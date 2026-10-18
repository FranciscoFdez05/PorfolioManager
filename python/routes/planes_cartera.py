"""Planes de inversión de la cartera (/api/planes-cartera).

El cliente maneja la lista completa de planes y la envía entera. El servidor no
calcula nada —cuánto hay realizado sale del estado de cada operación, que el
cliente ya tiene cargada— pero sí normaliza la forma: un plan es un objeto con
`id`, `nombre`, `archivado` y una lista `activos`, y cada activo lleva su
`assetId` y la lista de identificadores de `operaciones` vinculadas. Cualquier
otra cosa se descarta, y un activo sin identificador o un identificador que no
sea texto son un 400 con mensaje, no un 500 del motor.

Las operaciones se guardan por referencia: crear una desde el plan es crearla en
/api/operaciones y después vincularla aquí. El plan no lleva importes propios.
"""

from flask import Blueprint, jsonify

from core.errors import ValidationError
from core.validation import asBool, asRows, asText, jsonBody
from stores.planes_cartera_store import readPlanesCartera, writePlanesCartera

planesCarteraBp = Blueprint("planes_cartera", __name__)

_MAX_NOMBRE = 120
_MAX_ACTIVOS = 200
_MAX_OPERACIONES = 500


def _lista(valor, campo, maximo):
    if valor is None:
        return []
    if not isinstance(valor, list):
        raise ValidationError(f"«{campo}» debe ser una lista", field=campo)
    if len(valor) > maximo:
        raise ValidationError(f"«{campo}» supera el máximo de {maximo} elementos", field=campo)
    return valor


def _sanearActivo(fila, campo):
    if not isinstance(fila, dict):
        raise ValidationError(f"«{campo}» debe ser un objeto", field=campo)
    return {
        "assetId": asText(fila.get("assetId"), "assetId", maxLength=120, required=True),
        "operaciones": [
            asText(operacionId, "operaciones", maxLength=120, required=True)
            for operacionId in _lista(fila.get("operaciones"), f"{campo}.operaciones", _MAX_OPERACIONES)
        ],
    }


def _sanearPlan(fila, indice):
    campo = f"rows[{indice}].activos"
    return {
        "id":        asText(fila.get("id"), "id", maxLength=64) or f"plan-cartera-{indice + 1}",
        "nombre":    asText(fila.get("nombre"), "nombre", maxLength=_MAX_NOMBRE) or f"Plan {indice + 1}",
        "archivado": asBool(fila.get("archivado")),
        "activos": [
            _sanearActivo(activo, campo)
            for activo in _lista(fila.get("activos"), campo, _MAX_ACTIVOS)
        ],
    }


@planesCarteraBp.route("/api/planes-cartera", methods=["GET"])
def getPlanesCartera():
    return jsonify(readPlanesCartera())


@planesCarteraBp.route("/api/planes-cartera", methods=["POST"])
def savePlanesCartera():
    filas = asRows(jsonBody().get("rows"), "rows", maxRows=200)
    saneados = [_sanearPlan(fila, indice) for indice, fila in enumerate(filas)]
    writePlanesCartera(saneados)
    return jsonify({"ok": True, "rows": readPlanesCartera()["rows"]})
