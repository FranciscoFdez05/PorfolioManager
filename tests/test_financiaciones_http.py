"""Pruebas de /api/financiaciones: validación, guardado y cálculo adjunto."""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.financiaciones import financiacionesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(financiacionesBp)
    return client, cabeceras


def _compra(**cambios):
    datos = {"articulo": "Portátil", "precio": "1200", "entrada": "0", "cuotas": 12,
             "tin": "0", "fechaInicio": "2020-01-01"}
    datos.update(cambios)
    return datos


def _guardar(client, cabeceras, *filas):
    return client.post("/api/financiaciones", json={"rows": list(filas)}, headers=cabeceras)


def testSinComprasDevuelveListaVacia(cliente):
    client, _ = cliente
    assert client.get("/api/financiaciones").get_json() == {"rows": []}


def testSinInteresesLaCuotaEsElPrecioEntreCuotas(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _compra()).status_code == 200
    fila = client.get("/api/financiaciones").get_json()["rows"][0]
    resumen = fila["calculo"]["resumen"]
    assert resumen["cuotaActual"] == 100.0
    assert resumen["interesesTotales"] == 0
    assert resumen["sinIntereses"] is True
    assert resumen["liquidado"] is True
    assert resumen["totalAPagar"] == 1200.0


def testConEntradaFinanciaSoloLaDiferencia(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _compra(entrada="200"))
    resumen = client.get("/api/financiaciones").get_json()["rows"][0]["calculo"]["resumen"]
    assert resumen["financiado"] == 1000.0
    assert resumen["totalAPagar"] == 1200.0


def testConInteresesElTotalSuperaElPrecio(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _compra(tin="12", fechaInicio="2999-01-01"))
    resumen = client.get("/api/financiaciones").get_json()["rows"][0]["calculo"]["resumen"]
    assert resumen["interesesTotales"] > 0
    assert resumen["totalAPagar"] > 1200
    assert resumen["cuotasPagadas"] == 0
    assert resumen["cuotasRestantes"] == 12
    assert resumen["progreso"] == 0


def testEntradaIgualOMayorQueElPrecioSeRechaza(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _compra(entrada="1200")).status_code == 400
    assert _guardar(client, cabeceras, _compra(entrada="1500")).status_code == 400


def testCuotasFueraDeRangoSeRechazan(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _compra(cuotas=0)).status_code == 400
    assert _guardar(client, cabeceras, _compra(cuotas=999)).status_code == 400


def testPrecioNegativoOFechaInvalidaSeRechazan(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _compra(precio="-3")).status_code == 400
    assert _guardar(client, cabeceras, _compra(fechaInicio="ayer")).status_code == 400


def testGuardarSustituyeElListado(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _compra(), _compra(articulo="Otra"))
    _guardar(client, cabeceras, _compra(articulo="Sola"))
    filas = client.get("/api/financiaciones").get_json()["rows"]
    assert [f["articulo"] for f in filas] == ["Sola"]
