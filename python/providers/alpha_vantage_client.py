import re
from datetime import datetime
from urllib.error import HTTPError, URLError

from providers import (
    compact_symbol as _compact_symbol,
    fetch_json,
    format_decimal as _format_decimal,
    format_percent as _format_percent,
    normalize_text as _normalize_text,
    safe_float as _safe_float,
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


def _split_forex_pair(symbol):
    """Return (from_currency, to_currency) if symbol looks like a forex pair, else None."""
    m = _FOREX_PAIR_RE.match(symbol.upper().strip())
    if not m:
        return None
    return m.group(1), m.group(2)


def _is_forex_pair(symbol):
    parts = _split_forex_pair(symbol)
    if parts is None:
        return False
    from_cur, to_cur = parts
    # Always treat precious-metal pairs as forex
    if from_cur in _PRECIOUS_METALS or to_cur in _PRECIOUS_METALS:
        return True
    # Standard 3+3 currency pairs: avoid matching stock tickers like "AAPL" (4 chars filtered by regex)
    # Extra heuristic: both sides must not be the same
    return from_cur != to_cur


def _fetch_json(params, timeout=10):
    return fetch_json(AV_BASE_URL, params, timeout=timeout, provider="Alpha Vantage")


def _map_type(av_type):
    return _TYPE_MAP.get(str(av_type or "").strip(), "market")


def _score_result(item, normalized_query, normalized_asset_name="", preferred_asset_type=""):
    symbol = str(item.get("1. symbol", "")).strip().upper()
    name = str(item.get("2. name", "")).strip()
    av_type = str(item.get("3. type", "")).strip()
    region = str(item.get("4. region", "")).strip()
    compact_symbol = _compact_symbol(symbol)
    compact_query = _compact_symbol(normalized_query)
    normalized_name = _normalize_text(name)
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
        if av_type == "ETF":
            score += 320
        elif any(t in normalized_name for t in ("etf", "etp", "ucits", "ishares", "xtrackers", "amundi", "vanguard")):
            score += 200
        elif av_type == "Mutual Fund":
            score += 80
    elif preferred_asset_type == "acciones":
        if av_type == "Equity":
            score += 250
        elif av_type == "ETF":
            score += 40
    elif preferred_asset_type == "cripto":
        if av_type == "Cryptocurrency":
            score += 280
    elif preferred_asset_type == "comoditis":
        if any(t in normalized_name for t in ("gold", "silver", "oil", "brent", "crude", "commodity")):
            score += 280

    if preferred_asset_type in PREFERRED_EXCHANGES_BY_TYPE and region in PREFERRED_EXCHANGES_BY_TYPE[preferred_asset_type]:
        score += 90

    match_score = _safe_float(item.get("9. matchScore", 0))
    score += int(match_score * 50)

    return score


def _synthetic_forex_result(from_cur, to_cur):
    symbol = f"{from_cur}{to_cur}"
    metal_names = {"XAU": "Gold", "XAG": "Silver", "XPT": "Platinum", "XPD": "Palladium"}
    from_name = metal_names.get(from_cur, from_cur)
    to_name = metal_names.get(to_cur, to_cur)
    description = f"{from_name} / {to_name}"
    return {
        "symbol": symbol,
        "displaySymbol": f"{from_cur}/{to_cur}",
        "description": description,
        "type": "forex",
        "exchange": "Forex",
        "provider": "alphavantage",
        "price": "",
        "currency": to_cur,
        "change": "",
    }


def search_symbol(query_text, api_key, timeout=10, limit=8, asset_name="", preferred_asset_type=""):
    normalized_query = str(query_text or "").strip()

    if not normalized_query:
        return None, "Escribe un nombre o ticker para buscar"

    if not api_key:
        return None, "No se ha encontrado la API key de Alpha Vantage"

    # Forex/precious-metal pairs are not in SYMBOL_SEARCH — return a synthetic result directly
    # and include the live price so it shows immediately in the search results list.
    if _is_forex_pair(normalized_query):
        parts = _split_forex_pair(normalized_query)
        if parts:
            result = _synthetic_forex_result(parts[0], parts[1])
            quote, _ = _fetch_forex_quote(parts[0], parts[1], api_key, timeout=timeout)
            if quote:
                result["price"] = quote["price"]
                result["currency"] = quote["currency"]
            return [result], None

    try:
        payload = _fetch_json({
            "function": "SYMBOL_SEARCH",
            "keywords": normalized_query,
            "apikey": api_key,
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Alpha Vantage devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Alpha Vantage"

    if "Note" in payload or "Information" in payload:
        note = payload.get("Note") or payload.get("Information", "")
        return None, f"Alpha Vantage: {note[:120]}"

    raw_results = payload.get("bestMatches") or []
    normalized_asset_name = _normalize_text(asset_name)
    ranked_results = []
    seen_symbols = set()

    for item in raw_results:
        symbol = str(item.get("1. symbol", "")).strip().upper()
        name = str(item.get("2. name", "")).strip()
        av_type = str(item.get("3. type", "")).strip()
        region = str(item.get("4. region", "")).strip()
        currency = str(item.get("8. currency", "")).strip().upper()

        if not symbol or not name or symbol in seen_symbols:
            continue

        seen_symbols.add(symbol)
        score = _score_result(item, normalized_query, normalized_asset_name, preferred_asset_type)
        ranked_results.append((score, {
            "symbol": symbol,
            "displaySymbol": symbol,
            "description": name,
            "type": _map_type(av_type),
            "exchange": region,
            "provider": "alphavantage",
            "price": "",
            "currency": currency,
            "change": "",
        }))

    ranked_results.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    return [item for _, item in ranked_results[:limit]], None


def _fetch_forex_quote(from_cur, to_cur, api_key, timeout=10):
    try:
        payload = _fetch_json({
            "function": "CURRENCY_EXCHANGE_RATE",
            "from_currency": from_cur,
            "to_currency": to_cur,
            "apikey": api_key,
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Alpha Vantage devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Alpha Vantage"

    if "Note" in payload or "Information" in payload:
        note = payload.get("Note") or payload.get("Information", "")
        return None, f"Alpha Vantage: {note[:120]}"

    rate_data = payload.get("Realtime Currency Exchange Rate") or {}
    if not rate_data:
        return None, "Alpha Vantage no devolvió cotización para ese par"

    current_price = _safe_float(rate_data.get("5. Exchange Rate"))
    if current_price <= 0:
        return None, "Alpha Vantage no devolvió cotización para ese par"

    symbol = f"{from_cur}{to_cur}"
    return {
        "symbol": symbol,
        "price": _format_decimal(current_price, 4),
        "currency": to_cur,
        "change": "",
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": current_price,
            "percentChange": 0.0,
            "previousClose": current_price,
        },
    }, None


def fetch_quote(symbol, api_key, timeout=10):
    normalized_symbol = str(symbol or "").strip().upper()

    if not normalized_symbol:
        return None, "El ticker de Alpha Vantage es obligatorio"

    if not api_key:
        return None, "No se ha encontrado la API key de Alpha Vantage"

    # Use CURRENCY_EXCHANGE_RATE for forex/precious-metal pairs (e.g. XAUEUR, EURUSD)
    if _is_forex_pair(normalized_symbol):
        parts = _split_forex_pair(normalized_symbol)
        if parts:
            return _fetch_forex_quote(parts[0], parts[1], api_key, timeout)

    try:
        payload = _fetch_json({
            "function": "GLOBAL_QUOTE",
            "symbol": normalized_symbol,
            "apikey": api_key,
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Alpha Vantage devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Alpha Vantage"

    if "Note" in payload or "Information" in payload:
        note = payload.get("Note") or payload.get("Information", "")
        return None, f"Alpha Vantage: {note[:120]}"

    quote_data = payload.get("Global Quote") or {}

    if not quote_data:
        return None, "Alpha Vantage no devolvió cotización para ese ticker"

    current_price = _safe_float(quote_data.get("05. price"))
    previous_close = _safe_float(quote_data.get("08. previous close"))
    change_percent = _safe_float(quote_data.get("10. change percent"))

    if current_price <= 0 and previous_close <= 0:
        return None, "Alpha Vantage no devolvió cotización para ese ticker"

    if current_price <= 0:
        current_price = previous_close

    return {
        "symbol": normalized_symbol,
        "price": _format_decimal(current_price),
        "currency": "USD",
        "change": _format_percent(change_percent),
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": current_price,
            "percentChange": change_percent,
            "previousClose": previous_close,
        },
    }, None
