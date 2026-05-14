from flask import Blueprint, jsonify, request

from app_data import readFinnhubApiKey
from asset_store import deleteAssetFile, getAssetFile, listAssets, readAssetFile, updateAssetMarketData, updateAssetsOrder, writeAssetFile
from db import get_db
from asset_utils import (
    createDefaultAssetPayload, inferMarketProviderFromSymbol,
    normalizeMarketProvider, sanitizeAssetPayload, sanitizeAssetType, sanitize_color, slugify,
    _MAX_TICKER, _trunc,
)
from eodhd_client import fetch_quote as fetch_eodhd_quote
from finnhub_client import convert_amount, convert_quote_currency, fetch_quote
from yahoo_finance_client import fetch_quote as fetch_yahoo_quote
from helpers import (
    call_eodhd_with_fallbacks, convert_asset_rows_currency, format_decimal,
    is_temporary_service_error, normalize_currency_code, parse_loose_number,
)

activos_bp = Blueprint("activos", __name__)


@activos_bp.route("/api/activos", methods=["GET"])
def getActivos():
    return jsonify({"assets": listAssets()})


@activos_bp.route("/api/activos/rendimiento-batch", methods=["GET"])
def getRendimientoBatch():
    conn = get_db()
    assets = conn.execute(
        "SELECT id, price, currency, type FROM activos"
    ).fetchall()

    result = {}

    for asset in assets:
        asset_id = asset["id"]
        asset_type = str(asset["type"] or "").strip().lower()
        is_crypto = asset_type == "cripto"
        current_price = parse_loose_number(str(asset["price"] or "")) or 0

        rows = conn.execute(
            "SELECT tipo_operacion, participaciones, capital_invertido_bruto, "
            "comisiones, comisiones_fiat FROM activo_rows WHERE asset_id = ?",
            (asset_id,)
        ).fetchall()

        op_rows = conn.execute(
            "SELECT orden, cantidad, comisiones_cripto, total FROM activo_operation_rows "
            "WHERE asset_id = ? AND estado = 'Completado'",
            (asset_id,)
        ).fetchall()

        total_participaciones = 0.0
        total_invertido_bruto = 0.0
        total_comisiones_fiat = 0.0

        for row in rows:
            tipo = str(row["tipo_operacion"] or "").strip().lower()
            partic = parse_loose_number(str(row["participaciones"] or "")) or 0
            capital = parse_loose_number(str(row["capital_invertido_bruto"] or "")) or 0
            comis = parse_loose_number(str(row["comisiones"] or "")) or 0
            comis_fiat = parse_loose_number(str(row["comisiones_fiat"] or "")) or 0

            if tipo == "venta":
                total_participaciones -= partic
            else:
                total_participaciones += partic
                total_invertido_bruto += capital
                total_comisiones_fiat += comis_fiat if is_crypto else comis

        for op in op_rows:
            orden = str(op["orden"] or "").strip().lower()
            cantidad = parse_loose_number(str(op["cantidad"] or "")) or 0
            comis_cripto = parse_loose_number(str(op["comisiones_cripto"] or "")) or 0
            total_fiat = parse_loose_number(str(op["total"] or "")) or 0

            if orden == "venta":
                total_participaciones -= cantidad + comis_cripto
            else:
                total_participaciones += max(0, cantidad - comis_cripto)
                total_invertido_bruto += total_fiat

        inverted_neto = max(0, total_invertido_bruto - total_comisiones_fiat)
        neto_actual = max(0, total_participaciones) * current_price
        rendimiento = neto_actual - inverted_neto
        rendimiento_pct = (rendimiento / inverted_neto * 100) if inverted_neto > 0 else 0

        result[asset_id] = {
            "rendimiento": round(rendimiento, 2),
            "invertidoNeto": round(inverted_neto, 2),
            "rendimientoPct": round(rendimiento_pct, 2),
            "netoActual": round(neto_actual, 2),
        }

    return jsonify(result)


