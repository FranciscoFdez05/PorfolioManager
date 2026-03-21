from flask import Flask, jsonify, request, send_from_directory

from app_data import baseDir, ensureDataFile, readDividendosFile, readFinnhubApiKey, readInteresesFile, readOperacionesFile, writeDividendosFile, writeInteresesFile, writeOperacionesFile
from asset_store import getAssetFile, listAssets, readAssetFile, writeAssetFile
from asset_utils import createDefaultAssetPayload, sanitizeAssetPayload, sanitizeAssetType, slugify
from finnhub_client import convert_amount, convert_quote_currency, fetch_exchange_rate, fetch_quote, search_symbol
from gastos_store import create_default_gastos_year, delete_gastos_year, list_gastos_years, normalize_year, read_gastos_year, sanitize_gastos_payload, write_gastos_year

app = Flask(
    __name__,
    static_folder="../",
    static_url_path=""
)


def normalize_currency_code(currency, fallback="EUR"):
    normalized = str(currency or "").strip().upper()

    if normalized in {"USDT", "USDC", "BUSD"}:
        return "USD"

    return normalized or fallback


def parse_loose_number(value):
    text = str(value or "").strip()

    if not text:
        return None

    cleaned = "".join(character for character in text if character.isdigit() or character in ",.-")

    if not cleaned:
        return None

    if "," in cleaned and "." in cleaned:
        normalized = cleaned.replace(".", "").replace(",", ".")
    else:
        normalized = cleaned.replace(",", ".")

    try:
        return float(normalized)
    except ValueError:
        return None


def format_decimal(value, digits=2):
    return f"{float(value):.{digits}f}".replace(".", ",")


def convert_asset_rows_currency(rows, source_currency, target_currency, asset_type="", fields=None):
    converted_rows = []
    normalized_asset_type = str(asset_type or "").strip().lower()

    for row in rows or []:
        converted_row = dict(row)
        money_fields = ("precioParticipacion", "comisiones")

        if normalized_asset_type != "cripto":
            money_fields = ("precioParticipacion", "capitalInvertidoBruto", "comisiones")

        if fields:
            allowed_fields = set(fields)
            money_fields = tuple(field_name for field_name in money_fields if field_name in allowed_fields)

        for field_name in money_fields:
            parsed_value = parse_loose_number(converted_row.get(field_name, ""))

            if parsed_value is None:
                continue

            converted_value, error = convert_amount(parsed_value, source_currency, target_currency)

            if error:
                return None, error

            converted_row[field_name] = format_decimal(converted_value)

        converted_rows.append(converted_row)

    return converted_rows, None


@app.route("/")
def serveIndex():
    return send_from_directory(baseDir, "index.html")


@app.route("/api/exchange-rate", methods=["GET"])
def getExchangeRate():
    source_currency = normalize_currency_code(request.args.get("source", ""), fallback="EUR")
    target_currency = normalize_currency_code(request.args.get("target", ""), fallback=source_currency)

    if source_currency == target_currency:
        return jsonify({"ok": True, "source": source_currency, "target": target_currency, "rate": 1.0})

    rate, error = fetch_exchange_rate(source_currency, target_currency)

    if error:
        statusCode = 503 if "conectar" in error or "divisa" in error else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "source": source_currency, "target": target_currency, "rate": rate})


@app.route("/api/intereses", methods=["GET"])
def getIntereses():
    data = readInteresesFile()
    return jsonify(data)


@app.route("/api/intereses", methods=["POST"])
def saveIntereses():
    requestData = request.get_json(silent=True)

    if not requestData or "rows" not in requestData:
        return jsonify({"ok": False, "error": "JSON inválido"}), 400

    rows = requestData["rows"]

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitizedRows = []

    for row in rows:
        sanitizedRows.append({
            "fecha": str(row.get("fecha", "")).strip(),
            "saldoPromedio": str(row.get("saldoPromedio", "")).strip(),
            "acumulado": str(row.get("acumulado", "")).strip(),
            "impuestos": str(row.get("impuestos", "")).strip()
        })

    writeInteresesFile({"rows": sanitizedRows})

    return jsonify({"ok": True})


