import logging
import re
import time
from datetime import datetime
from urllib.error import HTTPError, URLError

from core import dinero
from providers import (
    compactSymbol as _compactSymbol,
    fetchJson,
    formatDecimal as _formatDecimal,
    formatPercent as _formatPercent,
    normalizeText as _normalizeText,
)

log = logging.getLogger(__name__)


def _mensajeHttp(error):
    """Traduce el código de Finnhub a algo que diga qué hacer.

    Finnhub contesta 403 «You don't have access to this resource» cuando la
    clave es correcta pero el plan no cubre lo que se ha pedido: en el plan
    gratuito, cualquier bolsa fuera de EE. UU. y todos los históricos. Un
    «Finnhub devolvió HTTP 403» mandaba a revisar la clave —lo único que el
    usuario puede tocar— y ahí no estaba el problema, así que no se encontraba
    nunca.
    """
    if error.code == 401:
        return "Finnhub rechaza la API key (HTTP 401)"
    if error.code == 403:
        return "El plan de Finnhub no cubre ese mercado (HTTP 403)"
    if error.code == 429:
        return "Finnhub: límite de peticiones alcanzado (HTTP 429)"
    return f"Finnhub devolvió HTTP {error.code}"


def _providerFromUrl(url: str) -> str:
    if "finnhub.io" in url:
        return "Finnhub"
    if "frankfurter.app" in url or "er-api.com" in url:
        return "Tipo de cambio"
    return "Otro"

FINNHUB_QUOTE_URL = "https://finnhub.io/api/v1/quote"
FINNHUB_SEARCH_URL = "https://finnhub.io/api/v1/search"
FINNHUB_CRYPTO_SYMBOLS_URL = "https://finnhub.io/api/v1/crypto/symbol"
FINNHUB_FOREX_SYMBOLS_URL = "https://finnhub.io/api/v1/forex/symbol"
FRANKFURTER_LATEST_URL = "https://api.frankfurter.app/latest"
EXCHANGE_RATE_API_URL = "https://open.er-api.com/v6/latest"
LOCAL_SYMBOL_SOURCES = (
    ("crypto", "BINANCE", FINNHUB_CRYPTO_SYMBOLS_URL),
    ("forex", "OANDA", FINNHUB_FOREX_SYMBOLS_URL),
)
PREFERRED_QUOTES = ("USDT", "USD", "USDC", "BUSD", "EUR")
SYMBOL_CACHE = {}
QUOTE_CURRENCY_ALIASES = {
    "USD": "USD",
    "USDT": "USD",
    "USDC": "USD",
    "BUSD": "USD",
    "EUR": "EUR",
    "GBP": "GBP",
    "CHF": "CHF",
    "JPY": "JPY",
}
MARKET_SUFFIX_CURRENCIES = {
    ".DE": "EUR",
    ".PA": "EUR",
    ".MI": "EUR",
    ".MC": "EUR",
    ".AS": "EUR",
    ".BR": "EUR",
    ".LS": "EUR",
    ".VI": "EUR",
    ".ST": "SEK",
    ".SW": "CHF",
    ".L": "GBP",
}
FRANKFURTER_CURRENCIES_URL = "https://api.frankfurter.app/currencies"
# La lista de divisas del servicio de cambio casi no cambia: se pide una vez al
# día como mucho, en vez de en cada apertura del modal que la enseña.
_CURRENCIES_TTL_SECONDS = 24 * 3600
_currenciesCache = {"divisas": None, "ts": 0.0}
SEARCH_QUERY_ALIASES = {}
PREFERRED_EXCHANGES_BY_TYPE = {
    "acciones": {"XNYS", "XNAS", "NYSE", "NASDAQ", "ARCX", "BATS", "XNCM"},
    "etfs": {"ARCX", "XNAS", "XNYS", "BATS", "NASDAQ", "NYSE"},
}


def _fetchJson(url, params, timeout=None):
    return fetchJson(url, params, timeout=timeout, provider=_providerFromUrl(url))


