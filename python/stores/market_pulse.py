"""Pulso del mercado: índices, sectores, amplitud y mayores subidas/bajadas.

Todo sale de dos proveedores ya conectados y sin clave: TradingView para
índices, ETF de sector, subidas/bajadas y amplitud; alternative.me para el
Fear & Greed de cripto.

Los índices y los ETF de sector son un catálogo curado, del mismo tipo que
`stores.benchmark` (que ya elige qué índices comparar con la cartera): no es
una lista para "arreglar" la cotización de un activo del usuario, es que aquí
no hay ningún activo del usuario, es una foto del mercado en general y esos
son los nombres con los que cualquier terminal de mercado la enseña.

Las subidas/bajadas y la amplitud, en cambio, sí son una consulta real al
screener (filtro + orden sobre todo el mercado): no hay ninguna lista de
acciones fijada de antemano, se le pregunta al mercado entero cuáles son.
"""

import time

from providers import tradingview_client
from providers.feargreed_client import (
    fetch_history as _fetch_fear_greed_history,
    fetch_index as _fetch_fear_greed_index,
)

MAJOR_INDICES = [
    {"key": "sp500", "ticker": "SP:SPX", "label": "S&P 500"},
    {"key": "nasdaq", "ticker": "NASDAQ:IXIC", "label": "Nasdaq Composite"},
    {"key": "dowjones", "ticker": "DJ:DJI", "label": "Dow Jones"},
    {"key": "vix", "ticker": "CBOE:VIX", "label": "VIX"},
    {"key": "dax", "ticker": "XETR:DAX", "label": "DAX"},
    {"key": "ibex", "ticker": "BME:IBC", "label": "IBEX 35"},
    {"key": "cac40", "ticker": "EURONEXT:PX1", "label": "CAC 40"},
    {"key": "ftse100", "ticker": "TVC:UKX", "label": "FTSE 100"},
    {"key": "eurostoxx", "ticker": "TVC:SX5E", "label": "EURO STOXX 50"},
    {"key": "nikkei", "ticker": "TVC:NI225", "label": "Nikkei 225"},
    {"key": "hangseng", "ticker": "TVC:HSI", "label": "Hang Seng"},
    {"key": "dxy", "ticker": "TVC:DXY", "label": "Índice dólar (DXY)"},
]

SECTOR_ETFS = [
    {"key": "tecnologia", "ticker": "AMEX:XLK", "label": "Tecnología"},
    {"key": "financiero", "ticker": "AMEX:XLF", "label": "Financiero"},
    {"key": "energia", "ticker": "AMEX:XLE", "label": "Energía"},
    {"key": "salud", "ticker": "AMEX:XLV", "label": "Salud"},
    {"key": "industrial", "ticker": "AMEX:XLI", "label": "Industrial"},
    {"key": "consumo_discrecional", "ticker": "AMEX:XLY", "label": "Consumo discrecional"},
    {"key": "consumo_basico", "ticker": "AMEX:XLP", "label": "Consumo básico"},
    {"key": "utilities", "ticker": "AMEX:XLU", "label": "Utilities"},
    {"key": "materiales", "ticker": "AMEX:XLB", "label": "Materiales"},
    {"key": "inmobiliario", "ticker": "AMEX:XLRE", "label": "Inmobiliario"},
    {"key": "comunicacion", "ticker": "AMEX:XLC", "label": "Comunicación"},
]

# Universo mínimamente líquido para "qué sube y qué baja" y la amplitud: sin
# esto ganaría cualquier microcap ilíquido que se mueve un 300 % con cuatro
# operaciones, que no dice nada sobre el mercado en general.
_LIQUID_US_FILTER = [
    {"left": "market_cap_basic", "operation": "greater", "right": 2_000_000_000},
    {"left": "average_volume_10d_calc", "operation": "greater", "right": 100_000},
    {"left": "exchange", "operation": "in_range", "right": ["NASDAQ", "NYSE", "AMEX"]},
]

_MOVERS_COLUMNS = ["name", "description", "close", "change", "market_cap_basic", "sector", "exchange"]
_RSI_COLUMNS = ["name", "description", "close", "change", "RSI", "sector", "exchange"]
_VOLUME_COLUMNS = ["name", "description", "close", "change", "relative_volume_10d_calc", "sector", "exchange"]

# Columnas para deduplicar cripto por moneda base real (`base_currency`), no
# por texto adivinado del ticker: "BTCUSD" en Binance y "BTCUSD" en Kraken son
# la misma moneda, pero "BTCRLUSD" (BTC cotizado en el stablecoin RLUSD) no se
# puede distinguir de forma fiable recortando sufijos a mano.
_CRYPTO_COLUMNS = ["base_currency", "base_currency_desc", "close", "change", "market_cap_calc"]