@app.route("/api/intereses/reset", methods=["POST"])
def resetIntereses():
    writeInteresesFile({"rows": []})
    return jsonify({"ok": True})


@app.route("/api/dividendos", methods=["GET"])
def getDividendos():
    data = readDividendosFile()
    return jsonify(data)


@app.route("/api/dividendos", methods=["POST"])
def saveDividendos():
    requestData = request.get_json(silent=True)

    if not requestData or "rows" not in requestData:
        return jsonify({"ok": False, "error": "JSON inválido"}), 400

    rows = requestData["rows"]

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitizedRows = []

    for row in rows:
        sanitizedRows.append({
            "fecha": str(row.get("fecha", "")).strip(),
            "instrumento": str(row.get("instrumento", "")).strip(),
            "acciones": str(row.get("acciones", "")).strip(),
            "dividendoAccion": str(row.get("dividendoAccion", "")).strip(),
            "impuestos": str(row.get("impuestos", "")).strip(),
            "total": str(row.get("total", "")).strip()
        })

    writeDividendosFile({"rows": sanitizedRows})

    return jsonify({"ok": True})


@app.route("/api/dividendos/reset", methods=["POST"])
def resetDividendos():
    writeDividendosFile({"rows": []})
    return jsonify({"ok": True})


@app.route("/api/operaciones", methods=["GET"])
def getOperaciones():
    data = readOperacionesFile()
    return jsonify(data)


