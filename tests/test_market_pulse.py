"""Catálogos curados, screener real y caché de `stores.market_pulse`.

Nada sale a la red: se sustituyen `tradingview_client.fetchStats` /
`fetchScreener` y `feargreed_client.fetchIndex` (importado en
`market_pulse` como `_fetch_fear_greed_index`).
"""

from providers import tradingview_client
from stores import market_pulse


def setup_function():
    # La caché en memoria del módulo no debe filtrarse entre tests.
    market_pulse._cache.clear()


def _stats(ticker, close, change, aum=None, currency="USD"):
    return {ticker: {"close": close, "change": change, "currency": currency, "aum": aum}}


def testSnapshotJuntaIndicesYSectoresEnUnaSolaLlamada(monkeypatch):
    llamadas = []

    def fakeFetchStats(tickers, timeout=None):
        llamadas.append(tickers)
        return {
            **_stats("SP:SPX", 6700.0, 0.5),
            **_stats("AMEX:XLK", 250.0, -1.2, aum=126_000_000_000),
        }

    monkeypatch.setattr(tradingview_client, "fetchStats", fakeFetchStats)

    datos = market_pulse.snapshot()

    assert len(llamadas) == 1
    sp500 = next(i for i in datos["indices"] if i["key"] == "sp500")
    assert sp500["price"] == 6700.0
    assert sp500["change"] == 0.5
    # Un índice no es un fondo: su AUM llega `None`, no un 0.
    assert sp500["aum"] is None

    tecnologia = next(s for s in datos["sectores"] if s["key"] == "tecnologia")
    assert tecnologia["change"] == -1.2
    assert tecnologia["aum"] == 126_000_000_000

    # Un ticker que el scanner no devolvió (mercado cerrado, no cotiza...) se
    # enseña sin dato, nunca con un precio inventado.
    vix = next(i for i in datos["indices"] if i["key"] == "vix")
    assert vix["price"] is None


def testSnapshotSeCacheaDentroDelTtl(monkeypatch):
    llamadas = []
    monkeypatch.setattr(tradingview_client, "fetchStats", lambda t, timeout=None: llamadas.append(t) or {})

    market_pulse.snapshot()
    market_pulse.snapshot()

    assert len(llamadas) == 1


def testTopMoversPideSubidasYBajadasConElMismoUniverso(monkeypatch):
    ordenes = []

    def fakeScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                       instrumentTypes=None, market="america", timeout=None):
        ordenes.append(sortOrder)
        precio = 100.0 if sortOrder == "desc" else 50.0
        cambio = 8.0 if sortOrder == "desc" else -6.0
        return {"data": [{"s": "NASDAQ:X", "d": ["X", "X Corp", precio, cambio, 3_000_000_000, "Tech", "NASDAQ"]}]}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fakeScreener)

    datos = market_pulse.topMovers(limit=5)

    assert set(ordenes) == {"desc", "asc"}
    assert datos["subidas"][0]["change"] == 8.0
    assert datos["bajadas"][0]["change"] == -6.0
    assert datos["subidas"][0]["ticker"] == "X"
    assert datos["subidas"][0]["symbol"] == "NASDAQ:X"


def testBreadthRestaSubidasYBajadasDelTotal(monkeypatch):
    def fakeScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                       instrumentTypes=None, market="america", timeout=None):
        # El filtro extra de "change > 0" / "change < 0" es el último de la lista.
        if any(f.get("right") == 0 and f.get("operation") == "greater" for f in filterClauses):
            return {"totalCount": 1200}
        if any(f.get("right") == 0 and f.get("operation") == "less" for f in filterClauses):
            return {"totalCount": 900}
        return {"totalCount": 2200}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fakeScreener)

    datos = market_pulse.breadth()

    assert datos == {"subidas": 1200, "bajadas": 900, "planas": 100, "total": 2200}


