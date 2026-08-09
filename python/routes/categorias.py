"""Gestión del catálogo de categorías desde la web app.

Estas rutas sí pasan por la sesión y el CSRF, al contrario que
`GET /api/categorias` (que sirve al Atajo de iOS y se protege por IP + firma).
Existen para que el panel de categorías pueda renombrar y eliminar sobre todos
los años, no solo sobre el que el navegador tenga cargado.
"""

from flask import Blueprint, jsonify, request

from stores.categorias_store import (
    CategoriaEnUso,
    CategoriaInvalida,
    eliminarCategoria,
    leerResumen,
    renombrarCategoria,
)

categorias_bp = Blueprint("categorias", __name__)


@categorias_bp.route("/api/categorias/resumen", methods=["GET"])
def getCategoriasResumen():
    return jsonify({"ok": True, "categorias": leerResumen()})


@categorias_bp.route("/api/categorias/renombrar", methods=["POST"])
def renameCategoria():
    requestData = request.get_json(silent=True) or {}

    try:
        filas = renombrarCategoria(
            requestData.get("tipo"),
            requestData.get("de"),
            requestData.get("a"),
        )
    except CategoriaInvalida as error:
        return jsonify({"ok": False, "error": str(error)}), 400

    return jsonify({"ok": True, "filas": filas})


@categorias_bp.route("/api/categorias/eliminar", methods=["POST"])
def deleteCategoria():
    requestData = request.get_json(silent=True) or {}

    try:
        eliminarCategoria(requestData.get("tipo"), requestData.get("label"))
    except CategoriaInvalida as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    except CategoriaEnUso as error:
        # 409 y no 400: la petición es válida, es el estado actual el que lo
        # impide. El frontend usa el número para explicarlo.
        return jsonify({
            "ok": False,
            "error": f"No se puede eliminar: {error.usos} movimiento{'' if error.usos == 1 else 's'} la usan.",
            "usos": error.usos,
        }), 409

    return jsonify({"ok": True})
