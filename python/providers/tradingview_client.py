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
    "commodity": "commodity",
    "swap": "perpetuo",
}

_TAG_RE = re.compile(r"</?em>")

# El scanner gratuito no tiene todos los cruces de divisa que sí se ven en
# tradingview.com: OANDA:XAUEUR no está pero OANDA:XAUUSD sí. Un cruce que falta
# se calcula como lo calculan los propios brókers: el par en dólares del mismo
# mercado entre su tipo de cambio. Comprobado contra el gráfico de OANDA:XAUEUR:
# 4284,97 / 1,13911 = 3761,68, lo mismo que marca TradingView.
#
# No hay ninguna lista de activos, mercados ni divisas: todo sale del ticker que
# eligió el usuario y de lo que devuelva la API. Si al mercado le falta el par
# en dólares o el tipo de cambio, el cruce se queda sin cotización.
_CROSS_RE = re.compile(r"^([A-Z]{3})([A-Z]{3})$")


def _strip_markup(text):
    """TradingView resalta la coincidencia con `<em>` dentro de symbol/description."""
    return _TAG_RE.sub("", str(text or ""))


def _map_type(raw_type):
    return _TYPE_MAP.get(str(raw_type or "").strip().lower(), "market")


def _fetch_json(url, params=None, timeout=None, json_body=None, headers=None):
    return fetch_json(url, params, timeout=timeout, provider="TradingView", json_body=json_body, headers=headers)


def _scan(tickers, timeout=None):
    """`{ticker: (precio, variación %, divisa)}` de los que el scanner cotiza.

    Una sola petición para todos. Deja pasar HTTPError/URLError: cada llamante
    decide si eso es un error que enseñar o un "sin cotización".
    """
    if not tickers:
        return {}

    payload = _fetch_json(
        TRADINGVIEW_SCAN_URL,
        json_body={"symbols": {"tickers": list(tickers), "query": {"types": []}}, "columns": _SCAN_COLUMNS},
        timeout=timeout,
    )

    cotizados = {}
    for row in payload.get("data") or []:
        values = row.get("d") or []
        if not row.get("s") or len(values) < 3:
            continue
        price = float(values[0] or 0)
        if price <= 0:
            continue
        cotizados[row["s"]] = (price, float(values[1] or 0), str(values[2] or "").strip().upper())
    return cotizados


def _cross_plan(ticker):
    """Con qué tickers se calcula el cruce `MERCADO:BBBQQQ` si el scanner no lo
    tiene, o None: `(par en USD, cambio QQQUSD, cambio USDQQQ, divisa QQQ)`.

    Se piden las dos orientaciones del tipo de cambio porque cada divisa cotiza
    en una (EURUSD pero USDJPY) y eso no se supone: se usa la que exista.
    """
    exchange, _, symbol = ticker.partition(":")
    match = _CROSS_RE.match(symbol)
    if not exchange or not match:
        return None

    base, target = match.groups()
    if "USD" in (base, target):
        return None  # ya es un par en dólares: no hay de dónde calcularlo

    return f"{exchange}:{base}USD", f"{exchange}:{target}USD", f"{exchange}:USD{target}", target


def _synthetic_quotes(tickers, timeout=None):
    """Calcula los cruces que el scanner no tiene: `{ticker: (precio, variación %,
    divisa, origen)}`. Una sola petición para todas las piezas que hagan falta."""
    plans = {ticker: plan for ticker in tickers if (plan := _cross_plan(ticker))}
    if not plans:
        return {}

    piezas = sorted({pieza for base, directo, inverso, _ in plans.values() for pieza in (base, directo, inverso)})
    try:
        cotizados = _scan(piezas, timeout)
    except (HTTPError, URLError):
        return {}

    calculados = {}
    for ticker, (base, directo, inverso, target) in plans.items():
        if cotizados.get(base, (0, 0, ""))[2] != "USD":
            continue
        base_price, base_change, _ = cotizados[base]

        # La variación del cruce no es la resta de las dos: se compone.
        if directo in cotizados:  # QQQUSD: dólares por unidad, se divide
            fx = directo
            fx_price, fx_change, _ = cotizados[fx]
            price = base_price / fx_price
            change = ((1 + base_change / 100) / (1 + fx_change / 100) - 1) * 100
        elif inverso in cotizados:  # USDQQQ: unidades por dólar, se multiplica
            fx = inverso
            fx_price, fx_change, _ = cotizados[fx]
            price = base_price * fx_price
            change = ((1 + base_change / 100) * (1 + fx_change / 100) - 1) * 100
        else:
            continue

        calculados[ticker] = (price, change, target, f"{base} / {fx}")

    return calculados


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
        cotizados = _scan([normalized_symbol], timeout)
    except HTTPError as error:
        return None, f"TradingView devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con TradingView: {error.reason}"

    status = "Cotización actualizada"
    if normalized_symbol in cotizados:
        current_price, percent_change, currency = cotizados[normalized_symbol]
        currency = currency or "USD"
    else:
        calculado = _synthetic_quotes([normalized_symbol], timeout).get(normalized_symbol)
        if not calculado:
            return None, "TradingView no devolvió cotización para ese ticker"
        current_price, percent_change, currency, origen = calculado
        # Se dice de dónde sale: no es la cotización de ese ticker en concreto
        # sino la del par en dólares pasada por el cambio, y puede diferir en
        # el diferencial del bróker.
        status = f"Cotización calculada ({origen})"

    previous_close = current_price / (1 + percent_change / 100) if percent_change != -100 else current_price

    return {
        "symbol": normalized_symbol,
        "price": _format_decimal(current_price),
        "currency": currency,
        "change": _format_percent(percent_change),
        "status": status,
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": current_price,
            "percentChange": percent_change,
            "previousClose": previous_close
        }
    }, None


