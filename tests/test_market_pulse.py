"""Catálogos curados, screener real y caché de `stores.market_pulse`.

Nada sale a la red: se sustituyen `tradingview_client.fetch_stats` /
`fetch_screener` y `feargreed_client.fetch_index` (importado en
`market_pulse` como `_fetch_fear_greed_index`).
"""

from providers import tradingview_client
from stores import market_pulse


def setup_function():
    # La caché en memoria del módulo no debe filtrarse entre tests.
    market_pulse._cache.clear()


def _stats(ticker, close, change, aum=None, currency="USD"):
    return {ticker: {"close": close, "change": change, "currency": currency, "aum": aum}}


def test_snapshot_junta_indices_y_sectores_en_una_sola_llamada(monkeypatch):
    llamadas = []

    def fake_fetch_stats(tickers, timeout=None):
        llamadas.append(tickers)
        return {
            **_stats("SP:SPX", 6700.0, 0.5),
            **_stats("AMEX:XLK", 250.0, -1.2, aum=126_000_000_000),
        }

    monkeypatch.setattr(tradingview_client, "fetch_stats", fake_fetch_stats)

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


def test_snapshot_se_cachea_dentro_del_ttl(monkeypatch):
    llamadas = []
    monkeypatch.setattr(tradingview_client, "fetch_stats", lambda t, timeout=None: llamadas.append(t) or {})

    market_pulse.snapshot()
    market_pulse.snapshot()

    assert len(llamadas) == 1


def test_top_movers_pide_subidas_y_bajadas_con_el_mismo_universo(monkeypatch):
    ordenes = []

    def fake_screener(filter_clauses, columns, sort_by=None, sort_order="desc", limit=50,
                       instrument_types=None, market="america", timeout=None):
        ordenes.append(sort_order)
        precio = 100.0 if sort_order == "desc" else 50.0
        cambio = 8.0 if sort_order == "desc" else -6.0
        return {"data": [{"s": "NASDAQ:X", "d": ["X", "X Corp", precio, cambio, 3_000_000_000, "Tech", "NASDAQ"]}]}

    monkeypatch.setattr(tradingview_client, "fetch_screener", fake_screener)

    datos = market_pulse.top_movers(limit=5)

    assert set(ordenes) == {"desc", "asc"}
    assert datos["subidas"][0]["change"] == 8.0
    assert datos["bajadas"][0]["change"] == -6.0
    assert datos["subidas"][0]["ticker"] == "X"
    assert datos["subidas"][0]["symbol"] == "NASDAQ:X"


def test_breadth_resta_subidas_y_bajadas_del_total(monkeypatch):
    def fake_screener(filter_clauses, columns, sort_by=None, sort_order="desc", limit=50,
                       instrument_types=None, market="america", timeout=None):
        # El filtro extra de "change > 0" / "change < 0" es el último de la lista.
        if any(f.get("right") == 0 and f.get("operation") == "greater" for f in filter_clauses):
            return {"totalCount": 1200}
        if any(f.get("right") == 0 and f.get("operation") == "less" for f in filter_clauses):
            return {"totalCount": 900}
        return {"totalCount": 2200}

    monkeypatch.setattr(tradingview_client, "fetch_screener", fake_screener)

    datos = market_pulse.breadth()

    assert datos == {"subidas": 1200, "bajadas": 900, "planas": 100, "total": 2200}


def test_rsi_extremes_pide_sobrecompra_y_sobreventa_con_el_mismo_universo(monkeypatch):
    ordenes = []

    def fake_screener(filter_clauses, columns, sort_by=None, sort_order="desc", limit=50,
                       instrument_types=None, market="america", timeout=None):
        ordenes.append((sort_by, sort_order))
        rsi = 82.0 if sort_order == "desc" else 14.0
        return {"data": [{"s": "NASDAQ:X", "d": ["X", "X Corp", 100.0, 1.5, rsi, "Tech", "NASDAQ"]}]}

    monkeypatch.setattr(tradingview_client, "fetch_screener", fake_screener)

    datos = market_pulse.rsi_extremes(limit=5)

    assert set(ordenes) == {("RSI", "desc"), ("RSI", "asc")}
    assert datos["sobrecompra"][0]["rsi"] == 82.0
    assert datos["sobreventa"][0]["rsi"] == 14.0


