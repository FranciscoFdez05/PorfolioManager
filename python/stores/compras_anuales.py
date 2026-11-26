"""Compras de cada año y rendimiento de lo que sigue en cartera de ellas.

Alimenta el «Resumen anual de activos» de Métricas: para cada año, qué activos
se compraron, cuánto se invirtió, qué parte sigue en cartera y cuánto rinde hoy
esa parte. Lo ya vendido solo cuenta como porcentaje vendido; su ganancia es
cosa del FIFO fiscal de Ventas.

La posición sale de `stores.rendimiento_activo`, el mismo FIFO que valora la
ficha y la tabla principal, para que la suma de todos los años cuadre con el
invertido y el valor actual de la cartera. El coste es el bruto (comisiones
incluidas en el lote), así que el rendimiento de cada año ya va neto de ellas.
"""

import logging
from collections.abc import Callable
from decimal import Decimal

from core import dinero
from stores import rendimiento_activo
from stores.fx_historico import tipoActualConMemo

log = logging.getLogger(__name__)

CERO = Decimal("0")
CIEN = Decimal("100")
EURO = "EUR"

_CONSULTA_ACTIVOS = "SELECT id, name, symbol, type, currency, price FROM activos"


def resumenComprasPorAnio(conn, tipo: Callable | None = None) -> dict:
    """Compras agrupadas por año de adquisición, con su rendimiento latente en euros.

    Args:
        conn: Conexión a la base del portfolio activo.
        tipo: Función `(desde, hacia) -> Decimal | None` con el cambio de hoy.
            Por defecto, `tipoActualConMemo()`; se inyecta en los tests.

    Returns:
        `{"anios": [...], "sinTipo": [...]}`. `anios` va del más reciente al más
        antiguo y cada año lleva sus activos ordenados por importe comprado.
        `sinTipo` lista las divisas sin cambio conocido, cuyos importes se han
        sumado sin convertir.

    Example:
        >>> resumenComprasPorAnio(getDb())["anios"][0]["anio"]
        2026
    """
    tipo = tipo or tipoActualConMemo()
    posiciones = rendimiento_activo.cargarPosiciones(conn)
    sinTipo: set[str] = set()

    activosPorAnio: dict[int, list[dict]] = {}
    for activo in conn.execute(_CONSULTA_ACTIVOS):
        datos = posiciones.get(activo["id"])
        if datos is None:
            continue
        for anio, fila in _comprasDeActivo(activo, datos, tipo, sinTipo).items():
            activosPorAnio.setdefault(anio, []).append(fila)

    if sinTipo:
        log.warning("[compras_anuales] Sin cambio a EUR para %s; importes sin convertir", sorted(sinTipo))

    anios = [_resumenDelAnio(anio, filas) for anio, filas in sorted(activosPorAnio.items(), reverse=True)]
    return {"anios": anios, "sinTipo": sorted(sinTipo)}


def _comprasDeActivo(activo, datos: dict, tipo: Callable, sinTipo: set) -> dict[int, dict]:
    """Fila de un activo por cada año en que tuvo entradas, en euros (sin redondear)."""
    moneda = str(activo["currency"] or EURO).strip().upper() or EURO
    esCripto = str(activo["type"] or "").strip().lower() == "cripto"
    compras = rendimiento_activo.comprasPorAnio(
        datos["filas"], datos["operaciones"], esCripto, datos["ventas"],
        datos["transacciones"], datos["conversiones"], moneda, tipo,
    )
    factor = _factorAEuros(moneda, tipo, sinTipo)
    precio = rendimiento_activo.numero(activo["price"])

    filas = {}
    for anio, compra in compras.items():
        if compra.cantidadComprada <= 0:
            continue
        filas[anio] = {
            "id": activo["id"],
            "nombre": activo["name"] or activo["symbol"] or activo["id"],
            "tipo": activo["type"] or "",
            "cantidadComprada": compra.cantidadComprada,
            "cantidadViva": compra.cantidadViva,
            "comprado": compra.costeComprado * factor,
            "costeVivo": compra.costeVivo * factor,
            "valorActual": compra.cantidadViva * precio * factor,
        }
    return filas


def _factorAEuros(moneda: str, tipo: Callable, sinTipo: set) -> Decimal:
    """Euros por unidad de `moneda`; 1 (y se apunta) si no hay cambio conocido.

    Se deja 1 en vez de descartar el activo, igual que la tabla principal: el
    importe queda en su divisa y la interfaz avisa con `sinTipo`.
    """
    if moneda == EURO:
        return Decimal("1")
    cambio = tipo(moneda, EURO)
    if cambio is None or cambio <= 0:
        sinTipo.add(moneda)
        return Decimal("1")
    return cambio


def _resumenDelAnio(anio: int, filas: list[dict]) -> dict:
    """Totales de un año y sus activos, listos para JSON."""
    comprado = sum((f["comprado"] for f in filas), CERO)
    costeVivo = sum((f["costeVivo"] for f in filas), CERO)
    valorActual = sum((f["valorActual"] for f in filas), CERO)
    # El % vendido del año se pondera por coste: sumar participaciones de
    # activos distintos no significa nada.
    pctVendido = (comprado - costeVivo) / comprado * CIEN if comprado > 0 else CERO
    activos = sorted((_serializarActivo(f) for f in filas), key=lambda a: a["comprado"], reverse=True)
    return {
        "anio": anio,
        "comprado": _euros(comprado),
        "costeVivo": _euros(costeVivo),
        "valorActual": _euros(valorActual),
        **_rendimiento(valorActual, costeVivo),
        "pctVendido": _euros(pctVendido),
        "numActivos": len(activos),
        "activos": activos,
    }


def _serializarActivo(fila: dict) -> dict:
    """Fila de un activo dentro de un año, redondeada una sola vez al final."""
    comprada = fila["cantidadComprada"]
    pctVendido = (comprada - fila["cantidadViva"]) / comprada * CIEN if comprada > 0 else CERO
    return {
        "id": fila["id"],
        "nombre": fila["nombre"],
        "tipo": fila["tipo"],
        "cantidadComprada": float(dinero.redondear(comprada, 8)),
        "cantidadViva": float(dinero.redondear(fila["cantidadViva"], 8)),
        "comprado": _euros(fila["comprado"]),
        "costeVivo": _euros(fila["costeVivo"]),
        "valorActual": _euros(fila["valorActual"]),
        **_rendimiento(fila["valorActual"], fila["costeVivo"]),
        "pctVendido": _euros(pctVendido),
    }


def _rendimiento(valorActual: Decimal, costeVivo: Decimal) -> dict:
    """Rendimiento latente en euros y en porcentaje sobre el coste vivo.

    Sin coste vivo el porcentaje es None, no cero: una entrada sin coste
    (cripto recibida de fuera) o ya vendida entera no tiene base sobre la que
    medir, y un 0 % se leería como «ni gana ni pierde».
    """
    rendimiento = valorActual - costeVivo
    pct = rendimiento / costeVivo * CIEN if costeVivo > 0 else None
    return {"rendimiento": _euros(rendimiento), "rendimientoPct": None if pct is None else _euros(pct)}


def _euros(valor: Decimal) -> float:
    return float(dinero.redondear(valor))
