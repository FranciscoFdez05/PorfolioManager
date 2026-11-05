"""Serie de un activo para el gráfico de su ficha.

Sale solo de `asset_snapshots`, el histórico que guarda la propia aplicación:
TradingView, el proveedor de la mayoría de los activos, no da cotizaciones
pasadas. A cambio, el gráfico empieza donde empiezan los snapshots del activo y
sus importes van siempre en euros, que es como se guardan.

El snapshot guarda el valor de la posición y no el precio, así que el precio por
participación se reconstruye dividiendo entre la cantidad de ese momento. Las
operaciones solo tienen fecha, sin hora, y a veces se apuntan días después de
hacerse: mientras tanto el snapshot todavía no las incluía, y dividir entre la
cantidad de esa fecha daría una caída de precio que nunca existió. Por eso el
coste del snapshot, que sí refleja lo que había al guardarlo, decide la cantidad.
"""

import bisect
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal

from core import dinero
from core.db import getDb
from core.fifo import FifoError, parseFecha
from stores import rendimiento_activo
from stores.fx_historico import tasa, tipoActualConMemo

_DIA = 86400
_HORA = 3600

# `cubeta` son los segundos que resume cada punto: un año de snapshots son decenas
# de miles de filas por activo, y el gráfico no puede pintar más que unos cientos.
# `hueco` es la distancia a partir de la cual la línea se corta en vez de unir dos
# puntos como si se conociera lo que pasó entre ellos.
RANGOS = {
    "1D": {"segundos": _DIA, "cubeta": 300, "hueco": 6 * _HORA},
    "7D": {"segundos": 7 * _DIA, "cubeta": 1800, "hueco": _DIA},
    "30D": {"segundos": 30 * _DIA, "cubeta": 4 * _HORA, "hueco": 2 * _DIA},
    "1A": {"segundos": 365 * _DIA, "cubeta": _DIA, "hueco": 7 * _DIA},
    "TODO": {"segundos": None, "cubeta": _DIA, "hueco": 7 * _DIA},
}

# Margen para colocar una operación en el snapshot más cercano. Cubre un servidor
# parado unos días; más allá, el punto ya no diría nada de esa fecha.
_TOLERANCIA_OPERACION = 3 * _DIA

# Diferencia relativa admitida entre el coste del snapshot y el de una posición.
# La de euros absorbe las comisiones, que el coste de los lotes no descuenta. En
# otra divisa además hay que absorber lo que se ha movido el cambio, porque el coste
# de los lotes se convierte con el de hoy y el del snapshot se convirtió con el suyo.
_TOLERANCIA_COSTE_EUROS = Decimal("0.05")
_TOLERANCIA_COSTE_OTRA_DIVISA = Decimal("0.20")

_CERO = Decimal("0")


class RangoInvalido(ValueError):
    """Rango que no está en `RANGOS`. La ruta lo traduce a un 400."""


class ActivoNoEncontrado(LookupError):
    """El activo no existe en el portfolio activo. La ruta lo traduce a un 404."""


@dataclass(frozen=True)
class _Tramo:
    """Posición tras los movimientos de un día, con su coste en euros."""

    dia: date
    cantidad: Decimal
    costeEur: Decimal


def _fechaLegible(texto) -> date | None:
    try:
        return parseFecha(texto)
    except FifoError:
        return None


def _fechasDeMovimientos(datos: dict) -> list[date]:
    """Días en los que cambió la posición, de todas las fuentes y sin repetir."""
    textos = [fila["fecha_operacion"] for fila in datos["filas"]]
    textos += [fila["fecha_apertura"] for fila in datos["operaciones"]]
    textos += [fila["fecha"] for fila in datos["ventas"]]
    textos += [fila["fecha_operacion"] for fila in datos["transacciones"]]
    textos += [fila["fecha"] for fila in datos["conversiones"]]
    return sorted({dia for dia in map(_fechaLegible, textos) if dia is not None})


def construirTramos(datos: dict, esCripto: bool, moneda: str, tipo) -> list[_Tramo]:
    """Línea temporal de la posición: un tramo por cada día con movimientos.

    Args:
        datos: Una entrada de `rendimiento_activo.cargarPosiciones`.
        esCripto: Si el activo es de tipo cripto.
        moneda: Divisa del activo.
        tipo: Función `(desde, hacia) -> Decimal | None` con el cambio de hoy.

    Returns:
        Tramos ordenados por día; el coste va en euros para poder compararlo con
        el del snapshot. El último, con día `date.max`, es la posición completa:
        `lotesVivos` cuenta las operaciones sin fecha legible en el total pero no
        al filtrar por día, así que ninguna fecha llegaría a esa cantidad. Solo se
        elige cuadrando por coste, porque ninguna fecha cae en él.
    """
    aEuros = Decimal("1") if moneda == "EUR" else (tipo(moneda, "EUR") or Decimal("1"))
    tramos = []
    for dia in [*_fechasDeMovimientos(datos), None]:
        lotes = rendimiento_activo.lotesVivos(
            datos["filas"], datos["operaciones"], esCripto, datos["ventas"], dia,
            datos["transacciones"], datos["conversiones"], moneda, tipo,
        )
        tramos.append(_Tramo(
            dia or date.max,
            sum((lote["cantidad"] for lote in lotes), _CERO),
            sum((lote["coste"] for lote in lotes), _CERO) * aEuros,
        ))
    return tramos


