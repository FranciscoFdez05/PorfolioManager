"""Supervisor del proceso web: reinicia gunicorn cuando deja de estar sano.

    cd python && python -m admin.supervisor_web -- gunicorn --bind ... server:app

Docker solo aplica `restart: unless-stopped` cuando el proceso principal del
contenedor **termina**. Un healthcheck que falla marca el contenedor como
«unhealthy» y nada más: una web con todos los hilos de gunicorn colgados, o que
ha perdido la base de datos, se quedaba así indefinidamente, y el vigilante solo
podía avisar por Telegram.

Este proceso arranca gunicorn como hijo, le reenvía las señales de parada y
pregunta a `/api/health` cada `[gunicorn] salud_intervalo_segundos`. Si falla
`salud_fallos_para_reiniciar` veces seguidas, para gunicorn (SIGTERM y, si no
acaba a tiempo, SIGKILL) y termina con error: Docker vuelve a levantar el
contenedor, que al arrancar comprueba y, si hace falta, repara la base de datos.

Por qué un proceso aparte y no un hilo dentro de gunicorn: el maestro de
gunicorn hace `fork` de los workers, y un hilo propio que estuviera a mitad de
una petición HTTP en ese momento podría dejar un bloqueo heredado en el hijo.
Y por qué no `autoheal` ni similares: necesitan el socket de Docker, que es root
sobre el host.
"""

import logging
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable
from urllib.error import HTTPError, URLError
from urllib.request import urlopen

log = logging.getLogger("supervisor")

# Lo que tarda gunicorn en terminar las peticiones en curso antes del SIGKILL.
# Por debajo de los 30 s de `stop_grace_period` en docker-compose.yml.
graciaParadaSegundos = 25.0


class ContadorFallos:
    """Decide cuándo una racha de comprobaciones fallidas justifica reiniciar.

    Solo lógica, sin red ni procesos, para poder probarla con un reloj falso.

    Los fallos no cuentan durante el margen de arranque mientras la web no haya
    respondido bien ninguna vez: la reparación de la BD al iniciar puede tardar
    minutos y reiniciar en medio sería empezar de nuevo, en bucle. En cuanto
    hay un acierto, el margen deja de aplicarse.

    Args:
        fallosParaReiniciar: Fallos seguidos que provocan el reinicio. 0 nunca
            reinicia.
        graciaArranqueSegundos: Margen tras crear el contador.
        reloj: Fuente de tiempo monótona; inyectable para los tests.

    Example:
        >>> contador = ContadorFallos(2, 0)
        >>> contador.registrar(False), contador.registrar(False)
        (False, True)
    """

    def __init__(
        self,
        fallosParaReiniciar: int,
        graciaArranqueSegundos: float,
        reloj: Callable[[], float] = time.monotonic,
    ) -> None:
        self.fallosParaReiniciar = fallosParaReiniciar
        self._reloj = reloj
        self._finGracia = reloj() + graciaArranqueSegundos
        self._haRespondido = False
        self.fallosSeguidos = 0

    def registrar(self, sano: bool) -> bool:
        """Apunta el resultado de una comprobación.

        Args:
            sano: Si `/api/health` respondió 200.

        Returns:
            True si hay que reiniciar ya.
        """
        if sano:
            self._haRespondido = True
            self.fallosSeguidos = 0
            return False
        if not self._haRespondido and self._reloj() < self._finGracia:
            return False
        self.fallosSeguidos += 1
        return self.fallosParaReiniciar > 0 and self.fallosSeguidos >= self.fallosParaReiniciar


def sondear(url: str, timeoutSegundos: float) -> bool:
    """Pregunta a `/api/health` si la web puede atender.

    Args:
        url: Dirección completa del endpoint.
        timeoutSegundos: Espera máxima de la respuesta.

    Returns:
        True solo con un 200. Un 503 (BD caída o corrupta), un timeout o una
        conexión rechazada cuentan como fallo.
    """
    try:
        with urlopen(url, timeout=timeoutSegundos) as respuesta:
            return respuesta.status == 200
    except HTTPError as error:
        log.warning("[supervisor] /api/health responde %s", error.code)
    except (URLError, OSError) as error:
        # TimeoutError es un OSError: una web colgada acaba aquí.
        log.warning("[supervisor] /api/health no responde: %s", error)
    return False