@activos_bp.route("/api/activos", methods=["POST"])
def createActivo():
    requestData = request.get_json(silent=True) or {}
    assetName = str(requestData.get("name", "")).strip()
    assetType = sanitizeAssetType(requestData.get("type", ""))
    marketSymbol = str(requestData.get("marketSymbol", requestData.get("finnhubSymbol", ""))).strip().upper()
    marketProvider = normalizeMarketProvider(
        requestData.get("marketProvider", ""),
        fallback=inferMarketProviderFromSymbol(marketSymbol)
    )

    if not assetName:
        return jsonify({"ok": False, "error": "El nombre del activo es obligatorio"}), 400

    if not assetType:
        return jsonify({"ok": False, "error": "Tipo de activo inválido"}), 400

    assetId = slugify(assetName)
    assetFile = getAssetFile(assetId)

    if assetFile.exists():
        return jsonify({"ok": False, "error": "Ya existe un activo con ese nombre"}), 409

    payload = createDefaultAssetPayload(assetName, assetType, assetId)
    payload["marketProvider"] = marketProvider
    payload["marketSymbol"] = marketSymbol
    payload["finnhubSymbol"] = marketSymbol
    payload["order"] = len(listAssets())
    payload["color"] = sanitize_color(requestData.get("color", ""))
    payload["tvSymbol"] = _trunc(str(requestData.get("tvSymbol", "")), _MAX_TICKER).strip()
    writeAssetFile(assetId, payload)

    return jsonify({"ok": True, "asset": payload}), 201


@activos_bp.route("/api/activos/reorder", methods=["POST"])
def reorderActivos():
    requestData = request.get_json(silent=True) or {}
    assets = listAssets()
    orderedAssetIds = requestData.get("orderedAssetIds")

    if isinstance(orderedAssetIds, list):
        normalizedIds = [slugify(assetId) for assetId in orderedAssetIds if str(assetId).strip()]
        currentIds = [asset["id"] for asset in assets]

        if sorted(normalizedIds) != sorted(currentIds):
            return jsonify({"ok": False, "error": "orderedAssetIds no coincide con los activos actuales"}), 400

        assetById = {asset["id"]: asset for asset in assets}
        assets = [assetById[assetId] for assetId in normalizedIds]
    else:
        assetId = slugify(requestData.get("assetId", ""))
        direction = str(requestData.get("direction", "")).strip().lower()

        if not assetId:
            return jsonify({"ok": False, "error": "assetId es obligatorio"}), 400

        if direction not in {"up", "down"}:
            return jsonify({"ok": False, "error": "direction inválida"}), 400

        currentIndex = next((index for index, asset in enumerate(assets) if asset["id"] == assetId), None)

        if currentIndex is None:
            return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

        swapIndex = currentIndex - 1 if direction == "up" else currentIndex + 1

        if swapIndex < 0 or swapIndex >= len(assets):
            return jsonify({"ok": True, "moved": False})

        assets[currentIndex], assets[swapIndex] = assets[swapIndex], assets[currentIndex]

    updateAssetsOrder([asset["id"] for asset in assets])
    return jsonify({"ok": True, "moved": True})


@activos_bp.route("/api/activos/<assetId>", methods=["GET"])
def getActivo(assetId):
    data = readAssetFile(assetId)

    if data is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    return jsonify(data)


@activos_bp.route("/api/activos/<assetId>", methods=["POST"])
def saveActivo(assetId):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitizeAssetPayload(requestData, slugify(assetId))

    if error:
        return jsonify({"ok": False, "error": error}), 400

    existing_asset = readAssetFile(assetId) or {}

    if not requestData.get("operationRows") and isinstance(existing_asset.get("operationRows"), list):
        payload["operationRows"] = existing_asset.get("operationRows", [])

    writeAssetFile(assetId, payload)
    return jsonify({"ok": True})