def testRsiExtremesPideSobrecompraYSobreventaConElMismoUniverso(monkeypatch):
    ordenes = []

    def fakeScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                       instrumentTypes=None, market="america", timeout=None):
        ordenes.append((sortBy, sortOrder))
        rsi = 82.0 if sortOrder == "desc" else 14.0
        return {"data": [{"s": "NASDAQ:X", "d": ["X", "X Corp", 100.0, 1.5, rsi, "Tech", "NASDAQ"]}]}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fakeScreener)

    datos = market_pulse.rsiExtremes(limit=5)

    assert set(ordenes) == {("RSI", "desc"), ("RSI", "asc")}
    assert datos["sobrecompra"][0]["rsi"] == 82.0
    assert datos["sobreventa"][0]["rsi"] == 14.0


def testUnusualVolumeOrdenaPorVolumenRelativo(monkeypatch):
    peticiones = []

    def fakeScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                       instrumentTypes=None, market="america", timeout=None):
        peticiones.append((sortBy, sortOrder))
        return {"data": [{"s": "NASDAQ:X", "d": ["X", "X Corp", 100.0, 1.5, 4.2, "Tech", "NASDAQ"]}]}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fakeScreener)

    datos = market_pulse.unusualVolume(limit=8)

    assert peticiones == [("relative_volume_10d_calc", "desc")]
    assert datos[0]["relativeVolume"] == 4.2
    assert datos[0]["ticker"] == "X"


def _filaCripto(symbol, base, desc, precio, cambio, cap):
    return {"s": symbol, "d": [base, desc, precio, cambio, cap]}


def testTopCryptosDedupePorMonedaBase(monkeypatch):
    """El mismo BTC cotiza en media docena de exchanges con el mismo AUM: solo
    debe quedar una fila por `base_currency`, la primera (más cara) que llega."""
    peticiones = []

    def fakeScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                       instrumentTypes=None, market="america", timeout=None):
        peticiones.append(market)
        return {"data": [
            _filaCripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 1_700_000_000_000),
            _filaCripto("KRAKEN:BTCUSD", "BTC", "Bitcoin", 84900.0, 0.4, 1_699_000_000_000),
            _filaCripto("BINANCE:ETHUSD", "ETH", "Ethereum", 2700.0, 0.8, 330_000_000_000),
        ]}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fakeScreener)

    filas = market_pulse.topCryptos(limit=30)

    assert peticiones == ["crypto"]
    assert [f["ticker"] for f in filas] == ["BTC", "ETH"]
    assert filas[0]["symbol"] == "BINANCE:BTCUSD"
    assert filas[0]["marketCap"] == 1_700_000_000_000


def testTopCryptosSeParaEnElLimiteDeMonedasUnicas(monkeypatch):
    def fakeScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                       instrumentTypes=None, market="america", timeout=None):
        return {"data": [
            _filaCripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 3),
            _filaCripto("BINANCE:ETHUSD", "ETH", "Ethereum", 2700.0, 0.8, 2),
            _filaCripto("BINANCE:SOLUSD", "SOL", "Solana", 120.0, 1.1, 1),
        ]}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fakeScreener)

    filas = market_pulse.topCryptos(limit=2)

    assert [f["ticker"] for f in filas] == ["BTC", "ETH"]


def _screenerConStablecoins(stablecoins, filasCripto, peticiones=None):
    """Fake de `fetchScreener` que responde según el mercado: `coin` para la
    consulta de categorías y `crypto` para los pares."""
    def fake(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
             instrumentTypes=None, market="america", timeout=None):
        if peticiones is not None:
            peticiones.append(market)
        if market == "coin":
            return {"data": stablecoins}
        return {"data": filasCripto}
    return fake


def testStablecoinBasesSoloAceptaFilasConLaCategoria(monkeypatch):
    """El filtro del servidor no basta: una fila sin la categoría en su propia
    lista (o con la lista a null) no se toma por stablecoin."""
    monkeypatch.setattr(tradingview_client, "fetchScreener", _screenerConStablecoins([
        {"s": "CRYPTO:USDTUSD", "d": ["USDT", ["stablecoins", "fiat-stablecoins"]]},
        {"s": "CRYPTO:BTCUSD", "d": ["BTC", ["cryptocurrencies"]]},
        {"s": "CRYPTO:XUSD", "d": ["X", None]},
        {"s": "CRYPTO:ROTA", "d": ["ROTA"]},
    ], []))

    assert market_pulse.stablecoinBases() == frozenset({"USDT"})


