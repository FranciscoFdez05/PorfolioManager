"""El campo `cuenta` del Atajo de iOS: con qué cuenta se paga o en cuál se cobra."""

import hashlib
import hmac
import json
import time

import pytest

CLAVE = "clave-de-prueba-0123456789abcdef"
IP = "192.168.1.50"


@pytest.fixture
def app(temp_db, monkeypatch):
    from flask import Flask

    from core.errors import register_error_handlers
    from routes.movimientos import movimientos_bp

    monkeypatch.setenv("MOVIMIENTOS_SECRET_KEY", CLAVE)
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "192.168.1.0/24")
    monkeypatch.setenv("MOVIMIENTOS_ACTIVADO", "true")

    app = Flask(__name__)
    app.config["TESTING"] = True
    register_error_handlers(app)
    app.register_blueprint(movimientos_bp)
    return app


def _enviar(client, payload):
    cuerpo = json.dumps(payload).encode()
    ts = int(time.time())
    firma = hmac.new(CLAVE.encode(), f"{ts}.".encode() + cuerpo, hashlib.sha256).hexdigest()
    return client.post(
        "/api/movimiento",
        data=cuerpo,
        content_type="application/json",
        headers={"X-Timestamp": str(ts), "X-Signature": firma},
        environ_base={"REMOTE_ADDR": IP},
    )


def _filas(tabla):
    from core.db import get_db

    return [dict(f) for f in get_db().execute(f"SELECT * FROM {tabla} ORDER BY id").fetchall()]


def test_sin_cuenta_es_la_cuenta_bancaria(app):
    res = _enviar(app.test_client(), {"tipo": "gasto", "categoria": "Comida", "nombre": "Super", "importe": 12.5})

    assert res.status_code == 201
    assert _filas("gastos_rows")[0]["cuenta"] == ""


@pytest.mark.parametrize("cuenta", ["Cuenta bancaria", "banco", "BANCO", ""])
def test_la_cuenta_bancaria_se_puede_pedir_expresamente(app, cuenta):
    res = _enviar(app.test_client(), {"tipo": "gasto", "categoria": "Comida", "cuenta": cuenta, "nombre": "x", "importe": 3})

    assert res.status_code == 201
    assert _filas("gastos_rows")[0]["cuenta"] == ""


def test_un_gasto_pagado_con_ahorro_conserva_su_categoria(app):
    res = _enviar(
        app.test_client(),
        {"tipo": "gasto", "categoria": "Comida", "cuenta": "Cuenta de ahorro", "nombre": "Cena", "importe": 50},
    )

    assert res.status_code == 201
    fila = _filas("gastos_rows")[0]
    assert (fila["tipo"], fila["cuenta"]) == ("Comida", "ahorro")


def test_un_ingreso_cobrado_en_una_cuenta(app):
    from stores.cuentas_store import crear_cuenta

    exchange = crear_cuenta("Binance", "exchange")

    _enviar(app.test_client(), {"tipo": "ingreso", "categoria": "Otros", "cuenta": "binance", "nombre": "Airdrop", "importe": 20})

    assert _filas("ingresos_rows")[0]["cuenta"] == exchange["id"]


def test_la_cuenta_tambien_vale_por_su_identificador(app):
    _enviar(app.test_client(), {"tipo": "gasto", "categoria": "Comida", "cuenta": "ahorro", "nombre": "x", "importe": 1})

    assert _filas("gastos_rows")[0]["cuenta"] == "ahorro"


def test_una_cuenta_que_no_existe_se_rechaza_diciendo_cuales_valen(app):
    res = _enviar(app.test_client(), {"tipo": "gasto", "cuenta": "Mi hucha", "nombre": "x", "importe": 1})

    assert res.status_code == 400
    error = res.get_json()["error"]
    assert "Mi hucha" in error and "Cuenta de ahorro" in error
    assert _filas("gastos_rows") == []


def test_las_categorias_traen_las_cuentas_con_la_bancaria_primera(app):
    from stores.cuentas_store import crear_cuenta

    crear_cuenta("Binance", "exchange")
    client = app.test_client()
    _enviar(client, {"tipo": "gasto", "categoria": "Comida", "nombre": "y", "importe": 1})

    datos = client.get("/api/categorias?tipo=gasto", environ_base={"REMOTE_ADDR": IP}).get_json()

    assert datos["cuentas"] == ["Cuenta bancaria", "Cuenta de ahorro", "Binance"]
    assert datos["lista"] == ["Comida"]


