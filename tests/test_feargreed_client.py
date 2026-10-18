"""Cliente del Fear & Greed de cripto (alternative.me).

Nada sale a la red: se sustituye `providers.feargreed_client.fetchJson`.
"""

from urllib.error import HTTPError, URLError

from providers import feargreed_client


def _payload(value="62", classification="Greed"):
    return {"data": [{"value": value, "value_classification": classification, "timestamp": "1700000000"}]}


def testFetchIndexDevuelveElValorYLaClasificacion(monkeypatch):
    monkeypatch.setattr(feargreed_client, "fetchJson", lambda *a, **kw: _payload())

    datos, error = feargreed_client.fetchIndex()

    assert error is None
    assert datos["valor"] == 62
    assert datos["clasificacion"] == "Greed"
    assert datos["timestamp"] == "1700000000"


def testFetchIndexSinFilasEsError(monkeypatch):
    monkeypatch.setattr(feargreed_client, "fetchJson", lambda *a, **kw: {"data": []})

    datos, error = feargreed_client.fetchIndex()

    assert datos is None
    assert "no devolvió datos" in error


def testFetchIndexConValorNoNumericoEsError(monkeypatch):
    # Una fila con un valor que no se puede convertir a número se descarta
    # igual que una fila vacía: sin filas válidas, es el mismo "sin datos".
    monkeypatch.setattr(feargreed_client, "fetchJson", lambda *a, **kw: _payload(value="N/A"))

    datos, error = feargreed_client.fetchIndex()

    assert datos is None
    assert "no devolvió datos" in error


def testFetchIndexHttpErrorSeTraduce(monkeypatch):
    def fake(*a, **kw):
        raise HTTPError("http://x", 503, "err", {}, None)

    monkeypatch.setattr(feargreed_client, "fetchJson", fake)

    datos, error = feargreed_client.fetchIndex()

    assert datos is None
    assert "HTTP 503" in error


def testFetchIndexUrlErrorSeTraduce(monkeypatch):
    def fake(*a, **kw):
        raise URLError("sin conexión")

    monkeypatch.setattr(feargreed_client, "fetchJson", fake)

    datos, error = feargreed_client.fetchIndex()

    assert datos is None
    assert "No se pudo conectar" in error


# ── Histórico ────────────────────────────────────────────────────────────────

def _payloadHistorico(*valores):
    return {"data": [
        {"value": str(v), "value_classification": "Greed", "timestamp": str(1700000000 - i * 86400)}
        for i, v in enumerate(valores)
    ]}


def testFetchHistoryPideElLimitePedido(monkeypatch):
    peticiones = []

    def fake(url, params=None, timeout=None, provider=None):
        peticiones.append(params)
        return _payloadHistorico(70, 65, 60)

    monkeypatch.setattr(feargreed_client, "fetchJson", fake)

    serie, error = feargreed_client.fetchHistory(days=30)

    assert error is None
    assert peticiones[0]["limit"] == 30
    assert [p["valor"] for p in serie] == [70, 65, 60]
    # El más reciente va primero, tal cual lo sirve la fuente.
    assert serie[0]["timestamp"] == "1700000000"


def testFetchHistoryDescartaFilasNoNumericasSinTirarLasDemas(monkeypatch):
    def fake(*a, **kw):
        return {"data": [
            {"value": "70", "value_classification": "Greed", "timestamp": "1700000000"},
            {"value": "N/A", "value_classification": "Greed", "timestamp": "1699913600"},
            {"value": "55", "value_classification": "Neutral", "timestamp": "1699827200"},
        ]}

    monkeypatch.setattr(feargreed_client, "fetchJson", fake)

    serie, error = feargreed_client.fetchHistory(days=3)

    assert error is None
    assert [p["valor"] for p in serie] == [70, 55]


def testFetchHistoryHttpErrorSeTraduce(monkeypatch):
    def fake(*a, **kw):
        raise HTTPError("http://x", 503, "err", {}, None)

    monkeypatch.setattr(feargreed_client, "fetchJson", fake)

    serie, error = feargreed_client.fetchHistory()

    assert serie == []
    assert "HTTP 503" in error


def testFetchIndexUsaFetchHistoryConUnSoloDia(monkeypatch):
    peticiones = []

    def fake(url, params=None, timeout=None, provider=None):
        peticiones.append(params["limit"])
        return _payloadHistorico(70)

    monkeypatch.setattr(feargreed_client, "fetchJson", fake)

    datos, error = feargreed_client.fetchIndex()

    assert error is None
    assert datos["valor"] == 70
    assert peticiones == [1]
