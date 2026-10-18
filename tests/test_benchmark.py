"""Serie de índices para comparar contra la cartera.

Ningún test toca la red: `fetchPriceSeries` se sustituye por un doble que
además cuenta las llamadas, porque la mitad del valor de este módulo está en
no bajar años de cotizaciones en cada visita a Métricas.
"""

import datetime

import pytest

from core.db import getDb
from stores import benchmark

DIA = 86400
AHORA = int(datetime.datetime(2024, 6, 1, 12).timestamp())


@pytest.fixture(autouse=True)
def sinMemoriaEntreTests():
    """El registro de últimos intentos es de proceso, no de base de datos."""
    benchmark._ultimoIntento.clear()
    yield
    benchmark._ultimoIntento.clear()


@pytest.fixture
def yahoo(monkeypatch):
    """Doble de Yahoo que devuelve un cierre por día y cuenta las llamadas."""
    llamadas = []

    def _serie(symbol, desde, hasta, timeout=None):
        llamadas.append((symbol, desde, hasta))
        dias = range(0, max(int((hasta - desde) // DIA), 1))
        return [{"ts": int(desde) + d * DIA, "close": 100.0 + d} for d in dias], None

    monkeypatch.setattr(benchmark, "fetchPriceSeries", _serie)
    return llamadas


class TestCatalogo:
    def testLasClavesNoExponenElSimboloDelProveedor(self):
        # La clave viaja por la URL y se guarda en las preferencias del
        # navegador; el símbolo puede cambiar sin romperlas.
        claves = {i["clave"] for i in benchmark.catalogo()}

        assert "sp500" in claves
        assert benchmark.INDICES["sp500"]["symbol"] == "^GSPC"

    def testTodosLosIndicesLlevanNombreLegible(self):
        assert all(i["nombre"] for i in benchmark.catalogo())


class TestSerie:
    def testBajaYCacheaLosCierres(self, tempDb, yahoo):
        datos, error = benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)

        assert error is None
        assert datos["symbol"] == "^GSPC"
        assert len(datos["data"]) > 0
        assert len(yahoo) == 1

        guardados = getDb().execute("SELECT COUNT(*) FROM benchmark_prices").fetchone()[0]
        assert guardados > 0

    def testLaSegundaVisitaNoVuelveALlamar(self, tempDb, yahoo, monkeypatch):
        monkeypatch.setattr(benchmark.settings, "historicoTtlSegundos", lambda: 3600)

        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)
        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)

        assert len(yahoo) == 1

    def testElTramoNuevoDelFinalSeBaja(self, tempDb, yahoo, monkeypatch):
        monkeypatch.setattr(benchmark.settings, "historicoTtlSegundos", lambda: 0)

        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)
        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA + 5 * DIA)

        assert len(yahoo) == 2

    def testElTtlProtegeAlProveedorAunqueFalteCola(self, tempDb, yahoo, monkeypatch):
        # Un fin de semana el último cierre es el del viernes: sin este freno,
        # cada refresco del gráfico volvería a preguntar por un dato que
        # todavía no existe.
        monkeypatch.setattr(benchmark.settings, "historicoTtlSegundos", lambda: 3600)

        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)
        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA + 5 * DIA)

        assert len(yahoo) == 1

    def testEstirarElRangoHaciaAtrasVuelveABajar(self, tempDb, yahoo, monkeypatch):
        monkeypatch.setattr(benchmark.settings, "historicoTtlSegundos", lambda: 0)

        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)
        benchmark.serie("sp500", AHORA - 365 * DIA, AHORA)

        assert len(yahoo) == 2
        assert yahoo[1][1] < yahoo[0][1]

    def testUnDiaRepetidoSeActualizaEnVezDeDuplicarse(self, tempDb, yahoo, monkeypatch):
        monkeypatch.setattr(benchmark.settings, "historicoTtlSegundos", lambda: 0)

        benchmark.serie("sp500", AHORA - 10 * DIA, AHORA)
        antes = getDb().execute("SELECT COUNT(*) FROM benchmark_prices").fetchone()[0]
        benchmark.serie("sp500", AHORA - 10 * DIA, AHORA)

        assert getDb().execute("SELECT COUNT(*) FROM benchmark_prices").fetchone()[0] == antes

    def testUnIndiceDesconocidoNoLlamaAlProveedor(self, tempDb, yahoo):
        datos, error = benchmark.serie("no_existe", AHORA - 30 * DIA, AHORA)

        assert datos is None
        assert error == "Índice desconocido"
        assert yahoo == []

    def testSiFallaLaDescargaSeSirveLoCacheado(self, tempDb, yahoo, monkeypatch):
        benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)
        benchmark._ultimoIntento.clear()
        monkeypatch.setattr(
            benchmark, "fetchPriceSeries",
            lambda symbol, desde, hasta, timeout=None: ([], "Yahoo Finance devolvió HTTP 429"),
        )

        datos, error = benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)

        # Un índice de hace dos días sigue diciendo si la cartera va por
        # delante o por detrás; un gráfico vacío no dice nada.
        assert error is None
        assert len(datos["data"]) > 0

    def testSiFallaYNoHayNadaCacheadoDevuelveElError(self, tempDb, monkeypatch):
        monkeypatch.setattr(
            benchmark, "fetchPriceSeries",
            lambda symbol, desde, hasta, timeout=None: ([], "Yahoo Finance devolvió HTTP 429"),
        )

        datos, error = benchmark.serie("sp500", AHORA - 30 * DIA, AHORA)

        assert datos is None
        assert error == "Yahoo Finance devolvió HTTP 429"

    def testSoloDevuelveLosPuntosDelRangoPedido(self, tempDb, yahoo):
        # La descarga se pide con una semana de margen por delante para que un
        # rango que arranca en festivo tenga cierre con el que empezar, pero
        # ese margen no debe colarse en el gráfico.
        datos, _ = benchmark.serie("sp500", AHORA - 10 * DIA, AHORA)

        assert all(AHORA - 10 * DIA <= p["ts"] <= AHORA for p in datos["data"])