def _fetchJsonAbsolute(url, timeout=None):
    return fetchJson(url, timeout=timeout, provider=_providerFromUrl(url))


def _normalizeCurrencyCode(currency, fallback="EUR"):
    normalized = QUOTE_CURRENCY_ALIASES.get(
        str(currency or "").strip().upper(),
        str(currency or "").strip().upper()
    )
    return normalized or fallback


# Puntos según el tipo de resultado, para cada tipo de activo buscado. Se
# aplica la primera fila que coincide (eran ramas if/elif).
_PUNTOS_POR_TIPO = {
    "acciones": ((("common stock", "adr", "etp", "etf"), 220), (("crypto", "forex"), -220)),
    "etfs": ((("etf", "etp", "fund"), 320), (("common stock",), 60), (("crypto", "forex"), -320)),
    "cripto": ((("crypto",), 220), (("common stock", "forex"), -160)),
    "comoditis": ((("forex",), 260), (("common stock",), -180)),
}
_PALABRAS_COMODITIS = ("gold", "silver", "oil", "brent", "crude")
_PALABRAS_FONDO = ("etf", "fund", "ucits", "ishares", "vanguard", "invesco", "spdr", "xtrackers", "amundi")


def _puntosPorBusqueda(normalizedQuery, compactSymbol, compactDisplay, symbol, normalizedDescription):
    if not normalizedQuery:
        return 0
    puntos = 0
    if normalizedQuery in (compactSymbol, compactDisplay):
        puntos += 500
    if compactSymbol.startswith(normalizedQuery) or compactDisplay.startswith(normalizedQuery):
        puntos += 200
    if normalizedQuery in normalizedDescription:
        puntos += 180
    if normalizedQuery in _normalizeText(symbol):
        puntos += 140
    return puntos


def _puntosPorNombre(normalizedAssetName, normalizedDescription):
    if not normalizedAssetName:
        return 0
    if normalizedAssetName == normalizedDescription:
        return 260
    return 180 if normalizedAssetName in normalizedDescription else 0


def _puntosPorTipo(preferredAssetType, resultType, normalizedDescription):
    puntos = next(
        (valor for tipos, valor in _PUNTOS_POR_TIPO.get(preferredAssetType, ()) if resultType in tipos), 0
    )
    if preferredAssetType == "comoditis" and any(p in normalizedDescription for p in _PALABRAS_COMODITIS):
        puntos += 220
    return puntos


def _puntosPorMercado(preferredAssetType, exchange, normalizedDescription):
    puntos = 0
    if exchange in PREFERRED_EXCHANGES_BY_TYPE.get(preferredAssetType, ()):
        puntos += 80
    if preferredAssetType in {"acciones", "etfs"} and any(p in normalizedDescription for p in _PALABRAS_FONDO):
        puntos += 70 if preferredAssetType == "etfs" else 20
    return puntos


def _scoreRemoteSymbol(item, normalizedQuery, normalizedAssetName="", preferredAssetType=""):
    symbol = str(item.get("symbol", "")).strip().upper()
    displaySymbol = str(item.get("displaySymbol", symbol)).strip().upper()
    normalizedDescription = _normalizeText(str(item.get("description", "")).strip())
    resultType = str(item.get("type", "")).strip().lower()
    exchange = str(item.get("exchange", "")).strip().upper()

    return (
        _puntosPorBusqueda(normalizedQuery, _compactSymbol(symbol), _compactSymbol(displaySymbol),
                             symbol, normalizedDescription)
        + _puntosPorNombre(normalizedAssetName, normalizedDescription)
        + _puntosPorTipo(preferredAssetType, resultType, normalizedDescription)
        + _puntosPorMercado(preferredAssetType, exchange, normalizedDescription)
    )


