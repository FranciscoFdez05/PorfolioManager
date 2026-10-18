"""Planes de inversión.

El cliente maneja la lista completa (añadir, editar, borrar y reordenar son la
misma acción para él) y la envía entera. El servidor no calcula nada aquí —el
porcentaje que falta para el objetivo depende del precio del momento, que ya se
pide aparte— pero sí normaliza: los desplegables entran acotados a sus opciones
y el resto de campos se recortan, para que en la base no acabe ni un estado
inventado ni una nota de un megabyte.

`assetId` es obligatorio: un plan se consulta desde la ficha de su activo, así
que uno sin activo se guardaría en un sitio del que no se puede salir. La tabla
lo refuerza con una clave foránea.
"""

from flask import Blueprint, jsonify

from core.validation import asRows, asText, jsonBody, oneOf
from stores.planes_store import readPlanes, writePlanes

planesBp = Blueprint("planes", __name__)

_HORIZONTES = {"Corto", "Medio", "Largo"}
_ESTADOS_PLAN = {"Pendiente", "En curso", "Cumplido", "Cancelado"}

# Ni el nombre ni la nota son campos de importe: 120 y 500 caracteres son de
# sobra para lo que cabe en una tarjeta, y evitan que un pegado accidental se
# guarde entero.
_MAX_NOMBRE = 120
_MAX_NOTAS = 500
_MAX_IMPORTE = 32


def _identificador(fila, indice, prefijo):
    return asText(fila.get("id"), "id", maxLength=64) or f"{prefijo}-{indice + 1}"


def _mercado(fila):
    """Campos con los que se localiza la cotización del plan.

    El plan cuelga siempre de un activo de la cartera, y de él saca el precio
    con el que se evalúa. El símbolo, el ticker y el proveedor se copian del
    activo al crearlo: no se usan para cotizar —eso ya lo hace el activo— pero
    dejan escrito de qué se estaba hablando y son con lo que la tarjeta abre el
    gráfico.
    """
    return {
        "assetId":        asText(fila.get("assetId"), "assetId", maxLength=120, required=True),
        "symbol":         asText(fila.get("symbol"), "symbol", maxLength=40).upper(),
        "ticker":         asText(fila.get("ticker"), "ticker", maxLength=80).upper(),
        "marketProvider": asText(fila.get("marketProvider"), "marketProvider", maxLength=40).lower(),
        "tvSymbol":       asText(fila.get("tvSymbol"), "tvSymbol", maxLength=120),
        "currency":       asText(fila.get("currency"), "currency", maxLength=10).upper() or "EUR",
    }


def _sanearPlan(fila, indice):
    return {
        **_mercado(fila),
        "id":            _identificador(fila, indice, "plan"),
        "nombre":        asText(fila.get("nombre"), "nombre", maxLength=_MAX_NOMBRE),
        "precioEntrada": asText(fila.get("precioEntrada"), "precioEntrada", maxLength=_MAX_IMPORTE),
        "precioSalida":  asText(fila.get("precioSalida"), "precioSalida", maxLength=_MAX_IMPORTE),
        "capital":       asText(fila.get("capital"), "capital", maxLength=_MAX_IMPORTE),
        "horizonte":     oneOf(fila.get("horizonte"), _HORIZONTES, "horizonte", default="Medio"),
        "estado":        oneOf(fila.get("estado"), _ESTADOS_PLAN, "estado", default="Pendiente"),
        "fechaObjetivo": asText(fila.get("fechaObjetivo"), "fechaObjetivo", maxLength=20),
        "notas":         asText(fila.get("notas"), "notas", maxLength=_MAX_NOTAS),
    }


@planesBp.route("/api/planes", methods=["GET"])
def getPlanes():
    return jsonify(readPlanes())


@planesBp.route("/api/planes", methods=["POST"])
def savePlanes():
    filas = asRows(jsonBody().get("rows"), "rows", maxRows=500)
    saneadas = [_sanearPlan(fila, indice) for indice, fila in enumerate(filas)]
    writePlanes(saneadas)
    return jsonify({"ok": True, "rows": saneadas})
