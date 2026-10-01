"""Alertas de precio de los activos: listar, crear, pausar/reactivar y borrar.

La lógica (validar, evaluar, avisar por Telegram) vive en
`stores.alertas_store`; aquí solo está la capa HTTP. Las alertas cuelgan del
portfolio activo, como los propios activos.
"""

from flask import Blueprint, jsonify, request

from stores import alertas_store
from stores.asset_utils import slugify

alertas_bp = Blueprint("alertas", __name__)


@alertas_bp.route("/api/alertas", methods=["GET"])
def getAlertas():
    asset_id = slugify(request.args["assetId"]) if request.args.get("assetId") else None
    return jsonify({
        "ok": True,
        "alertas": alertas_store.listar(asset_id),
        "condiciones": alertas_store.CONDICIONES,
    })


@alertas_bp.route("/api/alertas", methods=["POST"])
def createAlerta():
    datos = request.get_json(silent=True) or {}
    asset_id = slugify(str(datos.get("assetId") or ""))

    try:
        alerta = alertas_store.crear(
            asset_id, str(datos.get("condicion") or ""), datos.get("valor"), datos.get("nota", "")
        )
    except alertas_store.AlertaInvalida as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    return jsonify({"ok": True, "alerta": alerta}), 201


@alertas_bp.route("/api/alertas/<int:alerta_id>/estado", methods=["POST"])
def setEstadoAlerta(alerta_id):
    datos = request.get_json(silent=True) or {}
    if not alertas_store.cambiar_estado(alerta_id, bool(datos.get("activa"))):
        return jsonify({"ok": False, "error": "Alerta no encontrada"}), 404
    return jsonify({"ok": True})


@alertas_bp.route("/api/alertas/<int:alerta_id>", methods=["DELETE"])
def deleteAlerta(alerta_id):
    if not alertas_store.borrar(alerta_id):
        return jsonify({"ok": False, "error": "Alerta no encontrada"}), 404
    return jsonify({"ok": True})
