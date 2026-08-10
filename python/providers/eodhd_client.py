from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from providers import (
    compact_symbol as _compact_symbol,
    fetch_json,
    format_decimal as _format_decimal,
    format_percent as _format_percent,
    normalize_text as _normalize_text,
    safe_float as _safe_float,
)

EODHD_SEARCH_URL = "https://eodhd.com/api/search"
EODHD_REALTIME_URL = "https://eodhd.com/api/real-time"
PREFERRED_EXCHANGES_BY_TYPE = {
    "acciones": {"US", "NYSE", "NASDAQ", "XETRA", "LSE", "PA"},
    "etfs": {"XETRA", "PA", "LSE", "US", "NYSE", "NASDAQ", "AS", "SW"},
    "cripto": {"CC"},
    "comoditis": {"FOREX", "CC"},
}


def _fetch_json(url, params=None, timeout=None):
    return fetch_json(url, params, timeout=timeout, provider="EODHD")


def _format_symbol(item):
    code = str(item.get("Code", "")).strip().upper()
    exchange = str(item.get("Exchange", "")).strip().upper()

    if not code:
        return ""

    if not exchange:
        return code

    return f"{code}.{exchange}"


def _score_result(item, normalized_query, normalized_asset_name="", preferred_asset_type=""):
    code = str(item.get("Code", "")).strip().upper()
    name = str(item.get("Name", "")).strip()
    exchange = str(item.get("Exchange", "")).strip().upper()
    result_type = str(item.get("Type", "")).strip().lower()
    compact_code = _compact_symbol(code)
    compact_query = _compact_symbol(normalized_query)
    normalized_name = _normalize_text(name)
    score = 0

    if compact_query:
        if compact_code == compact_query:
            score += 500
        if compact_code.startswith(compact_query):
            score += 220
        if compact_query in normalized_name:
            score += 180

    if normalized_asset_name:
        if normalized_asset_name == normalized_name:
            score += 260
        elif normalized_asset_name in normalized_name:
            score += 160

    if preferred_asset_type == "etfs":
        if result_type == "etf":
            score += 320
        elif any(token in normalized_name for token in ("etf", "etp", "etc", "ucits", "ishares", "xtrackers", "amundi", "vanguard", "wisdomtree")):
            score += 200
        elif result_type == "fund":
            score += 80
    elif preferred_asset_type == "acciones":
        if result_type in {"stock", "common stock"}:
            score += 250
        elif result_type == "etf":
            score += 40
    elif preferred_asset_type == "cripto":
        if result_type == "crypto":
            score += 280
    elif preferred_asset_type == "comoditis":
        if any(token in normalized_name for token in ("gold", "silver", "oil", "brent", "crude", "commodity")):
            score += 280

    if preferred_asset_type in PREFERRED_EXCHANGES_BY_TYPE and exchange in PREFERRED_EXCHANGES_BY_TYPE[preferred_asset_type]:
        score += 90

    return score


def search_symbol(query_text, api_key, timeout=None, limit=8, asset_name="", preferred_asset_type=""):
    normalized_query = str(query_text or "").strip()

    if not normalized_query:
        return None, "Escribe un nombre o ticker para buscar"

    if not api_key:
        return None, "No se ha encontrado la API key de EODHD"

    search_type = "all"

    if preferred_asset_type == "acciones":
        search_type = "stock"
    elif preferred_asset_type == "etfs":
        search_type = "etf"
    elif preferred_asset_type == "cripto":
        search_type = "crypto"

    try:
        payload = _fetch_json(
            f"{EODHD_SEARCH_URL}/{quote(normalized_query)}",
            {
                "api_token": api_key,
                "fmt": "json",
                "limit": max(1, min(int(limit or 8), 15)),
                "type": search_type
            },
            timeout=timeout
        )
    except HTTPError as error:
        return None, f"EODHD devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con EODHD"

    normalized_asset_name = _normalize_text(asset_name)
    ranked_results = []
    seen_symbols = set()

    for item in payload or []:
        symbol = _format_symbol(item)
        code = str(item.get("Code", "")).strip().upper()
        name = str(item.get("Name", "")).strip()
        exchange = str(item.get("Exchange", "")).strip().upper()
        previous_close = item.get("previousClose")
        currency = str(item.get("Currency", "")).strip().upper()

        if not code or not name or symbol in seen_symbols:
            continue

        seen_symbols.add(symbol)
        ranked_results.append((
            _score_result(item, normalized_query, normalized_asset_name, preferred_asset_type),
            {
                "symbol": symbol,
                "displaySymbol": symbol,
                "description": name,
                "type": str(item.get("Type", "")).strip() or "market",
                "exchange": exchange,
                "provider": "eodhd",
                "price": str(previous_close) if previous_close not in (None, "") else "",
                "currency": currency,
                "change": ""
            }
        ))

    ranked_results.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    return [item for _, item in ranked_results[:limit]], None


def fetch_quote(symbol, api_key, timeout=None):
    normalized_symbol = str(symbol or "").strip().upper()

    if not normalized_symbol:
        return None, "El ticker de EODHD es obligatorio"

    if not api_key:
        return None, "No se ha encontrado la API key de EODHD"

    try:
        payload = _fetch_json(
            f"{EODHD_REALTIME_URL}/{quote(normalized_symbol)}",
            {
                "api_token": api_key,
                "fmt": "json"
            },
            timeout=timeout
        )
    except HTTPError as error:
        return None, f"EODHD devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con EODHD"

    current_price = _safe_float(payload.get("close"), fallback=0.0)
    previous_close = _safe_float(payload.get("previousClose"), fallback=0.0)
    percent_change = _safe_float(payload.get("change_p"), fallback=0.0)

    if abs(percent_change) < 1e-9 and previous_close > 0 and current_price > 0:
        absolute_change = _safe_float(payload.get("change"), fallback=0.0)
        if abs(absolute_change) > 1e-9:
            percent_change = absolute_change / previous_close * 100
        elif abs(current_price - previous_close) > 1e-9:
            percent_change = (current_price - previous_close) / previous_close * 100

    if current_price <= 0:
        current_price = previous_close

    currency = str(payload.get("currency", "")).strip().upper() or "EUR"

    if current_price <= 0 and previous_close <= 0:
        return None, "EODHD no devolvió cotización para ese ticker"

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
