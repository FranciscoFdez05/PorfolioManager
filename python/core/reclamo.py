"""«Esto ya lo ha hecho otro worker»: reclamar una tarea entre procesos.

gunicorn levanta dos workers y cada uno arranca sus hilos de fondo. Las tareas
que acaban en un mensaje de Telegram —el aviso de arranque, el resumen diario,
la comprobación de alertas— se ejecutarían dos veces y el mensaje llegaría
duplicado. `reclamar()` deja que solo uno de los procesos se la quede.

Cada tarea tiene una marca en `data/tmp/reclamo-<clave>.marca` con la hora del
último reclamo. Reclamar es comprobar esa hora y sobrescribirla **dentro de un
bloqueo de fichero** (`core.bloqueo`), de modo que dos procesos que llegan a la
vez no pueden ganar los dos. Es la misma técnica que la copia automática, y con
la misma consecuencia: si `data/tmp` no se puede escribir, se reclama siempre
(mejor un aviso repetido que ninguno).
"""

import logging
import re
import time

from core import paths
from core.bloqueo import exclusivo

log = logging.getLogger(__name__)

_CLAVE_VALIDA = re.compile(r"[^A-Za-z0-9._-]")


def _marca(clave: str):
    return paths.TMP_DIR / f"reclamo-{_CLAVE_VALIDA.sub('_', clave)[:80]}.marca"


def reclamar(clave: str, cada_segundos: float | None) -> bool:
    """True si esta llamada se queda la tarea; False si ya la hizo alguien hace poco.

    `cada_segundos=None` significa «una sola vez»: mientras exista la marca, no
    se vuelve a reclamar (p. ej. avisar de una versión concreta).
    """
    ahora = time.time()
    marca = _marca(clave)
    bloqueo = marca.with_suffix(".lock")

    try:
        with exclusivo(bloqueo, espera=2.0, obligatorio=False) as conseguido:
            if not conseguido:
                # Otro proceso está reclamando ahora mismo, o no hay sitio para
                # el bloqueo. Lo primero es lo normal y basta con ceder.
                return not bloqueo.parent.exists()

            try:
                anterior = float(marca.read_text("utf-8").strip())
            except (OSError, ValueError):
                anterior = None

            if anterior is not None and (cada_segundos is None or ahora - anterior < cada_segundos):
                return False

            try:
                marca.write_text(f"{ahora:.3f}", "utf-8")
            except OSError as error:
                log.warning("[reclamo] No se pudo escribir %s: %s", marca.name, error)
            return True
    except Exception as error:
        log.warning("[reclamo] %s: %s. Se reclama igualmente.", clave, error)
        return True


def liberar(clave: str) -> None:
    """Olvida la marca de `clave`: la próxima llamada a `reclamar` vuelve a ganar."""
    try:
        _marca(clave).unlink(missing_ok=True)
    except OSError:
        pass