def _extractCodeCandidates(queryText, remoteResults):
    normalizedQuery = str(queryText or "").strip()
    compactQuery = _compactSymbol(normalizedQuery)
    candidates = []

    if 2 <= len(compactQuery) <= 10:
        candidates.append(compactQuery)

    for result in remoteResults:
        searchableText = " ".join([
            str(result.get("symbol", "")),
            str(result.get("displaySymbol", "")),
            str(result.get("description", "")),
        ]).upper()

        for token in re.findall(r"\b[A-Z0-9]{2,10}\b", searchableText):
            if token not in candidates:
                candidates.append(token)

    return candidates


def _getCachedSymbols(symbolType, exchange, url, apiKey, timeout=None):
    cacheKey = (symbolType, exchange)

    if cacheKey in SYMBOL_CACHE:
        return SYMBOL_CACHE[cacheKey]

    data = _fetchJson(url, {
        "exchange": exchange,
        "token": apiKey
    }, timeout=timeout)

    normalizedData = []

    for item in data:
        symbol = str(item.get("symbol", "")).strip().upper()
        description = str(item.get("description", "")).strip()
        displaySymbol = str(item.get("displaySymbol", symbol)).strip().upper() or symbol

        if not symbol or not description:
            continue

        normalizedData.append({
            "symbol": symbol,
            "description": description,
            "displaySymbol": displaySymbol,
            "type": symbolType
        })

    SYMBOL_CACHE[cacheKey] = normalizedData
    return normalizedData


def _scoreLocalSymbol(item, normalizedQuery, candidateCodes, normalizedAssetName="", preferredAssetType=""):
    symbol = item["symbol"]
    displaySymbol = item["displaySymbol"]
    description = item["description"]
    compactDisplay = displaySymbol.replace("/", "").replace("_", "")
    normalizedDescription = _normalizeText(description)
    score = 0

    if normalizedQuery and normalizedQuery in _normalizeText(symbol):
        score += 120

    if normalizedQuery and normalizedQuery in _normalizeText(displaySymbol):
        score += 160

    if normalizedQuery and normalizedQuery in normalizedDescription:
        score += 80

    if normalizedAssetName:
        if normalizedAssetName == normalizedDescription:
            score += 220
        elif normalizedAssetName in normalizedDescription:
            score += 160

    for index, code in enumerate(candidateCodes):
        if not code:
            continue

        weight = max(10, 60 - (index * 4))

        # El ticker empieza por el código buscado, sea cual sea el mercado: antes
        # solo contaba en BINANCE, COINBASE y OANDA, una lista fija de mercados.
        if symbol.split(":", 1)[-1].replace("_", "").startswith(code):
            score += weight + 90

        if compactDisplay.startswith(code):
            score += weight + 70

        for quoteIndex, quote in enumerate(PREFERRED_QUOTES):
            quoteWeight = max(5, 40 - (quoteIndex * 5))

            if compactDisplay == f"{code}{quote}":
                score += weight + quoteWeight + 90
            elif compactDisplay.startswith(f"{code}{quote}"):
                score += weight + quoteWeight + 50

    if preferredAssetType == "acciones" and item.get("type") in {"crypto", "forex"}:
        score -= 220

    if preferredAssetType == "etfs":
        if item.get("type") == "crypto":
            score -= 320
        elif item.get("type") == "forex":
            score -= 260

    if preferredAssetType == "cripto":
        if item.get("type") == "crypto":
            score += 220
        elif item.get("type") == "forex":
            score -= 120

    if preferredAssetType == "comoditis":
        if item.get("type") == "forex":
            score += 280
        elif item.get("type") == "crypto":
            score -= 220

        if any(token in normalizedDescription for token in ("gold", "silver", "oil", "brent", "crude")):
            score += 240

    return score


