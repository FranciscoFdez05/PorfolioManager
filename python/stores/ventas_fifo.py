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

from decimal import Decimal

from core import fifo, fiscal_es
from core.db import get_db
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


def mensaje_incidencia(codigo):
    return _MENSAJES.get(codigo, "")


def _es_cripto(tipo):
    return str(tipo or "").strip().lower() == "cripto"


def _cargar_activos():
    conn = get_db()
    return {
        row["id"]: {"id": row["id"], "name": row["name"], "type": row["type"]}
        for row in conn.execute("SELECT id, name, type FROM activos")
    }


def _operaciones_de_fichas():
    """Movimientos apuntados en la ficha de cada activo y en sus operaciones."""
    conn = get_db()
    por_activo = {}

    filas = conn.execute(
        "SELECT id, asset_id, fecha_operacion, tipo_operacion, participaciones, "
        "precio_participacion, capital_invertido_bruto, comisiones, comisiones_fiat "
        "FROM activo_rows ORDER BY asset_id, id"
    ).fetchall()

    activos = _cargar_activos()

    for fila in filas:
        activo = activos.get(fila["asset_id"])
        if activo is None:
            continue
        cripto = _es_cripto(activo["type"])
        cantidad = _num(fila["participaciones"])
        if cantidad <= 0:
            continue

        tipo_operacion = str(fila["tipo_operacion"] or "").strip().lower()
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
            fecha = fifo.parse_fecha(fila["fecha_operacion"])
        except fifo.FifoError:
            # Una fila de la ficha sin fecha legible no puede ordenarse. Se
            # ignora en vez de tumbar el cálculo de todo el activo; la ficha
            # tiene su propia pantalla para corregirla.
            continue

        por_activo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=f"{fila['asset_id']}:ficha:{fila['id']}",
            activo_id=fila["asset_id"],
            fecha=fecha,
            tipo=TRANSMISION if tipo_operacion == "venta" else ADQUISICION,
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
            fecha = fifo.parse_fecha(fila["fecha_apertura"])
        except fifo.FifoError:
            continue

        es_venta = str(fila["orden"] or "").strip().lower() == "venta"
        por_activo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=f"{fila['asset_id']}:op:{fila['id']}",
            activo_id=fila["asset_id"],
            fecha=fecha,
            tipo=TRANSMISION if es_venta else ADQUISICION,
            cantidad=cantidad,
            importe=_num(fila["total"]),
            comision=_num(fila["comisiones_fiat"]),
            # Desplazado para que, a igual fecha, las operaciones vayan después
            # de las filas de la ficha y el orden sea siempre el mismo.
            orden=1_000_000 + int(fila["seq"]),
            origen="operacion",
            fiscal=False,
        ))

    return por_activo, activos


def _leer_ventas_crudas():
    conn = get_db()
    return conn.execute(
        "SELECT rowid AS seq, id, year, fecha, asset_id, cantidad, valor_venta, comision_venta "
        "FROM ventas ORDER BY year, rowid"
    ).fetchall()


def validar_venta(fila, activos):
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
        fecha = fifo.parse_fecha(fila["fecha"])
    except fifo.FifoError:
        return None, INCIDENCIA_FECHA

    if str(fecha.year) != str(fila["year"]):
        return None, INCIDENCIA_ANIO

    return {"fecha": fecha, "cantidad": cantidad, "precio": precio}, ""


