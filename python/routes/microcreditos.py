"""Ventana «Microcréditos»: listado con vencimientos, coste y TAE equivalente.

El cálculo vive en `core.microcreditos`; la ruta solo lee, guarda y adjunta el
resultado a cada microcrédito para que el cliente no reimplemente nada.
"""

from datetime import date

from flask import Blueprint, jsonify

from core.microcreditos import calcularMicrocredito
from core.validation import jsonBody
from stores.microcreditos_store import guardarMicrocreditos, listarMicrocreditos, sanearListado

microcreditosBp = Blueprint("microcreditos", __name__)


def _conCalculo(microcreditos: list[dict]) -> list[dict]:
    hoy = date.today()
    return [{**m, "calculo": calcularMicrocredito(m, hoy)} for m in microcreditos]


@microcreditosBp.route("/api/microcreditos", methods=["GET"])
def getMicrocreditos():
    return jsonify({"rows": _conCalculo(listarMicrocreditos())})


@microcreditosBp.route("/api/microcreditos", methods=["POST"])
def saveMicrocreditos():
    requestData = jsonBody()
    microcreditos = sanearListado(requestData.get("rows"))
    guardarMicrocreditos(microcreditos)
    return jsonify({"ok": True, "rows": _conCalculo(microcreditos)})