@activos_bp.route("/api/activos/<assetId>/refresh-market-data", methods=["POST"])
def refreshActivoMarketData(assetId):
    assetData = readAssetFile(assetId)

    if assetData is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    marketSymbol = str(assetData.get("marketSymbol", assetData.get("finnhubSymbol", ""))).strip().upper()
    marketProvider = normalizeMarketProvider(
        assetData.get("marketProvider", ""),
        fallback=inferMarketProviderFromSymbol(marketSymbol)
    )

    if not marketSymbol:
        return jsonify({"ok": False, "error": "El activo no tiene ticker de mercado configurado"}), 400

    if marketProvider == "eodhd":
        quote, error = call_eodhd_with_fallbacks(lambda apiKey: fetch_eodhd_quote(marketSymbol, apiKey))
    elif marketProvider == "yahoo":
        quote, error = fetch_yahoo_quote(marketSymbol)
    else:
        apiKey = readFinnhubApiKey()
        quote, error = fetch_quote(marketSymbol, apiKey)

    if error:
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    target_currency = normalize_currency_code(assetData.get("currency", ""), fallback="EUR")
    quote, error = convert_quote_currency(quote, target_currency)

    if error:
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    assetData["marketProvider"] = marketProvider
    assetData["marketSymbol"] = quote["symbol"]
    assetData["finnhubSymbol"] = quote["symbol"]
    assetData["price"] = quote["price"]
    assetData["currency"] = quote["currency"]
    assetData["change"] = quote["change"]
    assetData["status"] = quote["status"]
    assetData["lastUpdated"] = quote["lastUpdated"]
    updateAssetMarketData(assetId, assetData)

    return jsonify({"ok": True, "asset": assetData, "marketData": quote["marketData"]})


@activos_bp.route("/api/activos/<assetId>/currency", methods=["POST"])
def changeActivoCurrency(assetId):
    assetData = readAssetFile(assetId)

    if assetData is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    requestData = request.get_json(silent=True) or {}
    scope = str(requestData.get("scope", "asset")).strip().lower()
    is_crypto = str(assetData.get("type", "")).strip().lower() == "cripto"
    current_currency = normalize_currency_code(assetData.get("currency", ""), fallback="EUR")
    current_precio_currency = normalize_currency_code(
        assetData.get("precioCurrency", assetData.get("currency", "")),
        fallback=current_currency
    )
    target_currency = normalize_currency_code(
        requestData.get("currency", ""),
        fallback=current_precio_currency if scope == "price" else current_currency
    )

    if target_currency not in {"EUR", "USD"}:
        return jsonify({"ok": False, "error": "Solo se permite cambiar entre EUR y USD"}), 400

    if scope == "price":
        return jsonify({"ok": False, "error": "La moneda separada del precio ya no se usa en criptos"}), 400

    if current_currency == target_currency:
        return jsonify({"ok": True, "asset": assetData, "converted": False})

    # scope="moneda": convert only the price (market value), leave investment rows untouched
    if scope == "moneda":
        converted_price = parse_loose_number(assetData.get("price", ""))
        if converted_price is not None:
            converted_price, error = convert_amount(converted_price, current_currency, target_currency)
            if error:
                statusCode = 503 if is_temporary_service_error(error) else 400
                return jsonify({"ok": False, "error": error}), statusCode
            assetData["price"] = format_decimal(converted_price)
        assetData["currency"] = target_currency
        assetData["precioCurrency"] = target_currency
        assetData["status"] = f"Moneda de cotización cambiada a {target_currency}"
        writeAssetFile(assetId, assetData)
        return jsonify({"ok": True, "asset": assetData, "converted": True})

    converted_price = parse_loose_number(assetData.get("price", ""))

    if converted_price is not None:
        converted_price, error = convert_amount(converted_price, current_currency, target_currency)

        if error:
            statusCode = 503 if is_temporary_service_error(error) else 400
            return jsonify({"ok": False, "error": error}), statusCode

        assetData["price"] = format_decimal(converted_price)

    if not is_crypto:
        converted_rows, error = convert_asset_rows_currency(
            assetData.get("rows", []),
            current_currency,
            target_currency,
            assetData.get("type", ""),
            fields=None
        )

        if error:
            statusCode = 503 if is_temporary_service_error(error) else 400
            return jsonify({"ok": False, "error": error}), statusCode

        assetData["rows"] = converted_rows

    assetData["currency"] = target_currency
    assetData["precioCurrency"] = target_currency
    assetData["investedCurrency"] = target_currency
    assetData["status"] = (
        f"Moneda de visualización convertida de {current_currency} a {target_currency}"
        if is_crypto
        else f"Activo convertido de {current_currency} a {target_currency}"
    )
    writeAssetFile(assetId, assetData)

    return jsonify({"ok": True, "asset": assetData, "converted": True})

@activos_bp.route("/api/activos/<assetId>", methods=["DELETE"])
def deleteActivo(assetId):
    if not deleteAssetFile(assetId):
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    return jsonify({"ok": True})
