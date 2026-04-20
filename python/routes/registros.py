from flask import Blueprint, jsonify, request

from app_data import (
    readBonosFile, readDividendoCalendar, readDividendosFile, readInteresesFile, readRentaFijaFile, readTransaccionesFile,
    writeBonosFile, writeDividendoCalendar, writeDividendosFile, writeInteresesFile, writeRentaFijaFile, writeTransaccionesFile,
)

registros_bp = Blueprint("registros", __name__)


@registros_bp.route("/api/intereses", methods=["GET"])
def getIntereses():
    return jsonify(readInteresesFile())


@registros_bp.route("/api/intereses", methods=["POST"])
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


@registros_bp.route("/api/intereses/reset", methods=["POST"])
def resetIntereses():
    writeInteresesFile({"rows": []})
    return jsonify({"ok": True})


@registros_bp.route("/api/dividendos", methods=["GET"])
def getDividendos():
    return jsonify(readDividendosFile())


@registros_bp.route("/api/dividendos", methods=["POST"])
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


@registros_bp.route("/api/dividendos/reset", methods=["POST"])
def resetDividendos():
    writeDividendosFile({"rows": []})
    return jsonify({"ok": True})


@registros_bp.route("/api/dividendos/calendar", methods=["GET"])
def getDividendoCalendar():
    return jsonify(readDividendoCalendar())


@registros_bp.route("/api/dividendos/calendar", methods=["POST"])
def saveDividendoCalendar():
    requestData = request.get_json(silent=True) or {}
    if "calendar" not in requestData or not isinstance(requestData["calendar"], dict):
        return jsonify({"ok": False, "error": "JSON inválido"}), 400
    writeDividendoCalendar(requestData)
    return jsonify({"ok": True})


@registros_bp.route("/api/transacciones", methods=["GET"])
def getTransacciones():
    return jsonify(readTransaccionesFile())


@registros_bp.route("/api/transacciones", methods=["POST"])
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


@registros_bp.route("/api/bonos", methods=["GET"])
def getBonos():
    return jsonify(readBonosFile())


@registros_bp.route("/api/bonos", methods=["POST"])
def saveBonos():
    requestData = request.get_json(silent=True)

    if not requestData or "rows" not in requestData:
        return jsonify({"ok": False, "error": "JSON inválido"}), 400

    rows = requestData["rows"]

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitizedRows = []

    for row in rows:
        tipo = str(row.get("tipo", "gubernamental")).strip().lower()
        if tipo not in ("gubernamental", "corporativo"):
            tipo = "gubernamental"
        sanitizedRows.append({
            "fecha": str(row.get("fecha", "")).strip(),
            "tipo": tipo,
            "instrumento": str(row.get("instrumento", "")).strip(),
            "cupon": str(row.get("cupon", "")).strip(),
            "vencimiento": str(row.get("vencimiento", "")).strip(),
            "invertido": str(row.get("invertido", "")).strip(),
            "interesAcumulado": str(row.get("interesAcumulado", "")).strip(),
            "impuestos": str(row.get("impuestos", "")).strip(),
            "nota": str(row.get("nota", "")).strip(),
        })

    writeBonosFile({"rows": sanitizedRows})
    return jsonify({"ok": True})


@registros_bp.route("/api/rentafija", methods=["GET"])
def getRentaFija():
    return jsonify(readRentaFijaFile())


@registros_bp.route("/api/rentafija", methods=["POST"])
def saveRentaFija():
    requestData = request.get_json(silent=True)

    if not requestData or "rows" not in requestData:
        return jsonify({"ok": False, "error": "JSON inválido"}), 400

    rows = requestData["rows"]

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitizedRows = []

    for row in rows:
        tipo = str(row.get("tipo", "bancario")).strip().lower()
        if tipo not in ("bancario", "estatal"):
            tipo = "bancario"
        sanitizedRows.append({
            "fecha": str(row.get("fecha", "")).strip(),
            "tipo": tipo,
            "instrumento": str(row.get("instrumento", "")).strip(),
            "rentabilidad": str(row.get("rentabilidad", "")).strip(),
            "vencimiento": str(row.get("vencimiento", "")).strip(),
            "invertido": str(row.get("invertido", "")).strip(),
            "interesAcumulado": str(row.get("interesAcumulado", "")).strip(),
            "impuestos": str(row.get("impuestos", "")).strip(),
        })

    writeRentaFijaFile({"rows": sanitizedRows})
    return jsonify({"ok": True})
