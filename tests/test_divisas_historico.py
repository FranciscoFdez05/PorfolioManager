"""Comparador de divisas: histórico de un par, rangos y cambios por periodo.

Ninguna prueba sale a la red: `fetch_price_series` se sustituye por un doble.
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
def red_simulada(monkeypatch):
    divisas_historico.vaciar_cache()
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

    monkeypatch.setattr(divisas_historico, "fetch_price_series", falso)
    # Las rutas no reciben `ahora`: se fija el reloj para que coincida con las series.
    monkeypatch.setattr(divisas_historico, "_ahora", lambda: AHORA)
    return llamadas


def test_el_simbolo_es_el_par_de_yahoo(red_simulada):
    divisas_historico.historico_par("eur", "usd", "1M", ahora=AHORA)

    assert red_simulada[0][0] == "EURUSD=X"


def test_los_rangos_diarios_salen_de_una_sola_peticion(red_simulada):
    for rango in ("1M", "3M", "6M", "1A"):
        divisas_historico.historico_par("EUR", "USD", rango, ahora=AHORA)

    assert len(red_simulada) == 1


def test_cada_rango_acota_los_puntos(red_simulada):
    mes, _ = divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA)
    anio, _ = divisas_historico.historico_par("EUR", "USD", "1A", ahora=AHORA)

    assert 28 <= len(mes["puntos"]) <= 32
    assert len(anio["puntos"]) > 360
    assert mes["puntos"][-1] == anio["puntos"][-1] == mes["actual"]


def test_el_rango_de_un_dia_son_las_ultimas_24_horas_de_cotizacion(red_simulada):
    datos, _ = divisas_historico.historico_par("EUR", "USD", "1D", ahora=AHORA)

    puntos = datos["puntos"]
    assert puntos[-1]["ts"] - puntos[0]["ts"] <= DIA
    assert len(puntos) > 1
    assert datos["intervalo"] == "5m"


def test_el_rango_de_un_dia_funciona_aunque_el_mercado_lleve_cerrado_dias(monkeypatch):
    """Fin de semana: el último cierre es del viernes y aun así hay gráfico."""
    viejos = [{"ts": AHORA - 3 * DIA - i * 300, "close": 1.1} for i in range(40, -1, -1)]
    monkeypatch.setattr(
        divisas_historico, "fetch_price_series",
        lambda s, d, h, timeout=None, interval="1d": (_diaria() if interval == "1d" else viejos, None),
    )

    datos, _ = divisas_historico.historico_par("EUR", "USD", "1D", ahora=AHORA)

    assert len(datos["puntos"]) == len(viejos)


def test_las_referencias_cubren_cada_periodo(red_simulada):
    datos, _ = divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA)

    referencias = {r["rango"]: r for r in datos["referencias"]}
    assert set(referencias) == {"1D", "1S", "1M", "3M", "6M", "1A"}
    # El cierre de hace 7 días es 7 pasos por debajo del último.
    esperado = datos["actual"]["close"] - 7 * 0.001
    assert referencias["1S"]["close"] == pytest.approx(esperado)
    assert referencias["1D"]["close"] == pytest.approx(datos["actual"]["close"] - 0.001)


def test_una_serie_corta_omite_los_periodos_que_no_cubre(monkeypatch):
    monkeypatch.setattr(
        divisas_historico, "fetch_price_series",
        lambda *a, **k: (_diaria(dias=40), None),
    )

    datos, _ = divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA)

    assert {r["rango"] for r in datos["referencias"]} == {"1D", "1S", "1M"}


def test_la_cache_evita_repetir_la_peticion_hasta_que_caduca(red_simulada):
    divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA)
    divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA + 60)
    assert len(red_simulada) == 1

    divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA + 3600)
    assert len(red_simulada) == 2


def test_un_error_del_proveedor_se_devuelve_y_no_se_cachea(monkeypatch):
    respuestas = iter([([], "Yahoo Finance devolvió HTTP 429"), (_diaria(), None)])
    monkeypatch.setattr(divisas_historico, "fetch_price_series", lambda *a, **k: next(respuestas))

    datos, error = divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA)
    assert datos is None and "429" in error

    datos, error = divisas_historico.historico_par("EUR", "USD", "1M", ahora=AHORA)
    assert error is None and datos["puntos"]


@pytest.mark.parametrize(
    "base, quote, rango",
    [("EUR", "EUR", "1M"), ("EU", "USD", "1M"), ("EUR", "US1", "1M"), ("", "USD", "1M"), ("EUR", "USD", "10A")],
)
def test_los_pares_y_rangos_invalidos_se_rechazan(base, quote, rango):
    with pytest.raises(divisas_historico.HistoricoInvalido):
        divisas_historico.historico_par(base, quote, rango, ahora=AHORA)


def test_la_ruta_devuelve_400_o_502_segun_el_fallo(cliente_autenticado, monkeypatch):
    from routes.market import market_bp

    client, _cabeceras, _app = cliente_autenticado(market_bp)

    assert client.get("/api/divisas/historico?base=EUR&quote=EUR").status_code == 400
    assert client.get("/api/divisas/historico?base=EUR&quote=USD&rango=9X").status_code == 400

    monkeypatch.setattr(
        divisas_historico, "fetch_price_series", lambda *a, **k: ([], "Yahoo no responde")
    )
    divisas_historico.vaciar_cache()
    res = client.get("/api/divisas/historico?base=EUR&quote=USD")
    assert res.status_code == 502
    assert res.get_json()["error"] == "Yahoo no responde"


def test_la_ruta_devuelve_los_puntos(cliente_autenticado):
    from routes.market import market_bp

    client, _cabeceras, _app = cliente_autenticado(market_bp)

    datos = client.get("/api/divisas/historico?base=eur&quote=usd&rango=3m").get_json()

    assert datos["ok"] is True
    assert (datos["base"], datos["quote"], datos["rango"]) == ("EUR", "USD", "3M")
    assert datos["puntos"] and datos["referencias"]