def testTopCryptosExcluyeStablecoinsSinPerderHuecosDelLimite(monkeypatch):
    peticiones = []
    monkeypatch.setattr(tradingview_client, "fetchScreener", _screenerConStablecoins(
        [{"s": "CRYPTO:USDTUSD", "d": ["USDT", ["stablecoins"]]}],
        [
            _filaCripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 3),
            _filaCripto("BINANCE:USDTUSD", "USDT", "Tether USDt", 1.0, 0.0, 2),
            _filaCripto("BINANCE:ETHUSD", "ETH", "Ethereum", 2700.0, 0.8, 1),
        ],
        peticiones,
    ))

    filas = market_pulse.topCryptos(limit=2, excludeStablecoins=True)

    assert [f["ticker"] for f in filas] == ["BTC", "ETH"]
    assert sorted(peticiones) == ["coin", "crypto"]


def testTopCryptosSinExcluirNoPreguntaPorCategorias(monkeypatch):
    peticiones = []
    monkeypatch.setattr(tradingview_client, "fetchScreener", _screenerConStablecoins(
        [{"s": "CRYPTO:USDTUSD", "d": ["USDT", ["stablecoins"]]}],
        [_filaCripto("BINANCE:USDTUSD", "USDT", "Tether USDt", 1.0, 0.0, 2)],
        peticiones,
    ))

    filas = market_pulse.topCryptos(limit=5)

    assert [f["ticker"] for f in filas] == ["USDT"]
    assert peticiones == ["crypto"]


def testUniverseCriptoNoEnsenaStablecoins(monkeypatch):
    monkeypatch.setattr(tradingview_client, "fetchScreener", _screenerConStablecoins(
        [{"s": "CRYPTO:USDCUSD", "d": ["USDC", ["stablecoins"]]}],
        [
            _filaCripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 3),
            _filaCripto("COINBASE:USDCUSD", "USDC", "USDC", 1.0, -0.01, 2),
        ],
    ))

    filas = market_pulse.universe("cripto")

    assert [f["primary"] for f in filas] == ["BTC"]


def _filaNasdaq(symbol, ticker, desc, precio, cambio, cap, enNdx):
    indices = [{"name": "NASDAQ 100", "proname": "NASDAQ:NDX"}] if enNdx else [{"name": "Russell 3000", "proname": "TVC:RUA"}]
    return {"s": symbol, "d": [ticker, desc, precio, cambio, cap, indices]}


def testTopNasdaq100FiltraPorPertenenciaRealAlIndice(monkeypatch):
    """La pertenencia sale del propio campo `indexes` de cada fila, no de una
    lista de 100 tickers copiada a mano."""
    def fakeScreener(filterClauses, columns, sortBy=None, sortOrder="desc", limit=50,
                       instrumentTypes=None, market="america", timeout=None):
        assert filterClauses == [{"left": "exchange", "operation": "in_range", "right": ["NASDAQ"]}]
        return {"data": [
            _filaNasdaq("NASDAQ:AAPL", "AAPL", "Apple Inc.", 341.0, 0.5, 5_000_000_000_000, enNdx=True),
            _filaNasdaq("NASDAQ:XYZ", "XYZ", "XYZ Corp", 10.0, -0.3, 3_000_000_000, enNdx=False),
        ]}

    monkeypatch.setattr(tradingview_client, "fetchScreener", fakeScreener)

    filas = market_pulse.topNasdaq100(limit=40)

    assert [f["ticker"] for f in filas] == ["AAPL"]


def testUniverseDesconocidoDevuelveNone(monkeypatch):
    assert market_pulse.universe("no-existe") is None