@app.route("/api/operaciones", methods=["POST"])
def saveOperaciones():
    requestData = request.get_json(silent=True) or {}
    rows = requestData.get("rows", [])

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitizedRows = []

    for index, row in enumerate(rows):
        orden = str(row.get("orden", "Compra")).strip().capitalize()
        estado = str(row.get("estado", "Activo")).strip().capitalize()

        if orden not in {"Compra", "Venta"}:
            orden = "Compra"

        if estado not in {"Activo", "Cerrado", "Completado"}:
            estado = "Activo"

        currency = str(row.get("currency", "EUR")).strip().upper()
        precio_currency = str(row.get("precioCurrency", "EUR")).strip().upper()

        if currency not in {"EUR", "USD"}:
            currency = "EUR"

        if precio_currency not in {"EUR", "USD"}:
            precio_currency = "EUR"

        sanitizedRows.append({
            "id": str(row.get("id", f"operacion-{index + 1}")).strip() or f"operacion-{index + 1}",
            "activo": str(row.get("activo", "")).strip(),
            "fechaApertura": str(row.get("fechaApertura", row.get("fecha", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "orden": orden,
            "precioOrden": str(row.get("precioOrden", row.get("precio", ""))).strip(),
            "precioCurrency": precio_currency,
            "cantidad": str(row.get("cantidad", "")).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": currency,
            "estado": estado,
            "fechaCierre": str(row.get("fechaCierre", "")).strip()
        })

    writeOperacionesFile({"rows": sanitizedRows})
    return jsonify({"ok": True})


@app.route("/api/gastos", methods=["GET"])
def getGastosYears():
    years = list_gastos_years()

    if not years:
        default_year = "2026"
        payload = create_default_gastos_year(default_year)
        write_gastos_year(default_year, payload)
        years = [default_year]

    return jsonify({"years": years})


@app.route("/api/gastos", methods=["POST"])
def createGastosYear():
    requestData = request.get_json(silent=True) or {}
    year = normalize_year(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if read_gastos_year(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    payload = create_default_gastos_year(year)
    write_gastos_year(year, payload)
    return jsonify({"ok": True, "year": year, "data": payload}), 201


@app.route("/api/gastos/<year>", methods=["GET"])
def getGastosYear(year):
    data = read_gastos_year(year)

    if data is None:
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    return jsonify(data)


@app.route("/api/gastos/<year>", methods=["POST"])
def saveGastosYear(year):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitize_gastos_payload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    write_gastos_year(year, payload)
    return jsonify({"ok": True})


@app.route("/api/gastos/<year>", methods=["DELETE"])
def deleteGastosYear(year):
    normalized_year = normalize_year(year)

    if not normalized_year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not delete_gastos_year(normalized_year):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remaining_years = list_gastos_years()

    if not remaining_years:
        payload = create_default_gastos_year("2026")
        write_gastos_year("2026", payload)
        remaining_years = ["2026"]

    return jsonify({"ok": True, "years": remaining_years})


@app.route("/api/activos", methods=["GET"])
def getActivos():
    return jsonify({"assets": listAssets()})


@app.route("/api/activos", methods=["POST"])
def createActivo():
    requestData = request.get_json(silent=True) or {}
    assetName = str(requestData.get("name", "")).strip()
    assetType = sanitizeAssetType(requestData.get("type", ""))
    finnhubSymbol = str(requestData.get("finnhubSymbol", "")).strip().upper()

    if not assetName:
        return jsonify({"ok": False, "error": "El nombre del activo es obligatorio"}), 400

    if not assetType:
        return jsonify({"ok": False, "error": "Tipo de activo inválido"}), 400

    assetId = slugify(assetName)
    assetFile = getAssetFile(assetId)

    if assetFile.exists():
        return jsonify({"ok": False, "error": "Ya existe un activo con ese nombre"}), 409

    payload = createDefaultAssetPayload(assetName, assetType, assetId)
    payload["finnhubSymbol"] = finnhubSymbol
    payload["order"] = len(listAssets())
    writeAssetFile(assetId, payload)

    return jsonify({"ok": True, "asset": payload}), 201


@app.route("/api/activos/<assetId>", methods=["GET"])
def getActivo(assetId):
    data = readAssetFile(assetId)

    if data is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    return jsonify(data)


@app.route("/api/activos/<assetId>", methods=["POST"])
def saveActivo(assetId):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitizeAssetPayload(requestData, slugify(assetId))

    if error:
        return jsonify({"ok": False, "error": error}), 400

    writeAssetFile(assetId, payload)
    return jsonify({"ok": True})


@app.route("/api/activos/<assetId>/refresh-market-data", methods=["POST"])
def refreshActivoMarketData(assetId):
    assetData = readAssetFile(assetId)

    if assetData is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    finnhubSymbol = str(assetData.get("finnhubSymbol", "")).strip().upper()

    if not finnhubSymbol:
        return jsonify({"ok": False, "error": "El activo no tiene ticker de Finnhub configurado"}), 400

    apiKey = readFinnhubApiKey()
    quote, error = fetch_quote(finnhubSymbol, apiKey)

    if error:
        statusCode = 503 if "API key" in error or "conectar" in error else 400
        return jsonify({"ok": False, "error": error}), statusCode

    target_currency = normalize_currency_code(assetData.get("currency", ""), fallback="EUR")
    quote, error = convert_quote_currency(quote, target_currency)

    if error:
        statusCode = 503 if "API key" in error or "conectar" in error or "divisa" in error else 400
        return jsonify({"ok": False, "error": error}), statusCode

    assetData["finnhubSymbol"] = quote["symbol"]
    assetData["price"] = quote["price"]
    assetData["currency"] = quote["currency"]
    assetData["change"] = quote["change"]
    assetData["status"] = quote["status"]
    assetData["lastUpdated"] = quote["lastUpdated"]
    writeAssetFile(assetId, assetData)

    return jsonify({"ok": True, "asset": assetData, "marketData": quote["marketData"]})


@app.route("/api/activos/<assetId>/currency", methods=["POST"])
def changeActivoCurrency(assetId):
    assetData = readAssetFile(assetId)

    if assetData is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    requestData = request.get_json(silent=True) or {}
    scope = str(requestData.get("scope", "asset")).strip().lower()
    is_crypto = str(assetData.get("type", "")).strip().lower() == "cripto"
    current_currency = normalize_currency_code(assetData.get("currency", ""), fallback="EUR")
    current_precio_currency = normalize_currency_code(assetData.get("precioCurrency", assetData.get("currency", "")), fallback=current_currency)
    target_currency = normalize_currency_code(
        requestData.get("currency", ""),
        fallback=current_precio_currency if scope == "price" else current_currency
    )

    if target_currency not in {"EUR", "USD"}:
        return jsonify({"ok": False, "error": "Solo se permite cambiar entre EUR y USD"}), 400

    if scope == "price":
        if not is_crypto:
            return jsonify({"ok": False, "error": "La moneda separada del precio solo aplica a criptos"}), 400

        if current_precio_currency == target_currency:
            return jsonify({"ok": True, "asset": assetData, "converted": False})

        converted_rows, error = convert_asset_rows_currency(
            assetData.get("rows", []),
            current_precio_currency,
            target_currency,
            assetData.get("type", ""),
            fields=("precioParticipacion",)
        )

        if error:
            statusCode = 503 if "conectar" in error or "divisa" in error else 400
            return jsonify({"ok": False, "error": error}), statusCode

        assetData["rows"] = converted_rows
        assetData["precioCurrency"] = target_currency
        assetData["status"] = f"Precio de participación convertido de {current_precio_currency} a {target_currency}"
        writeAssetFile(assetId, assetData)

        return jsonify({"ok": True, "asset": assetData, "converted": True})

    if current_currency == target_currency:
        return jsonify({"ok": True, "asset": assetData, "converted": False})

    converted_price = parse_loose_number(assetData.get("price", ""))

    if converted_price is not None:
        converted_price, error = convert_amount(converted_price, current_currency, target_currency)

        if error:
            statusCode = 503 if "conectar" in error or "divisa" in error else 400
            return jsonify({"ok": False, "error": error}), statusCode

        assetData["price"] = format_decimal(converted_price)

    converted_rows, error = convert_asset_rows_currency(
        assetData.get("rows", []),
        current_currency,
        target_currency,
        assetData.get("type", ""),
        fields=("capitalInvertidoBruto", "comisiones") if is_crypto else None
    )

    if error:
        statusCode = 503 if "conectar" in error or "divisa" in error else 400
        return jsonify({"ok": False, "error": error}), statusCode

    assetData["rows"] = converted_rows
    assetData["currency"] = target_currency
    assetData["status"] = f"Activo convertido de {current_currency} a {target_currency}"
    writeAssetFile(assetId, assetData)

    return jsonify({"ok": True, "asset": assetData, "converted": True})


@app.route("/api/finnhub/search", methods=["GET"])
@app.route("/api/market/search", methods=["GET"])
def searchFinnhubSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    apiKey = readFinnhubApiKey()
    results, error = search_symbol(query, apiKey, asset_name=assetName, preferred_asset_type=assetType)

    if error:
        statusCode = 503 if "API key" in error or "conectar" in error else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@app.route("/api/activos/<assetId>", methods=["DELETE"])
def deleteActivo(assetId):
    assetFile = getAssetFile(assetId)

    if not assetFile.exists():
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    assetFile.unlink()
    return jsonify({"ok": True})


@app.route("/api/activos/reorder", methods=["POST"])
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

    for index, asset in enumerate(assets):
        assetData = readAssetFile(asset["id"])

        if assetData is None:
            continue

        assetData["order"] = index
        writeAssetFile(asset["id"], assetData)

    return jsonify({"ok": True, "moved": True})


@app.route("/<path:path>")
def serveStatic(path):
    return send_from_directory(baseDir, path)


if __name__ == "__main__":
    ensureDataFile()
    app.run(host="127.0.0.1", port=5000, debug=True)