# Columnas para el Nasdaq 100 real: `indexes` trae la lista de índices de los
# que forma parte cada acción (lo mismo que enseña la propia ficha del activo
# en tradingview.com), así que la pertenencia sale de ahí, no de una lista de
# 100 tickers copiada a mano que se queda desactualizada en el próximo rebalanceo.
_NASDAQ100_COLUMNS = ["name", "description", "close", "change", "market_cap_basic", "indexes"]
_NASDAQ100_INDEX_PRONAME = "NASDAQ:NDX"

_SNAPSHOT_TTL = 180
_MOVERS_TTL = 180
_BREADTH_TTL = 180
_UNIVERSE_TTL = 180
_FEAR_GREED_TTL = 3600
_FEAR_GREED_HISTORY_TTL = 3600
_FEAR_GREED_HISTORY_DAYS = 365

_cache: dict = {}


def _cached(key, ttl, fetcher):
    """Sirve lo cacheado si no ha caducado; si `fetcher` falla, la excepción
    sube sin cachear nada, para que el siguiente intento no espere el TTL
    entero por un fallo puntual de red.
    """
    entrada = _cache.get(key)
    ahora = time.time()
    if entrada and ahora - entrada["ts"] < ttl:
        return entrada["valor"]
    valor = fetcher()
    _cache[key] = {"ts": ahora, "valor": valor}
    return valor


def _fila_stats(item, stats):
    datos = stats.get(item["ticker"])
    if not datos or not datos.get("close"):
        return {**item, "price": None, "change": None, "currency": None, "aum": None}
    return {
        **item,
        "price": datos.get("close"),
        "change": datos.get("change"),
        "currency": datos.get("currency") or None,
        # AUM de los ETF de sector: el tamaño con el que se dibuja el treemap
        # de sectores. No hay ninguna lista de "peso de cada sector en el
        # S&P 500" guardada a mano (eso cambia cada día); es el patrimonio real
        # del ETF que ya sigue ese sector, tal cual lo da TradingView. Los
        # índices no tienen AUM (no son un fondo) y llega `None`, no un 0.
        "aum": datos.get("aum"),
    }


def snapshot(timeout=None):
    """Cotización actual de índices y ETF de sector, en una sola petición.

    Usa `fetch_stats` (no el `fetch_quotes` más ligero) porque los ETF de
    sector necesitan además su AUM para el treemap; a los índices ese campo
    les llega `None`, que es justo lo que son.
    """
    def _fetch():
        tickers = [item["ticker"] for item in MAJOR_INDICES + SECTOR_ETFS]
        stats = tradingview_client.fetch_stats(tickers, timeout)
        return {
            "indices": [_fila_stats(item, stats) for item in MAJOR_INDICES],
            "sectores": [_fila_stats(item, stats) for item in SECTOR_ETFS],
        }

    return _cached("snapshot", _SNAPSHOT_TTL, _fetch)


def _screener_rows(payload, columns):
    """Filas del screener ya emparejadas símbolo → {columna: valor}, saltando
    las que vengan cortas (sin dato para alguna columna pedida)."""
    filas = []
    for row in payload.get("data") or []:
        symbol = row.get("s")
        valores = row.get("d") or []
        if not symbol or len(valores) < len(columns):
            continue
        filas.append((symbol, dict(zip(columns, valores, strict=False))))
    return filas


def top_movers(limit=10, timeout=None):
    """Las `limit` acciones de EE. UU. que más suben y más bajan hoy."""
    def _lado(orden):
        payload = tradingview_client.fetch_screener(
            _LIQUID_US_FILTER, _MOVERS_COLUMNS, sort_by="change", sort_order=orden,
            limit=limit, instrument_types=["stock"], timeout=timeout,
        )
        return [
            {
                "symbol": symbol,
                "ticker": datos.get("name"),
                "name": datos.get("description"),
                "price": datos.get("close"),
                "change": datos.get("change"),
                "marketCap": datos.get("market_cap_basic"),
                "sector": datos.get("sector"),
                "exchange": datos.get("exchange"),
            }
            for symbol, datos in _screener_rows(payload, _MOVERS_COLUMNS)
        ]

    def _fetch():
        return {"subidas": _lado("desc"), "bajadas": _lado("asc")}

    return _cached(f"movers_{limit}", _MOVERS_TTL, _fetch)


