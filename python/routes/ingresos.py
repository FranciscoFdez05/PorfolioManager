from datetime import date

from flask import Blueprint, jsonify, request

from stores import revisiones
from stores.ingresos_store import (
    createDefaultIngresosYear,
    deleteIngresosYear as borrarAnioIngresos,
    listIngresosYears,
    normalizeYear,
    readIngresosTypes,
    readIngresosYear,
    sanitizeIngresosPayload,
    sanitizeIngresosTypes,
    writeIngresosTypes,
    writeIngresosYear,
)

ingresosBp = Blueprint("ingresos", __name__)


@ingresosBp.route("/api/ingresos", methods=["GET"])
def getIngresosYears():
    # Sin ningún año se ofrece el actual sin crearlo: la lectura no escribe.
    years = listIngresosYears() or [str(date.today().year)]

    return jsonify({"years": years})


@ingresosBp.route("/api/ingresos-tipos", methods=["GET"])
def getIngresosTipos():
    return jsonify({"types": readIngresosTypes()})


@ingresosBp.route("/api/ingresos-tipos", methods=["POST"])
def saveIngresosTipos():
    requestData = request.get_json(silent=True) or {}
    types = sanitizeIngresosTypes(requestData.get("types", []))
    writeIngresosTypes(types)
    return jsonify({"ok": True, "types": types})


@ingresosBp.route("/api/ingresos", methods=["POST"])
def createIngresosYear():
    requestData = request.get_json(silent=True) or {}
    year = normalizeYear(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if readIngresosYear(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    payload = createDefaultIngresosYear(year)
    writeIngresosYear(year, payload)
    return jsonify({"ok": True, "year": year, "data": payload}), 201


@ingresosBp.route("/api/ingresos/todos", methods=["GET"])
def getIngresosTodos():
    """Todos los años guardados con su contenido, en una sola respuesta.

    Sustituye a una petición `/api/ingresos/<año>` por año en el resumen anual
    de Métricas. Cada valor es idéntico a lo que devuelve `GET /api/ingresos/<año>`.
    """
    years = {}
    for year in listIngresosYears():
        data = readIngresosYear(year)
        if data is not None:
            years[year] = data

    return jsonify({"years": years})


@ingresosBp.route("/api/ingresos/<year>", methods=["GET"])
def getIngresosYear(year):
    data = readIngresosYear(year)

    if data is None:
        # El año fue creado con cero recurrentes y cero filas, por lo que la BD
        # no tiene registros pero el año es válido — devolvemos la estructura vacía.
        normalized = normalizeYear(year)
        if not normalized:
            return jsonify({"ok": False, "error": "Año no encontrado"}), 404
        data = createDefaultIngresosYear(normalized)
        data["ingresosTipos"] = readIngresosTypes()
        data["revision"] = revisiones.actual("ingresos", normalized)

    return jsonify(data)


@ingresosBp.route("/api/ingresos/<year>", methods=["POST"])
def saveIngresosYear(year):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitizeIngresosPayload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    try:
        esperada = revisiones.revisionDePeticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        nueva = writeIngresosYear(year, payload, revisionEsperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return jsonify({
            "ok": False, "conflicto": True, "revision": conflicto.actual,
            "error": "Este año ha cambiado desde otro sitio (otra pestaña, otro dispositivo o el Atajo)",
        }), 409
    return jsonify({"ok": True, "revision": nueva})


@ingresosBp.route("/api/ingresos/<year>", methods=["DELETE"])
def deleteIngresosYear(year):
    normalizedYear = normalizeYear(year)

    if not normalizedYear:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not borrarAnioIngresos(normalizedYear):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remainingYears = listIngresosYears()

    if not remainingYears:
        actual = str(date.today().year)
        writeIngresosYear(actual, createDefaultIngresosYear(actual))
        remainingYears = [actual]

    return jsonify({"ok": True, "years": remainingYears})
