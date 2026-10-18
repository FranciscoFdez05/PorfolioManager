from datetime import date

from flask import Blueprint, jsonify, request

from stores import revisiones
from stores.gastos_store import (
    createDefaultGastosYear,
    deleteGastosYear as borrarAnioGastos,
    listGastosYears,
    normalizeYear,
    readGastosTypes,
    readGastosYear,
    sanitizeGastosPayload,
    sanitizeGastosTypes,
    writeGastosTypes,
    writeGastosYear,
)

gastosBp = Blueprint("gastos", __name__)


@gastosBp.route("/api/gastos", methods=["GET"])
def getGastosYears():
    years = listGastosYears()

    if not years:
        defaultYear = str(date.today().year)
        payload = createDefaultGastosYear(defaultYear)
        writeGastosYear(defaultYear, payload)
        years = [defaultYear]

    return jsonify({"years": years})


@gastosBp.route("/api/gastos-tipos", methods=["GET"])
def getGastosTipos():
    return jsonify({"types": readGastosTypes()})


@gastosBp.route("/api/gastos-tipos", methods=["POST"])
def saveGastosTipos():
    requestData = request.get_json(silent=True) or {}
    types = sanitizeGastosTypes(requestData.get("types", []))
    writeGastosTypes(types)
    return jsonify({"ok": True, "types": types})


@gastosBp.route("/api/gastos", methods=["POST"])
def createGastosYear():
    requestData = request.get_json(silent=True) or {}
    year = normalizeYear(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if readGastosYear(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    payload = createDefaultGastosYear(year)
    writeGastosYear(year, payload)
    return jsonify({"ok": True, "year": year, "data": payload}), 201


@gastosBp.route("/api/gastos/<year>", methods=["GET"])
def getGastosYear(year):
    data = readGastosYear(year)

    if data is None:
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    return jsonify(data)


@gastosBp.route("/api/gastos/<year>", methods=["POST"])
def saveGastosYear(year):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitizeGastosPayload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    try:
        esperada = revisiones.revisionDePeticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        nueva = writeGastosYear(year, payload, revisionEsperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return jsonify({
            "ok": False, "conflicto": True, "revision": conflicto.actual,
            "error": "Este año ha cambiado desde otro sitio (otra pestaña, otro dispositivo o el Atajo)",
        }), 409
    return jsonify({"ok": True, "revision": nueva})


@gastosBp.route("/api/gastos/<year>", methods=["DELETE"])
def deleteGastosYear(year):
    normalizedYear = normalizeYear(year)

    if not normalizedYear:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not borrarAnioGastos(normalizedYear):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remainingYears = listGastosYears()

    if not remainingYears:
        actual = str(date.today().year)
        writeGastosYear(actual, createDefaultGastosYear(actual))
        remainingYears = [actual]

    return jsonify({"ok": True, "years": remainingYears})
