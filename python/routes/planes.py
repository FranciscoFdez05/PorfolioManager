"""Planes de inversión y planes DCA.

Dos recursos con la misma forma: el cliente maneja la lista completa (añadir,
editar, borrar y reordenar son la misma acción para él) y la envía entera. El
servidor no calcula nada aquí —el porcentaje que falta para el objetivo o el
próximo aporte dependen del precio del momento, que ya se pide aparte— pero sí
normaliza: los desplegables entran acotados a sus opciones y el resto de campos
se recortan, para que en la base no acabe ni un estado inventado ni una nota de
un megabyte.
"""

from flask import Blueprint, jsonify

from core.validation import as_int, as_rows, as_text, json_body, one_of
from stores.planes_store import read_dca, read_planes, write_dca, write_planes

planes_bp = Blueprint("planes", __name__)

_DIRECCIONES = {"Largo", "Corto"}
_HORIZONTES = {"Corto", "Medio", "Largo"}
_ESTADOS_PLAN = {"Pendiente", "En curso", "Cumplido", "Cancelado"}
_FRECUENCIAS = {"Semanal", "Quincenal", "Mensual", "Trimestral"}
_ESTADOS_DCA = {"Activo", "Pausado", "Finalizado"}

# Ni el nombre ni la nota son campos de importe: 120 y 500 caracteres son de
# sobra para lo que cabe en una tarjeta, y evitan que un pegado accidental se
# guarde entero.
_MAX_NOMBRE = 120
_MAX_NOTAS = 500
_MAX_IMPORTE = 32


def _identificador(fila, indice, prefijo):
    return as_text(fila.get("id"), "id", max_length=64) or f"{prefijo}-{indice + 1}"


def _mercado(fila):
    """Campos con los que se localiza la cotización del plan.

    Un plan puede apuntar a un activo de la cartera (`assetId`) o a algo que
    todavía no se tiene, en cuyo caso lo único que hay es el ticker y el
    proveedor. Se guardan los dos: si el activo se borra, el plan sigue sabiendo
    de qué estaba hablando.
    """
    return {
        "assetId":        as_text(fila.get("assetId"), "assetId", max_length=120),
        "symbol":         as_text(fila.get("symbol"), "symbol", max_length=40).upper(),
        "ticker":         as_text(fila.get("ticker"), "ticker", max_length=80).upper(),
        "marketProvider": as_text(fila.get("marketProvider"), "marketProvider", max_length=40).lower(),
        "tvSymbol":       as_text(fila.get("tvSymbol"), "tvSymbol", max_length=120),
        "currency":       as_text(fila.get("currency"), "currency", max_length=10).upper() or "EUR",
    }


def _sanear_plan(fila, indice):
    return {
        **_mercado(fila),
        "id":            _identificador(fila, indice, "plan"),
        "nombre":        as_text(fila.get("nombre"), "nombre", max_length=_MAX_NOMBRE),
        "direccion":     one_of(fila.get("direccion"), _DIRECCIONES, "direccion", default="Largo"),
        "precioEntrada": as_text(fila.get("precioEntrada"), "precioEntrada", max_length=_MAX_IMPORTE),
        "precioSalida":  as_text(fila.get("precioSalida"), "precioSalida", max_length=_MAX_IMPORTE),
        "stopLoss":      as_text(fila.get("stopLoss"), "stopLoss", max_length=_MAX_IMPORTE),
        "capital":       as_text(fila.get("capital"), "capital", max_length=_MAX_IMPORTE),
        "horizonte":     one_of(fila.get("horizonte"), _HORIZONTES, "horizonte", default="Medio"),
        "estado":        one_of(fila.get("estado"), _ESTADOS_PLAN, "estado", default="Pendiente"),
        "fechaObjetivo": as_text(fila.get("fechaObjetivo"), "fechaObjetivo", max_length=20),
        "notas":         as_text(fila.get("notas"), "notas", max_length=_MAX_NOTAS),
    }


def _sanear_dca(fila, indice):
    # El número de aportes va por `as_int` y vuelve a texto: es un contador, y
    # dejarlo pasar como cadena libre permitiría guardar "muchos" como objetivo
    # y que la barra de progreso del cliente saliera con NaN.
    objetivo = as_int(fila.get("aportesObjetivo"), "aportesObjetivo", minimum=0, maximum=1000)

    return {
        **_mercado(fila),
        "id":              _identificador(fila, indice, "dca"),
        "nombre":          as_text(fila.get("nombre"), "nombre", max_length=_MAX_NOMBRE),
        "importe":         as_text(fila.get("importe"), "importe", max_length=_MAX_IMPORTE),
        "frecuencia":      one_of(fila.get("frecuencia"), _FRECUENCIAS, "frecuencia", default="Mensual"),
        "fechaInicio":     as_text(fila.get("fechaInicio"), "fechaInicio", max_length=20),
        "fechaFin":        as_text(fila.get("fechaFin"), "fechaFin", max_length=20),
        "aportesObjetivo": "" if objetivo is None else str(objetivo),
        "precioMaximo":    as_text(fila.get("precioMaximo"), "precioMaximo", max_length=_MAX_IMPORTE),
        "estado":          one_of(fila.get("estado"), _ESTADOS_DCA, "estado", default="Activo"),
        "notas":           as_text(fila.get("notas"), "notas", max_length=_MAX_NOTAS),
    }


@planes_bp.route("/api/planes", methods=["GET"])
def getPlanes():
    return jsonify(read_planes())


@planes_bp.route("/api/planes", methods=["POST"])
def savePlanes():
    filas = as_rows(json_body().get("rows"), "rows", max_rows=500)
    saneadas = [_sanear_plan(fila, indice) for indice, fila in enumerate(filas)]
    write_planes(saneadas)
    return jsonify({"ok": True, "rows": saneadas})


@planes_bp.route("/api/dca", methods=["GET"])
def getDca():
    return jsonify(read_dca())


@planes_bp.route("/api/dca", methods=["POST"])
def saveDca():
    filas = as_rows(json_body().get("rows"), "rows", max_rows=500)
    saneadas = [_sanear_dca(fila, indice) for indice, fila in enumerate(filas)]
    write_dca(saneadas)
    return jsonify({"ok": True, "rows": saneadas})