def _searchLocalSymbols(queryText, remoteResults, apiKey, timeout=None, limit=8, assetName="", preferredAssetType=""):
    normalizedQuery = _normalizeText(queryText)
    normalizedAssetName = _normalizeText(assetName)
    candidateCodes = _extractCodeCandidates(queryText, remoteResults)
    rankedResults = []
    seenSymbols = set()

    for symbolType, exchange, url in LOCAL_SYMBOL_SOURCES:
        symbols = _getCachedSymbols(symbolType, exchange, url, apiKey, timeout=timeout)

        for item in symbols:
            score = _scoreLocalSymbol(item, normalizedQuery, candidateCodes, normalizedAssetName, preferredAssetType)

            if score <= 0:
                continue

            symbol = item["symbol"]

            if symbol in seenSymbols:
                continue

            seenSymbols.add(symbol)
            rankedResults.append((score, item))

    rankedResults.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    return [item for _, item in rankedResults[:limit]]


def inferCurrencyFromSymbol(symbol, fallback="USD"):
    normalizedSymbol = str(symbol or "").strip().upper()

    if not normalizedSymbol:
        return fallback

    if ":" in normalizedSymbol:
        marketSymbol = normalizedSymbol.split(":", 1)[1]

        if "_" in marketSymbol:
            quoteCurrency = marketSymbol.split("_")[-1]
            return QUOTE_CURRENCY_ALIASES.get(quoteCurrency, quoteCurrency or fallback)

        compactSymbol = marketSymbol.replace("/", "")

        for quoteCurrency in sorted(QUOTE_CURRENCY_ALIASES.keys(), key=len, reverse=True):
            if compactSymbol.endswith(quoteCurrency):
                return QUOTE_CURRENCY_ALIASES[quoteCurrency]

    for suffix, currency in MARKET_SUFFIX_CURRENCIES.items():
        if normalizedSymbol.endswith(suffix):
            return currency

    return fallback


def fetchQuote(symbol, apiKey, timeout=None):
    normalizedSymbol = str(symbol or "").strip().upper()

    if not normalizedSymbol:
        return None, "El ticker de Finnhub es obligatorio"

    if not apiKey:
        return None, "No se ha encontrado la API key de Finnhub"

    try:
        payload = _fetchJson(FINNHUB_QUOTE_URL, {
            "symbol": normalizedSymbol,
            "token": apiKey
        }, timeout=timeout)
    except HTTPError as error:
        return None, _mensajeHttp(error)
    except URLError:
        return None, "No se pudo conectar con Finnhub"

    currentPrice = float(payload.get("c") or 0)
    percentChange = float(payload.get("dp") or 0)
    previousClose = float(payload.get("pc") or 0)

    if currentPrice <= 0 and previousClose <= 0:
        return None, f"Finnhub no devolvió cotización para {normalizedSymbol} (precio 0: ticker desconocido, fuera del plan gratuito o mercado sin datos)"

    return {
        "symbol": normalizedSymbol,
        "price": _formatDecimal(currentPrice),
        "currency": inferCurrencyFromSymbol(normalizedSymbol),
        "change": _formatPercent(percentChange),
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": currentPrice,
            "percentChange": percentChange,
            "previousClose": previousClose
        }
    }, None


def fetchExchangeRate(sourceCurrency, targetCurrency, timeout=None):
    source = _normalizeCurrencyCode(sourceCurrency)
    target = _normalizeCurrencyCode(targetCurrency)

    if source == target:
        return 1.0, None

    # No hay lista propia de divisas "que funcionan": qué se puede convertir lo
    # dice el servicio de cambio, y si no conoce una divisa contesta con error
    # (que llega abajo como "No se pudo obtener el cambio").
    try:
        payload = _fetchJson(FRANKFURTER_LATEST_URL, {
            "from": source,
            "to": target
        }, timeout=timeout)
        rate = float((payload.get("rates") or {}).get(target) or 0)

        if rate > 0:
            return rate, None
    except HTTPError:
        pass
    except URLError:
        pass
    except TimeoutError:
        pass

    try:
        payload = _fetchJsonAbsolute(f"{EXCHANGE_RATE_API_URL}/{source}", timeout=timeout)
    except HTTPError as error:
        return None, f"Cambio de divisa devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar al servicio de cambio de divisa"
    except TimeoutError:
        return None, "El servicio de cambio de divisa tardó demasiado en responder"

    result = str(payload.get("result", "")).lower()

    if result not in {"success", ""}:
        return None, "El servicio de cambio de divisa no devolvió una respuesta válida"

    rate = float((payload.get("rates") or {}).get(target) or 0)

    if rate <= 0:
        return None, f"No se pudo obtener el cambio {source}/{target}"

    return rate, None


