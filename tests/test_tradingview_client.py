"""Cliente de TradingView: decodificado del ticker y filtro por mercado en la búsqueda.

Nada sale a la red: se sustituye `providers.tradingview_client._fetch_json`.
"""


from providers import tradingview_client


def _quote_payload(symbol="BINANCE:BTCUSD", price=100.0, change=1.5, currency="USD"):
    return {"data": [{"s": symbol, "d": [price, change, currency]}]}


def _batch_quote_payload(*rows):
    return {"data": [{"s": symbol, "d": [price, change, currency]} for symbol, price, change, currency in rows]}


def _search_payload(*symbols):
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


def test_fetch_quote_decodifica_el_ticker_pegado_de_una_url(monkeypatch):
    monkeypatch.setattr(tradingview_client, "_fetch_json", lambda *a, **kw: _quote_payload())

    quote, error = tradingview_client.fetch_quote("BINANCE%3ABTCUSD")

    assert error is None
    assert quote["symbol"] == "BINANCE:BTCUSD"


def test_fetch_quote_sin_dos_puntos_da_error_claro():
    quote, error = tradingview_client.fetch_quote("AAPL")

    assert quote is None
    assert "mercado delante" in error


def test_search_symbol_separa_mercado_y_texto(monkeypatch):
    llamadas = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        if json_body is not None:
            return _quote_payload()  # cotización con la que se enriquece el resultado
        llamadas.append(dict(params))
        return _search_payload(("BTCEUR", "BITVAVO", "Bitcoin / Euro"))

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    results, error = tradingview_client.search_symbol("BITVAVO:BTCEUR")

    assert error is None
    assert len(llamadas) == 1
    assert llamadas[0]["text"] == "BTCEUR"
    assert llamadas[0]["exchange"] == "BITVAVO"
    assert results[0]["symbol"] == "BITVAVO:BTCEUR"


def test_search_symbol_repite_como_texto_libre_si_el_mercado_no_existe(monkeypatch):
    llamadas = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        if json_body is not None:
            return _quote_payload()  # cotización con la que se enriquece el resultado
        llamadas.append(dict(params))
        if params["exchange"]:
            return _search_payload()  # el "mercado" inventado no encuentra nada
        return _search_payload(("AAPL", "NASDAQ", "Apple Inc."))

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    results, error = tradingview_client.search_symbol("FAKEEXCH:AAPL")

    assert error is None
    assert len(llamadas) == 2
    assert llamadas[0]["exchange"] == "FAKEEXCH"
    assert llamadas[1]["exchange"] == ""
    assert llamadas[1]["text"] == "FAKEEXCH:AAPL"
    assert results[0]["symbol"] == "NASDAQ:AAPL"


def test_search_symbol_sin_dos_puntos_no_filtra_por_mercado(monkeypatch):
    llamadas = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        if json_body is not None:
            return _quote_payload()  # cotización con la que se enriquece el resultado
        llamadas.append(dict(params))
        return _search_payload(("AAPL", "NASDAQ", "Apple Inc."))

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    tradingview_client.search_symbol("Apple")

    assert len(llamadas) == 1
    assert llamadas[0]["text"] == "Apple"
    assert llamadas[0]["exchange"] == ""