def detener(proceso: subprocess.Popen, graciaSegundos: float = graciaParadaSegundos) -> int:
    """Para el proceso hijo con SIGTERM y, si no acaba a tiempo, con SIGKILL.

    Args:
        proceso: El proceso de gunicorn.
        graciaSegundos: Espera entre una señal y otra.

    Returns:
        Código de salida del hijo.
    """
    if proceso.poll() is not None:
        return proceso.returncode
    proceso.terminate()
    try:
        return proceso.wait(timeout=graciaSegundos)
    except subprocess.TimeoutExpired:
        log.error("[supervisor] gunicorn no ha terminado en %.0f s: se mata", graciaSegundos)
        proceso.kill()
        return proceso.wait()


def supervisar(
    proceso: subprocess.Popen,
    contador: ContadorFallos,
    comprobar: Callable[[], bool],
    intervaloSegundos: float,
) -> int:
    """Vigila al hijo hasta que termine o haya que reiniciarlo.

    Args:
        proceso: El proceso de gunicorn ya arrancado.
        contador: Política de reinicio.
        comprobar: Hace una comprobación de salud; inyectable para los tests.
        intervaloSegundos: Espera entre comprobaciones.

    Returns:
        El código de salida de gunicorn si termina por su cuenta, o 1 si el
        supervisor lo ha parado por no estar sano.
    """
    while True:
        try:
            return proceso.wait(timeout=intervaloSegundos)
        except subprocess.TimeoutExpired:
            pass
        if contador.registrar(comprobar()):
            log.error(
                "[supervisor] La web lleva %d comprobaciones seguidas sin estar sana: se reinicia",
                contador.fallosSeguidos,
            )
            detener(proceso)
            return 1


def _leerAjustes() -> dict:
    """Valores efectivos de config.ini/entorno, ya acotados por `core.settings`."""
    from core import settings

    return {
        "puerto": settings.puerto(),
        "intervalo": settings.obtener("gunicorn.salud_intervalo_segundos"),
        "timeout": settings.obtener("gunicorn.salud_timeout_segundos"),
        "fallos": settings.obtener("gunicorn.salud_fallos_para_reiniciar"),
        "gracia": settings.obtener("gunicorn.salud_gracia_arranque_segundos"),
        "nivelLog": settings.nivelLog(),
        "formatoLog": settings.formatoLog(),
    }


def main(argumentos: list[str]) -> int:
    """Arranca el comando indicado tras `--` y lo supervisa.

    Args:
        argumentos: `sys.argv[1:]`.

    Returns:
        Código de salida del proceso.
    """
    comando = argumentos[argumentos.index("--") + 1:] if "--" in argumentos else argumentos
    if not comando:
        print("Uso: python -m admin.supervisor_web -- <comando>", file=sys.stderr)
        return 2

    ajustes = _leerAjustes()
    logging.basicConfig(level=ajustes["nivelLog"], format=ajustes["formatoLog"])
    url = f"http://127.0.0.1:{ajustes['puerto']}/api/health"

    proceso = subprocess.Popen(comando)
    parada = threading.Event()

    def reenviar(senal, _marco) -> None:
        # La parada la decide gunicorn (termina las peticiones en curso); el
        # supervisor solo la transmite y espera a que acabe en `supervisar`.
        parada.set()
        if proceso.poll() is None:
            proceso.send_signal(senal)

    def comprobar() -> bool:
        # Mientras gunicorn se para, que /api/health falle es lo esperado: no
        # cuenta para reiniciar algo que ya se está apagando.
        return parada.is_set() or sondear(url, ajustes["timeout"])

    signal.signal(signal.SIGTERM, reenviar)
    signal.signal(signal.SIGINT, reenviar)

    log.info(
        "[supervisor] Vigilando %s cada %s s; reinicio tras %s fallos seguidos (0 = nunca)",
        url, ajustes["intervalo"], ajustes["fallos"],
    )
    contador = ContadorFallos(ajustes["fallos"], ajustes["gracia"])
    return supervisar(proceso, contador, comprobar, ajustes["intervalo"])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
