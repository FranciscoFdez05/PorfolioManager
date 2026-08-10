"""Firma HMAC-SHA256 para los endpoints del Atajo de iOS.

El Atajo no tiene sesión ni cookie CSRF, así que cada petición se autentica con
una firma sobre el cuerpo exacto que envía:

    mensaje = f"{timestamp}.{cuerpoRaw}"
    firma   = HMAC_SHA256(claveSecreta, mensaje)

El timestamp va en la cabecera X-Timestamp y entra en el mensaje firmado, de
modo que una petición capturada no se puede reenviar pasada la ventana de
tolerancia: el atacante no puede cambiar el timestamp sin invalidar la firma.

Los ajustes (tolerancia, tope de tamaño, ruta del fichero de clave) salen de la
sección [atajo] de config.ini. La clave en sí no: config.ini está versionado en
git, así que se guarda en el fichero que indique `fichero_clave` —por defecto
API/movimientos.key, ignorado por git y cifrado en reposo por core/secret_store—
o en la variable de entorno MOVIMIENTOS_SECRET_KEY.

Sin clave, todo esto falla en cerrado: no habría forma de distinguir una
petición legítima de una inventada, y dejar pasar sería peor que un error.
"""

import hashlib
import hmac
import logging
import os
import time

from core import settings
from core.paths import rutaDesdeBase
from core.secret_store import read_secret_lines

log = logging.getLogger(__name__)

SECCION = "atajo"
ENV_CLAVE = "MOVIMIENTOS_SECRET_KEY"
CABECERA_FIRMA = "X-Signature"
CABECERA_TIMESTAMP = "X-Timestamp"


class ErrorFirma(Exception):
    """Fallo de autenticación de la firma. Se traduce a 401 en las rutas."""

    def __init__(self, mensaje, status=401):
        super().__init__(mensaje)
        self.mensaje = str(mensaje)
        self.status = int(status)


def rutaFicheroClave():
    return rutaDesdeBase(settings.obtener("atajo.fichero_clave"))


def toleranciaSegundos():
    """Margen a cada lado del reloj del servidor, en segundos.

    El mínimo declarado en el catálogo evita que un 0 en config.ini deje la
    ventana tan cerrada que ninguna petición llegue nunca a tiempo.
    """
    return settings.obtener("atajo.tolerancia_segundos")


def maxTextoFirma():
    return settings.obtener("atajo.max_texto_firma")


def obtenerClaveSecreta():
    """Clave secreta en bytes, o ErrorFirma(503) si no está configurada.

    La variable de entorno tiene prioridad sobre el fichero para poder hacer un
    override puntual (por ejemplo en los tests) sin tocar API/.
    """
    desdeEntorno = os.environ.get(ENV_CLAVE, "").strip()

    if desdeEntorno:
        return desdeEntorno.encode("utf-8")

    ruta = rutaFicheroClave()
    lineas = read_secret_lines(ruta)

    if lineas and lineas[0]:
        return lineas[0].encode("utf-8")

    log.error(
        "[firma_hmac] Sin clave de firma: no existe %s ni está definida %s. "
        "Genérala con: python tools/generar_clave_movimientos.py",
        ruta.name, ENV_CLAVE,
    )
    raise ErrorFirma("Firma no configurada en el servidor", status=503)


def calcularFirma(mensaje, clave=None):
    """HMAC-SHA256 en hexadecimal del mensaje indicado."""
    if clave is None:
        clave = obtenerClaveSecreta()

    if isinstance(mensaje, str):
        mensaje = mensaje.encode("utf-8")

    return hmac.new(clave, mensaje, hashlib.sha256).hexdigest()


def construirMensaje(timestamp, cuerpoRaw):
    """Concatena timestamp y cuerpo tal y como se firman.

    El cuerpo se firma en bytes crudos, sin reserializar el JSON: cualquier
    diferencia de espaciado o de orden de claves cambiaría el hash y el Atajo y
    el servidor dejarían de coincidir.
    """
    if isinstance(cuerpoRaw, str):
        cuerpoRaw = cuerpoRaw.encode("utf-8")

    return str(timestamp).encode("utf-8") + b"." + (cuerpoRaw or b"")


def verificarTimestamp(valorCabecera, ahora=None):
    """Valida la cabecera X-Timestamp y la devuelve normalizada como int."""
    texto = str(valorCabecera or "").strip()

    if not texto:
        raise ErrorFirma("Falta la cabecera X-Timestamp")

    try:
        # El Atajo puede mandar "1754640000.123": se trunca a segundos.
        timestamp = int(float(texto))
    except ValueError:
        raise ErrorFirma("X-Timestamp inválido") from None

    if ahora is None:
        ahora = time.time()

    if abs(int(ahora) - timestamp) > toleranciaSegundos():
        raise ErrorFirma("X-Timestamp fuera de la ventana permitida")

    return timestamp


def verificarPeticionFirmada(cabeceras, cuerpoRaw, ahora=None):
    """Comprueba firma y timestamp de una petición. Lanza ErrorFirma si fallan.

    `cabeceras` es cualquier mapa con .get() insensible a mayúsculas
    (request.headers de Flask lo cumple).
    """
    firmaRecibida = str(cabeceras.get(CABECERA_FIRMA, "") or "").strip().lower()

    if not firmaRecibida:
        raise ErrorFirma("Falta la cabecera X-Signature")

    # Se lee la clave antes que nada: si falta, el error es 503 (configuración),
    # no 401 (credencial incorrecta).
    clave = obtenerClaveSecreta()
    timestamp = verificarTimestamp(cabeceras.get(CABECERA_TIMESTAMP), ahora=ahora)

    firmaEsperada = calcularFirma(construirMensaje(timestamp, cuerpoRaw), clave)

    if not hmac.compare_digest(firmaRecibida, firmaEsperada):
        raise ErrorFirma("Firma inválida")

    return timestamp