def test_search_symbol_prioriza_resultados_con_cotizacion_real(monkeypatch):
    """GETTEX (algunos fondos) u OANDA (según la divisa) no están en el scanner
    gratuito de TradingView aunque el instrumento cotice de verdad en su web:
    entre dos listados del mismo activo, el que sí tiene precio va primero,
    aunque el buscador lo devolviera en peor posición por relevancia."""
    llamadas_cotizacion = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        if json_body is not None:
            llamadas_cotizacion.append(json_body)
            return _batch_quote_payload(("LSIN:0E5R", 104.1, 0.5, "EUR"))
        # GETTEX sale primero en la respuesta del buscador (mejor relevancia),
        # LSIN segundo.
        return _search_payload(
            ("10AF", "GETTEX", "Amundi Core MSCI Emerging Markets"),
            ("0E5R", "LSIN", "Amundi Core MSCI Emerging Markets"),
        )

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    results, error = tradingview_client.search_symbol("MSCI Emerging Markets")

    assert error is None
    assert results[0]["symbol"] == "LSIN:0E5R"
    assert results[0]["price"] == "104,10"
    assert results[1]["symbol"] == "GETTEX:10AF"
    assert results[1]["price"] == ""
    # Una sola llamada al scanner para las dos, no una por resultado.
    assert len(llamadas_cotizacion) == 1
    assert set(llamadas_cotizacion[0]["symbols"]["tickers"]) == {"GETTEX:10AF", "LSIN:0E5R"}


# ── Cruces que el scanner no tiene ───────────────────────────────────────────

def _scanner_que_cotiza(precios):
    """Doble del scanner: cotiza solo los tickers de `precios` y registra qué
    se le pide. `precios` es `{ticker: (precio, variación %, divisa)}`."""
    peticiones = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        tickers = json_body["symbols"]["tickers"]
        peticiones.append(tickers)
        return {"data": [
            {"s": t, "d": [precios[t][0], precios[t][1], precios[t][2]]}
            for t in tickers if t in precios
        ]}

    return fake_fetch, peticiones


def test_un_cruce_en_eur_que_no_esta_se_calcula_con_el_par_en_usd(monkeypatch):
    # Las cifras son las reales de OANDA: 4284,97 / 1,13911 = 3761,68, lo mismo
    # que marca el gráfico de OANDA:XAUEUR en tradingview.com.
    fake, peticiones = _scanner_que_cotiza({
        "OANDA:XAUUSD": (4284.97, 0.26135991389396024, "USD"),
        "OANDA:EURUSD": (1.13911, 0.09578039050280622, "USD"),
    })
    monkeypatch.setattr(tradingview_client, "_fetch_json", fake)

    quote, error = tradingview_client.fetch_quote("OANDA:XAUEUR")

    assert error is None
    assert quote["price"] == "3761,68"
    assert quote["currency"] == "EUR"
    assert quote["change"] == "+0,17%"
    assert "OANDA:XAUUSD / OANDA:EURUSD" in quote["status"]
    assert len(peticiones) == 2  # el ticker pedido, y luego las dos piezas juntas


def test_sin_el_par_en_usd_del_mismo_mercado_se_queda_sin_cotizacion(monkeypatch):
    # OANDA:XAGUSD no está en el scanner. No se busca la plata en otro sitio
    # (un spot compuesto, otro bróker): eso sería decidir a mano de dónde sale
    # el precio de un activo concreto.
    fake, _ = _scanner_que_cotiza({
        "TVC:SILVER": (64.2904, 0.72, "USD"),
        "OANDA:EURUSD": (1.13911, 0.09, "USD"),
    })
    monkeypatch.setattr(tradingview_client, "_fetch_json", fake)

    quote, error = tradingview_client.fetch_quote("OANDA:XAGEUR")

    assert quote is None
    assert "no devolvió cotización" in error


def test_el_sentido_del_cambio_se_toma_del_par_que_exista(monkeypatch):
    # El mercado tiene USDJPY (yenes por dólar), no JPYUSD: se multiplica. No
    # hay ninguna lista que diga qué divisas cotizan al revés.
    fake, peticiones = _scanner_que_cotiza({
        "OANDA:XAUUSD": (4000.0, 0.0, "USD"),
        "OANDA:USDJPY": (150.0, 0.0, "JPY"),
    })
    monkeypatch.setattr(tradingview_client, "_fetch_json", fake)

    quote, _ = tradingview_client.fetch_quote("OANDA:XAUJPY")

    assert quote["price"] == "600000,00"
    assert quote["currency"] == "JPY"
    assert set(peticiones[1]) == {"OANDA:XAUUSD", "OANDA:JPYUSD", "OANDA:USDJPY"}