def test_unusual_volume_ordena_por_volumen_relativo(monkeypatch):
    peticiones = []

    def fake_screener(filter_clauses, columns, sort_by=None, sort_order="desc", limit=50,
                       instrument_types=None, market="america", timeout=None):
        peticiones.append((sort_by, sort_order))
        return {"data": [{"s": "NASDAQ:X", "d": ["X", "X Corp", 100.0, 1.5, 4.2, "Tech", "NASDAQ"]}]}

    monkeypatch.setattr(tradingview_client, "fetch_screener", fake_screener)

    datos = market_pulse.unusual_volume(limit=8)

    assert peticiones == [("relative_volume_10d_calc", "desc")]
    assert datos[0]["relativeVolume"] == 4.2
    assert datos[0]["ticker"] == "X"


def _fila_cripto(symbol, base, desc, precio, cambio, cap):
    return {"s": symbol, "d": [base, desc, precio, cambio, cap]}


def test_top_cryptos_dedupe_por_moneda_base(monkeypatch):
    """El mismo BTC cotiza en media docena de exchanges con el mismo AUM: solo
    debe quedar una fila por `base_currency`, la primera (más cara) que llega."""
    peticiones = []

    def fake_screener(filter_clauses, columns, sort_by=None, sort_order="desc", limit=50,
                       instrument_types=None, market="america", timeout=None):
        peticiones.append(market)
        return {"data": [
            _fila_cripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 1_700_000_000_000),
            _fila_cripto("KRAKEN:BTCUSD", "BTC", "Bitcoin", 84900.0, 0.4, 1_699_000_000_000),
            _fila_cripto("BINANCE:ETHUSD", "ETH", "Ethereum", 2700.0, 0.8, 330_000_000_000),
        ]}

    monkeypatch.setattr(tradingview_client, "fetch_screener", fake_screener)

    filas = market_pulse.top_cryptos(limit=30)

    assert peticiones == ["crypto"]
    assert [f["ticker"] for f in filas] == ["BTC", "ETH"]
    assert filas[0]["symbol"] == "BINANCE:BTCUSD"
    assert filas[0]["marketCap"] == 1_700_000_000_000


def test_top_cryptos_se_para_en_el_limite_de_monedas_unicas(monkeypatch):
    def fake_screener(filter_clauses, columns, sort_by=None, sort_order="desc", limit=50,
                       instrument_types=None, market="america", timeout=None):
        return {"data": [
            _fila_cripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 3),
            _fila_cripto("BINANCE:ETHUSD", "ETH", "Ethereum", 2700.0, 0.8, 2),
            _fila_cripto("BINANCE:SOLUSD", "SOL", "Solana", 120.0, 1.1, 1),
        ]}

    monkeypatch.setattr(tradingview_client, "fetch_screener", fake_screener)

    filas = market_pulse.top_cryptos(limit=2)

    assert [f["ticker"] for f in filas] == ["BTC", "ETH"]


def _fila_nasdaq(symbol, ticker, desc, precio, cambio, cap, en_ndx):
    indices = [{"name": "NASDAQ 100", "proname": "NASDAQ:NDX"}] if en_ndx else [{"name": "Russell 3000", "proname": "TVC:RUA"}]
    return {"s": symbol, "d": [ticker, desc, precio, cambio, cap, indices]}


def test_top_nasdaq100_filtra_por_pertenencia_real_al_indice(monkeypatch):
    """La pertenencia sale del propio campo `indexes` de cada fila, no de una
    lista de 100 tickers copiada a mano."""
    def fake_screener(filter_clauses, columns, sort_by=None, sort_order="desc", limit=50,
                       instrument_types=None, market="america", timeout=None):
        assert filter_clauses == [{"left": "exchange", "operation": "in_range", "right": ["NASDAQ"]}]
        return {"data": [
            _fila_nasdaq("NASDAQ:AAPL", "AAPL", "Apple Inc.", 341.0, 0.5, 5_000_000_000_000, en_ndx=True),
            _fila_nasdaq("NASDAQ:XYZ", "XYZ", "XYZ Corp", 10.0, -0.3, 3_000_000_000, en_ndx=False),
        ]}

    monkeypatch.setattr(tradingview_client, "fetch_screener", fake_screener)

    filas = market_pulse.top_nasdaq100(limit=40)

    assert [f["ticker"] for f in filas] == ["AAPL"]


