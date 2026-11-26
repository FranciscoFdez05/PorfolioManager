"""Canjes de valores por fusión: alta manual, edición, borrado y previsualización.

La lógica fiscal está en `core.canjes` y `stores.ventas_fifo`, y el acceso a la
tabla en `stores.canjes_store`. Aquí solo se traduce HTTP.

`GET /api/canjes` devuelve además los movimientos de posición que genera cada
canje (`posicion`), ya resueltos por el servidor: el navegador reconstruye la
cartera por su cuenta (`buildRemainingAssetLots`) y, si tuviera que repetir el
reparto de lotes del canje, habría dos copias de la misma regla.
"""

from flask import Blueprint, jsonify

from core import dinero
from core.db import getDb
from core.validation import jsonBody
from stores import canjes_store, rendimiento_activo, ventas_fifo

canjesBp = Blueprint("canjes", __name__)


def _movimientosDePosicion() -> list[dict]:
    """Filas de ficha generadas por los canjes, en el formato del navegador."""
    posiciones = rendimiento_activo.cargarPosiciones(getDb())
    movimientos = []
    for datos in posiciones.values():
        for fila in datos["filas"]:
            if not isinstance(fila, dict) or not fila.get("canje"):
                continue
            antiguedad = fila.get("fecha_antiguedad")
            movimientos.append({
                "canjeId": fila["canje"],
                "assetId": fila["asset_id"],
                "fecha": fila["fecha_operacion"],
                "tipo": fila["tipo_operacion"],
                "cantidad": fila["participaciones"],
                "coste": fila["capital_invertido_bruto"],
                "moneda": fila["currency"],
                "fxRate": fila["fx_rate"],
                "fechaAntiguedad": antiguedad.strftime("%d-%m-%Y") if antiguedad else "",
                "descuento": dinero.aTexto(fila.get("canje_descuento") or 0),
                "monedaDescuento": fila.get("canje_moneda", ""),
            })
    return movimientos


@canjesBp.route("/api/canjes", methods=["GET"])
def getCanjes():
    return jsonify({"ok": True, "rows": canjes_store.listar(), "posicion": _movimientosDePosicion()})


@canjesBp.route("/api/canjes", methods=["POST"])
def createCanje():
    return jsonify({"ok": True, "canje": canjes_store.guardar(jsonBody())}), 201


@canjesBp.route("/api/canjes/<canjeId>", methods=["PUT"])
def updateCanje(canjeId):
    return jsonify({"ok": True, "canje": canjes_store.guardar(jsonBody(), canjeId)})


@canjesBp.route("/api/canjes/<canjeId>", methods=["DELETE"])
def deleteCanje(canjeId):
    if not canjes_store.borrar(canjeId):
        return jsonify({"ok": False, "error": "Canje no encontrado"}), 404
    return jsonify({"ok": True})


@canjesBp.route("/api/canjes/previsualizar", methods=["POST"])
def previewCanje():
    """Lotes que se traspasarían y lo que se declararía, sin guardar nada.

    Acepta `id` en el cuerpo para previsualizar la edición de un canje guardado
    sin contarlo dos veces.
    """
    datos = jsonBody()
    valores = canjes_store.validarContraLaBase(datos)
    canjeId = str(datos.get("id") or "") or None
    return jsonify({"ok": True, "previsualizacion": ventas_fifo.previsualizarCanje(valores, canjeId)})
