"""Construye la línea temporal de cada activo y liquida las ventas.

Este módulo es el único sitio donde se decide **qué** cuenta como adquisición y
qué como transmisión; `core.fifo` pone el reparto en lotes y `core.fiscal_es`
la normativa. La separación importa porque la respuesta a "qué cuenta" depende
de cómo guarda los datos esta aplicación, no de la ley.

Fuentes de la línea temporal de un activo:

  * `activo_rows` — la ficha del activo. `Compra` adquiere, `Venta` transmite.
  * `activo_operation_rows` con estado `Completado` — operaciones de cripto.
    `Compra` adquiere, `Venta` transmite.
  * `ventas` — la tabla fiscal. Siempre transmite, y es la única fuente que
    genera resultado declarable.

Las dos primeras mueven la posición pero no declaran: reflejan lo que el
usuario apuntó en la ficha. Si una misma venta está apuntada en la ficha *y* en
la tabla de ventas, se consumirá dos veces y saltará una incidencia de stock.
Eso es deliberado: antes el descuadre se tragaba en silencio y salían costes de
adquisición inventados.
"""

import threading
from dataclasses import replace
from decimal import Decimal

from core import fifo, fiscal_es
from core.db import getDb
from core.fifo import ADQUISICION, TRANSMISION, Operacion

# Motivos de incidencia propios de esta capa (los de reparto viven en core.fifo).
INCIDENCIA_FECHA = "fecha_invalida"
INCIDENCIA_ANIO = "anio_incoherente"
INCIDENCIA_ACTIVO = "activo_desconocido"
INCIDENCIA_CANTIDAD = "cantidad_invalida"
INCIDENCIA_PRECIO = "precio_invalido"

_MENSAJES = {
    fifo.INCIDENCIA_STOCK: (
        "Vendes más participaciones de las disponibles en esa fecha. Revisa si "
        "la venta ya está apuntada en la ficha del activo o si falta registrar "
        "una compra anterior."
    ),
    fifo.INCIDENCIA_SIN_LOTES: (
        "No hay ninguna compra registrada de este activo antes de la fecha de "
        "venta, así que no se puede determinar el coste de adquisición."
    ),
    INCIDENCIA_FECHA: "La fecha de venta no es válida (usa dd-mm-aaaa).",
    INCIDENCIA_ANIO: "La fecha de venta no pertenece al ejercicio en el que está guardada.",
    INCIDENCIA_ACTIVO: "El activo seleccionado ya no existe.",
    INCIDENCIA_CANTIDAD: "La cantidad debe ser un número mayor que cero.",
    INCIDENCIA_PRECIO: "El valor de venta debe ser un número mayor o igual que cero.",
}

# Incidencias que impiden siquiera colocar la fila en la línea temporal. Las
# rutas las rechazan al guardar; las demás se guardan y se muestran marcadas.
BLOQUEANTES = {
    INCIDENCIA_FECHA, INCIDENCIA_ACTIVO, INCIDENCIA_CANTIDAD,
    INCIDENCIA_PRECIO, INCIDENCIA_ANIO,
}


def mensajeIncidencia(codigo):
    return _MENSAJES.get(codigo, "")


def _esCripto(tipo):
    return str(tipo or "").strip().lower() == "cripto"


def _cargarActivos():
    conn = getDb()
    return {
        row["id"]: {"id": row["id"], "name": row["name"], "type": row["type"]}
        for row in conn.execute("SELECT id, name, type FROM activos")
    }


