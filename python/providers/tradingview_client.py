"""Cliente TradingView, sin API key.

Mathieu2301/TradingView-API habla con el feed en tiempo real de TradingView
por WebSocket (protocolo propio de sockets, streaming). Los otros cuatro
proveedores conectados aquí son síncronos por HTTP con `providers.fetch_json`
y no llevan ninguna dependencia nueva; mantener ese mismo patrón importaba más
que el streaming, así que este cliente usa el `scanner.tradingview.com` que
alimenta las tablas de la web —los mismos datos, en una foto en vez de un
flujo— y encaja tal cual en `stores.market_data` (caché + respaldo entre
proveedores) sin tocar esa lógica.

El símbolo va con la sintaxis de TradingView, `MERCADO:TICKER`
(`NASDAQ:AAPL`, `BINANCE:BTCUSDT`, `XETR:SAP`): por eso no es "portable" para
`stores.market_data._is_portable_symbol` y solo se usa cuando el activo lo
pide explícitamente, igual que ya pasa con la sintaxis de Finnhub para
cripto/forex.
"""

import re
from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import unquote

from providers import (
    compact_symbol as _compact_symbol,
    fetch_json,
    format_decimal as _format_decimal,
    format_percent as _format_percent,
    normalize_text as _normalize_text,
)

TRADINGVIEW_SCAN_URL = "https://scanner.tradingview.com/global/scan"
TRADINGVIEW_SEARCH_URL = "https://symbol-search.tradingview.com/symbol_search/v3/"

_SCAN_COLUMNS = ["close", "change", "currency", "description", "exchange", "type"]

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
}

_TAG_RE = re.compile(r"</?em>")


def _strip_markup(text):
    """TradingView resalta la coincidencia con `<em>` dentro de symbol/description."""
    return _TAG_RE.sub("", str(text or ""))


def _map_type(raw_type):
    return _TYPE_MAP.get(str(raw_type or "").strip().lower(), "market")


def _fetch_json(url, params=None, timeout=None, json_body=None, headers=None):
    return fetch_json(url, params, timeout=timeout, provider="TradingView", json_body=json_body, headers=headers)


def fetch_quote(symbol, timeout=None):
    # Quien copia el símbolo desde la URL de tradingview.com (?symbol=BINANCE%3ABTCUSD)
    # se lleva los dos puntos codificados: la barra de direcciones no los decodifica
    # siempre. Sin este `unquote` ese pegado no tiene ":" y cae directo en el error
    # de abajo aunque el ticker sea correcto.
    normalized_symbol = unquote(str(symbol or "").strip()).upper()

    if not normalized_symbol:
        return None, "El ticker de TradingView es obligatorio"

    if ":" not in normalized_symbol:
        return None, "El ticker de TradingView necesita el mercado delante (p.ej. NASDAQ:AAPL)"

    try:
        payload = _fetch_json(
            TRADINGVIEW_SCAN_URL,
            json_body={
                "symbols": {"tickers": [normalized_symbol], "query": {"types": []}},
                "columns": _SCAN_COLUMNS,
            },
            timeout=timeout,
        )
    except HTTPError as error:
        return None, f"TradingView devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con TradingView: {error.reason}"

    rows = payload.get("data") or []
    values = (rows[0].get("d") or []) if rows else []

    if len(values) < 3:
        return None, "TradingView no devolvió cotización para ese ticker"

    current_price = float(values[0] or 0)
    percent_change = float(values[1] or 0)
    currency = str(values[2] or "USD").strip().upper()

    if current_price <= 0:
        return None, "TradingView no devolvió cotización para ese ticker"

    previous_close = current_price / (1 + percent_change / 100) if percent_change not in (None, -100) else current_price

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


