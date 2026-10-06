"""Comisión de las transferencias (esquema 12): la paga el origen, además de la cantidad."""

import datetime
import sqlite3

import pytest

from tests.test_cuentas import _cuenta, _guardar_gastos, _saldo, _transferir  # noqa: F401
from tests.test_cuentas import cliente  # noqa: F401  (fixture)

HOY = datetime.date(2026, 10, 5)


def _cuentas(client):
    return {c["id"]: c for c in client.get("/api/cuentas").get_json()["cuentas"]}


def test_la_comision_sale_del_origen_y_el_destino_recibe_solo_la_cantidad(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")

    res = _transferir(client, cabeceras, "banco", exchange["id"], "100", comision="2,5")

    assert res.status_code == 201
    assert res.get_json()["transferencia"]["comision"] == "2,50 €"
    assert _saldo(client, "banco") == -102.5
    assert _saldo(client, exchange["id"]) == 100
    # Cada cosa en su sitio: la cantidad son las salidas, la comisión va aparte.
    assert float(_cuentas(client)["banco"]["salidas"]) == 100
    assert float(_cuentas(client)["banco"]["comisiones"]) == 2.5
    assert float(_cuentas(client)["banco"]["entradas"]) == 0


def test_sin_comision_todo_sigue_igual(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")

    t = _transferir(client, cabeceras, "banco", exchange["id"], "100").get_json()["transferencia"]

    assert t["comision"] == ""
    assert _saldo(client, "banco") == -100


@pytest.mark.parametrize("valor", ["0", "0,00", "", None])
def test_una_comision_cero_o_vacia_no_se_guarda(cliente, valor):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")

    t = _transferir(client, cabeceras, "banco", exchange["id"], "10", comision=valor).get_json()["transferencia"]

    assert t["comision"] == ""


@pytest.mark.parametrize("valor", ["-1", "abc"])
def test_una_comision_invalida_se_rechaza(cliente, valor):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")

    res = _transferir(client, cabeceras, "banco", exchange["id"], "10", comision=valor)

    assert res.status_code == 400
    assert client.get("/api/transferencias").get_json()["transferencias"] == []


def test_editar_y_quitar_la_comision(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    t = _transferir(client, cabeceras, "banco", exchange["id"], "100", comision="3").get_json()["transferencia"]

    cuerpo = {"origen": "banco", "destino": exchange["id"], "cantidad": "100", "fecha": "10-03-2026"}
    assert client.put(f"/api/transferencias/{t['id']}", json={**cuerpo, "comision": "1"}, headers=cabeceras).status_code == 200
    assert _saldo(client, "banco") == -101

    assert client.put(f"/api/transferencias/{t['id']}", json=cuerpo, headers=cabeceras).status_code == 200
    assert _saldo(client, "banco") == -100


def test_borrar_la_transferencia_devuelve_tambien_la_comision(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    t = _transferir(client, cabeceras, "banco", exchange["id"], "100", comision="3").get_json()["transferencia"]

    client.delete(f"/api/transferencias/{t['id']}", headers=cabeceras)

    assert _saldo(client, "banco") == 0


def test_la_comision_de_una_transferencia_futura_no_mueve_el_saldo_aun(cliente):
    from core.db import get_db
    from stores.cuentas_store import saldos

    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    _transferir(client, cabeceras, "banco", exchange["id"], "100", fecha="10-12-2026", comision="4")

    assert float(saldos(get_db(), hoy=HOY)["banco"]["saldo"]) == 0
    assert float(saldos(get_db(), hoy=datetime.date(2026, 12, 20))["banco"]["saldo"]) == -104


def test_la_comision_aparece_como_movimiento_solo_en_la_cuenta_de_origen(cliente):
    client, cabeceras = cliente
    _transferir(client, cabeceras, "ahorro", "banco", "50", concepto="Retirada", comision="1,5")

    movs = client.get("/api/cuenta-ahorro").get_json()["movimientos"]

    assert [(m["origen"], m["kind"], m["cantidad"], m["nombre"]) for m in movs] == [
        ("transferencia", "salida", "50,00 €", "Retirada"),
        ("comision", "salida", "1,50 €", "Comisión · Retirada"),
    ]
    assert movs[0]["comision"] == "1,50 €"
    # El banco recibe 50; la comisión no es un movimiento suyo.
    assert _saldo(client, "banco") == 50
    assert _saldo(client, "ahorro") == -51.5


def test_la_comision_no_cuenta_como_gasto(cliente):
    client, cabeceras = cliente
    exchange = _cuenta(client, cabeceras, "Binance")
    _transferir(client, cabeceras, "banco", exchange["id"], "100", comision="5")

    from core.db import get_db

    assert get_db().execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 0


def test_el_esquema_12_anade_la_columna_sin_tocar_las_filas(tmp_path):
    from core import db

    ruta = tmp_path / "viejo.db"
    conn = sqlite3.connect(ruta)
    conn.execute(
        "CREATE TABLE transferencias (id INTEGER PRIMARY KEY AUTOINCREMENT, fecha TEXT NOT NULL DEFAULT '', "
        "origen TEXT NOT NULL DEFAULT '', destino TEXT NOT NULL DEFAULT '', cantidad TEXT NOT NULL DEFAULT '', "
        "concepto TEXT NOT NULL DEFAULT '', nota TEXT NOT NULL DEFAULT '')"
    )
    conn.execute("INSERT INTO transferencias (fecha, origen, destino, cantidad) VALUES ('01-01-2026', 'banco', 'ahorro', '10,00 €')")

    db._esquema_12(conn)
    db._esquema_12(conn)  # idempotente

    fila = conn.execute("SELECT cantidad, comision FROM transferencias").fetchone()
    assert fila == ("10,00 €", "")