def _operacionesDeFichas():
    """Movimientos apuntados en la ficha de cada activo y en sus operaciones."""
    conn = getDb()
    porActivo = {}

    filas = conn.execute(
        "SELECT id, asset_id, fecha_operacion, tipo_operacion, participaciones, "
        "precio_participacion, capital_invertido_bruto, comisiones, comisiones_fiat "
        "FROM activo_rows ORDER BY asset_id, id"
    ).fetchall()

    activos = _cargarActivos()

    for fila in filas:
        activo = activos.get(fila["asset_id"])
        if activo is None:
            continue
        cripto = _esCripto(activo["type"])
        cantidad = _num(fila["participaciones"])
        if cantidad <= 0:
            continue

        tipoOperacion = str(fila["tipo_operacion"] or "").strip().lower()
        precio = _num(fila["precio_participacion"])
        bruto = _num(fila["capital_invertido_bruto"])
        # En cripto el usuario apunta el importe total invertido; en el resto,
        # el precio por participación. Se respeta ese orden de preferencia y se
        # usa el otro campo como respaldo.
        if cripto:
            importe = bruto if bruto > 0 else precio * cantidad
        else:
            importe = precio * cantidad if precio > 0 else bruto

        comision = _num(fila["comisiones_fiat"]) if cripto else Decimal("0")
        if comision <= 0:
            comision = _num(fila["comisiones"])

        try:
            fecha = fifo.parseFecha(fila["fecha_operacion"])
        except fifo.FifoError:
            # Una fila de la ficha sin fecha legible no puede ordenarse. Se
            # ignora en vez de tumbar el cálculo de todo el activo; la ficha
            # tiene su propia pantalla para corregirla.
            continue

        porActivo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=f"{fila['asset_id']}:ficha:{fila['id']}",
            activoId=fila["asset_id"],
            fecha=fecha,
            tipo=TRANSMISION if tipoOperacion == "venta" else ADQUISICION,
            cantidad=cantidad,
            importe=importe,
            comision=comision,
            orden=int(fila["id"]),
            origen="ficha",
            fiscal=False,
        ))

    operaciones = conn.execute(
        "SELECT rowid AS seq, id, asset_id, fecha_apertura, orden, cantidad, "
        "comisiones_fiat, total FROM activo_operation_rows "
        "WHERE estado = 'Completado' ORDER BY asset_id, rowid"
    ).fetchall()

    for fila in operaciones:
        if fila["asset_id"] not in activos:
            continue
        cantidad = _num(fila["cantidad"])
        if cantidad <= 0:
            continue
        try:
            fecha = fifo.parseFecha(fila["fecha_apertura"])
        except fifo.FifoError:
            continue

        esVenta = str(fila["orden"] or "").strip().lower() == "venta"
        porActivo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=f"{fila['asset_id']}:op:{fila['id']}",
            activoId=fila["asset_id"],
            fecha=fecha,
            tipo=TRANSMISION if esVenta else ADQUISICION,
            cantidad=cantidad,
            importe=_num(fila["total"]),
            comision=_num(fila["comisiones_fiat"]),
            # Desplazado para que, a igual fecha, las operaciones vayan después
            # de las filas de la ficha y el orden sea siempre el mismo.
            orden=1_000_000 + int(fila["seq"]),
            origen="operacion",
            fiscal=False,
        ))

    return porActivo, activos


def _leerVentasCrudas():
    conn = getDb()
    return conn.execute(
        "SELECT rowid AS seq, id, year, fecha, asset_id, cantidad, valor_venta, comision_venta "
        "FROM ventas ORDER BY year, rowid"
    ).fetchall()


def validarVenta(fila, activos):
    """Comprueba una fila de venta antes de meterla en la línea temporal."""
    if fila["asset_id"] not in activos:
        return None, INCIDENCIA_ACTIVO

    cantidad = _num(fila["cantidad"])
    if cantidad <= 0:
        return None, INCIDENCIA_CANTIDAD

    precio = _num(fila["valor_venta"])
    if precio < 0:
        return None, INCIDENCIA_PRECIO

    try:
        fecha = fifo.parseFecha(fila["fecha"])
    except fifo.FifoError:
        return None, INCIDENCIA_FECHA

    if str(fecha.year) != str(fila["year"]):
        return None, INCIDENCIA_ANIO

    return {"fecha": fecha, "cantidad": cantidad, "precio": precio}, ""


def _añadirVentas(porActivo, ventas, activos):
    """Mete las ventas fiscales válidas en la línea temporal de cada activo.

    Devuelve `{(anio, id): incidencia}` con las que no se pudieron colocar.
    """
    invalidas = {}
    for fila in ventas:
        datos, incidencia = validarVenta(fila, activos)
        clave = (fila["year"], fila["id"])
        if incidencia:
            invalidas[clave] = incidencia
            continue

        ref = f"venta:{fila['year']}:{fila['id']}"
        porActivo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=ref,
            activoId=fila["asset_id"],
            fecha=datos["fecha"],
            tipo=TRANSMISION,
            cantidad=datos["cantidad"],
            importe=datos["cantidad"] * datos["precio"],
            comision=_num(fila["comision_venta"]),
            # Muy por detrás de la ficha: si el mismo día hay una compra en la
            # ficha y una venta fiscal, la compra entra primero.
            orden=2_000_000 + int(fila["seq"]),
            origen="ventas",
            fiscal=True,
        ))

    return invalidas


