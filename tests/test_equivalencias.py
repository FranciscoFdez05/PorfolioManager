"""Equivalencias entre divisas y activos: conversión, rangos, errores y ruta.

Nada sale a la red: las velas de TradingView llegan por `velasDe` y los cambios
de divisa por un doble de `fetchPriceSeries` dentro de `divisas_historico`.
"""

import pytest

from stores import divisas_historico, equivalencias

DIA = 86400
AHORA = 1_800_000_000

# Lo que vale una unidad de cada divisa en euros, fijo en toda la serie.
CAMBIOS_A_EUR = {"USD": 0.9, "GBP": 1.2}


def _diaria(dias=400, inicio=100.0, paso=1.0):
    """Velas diarias `[ts, cierre, máximo, mínimo]`, la última en AHORA."""
    return [[AHORA - (dias - 1 - i) * DIA, inicio + i * paso, 0, 0] for i in range(dias)]


def _intradia(horas=72, inicio=200.0):
    """Velas cada hora de los últimos `horas`, la última en AHORA."""
    return [[AHORA - (horas - i) * 3600, inicio + i, 0, 0] for i in range(horas + 1)]


def _velasFalsas(ticker, rango, temporalidad=None):
    """Doble de `series_tradingview.velasDelGrafico`."""
    if ticker == "TEST:NADA":
        return None
    divisa = {"TEST:EURO": "EUR", "TEST:RARA": "XXX"}.get(ticker, "USD")
    if rango in ("1D", "7D"):
        return divisa, _intradia()
    if temporalidad == "1S":
        return divisa, _diaria(dias=300 * 7)[::7]
    return divisa, _diaria()


@pytest.fixture(autouse=True)
def cambiosSimulados(monkeypatch):
    divisas_historico.vaciarCache()
    llamadas = []

    def falso(simbolo, desde, hasta, timeout=None, interval="1d"):
        llamadas.append((simbolo, interval))
        divisa = simbolo[:3]
        if divisa not in CAMBIOS_A_EUR:
            return [], f"Yahoo no tiene {simbolo}"
        paso = DIA if interval in ("1d", "1wk") else 1800
        puntos = [{"ts": AHORA - i * paso, "close": CAMBIOS_A_EUR[divisa]} for i in range(400, -1, -1)]
        return [p for p in puntos if desde <= p["ts"] <= hasta], None

    monkeypatch.setattr(divisas_historico, "fetchPriceSeries", falso)
    monkeypatch.setattr(divisas_historico, "_ahora", lambda: AHORA)
    monkeypatch.setattr(equivalencias, "_ahora", lambda: AHORA)
    return llamadas


def _calcular(divisas=(), tickers=(), referencia="EUR", rango="1M", velasDe=_velasFalsas):
    datos = equivalencias.equivalencias(list(divisas), list(tickers), referencia, rango, ahora=AHORA, velasDe=velasDe)
    return {e["id"]: e for e in datos["elementos"]}


def testLaMonedaDeReferenciaValeSiempreUno():
    eur = _calcular(divisas=["EUR"])["EUR"]

    assert {p["close"] for p in eur["puntos"]} == {1.0}
    assert eur["actual"]["close"] == 1.0


def testUnaDivisaValeSuCambioALaReferencia():
    usd = _calcular(divisas=["USD"])["USD"]

    assert usd["tipo"] == "divisa"
    assert usd["actual"]["close"] == pytest.approx(0.9)


def testUnTickerEnOtraDivisaSePasaALaReferencia():
    datos = _calcular(tickers=["BITSTAMP:BTCUSD"])["BITSTAMP:BTCUSD"]

    assert datos["divisa"] == "USD"
    # El último cierre diario es 100 + 399 = 499 dólares.
    assert datos["actual"]["close"] == pytest.approx(499 * 0.9)


def testUnTickerEnLaMonedaDeReferenciaNoPideCambio(cambiosSimulados):
    datos = _calcular(tickers=["TEST:EURO"])["TEST:EURO"]

    assert datos["actual"]["close"] == pytest.approx(499)
    assert cambiosSimulados == []


def testElCambioDeUnaDivisaSePideUnaVezParaVariosTickers(cambiosSimulados):
    _calcular(tickers=["NASDAQ:AAPL", "NASDAQ:MSFT", "BITSTAMP:BTCUSD"])

    assert cambiosSimulados.count(("USDEUR=X", "1d")) == 1


