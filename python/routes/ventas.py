from datetime import date

from flask import Blueprint, Response, g, jsonify

from core import csp, informe_renta
from core.validation import jsonBody
from stores import revisiones, ventas_fifo
from stores.gastos_store import normalizeYear
from stores.ventas_store import (
    createDefaultVentasYear,
    deleteVentasYear as borrarAnioVentas,
    listVentasYears,
    migrateLegacyVentasIfNeeded,
    readAllVentasRows,
    readVentasYear,
    sanitizeVentasPayload,
    validarParaGuardar,
    writeVentasYear,
)

ventasBp = Blueprint("ventas", __name__)


@ventasBp.route("/api/ventas", methods=["GET"])
def getVentas():
    # Sin ningún ejercicio se ofrece el actual sin crearlo: la lectura no
    # escribe, y el año se guarda la primera vez que el usuario guarda.
    years = listVentasYears() or [str(date.today().year)]
    # Un solo cálculo para todo: el FIFO es global y recalcularlo por año
    # daría, además de lento, resultados distintos según el orden de lectura.
    calculo = ventas_fifo.calcularTodo()
    return jsonify({
        "years": years,
        "rows": readAllVentasRows(calculo),
        "resumenes": {
            anio: ventas_fifo.serializarLiquidacion(liquidacion)
            for anio, liquidacion in calculo["liquidaciones"].items()
        },
        "incidencias": calculo["incidencias"],
    })


@ventasBp.route("/api/ventas", methods=["POST"])
def createVentasYear():
    requestData = jsonBody(required=False)
    year = normalizeYear(requestData.get("year"))

    if not year:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    migrateLegacyVentasIfNeeded(year)

    if readVentasYear(year) is not None:
        return jsonify({"ok": False, "error": "Ese año ya existe"}), 409

    writeVentasYear(year, createDefaultVentasYear(year))
    return jsonify({"ok": True, "year": year, "data": readVentasYear(year)}), 201


@ventasBp.route("/api/ventas/<year>", methods=["GET"])
def getVentasYear(year):
    data = readVentasYear(year)

    if data is None and not listVentasYears() and normalizeYear(year) == str(date.today().year):
        # El ejercicio actual de una cartera sin ventas: vacío, sin persistirlo.
        data = {**createDefaultVentasYear(year), "resumen": None, "incidencias": [], "revision": 0}

    if data is None:
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    return jsonify(data)


@ventasBp.route("/api/ventas/<year>", methods=["POST"])
def saveVentasYear(year):
    requestData = jsonBody(required=False)
    payload, error = sanitizeVentasPayload(requestData, year)

    if error:
        return jsonify({"ok": False, "error": error}), 400

    # Lanza ValidationError (400 con el detalle de cada fila) si hay datos que
    # no pueden colocarse en la línea temporal. Las incoherencias de saldo sí
    # se guardan, marcadas, y salen en `incidencias`.
    validarParaGuardar(payload)

    try:
        esperada = revisiones.revisionDePeticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    try:
        writeVentasYear(payload["year"], payload, revisionEsperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return jsonify({
            "ok": False, "conflicto": True, "revision": conflicto.actual,
            "error": "Este año ha cambiado desde otro sitio (otra pestaña u otro dispositivo)",
        }), 409
    data = readVentasYear(payload["year"])
    return jsonify({
        "ok": True,
        "year": data["year"],
        "rows": data["rows"],
        "resumen": data["resumen"],
        "incidencias": data["incidencias"],
        "revision": data["revision"],
    })


# ── Informe anual para la declaración ─────────────────────────────────────────
# El cálculo fiscal ya era correcto, pero solo se podía leer en pantalla: en
# abril había que copiar las cifras a mano a Renta Web. Estas dos rutas sirven
# el mismo informe en los dos formatos que hacen falta —hoja de cálculo y
# documento imprimible— desde un único cálculo, para que no puedan divergir.


def _prepararInforme(year):
    """Devuelve `(informe, error)`; `error` es la respuesta lista para devolver."""
    normalizedYear = normalizeYear(year)
    if not normalizedYear:
        return None, (jsonify({"ok": False, "error": "Año inválido"}), 400)

    data = readVentasYear(normalizedYear)
    if data is None:
        return None, (jsonify({"ok": False, "error": "Año no encontrado"}), 404)

    return informe_renta.construir(
        normalizedYear, data["rows"], data["resumen"], data.get("permutas", ())
    ), None


@ventasBp.route("/api/ventas/<year>/informe.csv", methods=["GET"])
def getInformeCsv(year):
    informe, error = _prepararInforme(year)
    if error:
        return error

    return Response(
        informe_renta.aCsv(informe),
        # charset explícito además del BOM: si el navegador decide el suyo, los
        # acentos se ven mal al abrirlo directamente en vez de descargarlo.
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": (
                f'attachment; filename=ganancias-patrimoniales-{informe["anio"]}.csv'
            ),
            "Cache-Control": "no-store",
        },
    )


@ventasBp.route("/api/ventas/<year>/informe.html", methods=["GET"])
def getInformeHtml(year):
    informe, error = _prepararInforme(year)
    if error:
        return error

    # El nonce va en `g` para que la CSP que monta core/seguridad_app.py lo
    # recoja en el after_request; sin él, el navegador bloquea el script que
    # engancha el botón de imprimir.
    g.csp_nonce = csp.generarNonce()
    return Response(
        informe_renta.aHtml(informe, nonce=g.csp_nonce),
        mimetype="text/html; charset=utf-8",
        headers={"Cache-Control": "no-store"},
    )


@ventasBp.route("/api/ventas/<year>", methods=["DELETE"])
def deleteVentasYear(year):
    normalizedYear = normalizeYear(year)

    if not normalizedYear:
        return jsonify({"ok": False, "error": "Año inválido"}), 400

    if not borrarAnioVentas(normalizedYear):
        return jsonify({"ok": False, "error": "Año no encontrado"}), 404

    remainingYears = listVentasYears()

    if not remainingYears:
        actual = str(date.today().year)
        writeVentasYear(actual, createDefaultVentasYear(actual))
        remainingYears = [actual]

    return jsonify({"ok": True, "years": remainingYears})
