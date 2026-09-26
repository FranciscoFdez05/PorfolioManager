"""Cliente de TradingView: decodificado del ticker y filtro por mercado en la búsqueda.

Nada sale a la red: se sustituye `providers.tradingview_client._fetch_json`.
"""

import pytest

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
