"""Qué pasa si una tarea del worker se atasca, si se para a media copia o si muere.

El latido solo demuestra que vive el hilo principal. Estas pruebas cubren lo que
faltaba: el reinicio si un hilo no avanza, la espera a la copia en curso al parar
y el aviso del vigilante cuando el worker deja de latir.
"""

import os
import threading
import time

import pytest
import vigilante

from admin import backup_manager, worker
from core import pulso


@pytest.fixture(autouse=True)
def pulsosLimpios():
    pulso._vencimientos.clear()
    yield
    pulso._vencimientos.clear()


@pytest.fixture
def workerSinHilos(monkeypatch, tmp_path):
    monkeypatch.setattr(worker, "LATIDO", tmp_path / "worker.latido")
    monkeypatch.setattr(worker.signal, "signal", lambda *a: None)
    monkeypatch.setattr(worker, "iniciarTareas", lambda: None)
    monkeypatch.setattr(worker, "detenerTareas", lambda: None)


# ── Pulso ─────────────────────────────────────────────────────────────────────


def testUnaTareaDentroDeSuPlazoNoEstaVencida():
    pulso.marcar("copias", 60)

    assert pulso.vencidas() == []


def testUnaTareaQueNoRenuevaSuPlazoVence():
    pulso.marcar("copias", -1)
    pulso.marcar("avisos", 60)

    assert pulso.vencidas() == ["copias"]


def testRenovarElPlazoLaRecupera():
    pulso.marcar("copias", -1)
    pulso.marcar("copias", 60)

    assert pulso.vencidas() == []


# ── El worker ante una tarea atascada ─────────────────────────────────────────


def testUnaTareaAtascadaReiniciaElProcesoSinLatir(workerSinHilos, monkeypatch):
    class Abortado(Exception):
        pass

    def abortar():
        raise Abortado

    monkeypatch.setattr(worker, "_abortar", abortar)
    pulso.marcar("copias", -1)

    with pytest.raises(Abortado):
        worker.main()

    assert not worker.LATIDO.exists()


def testConLaParadaPedidaSaleBien(workerSinHilos):
    pulso.marcar("copias", 60)
    worker._parada.set()
    try:
        assert worker.main() == 0
    finally:
        worker._parada.clear()


# ── Parar con una copia en curso ──────────────────────────────────────────────


def testEsperaALaCopiaEnCurso():
    terminada = threading.Event()

    def copia():
        with backup_manager._AUTO_BACKUP_LOCK:
            empezada.set()
            time.sleep(0.3)
            terminada.set()

    empezada = threading.Event()
    hilo = threading.Thread(target=copia)
    hilo.start()
    empezada.wait(5)

    assert backup_manager.esperarCopiaEnCurso(5) is True
    assert terminada.is_set()
    hilo.join()


def testAgotaLaEsperaSiLaCopiaNoAcaba():
    with backup_manager._AUTO_BACKUP_LOCK:
        libre = threading.Event()

        def probar():
            libre.set() if backup_manager.esperarCopiaEnCurso(0.05) else None

        hilo = threading.Thread(target=probar)
        hilo.start()
        hilo.join()

    assert not libre.is_set()


def testSinCopiaEnCursoNoEspera():
    inicio = time.monotonic()

    assert backup_manager.esperarCopiaEnCurso(5) is True
    assert time.monotonic() - inicio < 1


def testPararEsperaLaCopiaSoloLoQueQuedaDeGracia(monkeypatch):
    for modulo in (worker.avisos_scheduler, worker.snapshot_scheduler, worker.telegram_listener):
        monkeypatch.setattr(modulo, "detener", lambda: None)
    plazos = []
    monkeypatch.setattr(worker, "esperarCopiaEnCurso", lambda t: plazos.append(t) or True)

    worker.detenerTareas()

    assert 0 < plazos[0] <= worker.graciaParadaSegundos


# ── El vigilante mira el latido ───────────────────────────────────────────────


def testLatidoRecienteEstaBien(tmp_path):
    latido = tmp_path / "worker.latido"
    latido.touch()

    assert vigilante.sondearLatido(str(latido)) == (vigilante.OK, "")


def testLatidoViejoEsCaido(tmp_path):
    latido = tmp_path / "worker.latido"
    latido.touch()
    haceRato = time.time() - 600
    os.utime(latido, (haceRato, haceRato))

    estado, detalle = vigilante.sondearLatido(str(latido))

    assert estado == vigilante.CAIDO
    assert "último latido" in detalle


def testSinFicheroDeLatidoEsCaido(tmp_path):
    estado, detalle = vigilante.sondearLatido(str(tmp_path / "no-existe"))

    assert estado == vigilante.CAIDO
    assert "sin latido" in detalle


def testElObjetivoDeComposeLlegaALaSondaDeLatido(tmp_path):
    latido = tmp_path / "worker.latido"
    latido.touch()
    valor = f"La aplicación=http://caddy:5000/api/health,El worker=latido:{latido}"

    objetivos = vigilante.leerObjetivos(valor, 5000)

    assert objetivos[1][0] == "El worker"
    assert vigilante.sondear(objetivos[1][1], contexto=object()) == (vigilante.OK, "")