def test_preparar_acepta_el_campo_cuenta(app):
    res = app.test_client().post(
        "/api/preparar",
        json={"tipo": "gasto", "cuenta": "Cuenta de ahorro", "nombre": "Hucha", "importe": 5},
        environ_base={"REMOTE_ADDR": IP},
    )

    assert res.status_code == 200
    assert json.loads(res.get_json()["cuerpo"])["cuenta"] == "Cuenta de ahorro"


# ── Concepto opcional ────────────────────────────────────────────────────────

@pytest.mark.parametrize("payload", [
    {"tipo": "gasto", "categoria": "Comida", "nombre": "", "importe": 5},
    {"tipo": "gasto", "categoria": "Comida", "importe": 5},
    {"tipo": "ingreso", "categoria": "Nómina", "nombre": "   ", "importe": 5},
])
def test_el_concepto_puede_ir_en_blanco(app, payload):
    res = _enviar(app.test_client(), payload)

    assert res.status_code == 201
    tabla = "gastos_rows" if payload["tipo"] == "gasto" else "ingresos_rows"
    fila = _filas(tabla)[0]
    assert fila["nombre"] == ""
    assert fila["cantidad"] == "5,00 €"


def test_preparar_acepta_un_movimiento_sin_concepto(app):
    res = app.test_client().post(
        "/api/preparar",
        json={"tipo": "gasto", "categoria": "Comida", "nombre": "", "importe": 5},
        environ_base={"REMOTE_ADDR": IP},
    )

    assert res.status_code == 200
    assert "nombre" not in json.loads(res.get_json()["cuerpo"])


def test_la_cuenta_bancaria_renombrada_se_pide_por_su_nombre_nuevo_y_por_los_de_siempre(app):
    from stores.cuentas_store import modificar_cuenta

    modificar_cuenta("banco", nombre="BBVA nómina")
    client = app.test_client()

    for cuenta in ("BBVA nómina", "Cuenta bancaria", "banco"):
        assert _enviar(client, {"tipo": "gasto", "categoria": "Comida", "cuenta": cuenta, "nombre": "x", "importe": 1}).status_code == 201

    assert {f["cuenta"] for f in _filas("gastos_rows")} == {""}
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": IP}).get_json()["cuentas"][0] == "BBVA nómina"


# ── Lista de cuentas para el Atajo ───────────────────────────────────────────

def test_la_lista_de_cuentas_trae_nombres_y_la_bancaria_primera(app):
    from stores.cuentas_store import crear_cuenta, modificar_cuenta

    modificar_cuenta("banco", nombre="Santander")
    crear_cuenta("Revolut", "banco")
    crear_cuenta("Trade Republic", "ahorro")

    datos = app.test_client().get("/api/cuentas-lista", environ_base={"REMOTE_ADDR": IP}).get_json()

    assert datos["nombres"] == ["Santander", "Cuenta de ahorro", "Revolut", "Trade Republic"]
    assert datos["predeterminada"] == "Santander"
    assert datos["idPorNombre"]["Trade Republic"] == "ahorro-trade-republic"
    assert {c["nombre"]: c["tipo_etiqueta"] for c in datos["cuentas"]}["Revolut"] == "Banco"


def test_la_lista_de_cuentas_sirve_para_pagar(app):
    from stores.cuentas_store import crear_cuenta

    crear_cuenta("Revolut", "banco")
    client = app.test_client()
    elegida = client.get("/api/cuentas-lista", environ_base={"REMOTE_ADDR": IP}).get_json()["nombres"][-1]

    assert _enviar(client, {"tipo": "ingreso", "categoria": "Nómina", "cuenta": elegida, "nombre": "x", "importe": 5}).status_code == 201
    assert _filas("ingresos_rows")[0]["cuenta"] == "banco-revolut"


def test_la_lista_de_cuentas_solo_se_sirve_a_la_red_local(app):
    assert app.test_client().get("/api/cuentas-lista", environ_base={"REMOTE_ADDR": "8.8.8.8"}).status_code == 403