def cantidadDelSnapshot(
    ts: int, costeEur, tramos: list[_Tramo], dias: list[date], tolerancia: Decimal = _TOLERANCIA_COSTE_EUROS
) -> Decimal | None:
    """Participaciones que había cuando se guardó un snapshot.

    Manda la fecha. Si el coste del snapshot no cuadra con la posición de esa
    fecha, es que la operación se apuntó después de guardarlo, y se usa la
    posición cuyo coste sí cuadra. Si no cuadra con ninguna (operaciones borradas
    o una cartera sustituida al restaurar), no se puede saber: un precio dividido
    entre una cantidad que nunca existió se vería como un movimiento real. Sin
    coste (snapshots antiguos) solo queda la fecha.

    Args:
        ts: Instante del snapshot.
        costeEur: Coste guardado en el snapshot.
        tramos: Resultado de `construirTramos`.
        dias: El día de cada tramo, para buscar con bisección.
        tolerancia: Diferencia relativa de coste admitida.

    Returns:
        La cantidad, o None si no se puede saber.
    """
    indice = bisect.bisect_right(dias, date.fromtimestamp(ts)) - 1
    porFecha = tramos[indice] if indice >= 0 and tramos[indice].cantidad > 0 else None
    coste = dinero.aDecimal(costeEur or 0)
    if coste <= 0:
        return porFecha.cantidad if porFecha else None

    margen = tolerancia * coste
    if porFecha and abs(porFecha.costeEur - coste) <= margen:
        return porFecha.cantidad

    conPosicion = [tramo for tramo in tramos if tramo.cantidad > 0]
    if not conPosicion:
        return None
    mejor = min(conPosicion, key=lambda tramo: abs(tramo.costeEur - coste))
    return mejor.cantidad if abs(mejor.costeEur - coste) <= margen else None


def _leerSnapshots(conn, assetId: str, desdeTs: int, cubeta: int) -> list:
    # SQLite garantiza que, con un único MAX(), las demás columnas salen de esa
    # misma fila: cada cubeta se queda con su último snapshot.
    return conn.execute(
        "SELECT MAX(ts) AS ts, price_eur, cost_eur FROM asset_snapshots "
        "WHERE asset_id = ? AND ts >= ? AND price_eur > 0 GROUP BY ts / ? ORDER BY ts",
        (assetId, desdeTs, cubeta),
    ).fetchall()


def construirPuntos(filas, tramos: list[_Tramo], moneda: str = "EUR") -> list[dict]:
    """Puntos del gráfico: valor y coste en euros, y precio por participación."""
    dias = [tramo.dia for tramo in tramos]
    tolerancia = _TOLERANCIA_COSTE_EUROS if moneda == "EUR" else _TOLERANCIA_COSTE_OTRA_DIVISA
    puntos = []
    for fila in filas:
        cantidad = cantidadDelSnapshot(fila["ts"], fila["cost_eur"], tramos, dias, tolerancia)
        precio = dinero.aDecimal(fila["price_eur"]) / cantidad if cantidad else None
        puntos.append({
            "ts": fila["ts"],
            "valor": fila["price_eur"],
            "coste": fila["cost_eur"] or 0,
            "precio": float(dinero.redondear(precio, 8)) if precio is not None else None,
        })
    return puntos


def _importe(texto) -> Decimal:
    return rendimiento_activo.numero(texto)


def _operacion(tipoOperacion: str, textoFecha, cantidad: Decimal, precio: Decimal, divisa: str) -> dict | None:
    dia = _fechaLegible(textoFecha)
    if dia is None or cantidad <= 0:
        return None
    return {
        "tipo": tipoOperacion,
        "fecha": dia.strftime("%d-%m-%Y"),
        # A mediodía: sin hora, es el instante más cercano a cualquier momento del día.
        "ts": int(datetime.combine(dia, time(12)).timestamp()),
        "cantidad": float(cantidad),
        "precio": float(dinero.redondear(precio, 8)) if precio > 0 else None,
        "divisa": divisa,
    }


