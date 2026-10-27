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
from decimal import Decimal

from core import dinero, fifo, fiscal_es
from core.db import getDb
from core.fifo import ADQUISICION, TRANSMISION, Operacion
from stores import rendimiento_activo
from stores.fx_historico import tipoActualConMemo

# Motivos de incidencia propios de esta capa (los de reparto viven en core.fifo).
INCIDENCIA_FECHA = "fecha_invalida"
INCIDENCIA_ANIO = "anio_incoherente"
INCIDENCIA_ACTIVO = "activo_desconocido"
INCIDENCIA_CANTIDAD = "cantidad_invalida"
INCIDENCIA_PRECIO = "precio_invalido"
INCIDENCIA_SIN_VALOR = "valor_mercado_pendiente"
INCIDENCIA_COSTE_RECIBIDA = "coste_recibida_pendiente"

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
    fifo.INCIDENCIA_COMPRA_ILEGIBLE: (
        "Una de las compras de las que sale esta venta tiene un importe que no se "
        "puede leer. Corrígela en la ficha del activo."
    ),
    fifo.INCIDENCIA_SIN_TIPO: (
        "Falta el tipo de cambio de esta venta o de alguna de las compras de las "
        "que sale. Complétalo desde Ajustes → Tipos de cambio."
    ),
    INCIDENCIA_SIN_VALOR: (
        "Una permuta de cripto por cripto no tiene valor de mercado en euros, que "
        "es lo que fija la ganancia de lo entregado y el coste de lo recibido. "
        "Anótalo en la conversión."
    ),
    INCIDENCIA_COSTE_RECIBIDA: (
        "Una parte de lo que se vende llegó por una transferencia recibida y se "
        "desconoce su coste de adquisición."
    ),
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
        row["id"]: {"id": row["id"], "name": row["name"], "type": row["type"], "currency": row["currency"]}
        for row in conn.execute("SELECT id, name, type, currency FROM activos")
    }


def _factorEur(moneda, fxRate):
    """Cuántos euros vale una unidad de `moneda`, o None si falta el tipo.

    El tipo es el anotado en la propia operación (el de su fecha), también en
    euros: al cambiar la divisa de un activo, el tipo de sus filas se reescala
    para que el coste en euros no cambie, y puede no ser 1. El euro sin tipo
    anotado vale 1; en cualquier otra divisa, si falta no se descarga ni se toma
    1, porque el resultado fiscal saldría mal sin avisar.
    """
    divisa = str(moneda or "EUR").strip().upper() or "EUR"
    tipo = dinero.aDecimalONulo(fxRate)
    if tipo is not None and tipo > 0:
        return tipo
    return Decimal("1") if divisa == "EUR" else None


def _defectoDeFila(fila, columnas):
    """Incidencia si alguna de las columnas de importe de la fila es ilegible."""
    if any(_ilegible(fila[columna]) for columna in columnas):
        return fifo.INCIDENCIA_COMPRA_ILEGIBLE
    return ""


