"""Orden de las tarjetas de Seguimiento: se guarda en el perfil y sobrevive a datos raros."""

import pytest

from stores import seguimiento_prefs


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, cabeceras


def testNormalizarOrdenQuitaRepetidosYNoTextos():
    assert seguimiento_prefs.normalizarOrden(["b", "a", "b", 3, "", None, "c"]) == ["b", "a", "c"]


def testNormalizarOrdenDeOtroTipoDaListaVacia():
    assert seguimiento_prefs.normalizarOrden({"a": 1}) == []


def testNormalizarOrdenRespetaElTope():
    orden = [f"id{i}" for i in range(seguimiento_prefs.MAX_ELEMENTOS + 10)]
    assert len(seguimiento_prefs.normalizarOrden(orden)) == seguimiento_prefs.MAX_ELEMENTOS


def testSinOrdenGuardadoDevuelveListaVacia(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/settings").get_json()["seguimientoOrden"] == []


def testElOrdenSeGuardaYSeLee(cliente):
    client, cabeceras = cliente
    respuesta = client.post("/api/settings", json={"seguimientoOrden": ["custom_1", "portfolio_a"]}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert client.get("/api/settings").get_json()["seguimientoOrden"] == ["custom_1", "portfolio_a"]


def testUnValorDeOtroTipoNoBorraElOrden(cliente):
    client, cabeceras = cliente
    client.post("/api/settings", json={"seguimientoOrden": ["a", "b"]}, headers=cabeceras)
    client.post("/api/settings", json={"seguimientoOrden": "basura"}, headers=cabeceras)

    assert client.get("/api/settings").get_json()["seguimientoOrden"] == ["a", "b"]
