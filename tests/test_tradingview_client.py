"""Cliente de TradingView: decodificado del ticker y filtro por mercado en la búsqueda.

Nada sale a la red: se sustituye `providers.tradingview_client._fetchJson`.
"""


from providers import tradingview_client


def _quotePayload(symbol="BINANCE:BTCUSD", price=100.0, change=1.5, currency="USD"):
    return {"data": [{"s": symbol, "d": [price, change, currency]}]}


def _batchQuotePayload(*rows):
    return {"data": [{"s": symbol, "d": [price, change, currency]} for symbol, price, change, currency in rows]}


def _searchPayload(*symbols):
    return {
        "symbols": [
            {
                "symbol": symbol,
                "exchange": exchange,
                "description": description,
                "type": "spot",
                "currency_code": "EUR",
            }
            for symbol, exchange, description in symbols
        ]
    }


def testFetchQuoteDecodificaElTickerPegadoDeUnaUrl(monkeypatch):
    monkeypatch.setattr(tradingview_client, "_fetchJson", lambda *a, **kw: _quotePayload())

    quote, error = tradingview_client.fetchQuote("BINANCE%3ABTCUSD")

    assert error is None
    assert quote["symbol"] == "BINANCE:BTCUSD"


def testFetchQuoteSinDosPuntosDaErrorClaro():
    quote, error = tradingview_client.fetchQuote("AAPL")

    assert quote is None
    assert "mercado delante" in error


def testSearchSymbolSeparaMercadoYTexto(monkeypatch):
    llamadas = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        if jsonBody is not None:
            return _quotePayload()  # cotización con la que se enriquece el resultado
        llamadas.append(dict(params))
        return _searchPayload(("BTCEUR", "BITVAVO", "Bitcoin / Euro"))

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    results, error = tradingview_client.searchSymbol("BITVAVO:BTCEUR")

    assert error is None
    assert len(llamadas) == 1
    assert llamadas[0]["text"] == "BTCEUR"
    assert llamadas[0]["exchange"] == "BITVAVO"
    assert results[0]["symbol"] == "BITVAVO:BTCEUR"


def testSearchSymbolRepiteComoTextoLibreSiElMercadoNoExiste(monkeypatch):
    llamadas = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        if jsonBody is not None:
            return _quotePayload()  # cotización con la que se enriquece el resultado
        llamadas.append(dict(params))
        if params["exchange"]:
            return _searchPayload()  # el "mercado" inventado no encuentra nada
        return _searchPayload(("AAPL", "NASDAQ", "Apple Inc."))

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    results, error = tradingview_client.searchSymbol("FAKEEXCH:AAPL")

    assert error is None
    assert len(llamadas) == 2
    assert llamadas[0]["exchange"] == "FAKEEXCH"
    assert llamadas[1]["exchange"] == ""
    assert llamadas[1]["text"] == "FAKEEXCH:AAPL"
    assert results[0]["symbol"] == "NASDAQ:AAPL"


def testSearchSymbolSinDosPuntosNoFiltraPorMercado(monkeypatch):
    llamadas = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        if jsonBody is not None:
            return _quotePayload()  # cotización con la que se enriquece el resultado
        llamadas.append(dict(params))
        return _searchPayload(("AAPL", "NASDAQ", "Apple Inc."))

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    tradingview_client.searchSymbol("Apple")

    assert len(llamadas) == 1
    assert llamadas[0]["text"] == "Apple"
    assert llamadas[0]["exchange"] == ""


def testSearchSymbolPriorizaResultadosConCotizacionReal(monkeypatch):
    """GETTEX (algunos fondos) u OANDA (según la divisa) no están en el scanner
    gratuito de TradingView aunque el instrumento cotice de verdad en su web:
    entre dos listados del mismo activo, el que sí tiene precio va primero,
    aunque el buscador lo devolviera en peor posición por relevancia."""
    llamadasCotizacion = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        if jsonBody is not None:
            llamadasCotizacion.append(jsonBody)
            return _batchQuotePayload(("LSIN:0E5R", 104.1, 0.5, "EUR"))
        # GETTEX sale primero en la respuesta del buscador (mejor relevancia),
        # LSIN segundo.
        return _searchPayload(
            ("10AF", "GETTEX", "Amundi Core MSCI Emerging Markets"),
            ("0E5R", "LSIN", "Amundi Core MSCI Emerging Markets"),
        )

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    results, error = tradingview_client.searchSymbol("MSCI Emerging Markets")

    assert error is None
    assert results[0]["symbol"] == "LSIN:0E5R"
    assert results[0]["price"] == "104,10"
    assert results[1]["symbol"] == "GETTEX:10AF"
    assert results[1]["price"] == ""
    # Una sola llamada al scanner para las dos, no una por resultado.
    assert len(llamadasCotizacion) == 1
    assert set(llamadasCotizacion[0]["symbols"]["tickers"]) == {"GETTEX:10AF", "LSIN:0E5R"}