def _operacionesDeFichas(convertir=True):
    """Movimientos apuntados en la ficha de cada activo y en sus operaciones.

    Con `convertir` los importes salen en euros, cada uno con el tipo de cambio
    de su propia operación (lo que necesita el cálculo fiscal). Sin él se dejan
    en la divisa de la operación, que es lo que quiere la valoración de la
    cartera, que convierte con el tipo de hoy.
    """
    conn = getDb()
    porActivo = {}

    filas = conn.execute(
        "SELECT id, asset_id, fecha_operacion, tipo_operacion, participaciones, "
        "precio_participacion, capital_invertido_bruto, comisiones, comisiones_fiat, comisiones_cripto, "
        "currency, fx_rate "
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
        if rendimiento_activo._esConversion(tipoOperacion):
            continue  # es una permuta: la lee `_añadirMovimientosPropios`
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

        # La comisión en cripto sale de las propias participaciones: al comprar
        # llegan menos de las pagadas y al vender se pierden además de las
        # vendidas (misma regla que el navegador). El importe ya se calculó
        # sobre la cantidad bruta.
        if cripto:
            comisionCripto = _num(fila["comisiones_cripto"])
            cantidad = cantidad + comisionCripto if tipoOperacion == "venta" else cantidad - comisionCripto
            if cantidad <= 0:
                continue

        try:
            fecha = fifo.parseFecha(fila["fecha_operacion"])
        except fifo.FifoError:
            # Una fila de la ficha sin fecha legible no puede ordenarse. Se
            # ignora en vez de tumbar el cálculo de todo el activo; la ficha
            # tiene su propia pantalla para corregirla.
            continue

        defecto = _defectoDeFila(fila, (
            "precio_participacion", "capital_invertido_bruto", "comisiones",
            "comisiones_fiat", "comisiones_cripto",
        ))
        if convertir:
            factor = _factorEur(fila["currency"], fila["fx_rate"])
            if factor is None:
                defecto = defecto or fifo.INCIDENCIA_SIN_TIPO
            else:
                importe *= factor
                comision *= factor

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
            defecto=defecto,
        ))

    operaciones = conn.execute(
        "SELECT rowid AS seq, id, asset_id, fecha_apertura, orden, cantidad, "
        "comisiones_fiat, comisiones_cripto, total, currency, fx_rate FROM activo_operation_rows "
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
        comisionCripto = _num(fila["comisiones_cripto"])
        cantidad = cantidad + comisionCripto if esVenta else cantidad - comisionCripto
        if cantidad <= 0:
            continue

        importe = _num(fila["total"])
        defecto = _defectoDeFila(fila, ("total", "comisiones_fiat", "comisiones_cripto"))
        if convertir:
            # La comisión de una operación spot va siempre en euros; el total,
            # en la divisa de la operación.
            factor = _factorEur(fila["currency"], fila["fx_rate"])
            if factor is None:
                defecto = defecto or fifo.INCIDENCIA_SIN_TIPO
            else:
                importe *= factor
        porActivo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=f"{fila['asset_id']}:op:{fila['id']}",
            activoId=fila["asset_id"],
            fecha=fecha,
            tipo=TRANSMISION if esVenta else ADQUISICION,
            cantidad=cantidad,
            importe=importe,
            comision=_num(fila["comisiones_fiat"]),
            defecto=defecto,
            # Desplazado para que, a igual fecha, las operaciones vayan después
            # de las filas de la ficha y el orden sea siempre el mismo.
            orden=1_000_000 + int(fila["seq"]),
            origen="operacion",
            fiscal=False,
        ))

    return porActivo, activos


def _valorMercadoEur(fila):
    """Valor de mercado, en euros, de lo que se entregó en la permuta; None si no consta.

    Solo se acepta lo que el usuario anotó en la propia conversión (columna
    `valor_eur`). Un precio histórico que la aplicación no guardó no se
    reconstruye ni se estima: una permuta sin valor sale con incidencia en vez de
    con una ganancia inventada.
    """
    try:
        valor = dinero.aDecimalONulo(fila["valor_eur"])
    except (IndexError, KeyError):
        return None
    return valor if valor is not None and valor > 0 else None


def _comisionDeLaSalida(fila, cantidad, valor):
    """Valor en euros de la comisión en cripto de una salida, prorrateado sobre el valor de mercado.

    Devuelve cero si no se puede valorar sin inventar: sin valor de mercado, sin
    comisión, en una moneda que no es de las dos del par o sin cantidad sobre la
    que repartir.
    """
    comision = _num(fila.get("comision"))
    moneda = str(fila.get("comision_moneda") or "").strip().upper()
    if not valor or comision <= 0 or not moneda:
        return Decimal("0")
    # El par lo escribe el formulario como «cripto de la ficha/contraparte»: es
    # más fiable que el símbolo guardado del activo, que puede ser su nombre.
    partes = [p.strip().upper() for p in str(fila.get("par") or "").split("/")]
    propio = partes[0]
    contraparte = partes[1] if len(partes) > 1 else ""
    if moneda == propio:
        base = cantidad
    elif moneda == contraparte:
        base = _num(fila.get("cantidad_contraparte"))
    else:
        return Decimal("0")
    if base <= 0 or comision >= base:
        return Decimal("0")
    return comision / base * valor


