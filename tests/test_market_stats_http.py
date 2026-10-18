"""HTTP de /api/tradingview/stats: fundamentales y técnico del scanner.

Nada sale a la red: se sustituye `fetch_tradingview_stats` (el alias con el
que `routes.market` importa `tradingview_client.fetchStats`).
"""

from urllib.error import URLError

from routes import market as marketRoute
from routes.market import marketBp


def _cliente(clienteAutenticado):
    client, cabeceras, _app = clienteAutenticado(marketBp)
    return client, cabeceras


def testSinSymbolsEsErrorDeCliente(clienteAutenticado):
    client, _cabeceras = _cliente(clienteAutenticado)

    respuesta = client.get("/api/tradingview/stats")

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testDevuelveLosDatosDelScanner(clienteAutenticado, monkeypatch):
    llamadas = []

    def fake(tickers):
        llamadas.append(tickers)
        return {"NASDAQ:AAPL": {"market_cap_basic": 3.1e12, "sector": "Technology"}}

    monkeypatch.setattr(marketRoute, "fetchTradingviewStats", fake)

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/tradingview/stats?symbols=nasdaq:aapl")

    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True
    assert datos["data"]["NASDAQ:AAPL"]["sector"] == "Technology"
    # El símbolo llega en mayúsculas al cliente aunque se pida en minúsculas.
    assert llamadas[0] == ["NASDAQ:AAPL"]


def testSymbolsDuplicadosSePidenUnaSolaVez(clienteAutenticado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(marketRoute, "fetchTradingviewStats", lambda tickers: llamadas.append(tickers) or {})

    client, _cabeceras = _cliente(clienteAutenticado)
    client.get("/api/tradingview/stats?symbols=NASDAQ:AAPL,NASDAQ:AAPL,NASDAQ:MSFT")

    assert len(llamadas[0]) == 2
    assert set(llamadas[0]) == {"NASDAQ:AAPL", "NASDAQ:MSFT"}


def testErrorDeRedSeTraduceA503(clienteAutenticado, monkeypatch):
    def fake(tickers):
        raise URLError("sin conexión")

    monkeypatch.setattr(marketRoute, "fetchTradingviewStats", fake)

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/tradingview/stats?symbols=NASDAQ:AAPL")

    assert respuesta.status_code == 503
    assert respuesta.get_json()["ok"] is False
