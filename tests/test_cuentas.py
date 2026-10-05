"""Cuentas de dinero y transferencias: lo que mueve cada saldo y lo que no es un gasto."""

import datetime

import pytest

HOY = datetime.date(2026, 10, 5)


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.ajustes import ajustes_bp
    from routes.cuenta_ahorro import cuenta_ahorro_bp
    from routes.cuentas import cuentas_bp
    from routes.gastos import gastos_bp
    from routes.ingresos import ingresos_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = cliente_autenticado(cuentas_bp, cuenta_ahorro_bp, gastos_bp, ingresos_bp, ajustes_bp)
    return client, cabeceras


def _cuenta(client, cabeceras, nombre, tipo="exchange", **extra):
    res = client.post("/api/cuentas", json={"nombre": nombre, "tipo": tipo, **extra}, headers=cabeceras)
    assert res.status_code == 201, res.get_json()
    return res.get_json()["cuenta"]


def _transferir(client, cabeceras, origen, destino, cantidad, fecha="10-03-2026", **extra):
    return client.post(
        "/api/transferencias",
        json={"origen": origen, "destino": destino, "cantidad": cantidad, "fecha": fecha, **extra},
        headers=cabeceras,
    )


def _saldo(client, cuenta_id):
    cuentas = client.get("/api/cuentas").get_json()["cuentas"]
    return float(next(c for c in cuentas if c["id"] == cuenta_id)["saldo"])


def _guardar_gastos(client, cabeceras, filas, year="2026", mes="marzo"):
    client.post(
        f"/api/gastos/{year}",
        json={"year": year, "months": {mes: {"rows": filas}}},
        headers=cabeceras,
    )


# ── Cuentas ──────────────────────────────────────────────────────────────────

def test_siempre_existen_la_cuenta_bancaria_y_la_de_ahorro(cliente):
    client, _cabeceras = cliente

    cuentas = client.get("/api/cuentas").get_json()["cuentas"]

    assert [(c["id"], c["tipo"]) for c in cuentas[:2]] == [("banco", "banco"), ("ahorro", "ahorro")]
    assert all(c["protegida"] for c in cuentas[:2])


def test_se_pueden_crear_cuentas_de_cada_tipo(cliente):
    client, cabeceras = cliente

    for nombre, tipo in (
        ("Binance", "exchange"),
        ("Degiro", "broker"),
        ("BBVA", "banco"),
        ("Viaje", "ahorro"),
        ("Cartera", "metalico"),
    ):
        cuenta = _cuenta(client, cabeceras, nombre, tipo)
        assert cuenta["tipo"] == tipo

    nombres = [c["nombre"] for c in client.get("/api/cuentas").get_json()["cuentas"]]
    assert nombres == ["Cuenta bancaria", "Cuenta de ahorro", "Binance", "Degiro", "BBVA", "Viaje", "Cartera"]
    assert next(c for c in client.get("/api/cuentas").get_json()["cuentas"] if c["nombre"] == "Cartera")["tipo_etiqueta"] == "Metálico"


@pytest.mark.parametrize(
    "cuerpo",
    [
        {"nombre": "", "tipo": "exchange"},
        {"nombre": "X", "tipo": "otro"},
        {"nombre": "Cuenta bancaria", "tipo": "exchange"},
        {"nombre": "banco", "tipo": "exchange"},
        {"nombre": "Binance", "tipo": "exchange", "saldoInicial": "abc"},
    ],
)
def test_las_cuentas_invalidas_se_rechazan(cliente, cuerpo):
    client, cabeceras = cliente
    _cuenta(client, cabeceras, "Binance")

    assert client.post("/api/cuentas", json=cuerpo, headers=cabeceras).status_code == 400


def test_el_nombre_no_se_repite_aunque_cambien_las_mayusculas(cliente):
    client, cabeceras = cliente
    _cuenta(client, cabeceras, "Binance")

    assert client.post("/api/cuentas", json={"nombre": "BINANCE", "tipo": "broker"}, headers=cabeceras).status_code == 400