def fetchExchangeRates(baseCurrency, targetCurrencies, timeout=None):
    """Tipos de cambio de `base_currency` a varias divisas, en una petición.

    Mismas fuentes y en el mismo orden que `fetchExchangeRate` (Frankfurter y,
    si falla, open.er-api.com), para que lo que se enseña en Ajustes sea lo que
    de verdad se usa al convertir. Devuelve `(datos, error)` con
    `datos = {"rates": {divisa: tipo}, "fuente": str, "fecha": str}`.
    """
    base = _normalizeCurrencyCode(baseCurrency)
    targets = [t for t in dict.fromkeys(_normalizeCurrencyCode(t) for t in targetCurrencies) if t != base]
    if not targets:
        return {"rates": {}, "fuente": "", "fecha": ""}, None

    try:
        payload = _fetchJson(FRANKFURTER_LATEST_URL, {"from": base, "to": ",".join(targets)}, timeout=timeout)
        rates = {t: float(r) for t, r in (payload.get("rates") or {}).items() if float(r or 0) > 0}
        if rates:
            return {"rates": rates, "fuente": "Frankfurter (referencia diaria del BCE)",
                    "fecha": str(payload.get("date") or "")}, None
    except (HTTPError, URLError, TimeoutError, ValueError):
        pass

    try:
        payload = _fetchJsonAbsolute(f"{EXCHANGE_RATE_API_URL}/{base}", timeout=timeout)
    except HTTPError as error:
        return None, f"Cambio de divisa devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar al servicio de cambio de divisa"
    except TimeoutError:
        return None, "El servicio de cambio de divisa tardó demasiado en responder"

    todas = payload.get("rates") or {}
    rates = {t: float(todas[t]) for t in targets if float(todas.get(t) or 0) > 0}
    if not rates:
        return None, f"No se pudo obtener el cambio desde {base}"
    return {"rates": rates, "fuente": "open.er-api.com (diario)",
            "fecha": str(payload.get("time_last_update_utc") or "")}, None


def fetchCurrencies(timeout=None):
    """Divisas que publica el servicio de cambio: `({código: nombre}, error)`."""
    ahora = time.monotonic()
    if _currenciesCache["divisas"] and ahora - _currenciesCache["ts"] < _CURRENCIES_TTL_SECONDS:
        return dict(_currenciesCache["divisas"]), None

    try:
        payload = _fetchJsonAbsolute(FRANKFURTER_CURRENCIES_URL, timeout=timeout)
    except HTTPError as error:
        return None, f"El servicio de cambio de divisa devolvió HTTP {error.code}"
    except (URLError, TimeoutError):
        return None, "No se pudo conectar al servicio de cambio de divisa"

    if not isinstance(payload, dict) or not payload:
        return None, "El servicio de cambio de divisa no devolvió una respuesta válida"

    divisas = {str(codigo).strip().upper(): str(nombre).strip() for codigo, nombre in payload.items()}
    _currenciesCache["divisas"] = divisas
    _currenciesCache["ts"] = ahora
    return dict(divisas), None


def convertAmount(value, sourceCurrency, targetCurrency, timeout=None):
    """Convierte un importe de divisa. Devuelve `Decimal`, no `float`.

    El tipo de cambio llega de la API como float —ahí no hay elección— pero la
    multiplicación se hace en Decimal: el resultado acaba guardado en una
    columna de importes, y `float(value) * rate` metía la cola binaria del
    producto en el dato almacenado.
    """
    rate, error = fetchExchangeRate(sourceCurrency, targetCurrency, timeout=timeout)

    if error:
        return None, error

    return dinero.aDecimal(value, "importe a convertir") * dinero.aDecimal(rate, "tipo de cambio"), None


