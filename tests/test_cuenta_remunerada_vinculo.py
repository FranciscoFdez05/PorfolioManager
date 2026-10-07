"""Vínculo entre cada cuenta de dinero y su cuenta remunerada: uno por cada lado."""

import json

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


def _remuneradas(*pares):
    from stores.app_data import writeInteresesFile

    writeInteresesFile({"cuentas": [{"id": rid, "nombre": nombre, "rows": []} for rid, nombre in pares]})


def _cuenta(client, cabeceras, nombre, tipo="banco", **extra):
    res = client.post("/api/cuentas", json={"nombre": nombre, "tipo": tipo, **extra}, headers=cabeceras)
    assert res.status_code == 201, res.get_json()
    return res.get_json()["cuenta"]


def _cuentas(client):
    return {c["id"]: c for c in client.get("/api/cuentas").get_json()["cuentas"]}


@pytest.mark.parametrize("tipo", ["banco", "ahorro", "exchange", "broker", "metalico"])
def test_cualquier_tipo_de_cuenta_se_vincula_al_crearla(cliente, tipo):
    client, cabeceras = cliente
    _remuneradas(("tr", "Trade Republic"))

    cuenta = _cuenta(client, cabeceras, "Trade Republic", tipo, remunerada="tr")

    assert cuenta["remunerada"] == "tr"
    assert _cuentas(client)[cuenta["id"]]["remunerada_nombre"] == "Trade Republic"


def test_editar_cambia_y_quita_el_vinculo(cliente):
    client, cabeceras = cliente
    _remuneradas(("tr", "Trade Republic"), ("mi", "MyInvestor"))
    cuenta = _cuenta(client, cabeceras, "Revolut")

    client.put(f"/api/cuentas/{cuenta['id']}", json={"remunerada": "tr"}, headers=cabeceras)
    client.put(f"/api/cuentas/{cuenta['id']}", json={"remunerada": "mi"}, headers=cabeceras)
    assert _cuentas(client)[cuenta["id"]]["remunerada"] == "mi"

    # Sin el campo, el vínculo se queda como está.
    client.put(f"/api/cuentas/{cuenta['id']}", json={"nombre": "Revolut 2"}, headers=cabeceras)
    assert _cuentas(client)[cuenta["id"]]["remunerada"] == "mi"

    client.put(f"/api/cuentas/{cuenta['id']}", json={"remunerada": ""}, headers=cabeceras)
    assert _cuentas(client)[cuenta["id"]]["remunerada"] == ""


def test_una_remunerada_no_puede_estar_en_dos_cuentas(cliente):
    client, cabeceras = cliente
    _remuneradas(("tr", "Trade Republic"))
    _cuenta(client, cabeceras, "Trade Republic", "ahorro", remunerada="tr")
    otra = _cuenta(client, cabeceras, "Revolut")

    res = client.put(f"/api/cuentas/{otra['id']}", json={"remunerada": "tr"}, headers=cabeceras)

    assert res.status_code == 400
    assert "ya está vinculada" in res.get_json()["error"]
    assert _cuentas(client)[otra["id"]]["remunerada"] == ""


def test_una_cuenta_tiene_como_mucho_una_remunerada(temp_db):
    import sqlite3

    from core.db import get_db

    _remuneradas(("tr", "Trade Republic"), ("mi", "MyInvestor"))
    conn = get_db()
    conn.execute("INSERT INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) VALUES ('tr', 'banco')")
    with pytest.raises(sqlite3.IntegrityError):
        conn.execute("INSERT INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) VALUES ('mi', 'banco')")
    conn.rollback()


def test_crear_con_una_remunerada_que_no_existe_no_crea_la_cuenta(cliente):
    client, cabeceras = cliente

    res = client.post("/api/cuentas", json={"nombre": "X", "tipo": "banco", "remunerada": "nada"}, headers=cabeceras)

    assert res.status_code == 400
    assert all(c["nombre"] != "X" for c in _cuentas(client).values())


