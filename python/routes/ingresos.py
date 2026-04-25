from flask import Blueprint, jsonify, request

from ingresos_store import (
    create_default_ingresos_year, delete_ingresos_year, list_ingresos_years,
    normalize_year, read_ingresos_types, read_ingresos_year, sanitize_ingresos_payload,
    sanitize_ingresos_types, write_ingresos_types, write_ingresos_year,
)

ingresos_bp = Blueprint("ingresos", __name__)


@ingresos_bp.route("/api/ingresos", methods=["GET"])
def getIngresosYears():
    years = list_ingresos_years()

    if not years:
        default_year = "2026"
        payload = create_default_ingresos_year(default_year)
        write_ingresos_year(default_year, payload)
        years = [default_year]

    return jsonify({"years": years})


@ingresos_bp.route("/api/ingresos-tipos", methods=["GET"])
def getIngresosTipos():
    return jsonify({"types": read_ingresos_types()})


@ingresos_bp.route("/api/ingresos-tipos", methods=["POST"])
def saveIngresosTipos():
    requestData = request.get_json(silent=True) or {}
    types = sanitize_ingresos_types(requestData.get("types", []))
    write_ingresos_types(types)
    return jsonify({"ok": True, "types": types})


@ingresos_bp.route("/api/ingresos", methods=["POST"])
def createIngresosYear():
    requestData = request.get_json(silent=True) or {}
    year = normalize_year(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if read_ingresos_year(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    payload = create_default_ingresos_year(year)
    write_ingresos_year(year, payload)
    return jsonify({"ok": True, "year": year, "data": payload}), 201


@ingresos_bp.route("/api/ingresos/<year>", methods=["GET"])
def getIngresosYear(year):
    data = read_ingresos_year(year)

    if data is None:
        # El año fue creado con cero recurrentes y cero filas, por lo que la BD
        # no tiene registros pero el año es válido — devolvemos la estructura vacía.
        normalized = normalize_year(year)
        if not normalized:
            return jsonify({"ok": False, "error": "Año no encontrado"}), 404
        data = create_default_ingresos_year(normalized)
        data["ingresosTipos"] = read_ingresos_types()

    return jsonify(data)


@ingresos_bp.route("/api/ingresos/<year>", methods=["POST"])
def saveIngresosYear(year):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitize_ingresos_payload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    write_ingresos_year(year, payload)
    return jsonify({"ok": True})


@ingresos_bp.route("/api/ingresos/<year>", methods=["DELETE"])
def deleteIngresosYear(year):
    normalized_year = normalize_year(year)

    if not normalized_year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not delete_ingresos_year(normalized_year):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remaining_years = list_ingresos_years()

    if not remaining_years:
        payload = create_default_ingresos_year("2026")
        write_ingresos_year("2026", payload)
        remaining_years = ["2026"]

    return jsonify({"ok": True, "years": remaining_years})
