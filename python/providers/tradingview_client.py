"""Cliente TradingView, sin API key.

Mathieu2301/TradingView-API habla con el feed en tiempo real de TradingView
por WebSocket (protocolo propio de sockets, streaming). Los otros cuatro
proveedores conectados aquí son síncronos por HTTP con `providers.fetchJson`
y no llevan ninguna dependencia nueva; mantener ese mismo patrón importaba más
que el streaming, así que este cliente usa el `scanner.tradingview.com` que
alimenta las tablas de la web —los mismos datos, en una foto en vez de un
flujo— y encaja tal cual en `stores.market_data` (caché + respaldo entre
proveedores) sin tocar esa lógica.

El símbolo va con la sintaxis de TradingView, `MERCADO:TICKER`
(`NASDAQ:AAPL`, `BINANCE:BTCUSDT`, `XETR:SAP`): por eso no es "portable" para
`stores.market_data._isPortableSymbol` y solo se usa cuando el activo lo
pide explícitamente, igual que ya pasa con la sintaxis de Finnhub para
cripto/forex.
"""

import re
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import unquote

from providers import (
    compactSymbol as _compactSymbol,
    fetchJson,
    formatDecimal as _formatDecimal,
    formatPercent as _formatPercent,
    normalizeText as _normalizeText,
)
from providers.http import motivoConexion

TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/global/scan"
TRADINGVIEW_SEARCH_URL = "https://symbol-search.tradingview.com/symbol_search/v3/"

# El scanner por ticker (`TRADINGVIEW_SCAN_URL`, mercado "global") vale para
# cotizar símbolos concretos, pero no hace screener: filtrar y ordenar todo un
# mercado pide su propio endpoint regional (`.../america/scan`, `.../spain/scan`...).
_CAP_COLUMNS = ["close", "currency", "market_cap_calc", "total_shares_outstanding", "description"]

def screenerUrl(market="america"):
    return f"https://scanner.tradingview.com/{market}/scan"

_SCAN_COLUMNS = ["close", "change", "currency", "description", "exchange", "type"]

# Columnas de fundamentales y técnico para la página de Estadísticas de
# mercado. Son los mismos nombres de campo que usa el scanner público de
# TradingView (los que alimentan sus propias tablas): no hay traducción ni
# preferencia por ningún campo concreto, se piden tal cual los pide la página.
_FUNDAMENTAL_COLUMNS = [
    "market_cap_basic",
    "aum",
    "price_earnings_ttm",
    "price_book_ratio",
    "price_sales_ratio",
    "earnings_per_share_basic_ttm",
    "earnings_per_share_diluted_yoy_growth_ttm",
    "dividend_yield_recent",
    "debt_to_equity",
    "return_on_equity",
    "return_on_assets",
    "sector",
    "industry",
    "country",
]

_TECHNICAL_COLUMNS = [
    "Recommend.All",
    "Recommend.MA",
    "Recommend.Other",
    "RSI",
    "MACD.macd",
    "MACD.signal",
    "SMA20",
    "SMA50",
    "SMA100",
    "SMA200",
    "EMA20",
    "EMA50",
    "EMA100",
    "EMA200",
    "ADX",
    "Stoch.K",
    "Stoch.D",
    "Pivot.M.Classic.R3",
    "Pivot.M.Classic.R2",
    "Pivot.M.Classic.R1",
    "Pivot.M.Classic.Middle",
    "Pivot.M.Classic.S1",
    "Pivot.M.Classic.S2",
    "Pivot.M.Classic.S3",
]

_STATS_COLUMNS = _SCAN_COLUMNS + _FUNDAMENTAL_COLUMNS + _TECHNICAL_COLUMNS

# La búsqueda de TradingView contesta 403 a peticiones sin pinta de navegador
# (a diferencia del scanner de cotizaciones, que no filtra por esto). No es un
# ajuste de despliegue -como el `user_agent` de [proveedores]-, es lo que pide
# este proveedor en concreto, igual que en yahoo_finance_client.py.
_SEARCH_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": "https://www.tradingview.com",
    "Referer": "https://www.tradingview.com/",
}

_TYPE_MAP = {
    "stock": "stock",
    "dr": "stock",
    "fund": "fund",
    "structured": "etf",
    "crypto": "crypto",
    "spot": "crypto",
    "forex": "forex",
    "futures": "futures",
    "index": "index",
    "cfd": "cfd",
    "bond": "bond",
    "economic": "economic",
    "option": "option",
    "commodity": "commodity",
    "swap": "perpetuo",
}

