"""¿Hay publicada una versión más nueva que la que está corriendo?

El botón de Ajustes lanzaba la actualización a ciegas: `docker-update.sh` hace
`git pull` y reconstruye la imagen aunque no haya nada que traer, y eso son un
par de minutos sin servicio para acabar en la misma versión. La única forma de
saberlo antes era entrar por SSH.

Aquí se mira, y solo se mira: esto no actualiza nada —no puede, y
`core/actualizacion.py` explica por qué—. Es la lectura de un fichero público.

**Por qué se lee `python/core/version.py` de la rama y no las releases.** El
repositorio no publica releases ni etiquetas —`git ls-remote --tags` no
devuelve nada—, así que preguntar por la «última release» daría siempre vacío.
Y lo que el servidor va a instalar no es una etiqueta: es lo que traiga
`git pull --ff-only` de la rama que tenga puesta. Leer la versión declarada en
esa misma rama responde exactamente a la pregunta que se hace quien mira el
panel —«si pulso, ¿a qué versión voy?»— en vez de a una parecida.

La respuesta se guarda en `data/tmp/` con su fecha: el panel se consulta al
abrir Ajustes, y otra vez cada 5 segundos mientras dura una actualización, y
GitHub no tiene por qué enterarse de eso. Los fallos también se recuerdan,
menos tiempo: sin ello, con GitHub caído cada carga del panel se comería el
timeout entero.
"""

import json
import logging
import re
import threading
from datetime import datetime
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from core import paths, settings
from core.escritura import escribirJsonAtomico
from core.version import __version__

log = logging.getLogger(__name__)

NOMBRE_CACHE = "actualizacion.remota"
RUTA_VERSION = "python/core/version.py"
PLANTILLA_URL = "https://raw.githubusercontent.com/{repositorio}/{rama}/" + RUTA_VERSION

# Un fallo se recuerda mucho menos que un acierto: puede ser un corte de un
# minuto, y dejar el panel diciendo «no se pudo comprobar» durante seis horas
# sería mentir por comodidad.
ESPERA_TRAS_FALLO_SEGUNDOS = 600

# Tope al «Comprobar» manual: forzar salta la caché, pero no permite pulsar
# treinta veces seguidas contra GitHub.
ESPERA_MINIMA_FORZADO_SEGUNDOS = 20

# version.py son 1,5 KB. El tope está por si esa URL acaba sirviendo otra cosa
# —una página de error, un repositorio equivocado—: se lee y se descarta sin
# cargar en memoria lo que mande el servidor.
MAX_BYTES = 64 * 1024

