import re
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import json
import re

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
SUPPORTED_DISPLAY_CURRENCIES = {"EUR", "USD"}
SEARCH_QUERY_ALIASES = {
    "tsmc": ["TSM", "Taiwan Semiconductor", "2330.TW"],
    "tencent": ["0700.HK", "TCEHY", "Tencent Holdings"],
    "universal": ["Universal Corp", "UVV"],
    "universal corp": ["UVV", "Universal Corp"],
    "universal music": ["Universal Music Group", "UMG.AS", "UMGNF"],
}
PREFERRED_EXCHANGES_BY_TYPE = {
    "acciones": {"XNYS", "XNAS", "NYSE", "NASDAQ", "ARCX", "BATS", "XNCM"},
    "etfs": {"ARCX", "XNAS", "XNYS", "BATS", "NASDAQ", "NYSE"},
}


def _format_decimal(value, digits=2):
    return f"{value:.{digits}f}".replace(".", ",")


def _format_percent(value):
    sign = "+" if value >= 0 else ""
    return f"{sign}{_format_decimal(value)}%"


def _fetch_json(url, params, timeout=10):
    query = urlencode(params)
    request = Request(
        f"{url}?{query}",
        headers={
            "User-Agent": "PortfolioPython/1.0",
            "Accept": "application/json"
        }
    )

    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _fetch_json_absolute(url, timeout=10):
    request = Request(
        url,
        headers={
            "User-Agent": "PortfolioPython/1.0",
            "Accept": "application/json"
        }
    )

    with urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def _normalize_currency_code(currency, fallback="EUR"):
    normalized = QUOTE_CURRENCY_ALIASES.get(
        str(currency or "").strip().upper(),
        str(currency or "").strip().upper()
    )
    return normalized or fallback


def _normalize_text(value):
    return re.sub(r"[^a-z0-9]+", "", str(value or "").lower())


def _compact_symbol(value):
    return re.sub(r"[^A-Za-z0-9]+", "", str(value or "").upper())


def _score_remote_symbol(item, normalized_query, normalized_asset_name="", preferred_asset_type=""):
    symbol = str(item.get("symbol", "")).strip().upper()
    display_symbol = str(item.get("displaySymbol", symbol)).strip().upper()
    description = str(item.get("description", "")).strip()
    result_type = str(item.get("type", "")).strip().lower()
    exchange = str(item.get("exchange", "")).strip().upper()
    compact_symbol = _compact_symbol(symbol)
    compact_display = _compact_symbol(display_symbol)
    normalized_description = _normalize_text(description)
    score = 0

    if normalized_query:
        if compact_symbol == normalized_query or compact_display == normalized_query:
            score += 500
        if compact_symbol.startswith(normalized_query) or compact_display.startswith(normalized_query):
            score += 200
        if normalized_query in normalized_description:
            score += 180
        if normalized_query in _normalize_text(symbol):
            score += 140

    if normalized_asset_name:
        if normalized_asset_name == normalized_description:
            score += 260
        elif normalized_asset_name in normalized_description:
            score += 180

    if preferred_asset_type == "acciones":
        if result_type in {"common stock", "adr", "etp", "etf"}:
            score += 220
        elif result_type in {"crypto", "forex"}:
            score -= 220
    elif preferred_asset_type == "etfs":
        if result_type in {"etf", "etp", "fund"}:
            score += 320
        elif result_type == "common stock":
            score += 60
        elif result_type in {"crypto", "forex"}:
            score -= 320
    elif preferred_asset_type == "cripto":
        if result_type == "crypto":
            score += 220
        elif result_type in {"common stock", "forex"}:
            score -= 160
    elif preferred_asset_type == "comoditis":
        if result_type == "forex":
            score += 260
        elif result_type == "common stock":
            score -= 180

        if any(token in normalized_description for token in ("gold", "silver", "oil", "brent", "crude")):
            score += 220

        if "XAU" in symbol:
            score += 260

    if preferred_asset_type in PREFERRED_EXCHANGES_BY_TYPE and exchange in PREFERRED_EXCHANGES_BY_TYPE[preferred_asset_type]:
        score += 80

    if preferred_asset_type in {"acciones", "etfs"} and any(token in normalized_description for token in ("etf", "fund", "ucits", "ishares", "vanguard", "invesco", "spdr", "xtrackers", "amundi")):
        score += 70 if preferred_asset_type == "etfs" else 20

    return score


