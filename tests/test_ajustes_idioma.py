"""Pruebas del ajuste `idioma` de /api/settings.

El idioma de la interfaz es un ajuste global independiente del formato de
números (`numLocale`): elegir la interfaz en inglés no debe cambiar cómo se
escriben los importes, ni al revés.
"""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, cabeceras


def _guardar(client, cabeceras, **campos):
    return client.post("/api/settings", json=campos, headers=cabeceras)


def testPorDefectoElIdiomaEsEspanol(cliente):
    client, _cabeceras = cliente

    assert client.get("/api/settings").get_json()["idioma"] == "es"


def testElIdiomaElegidoSePersiste(cliente):
    client, cabeceras = cliente

    respuesta = _guardar(client, cabeceras, idioma="en")

    assert respuesta.get_json()["ok"] is True
    assert client.get("/api/settings").get_json()["idioma"] == "en"


@pytest.mark.parametrize("valor", ["fr", "EN", "en-GB", "", None, ["en"], {"a": 1}])
def testUnIdiomaNoAdmitidoCaeAlEspanol(cliente, valor):
    """Solo se guardan los idiomas que tienen diccionario en js/locales/."""
    client, cabeceras = cliente

    respuesta = _guardar(client, cabeceras, idioma=valor)

    assert respuesta.status_code == 200
    assert client.get("/api/settings").get_json()["idioma"] == "es"


def testIdiomaYFormatoDeNumerosSonIndependientes(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, numLocale="es-ES")

    _guardar(client, cabeceras, idioma="en")

    datos = client.get("/api/settings").get_json()
    assert datos["idioma"] == "en"
    assert datos["numLocale"] == "es-ES"
