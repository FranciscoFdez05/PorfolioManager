"""Pedir la actualización desde Ajustes > Datos.

Dos endpoints y ninguna lógica: lo que decide algo está en
`core/actualizacion.py`, que es lo que se puede probar sin un vigilante
instalado ni un Docker delante.

    GET  /api/actualizacion   estado, para pintar el panel
    POST /api/actualizacion   deja la señal para el vigilante del host

La aplicación no actualiza nada por sí misma —no puede, y el módulo de `core`
explica por qué—: solo deja la señal. Quien reconstruye y reinicia es
`docker-update.sh`, ejecutado desde el host, que es el único sitio desde el que
se puede reiniciar el contenedor de la aplicación sin matarse a media faena.
"""

import logging

from flask import Blueprint, jsonify

from core import actualizacion

log = logging.getLogger(__name__)

actualizacion_bp = Blueprint("actualizacion", __name__)


@actualizacion_bp.route("/api/actualizacion", methods=["GET"])
def get_actualizacion():
    return jsonify({"ok": True, **actualizacion.estado()})


@actualizacion_bp.route("/api/actualizacion", methods=["POST"])
def post_actualizacion():
    estado, error = actualizacion.solicitar()

    if error:
        # 409: no es un fallo de la petición, es que ya se está haciendo.
        return jsonify({"ok": False, "error": error, **estado}), 409

    return jsonify({"ok": True, **estado})