def test_universe_desconocido_devuelve_none(monkeypatch):
    assert market_pulse.universe("no-existe") is None


def test_universe_sp500_reusa_snapshot(monkeypatch):
    monkeypatch.setattr(tradingview_client, "fetch_stats", lambda t, timeout=None: {
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


def test_universe_filtra_filas_sin_cambio_o_sin_tamano(monkeypatch):
    monkeypatch.setattr(tradingview_client, "fetch_screener", lambda *a, **kw: {"data": [
        _fila_cripto("BINANCE:BTCUSD", "BTC", "Bitcoin", 85000.0, 0.5, 1_700_000_000_000),
        _fila_cripto("BINANCE:ETHUSD", "ETH", "Ethereum", 2700.0, None, 330_000_000_000),
    ]})

    filas = market_pulse.universe("cripto")

    assert [f["symbol"] for f in filas] == ["BINANCE:BTCUSD"]


def test_fear_greed_se_cachea_solo_si_hay_exito(monkeypatch):
    llamadas = []

    def fake(timeout=None):
        llamadas.append(1)
        return {"valor": 55, "clasificacion": "Neutral", "timestamp": "1700000000"}, None

    monkeypatch.setattr(market_pulse, "_fetch_fear_greed_index", fake)

    datos1, error1 = market_pulse.fear_greed()
    datos2, error2 = market_pulse.fear_greed()

    assert error1 is None and error2 is None
    assert datos1 == datos2
    assert len(llamadas) == 1  # la segunda llamada sale de la caché


def test_fear_greed_no_cachea_el_error(monkeypatch):
    llamadas = []

    def fake(timeout=None):
        llamadas.append(1)
        return None, "sin datos"

    monkeypatch.setattr(market_pulse, "_fetch_fear_greed_index", fake)

    datos, error = market_pulse.fear_greed()

    assert datos is None
    assert error == "sin datos"

    market_pulse.fear_greed()
    assert len(llamadas) == 2  # no se cachea el fallo: se reintenta en la siguiente llamada


def test_fear_greed_history_pide_el_dia_mas_reciente_primero(monkeypatch):
    llamadas = []

    def fake(days, timeout=None):
        llamadas.append(days)
        return [{"valor": 70, "clasificacion": "Greed", "timestamp": "1700000000"}], None

    monkeypatch.setattr(market_pulse, "_fetch_fear_greed_history", fake)

    serie, error = market_pulse.fear_greed_history()

    assert error is None
    assert serie[0]["valor"] == 70
    assert llamadas == [market_pulse._FEAR_GREED_HISTORY_DAYS]


def test_fear_greed_history_se_cachea_por_numero_de_dias(monkeypatch):
    llamadas = []

    def fake(days, timeout=None):
        llamadas.append(days)
        return [], None

    monkeypatch.setattr(market_pulse, "_fetch_fear_greed_history", fake)

    market_pulse.fear_greed_history(days=30)
    market_pulse.fear_greed_history(days=30)
    market_pulse.fear_greed_history(days=90)

    # 30 y 90 días son cachés distintas: la segunda llamada con 30 sale de la
    # caché, pero 90 es una ventana distinta y pide su propia serie.
    assert llamadas == [30, 90]


def test_fear_greed_history_no_cachea_el_error(monkeypatch):
    llamadas = []

    def fake(days, timeout=None):
        llamadas.append(1)
        return [], "sin datos"

    monkeypatch.setattr(market_pulse, "_fetch_fear_greed_history", fake)

    serie, error = market_pulse.fear_greed_history(days=10)

    assert serie == []
    assert error == "sin datos"

    market_pulse.fear_greed_history(days=10)
    assert len(llamadas) == 2
