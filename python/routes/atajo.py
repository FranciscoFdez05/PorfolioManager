"""Gestión del Atajo de iOS desde Ajustes > API.

Estos endpoints son los de la **web app**, no los del Atajo: pasan por la sesión
como el resto del panel. Los del Atajo (`/api/movimiento`, `/api/preparar`…)
viven en `routes/movimientos.py` y se autentican por IP y firma, porque un Atajo
no puede mantener una cookie.

    GET  /api/atajo             qué hay configurado y qué falta
    POST /api/atajo/clave       generar o rehacer la clave de firma
    POST /api/atajo/prueba      recorrer el camino sin escribir en la base de datos
    POST /api/atajo/acceso      firma exigida o no, y desde qué redes se acepta
    GET  /api/atajo/descargar   el fichero .shortcut para el iPhone

**Por qué la descarga pide sesión** aunque el fichero no lleve secretos dentro:
contiene la dirección por la que se entra al servidor, y no hay razón para
regalarla a quien pase por el puerto.
"""

import logging

from flask import Blueprint, jsonify, make_response, request

from core import atajo, atajo_acceso, atajo_shortcut, red_local, tls
from core.errors import ValidationError

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


def _comoTeVeElServidor() -> dict:
    """Con qué IP llega esta misma petición, y si esa IP pasaría el filtro.

    En Docker hay un proxy delante siempre, así que la IP que ve la aplicación
    es la de Caddy salvo que `PROXY_FIX_HOPS` esté bien puesto. Cuando no lo
    está, el filtro de red deja de discriminar nada y el síntoma es
    desconcertante: el Atajo falla desde el móvil con la IP correcta escrita en
    los rangos. Enseñar aquí la IP de verdad convierte media hora de log en un
    vistazo —y es lo primero que hay que mirar si se ha quitado la firma, porque
    entonces esto es la única barrera que queda—.
    """
    ip = red_local.obtenerIpCliente()
    return {"ip": ip or "desconocida", "permitida": red_local.ipEstaPermitida(ip)}


@atajo_bp.route("/api/atajo", methods=["GET"])
def get_atajo():
    return jsonify({"ok": True, "verTe": _comoTeVeElServidor(), **atajo.estado(_urlBase())})


@atajo_bp.route("/api/atajo/acceso", methods=["POST"])
def post_acceso():
    """Guarda quién puede escribir por los endpoints del Atajo.

    Dos cosas y las dos delicadas: si hay que comprobar la firma, y desde qué
    redes se acepta. Quitar la firma deja la red de origen como única barrera, y
    eso se dice en la interfaz, en el log de arranque y aquí.
    """
    datos = request.get_json(silent=True) or {}
    exigir = datos.get("exigirFirma")
    if exigir is None:
        raise ValidationError("Falta «exigirFirma».", field="exigirFirma")

    redes = atajo_acceso.normalizarRedes(datos.get("redes"))
    if len(redes) > atajo_acceso.MAX_REDES:
        raise ValidationError(
            f"Demasiados rangos (máximo {atajo_acceso.MAX_REDES}).", field="redes",
        )

    # Un rango que llega y no sobrevive a la normalización es un rango mal
    # escrito, y guardarlo en silencio dejaría al usuario creyendo que ha
    # permitido algo que no ha permitido.
    escritos = [r for r in (datos.get("redes") or []) if str(r).strip()]
    if escritos and not redes:
        raise ValidationError(
            "Ninguno de esos rangos es una red válida. Se escriben como "
            "192.168.1.0/24, o como una IP suelta con /32.",
            field="redes",
        )

    estado = atajo_acceso.guardar(bool(exigir), redes)

    log.warning(
        "[atajo] Acceso cambiado desde Ajustes: firma %s, redes %s",
        "exigida" if estado["exigirFirma"] else "NO exigida",
        ", ".join(atajo_acceso.redesEfectivas()) or "(ninguna)",
    )

    return jsonify({"ok": True, "verTe": _comoTeVeElServidor(), **atajo.estado(_urlBase())})


@atajo_bp.route("/api/atajo/clave", methods=["POST"])
def post_clave():
    """Genera la clave de firma, o la rehace si ya había una.

    No pide confirmación aquí: la pide la interfaz, que es donde se puede
    explicar qué implica. Rehacerla invalida las firmas en vuelo —ninguna, en la
    práctica: viven segundos— pero no obliga a rehacer el Atajo del iPhone,
    porque el Atajo no guarda la clave.
    """
    fichero = atajo.generarClave()
    return jsonify({"ok": True, "verTe": _comoTeVeElServidor(), "fichero": fichero, **atajo.estado(_urlBase())})


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
