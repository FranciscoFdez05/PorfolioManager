"""Resumen de ingresos pasivos de la ventana Dividendos.

El cálculo vive en `core.ingresos_pasivos`; `stores.ingresos_pasivos_store`
reúne los datos. La ruta solo expone el resultado.
"""

from flask import Blueprint, jsonify

from stores.ingresos_pasivos_store import calcularIngresosPasivos

ingresosPasivosBp = Blueprint("ingresosPasivos", __name__)


@ingresosPasivosBp.route("/api/dividendos/resumen", methods=["GET"])
def getResumenIngresosPasivos():
    """Dividendos de los últimos 12 meses, media mensual, proyección y rentabilidad."""
    return jsonify(calcularIngresosPasivos())
