import re

from flask import Blueprint, jsonify, request

from stores.app_data import readOperacionesFile, readStablecoinsFile, writeOperacionesFile, writeStablecoinsFile
from stores.helpers import sync_completed_operations_into_assets

operaciones_bp = Blueprint("operaciones", __name__)


def _sanitize_operation_currency(value):
    """Las divisas de las operaciones no se limitan a EUR/USD: la lista de fiat
    es configurable en ajustes y las de bolsa pueden ir en GBP, CHF o JPY."""
    code = str(value or "").strip().upper()
    return code if code.isalpha() and 2 <= len(code) <= 5 else "EUR"


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
    if not all(isinstance(row, dict) for row in rows):
        # Una fila que no es un objeto llegaba a row.get(...) y daba un 500.
        return jsonify({"ok": False, "error": "Cada fila debe ser un objeto"}), 400

    sanitizedRows = []

    for index, row in enumerate(rows):
        orden = str(row.get("orden", "Compra")).strip().capitalize()
        estado = str(row.get("estado", "Activo")).strip().capitalize()

        if orden not in {"Compra", "Venta"}:
            orden = "Compra"

        if estado not in {"Activo", "Cerrado", "Completado", "Cancelado"}:
            estado = "Activo"

        currency = _sanitize_operation_currency(row.get("currency", "EUR"))
        precio_currency = _sanitize_operation_currency(row.get("precioCurrency", "EUR"))

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
            "comisionesFiat": str(row.get("comisionesFiat", "")).strip(),
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


def _catalogo_de_simbolos(simbolos):
    catalogo = [_sanitize_stablecoin_catalog_entry({"symbol": s}) for s in simbolos]
    return [entrada for entrada in catalogo if entrada]


def _catalogo_saneado(catalog):
    """Entradas del catálogo normalizadas y sin símbolos repetidos."""
    saneado, simbolos = [], []
    for entry in catalog:
        normalizada = _sanitize_stablecoin_catalog_entry(entry if isinstance(entry, dict) else {"symbol": entry})
        if normalizada and normalizada["symbol"] not in simbolos:
            simbolos.append(normalizada["symbol"])
            saneado.append(normalizada)
    return saneado


def _activados_saneados(enabled_symbols, simbolos_catalogo):
    """Símbolos activados, normalizados, sin repetir y presentes en el catálogo (si lo hay)."""
    activados = []
    for symbol in enabled_symbols:
        normalizado = _normalize_stablecoin_symbol(symbol)
        if not normalizado or (simbolos_catalogo and normalizado not in simbolos_catalogo):
            continue
        if normalizado not in activados:
            activados.append(normalizado)
    return activados


def _simbolos_de_filas(rows):
    simbolos = []
    for row in rows:
        normalizado = _normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))
        if normalizado and normalizado not in simbolos:
            simbolos.append(normalizado)
    return simbolos


def _fila_stablecoin(index, row, activados, simbolos_catalogo):
    stablecoin_symbol = _normalize_stablecoin_symbol(row.get("stablecoinSymbol", ""))
    if not stablecoin_symbol or (simbolos_catalogo and stablecoin_symbol not in simbolos_catalogo):
        stablecoin_symbol = activados[0] if activados else (simbolos_catalogo[0] if simbolos_catalogo else "")

    movement_type = str(row.get("tipo", "Compra")).strip().capitalize()
    if movement_type == "Gasto":
        movement_type = "Venta"
    if movement_type not in {"Compra", "Venta"}:
        movement_type = "Compra"

    currency = str(row.get("currency", "USD")).strip().upper()
    if currency not in {"EUR", "USD"}:
        currency = "USD"

    id_por_defecto = f"stablecoin-{index + 1}"
    return {
        "id": str(row.get("id", id_por_defecto)).strip() or id_por_defecto,
        "stablecoinSymbol": stablecoin_symbol,
        "fecha": str(row.get("fecha", "")).strip(),
        "tipo": movement_type,
        "cantidad": str(row.get("cantidad", "")).strip(),
        "precio": str(row.get("precio", "")).strip(),
        "total": str(row.get("total", "")).strip(),
        "comisiones": str(row.get("comisiones", "")).strip(),
        "currency": currency,
        "nota": str(row.get("nota", "")).strip(),
    }


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
    if not all(isinstance(row, dict) for row in rows):
        # Una fila que no es un objeto llegaba a row.get(...) y daba un 500.
        return jsonify({"ok": False, "error": "Cada fila debe ser un objeto"}), 400

    sanitized_catalog = _catalogo_saneado(catalog)
    activados = _activados_saneados(enabled_symbols, [e["symbol"] for e in sanitized_catalog])

    # Sin catálogo, se deduce: primero de los símbolos activados y, si tampoco
    # hay, de los que aparecen en las filas.
    if not sanitized_catalog:
        sanitized_catalog = _catalogo_de_simbolos(activados or _simbolos_de_filas(rows))
    catalog_symbols = [entry["symbol"] for entry in sanitized_catalog]

    payload = {
        "catalog": sanitized_catalog,
        "enabledSymbols": activados,
        "rows": [_fila_stablecoin(i, row, activados, catalog_symbols) for i, row in enumerate(rows)],
    }
    writeStablecoinsFile(payload)
    return jsonify({"ok": True, "data": payload})
