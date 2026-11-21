"""Fecha de inicio de las cuentas («Reiniciar cuentas»).

Las cuentas llegaron después que Gastos e Ingresos. Con una fecha de inicio, el
saldo inicial es el del final de ese día y solo cuenta lo posterior; lo de antes
no se borra: sigue en Gastos e Ingresos y la lista de la cuenta lo marca.
"""

import datetime
from decimal import Decimal

import pytest
from test_saldos_equivalencia import HOY, _aEuros, _sembrar


@pytest.fixture
def conn(tempDb):
    from core.db import getDb

    conexion = getDb()
    _sembrar(conexion)
    return conexion


def _saldos(conn, hoy=HOY):
    from stores.cuentas_store import saldos

    return saldos(conn, hoy=hoy, aEuros=_aEuros)


def test_sin_fecha_de_inicio_no_cambia_nada(conn):
    from test_saldos_equivalencia import GOLDEN_SALDOS

    assert {c: str(d["saldo"]) for c, d in _saldos(conn).items()} == {
        c: d["saldo"] for c, d in GOLDEN_SALDOS.items()
    }


def test_solo_cuenta_lo_posterior_al_inicio(conn):
    from stores.cuentas_store import reiniciarCuentas

    # Banco tenía 500 al terminar el 01-03-2026. Después, hasta HOY (20-03),
    # solo le llegan los 10 de tarjeta del 20-03. Lo del propio día 1 (la
    # transferencia al broker, la nómina de marzo y las filas de marzo sin
    # fecha) y lo que no tiene fecha ya está en esos 500.
    reiniciarCuentas("01-03-2026", {"banco": "500"})

    banco = _saldos(conn)["banco"]
    assert banco["inicial"] == Decimal("500")
    assert banco["entradas"] == Decimal("10")
    assert banco["salidas"] == Decimal(0)
    assert banco["saldo"] == Decimal("510")


def test_el_inicio_de_una_cuenta_no_toca_a_las_demas(conn):
    from stores.cuentas_store import reiniciarCuentas

    antes = _saldos(conn)
    reiniciarCuentas("01-03-2026", {"banco": "500"})
    despues = _saldos(conn)

    for cuentaId in ("ahorro", "broker", "tarjeta"):
        assert despues[cuentaId] == antes[cuentaId], cuentaId


def test_intereses_y_dividendos_anteriores_no_cuentan(conn):
    from stores.cuentas_store import reiniciarCuentas

    reiniciarCuentas("28-02-2026", {"ahorro": "0", "broker": "0"})
    resultado = _saldos(conn)

    # Ahorro: solo el interés de «03-2026» (día 1 de marzo): 20 - 3,80.
    assert resultado["ahorro"]["intereses"] == Decimal("16.20")
    # Broker: el dividendo del 10-03 va a la cuenta de dividendos (broker);
    # el del 05-01 ya no cuenta.
    assert resultado["broker"]["dividendos"] == Decimal("8.25")


def test_historico_empieza_en_el_inicio_y_acaba_en_el_saldo(conn):
    from stores.cuentas_historico import historicoSaldos
    from stores.cuentas_store import reiniciarCuentas

    reiniciarCuentas("01-03-2026", {"banco": "500"})
    serie = historicoSaldos(conn, hoy=HOY, aEuros=_aEuros)["banco"]

    assert serie[0] == {"fecha": datetime.date(2026, 3, 1), "entradas": Decimal(0), "salidas": Decimal(0), "saldo": Decimal("500")}
    assert serie[-1]["saldo"] == _saldos(conn)["banco"]["saldo"]


def test_detallados_marcan_lo_anterior_y_cuadran(conn):
    from stores.cuentas_historico import movimientosDetallados
    from stores.cuentas_store import reiniciarCuentas

    reiniciarCuentas("01-03-2026", {"banco": "500"})
    movimientos = movimientosDetallados("banco", conn, hoy=HOY, aEuros=_aEuros)

    anteriores = [m for m in movimientos if m["anterior"]]
    contados = [m for m in movimientos if not m["anterior"] and not m["pendiente"]]
    assert anteriores and all(m["saldo"] == "" and not m["pendiente"] for m in anteriores)
    assert Decimal(contados[-1]["saldo"]) == _saldos(conn)["banco"]["saldo"]


def test_reiniciar_valida_todo_antes_de_guardar(conn):
    from stores.cuentas_store import CuentaInvalida, obtenerCuenta, reiniciarCuentas

    with pytest.raises(CuentaInvalida):
        reiniciarCuentas("01-03-2026", {"banco": "500", "nada": "1"})
    with pytest.raises(CuentaInvalida):
        reiniciarCuentas("01-03-2026", {"banco": "abc"})
    with pytest.raises(CuentaInvalida):
        reiniciarCuentas("", {"banco": "1"})
    with pytest.raises(CuentaInvalida):
        reiniciarCuentas((datetime.date.today() + datetime.timedelta(days=1)).strftime("%d-%m-%Y"), {"banco": "1"})

    assert obtenerCuenta("banco", conn)["inicio"] == ""


def test_quitar_la_fecha_vuelve_a_contar_toda_la_historia(conn):
    from stores.cuentas_store import modificarCuenta, reiniciarCuentas

    antes = _saldos(conn)["banco"]["saldo"]
    reiniciarCuentas("01-03-2026", {"banco": "1.500,25"})
    modificarCuenta("banco", inicio="")

    assert _saldos(conn)["banco"]["saldo"] == antes


def test_la_migracion_42_anade_la_columna(tempDb):
    from core import db

    conexion = db.getDb()
    columnas = {fila[1] for fila in conexion.execute("PRAGMA table_info(cuentas)")}
    assert "inicio" in columnas
    assert db.ESQUEMA_VERSION >= 42


# ── HTTP ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb):
    from routes.cuentas import cuentasBp

    client, cabeceras, _app = clienteAutenticado(cuentasBp)
    return client, cabeceras


def test_post_reiniciar_y_editar_inicio(cliente):
    client, cabeceras = cliente

    res = client.post("/api/cuentas/reiniciar", json={"fecha": "01-01-2026", "saldos": {"banco": "100,50"}}, headers=cabeceras)
    assert res.status_code == 200
    banco = next(c for c in client.get("/api/cuentas").get_json()["cuentas"] if c["id"] == "banco")
    assert banco["inicio"] == "2026-01-01"
    assert banco["saldo_inicial"] == "100.50"

    res = client.put("/api/cuentas/banco", json={"inicio": ""}, headers=cabeceras)
    assert res.status_code == 200
    assert res.get_json()["cuenta"]["inicio"] == ""


def test_post_reiniciar_rechaza_datos_malos(cliente):
    client, cabeceras = cliente

    res = client.post("/api/cuentas/reiniciar", json={"fecha": "32-01-2026", "saldos": {"banco": "1"}}, headers=cabeceras)
    assert res.status_code == 400
