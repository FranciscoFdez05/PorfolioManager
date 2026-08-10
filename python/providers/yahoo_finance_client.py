import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from core import settings
from providers import (
    fetch_json,
    format_decimal as _format_decimal,
    format_percent as _format_percent,
    normalize_text as _normalize_text,
)
from providers.api_stats import record_api_call

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


def _fetch_json(url, params=None, timeout=None):
    # Yahoo no tiene API key ni cuota documentada: las llamadas se contabilizan
    # en las funciones públicas para no inflar el contador con los reintentos.
    return fetch_json(url, params, timeout=timeout, headers=_HEADERS)


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


def _fetch_one_price(symbol, timeout=None):
    try:
        payload = _fetch_json(
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


def _fetch_prices(symbols, timeout=None):
    if not symbols:
        return {}
    result = {}
    # El paralelismo se acota por [mercado] max_peticiones_paralelas: subirlo
    # acelera el refresco pero agota antes la cuota del proveedor.
    workers = min(len(symbols), settings.maxPeticionesParalelas())
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_fetch_one_price, s, timeout): s for s in symbols}
        for f in as_completed(futures):
            sym, data = f.result()
            if data:
                result[sym] = data
    return result


_YAHOO_DIRECT_RE = re.compile(r"^[A-Z0-9^]{1,10}(=[XFx])?$", re.IGNORECASE)
_FOREX_SUFFIX_RE = re.compile(r"^([A-Z]{3})([A-Z]{3})=X$", re.IGNORECASE)
_PRECIOUS_METALS = {"XAU", "XAG", "XPT", "XPD"}
_METAL_NAMES     = {"XAU": "Gold", "XAG": "Silver", "XPT": "Platinum", "XPD": "Palladium"}


def _synthetic_yahoo_result(symbol, description, asset_type="forex", currency=""):
    return {
        "symbol":        symbol.upper(),
        "displaySymbol": symbol.upper(),
        "description":   description,
        "type":          asset_type,
        "exchange":      "Yahoo Finance",
        "provider":      "yahoo",
        "price":         "",
        "currency":      currency.upper(),
        "change":        "",
    }


def search_symbol(query_text, timeout=None, limit=8, asset_name="", preferred_asset_type=""):
    normalized_query = str(query_text or "").strip().upper()

    if not normalized_query:
        return None, "Escribe un nombre o ticker para buscar"

    # Forex pairs like XAUEUR=X, EURUSD=X — Yahoo search doesn't index these,
    # but the chart API can fetch them directly.
    m = _FOREX_SUFFIX_RE.match(normalized_query)
    if m:
        from_cur, to_cur = m.group(1).upper(), m.group(2).upper()
        from_name = _METAL_NAMES.get(from_cur, from_cur)
        to_name   = _METAL_NAMES.get(to_cur,   to_cur)
        result = _synthetic_yahoo_result(
            normalized_query,
            f"{from_name} / {to_name}",
            asset_type="forex",
            currency=to_cur,
        )
        quote_data, _ = fetch_quote(normalized_query, timeout=timeout)
        if quote_data:
            result["price"]    = quote_data["price"]
            result["change"]   = quote_data.get("change", "")
            result["currency"] = quote_data.get("currency") or to_cur
        return [result], None

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


def fetch_quote(symbol, timeout=None):
    normalized_symbol = str(symbol or "").strip().upper()

    if not normalized_symbol:
        return None, "El ticker de Yahoo Finance es obligatorio"

    record_api_call("Yahoo Finance")

    try:
        payload = _fetch_json(
            f"{YAHOO_CHART_URL}/{quote(normalized_symbol, safe='=')}",
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