def _extract_code_candidates(query_text, remote_results):
    normalized_query = str(query_text or "").strip()
    compact_query = _compact_symbol(normalized_query)
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


def _score_local_symbol(item, normalized_query, candidate_codes, normalized_asset_name="", preferred_asset_type=""):
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

    if normalized_asset_name:
        if normalized_asset_name == normalized_description:
            score += 220
        elif normalized_asset_name in normalized_description:
            score += 160

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

    if preferred_asset_type == "acciones" and item.get("type") in {"crypto", "forex"}:
        score -= 220

    if preferred_asset_type == "etfs":
        if item.get("type") == "crypto":
            score -= 320
        elif item.get("type") == "forex":
            score -= 260

    if preferred_asset_type == "cripto":
        if item.get("type") == "crypto":
            score += 220
        elif item.get("type") == "forex":
            score -= 120

    if preferred_asset_type == "comoditis":
        if item.get("type") == "forex":
            score += 280
        elif item.get("type") == "crypto":
            score -= 220

        if any(token in normalized_description for token in ("gold", "silver", "oil", "brent", "crude")):
            score += 240

        if symbol.startswith("OANDA:XAU_"):
            score += 320

    return score


def _search_local_symbols(query_text, remote_results, api_key, timeout=10, limit=8, asset_name="", preferred_asset_type=""):
    normalized_query = _normalize_text(query_text)
    normalized_asset_name = _normalize_text(asset_name)
    candidate_codes = _extract_code_candidates(query_text, remote_results)
    ranked_results = []
    seen_symbols = set()

    for symbol_type, exchange, url in LOCAL_SYMBOL_SOURCES:
        symbols = _get_cached_symbols(symbol_type, exchange, url, api_key, timeout=timeout)

        for item in symbols:
            score = _score_local_symbol(item, normalized_query, candidate_codes, normalized_asset_name, preferred_asset_type)

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
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": current_price,
            "percentChange": percent_change,
            "previousClose": previous_close
        }
    }, None


