"""HTTP de /api/tradingview/stats: fundamentales y técnico del scanner.

Nada sale a la red: se sustituye `fetch_tradingview_stats` (el alias con el
que `routes.market` importa `tradingview_client.fetch_stats`).
"""

from urllib.error import URLError

from routes import market as market_route
from routes.market import market_bp


def _cliente(cliente_autenticado):
    client, cabeceras, _app = cliente_autenticado(market_bp)
    return client, cabeceras


def test_sin_symbols_es_error_de_cliente(cliente_autenticado):
    client, _cabeceras = _cliente(cliente_autenticado)

    respuesta = client.get("/api/tradingview/stats")

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_devuelve_los_datos_del_scanner(cliente_autenticado, monkeypatch):
    llamadas = []

    def fake(tickers):
        llamadas.append(tickers)
        return {"NASDAQ:AAPL": {"market_cap_basic": 3.1e12, "sector": "Technology"}}

    monkeypatch.setattr(market_route, "fetch_tradingview_stats", fake)

    client, _cabeceras = _cliente(cliente_autenticado)
    respuesta = client.get("/api/tradingview/stats?symbols=nasdaq:aapl")

    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True
    assert datos["data"]["NASDAQ:AAPL"]["sector"] == "Technology"
    # El símbolo llega en mayúsculas al cliente aunque se pida en minúsculas.
    assert llamadas[0] == ["NASDAQ:AAPL"]


def test_symbols_duplicados_se_piden_una_sola_vez(cliente_autenticado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(market_route, "fetch_tradingview_stats", lambda tickers: llamadas.append(tickers) or {})

    client, _cabeceras = _cliente(cliente_autenticado)
    client.get("/api/tradingview/stats?symbols=NASDAQ:AAPL,NASDAQ:AAPL,NASDAQ:MSFT")

    assert len(llamadas[0]) == 2
    assert set(llamadas[0]) == {"NASDAQ:AAPL", "NASDAQ:MSFT"}


def test_error_de_red_se_traduce_a_503(cliente_autenticado, monkeypatch):
    def fake(tickers):
        raise URLError("sin conexión")

    monkeypatch.setattr(market_route, "fetch_tradingview_stats", fake)

    client, _cabeceras = _cliente(cliente_autenticado)
    respuesta = client.get("/api/tradingview/stats?symbols=NASDAQ:AAPL")

    assert respuesta.status_code == 503
    assert respuesta.get_json()["ok"] is False
