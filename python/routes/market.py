import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

from core import dinero, settings
from core.db import get_db
from providers.alpha_vantage_client import search_symbol as search_av_symbol
from providers.eodhd_client import search_symbol as search_eodhd_symbol
from providers.finnhub_client import (
    fetch_candle_close,
    fetch_exchange_rate,
    search_symbol,
)
from providers.yahoo_finance_client import search_symbol as search_yahoo_symbol
from stores import benchmark
from stores.app_data import readFinnhubApiKey
from stores.asset_store import listAssets
from stores.helpers import (
    call_alpha_vantage_with_fallbacks,
    call_eodhd_with_fallbacks,
    is_temporary_service_error,
    normalize_currency_code,
    parse_loose_number,
)
from stores.market_data import fetch_asset_quote

_hist_cache = {}   # {period: {"data": {...}, "ts": float}}

market_bp = Blueprint("market", __name__)


@market_bp.route("/api/exchange-rate", methods=["GET"])
def getExchangeRate():
    source_currency = normalize_currency_code(
        request.args.get("source") or request.args.get("from", ""), fallback="EUR"
    )
    target_currency = normalize_currency_code(
        request.args.get("target") or request.args.get("to", ""), fallback=source_currency
    )

    if source_currency == target_currency:
        return jsonify({"ok": True, "source": source_currency, "target": target_currency, "rate": 1.0})

    rate, error = fetch_exchange_rate(source_currency, target_currency)

    if error:
        statusCode = 503 if is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "source": source_currency, "target": target_currency, "rate": rate})


@market_bp.route("/api/finnhub/search", methods=["GET"])
@market_bp.route("/api/market/search", methods=["GET"])
def searchFinnhubSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    apiKey = readFinnhubApiKey()
    results, error = search_symbol(query, apiKey, asset_name=assetName, preferred_asset_type=assetType)

    if error:
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@market_bp.route("/api/historical-changes", methods=["GET"])
def getHistoricalChanges():
    period = str(request.args.get("period", "semana")).strip().lower()
    if period not in ("semana", "mes", "ytd", "anyo"):
        return jsonify({"ok": False, "error": "Periodo inválido"}), 400

    # TTL 0 en [mercado] historico_ttl_segundos desactiva la caché: útil para
    # depurar sin tener que esperar a que caduque.
    ttl = settings.historicoTtlSegundos()
    cached = _hist_cache.get(period)
    if ttl > 0 and cached and time.time() - cached["ts"] < ttl:
        return jsonify({"ok": True, "data": cached["data"], "cached": True})

    now = datetime.utcnow()
    if period == "semana":
        target = now - timedelta(days=7)
    elif period == "mes":
        target = now - timedelta(days=30)
    elif period == "ytd":
        target = datetime(now.year, 1, 2)
    else:
        target = now - timedelta(days=365)

    from_ts    = int(target.timestamp())
    safe_limit = int((now - timedelta(days=2)).timestamp())
    to_ts      = min(from_ts + 10 * 86400, safe_limit)

    conn   = get_db()
    result = {}

    # Snapshot más reciente por activo (valor actual)
    latest: dict[str, float] = {}
    for row in conn.execute(
        "SELECT asset_id, price_eur FROM asset_snapshots "
        "WHERE ts = (SELECT MAX(ts) FROM asset_snapshots)"
    ).fetchall():
        latest[row["asset_id"]] = row["price_eur"]

    # Snapshot del periodo objetivo por activo (primer registro en la ventana)
    past: dict[str, float] = {}
    for row in conn.execute(
        "SELECT asset_id, price_eur FROM asset_snapshots "
        "WHERE ts BETWEEN ? AND ? ORDER BY ts ASC",
        (from_ts, to_ts)
    ).fetchall():
        if row["asset_id"] not in past:
            past[row["asset_id"]] = row["price_eur"]

    assets_needing_api = []
    for asset in listAssets():
        aid  = asset["id"]
        cur  = latest.get(aid)
        prev = past.get(aid)
        if cur and prev and prev > 0:
            result[aid] = round((cur - prev) / prev * 100, 2)
        elif asset.get("marketSymbol") or asset.get("finnhubSymbol"):
            assets_needing_api.append(asset)

    # Fallback a Finnhub para activos sin snapshots almacenados
    if assets_needing_api:
        api_key = readFinnhubApiKey()

        def fetch_one(asset):
            symbol    = str(asset.get("marketSymbol") or asset.get("finnhubSymbol") or "").strip()
            cur_price = parse_loose_number(asset.get("price"))
            if not symbol or not cur_price or cur_price <= 0:
                return asset["id"], None
            hist_price, _ = fetch_candle_close(symbol, from_ts, to_ts, api_key)
            if not hist_price or hist_price <= 0:
                return asset["id"], None
            # El precio actual sale de una columna TEXT (Decimal) y el histórico
            # de la API de Finnhub (float). Restarlos directamente es un
            # TypeError, así que el float del proveedor entra por `dinero`, que
            # lo convierte por su representación más corta en vez de arrastrar
            # la cola binaria.
            hist = dinero.aDecimal(hist_price, "precio histórico")
            variacion = (cur_price - hist) / hist * 100
            return asset["id"], float(dinero.redondear(variacion))

        with ThreadPoolExecutor(max_workers=settings.maxPeticionesParalelas()) as pool:
            futures = {pool.submit(fetch_one, a): a for a in assets_needing_api}
            for f in as_completed(futures):
                asset_id, pct = f.result()
                if pct is not None:
                    result[asset_id] = pct

    _hist_cache[period] = {"data": result, "ts": time.time()}
    return jsonify({"ok": True, "data": result, "cached": False})


