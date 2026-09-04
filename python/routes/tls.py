"""Encender y apagar el HTTPS desde Ajustes, y descargar la CA para instalarla.

Tres endpoints y ninguna lógica: todo lo que decide algo está en `core/tls.py`,
que es lo que se puede probar sin levantar un proxy.

    GET  /api/tls            estado actual, para pintar el panel
    POST /api/tls            activar o desactivar
    GET  /api/tls/ca.crt     certificado raíz, para instalar en cada aparato

**Por qué la descarga pide sesión** aunque un certificado raíz sea público por
definición: quien lo instala está decidiendo confiar en una autoridad para
*todos* los sitios que visite. Servirlo sin autenticar invita a que alguien
enlace a él desde fuera y consiga que se instale una CA que no es la suya.
"""

import logging

from flask import Blueprint, jsonify, make_response, request

from core import tls
from core.errors import ApiError, ValidationError

log = logging.getLogger(__name__)

tls_bp = Blueprint("tls", __name__)

# Tope de nombres. No hay un límite técnico en Caddy, pero cada nombre es un
# certificado que emitir y una entrada más en el SAN; una lista larga suele ser
# un error de pegado, no una necesidad.
MAX_NOMBRES = 20


def _estado_publico() -> dict:
    estado = tls.leerEstado()
    return {
        "activado": tls.httpsActivo(),
        "nombres": estado["nombres"],
        "actualizado": estado["actualizado"],
        "proxyDisponible": tls.proxyDisponible(),
        # Cuando el HTTPS viene impuesto por .env (dominio público con Let's
        # Encrypt), la interfaz no debe ofrecer un interruptor que machacaría
        # esa configuración. Se lo dice al frontend en vez de dejarle adivinar.
        "gestionadoPorEntorno": _gestionado_por_entorno(),
        # El nombre por el que ha llegado esta misma petición. Es la mejor
        # sugerencia posible para el certificado: es literalmente lo que el
        # usuario tiene escrito en la barra del navegador, y desde dentro de un
        # contenedor no hay forma de averiguar la IP de la LAN del host.
        "nombreActual": (request.host or "").split(":")[0],
    }


def _gestionado_por_entorno() -> bool:
    from core import settings

    return settings.httpsActivado()


@tls_bp.route("/api/tls", methods=["GET"])
def get_tls():
    return jsonify({"ok": True, **_estado_publico()})


@tls_bp.route("/api/tls", methods=["POST"])
def set_tls():
    if _gestionado_por_entorno():
        raise ApiError(
            "El HTTPS está fijado por la configuración del servidor "
            "(HTTPS_ENABLED en .env). Cámbialo allí, no desde aquí.",
            status_code=409,
        )

    datos = request.get_json(silent=True) or {}
    activar = bool(datos.get("activado"))
    nombres = tls.normalizarNombres(datos.get("nombres"))

    if activar:
        if not nombres:
            raise ValidationError(
                "Hace falta al menos un nombre o dirección IP: el certificado "
                "solo vale para los nombres que se declaren.",
                field="nombres",
            )
        if len(nombres) > MAX_NOMBRES:
            raise ValidationError(
                f"Demasiados nombres (máximo {MAX_NOMBRES}).", field="nombres",
            )

    try:
        tls.aplicar(activar, nombres)
    except tls.ErrorCaddy as e:
        # 502 y no 500: el fallo es del proxy, no de esta aplicación, y el
        # mensaje ya dice qué mirar.
        raise ApiError(str(e), status_code=502) from e

    # Solo se guarda si Caddy ha aceptado la configuración. Al revés, un estado
    # que dijera «HTTPS activo» sobre un proxy sirviendo en claro haría que las
    # cookies salieran con `Secure` y nadie pudiera iniciar sesión.
    estado = tls.guardarEstado(activar, nombres)

    # Las banderas de la cookie se leen de app.config en cada respuesta, así que
    # actualizarlas aquí surte efecto inmediato: la propia respuesta a esta
    # petición ya sale con la política nueva, sin reiniciar nada.
    from flask import current_app

    from core import seguridad_app

    seguridad_app.aplicar_configuracion_sesion(current_app)

    log.info(
        "[tls] HTTPS %s desde Ajustes para %s",
        "activado" if activar else "desactivado",
        ", ".join(nombres) or "(sin nombres)",
    )

    return jsonify({"ok": True, **_estado_publico(), "estado": estado})


@tls_bp.route("/api/tls/ca.crt", methods=["GET"])
def get_ca():
    """Certificado raíz en PEM, como descarga.

    El tipo es `application/x-x509-ca-cert` porque es el que hace que iOS ofrezca
    instalarlo como perfil en vez de enseñarlo como texto. En Android y en
    escritorio da igual: lo que manda es la extensión `.crt` del nombre.
    """
    try:
        pem = tls.raizDeLaCa()
    except tls.ErrorCaddy as e:
        raise ApiError(str(e), status_code=502) from e

    respuesta = make_response(pem)
    respuesta.headers["Content-Type"] = "application/x-x509-ca-cert"
    respuesta.headers["Content-Disposition"] = 'attachment; filename="PorfolioManager-CA.crt"'
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta
