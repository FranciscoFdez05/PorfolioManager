from flask import Blueprint, jsonify, request

from app_data import readFinnhubApiKey
from eodhd_client import search_symbol as search_eodhd_symbol
from finnhub_client import fetch_exchange_rate, search_symbol
from helpers import call_eodhd_with_fallbacks, is_temporary_service_error, normalize_currency_code

market_bp = Blueprint("market", __name__)


@market_bp.route("/api/exchange-rate", methods=["GET"])
def getExchangeRate():
    source_currency = normalize_currency_code(request.args.get("source", ""), fallback="EUR")
    target_currency = normalize_currency_code(request.args.get("target", ""), fallback=source_currency)

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
