"""Varias etiquetas por cuenta: el tipo es la principal y las demás van aparte."""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.cuentas import cuentasBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(cuentasBp)
    return client, cabeceras


def _cuenta(client, cuentaId):
    return next(c for c in client.get("/api/cuentas").get_json()["cuentas"] if c["id"] == cuentaId)


def testLaMigracion28AnadeLaColumnaSinTocarLasCuentas(tempDb):
    from core import db

    conexion = db.getDb()
    # Una base en el esquema 27: la misma tabla sin la columna. Se reconstruye
    # porque SQLite no deja hacer DROP COLUMN con los comentarios del CREATE.
    conexion.execute("PRAGMA foreign_keys = OFF")
    conexion.executescript(
        "CREATE TABLE cuentas_vieja AS "
        "SELECT id, nombre, tipo, saldo_inicial, sort_order, dividendos, ahorro FROM cuentas;"
        "DROP TABLE cuentas;"
        "ALTER TABLE cuentas_vieja RENAME TO cuentas;"
    )
    conexion.execute("PRAGMA foreign_keys = ON")
    conexion.execute("PRAGMA user_version = 27")
    conexion.commit()

    db._migrate(conexion)

    columnas = {fila[1] for fila in conexion.execute("PRAGMA table_info(cuentas)")}
    assert "etiquetas" in columnas
    assert conexion.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    assert {fila[0] for fila in conexion.execute("SELECT etiquetas FROM cuentas")} == {""}


def testUnaCuentaSinEtiquetasExtraTieneSoloSuTipo(cliente):
    client, _cabeceras = cliente

    banco = _cuenta(client, "banco")

    assert banco["etiquetas"] == ["banco"]
    assert banco["etiquetas_nombres"] == ["Banco"]


def testCrearConEtiquetasExtraLasGuardaTrasLaPrincipalYEnOrden(cliente):
    client, cabeceras = cliente

    res = client.post(
        "/api/cuentas",
        json={"nombre": "Revolut", "tipo": "banco", "etiquetas": ["exchange", "broker", "banco", "broker"]},
        headers=cabeceras,
    )

    assert res.status_code == 201
    cuenta = _cuenta(client, res.get_json()["cuenta"]["id"])
    # La principal no se repite y las extra van en el orden de los tipos.
    assert cuenta["etiquetas"] == ["banco", "exchange", "broker"]
    assert cuenta["etiquetas_nombres"] == ["Banco", "Exchange", "Broker"]


def testEditarCambiaLaPrincipalYLasExtra(cliente):
    client, cabeceras = cliente
    cuentaId = client.post(
        "/api/cuentas", json={"nombre": "Trade Republic", "tipo": "broker"}, headers=cabeceras
    ).get_json()["cuenta"]["id"]

    res = client.put(
        f"/api/cuentas/{cuentaId}", json={"tipo": "ahorro", "etiquetas": ["broker", "banco"]}, headers=cabeceras
    )

    assert res.status_code == 200
    cuenta = _cuenta(client, cuentaId)
    assert cuenta["id"] == cuentaId
    assert cuenta["tipo"] == "ahorro"
    assert cuenta["etiquetas"] == ["ahorro", "banco", "broker"]


def testCambiarSoloLaPrincipalConservaLasExtraSinRepetirla(cliente):
    client, cabeceras = cliente
    cuentaId = client.post(
        "/api/cuentas", json={"nombre": "Bitvavo", "tipo": "exchange", "etiquetas": ["broker"]}, headers=cabeceras
    ).get_json()["cuenta"]["id"]

    client.put(f"/api/cuentas/{cuentaId}", json={"tipo": "broker"}, headers=cabeceras)

    assert _cuenta(client, cuentaId)["etiquetas"] == ["broker"]


def testEditarOtrosCamposNoTocaLasEtiquetas(cliente):
    client, cabeceras = cliente
    cuentaId = client.post(
        "/api/cuentas", json={"nombre": "N26", "tipo": "banco", "etiquetas": ["ahorro"]}, headers=cabeceras
    ).get_json()["cuenta"]["id"]

    client.put(f"/api/cuentas/{cuentaId}", json={"nombre": "N26 nueva"}, headers=cabeceras)

    assert _cuenta(client, cuentaId)["etiquetas"] == ["banco", "ahorro"]


@pytest.mark.parametrize("etiquetas", [["inventada"], "broker", [None]])
def testEtiquetasNoValidasSeRechazan(cliente, etiquetas):
    client, cabeceras = cliente

    res = client.post(
        "/api/cuentas", json={"nombre": "Mala", "tipo": "banco", "etiquetas": etiquetas}, headers=cabeceras
    )

    assert res.status_code == 400


def testUnValorGuardadoIlegibleNoRompeLaLectura(cliente, tempDb):
    from core.db import getDb

    client, _cabeceras = cliente
    conexion = getDb()
    conexion.execute("""UPDATE cuentas SET etiquetas = '{no es json' WHERE id = 'banco'""")
    conexion.execute("""UPDATE cuentas SET etiquetas = '["broker", "borrado"]' WHERE id = 'ahorro'""")
    conexion.commit()

    assert _cuenta(client, "banco")["etiquetas"] == ["banco"]
    assert _cuenta(client, "ahorro")["etiquetas"] == ["ahorro", "broker"]
