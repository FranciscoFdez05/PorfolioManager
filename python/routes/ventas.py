from flask import Blueprint, jsonify, request

from gastos_store import normalize_year
from ventas_store import (
    create_default_ventas_year, delete_ventas_year, list_ventas_years,
    migrate_legacy_ventas_if_needed, read_all_ventas_rows, read_ventas_year,
    sanitize_ventas_payload, write_ventas_year,
)

ventas_bp = Blueprint("ventas", __name__)


@ventas_bp.route("/api/ventas", methods=["GET"])
def getVentas():
    default_year = "2026"
    years = migrate_legacy_ventas_if_needed(default_year)
    return jsonify({"years": years, "rows": read_all_ventas_rows()})


@ventas_bp.route("/api/ventas", methods=["POST"])
def createVentasYear():
    requestData = request.get_json(silent=True) or {}
    year = normalize_year(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    migrate_legacy_ventas_if_needed(year)

    if read_ventas_year(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    payload = create_default_ventas_year(year)
    write_ventas_year(year, payload)
    return jsonify({"ok": True, "year": year, "data": payload}), 201


@ventas_bp.route("/api/ventas/<year>", methods=["GET"])
def getVentasYear(year):
    migrate_legacy_ventas_if_needed(normalize_year(year) or "2026")
    data = read_ventas_year(year)

    if data is None:
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    return jsonify(data)


@ventas_bp.route("/api/ventas/<year>", methods=["POST"])
def saveVentasYear(year):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitize_ventas_payload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    write_ventas_year(year, payload)
    return jsonify({"ok": True})


@ventas_bp.route("/api/ventas/<year>", methods=["DELETE"])
def deleteVentasYear(year):
    normalized_year = normalize_year(year)

    if not normalized_year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not delete_ventas_year(normalized_year):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remaining_years = list_ventas_years()

    if not remaining_years:
        payload = create_default_ventas_year("2026")
        write_ventas_year("2026", payload)
        remaining_years = ["2026"]

    return jsonify({"ok": True, "years": remaining_years})