def test_guardar_las_remuneradas_no_deshace_el_vinculo(cliente):
    client, cabeceras = cliente
    _remuneradas(("tr", "Trade Republic"))
    cuenta = _cuenta(client, cabeceras, "TR", remunerada="tr")

    # Lo que hace la ventana Cuenta Remunerada al añadir una fila o renombrar.
    _remuneradas(("tr", "Trade Republic (nuevo)"))

    assert _cuentas(client)[cuenta["id"]]["remunerada_nombre"] == "Trade Republic (nuevo)"


def test_borrar_la_remunerada_o_la_cuenta_deshace_el_vinculo(cliente):
    from core.db import get_db

    client, cabeceras = cliente
    _remuneradas(("tr", "Trade Republic"), ("mi", "MyInvestor"))
    cuenta = _cuenta(client, cabeceras, "TR", remunerada="tr")
    otra = _cuenta(client, cabeceras, "MI", remunerada="mi")

    _remuneradas(("mi", "MyInvestor"))
    assert _cuentas(client)[cuenta["id"]]["remunerada"] == ""

    client.delete(f"/api/cuentas/{otra['id']}", headers=cabeceras)
    assert get_db().execute("SELECT COUNT(*) FROM cuenta_remunerada_vinculo").fetchone()[0] == 0


def test_los_vinculos_de_la_configuracion_antigua_pasan_a_la_base(cliente):
    from routes.ajustes import _active_portfolio_id, _read_prefs, _write_prefs

    client, cabeceras = cliente
    _remuneradas(("tr", "Trade Republic"), ("mi", "MyInvestor"))
    pid = _active_portfolio_id()
    prefs = _read_prefs(pid)
    prefs["cuentaAhorroConfig"] = {"cuentas": [{"nombre": "", "remuneradas": ["tr", "mi"], "incluirDividendos": True}]}
    _write_prefs(pid, prefs)

    cuentas = _cuentas(client)

    # La cuenta de ahorro principal se queda con la primera; la otra queda libre.
    # Los dividendos también pasan a ser de la cuenta.
    assert cuentas["ahorro"]["remunerada"] == "tr"
    assert cuentas["ahorro"]["dividendos"] is True
    guardada = _read_prefs(pid)["cuentaAhorroConfig"]["cuentas"][0]
    assert "remuneradas" not in guardada
    assert "incluirDividendos" not in guardada

    # Tampoco vuelven los dividendos si se quitan a mano.
    client.put("/api/cuentas/ahorro", json={"dividendos": False}, headers=cabeceras)
    assert _cuentas(client)["ahorro"]["dividendos"] is False

    # Ya no vuelve: quitarlo a mano se respeta.
    client.put("/api/cuentas/ahorro", json={"remunerada": ""}, headers=cabeceras)
    assert _cuentas(client)["ahorro"]["remunerada"] == ""
    assert json.dumps(client.get("/api/cuenta-ahorro").get_json()["cuentas"]).count('"remunerada": "tr"') == 0


def _intereses(cuenta_id, nombre, *filas):
    from stores.app_data import writeInteresesFile

    writeInteresesFile({"cuentas": [{
        "id": cuenta_id, "nombre": nombre,
        "rows": [{"fecha": f, "acumulado": a, "impuestos": i} for f, a, i in filas],
    }]})


def _dividendos(*filas):
    from core.db import get_db

    conn = get_db()
    for fecha, total, moneda in filas:
        conn.execute(
            "INSERT INTO dividendos (fecha, instrumento, total, moneda_total) VALUES (?, 'X', ?, ?)",
            (fecha, total, moneda),
        )
    conn.commit()


def test_los_intereses_de_la_remunerada_entran_en_el_saldo(cliente):
    client, cabeceras = cliente
    _intereses("tr", "Trade Republic", ("15-01-2026", "1,50", "0,18"), ("2026-02-28", "2", "0"),
               ("15-12-2099", "100", "0"))
    cuenta = _cuenta(client, cabeceras, "Trade Republic", "ahorro", remunerada="tr", saldoInicial="50")

    datos = _cuentas(client)[cuenta["id"]]

    # Netos de impuestos y sin los que todavía no han llegado.
    assert datos["intereses"] == "3.32"
    assert datos["saldo"] == "53.32"
    assert datos["dividendos_cobrados"] == "0.00"