def rsi_extremes(limit=8, timeout=None):
    """Las `limit` acciones de EE. UU. con el RSI(14) más alto (más cerca de
    sobrecompra) y más bajo (más cerca de sobreventa) hoy, en el mismo
    universo líquido que `top_movers`.
    """
    def _lado(orden):
        payload = tradingview_client.fetch_screener(
            _LIQUID_US_FILTER, _RSI_COLUMNS, sort_by="RSI", sort_order=orden,
            limit=limit, instrument_types=["stock"], timeout=timeout,
        )
        return [
            {
                "symbol": symbol,
                "ticker": datos.get("name"),
                "name": datos.get("description"),
                "price": datos.get("close"),
                "change": datos.get("change"),
                "rsi": datos.get("RSI"),
                "sector": datos.get("sector"),
                "exchange": datos.get("exchange"),
            }
            for symbol, datos in _screener_rows(payload, _RSI_COLUMNS)
        ]

    def _fetch():
        return {"sobrecompra": _lado("desc"), "sobreventa": _lado("asc")}

    return _cached(f"rsi_{limit}", _MOVERS_TTL, _fetch)


def unusual_volume(limit=8, timeout=None):
    """Las `limit` acciones de EE. UU. cuyo volumen de hoy está más por
    encima de su propia media de 10 días: señal de que "algo está pasando"
    ahí, no una lista de qué acciones vigilar fijada de antemano.
    """
    def _fetch():
        payload = tradingview_client.fetch_screener(
            _LIQUID_US_FILTER, _VOLUME_COLUMNS, sort_by="relative_volume_10d_calc",
            sort_order="desc", limit=limit, instrument_types=["stock"], timeout=timeout,
        )
        return [
            {
                "symbol": symbol,
                "ticker": datos.get("name"),
                "name": datos.get("description"),
                "price": datos.get("close"),
                "change": datos.get("change"),
                "relativeVolume": datos.get("relative_volume_10d_calc"),
                "sector": datos.get("sector"),
                "exchange": datos.get("exchange"),
            }
            for symbol, datos in _screener_rows(payload, _VOLUME_COLUMNS)
        ]

    return _cached(f"volume_{limit}", _MOVERS_TTL, _fetch)


def breadth(timeout=None):
    """Cuántas acciones del mismo universo suben, bajan o están planas hoy."""
    def _contar(extra_filter):
        payload = tradingview_client.fetch_screener(
            _LIQUID_US_FILTER + extra_filter, ["name"], limit=1,
            instrument_types=["stock"], timeout=timeout,
        )
        return int(payload.get("totalCount") or 0)

    def _fetch():
        subidas = _contar([{"left": "change", "operation": "greater", "right": 0}])
        bajadas = _contar([{"left": "change", "operation": "less", "right": 0}])
        total = _contar([])
        planas = max(total - subidas - bajadas, 0)
        return {"subidas": subidas, "bajadas": bajadas, "planas": planas, "total": total}

    return _cached("breadth", _BREADTH_TTL, _fetch)


def top_cryptos(limit=30, timeout=None):
    """Las `limit` criptomonedas de mayor capitalización, una fila por moneda
    (no por par de cotización): el mismo par de cotización se repite en
    docenas de exchanges, así que se piden de golpe más filas de las que hacen
    falta (300) y se corta en la primera vez que aparece cada `base_currency`.
    """
    def _fetch():
        payload = tradingview_client.fetch_screener(
            [], _CRYPTO_COLUMNS, sort_by="market_cap_calc", sort_order="desc",
            limit=300, instrument_types=["spot"], market="crypto", timeout=timeout,
        )
        vistos = set()
        filas = []
        for row in payload.get("data") or []:
            symbol = row.get("s")
            valores = row.get("d") or []
            if not symbol or len(valores) < len(_CRYPTO_COLUMNS):
                continue
            datos = dict(zip(_CRYPTO_COLUMNS, valores, strict=False))
            base = datos.get("base_currency")
            if not base or base in vistos:
                continue
            vistos.add(base)
            filas.append({
                "symbol": symbol,
                "ticker": base,
                "name": datos.get("base_currency_desc") or base,
                "price": datos.get("close"),
                "change": datos.get("change"),
                "marketCap": datos.get("market_cap_calc"),
            })
            if len(filas) >= limit:
                break
        return filas

    return _cached(f"cryptos_{limit}", _MOVERS_TTL, _fetch)