_TAG_RE = re.compile(r"</?em>")

# El scanner gratuito no tiene todos los cruces de divisa que sí se ven en
# tradingview.com: OANDA:XAUEUR no está pero OANDA:XAUUSD sí. Un cruce que falta
# se calcula como lo calculan los propios brókers: el par en dólares del mismo
# mercado entre su tipo de cambio. Comprobado contra el gráfico de OANDA:XAUEUR:
# 4284,97 / 1,13911 = 3761,68, lo mismo que marca TradingView.
#
# No hay ninguna lista de activos, mercados ni divisas: todo sale del ticker que
# eligió el usuario y de lo que devuelva la API. Si al mercado le falta el par
# en dólares o el tipo de cambio, el cruce se queda sin cotización.
_CROSS_RE = re.compile(r"^([A-Z]{3})([A-Z]{3})$")


def _stripMarkup(text):
    """TradingView resalta la coincidencia con `<em>` dentro de symbol/description."""
    return _TAG_RE.sub("", str(text or ""))


def _mapType(rawType):
    return _TYPE_MAP.get(str(rawType or "").strip().lower(), "market")


def _fetchJson(url, params=None, timeout=None, jsonBody=None, headers=None):
    return fetchJson(url, params, timeout=timeout, provider="TradingView", jsonBody=jsonBody, headers=headers)


def _scan(tickers, timeout=None):
    """`{ticker: (precio, variación %, divisa)}` de los que el scanner cotiza.

    Una sola petición para todos. Deja pasar HTTPError/URLError: cada llamante
    decide si eso es un error que enseñar o un "sin cotización".
    """
    if not tickers:
        return {}

    payload = _fetchJson(
        TRADINGVIEW_SCAN_URL,
        jsonBody={"symbols": {"tickers": list(tickers), "query": {"types": []}}, "columns": _SCAN_COLUMNS},
        timeout=timeout,
    )

    cotizados = {}
    for row in payload.get("data") or []:
        values = row.get("d") or []
        if not row.get("s") or len(values) < 3:
            continue
        price = float(values[0] or 0)
        if price <= 0:
            continue
        cotizados[row["s"]] = (price, float(values[1] or 0), str(values[2] or "").strip().upper())
    return cotizados


def fetchQuotes(tickers, timeout=None):
    """Envoltorio público de `_scan`, para catálogos curados (índices, ETF de
    sector) que no son un activo del usuario y no necesitan los cruces
    sintéticos de `fetchQuote` (esos solo tienen sentido para el ticker
    exacto que pide un activo en concreto).
    """
    return _scan(tickers, timeout)


def fetchScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                    instrumentTypes=None, market="america", timeout=None):
    """Consulta real al screener de TradingView: filtro + orden sobre todo un
    mercado, no una lista de tickers fijada de antemano. La usa
    `stores.market_pulse` para "qué sube y qué baja hoy" y la amplitud de
    mercado. Deja pasar HTTPError/URLError, igual que `_scan`.
    """
    payload = {
        "filter": filterClauses,
        "options": {"lang": "en"},
        "symbols": {"query": {"types": instrumentTypes or []}, "tickers": []},
        "columns": columns,
        "range": [0, max(1, limit)],
    }
    if sortBy:
        payload["sort"] = {"sortBy": sortBy, "sortOrder": sortOrder}

    return _fetchJson(screenerUrl(market), jsonBody=payload, timeout=timeout, headers=_SEARCH_HEADERS)


def fetchStats(tickers, timeout=None):
    """Fundamentales y técnico del scanner para varios tickers a la vez.

    Una sola petición para todos, como `_batchFetchQuotes`. Cada campo sale
    tal cual lo devuelve el scanner: `None` cuando ese dato no existe para el
    tipo de instrumento (una cripto no tiene sector, un índice no tiene PER),
    nunca un valor inventado para rellenar el hueco. Deja pasar
    HTTPError/URLError: quien llama decide si eso es un error que enseñar o
    una fila sin datos.
    """
    if not tickers:
        return {}

    payload = _fetchJson(
        TRADINGVIEW_SCAN_URL,
        jsonBody={"symbols": {"tickers": list(tickers), "query": {"types": []}}, "columns": _STATS_COLUMNS},
        timeout=timeout,
    )

    stats = {}
    for row in payload.get("data") or []:
        symbol = row.get("s")
        values = row.get("d") or []
        if not symbol:
            continue
        stats[symbol] = dict(zip(_STATS_COLUMNS, values, strict=False))
    return stats


