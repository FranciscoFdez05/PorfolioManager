"""Valora la cartera en el servidor, sin navegador de por medio.

Hasta ahora la única cifra de "cuánto vale el portfolio" la calculaba el
frontend (`refreshTopPortfolioMetrics`) y el servidor se limitaba a guardarla.
Eso ataba el histórico a que hubiera una pestaña abierta, y desde que la
rentabilidad anual se calcula con Modified Dietz sobre esos puntos, cada semana
sin abrir la web degradaba la métrica.

Las piezas se reutilizan, no se reimplementan:

  * la posición viva y su coste salen del FIFO del servidor
    (`ventas_fifo.cartera_viva`), el mismo motor que liquida las ventas;
  * las cotizaciones, de `stores.market_data`, el mismo despacho por proveedor
    que usa `/api/market/quote`;
  * el cambio a euros, de `fetch_exchange_rate`, que no gasta clave de API.

Lo que devuelve tiene la forma que espera `routes.snapshots.guardar_snapshot`,
que es la misma que manda el frontend.
"""

import logging
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

from core import dinero, settings
from core.db import get_db
from providers.finnhub_client import fetch_exchange_rate
from stores import ventas_fifo
from stores.helpers import normalize_currency_code
from stores.market_data import fetch_asset_quote

log = logging.getLogger(__name__)


class _Cambios:
    """Tipos de cambio a euros pedidos una sola vez por ejecución.

    El tipo llega del proveedor como float —ahí no hay elección— pero se guarda
    y se aplica como Decimal: este multiplicador entra en el valor de **toda**
    la cartera, y era el punto donde el error de coma flotante se amplificaba
    por el importe más grande del cálculo.
    """

    def __init__(self):
        self._cache = {"EUR": Decimal("1")}

    def a_euros(self, importe, moneda):
        divisa = normalize_currency_code(moneda, fallback="EUR")
        if divisa not in self._cache:
            rate, error = fetch_exchange_rate(divisa, "EUR")
            if error or not rate or rate <= 0:
                log.warning("[valoracion] Sin cambio %s→EUR (%s); se valora 1:1", divisa, error)
                rate = 1
            self._cache[divisa] = dinero.aDecimal(rate, "tipo de cambio", defecto=Decimal("1"))
        return dinero.aDecimal(importe) * self._cache[divisa]


def _activos_en_cartera():
    """Datos de mercado de los activos que tienen posición viva."""
    cartera = ventas_fifo.cartera_viva()
    if not cartera:
        return []

    conn = get_db()
    filas = conn.execute(
        "SELECT id, market_provider, market_symbol, finnhub_symbol, price, currency FROM activos"
    ).fetchall()

    activos = []
    for fila in filas:
        posicion = cartera.get(fila["id"])
        if posicion is None:
            continue
        moneda = normalize_currency_code(fila["currency"], fallback="EUR")
        activos.append({
            "id":        fila["id"],
            "proveedor": fila["market_provider"],
            "simbolo":   str(fila["market_symbol"] or fila["finnhub_symbol"] or "").strip(),
            # `price` es una columna TEXT en formato español; `dinero` la lee
            # sin pasar por float, que es lo que hacía `_parse_num`.
            "precio":    dinero.aDecimal(fila["price"], "precio", defecto=Decimal("0")),
            "moneda":    moneda,
            # La cotización puede venir en otra divisa que la de la ficha, y el
            # coste está apuntado en la de la ficha: se guardan por separado
            # para no convertir el invertido con el cambio equivocado.
            "monedaCoste": moneda,
            # El FIFO ya las devuelve en Decimal: convertirlas a float aquí
            # tiraba la precisión del único motor que la mantenía.
            "cantidad":  posicion["cantidad"],
            "coste":     posicion["coste"],
        })

    return activos


def _refrescar_precios(activos):
    """Pide cotización fresca de cada activo. Devuelve cuántas se obtuvieron.

    Un fallo no invalida el snapshot: ese activo se valora con el último precio
    conocido. Un hueco en el histórico hace más daño que un punto con un precio
    de hace unas horas, y el aviso queda en el log.
    """
    con_simbolo = [a for a in activos if a["simbolo"]]
    if not con_simbolo:
        return 0

    def _pedir(activo):
        try:
            return activo, fetch_asset_quote(activo["simbolo"], activo["proveedor"])
        except Exception as e:  # el hilo del scheduler no puede morir por esto
            return activo, (None, str(e))

    frescos = 0
    with ThreadPoolExecutor(max_workers=settings.maxPeticionesParalelas()) as pool:
        for activo, (quote, error) in pool.map(_pedir, con_simbolo):
            # `price` viene formateado a la española ("345,90"): float() directo
            # reventaba aquí, fuera del try de `_pedir`, y se llevaba por delante
            # el snapshot entero de la cartera por un solo activo. `dinero` lo
            # lee en Decimal y devuelve el defecto si no hay dato, que es lo que
            # descarta el activo unas líneas más abajo.
            precio = dinero.aDecimal((quote or {}).get("price"), "cotización", defecto=Decimal("0"))
            if error or precio <= 0:
                log.info("[valoracion] %s conserva su último precio (%s)", activo["id"], error or "sin cotización")
                continue
            activo["precio"] = precio
            activo["moneda"] = normalize_currency_code((quote or {}).get("currency"), fallback=activo["moneda"])
            frescos += 1

    return frescos


def valorar_portfolio(refrescar_precios=True):
    """Valor y coste de la cartera en euros, más el desglose por activo.

    Devuelve `{"total_value", "total_invested", "assets": [{"id", "v", "c"}],
    "precios_frescos", "activos": n}`.
    """
    activos = _activos_en_cartera()
    frescos = _refrescar_precios(activos) if refrescar_precios else 0

    cambios = _Cambios()
    total_value = Decimal("0")
    total_invested = Decimal("0")
    desglose = []

    for activo in activos:
        valor_eur = cambios.a_euros(activo["cantidad"] * activo["precio"], activo["moneda"])
        coste_eur = cambios.a_euros(activo["coste"], activo["monedaCoste"])

        total_value += valor_eur
        total_invested += coste_eur
        if valor_eur > 0:
            # `float` aquí y no antes: las columnas del histórico son REAL, así
            # que el punto acaba en coma flotante igualmente. La diferencia es
            # que ahora se convierte **el total ya sumado en Decimal** en vez de
            # ir acumulando el error activo a activo.
            desglose.append({
                "id": activo["id"],
                "v": float(dinero.redondear(valor_eur)),
                "c": float(dinero.redondear(coste_eur)),
            })

    return {
        "total_value":     float(dinero.redondear(total_value)),
        "total_invested":  float(dinero.redondear(total_invested)),
        "assets":          desglose,
        "precios_frescos": frescos,
        "activos":         len(activos),
    }