_PATRON_VERSION = re.compile(r'^__version__\s*=\s*"(\d+\.\d+\.\d+)"', re.M)
_PATRON_REPOSITORIO = re.compile(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$")
_PATRON_RAMA = re.compile(r"^[A-Za-z0-9._/-]+$")

# Dos pestañas abiertas no tienen por qué preguntar dos veces: la segunda espera
# a la primera y se encuentra la respuesta ya guardada.
_cerrojo = threading.Lock()


def _archivo_cache() -> Path:
    return paths.TMP_DIR / NOMBRE_CACHE


def _ahora() -> datetime:
    return datetime.now().astimezone()


def _segundos_desde(marca) -> float | None:
    try:
        momento = datetime.fromisoformat(str(marca))
    except (TypeError, ValueError):
        return None
    if momento.tzinfo is None:
        momento = momento.astimezone()
    return max(0.0, (_ahora() - momento).total_seconds())


def _tupla(version) -> tuple[int, ...] | None:
    try:
        partes = str(version).strip().split(".")
        return tuple(int(p) for p in partes) if len(partes) == 3 else None
    except (TypeError, ValueError):
        return None


def hayNueva(instalada, publicada) -> bool | None:
    """`True`, `False`, o `None` si alguna de las dos no es comparable.

    `None` no es lo mismo que `False`: el panel no debe decir «estás al día»
    cuando lo que pasa es que no ha podido saberlo.
    """
    a, b = _tupla(instalada), _tupla(publicada)
    if a is None or b is None:
        return None
    return b > a


def _url() -> str | None:
    repositorio = settings.actualizacionRepositorio().strip().strip("/")
    rama = settings.actualizacionRama().strip().strip("/")

    # El host es fijo, así que esto no puede acabar llamando a otro sitio; lo
    # que evita es que un valor con `..` o con espacios pida una ruta absurda.
    if not _PATRON_REPOSITORIO.match(repositorio) or not _PATRON_RAMA.match(rama):
        log.warning("Repositorio o rama no válidos: %r / %r", repositorio, rama)
        return None
    if ".." in repositorio or ".." in rama:
        return None

    return PLANTILLA_URL.format(repositorio=repositorio, rama=rama)


def _descargar(url: str) -> str:
    peticion = Request(url, headers={
        "User-Agent": f"PorfolioManager/{__version__}",
        "Accept": "text/plain",
    })
    with urlopen(peticion, timeout=settings.actualizacionTimeout()) as respuesta:
        return respuesta.read(MAX_BYTES).decode("utf-8", errors="replace")


def _extraer(texto) -> str | None:
    encontrado = _PATRON_VERSION.search(texto or "")
    return encontrado.group(1) if encontrado else None


def _leer_cache() -> dict | None:
    try:
        datos = json.loads(_archivo_cache().read_text("utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        log.warning("No se pudo leer %s: %s", NOMBRE_CACHE, error)
        return None
    return datos if isinstance(datos, dict) else None


def _guardar_cache(publicada, error) -> dict:
    datos = {"publicada": publicada, "error": error, "momento": _ahora().isoformat()}
    try:
        paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
        escribirJsonAtomico(_archivo_cache(), datos)
    except OSError as fallo:
        # Sin caché se sigue funcionando: solo se pregunta más de la cuenta.
        log.warning("No se pudo guardar %s: %s", NOMBRE_CACHE, fallo)
    return datos


def _vigente(cache, forzar: bool) -> bool:
    if not cache:
        return False
    edad = _segundos_desde(cache.get("momento"))
    if edad is None:
        return False
    if forzar:
        return edad < ESPERA_MINIMA_FORZADO_SEGUNDOS
    if cache.get("error"):
        return edad < ESPERA_TRAS_FALLO_SEGUNDOS
    return edad < settings.actualizacionCacheSegundos()


def _consultar_a_github() -> tuple[str | None, str | None]:
    """Devuelve `(version, error)`. De aquí no sale ninguna excepción."""
    url = _url()
    if url is None:
        return None, "El repositorio o la rama configurados no son válidos"

    try:
        publicada = _extraer(_descargar(url))
    except HTTPError as error:
        if error.code == 404:
            return None, "GitHub no encuentra el repositorio o la rama configurados"
        return None, f"GitHub respondió {error.code}"
    except (TimeoutError, URLError, OSError) as error:
        return None, f"No se pudo conectar con GitHub ({error})"

    if publicada is None:
        return None, "La respuesta de GitHub no declara ninguna versión"

    return publicada, None


def _respuesta(cache, activo=True) -> dict:
    publicada = (cache or {}).get("publicada")
    return {
        "activo": activo,
        "publicada": publicada,
        "hayNueva": hayNueva(__version__, publicada) if publicada else None,
        "comprobado": (cache or {}).get("momento"),
        "error": (cache or {}).get("error"),
        "repositorio": settings.actualizacionRepositorio(),
        "rama": settings.actualizacionRama(),
    }


def consultar(forzar: bool = False) -> dict:
    """Versión publicada, de la caché o preguntando. No lanza nunca."""
    if not settings.comprobarVersionRemota():
        return _respuesta(None, activo=False)

    cache = _leer_cache()
    if _vigente(cache, forzar):
        return _respuesta(cache)

    with _cerrojo:
        # Otra petición pudo preguntar mientras esta esperaba el cerrojo.
        cache = _leer_cache()
        if _vigente(cache, forzar):
            return _respuesta(cache)

        publicada, error = _consultar_a_github()
        if error:
            log.info("No se pudo comprobar la versión publicada: %s", error)
            # Se conserva la última versión conocida: saber que hace seis horas
            # había una 1.8.0 es más útil que un hueco por un corte de red.
            publicada = publicada or (cache or {}).get("publicada")
        cache = _guardar_cache(publicada, error)

    return _respuesta(cache)


__all__ = [
    "ESPERA_MINIMA_FORZADO_SEGUNDOS",
    "ESPERA_TRAS_FALLO_SEGUNDOS",
    "NOMBRE_CACHE",
    "consultar",
    "hayNueva",
]
