import re

from flask import Flask, jsonify, request, send_from_directory

from app_data import baseDir, ensureDataFile, readDividendosFile, readEodhdApiKey, readFinnhubApiKey, readInteresesFile, readOperacionesFile, readRotatedEodhdApiKeys, readStablecoinsFile, readTransaccionesFile, writeDividendosFile, writeInteresesFile, writeOperacionesFile, writeStablecoinsFile, writeTransaccionesFile
from asset_store import getAssetFile, listAssets, readAssetFile, writeAssetFile
from asset_utils import createDefaultAssetPayload, inferMarketProviderFromSymbol, normalizeMarketProvider, sanitizeAssetOperationRows, sanitizeAssetPayload, sanitizeAssetType, slugify
from eodhd_client import fetch_quote as fetch_eodhd_quote
from eodhd_client import search_symbol as search_eodhd_symbol
from finnhub_client import convert_amount, convert_quote_currency, fetch_exchange_rate, fetch_quote, search_symbol
from gastos_store import create_default_gastos_year, delete_gastos_year, list_gastos_years, normalize_year, read_gastos_types, read_gastos_year, sanitize_gastos_payload, sanitize_gastos_types, write_gastos_types, write_gastos_year
from ventas_store import create_default_ventas_year, delete_ventas_year, list_ventas_years, migrate_legacy_ventas_if_needed, read_all_ventas_rows, read_ventas_year, sanitize_ventas_payload, write_ventas_year

app = Flask(
    __name__,
    static_folder="../",
    static_url_path=""
)

def normalize_currency_code(currency, fallback="EUR"):
    normalized = str(currency or "").strip().upper()

    if normalized in {"USDT", "USDC", "BUSD", "DAI", "FDUSD", "PYUSD", "TUSD", "USDE"} or normalized.endswith("USD"):
        return "USD"

    if normalized in {"EURC"} or normalized.endswith("EUR"):
        return "EUR"

    return normalized or fallback


def normalize_stablecoin_symbol(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())


def sanitize_stablecoin_catalog_entry(entry):
    entry = entry or {}
    market_symbol = str(entry.get("marketSymbol", entry.get("symbol", ""))).strip().upper()
    display_symbol = str(entry.get("displaySymbol", market_symbol or entry.get("symbol", ""))).strip().upper()
    symbol = normalize_stablecoin_symbol(entry.get("symbol", ""))

    if not symbol and display_symbol:
        symbol = normalize_stablecoin_symbol(display_symbol.split("/")[0].split("_")[0].split("-")[0])

    if not symbol and market_symbol:
        market_tail = market_symbol.split(":").pop()
        symbol = normalize_stablecoin_symbol(market_tail.split("/")[0].split("_")[0].split("-")[0])

    if not symbol:
        return None

    return {
        "symbol": symbol,
        "marketSymbol": market_symbol or symbol,
        "displaySymbol": display_symbol or symbol,
        "description": str(entry.get("description", "")).strip(),
        "provider": str(entry.get("provider", "FINNHUB")).strip().upper() or "FINNHUB"
    }


def call_eodhd_with_fallbacks(callback):
    apiKeys = readRotatedEodhdApiKeys()

    if not apiKeys:
        legacyKey = readEodhdApiKey()

        if legacyKey:
            apiKeys = [legacyKey]

    if not apiKeys:
        return None, "No se ha encontrado ninguna API key de EODHD"

    lastError = None

    for apiKey in apiKeys:
        try:
            result, error = callback(apiKey)
        except Exception as error:
            result = None
            error = str(error)

        if not error:
            return result, None

        lastError = error

    return None, lastError or "Todas las API keys de EODHD han fallado"


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


