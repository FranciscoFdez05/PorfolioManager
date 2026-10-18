import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from core import settings
from providers import (
    fetchJson,
    formatDecimal as _formatDecimal,
    formatPercent as _formatPercent,
    normalizeText as _normalizeText,
)
from providers.api_stats import recordApiCall
from providers.http import motivoConexion

YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"

# Yahoo responde 403 a los User-Agent que no parecen un navegador, así que este
# cliente no usa el de [proveedores] user_agent: no es un ajuste de despliegue,
# es un requisito del proveedor.
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
}

_TYPE_MAP = {
    "EQUITY": "stock",
    "ETF": "etf",
    "CRYPTOCURRENCY": "crypto",
    "CURRENCY": "forex",
    "FUTURE": "futures",
    "INDEX": "index",
    "MUTUALFUND": "fund",
}


def _fetchJson(url, params=None, timeout=None):
    # Yahoo no tiene API key ni cuota documentada: las llamadas se contabilizan
    # en las funciones públicas para no inflar el contador con los reintentos.
    return fetchJson(url, params, timeout=timeout, headers=_HEADERS)


def _mapQuoteType(quoteType):
    return _TYPE_MAP.get(str(quoteType or "").upper(), "market")


def _scoreResult(item, normalizedQuery, normalizedAssetName="", preferredAssetType=""):
    symbol = str(item.get("symbol", "")).strip().upper()
    name = str(item.get("shortname") or item.get("longname", "")).strip()
    quoteType = str(item.get("quoteType", "")).upper()
    normalizedName = _normalizeText(name)
    compactSymbol = re.sub(r"[^A-Za-z0-9]+", "", symbol)
    compactQuery = re.sub(r"[^A-Za-z0-9]+", "", normalizedQuery.upper())
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
        if quoteType == "ETF":
            score += 320
        elif any(t in normalizedName for t in ("etf", "etp", "ucits", "ishares", "xtrackers", "amundi", "vanguard")):
            score += 200
        elif quoteType == "MUTUALFUND":
            score += 80
    elif preferredAssetType == "acciones":
        if quoteType == "EQUITY":
            score += 250
        elif quoteType == "ETF":
            score += 40
    elif preferredAssetType == "cripto":
        if quoteType == "CRYPTOCURRENCY":
            score += 280
    elif preferredAssetType == "comoditis":
        if any(t in normalizedName for t in ("gold", "silver", "oil", "brent", "crude", "commodity")):
            score += 280

    return score


def _fetchOnePrice(symbol, timeout=None):
    try:
        payload = _fetchJson(
            f"{YAHOO_CHART_URL}/{quote(symbol, safe='=')}",
            {"range": "1d", "interval": "1d"},
            timeout=timeout,
        )
        meta = payload["chart"]["result"][0]["meta"]
        current = float(meta.get("regularMarketPrice") or 0)
        prev = float(meta.get("chartPreviousClose") or meta.get("previousClose") or 0)
        return symbol.upper(), {
            "price": current,
            "previousClose": prev,
            "currency": str(meta.get("currency") or "").upper(),
        }
    except Exception:
        return symbol.upper(), {}


def _fetchPrices(symbols, timeout=None):
    if not symbols:
        return {}
    result = {}
    # El paralelismo se acota por [mercado] max_peticiones_paralelas: subirlo
    # acelera el refresco pero agota antes la cuota del proveedor.
    workers = min(len(symbols), settings.maxPeticionesParalelas())
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_fetchOnePrice, s, timeout): s for s in symbols}
        for f in as_completed(futures):
            sym, data = f.result()
            if data:
                result[sym] = data
    return result


_YAHOO_DIRECT_RE = re.compile(r"^[A-Z0-9^]{1,10}(=[XFx])?$", re.IGNORECASE)
_FOREX_SUFFIX_RE = re.compile(r"^([A-Z]{3})([A-Z]{3})=X$", re.IGNORECASE)
_PRECIOUS_METALS = {"XAU", "XAG", "XPT", "XPD"}
_METAL_NAMES     = {"XAU": "Gold", "XAG": "Silver", "XPT": "Platinum", "XPD": "Palladium"}