def convertQuoteCurrency(quote, targetCurrency, timeout=None):
    if not quote:
        return None, "No hay cotización para convertir"

    sourceCurrency = _normalizeCurrencyCode(quote.get("currency", ""), "USD")
    targetCurrency = _normalizeCurrencyCode(targetCurrency, sourceCurrency)

    if sourceCurrency == targetCurrency:
        convertedQuote = dict(quote)
        convertedQuote["currency"] = targetCurrency
        convertedQuote["marketData"] = {
            **quote.get("marketData", {}),
            "sourceCurrency": sourceCurrency,
            "sourcePrice": float(quote.get("marketData", {}).get("currentPrice") or 0),
            "exchangeRate": 1.0
        }
        return convertedQuote, None

    currentPrice = float(quote.get("marketData", {}).get("currentPrice") or 0)
    previousClose = float(quote.get("marketData", {}).get("previousClose") or 0)
    exchangeRate, error = fetchExchangeRate(sourceCurrency, targetCurrency, timeout=timeout)

    if error:
        return None, error

    convertedCurrentPrice = currentPrice * exchangeRate
    convertedPreviousClose = previousClose * exchangeRate if previousClose > 0 else 0

    convertedQuote = dict(quote)
    convertedQuote["price"] = _formatDecimal(convertedCurrentPrice)
    convertedQuote["currency"] = targetCurrency
    convertedQuote["status"] = f"Cotización actualizada ({sourceCurrency}->{targetCurrency})"
    convertedQuote["marketData"] = {
        **quote.get("marketData", {}),
        "currentPrice": convertedCurrentPrice,
        "previousClose": convertedPreviousClose,
        "sourceCurrency": sourceCurrency,
        "sourcePrice": currentPrice,
        "exchangeRate": exchangeRate
    }

    return convertedQuote, None


def enrichSearchResultsWithQuote(results, apiKey, timeout=None):
    enrichedResults = []

    for item in results:
        enrichedItem = dict(item)
        quote, error = fetchQuote(item.get("symbol", ""), apiKey, timeout=timeout)

        if not error and quote:
            enrichedItem["price"] = quote.get("price", "")
            enrichedItem["currency"] = quote.get("currency", "")
            enrichedItem["change"] = quote.get("change", "")

        enrichedResults.append(enrichedItem)

    return enrichedResults


