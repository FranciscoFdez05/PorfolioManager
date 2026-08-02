from flask import Blueprint, jsonify, request

from stores.app_data import readTradingFile, writeTradingFile

trading_bp = Blueprint("trading", __name__)

_TIPO_OPTIONS = {"SCALP", "SWING"}
_DIRECCION_OPTIONS = {"LONG", "SHORT"}
_RESULTADO_OPTIONS = {"PROFIT", "PÉRDIDA"}


@trading_bp.route("/api/trading", methods=["GET"])
def getTrading():
    return jsonify(readTradingFile())


@trading_bp.route("/api/trading", methods=["POST"])
def saveTrading():
    requestData = request.get_json(silent=True) or {}
    rows = requestData.get("rows", [])

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400

    sanitized = []
    for index, row in enumerate(rows):
        tipo = str(row.get("tipo", "SCALP")).strip().upper()
        if tipo not in _TIPO_OPTIONS:
            tipo = "SCALP"

        direccion = str(row.get("direccion", "LONG")).strip().upper()
        if direccion not in _DIRECCION_OPTIONS:
            direccion = "LONG"

        resultado = str(row.get("resultado", "PROFIT")).strip().upper()
        if resultado == "PERDIDA":
            resultado = "PÉRDIDA"
        if resultado not in _RESULTADO_OPTIONS:
            resultado = "PROFIT"

        sanitized.append({
            "id": str(row.get("id", f"trade-{index + 1}")).strip() or f"trade-{index + 1}",
            "fecha": str(row.get("fecha", "")).strip(),
            "tipo": tipo,
            "moneda": str(row.get("moneda", "")).strip().upper(),
            "direccion": direccion,
            "resultado": resultado,
            "capital": str(row.get("capital", "")).strip(),
            "capital_currency": str(row.get("capital_currency", "EUR")).strip().upper() or "EUR",
            "roi": str(row.get("roi", "")).strip(),
            "ganancia": str(row.get("ganancia", "")).strip(),
            "ganancia_neta": str(row.get("ganancia_neta", "")).strip(),
        })

    writeTradingFile({"rows": sanitized})
    return jsonify({"ok": True})