def _leerConversiones(conn):
    """Conversiones cripto de la tabla y las antiguas de la ficha, sin repetir.

    Las conversiones antiguas vivían en la ficha como filas «X convertidos» o
    «Convertidos a X»; las que ya están también en la tabla cuentan una vez, con
    la misma clave que usa `rendimiento_activo.lotesVivos`.
    """
    filas = [dict(f) for f in conn.execute(
        "SELECT rowid AS seq, id, asset_id, fecha, par, tipo, cantidad, cantidad_contraparte, "
        "comision, comision_moneda, valor_eur FROM activo_conversion_rows ORDER BY rowid"
    )]
    for fila in conn.execute(
        "SELECT id, asset_id, fecha_operacion, tipo_operacion, participaciones FROM activo_rows ORDER BY id"
    ):
        if rendimiento_activo._esConversion(fila["tipo_operacion"]):
            filas.append({
                "seq": int(fila["id"]), "id": f"ficha{fila['id']}", "asset_id": fila["asset_id"],
                "fecha": fila["fecha_operacion"], "par": "", "tipo": fila["tipo_operacion"],
                "cantidad": fila["participaciones"],
            })

    vistas = set()
    for fila in filas:
        clave = (fila["asset_id"], str(fila["fecha"] or "").strip(), str(fila["par"] or "").strip(),
                 rendimiento_activo._esConversionDeSalida(fila["tipo"]), str(fila["cantidad"] or "").strip())
        if clave not in vistas:
            vistas.add(clave)
            yield fila


def _añadirMovimientosPropios(porActivo, activos):
    """Permutas cripto-cripto y transferencias entre wallets en la línea temporal.

    Criterio fiscal español (DGT V0999-18 y siguientes): convertir una cripto en
    otra es una permuta, es decir, la transmisión de lo entregado, valorada a
    mercado en ese momento (ganancia o pérdida por FIFO), más la adquisición de lo
    recibido por ese mismo valor. Cada fila de conversión mueve solo el activo en
    el que está anotada, igual que en la posición de la cartera.

    * Sin valor de mercado la permuta sale con incidencia, y la incidencia viaja
      al lote recibido y a las ventas que lo consuman.
    * La comisión cobrada en cripto en una salida resta del valor de transmisión,
      en proporción: comisión entre la cantidad en la que se cobró (la entregada
      o la recibida, según la moneda de la comisión) por el valor de mercado. Si
      la moneda de la comisión no es una de las dos del par, o no hay cantidad
      con la que prorratear, no se valora. En una entrada la comisión tampoco se
      valora: no está claro que sea gasto de adquisición del lote recibido.
    * Las transferencias entre wallets propias no son hecho imponible: solo la
      comisión de red, en cripto, reduce las existencias. Las enviadas restan
      cantidad y comisión; las recibidas suman participaciones de coste
      desconocido (incidencia). Ninguna declara resultado (`fiscal=False`).

    Devuelve `{ref: {"par": ..., "activo": ...}}` de las permutas, para el informe.
    """
    conn = getDb()
    permutas = {}

    for fila in _leerConversiones(conn):
        activo = activos.get(fila["asset_id"])
        if activo is None or not _esCripto(activo["type"]):
            continue
        cantidad = _num(fila["cantidad"])
        if cantidad <= 0:
            continue
        try:
            fecha = fifo.parseFecha(fila["fecha"])
        except fifo.FifoError:
            continue
        salida = rendimiento_activo._esConversionDeSalida(fila["tipo"])
        valor = _valorMercadoEur(fila)
        ref = f"permuta:{fila['asset_id']}:{fila['id']}"
        permutas[ref] = {"par": str(fila["par"] or ""), "activo": activo["name"]}
        porActivo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=ref,
            activoId=fila["asset_id"],
            fecha=fecha,
            tipo=TRANSMISION if salida else ADQUISICION,
            cantidad=cantidad,
            importe=valor or Decimal("0"),
            comision=_comisionDeLaSalida(fila, cantidad, valor) if salida else Decimal("0"),
            defecto="" if valor else INCIDENCIA_SIN_VALOR,
            orden=1_500_000 + int(fila["seq"]),
            origen="permuta",
            fiscal=salida,
        ))

    for fila in conn.execute(
        "SELECT rowid AS seq, asset_id, fecha_operacion, total, comision_red, wallet_tipo "
        "FROM transacciones ORDER BY rowid"
    ):
        if fila["asset_id"] not in activos:
            continue
        cantidad = _num(fila["total"])
        comisionRed = max(Decimal("0"), _num(fila["comision_red"]))
        movimiento = str(fila["wallet_tipo"] or "").strip().lower()
        if cantidad <= 0 or movimiento not in ("entre_wallet", "enviada", "recibida"):
            continue
        try:
            fecha = fifo.parseFecha(fila["fecha_operacion"])
        except fifo.FifoError:
            continue
        if movimiento == "recibida":
            tipo, unidades, defecto = ADQUISICION, cantidad, INCIDENCIA_COSTE_RECIBIDA
        else:
            tipo, defecto = TRANSMISION, ""
            unidades = comisionRed if movimiento == "entre_wallet" else cantidad + comisionRed
        if unidades <= 0:
            continue
        porActivo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=f"transferencia:{fila['asset_id']}:{fila['seq']}",
            activoId=fila["asset_id"],
            fecha=fecha,
            tipo=tipo,
            cantidad=unidades,
            defecto=defecto,
            orden=1_200_000 + int(fila["seq"]),
            origen="transferencia",
            fiscal=False,
        ))

    return permutas