def carteraViva():
    """Posición que sigue en cartera por activo, según el FIFO.

    Devuelve `{asset_id: {"cantidad": Decimal, "coste": Decimal}}`, en la moneda
    del activo. Es lo que el navegador calcula con `buildRemainingAssetLots`, y
    lo necesita el snapshot del servidor para valorar la cartera sin depender de
    que haya una pestaña abierta.

    Dos diferencias deliberadas con `calcularTodo()`:

    * Las comisiones se descuentan de las operaciones antes de repartir. El
      coste que devuelve esta función es el **invertido bruto**, que es la cifra
      que el frontend manda como `total_invested`; sumarle las comisiones
      dejaría el histórico con dos definiciones distintas de invertido según
      quién guardara el punto.
    * No pasa por `fiscal_es`: la regla de antiaplicación mueve el resultado
      declarable de una venta, no las participaciones que quedan ni su coste.
    """
    porActivo, activos = _operacionesDeFichas()
    _añadirVentas(porActivo, _leerVentasCrudas(), activos)

    cartera = {}
    for activoId, operaciones in porActivo.items():
        sinComision = [replace(op, comision=Decimal("0")) for op in operaciones]
        _, lotes = fifo.aplicarFifo(sinComision)

        cantidad = sum((lote.restante for lote in lotes), Decimal("0"))
        coste = sum((lote.restante * lote.costeUnitario for lote in lotes), Decimal("0"))
        if cantidad > 0:
            cartera[activoId] = {"cantidad": cantidad, "coste": coste}

    return cartera


_cacheHilo = threading.local()


def calcularTodo():
    """Liquida todas las ventas de todos los ejercicios. Memoizado por hilo.

    El cálculo depende de tres tablas (`activos`, las fichas de operaciones y
    `ventas`) repartidas entre varias rutas, y este módulo ya viene escarmentado
    de invalidar mal: "calcular un año aislado es justamente el fallo que tenía
    la versión anterior" (ver más abajo). Enganchar la invalidación a mano en
    cada punto de escritura de esas tablas sería el mismo tipo de fallo otra
    vez, solo que repartido por más ficheros.

    En vez de eso, la clave de caché es la propia foto de la base de datos:
    `PRAGMA data_version` cambia en cuanto OTRA conexión confirma una escritura
    (no la que pregunta: ese es justo el motivo de sumarle `total_changes`,
    que sí cuenta las de esta conexión), y `id(conn)` de propina por si el hilo
    recicla la conexión (`core/db.py`), para que una coincidencia de contador
    tras el reciclaje no se lea como "no ha cambiado nada". Es por hilo (los
    workers de gunicorn no comparten memoria, y cada hilo ya tiene su propia
    conexión) y de un solo hueco: no hace falta guardar más de un resultado a
    la vez.

    Nadie fuera de este módulo debe mutar el diccionario devuelto: con caché,
    ese mismo objeto se reparte entre peticiones.
    """
    conn = getDb()
    clave = (id(conn), conn.execute("PRAGMA data_version").fetchone()[0], conn.total_changes)
    if getattr(_cacheHilo, "clave", None) == clave:
        return _cacheHilo.resultado

    resultado = _calcularTodoSinCache()
    _cacheHilo.clave = clave
    _cacheHilo.resultado = resultado
    return resultado


