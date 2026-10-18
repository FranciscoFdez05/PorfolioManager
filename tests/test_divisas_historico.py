"""Comparador de divisas: histórico de un par, rangos y cambios por periodo.

Ninguna prueba sale a la red: `fetchPriceSeries` se sustituye por un doble.
"""

import pytest

from stores import divisas_historico

DIA = 86400
AHORA = 1_800_000_000  # una fecha cualquiera; todo se mide respecto a ella


def _diaria(dias=400, inicio=1.0, paso=0.001):
    """Un cierre por día, el último en AHORA, creciendo `paso` cada día."""
    return [
        {"ts": AHORA - (dias - 1 - i) * DIA, "close": inicio + i * paso}
        for i in range(dias)
    ]


@pytest.fixture(autouse=True)
def redSimulada(monkeypatch):
    divisas_historico.vaciarCache()
    llamadas = []

    def falso(simbolo, desde, hasta, timeout=None, interval="1d"):
        llamadas.append((simbolo, interval))
        if interval == "1d":
            return [p for p in _diaria() if desde <= p["ts"] <= hasta], None
        # Intradía: tres días de cierres cada 4 horas.
        puntos = [
            {"ts": AHORA - i * 4 * 3600, "close": 1.1 + i * 0.0001} for i in range(18, -1, -1)
        ]
        return [p for p in puntos if desde <= p["ts"] <= hasta], None

    monkeypatch.setattr(divisas_historico, "fetchPriceSeries", falso)
    # Las rutas no reciben `ahora`: se fija el reloj para que coincida con las series.
    monkeypatch.setattr(divisas_historico, "_ahora", lambda: AHORA)
    return llamadas


def testElSimboloEsElParDeYahoo(redSimulada):
    divisas_historico.historicoPar("eur", "usd", "1M", ahora=AHORA)

    assert redSimulada[0][0] == "EURUSD=X"


def testLosRangosDiariosSalenDeUnaSolaPeticion(redSimulada):
    for rango in ("1M", "3M", "6M", "1A"):
        divisas_historico.historicoPar("EUR", "USD", rango, ahora=AHORA)

    assert len(redSimulada) == 1


def testCadaRangoAcotaLosPuntos(redSimulada):
    mes, _ = divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA)
    anio, _ = divisas_historico.historicoPar("EUR", "USD", "1A", ahora=AHORA)

    assert 28 <= len(mes["puntos"]) <= 32
    assert len(anio["puntos"]) > 360
    assert mes["puntos"][-1] == anio["puntos"][-1] == mes["actual"]


def testElRangoDeUnDiaSonLasUltimas24HorasDeCotizacion(redSimulada):
    datos, _ = divisas_historico.historicoPar("EUR", "USD", "1D", ahora=AHORA)

    puntos = datos["puntos"]
    assert puntos[-1]["ts"] - puntos[0]["ts"] <= DIA
    assert len(puntos) > 1
    assert datos["intervalo"] == "5m"


def testElRangoDeUnDiaFuncionaAunqueElMercadoLleveCerradoDias(monkeypatch):
    """Fin de semana: el último cierre es del viernes y aun así hay gráfico."""
    viejos = [{"ts": AHORA - 3 * DIA - i * 300, "close": 1.1} for i in range(40, -1, -1)]
    monkeypatch.setattr(
        divisas_historico, "fetchPriceSeries",
        lambda s, d, h, timeout=None, interval="1d": (_diaria() if interval == "1d" else viejos, None),
    )

    datos, _ = divisas_historico.historicoPar("EUR", "USD", "1D", ahora=AHORA)

    assert len(datos["puntos"]) == len(viejos)


def testLasReferenciasCubrenCadaPeriodo(redSimulada):
    datos, _ = divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA)

    referencias = {r["rango"]: r for r in datos["referencias"]}
    assert set(referencias) == {"1D", "1S", "1M", "3M", "6M", "1A"}
    # El cierre de hace 7 días es 7 pasos por debajo del último.
    esperado = datos["actual"]["close"] - 7 * 0.001
    assert referencias["1S"]["close"] == pytest.approx(esperado)
    assert referencias["1D"]["close"] == pytest.approx(datos["actual"]["close"] - 0.001)


def testUnaSerieCortaOmiteLosPeriodosQueNoCubre(monkeypatch):
    monkeypatch.setattr(
        divisas_historico, "fetchPriceSeries",
        lambda *a, **k: (_diaria(dias=40), None),
    )

    datos, _ = divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA)

    assert {r["rango"] for r in datos["referencias"]} == {"1D", "1S", "1M"}


def testLaCacheEvitaRepetirLaPeticionHastaQueCaduca(redSimulada):
    divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA)
    divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA + 60)
    assert len(redSimulada) == 1

    divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA + 3600)
    assert len(redSimulada) == 2


def testUnErrorDelProveedorSeDevuelveYNoSeCachea(monkeypatch):
    respuestas = iter([([], "Yahoo Finance devolvió HTTP 429"), (_diaria(), None)])
    monkeypatch.setattr(divisas_historico, "fetchPriceSeries", lambda *a, **k: next(respuestas))

    datos, error = divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA)
    assert datos is None and "429" in error

    datos, error = divisas_historico.historicoPar("EUR", "USD", "1M", ahora=AHORA)
    assert error is None and datos["puntos"]


@pytest.mark.parametrize(
    "base, quote, rango",
    [("EUR", "EUR", "1M"), ("EU", "USD", "1M"), ("EUR", "US1", "1M"), ("", "USD", "1M"), ("EUR", "USD", "10A")],
)
def testLosParesYRangosInvalidosSeRechazan(base, quote, rango):
    with pytest.raises(divisas_historico.HistoricoInvalido):
        divisas_historico.historicoPar(base, quote, rango, ahora=AHORA)


def testLaRutaDevuelve400O502SegunElFallo(clienteAutenticado, monkeypatch):
    from routes.market import marketBp

    client, _cabeceras, _app = clienteAutenticado(marketBp)

    assert client.get("/api/divisas/historico?base=EUR&quote=EUR").status_code == 400
    assert client.get("/api/divisas/historico?base=EUR&quote=USD&rango=9X").status_code == 400

    monkeypatch.setattr(
        divisas_historico, "fetchPriceSeries", lambda *a, **k: ([], "Yahoo no responde")
    )
    divisas_historico.vaciarCache()
    res = client.get("/api/divisas/historico?base=EUR&quote=USD")
    assert res.status_code == 502
    assert res.get_json()["error"] == "Yahoo no responde"


def testLaRutaDevuelveLosPuntos(clienteAutenticado):
    from routes.market import marketBp

    client, _cabeceras, _app = clienteAutenticado(marketBp)

    datos = client.get("/api/divisas/historico?base=eur&quote=usd&rango=3m").get_json()

    assert datos["ok"] is True
    assert (datos["base"], datos["quote"], datos["rango"]) == ("EUR", "USD", "3M")
    assert datos["puntos"] and datos["referencias"]
