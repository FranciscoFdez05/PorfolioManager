import re
from datetime import datetime
from urllib.error import HTTPError, URLError

from providers import (
    compactSymbol as _compactSymbol,
    fetchJson,
    formatDecimal as _formatDecimal,
    formatPercent as _formatPercent,
    normalizeText as _normalizeText,
    safeFloat as _safeFloat,
)

AV_BASE_URL = "https://www.alphavantage.co/query"

PREFERRED_EXCHANGES_BY_TYPE = {
    "acciones": {"United States", "NYSE", "NASDAQ"},
    "etfs": {"United States", "NYSE", "NASDAQ"},
    "cripto": {"Cryptocurrency"},
    "comoditis": {"Physical Currency"},
}

_TYPE_MAP = {
    "Equity": "stock",
    "ETF": "etf",
    "Cryptocurrency": "crypto",
    "Physical Currency": "forex",
    "Mutual Fund": "fund",
}

# Matches 6-char forex pairs (EURUSD, XAUEUR) or slash-separated (XAU/EUR)
_FOREX_PAIR_RE = re.compile(r"^([A-Z]{3})[/\-]?([A-Z]{3})$")

_PRECIOUS_METALS = {"XAU", "XAG", "XPT", "XPD"}


def _splitForexPair(symbol):
    """Return (from_currency, to_currency) if symbol looks like a forex pair, else None."""
    m = _FOREX_PAIR_RE.match(symbol.upper().strip())
    if not m:
        return None
    return m.group(1), m.group(2)


def _isForexPair(symbol):
    parts = _splitForexPair(symbol)
    if parts is None:
        return False
    fromCur, toCur = parts
    # Always treat precious-metal pairs as forex
    if fromCur in _PRECIOUS_METALS or toCur in _PRECIOUS_METALS:
        return True
    # Standard 3+3 currency pairs: avoid matching stock tickers like "AAPL" (4 chars filtered by regex)
    # Extra heuristic: both sides must not be the same
    return fromCur != toCur


def _fetchJson(params, timeout=None):
    return fetchJson(AV_BASE_URL, params, timeout=timeout, provider="Alpha Vantage")


def _mapType(avType):
    return _TYPE_MAP.get(str(avType or "").strip(), "market")


def _scoreResult(item, normalizedQuery, normalizedAssetName="", preferredAssetType=""):
    symbol = str(item.get("1. symbol", "")).strip().upper()
    name = str(item.get("2. name", "")).strip()
    avType = str(item.get("3. type", "")).strip()
    region = str(item.get("4. region", "")).strip()
    compactSymbol = _compactSymbol(symbol)
    compactQuery = _compactSymbol(normalizedQuery)
    normalizedName = _normalizeText(name)
    score = 0

    if compactQuery:
        if compactSymbol == compactQuery:
            score += 500
        elif compactSymbol.startswith(compactQuery):
            score += 220
        if compactQuery.lower() in normalizedName:
            score += 180

    if normalizedAssetName:
        if normalizedAssetName == normalizedName:
            score += 260
        elif normalizedAssetName in normalizedName:
            score += 160

    if preferredAssetType == "etfs":
        if avType == "ETF":
            score += 320
        elif any(t in normalizedName for t in ("etf", "etp", "ucits", "ishares", "xtrackers", "amundi", "vanguard")):
            score += 200
        elif avType == "Mutual Fund":
            score += 80
    elif preferredAssetType == "acciones":
        if avType == "Equity":
            score += 250
        elif avType == "ETF":
            score += 40
    elif preferredAssetType == "cripto":
        if avType == "Cryptocurrency":
            score += 280
    elif preferredAssetType == "comoditis":
        if any(t in normalizedName for t in ("gold", "silver", "oil", "brent", "crude", "commodity")):
            score += 280

    if preferredAssetType in PREFERRED_EXCHANGES_BY_TYPE and region in PREFERRED_EXCHANGES_BY_TYPE[preferredAssetType]:
        score += 90

    matchScore = _safeFloat(item.get("9. matchScore", 0))
    score += int(matchScore * 50)

    return score


def _syntheticForexResult(fromCur, toCur):
    symbol = f"{fromCur}{toCur}"
    metalNames = {"XAU": "Gold", "XAG": "Silver", "XPT": "Platinum", "XPD": "Palladium"}
    fromName = metalNames.get(fromCur, fromCur)
    toName = metalNames.get(toCur, toCur)
    description = f"{fromName} / {toName}"
    return {
        "symbol": symbol,
        "displaySymbol": f"{fromCur}/{toCur}",
        "description": description,
        "type": "forex",
        "exchange": "Forex",
        "provider": "alphavantage",
        "price": "",
        "currency": toCur,
        "change": "",
    }


