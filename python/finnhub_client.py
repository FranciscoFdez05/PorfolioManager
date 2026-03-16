import json
import re
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import urlopen


FINNHUB_QUOTE_URL = "https://finnhub.io/api/v1/quote"
FINNHUB_SEARCH_URL = "https://finnhub.io/api/v1/search"
FINNHUB_CRYPTO_SYMBOLS_URL = "https://finnhub.io/api/v1/crypto/symbol"
FINNHUB_FOREX_SYMBOLS_URL = "https://finnhub.io/api/v1/forex/symbol"
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


def _format_decimal(value, digits=2):
    return f"{value:.{digits}f}".replace(".", ",")


def _format_percent(value):
    sign = "+" if value >= 0 else ""
    return f"{sign}{_format_decimal(value)}%"


def _fetch_json(url, params, timeout=10):
    query = urlencode(params)

    with urlopen(f"{url}?{query}", timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _normalize_text(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _extract_code_candidates(query_text, remote_results):
    normalized_query = str(query_text or "").strip()
    compact_query = re.sub(r"[^A-Za-z0-9]+", "", normalized_query).upper()
    candidates = []

    if 2 <= len(compact_query) <= 10:
        candidates.append(compact_query)

    for result in remote_results:
        searchable_text = " ".join([
            str(result.get("symbol", "")),
            str(result.get("displaySymbol", "")),
            str(result.get("description", "")),
        ]).upper()

        for token in re.findall(r"\b[A-Z0-9]{2,10}\b", searchable_text):
            if token not in candidates:
                candidates.append(token)

    return candidates


def _get_cached_symbols(symbol_type, exchange, url, api_key, timeout=10):
    cache_key = (symbol_type, exchange)

    if cache_key in SYMBOL_CACHE:
        return SYMBOL_CACHE[cache_key]

    data = _fetch_json(url, {
        "exchange": exchange,
        "token": api_key
    }, timeout=timeout)

    normalized_data = []

    for item in data:
        symbol = str(item.get("symbol", "")).strip().upper()
        description = str(item.get("description", "")).strip()
        display_symbol = str(item.get("displaySymbol", symbol)).strip().upper() or symbol

        if not symbol or not description:
            continue

        normalized_data.append({
            "symbol": symbol,
            "description": description,
            "displaySymbol": display_symbol,
            "type": symbol_type
        })

    SYMBOL_CACHE[cache_key] = normalized_data
    return normalized_data


def _score_local_symbol(item, normalized_query, candidate_codes):
    symbol = item["symbol"]
    display_symbol = item["displaySymbol"]
    description = item["description"]
    compact_display = display_symbol.replace("/", "").replace("_", "")
    normalized_description = _normalize_text(description)
    score = 0

    if normalized_query and normalized_query in _normalize_text(symbol):
        score += 120

    if normalized_query and normalized_query in _normalize_text(display_symbol):
        score += 160

    if normalized_query and normalized_query in normalized_description:
        score += 80

    for index, code in enumerate(candidate_codes):
        if not code:
            continue

        weight = max(10, 60 - (index * 4))

        if symbol.startswith(f"BINANCE:{code}") or symbol.startswith(f"COINBASE:{code}") or symbol.startswith(f"OANDA:{code}_"):
            score += weight + 90

        if compact_display.startswith(code):
            score += weight + 70

        for quote_index, quote in enumerate(PREFERRED_QUOTES):
            quote_weight = max(5, 40 - (quote_index * 5))

            if compact_display == f"{code}{quote}":
                score += weight + quote_weight + 90
            elif compact_display.startswith(f"{code}{quote}"):
                score += weight + quote_weight + 50

    return score


def _search_local_symbols(query_text, remote_results, api_key, timeout=10, limit=8):
    normalized_query = _normalize_text(query_text)
    candidate_codes = _extract_code_candidates(query_text, remote_results)
    ranked_results = []
    seen_symbols = set()

    for symbol_type, exchange, url in LOCAL_SYMBOL_SOURCES:
        symbols = _get_cached_symbols(symbol_type, exchange, url, api_key, timeout=timeout)

        for item in symbols:
            score = _score_local_symbol(item, normalized_query, candidate_codes)

            if score <= 0:
                continue

            symbol = item["symbol"]

            if symbol in seen_symbols:
                continue

            seen_symbols.add(symbol)
            ranked_results.append((score, item))

    ranked_results.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    return [item for _, item in ranked_results[:limit]]


def infer_currency_from_symbol(symbol, fallback="USD"):
    normalized_symbol = str(symbol or "").strip().upper()

    if not normalized_symbol:
        return fallback

    if ":" in normalized_symbol:
        market_symbol = normalized_symbol.split(":", 1)[1]

        if "_" in market_symbol:
            quote_currency = market_symbol.split("_")[-1]
            return QUOTE_CURRENCY_ALIASES.get(quote_currency, quote_currency or fallback)

        compact_symbol = market_symbol.replace("/", "")

        for quote_currency in sorted(QUOTE_CURRENCY_ALIASES.keys(), key=len, reverse=True):
            if compact_symbol.endswith(quote_currency):
                return QUOTE_CURRENCY_ALIASES[quote_currency]

    for suffix, currency in MARKET_SUFFIX_CURRENCIES.items():
        if normalized_symbol.endswith(suffix):
            return currency

    return fallback


def fetch_quote(symbol, api_key, timeout=10):
    normalized_symbol = str(symbol or "").strip().upper()

    if not normalized_symbol:
        return None, "El ticker de Finnhub es obligatorio"

    if not api_key:
        return None, "No se ha encontrado la API key de Finnhub"

    try:
        payload = _fetch_json(FINNHUB_QUOTE_URL, {
            "symbol": normalized_symbol,
            "token": api_key
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Finnhub devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Finnhub"

    current_price = float(payload.get("c") or 0)
    percent_change = float(payload.get("dp") or 0)
    previous_close = float(payload.get("pc") or 0)

    if current_price <= 0 and previous_close <= 0:
        return None, "Finnhub no devolvió cotización para ese ticker"

    return {
        "symbol": normalized_symbol,
        "price": _format_decimal(current_price),
        "currency": infer_currency_from_symbol(normalized_symbol),
        "change": _format_percent(percent_change),
        "status": "Cotización actualizada",
        "marketData": {
            "currentPrice": current_price,
            "percentChange": percent_change,
            "previousClose": previous_close
        }
    }, None


def search_symbol(query_text, api_key, timeout=10, limit=8):
    normalized_query = str(query_text or "").strip()

    if not normalized_query:
        return None, "Escribe un nombre o ticker para buscar"

    if not api_key:
        return None, "No se ha encontrado la API key de Finnhub"

    try:
        payload = _fetch_json(FINNHUB_SEARCH_URL, {
            "q": normalized_query,
            "token": api_key
        }, timeout=timeout)
    except HTTPError as error:
        return None, f"Finnhub devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar con Finnhub"

    remote_results = []

    for item in payload.get("result") or []:
        symbol = str(item.get("symbol", "")).strip().upper()
        description = str(item.get("description", "")).strip()

        if not symbol or not description:
            continue

        remote_results.append({
            "symbol": symbol,
            "description": description,
            "displaySymbol": str(item.get("displaySymbol", symbol)).strip().upper() or symbol,
            "type": str(item.get("type", "")).strip() or "market"
        })

    local_results = _search_local_symbols(normalized_query, remote_results, api_key, timeout=timeout, limit=limit * 2)
    merged_results = []
    seen_symbols = set()

    for item in [*local_results, *remote_results]:
        symbol = item["symbol"]

        if symbol in seen_symbols:
            continue

        seen_symbols.add(symbol)
        merged_results.append(item)

        if len(merged_results) >= limit:
            break

    return merged_results, None
