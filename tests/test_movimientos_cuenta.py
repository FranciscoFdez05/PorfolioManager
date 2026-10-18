"""El campo `cuenta` del Atajo de iOS: con qué cuenta se paga o en cuál se cobra."""

import hashlib
import hmac
import json
import time

import pytest

from tests.conftest import ClienteAtajo

CLAVE = "clave-de-prueba-0123456789abcdef"
IP = "192.168.1.50"


@pytest.fixture
def app(tempDb, monkeypatch):
    from flask import Flask

    from core.errors import registerErrorHandlers
    from routes.movimientos import movimientosBp

    monkeypatch.setenv("MOVIMIENTOS_SECRET_KEY", CLAVE)
    monkeypatch.setenv("MOVIMIENTOS_REDES_PERMITIDAS", "192.168.1.0/24")
    monkeypatch.setenv("MOVIMIENTOS_ACTIVADO", "true")

    app = Flask(__name__)
    app.config["TESTING"] = True
    registerErrorHandlers(app)
    app.register_blueprint(movimientosBp)
    return ClienteAtajo.instalar(app)


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
    from core.db import getDb

    return [dict(f) for f in getDb().execute(f"SELECT * FROM {tabla} ORDER BY id").fetchall()]


def testSinCuentaEsLaCuentaBancaria(app):
    res = _enviar(app.test_client(), {"tipo": "gasto", "categoria": "Comida", "nombre": "Super", "importe": 12.5})

    assert res.status_code == 201
    assert _filas("gastos_rows")[0]["cuenta"] == ""


@pytest.mark.parametrize("cuenta", ["Cuenta bancaria", "banco", "BANCO", ""])
def testLaCuentaBancariaSePuedePedirExpresamente(app, cuenta):
    res = _enviar(app.test_client(), {"tipo": "gasto", "categoria": "Comida", "cuenta": cuenta, "nombre": "x", "importe": 3})

    assert res.status_code == 201
    assert _filas("gastos_rows")[0]["cuenta"] == ""


def testUnGastoPagadoConAhorroConservaSuCategoria(app):
    res = _enviar(
        app.test_client(),
        {"tipo": "gasto", "categoria": "Comida", "cuenta": "Cuenta de ahorro", "nombre": "Cena", "importe": 50},
    )

    assert res.status_code == 201
    fila = _filas("gastos_rows")[0]
    assert (fila["tipo"], fila["cuenta"]) == ("Comida", "ahorro")


def testUnIngresoCobradoEnUnaCuenta(app):
    from stores.cuentas_store import crearCuenta

    exchange = crearCuenta("Binance", "exchange")

    _enviar(app.test_client(), {"tipo": "ingreso", "categoria": "Otros", "cuenta": "binance", "nombre": "Airdrop", "importe": 20})

    assert _filas("ingresos_rows")[0]["cuenta"] == exchange["id"]


def testLaCuentaTambienValePorSuIdentificador(app):
    _enviar(app.test_client(), {"tipo": "gasto", "categoria": "Comida", "cuenta": "ahorro", "nombre": "x", "importe": 1})

    assert _filas("gastos_rows")[0]["cuenta"] == "ahorro"


def testUnaCuentaQueNoExisteSeRechazaDiciendoCualesValen(app):
    res = _enviar(app.test_client(), {"tipo": "gasto", "cuenta": "Mi hucha", "nombre": "x", "importe": 1})

    assert res.status_code == 400
    error = res.get_json()["error"]
    assert "Mi hucha" in error and "Cuenta de ahorro" in error
    assert _filas("gastos_rows") == []


def testLasCategoriasTraenLasCuentasConLaBancariaPrimera(app):
    from stores.cuentas_store import crearCuenta

    crearCuenta("Binance", "exchange")
    client = app.test_client()
    _enviar(client, {"tipo": "gasto", "categoria": "Comida", "nombre": "y", "importe": 1})

    datos = client.get("/api/categorias?tipo=gasto", environ_base={"REMOTE_ADDR": IP}).get_json()

    assert datos["cuentas"] == ["Cuenta bancaria", "Cuenta de ahorro", "Binance"]
    assert datos["lista"] == ["Comida"]


def testPrepararAceptaElCampoCuenta(app):
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
def testElConceptoPuedeIrEnBlanco(app, payload):
    res = _enviar(app.test_client(), payload)

    assert res.status_code == 201
    tabla = "gastos_rows" if payload["tipo"] == "gasto" else "ingresos_rows"
    fila = _filas(tabla)[0]
    assert fila["nombre"] == ""
    assert fila["cantidad"] == "5,00 €"


def testPrepararAceptaUnMovimientoSinConcepto(app):
    res = app.test_client().post(
        "/api/preparar",
        json={"tipo": "gasto", "categoria": "Comida", "nombre": "", "importe": 5},
        environ_base={"REMOTE_ADDR": IP},
    )

    assert res.status_code == 200
    assert "nombre" not in json.loads(res.get_json()["cuerpo"])


def testLaCuentaBancariaRenombradaSePidePorSuNombreNuevoYPorLosDeSiempre(app):
    from stores.cuentas_store import modificarCuenta

    modificarCuenta("banco", nombre="BBVA nómina")
    client = app.test_client()

    for cuenta in ("BBVA nómina", "Cuenta bancaria", "banco"):
        assert _enviar(client, {"tipo": "gasto", "categoria": "Comida", "cuenta": cuenta, "nombre": "x", "importe": 1}).status_code == 201

    assert {f["cuenta"] for f in _filas("gastos_rows")} == {""}
    assert client.get("/api/categorias", environ_base={"REMOTE_ADDR": IP}).get_json()["cuentas"][0] == "BBVA nómina"


# ── Lista de cuentas para el Atajo ───────────────────────────────────────────

def testLaListaDeCuentasTraeNombresYLaBancariaPrimera(app):
    from stores.cuentas_store import crearCuenta, modificarCuenta

    modificarCuenta("banco", nombre="Santander")
    crearCuenta("Revolut", "banco")
    crearCuenta("Trade Republic", "ahorro")

    datos = app.test_client().get("/api/cuentas-lista", environ_base={"REMOTE_ADDR": IP}).get_json()

    assert datos["nombres"] == ["Santander", "Cuenta de ahorro", "Revolut", "Trade Republic"]
    assert datos["predeterminada"] == "Santander"
    assert datos["idPorNombre"]["Trade Republic"] == "ahorro-trade-republic"
    assert {c["nombre"]: c["tipo_etiqueta"] for c in datos["cuentas"]}["Revolut"] == "Banco"


def testLaListaDeCuentasSirveParaPagar(app):
    from stores.cuentas_store import crearCuenta

    crearCuenta("Revolut", "banco")
    client = app.test_client()
    elegida = client.get("/api/cuentas-lista", environ_base={"REMOTE_ADDR": IP}).get_json()["nombres"][-1]

    assert _enviar(client, {"tipo": "ingreso", "categoria": "Nómina", "cuenta": elegida, "nombre": "x", "importe": 5}).status_code == 201
    assert _filas("ingresos_rows")[0]["cuenta"] == "banco-revolut"


def testLaListaDeCuentasSoloSeSirveALaRedLocal(app):
    assert app.test_client().get("/api/cuentas-lista", environ_base={"REMOTE_ADDR": "8.8.8.8"}).status_code == 403
