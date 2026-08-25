"""Comprobación de salud del proceso.

Existe por el healthcheck de docker-compose, que antes apuntaba a `/login`.
Esa página se renderiza leyendo un HTML del disco y no toca la base de datos,
así que respondía 200 con la BD corrupta, con el volumen de datos sin montar o
con el disco lleno: exactamente los tres casos en los que quieres que el
contenedor se marque como enfermo y se reinicie.

`GET /api/health` sí abre la base de datos activa y ejecuta una consulta. Es la
diferencia entre "el proceso de Python sigue vivo" y "la aplicación puede
atender una petición".

**Qué se publica sin sesión.** El endpoint es público —un healthcheck no tiene
cookies— así que la respuesta anónima se limita a si está sano y a la versión.
Las rutas del disco, el nombre del portfolio activo o el número de filas solo
salen con la sesión abierta: son datos del usuario, y un endpoint de diagnóstico
es un sitio clásico por donde se escapan.
"""

import logging
import time

from flask import Blueprint, jsonify, session

from core import db, settings

log = logging.getLogger(__name__)

salud_bp = Blueprint("salud", __name__)

VERSION = "1.0.0"

# Momento de importación del módulo, que en la práctica es el arranque del
# worker. Sirve para distinguir "lleva días en pie" de "se acaba de reiniciar
# solo", que es la primera pregunta cuando algo va raro.
_ARRANQUE = time.monotonic()


def _comprobar_bd():
    """(sano, detalle) de la base de datos activa.

    Se usa `PRAGMA quick_check` y no `integrity_check`: el rápido recorre la
    estructura sin verificar todos los índices, tarda milisegundos en una BD de
    tamaño normal y detecta igualmente el fichero truncado o corrupto, que es
    lo que importa aquí. Un healthcheck que tarda medio minuto es un
    healthcheck que acaba dando falsos positivos por timeout.
    """
    detalle = {}
    try:
        conexion = db.get_db()
        conexion.execute("SELECT 1").fetchone()

        resultado = conexion.execute("PRAGMA quick_check(1)").fetchone()
        estado_bd = (resultado[0] if resultado else "sin respuesta").lower()
        if estado_bd != "ok":
            return False, {"bd": "corrupta", "detalle": estado_bd}

        detalle["esquema"] = conexion.execute("PRAGMA user_version").fetchone()[0]
        detalle["journal_mode"] = conexion.execute("PRAGMA journal_mode").fetchone()[0]
        return True, detalle
    except Exception as error:
        # Sin traza completa: este endpoint lo llama el orquestador cada 30
        # segundos, y una BD caída llenaría el log de trazas idénticas.
        log.warning("Healthcheck: la base de datos no responde: %s", error)
        return False, {"bd": "no disponible", "detalle": str(error)[:200]}


@salud_bp.route("/api/health", methods=["GET"])
def getHealth():
    sano, detalle = _comprobar_bd()

    respuesta = {
        "ok": sano,
        "estado": "ok" if sano else "degradado",
        "version": VERSION,
    }

    # A partir de aquí, solo para quien ya ha iniciado sesión.
    if session.get("logged_in"):
        respuesta["uptime_segundos"] = round(time.monotonic() - _ARRANQUE)
        respuesta["bd"] = detalle
        try:
            ruta = db.get_active_db_path()
            respuesta["bd"]["ruta"] = str(ruta)
            respuesta["bd"]["tamano_bytes"] = ruta.stat().st_size if ruta.exists() else 0
        except Exception as error:
            respuesta["bd"]["ruta"] = f"no disponible: {error}"

        try:
            from admin.portfolios_manager import get_active_portfolio_id

            respuesta["portfolio_activo"] = get_active_portfolio_id()
        except Exception as error:
            respuesta["portfolio_activo"] = f"no disponible: {error}"

        respuesta["debug"] = settings.modoDebug()
    elif not sano:
        # Al anónimo se le dice qué subsistema falla, pero no el mensaje del
        # motor: puede llevar rutas absolutas del servidor.
        respuesta["fallo"] = detalle.get("bd", "desconocido")

    # 503 y no 200: es lo que hace que docker/k8s marquen el contenedor como
    # no sano. Con 200 el healthcheck pasaría igual y no serviría de nada.
    return jsonify(respuesta), (200 if sano else 503)