def fetchCapitalizacion(tickers, timeout=None):
    """Precio, divisa, capitalización y acciones/monedas en circulación.

    Cada campo sale tal cual lo devuelve el scanner y es `None` cuando ese
    instrumento no lo publica (el oro no tiene capitalización): no se estima ni
    se rellena. Una sola petición para todos. Deja pasar HTTPError/URLError.
    """
    if not tickers:
        return {}

    payload = _fetchJson(
        TRADINGVIEW_SCAN_URL,
        jsonBody={"symbols": {"tickers": list(tickers), "query": {"types": []}}, "columns": _CAP_COLUMNS},
        timeout=timeout,
    )

    datos = {}
    for row in payload.get("data") or []:
        if not row.get("s"):
            continue
        d = dict(zip(_CAP_COLUMNS, row.get("d") or [], strict=False))
        datos[row["s"]] = {
            "precio": d.get("close"),
            "divisa": str(d.get("currency") or "").strip().upper() or None,
            "capitalizacion": d.get("market_cap_calc"),
            "suministro": d.get("total_shares_outstanding"),
            "nombre": d.get("description"),
        }
    return datos


def _crossPlan(ticker):
    """Con qué tickers se calcula el cruce `MERCADO:BBBQQQ` si el scanner no lo
    tiene, o None: `(par en USD, cambio QQQUSD, cambio USDQQQ, divisa QQQ)`.

    Se piden las dos orientaciones del tipo de cambio porque cada divisa cotiza
    en una (EURUSD pero USDJPY) y eso no se supone: se usa la que exista.
    """
    exchange, _, symbol = ticker.partition(":")
    match = _CROSS_RE.match(symbol)
    if not exchange or not match:
        return None

    base, target = match.groups()
    if "USD" in (base, target):
        return None  # ya es un par en dólares: no hay de dónde calcularlo

    return f"{exchange}:{base}USD", f"{exchange}:{target}USD", f"{exchange}:USD{target}", target


def _syntheticQuotes(tickers, timeout=None):
    """Calcula los cruces que el scanner no tiene: `{ticker: (precio, variación %,
    divisa, origen)}`. Una sola petición para todas las piezas que hagan falta."""
    plans = {ticker: plan for ticker in tickers if (plan := _crossPlan(ticker))}
    if not plans:
        return {}

    piezas = sorted({pieza for base, directo, inverso, _ in plans.values() for pieza in (base, directo, inverso)})
    try:
        cotizados = _scan(piezas, timeout)
    except (HTTPError, URLError):
        return {}

    calculados = {}
    for ticker, (base, directo, inverso, target) in plans.items():
        if cotizados.get(base, (0, 0, ""))[2] != "USD":
            continue
        basePrice, baseChange, _ = cotizados[base]

        # La variación del cruce no es la resta de las dos: se compone.
        if directo in cotizados:  # QQQUSD: dólares por unidad, se divide
            fx = directo
            fxPrice, fxChange, _ = cotizados[fx]
            price = basePrice / fxPrice
            change = ((1 + baseChange / 100) / (1 + fxChange / 100) - 1) * 100
        elif inverso in cotizados:  # USDQQQ: unidades por dólar, se multiplica
            fx = inverso
            fxPrice, fxChange, _ = cotizados[fx]
            price = basePrice * fxPrice
            change = ((1 + baseChange / 100) * (1 + fxChange / 100) - 1) * 100
        else:
            continue

        calculados[ticker] = (price, change, target, f"{base} / {fx}")

    return calculados


def fetchQuote(symbol, timeout=None):
    # Quien copia el símbolo desde la URL de tradingview.com (?symbol=BINANCE%3ABTCUSD)
    # se lleva los dos puntos codificados: la barra de direcciones no los decodifica
    # siempre. Sin este `unquote` ese pegado no tiene ":" y cae directo en el error
    # de abajo aunque el ticker sea correcto.
    normalizedSymbol = unquote(str(symbol or "").strip()).upper()

    if not normalizedSymbol:
        return None, "El ticker de TradingView es obligatorio"

    if ":" not in normalizedSymbol:
        return None, "El ticker de TradingView necesita el mercado delante (p.ej. NASDAQ:AAPL)"

    try:
        cotizados = _scan([normalizedSymbol], timeout)
    except HTTPError as error:
        return None, f"TradingView devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con TradingView: {motivoConexion(error, 'TradingView')}"

    status = "Cotización actualizada"
    if normalizedSymbol in cotizados:
        currentPrice, percentChange, currency = cotizados[normalizedSymbol]
        currency = currency or "USD"
    else:
        calculado = _syntheticQuotes([normalizedSymbol], timeout).get(normalizedSymbol)
        if not calculado:
            return None, "TradingView no devolvió cotización para ese ticker"
        currentPrice, percentChange, currency, origen = calculado
        # Se dice de dónde sale: no es la cotización de ese ticker en concreto
        # sino la del par en dólares pasada por el cambio, y puede diferir en
        # el diferencial del bróker.
        status = f"Cotización calculada ({origen})"

    previousClose = currentPrice / (1 + percentChange / 100) if percentChange != -100 else currentPrice

    return {
        "symbol": normalizedSymbol,
        "price": _formatDecimal(currentPrice),
        "currency": currency,
        "change": _formatPercent(percentChange),
        "status": status,
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": currentPrice,
            "percentChange": percentChange,
            "previousClose": previousClose
        }
    }, None


