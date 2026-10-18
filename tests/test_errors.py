"""La capa de errores debe garantizar JSON en /api/ y no filtrar internos."""

import pytest
from flask import jsonify

from core.errors import ApiError, ConflictError, NotFoundError, UpstreamError, ValidationError


@pytest.fixture
def client(errorApp):
    @errorApp.route("/api/ok")
    def ok():
        return jsonify({"ok": True})

    @errorApp.route("/api/boom")
    def boom():
        raise RuntimeError("ruta interna /home/secreta/db.sqlite")

    @errorApp.route("/api/invalido")
    def invalido():
        raise ValidationError("El año no es válido", field="year")

    @errorApp.route("/api/nohay")
    def nohay():
        raise NotFoundError("Año no encontrado")

    @errorApp.route("/api/conflicto")
    def conflicto():
        raise ConflictError("Ese año ya existe")

    @errorApp.route("/api/proveedor")
    def proveedor():
        raise UpstreamError("Finnhub no responde")

    @errorApp.route("/pagina")
    def pagina():
        raise RuntimeError("fallo")

    return errorApp.test_client()


def testRutaCorrectaNoSeVeAfectada(client):
    response = client.get("/api/ok")
    assert response.status_code == 200
    assert response.get_json() == {"ok": True}


def testErrorInesperadoDevuelveJsonSinDetalles(client):
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
def testErroresDeNegocioMapeanSuCodigo(client, ruta, status):
    response = client.get(ruta)
    assert response.status_code == status
    assert response.get_json()["ok"] is False


def testErrorDeValidacionIncluyeElCampo(client):
    payload = client.get("/api/invalido").get_json()
    assert payload["field"] == "year"
    assert payload["error"] == "El año no es válido"


def test404DeApiEsJson(client):
    response = client.get("/api/no-existe")
    assert response.status_code == 404
    assert response.is_json
    assert response.get_json()["error"] == "Recurso no encontrado"


def testRutaNoApiNoDevuelveJson(client):
    # Una página HTML debe seguir dando una respuesta HTML, no JSON.
    response = client.get("/pagina")
    assert response.status_code == 500
    assert not response.is_json


def testRequestIdViajaEnLaCabecera(client):
    response = client.get("/api/ok")
    assert response.headers.get("X-Request-Id")


def testRequestIdEntranteSeRespeta(client):
    response = client.get("/api/ok", headers={"X-Request-Id": "abc123"})
    assert response.headers["X-Request-Id"] == "abc123"


def testRequestIdEntranteSeAcota(client):
    response = client.get("/api/ok", headers={"X-Request-Id": "x" * 500})
    assert len(response.headers["X-Request-Id"]) <= 64


def testApiErrorAdmiteStatusPersonalizado():
    error = ApiError("demasiadas peticiones", 429)
    assert error.status_code == 429
    assert error.to_dict() == {"ok": False, "error": "demasiadas peticiones"}
