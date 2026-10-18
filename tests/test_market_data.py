"""Caché en memoria y respaldo entre proveedores de `stores.market_data`.

Cada test sustituye los clientes de proveedor por dobles: nada sale a la red.
"""

import pytest

from core import settings
from stores import market_data


@pytest.fixture(autouse=True)
def estadoLimpio(monkeypatch):
    """Cada test empieza sin caché ni proveedores en reposo de uno anterior."""
    monkeypatch.setattr(market_data, "_quoteCache", {})
    monkeypatch.setattr(market_data, "_providerRestingUntil", {})
    monkeypatch.setattr(settings, "cotizacionTtlSegundos", lambda: 30)


def _quote(price="100,00"):
    return {"symbol": "AAPL", "price": price, "currency": "USD", "change": "+0,00%"}


def testUsaLaCacheDentroDelTtl(monkeypatch):
    llamadas = []

    def finnhubOk(symbol):
        llamadas.append(symbol)
        return _quote(), None

    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", lambda cb: finnhubOk("AAPL"))

    quote1, error1 = market_data.fetchAssetQuote("AAPL", "finnhub")
    quote2, error2 = market_data.fetchAssetQuote("AAPL", "finnhub")

    assert error1 is None and error2 is None
    assert quote1 == quote2 == _quote()
    assert len(llamadas) == 1  # la segunda petición vino de la caché


def testUseCacheFalseIgnoraLaCachePeroLaDejaActualizada(monkeypatch):
    """El botón "Actualizar cotización" pide un dato fresco a propósito."""
    respuestas = iter([_quote("100,00"), _quote("101,00")])
    llamadas = []

    def finnhubOk(cb):
        llamadas.append(1)
        return next(respuestas), None

    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", finnhubOk)

    quote1, _ = market_data.fetchAssetQuote("AAPL", "finnhub")
    assert quote1 == _quote("100,00")

    # Refresco forzado: no usa la caché, pide un dato nuevo de verdad.
    quote2, _ = market_data.fetchAssetQuote("AAPL", "finnhub", useCache=False)
    assert quote2 == _quote("101,00")
    assert len(llamadas) == 2

    # Pero deja la caché actualizada con lo nuevo, no con el precio viejo.
    quote3, _ = market_data.fetchAssetQuote("AAPL", "finnhub")
    assert quote3 == _quote("101,00")
    assert len(llamadas) == 2


def testTtlCeroDesactivaLaCache(monkeypatch):
    monkeypatch.setattr(settings, "cotizacionTtlSegundos", lambda: 0)
    llamadas = []

    def finnhubOk(cb):
        llamadas.append(1)
        return _quote(), None

    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", finnhubOk)

    market_data.fetchAssetQuote("AAPL", "finnhub")
    market_data.fetchAssetQuote("AAPL", "finnhub")

    assert len(llamadas) == 2


def testRespaldoAOtroProveedorConSimboloPortable(monkeypatch):
    """AAPL no lleva sufijo de bolsa: si Finnhub falla, prueba Yahoo."""
    monkeypatch.setattr(
        market_data, "callFinnhubWithFallbacks",
        lambda cb: (None, "No se pudo conectar con Finnhub"),
    )
    monkeypatch.setattr(market_data, "_fetchYahooQuote", lambda symbol: (_quote(), None))

    quote, error = market_data.fetchAssetQuote("AAPL", "finnhub")

    assert error is None
    assert quote == _quote()


def testSinRespaldoParaSimboloAtadoAEodhd(monkeypatch):
    """SAP.XETRA es sintaxis de EODHD: no tiene sentido probarlo en otro proveedor."""
    yahooLlamado = []
    monkeypatch.setattr(
        market_data, "callEodhdWithFallbacks",
        lambda cb: (None, "No se pudo conectar con EODHD"),
    )
    monkeypatch.setattr(
        market_data, "_fetchYahooQuote",
        lambda symbol: yahooLlamado.append(symbol) or (_quote(), None),
    )

    quote, error = market_data.fetchAssetQuote("SAP.XETRA", "eodhd")

    assert quote is None
    assert error == "No se pudo conectar con EODHD"
    assert yahooLlamado == []


def testTargetCurrencyConvierteAntesDeCachear(monkeypatch):
    llamadasConversion = []

    def finnhubOk(cb):
        return _quote("100,00"), None

    def convertir(quote, target, timeout=None):
        llamadasConversion.append((quote["currency"], target))
        return {**quote, "price": "92,00", "currency": target}, None

    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", finnhubOk)
    monkeypatch.setattr(market_data, "convertQuoteCurrency", convertir)

    quote1, error1 = market_data.fetchAssetQuote("AAPL", "finnhub", targetCurrency="EUR")
    assert error1 is None
    assert quote1["price"] == "92,00"
    assert quote1["currency"] == "EUR"
    assert len(llamadasConversion) == 1

    # Segunda petición: viene de caché, no vuelve a convertir.
    quote2, _ = market_data.fetchAssetQuote("AAPL", "finnhub", targetCurrency="EUR")
    assert quote2 == quote1
    assert len(llamadasConversion) == 1