def searchSymbol(queryText, apiKey, timeout=None, limit=8, assetName="", preferredAssetType=""):
    normalizedQuery = str(queryText or "").strip()

    if not normalizedQuery:
        return None, "Escribe un nombre o ticker para buscar"

    if not apiKey:
        return None, "No se ha encontrado la API key de Finnhub"

    aliasQueries = SEARCH_QUERY_ALIASES.get(_normalizeText(normalizedQuery), [])
    searchQueries = []

    for query in [normalizedQuery, *aliasQueries]:
        cleanQuery = str(query or "").strip()
        if cleanQuery and cleanQuery not in searchQueries:
            searchQueries.append(cleanQuery)

    remoteResults = []
    seenRemoteSymbols = set()

    for searchQuery in searchQueries:
        try:
            payload = _fetchJson(FINNHUB_SEARCH_URL, {
                "q": searchQuery,
                "token": apiKey
            }, timeout=timeout)
        except HTTPError as error:
            return None, _mensajeHttp(error)
        except URLError:
            return None, "No se pudo conectar con Finnhub"

        for item in payload.get("result") or []:
            symbol = str(item.get("symbol", "")).strip().upper()
            description = str(item.get("description", "")).strip()

            if not symbol or not description or symbol in seenRemoteSymbols:
                continue

            seenRemoteSymbols.add(symbol)
            remoteResults.append({
                "symbol": symbol,
                "description": description,
                "displaySymbol": str(item.get("displaySymbol", symbol)).strip().upper() or symbol,
                "type": str(item.get("type", "")).strip() or "market",
                "exchange": str(item.get("mic", "")).strip().upper()
            })

    localResults = _searchLocalSymbols(
        normalizedQuery,
        remoteResults,
        apiKey,
        timeout=timeout,
        limit=limit * 2,
        assetName=assetName,
        preferredAssetType=preferredAssetType
    )

    normalizedRankQuery = _compactSymbol(normalizedQuery)
    normalizedAssetName = _normalizeText(assetName)
    rankedResults = []
    seenSymbols = set()

    for item in remoteResults:
        symbol = item["symbol"]

        if symbol in seenSymbols:
            continue

        seenSymbols.add(symbol)
        rankedResults.append((
            _scoreRemoteSymbol(item, normalizedRankQuery, normalizedAssetName, preferredAssetType),
            item
        ))

    candidateCodes = _extractCodeCandidates(normalizedQuery, remoteResults)

    for item in localResults:
        symbol = item["symbol"]

        if symbol in seenSymbols:
            continue

        seenSymbols.add(symbol)
        rankedResults.append((
            _scoreLocalSymbol(item, _normalizeText(normalizedQuery), candidateCodes, normalizedAssetName, preferredAssetType),
            item
        ))

    rankedResults.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    mergedResults = [item for _, item in rankedResults[:limit]]

    return enrichSearchResultsWithQuote(mergedResults, apiKey, timeout=timeout), None


FINNHUB_STOCK_CANDLE_URL  = "https://finnhub.io/api/v1/stock/candle"
FINNHUB_CRYPTO_CANDLE_URL = "https://finnhub.io/api/v1/crypto/candle"

SIN_HISTORICO = "El plan de Finnhub no incluye históricos (HTTP 403)"

# Finnhub sacó los endpoints de velas del plan gratuito: contestan 403 pase lo
# que pase. Quien pide esto es el cálculo de variación por periodo, que lo
# lanza en paralelo para todos los activos sin snapshot guardado, así que un
# plan sin históricos costaba una tanda de 403 —una por activo— en cada
# consulta, y ninguna iba a funcionar nunca. Con el primero basta para saberlo.
#
# Se recuerda solo mientras viva el proceso: al mejorar el plan, un reinicio
# vuelve a intentarlo.
_sinHistoricos = False


def fetchCandleClose(symbol, fromTs, toTs, apiKey, timeout=None):
    """Return the first available daily closing price in [from_ts, to_ts]."""
    global _sinHistoricos

    if not symbol or not apiKey:
        return None, "Parámetros insuficientes"

    if _sinHistoricos:
        return None, SIN_HISTORICO

    normalized = str(symbol).strip().upper()
    isCrypto = ":" in normalized
    url = FINNHUB_CRYPTO_CANDLE_URL if isCrypto else FINNHUB_STOCK_CANDLE_URL

    try:
        data = _fetchJson(url, {
            "symbol": normalized,
            "resolution": "D",
            "from": int(fromTs),
            "to": int(toTs),
            "token": apiKey,
        }, timeout=timeout)
    except HTTPError as error:
        if error.code == 403:
            _sinHistoricos = True
            log.warning(
                "Finnhub no da históricos con este plan: la variación por "
                "periodo se calculará solo con los snapshots guardados."
            )
            return None, SIN_HISTORICO
        return None, _mensajeHttp(error)
    except (TimeoutError, URLError) as error:
        return None, str(error)

    if data.get("s") == "ok" and data.get("c"):
        return float(data["c"][0]), None

    return None, f"Sin datos ({data.get('s', 'unknown')})"


def reiniciarHistoricosParaPruebas():
    """Olvida el 403 recordado. Simula un proceso recién arrancado."""
    global _sinHistoricos
    _sinHistoricos = False