# ── Cruces que el scanner no tiene ───────────────────────────────────────────

def _scannerQueCotiza(precios):
    """Doble del scanner: cotiza solo los tickers de `precios` y registra qué
    se le pide. `precios` es `{ticker: (precio, variación %, divisa)}`."""
    peticiones = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        tickers = jsonBody["symbols"]["tickers"]
        peticiones.append(tickers)
        return {"data": [
            {"s": t, "d": [precios[t][0], precios[t][1], precios[t][2]]}
            for t in tickers if t in precios
        ]}

    return fakeFetch, peticiones


def testUnCruceEnEurQueNoEstaSeCalculaConElParEnUsd(monkeypatch):
    # Las cifras son las reales de OANDA: 4284,97 / 1,13911 = 3761,68, lo mismo
    # que marca el gráfico de OANDA:XAUEUR en tradingview.com.
    fake, peticiones = _scannerQueCotiza({
        "OANDA:XAUUSD": (4284.97, 0.26135991389396024, "USD"),
        "OANDA:EURUSD": (1.13911, 0.09578039050280622, "USD"),
    })
    monkeypatch.setattr(tradingview_client, "_fetchJson", fake)

    quote, error = tradingview_client.fetchQuote("OANDA:XAUEUR")

    assert error is None
    assert quote["price"] == "3761,68"
    assert quote["currency"] == "EUR"
    assert quote["change"] == "+0,17%"
    assert "OANDA:XAUUSD / OANDA:EURUSD" in quote["status"]
    assert len(peticiones) == 2  # el ticker pedido, y luego las dos piezas juntas


def testSinElParEnUsdDelMismoMercadoSeQuedaSinCotizacion(monkeypatch):
    # OANDA:XAGUSD no está en el scanner. No se busca la plata en otro sitio
    # (un spot compuesto, otro bróker): eso sería decidir a mano de dónde sale
    # el precio de un activo concreto.
    fake, _ = _scannerQueCotiza({
        "TVC:SILVER": (64.2904, 0.72, "USD"),
        "OANDA:EURUSD": (1.13911, 0.09, "USD"),
    })
    monkeypatch.setattr(tradingview_client, "_fetchJson", fake)

    quote, error = tradingview_client.fetchQuote("OANDA:XAGEUR")

    assert quote is None
    assert "no devolvió cotización" in error


def testElSentidoDelCambioSeTomaDelParQueExista(monkeypatch):
    # El mercado tiene USDJPY (yenes por dólar), no JPYUSD: se multiplica. No
    # hay ninguna lista que diga qué divisas cotizan al revés.
    fake, peticiones = _scannerQueCotiza({
        "OANDA:XAUUSD": (4000.0, 0.0, "USD"),
        "OANDA:USDJPY": (150.0, 0.0, "JPY"),
    })
    monkeypatch.setattr(tradingview_client, "_fetchJson", fake)

    quote, _ = tradingview_client.fetchQuote("OANDA:XAUJPY")

    assert quote["price"] == "600000,00"
    assert quote["currency"] == "JPY"
    assert set(peticiones[1]) == {"OANDA:XAUUSD", "OANDA:JPYUSD", "OANDA:USDJPY"}


def testElCambioSeBuscaSoloEnElMismoMercado(monkeypatch):
    fake, peticiones = _scannerQueCotiza({
        "SAXO:XAUUSD": (4000.0, 0.0, "USD"),
        "OANDA:EURUSD": (1.1, 0.0, "USD"),  # otro mercado: no se usa
    })
    monkeypatch.setattr(tradingview_client, "_fetchJson", fake)

    quote, _ = tradingview_client.fetchQuote("SAXO:XAUEUR")

    assert quote is None
    assert all(t.startswith("SAXO:") for t in peticiones[1])


