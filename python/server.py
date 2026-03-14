from pathlib import Path
import json
import re

from flask import Flask, jsonify, request, send_from_directory

app = Flask(
    __name__,
    static_folder="../",
    static_url_path=""
)

baseDir = Path(__file__).resolve().parent.parent
dataDir = baseDir / "data"
activosDir = dataDir / "activos"
interesesFile = dataDir / "intereses.json"
dividendosFile = dataDir / "dividendos.json"

ALLOWED_ASSET_TYPES = {"cripto", "acciones", "etfs", "comoditis"}


def slugify(value):
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", str(value).strip().lower())
    normalized = normalized.strip("-")
    return normalized or "activo"


def createAssetSymbol(name):
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(name).upper())
    return cleaned[:10] or "ACTIVO"


def sanitizeAssetType(assetType):
    normalized = slugify(assetType).replace("-", "")

    if normalized not in ALLOWED_ASSET_TYPES:
        return None

    return normalized


def createDefaultAssetPayload(name, assetType, assetId=None):
    return {
        "id": assetId or slugify(name),
        "name": str(name).strip(),
        "symbol": createAssetSymbol(name),
        "type": assetType,
        "order": 0,
        "price": "0,00",
        "currency": "USD",
        "change": "+0,00%",
        "status": "Mercado abierto",
        "rows": [
            {
                "fechaOperacion": "",
                "tipoOperacion": "Compra",
                "participaciones": "",
                "precioParticipacion": "",
                "capitalInvertidoBruto": "",
                "comisiones": ""
            }
        ]
    }


def sanitizeAssetRows(rows):
    sanitizedRows = []

    for row in rows:
        sanitizedRows.append({
            "fechaOperacion": str(row.get("fechaOperacion", "")).strip(),
            "tipoOperacion": str(row.get("tipoOperacion", "")).strip(),
            "participaciones": str(row.get("participaciones", "")).strip(),
            "precioParticipacion": str(row.get("precioParticipacion", "")).strip(),
            "capitalInvertidoBruto": str(row.get("capitalInvertidoBruto", "")).strip(),
            "comisiones": str(row.get("comisiones", "")).strip()
        })

    return sanitizedRows


def sanitizeAssetPayload(requestData, fallbackAssetId=None):
    assetName = str(requestData.get("name", "")).strip()
    assetType = sanitizeAssetType(requestData.get("type", ""))

    if not assetName:
        return None, "El nombre del activo es obligatorio"

    if not assetType:
        return None, "Tipo de activo inválido"

    assetId = fallbackAssetId or slugify(requestData.get("id") or assetName)
    rows = requestData.get("rows", [])

    if not isinstance(rows, list):
        return None, "rows debe ser una lista"

    payload = {
        "id": assetId,
        "name": assetName,
        "symbol": str(requestData.get("symbol") or createAssetSymbol(assetName)).strip() or createAssetSymbol(assetName),
        "type": assetType,
        "order": int(requestData.get("order", 0) or 0),
        "price": str(requestData.get("price", "0,00")).strip(),
        "currency": str(requestData.get("currency", "USD")).strip() or "USD",
        "change": str(requestData.get("change", "+0,00%")).strip() or "+0,00%",
        "status": str(requestData.get("status", "Mercado abierto")).strip() or "Mercado abierto",
        "rows": sanitizeAssetRows(rows)
    }

    return payload, None


def getAssetFile(assetId):
    safeAssetId = slugify(assetId)
    return activosDir / f"{safeAssetId}.json"


def ensureDataFile():
    dataDir.mkdir(parents=True, exist_ok=True)
    activosDir.mkdir(parents=True, exist_ok=True)

    if not interesesFile.exists():
        with interesesFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)

    if not dividendosFile.exists():
        with dividendosFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)


def readInteresesFile():
    ensureDataFile()

    with interesesFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeInteresesFile(data):
    ensureDataFile()

    with interesesFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readDividendosFile():
    ensureDataFile()

    with dividendosFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeDividendosFile(data):
    ensureDataFile()

    with dividendosFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readAssetFile(assetId):
    ensureDataFile()
    assetFile = getAssetFile(assetId)

    if not assetFile.exists():
        return None

    with assetFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeAssetFile(assetId, data):
    dataDir.mkdir(parents=True, exist_ok=True)
    activosDir.mkdir(parents=True, exist_ok=True)
    assetFile = getAssetFile(assetId)

    with assetFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def listAssets():
    ensureDataFile()
    assets = []

    for index, assetFile in enumerate(sorted(activosDir.glob("*.json"))):
        with assetFile.open("r", encoding="utf-8") as file:
            data = json.load(file)

        assets.append({
            "id": data.get("id", assetFile.stem),
            "name": data.get("name", assetFile.stem),
            "symbol": data.get("symbol", assetFile.stem.upper()),
            "type": data.get("type", ""),
            "order": data.get("order", index),
            "price": data.get("price", "0,00"),
            "currency": data.get("currency", "USD"),
            "change": data.get("change", "+0,00%"),
            "status": data.get("status", "Mercado abierto")
        })

    return sorted(assets, key=lambda asset: (asset.get("order", 0), asset.get("symbol", "")))


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
    assetId = slugify(requestData.get("assetId", ""))
    direction = str(requestData.get("direction", "")).strip().lower()

    if not assetId:
        return jsonify({"ok": False, "error": "assetId es obligatorio"}), 400

    if direction not in {"up", "down"}:
        return jsonify({"ok": False, "error": "direction inválida"}), 400

    assets = listAssets()
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