def searchSymbol(queryText, apiKey, timeout=None, limit=8, assetName="", preferredAssetType=""):
    normalizedQuery = str(queryText or "").strip()

    if not normalizedQuery:
        return None, "Escribe un nombre o ticker para buscar"

    if not apiKey:
        return None, "No se ha encontrado la API key de Alpha Vantage"

    # Forex/precious-metal pairs are not in SYMBOL_SEARCH — return a synthetic result directly
    # and include the live price so it shows immediately in the search results list.
    if _isForexPair(normalizedQuery):
        parts = _splitForexPair(normalizedQuery)
        if parts:
            result = _syntheticForexResult(parts[0], parts[1])
            quote, _ = _fetchForexQuote(parts[0], parts[1], apiKey, timeout=timeout)
            if quote:
                result["price"] = quote["price"]
                result["currency"] = quote["currency"]
            return [result], None

    try:
        payload = _fetchJson({
            "function": "SYMBOL_SEARCH",
            "keywords": normalizedQuery,
            "apikey": apiKey,
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Alpha Vantage devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Alpha Vantage"

    if "Note" in payload or "Information" in payload:
        note = payload.get("Note") or payload.get("Information", "")
        return None, f"Alpha Vantage: {note[:120]}"

    rawResults = payload.get("bestMatches") or []
    normalizedAssetName = _normalizeText(assetName)
    rankedResults = []
    seenSymbols = set()

    for item in rawResults:
        symbol = str(item.get("1. symbol", "")).strip().upper()
        name = str(item.get("2. name", "")).strip()
        avType = str(item.get("3. type", "")).strip()
        region = str(item.get("4. region", "")).strip()
        currency = str(item.get("8. currency", "")).strip().upper()

        if not symbol or not name or symbol in seenSymbols:
            continue

        seenSymbols.add(symbol)
        score = _scoreResult(item, normalizedQuery, normalizedAssetName, preferredAssetType)
        rankedResults.append((score, {
            "symbol": symbol,
            "displaySymbol": symbol,
            "description": name,
            "type": _mapType(avType),
            "exchange": region,
            "provider": "alphavantage",
            "price": "",
            "currency": currency,
            "change": "",
        }))

    rankedResults.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    return [item for _, item in rankedResults[:limit]], None


def _fetchForexQuote(fromCur, toCur, apiKey, timeout=None):
    try:
        payload = _fetchJson({
            "function": "CURRENCY_EXCHANGE_RATE",
            "from_currency": fromCur,
            "to_currency": toCur,
            "apikey": apiKey,
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Alpha Vantage devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Alpha Vantage"

    if "Note" in payload or "Information" in payload:
        note = payload.get("Note") or payload.get("Information", "")
        return None, f"Alpha Vantage: {note[:120]}"

    rateData = payload.get("Realtime Currency Exchange Rate") or {}
    if not rateData:
        return None, "Alpha Vantage no devolvió cotización para ese par"

    currentPrice = _safeFloat(rateData.get("5. Exchange Rate"))
    if currentPrice <= 0:
        return None, "Alpha Vantage no devolvió cotización para ese par"

    symbol = f"{fromCur}{toCur}"
    return {
        "symbol": symbol,
        "price": _formatDecimal(currentPrice, 4),
        "currency": toCur,
        "change": "",
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": currentPrice,
            "percentChange": 0.0,
            "previousClose": currentPrice,
        },
    }, None


def fetchQuote(symbol, apiKey, timeout=None):
    normalizedSymbol = str(symbol or "").strip().upper()

    if not normalizedSymbol:
        return None, "El ticker de Alpha Vantage es obligatorio"

    if not apiKey:
        return None, "No se ha encontrado la API key de Alpha Vantage"

    # Use CURRENCY_EXCHANGE_RATE for forex/precious-metal pairs (e.g. XAUEUR, EURUSD)
    if _isForexPair(normalizedSymbol):
        parts = _splitForexPair(normalizedSymbol)
        if parts:
            return _fetchForexQuote(parts[0], parts[1], apiKey, timeout)

    try:
        payload = _fetchJson({
            "function": "GLOBAL_QUOTE",
            "symbol": normalizedSymbol,
            "apikey": apiKey,
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Alpha Vantage devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Alpha Vantage"

    if "Note" in payload or "Information" in payload:
        note = payload.get("Note") or payload.get("Information", "")
        return None, f"Alpha Vantage: {note[:120]}"

    quoteData = payload.get("Global Quote") or {}

    if not quoteData:
        return None, "Alpha Vantage no devolvió cotización para ese ticker"

    currentPrice = _safeFloat(quoteData.get("05. price"))
    previousClose = _safeFloat(quoteData.get("08. previous close"))
    changePercent = _safeFloat(quoteData.get("10. change percent"))

    if currentPrice <= 0 and previousClose <= 0:
        return None, "Alpha Vantage no devolvió cotización para ese ticker"

    if currentPrice <= 0:
        currentPrice = previousClose

    return {
        "symbol": normalizedSymbol,
        "price": _formatDecimal(currentPrice),
        "currency": "USD",
        "change": _formatPercent(changePercent),
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": currentPrice,
            "percentChange": changePercent,
            "previousClose": previousClose,
        },
    }, None