def testUnaCotizacionRealNoSeSustituyePorLaCalculada(monkeypatch):
    fake, peticiones = _scannerQueCotiza({"OANDA:XAUEUR": (3700.0, 0.0, "EUR")})
    monkeypatch.setattr(tradingview_client, "_fetchJson", fake)

    quote, _ = tradingview_client.fetchQuote("OANDA:XAUEUR")

    assert quote["price"] == "3700,00"
    assert quote["status"] == "Cotización actualizada"
    assert len(peticiones) == 1


def testSinPiezasParaCalcularloSigueSinCotizacion(monkeypatch):
    fake, _ = _scannerQueCotiza({})
    monkeypatch.setattr(tradingview_client, "_fetchJson", fake)

    quote, error = tradingview_client.fetchQuote("OANDA:XAUEUR")

    assert quote is None
    assert "no devolvió cotización" in error


def testLaBusquedaCalculaElCruceQueFalta(monkeypatch):
    precios = {
        "OANDA:XAUUSD": (4284.97, 0.26, "USD"),
        "OANDA:EURUSD": (1.13911, 0.09, "USD"),
    }

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        if jsonBody is None:
            return {"symbols": [
                {"symbol": "XAUEUR", "exchange": "OANDA", "description": "Gold/EUR",
                 "type": "commodity", "currency_code": "EUR"},
            ]}
        tickers = jsonBody["symbols"]["tickers"]
        return {"data": [{"s": t, "d": list(precios[t])} for t in tickers if t in precios]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    results, error = tradingview_client.searchSymbol("OANDA:XAUEUR")

    assert error is None
    assert results[0]["symbol"] == "OANDA:XAUEUR"
    assert results[0]["price"] == "3761,68"
    assert results[0]["currency"] == "EUR"


def testLosPerpetuosQuedanDetrasDelActivo(monkeypatch):
    """Buscar "XAG" devolvía primero BINANCE:XAGUSDT.P y compañía."""
    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        if jsonBody is None:
            return {"symbols": [
                {"symbol": "XAGUSDT.P", "exchange": "BINANCE", "description": "XAG / TetherUS PERPETUAL",
                 "type": "swap", "currency_code": "USDT"},
                {"symbol": "XAGUSD", "exchange": "OANDA", "description": "Silver",
                 "type": "commodity", "currency_code": "USD"},
            ]}
        return {"data": [{"s": t, "d": [64.2, 0.1, "USD"]} for t in jsonBody["symbols"]["tickers"]]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    results, _ = tradingview_client.searchSymbol("XAG", preferredAssetType="comoditis")

    assert [r["symbol"] for r in results] == ["OANDA:XAGUSD", "BINANCE:XAGUSDT.P"]


# ── Screener real (subidas/bajadas, amplitud de mercado) ────────────────────

def testFetchScreenerMandaFiltroOrdenYRango(monkeypatch):
    peticiones = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        peticiones.append((url, jsonBody))
        return {"totalCount": 2, "data": [{"s": "NASDAQ:AAA", "d": ["AAA", 10.0, 5.0]}]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    filtro = [{"left": "market_cap_basic", "operation": "greater", "right": 1_000_000}]
    payload = tradingview_client.fetchScreener(
        filtro, ["name", "close", "change"], sortBy="change", sortOrder="desc", limit=5,
        instrumentTypes=["stock"],
    )

    assert len(peticiones) == 1
    url, body = peticiones[0]
    assert url == "https://scanner.tradingview.com/america/scan"
    assert body["filter"] == filtro
    assert body["sort"] == {"sortBy": "change", "sortOrder": "desc"}
    assert body["range"] == [0, 5]
    assert body["symbols"]["query"]["types"] == ["stock"]
    assert payload["totalCount"] == 2


def testFetchScreenerSinSortNoLoManda(monkeypatch):
    peticiones = []
    monkeypatch.setattr(
        tradingview_client, "_fetchJson",
        lambda url, params=None, timeout=None, jsonBody=None, headers=None: (peticiones.append(jsonBody) or {}),
    )

    tradingview_client.fetchScreener([], ["name"], limit=1)

    assert "sort" not in peticiones[0]


def testFetchQuotesEsUnEnvoltorioDeScan(monkeypatch):
    peticiones = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        peticiones.append(jsonBody["symbols"]["tickers"])
        return {"data": [{"s": "SP:SPX", "d": [6700.0, 0.5, "USD"]}]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    cotizados = tradingview_client.fetchQuotes(["SP:SPX"])

    assert cotizados == {"SP:SPX": (6700.0, 0.5, "USD")}
    assert peticiones[0] == ["SP:SPX"]


# ── Fundamentales y técnico (página de Estadísticas de mercado) ─────────────

def testFetchStatsJuntaCadaColumnaConSuValor(monkeypatch):
    peticiones = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        peticiones.append(jsonBody)
        columnas = jsonBody["columns"]
        valores = [42.0 if c == "market_cap_basic" else None for c in columnas]
        return {"data": [{"s": "NASDAQ:AAPL", "d": valores}]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    stats = tradingview_client.fetchStats(["NASDAQ:AAPL"])

    assert len(peticiones) == 1
    assert stats["NASDAQ:AAPL"]["market_cap_basic"] == 42.0
    # Un campo que no aplica a este instrumento (p.ej. sector de una cripto)
    # llega como None tal cual lo da el scanner, no como un valor inventado.
    assert stats["NASDAQ:AAPL"]["sector"] is None


def testFetchStatsUnaSolaPeticionParaVariosTickers(monkeypatch):
    peticiones = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        peticiones.append(jsonBody["symbols"]["tickers"])
        return {"data": []}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    tradingview_client.fetchStats(["NASDAQ:AAPL", "NASDAQ:MSFT"])

    assert len(peticiones) == 1
    assert set(peticiones[0]) == {"NASDAQ:AAPL", "NASDAQ:MSFT"}


def testFetchStatsPideLosPivotesDeCadaMetodoYPeriodo(monkeypatch):
    peticiones = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        peticiones.append(jsonBody["columns"])
        return {"data": []}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    tradingview_client.fetchStats(["NASDAQ:AAPL"])

    columnas = peticiones[0]
    for method in tradingview_client.PIVOT_METHODS:
        for suffix in tradingview_client.PIVOT_PERIODS.values():
            for level in tradingview_client.PIVOT_LEVELS:
                assert f"Pivot.M.{method}.{level}{suffix}" in columnas
    # Una columna repetida desplazaría el emparejamiento nombre-valor de la fila.
    assert len(columnas) == len(set(columnas))


def testFetchStatsIncluyeRendimientoYVolatilidad(monkeypatch):
    peticiones = []

    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        peticiones.append(jsonBody["columns"])
        columnas = jsonBody["columns"]
        return {"data": [{"s": "BITVAVO:BTCEUR", "d": [-3.4 if c == "Perf.1M" else None for c in columnas]}]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    stats = tradingview_client.fetchStats(["BITVAVO:BTCEUR"])

    for columna in ("Perf.W", "Perf.YTD", "price_52_week_high", "High.All", "ATR", "Volatility.D",
                    "Recommend.MA", "Recommend.Other", "CCI20", "fundamental_currency_code"):
        assert columna in peticiones[0]
    assert stats["BITVAVO:BTCEUR"]["Perf.1M"] == -3.4


def testFetchStatsSinTickersNoLlamaALaRed(monkeypatch):
    def fakeFetch(*a, **kw):
        raise AssertionError("no debería llamar a la red sin tickers")

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    assert tradingview_client.fetchStats([]) == {}


def testSinTipoDeActivoMandaElOrdenDeTradingview(monkeypatch):
    """Sin tipo elegido no hay preferencia por ninguna clase de instrumento."""
    def fakeFetch(url, params=None, timeout=None, jsonBody=None, headers=None):
        if jsonBody is None:
            return {"symbols": [
                {"symbol": "XAGUSDT.P", "exchange": "BINANCE", "description": "XAG / TetherUS PERPETUAL",
                 "type": "swap", "currency_code": "USDT"},
                {"symbol": "XAGUSD", "exchange": "OANDA", "description": "Silver",
                 "type": "commodity", "currency_code": "USD"},
            ]}
        return {"data": [{"s": t, "d": [64.2, 0.1, "USD"]} for t in jsonBody["symbols"]["tickers"]]}

    monkeypatch.setattr(tradingview_client, "_fetchJson", fakeFetch)

    results, _ = tradingview_client.searchSymbol("XAG")

    assert [r["symbol"] for r in results] == ["BINANCE:XAGUSDT.P", "OANDA:XAGUSD"]
