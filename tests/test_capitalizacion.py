"""Endpoint de la calculadora de capitalización objetivo.

Lo que se prueba es el contrato: los datos del scanner pasan tal cual, lo que
no publica llega como null (nunca un valor inventado) y los fallos de red salen
como error 503 en vez de romper la petición.
"""

from urllib.error import URLError

import pytest

from routes.herramientas import herramientasBp


@pytest.fixture
def cliente(clienteAutenticado):
    client, _cabeceras, _app = clienteAutenticado(herramientasBp)
    return client


def testDevuelvePrecioSuministroYCapitalizacion(cliente, monkeypatch):
    from providers import tradingview_client

    monkeypatch.setattr(
        tradingview_client,
        "fetchCapitalizacion",
        lambda tickers: {
            "BITSTAMP:XRPUSD": {
                "precio": 1.5, "divisa": "USD", "capitalizacion": 9.4e10,
                "suministro": 6.3e10, "nombre": "XRP / U.S. dollar",
            }
        },
    )

    res = cliente.get("/api/herramientas/capitalizacion?ticker=bitstamp:xrpusd")

    assert res.status_code == 200
    data = res.get_json()
    assert data["ok"] is True
    assert data["ticker"] == "BITSTAMP:XRPUSD"
    assert data["suministro"] == 6.3e10
    assert data["capitalizacion"] == 9.4e10


def testSinCapitalizacionNoSeInventa(cliente, monkeypatch):
    from providers import tradingview_client

    monkeypatch.setattr(
        tradingview_client,
        "fetchCapitalizacion",
        lambda tickers: {
            "TVC:GOLD": {"precio": 4151.58, "divisa": "USD", "capitalizacion": None, "suministro": None, "nombre": "Gold"}
        },
    )

    data = cliente.get("/api/herramientas/capitalizacion?ticker=TVC:GOLD").get_json()

    assert data["ok"] is True
    assert data["capitalizacion"] is None
    assert data["suministro"] is None


def testTickerObligatorio(cliente):
    assert cliente.get("/api/herramientas/capitalizacion").status_code == 400


def testTickerSinCotizacion(cliente, monkeypatch):
    from providers import tradingview_client

    monkeypatch.setattr(tradingview_client, "fetchCapitalizacion", lambda tickers: {})

    assert cliente.get("/api/herramientas/capitalizacion?ticker=NOPE:NOPE").status_code == 404


def testFalloDeRedEs503(cliente, monkeypatch):
    from providers import tradingview_client

    def falla(tickers):
        raise URLError("sin red")

    monkeypatch.setattr(tradingview_client, "fetchCapitalizacion", falla)

    assert cliente.get("/api/herramientas/capitalizacion?ticker=X:Y").status_code == 503