def _filaPermuta(resultado, meta):
    """Una permuta ya liquidada, lista para JSON e informe (tipo «permuta»)."""
    if resultado.incidencia:
        vacia = {"valorTransmision": "", "costeAdquisicion": "", "dineroDeclarar": ""}
    else:
        vacia = {
            "valorTransmision": _money(resultado.valorTransmision),
            "costeAdquisicion": _money(resultado.costeAdquisicion),
            "dineroDeclarar": _money(resultado.gananciaComputable),
        }
    return {
        "tipo": "permuta",
        "id": resultado.ref,
        "fecha": resultado.fecha.strftime("%d-%m-%Y"),
        "activo": meta.get("activo", resultado.activoId),
        "par": meta.get("par", ""),
        "cantidad": _money(resultado.cantidad, escala="0.00000001"),
        **vacia,
        "perdidaNoComputable": _money(resultado.perdidaNoComputable),
        "perdidaDiferidaLiberada": _money(resultado.perdidaDiferidaLiberada),
        "incidencia": resultado.incidencia,
        "mensaje": mensajeIncidencia(resultado.incidencia),
    }


def _leerVentasCrudas():
    conn = getDb()
    return conn.execute(
        "SELECT rowid AS seq, id, year, fecha, asset_id, cantidad, valor_venta, comision_venta, "
        "currency, fx_rate FROM ventas ORDER BY year, rowid"
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

    # `_num` convierte lo ilegible en cero; para una venta eso es una
    # transmisión a coste cero y una pérdida inventada, así que se rechaza.
    for campo in ("valor_venta", "comision_venta"):
        try:
            texto = fila[campo]
        except (IndexError, KeyError):
            continue
        if _ilegible(texto):
            return None, INCIDENCIA_PRECIO

    try:
        fecha = fifo.parseFecha(fila["fecha"])
    except fifo.FifoError:
        return None, INCIDENCIA_FECHA

    if str(fecha.year) != str(fila["year"]):
        return None, INCIDENCIA_ANIO

    return {"fecha": fecha, "cantidad": cantidad, "precio": precio}, ""


def _añadirVentas(porActivo, ventas, activos, convertir=True):
    """Mete las ventas fiscales válidas en la línea temporal de cada activo.

    Devuelve `{(anio, id): incidencia}` con las que no se pudieron colocar.
    Con `convertir`, el valor y la comisión de cada venta pasan a euros con el
    tipo de cambio de su fecha; si falta, la venta queda con incidencia.
    """
    invalidas = {}
    for fila in ventas:
        datos, incidencia = validarVenta(fila, activos)
        clave = (fila["year"], fila["id"])
        if incidencia:
            invalidas[clave] = incidencia
            continue

        importe = datos["cantidad"] * datos["precio"]
        comision = _num(fila["comision_venta"])
        defecto = ""
        if convertir:
            factor = _factorEur(
                fila["currency"] or activos[fila["asset_id"]].get("currency"), fila["fx_rate"]
            )
            if factor is None:
                defecto = fifo.INCIDENCIA_SIN_TIPO
            else:
                importe *= factor
                comision *= factor

        ref = f"venta:{fila['year']}:{fila['id']}"
        porActivo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=ref,
            activoId=fila["asset_id"],
            fecha=datos["fecha"],
            tipo=TRANSMISION,
            cantidad=datos["cantidad"],
            importe=importe,
            comision=comision,
            defecto=defecto,
            # Muy por detrás de la ficha: si el mismo día hay una compra en la
            # ficha y una venta fiscal, la compra entra primero.
            orden=2_000_000 + int(fila["seq"]),
            origen="ventas",
            fiscal=True,
        ))

    return invalidas