def test_los_dividendos_entran_en_la_cuenta_que_los_cobra(cliente):
    client, cabeceras = cliente
    _dividendos(("10-03-2026", "6,76", "EUR"), ("01-01-2099", "50", "EUR"))
    cuenta = _cuenta(client, cabeceras, "Broker", "broker", dividendos=True)
    otra = _cuenta(client, cabeceras, "Banco 2")

    cuentas = _cuentas(client)
    assert cuentas[cuenta["id"]]["dividendos"] is True
    assert cuentas[cuenta["id"]]["dividendos_cobrados"] == "6.76"
    assert cuentas[cuenta["id"]]["saldo"] == "6.76"
    assert cuentas[otra["id"]]["saldo"] == "0.00"

    # Pueden cobrarlos varias, pero cada dividendo va a una sola: los que no
    # traen cuenta, a la primera marcada, así que no se suman dos veces.
    res = client.put(f"/api/cuentas/{otra['id']}", json={"dividendos": True}, headers=cabeceras)
    assert res.status_code == 200
    cuentas = _cuentas(client)
    assert cuentas[cuenta["id"]]["saldo"] == "6.76"
    assert cuentas[otra["id"]]["saldo"] == "0.00"

    client.put(f"/api/cuentas/{cuenta['id']}", json={"dividendos": False}, headers=cabeceras)
    cuentas = _cuentas(client)
    assert cuentas[cuenta["id"]]["saldo"] == "0.00"
    assert cuentas[otra["id"]]["saldo"] == "6.76"


def test_los_dividendos_en_otra_divisa_se_pasan_a_euros(temp_db):
    import datetime

    from core.db import get_db
    from stores.cuentas_store import crear_cuenta, saldos

    _dividendos(("10-03-2026", "10", "USD"), ("11-03-2026", "1", "EUR"))
    cuenta = crear_cuenta("Broker", "broker", dividendos=True)

    def a_euros(importe, moneda):
        return importe * (2 if moneda == "USD" else 1)

    datos = saldos(get_db(), hoy=datetime.date(2026, 10, 7), a_euros=a_euros)[cuenta["id"]]
    assert float(datos["dividendos"]) == 21


def test_cada_dividendo_va_a_su_cuenta_y_los_sin_cuenta_a_la_que_los_cobra(cliente):
    client, cabeceras = cliente
    cobra = _cuenta(client, cabeceras, "Broker", "broker", dividendos=True)
    otra = _cuenta(client, cabeceras, "Banco 2")
    filas = [
        {"fecha": "10-03-2026", "instrumento": "A", "total": "5,00", "monedaTotal": "EUR", "cuenta": otra["id"]},
        {"fecha": "11-03-2026", "instrumento": "B", "total": "2,00", "monedaTotal": "EUR"},
        {"fecha": "12-03-2026", "instrumento": "C", "total": "1,00", "monedaTotal": "EUR", "cuenta": "no-existe"},
    ]
    assert client.post("/api/dividendos", json={"rows": filas}, headers=cabeceras).status_code == 200

    rows = client.get("/api/dividendos").get_json()["rows"]
    assert [r["cuenta"] for r in rows] == [otra["id"], "", ""]

    cuentas = _cuentas(client)
    assert cuentas[otra["id"]]["dividendos_cobrados"] == "5.00"
    assert cuentas[cobra["id"]]["dividendos_cobrados"] == "3.00"


def test_no_se_borra_una_cuenta_con_dividendos_apuntados(cliente):
    from core.db import get_db

    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Broker", "broker")
    _dividendos(("10-03-2026", "6,76", "EUR"))
    conn = get_db()
    conn.execute("UPDATE dividendos SET cuenta = ?", (cuenta["id"],))
    conn.commit()

    res = client.delete(f"/api/cuentas/{cuenta['id']}", headers=cabeceras)
    assert res.status_code == 409

    conn.execute("UPDATE dividendos SET cuenta = ''")
    conn.commit()
    assert client.delete(f"/api/cuentas/{cuenta['id']}", headers=cabeceras).status_code == 200