def test_el_cambio_se_busca_solo_en_el_mismo_mercado(monkeypatch):
    fake, peticiones = _scanner_que_cotiza({
        "SAXO:XAUUSD": (4000.0, 0.0, "USD"),
        "OANDA:EURUSD": (1.1, 0.0, "USD"),  # otro mercado: no se usa
    })
    monkeypatch.setattr(tradingview_client, "_fetch_json", fake)

    quote, _ = tradingview_client.fetch_quote("SAXO:XAUEUR")

    assert quote is None
    assert all(t.startswith("SAXO:") for t in peticiones[1])


def test_una_cotizacion_real_no_se_sustituye_por_la_calculada(monkeypatch):
    fake, peticiones = _scanner_que_cotiza({"OANDA:XAUEUR": (3700.0, 0.0, "EUR")})
    monkeypatch.setattr(tradingview_client, "_fetch_json", fake)

    quote, _ = tradingview_client.fetch_quote("OANDA:XAUEUR")

    assert quote["price"] == "3700,00"
    assert quote["status"] == "Cotización actualizada"
    assert len(peticiones) == 1


def test_sin_piezas_para_calcularlo_sigue_sin_cotizacion(monkeypatch):
    fake, _ = _scanner_que_cotiza({})
    monkeypatch.setattr(tradingview_client, "_fetch_json", fake)

    quote, error = tradingview_client.fetch_quote("OANDA:XAUEUR")

    assert quote is None
    assert "no devolvió cotización" in error


def test_la_busqueda_calcula_el_cruce_que_falta(monkeypatch):
    precios = {
        "OANDA:XAUUSD": (4284.97, 0.26, "USD"),
        "OANDA:EURUSD": (1.13911, 0.09, "USD"),
    }

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        if json_body is None:
            return {"symbols": [
                {"symbol": "XAUEUR", "exchange": "OANDA", "description": "Gold/EUR",
                 "type": "commodity", "currency_code": "EUR"},
            ]}
        tickers = json_body["symbols"]["tickers"]
        return {"data": [{"s": t, "d": list(precios[t])} for t in tickers if t in precios]}

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    results, error = tradingview_client.search_symbol("OANDA:XAUEUR")

    assert error is None
    assert results[0]["symbol"] == "OANDA:XAUEUR"
    assert results[0]["price"] == "3761,68"
    assert results[0]["currency"] == "EUR"


def test_los_perpetuos_quedan_detras_del_activo(monkeypatch):
    """Buscar "XAG" devolvía primero BINANCE:XAGUSDT.P y compañía."""
    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        if json_body is None:
            return {"symbols": [
                {"symbol": "XAGUSDT.P", "exchange": "BINANCE", "description": "XAG / TetherUS PERPETUAL",
                 "type": "swap", "currency_code": "USDT"},
                {"symbol": "XAGUSD", "exchange": "OANDA", "description": "Silver",
                 "type": "commodity", "currency_code": "USD"},
            ]}
        return {"data": [{"s": t, "d": [64.2, 0.1, "USD"]} for t in json_body["symbols"]["tickers"]]}

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    results, _ = tradingview_client.search_symbol("XAG", preferred_asset_type="comoditis")

    assert [r["symbol"] for r in results] == ["OANDA:XAGUSD", "BINANCE:XAGUSDT.P"]


# ── Screener real (subidas/bajadas, amplitud de mercado) ────────────────────

def test_fetch_screener_manda_filtro_orden_y_rango(monkeypatch):
    peticiones = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        peticiones.append((url, json_body))
        return {"totalCount": 2, "data": [{"s": "NASDAQ:AAA", "d": ["AAA", 10.0, 5.0]}]}

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    filtro = [{"left": "market_cap_basic", "operation": "greater", "right": 1_000_000}]
    payload = tradingview_client.fetch_screener(
        filtro, ["name", "close", "change"], sort_by="change", sort_order="desc", limit=5,
        instrument_types=["stock"],
    )

    assert len(peticiones) == 1
    url, body = peticiones[0]
    assert url == "https://scanner.tradingview.com/america/scan"
    assert body["filter"] == filtro
    assert body["sort"] == {"sortBy": "change", "sortOrder": "desc"}
    assert body["range"] == [0, 5]
    assert body["symbols"]["query"]["types"] == ["stock"]
    assert payload["totalCount"] == 2


