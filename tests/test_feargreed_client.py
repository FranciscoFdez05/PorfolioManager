"""Cliente del Fear & Greed de cripto (alternative.me).

Nada sale a la red: se sustituye `providers.feargreed_client.fetch_json`.
"""

from urllib.error import HTTPError, URLError

from providers import feargreed_client


def _payload(value="62", classification="Greed"):
    return {"data": [{"value": value, "value_classification": classification, "timestamp": "1700000000"}]}


def test_fetch_index_devuelve_el_valor_y_la_clasificacion(monkeypatch):
    monkeypatch.setattr(feargreed_client, "fetch_json", lambda *a, **kw: _payload())

    datos, error = feargreed_client.fetch_index()

    assert error is None
    assert datos["valor"] == 62
    assert datos["clasificacion"] == "Greed"
    assert datos["timestamp"] == "1700000000"


def test_fetch_index_sin_filas_es_error(monkeypatch):
    monkeypatch.setattr(feargreed_client, "fetch_json", lambda *a, **kw: {"data": []})

    datos, error = feargreed_client.fetch_index()

    assert datos is None
    assert "no devolvió datos" in error


def test_fetch_index_con_valor_no_numerico_es_error(monkeypatch):
    # Una fila con un valor que no se puede convertir a número se descarta
    # igual que una fila vacía: sin filas válidas, es el mismo "sin datos".
    monkeypatch.setattr(feargreed_client, "fetch_json", lambda *a, **kw: _payload(value="N/A"))

    datos, error = feargreed_client.fetch_index()

    assert datos is None
    assert "no devolvió datos" in error


def test_fetch_index_http_error_se_traduce(monkeypatch):
    def fake(*a, **kw):
        raise HTTPError("http://x", 503, "err", {}, None)

    monkeypatch.setattr(feargreed_client, "fetch_json", fake)

    datos, error = feargreed_client.fetch_index()

    assert datos is None
    assert "HTTP 503" in error


def test_fetch_index_url_error_se_traduce(monkeypatch):
    def fake(*a, **kw):
        raise URLError("sin conexión")

    monkeypatch.setattr(feargreed_client, "fetch_json", fake)

    datos, error = feargreed_client.fetch_index()

    assert datos is None
    assert "No se pudo conectar" in error


# ── Histórico ────────────────────────────────────────────────────────────────

def _payload_historico(*valores):
    return {"data": [
        {"value": str(v), "value_classification": "Greed", "timestamp": str(1700000000 - i * 86400)}
        for i, v in enumerate(valores)
    ]}


def test_fetch_history_pide_el_limite_pedido(monkeypatch):
    peticiones = []

    def fake(url, params=None, timeout=None, provider=None):
        peticiones.append(params)
        return _payload_historico(70, 65, 60)

    monkeypatch.setattr(feargreed_client, "fetch_json", fake)

    serie, error = feargreed_client.fetch_history(days=30)

    assert error is None
    assert peticiones[0]["limit"] == 30
    assert [p["valor"] for p in serie] == [70, 65, 60]
    # El más reciente va primero, tal cual lo sirve la fuente.
    assert serie[0]["timestamp"] == "1700000000"


def test_fetch_history_descarta_filas_no_numericas_sin_tirar_las_demas(monkeypatch):
    def fake(*a, **kw):
        return {"data": [
            {"value": "70", "value_classification": "Greed", "timestamp": "1700000000"},
            {"value": "N/A", "value_classification": "Greed", "timestamp": "1699913600"},
            {"value": "55", "value_classification": "Neutral", "timestamp": "1699827200"},
        ]}

    monkeypatch.setattr(feargreed_client, "fetch_json", fake)

    serie, error = feargreed_client.fetch_history(days=3)

    assert error is None
    assert [p["valor"] for p in serie] == [70, 55]


def test_fetch_history_http_error_se_traduce(monkeypatch):
    def fake(*a, **kw):
        raise HTTPError("http://x", 503, "err", {}, None)

    monkeypatch.setattr(feargreed_client, "fetch_json", fake)

    serie, error = feargreed_client.fetch_history()

    assert serie == []
    assert "HTTP 503" in error


def test_fetch_index_usa_fetch_history_con_un_solo_dia(monkeypatch):
    peticiones = []

    def fake(url, params=None, timeout=None, provider=None):
        peticiones.append(params["limit"])
        return _payload_historico(70)

    monkeypatch.setattr(feargreed_client, "fetch_json", fake)

    datos, error = feargreed_client.fetch_index()

    assert error is None
    assert datos["valor"] == 70
    assert peticiones == [1]
