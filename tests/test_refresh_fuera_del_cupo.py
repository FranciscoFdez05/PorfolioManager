"""El refresco de cotizaciones no gasta el cupo de escrituras, pero sigue protegido."""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.activos import activosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "3")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, app = clienteAutenticado(activosBp)
    return client, cabeceras, app


def testElRefrescoNoConsumeElCupo(cliente):
    client, cabeceras, _app = cliente

    estados = [
        client.post("/api/activos/inexistente/refresh-market-data", headers=cabeceras).status_code
        for _ in range(10)
    ]

    assert 429 not in estados
    assert set(estados) == {404}


def testOtrasEscriturasSiguenLimitadas(cliente):
    client, cabeceras, _app = cliente

    estados = [
        client.post("/api/activos/inexistente/currency", json={}, headers=cabeceras).status_code
        for _ in range(6)
    ]

    assert 429 in estados


def testElRefrescoSigueExigiendoCsrf(cliente):
    client, _cabeceras, _app = cliente

    respuesta = client.post("/api/activos/inexistente/refresh-market-data")

    assert respuesta.status_code == 403


def testElRefrescoSigueExigiendoSesion(crearApp, datosAislados, tempDb, monkeypatch):
    from routes.activos import activosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "3")
    client = crearApp(activosBp).test_client()

    respuesta = client.post("/api/activos/inexistente/refresh-market-data")

    assert respuesta.status_code == 401