def calcular_todo():
    """Liquida todas las ventas de todos los ejercicios.

    Se calcula siempre sobre el histórico completo, nunca sobre un año suelto:
    el coste FIFO de una venta de 2026 depende de lo que se vendiera en 2025, y
    calcular un año aislado es justamente el fallo que tenía la versión
    anterior.

    Devuelve `{"filas": {(anio, id): dato}, "liquidaciones": {...},
    "incidencias": [...]}`.
    """
    por_activo, activos = _operaciones_de_fichas()
    ventas = _leer_ventas_crudas()

    invalidas = {}
    for fila in ventas:
        datos, incidencia = validar_venta(fila, activos)
        clave = (fila["year"], fila["id"])
        if incidencia:
            invalidas[clave] = incidencia
            continue

        ref = f"venta:{fila['year']}:{fila['id']}"
        por_activo.setdefault(fila["asset_id"], []).append(Operacion(
            ref=ref,
            activo_id=fila["asset_id"],
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

    resultados_por_ref = {}
    lotes_vivos = {}
    for activo_id, operaciones in por_activo.items():
        tipo = activos.get(activo_id, {}).get("type", "")
        resultados, lotes = fiscal_es.calcular_con_normativa(operaciones, tipo)
        lotes_vivos[activo_id] = lotes
        for resultado in resultados:
            resultados_por_ref[resultado.ref] = resultado

    # Agrupa por ejercicio solo los resultados fiscales (los de la ficha mueven
    # la posición pero no declaran).
    resultados_por_anio = {}
    for fila in ventas:
        clave = (fila["year"], fila["id"])
        if clave in invalidas:
            continue
        resultado = resultados_por_ref.get(f"venta:{fila['year']}:{fila['id']}")
        if resultado is not None:
            resultados_por_anio.setdefault(fila["year"], []).append(resultado)

    # Un ejercicio existente sin ventas válidas también necesita liquidación
    # (a cero) para que la pantalla tenga algo que enseñar.
    conn = get_db()
    for row in conn.execute("SELECT year FROM ventas_years"):
        resultados_por_anio.setdefault(row["year"], [])

    liquidaciones = fiscal_es.liquidar_ejercicios(resultados_por_anio)

    filas = {}
    incidencias = []
    for anio, resultados in resultados_por_anio.items():
        liquidacion = liquidaciones[str(anio)]
        reparto = fiscal_es.repartir_cuota_por_venta(
            resultados, liquidacion, fiscal_es.escala_del_ejercicio(anio)
        )
        for resultado in resultados:
            _, venta_id = resultado.ref.rsplit(":", 1)
            filas[(anio, venta_id)] = _serializar_fila(
                resultado, reparto.get(resultado.ref, {})
            )
            if resultado.incidencia:
                incidencias.append({
                    "year": anio,
                    "id": venta_id,
                    "codigo": resultado.incidencia,
                    "mensaje": mensaje_incidencia(resultado.incidencia),
                })

    for (anio, venta_id), codigo in invalidas.items():
        filas[(anio, venta_id)] = fila_vacia(codigo)
        incidencias.append({
            "year": anio,
            "id": venta_id,
            "codigo": codigo,
            "mensaje": mensaje_incidencia(codigo),
        })

    return {
        "filas": filas,
        "liquidaciones": liquidaciones,
        "incidencias": incidencias,
        "lotes_vivos": lotes_vivos,
    }


def _serializar_fila(resultado, tramos):
    if resultado.incidencia:
        fila = fila_vacia(resultado.incidencia)
        fila["stockDisponible"] = _money(resultado.disponible_antes, escala="0.00000001")
        fila["bruto"] = _money(resultado.valor_transmision)
        return fila

    cuota = sum(tramos.values(), Decimal("0"))
    ganancia = resultado.ganancia_computable

    return {
        "valorCompra": _money(resultado.coste_unitario),
        "costeAdquisicion": _money(resultado.coste_adquisicion),
        "valorTransmision": _money(resultado.valor_transmision),
        "dineroDeclarar": _money(ganancia),
        "tramo1": _money(tramos.get("tramo1", 0)),
        "tramo2": _money(tramos.get("tramo2", 0)),
        "tramo3": _money(tramos.get("tramo3", 0)),
        "tramo4": _money(tramos.get("tramo4", 0)),
        "tramo5": _money(tramos.get("tramo5", 0)),
        "totalPagar": _money(cuota),
        "bruto": _money(resultado.valor_transmision),
        "neto": _money(resultado.valor_transmision - cuota),
        "stockDisponible": _money(resultado.disponible_antes, escala="0.00000001"),
        "perdidaNoComputable": _money(resultado.perdida_no_computable),
        "perdidaDiferidaLiberada": _money(resultado.perdida_diferida_liberada),
        "notaAntiaplicacion": resultado.nota_antiaplicacion,
        "incidencia": "",
        "mensaje": "",
        "lotes": [
            {
                "ref": consumo.lote_ref,
                "fecha": consumo.fecha_adquisicion.strftime("%d-%m-%Y"),
                "cantidad": _money(consumo.cantidad, escala="0.00000001"),
                "costeUnitario": _money(consumo.coste_unitario, escala="0.0001"),
                "coste": _money(consumo.coste),
                "origen": consumo.origen,
            }
            for consumo in resultado.lotes
        ],
    }


def fila_vacia(incidencia=""):
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
        "mensaje": mensaje_incidencia(incidencia),
        "lotes": [],
    }


def serializar_liquidacion(liquidacion):
    """Resumen anual listo para JSON."""
    return {
        "year": liquidacion.anio,
        "ganancias": _money(liquidacion.ganancias),
        "perdidas": _money(liquidacion.perdidas),
        "saldo": _money(liquidacion.saldo),
        "compensadoAnteriores": _money(liquidacion.compensado_anteriores),
        "base": _money(liquidacion.base),
        "cuota": _money(liquidacion.cuota),
        "tramos": {k: _money(v) for k, v in liquidacion.tramos.items()},
        "saldoNegativoGenerado": _money(liquidacion.saldo_negativo_generado),
        "pendienteCompensar": _money(liquidacion.pendiente_compensar),
        "perdidasNoComputables": _money(liquidacion.perdidas_no_computables),
        "perdidasDiferidasLiberadas": _money(liquidacion.perdidas_diferidas_liberadas),
    }


def _num(value):
    try:
        return fifo.parse_decimal(value)
    except fifo.FifoError:
        return Decimal("0")


def _money(value, escala="0.01"):
    """Importe como cadena con punto decimal, apta para JSON y para la BD."""
    if value is None or value == "":
        return ""
    return f"{fifo.cuantizar(Decimal(value), Decimal(escala)):f}"
