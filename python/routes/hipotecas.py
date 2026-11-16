"""Ventana «Hipotecas»: listado con cuadro de amortización y métricas.

El cálculo vive en `core.hipotecas`; la ruta solo lee, guarda y adjunta el
resultado a cada hipoteca para que el cliente no tenga que reimplementar la
amortización.
"""

from datetime import date
from decimal import Decimal

from flask import Blueprint, jsonify

from core.amortizacion import AmortizacionInvalida
from core.errors import NotFoundError, ValidationError
from core.hipotecas import MAX_CAPITAL, _fecha, calcularHipoteca, simularAmortizacion
from core.validation import asDecimal, jsonBody
from stores.hipotecas_store import guardarHipotecas, listarHipotecas, sanearListado

hipotecasBp = Blueprint("hipotecas", __name__)


def _conCalculo(hipotecas: list[dict]) -> list[dict]:
    hoy = date.today()
    return [{**h, "calculo": calcularHipoteca(h, hoy)} for h in hipotecas]


@hipotecasBp.route("/api/hipotecas", methods=["GET"])
def getHipotecas():
    return jsonify({"rows": _conCalculo(listarHipotecas())})


@hipotecasBp.route("/api/hipotecas", methods=["POST"])
def saveHipotecas():
    requestData = jsonBody()
    hipotecas = sanearListado(requestData.get("rows"))
    guardarHipotecas(hipotecas)
    return jsonify({"ok": True, "rows": _conCalculo(hipotecas)})


@hipotecasBp.route("/api/hipotecas/<hipotecaId>/simulacion", methods=["POST"])
def simularHipoteca(hipotecaId: str):
    """Compara la hipoteca con un pago anticipado hipotético sin guardar nada."""
    hipoteca = next((h for h in listarHipotecas() if h["id"] == hipotecaId), None)
    if hipoteca is None:
        raise NotFoundError("Hipoteca no encontrada")

    requestData = jsonBody()
    hoy = date.today()
    importe = asDecimal(requestData.get("importe"), "importe", required=True,
                        minimum=Decimal("0.01"), maximum=MAX_CAPITAL)
    fecha = date.fromisoformat(_fecha(requestData.get("fecha") or hoy.isoformat(), "fecha"))
    try:
        return jsonify({"ok": True, **simularAmortizacion(hipoteca, hoy, importe, fecha)})
    except AmortizacionInvalida as error:
        raise ValidationError(str(error)) from error
