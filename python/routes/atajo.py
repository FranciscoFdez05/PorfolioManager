"""Gestión del Atajo de iOS desde Ajustes > API.

Estos endpoints son los de la **web app**, no los del Atajo: pasan por la sesión
como el resto del panel. Los del Atajo (`/api/movimiento`, `/api/preparar`…)
viven en `routes/movimientos.py` y se autentican por IP y firma, porque un Atajo
no puede mantener una cookie.

    GET  /api/atajo             qué hay configurado y qué falta
    POST /api/atajo/clave       generar o rehacer la clave de firma
    POST /api/atajo/prueba      recorrer el camino sin escribir en la base de datos
    GET  /api/atajo/descargar   el fichero .shortcut para el iPhone

**Por qué la descarga pide sesión** aunque el fichero no lleve secretos dentro:
contiene la dirección por la que se entra al servidor, y no hay razón para
regalarla a quien pase por el puerto.
"""

import logging

from flask import Blueprint, jsonify, make_response, request

from core import atajo, atajo_shortcut, tls

log = logging.getLogger(__name__)

atajo_bp = Blueprint("atajo", __name__)


def _urlBase() -> str:
    """La dirección por la que el iPhone va a llamar al servidor.

    Se deduce del `Host` de esta misma petición, que es literalmente lo que el
    usuario tiene escrito en la barra del navegador: desde dentro del contenedor
    no hay forma de saber por qué dirección lo alcanzan. El esquema sale del
    estado del HTTPS y no de `request.scheme`, porque con el proxy delante lo que
    ve Flask es la conexión interna, en claro.
    """
    esquema = "https" if tls.httpsActivo() else "http"
    return f"{esquema}://{request.host}"


@atajo_bp.route("/api/atajo", methods=["GET"])
def get_atajo():
    return jsonify({"ok": True, **atajo.estado(_urlBase())})


@atajo_bp.route("/api/atajo/clave", methods=["POST"])
def post_clave():
    """Genera la clave de firma, o la rehace si ya había una.

    No pide confirmación aquí: la pide la interfaz, que es donde se puede
    explicar qué implica. Rehacerla invalida las firmas en vuelo —ninguna, en la
    práctica: viven segundos— pero no obliga a rehacer el Atajo del iPhone,
    porque el Atajo no guarda la clave.
    """
    fichero = atajo.generarClave()
    return jsonify({"ok": True, "fichero": fichero, **atajo.estado(_urlBase())})


@atajo_bp.route("/api/atajo/prueba", methods=["POST"])
def post_prueba():
    """Comprobación en seco. Siempre 200: que un paso falle es el resultado."""
    return jsonify({"ok": True, **atajo.probar()})


@atajo_bp.route("/api/atajo/descargar", methods=["GET"])
def get_descargar():
    """El `.shortcut` generado para esta instalación.

    `application/octet-stream` a propósito: con un tipo que iOS crea saber
    mostrar, Safari lo abre como texto en vez de ofrecer «Abrir en Atajos».
    """
    cuerpo = atajo_shortcut.construir(_urlBase())

    respuesta = make_response(cuerpo)
    respuesta.headers["Content-Type"] = "application/octet-stream"
    respuesta.headers["Content-Disposition"] = 'attachment; filename="PorfolioManager.shortcut"'
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta
