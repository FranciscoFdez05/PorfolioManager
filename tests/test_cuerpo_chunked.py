"""El tope de cuerpo también vale para Transfer-Encoding: chunked.

Regresión: el tope de 5 MB solo miraba la cabecera Content-Length. Un cuerpo de
12 MB enviado en chunked (sin esa cabecera) llegaba a la vista; después, con el
límite por petición, Werkzeug lo truncaba en silencio y la vista lo trataba
como vacío. Tiene que ser un 413, igual que con Content-Length.
"""

import io
import json

import pytest
from flask import Blueprint, jsonify, request

bp = Blueprint("prueba_chunked", __name__)


@bp.route("/api/eco", methods=["POST"])
def eco():
    datos = request.get_json(silent=True)
    return jsonify({"ok": True, "tipo": type(datos).__name__})


@pytest.fixture
def cliente(cliente_autenticado, monkeypatch):
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("MAX_CUERPO_MB", "1")
    client, cabeceras, _app = cliente_autenticado(bp)
    return client, cabeceras


def _chunked(client, cabeceras, megas):
    cuerpo = json.dumps({"nota": "A" * int(megas * 1024 * 1024)}).encode()
    return client.post(
        "/api/eco",
        input_stream=io.BytesIO(cuerpo),
        content_type="application/json",
        headers={**cabeceras, "Transfer-Encoding": "chunked"},
        # Lo que pone un servidor que sabe terminar el chunked (gunicorn, el de
        # desarrollo de Werkzeug): sin esto Werkzeug no lee nada del cuerpo.
        environ_base={"wsgi.input_terminated": True},
    )


def test_un_cuerpo_chunked_por_encima_del_tope_es_413(cliente):
    client, cabeceras = cliente
    assert _chunked(client, cabeceras, 3).status_code == 413


def test_un_cuerpo_chunked_pequeno_llega_entero(cliente):
    client, cabeceras = cliente
    respuesta = _chunked(client, cabeceras, 0.1)
    assert respuesta.status_code == 200
    assert respuesta.get_json()["tipo"] == "dict"


def test_con_content_length_sigue_siendo_413(cliente):
    client, cabeceras = cliente
    cuerpo = json.dumps({"nota": "A" * (3 * 1024 * 1024)})
    respuesta = client.post("/api/eco", data=cuerpo, content_type="application/json", headers=cabeceras)
    assert respuesta.status_code == 413