def _calcularTodoSinCache():
    """Liquida todas las ventas de todos los ejercicios.

    Se calcula siempre sobre el histórico completo, nunca sobre un año suelto:
    el coste FIFO de una venta de 2026 depende de lo que se vendiera en 2025, y
    calcular un año aislado es justamente el fallo que tenía la versión
    anterior.

    Devuelve `{"filas": {(anio, id): dato}, "liquidaciones": {...},
    "incidencias": [...]}`.
    """
    porActivo, activos = _operacionesDeFichas()
    ventas = _leerVentasCrudas()
    invalidas = _añadirVentas(porActivo, ventas, activos)

    resultadosPorRef = {}
    lotesVivos = {}
    for activoId, operaciones in porActivo.items():
        tipo = activos.get(activoId, {}).get("type", "")
        resultados, lotes = fiscal_es.calcularConNormativa(operaciones, tipo)
        lotesVivos[activoId] = lotes
        for resultado in resultados:
            resultadosPorRef[resultado.ref] = resultado

    # Agrupa por ejercicio solo los resultados fiscales (los de la ficha mueven
    # la posición pero no declaran).
    resultadosPorAnio = {}
    for fila in ventas:
        clave = (fila["year"], fila["id"])
        if clave in invalidas:
            continue
        resultado = resultadosPorRef.get(f"venta:{fila['year']}:{fila['id']}")
        if resultado is not None:
            resultadosPorAnio.setdefault(fila["year"], []).append(resultado)

    # Un ejercicio existente sin ventas válidas también necesita liquidación
    # (a cero) para que la pantalla tenga algo que enseñar.
    conn = getDb()
    for row in conn.execute("SELECT year FROM ventas_years"):
        resultadosPorAnio.setdefault(row["year"], [])

    liquidaciones = fiscal_es.liquidarEjercicios(resultadosPorAnio)

    filas = {}
    incidencias = []
    for anio, resultados in resultadosPorAnio.items():
        liquidacion = liquidaciones[str(anio)]
        reparto = fiscal_es.repartirCuotaPorVenta(
            resultados, liquidacion, fiscal_es.escalaDelEjercicio(anio)
        )
        for resultado in resultados:
            _, ventaId = resultado.ref.rsplit(":", 1)
            filas[(anio, ventaId)] = _serializarFila(
                resultado, reparto.get(resultado.ref, {})
            )
            if resultado.incidencia:
                incidencias.append({
                    "year": anio,
                    "id": ventaId,
                    "codigo": resultado.incidencia,
                    "mensaje": mensajeIncidencia(resultado.incidencia),
                })

    for (anio, ventaId), codigo in invalidas.items():
        filas[(anio, ventaId)] = filaVacia(codigo)
        incidencias.append({
            "year": anio,
            "id": ventaId,
            "codigo": codigo,
            "mensaje": mensajeIncidencia(codigo),
        })

    return {
        "filas": filas,
        "liquidaciones": liquidaciones,
        "incidencias": incidencias,
        "lotes_vivos": lotesVivos,
    }


# ── Simulación de una venta (herramienta) ────────────────────────────────────
# La pantalla de Ventas contesta qué pasó; esto contesta qué pasaría. Va aquí y
# no en la herramienta del navegador porque la respuesta depende del FIFO sobre
# todo el histórico y de la escala del ahorro, y tener esa aritmética escrita
# dos veces es la forma seguro de que un día dejen de coincidir.
#
# La cuota que se devuelve es **incremental**: se liquida el ejercicio con y sin
# la venta simulada y se resta. Es lo que de verdad cuesta vender, porque la
# escala es progresiva y el saldo puede compensarse con pérdidas de ejercicios
# anteriores; un tipo fijo aplicado a la ganancia daría otro número.

REF_SIMULACION = "simulacion"


def _liquidarCon(porActivo, activos, ventas, invalidas, extra=None):
    """Liquida todos los ejercicios, opcionalmente con una venta más.

    `extra` es una `Operacion` que no está guardada en ninguna parte. No se
    mezcla con `por_activo` para que la misma línea temporal pueda liquidarse
    dos veces, con ella y sin ella.
    """
    porRef = {}
    activosARecorrer = set(porActivo)
    if extra is not None:
        activosARecorrer.add(extra.activoId)

    for activoId in activosARecorrer:
        operaciones = list(porActivo.get(activoId, []))
        if extra is not None and extra.activoId == activoId:
            operaciones.append(extra)
        tipo = activos.get(activoId, {}).get("type", "")
        resultados, _lotes = fiscal_es.calcularConNormativa(operaciones, tipo)
        for resultado in resultados:
            porRef[resultado.ref] = resultado

    resultadosPorAnio = {}
    for fila in ventas:
        if (fila["year"], fila["id"]) in invalidas:
            continue
        resultado = porRef.get(f"venta:{fila['year']}:{fila['id']}")
        if resultado is not None:
            resultadosPorAnio.setdefault(str(fila["year"]), []).append(resultado)

    if extra is not None:
        simulada = porRef.get(REF_SIMULACION)
        if simulada is not None:
            resultadosPorAnio.setdefault(str(extra.fecha.year), []).append(simulada)

    return porRef, fiscal_es.liquidarEjercicios(resultadosPorAnio)