def _syntheticYahooResult(symbol, description, assetType="forex", currency=""):
    return {
        "symbol":        symbol.upper(),
        "displaySymbol": symbol.upper(),
        "description":   description,
        "type":          assetType,
        "exchange":      "Yahoo Finance",
        "provider":      "yahoo",
        "price":         "",
        "currency":      currency.upper(),
        "change":        "",
    }


def searchSymbol(queryText, timeout=None, limit=8, assetName="", preferredAssetType=""):
    normalizedQuery = str(queryText or "").strip().upper()

    if not normalizedQuery:
        return None, "Escribe un nombre o ticker para buscar"

    # Forex pairs like XAUEUR=X, EURUSD=X — Yahoo search doesn't index these,
    # but the chart API can fetch them directly.
    m = _FOREX_SUFFIX_RE.match(normalizedQuery)
    if m:
        fromCur, toCur = m.group(1).upper(), m.group(2).upper()
        fromName = _METAL_NAMES.get(fromCur, fromCur)
        toName   = _METAL_NAMES.get(toCur,   toCur)
        result = _syntheticYahooResult(
            normalizedQuery,
            f"{fromName} / {toName}",
            assetType="forex",
            currency=toCur,
        )
        quoteData, _ = fetchQuote(normalizedQuery, timeout=timeout)
        if quoteData:
            result["price"]    = quoteData["price"]
            result["change"]   = quoteData.get("change", "")
            result["currency"] = quoteData.get("currency") or toCur
        return [result], None

    recordApiCall("Yahoo Finance")

    try:
        payload = _fetchJson(
            YAHOO_SEARCH_URL,
            {
                "q": normalizedQuery,
                "quotesCount": max(1, min(int(limit or 8), 20)),
                "newsCount": 0,
                "enableFuzzyQuery": "false",
                "enableNavLinks": "false",
            },
            timeout=timeout,
        )
    except HTTPError as error:
        return None, f"Yahoo Finance devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Yahoo Finance"

    rawResults = payload.get("quotes") or []
    normalizedAssetName = _normalizeText(assetName)
    rankedResults = []
    seenSymbols = set()

    for item in rawResults:
        symbol = str(item.get("symbol", "")).strip().upper()
        name = str(item.get("shortname") or item.get("longname", "")).strip()
        exchange = str(item.get("exchDisp") or item.get("exchange", "")).strip().upper()
        quoteType = str(item.get("quoteType", "")).strip()
        currency = str(item.get("currency", "")).strip().upper()

        if not symbol or not name or symbol in seenSymbols:
            continue

        seenSymbols.add(symbol)
        score = _scoreResult(item, normalizedQuery, normalizedAssetName, preferredAssetType)
        rankedResults.append((score, {
            "symbol": symbol,
            "displaySymbol": symbol,
            "description": name,
            "type": _mapQuoteType(quoteType),
            "exchange": exchange,
            "provider": "yahoo",
            "price": "",
            "currency": currency,
            "change": ""
        }))

    rankedResults.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    topResults = [item for _, item in rankedResults[:limit]]

    prices = _fetchPrices([r["symbol"] for r in topResults], timeout=timeout)
    for result in topResults:
        quoteData = prices.get(result["symbol"])
        if not quoteData:
            continue
        current = quoteData.get("price") or 0
        prev = quoteData.get("previousClose") or 0
        currency = quoteData.get("currency") or result["currency"]
        if current > 0:
            result["price"] = _formatDecimal(current)
            if prev > 0:
                result["change"] = _formatPercent((current - prev) / prev * 100)
        if currency:
            result["currency"] = currency

    return topResults, None


