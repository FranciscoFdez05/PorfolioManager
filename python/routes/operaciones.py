import re

from flask import Blueprint, jsonify, request

from core.validation import primerIdDuplicado
from stores import revisiones
from stores.app_data import readOperacionesFile, readStablecoinsFile, writeOperacionesFile, writeStablecoinsFile
from stores.helpers import syncCompletedOperationsIntoAssets

operacionesBp = Blueprint("operaciones", __name__)


def _sanitizeOperationCurrency(value):
    """Las divisas de las operaciones no se limitan a EUR/USD: la lista de fiat
    es configurable en ajustes y las de bolsa pueden ir en GBP, CHF o JPY."""
    code = str(value or "").strip().upper()
    return code if code.isalpha() and 2 <= len(code) <= 5 else "EUR"


def _normalizeStablecoinSymbol(value):
    return re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())


def _sanitizeStablecoinCatalogEntry(entry):
    entry = entry or {}
    marketSymbol = str(entry.get("marketSymbol", entry.get("symbol", ""))).strip().upper()
    displaySymbol = str(entry.get("displaySymbol", marketSymbol or entry.get("symbol", ""))).strip().upper()
    symbol = _normalizeStablecoinSymbol(entry.get("symbol", ""))

    if not symbol and displaySymbol:
        symbol = _normalizeStablecoinSymbol(displaySymbol.split("/")[0].split("_")[0].split("-")[0])

    if not symbol and marketSymbol:
        marketTail = marketSymbol.split(":").pop()
        symbol = _normalizeStablecoinSymbol(marketTail.split("/")[0].split("_")[0].split("-")[0])

    if not symbol:
        return None

    return {
        "symbol": symbol,
        "marketSymbol": marketSymbol or symbol,
        "displaySymbol": displaySymbol or symbol,
        "description": str(entry.get("description", "")).strip(),
        "provider": str(entry.get("provider", "FINNHUB")).strip().upper() or "FINNHUB"
    }


@operacionesBp.route("/api/operaciones", methods=["GET"])
def getOperaciones():
    data = readOperacionesFile()
    syncCompletedOperationsIntoAssets(data.get("rows", []))
    return jsonify({**data, "revision": revisiones.actual("operaciones", revisiones.CLAVE_UNICA)})


