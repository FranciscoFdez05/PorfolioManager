"""Pedir una actualización desde Ajustes, sin que la aplicación pueda hacerla.

`docker-update.sh` hace `git pull`, reconstruye la imagen, levanta el contenedor
nuevo, espera a que `/api/health` responda y, si no responde, vuelve solo a la
imagen anterior. Es lo que hace que actualizar sea seguro, y **no puede lanzarlo
esta aplicación**, por tres motivos que no son un descuido sino el diseño:

* Dentro del contenedor no hay Docker. Solo están montados `data/`, `logs/` y
  `API/`: ni el socket ni el CLI, así que no hay a quién pedirle nada.
* Tampoco hay repositorio: el código va horneado en la imagen, y el `git pull`
  necesita el checkout del host.
* Y aunque lo hubiera, el script para y recrea **el contenedor que lo está
  ejecutando**. El proceso moriría a mitad, justo antes de la comprobación de
  arranque y del retroceso automático: quedaría una actualización sin red.

Así que aquí no se actualiza nada. Se deja una **señal** en un fichero del
volumen compartido, y un vigilante del host —un temporizador de systemd, ver
`tools/actualizador/`— la recoge y ejecuta el script con todas sus garantías,
desde fuera del contenedor que se va a reiniciar.

El canal son dos ficheros en `data/tmp/`:

* ``actualizacion.solicitada`` — lo escribe la aplicación al pulsar el botón.
* ``actualizacion.estado``     — lo escribe el vigilante: en marcha, bien o mal.

Que el vigilante no haya escrito nunca ese segundo fichero es en sí un dato: o
no está instalado, o no ha llegado a arrancar. La interfaz lo dice en vez de
dejar el botón girando para siempre.

**Quien pueda escribir ese fichero puede provocar una reconstrucción y un
reinicio.** Es menos poder que montar el socket de Docker —que es root en el
host— pero no es ninguno: el endpoint exige sesión, como todo lo demás.
"""

import json
import logging
from datetime import datetime
from pathlib import Path

from core import paths
from core.escritura import escribirJsonAtomico
from core.version import __version__

log = logging.getLogger(__name__)

NOMBRE_SOLICITUD = "actualizacion.solicitada"
NOMBRE_ESTADO = "actualizacion.estado"

# Cuánto se sigue creyendo un «en marcha» sin noticias. `docker-update.sh`
# reconstruye la imagen entera: en un servidor modesto son varios minutos, y
# pasado ese tiempo lo más probable es que el vigilante se quedara sin terminar
# de escribir el resultado (por ejemplo, si se reinició el host). Pasado el
# plazo se vuelve a admitir una solicitud, que si no el botón quedaría muerto.
ESPERA_MAXIMA_SEGUNDOS = 900


def _archivo_solicitud() -> Path:
    return paths.TMP_DIR / NOMBRE_SOLICITUD


def _archivo_estado() -> Path:
    return paths.TMP_DIR / NOMBRE_ESTADO


def _ahora() -> str:
    return datetime.now().astimezone().isoformat()


def _leer_json(ruta: Path):
    try:
        return json.loads(ruta.read_text("utf-8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        # El vigilante escribe desde fuera: un fichero a medias o con basura no
        # puede tumbar la pantalla de Ajustes.
        log.warning("No se pudo leer %s: %s", ruta.name, error)
        return None


def _segundos_desde(marca) -> float | None:
    try:
        momento = datetime.fromisoformat(str(marca))
    except (TypeError, ValueError):
        return None
    if momento.tzinfo is None:
        momento = momento.astimezone()
    return max(0.0, (datetime.now().astimezone() - momento).total_seconds())


def _en_marcha(ultimo) -> bool:
    """Si el vigilante dijo que empezaba y aún está dentro de plazo."""
    if not ultimo or ultimo.get("estado") != "en_marcha":
        return False
    segundos = _segundos_desde(ultimo.get("momento"))
    return segundos is None or segundos < ESPERA_MAXIMA_SEGUNDOS


def estado() -> dict:
    """Qué versión corre, qué se ha pedido y cómo fue el último intento."""
    solicitud = _leer_json(_archivo_solicitud())
    ultimo = _leer_json(_archivo_estado())

    return {
        "version": __version__,
        "solicitada": solicitud,
        "haceSegundos": _segundos_desde((solicitud or {}).get("momento")),
        "ultimo": ultimo,
        "enMarcha": _en_marcha(ultimo),
        # Sin rastro del vigilante, el botón dejaría la señal ahí para siempre.
        # Mejor decirlo que fingir que se está actualizando algo.
        "vigilanteVisto": ultimo is not None,
    }


def solicitar() -> tuple[dict, str | None]:
    """Deja la señal para el vigilante. Devuelve `(estado, error)`."""
    actual = estado()

    if actual["enMarcha"]:
        return actual, "Ya hay una actualización en marcha"

    paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
    escribirJsonAtomico(_archivo_solicitud(), {"momento": _ahora(), "version": __version__})
    log.info("Actualización solicitada desde Ajustes (versión en marcha: %s)", __version__)

    return estado(), None


__all__ = [
    "ESPERA_MAXIMA_SEGUNDOS",
    "NOMBRE_ESTADO",
    "NOMBRE_SOLICITUD",
    "estado",
    "solicitar",
]