# Qué tipos de la API corresponden a cada tipo de activo de la aplicación (el
# que eliges al crear el activo). Es la traducción entre el vocabulario de la
# app y el de TradingView, no una preferencia por ningún activo, marca ni
# mercado: qué resultado encaja lo deciden tu elección y el tipo que da la API.
_TIPOS_API_POR_CATEGORIA = {
    "acciones": {"stock", "dr"},
    "etfs": {"fund", "structured"},
    "cripto": {"crypto", "spot"},
    "comoditis": {"commodity", "futures", "cfd"},
}


def _score_result(symbol, description, query_text, normalized_asset_name="", rank_index=0):
    """Relevancia de un resultado, solo con lo que escribió el usuario y lo que
    dice la API: sin listas de palabras, marcas ni mercados preferidos."""
    normalized_query = _normalize_text(query_text)
    compact_query = _compact_symbol(query_text)
    compact_symbol = _compact_symbol(symbol)
    normalized_description = _normalize_text(description)

    # TradingView ya devuelve sus propios resultados ordenados por relevancia.
    # Este suelo, que baja con la posición original, hace que esa ordenación
    # mande salvo que el símbolo o el nombre coincidan mejor con lo buscado.
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

    return score


def _batch_fetch_quotes(symbols, timeout=None):
    """Cotiza varios símbolos de una vez: una sola llamada al scanner, no una
    por resultado. El scanner ya acepta una lista de `tickers`; usarla aquí es
    lo que permite mirar más candidatos de golpe sin multiplicar peticiones.
    """
    if not symbols:
        return {}

    try:
        cotizados = _scan(symbols, timeout)
    except (HTTPError, URLError):
        return {}

    # Los que el scanner no tiene y son un cruce calculable con piezas del mismo
    # mercado (OANDA:XAUEUR) salen con precio en vez de "sin cotización".
    faltan = [symbol for symbol in symbols if symbol not in cotizados]
    for symbol, (price, change, currency, _origen) in _synthetic_quotes(faltan, timeout).items():
        cotizados[symbol] = (price, change, currency)

    return {
        symbol: {
            "price": _format_decimal(price),
            "currency": currency,
            "change": _format_percent(change),
        }
        for symbol, (price, change, currency) in cotizados.items()
    }


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
    tipos_categoria = _TIPOS_API_POR_CATEGORIA.get(str(preferred_asset_type or "").strip().lower())
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
        score = _score_result(raw_symbol, description, normalized_query, normalized_asset_name, rank_index)
        # Sin tipo de activo elegido, todos cuentan igual.
        en_categoria = raw_type in tipos_categoria if tipos_categoria else True
        ranked_results.append((score, en_categoria, {
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

    # Primero lo que la API marca como del tipo de activo elegido; dentro, por
    # relevancia. Así, buscando "XAG" en un activo de materias primas, la plata
    # de los brókers (tipo "commodity") va antes que los contratos perpetuos de
    # los exchanges de cripto (tipo "swap"), sin nombrar a ninguno de los dos.
    ranked_results.sort(key=lambda row: (not row[1], -row[0], row[2]["symbol"]))

    # Se cotiza un grupo más amplio que lo que se va a enseñar (`_ENRICH_POOL`,
    # no `limit`): mirar la cotización solo cambia si un resultado sale al
    # final antes de saber si es el que sirve. Hay listados que el scanner
    # gratuito no tiene aunque coticen en tradingview.com, y sin este margen uno
    # sin precio se quedaba en el hueco de otro mercado del mismo instrumento
    # que sí lo tiene y rankeaba justo un poco peor.
    _ENRICH_POOL = max(limit, 20)
    candidates = [(en_categoria, item) for _, en_categoria, item in ranked_results[:_ENRICH_POOL]]
    quotes = _batch_fetch_quotes([item["symbol"] for _, item in candidates], timeout=timeout)

    for _, candidate in candidates:
        quote = quotes.get(candidate["symbol"])
        if quote:
            candidate["price"] = quote["price"]
            candidate["currency"] = quote["currency"]
            candidate["change"] = quote["change"]

    # Sort estable: dentro del tipo de activo elegido va antes lo que tiene
    # cotización, y a igualdad se respeta el orden de relevancia.
    candidates.sort(key=lambda pair: (not pair[0], pair[1]["price"] == ""))

    return [item for _, item in candidates[:limit]], None