def test_renombrar_y_poner_saldo_inicial(cliente):
    client, cabeceras = cliente
    cuenta = _cuenta(client, cabeceras, "Binance")

    res = client.put(
        f"/api/cuentas/{cuenta['id']}", json={"nombre": "Kraken", "saldoInicial": "1.500,50"}, headers=cabeceras
    )

    assert res.status_code == 200
    assert res.get_json()["cuenta"]["nombre"] == "Kraken"
    assert _saldo(client, cuenta["id"]) == 1500.50


def test_la_cuenta_bancaria_se_puede_renombrar_pero_no_eliminar(cliente):
    client, cabeceras = cliente

    res = client.put("/api/cuentas/banco", json={"nombre": "BBVA nómina"}, headers=cabeceras)

    assert res.status_code == 200
    assert client.get("/api/cuentas").get_json()["cuentas"][0]["nombre"] == "BBVA nómina"
    assert client.delete("/api/cuentas/banco", headers=cabeceras).status_code == 400
    assert client.delete("/api/cuentas/ahorro", headers=cabeceras).status_code == 400


def test_la_cuenta_bancaria_puede_volver_a_llamarse_como_al_principio(cliente):
    client, cabeceras = cliente
    client.put("/api/cuentas/banco", json={"nombre": "BBVA"}, headers=cabeceras)

    res = client.put("/api/cuentas/banco", json={"nombre": "Cuenta bancaria"}, headers=cabeceras)

    assert res.status_code == 200


def test_la_cuenta_bancaria_renombrada_sigue_siendo_la_de_las_filas_sin_cuenta(cliente):
    client, cabeceras = cliente
    client.put("/api/cuentas/banco", json={"nombre": "BBVA"}, headers=cabeceras)
    _guardar_gastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Cena", "tipo": "Comida", "cantidad": "30,00 €"},
    ])

    assert _saldo(client, "banco") == -30


def test_ninguna_otra_cuenta_puede_llamarse_como_los_alias_de_la_bancaria(cliente):
    client, cabeceras = cliente
    client.put("/api/cuentas/banco", json={"nombre": "BBVA"}, headers=cabeceras)

    assert client.post("/api/cuentas", json={"nombre": "Banco", "tipo": "exchange"}, headers=cabeceras).status_code == 400
    assert client.post("/api/cuentas", json={"nombre": "BBVA", "tipo": "exchange"}, headers=cabeceras).status_code == 400


def test_una_cuenta_con_movimientos_no_se_elimina(cliente):
    client, cabeceras = cliente
    usada = _cuenta(client, cabeceras, "Binance")
    vacia = _cuenta(client, cabeceras, "Vacía", "broker")
    _transferir(client, cabeceras, "banco", usada["id"], "100")

    assert client.delete(f"/api/cuentas/{usada['id']}", headers=cabeceras).status_code == 409
    assert client.delete(f"/api/cuentas/{vacia['id']}", headers=cabeceras).status_code == 200


# ── Transferencias ───────────────────────────────────────────────────────────