@operacionesBp.route("/api/operaciones", methods=["POST"])
def saveOperaciones():
    requestData = request.get_json(silent=True) or {}
    if "rows" not in requestData:
        return jsonify({"ok": False, "error": "JSON inválido: falta rows"}), 400
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

        currency = _sanitizeOperationCurrency(row.get("currency", "EUR"))
        precioCurrency = _sanitizeOperationCurrency(row.get("precioCurrency", "EUR"))

        sanitizedRows.append({
            "id": str(row.get("id", f"operacion-{index + 1}")).strip() or f"operacion-{index + 1}",
            "assetId": str(row.get("assetId", "")).strip(),
            "activo": str(row.get("activo", "")).strip(),
            "fechaApertura": str(row.get("fechaApertura", row.get("fecha", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "stablecoinSymbol": str(row.get("stablecoinSymbol", "")).strip().upper(),
            "orden": orden,
            "precioOrden": str(row.get("precioOrden", row.get("precio", ""))).strip(),
            "precioCurrency": precioCurrency,
            "cantidad": str(row.get("cantidad", "")).strip(),
            "comisionesCripto": str(row.get("comisionesCripto", row.get("comisiones", ""))).strip(),
            "comisionesFiat": str(row.get("comisionesFiat", "")).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": currency,
            "estado": estado,
            "fechaCierre": str(row.get("fechaCierre", "")).strip()
        })

    duplicado = primerIdDuplicado(sanitizedRows)
    if duplicado is not None:
        return jsonify({"ok": False, "error": f"Hay dos operaciones con el mismo identificador ({duplicado})"}), 400

    try:
        esperada = revisiones.revisionDePeticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        nueva = writeOperacionesFile({"rows": sanitizedRows}, revisionEsperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return revisiones.respuestaConflicto(conflicto, "Las operaciones han cambiado desde otro sitio (otra pestaña u otro dispositivo)")
    syncCompletedOperationsIntoAssets(sanitizedRows)
    return jsonify({"ok": True, "revision": nueva})


@operacionesBp.route("/api/stablecoins", methods=["GET"])
def getStablecoins():
    data = readStablecoinsFile() or {}
    catalog = data.get("catalog", [])
    enabledSymbols = data.get("enabledSymbols", [])
    rows = data.get("rows", [])

    if not isinstance(catalog, list):
        catalog = []

    if not isinstance(enabledSymbols, list):
        enabledSymbols = []

    if not isinstance(rows, list):
        rows = []

    migratedSymbols = []

    for symbol in enabledSymbols:
        normalizedSymbol = _normalizeStablecoinSymbol(symbol)

        if normalizedSymbol and normalizedSymbol not in migratedSymbols:
            migratedSymbols.append(normalizedSymbol)

    for row in rows:
        normalizedSymbol = _normalizeStablecoinSymbol(row.get("stablecoinSymbol", ""))

        if normalizedSymbol and normalizedSymbol not in migratedSymbols:
            migratedSymbols.append(normalizedSymbol)

    if not catalog and migratedSymbols:
        catalog = [_sanitizeStablecoinCatalogEntry({"symbol": symbol}) for symbol in migratedSymbols]
        catalog = [entry for entry in catalog if entry]
        data = {
            "catalog": catalog,
            "enabledSymbols": enabledSymbols or migratedSymbols,
            "rows": rows
        }
        writeStablecoinsFile(data)
        enabledSymbols = data["enabledSymbols"]

    return jsonify({
        "catalog": catalog, "enabledSymbols": enabledSymbols, "rows": rows,
        "revision": revisiones.actual("stablecoins", revisiones.CLAVE_UNICA),
    })


def _catalogoDeSimbolos(simbolos):
    catalogo = [_sanitizeStablecoinCatalogEntry({"symbol": s}) for s in simbolos]
    return [entrada for entrada in catalogo if entrada]


def _catalogoSaneado(catalog):
    """Entradas del catálogo normalizadas y sin símbolos repetidos."""
    saneado, simbolos = [], []
    for entry in catalog:
        normalizada = _sanitizeStablecoinCatalogEntry(entry if isinstance(entry, dict) else {"symbol": entry})
        if normalizada and normalizada["symbol"] not in simbolos:
            simbolos.append(normalizada["symbol"])
            saneado.append(normalizada)
    return saneado


def _activadosSaneados(enabledSymbols, simbolosCatalogo):
    """Símbolos activados, normalizados, sin repetir y presentes en el catálogo (si lo hay)."""
    activados = []
    for symbol in enabledSymbols:
        normalizado = _normalizeStablecoinSymbol(symbol)
        if not normalizado or (simbolosCatalogo and normalizado not in simbolosCatalogo):
            continue
        if normalizado not in activados:
            activados.append(normalizado)
    return activados


def _simbolosDeFilas(rows):
    simbolos = []
    for row in rows:
        normalizado = _normalizeStablecoinSymbol(row.get("stablecoinSymbol", ""))
        if normalizado and normalizado not in simbolos:
            simbolos.append(normalizado)
    return simbolos


def _filaStablecoin(index, row, activados, simbolosCatalogo):
    stablecoinSymbol = _normalizeStablecoinSymbol(row.get("stablecoinSymbol", ""))
    if not stablecoinSymbol or (simbolosCatalogo and stablecoinSymbol not in simbolosCatalogo):
        stablecoinSymbol = activados[0] if activados else (simbolosCatalogo[0] if simbolosCatalogo else "")

    movementType = str(row.get("tipo", "Compra")).strip().capitalize()
    if movementType == "Gasto":
        movementType = "Venta"
    if movementType not in {"Compra", "Venta"}:
        movementType = "Compra"

    currency = str(row.get("currency", "USD")).strip().upper()
    if currency not in {"EUR", "USD"}:
        currency = "USD"

    idPorDefecto = f"stablecoin-{index + 1}"
    return {
        "id": str(row.get("id", idPorDefecto)).strip() or idPorDefecto,
        "stablecoinSymbol": stablecoinSymbol,
        "fecha": str(row.get("fecha", "")).strip(),
        "tipo": movementType,
        "cantidad": str(row.get("cantidad", "")).strip(),
        "precio": str(row.get("precio", "")).strip(),
        "total": str(row.get("total", "")).strip(),
        "comisiones": str(row.get("comisiones", "")).strip(),
        "currency": currency,
        "nota": str(row.get("nota", "")).strip(),
    }


@operacionesBp.route("/api/stablecoins", methods=["POST"])
def saveStablecoins():
    requestData = request.get_json(silent=True) or {}
    if not {"rows", "catalog", "availableSymbols", "enabledSymbols"} & set(requestData):
        return jsonify({"ok": False, "error": "JSON inválido: faltan los datos de stablecoins"}), 400
    catalog =requestData.get("catalog", requestData.get("availableSymbols", []))
    enabledSymbols = requestData.get("enabledSymbols", [])
    # Un guardado sin `rows` (solo el catálogo, por ejemplo) no las toca: usar []
    # las borraba todas.
    rows = requestData["rows"] if "rows" in requestData else readStablecoinsFile().get("rows", [])

    if not isinstance(catalog, list):
        return jsonify({"ok": False, "error": "catalog debe ser una lista"}), 400

    if not isinstance(enabledSymbols, list):
        return jsonify({"ok": False, "error": "enabledSymbols debe ser una lista"}), 400

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400
    if not all(isinstance(row, dict) for row in rows):
        # Una fila que no es un objeto llegaba a row.get(...) y daba un 500.
        return jsonify({"ok": False, "error": "Cada fila debe ser un objeto"}), 400

    sanitizedCatalog = _catalogoSaneado(catalog)
    activados = _activadosSaneados(enabledSymbols, [e["symbol"] for e in sanitizedCatalog])

    # Sin catálogo, se deduce: primero de los símbolos activados y, si tampoco
    # hay, de los que aparecen en las filas.
    if not sanitizedCatalog:
        sanitizedCatalog = _catalogoDeSimbolos(activados or _simbolosDeFilas(rows))
    catalogSymbols = [entry["symbol"] for entry in sanitizedCatalog]

    payload = {
        "catalog": sanitizedCatalog,
        "enabledSymbols": activados,
        "rows": [_filaStablecoin(i, row, activados, catalogSymbols) for i, row in enumerate(rows)],
    }
    duplicado = primerIdDuplicado(payload["rows"])
    if duplicado is not None:
        return jsonify({"ok": False, "error": f"Hay dos movimientos con el mismo identificador ({duplicado})"}), 400

    try:
        esperada = revisiones.revisionDePeticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        nueva = writeStablecoinsFile(payload, revisionEsperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return revisiones.respuestaConflicto(conflicto, "Las stablecoins han cambiado desde otro sitio (otra pestaña u otro dispositivo)")
    return jsonify({"ok": True, "data": payload, "revision": nueva})
