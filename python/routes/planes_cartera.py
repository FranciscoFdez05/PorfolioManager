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
from core.validation import as_bool, as_rows, as_text, json_body
from stores.planes_cartera_store import read_planes_cartera, write_planes_cartera

planes_cartera_bp = Blueprint("planes_cartera", __name__)

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


def _sanear_activo(fila, campo):
    if not isinstance(fila, dict):
        raise ValidationError(f"«{campo}» debe ser un objeto", field=campo)
    return {
        "assetId": as_text(fila.get("assetId"), "assetId", max_length=120, required=True),
        "operaciones": [
            as_text(operacion_id, "operaciones", max_length=120, required=True)
            for operacion_id in _lista(fila.get("operaciones"), f"{campo}.operaciones", _MAX_OPERACIONES)
        ],
    }


def _sanear_plan(fila, indice):
    campo = f"rows[{indice}].activos"
    return {
        "id":        as_text(fila.get("id"), "id", max_length=64) or f"plan-cartera-{indice + 1}",
        "nombre":    as_text(fila.get("nombre"), "nombre", max_length=_MAX_NOMBRE) or f"Plan {indice + 1}",
        "archivado": as_bool(fila.get("archivado")),
        "activos": [
            _sanear_activo(activo, campo)
            for activo in _lista(fila.get("activos"), campo, _MAX_ACTIVOS)
        ],
    }


@planes_cartera_bp.route("/api/planes-cartera", methods=["GET"])
def getPlanesCartera():
    return jsonify(read_planes_cartera())


@planes_cartera_bp.route("/api/planes-cartera", methods=["POST"])
def savePlanesCartera():
    filas = as_rows(json_body().get("rows"), "rows", max_rows=200)
    saneados = [_sanear_plan(fila, indice) for indice, fila in enumerate(filas)]
    write_planes_cartera(saneados)
    return jsonify({"ok": True, "rows": read_planes_cartera()["rows"]})
