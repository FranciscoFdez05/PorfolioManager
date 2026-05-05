import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

from api_stats import record_api_call


YAHOO_SEARCH_URL = "https://query1.finance.yahoo.com/v1/finance/search"
YAHOO_CHART_URL = "https://query1.finance.yahoo.com/v8/finance/chart"

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


def _fetch_json(url, params=None, timeout=10):
    query = urlencode(params or {})
    request_url = f"{url}?{query}" if query else url
    req = Request(request_url, headers=_HEADERS)

    with urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _normalize_text(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _format_decimal(value, digits=2):
    return f"{value:.{digits}f}".replace(".", ",")


def _format_percent(value):
    sign = "+" if value >= 0 else ""
    return f"{sign}{_format_decimal(value)}%"


def _map_quote_type(quote_type):
    return _TYPE_MAP.get(str(quote_type or "").upper(), "market")


def _score_result(item, normalized_query, normalized_asset_name="", preferred_asset_type=""):
    symbol = str(item.get("symbol", "")).strip().upper()
    name = str(item.get("shortname") or item.get("longname", "")).strip()
    quote_type = str(item.get("quoteType", "")).upper()
    normalized_name = _normalize_text(name)
    compact_symbol = re.sub(r"[^A-Za-z0-9]+", "", symbol)
    compact_query = re.sub(r"[^A-Za-z0-9]+", "", normalized_query.upper())
    score = 0

    if compact_query:
        if compact_symbol == compact_query:
            score += 500
        elif compact_symbol.startswith(compact_query):
            score += 220
        if compact_query.lower() in normalized_name:
            score += 180

    if normalized_asset_name:
        if normalized_asset_name == normalized_name:
            score += 260
        elif normalized_asset_name in normalized_name:
            score += 160

    if preferred_asset_type == "etfs":
        if quote_type == "ETF":
            score += 320
        elif any(t in normalized_name for t in ("etf", "etp", "ucits", "ishares", "xtrackers", "amundi", "vanguard")):
            score += 200
        elif quote_type == "MUTUALFUND":
            score += 80
    elif preferred_asset_type == "acciones":
        if quote_type == "EQUITY":
            score += 250
        elif quote_type == "ETF":
            score += 40
    elif preferred_asset_type == "cripto":
        if quote_type == "CRYPTOCURRENCY":
            score += 280
    elif preferred_asset_type == "comoditis":
        if any(t in normalized_name for t in ("gold", "silver", "oil", "brent", "crude", "commodity")):
            score += 280

    return score


def _fetch_one_price(symbol, timeout=5):
    try:
        payload = _fetch_json(
            f"{YAHOO_CHART_URL}/{quote(symbol)}",
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


def _fetch_prices(symbols, timeout=8):
    if not symbols:
        return {}
    result = {}
    with ThreadPoolExecutor(max_workers=min(len(symbols), 6)) as pool:
        futures = {pool.submit(_fetch_one_price, s, timeout): s for s in symbols}
        for f in as_completed(futures):
            sym, data = f.result()
            if data:
                result[sym] = data
    return result


def search_symbol(query_text, timeout=10, limit=8, asset_name="", preferred_asset_type=""):
    normalized_query = str(query_text or "").strip()

    if not normalized_query:
        return None, "Escribe un nombre o ticker para buscar"

    record_api_call("Yahoo Finance")

    try:
        payload = _fetch_json(
            YAHOO_SEARCH_URL,
            {
                "q": normalized_query,
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

    raw_results = payload.get("quotes") or []
    normalized_asset_name = _normalize_text(asset_name)
    ranked_results = []
    seen_symbols = set()

    for item in raw_results:
        symbol = str(item.get("symbol", "")).strip().upper()
        name = str(item.get("shortname") or item.get("longname", "")).strip()
        exchange = str(item.get("exchDisp") or item.get("exchange", "")).strip().upper()
        quote_type = str(item.get("quoteType", "")).strip()
        currency = str(item.get("currency", "")).strip().upper()

        if not symbol or not name or symbol in seen_symbols:
            continue

        seen_symbols.add(symbol)
        score = _score_result(item, normalized_query, normalized_asset_name, preferred_asset_type)
        ranked_results.append((score, {
            "symbol": symbol,
            "displaySymbol": symbol,
            "description": name,
            "type": _map_quote_type(quote_type),
            "exchange": exchange,
            "provider": "yahoo",
            "price": "",
            "currency": currency,
            "change": ""
        }))

    ranked_results.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    top_results = [item for _, item in ranked_results[:limit]]

    prices = _fetch_prices([r["symbol"] for r in top_results], timeout=timeout)
    for result in top_results:
        quote_data = prices.get(result["symbol"])
        if not quote_data:
            continue
        current = quote_data.get("price") or 0
        prev = quote_data.get("previousClose") or 0
        currency = quote_data.get("currency") or result["currency"]
        if current > 0:
            result["price"] = _format_decimal(current)
            if prev > 0:
                result["change"] = _format_percent((current - prev) / prev * 100)
        if currency:
            result["currency"] = currency

    return top_results, None


def fetch_quote(symbol, timeout=10):
    normalized_symbol = str(symbol or "").strip().upper()

    if not normalized_symbol:
        return None, "El ticker de Yahoo Finance es obligatorio"

    record_api_call("Yahoo Finance")

    try:
        payload = _fetch_json(
            f"{YAHOO_CHART_URL}/{quote(normalized_symbol)}",
            {"range": "2d", "interval": "1d"},
            timeout=timeout,
        )
    except HTTPError as error:
        return None, f"Yahoo Finance devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con Yahoo Finance: {error.reason}"
    except Exception as error:
        return None, f"Error al obtener cotización de Yahoo Finance: {error}"

    try:
        meta = payload["chart"]["result"][0]["meta"]
    except (KeyError, IndexError, TypeError):
        return None, "Yahoo Finance no devolvió cotización para ese ticker"

    current_price = float(meta.get("regularMarketPrice") or 0)
    previous_close = float(meta.get("chartPreviousClose") or meta.get("previousClose") or 0)
    currency = str(meta.get("currency") or "USD").strip().upper()

    if current_price <= 0 and previous_close <= 0:
        return None, "Yahoo Finance no devolvió cotización para ese ticker"

    percent_change = (current_price - previous_close) / previous_close * 100 if previous_close > 0 else 0.0

    return {
        "symbol": normalized_symbol,
        "price": _format_decimal(current_price),
        "currency": currency,
        "change": _format_percent(percent_change),
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": current_price,
            "percentChange": percent_change,
            "previousClose": previous_close
        }
    }, None