def top_nasdaq100(limit=40, timeout=None):
    """Las `limit` acciones de mayor capitalización que estén hoy en el
    Nasdaq 100 de verdad (columna `indexes` de TradingView), no una lista de
    tickers copiada a mano que se desactualiza en cada rebalanceo del índice.
    """
    def _fetch():
        payload = tradingview_client.fetch_screener(
            [{"left": "exchange", "operation": "in_range", "right": ["NASDAQ"]}],
            _NASDAQ100_COLUMNS, sort_by="market_cap_basic", sort_order="desc",
            limit=300, instrument_types=["stock"], timeout=timeout,
        )
        filas = []
        for row in payload.get("data") or []:
            symbol = row.get("s")
            valores = row.get("d") or []
            if not symbol or len(valores) < len(_NASDAQ100_COLUMNS):
                continue
            datos = dict(zip(_NASDAQ100_COLUMNS, valores, strict=False))
            indices = datos.get("indexes") or []
            if not any((i or {}).get("proname") == _NASDAQ100_INDEX_PRONAME for i in indices):
                continue
            filas.append({
                "symbol": symbol,
                "ticker": datos.get("name"),
                "name": datos.get("description"),
                "price": datos.get("close"),
                "change": datos.get("change"),
                "marketCap": datos.get("market_cap_basic"),
            })
            if len(filas) >= limit:
                break
        return filas

    return _cached(f"nasdaq100_{limit}", _MOVERS_TTL, _fetch)


# A qué función corresponde cada universo del selector del treemap, y cómo se
# convierte su fila (que cada uno da con su propia forma) a lo único que pide
# el mosaico: symbol para el gráfico, primary/secondary para el texto, change
# para el color, size para el área y price/currency/sizeLabel para el tooltip
# al pasar el cursor.
def _universe_sp500():
    return [
        {
            "symbol": s["ticker"], "primary": s["label"], "secondary": "",
            "change": s["change"], "size": s["aum"], "sizeLabel": "Patrimonio del ETF (AUM)",
            "price": s["price"], "currency": s["currency"],
        }
        for s in snapshot()["sectores"]
    ]


# Con 40/30 filas el treemap quedaba con demasiados rectángulos diminutos
# donde ni el ticker cabía. 24 es el mismo orden de magnitud que enseñan los
# mapas de calor de cripto habituales (BTC, ETH, top ~20) y dentro de una
# tarjeta se lee bien.
_UNIVERSE_TREEMAP_LIMIT = 24


def _universe_cripto():
    return [
        {
            "symbol": c["symbol"], "primary": c["ticker"], "secondary": c["name"],
            "change": c["change"], "size": c["marketCap"], "sizeLabel": "Capitalización de mercado",
            "price": c["price"], "currency": "USD",
        }
        for c in top_cryptos(limit=_UNIVERSE_TREEMAP_LIMIT)
    ]


def _universe_nasdaq100():
    return [
        {
            "symbol": n["symbol"], "primary": n["ticker"], "secondary": n["name"],
            "change": n["change"], "size": n["marketCap"], "sizeLabel": "Capitalización de mercado",
            "price": n["price"], "currency": "USD",
        }
        for n in top_nasdaq100(limit=_UNIVERSE_TREEMAP_LIMIT)
    ]


_UNIVERSES = {
    "sp500": _universe_sp500,
    "cripto": _universe_cripto,
    "nasdaq100": _universe_nasdaq100,
}


def universe(clave):
    """Las filas del treemap de distribución para `clave` (`sp500`, `cripto`
    o `nasdaq100`), ya en la forma común que pinta el mosaico. `None` si
    `clave` no es ninguno de los tres, `[]` filtrado si una fila no tiene
    cambio o tamaño con los que dibujarse (nunca un 0 inventado).
    """
    fetcher = _UNIVERSES.get(clave)
    if not fetcher:
        return None

    def _fetch():
        filas = fetcher()
        return [f for f in filas if f["change"] is not None and f["size"]]

    return _cached(f"universe_{clave}", _UNIVERSE_TTL, _fetch)


def fear_greed(timeout=None):
    """`(datos, None)` o `(None, error)`. Cacheado una hora: la fuente lo
    actualiza como mucho una vez al día, no merece pedirlo en cada visita.
    """
    cacheado = _cache.get("fear_greed")
    ahora = time.time()
    if cacheado and ahora - cacheado["ts"] < _FEAR_GREED_TTL:
        return cacheado["valor"], None

    datos, error = _fetch_fear_greed_index(timeout)
    if error:
        return None, error

    _cache["fear_greed"] = {"ts": ahora, "valor": datos}
    return datos, None


def fear_greed_history(days=_FEAR_GREED_HISTORY_DAYS, timeout=None):
    """El histórico del índice, el más reciente primero. `(lista, None)` o
    `([], error)`. Cacheado una hora, igual que `fear_greed`.
    """
    clave = f"fear_greed_history_{days}"
    cacheado = _cache.get(clave)
    ahora = time.time()
    if cacheado and ahora - cacheado["ts"] < _FEAR_GREED_HISTORY_TTL:
        return cacheado["valor"], None

    serie, error = _fetch_fear_greed_history(days, timeout)
    if error:
        return [], error

    _cache[clave] = {"ts": ahora, "valor": serie}
    return serie, None
