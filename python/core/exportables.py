"""Lo que viaja en el ZIP además de los datos: preferencias de interfaz y claves.

El export llevaba la base de datos y los ajustes del servidor, y aun así
restaurar en una máquina limpia dejaba la aplicación irreconocible: las tarjetas
de Ajustes en otro orden, las tablas ordenadas por otra columna, las métricas en
otra vista. Todo eso vive en el `localStorage` del navegador, que el servidor no
ve, así que no había forma de que entrara en un fichero generado por el
servidor. Ahora lo manda el navegador en la propia petición de exportar y aquí
se sanea antes de meterlo en el ZIP.

Las claves de API son el otro hueco, y el que más dolía: una reinstalación
limpia se las llevaba por delante —están cifradas con `SECRET_KEY`, y esa se
regenera— y había que volver a pedirlas proveedor por proveedor. Van **en
claro** dentro del ZIP, porque cifradas solo se podrían restaurar en un servidor
que conservase la misma `SECRET_KEY`, que es justo el caso en el que no hacían
falta. Eso convierte el ZIP en un secreto, así que **solo se incluyen si se
piden explícitamente** y la interfaz lo advierte antes de descargar.
"""

import logging

from core import firma_hmac, paths
from core.secret_store import read_secret_lines, write_secret_lines
from stores import app_data

log = logging.getLogger(__name__)

# Nombres de los ficheros dentro del ZIP.
FICHERO_UI = "ui.json"
FICHERO_CLAVES = "claves-api.json"

# Topes del volcado de interfaz. Lo manda el navegador, así que entra sin
# validar en un fichero que luego se guarda: sin límites, una pestaña con el
# almacenamiento lleno convertiría el export en un ZIP de decenas de megas.
MAX_CLAVES_UI = 500
MAX_LARGO_CLAVE = 200
MAX_LARGO_VALOR = 64 * 1024
MAX_TOTAL_UI = 1024 * 1024

# La clave del Atajo no está en API_KEY_SOURCES —no es un proveedor de
# cotizaciones— pero se pierde en una reinstalación exactamente igual, y
# rehacerla obliga a volver a montar el Atajo en el iPhone.
CLAVE_ATAJO = "atajo"


def destinoDe(proveedor):
    """Fichero donde vive la clave de ese proveedor, o None si no lo conocemos.

    Se resuelve en cada llamada y no al importar el módulo: así apunta siempre a
    donde diga la configuración vigente, y una prueba que redirige `API/` a un
    directorio temporal no acaba escribiendo en el de verdad.
    """
    if proveedor == CLAVE_ATAJO:
        return firma_hmac.rutaFicheroClave()
    if proveedor in app_data.API_KEY_SOURCES:
        return paths.API_DIR / app_data.API_KEY_SOURCES[proveedor][1]
    return None


def sanearUi(datos) -> dict:
    """Deja el volcado de `localStorage` en algo seguro de guardar.

    Se descarta en silencio lo que no encaja en vez de rechazar el export
    entero: el usuario ha pedido una copia de sus datos, y perderla porque una
    extensión del navegador dejó una entrada rara en el almacenamiento sería un
    intercambio pésimo. Lo descartado se cuenta en el log.
    """
    if not isinstance(datos, dict):
        return {}

    limpio = {}
    total = 0
    descartadas = 0

    for clave, valor in datos.items():
        # localStorage solo guarda cadenas; cualquier otra cosa viene de alguien
        # que no es la aplicación.
        if not isinstance(clave, str) or not isinstance(valor, str):
            descartadas += 1
            continue
        if len(clave) > MAX_LARGO_CLAVE or len(valor) > MAX_LARGO_VALOR:
            descartadas += 1
            continue
        if len(limpio) >= MAX_CLAVES_UI or total + len(valor) > MAX_TOTAL_UI:
            descartadas += 1
            continue

        limpio[clave] = valor
        total += len(valor)

    if descartadas:
        log.info("[export] %d entradas de interfaz descartadas por tamaño o tipo", descartadas)

    return limpio


def clavesEnClaro() -> dict:
    """Las claves que el servidor usa de verdad, descifradas.

    Se piden a `readApiKeysConOrigen()` y no a los ficheros para que salga lo que
    de verdad está en uso: si las claves vienen del `.env`, los ficheros de
    `API/` están vacíos y una copia de ellos sería una copia de nada.
    """
    claves = {}

    for proveedor in app_data.API_KEY_SOURCES:
        origen = app_data.readApiKeysConOrigen(proveedor)
        if origen["claves"]:
            claves[proveedor] = list(origen["claves"])

    atajo = read_secret_lines(firma_hmac.rutaFicheroClave())
    if atajo:
        claves[CLAVE_ATAJO] = [atajo[0]]

    return claves


def restaurarClaves(claves) -> list:
    """Escribe las claves del ZIP en `API/`, cifradas con la SECRET_KEY de aquí.

    Ese cambio de cifrado es el sentido de todo esto: entran en claro desde el
    ZIP y salen guardadas con la clave de **esta** instalación, que es lo que
    hace que una copia sirva para restaurar en un servidor recién montado.

    Devuelve los ficheros escritos, para poder decirlo en la respuesta.
    """
    if not isinstance(claves, dict):
        return []

    escritos = []

    for proveedor, valores in claves.items():
        destino = destinoDe(proveedor)
        if destino is None:
            # Un nombre inventado escribiría un fichero arbitrario dentro de
            # API/: solo se aceptan los proveedores que la aplicación conoce.
            log.warning("[import] Clave de proveedor desconocido, se ignora: %r", proveedor)
            continue

        utiles = [str(v).strip() for v in (valores or []) if str(v).strip()]
        if not utiles:
            continue

        write_secret_lines(destino, utiles)
        escritos.append(destino.name)

    return escritos