# Qué tipos de la API corresponden a cada tipo de activo de la aplicación (el
# que eliges al crear el activo). Es la traducción entre el vocabulario de la
# app y el de TradingView, no una preferencia por ningún activo, marca ni
# mercado: qué resultado encaja lo deciden tu elección y el tipo que da la API.
_TIPOS_API_POR_CATEGORIA = {
    "acciones": {"stock", "dr"},
    "etfs": {"fund", "structured"},
    "cripto": {"crypto", "spot"},
    "comoditis": {"commodity", "futures", "cfd"},
}


def _scoreResult(symbol, description, queryText, normalizedAssetName="", rankIndex=0):
    """Relevancia de un resultado, solo con lo que escribió el usuario y lo que
    dice la API: sin listas de palabras, marcas ni mercados preferidos."""
    normalizedQuery = _normalizeText(queryText)
    compactQuery = _compactSymbol(queryText)
    compactSymbol = _compactSymbol(symbol)
    normalizedDescription = _normalizeText(description)

    # TradingView ya devuelve sus propios resultados ordenados por relevancia.
    # Este suelo, que baja con la posición original, hace que esa ordenación
    # mande salvo que el símbolo o el nombre coincidan mejor con lo buscado.
    score = max(0, 200 - rankIndex * 6)

    if compactQuery:
        if compactSymbol == compactQuery:
            score += 500
        elif compactSymbol.startswith(compactQuery):
            score += 220
        if normalizedQuery and normalizedQuery in normalizedDescription:
            score += 180

    if normalizedAssetName:
        if normalizedAssetName == normalizedDescription:
            score += 260
        elif normalizedAssetName in normalizedDescription:
            score += 160

    return score


def _batchFetchQuotes(symbols, timeout=None):
    """Cotiza varios símbolos de una vez: una sola llamada al scanner, no una
    por resultado. El scanner ya acepta una lista de `tickers`; usarla aquí es
    lo que permite mirar más candidatos de golpe sin multiplicar peticiones.
    """
    if not symbols:
        return {}

    try:
        cotizados = _scan(symbols, timeout)
    except (HTTPError, URLError):
        return {}

    # Los que el scanner no tiene y son un cruce calculable con piezas del mismo
    # mercado (OANDA:XAUEUR) salen con precio en vez de "sin cotización".
    faltan = [symbol for symbol in symbols if symbol not in cotizados]
    for symbol, (price, change, currency, _origen) in _syntheticQuotes(faltan, timeout).items():
        cotizados[symbol] = (price, change, currency)

    return {
        symbol: {
            "price": _formatDecimal(price),
            "currency": currency,
            "change": _formatPercent(change),
        }
        for symbol, (price, change, currency) in cotizados.items()
    }


def _searchSymbolRequest(text, exchange, timeout):
    return _fetchJson(
        TRADINGVIEW_SEARCH_URL,
        {
            "text": text,
            "hl": 1,
            "exchange": exchange,
            "lang": "en",
            "search_type": "undefined",
            "domain": "production",
        },
        timeout=timeout,
        headers=_SEARCH_HEADERS,
    )


