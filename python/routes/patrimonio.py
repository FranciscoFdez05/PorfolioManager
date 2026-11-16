"""Ventana «Patrimonio»: lo que se tiene menos lo que se debe.

El cálculo vive en `core.patrimonio`; `stores.patrimonio_store` reúne las
partidas. La ruta solo expone el resultado.
"""

from flask import Blueprint, jsonify

from stores.patrimonio_store import calcularPatrimonioActual

patrimonioBp = Blueprint("patrimonio", __name__)


@patrimonioBp.route("/api/patrimonio", methods=["GET"])
def getPatrimonio():
    """Patrimonio neto actual con su desglose por grupo."""
    return jsonify(calcularPatrimonioActual())