def testUnTickerSinVelasLlegaConErrorYLosDemasSiguen():
    elementos = _calcular(divisas=["USD"], tickers=["TEST:NADA", "NASDAQ:AAPL"])

    assert "error" in elementos["TEST:NADA"]
    assert "error" not in elementos["NASDAQ:AAPL"]
    assert "error" not in elementos["USD"]


def testSinCambioParaLaDivisaDelTickerSeDiceCual():
    datos = _calcular(tickers=["TEST:RARA"])["TEST:RARA"]

    assert datos["divisa"] == "XXX"
    assert "XXX" in datos["error"] and "EUR" in datos["error"]


def testElRangoMensualSonUnosTreintaDias():
    puntos = _calcular(tickers=["NASDAQ:AAPL"], rango="1M")["NASDAQ:AAPL"]["puntos"]

    assert 29 <= len(puntos) <= 32
    assert puntos[-1]["ts"] == AHORA


def testElRangoDeUnDiaSonLasUltimas24HorasDeCotizacion():
    puntos = _calcular(tickers=["NASDAQ:AAPL"], rango="1D")["NASDAQ:AAPL"]["puntos"]

    assert puntos[-1]["ts"] - puntos[0]["ts"] <= DIA
    assert len(puntos) > 2


def testElRangoDeCincoAniosUsaVelasSemanales():
    puntos = _calcular(tickers=["NASDAQ:AAPL"], rango="5A")["NASDAQ:AAPL"]["puntos"]

    assert puntos[1]["ts"] - puntos[0]["ts"] == 7 * DIA
    assert AHORA - puntos[0]["ts"] <= 1830 * DIA


def testLasReferenciasSeCalculanSobreLaSerieConvertida():
    datos = _calcular(tickers=["NASDAQ:AAPL"])["NASDAQ:AAPL"]

    referencias = {r["rango"]: r["close"] for r in datos["referencias"]}
    # Hace 7 días el cierre era 499 - 7 = 492 dólares.
    assert referencias["1S"] == pytest.approx(492 * 0.9)


def testConvertirUsaElUltimoCambioConocidoYElPrimeroSiNoHayAnterior():
    cambio = [{"ts": 100, "close": 2.0}, {"ts": 200, "close": 3.0}]
    puntos = [{"ts": 50, "close": 1.0}, {"ts": 150, "close": 1.0}, {"ts": 250, "close": 1.0}]

    convertidos = equivalencias._convertir(puntos, cambio)

    assert [p["close"] for p in convertidos] == [2.0, 2.0, 3.0]


def testLeerListaLimpiaYQuitaRepetidos():
    assert equivalencias.leerLista(" usd, GBP,,usd ") == ["USD", "GBP"]
    assert equivalencias.leerLista(None) == []


@pytest.mark.parametrize(
    "divisas, tickers, referencia, rango",
    [
        ([], [], "EUR", "1M"),
        (["USD"], [], "EUR", "9X"),
        (["USD"], [], "EURO", "1M"),
        (["US"], [], "EUR", "1M"),
        ([], ["NASDAQ:AA PL"], "EUR", "1M"),
        ([f"U{i:02d}" for i in range(equivalencias.MAX_ELEMENTOS + 1)], [], "EUR", "1M"),
    ],
)
def testLasPeticionesInvalidasSeRechazan(divisas, tickers, referencia, rango):
    with pytest.raises(equivalencias.EquivalenciasInvalidas):
        equivalencias.equivalencias(divisas, tickers, referencia, rango, ahora=AHORA, velasDe=_velasFalsas)


def testLaRutaDevuelve400SiLaPeticionNoVale(clienteAutenticado):
    from routes.herramientas import herramientasBp

    client, _cabeceras, _app = clienteAutenticado(herramientasBp)

    assert client.get("/api/herramientas/equivalencias").status_code == 400
    assert client.get("/api/herramientas/equivalencias?divisas=USD&rango=9X").status_code == 400


def testLaRutaDevuelveLosElementos(clienteAutenticado, monkeypatch):
    from routes.herramientas import herramientasBp
    from stores import series_tradingview

    monkeypatch.setattr(series_tradingview, "velasDelGrafico", _velasFalsas)
    client, _cabeceras, _app = clienteAutenticado(herramientasBp)

    datos = client.get(
        "/api/herramientas/equivalencias?divisas=eur,usd&tickers=nasdaq:aapl&referencia=eur&rango=3m"
    ).get_json()

    assert datos["ok"] is True
    assert (datos["referencia"], datos["rango"]) == ("EUR", "3M")
    assert [e["id"] for e in datos["elementos"]] == ["EUR", "USD", "NASDAQ:AAPL"]
    assert all("puntos" in e for e in datos["elementos"])
