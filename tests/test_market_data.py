"""Caché en memoria y respaldo entre proveedores de `stores.market_data`.

Cada test sustituye los clientes de proveedor por dobles: nada sale a la red.
"""

import pytest

from core import settings
from stores import market_data


@pytest.fixture(autouse=True)
def estado_limpio(monkeypatch):
    """Cada test empieza sin caché ni proveedores en reposo de uno anterior."""
    monkeypatch.setattr(market_data, "_quote_cache", {})
    monkeypatch.setattr(market_data, "_provider_resting_until", {})
    monkeypatch.setattr(settings, "cotizacionTtlSegundos", lambda: 30)


def _quote(price="100,00"):
    return {"symbol": "AAPL", "price": price, "currency": "USD", "change": "+0,00%"}


def test_usa_la_cache_dentro_del_ttl(monkeypatch):
    llamadas = []

    def finnhub_ok(symbol):
        llamadas.append(symbol)
        return _quote(), None

    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", lambda cb: finnhub_ok("AAPL"))

    quote1, error1 = market_data.fetch_asset_quote("AAPL", "finnhub")
    quote2, error2 = market_data.fetch_asset_quote("AAPL", "finnhub")

    assert error1 is None and error2 is None
    assert quote1 == quote2 == _quote()
    assert len(llamadas) == 1  # la segunda petición vino de la caché


def test_use_cache_false_ignora_la_cache_pero_la_deja_actualizada(monkeypatch):
    """El botón "Actualizar cotización" pide un dato fresco a propósito."""
    respuestas = iter([_quote("100,00"), _quote("101,00")])
    llamadas = []

    def finnhub_ok(cb):
        llamadas.append(1)
        return next(respuestas), None

    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", finnhub_ok)

    quote1, _ = market_data.fetch_asset_quote("AAPL", "finnhub")
    assert quote1 == _quote("100,00")

    # Refresco forzado: no usa la caché, pide un dato nuevo de verdad.
    quote2, _ = market_data.fetch_asset_quote("AAPL", "finnhub", use_cache=False)
    assert quote2 == _quote("101,00")
    assert len(llamadas) == 2

    # Pero deja la caché actualizada con lo nuevo, no con el precio viejo.
    quote3, _ = market_data.fetch_asset_quote("AAPL", "finnhub")
    assert quote3 == _quote("101,00")
    assert len(llamadas) == 2


def test_ttl_cero_desactiva_la_cache(monkeypatch):
    monkeypatch.setattr(settings, "cotizacionTtlSegundos", lambda: 0)
    llamadas = []

    def finnhub_ok(cb):
        llamadas.append(1)
        return _quote(), None

    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", finnhub_ok)

    market_data.fetch_asset_quote("AAPL", "finnhub")
    market_data.fetch_asset_quote("AAPL", "finnhub")

    assert len(llamadas) == 2


def test_respaldo_a_otro_proveedor_con_simbolo_portable(monkeypatch):
    """AAPL no lleva sufijo de bolsa: si Finnhub falla, prueba Yahoo."""
    monkeypatch.setattr(
        market_data, "call_finnhub_with_fallbacks",
        lambda cb: (None, "No se pudo conectar con Finnhub"),
    )
    monkeypatch.setattr(market_data, "_fetch_yahoo_quote", lambda symbol: (_quote(), None))

    quote, error = market_data.fetch_asset_quote("AAPL", "finnhub")

    assert error is None
    assert quote == _quote()


def test_sin_respaldo_para_simbolo_atado_a_eodhd(monkeypatch):
    """SAP.XETRA es sintaxis de EODHD: no tiene sentido probarlo en otro proveedor."""
    yahoo_llamado = []
    monkeypatch.setattr(
        market_data, "call_eodhd_with_fallbacks",
        lambda cb: (None, "No se pudo conectar con EODHD"),
    )
    monkeypatch.setattr(
        market_data, "_fetch_yahoo_quote",
        lambda symbol: yahoo_llamado.append(symbol) or (_quote(), None),
    )

    quote, error = market_data.fetch_asset_quote("SAP.XETRA", "eodhd")

    assert quote is None
    assert error == "No se pudo conectar con EODHD"
    assert yahoo_llamado == []


