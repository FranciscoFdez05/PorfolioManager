"""`/api/gastos/todos` e `/api/ingresos/todos`: lo mismo que pedir año a año."""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.gastos import gastosBp
    from routes.ingresos import ingresosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = clienteAutenticado(gastosBp, ingresosBp)
    return client, cabeceras


def _sembrar(client, cabeceras):
    for year in ("2024", "2025", "2026"):
        res = client.post(
            f"/api/gastos/{year}",
            json={"year": year, "months": {"marzo": {"rows": [{"nombre": "Luz", "cantidad": "12,50", "fecha": f"01-03-{year}"}]}}},
            headers=cabeceras,
        )
        assert res.status_code == 200, res.get_json()
        res = client.post(
            f"/api/ingresos/{year}",
            json={"year": year, "months": {"enero": {"rows": [{"nombre": "Extra", "cantidad": "100", "fecha": f"01-01-{year}"}]}}},
            headers=cabeceras,
        )
        assert res.status_code == 200, res.get_json()


@pytest.mark.parametrize("recurso", ["gastos", "ingresos"])
def testCadaAnioCoincideConLaPeticionIndividual(cliente, recurso):
    client, cabeceras = cliente
    _sembrar(client, cabeceras)

    todos = client.get(f"/api/{recurso}/todos").get_json()["years"]
    anios = client.get(f"/api/{recurso}").get_json()["years"]

    assert sorted(todos) == sorted(anios) == ["2024", "2025", "2026"]
    for year in anios:
        assert todos[year] == client.get(f"/api/{recurso}/{year}").get_json()


@pytest.mark.parametrize("recurso", ["gastos", "ingresos"])
def testSinDatosDevuelveUnDiccionarioVacio(cliente, recurso):
    client, _cabeceras = cliente

    res = client.get(f"/api/{recurso}/todos")

    assert res.status_code == 200
    assert res.get_json() == {"years": {}}
