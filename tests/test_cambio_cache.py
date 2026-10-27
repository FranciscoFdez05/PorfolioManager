"""Caché del tipo de cambio actual en `fetchExchangeRate`."""

import threading
import time

import pytest

from providers import finnhub_client as fh


@pytest.fixture(autouse=True)
def _cacheLimpia(monkeypatch):
    monkeypatch.delenv("PROVEEDORES_CAMBIO_VIGENCIA", raising=False)
    monkeypatch.delenv("PROVEEDORES_CAMBIO_OBSOLETO_MAX", raising=False)
    fh.clearExchangeRateCache()
    yield
    fh.clearExchangeRateCache()


def _falsoProveedor(monkeypatch, respuestas):
    """Sustituye la llamada de red; `respuestas` es una lista que se va consumiendo."""
    llamadas = []

    def falso(origen, destino, timeout=None):
        llamadas.append((origen, destino, timeout))
        return respuestas.pop(0) if len(respuestas) > 1 else respuestas[0]

    monkeypatch.setattr(fh, "_requestExchangeRate", falso)
    return llamadas


def testLaSegundaLlamadaDentroDeLaVigenciaNoSaleALaRed(monkeypatch):
    llamadas = _falsoProveedor(monkeypatch, [(0.9, None)])

    assert fh.fetchExchangeRate("usd", "EUR") == (0.9, None)
    assert fh.fetchExchangeRate("USD", "eur") == (0.9, None)
    assert len(llamadas) == 1


def testCadaParTieneSuPropiaEntrada(monkeypatch):
    llamadas = _falsoProveedor(monkeypatch, [(0.9, None)])

    fh.fetchExchangeRate("USD", "EUR")
    fh.fetchExchangeRate("EUR", "USD")
    fh.fetchExchangeRate("GBP", "EUR")
    assert len(llamadas) == 3


def testMismaDivisaNoUsaRedNiCache(monkeypatch):
    llamadas = _falsoProveedor(monkeypatch, [(0.9, None)])

    assert fh.fetchExchangeRate("EUR", "EUR") == (1.0, None)
    assert llamadas == []


def testCaducadaLaVigenciaSeVuelveAPedir(monkeypatch):
    monkeypatch.setenv("PROVEEDORES_CAMBIO_VIGENCIA", "1")
    llamadas = _falsoProveedor(monkeypatch, [(0.9, None), (0.8, None)])

    assert fh.fetchExchangeRate("USD", "EUR") == (0.9, None)
    time.sleep(1.1)
    assert fh.fetchExchangeRate("USD", "EUR") == (0.8, None)
    assert len(llamadas) == 2


def testVigenciaCeroDesactivaLaCache(monkeypatch):
    monkeypatch.setenv("PROVEEDORES_CAMBIO_VIGENCIA", "0")
    llamadas = _falsoProveedor(monkeypatch, [(0.9, None)])

    fh.fetchExchangeRate("USD", "EUR")
    fh.fetchExchangeRate("USD", "EUR")
    assert len(llamadas) == 2


def testSiFallaSeUsaElUltimoValorConocido(monkeypatch):
    monkeypatch.setenv("PROVEEDORES_CAMBIO_VIGENCIA", "1")
    llamadas = _falsoProveedor(monkeypatch, [(0.9, None), (None, "sin red")])

    assert fh.fetchExchangeRate("USD", "EUR") == (0.9, None)
    time.sleep(1.1)
    assert fh.fetchExchangeRate("USD", "EUR") == (0.9, None)
    assert len(llamadas) == 2


def testSinValorPrevioElErrorSePropagaYNoSeCachea(monkeypatch):
    llamadas = _falsoProveedor(monkeypatch, [(None, "sin red"), (0.9, None)])

    assert fh.fetchExchangeRate("USD", "EUR") == (None, "sin red")
    assert fh.fetchExchangeRate("USD", "EUR") == (0.9, None)
    assert len(llamadas) == 2


def testElRespaldoCaducaConElObsoletoMaximo(monkeypatch):
    monkeypatch.setenv("PROVEEDORES_CAMBIO_VIGENCIA", "1")
    monkeypatch.setenv("PROVEEDORES_CAMBIO_OBSOLETO_MAX", "1")
    _falsoProveedor(monkeypatch, [(0.9, None), (None, "sin red")])

    fh.fetchExchangeRate("USD", "EUR")
    time.sleep(1.1)
    assert fh.fetchExchangeRate("USD", "EUR") == (None, "sin red")


def testHilosSimultaneosDelMismoParHacenUnaSolaLlamada(monkeypatch):
    contador = {"n": 0}

    def lento(origen, destino, timeout=None):
        contador["n"] += 1
        time.sleep(0.2)
        return 0.9, None

    monkeypatch.setattr(fh, "_requestExchangeRate", lento)
    resultados = []
    hilos = [threading.Thread(target=lambda: resultados.append(fh.fetchExchangeRate("USD", "EUR"))) for _ in range(8)]
    for hilo in hilos:
        hilo.start()
    for hilo in hilos:
        hilo.join()

    assert contador["n"] == 1
    assert resultados == [(0.9, None)] * 8


def testElTimeoutLlegaAlProveedor(monkeypatch):
    llamadas = _falsoProveedor(monkeypatch, [(0.9, None)])

    fh.fetchExchangeRate("USD", "EUR", timeout=5)
    assert llamadas[0][2] == 5