def test_una_transferencia_mueve_el_saldo_de_las_dos_cuentas(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")

    res = _transferir(client, cabeceras, "banco", exchange["id"], "250,50", concepto="Compra de cripto")

    assert res.status_code == 201
    assert _saldo(client, exchange["id"]) == 250.50
    assert _saldo(client, "banco") == -250.50


def test_una_transferencia_no_es_un_gasto_ni_un_ingreso(cliente):
    client, cabeceras = cliente
    _transferir(client, cabeceras, "banco", "ahorro", "1000")

    assert client.get("/api/gastos").get_json()["years"] == ["2026"]  # solo el año por defecto
    assert client.get("/api/gastos/2026").get_json()["months"]["marzo"]["rows"] == []
    assert client.get("/api/ingresos/2026").get_json()["months"]["marzo"]["rows"] == []


@pytest.mark.parametrize(
    "cuerpo",
    [
        {"origen": "banco", "destino": "banco", "cantidad": "5"},
        {"origen": "banco", "destino": "nadie", "cantidad": "5"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "0"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "-3"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "abc"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "5", "fecha": "31-02-2026"},
        {"origen": "banco", "destino": "ahorro", "cantidad": "5", "fecha": "ayer"},
    ],
)
def test_las_transferencias_invalidas_se_rechazan(cliente, cuerpo):
    client, cabeceras = cliente

    assert client.post("/api/transferencias", json=cuerpo, headers=cabeceras).status_code == 400
    assert client.get("/api/transferencias").get_json()["transferencias"] == []


def test_editar_y_eliminar_una_transferencia(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    t = _transferir(client, cabeceras, "banco", exchange["id"], "100").get_json()["transferencia"]

    res = client.put(
        f"/api/transferencias/{t['id']}",
        json={"origen": exchange["id"], "destino": "banco", "cantidad": "40", "fecha": "11-03-2026"},
        headers=cabeceras,
    )

    assert res.status_code == 200
    assert _saldo(client, exchange["id"]) == -40
    assert client.delete(f"/api/transferencias/{t['id']}", headers=cabeceras).status_code == 200
    assert _saldo(client, exchange["id"]) == 0
    assert client.delete(f"/api/transferencias/{t['id']}", headers=cabeceras).status_code == 404
    assert client.put(f"/api/transferencias/{t['id']}", json={}, headers=cabeceras).status_code in (400, 404)


# ── Gastos e ingresos con cuenta ─────────────────────────────────────────────

def test_un_gasto_pagado_con_ahorro_baja_ese_saldo_y_no_el_del_banco(cliente):
    client, cabeceras = cliente
    _transferir(client, cabeceras, "banco", "ahorro", "500")
    _guardar_gastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Nevera", "tipo": "Casa", "cantidad": "120,00 €", "cuenta": "ahorro"},
        {"fecha": "13-03-2026", "nombre": "Cena", "tipo": "Comida", "cantidad": "30,00 €"},
    ])

    assert _saldo(client, "ahorro") == 500 - 120
    assert _saldo(client, "banco") == -500 - 30


def test_el_gasto_pagado_con_ahorro_sigue_siendo_un_gasto_de_su_categoria(cliente):
    client, cabeceras = cliente
    _guardar_gastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Nevera", "tipo": "Casa", "cantidad": "120,00 €", "cuenta": "ahorro"},
    ])

    fila = client.get("/api/gastos/2026").get_json()["months"]["marzo"]["rows"][0]

    assert (fila["tipo"], fila["cuenta"]) == ("Casa", "ahorro")


def test_un_ingreso_cobrado_en_ahorro_sube_ese_saldo(cliente):
    client, cabeceras = cliente
    client.post(
        "/api/ingresos/2026",
        json={"year": "2026", "months": {"marzo": {"rows": [
            {"fecha": "01-03-2026", "nombre": "Intereses", "tipo": "Otros", "cantidad": "10,00 €", "cuenta": "ahorro"}
        ]}}},
        headers=cabeceras,
    )

    assert _saldo(client, "ahorro") == 10
    assert _saldo(client, "banco") == 0


def test_una_cuenta_desconocida_en_una_fila_vuelve_a_la_bancaria(cliente):
    client, cabeceras = cliente
    _guardar_gastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "x", "tipo": "Casa", "cantidad": "10,00 €", "cuenta": "fantasma"},
    ])

    assert client.get("/api/gastos/2026").get_json()["months"]["marzo"]["rows"][0]["cuenta"] == ""


def test_una_cuenta_con_gastos_pagados_no_se_elimina(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    _guardar_gastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "x", "tipo": "Casa", "cantidad": "10,00 €", "cuenta": exchange["id"]},
    ])

    assert client.delete(f"/api/cuentas/{exchange['id']}", headers=cabeceras).status_code == 409


# ── Saldos ───────────────────────────────────────────────────────────────────

def test_el_saldo_cuenta_las_mensualidades_y_recurrentes_hasta_el_mes_actual(temp_db):
    from core.db import get_db
    from stores.cuentas_store import saldos

    conn = get_db()
    conn.execute("INSERT INTO mensualidades (year, nombre, enero, febrero, diciembre) VALUES ('2026', 'Gym', '30,00', '30,00', '30,00')")
    conn.execute("INSERT INTO ingresos_recurrentes (year, nombre, enero, diciembre) VALUES ('2026', 'Nómina', '1.000,00', '1.000,00')")
    conn.commit()

    banco = saldos(conn, hoy=HOY)["banco"]

    # Diciembre todavía no ha llegado: no es dinero que ya esté en la cuenta.
    assert float(banco["salidas"]) == 60
    assert float(banco["entradas"]) == 1000
    assert float(banco["saldo"]) == 940