def build_completed_operations_by_asset(rows):
    operations_by_asset = {}

    for row in rows or []:
        asset_id = slugify(row.get("assetId", ""))
        estado = str(row.get("estado", "")).strip().capitalize()

        if not asset_id or estado != "Completado":
            continue

        operations_by_asset.setdefault(asset_id, []).append({
            "id": str(row.get("id", "")).strip(),
            "assetId": asset_id,
            "activo": str(row.get("activo", "")).strip(),
            "fechaApertura": str(row.get("fechaApertura", row.get("fecha", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "stablecoinSymbol": str(row.get("stablecoinSymbol", "")).strip().upper(),
            "orden": str(row.get("orden", "Compra")).strip().capitalize(),
            "precioOrden": str(row.get("precioOrden", row.get("precio", ""))).strip(),
            "precioCurrency": str(row.get("precioCurrency", row.get("currency", "EUR"))).strip().upper(),
            "cantidad": str(row.get("cantidad", "")).strip(),
            "comisionesCripto": str(row.get("comisionesCripto", row.get("comisiones", ""))).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": str(row.get("currency", "EUR")).strip().upper(),
            "estado": "Completado",
            "fechaCierre": str(row.get("fechaCierre", "")).strip()
        })

    return {asset_id: sanitizeAssetOperationRows(asset_rows) for asset_id, asset_rows in operations_by_asset.items()}


def sync_completed_operations_into_assets(rows):
    operations_by_asset = build_completed_operations_by_asset(rows)

    for asset in listAssets():
        asset_id = asset["id"]
        asset_data = readAssetFile(asset_id)

        if asset_data is None:
            continue

        asset_data["operationRows"] = operations_by_asset.get(asset_id, [])
        writeAssetFile(asset_id, asset_data)


def is_temporary_service_error(error):
    normalized_error = str(error or "").lower()
    return any(fragment in normalized_error for fragment in ("conectar", "divisa", "tard", "timeout"))


def convert_asset_rows_currency(rows, source_currency, target_currency, asset_type="", fields=None):
    converted_rows = []
    normalized_asset_type = str(asset_type or "").strip().lower()

    for row in rows or []:
        converted_row = dict(row)
        money_fields = ("precioParticipacion", "comisiones")

        if normalized_asset_type != "cripto":
            money_fields = ("precioParticipacion", "capitalInvertidoBruto", "comisiones")
        else:
            money_fields = ("precioParticipacion", "capitalInvertidoBruto", "comisiones", "comisionesFiat")

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
        statusCode = 503 if is_temporary_service_error(error) else 400
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
    sync_completed_operations_into_assets(data.get("rows", []))
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
            "assetId": str(row.get("assetId", "")).strip(),
            "activo": str(row.get("activo", "")).strip(),
            "fechaApertura": str(row.get("fechaApertura", row.get("fecha", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "stablecoinSymbol": str(row.get("stablecoinSymbol", "")).strip().upper(),
            "orden": orden,
            "precioOrden": str(row.get("precioOrden", row.get("precio", ""))).strip(),
            "precioCurrency": precio_currency,
            "cantidad": str(row.get("cantidad", "")).strip(),
            "comisionesCripto": str(row.get("comisionesCripto", row.get("comisiones", ""))).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": currency,
            "estado": estado,
            "fechaCierre": str(row.get("fechaCierre", "")).strip()
        })

    writeOperacionesFile({"rows": sanitizedRows})
    sync_completed_operations_into_assets(sanitizedRows)
    return jsonify({"ok": True})


@app.route("/api/stablecoins", methods=["GET"])
def getStablecoins():
    data = readStablecoinsFile() or {}
    catalog = data.get("catalog", [])
    enabled_symbols = data.get("enabledSymbols", [])
    rows = data.get("rows", [])

    if not isinstance(catalog, list):
        catalog = []

    if not isinstance(enabled_symbols, list):
        enabled_symbols = []

    if not isinstance(rows, list):
        rows = []

    migrated_symbols = []

    for symbol in enabled_symbols:
        normalized_symbol = normalize_stablecoin_symbol(symbol)

        if normalized_symbol and normalized_symbol not in migrated_symbols:
            migrated_symbols.append(normalized_symbol)

    for row in rows:
        normalized_symbol = normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))

        if normalized_symbol and normalized_symbol not in migrated_symbols:
            migrated_symbols.append(normalized_symbol)

    if not catalog and migrated_symbols:
        catalog = [sanitize_stablecoin_catalog_entry({"symbol": symbol}) for symbol in migrated_symbols]
        catalog = [entry for entry in catalog if entry]
        data = {
            "catalog": catalog,
            "enabledSymbols": migrated_symbols if not enabled_symbols else enabled_symbols,
            "rows": rows
        }
        writeStablecoinsFile(data)
        enabled_symbols = data["enabledSymbols"]

    return jsonify({"catalog": catalog, "enabledSymbols": enabled_symbols, "rows": rows})


@app.route("/api/stablecoins", methods=["POST"])
def saveStablecoins():
    requestData = request.get_json(silent=True) or {}
    catalog = requestData.get("catalog", requestData.get("availableSymbols", []))
    enabled_symbols = requestData.get("enabledSymbols", [])
    rows = requestData.get("rows", [])

    if not isinstance(catalog, list):
        return jsonify({"ok": False, "error": "catalog debe ser una lista"}), 400

    if not isinstance(enabled_symbols, list):
        return jsonify({"ok": False, "error": "enabledSymbols debe ser una lista"}), 400

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitized_catalog = []
    catalog_symbols = []

    for entry in catalog:
        normalized_entry = sanitize_stablecoin_catalog_entry(entry if isinstance(entry, dict) else {"symbol": entry})

        if not normalized_entry or normalized_entry["symbol"] in catalog_symbols:
            continue

        catalog_symbols.append(normalized_entry["symbol"])
        sanitized_catalog.append(normalized_entry)

    sanitized_enabled_symbols = []

    for symbol in enabled_symbols:
        normalized_symbol = normalize_stablecoin_symbol(symbol)

        if not normalized_symbol:
            continue

        if catalog_symbols and normalized_symbol not in catalog_symbols:
            continue

        if normalized_symbol not in sanitized_enabled_symbols:
            sanitized_enabled_symbols.append(normalized_symbol)

    if not sanitized_catalog and sanitized_enabled_symbols:
        sanitized_catalog = [sanitize_stablecoin_catalog_entry({"symbol": symbol}) for symbol in sanitized_enabled_symbols]
        sanitized_catalog = [entry for entry in sanitized_catalog if entry]
        catalog_symbols = [entry["symbol"] for entry in sanitized_catalog]

    if not sanitized_catalog:
        inferred_symbols = []

        for row in rows:
            normalized_symbol = normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))

            if normalized_symbol and normalized_symbol not in inferred_symbols:
                inferred_symbols.append(normalized_symbol)

        if inferred_symbols:
            sanitized_catalog = [sanitize_stablecoin_catalog_entry({"symbol": symbol}) for symbol in inferred_symbols]
            sanitized_catalog = [entry for entry in sanitized_catalog if entry]
            catalog_symbols = [entry["symbol"] for entry in sanitized_catalog]

    sanitized_rows = []

    for index, row in enumerate(rows):
        stablecoin_symbol = normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))
        movement_type = str(row.get("tipo", "Compra")).strip().capitalize()
        currency = str(row.get("currency", "USD")).strip().upper()

        if not stablecoin_symbol or (catalog_symbols and stablecoin_symbol not in catalog_symbols):
            stablecoin_symbol = sanitized_enabled_symbols[0] if sanitized_enabled_symbols else (catalog_symbols[0] if catalog_symbols else "")

        if movement_type not in {"Compra", "Gasto"}:
            movement_type = "Compra"

        if currency not in {"EUR", "USD"}:
            currency = "USD"

        sanitized_rows.append({
            "id": str(row.get("id", f"stablecoin-{index + 1}")).strip() or f"stablecoin-{index + 1}",
            "stablecoinSymbol": stablecoin_symbol,
            "fecha": str(row.get("fecha", "")).strip(),
            "tipo": movement_type,
            "cantidad": str(row.get("cantidad", "")).strip(),
            "precio": str(row.get("precio", "")).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": currency,
            "nota": str(row.get("nota", "")).strip()
        })

    payload = {
        "catalog": sanitized_catalog,
        "enabledSymbols": sanitized_enabled_symbols,
        "rows": sanitized_rows
    }
    writeStablecoinsFile(payload)
    return jsonify({"ok": True, "data": payload})


