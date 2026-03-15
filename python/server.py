from flask import Flask, jsonify, request, send_from_directory

from app_data import baseDir, ensureDataFile, readDividendosFile, readInteresesFile, writeDividendosFile, writeInteresesFile
from asset_store import getAssetFile, listAssets, readAssetFile, writeAssetFile
from asset_utils import createDefaultAssetPayload, sanitizeAssetPayload, sanitizeAssetType, slugify
from gastos_store import create_default_gastos_year, delete_gastos_year, list_gastos_years, normalize_year, read_gastos_year, sanitize_gastos_payload, write_gastos_year

app = Flask(
    __name__,
    static_folder="../",
    static_url_path=""
)


@app.route("/")
def serveIndex():
    return send_from_directory(baseDir, "index.html")


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

    if not assetName:
        return jsonify({"ok": False, "error": "El nombre del activo es obligatorio"}), 400

    if not assetType:
        return jsonify({"ok": False, "error": "Tipo de activo inválido"}), 400

    assetId = slugify(assetName)
    assetFile = getAssetFile(assetId)

    if assetFile.exists():
        return jsonify({"ok": False, "error": "Ya existe un activo con ese nombre"}), 409

    payload = createDefaultAssetPayload(assetName, assetType, assetId)
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