def testUniverseSp500ReusaSnapshot(monkeypatch):
    monkeypatch.setattr(tradingview_client, "fetchStats", lambda t, timeout=None: {
        "AMEX:XLK": {"close": 196.0, "change": 0.8, "currency": "USD", "aum": 126_000_000_000},
    })

    filas = market_pulse.universe("sp500")

    tecnologia = next(f for f in filas if f["symbol"] == "AMEX:XLK")
    assert tecnologia["primary"] == "Tecnología"
    assert tecnologia["change"] == 0.8
    assert tecnologia["size"] == 126_000_000_000
    # Estos tres alimentan el tooltip al pasar el cursor por la baldoseta.
    assert tecnologia["price"] == 196.0
    assert tecnologia["currency"] == "USD"
    assert tecnologia["sizeLabel"] == "Patrimonio del ETF (AUM)"


def testUniverseFiltraFilasSinCambioOSinTamano(monkeypatch):
    monkeypatch.setattr(tradingview_client, "fetchScreener", lambda *a, **kw: {"data": [
        _filaCripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 1_700_000_000_000),
        _filaCripto("BINANCE:ETHUSD", "ETH", "Ethereum", 2700.0, None, 330_000_000_000),
    ]})

    filas = market_pulse.universe("cripto")

    assert [f["symbol"] for f in filas] == ["BINANCE:BTCUSD"]


def testFearGreedSeCacheaSoloSiHayExito(monkeypatch):
    llamadas = []

    def fake(timeout=None):
        llamadas.append(1)
        return {"valor": 55, "clasificacion": "Neutral", "timestamp": "1700000000"}, None

    monkeypatch.setattr(market_pulse, "_fetchFearGreedIndex", fake)

    datos1, error1 = market_pulse.fearGreed()
    datos2, error2 = market_pulse.fearGreed()

    assert error1 is None and error2 is None
    assert datos1 == datos2
    assert len(llamadas) == 1  # la segunda llamada sale de la caché


def testFearGreedNoCacheaElError(monkeypatch):
    llamadas = []

    def fake(timeout=None):
        llamadas.append(1)
        return None, "sin datos"

    monkeypatch.setattr(market_pulse, "_fetchFearGreedIndex", fake)

    datos, error = market_pulse.fearGreed()

    assert datos is None
    assert error == "sin datos"

    market_pulse.fearGreed()
    assert len(llamadas) == 2  # no se cachea el fallo: se reintenta en la siguiente llamada


def testFearGreedHistoryPideElDiaMasRecientePrimero(monkeypatch):
    llamadas = []

    def fake(days, timeout=None):
        llamadas.append(days)
        return [{"valor": 70, "clasificacion": "Greed", "timestamp": "1700000000"}], None

    monkeypatch.setattr(market_pulse, "_fetchFearGreedHistory", fake)

    serie, error = market_pulse.fearGreedHistory()

    assert error is None
    assert serie[0]["valor"] == 70
    assert llamadas == [market_pulse._FEAR_GREED_HISTORY_DAYS]


def testFearGreedHistorySeCacheaPorNumeroDeDias(monkeypatch):
    llamadas = []

    def fake(days, timeout=None):
        llamadas.append(days)
        return [], None

    monkeypatch.setattr(market_pulse, "_fetchFearGreedHistory", fake)

    market_pulse.fearGreedHistory(days=30)
    market_pulse.fearGreedHistory(days=30)
    market_pulse.fearGreedHistory(days=90)

    # 30 y 90 días son cachés distintas: la segunda llamada con 30 sale de la
    # caché, pero 90 es una ventana distinta y pide su propia serie.
    assert llamadas == [30, 90]


def testFearGreedHistoryNoCacheaElError(monkeypatch):
    llamadas = []

    def fake(days, timeout=None):
        llamadas.append(1)
        return [], "sin datos"

    monkeypatch.setattr(market_pulse, "_fetchFearGreedHistory", fake)

    serie, error = market_pulse.fearGreedHistory(days=10)

    assert serie == []
    assert error == "sin datos"

    market_pulse.fearGreedHistory(days=10)
    assert len(llamadas) == 2
