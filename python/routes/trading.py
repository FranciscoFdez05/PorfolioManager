from flask import Blueprint, jsonify, request

from core.validation import primerIdDuplicado
from stores import revisiones
from stores.app_data import readTradingFile, writeTradingFile

tradingBp = Blueprint("trading", __name__)

_TIPO_OPTIONS = {"SCALP", "SWING"}
_DIRECCION_OPTIONS = {"LONG", "SHORT"}
_RESULTADO_OPTIONS = {"PROFIT", "PÉRDIDA"}


@tradingBp.route("/api/trading", methods=["GET"])
def getTrading():
    return jsonify({**readTradingFile(), "revision": revisiones.actual("trading", revisiones.CLAVE_UNICA)})


@tradingBp.route("/api/trading", methods=["POST"])
def saveTrading():
    requestData = request.get_json(silent=True) or {}
    if "rows" not in requestData:
        return jsonify({"ok": False, "error": "JSON inválido: falta rows"}), 400
    rows = requestData.get("rows", [])

    if not isinstance(rows, list):
        return jsonify({"ok": False, "error": "rows debe ser una lista"}), 400
    if not all(isinstance(row, dict) for row in rows):
        # Una fila que no es un objeto llegaba a row.get(...) y daba un 500.
        return jsonify({"ok": False, "error": "Cada fila debe ser un objeto"}), 400

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

    duplicado = primerIdDuplicado(sanitized)
    if duplicado is not None:
        return jsonify({"ok": False, "error": f"Hay dos trades con el mismo identificador ({duplicado})"}), 400

    try:
        esperada = revisiones.revisionDePeticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        nueva = writeTradingFile({"rows": sanitized}, revisionEsperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return revisiones.respuestaConflicto(conflicto, "Los trades han cambiado desde otro sitio (otra pestaña u otro dispositivo)")
    return jsonify({"ok": True, "revision": nueva})
