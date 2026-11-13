"""Rutas del registro interno: estado, lectura de logs y errores del navegador."""

from flask import Blueprint, jsonify, request

from core import registro_interno
from core.validation import jsonBody

registroInternoBp = Blueprint("registroInterno", __name__)


@registroInternoBp.route("/api/registro/estado", methods=["GET"])
def getEstadoRegistro():
    return jsonify({"ok": True, **registro_interno.estado()})


@registroInternoBp.route("/api/registro/<proceso>", methods=["GET"])
def getLogProceso(proceso: str):
    nivel = request.args.get("nivel", "DEBUG")
    try:
        lineas = request.args.get("lineas", registro_interno.LINEAS_POR_DEFECTO, type=int)
        return jsonify({"ok": True, "lineas": registro_interno.leerCola(proceso, lineas, nivel)})
    except ValueError:
        return jsonify({"ok": False, "error": "Proceso de log desconocido"}), 404


@registroInternoBp.route("/api/registro/cliente", methods=["POST"])
def postErrorCliente():
    datos = jsonBody(required=False)
    guardado = registro_interno.registrarErrorCliente(datos if isinstance(datos, dict) else {})
    # 200 también al descartar: un 429 en /api hace que api.js saque un aviso por
    # cada error, y un error en bucle llenaba la pantalla de avisos.
    return jsonify({"ok": True, "guardado": guardado})
