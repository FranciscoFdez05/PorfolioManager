"""Reglas de alerta: catálogo, listar, crear, pausar/reactivar y borrar.

La lógica (validar, muestrear, evaluar y avisar por Telegram) vive en
`stores.reglas_alerta_store` y `stores.reglas_alerta_motor`; aquí solo está la
capa HTTP. Las reglas cuelgan del portfolio activo, como los propios activos.
"""

from flask import Blueprint, jsonify, request

from stores import reglas_alerta_store as store
from stores.asset_utils import slugify

alertasReglasBp = Blueprint("alertasReglas", __name__)


@alertasReglasBp.route("/api/alertas/activos", methods=["GET"])
def getActivosAlertables():
    """Activos con símbolo de mercado, para los selectores de alertas.

    Ligero a propósito: `/api/activos` reconstruye posiciones con el FIFO y
    aquí basta con id, nombre, símbolo y divisa.
    """
    return jsonify({"ok": True, "activos": store.activosSeleccionables()})


@alertasReglasBp.route("/api/alertas-reglas", methods=["GET"])
def getReglas():
    """Reglas, últimos avisos y catálogo de tipos.

    Con `?assetId=` solo las de ese activo y las generales que también lo
    vigilan (lo que enseña la pestaña «Alertas» de su ficha).
    """
    textoActivo = str(request.args.get("assetId") or "").strip()
    assetId = slugify(textoActivo) if textoActivo else None
    return jsonify({
        "ok": True,
        "reglas": store.listar(assetId, incluirGenerales=bool(assetId)),
        "avisos": store.ultimosAvisos(),
        "tipos": store.catalogo(),
        "enfriamientos": list(store.enfriamientosPermitidos),
    })


@alertasReglasBp.route("/api/alertas-reglas", methods=["POST"])
def createRegla():
    """Crea una regla. `assetId` vacío en un tipo por activo = todos con posición."""
    datos = request.get_json(silent=True) or {}
    textoActivo = str(datos.get("assetId") or "").strip()
    # slugify("") devuelve "activo": vacío tiene que seguir siendo «todos».
    assetId = slugify(textoActivo) if textoActivo else None

    try:
        regla = store.crear(
            datos.get("tipo"), assetId, datos.get("sentido", ""), datos.get("unidad", ""), datos.get("valor"),
            datos.get("ventanaMin"), datos.get("enfriamientoMin"), datos.get("nota", ""),
        )
    except store.ReglaInvalida as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    return jsonify({"ok": True, "regla": regla}), 201


@alertasReglasBp.route("/api/alertas-reglas/<int:reglaId>/estado", methods=["POST"])
def setEstadoRegla(reglaId):
    """Pausa o reactiva una regla."""
    datos = request.get_json(silent=True) or {}
    if not store.cambiarEstado(reglaId, bool(datos.get("activa"))):
        return jsonify({"ok": False, "error": "Alerta no encontrada"}), 404
    return jsonify({"ok": True})


@alertasReglasBp.route("/api/alertas-reglas/<int:reglaId>", methods=["DELETE"])
def deleteRegla(reglaId):
    """Borra una regla y sus avisos."""
    if not store.borrar(reglaId):
        return jsonify({"ok": False, "error": "Alerta no encontrada"}), 404
    return jsonify({"ok": True})
