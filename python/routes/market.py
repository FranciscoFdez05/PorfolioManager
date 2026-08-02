import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

from core.db import get_db
from providers.alpha_vantage_client import fetch_quote as fetch_av_quote, search_symbol as search_av_symbol
from providers.eodhd_client import fetch_quote as fetch_eodhd_quote, search_symbol as search_eodhd_symbol
from providers.finnhub_client import (
    fetch_candle_close,
    fetch_exchange_rate,
    fetch_quote as fetch_finnhub_quote,
    search_symbol,
)
from providers.yahoo_finance_client import fetch_quote as fetch_yahoo_quote, search_symbol as search_yahoo_symbol
from stores.app_data import readFinnhubApiKey
from stores.asset_store import listAssets
from stores.asset_utils import inferMarketProviderFromSymbol, normalizeMarketProvider
from stores.helpers import (
    call_alpha_vantage_with_fallbacks,
    call_eodhd_with_fallbacks,
    is_temporary_service_error,
    normalize_currency_code,
    parse_loose_number,
)

_hist_cache = {}   # {period: {"data": {...}, "ts": float}}
_HIST_TTL   = 4 * 3600  # 4 horas

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

    cached = _hist_cache.get(period)
    if cached and time.time() - cached["ts"] < _HIST_TTL:
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
            cur_price = parse_loose_number(str(asset.get("price") or ""))
            if not symbol or not cur_price or cur_price <= 0:
                return asset["id"], None
            hist_price, _ = fetch_candle_close(symbol, from_ts, to_ts, api_key)
            if hist_price and hist_price > 0:
                return asset["id"], round((cur_price - hist_price) / hist_price * 100, 2)
            return asset["id"], None

        with ThreadPoolExecutor(max_workers=6) as pool:
            futures = {pool.submit(fetch_one, a): a for a in assets_needing_api}
            for f in as_completed(futures):
                asset_id, pct = f.result()
                if pct is not None:
                    result[asset_id] = pct

    _hist_cache[period] = {"data": result, "ts": time.time()}
    return jsonify({"ok": True, "data": result, "cached": False})


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

    provider = normalizeMarketProvider(provider_raw, fallback=inferMarketProviderFromSymbol(symbol))

    if provider == "eodhd":
        quote, error = call_eodhd_with_fallbacks(lambda apiKey: fetch_eodhd_quote(symbol, apiKey))
    elif provider == "yahoo":
        quote, error = fetch_yahoo_quote(symbol)
    elif provider == "alphavantage":
        quote, error = call_alpha_vantage_with_fallbacks(lambda apiKey: fetch_av_quote(symbol, apiKey))
    else:
        api_key = readFinnhubApiKey()
        quote, error = fetch_finnhub_quote(symbol, api_key)

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
