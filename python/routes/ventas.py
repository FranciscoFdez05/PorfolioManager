from flask import Blueprint, jsonify

from core.validation import json_body
from stores import ventas_fifo
from stores.gastos_store import normalize_year
from stores.ventas_store import (
    create_default_ventas_year,
    delete_ventas_year,
    list_ventas_years,
    migrate_legacy_ventas_if_needed,
    read_all_ventas_rows,
    read_ventas_year,
    sanitize_ventas_payload,
    validar_para_guardar,
    write_ventas_year,
)

ventas_bp = Blueprint("ventas", __name__)


@ventas_bp.route("/api/ventas", methods=["GET"])
def getVentas():
    default_year = "2026"
    years = migrate_legacy_ventas_if_needed(default_year)
    # Un solo cálculo para todo: el FIFO es global y recalcularlo por año
    # daría, además de lento, resultados distintos según el orden de lectura.
    calculo = ventas_fifo.calcular_todo()
    return jsonify({
        "years": years,
        "rows": read_all_ventas_rows(calculo),
        "resumenes": {
            anio: ventas_fifo.serializar_liquidacion(liquidacion)
            for anio, liquidacion in calculo["liquidaciones"].items()
        },
        "incidencias": calculo["incidencias"],
    })


@ventas_bp.route("/api/ventas", methods=["POST"])
def createVentasYear():
    requestData = json_body(required=False)
    year = normalize_year(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    migrate_legacy_ventas_if_needed(year)

    if read_ventas_year(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    write_ventas_year(year, create_default_ventas_year(year))
    return jsonify({"ok": True, "year": year, "data": read_ventas_year(year)}), 201


@ventas_bp.route("/api/ventas/<year>", methods=["GET"])
def getVentasYear(year):
    migrate_legacy_ventas_if_needed(normalize_year(year) or "2026")
    data = read_ventas_year(year)

    if data is None:
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    return jsonify(data)


@ventas_bp.route("/api/ventas/<year>", methods=["POST"])
def saveVentasYear(year):
    requestData = json_body(required=False)
    payload, error = sanitize_ventas_payload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    # Lanza ValidationError (400 con el detalle de cada fila) si hay datos que
    # no pueden colocarse en la línea temporal. Las incoherencias de saldo sí
    # se guardan, marcadas, y salen en `incidencias`.
    validar_para_guardar(payload)

    write_ventas_year(payload["year"], payload)
    data = read_ventas_year(payload["year"])
    return jsonify({
        "ok": True,
        "year": data["year"],
        "rows": data["rows"],
        "resumen": data["resumen"],
        "incidencias": data["incidencias"],
    })


@ventas_bp.route("/api/ventas/<year>", methods=["DELETE"])
def deleteVentasYear(year):
    normalized_year = normalize_year(year)

    if not normalized_year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not delete_ventas_year(normalized_year):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remaining_years = list_ventas_years()

    if not remaining_years:
        write_ventas_year("2026", create_default_ventas_year("2026"))
        remaining_years = ["2026"]

    return jsonify({"ok": True, "years": remaining_years})
