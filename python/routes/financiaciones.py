"""Ventana «Compras financiadas»: listado con cuotas, plazo y tiempo restante."""

from datetime import date

from flask import Blueprint, jsonify

from core.financiaciones import calcularFinanciacion
from core.validation import jsonBody
from stores.financiaciones_store import guardarFinanciaciones, listarFinanciaciones, sanearListado

financiacionesBp = Blueprint("financiaciones", __name__)


def _conCalculo(compras: list[dict]) -> list[dict]:
    hoy = date.today()
    return [{**c, "calculo": calcularFinanciacion(c, hoy)} for c in compras]


@financiacionesBp.route("/api/financiaciones", methods=["GET"])
def getFinanciaciones():
    return jsonify({"rows": _conCalculo(listarFinanciaciones())})


@financiacionesBp.route("/api/financiaciones", methods=["POST"])
def saveFinanciaciones():
    requestData = jsonBody()
    compras = sanearListado(requestData.get("rows"))
    guardarFinanciaciones(compras)
    return jsonify({"ok": True, "rows": _conCalculo(compras)})
