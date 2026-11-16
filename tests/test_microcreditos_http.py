"""Pruebas de /api/microcreditos: validación, guardado y cálculo adjunto."""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.microcreditos import microcreditosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(microcreditosBp)
    return client, cabeceras


def _credito(**cambios):
    datos = {"nombre": "Rapido", "modo": "unico", "importe": "300", "comision": "45",
             "fechaInicio": "2020-01-01", "fechaVencimiento": "2020-01-31"}
    datos.update(cambios)
    return datos


def _guardar(client, cabeceras, *filas):
    return client.post("/api/microcreditos", json={"rows": list(filas)}, headers=cabeceras)


def testSinMicrocreditosDevuelveListaVacia(cliente):
    client, _ = cliente
    assert client.get("/api/microcreditos").get_json() == {"rows": []}


def testGuardaYDevuelveConCalculoYId(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, _credito())
    assert respuesta.status_code == 200
    fila = client.get("/api/microcreditos").get_json()["rows"][0]
    assert fila["id"]
    assert fila["calculo"]["resumen"]["estado"] == "vencido"
    assert fila["calculo"]["resumen"]["totalAPagar"] == 345.0


def testMarcarDevueltoSePersiste(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _credito(devuelto=True, fechaDevolucion="2020-01-20"))
    fila = client.get("/api/microcreditos").get_json()["rows"][0]
    assert fila["devuelto"] is True
    assert fila["fechaDevolucion"] == "2020-01-20"
    assert fila["calculo"]["resumen"]["estado"] == "devuelto"


def testModoCuotasDevuelveCuadro(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _credito(modo="cuotas", cuotas=6, tin="0", importe="600"))
    calculo = client.get("/api/microcreditos").get_json()["rows"][0]["calculo"]
    assert len(calculo["cuadro"]) == 6
    assert calculo["resumen"]["cuotaMensual"] == 100.0


def testGuardarSustituyeElListado(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _credito(), _credito(nombre="Otro"))
    _guardar(client, cabeceras, _credito(nombre="Solo uno"))
    filas = client.get("/api/microcreditos").get_json()["rows"]
    assert [f["nombre"] for f in filas] == ["Solo uno"]


@pytest.mark.parametrize("cambios", [{"importe": "0"}, {"nombre": ""}, {"fechaVencimiento": "2019-01-01"}])
def testDatosInvalidosDan400(cliente, cambios):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _credito(**cambios)).status_code == 400
    assert client.get("/api/microcreditos").get_json() == {"rows": []}


def testIdRepetidoDa400(cliente):
    client, cabeceras = cliente
    assert _guardar(client, cabeceras, _credito(id="a"), _credito(id="a")).status_code == 400


def testListaNoValidaDa400(cliente):
    client, cabeceras = cliente
    respuesta = client.post("/api/microcreditos", json={"rows": "x"}, headers=cabeceras)
    assert respuesta.status_code == 400


def testLaMigracion33CreaLaTablaEnUnaBaseDelEsquema32(tempDb):
    from core import db

    conexion = db.getDb()
    conexion.execute("DROP TABLE microcreditos")
    conexion.execute("PRAGMA user_version = 32")
    conexion.commit()

    db._migrate(conexion)

    tablas = {fila[0] for fila in conexion.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "microcreditos" in tablas
    assert conexion.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
