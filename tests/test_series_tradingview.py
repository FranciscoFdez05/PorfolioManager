"""Velas de TradingView para la línea de las casillas del mapa de Paneles.

El feed se sustituye por una función falsa que anota qué se le pide: lo que se
prueba es la caché, el filtrado de tickers y la respuesta de la ruta.
"""

import pytest

from stores import series_tradingview


class FeedFalso:
    """`fetchSeries` falso: devuelve velas fijas por ticker y anota cada llamada."""

    def __init__(self, velas=None, error=None):
        self.velas = velas or {}
        self.error = error
        self.llamadas = []

    def __call__(self, simbolos, resolucion, velas):
        self.llamadas.append((list(simbolos), resolucion, velas))
        if self.error:
            raise self.error
        return {s: self.velas[s] for s in simbolos if s in self.velas}


@pytest.fixture
def reloj():
    instante = {"t": 1000.0}

    def ahora():
        return instante["t"]

    ahora.avanzar = lambda segundos: instante.update(t=instante["t"] + segundos)
    return ahora


def testNormalizarSimbolosLimpiaRepetidosYDescartaLosRaros():
    simbolos = series_tradingview.normalizarSimbolos(
        [" nasdaq:ndx", "NASDAQ:NDX", "", "TVC:UKOIL", "aapl", "MAL ACTIVO", "X:<script>"]
    )

    assert simbolos == ["NASDAQ:NDX", "TVC:UKOIL", "AAPL"]


def testNormalizarSimbolosExigeAlgunoYPoneTope():
    with pytest.raises(series_tradingview.SimbolosInvalidos):
        series_tradingview.normalizarSimbolos(["", "  "])
    with pytest.raises(series_tradingview.SimbolosInvalidos):
        series_tradingview.normalizarSimbolos([f"X:S{i}" for i in range(series_tradingview.MAX_SIMBOLOS + 1)])


def testPideLaResolucionDelPeriodoYSoloDevuelveSeriesUtiles(reloj):
    feed = FeedFalso({"SP:SPX": [(1, 10.0), (2, 11.0)], "TVC:UKOIL": [(1, 90.0)]})

    series = series_tradingview.seriesDeSimbolos(["SP:SPX", "TVC:UKOIL", "FOO:NOPE"], "mes", fetch=feed, clock=reloj)

    assert series == {"SP:SPX": [[1, 10.0], [2, 11.0]]}
    assert feed.llamadas == [(["SP:SPX", "TVC:UKOIL", "FOO:NOPE"], "240", 200)]


def testLaCacheEvitaVolverAPedirIncluidosLosQueNoTienenVelas(reloj):
    feed = FeedFalso({"SP:SPX": [(1, 10.0), (2, 11.0)]})

    series_tradingview.seriesDeSimbolos(["SP:SPX", "FOO:NOPE"], "dia", fetch=feed, clock=reloj)
    reloj.avanzar(60)
    series = series_tradingview.seriesDeSimbolos(["SP:SPX", "FOO:NOPE", "DJ:DJI"], "dia", fetch=feed, clock=reloj)

    assert series == {"SP:SPX": [[1, 10.0], [2, 11.0]]}
    # Solo el nuevo: SP:SPX está en caché y FOO:NOPE quedó anotado como «sin velas».
    assert feed.llamadas[1][0] == ["DJ:DJI"]


def testLaCacheCaducaYVaPorPeriodo(reloj):
    feed = FeedFalso({"SP:SPX": [(1, 10.0), (2, 11.0)]})

    series_tradingview.seriesDeSimbolos(["SP:SPX"], "dia", fetch=feed, clock=reloj)
    series_tradingview.seriesDeSimbolos(["SP:SPX"], "semana", fetch=feed, clock=reloj)
    reloj.avanzar(121)
    series_tradingview.seriesDeSimbolos(["SP:SPX"], "dia", fetch=feed, clock=reloj)

    assert [llamada[1] for llamada in feed.llamadas] == ["5", "60", "5"]


def testSinCacheSiElTtlEsCero(reloj, monkeypatch):
    monkeypatch.setenv("MERCADO_SERIE_MAPA_TTL", "0")
    feed = FeedFalso({"SP:SPX": [(1, 10.0), (2, 11.0)]})

    series_tradingview.seriesDeSimbolos(["SP:SPX"], "dia", fetch=feed, clock=reloj)
    series_tradingview.seriesDeSimbolos(["SP:SPX"], "dia", fetch=feed, clock=reloj)

    assert len(feed.llamadas) == 2


def testUnFalloDelFeedDevuelveLoQueHayEnCacheSinError(reloj):
    bueno = FeedFalso({"SP:SPX": [(1, 10.0), (2, 11.0)]})
    series_tradingview.seriesDeSimbolos(["SP:SPX"], "dia", fetch=bueno, clock=reloj)

    caido = FeedFalso(error=ConnectionResetError("cortado"))
    series = series_tradingview.seriesDeSimbolos(["SP:SPX", "DJ:DJI"], "dia", fetch=caido, clock=reloj)

    assert series == {"SP:SPX": [[1, 10.0], [2, 11.0]]}
    # El fallo no se guarda como «sin velas»: la próxima vez se vuelve a intentar.
    series_tradingview.seriesDeSimbolos(["DJ:DJI"], "dia", fetch=caido, clock=reloj)
    assert len(caido.llamadas) == 2


def testPeriodoDesconocido(reloj):
    with pytest.raises(series_tradingview.PeriodoInvalido):
        series_tradingview.seriesDeSimbolos(["SP:SPX"], "siglo", fetch=FeedFalso(), clock=reloj)