def simularVenta(assetId, fechaTexto, cantidad, precio, comision=0):
    """Qué saldría de vender ahora mismo. No guarda nada.

    Devuelve `(dato, incidencia)`. La incidencia bloqueante (fecha ilegible,
    activo inexistente…) viene con `dato` a None; las de reparto —vender más de
    lo que hay, sin compras previas— llegan dentro del dato, porque el resto de
    las cifras siguen siendo informativas.
    """
    activos = _cargarActivos()
    activo = activos.get(assetId)
    if activo is None:
        return None, INCIDENCIA_ACTIVO

    cantidad = _num(cantidad)
    precio = _num(precio)
    comision = _num(comision)
    if cantidad <= 0:
        return None, INCIDENCIA_CANTIDAD
    if precio < 0:
        return None, INCIDENCIA_PRECIO

    try:
        fecha = fifo.parseFecha(fechaTexto)
    except fifo.FifoError:
        return None, INCIDENCIA_FECHA

    porActivo, activos = _operacionesDeFichas()
    ventas = _leerVentasCrudas()
    invalidas = _añadirVentas(porActivo, ventas, activos)

    operacion = Operacion(
        ref=REF_SIMULACION,
        activoId=assetId,
        fecha=fecha,
        tipo=TRANSMISION,
        cantidad=cantidad,
        importe=cantidad * precio,
        comision=comision,
        # Detrás de todo lo guardado: a igual fecha, lo real va primero.
        orden=3_000_000,
        origen="simulacion",
        fiscal=True,
    )

    anio = str(fecha.year)
    _, liquidacionesSin = _liquidarCon(porActivo, activos, ventas, invalidas)
    porRef, liquidacionesCon = _liquidarCon(porActivo, activos, ventas, invalidas, operacion)

    resultado = porRef.get(REF_SIMULACION)
    if resultado is None:
        return None, INCIDENCIA_CANTIDAD

    sin = liquidacionesSin.get(anio)
    con = liquidacionesCon.get(anio)
    cuotaSin = sin.cuota if sin is not None else Decimal("0")
    cuotaCon = con.cuota if con is not None else Decimal("0")
    cuotaVenta = cuotaCon - cuotaSin

    compensadoSin = sin.compensadoAnteriores if sin is not None else Decimal("0")
    compensadoCon = con.compensadoAnteriores if con is not None else Decimal("0")

    ganancia = resultado.gananciaComputable
    valorTransmision = resultado.valorTransmision

    dato = {
        "activo": activo["name"],
        "tipo": activo["type"],
        "anio": anio,
        "cantidad": _money(cantidad, escala="0.00000001"),
        "disponible": _money(resultado.disponibleAntes, escala="0.00000001"),
        "valorTransmision": _money(valorTransmision),
        "costeAdquisicion": _money(resultado.costeAdquisicion),
        "ganancia": _money(ganancia),
        "cuota": _money(cuotaVenta),
        "neto": _money(valorTransmision - cuotaVenta),
        # Tipo efectivo de ESTA venta, no el del tramo: con compensaciones de
        # ejercicios anteriores puede salir muy por debajo de la escala.
        "tipoEfectivo": _money((cuotaVenta / ganancia * 100) if ganancia > 0 else Decimal("0")),
        "perdidaNoComputable": _money(resultado.perdidaNoComputable),
        "notaAntiaplicacion": resultado.notaAntiaplicacion,
        "compensadoAnteriores": _money(compensadoCon - compensadoSin),
        "cuotaEjercicioAntes": _money(cuotaSin),
        "cuotaEjercicioDespues": _money(cuotaCon),
        "incidencia": resultado.incidencia,
        "mensaje": mensajeIncidencia(resultado.incidencia),
        "lotes": [
            {
                "fecha": consumo.fechaAdquisicion.strftime("%d-%m-%Y"),
                "cantidad": _money(consumo.cantidad, escala="0.00000001"),
                "costeUnitario": _money(consumo.costeUnitario, escala="0.0001"),
                "coste": _money(consumo.coste),
            }
            for consumo in resultado.lotes
        ],
    }

    return dato, ""


