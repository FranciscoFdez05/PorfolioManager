"""Pestaña "Mercado" de la ficha: cliente de Binance, columnas del scanner,
servicio que junta las fuentes y endpoint.

Nada sale a la red: se sustituyen `fetchJson` de cada cliente y las funciones
de proveedor que usa el servicio. Lo que se comprueba es el contrato: un dato
que no existe llega como None (nunca inventado), un contrato inexistente es
"sin derivados" y un fallo de una parte secundaria no tumba el resto.
"""

from urllib.error import HTTPError, URLError

import pytest

from providers import binance_futures_client, tradingview_client
from routes import market as marketRoute
from routes.market import marketBp
from stores import mercado_ficha


@pytest.fixture(autouse=True)
def cacheLimpia():
    mercado_ficha._cache.clear()
    yield
    mercado_ficha._cache.clear()


def _httpError(code):
    return HTTPError("http://x", code, "err", {}, None)


# ── Binance ─────────────────────────────────────────────────────────────────

def _fakeBinance(monkeypatch, respuestas):
    llamadas = []

    def fake(url, params=None, **kwargs):
        llamadas.append((url, params))
        respuesta = respuestas[url.rsplit("/fapi/v1/", 1)[1]]
        if isinstance(respuesta, Exception):
            raise respuesta
        return respuesta

    monkeypatch.setattr(binance_futures_client, "fetchJson", fake)
    return llamadas


def testDerivadosValoranElInteresAbiertoAlPrecioDeMarca(monkeypatch):
    _fakeBinance(monkeypatch, {
        "premiumIndex": {"markPrice": "100.0", "indexPrice": "99.0", "lastFundingRate": "0.0001", "nextFundingTime": 123},
        "openInterest": {"openInterest": "10"},
        "ticker/24hr": {"quoteVolume": "5000"},
    })

    datos = binance_futures_client.fetchDerivatives("btc")

    assert datos["symbol"] == "BTCUSDT"
    assert datos["openInterestUsd"] == 1000.0
    assert datos["fundingRate"] == 0.0001
    assert datos["basisPct"] == pytest.approx((100 / 99 - 1) * 100)
    assert datos["volume24hUsd"] == 5000.0


def testSimboloInexistenteEsSinDerivados(monkeypatch):
    llamadas = _fakeBinance(monkeypatch, {"premiumIndex": _httpError(400)})

    assert binance_futures_client.fetchDerivatives("NOEXISTE") is None
    # Con el primer rechazo no se piden el interés abierto ni el volumen.
    assert len(llamadas) == 1


def testOtroErrorHttpSePropaga(monkeypatch):
    _fakeBinance(monkeypatch, {"premiumIndex": _httpError(451)})

    with pytest.raises(HTTPError):
        binance_futures_client.fetchDerivatives("BTC")


@pytest.mark.parametrize("base", ["", None, "BTC/USDT", "A" * 40, "btc&x=1"])
def testBaseInvalidaNoSeEnviaAlProveedor(monkeypatch, base):
    llamadas = _fakeBinance(monkeypatch, {})

    assert binance_futures_client.fetchDerivatives(base) is None
    assert llamadas == []


def testCamposAusentesLleganComoNone(monkeypatch):
    _fakeBinance(monkeypatch, {
        "premiumIndex": {"markPrice": "100", "indexPrice": "0"},
        "openInterest": {},
        "ticker/24hr": {},
    })

    datos = binance_futures_client.fetchDerivatives("BTC")

    assert datos["basisPct"] is None
    assert datos["fundingRate"] is None
    assert datos["openInterestUsd"] is None
    assert datos["volume24hUsd"] is None


# ── Scanner de TradingView ──────────────────────────────────────────────────

def testColumnasDeLaFichaSinRepetidas():
    columnas = tradingview_client._FICHA_COLUMNS
    # Una columna repetida desplazaría el emparejamiento nombre-valor de la fila.
    assert len(columnas) == len(set(columnas))
    assert "base_currency" in columnas


def testFetchFichaStatsEmparejaColumnasYValores(monkeypatch):
    def fake(url, params=None, timeout=None, jsonBody=None, headers=None):
        columnas = jsonBody["columns"]
        return {"data": [{"s": "BITVAVO:BTCEUR", "d": ["BTC" if c == "base_currency" else None for c in columnas]}]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fake)

    stats = tradingview_client.fetchFichaStats("BITVAVO:BTCEUR")

    assert stats["base_currency"] == "BTC"
    assert stats["sector"] is None


def testFetchFichaStatsTickerDesconocidoEsNone(monkeypatch):
    monkeypatch.setattr(tradingview_client, "_fetchJson", lambda *a, **kw: {"data": []})

    assert tradingview_client.fetchFichaStats("XXX:YYY") is None


def testFetchCoinFiltraPorMonedaBase(monkeypatch):
    peticiones = []

    def fake(filtro, columnas, **kwargs):
        peticiones.append((filtro, kwargs))
        return {"data": [{"s": "CRYPTO:BTCUSD", "d": [21_000_000 if c == "max_supply" else None for c in columnas]}]}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fake)

    coin = tradingview_client.fetchCoin("BTC")

    assert coin["max_supply"] == 21_000_000
    assert peticiones[0][0] == [{"left": "base_currency", "operation": "equal", "right": "BTC"}]
    assert peticiones[0][1]["market"] == "coin"


def testFetchCoinSinFilaEsNone(monkeypatch):
    monkeypatch.setattr(tradingview_client, "fetchScreener", lambda *a, **kw: {"data": []})

    assert tradingview_client.fetchCoin("ZZZ") is None


# ── Servicio ────────────────────────────────────────────────────────────────

