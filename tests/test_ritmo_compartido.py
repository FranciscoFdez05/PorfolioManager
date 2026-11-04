"""`RitmoCompartido`: el límite de una API se respeta entre procesos, no solo entre hilos.

En Docker llaman a Esplora y Etherscan los dos workers de gunicorn y el servicio
worker. Con un ritmo por proceso, cada uno iba a su velocidad y entre los tres se
pasaban del límite de la IP.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from core import paths
from providers import blockchain_clients as bc

_carpetaPython = Path(__file__).resolve().parent.parent / "python"

# Reloj fijo: las esperas devueltas son múltiplos exactos del intervalo, así que
# dos procesos que reservasen el mismo hueco se verían como un valor repetido.
_scriptProceso = """
import sys
from pathlib import Path
from core import paths
from providers import blockchain_clients as bc

paths.TMP_DIR = Path(sys.argv[1])
ritmo = bc.RitmoCompartido("prueba", 10.0, reloj=lambda: 1000.0)
for _ in range(5):
    print(ritmo.turno())
"""


def testDosInstanciasCompartenElHueco():
    """Dos instancias equivalen a dos procesos: su única memoria común es el fichero."""
    reloj = lambda: 1000.0  # noqa: E731
    una = bc.RitmoCompartido("dos", 1.0, reloj)
    otra = bc.RitmoCompartido("dos", 1.0, reloj)

    assert [una.turno(), otra.turno(), una.turno()] == [0.0, 1.0, 2.0]


def testClavesDistintasNoSeEsperan():
    assert bc.RitmoCompartido("a", 1.0, lambda: 1000.0).turno() == 0.0
    assert bc.RitmoCompartido("b", 1.0, lambda: 1000.0).turno() == 0.0


def testProcesosRealesNoReservanElMismoHueco(tmp_path):
    entorno = {**os.environ, "PYTHONPATH": str(_carpetaPython), "PORTFOLIO_DATA_DIR": str(tmp_path / "data"),
               "PORTFOLIO_API_DIR": str(tmp_path / "API"), "PORTFOLIO_LOGS_DIR": str(tmp_path / "logs")}
    procesos = [
        subprocess.Popen([sys.executable, "-c", _scriptProceso, str(tmp_path)], stdout=subprocess.PIPE, text=True,
                         env=entorno, cwd=_carpetaPython)
        for _ in range(4)
    ]

    esperas = []
    for proceso in procesos:
        salida, _ = proceso.communicate(timeout=120)
        assert proceso.returncode == 0
        esperas += [float(linea) for linea in salida.split()]

    assert sorted(esperas) == [i * 10.0 for i in range(20)]


def testUnaMarcaMuyAdelantadaNoBloqueaLasLecturas():
    """Un reloj que retrocede dejaría la marca en el futuro: no es una cola real."""
    ritmo = bc.RitmoCompartido("reloj", 1.0, lambda: 1000.0)
    (paths.TMP_DIR / "ritmo-reloj.marca").write_text("999999.0", "utf-8")

    assert ritmo.turno() == 0.0


def testUnaMarcaIlegibleSeIgnora():
    ritmo = bc.RitmoCompartido("rota", 1.0, lambda: 1000.0)
    (paths.TMP_DIR / "ritmo-rota.marca").write_text("no es un número", "utf-8")

    assert ritmo.turno() == 0.0


def testSinPoderEscribirSigueElRitmoDelProceso(monkeypatch):
    ritmo = bc.RitmoCompartido("sinDisco", 1.0, lambda: 1000.0)

    def falla(_marca):
        raise OSError("disco lleno")

    monkeypatch.setattr(ritmo, "_reservar", falla)

    assert [ritmo.turno(), ritmo.turno()] == [0.0, 1.0]


def testOlvidarCaidasBorraElRitmoDeEsplora(monkeypatch):
    monkeypatch.setattr(bc.settings, "walletsEsploraIntervalo", lambda: 1.0)
    bc.esperarTurnoEsplora("https://esplora.test/api", lambda _s: None)
    assert list(paths.TMP_DIR.glob("ritmo-esplora-*.marca"))

    bc.olvidarEsploraCaidas()

    assert not list(paths.TMP_DIR.glob("ritmo-esplora-*.marca"))


@pytest.mark.parametrize("ritmo", [bc._RITMO_ETHERSCAN])
def testEtherscanTambienSeComparte(ritmo):
    assert isinstance(ritmo, bc.RitmoCompartido)