@app.route("/api/ventas", methods=["GET"])
def getVentas():
    default_year = "2026"
    years = migrate_legacy_ventas_if_needed(default_year)
    return jsonify({"years": years, "rows": read_all_ventas_rows()})


@app.route("/api/ventas", methods=["POST"])
def createVentasYear():
    requestData = request.get_json(silent=True) or {}
    year = normalize_year(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    migrate_legacy_ventas_if_needed(year)

    if read_ventas_year(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    payload = create_default_ventas_year(year)
    write_ventas_year(year, payload)
    return jsonify({"ok": True, "year": year, "data": payload}), 201


@app.route("/api/ventas/<year>", methods=["GET"])
def getVentasYear(year):
    migrate_legacy_ventas_if_needed(normalize_year(year) or "2026")
    data = read_ventas_year(year)

    if data is None:
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    return jsonify(data)


@app.route("/api/ventas/<year>", methods=["POST"])
def saveVentasYear(year):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitize_ventas_payload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    write_ventas_year(year, payload)
    return jsonify({"ok": True})


@app.route("/api/ventas/<year>", methods=["DELETE"])
def deleteVentasYear(year):
    normalized_year = normalize_year(year)

    if not normalized_year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not delete_ventas_year(normalized_year):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remaining_years = list_ventas_years()

    if not remaining_years:
        payload = create_default_ventas_year("2026")
        write_ventas_year("2026", payload)
        remaining_years = ["2026"]

    return jsonify({"ok": True, "years": remaining_years})


@app.route("/api/transacciones", methods=["GET"])
def getTransacciones():
    data = readTransaccionesFile()
    return jsonify(data)


@app.route("/api/transacciones", methods=["POST"])
def saveTransacciones():
    requestData = request.get_json(silent=True) or {}
    rows = requestData.get("rows", [])

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitizedRows = []

    for index, row in enumerate(rows):
        sanitizedRows.append({
            "id": str(row.get("id", f"transaccion-{index + 1}")).strip() or f"transaccion-{index + 1}",
            "assetId": str(row.get("assetId", "")).strip(),
            "assetName": str(row.get("assetName", "")).strip(),
            "fechaOperacion": str(row.get("fechaOperacion", "")).strip(),
            "total": str(row.get("total", "")).strip(),
            "comisionRed": str(row.get("comisionRed", "")).strip(),
            "walletTipo": str(row.get("walletTipo", "entre_wallet")).strip().lower() or "entre_wallet",
            "walletDestino": str(row.get("walletDestino", "")).strip(),
            "hashTransaccion": str(row.get("hashTransaccion", row.get("walletOrigen", ""))).strip(),
            "nota": str(row.get("nota", "")).strip()
        })

    writeTransaccionesFile({"rows": sanitizedRows})
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


@app.route("/api/gastos-tipos", methods=["GET"])
def getGastosTipos():
    return jsonify({"types": read_gastos_types()})


@app.route("/api/gastos-tipos", methods=["POST"])
def saveGastosTipos():
    requestData = request.get_json(silent=True) or {}
    types = sanitize_gastos_types(requestData.get("types", []))
    write_gastos_types(types)
    return jsonify({"ok": True, "types": types})


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
    writeAssetFile(assetId, payload)

    return jsonify({"ok": True, "asset": payload}), 201


@app.route("/api/activos/<assetId>", methods=["GET"])
def getActivo(assetId):
    data = readAssetFile(assetId)

    if data is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    if not isinstance(data.get("operationRows"), list):
        operaciones_data = readOperacionesFile() or {}
        sync_completed_operations_into_assets(operaciones_data.get("rows", []))
        data = readAssetFile(assetId) or data

    if not isinstance(data.get("operationRows"), list):
        data["operationRows"] = []

    return jsonify(data)


@app.route("/api/activos/<assetId>", methods=["POST"])
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


@app.route("/api/activos/<assetId>/refresh-market-data", methods=["POST"])
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
        return jsonify({"ok": False, "error": "La moneda separada del precio ya no se usa en criptos"}), 400

    if current_currency == target_currency:
        return jsonify({"ok": True, "asset": assetData, "converted": False})

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
    assetData["status"] = (
        f"Moneda de visualización convertida de {current_currency} a {target_currency}"
        if is_crypto
        else f"Activo convertido de {current_currency} a {target_currency}"
    )
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
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@app.route("/api/eodhd/search", methods=["GET"])
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
