"""Ser de ahorro o remunerada es un papel de una cuenta que ya existe en «Cuentas»."""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp
    from routes.cuenta_ahorro import cuentaAhorroBp
    from routes.cuentas import cuentasBp
    from routes.registros import registrosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = clienteAutenticado(cuentasBp, cuentaAhorroBp, ajustesBp, registrosBp)
    return client, cabeceras


def _cuenta(client, cabeceras, nombre, tipo="banco"):
    res = client.post("/api/cuentas", json={"nombre": nombre, "tipo": tipo}, headers=cabeceras)
    assert res.status_code == 201, res.get_json()
    return res.get_json()["cuenta"]


def _cuentas(client):
    return {c["id"]: c for c in client.get("/api/cuentas").get_json()["cuentas"]}


# ── Cuenta de ahorro ─────────────────────────────────────────────────────────

def testUnaCuentaDeTipoAhorroSaleEnLaVentanaDeAhorro(cliente):
    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Viaje", "ahorro")
    otra = _cuenta(client, cabeceras, "Broker", "broker")

    ids = {c["id"] for c in client.get("/api/cuenta-ahorro").get_json()["cuentas"]}
    assert cuenta["id"] in ids
    assert otra["id"] not in ids
    assert "ahorro" in ids


def testCualquierCuentaExistenteSeEligeComoDeAhorroYSeQuitaSinBorrarla(cliente):
    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Trade Republic", "broker")

    client.put(f"/api/cuentas/{cuenta['id']}", json={"ahorro": True}, headers=cabeceras)
    ids = {c["id"] for c in client.get("/api/cuenta-ahorro").get_json()["cuentas"]}
    assert cuenta["id"] in ids
    assert _cuentas(client)[cuenta["id"]]["tipo"] == "broker"

    client.put(f"/api/cuentas/{cuenta['id']}", json={"ahorro": False}, headers=cabeceras)
    ids = {c["id"] for c in client.get("/api/cuenta-ahorro").get_json()["cuentas"]}
    assert cuenta["id"] not in ids
    assert cuenta["id"] in _cuentas(client)


def testLaCuentaDeAhorroPrincipalNoSeQuita(cliente):
    client, cabeceras = cliente
    res = client.put("/api/cuentas/ahorro", json={"ahorro": False}, headers=cabeceras)
    assert res.status_code == 400
    assert _cuentas(client)["ahorro"]["ahorro"] is True


def testLaMigracionMarcaLasCuentasQueYaEranDeAhorro(tempDb):
    from core import db

    conn = db.getDb()
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, ahorro) VALUES ('ahorro-x', 'X', 'ahorro', 0)")
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, ahorro) VALUES ('exchange-y', 'Y', 'exchange', 0)")
    conn.commit()

    db._esquema16(conn)

    marcadas = {f["id"] for f in conn.execute("SELECT id FROM cuentas WHERE ahorro = 1")}
    assert "ahorro-x" in marcadas
    assert "exchange-y" not in marcadas


# ── Cuenta remunerada ────────────────────────────────────────────────────────

def testUnaRemuneradaSeCreaEligiendoUnaCuentaYTomaSuNombre(cliente):
    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Trade Republic")

    res = client.post(
        "/api/intereses",
        json={"cuentas": [{"id": "r1", "nombre": "lo que sea", "cuenta": cuenta["id"], "rows": []}]},
        headers=cabeceras,
    )
    assert res.get_json()["ok"]

    remunerada = client.get("/api/intereses").get_json()["cuentas"][0]
    assert remunerada["cuenta"] == cuenta["id"]
    assert remunerada["nombre"] == "Trade Republic"
    assert _cuentas(client)[cuenta["id"]]["remunerada"] == "r1"

    # Si la cuenta cambia de nombre, la remunerada también.
    client.put(f"/api/cuentas/{cuenta['id']}", json={"nombre": "TR"}, headers=cabeceras)
    assert client.get("/api/intereses").get_json()["cuentas"][0]["nombre"] == "TR"


def testUnaRemuneradaCambiaDeCuentaPeroNoAUnaQueYaLoEs(cliente):
    client, cabeceras = cliente
    a = _cuenta(client, cabeceras, "A")
    b = _cuenta(client, cabeceras, "B")
    c = _cuenta(client, cabeceras, "C")

    def guardar(*pares):
        return client.post(
            "/api/intereses",
            json={"cuentas": [{"id": rid, "nombre": "", "cuenta": cid, "rows": []} for rid, cid in pares]},
            headers=cabeceras,
        )

    assert guardar(("r1", a["id"]), ("r2", b["id"])).status_code == 200
    assert guardar(("r1", c["id"]), ("r2", b["id"])).status_code == 200
    cuentas = _cuentas(client)
    assert cuentas[a["id"]]["remunerada"] == ""
    assert cuentas[c["id"]]["remunerada"] == "r1"

    res = guardar(("r1", b["id"]), ("r2", b["id"]))
    assert res.status_code == 400
    assert "ya es una cuenta remunerada" in res.get_json()["error"]
    # No se guarda nada a medias.
    assert _cuentas(client)[c["id"]]["remunerada"] == "r1"


def testQuitarUnaRemuneradaNoBorraSuCuenta(cliente):
    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Trade Republic")
    client.post(
        "/api/intereses",
        json={"cuentas": [{"id": "r1", "nombre": "", "cuenta": cuenta["id"], "rows": []}]},
        headers=cabeceras,
    )

    client.post("/api/intereses", json={"cuentas": []}, headers=cabeceras)

    datos = _cuentas(client)[cuenta["id"]]
    assert datos["remunerada"] == ""
