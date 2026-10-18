"""Alertas de precio de los activos: listar, crear, pausar/reactivar y borrar.

La lógica (validar, evaluar, avisar por Telegram) vive en
`stores.alertas_store`; aquí solo está la capa HTTP. Las alertas cuelgan del
portfolio activo, como los propios activos.
"""

from flask import Blueprint, jsonify, request

from stores import alertas_store
from stores.asset_utils import slugify

alertasBp = Blueprint("alertas", __name__)


@alertasBp.route("/api/alertas", methods=["GET"])
def getAlertas():
    assetId = slugify(request.args["assetId"]) if request.args.get("assetId") else None
    return jsonify({
        "ok": True,
        "alertas": alertas_store.listar(assetId),
        "condiciones": alertas_store.CONDICIONES,
    })


@alertasBp.route("/api/alertas", methods=["POST"])
def createAlerta():
    datos = request.get_json(silent=True) or {}
    assetId = slugify(str(datos.get("assetId") or ""))

    try:
        alerta = alertas_store.crear(
            assetId, str(datos.get("condicion") or ""), datos.get("valor"), datos.get("nota", "")
        )
    except alertas_store.AlertaInvalida as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    return jsonify({"ok": True, "alerta": alerta}), 201


@alertasBp.route("/api/alertas/<int:alertaId>/estado", methods=["POST"])
def setEstadoAlerta(alertaId):
    datos = request.get_json(silent=True) or {}
    if not alertas_store.cambiarEstado(alertaId, bool(datos.get("activa"))):
        return jsonify({"ok": False, "error": "Alerta no encontrada"}), 404
    return jsonify({"ok": True})


@alertasBp.route("/api/alertas/<int:alertaId>", methods=["DELETE"])
def deleteAlerta(alertaId):
    if not alertas_store.borrar(alertaId):
        return jsonify({"ok": False, "error": "Alerta no encontrada"}), 404
    return jsonify({"ok": True})
