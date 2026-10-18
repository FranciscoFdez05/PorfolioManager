"""Reintentos, backoff y tolerancia a respuestas basura del cliente HTTP común.

Nada aquí sale a la red: se sustituye `urlopen` por un doble que devuelve
respuestas o lanza errores según un guion.
"""

import io
import json
from urllib.error import HTTPError, URLError

import pytest

from core import settings
from providers import http as marketHttp
from providers.http import ProviderResponseError, buildUrl, fetchJson


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
        return False


def jsonResponse(payload):
    return FakeResponse(json.dumps(payload).encode("utf-8"))


def httpError(status, retryAfter=None):
    headers = {"Retry-After": str(retryAfter)} if retryAfter is not None else {}
    return HTTPError("http://x", status, "err", headers, None)


@pytest.fixture(autouse=True)
def sinEsperas(monkeypatch):
    """Anula los sleep del backoff para que la suite no tarde segundos."""
    dormido = []
    monkeypatch.setattr(marketHttp.time, "sleep", dormido.append)
    return dormido


@pytest.fixture(autouse=True)
def sinEstadisticas(monkeypatch):
    llamadas = []
    monkeypatch.setattr(marketHttp, "recordApiCall", llamadas.append)
    return llamadas


def guion(monkeypatch, *respuestas):
    """Programa urlopen para devolver/lanzar cada elemento en orden."""
    pendientes = list(respuestas)
    intentos = []

    def fakeUrlopen(request, timeout=None):
        intentos.append(request.full_url)
        siguiente = pendientes.pop(0)
        if isinstance(siguiente, Exception):
            raise siguiente
        return siguiente

    monkeypatch.setattr(marketHttp, "urlopen", fakeUrlopen)
    return intentos


def testDevuelveElJsonAlPrimerIntento(monkeypatch):
    intentos = guion(monkeypatch, jsonResponse({"c": 12.5}))
    assert fetchJson("http://api.test/quote", {"symbol": "AAPL"}) == {"c": 12.5}
    assert len(intentos) == 1
    assert "symbol=AAPL" in intentos[0]


def testReintentaTrasUnTimeout(monkeypatch):
    intentos = guion(monkeypatch, TimeoutError("lento"), jsonResponse({"ok": 1}))
    assert fetchJson("http://api.test/quote") == {"ok": 1}
    assert len(intentos) == 2


def testReintentaAnte5xx(monkeypatch):
    intentos = guion(monkeypatch, httpError(503), jsonResponse({"ok": 1}))
    assert fetchJson("http://api.test/quote") == {"ok": 1}
    assert len(intentos) == 2


def testNoReintentaAnte4xxDeCliente(monkeypatch):
    # Una API key inválida (401) no mejora reintentando: gasta cuota y tiempo.
    intentos = guion(monkeypatch, httpError(401))
    with pytest.raises(HTTPError) as exc:
        fetchJson("http://api.test/quote")
    assert exc.value.code == 401
    assert len(intentos) == 1


def testRespetaRetryAfterAcotado(monkeypatch, sinEsperas):
    guion(monkeypatch, httpError(429, retryAfter=60), jsonResponse({"ok": 1}))
    assert fetchJson("http://api.test/quote") == {"ok": 1}
    # 60 s pedidos por el proveedor, pero el usuario está esperando: se acota.
    assert sinEsperas[0] <= settings.proveedorMaxRetryAfter()


def testAgotaLosReintentosYPropagaElErrorOriginal(monkeypatch):
    intentos = guion(monkeypatch, URLError("sin red"), URLError("sin red"), URLError("sin red"))
    with pytest.raises(URLError):
        fetchJson("http://api.test/quote")
    assert len(intentos) == 3  # 1 intento + 2 reintentos por defecto


def testJsonMalformadoSeTrataComoErrorDeRed(monkeypatch):
    # Los proveedores devuelven HTML en mantenimiento; antes esto era un
    # JSONDecodeError que ningún llamante capturaba y acababa en un 500.
    guion(monkeypatch,
          FakeResponse(b"<html>maintenance</html>"),
          FakeResponse(b"<html>maintenance</html>"),
          FakeResponse(b"<html>maintenance</html>"))
    with pytest.raises(ProviderResponseError):
        fetchJson("http://api.test/quote")


def testErrorDeRespuestaEsCapturableComoUrlerror(monkeypatch):
    # Los clientes ya tienen ramas `except URLError`; deben cubrir este caso.
    guion(monkeypatch, *(FakeResponse(b"no json") for _ in range(3)))
    with pytest.raises(URLError):
        fetchJson("http://api.test/quote")


def testRespuestaVaciaEsError(monkeypatch):
    guion(monkeypatch, *(FakeResponse(b"") for _ in range(3)))
    with pytest.raises(ProviderResponseError):
        fetchJson("http://api.test/quote")


def testRespuestaDemasiadoGrandeSeCorta(monkeypatch):
    enorme = b'{"a":"' + b"x" * (settings.proveedorMaxRespuestaBytes() + 10) + b'"}'
    guion(monkeypatch, *(FakeResponse(enorme) for _ in range(3)))
    with pytest.raises(ProviderResponseError):
        fetchJson("http://api.test/quote")


def testContabilizaUnaLlamadaPorIntento(monkeypatch, sinEstadisticas):
    guion(monkeypatch, httpError(503), jsonResponse({"ok": 1}))
    fetchJson("http://api.test/quote", provider="Finnhub")
    # Cada intento consume cuota real del proveedor.
    assert sinEstadisticas == ["Finnhub", "Finnhub"]


def testSinProveedorNoContabiliza(monkeypatch, sinEstadisticas):
    guion(monkeypatch, jsonResponse({"ok": 1}))
    fetchJson("http://api.test/quote")
    assert sinEstadisticas == []


def testBuildUrlSinParametros():
    assert buildUrl("http://api.test/x") == "http://api.test/x"
    assert buildUrl("http://api.test/x", {}) == "http://api.test/x"
    assert buildUrl("http://api.test/x", {"a": "1"}) == "http://api.test/x?a=1"


def testJsonBodyMandaPostConElCuerpoSerializado(monkeypatch):
    # El scanner de TradingView (tradingview_client.py) es el único que pide
    # POST con cuerpo JSON en vez de query string; el resto de proveedores
    # siguen en GET sin tocar este camino.
    peticiones = []

    def fakeUrlopen(request, timeout=None):
        peticiones.append(request)
        return jsonResponse({"ok": 1})

    monkeypatch.setattr(marketHttp, "urlopen", fakeUrlopen)

    resultado = fetchJson("http://api.test/scan", jsonBody={"symbols": ["AAPL"]})

    assert resultado == {"ok": 1}
    assert len(peticiones) == 1
    peticion = peticiones[0]
    assert peticion.get_method() == "POST"
    assert peticion.get_header("Content-type") == "application/json"
    assert json.loads(peticion.data.decode("utf-8")) == {"symbols": ["AAPL"]}


def testSinJsonBodySigueSiendoGet(monkeypatch):
    peticiones = []

    def fakeUrlopen(request, timeout=None):
        peticiones.append(request)
        return jsonResponse({"ok": 1})

    monkeypatch.setattr(marketHttp, "urlopen", fakeUrlopen)

    fetchJson("http://api.test/quote", {"symbol": "AAPL"})

    assert peticiones[0].get_method() == "GET"
    assert peticiones[0].data is None