def test_las_filas_futuras_no_mueven_el_saldo_todavia(temp_db):
    from core.db import get_db
    from stores.cuentas_store import crear_transferencia, saldos

    crear_transferencia("banco", "ahorro", "10-12-2026", "100")
    crear_transferencia("banco", "ahorro", "10-03-2026", "40")

    assert float(saldos(get_db(), hoy=HOY)["ahorro"]["saldo"]) == 40
    assert float(saldos(get_db(), hoy=datetime.date(2026, 12, 20))["ahorro"]["saldo"]) == 140


# ── Ventana de ahorro ────────────────────────────────────────────────────────

def test_los_movimientos_de_ahorro_son_transferencias_ingresos_y_gastos_de_esa_cuenta(cliente):
    client, cabeceras = cliente
    _transferir(client, cabeceras, "banco", "ahorro", "500", concepto="Aportación")
    _transferir(client, cabeceras, "ahorro", "banco", "50", fecha="11-03-2026")
    _guardar_gastos(client, cabeceras, [
        {"fecha": "12-03-2026", "nombre": "Nevera", "tipo": "Casa", "cantidad": "120,00 €", "cuenta": "ahorro"},
    ])

    datos = client.get("/api/cuenta-ahorro").get_json()

    assert [c["id"] for c in datos["cuentas"]] == ["ahorro"]
    assert [(m["origen"], m["kind"], m["cantidad"]) for m in datos["movimientos"]] == [
        ("transferencia", "entrada", "500,00 €"),
        ("transferencia", "salida", "50,00 €"),
        ("gasto", "salida", "120,00 €"),
    ]
    assert datos["movimientos"][0]["contraparte"] == "Cuenta bancaria"


def test_cada_cuenta_de_ahorro_solo_ve_lo_suyo(cliente):
    client, cabeceras = cliente
    viaje = _cuenta(client, cabeceras, "Viaje", "ahorro")
    _transferir(client, cabeceras, "banco", viaje["id"], "70")
    _transferir(client, cabeceras, "banco", "ahorro", "20")

    movs = client.get("/api/cuenta-ahorro").get_json()["movimientos"]

    assert sorted((m["cuenta"], m["cantidad"]) for m in movs) == [("ahorro", "20,00 €"), (viaje["id"], "70,00 €")]


def test_las_cuentas_que_no_son_de_ahorro_no_salen_en_su_ventana(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    _transferir(client, cabeceras, "banco", exchange["id"], "70")

    datos = client.get("/api/cuenta-ahorro").get_json()

    assert [c["id"] for c in datos["cuentas"]] == ["ahorro"]
    assert datos["movimientos"] == []


def test_renombrar_una_cuenta_de_ahorro_mueve_su_configuracion(cliente):
    client, cabeceras = cliente
    viaje = _cuenta(client, cabeceras, "Viaje", "ahorro")
    client.post(
        "/api/settings",
        json={"cuentaAhorroConfig": {"cuentas": [{"nombre": "Viaje", "objetivo": "1000"}]}},
        headers=cabeceras,
    )

    client.put(f"/api/cuentas/{viaje['id']}", json={"nombre": "Vacaciones"}, headers=cabeceras)

    cuentas = client.get("/api/settings").get_json()["cuentaAhorroConfig"]["cuentas"]
    assert {c["nombre"]: c["objetivo"] for c in cuentas}["Vacaciones"] == "1000.00"


# ── Categorías ───────────────────────────────────────────────────────────────

def test_ya_no_hay_categorias_reservadas(cliente):
    client, _cabeceras = cliente

    assert client.get("/api/gastos-tipos").get_json()["types"] == []
    assert client.get("/api/ingresos-tipos").get_json()["types"] == []


def test_leer_las_cuentas_y_los_saldos_no_deja_una_transaccion_abierta(temp_db):
    """Una lectura que escribiera dejaría la base bloqueada para los demás hilos."""
    from core.db import get_db
    from stores.cuentas_store import listar_cuentas, listar_transferencias, movimientos_de_cuenta, saldos

    conn = get_db()
    listar_cuentas(conn)
    listar_transferencias(conn)
    saldos(conn)
    movimientos_de_cuenta("ahorro", conn)

    assert conn.in_transaction is False