def _parchearProveedores(monkeypatch, stats, coin=None, derivados=None, coinError=None, derivadosError=None):
    monkeypatch.setattr(tradingview_client, "fetchFichaStats", lambda ticker, timeout=None: stats)

    def fakeCoin(base, timeout=None):
        if coinError:
            raise coinError
        return coin

    def fakeDerivados(base, timeout=None):
        if derivadosError:
            raise derivadosError
        return derivados

    monkeypatch.setattr(tradingview_client, "fetchCoin", fakeCoin)
    monkeypatch.setattr(binance_futures_client, "fetchDerivatives", fakeDerivados)


def testCriptoJuntaMonedaYDerivados(monkeypatch):
    _parchearProveedores(
        monkeypatch,
        {"subtype": "crypto", "base_currency": "BTC"},
        coin={"max_supply": 21e6},
        derivados={"symbol": "BTCUSDT"},
    )

    datos = mercado_ficha.fichaMercado("BITVAVO:BTCEUR")

    assert datos["isCrypto"] is True
    assert datos["coin"]["max_supply"] == 21e6
    assert datos["derivatives"]["symbol"] == "BTCUSDT"
    assert datos["coinError"] is None and datos["derivativesError"] is None


def testAccionNoPideMonedaNiDerivados(monkeypatch):
    _parchearProveedores(
        monkeypatch,
        {"subtype": "common", "base_currency": None},
        coinError=AssertionError("no debe pedirse"),
        derivadosError=AssertionError("no debe pedirse"),
    )

    datos = mercado_ficha.fichaMercado("NASDAQ:AAPL")

    assert datos["isCrypto"] is False
    assert "coin" not in datos and "derivatives" not in datos


def testTickerDesconocidoDevuelveStatsNone(monkeypatch):
    _parchearProveedores(monkeypatch, None)

    datos = mercado_ficha.fichaMercado("XXX:YYY")

    assert datos["stats"] is None


def testFalloDeBinanceNoTumbaLoDemas(monkeypatch):
    _parchearProveedores(
        monkeypatch,
        {"subtype": "crypto", "base_currency": "BTC"},
        coin={"max_supply": 21e6},
        derivadosError=_httpError(451),
    )

    datos = mercado_ficha.fichaMercado("BITVAVO:BTCEUR")

    assert datos["coin"]["max_supply"] == 21e6
    assert datos["derivatives"] is None
    assert "451" in datos["derivativesError"]


def testFalloDeConexionDeLaMonedaSeAnotaSinTumbar(monkeypatch):
    _parchearProveedores(
        monkeypatch,
        {"subtype": "crypto", "base_currency": "BTC"},
        coinError=URLError("timed out"),
        derivados={"symbol": "BTCUSDT"},
    )

    datos = mercado_ficha.fichaMercado("BITVAVO:BTCEUR")

    assert datos["coin"] is None
    assert datos["coinError"]
    assert datos["derivatives"]["symbol"] == "BTCUSDT"


def testFalloDelScannerPrincipalSePropagaYNoSeCachea(monkeypatch):
    llamadas = []

    def fake(ticker, timeout=None):
        llamadas.append(ticker)
        raise _httpError(503)

    monkeypatch.setattr(tradingview_client, "fetchFichaStats", fake)

    for _ in range(2):
        with pytest.raises(HTTPError):
            mercado_ficha.fichaMercado("NASDAQ:AAPL")

    assert len(llamadas) == 2


def testSegundaLlamadaSirveDeCache(monkeypatch):
    llamadas = []

    def fake(ticker, timeout=None):
        llamadas.append(ticker)
        return {"subtype": "common"}

    monkeypatch.setattr(tradingview_client, "fetchFichaStats", fake)

    mercado_ficha.fichaMercado("NASDAQ:AAPL")
    mercado_ficha.fichaMercado("NASDAQ:AAPL")

    assert len(llamadas) == 1


def testLaCacheTieneTope(monkeypatch):
    monkeypatch.setattr(tradingview_client, "fetchFichaStats", lambda ticker, timeout=None: {"subtype": "common"})

    for n in range(mercado_ficha._CACHE_MAX + 10):
        mercado_ficha.fichaMercado(f"NASDAQ:T{n}")

    assert len(mercado_ficha._cache) <= mercado_ficha._CACHE_MAX


# ── Endpoint ────────────────────────────────────────────────────────────────

def testEndpointExigeTickerConMercado(clienteAutenticado):
    client, _cabeceras, _app = clienteAutenticado(marketBp)

    assert client.get("/api/market/ficha").status_code == 400
    assert client.get("/api/market/ficha?symbol=BTCUSD").status_code == 400


def testEndpointDevuelveLaFicha(clienteAutenticado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(
        marketRoute, "fichaMercado", lambda ticker: llamadas.append(ticker) or {"ticker": ticker, "stats": {}, "isCrypto": False}
    )
    client, _cabeceras, _app = clienteAutenticado(marketBp)

    respuesta = client.get("/api/market/ficha?symbol=nasdaq:aapl")

    assert respuesta.status_code == 200
    assert respuesta.get_json()["ok"] is True
    assert llamadas == ["NASDAQ:AAPL"]


def testEndpointFalloDeRedEs503(clienteAutenticado, monkeypatch):
    def falla(ticker):
        raise URLError("refused")

    monkeypatch.setattr(marketRoute, "fichaMercado", falla)
    client, _cabeceras, _app = clienteAutenticado(marketBp)

    respuesta = client.get("/api/market/ficha?symbol=NASDAQ:AAPL")

    assert respuesta.status_code == 503
    assert respuesta.get_json()["ok"] is False
