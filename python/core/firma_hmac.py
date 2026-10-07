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
import json
import logging
import os
import secrets
import time
from pathlib import Path

from core import paths, settings
from core.bloqueo import BloqueoOcupado, exclusivo
from core.escritura import escribirJsonAtomico
from core.secret_store import read_secret_lines, write_secret_lines

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
    """Fichero de la clave HMAC.

    Las rutas relativas son relativas al directorio de claves ([rutas] claves),
    donde viven las demás. Antes lo eran a la raíz del proyecto: con ese
    directorio movido (un volumen aparte, por ejemplo), la clave del Atajo se
    seguía buscando en `<raíz>/API`. El valor de siempre, `API/movimientos.key`,
    se entiende como «movimientos.key en el directorio de claves», que es lo
    que significaba con la configuración por defecto.
    """
    ruta = Path(settings.obtener("atajo.fichero_clave")).expanduser()
    if ruta.is_absolute():
        return ruta
    if ruta.parts and ruta.parts[0] == "API":
        ruta = Path(*ruta.parts[1:]) if len(ruta.parts) > 1 else Path("movimientos.key")
    return paths.API_DIR / ruta


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

    if ruta.exists():
        # Dos averías con soluciones opuestas —generar otra clave, o recuperar
        # la SECRET_KEY— que antes se veían idénticas en el log, porque las dos
        # acaban en una lista de líneas vacía.
        log.error(
            "[firma_hmac] %s existe pero no se ha podido leer ninguna clave de él. "
            "Lo normal es que la SECRET_KEY del .env haya cambiado desde que se "
            "guardó: recupérala, o genera una clave nueva desde Ajustes > API.",
            ruta.name,
        )
    else:
        log.error(
            "[firma_hmac] Sin clave de firma: no existe %s ni está definida %s. "
            "Genérala desde Ajustes > API, o con: python tools/generar_clave_movimientos.py",
            ruta.name, ENV_CLAVE,
        )

    raise ErrorFirma("Firma no configurada en el servidor", status=503)


# 32 bytes = 256 bits, el mismo tamaño que la salida de SHA-256. Más longitud no
# aporta seguridad frente a HMAC-SHA256.
BYTES_CLAVE = 32


def generarClave() -> str:
    """Una clave nueva, en hexadecimal."""
    return secrets.token_hex(BYTES_CLAVE)


def escribirClaveNueva(ruta=None):
    """Genera una clave y la guarda cifrada en su fichero.

    Vive aquí y no en la herramienta de línea de comandos porque ahora hay dos
    sitios que la crean —`tools/generar_clave_movimientos.py` y el botón de
    Ajustes > API— y dos copias de esto acabarían generando claves de distinto
    tamaño o guardándolas de distinta forma.
    """
    destino = ruta or rutaFicheroClave()
    destino.parent.mkdir(parents=True, exist_ok=True)
    write_secret_lines(destino, [generarClave()])
    return destino

def calcularFirma(mensaje, clave=None):
    """HMAC-SHA256 en hexadecimal del mensaje indicado."""
    if clave is None:
        clave = obtenerClaveSecreta()

    if isinstance(mensaje, str):
        mensaje = mensaje.encode("utf-8")

    return hmac.new(clave, mensaje, hashlib.sha256).hexdigest()


# ── Token de dispositivo ──────────────────────────────────────────────────────
# La firma sola no autenticaba a nadie: el Atajo no puede calcular un HMAC, así
# que se la pedía a /api/preparar, y ese endpoint firmaba para cualquiera que
# llegase desde una red permitida. Cualquier equipo de la LAN podía apuntar
# gastos sin conocer la clave. El token es el secreto que sí lleva el Atajo: va
# dentro del .shortcut (que solo se descarga con sesión) y se manda en todas las
# llamadas. Se deriva de la clave de firma, así que rehacer la clave en Ajustes
# lo revoca sin guardar nada más.
CABECERA_TOKEN = "X-Atajo-Token"
_CONTEXTO_TOKEN = b"PorfolioManager/atajo/token-dispositivo/v1"


def tokenDispositivo(clave=None):
    """El token que el Atajo tiene que mandar en `X-Atajo-Token`."""
    if clave is None:
        clave = obtenerClaveSecreta()
    return hmac.new(clave, _CONTEXTO_TOKEN, hashlib.sha256).hexdigest()


def verificarTokenDispositivo(cabeceras):
    """ErrorFirma(401) si falta el token o no es el de esta instalación."""
    recibido = str(cabeceras.get(CABECERA_TOKEN, "") or "").strip().lower()
    # La clave se lee antes: si falta, el error es 503 (configuración), no 401.
    esperado = tokenDispositivo()
    if not recibido:
        raise ErrorFirma(
            "Este Atajo no lleva el token de acceso. Vuelve a descargarlo desde "
            "Ajustes > API > Atajo de iOS."
        )
    if not hmac.compare_digest(recibido, esperado):
        raise ErrorFirma(
            "El token del Atajo no es válido (¿se rehízo la clave?). Vuelve a "
            "descargarlo desde Ajustes > API > Atajo de iOS."
        )


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
    except (ValueError, OverflowError):
        # OverflowError: "inf" es un float válido pero no cabe en un int, y
        # sin capturarlo la petición acababa en un 500 en vez de en un 401.
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

    marcarFirmaUsada(firmaEsperada, timestamp)
    return timestamp


# ── Firmas de un solo uso ─────────────────────────────────────────────────────
# El timestamp limita cuánto vale una petición capturada, pero no cuántas veces:
# dentro de la ventana de tolerancia, la misma petición firmada se podía
# reenviar y cada envío creaba otro movimiento. Se recuerdan las firmas ya
# aceptadas hasta que su timestamp sale de la ventana. Va a disco y con bloqueo
# entre procesos porque con dos workers la repetición podía entrar por el otro.


def _ficheroFirmasUsadas():
    # Se lee `paths.TMP_DIR` en cada llamada para seguir a donde apunte (los
    # tests lo redirigen a un temporal).
    return paths.TMP_DIR / "atajo-firmas-usadas.json"


def marcarFirmaUsada(firma, timestamp, ahora=None):
    """Anota `firma` como usada. ErrorFirma(401) si ya lo estaba."""
    ruta = _ficheroFirmasUsadas()
    ahora = time.time() if ahora is None else ahora
    try:
        with exclusivo(ruta.with_suffix(".lock"), espera=5):
            try:
                usadas = json.loads(ruta.read_text("utf-8"))
                if not isinstance(usadas, dict):
                    usadas = {}
            except (OSError, ValueError):
                usadas = {}

            usadas = {f: caduca for f, caduca in usadas.items()
                      if isinstance(caduca, (int, float)) and caduca > ahora}
            if firma in usadas:
                raise ErrorFirma("Petición repetida: esta firma ya se usó")

            usadas[firma] = int(timestamp) + toleranciaSegundos() + 1
            escribirJsonAtomico(ruta, usadas, indent=None)
    except BloqueoOcupado:
        raise ErrorFirma("Servidor ocupado; inténtalo de nuevo", status=503) from None
