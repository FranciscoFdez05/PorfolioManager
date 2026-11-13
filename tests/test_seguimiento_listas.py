"""Listas con nombre de Seguimiento: se normalizan, se guardan en el perfil y sobreviven a datos raros."""

import pytest

from stores import seguimiento_prefs


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, cabeceras


def testNormalizarListasLimpiaNombreYRepetidos():
    crudo = {"a": {"nombre": "  Cripto  ", "ids": ["x", "y", "x", 3, ""]}}
    assert seguimiento_prefs.normalizarListas(crudo) == {"a": {"nombre": "Cripto", "ids": ["x", "y"]}}


def testNormalizarListasDeOtroTipoDaDiccionarioVacio():
    assert seguimiento_prefs.normalizarListas(["a"]) == {}
    assert seguimiento_prefs.normalizarListas(None) == {}


def testNormalizarListasDescartaLasInvalidas():
    crudo = {
        "": {"nombre": "Sin id", "ids": []},
        "sinNombre": {"nombre": "   ", "ids": []},
        "nombreNoTexto": {"nombre": 5, "ids": []},
        "noDict": "basura",
        "buena": {"nombre": "Buena"},
    }
    assert seguimiento_prefs.normalizarListas(crudo) == {"buena": {"nombre": "Buena", "ids": []}}


def testNormalizarListasRespetaLosTopes():
    muchas = {f"l{i}": {"nombre": f"Lista {i}", "ids": []} for i in range(seguimiento_prefs.MAX_LISTAS + 5)}
    assert len(seguimiento_prefs.normalizarListas(muchas)) == seguimiento_prefs.MAX_LISTAS

    larga = {"a": {"nombre": "n" * 500, "ids": []}}
    assert len(seguimiento_prefs.normalizarListas(larga)["a"]["nombre"]) == 60


def testSinListasGuardadasDevuelveDiccionarioVacio(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/settings").get_json()["seguimientoListas"] == {}


def testLasListasSeGuardanYSeLeen(cliente):
    client, cabeceras = cliente
    listas = {"a": {"nombre": "Cripto", "ids": ["portfolio_1", "custom_2"]}}
    respuesta = client.post("/api/settings", json={"seguimientoListas": listas}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert client.get("/api/settings").get_json()["seguimientoListas"] == listas


def testUnValorDeOtroTipoNoBorraLasListas(cliente):
    client, cabeceras = cliente
    listas = {"a": {"nombre": "Cripto", "ids": ["x"]}}
    client.post("/api/settings", json={"seguimientoListas": listas}, headers=cabeceras)
    client.post("/api/settings", json={"seguimientoListas": "basura"}, headers=cabeceras)

    assert client.get("/api/settings").get_json()["seguimientoListas"] == listas


def testAlGuardarSeLimpianLasListasInvalidas(cliente):
    client, cabeceras = cliente
    crudo = {"a": {"nombre": " Uno ", "ids": ["x", "x"]}, "b": {"nombre": "", "ids": []}}
    client.post("/api/settings", json={"seguimientoListas": crudo}, headers=cabeceras)

    assert client.get("/api/settings").get_json()["seguimientoListas"] == {"a": {"nombre": "Uno", "ids": ["x"]}}