# --- Ruta /api/market/series ---------------------------------------------------


@pytest.fixture
def cliente(clienteAutenticado, monkeypatch):
    from providers import tradingview_feed
    from routes.market import marketBp

    feed = FeedFalso({"SP:SPX": [(1, 10.0), (2, 11.0)]})
    monkeypatch.setattr(tradingview_feed, "fetchSeries", feed)
    client, _cabeceras, _app = clienteAutenticado(marketBp)
    return client, feed


def testRutaDevuelveLasSeriesDelPeriodo(cliente):
    client, feed = cliente

    respuesta = client.get("/api/market/series?symbols=sp:spx,FOO:NOPE,mal%20ticker&periodo=semana")

    assert respuesta.status_code == 200
    assert respuesta.get_json() == {"ok": True, "periodo": "semana", "series": {"SP:SPX": [[1, 10.0], [2, 11.0]]}}
    assert feed.llamadas == [(["SP:SPX", "FOO:NOPE"], "60", 200)]


@pytest.mark.parametrize(
    "consulta",
    ["symbols=SP:SPX&periodo=siglo", "symbols=&periodo=dia", "periodo=dia"],
)
def testRutaRechazaPeticionesNoValidas(cliente, consulta):
    client, feed = cliente

    respuesta = client.get(f"/api/market/series?{consulta}")

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False
    assert feed.llamadas == []


# --- Velas del gráfico de la ficha (velasDelGrafico) ------------------------------


class FeedConDivisa(FeedFalso):
    """`fetchSeriesWithCurrency` falso: como `FeedFalso`, con la divisa de cada ticker."""

    def __init__(self, velas=None, divisas=None, error=None):
        super().__init__(velas, error)
        self.divisas = divisas or {}

    def __call__(self, simbolos, resolucion, velas):
        cierres = super().__call__(simbolos, resolucion, velas)
        return {s: (self.divisas.get(s), puntos) for s, puntos in cierres.items()}


def testVelasDelGraficoDevuelveDivisaYPideLaResolucionDelRango(reloj):
    feed = FeedConDivisa({"NASDAQ:AAPL": [(1, 10.0, 10.5, 9.5), (2, 11.0, 11.5, 10.5)]}, {"NASDAQ:AAPL": "USD"})

    resultado = series_tradingview.velasDelGrafico("NASDAQ:AAPL", "30D", fetch=feed, clock=reloj)

    assert resultado == ("USD", [[1, 10.0, 10.5, 9.5], [2, 11.0, 11.5, 10.5]])
    assert feed.llamadas == [(["NASDAQ:AAPL"], "240", 200)]


def testVelasDelGraficoEnTodoCubreDesdeElPrimerMovimientoConTope(reloj):
    feed = FeedConDivisa()
    ahora = 1_800_000_000

    series_tradingview.velasDelGrafico("X:A", "TODO", desdeTs=ahora - 100 * 86400, ahoraTs=ahora, fetch=feed, clock=reloj)
    series_tradingview.velasDelGrafico("X:A", "TODO", desdeTs=ahora - 40000 * 86400, ahoraTs=ahora, fetch=feed, clock=reloj)
    series_tradingview.velasDelGrafico("X:B", "TODO", desdeTs=0, ahoraTs=ahora, fetch=feed, clock=reloj)

    assert [llamada[1:] for llamada in feed.llamadas] == [
        ("1D", 111),
        ("1D", series_tradingview.MAX_VELAS_DIARIAS),
        ("1D", series_tradingview.MAX_VELAS_DIARIAS),
    ]


def testVelasDelGraficoSinDivisaOConUnaSolaVelaNoSirven(reloj):
    feed = FeedConDivisa({"X:A": [(1, 10.0), (2, 11.0)], "X:B": [(1, 10.0)]}, {"X:B": "EUR"})

    assert series_tradingview.velasDelGrafico("X:A", "1A", fetch=feed, clock=reloj) is None
    assert series_tradingview.velasDelGrafico("X:B", "1A", fetch=feed, clock=reloj) is None


def testVelasDelGraficoCacheaTambienLasQueNoHay(reloj):
    feed = FeedConDivisa({"X:A": [(1, 10.0), (2, 11.0)]}, {"X:A": "EUR"})

    series_tradingview.velasDelGrafico("X:A", "7D", fetch=feed, clock=reloj)
    series_tradingview.velasDelGrafico("X:NOPE", "7D", fetch=feed, clock=reloj)
    reloj.avanzar(60)
    series_tradingview.velasDelGrafico("X:A", "7D", fetch=feed, clock=reloj)
    series_tradingview.velasDelGrafico("X:NOPE", "7D", fetch=feed, clock=reloj)
    series_tradingview.velasDelGrafico("X:A", "1D", fetch=feed, clock=reloj)

    assert [llamada[0] for llamada in feed.llamadas] == [["X:A"], ["X:NOPE"], ["X:A"]]


def testVelasDelGraficoFalloDelFeedNoSeCachea(reloj):
    feed = FeedConDivisa(error=OSError("sin red"))

    assert series_tradingview.velasDelGrafico("X:A", "1A", fetch=feed, clock=reloj) is None
    feed.error = None
    series_tradingview.velasDelGrafico("X:A", "1A", fetch=feed, clock=reloj)

    assert len(feed.llamadas) == 2


def testVelasDelGraficoRangoInvalido(reloj):
    with pytest.raises(series_tradingview.PeriodoInvalido):
        series_tradingview.velasDelGrafico("X:A", "5A", fetch=FeedConDivisa(), clock=reloj)