def carteraViva():
    """Posición que sigue en cartera por activo, según el FIFO.

    Devuelve `{asset_id: {"cantidad", "coste", "invertido"}}` (Decimal), en la
    moneda del activo. Es lo que el navegador calcula con `buildRemainingAssetLots`, y
    lo necesita el snapshot del servidor para valorar la cartera sin depender de
    que haya una pestaña abierta.

    Dos diferencias deliberadas con `calcularTodo()`:

    * `coste` es el invertido bruto y `invertido` el neto (bruto menos
      comisiones): la ficha del activo enseña el neto, y es el que debe guardar
      el histórico para no tener dos definiciones de invertido según quién
      guarde el punto.
    * No pasa por `fiscal_es`: la regla de antiaplicación mueve el resultado
      declarable de una venta, no las participaciones que quedan ni su coste.
    """
    # La posición sale de la misma reconstrucción que usa el navegador, con todas
    # sus fuentes (ficha, operaciones, ventas, transacciones y conversiones). La
    # línea temporal fiscal de arriba solo conoce las tres primeras y se saltaba
    # las filas sin fecha legible, así que valoraba de menos cualquier activo
    # con transferencias o conversiones.
    activos = _cargarActivos()
    posiciones = rendimiento_activo.cargarPosiciones(getDb())

    tipoDeCambio = tipoActualConMemo()
    cartera = {}
    for activoId, datos in posiciones.items():
        activo = activos.get(activoId)
        if activo is None:
            continue
        esCripto = _esCripto(activo["type"])
        moneda = str(activo["currency"] or "EUR").strip().upper() or "EUR"
        lotes = rendimiento_activo.lotesVivos(
            datos["filas"], datos["operaciones"], esCripto, datos["ventas"],
            None, datos["transacciones"], datos["conversiones"], moneda, tipoDeCambio,
        )
        cantidad = sum((lote["cantidad"] for lote in lotes), Decimal("0"))
        coste = sum((lote["coste"] for lote in lotes), Decimal("0"))
        comisiones = rendimiento_activo.comisionesFiat(
            datos["filas"], datos["operaciones"], esCripto, moneda, tipoDeCambio
        )
        if cantidad > 0:
            # `invertido` es la cifra que enseña la ficha del activo (invertido
            # neto); `coste` es el bruto, sin descontar comisiones.
            cartera[activoId] = {"cantidad": cantidad, "coste": coste, "invertido": coste - comisiones}

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
    metaPermutas = _añadirMovimientosPropios(porActivo, activos)

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

    # Las permutas declaran como una transmisión más, en el ejercicio de su fecha,
    # pero salen aparte: no son ventas a fiat ni tienen fila en la tabla Ventas.
    permutas = {}
    for ref, resultado in resultadosPorRef.items():
        if ref.startswith("permuta:") and resultado.fiscal:
            anio = str(resultado.fecha.year)
            resultadosPorAnio.setdefault(anio, []).append(resultado)
            permutas.setdefault(anio, []).append(_filaPermuta(resultado, metaPermutas.get(ref, {})))
    for filasPermuta in permutas.values():
        filasPermuta.sort(key=lambda f: (f["fecha"][6:], f["fecha"][3:5], f["fecha"][:2], f["id"]))

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
            if resultado.ref.startswith("permuta:"):
                continue
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
        "permutas": permutas,
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

    for ref, resultado in porRef.items():
        if ref.startswith("permuta:") and resultado.fiscal:
            resultadosPorAnio.setdefault(str(resultado.fecha.year), []).append(resultado)

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
    _añadirMovimientosPropios(porActivo, activos)

    # La venta simulada se teclea en la divisa del activo y no tiene tipo
    # anotado: se usa el que ya esté en la caché para esa fecha, sin descargar.
    importe = cantidad * precio
    defecto = ""
    moneda = str(activo.get("currency") or "EUR").strip().upper() or "EUR"
    if moneda != "EUR":
        from stores.fx_historico import tasa

        tipo, _origen, _fechaUsada = tasa(moneda, fecha, permitirDescarga=False)
        if tipo is None or tipo <= 0:
            defecto = fifo.INCIDENCIA_SIN_TIPO
        else:
            importe *= tipo
            comision *= tipo

    operacion = Operacion(
        ref=REF_SIMULACION,
        activoId=assetId,
        fecha=fecha,
        tipo=TRANSMISION,
        cantidad=cantidad,
        importe=importe,
        comision=comision,
        defecto=defecto,
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
    """Resumen anual listo para JSON.

    Un único punto de redondeo: ganancias y pérdidas se redondean una vez y el
    saldo y la base se derivan de esas cifras ya redondeadas. Redondear cada una
    por separado dejaba el saldo mostrado un céntimo fuera de ganancias menos
    pérdidas.
    """
    ganancias = dinero.redondear(liquidacion.ganancias)
    perdidas = dinero.redondear(liquidacion.perdidas)
    saldo = ganancias - perdidas
    compensado = dinero.redondear(liquidacion.compensadoAnteriores)
    base = max(saldo - compensado, Decimal("0")) if saldo > 0 else Decimal("0")
    return {
        "year": liquidacion.anio,
        "ganancias": _money(ganancias),
        "perdidas": _money(perdidas),
        "saldo": _money(saldo),
        "compensadoAnteriores": _money(compensado),
        "base": _money(base),
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


def _ilegible(value) -> bool:
    """True si hay un texto que no se puede leer como importe (el vacío cuenta como legible)."""
    if value is None or not str(value).strip():
        return False
    return dinero.aDecimalONulo(value) is None


def _num(value):
    try:
        return fifo.parseDecimal(value)
    except fifo.FifoError:
        return Decimal("0")


def _money(value, escala="0.01"):
    """Importe como cadena con punto decimal, apta para JSON y para la BD."""
    if value is None or value == "":
        return ""
    # ROUND_HALF_UP de dinero.redondear, como el resto de la aplicación: el
    # medio-par de fifo.cuantizar dejaba 0,125 en 0,12 aquí y en 0,13 en las
    # demás pantallas.
    decimales = -Decimal(escala).as_tuple().exponent
    return f"{dinero.redondear(Decimal(value), decimales):f}"