@market_bp.route("/api/market/benchmarks", methods=["GET"])
def listBenchmarks():
    return jsonify({"ok": True, "indices": benchmark.catalogo()})


@market_bp.route("/api/market/benchmark", methods=["GET"])
def getBenchmark():
    """Cierres diarios del índice pedido, para superponerlo a la evolución."""
    clave = request.args.get("indice", "")
    ahora = int(time.time())
    try:
        desde = int(request.args.get("from") or (ahora - 365 * 86400))
        hasta = int(request.args.get("to") or ahora)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Rango inválido"}), 400
    if desde >= hasta:
        return jsonify({"ok": False, "error": "Rango inválido"}), 400

    datos, error = benchmark.serie(clave, desde, hasta)
    if error:
        statusCode = 503 if is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, **datos})


@market_bp.route("/api/historical-changes/invalidate", methods=["POST"])
def invalidateHistoricalCache():
    _hist_cache.clear()
    return jsonify({"ok": True})


@market_bp.route("/api/eodhd/search", methods=["GET"])
def searchEodhdSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = call_eodhd_with_fallbacks(
        lambda apiKey: search_eodhd_symbol(query, apiKey, asset_name=assetName, preferred_asset_type=assetType)
    )

    if error:
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@market_bp.route("/api/yahoo/search", methods=["GET"])
def searchYahooSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = search_yahoo_symbol(query, asset_name=assetName, preferred_asset_type=assetType)

    if error:
        statusCode = 503 if is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@market_bp.route("/api/alphavantage/search", methods=["GET"])
def searchAlphaVantageSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = call_alpha_vantage_with_fallbacks(
        lambda apiKey: search_av_symbol(query, apiKey, asset_name=assetName, preferred_asset_type=assetType)
    )

    if error:
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})

@market_bp.route("/api/market/quote", methods=["GET"])
def getMarketQuote():
    symbol = str(request.args.get("symbol", "")).strip().upper()
    provider_raw = str(request.args.get("provider", "")).strip()

    if not symbol:
        return jsonify({"ok": False, "error": "symbol requerido"}), 400

    quote, error = fetch_asset_quote(symbol, provider_raw)

    if error:
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({
        "ok":          True,
        "price":       quote.get("price"),
        "change":      quote.get("change"),
        "currency":    quote.get("currency", "EUR"),
        "lastUpdated": quote.get("lastUpdated"),
    })
