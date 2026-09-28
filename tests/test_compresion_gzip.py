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

pruebas_bp = Blueprint("pruebas_gzip", __name__)

TEXTO_GRANDE = "x" * 5000
TEXTO_PEQUENO = "hola"


@pruebas_bp.route("/prueba/json-grande")
def json_grande():
    return Response(json.dumps({"datos": TEXTO_GRANDE}), mimetype="application/json")


@pruebas_bp.route("/prueba/texto-pequeno")
def texto_pequeno():
    return Response(TEXTO_PEQUENO, mimetype="text/plain")


@pruebas_bp.route("/prueba/binario")
def binario():
    # bytes no comprimibles (mimetype fuera de la lista blanca), del tamaño
    # que sea: nunca debe llevar Content-Encoding.
    return Response(TEXTO_GRANDE.encode(), mimetype="application/octet-stream")


@pytest.fixture
def cliente(cliente_autenticado):
    client, cabeceras, _app = cliente_autenticado(pruebas_bp)
    return client, cabeceras


def test_una_respuesta_grande_y_comprimible_se_manda_en_gzip(cliente):
    client, cabeceras = cliente

    respuesta = client.get(
        "/prueba/json-grande", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert respuesta.headers.get("Content-Encoding") == "gzip"
    assert "Accept-Encoding" in respuesta.headers.get("Vary", "")
    descomprimido = gzip.decompress(respuesta.get_data())
    assert json.loads(descomprimido)["datos"] == TEXTO_GRANDE


def test_sin_accept_encoding_no_se_comprime(cliente):
    client, cabeceras = cliente

    respuesta = client.get("/prueba/json-grande", headers=cabeceras)

    assert "Content-Encoding" not in respuesta.headers
    assert json.loads(respuesta.get_data())["datos"] == TEXTO_GRANDE


def test_una_respuesta_pequena_no_se_comprime_aunque_se_acepte(cliente):
    """Por debajo del umbral, la cabecera de gzip pesa más que lo que ahorra."""
    client, cabeceras = cliente

    respuesta = client.get(
        "/prueba/texto-pequeno", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert "Content-Encoding" not in respuesta.headers
    assert respuesta.get_data(as_text=True) == TEXTO_PEQUENO


def test_un_mimetype_no_comprimible_no_se_toca(cliente):
    client, cabeceras = cliente

    respuesta = client.get(
        "/prueba/binario", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert "Content-Encoding" not in respuesta.headers
    assert respuesta.get_data() == TEXTO_GRANDE.encode()


def test_un_estatico_js_se_sirve_comprimido(cliente_autenticado):
    """El caso real: send_from_directory con direct_passthrough=True.

    Es justo el camino por el que sale todo el JS/CSS propio, y el que un
    chequeo ingenuo de `response.direct_passthrough` dejaría siempre sin
    comprimir.
    """
    from flask import send_from_directory

    from core.paths import BASE_DIR

    estaticos_bp = Blueprint("estaticos_prueba", __name__)

    @estaticos_bp.route("/prueba/estatico")
    def estatico():
        return send_from_directory(BASE_DIR, "js/core/dom.js")

    client, cabeceras, _app = cliente_autenticado(estaticos_bp)

    original = (BASE_DIR / "js/core/dom.js").read_bytes()
    respuesta = client.get(
        "/prueba/estatico", headers={**cabeceras, "Accept-Encoding": "gzip"}
    )

    assert respuesta.headers.get("Content-Encoding") == "gzip"
    assert gzip.decompress(respuesta.get_data()) == original