def searchSymbol(queryText, timeout=None, limit=8, assetName="", preferredAssetType=""):
    normalizedQuery = unquote(str(queryText or "").strip())

    if not normalizedQuery:
        return None, "Escribe un nombre o ticker para buscar"

    # Si pegan un ticker ya con mercado (p.ej. "BITVAVO:BTCEUR", copiado del
    # propio campo "Ticker mercado" o de la URL de TradingView), mandar los dos
    # puntos dentro de `text` no encuentra ese mercado: la búsqueda de
    # TradingView no lo interpreta como filtro, solo como texto suelto, y el
    # resultado que sale primero suele ser el de un mercado distinto (comprobado
    # contra la API real: "BITVAVO:BTCEUR" como texto devuelve Bybit/Bitfinex,
    # nunca Bitvavo). Separarlo en `text` + `exchange` sí filtra de verdad.
    exchangeFilter = ""
    searchText = normalizedQuery
    if ":" in normalizedQuery:
        possibleExchange, possibleSymbol = normalizedQuery.split(":", 1)
        if possibleExchange.strip() and possibleSymbol.strip():
            exchangeFilter = possibleExchange.strip().upper()
            searchText = possibleSymbol.strip()

    try:
        payload = _searchSymbolRequest(searchText, exchangeFilter, timeout)
        # Un prefijo que no es un código de mercado real de TradingView filtra a
        # cero en vez de dar error (comprobado: "exchange" inválido -> lista
        # vacía). Repetir como texto libre evita dejar al usuario sin nada por
        # una suposición nuestra que no encaja.
        if exchangeFilter and not (payload.get("symbols") or []):
            payload = _searchSymbolRequest(normalizedQuery, "", timeout)
    except HTTPError as error:
        return None, f"TradingView devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con TradingView: {motivoConexion(error, 'TradingView')}"

    rawResults = payload.get("symbols") or []
    normalizedAssetName = _normalizeText(assetName)
    tiposCategoria = _TIPOS_API_POR_CATEGORIA.get(str(preferredAssetType or "").strip().lower())
    rankedResults = []
    seenSymbols = set()

    for rankIndex, item in enumerate(rawResults):
        exchange = str(item.get("exchange", "")).strip().upper()
        rawSymbol = _stripMarkup(item.get("symbol", "")).strip().upper()
        description = _stripMarkup(item.get("description", "")).strip()
        rawType = str(item.get("type", "")).strip().lower()
        currency = str(item.get("currency_code", "")).strip().upper()

        if not rawSymbol or not exchange or not description:
            continue

        fullSymbol = f"{exchange}:{rawSymbol}"

        if fullSymbol in seenSymbols:
            continue

        seenSymbols.add(fullSymbol)
        score = _scoreResult(rawSymbol, description, normalizedQuery, normalizedAssetName, rankIndex)
        # Sin tipo de activo elegido, todos cuentan igual.
        enCategoria = rawType in tiposCategoria if tiposCategoria else True
        rankedResults.append((score, enCategoria, {
            "symbol": fullSymbol,
            "displaySymbol": fullSymbol,
            "description": description,
            "type": _mapType(rawType),
            "exchange": exchange,
            "provider": "tradingview",
            "price": "",
            "currency": currency,
            "change": ""
        }))

    # Primero lo que la API marca como del tipo de activo elegido; dentro, por
    # relevancia. Así, buscando "XAG" en un activo de materias primas, la plata
    # de los brókers (tipo "commodity") va antes que los contratos perpetuos de
    # los exchanges de cripto (tipo "swap"), sin nombrar a ninguno de los dos.
    rankedResults.sort(key=lambda row: (not row[1], -row[0], row[2]["symbol"]))

    # Se cotiza un grupo más amplio que lo que se va a enseñar (`_ENRICH_POOL`,
    # no `limit`): mirar la cotización solo cambia si un resultado sale al
    # final antes de saber si es el que sirve. Hay listados que el scanner
    # gratuito no tiene aunque coticen en tradingview.com, y sin este margen uno
    # sin precio se quedaba en el hueco de otro mercado del mismo instrumento
    # que sí lo tiene y rankeaba justo un poco peor.
    _ENRICH_POOL = max(limit, 20)
    candidates = [(enCategoria, item) for _, enCategoria, item in rankedResults[:_ENRICH_POOL]]
    quotes = _batchFetchQuotes([item["symbol"] for _, item in candidates], timeout=timeout)

    for _, candidate in candidates:
        quote = quotes.get(candidate["symbol"])
        if quote:
            candidate["price"] = quote["price"]
            candidate["currency"] = quote["currency"]
            candidate["change"] = quote["change"]

    # Sort estable: dentro del tipo de activo elegido va antes lo que tiene
    # cotización, y a igualdad se respeta el orden de relevancia.
    candidates.sort(key=lambda pair: (not pair[0], pair[1]["price"] == ""))

    return [item for _, item in candidates[:limit]], None