def _operacionesDeFicha(filas, esCripto: bool, moneda: str) -> list[dict | None]:
    resultado = []
    for fila in filas:
        tipoFila = str(fila["tipo_operacion"] or "").strip().lower()
        if tipoFila not in ("compra", "venta"):
            # «X convertidos» y similares son conversiones, no compras ni ventas.
            continue
        cantidad = _importe(fila["participaciones"])
        precio = _importe(fila["precio_participacion"])
        if precio <= 0 and cantidad > 0:
            precio = _importe(fila["capital_invertido_bruto"]) / cantidad
        # Solo las filas de cripto tienen divisa propia; el resto va en la del activo.
        divisa = str(fila["currency"] or moneda).strip().upper() if esCripto else moneda
        resultado.append(_operacion(tipoFila, fila["fecha_operacion"], cantidad, precio, divisa))
    return resultado


def _operacionesCompletadas(conn, assetId: str, moneda: str) -> list[dict | None]:
    # La fecha de cierre tampoco está en `cargarPosiciones`, que no la necesita. Si
    # la de apertura no se entiende, es la que dice cuándo se ejecutó la orden.
    filas = conn.execute(
        "SELECT fecha_apertura, fecha_cierre, orden, cantidad, precio_orden, precio_currency, total, currency "
        "FROM activo_operation_rows WHERE asset_id = ? AND estado = 'Completado' ORDER BY rowid",
        (assetId,),
    ).fetchall()
    resultado = []
    for fila in filas:
        tipoFila = str(fila["orden"] or "").strip().lower()
        if tipoFila not in ("compra", "venta"):
            continue
        cantidad = _importe(fila["cantidad"])
        precio = _importe(fila["precio_orden"])
        divisa = str(fila["precio_currency"] or fila["currency"] or moneda).strip().upper()
        if precio <= 0 and cantidad > 0:
            precio = _importe(fila["total"]) / cantidad
            divisa = str(fila["currency"] or moneda).strip().upper()
        textoFecha = fila["fecha_apertura"] if _fechaLegible(fila["fecha_apertura"]) else fila["fecha_cierre"]
        resultado.append(_operacion(tipoFila, textoFecha, cantidad, precio, divisa))
    return resultado


def _ventasRegistradas(conn, assetId: str, moneda: str) -> list[dict | None]:
    # El precio no está en `cargarPosiciones`, que solo necesita la cantidad.
    filas = conn.execute(
        "SELECT fecha, cantidad, valor_venta, currency FROM ventas WHERE asset_id = ? ORDER BY year, rowid",
        (assetId,),
    ).fetchall()
    return [
        _operacion(
            "venta", fila["fecha"], _importe(fila["cantidad"]), _importe(fila["valor_venta"]),
            str(fila["currency"] or moneda).strip().upper(),
        )
        for fila in filas
    ]


def _precioEnEuros(operacion: dict, tipo) -> float | None:
    """Precio de una operación en euros, la unidad de la línea del gráfico.

    Args:
        operacion: Resultado de `_operacion`.
        tipo: Función `(desde, hacia) -> Decimal | None` con el cambio de hoy.

    Returns:
        El precio convertido, o None si no hay precio o tipo de cambio.
    """
    if operacion["precio"] is None:
        return None
    # Sin descarga: una petición a Yahoo por operación bloquearía el gráfico. Si la
    # fecha no está en caché, el cambio de hoy solo desplaza un poco la marca.
    cambio, _origen, _fecha = tasa(operacion["divisa"], operacion["fecha"], permitirDescarga=False)
    if cambio is None:
        cambio = tipo(operacion["divisa"], "EUR")
    if cambio is None:
        return None
    return float(dinero.redondear(dinero.aDecimal(operacion["precio"]) * cambio, 8))


def _puntoMasParecidoDelDia(operacion: dict, puntos: list[dict], marcas: list[int], cercano: int) -> int:
    """Snapshot del día de la operación cuyo precio se parece más al suyo.

    Las operaciones no tienen hora: a mediodía, una compra hecha por la tarde caería
    antes de un movimiento que ya había ocurrido cuando se ejecutó.

    Args:
        operacion: Operación con `precioEur`.
        puntos: Puntos del gráfico, ordenados por `ts`.
        marcas: El `ts` de cada punto.
        cercano: Índice del punto más cercano en el tiempo, por si no se puede elegir.

    Returns:
        El índice elegido en `puntos`.
    """
    precio = operacion.get("precioEur")
    if precio is None:
        return cercano
    dia = date.fromtimestamp(operacion["ts"])
    inicio = bisect.bisect_left(marcas, int(datetime.combine(dia, time.min).timestamp()))
    fin = bisect.bisect_right(marcas, int(datetime.combine(dia, time.max).timestamp()))
    delDia = [i for i in range(inicio, fin) if puntos[i]["precio"] is not None]
    return min(delDia, key=lambda i: abs(puntos[i]["precio"] - precio), default=cercano)


