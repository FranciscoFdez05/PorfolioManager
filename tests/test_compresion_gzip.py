"""Pruebas de la compresión gzip instalada en `core/seguridad_app.py`.

No hay por qué depender de que Caddy (u otro proxy) comprima delante: una
instalación sin proxy, o con uno que no comprima, tiene que servir el JS/CSS/
JSON propios comprimidos igual. Este `after_request` es lo único que lo
garantiza, así que es lo único que hay que comprobar aquí.
"""

import gzip
import json

import pytest
from flask import Blueprint, Response

pruebasBp = Blueprint("pruebas_gzip", __name__)

TEXTO_GRANDE = "x" * 5000
TEXTO_PEQUENO = "hola"


@pruebasBp.route("/prueba/json-grande")
def jsonGrande():
    return Response(json.dumps({"datos": TEXTO_GRANDE}), mimetype="application/json")


@pruebasBp.route("/prueba/texto-pequeno")
def textoPequeno():
    return Response(TEXTO_PEQUENO, mimetype="text/plain")


@pruebasBp.route("/prueba/binario")
def binario():
    # bytes no comprimibles (mimetype fuera de la lista blanca), del tamaño
    # que sea: nunca debe llevar Content-Encoding.
    return Response(TEXTO_GRANDE.encode(), mimetype="application/octet-stream")


@pytest.fixture
def cliente(clienteAutenticado):
    client, cabeceras, _app = clienteAutenticado(pruebasBp)
    return client, cabeceras


def testUnaRespuestaGrandeYComprimibleSeMandaEnGzip(cliente):
    client, cabeceras = cliente

    respuesta = client.get(
        "/prueba/json-grande", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert respuesta.headers.get("Content-Encoding") == "gzip"
    assert "Accept-Encoding" in respuesta.headers.get("Vary", "")
    descomprimido = gzip.decompress(respuesta.get_data())
    assert json.loads(descomprimido)["datos"] == TEXTO_GRANDE


def testSinAcceptEncodingNoSeComprime(cliente):
    client, cabeceras = cliente

    respuesta = client.get("/prueba/json-grande", headers=cabeceras)

    assert "Content-Encoding" not in respuesta.headers
    assert json.loads(respuesta.get_data())["datos"] == TEXTO_GRANDE


def testUnaRespuestaPequenaNoSeComprimeAunqueSeAcepte(cliente):
    """Por debajo del umbral, la cabecera de gzip pesa más que lo que ahorra."""
    client, cabeceras = cliente

    respuesta = client.get(
        "/prueba/texto-pequeno", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert "Content-Encoding" not in respuesta.headers
    assert respuesta.get_data(as_text=True) == TEXTO_PEQUENO


def testUnMimetypeNoComprimibleNoSeToca(cliente):
    client, cabeceras = cliente

    respuesta = client.get(
        "/prueba/binario", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert "Content-Encoding" not in respuesta.headers
    assert respuesta.get_data() == TEXTO_GRANDE.encode()


def testUnEstaticoJsSeSirveComprimido(clienteAutenticado):
    """El caso real: send_from_directory con direct_passthrough=True.

    Es justo el camino por el que sale todo el JS/CSS propio, y el que un
    chequeo ingenuo de `response.direct_passthrough` dejaría siempre sin
    comprimir.
    """
    from flask import send_from_directory

    from core.paths import BASE_DIR

    estaticosBp = Blueprint("estaticos_prueba", __name__)

    @estaticosBp.route("/prueba/estatico")
    def estatico():
        return send_from_directory(BASE_DIR, "js/core/dom.js")

    client, cabeceras, _app = clienteAutenticado(estaticosBp)

    original = (BASE_DIR / "js/core/dom.js").read_bytes()
    respuesta = client.get(
        "/prueba/estatico", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert respuesta.headers.get("Content-Encoding") == "gzip"
    assert gzip.decompress(respuesta.get_data()) == original
