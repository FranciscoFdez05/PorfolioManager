"""Pruebas del supervisor que reinicia la web cuando /api/health deja de responder.

Docker no reinicia un contenedor «unhealthy»; estas pruebas cubren la política
que decide cuándo terminar gunicorn para que lo haga, y que la parada sea
ordenada (SIGTERM antes que SIGKILL).
"""

import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

from admin import supervisor_web
from admin.supervisor_web import ContadorFallos


class RelojFalso:
    """Reloj monótono que solo avanza cuando el test lo dice."""

    def __init__(self) -> None:
        self.ahora = 0.0

    def __call__(self) -> float:
        return self.ahora


# ── Política de reinicio ──────────────────────────────────────────────────────


def testReiniciaAlLlegarALosFallosSeguidos():
    contador = ContadorFallos(3, 0)

    assert [contador.registrar(False) for _ in range(3)] == [False, False, True]


def testUnAciertoReiniciaLaCuenta():
    contador = ContadorFallos(3, 0)
    contador.registrar(False)
    contador.registrar(False)

    contador.registrar(True)

    assert contador.fallosSeguidos == 0
    assert contador.registrar(False) is False


def testConCeroNoReiniciaNunca():
    contador = ContadorFallos(0, 0)

    assert not any(contador.registrar(False) for _ in range(50))
    assert contador.fallosSeguidos == 50


def testLosFallosDelArranqueNoCuentan():
    """La reparación de la BD al iniciar puede tardar: reiniciar en medio sería un bucle."""
    reloj = RelojFalso()
    contador = ContadorFallos(2, 300, reloj)

    assert not any(contador.registrar(False) for _ in range(10))
    assert contador.fallosSeguidos == 0

    reloj.ahora = 301
    assert contador.registrar(False) is False
    assert contador.registrar(False) is True


def testTrasElPrimerAciertoLaGraciaYaNoAplica():
    reloj = RelojFalso()
    contador = ContadorFallos(2, 300, reloj)
    contador.registrar(True)

    contador.registrar(False)

    assert contador.registrar(False) is True


# ── Sonda ─────────────────────────────────────────────────────────────────────


def _servidor(codigo: int):
    class Manejador(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(codigo)
            self.end_headers()

        def log_message(self, *_args):
            pass

    servidor = HTTPServer(("127.0.0.1", 0), Manejador)
    threading.Thread(target=servidor.serve_forever, daemon=True).start()
    return servidor


@pytest.mark.parametrize(("codigo", "esperado"), [(200, True), (503, False), (500, False)])
def testLaSondaSoloAceptaUn200(codigo, esperado):
    servidor = _servidor(codigo)
    try:
        url = f"http://127.0.0.1:{servidor.server_port}/api/health"
        assert supervisor_web.sondear(url, 5) is esperado
    finally:
        servidor.shutdown()


def testUnaConexionRechazadaEsUnFallo():
    servidor = _servidor(200)
    puerto = servidor.server_port
    servidor.shutdown()
    servidor.server_close()

    assert supervisor_web.sondear(f"http://127.0.0.1:{puerto}/api/health", 2) is False


# ── Supervisión del proceso ───────────────────────────────────────────────────


def _hijo(codigo: str) -> subprocess.Popen:
    return subprocess.Popen([sys.executable, "-c", codigo])


def testDevuelveElCodigoDelHijoSiTerminaSolo():
    proceso = _hijo("import sys; sys.exit(3)")

    codigo = supervisor_web.supervisar(proceso, ContadorFallos(1, 0), lambda: True, 0.05)

    assert codigo == 3


def testParaAlHijoYTerminaConErrorSiNoEstaSano():
    proceso = _hijo("import time; time.sleep(60)")

    codigo = supervisor_web.supervisar(proceso, ContadorFallos(2, 0), lambda: False, 0.05)

    assert codigo == 1
    assert proceso.poll() is not None


def testMataAlHijoQueNoAtiendeElSigterm(monkeypatch):
    # En Windows terminate() ya es un TerminateProcess; lo que se prueba aquí
    # es que, si el SIGTERM no basta, no se espera para siempre.
    proceso = _hijo("import time; time.sleep(60)")
    monkeypatch.setattr(proceso, "terminate", lambda: None)

    supervisor_web.detener(proceso, graciaSegundos=0.2)

    assert proceso.poll() is not None


def testSinComandoDevuelveErrorDeUso(capsys):
    assert supervisor_web.main(["--"]) == 2
    assert "Uso" in capsys.readouterr().err
