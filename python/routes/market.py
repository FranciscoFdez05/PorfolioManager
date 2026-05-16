import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta

from flask import Blueprint, jsonify, request

from alpha_vantage_client import search_symbol as search_av_symbol
from app_data import readFinnhubApiKey
from asset_store import listAssets
from eodhd_client import search_symbol as search_eodhd_symbol
from finnhub_client import fetch_candle_close, fetch_exchange_rate, search_symbol
from helpers import call_alpha_vantage_with_fallbacks, call_eodhd_with_fallbacks, is_temporary_service_error, normalize_currency_code, parse_loose_number
from yahoo_finance_client import search_symbol as search_yahoo_symbol

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

    from_ts = int(target.timestamp())
    to_ts   = from_ts + 10 * 86400

    api_key = readFinnhubApiKey()
    assets  = listAssets()

    def fetch_one(asset):
        symbol    = str(asset.get("marketSymbol") or asset.get("finnhubSymbol") or "").strip()
        cur_price = parse_loose_number(str(asset.get("price") or ""))
        if not symbol or not cur_price or cur_price <= 0:
            return asset["id"], None
        hist_price, _ = fetch_candle_close(symbol, from_ts, to_ts, api_key)
        if hist_price and hist_price > 0:
            return asset["id"], round((cur_price - hist_price) / hist_price * 100, 2)
        return asset["id"], None

    result = {}
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(fetch_one, a): a for a in assets
                   if a.get("marketSymbol") or a.get("finnhubSymbol")}
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