def test_fetch_screener_sin_sort_no_lo_manda(monkeypatch):
    peticiones = []
    monkeypatch.setattr(
        tradingview_client, "_fetch_json",
        lambda url, params=None, timeout=None, json_body=None, headers=None: (peticiones.append(json_body) or {}),
    )

    tradingview_client.fetch_screener([], ["name"], limit=1)

    assert "sort" not in peticiones[0]


def test_fetch_quotes_es_un_envoltorio_de_scan(monkeypatch):
    peticiones = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        peticiones.append(json_body["symbols"]["tickers"])
        return {"data": [{"s": "SP:SPX", "d": [6700.0, 0.5, "USD"]}]}

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    cotizados = tradingview_client.fetch_quotes(["SP:SPX"])

    assert cotizados == {"SP:SPX": (6700.0, 0.5, "USD")}
    assert peticiones[0] == ["SP:SPX"]


# ── Fundamentales y técnico (página de Estadísticas de mercado) ─────────────

def test_fetch_stats_junta_cada_columna_con_su_valor(monkeypatch):
    peticiones = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        peticiones.append(json_body)
        columnas = json_body["columns"]
        valores = [42.0 if c == "market_cap_basic" else None for c in columnas]
        return {"data": [{"s": "NASDAQ:AAPL", "d": valores}]}

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    stats = tradingview_client.fetch_stats(["NASDAQ:AAPL"])

    assert len(peticiones) == 1
    assert stats["NASDAQ:AAPL"]["market_cap_basic"] == 42.0
    # Un campo que no aplica a este instrumento (p.ej. sector de una cripto)
    # llega como None tal cual lo da el scanner, no como un valor inventado.
    assert stats["NASDAQ:AAPL"]["sector"] is None


def test_fetch_stats_una_sola_peticion_para_varios_tickers(monkeypatch):
    peticiones = []

    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        peticiones.append(json_body["symbols"]["tickers"])
        return {"data": []}

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    tradingview_client.fetch_stats(["NASDAQ:AAPL", "NASDAQ:MSFT"])

    assert len(peticiones) == 1
    assert set(peticiones[0]) == {"NASDAQ:AAPL", "NASDAQ:MSFT"}


def test_fetch_stats_sin_tickers_no_llama_a_la_red(monkeypatch):
    def fake_fetch(*a, **kw):
        raise AssertionError("no debería llamar a la red sin tickers")

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    assert tradingview_client.fetch_stats([]) == {}


def test_sin_tipo_de_activo_manda_el_orden_de_tradingview(monkeypatch):
    """Sin tipo elegido no hay preferencia por ninguna clase de instrumento."""
    def fake_fetch(url, params=None, timeout=None, json_body=None, headers=None):
        if json_body is None:
            return {"symbols": [
                {"symbol": "XAGUSDT.P", "exchange": "BINANCE", "description": "XAG / TetherUS PERPETUAL",
                 "type": "swap", "currency_code": "USDT"},
                {"symbol": "XAGUSD", "exchange": "OANDA", "description": "Silver",
                 "type": "commodity", "currency_code": "USD"},
            ]}
        return {"data": [{"s": t, "d": [64.2, 0.1, "USD"]} for t in json_body["symbols"]["tickers"]]}

    monkeypatch.setattr(tradingview_client, "_fetch_json", fake_fetch)

    results, _ = tradingview_client.search_symbol("XAG")

    assert [r["symbol"] for r in results] == ["BINANCE:XAGUSDT.P", "OANDA:XAGUSD"]
