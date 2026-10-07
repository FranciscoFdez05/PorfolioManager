from datetime import date

from flask import Blueprint, jsonify, request

from stores import revisiones
from stores.gastos_store import (
    create_default_gastos_year,
    delete_gastos_year,
    list_gastos_years,
    normalize_year,
    read_gastos_types,
    read_gastos_year,
    sanitize_gastos_payload,
    sanitize_gastos_types,
    write_gastos_types,
    write_gastos_year,
)

gastos_bp = Blueprint("gastos", __name__)


@gastos_bp.route("/api/gastos", methods=["GET"])
def getGastosYears():
    years = list_gastos_years()

    if not years:
        default_year = str(date.today().year)
        payload = create_default_gastos_year(default_year)
        write_gastos_year(default_year, payload)
        years = [default_year]

    return jsonify({"years": years})


@gastos_bp.route("/api/gastos-tipos", methods=["GET"])
def getGastosTipos():
    return jsonify({"types": read_gastos_types()})


@gastos_bp.route("/api/gastos-tipos", methods=["POST"])
def saveGastosTipos():
    requestData = request.get_json(silent=True) or {}
    types = sanitize_gastos_types(requestData.get("types", []))
    write_gastos_types(types)
    return jsonify({"ok": True, "types": types})


@gastos_bp.route("/api/gastos", methods=["POST"])
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


@gastos_bp.route("/api/gastos/<year>", methods=["GET"])
def getGastosYear(year):
    data = read_gastos_year(year)

    if data is None:
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    return jsonify(data)


@gastos_bp.route("/api/gastos/<year>", methods=["POST"])
def saveGastosYear(year):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitize_gastos_payload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    try:
        esperada = revisiones.revision_de_peticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        nueva = write_gastos_year(year, payload, revision_esperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return jsonify({
            "ok": False, "conflicto": True, "revision": conflicto.actual,
            "error": "Este año ha cambiado desde otro sitio (otra pestaña, otro dispositivo o el Atajo)",
        }), 409
    return jsonify({"ok": True, "revision": nueva})


@gastos_bp.route("/api/gastos/<year>", methods=["DELETE"])
def deleteGastosYear(year):
    normalized_year = normalize_year(year)

    if not normalized_year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not delete_gastos_year(normalized_year):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remaining_years = list_gastos_years()

    if not remaining_years:
        actual = str(date.today().year)
        write_gastos_year(actual, create_default_gastos_year(actual))
        remaining_years = [actual]

    return jsonify({"ok": True, "years": remaining_years})