def colocarOperaciones(operaciones: list[dict], puntos: list[dict]) -> tuple[list[dict], int]:
    """Asigna a cada operación su punto del gráfico.

    Es el punto más cercano o, si la operación tiene `precioEur` y hay snapshots de
    ese día, el de precio más parecido.

    Args:
        operaciones: Operaciones del tramo pedido.
        puntos: Puntos del gráfico, ordenados por `ts`.

    Returns:
        Las operaciones colocadas, con su `indice` en `puntos`, y cuántas no
        tienen ningún snapshot lo bastante cerca para colocarlas.
    """
    marcas = [punto["ts"] for punto in puntos]
    colocadas = []
    sinPunto = 0
    for operacion in operaciones:
        posicion = bisect.bisect_left(marcas, operacion["ts"])
        candidatos = [i for i in (posicion - 1, posicion) if 0 <= i < len(marcas)]
        indice = min(candidatos, key=lambda i: abs(marcas[i] - operacion["ts"]), default=None)
        if indice is None or abs(marcas[indice] - operacion["ts"]) > _TOLERANCIA_OPERACION:
            sinPunto += 1
            continue
        colocadas.append({**operacion, "indice": _puntoMasParecidoDelDia(operacion, puntos, marcas, indice)})
    return colocadas, sinPunto


def _primerSnapshot(conn, assetId: str) -> int | None:
    fila = conn.execute(
        "SELECT ts FROM asset_snapshots WHERE asset_id = ? AND price_eur > 0 ORDER BY ts LIMIT 1",
        (assetId,),
    ).fetchone()
    return fila["ts"] if fila else None


def datosDelGrafico(assetId: str, rango: str, ahora: float | None = None) -> dict:
    """Puntos y operaciones de un activo en el rango pedido.

    Args:
        assetId: Id del activo.
        rango: Una de las claves de `RANGOS`.
        ahora: Instante de referencia; por defecto, el actual.

    Returns:
        `{"rango", "moneda", "segundosHueco", "inicioHistorico", "puntos",
        "operaciones", "operacionesSinPunto"}`. Los importes de `puntos` van en
        euros, y el precio de cada operación en la divisa en que se hizo. Cada
        operación lleva además `precioEur`, la altura de su marca en la vista de
        precio, o None si no se puede convertir.

    Raises:
        RangoInvalido: Si `rango` no existe.
        ActivoNoEncontrado: Si el activo no existe.
    """
    ajustes = RANGOS.get(rango)
    if ajustes is None:
        raise RangoInvalido(f"Rango no admitido: {rango or 'vacío'}")

    conn = getDb()
    activo = conn.execute("SELECT type, currency FROM activos WHERE id = ?", (assetId,)).fetchone()
    if activo is None:
        raise ActivoNoEncontrado(assetId)

    ahora = datetime.now().timestamp() if ahora is None else ahora
    desdeTs = int(ahora - ajustes["segundos"]) if ajustes["segundos"] else 0
    esCripto = str(activo["type"] or "").strip().lower() == "cripto"
    moneda = str(activo["currency"] or "EUR").strip().upper() or "EUR"
    datos = rendimiento_activo.cargarPosiciones(conn).get(assetId) or {
        "filas": [], "operaciones": [], "ventas": [], "transacciones": [], "conversiones": [],
    }

    tipo = tipoActualConMemo()
    tramos = construirTramos(datos, esCripto, moneda, tipo)
    puntos = construirPuntos(_leerSnapshots(conn, assetId, desdeTs, ajustes["cubeta"]), tramos, moneda)

    # Se compara por día: la operación de ayer cae dentro de «las últimas 24 h» si
    # el rango llega a ese día, porque no se sabe a qué hora se hizo.
    diaInicial = date.fromtimestamp(desdeTs) if desdeTs else date.min
    candidatas = (
        _operacionesDeFicha(datos["filas"], esCripto, moneda)
        + _operacionesCompletadas(conn, assetId, moneda)
        + _ventasRegistradas(conn, assetId, moneda)
    )
    enRango = sorted(
        (
            {**op, "precioEur": _precioEnEuros(op, tipo)}
            for op in candidatas
            if op and date.fromtimestamp(op["ts"]) >= diaInicial
        ),
        key=lambda op: op["ts"],
    )
    operaciones, sinPunto = colocarOperaciones(enRango, puntos)

    return {
        "rango": rango,
        "moneda": "EUR",
        "segundosHueco": ajustes["hueco"],
        "inicioHistorico": _primerSnapshot(conn, assetId),
        "puntos": puntos,
        "operaciones": operaciones,
        "operacionesSinPunto": sinPunto,
    }