def fetchPriceSeries(symbol, fromTs, toTs, timeout=None, interval="1d"):
    """Cierres de un ticker entre dos fechas, diarios salvo que se pida otro intervalo.

    `interval` es el de Yahoo (`5m`, `30m`, `1h`, `1d`, `1wk`, `1mo`). Los
    intradía solo existen para los últimos 60 o 730 días según el intervalo.

    Yahoo es el único de los cuatro proveedores conectados que sirve series
    largas sin clave ni cuota, y además cotiza los índices (^GSPC, ^STOXX50E…)
    que no aparecen en las APIs de acciones.

    Devuelve `([{"ts", "close"}], error)` con los puntos ordenados; los días
    sin cierre (festivos, sesiones a medias) se descartan en vez de
    interpolarse: un hueco es más honesto que un precio inventado.
    """
    normalizedSymbol = str(symbol or "").strip().upper()
    if not normalizedSymbol:
        return [], "El ticker de Yahoo Finance es obligatorio"

    recordApiCall("Yahoo Finance")

    try:
        payload = _fetchJson(
            f"{YAHOO_CHART_URL}/{quote(normalizedSymbol, safe='=^')}",
            {"period1": int(fromTs), "period2": int(toTs), "interval": interval},
            timeout=timeout,
        )
    except HTTPError as error:
        return [], f"Yahoo Finance devolvió HTTP {error.code}"
    except URLError as error:
        return [], f"No se pudo conectar con Yahoo Finance: {motivoConexion(error, 'Yahoo Finance')}"
    except Exception as error:
        return [], f"Error al obtener el histórico de Yahoo Finance: {error}"

    try:
        resultado = payload["chart"]["result"][0]
        marcas    = resultado["timestamp"]
        cierres   = resultado["indicators"]["quote"][0]["close"]
    except (KeyError, IndexError, TypeError):
        return [], "Yahoo Finance no devolvió histórico para ese ticker"

    serie = []
    for ts, cierre in zip(marcas, cierres, strict=False):
        if cierre is None:
            continue
        try:
            valor = float(cierre)
        except (TypeError, ValueError):
            continue
        if valor > 0:
            serie.append({"ts": int(ts), "close": valor})

    if not serie:
        return [], "Yahoo Finance no devolvió cierres para ese periodo"

    serie.sort(key=lambda punto: punto["ts"])
    return serie, None


def fetchQuote(symbol, timeout=None):
    normalizedSymbol = str(symbol or "").strip().upper()

    if not normalizedSymbol:
        return None, "El ticker de Yahoo Finance es obligatorio"

    recordApiCall("Yahoo Finance")

    try:
        payload = _fetchJson(
            f"{YAHOO_CHART_URL}/{quote(normalizedSymbol, safe='=')}",
            {"range": "2d", "interval": "1d"},
            timeout=timeout,
        )
    except HTTPError as error:
        return None, f"Yahoo Finance devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con Yahoo Finance: {motivoConexion(error, 'Yahoo Finance')}"
    except Exception as error:
        return None, f"Error al obtener cotización de Yahoo Finance: {error}"

    try:
        meta = payload["chart"]["result"][0]["meta"]
    except (KeyError, IndexError, TypeError):
        return None, "Yahoo Finance no devolvió cotización para ese ticker"

    currentPrice = float(meta.get("regularMarketPrice") or 0)
    previousClose = float(meta.get("chartPreviousClose") or meta.get("previousClose") or 0)
    currency = str(meta.get("currency") or "USD").strip().upper()

    if currentPrice <= 0 and previousClose <= 0:
        return None, "Yahoo Finance no devolvió cotización para ese ticker"

    percentChange = (currentPrice - previousClose) / previousClose * 100 if previousClose > 0 else 0.0

    return {
        "symbol": normalizedSymbol,
        "price": _formatDecimal(currentPrice),
        "currency": currency,
        "change": _formatPercent(percentChange),
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": currentPrice,
            "percentChange": percentChange,
            "previousClose": previousClose
        }
    }, None
