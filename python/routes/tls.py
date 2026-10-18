"""Encender y apagar el HTTPS desde Ajustes, y descargar la CA para instalarla.

Endpoints y ninguna lógica: todo lo que decide algo está en `core/tls.py`, que
es lo que se puede probar sin levantar un proxy.

    GET  /api/tls            estado actual, para pintar el panel
    POST /api/tls/preparar   emitir el certificado sin encender nada todavía
    POST /api/tls            activar o desactivar
    POST /api/tls/comprobacion  levantar el puerto donde se comprueba desde el aparato
    GET  /api/tls/prueba     comprobación real del cifrado, nombre por nombre
    GET  /api/tls/ca.crt     certificado raíz, para instalar en cada aparato

**Por qué preparar y activar son dos peticiones.** Porque la respuesta a activar
llega por un puerto que para entonces ya solo habla TLS: si el certificado no
estaba instalado antes, el navegador corta ahí y el usuario se queda fuera sin
haber podido descargarlo. `preparar` emite exactamente lo mismo dejando el
puerto en claro, así que la instalación ocurre con la sesión intacta y activar
pasa a ser el último paso en vez del primero.

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

tlsBp = Blueprint("tls", __name__)

# Tope de nombres. No hay un límite técnico en Caddy, pero cada nombre es un
# certificado que emitir y una entrada más en el SAN; una lista larga suele ser
# un error de pegado, no una necesidad.
MAX_NOMBRES = 20


def _estadoPublico() -> dict:
    estado = tls.leerEstado()
    proxy = tls.proxyDisponible()
    return {
        "activado": tls.httpsActivo(),
        "nombres": estado["nombres"],
        "actualizado": estado["actualizado"],
        "proxyDisponible": proxy,
        # Si ya hay CA, el panel ofrece el certificado antes de encender nada:
        # es lo que separa «instálalo con calma» de «instálalo desde el otro
        # lado del aviso que acabas de provocar». Se pregunta solo con el proxy
        # en pie porque sin él la respuesta sería que no, pero por otro motivo.
        "caDisponible": proxy and tls.caDisponible(),
        # El puerto donde vive la página de comprobación. Lo necesita el
        # frontend para armar la URL con el nombre por el que ha entrado ESTE
        # aparato, que es el único que sabe el navegador y no el servidor.
        "puertoPrueba": tls.PUERTO_PREPARACION,
        # Cuando el HTTPS viene impuesto por .env (dominio público con Let's
        # Encrypt), la interfaz no debe ofrecer un interruptor que machacaría
        # esa configuración. Se lo dice al frontend en vez de dejarle adivinar.
        "gestionadoPorEntorno": _gestionadoPorEntorno(),
        # El nombre por el que ha llegado esta misma petición. Es la mejor
        # sugerencia posible para el certificado: es literalmente lo que el
        # usuario tiene escrito en la barra del navegador, y desde dentro de un
        # contenedor no hay forma de averiguar la IP de la LAN del host.
        "nombreActual": (request.host or "").split(":")[0],
        # Con qué llega relleno el campo cuando aún no hay nada guardado: el
        # nombre de la barra más la IP de la LAN, que es la que se olvida y la
        # que hace falta para entrar desde el móvil.
        "nombresSugeridos": tls.nombresSugeridos(request.host or ""),
    }


def _gestionadoPorEntorno() -> bool:
    from core import settings

    return settings.httpsActivado()


def _validarNombres(nombres: list[str]) -> None:
    """Las dos condiciones que tiene que cumplir la lista para emitir con ella.

    Vale igual para preparar y para activar: el certificado que se emite es el
    mismo, y lo que se rechace en el primer paso no puede colarse en el segundo.
    """
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


def _validarQueNoTeDejaFuera(nombres: list[str]) -> None:
    """No se activa el HTTPS para una lista que no cubra por dónde estás entrando.

    Es la única forma de quedarse fuera, y no puede ser lo que nadie quería: al
    saltar a `https://` por esa misma dirección, el certificado no la cubre, el
    navegador corta, y la pantalla desde la que se arregla queda justo detrás
    del aviso. Emitir un certificado que no vale para la dirección con la que
    entras no es una preferencia discutible, es el error de siempre —el que
    convierte «activar el HTTPS» en «perder el acceso»—, así que se rechaza.

    localhost y 127.0.0.1 no hace falta escribirlos: van siempre.
    """
    actual = (request.host or "").split(":")[0]
    if tls.cubre(nombres, actual):
        return

    raise ValidationError(
        f"Estás entrando por «{actual}» y el certificado no cubriría esa "
        f"dirección: al activar el HTTPS, tu propio navegador rechazaría la "
        f"conexión y esta pantalla quedaría detrás del aviso. Añade «{actual}» "
        f"a la lista y vuelve a emitir el certificado.",
        field="nombres",
    )


@tlsBp.route("/api/tls", methods=["GET"])
def getTls():
    return jsonify({"ok": True, **_estadoPublico()})


@tlsBp.route("/api/tls/preparar", methods=["POST"])
def postPreparar():
    """Emite el certificado y deja la CA lista para descargar, sin encender nada.

    Al terminar, la conexión sigue exactamente igual que estaba —mismo puerto,
    mismo esquema, misma sesión—: lo único que ha cambiado es que ya hay algo
    que instalar en el móvil y en el portátil.
    """
    if _gestionadoPorEntorno():
        raise ApiError(
            "El HTTPS está fijado por la configuración del servidor "
            "(HTTPS_ENABLED en .env). Cámbialo allí, no desde aquí.",
            statusCode=409,
        )
    if tls.httpsActivo():
        raise ApiError(
            "El HTTPS ya está activo: el certificado se descarga directamente "
            "desde este mismo panel.",
            statusCode=409,
        )

    datos = request.get_json(silent=True) or {}
    nombres = tls.normalizarNombres(datos.get("nombres"))
    _validarNombres(nombres)

    try:
        tls.preparar(nombres)
    except tls.ErrorCaddy as e:
        raise ApiError(str(e), statusCode=502) from e

    # Se guardan los nombres pero NO se enciende. Así el panel los recuerda si se
    # recarga la página entre instalar el certificado y pulsar «Activar» —que es
    # justo lo que se va a hacer, porque instalar la CA lleva a Ajustes del
    # móvil y de vuelta—, y el estado sigue diciendo la verdad: esto todavía va
    # en claro, y las cookies siguen saliendo sin `Secure`.
    tls.guardarEstado(False, nombres)

    log.info(
        "[tls] certificado preparado para %s; el HTTPS sigue sin activar",
        ", ".join(nombres),
    )

    return jsonify({"ok": True, **_estadoPublico()})


@tlsBp.route("/api/tls", methods=["POST"])
def setTls():
    if _gestionadoPorEntorno():
        raise ApiError(
            "El HTTPS está fijado por la configuración del servidor "
            "(HTTPS_ENABLED en .env). Cámbialo allí, no desde aquí.",
            statusCode=409,
        )

    datos = request.get_json(silent=True) or {}
    activar = bool(datos.get("activado"))
    nombres = tls.normalizarNombres(datos.get("nombres"))

    if activar:
        _validarNombres(nombres)
        _validarQueNoTeDejaFuera(nombres)

    try:
        tls.aplicar(activar, nombres)
    except tls.ErrorCaddy as e:
        # 502 y no 500: el fallo es del proxy, no de esta aplicación, y el
        # mensaje ya dice qué mirar.
        raise ApiError(str(e), statusCode=502) from e

    # Solo se guarda si Caddy ha aceptado la configuración. Al revés, un estado
    # que dijera «HTTPS activo» sobre un proxy sirviendo en claro haría que las
    # cookies salieran con `Secure` y nadie pudiera iniciar sesión.
    estado = tls.guardarEstado(activar, nombres)

    # Las banderas de la cookie se leen de app.config en cada respuesta, así que
    # actualizarlas aquí surte efecto inmediato: la propia respuesta a esta
    # petición ya sale con la política nueva, sin reiniciar nada.
    from flask import current_app

    from core import seguridad_app

    seguridad_app.aplicarConfiguracionSesion(current_app)

    log.info(
        "[tls] HTTPS %s desde Ajustes para %s",
        "activado" if activar else "desactivado",
        ", ".join(nombres) or "(sin nombres)",
    )

    return jsonify({"ok": True, **_estadoPublico(), "estado": estado})


@tlsBp.route("/api/tls/comprobacion", methods=["POST"])
def postComprobacion():
    """Deja en pie el puerto de comprobación, para que se pueda abrir desde aquí.

    Hace falta porque ese sitio no sobrevive a un reinicio: al arrancar se
    reaplica el estado guardado, y con el HTTPS apagado ahí no hay ningún TLS.
    Sin esto, «Probar en este aparato» lleva a una conexión rechazada, que es el
    peor mensaje posible: parece que el certificado está mal cuando lo que pasa
    es que no hay nada escuchando, y manda a revisar lo que no toca.

    Con el HTTPS ya activo no hay nada que levantar: el sitio de comprobación va
    en la misma configuración que sirve la aplicación.
    """
    if tls.httpsActivo():
        return jsonify({"ok": True, "listo": True, "puerto": tls.PUERTO_PREPARACION})

    estado = tls.leerEstado()
    if not estado["nombres"]:
        raise ApiError(
            "Todavía no hay ningún certificado que comprobar. Pulsa «Emitir el "
            "certificado».",
            statusCode=409,
        )

    try:
        if not tls.sitioDePruebaLevantado():
            tls.aplicar(False, estado["nombres"], preparando=True)
    except tls.ErrorCaddy as e:
        raise ApiError(str(e), statusCode=502) from e

    return jsonify({"ok": True, "listo": True, "puerto": tls.PUERTO_PREPARACION})


@tlsBp.route("/api/tls/prueba", methods=["GET"])
def getPrueba():
    """¿Está el cifrado como el usuario cree que está?

    Vale en los dos estados: con el HTTPS puesto comprueba el puerto de siempre
    y, antes de encenderlo, el de preparación, que sirve el mismo certificado.
    Eso convierte la comprobación en algo que se puede hacer **antes** de
    apostarse la sesión, en vez de en un diagnóstico póstumo.

    No devuelve error aunque la comprobación salga mal: que un nombre no esté
    cubierto es un resultado, no un fallo de la petición, y la interfaz necesita
    pintarlo entero (qué nombre falla y por qué) en vez de un 500 sin detalle.
    Solo el proxy caído o la CA ausente llenan `error`, y también con 200.
    """
    return jsonify({"ok": True, "puertoPrueba": tls.PUERTO_PREPARACION, **tls.probar()})


@tlsBp.route("/api/tls/ca.crt", methods=["GET"])
def getCa():
    """Certificado raíz en PEM, como descarga.

    El tipo es `application/x-x509-ca-cert` porque es el que hace que iOS ofrezca
    instalarlo como perfil en vez de enseñarlo como texto. En Android y en
    escritorio da igual: lo que manda es la extensión `.crt` del nombre.
    """
    try:
        pem = tls.raizDeLaCa()
    except tls.ErrorCaddy as e:
        raise ApiError(str(e), statusCode=502) from e

    respuesta = make_response(pem)
    respuesta.headers["Content-Type"] = "application/x-x509-ca-cert"
    respuesta.headers["Content-Disposition"] = 'attachment; filename="PorfolioManager-CA.crt"'
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta
