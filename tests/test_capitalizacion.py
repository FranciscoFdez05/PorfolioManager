"""Endpoint de la calculadora de capitalización objetivo.

Lo que se prueba es el contrato: los datos del scanner pasan tal cual, lo que
no publica llega como null (nunca un valor inventado) y los fallos de red salen
como error 503 en vez de romper la petición.
"""

from urllib.error import URLError

import pytest

from routes.herramientas import herramientas_bp


@pytest.fixture
def cliente(cliente_autenticado):
    client, _cabeceras, _app = cliente_autenticado(herramientas_bp)
    return client


def test_devuelve_precio_suministro_y_capitalizacion(cliente, monkeypatch):
    from providers import tradingview_client

    monkeypatch.setattr(
        tradingview_client,
        "fetch_capitalizacion",
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


def test_sin_capitalizacion_no_se_inventa(cliente, monkeypatch):
    from providers import tradingview_client

    monkeypatch.setattr(
        tradingview_client,
        "fetch_capitalizacion",
        lambda tickers: {
            "TVC:GOLD": {"precio": 4151.58, "divisa": "USD", "capitalizacion": None, "suministro": None, "nombre": "Gold"}
        },
    )

    data = cliente.get("/api/herramientas/capitalizacion?ticker=TVC:GOLD").get_json()

    assert data["ok"] is True
    assert data["capitalizacion"] is None
    assert data["suministro"] is None


def test_ticker_obligatorio(cliente):
    assert cliente.get("/api/herramientas/capitalizacion").status_code == 400


def test_ticker_sin_cotizacion(cliente, monkeypatch):
    from providers import tradingview_client

    monkeypatch.setattr(tradingview_client, "fetch_capitalizacion", lambda tickers: {})

    assert cliente.get("/api/herramientas/capitalizacion?ticker=NOPE:NOPE").status_code == 404


def test_fallo_de_red_es_503(cliente, monkeypatch):
    from providers import tradingview_client

    def falla(tickers):
        raise URLError("sin red")

    monkeypatch.setattr(tradingview_client, "fetch_capitalizacion", falla)

    assert cliente.get("/api/herramientas/capitalizacion?ticker=X:Y").status_code == 503
