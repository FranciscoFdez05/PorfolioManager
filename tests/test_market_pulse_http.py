"""HTTP de /api/market/pulse.

Nada sale a la red: se sustituyen las funciones de `stores.market_pulse` que
importa `routes.market_pulse`. Cada sección se prueba también fallando por
separado, porque la ruta debe devolver lo que sí llegó en vez de tirar toda
la respuesta por un fallo parcial.
"""

from urllib.error import HTTPError, URLError

from routes import market_pulse as route
from routes.market_pulse import marketPulseBp


def _cliente(clienteAutenticado):
    client, cabeceras, _app = clienteAutenticado(marketPulseBp)
    return client, cabeceras


def _sinFallos(monkeypatch):
    monkeypatch.setattr(route.market_pulse, "snapshot", lambda: {"indices": [], "sectores": []})
    monkeypatch.setattr(route.market_pulse, "topMovers", lambda limit=10: {"subidas": [], "bajadas": []})
    monkeypatch.setattr(route.market_pulse, "breadth", lambda: {"subidas": 1, "bajadas": 1, "planas": 0, "total": 2})
    monkeypatch.setattr(route.market_pulse, "rsiExtremes", lambda limit=8: {"sobrecompra": [], "sobreventa": []})
    monkeypatch.setattr(route.market_pulse, "unusualVolume", lambda limit=8: [])
    monkeypatch.setattr(route.market_pulse, "fearGreed", lambda: ({"valor": 50, "clasificacion": "Neutral"}, None))
    monkeypatch.setattr(route.market_pulse, "fearGreedHistory", lambda: ([{"valor": 50}], None))


def testDevuelveLasSieteSecciones(clienteAutenticado, monkeypatch):
    _sinFallos(monkeypatch)
    client, _cabeceras = _cliente(clienteAutenticado)

    respuesta = client.get("/api/market/pulse")

    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True
    assert datos["breadth"]["total"] == 2
    assert datos["rsi"] == {"sobrecompra": [], "sobreventa": []}
    assert datos["unusualVolume"] == []
    assert datos["fearGreed"]["valor"] == 50
    assert datos["fearGreedHistory"] == [{"valor": 50}]
    assert "snapshotError" not in datos
    assert "fearGreedHistoryError" not in datos


def testRsiPuedeFallarSinAfectarAlResto(clienteAutenticado, monkeypatch):
    _sinFallos(monkeypatch)
    monkeypatch.setattr(route.market_pulse, "rsiExtremes", lambda limit=8: (_ for _ in ()).throw(URLError("sin red")))

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse")

    datos = respuesta.get_json()
    assert datos["rsi"] is None
    assert "No se pudo conectar" in datos["rsiError"]
    assert datos["unusualVolume"] == []


def testUnFalloEnElScreenerNoTumbaLasDemasSecciones(clienteAutenticado, monkeypatch):
    _sinFallos(monkeypatch)
    monkeypatch.setattr(route.market_pulse, "topMovers", lambda limit=10: (_ for _ in ()).throw(URLError("sin red")))

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse")

    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True
    assert datos["movers"] is None
    assert "No se pudo conectar" in datos["moversError"]
    # El resto de secciones sigue llegando.
    assert datos["fearGreed"]["valor"] == 50


def testUnHttpErrorSeTraduceConElCodigo(clienteAutenticado, monkeypatch):
    _sinFallos(monkeypatch)

    def fallo():
        raise HTTPError("http://x", 429, "err", {}, None)

    monkeypatch.setattr(route.market_pulse, "snapshot", fallo)

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse")

    datos = respuesta.get_json()
    assert datos["snapshot"] is None
    assert "HTTP 429" in datos["snapshotError"]


def testFearGreedPuedeFallarSinAfectarAlResto(clienteAutenticado, monkeypatch):
    _sinFallos(monkeypatch)
    monkeypatch.setattr(route.market_pulse, "fearGreed", lambda: (None, "Fear & Greed no devolvió datos"))

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse")

    datos = respuesta.get_json()
    assert datos["fearGreed"] is None
    assert datos["fearGreedError"] == "Fear & Greed no devolvió datos"
    assert datos["breadth"]["total"] == 2


def testFearGreedHistoryPuedeFallarSinAfectarAlResto(clienteAutenticado, monkeypatch):
    _sinFallos(monkeypatch)
    monkeypatch.setattr(route.market_pulse, "fearGreedHistory", lambda: ([], "sin datos"))

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse")

    datos = respuesta.get_json()
    assert datos["fearGreedHistory"] == []
    assert datos["fearGreedHistoryError"] == "sin datos"
    assert datos["fearGreed"]["valor"] == 50


# ── /api/market/pulse/universe ───────────────────────────────────────────────

def testUniverseDevuelveLasFilasDelTipoPedido(clienteAutenticado, monkeypatch):
    monkeypatch.setattr(
        route.market_pulse, "universe",
        lambda clave: [{"symbol": "AMEX:XLK", "primary": "Tecnología", "secondary": "", "change": 0.8, "size": 1}],
    )

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse/universe?type=sp500")

    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True
    assert datos["universe"] == "sp500"
    assert datos["items"][0]["primary"] == "Tecnología"


def testUniverseDesconocidoEs400(clienteAutenticado, monkeypatch):
    monkeypatch.setattr(route.market_pulse, "universe", lambda clave: None)

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse/universe?type=lo-que-sea")

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testUniverseSinTypeUsaSp500PorDefecto(clienteAutenticado, monkeypatch):
    claves = []
    monkeypatch.setattr(route.market_pulse, "universe", lambda clave: claves.append(clave) or [])

    client, _cabeceras = _cliente(clienteAutenticado)
    client.get("/api/market/pulse/universe")

    assert claves == ["sp500"]


def testUniverseErrorDeRedEs503(clienteAutenticado, monkeypatch):
    def fallo(clave):
        raise URLError("sin conexión")

    monkeypatch.setattr(route.market_pulse, "universe", fallo)

    client, _cabeceras = _cliente(clienteAutenticado)
    respuesta = client.get("/api/market/pulse/universe?type=cripto")

    assert respuesta.status_code == 503
    assert "No se pudo conectar" in respuesta.get_json()["error"]
