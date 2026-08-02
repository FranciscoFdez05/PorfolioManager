"""Reintentos, backoff y tolerancia a respuestas basura del cliente HTTP común.

Nada aquí sale a la red: se sustituye `urlopen` por un doble que devuelve
respuestas o lanza errores según un guion.
"""

import io
import json
from urllib.error import HTTPError, URLError

import pytest

from providers import http as market_http
from providers.http import MAX_RESPONSE_BYTES, ProviderResponseError, build_url, fetch_json


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()
        return False


def json_response(payload):
    return FakeResponse(json.dumps(payload).encode("utf-8"))


def http_error(status, retry_after=None):
    headers = {"Retry-After": str(retry_after)} if retry_after is not None else {}
    return HTTPError("http://x", status, "err", headers, None)


@pytest.fixture(autouse=True)
def sin_esperas(monkeypatch):
    """Anula los sleep del backoff para que la suite no tarde segundos."""
    dormido = []
    monkeypatch.setattr(market_http.time, "sleep", dormido.append)
    return dormido


@pytest.fixture(autouse=True)
def sin_estadisticas(monkeypatch):
    llamadas = []
    monkeypatch.setattr(market_http, "record_api_call", llamadas.append)
    return llamadas


def guion(monkeypatch, *respuestas):
    """Programa urlopen para devolver/lanzar cada elemento en orden."""
    pendientes = list(respuestas)
    intentos = []

    def fake_urlopen(request, timeout=None):
        intentos.append(request.full_url)
        siguiente = pendientes.pop(0)
        if isinstance(siguiente, Exception):
            raise siguiente
        return siguiente

    monkeypatch.setattr(market_http, "urlopen", fake_urlopen)
    return intentos


def test_devuelve_el_json_al_primer_intento(monkeypatch):
    intentos = guion(monkeypatch, json_response({"c": 12.5}))
    assert fetch_json("http://api.test/quote", {"symbol": "AAPL"}) == {"c": 12.5}
    assert len(intentos) == 1
    assert "symbol=AAPL" in intentos[0]


def test_reintenta_tras_un_timeout(monkeypatch):
    intentos = guion(monkeypatch, TimeoutError("lento"), json_response({"ok": 1}))
    assert fetch_json("http://api.test/quote") == {"ok": 1}
    assert len(intentos) == 2


def test_reintenta_ante_5xx(monkeypatch):
    intentos = guion(monkeypatch, http_error(503), json_response({"ok": 1}))
    assert fetch_json("http://api.test/quote") == {"ok": 1}
    assert len(intentos) == 2


def test_no_reintenta_ante_4xx_de_cliente(monkeypatch):
    # Una API key inválida (401) no mejora reintentando: gasta cuota y tiempo.
    intentos = guion(monkeypatch, http_error(401))
    with pytest.raises(HTTPError) as exc:
        fetch_json("http://api.test/quote")
    assert exc.value.code == 401
    assert len(intentos) == 1


def test_respeta_retry_after_acotado(monkeypatch, sin_esperas):
    guion(monkeypatch, http_error(429, retry_after=60), json_response({"ok": 1}))
    assert fetch_json("http://api.test/quote") == {"ok": 1}
    # 60 s pedidos por el proveedor, pero el usuario está esperando: se acota.
    assert sin_esperas[0] <= market_http.MAX_RETRY_AFTER


def test_agota_los_reintentos_y_propaga_el_error_original(monkeypatch):
    intentos = guion(monkeypatch, URLError("sin red"), URLError("sin red"), URLError("sin red"))
    with pytest.raises(URLError):
        fetch_json("http://api.test/quote")
    assert len(intentos) == 3  # 1 intento + 2 reintentos por defecto


def test_json_malformado_se_trata_como_error_de_red(monkeypatch):
    # Los proveedores devuelven HTML en mantenimiento; antes esto era un
    # JSONDecodeError que ningún llamante capturaba y acababa en un 500.
    guion(monkeypatch,
          FakeResponse(b"<html>maintenance</html>"),
          FakeResponse(b"<html>maintenance</html>"),
          FakeResponse(b"<html>maintenance</html>"))
    with pytest.raises(ProviderResponseError):
        fetch_json("http://api.test/quote")


def test_error_de_respuesta_es_capturable_como_urlerror(monkeypatch):
    # Los clientes ya tienen ramas `except URLError`; deben cubrir este caso.
    guion(monkeypatch, *(FakeResponse(b"no json") for _ in range(3)))
    with pytest.raises(URLError):
        fetch_json("http://api.test/quote")


def test_respuesta_vacia_es_error(monkeypatch):
    guion(monkeypatch, *(FakeResponse(b"") for _ in range(3)))
    with pytest.raises(ProviderResponseError):
        fetch_json("http://api.test/quote")


def test_respuesta_demasiado_grande_se_corta(monkeypatch):
    enorme = b'{"a":"' + b"x" * (MAX_RESPONSE_BYTES + 10) + b'"}'
    guion(monkeypatch, *(FakeResponse(enorme) for _ in range(3)))
    with pytest.raises(ProviderResponseError):
        fetch_json("http://api.test/quote")


def test_contabiliza_una_llamada_por_intento(monkeypatch, sin_estadisticas):
    guion(monkeypatch, http_error(503), json_response({"ok": 1}))
    fetch_json("http://api.test/quote", provider="Finnhub")
    # Cada intento consume cuota real del proveedor.
    assert sin_estadisticas == ["Finnhub", "Finnhub"]


def test_sin_proveedor_no_contabiliza(monkeypatch, sin_estadisticas):
    guion(monkeypatch, json_response({"ok": 1}))
    fetch_json("http://api.test/quote")
    assert sin_estadisticas == []


def test_build_url_sin_parametros():
    assert build_url("http://api.test/x") == "http://api.test/x"
    assert build_url("http://api.test/x", {}) == "http://api.test/x"
    assert build_url("http://api.test/x", {"a": "1"}) == "http://api.test/x?a=1"
