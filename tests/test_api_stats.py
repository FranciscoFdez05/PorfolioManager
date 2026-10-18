"""El contador de llamadas a proveedores, compartido entre workers.

Los proveedores gratuitos limitan las peticiones por día, así que este número
es el que dice si queda margen para refrescar la cartera. Vivía en memoria del
proceso: con los dos workers de gunicorn del contenedor, cada uno llevaba su
cuenta y la pantalla enseñaba la del worker que contestara —la mitad, y una
distinta en cada recarga—. Estas pruebas fijan que la cuenta sea una sola y que
un fallo de disco nunca tumbe la consulta de cotizaciones.
"""

import json

import pytest

from providers import api_stats


@pytest.fixture(autouse=True)
def statsAisladas(tmp_path, monkeypatch):
    from core import paths

    jsonDir = tmp_path / "JSON"
    jsonDir.mkdir()
    monkeypatch.setattr(paths, "JSON_DIR", jsonDir, raising=False)
    monkeypatch.setattr(paths, "TMP_DIR", tmp_path / "tmp", raising=False)
    api_stats.reiniciarParaPruebas()
    yield jsonDir
    api_stats.reiniciarParaPruebas()


def testCuentaLasLlamadasPorProveedor():
    api_stats.recordApiCall("Finnhub")
    api_stats.recordApiCall("Finnhub")
    api_stats.recordApiCall("EODHD")

    estado = api_stats.getTodayStats()

    assert estado["counts"] == {"Finnhub": 2, "EODHD": 1}
    assert estado["total"] == 3


def testDosWorkersSumanSobreLaMismaCuenta():
    """`reiniciarParaPruebas` deja el proceso como un worker recién arrancado.

    Es la situación real del contenedor: dos procesos distintos, sin memoria
    compartida, contando llamadas al mismo proveedor.
    """
    api_stats.recordApiCall("Finnhub")
    api_stats.reiniciarParaPruebas()      # ← el otro worker
    api_stats.recordApiCall("Finnhub")

    assert api_stats.getTodayStats()["counts"]["Finnhub"] == 2


def testElRecuentoDeAyerNoSeArrastra(statsAisladas):
    (statsAisladas / "api_stats.json").write_text(
        json.dumps({"date": "2020-01-01", "counts": {"Finnhub": 99}}), encoding="utf-8"
    )

    api_stats.recordApiCall("Finnhub")

    assert api_stats.getTodayStats()["counts"] == {"Finnhub": 1}


def testUnFicheroIlegibleNoRompeElContador(statsAisladas):
    (statsAisladas / "api_stats.json").write_text("{no es json", encoding="utf-8")

    api_stats.recordApiCall("Yahoo Finance")

    assert api_stats.getTodayStats()["counts"] == {"Yahoo Finance": 1}


def testSinPoderEscribirSeSigueContandoEnMemoria(monkeypatch):
    """Una cotización no puede fallar porque el contador no quepa en disco."""
    def _denegado(*_args, **_kwargs):
        raise PermissionError("Permission denied")

    monkeypatch.setattr(api_stats, "escribirJsonAtomico", _denegado)

    api_stats.recordApiCall("Finnhub")

    assert api_stats.getTodayStats()["counts"] == {"Finnhub": 1}


def testSinLlamadasDevuelveElDiaACero():
    estado = api_stats.getTodayStats()

    assert estado["counts"] == {}
    assert estado["total"] == 0
