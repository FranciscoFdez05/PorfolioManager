"""Proceso aparte para las tareas de fondo: copias, snapshots, Telegram y avisos.

    cd python && python -m admin.worker

En Docker es el servicio `worker` de docker-compose.yml, con la misma imagen
que la web. Separarlas tiene tres ventajas:

* **La web no pierde hilos.** Una revisión de wallets o de bloques que tarda no
  ocupa ninguno de los workers por threads de gunicorn que atienden la página.
* **Una sola copia de cada hilo.** Dentro de gunicorn cada worker arrancaba la
  suya y se repartían el trabajo con `core.reclamo`; aquí hay una.
* **Aislamiento.** Si una tarea se cuelga o gasta memoria, la web sigue.

La web deja de arrancar estos hilos con `[server] tareas_en_web = false`
(env PORTFOLIO_TAREAS_EN_WEB), que docker-compose.yml pone a la web. Sin worker
(desarrollo, o una instalación sin el servicio), la web los sigue arrancando
como siempre. `core.reclamo` se queda: si por error corriesen en los dos
procesos, no se repetiría nada.

El worker arranca después de que la web esté sana (depends_on en compose): la
web es quien comprueba y, si hace falta, repara las bases de datos al iniciar.
"""

import logging
import os
import signal
import threading
import time

from dotenv import load_dotenv

# .env antes que los ajustes, como en server.py: admiten override por variable.
load_dotenv()

from admin import avisos_scheduler, snapshot_scheduler, telegram_listener  # noqa: E402
from admin.backup_manager import (  # noqa: E402
    esperarCopiaEnCurso,
    startScheduler as startBackupScheduler,
)
from core import paths, pulso, settings  # noqa: E402

log = logging.getLogger("worker")

# El healthcheck del contenedor (docker-compose.yml) mira que este fichero se
# haya tocado hace menos de 2 minutos.
LATIDO = paths.TMP_DIR / "worker.latido"
CADA_LATIDO_SEGUNDOS = 30
# Por debajo de los 30 s de `stop_grace_period` en docker-compose.yml, para
# acabar antes de que Docker mate el proceso.
graciaParadaSegundos = 25.0

_parada = threading.Event()


def iniciarTareas() -> None:
    """Arranca los hilos de fondo. Son los mismos que arranca server.py sin worker."""
    startBackupScheduler()
    snapshot_scheduler.iniciar()
    telegram_listener.iniciar()
    avisos_scheduler.iniciar()


def detenerTareas() -> None:
    """Para los hilos que saben pararse y da tiempo a acabar a una copia en curso.

    El de las copias es daemon y moriría con el proceso a media copia.
    """
    inicio = time.monotonic()
    for modulo in (avisos_scheduler, snapshot_scheduler, telegram_listener):
        try:
            modulo.detener()
        except Exception as error:
            # Al apagar no hay nada que salvar: se apunta y se sigue con los demás.
            log.warning("[worker] No se pudo parar %s: %s", modulo.__name__, error)
    if not esperarCopiaEnCurso(graciaParadaSegundos - (time.monotonic() - inicio)):
        log.warning("[worker] Se para con una copia automática en curso; se repetirá al arrancar")


def latir() -> None:
    """Marca que el proceso sigue vivo."""
    try:
        LATIDO.parent.mkdir(parents=True, exist_ok=True)
        LATIDO.touch()
    except OSError as error:
        log.warning("[worker] No se pudo escribir el latido %s: %s", LATIDO, error)


def _abortar() -> None:
    """Termina ya, con error, para que `restart: unless-stopped` levante otro proceso.

    `os._exit` y no un `return`: al salir normal, Python espera a los hilos de los
    `ThreadPoolExecutor`, y uno colgado dejaría el proceso vivo para siempre.
    """
    logging.shutdown()
    os._exit(1)


def _alParar(senal, _marco) -> None:
    log.info("[worker] Señal %s: parando", senal)
    _parada.set()


def main() -> int:
    logging.basicConfig(level=settings.nivelLog(), format=settings.formatoLog())
    signal.signal(signal.SIGTERM, _alParar)
    signal.signal(signal.SIGINT, _alParar)
    log.info("[worker] Arrancando copias, snapshots, Telegram y avisos")
    iniciarTareas()
    while not _parada.is_set():
        atascadas = pulso.vencidas()
        if atascadas:
            log.error("[worker] Tareas sin avanzar: %s. Se reinicia el proceso", ", ".join(atascadas))
            _abortar()
        latir()
        _parada.wait(CADA_LATIDO_SEGUNDOS)
    detenerTareas()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
