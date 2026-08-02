"""La capa de errores debe garantizar JSON en /api/ y no filtrar internos."""

import pytest
from flask import jsonify

from core.errors import ApiError, ConflictError, NotFoundError, UpstreamError, ValidationError


@pytest.fixture
def client(error_app):
    @error_app.route("/api/ok")
    def ok():
        return jsonify({"ok": True})

    @error_app.route("/api/boom")
    def boom():
        raise RuntimeError("ruta interna /home/secreta/db.sqlite")

    @error_app.route("/api/invalido")
    def invalido():
        raise ValidationError("El año no es válido", field="year")

    @error_app.route("/api/nohay")
    def nohay():
        raise NotFoundError("Año no encontrado")

    @error_app.route("/api/conflicto")
    def conflicto():
        raise ConflictError("Ese año ya existe")

    @error_app.route("/api/proveedor")
    def proveedor():
        raise UpstreamError("Finnhub no responde")

    @error_app.route("/pagina")
    def pagina():
        raise RuntimeError("fallo")

    return error_app.test_client()


def test_ruta_correcta_no_se_ve_afectada(client):
    response = client.get("/api/ok")
    assert response.status_code == 200
    assert response.get_json() == {"ok": True}


def test_error_inesperado_devuelve_json_sin_detalles(client):
    response = client.get("/api/boom")
    assert response.status_code == 500
    assert response.is_json
    payload = response.get_json()
    assert payload["ok"] is False
    # El detalle interno (ruta del sistema) no puede salir al cliente.
    assert "secreta" not in payload["error"]
    assert payload["error"] == "Error interno del servidor"
    assert payload["requestId"]


@pytest.mark.parametrize("ruta,status", [
    ("/api/invalido", 400),
    ("/api/nohay", 404),
    ("/api/conflicto", 409),
    ("/api/proveedor", 502),
])
def test_errores_de_negocio_mapean_su_codigo(client, ruta, status):
    response = client.get(ruta)
    assert response.status_code == status
    assert response.get_json()["ok"] is False


def test_error_de_validacion_incluye_el_campo(client):
    payload = client.get("/api/invalido").get_json()
    assert payload["field"] == "year"
    assert payload["error"] == "El año no es válido"


def test_404_de_api_es_json(client):
    response = client.get("/api/no-existe")
    assert response.status_code == 404
    assert response.is_json
    assert response.get_json()["error"] == "Recurso no encontrado"


def test_ruta_no_api_no_devuelve_json(client):
    # Una página HTML debe seguir dando una respuesta HTML, no JSON.
    response = client.get("/pagina")
    assert response.status_code == 500
    assert not response.is_json


def test_request_id_viaja_en_la_cabecera(client):
    response = client.get("/api/ok")
    assert response.headers.get("X-Request-Id")


def test_request_id_entrante_se_respeta(client):
    response = client.get("/api/ok", headers={"X-Request-Id": "abc123"})
    assert response.headers["X-Request-Id"] == "abc123"


def test_request_id_entrante_se_acota(client):
    response = client.get("/api/ok", headers={"X-Request-Id": "x" * 500})
    assert len(response.headers["X-Request-Id"]) <= 64


def test_api_error_admite_status_personalizado():
    error = ApiError("demasiadas peticiones", 429)
    assert error.status_code == 429
    assert error.to_dict() == {"ok": False, "error": "demasiadas peticiones"}