def fetch_exchange_rate(source_currency, target_currency, timeout=10):
    source = _normalize_currency_code(source_currency)
    target = _normalize_currency_code(target_currency)

    if source == target:
        return 1.0, None

    if source not in SUPPORTED_DISPLAY_CURRENCIES or target not in SUPPORTED_DISPLAY_CURRENCIES:
        return None, f"No hay conversión automática disponible de {source} a {target}"

    try:
        payload = _fetch_json(FRANKFURTER_LATEST_URL, {
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

    try:
        payload = _fetch_json_absolute(f"{EXCHANGE_RATE_API_URL}/{source}", timeout=timeout)
    except HTTPError as error:
        return None, f"Cambio de divisa devolvió HTTP {error.code}"
    except URLError:
        return None, "No se pudo conectar al servicio de cambio de divisa"

    result = str(payload.get("result", "")).lower()

    if result not in {"success", ""}:
        return None, "El servicio de cambio de divisa no devolvió una respuesta válida"

    rate = float((payload.get("rates") or {}).get(target) or 0)

    if rate <= 0:
        return None, f"No se pudo obtener el cambio {source}/{target}"

    return rate, None


def convert_amount(value, source_currency, target_currency, timeout=10):
    rate, error = fetch_exchange_rate(source_currency, target_currency, timeout=timeout)

    if error:
        return None, error

    return float(value) * rate, None


def convert_quote_currency(quote, target_currency, timeout=10):
    if not quote:
        return None, "No hay cotización para convertir"

    source_currency = _normalize_currency_code(quote.get("currency", ""), "USD")
    target_currency = _normalize_currency_code(target_currency, source_currency)

    if source_currency == target_currency:
        converted_quote = dict(quote)
        converted_quote["currency"] = target_currency
        converted_quote["marketData"] = {
            **quote.get("marketData", {}),
            "sourceCurrency": source_currency,
            "sourcePrice": float(quote.get("marketData", {}).get("currentPrice") or 0),
            "exchangeRate": 1.0
        }
        return converted_quote, None

    current_price = float(quote.get("marketData", {}).get("currentPrice") or 0)
    previous_close = float(quote.get("marketData", {}).get("previousClose") or 0)
    converted_current_price, error = convert_amount(current_price, source_currency, target_currency, timeout=timeout)

    if error:
        return None, error

    if previous_close > 0:
        converted_previous_close, error = convert_amount(previous_close, source_currency, target_currency, timeout=timeout)
        if error:
            return None, error
    else:
        converted_previous_close = 0

    exchange_rate, error = fetch_exchange_rate(source_currency, target_currency, timeout=timeout)
    if error:
        return None, error

    converted_quote = dict(quote)
    converted_quote["price"] = _format_decimal(converted_current_price)
    converted_quote["currency"] = target_currency
    converted_quote["status"] = f"Cotización actualizada ({source_currency}->{target_currency})"
    converted_quote["marketData"] = {
        **quote.get("marketData", {}),
        "currentPrice": converted_current_price,
        "previousClose": converted_previous_close,
        "sourceCurrency": source_currency,
        "sourcePrice": current_price,
        "exchangeRate": exchange_rate
    }

    return converted_quote, None


def enrich_search_results_with_quote(results, api_key, timeout=10):
    enriched_results = []

    for item in results:
        enriched_item = dict(item)
        quote, error = fetch_quote(item.get("symbol", ""), api_key, timeout=timeout)

        if not error and quote:
            enriched_item["price"] = quote.get("price", "")
            enriched_item["currency"] = quote.get("currency", "")
            enriched_item["change"] = quote.get("change", "")

        enriched_results.append(enriched_item)

    return enriched_results


def search_symbol(query_text, api_key, timeout=10, limit=8, asset_name="", preferred_asset_type=""):
    normalized_query = str(query_text or "").strip()

    if not normalized_query:
        return None, "Escribe un nombre o ticker para buscar"

    if not api_key:
        return None, "No se ha encontrado la API key de Finnhub"

    alias_queries = SEARCH_QUERY_ALIASES.get(_normalize_text(normalized_query), [])
    search_queries = []

    for query in [normalized_query, *alias_queries]:
        clean_query = str(query or "").strip()
        if clean_query and clean_query not in search_queries:
            search_queries.append(clean_query)

    remote_results = []
    seen_remote_symbols = set()

    for search_query in search_queries:
        try:
            payload = _fetch_json(FINNHUB_SEARCH_URL, {
                "q": search_query,
                "token": api_key
            }, timeout=timeout)
        except HTTPError as error:
            return None, f"Finnhub devolvió HTTP {error.code}"
        except URLError:
            return None, "No se pudo conectar con Finnhub"

        for item in payload.get("result") or []:
            symbol = str(item.get("symbol", "")).strip().upper()
            description = str(item.get("description", "")).strip()

            if not symbol or not description or symbol in seen_remote_symbols:
                continue

            seen_remote_symbols.add(symbol)
            remote_results.append({
                "symbol": symbol,
                "description": description,
                "displaySymbol": str(item.get("displaySymbol", symbol)).strip().upper() or symbol,
                "type": str(item.get("type", "")).strip() or "market",
                "exchange": str(item.get("mic", "")).strip().upper()
            })

    local_results = _search_local_symbols(
        normalized_query,
        remote_results,
        api_key,
        timeout=timeout,
        limit=limit * 2,
        asset_name=asset_name,
        preferred_asset_type=preferred_asset_type
    )

    normalized_rank_query = _compact_symbol(normalized_query)
    normalized_asset_name = _normalize_text(asset_name)
    ranked_results = []
    seen_symbols = set()

    for item in remote_results:
        symbol = item["symbol"]

        if symbol in seen_symbols:
            continue

        seen_symbols.add(symbol)
        ranked_results.append((
            _score_remote_symbol(item, normalized_rank_query, normalized_asset_name, preferred_asset_type),
            item
        ))

    candidate_codes = _extract_code_candidates(normalized_query, remote_results)

    for item in local_results:
        symbol = item["symbol"]

        if symbol in seen_symbols:
            continue

        seen_symbols.add(symbol)
        ranked_results.append((
            _score_local_symbol(item, _normalize_text(normalized_query), candidate_codes, normalized_asset_name, preferred_asset_type),
            item
        ))

    ranked_results.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    merged_results = [item for _, item in ranked_results[:limit]]

    return enrich_search_results_with_quote(merged_results, api_key, timeout=timeout), None
