from pathlib import Path
import json

from flask import Flask, jsonify, request, send_from_directory

app = Flask(
    __name__,
    static_folder="../",
    static_url_path=""
)

baseDir = Path(__file__).resolve().parent.parent
dataDir = baseDir / "data"
interesesFile = dataDir / "intereses.json"


def ensureDataFile():
    dataDir.mkdir(parents=True, exist_ok=True)

    if not interesesFile.exists():
        with interesesFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)


def readInteresesFile():
    ensureDataFile()

    with interesesFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeInteresesFile(data):
    ensureDataFile()

    with interesesFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


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


@app.route("/<path:path>")
def serveStatic(path):
    return send_from_directory(baseDir, path)


if __name__ == "__main__":
    ensureDataFile()
    app.run(host="127.0.0.1", port=5000, debug=True)