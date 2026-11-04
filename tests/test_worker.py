"""Pruebas de admin/worker.py: arranca los hilos de fondo, late y para limpio.

Los hilos reales no se arrancan: cada `iniciar`/`detener` es un doble.
"""

import pytest

from admin import worker


@pytest.fixture
def llamadas(monkeypatch):
    registro = []
    monkeypatch.setattr(worker, "startBackupScheduler", lambda: registro.append("copias"))
    for nombre, modulo in (("snapshots", worker.snapshot_scheduler), ("telegram", worker.telegram_listener),
                           ("avisos", worker.avisos_scheduler)):
        monkeypatch.setattr(modulo, "iniciar", lambda n=nombre: registro.append(n))
        monkeypatch.setattr(modulo, "detener", lambda n=nombre: registro.append(f"parar {n}"))
    return registro


def testArrancaLosCuatroHilosDeFondo(llamadas):
    worker.iniciarTareas()

    assert llamadas == ["copias", "snapshots", "telegram", "avisos"]


def testLatirTocaElFichero(tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "LATIDO", tmp_path / "tmp" / "worker.latido")

    worker.latir()

    assert worker.LATIDO.exists()


def testMainLateYAlPararDetieneLosHilos(llamadas, tmp_path, monkeypatch):
    monkeypatch.setattr(worker, "LATIDO", tmp_path / "worker.latido")
    monkeypatch.setattr(worker.signal, "signal", lambda *a: None)
    # Ya pedida la parada: hace una vuelta (late) y sale.
    worker._parada.set()
    try:
        assert worker.main() == 0
    finally:
        worker._parada.clear()

    assert llamadas[:4] == ["copias", "snapshots", "telegram", "avisos"]
    assert sorted(llamadas[4:]) == ["parar avisos", "parar snapshots", "parar telegram"]


def testUnHiloQueNoParaNoImpidePararLosDemas(llamadas, monkeypatch):
    def falla():
        raise RuntimeError("colgado")

    monkeypatch.setattr(worker.avisos_scheduler, "detener", falla)

    worker.detenerTareas()

    assert sorted(llamadas) == ["parar snapshots", "parar telegram"]
