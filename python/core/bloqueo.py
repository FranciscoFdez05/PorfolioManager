"""Exclusión mutua **entre procesos**, no solo entre hilos.

El código estaba escrito para un proceso. `threading.Lock` protege la migración
del esquema, la copia automática diaria y el guardado de `portfolios.json`… de
los otros hilos del mismo proceso, que es todo lo que hay cuando se ejecuta el
servidor de desarrollo en el PC.

En el servidor, gunicorn levanta **dos workers**: dos procesos de Python que
importan `server.py` a la vez, abren la misma base de datos y arrancan cada uno
sus hilos de fondo. Ahí un `threading.Lock` no protege de nada, y lo que estaba
serializado deja de estarlo justo en las operaciones que reescriben ficheros.

Se usa el bloqueo de ficheros del sistema operativo (`fcntl` en Linux y macOS,
`msvcrt` en Windows) y no un fichero-testigo con el pid dentro, porque el
sistema lo suelta solo cuando el proceso muere. Un testigo escrito a mano
sobrevive a un `docker kill` y deja el bloqueo puesto para siempre, que es peor
que no tenerlo: nadie volvería a hacer una copia automática.

El bloqueo es una red de seguridad, no un requisito de arranque: si no se puede
ni crear el fichero, se avisa y se sigue sin él (que es exactamente como
funcionaba antes). Lo que sí se propaga es la espera agotada, porque significa
que otro proceso está haciendo esa misma operación ahora mismo.
"""

import logging
import os
import time
from contextlib import contextmanager
from pathlib import Path

log = logging.getLogger(__name__)

try:                                    # POSIX (Linux, macOS): el caso de Docker
    import fcntl
except ImportError:                     # pragma: no cover - depende del sistema
    fcntl = None

try:                                    # Windows: el equipo de desarrollo
    import msvcrt
except ImportError:                     # pragma: no cover - depende del sistema
    msvcrt = None

# Cada cuánto se reintenta mientras otro proceso tiene el bloqueo. No hay espera
# activa que optimizar: se compite un instante al arrancar y una vez por hora.
_REINTENTO_SEGUNDOS = 0.2


class BloqueoOcupado(RuntimeError):
    """Otro proceso tiene el bloqueo y se ha agotado la espera."""


def _intentar(descriptor) -> bool:
    """Un intento no bloqueante. True si se ha conseguido el bloqueo."""
    if fcntl is not None:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return True
        except OSError:
            return False

    if msvcrt is not None:
        try:
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            return True
        except OSError:
            return False

    # Sin ninguno de los dos no hay nada que hacer; se comporta como antes.
    return True


def _soltar(descriptor) -> None:
    try:
        if fcntl is not None:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
        elif msvcrt is not None:
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
    except OSError:
        # Al cerrar el descriptor el sistema lo suelta igualmente.
        pass


@contextmanager
def exclusivo(ruta, *, espera=0.0, obligatorio=True):
    """Bloqueo exclusivo entre procesos sobre `ruta`.

    `espera` son los segundos que se insiste antes de rendirse: 0 lo convierte
    en un intento único, que es lo que quiere una tarea de fondo (si otro worker
    ya la está haciendo, este se la salta y vuelve dentro de una hora).

    `obligatorio=False` deja continuar sin bloqueo cuando no se ha podido
    conseguir, en vez de lanzar `BloqueoOcupado`.

    Cede True si se tiene el bloqueo y False si se ha entrado sin él.
    """
    ruta = Path(ruta)
    descriptor = None
    conseguido = False
    try:
        try:
            ruta.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(str(ruta), os.O_RDWR | os.O_CREAT, 0o644)
        except OSError as error:
            # Sin sitio donde poner el fichero de bloqueo no se puede coordinar
            # nada, pero tampoco es motivo para no dejar arrancar: se avisa una
            # vez y se sigue con el comportamiento de siempre.
            log.warning("[bloqueo] No se pudo abrir %s: %s. Se continúa sin bloqueo.", ruta, error)
            yield False
            return

        limite = time.monotonic() + max(0.0, float(espera))
        while True:
            conseguido = _intentar(descriptor)
            if conseguido or time.monotonic() >= limite:
                break
            time.sleep(_REINTENTO_SEGUNDOS)

        if not conseguido:
            if obligatorio:
                raise BloqueoOcupado(
                    f"otro proceso mantiene el bloqueo {ruta.name} desde hace más de {espera:g}s"
                )
            log.debug("[bloqueo] %s ocupado; se continúa sin él.", ruta.name)

        yield conseguido
    finally:
        if descriptor is not None:
            if conseguido:
                _soltar(descriptor)
            try:
                os.close(descriptor)
            except OSError:
                pass


__all__ = ["BloqueoOcupado", "exclusivo"]
