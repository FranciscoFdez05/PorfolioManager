"""Ser de ahorro o remunerada es un papel de una cuenta que ya existe en «Cuentas»."""

import pytest


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.ajustes import ajustes_bp
    from routes.cuenta_ahorro import cuenta_ahorro_bp
    from routes.cuentas import cuentas_bp
    from routes.registros import registros_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = cliente_autenticado(cuentas_bp, cuenta_ahorro_bp, ajustes_bp, registros_bp)
    return client, cabeceras


def _cuenta(client, cabeceras, nombre, tipo="banco"):
    res = client.post("/api/cuentas", json={"nombre": nombre, "tipo": tipo}, headers=cabeceras)
    assert res.status_code == 201, res.get_json()
    return res.get_json()["cuenta"]


def _cuentas(client):
    return {c["id"]: c for c in client.get("/api/cuentas").get_json()["cuentas"]}


# ── Cuenta de ahorro ─────────────────────────────────────────────────────────

def test_una_cuenta_de_tipo_ahorro_sale_en_la_ventana_de_ahorro(cliente):
    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Viaje", "ahorro")
    otra = _cuenta(client, cabeceras, "Broker", "broker")

    ids = {c["id"] for c in client.get("/api/cuenta-ahorro").get_json()["cuentas"]}
    assert cuenta["id"] in ids
    assert otra["id"] not in ids
    assert "ahorro" in ids


def test_cualquier_cuenta_existente_se_elige_como_de_ahorro_y_se_quita_sin_borrarla(cliente):
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


def test_la_cuenta_de_ahorro_principal_no_se_quita(cliente):
    client, cabeceras = cliente
    res = client.put("/api/cuentas/ahorro", json={"ahorro": False}, headers=cabeceras)
    assert res.status_code == 400
    assert _cuentas(client)["ahorro"]["ahorro"] is True


def test_la_migracion_marca_las_cuentas_que_ya_eran_de_ahorro(temp_db):
    from core import db

    conn = db.get_db()
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, ahorro) VALUES ('ahorro-x', 'X', 'ahorro', 0)")
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, ahorro) VALUES ('exchange-y', 'Y', 'exchange', 0)")
    conn.commit()

    db._esquema_16(conn)

    marcadas = {f["id"] for f in conn.execute("SELECT id FROM cuentas WHERE ahorro = 1")}
    assert "ahorro-x" in marcadas
    assert "exchange-y" not in marcadas


# ── Cuenta remunerada ────────────────────────────────────────────────────────

def test_una_remunerada_se_crea_eligiendo_una_cuenta_y_toma_su_nombre(cliente):
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


def test_una_remunerada_cambia_de_cuenta_pero_no_a_una_que_ya_lo_es(cliente):
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


def test_quitar_una_remunerada_no_borra_su_cuenta(cliente):
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