def _score_result(symbol, description, raw_type, query_text, normalized_asset_name="", preferred_asset_type="", rank_index=0):
    normalized_query = _normalize_text(query_text)
    compact_query = _compact_symbol(query_text)
    compact_symbol = _compact_symbol(symbol)
    normalized_description = _normalize_text(description)

    # TradingView ya devuelve sus propios resultados ordenados por relevancia
    # -y mezcla acciones con bonos, pares de cripto descatalogados, futuros...
    # donde "contiene la palabra" empata a casi todos-. Este suelo, que baja
    # con la posición original, hace que esa ordenación mande salvo que algo
    # de aquí abajo encuentre una señal más fuerte (símbolo exacto, tipo
    # preferido).
    score = max(0, 200 - rank_index * 6)

    if compact_query:
        if compact_symbol == compact_query:
            score += 500
        elif compact_symbol.startswith(compact_query):
            score += 220
        if normalized_query and normalized_query in normalized_description:
            score += 180

    if normalized_asset_name:
        if normalized_asset_name == normalized_description:
            score += 260
        elif normalized_asset_name in normalized_description:
            score += 160

    if preferred_asset_type == "etfs":
        if raw_type in {"fund", "structured"}:
            score += 280
        elif any(token in normalized_description for token in ("etf", "etp", "ucits", "ishares", "xtrackers", "amundi", "vanguard", "spdr")):
            score += 200
        elif raw_type == "stock":
            score += 40
    elif preferred_asset_type == "acciones":
        if raw_type == "stock":
            score += 250
        elif raw_type in {"crypto", "spot", "forex"}:
            score -= 220
    elif preferred_asset_type == "cripto":
        if raw_type in {"crypto", "spot"}:
            score += 280
        elif raw_type in {"stock", "forex"}:
            score -= 160
    elif preferred_asset_type == "comoditis":
        if raw_type in {"forex", "cfd", "futures"}:
            score += 200
        if any(token in normalized_description for token in ("gold", "silver", "oil", "brent", "crude", "commodity")):
            score += 280

    return score


def enrich_search_results_with_quote(results, timeout=None):
    enriched_results = []

    for item in results:
        enriched_item = dict(item)
        quote, error = fetch_quote(item.get("symbol", ""), timeout=timeout)

        if not error and quote:
            enriched_item["price"] = quote.get("price", "")
            enriched_item["currency"] = quote.get("currency", "")
            enriched_item["change"] = quote.get("change", "")

        enriched_results.append(enriched_item)

    return enriched_results


def _search_symbol_request(text, exchange, timeout):
    return _fetch_json(
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


def search_symbol(query_text, timeout=None, limit=8, asset_name="", preferred_asset_type=""):
    normalized_query = unquote(str(query_text or "").strip())

    if not normalized_query:
        return None, "Escribe un nombre o ticker para buscar"

    # Si pegan un ticker ya con mercado (p.ej. "BITVAVO:BTCEUR", copiado del
    # propio campo "Ticker mercado" o de la URL de TradingView), mandar los dos
    # puntos dentro de `text` no encuentra ese mercado: la búsqueda de
    # TradingView no lo interpreta como filtro, solo como texto suelto, y el
    # resultado que sale primero suele ser el de un mercado distinto (comprobado
    # contra la API real: "BITVAVO:BTCEUR" como texto devuelve Bybit/Bitfinex,
    # nunca Bitvavo). Separarlo en `text` + `exchange` sí filtra de verdad.
    exchange_filter = ""
    search_text = normalized_query
    if ":" in normalized_query:
        possible_exchange, possible_symbol = normalized_query.split(":", 1)
        if possible_exchange.strip() and possible_symbol.strip():
            exchange_filter = possible_exchange.strip().upper()
            search_text = possible_symbol.strip()

    try:
        payload = _search_symbol_request(search_text, exchange_filter, timeout)
        # Un prefijo que no es un código de mercado real de TradingView filtra a
        # cero en vez de dar error (comprobado: "exchange" inválido -> lista
        # vacía). Repetir como texto libre evita dejar al usuario sin nada por
        # una suposición nuestra que no encaja.
        if exchange_filter and not (payload.get("symbols") or []):
            payload = _search_symbol_request(normalized_query, "", timeout)
    except HTTPError as error:
        return None, f"TradingView devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con TradingView: {error.reason}"

    raw_results = payload.get("symbols") or []
    normalized_asset_name = _normalize_text(asset_name)
    ranked_results = []
    seen_symbols = set()

    for rank_index, item in enumerate(raw_results):
        exchange = str(item.get("exchange", "")).strip().upper()
        raw_symbol = _strip_markup(item.get("symbol", "")).strip().upper()
        description = _strip_markup(item.get("description", "")).strip()
        raw_type = str(item.get("type", "")).strip().lower()
        currency = str(item.get("currency_code", "")).strip().upper()

        if not raw_symbol or not exchange or not description:
            continue

        full_symbol = f"{exchange}:{raw_symbol}"

        if full_symbol in seen_symbols:
            continue

        seen_symbols.add(full_symbol)
        score = _score_result(raw_symbol, description, raw_type, normalized_query, normalized_asset_name, preferred_asset_type, rank_index)
        ranked_results.append((score, {
            "symbol": full_symbol,
            "displaySymbol": full_symbol,
            "description": description,
            "type": _map_type(raw_type),
            "exchange": exchange,
            "provider": "tradingview",
            "price": "",
            "currency": currency,
            "change": ""
        }))

    ranked_results.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    top_results = [item for _, item in ranked_results[:limit]]

    return enrich_search_results_with_quote(top_results, timeout=timeout), None
