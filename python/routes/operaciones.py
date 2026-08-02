import re

from flask import Blueprint, jsonify, request

from stores.app_data import readOperacionesFile, readStablecoinsFile, writeOperacionesFile, writeStablecoinsFile
from stores.helpers import sync_completed_operations_into_assets

operaciones_bp = Blueprint("operaciones", __name__)


def _normalize_stablecoin_symbol(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())


def _sanitize_stablecoin_catalog_entry(entry):
    entry = entry or {}
    market_symbol = str(entry.get("marketSymbol", entry.get("symbol", ""))).strip().upper()
    display_symbol = str(entry.get("displaySymbol", market_symbol or entry.get("symbol", ""))).strip().upper()
    symbol = _normalize_stablecoin_symbol(entry.get("symbol", ""))

    if not symbol and display_symbol:
        symbol = _normalize_stablecoin_symbol(display_symbol.split("/")[0].split("_")[0].split("-")[0])

    if not symbol and market_symbol:
        market_tail = market_symbol.split(":").pop()
        symbol = _normalize_stablecoin_symbol(market_tail.split("/")[0].split("_")[0].split("-")[0])

    if not symbol:
        return None

    return {
        "symbol": symbol,
        "marketSymbol": market_symbol or symbol,
        "displaySymbol": display_symbol or symbol,
        "description": str(entry.get("description", "")).strip(),
        "provider": str(entry.get("provider", "FINNHUB")).strip().upper() or "FINNHUB"
    }


@operaciones_bp.route("/api/operaciones", methods=["GET"])
def getOperaciones():
    data = readOperacionesFile()
    sync_completed_operations_into_assets(data.get("rows", []))
    return jsonify(data)


@operaciones_bp.route("/api/operaciones", methods=["POST"])
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

        if estado not in {"Activo", "Cerrado", "Completado", "Cancelado"}:
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


@operaciones_bp.route("/api/stablecoins", methods=["GET"])
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
        normalized_symbol = _normalize_stablecoin_symbol(symbol)

        if normalized_symbol and normalized_symbol not in migrated_symbols:
            migrated_symbols.append(normalized_symbol)

    for row in rows:
        normalized_symbol = _normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))

        if normalized_symbol and normalized_symbol not in migrated_symbols:
            migrated_symbols.append(normalized_symbol)

    if not catalog and migrated_symbols:
        catalog = [_sanitize_stablecoin_catalog_entry({"symbol": symbol}) for symbol in migrated_symbols]
        catalog = [entry for entry in catalog if entry]
        data = {
            "catalog": catalog,
            "enabledSymbols": enabled_symbols or migrated_symbols,
            "rows": rows
        }
        writeStablecoinsFile(data)
        enabled_symbols = data["enabledSymbols"]

    return jsonify({"catalog": catalog, "enabledSymbols": enabled_symbols, "rows": rows})


@operaciones_bp.route("/api/stablecoins", methods=["POST"])
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
        normalized_entry = _sanitize_stablecoin_catalog_entry(
            entry if isinstance(entry, dict) else {"symbol": entry}
        )

        if not normalized_entry or normalized_entry["symbol"] in catalog_symbols:
            continue

        catalog_symbols.append(normalized_entry["symbol"])
        sanitized_catalog.append(normalized_entry)

    sanitized_enabled_symbols = []

    for symbol in enabled_symbols:
        normalized_symbol = _normalize_stablecoin_symbol(symbol)

        if not normalized_symbol:
            continue

        if catalog_symbols and normalized_symbol not in catalog_symbols:
            continue

        if normalized_symbol not in sanitized_enabled_symbols:
            sanitized_enabled_symbols.append(normalized_symbol)

    if not sanitized_catalog and sanitized_enabled_symbols:
        sanitized_catalog = [_sanitize_stablecoin_catalog_entry({"symbol": s}) for s in sanitized_enabled_symbols]
        sanitized_catalog = [entry for entry in sanitized_catalog if entry]
        catalog_symbols = [entry["symbol"] for entry in sanitized_catalog]

    if not sanitized_catalog:
        inferred_symbols = []

        for row in rows:
            normalized_symbol = _normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))

            if normalized_symbol and normalized_symbol not in inferred_symbols:
                inferred_symbols.append(normalized_symbol)

        if inferred_symbols:
            sanitized_catalog = [_sanitize_stablecoin_catalog_entry({"symbol": s}) for s in inferred_symbols]
            sanitized_catalog = [entry for entry in sanitized_catalog if entry]
            catalog_symbols = [entry["symbol"] for entry in sanitized_catalog]

    sanitized_rows = []

    for index, row in enumerate(rows):
        stablecoin_symbol = _normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))
        movement_type = str(row.get("tipo", "Compra")).strip().capitalize()
        currency = str(row.get("currency", "USD")).strip().upper()

        if not stablecoin_symbol or (catalog_symbols and stablecoin_symbol not in catalog_symbols):
            stablecoin_symbol = (
                sanitized_enabled_symbols[0] if sanitized_enabled_symbols
                else (catalog_symbols[0] if catalog_symbols else "")
            )

        if movement_type == "Gasto":
            movement_type = "Venta"

        if movement_type not in {"Compra", "Venta"}:
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
            "comisiones": str(row.get("comisiones", "")).strip(),
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