def _serializarFila(resultado, tramos):
    if resultado.incidencia:
        fila = filaVacia(resultado.incidencia)
        fila["stockDisponible"] = _money(resultado.disponibleAntes, escala="0.00000001")
        fila["bruto"] = _money(resultado.valorTransmision)
        return fila

    cuota = sum(tramos.values(), Decimal("0"))
    ganancia = resultado.gananciaComputable

    return {
        "valorCompra": _money(resultado.costeUnitario),
        "costeAdquisicion": _money(resultado.costeAdquisicion),
        "valorTransmision": _money(resultado.valorTransmision),
        "dineroDeclarar": _money(ganancia),
        "tramo1": _money(tramos.get("tramo1", 0)),
        "tramo2": _money(tramos.get("tramo2", 0)),
        "tramo3": _money(tramos.get("tramo3", 0)),
        "tramo4": _money(tramos.get("tramo4", 0)),
        "tramo5": _money(tramos.get("tramo5", 0)),
        "totalPagar": _money(cuota),
        "bruto": _money(resultado.valorTransmision),
        "neto": _money(resultado.valorTransmision - cuota),
        "stockDisponible": _money(resultado.disponibleAntes, escala="0.00000001"),
        "perdidaNoComputable": _money(resultado.perdidaNoComputable),
        "perdidaDiferidaLiberada": _money(resultado.perdidaDiferidaLiberada),
        "notaAntiaplicacion": resultado.notaAntiaplicacion,
        "incidencia": "",
        "mensaje": "",
        "lotes": [
            {
                "ref": consumo.loteRef,
                "fecha": consumo.fechaAdquisicion.strftime("%d-%m-%Y"),
                "cantidad": _money(consumo.cantidad, escala="0.00000001"),
                "costeUnitario": _money(consumo.costeUnitario, escala="0.0001"),
                "coste": _money(consumo.coste),
                "origen": consumo.origen,
            }
            for consumo in resultado.lotes
        ],
    }


def filaVacia(incidencia=""):
    return {
        "valorCompra": "",
        "costeAdquisicion": "",
        "valorTransmision": "",
        "dineroDeclarar": "",
        "tramo1": "",
        "tramo2": "",
        "tramo3": "",
        "tramo4": "",
        "tramo5": "",
        "totalPagar": "",
        "bruto": "",
        "neto": "",
        "stockDisponible": "",
        "perdidaNoComputable": "",
        "perdidaDiferidaLiberada": "",
        "notaAntiaplicacion": "",
        "incidencia": incidencia,
        "mensaje": mensajeIncidencia(incidencia),
        "lotes": [],
    }


def serializarLiquidacion(liquidacion):
    """Resumen anual listo para JSON."""
    return {
        "year": liquidacion.anio,
        "ganancias": _money(liquidacion.ganancias),
        "perdidas": _money(liquidacion.perdidas),
        "saldo": _money(liquidacion.saldo),
        "compensadoAnteriores": _money(liquidacion.compensadoAnteriores),
        "base": _money(liquidacion.base),
        "cuota": _money(liquidacion.cuota),
        "tramos": {k: _money(v) for k, v in liquidacion.tramos.items()},
        "saldoNegativoGenerado": _money(liquidacion.saldoNegativoGenerado),
        "pendienteCompensar": _money(liquidacion.pendienteCompensar),
        "perdidasNoComputables": _money(liquidacion.perdidasNoComputables),
        "perdidasDiferidasLiberadas": _money(liquidacion.perdidasDiferidasLiberadas),
        # El total de `pendienteCompensar` no basta para declarar: cada saldo
        # negativo caduca a los cuatro ejercicios de su origen, así que hay que
        # saber de qué año viene cada trozo.
        "arrastres": [
            {
                "anioOrigen": str(a["anio_origen"]),
                "importe": _money(a["importe"]),
                "ultimoEjercicio": str(a["ultimo_ejercicio"]),
            }
            for a in liquidacion.arrastres
        ],
        "compensacionesAplicadas": [
            {
                "anioOrigen": str(c["anio_origen"]),
                "importe": _money(c["importe"]),
                "ultimoEjercicio": str(c["ultimo_ejercicio"]),
            }
            for c in liquidacion.compensacionesAplicadas
        ],
    }


def _num(value):
    try:
        return fifo.parseDecimal(value)
    except fifo.FifoError:
        return Decimal("0")


def _money(value, escala="0.01"):
    """Importe como cadena con punto decimal, apta para JSON y para la BD."""
    if value is None or value == "":
        return ""
    return f"{fifo.cuantizar(Decimal(value), Decimal(escala)):f}"