def test_target_currency_convierte_antes_de_cachear(monkeypatch):
    llamadas_conversion = []

    def finnhub_ok(cb):
        return _quote("100,00"), None

    def convertir(quote, target, timeout=None):
        llamadas_conversion.append((quote["currency"], target))
        return {**quote, "price": "92,00", "currency": target}, None

    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", finnhub_ok)
    monkeypatch.setattr(market_data, "convert_quote_currency", convertir)

    quote1, error1 = market_data.fetch_asset_quote("AAPL", "finnhub", target_currency="EUR")
    assert error1 is None
    assert quote1["price"] == "92,00"
    assert quote1["currency"] == "EUR"
    assert len(llamadas_conversion) == 1

    # Segunda petición: viene de caché, no vuelve a convertir.
    quote2, _ = market_data.fetch_asset_quote("AAPL", "finnhub", target_currency="EUR")
    assert quote2 == quote1
    assert len(llamadas_conversion) == 1


def test_target_currency_no_mezcla_cache_con_la_nativa(monkeypatch):
    llamadas = []

    def finnhub_ok(cb):
        llamadas.append(1)
        return _quote("100,00"), None

    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", finnhub_ok)
    monkeypatch.setattr(
        market_data, "convert_quote_currency",
        lambda quote, target, timeout=None: ({**quote, "price": "92,00", "currency": target}, None),
    )

    nativa, _ = market_data.fetch_asset_quote("AAPL", "finnhub")
    convertida, _ = market_data.fetch_asset_quote("AAPL", "finnhub", target_currency="EUR")

    assert nativa["currency"] == "USD" and nativa["price"] == "100,00"
    assert convertida["currency"] == "EUR" and convertida["price"] == "92,00"
    assert len(llamadas) == 2  # cada divisa pide su propia cotización, no comparten caché


def test_target_currency_igual_a_la_nativa_no_convierte(monkeypatch):
    llamadas_conversion = []
    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", lambda cb: (_quote(), None))
    monkeypatch.setattr(
        market_data, "convert_quote_currency",
        lambda quote, target, timeout=None: llamadas_conversion.append(1) or (quote, None),
    )

    quote, _ = market_data.fetch_asset_quote("AAPL", "finnhub", target_currency="USD")

    assert quote["currency"] == "USD"
    assert llamadas_conversion == []  # ya estaba en USD, no hace falta pedir el cambio


def test_target_currency_si_falla_la_conversion_devuelve_la_nativa(monkeypatch):
    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", lambda cb: (_quote("100,00"), None))
    monkeypatch.setattr(
        market_data, "convert_quote_currency",
        lambda quote, target, timeout=None: (None, "No se pudo obtener el cambio USD/EUR"),
    )

    quote, error = market_data.fetch_asset_quote("AAPL", "finnhub", target_currency="EUR")

    assert error is None
    assert quote["currency"] == "USD"
    assert quote["price"] == "100,00"


def test_limite_de_peticiones_deja_el_proveedor_en_reposo(monkeypatch):
    finnhub_llamadas = []

    def finnhub_limitado(cb):
        finnhub_llamadas.append(1)
        return None, "Finnhub: límite de peticiones alcanzado (HTTP 429)"

    monkeypatch.setattr(market_data, "call_finnhub_with_fallbacks", finnhub_limitado)
    monkeypatch.setattr(market_data, "_fetch_yahoo_quote", lambda symbol: (_quote(), None))

    # Primera petición: prueba Finnhub, falla por límite, cae a Yahoo.
    market_data.fetch_asset_quote("AAPL", "finnhub")
    # Segunda petición, símbolo distinto: Finnhub sigue en reposo, no se llama.
    market_data.fetch_asset_quote("MSFT", "finnhub")

    assert len(finnhub_llamadas) == 1