def testTargetCurrencyNoMezclaCacheConLaNativa(monkeypatch):
    llamadas = []

    def finnhubOk(cb):
        llamadas.append(1)
        return _quote("100,00"), None

    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", finnhubOk)
    monkeypatch.setattr(
        market_data, "convertQuoteCurrency",
        lambda quote, target, timeout=None: ({**quote, "price": "92,00", "currency": target}, None),
    )

    nativa, _ = market_data.fetchAssetQuote("AAPL", "finnhub")
    convertida, _ = market_data.fetchAssetQuote("AAPL", "finnhub", targetCurrency="EUR")

    assert nativa["currency"] == "USD" and nativa["price"] == "100,00"
    assert convertida["currency"] == "EUR" and convertida["price"] == "92,00"
    assert len(llamadas) == 2  # cada divisa pide su propia cotización, no comparten caché


def testTargetCurrencyIgualALaNativaNoConvierte(monkeypatch):
    llamadasConversion = []
    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", lambda cb: (_quote(), None))
    monkeypatch.setattr(
        market_data, "convertQuoteCurrency",
        lambda quote, target, timeout=None: llamadasConversion.append(1) or (quote, None),
    )

    quote, _ = market_data.fetchAssetQuote("AAPL", "finnhub", targetCurrency="USD")

    assert quote["currency"] == "USD"
    assert llamadasConversion == []  # ya estaba en USD, no hace falta pedir el cambio


def testTargetCurrencySiFallaLaConversionDevuelveLaNativa(monkeypatch):
    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", lambda cb: (_quote("100,00"), None))
    monkeypatch.setattr(
        market_data, "convertQuoteCurrency",
        lambda quote, target, timeout=None: (None, "No se pudo obtener el cambio USD/EUR"),
    )

    quote, error = market_data.fetchAssetQuote("AAPL", "finnhub", targetCurrency="EUR")

    assert error is None
    assert quote["currency"] == "USD"
    assert quote["price"] == "100,00"


def testLimiteDePeticionesDejaElProveedorEnReposo(monkeypatch):
    finnhubLlamadas = []

    def finnhubLimitado(cb):
        finnhubLlamadas.append(1)
        return None, "Finnhub: límite de peticiones alcanzado (HTTP 429)"

    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks", finnhubLimitado)
    monkeypatch.setattr(market_data, "_fetchYahooQuote", lambda symbol: (_quote(), None))

    # Primera petición: prueba Finnhub, falla por límite, cae a Yahoo.
    market_data.fetchAssetQuote("AAPL", "finnhub")
    # Segunda petición, símbolo distinto: Finnhub sigue en reposo, no se llama.
    market_data.fetchAssetQuote("MSFT", "finnhub")

    assert len(finnhubLlamadas) == 1


# ── Orden de respaldo y reposo: ajustes del usuario ──────────────────────────

def testElOrdenDeRespaldoSaleDeLosAjustes(monkeypatch):
    llamadas = []
    monkeypatch.setattr(settings, "ordenRespaldoProveedores", lambda: ["eodhd", "yahoo"])
    monkeypatch.setattr(market_data, "callFinnhubWithFallbacks",
                        lambda cb: llamadas.append("finnhub") or (None, "No se pudo conectar con Finnhub"))
    monkeypatch.setattr(market_data, "callEodhdWithFallbacks",
                        lambda cb: llamadas.append("eodhd") or (None, "No se pudo conectar con EODHD"))
    monkeypatch.setattr(market_data, "_fetchYahooQuote",
                        lambda symbol: llamadas.append("yahoo") or (_quote(), None))

    _quoteObtenida, error = market_data.fetchAssetQuote("AAPL", "finnhub")

    assert error is None
    assert llamadas == ["finnhub", "eodhd", "yahoo"]


def testUnProveedorMalEscritoEnElOrdenSeIgnora(monkeypatch):
    monkeypatch.setattr(settings, "ordenRespaldoProveedores", lambda: ["bloomberg", "YAHOO", "yahoo"])

    assert market_data._fallbackChain("finnhub", "AAPL") == ("finnhub", "yahoo")


def testOrdenDeRespaldoVacioEsSinRespaldo(monkeypatch):
    monkeypatch.setattr(settings, "ordenRespaldoProveedores", lambda: [])

    assert market_data._fallbackChain("finnhub", "AAPL") == ("finnhub",)


def testReposoCeroNoDejaElProveedorEnReposo(monkeypatch):
    monkeypatch.setattr(settings, "reposoLimiteSegundos", lambda: 0)

    market_data._markProviderRateLimited("finnhub")

    assert not market_data._isProviderResting("finnhub")
