"""Histórico diario del saldo de las cuentas (gráficas de la ventana Cuentas).

La garantía principal: el último punto de cada serie es exactamente el saldo que
da `saldos`, con los mismos datos que usan los tests de equivalencia (cada tipo de
movimiento, fechas raras, cuentas borradas y meses futuros).
"""

import datetime
from decimal import Decimal
from itertools import pairwise

import pytest
from test_saldos_equivalencia import HOY, _aEuros, _sembrar


@pytest.fixture
def conn(tempDb):
    from core.db import getDb

    conexion = getDb()
    _sembrar(conexion)
    return conexion


def _historico(conn, hoy=HOY):
    from stores.cuentas_historico import historicoSaldos

    return historicoSaldos(conn, hoy=hoy, aEuros=_aEuros)


def _punto(serie, fecha):
    return next(p for p in serie if p["fecha"] == fecha)


def test_ultimo_punto_coincide_con_saldos(conn):
    from stores.cuentas_store import saldos

    esperados = saldos(conn, hoy=HOY, aEuros=_aEuros)
    series = _historico(conn)

    assert set(series) == set(esperados)
    for cuentaId, serie in series.items():
        assert serie[-1]["fecha"] == HOY
        assert serie[-1]["saldo"] == esperados[cuentaId]["saldo"], cuentaId


@pytest.mark.parametrize("hoy", [datetime.date(2026, 1, 31), datetime.date(2026, 2, 1), datetime.date(2026, 12, 31)])
def test_coincide_con_saldos_en_otras_fechas_de_corte(conn, hoy):
    from stores.cuentas_store import saldos

    esperados = saldos(conn, hoy=hoy, aEuros=_aEuros)
    for cuentaId, serie in _historico(conn, hoy).items():
        assert serie[-1]["saldo"] == esperados[cuentaId]["saldo"], cuentaId


def test_las_fechas_van_ordenadas_y_ninguna_pasa_de_hoy(conn):
    for serie in _historico(conn).values():
        fechas = [p["fecha"] for p in serie]
        assert fechas == sorted(fechas)
        assert len(set(fechas)) == len(fechas)
        assert fechas[-1] <= HOY


def test_cada_punto_es_el_anterior_mas_sus_flujos(conn):
    for serie in _historico(conn).values():
        for anterior, punto in pairwise(serie):
            assert punto["saldo"] == anterior["saldo"] + punto["entradas"] - punto["salidas"]


def test_transferencia_cae_en_su_dia_con_la_comision_en_el_origen(conn):
    series = _historico(conn)

    # 01-03-2026: banco -> broker 100,50 con 1,25 de comisión.
    assert _punto(series["broker"], datetime.date(2026, 3, 1))["entradas"] == Decimal("100.50")
    salidaBanco = _punto(series["banco"], datetime.date(2026, 3, 1))["salidas"]
    # El 1 de marzo también salen de la bancaria las filas de gasto sin día.
    assert salidaBanco >= Decimal("101.75")


def test_lo_que_solo_tiene_mes_cuenta_el_dia_1(conn):
    series = _historico(conn)

    # La nómina de enero (recurrente, 1.000) entra el 1 de enero en la bancaria.
    assert _punto(series["banco"], datetime.date(2026, 1, 1))["entradas"] >= Decimal("1000.00")


def test_lo_posterior_a_hoy_del_mes_en_curso_todavia_no_cuenta(conn):
    series = _historico(conn)

    # 21-03-2026 (HOY es el 20): banco -> ahorro 999 + 9 de comisión. Aún no ha
    # pasado, así que ni la gráfica ni `saldos` lo cuentan.
    assert _punto(series["ahorro"], HOY)["entradas"] == Decimal(0)
    despues = _historico(conn, datetime.date(2026, 3, 21))["ahorro"]
    assert _punto(despues, datetime.date(2026, 3, 21))["entradas"] == Decimal("999")


def test_lo_que_no_tiene_fecha_va_al_saldo_de_partida(conn):
    series = _historico(conn)

    # «sin fecha»: banco -> ahorro 7. El primer punto de ahorro ya lo incluye.
    assert series["ahorro"][0]["saldo"] == Decimal("7")
    assert series["ahorro"][0]["entradas"] == Decimal(0)


def test_cuenta_sin_movimientos_tiene_solo_el_punto_de_hoy(tempDb):
    from core.db import getDb

    conexion = getDb()
    conexion.execute("UPDATE cuentas SET saldo_inicial = '25' WHERE id = 'ahorro'")
    conexion.commit()

    serie = _historico(conexion)["ahorro"]

    assert serie == [{"fecha": HOY, "entradas": Decimal(0), "salidas": Decimal(0), "saldo": Decimal("25")}]


def test_fecha_que_no_casa_con_el_mes_de_la_fila_usa_el_dia_1(tempDb):
    from core.db import getDb

    conexion = getDb()
    conexion.execute(
        "INSERT INTO gastos_rows (year, month, fecha, cantidad, cuenta) VALUES ('2026', 'febrero', '15-01-2026', '10', '')"
    )
    conexion.execute(
        "INSERT INTO gastos_rows (year, month, fecha, cantidad, cuenta) VALUES ('2026', 'febrero', '14-02-2026', '3', '')"
    )
    conexion.commit()

    serie = _historico(conexion)["banco"]

    assert _punto(serie, datetime.date(2026, 2, 1))["salidas"] == Decimal("10")
    assert _punto(serie, datetime.date(2026, 2, 14))["salidas"] == Decimal("3")


# ── HTTP ─────────────────────────────────────────────────────────────────────


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.cuentas import cuentasBp

    client, cabeceras, _app = clienteAutenticado(cuentasBp)
    return client, cabeceras


def test_get_historico_devuelve_textos_y_fechas_iso(cliente):
    client, cabeceras = cliente
    client.post(
        "/api/transferencias",
        json={"origen": "banco", "destino": "ahorro", "cantidad": "12,5", "fecha": "02-01-2026"},
        headers=cabeceras,
    )

    datos = client.get("/api/cuentas/historico").get_json()
    serie = datos["cuentas"]["ahorro"]

    assert {"fecha": "2026-01-02", "entradas": "12.50", "salidas": "0.00", "saldo": "12.50"} in serie
    assert serie[-1]["fecha"] == datetime.date.today().isoformat()


def test_get_movimientos_de_cuenta(cliente):
    client, cabeceras = cliente
    client.post(
        "/api/transferencias",
        json={"origen": "banco", "destino": "ahorro", "cantidad": "5", "fecha": "02-01-2026", "comision": "1"},
        headers=cabeceras,
    )

    movimientos = client.get("/api/cuentas/banco/movimientos").get_json()["movimientos"]

    assert [m["origen"] for m in movimientos] == ["transferencia", "comision"]
    assert all(m["kind"] == "salida" for m in movimientos)


def test_get_movimientos_de_cuenta_inexistente_es_404(cliente):
    client, _cabeceras = cliente

    assert client.get("/api/cuentas/nada/movimientos").status_code == 404


# ── Gastos por categoría ─────────────────────────────────────────────────────


def _gastosCategorias(conn, desde=None):
    from stores.cuentas_historico import gastosPorCategoria

    return {c["categoria"]: c["importe"] for c in gastosPorCategoria(desde, conn, hoy=HOY)}


def test_gastos_por_categoria_suma_filas_y_mensualidades(tempDb):
    from core.db import getDb

    conexion = getDb()
    conexion.execute(
        "INSERT INTO gastos_rows (year, month, fecha, tipo, cantidad) VALUES ('2026', 'enero', '10-01-2026', 'Comida', '20')"
    )
    conexion.execute(
        "INSERT INTO gastos_rows (year, month, fecha, tipo, cantidad) VALUES ('2026', 'marzo', '05-03-2026', 'Comida', '5,50')"
    )
    conexion.execute("INSERT INTO gastos_rows (year, month, fecha, tipo, cantidad) VALUES ('2026', 'marzo', '', '', '3')")
    conexion.execute(
        "INSERT INTO mensualidades (year, nombre, categoria, enero, febrero) VALUES ('2026', 'Gym', 'Deporte', '30', '30')"
    )
    conexion.commit()

    assert _gastosCategorias(conexion) == {
        "Deporte": Decimal("60"),
        "Comida": Decimal("25.50"),
        "Sin categoría": Decimal("3"),
    }


def test_gastos_por_categoria_respeta_el_inicio_y_no_cuenta_meses_futuros(tempDb):
    from core.db import getDb

    conexion = getDb()
    conexion.execute(
        "INSERT INTO gastos_rows (year, month, fecha, tipo, cantidad) VALUES ('2026', 'enero', '10-01-2026', 'Comida', '20')"
    )
    conexion.execute(
        "INSERT INTO gastos_rows (year, month, fecha, tipo, cantidad) VALUES ('2026', 'marzo', '15-03-2026', 'Comida', '7')"
    )
    # Mayo aún no ha llegado (HOY es el 20 de marzo).
    conexion.execute(
        "INSERT INTO gastos_rows (year, month, fecha, tipo, cantidad) VALUES ('2026', 'mayo', '01-05-2026', 'Viajes', '99')"
    )
    conexion.commit()

    assert _gastosCategorias(conexion, datetime.date(2026, 2, 1)) == {"Comida": Decimal("7")}
    assert "Viajes" not in _gastosCategorias(conexion)


def test_get_gastos_categorias(cliente):
    client, _cabeceras = cliente

    assert client.get("/api/cuentas/gastos-categorias").get_json() == {"categorias": []}
    assert client.get("/api/cuentas/gastos-categorias?desde=ayer").status_code == 400


# ── Día de cobro y lista detallada ───────────────────────────────────────────


def test_mensualidad_cuenta_desde_su_dia_de_cobro(tempDb):
    from core.db import getDb
    from stores.cuentas_store import saldos

    conexion = getDb()
    # Se cobra el 28; en marzo, por excepción, el 5. HOY es el 20 de marzo.
    conexion.execute(
        "INSERT INTO mensualidades (year, nombre, dia_cobro, dias_cobro, febrero, marzo) "
        "VALUES ('2026', 'Seguro', '28', '{\"marzo\": \"5\"}', '10', '20')"
    )
    conexion.execute(
        "INSERT INTO ingresos_recurrentes (year, nombre, dia_cobro, marzo) VALUES ('2026', 'Nomina', '25', '1000')"
    )
    conexion.commit()

    banco = saldos(conexion, hoy=HOY)["banco"]
    assert banco["salidas"] == Decimal("30")
    # La nómina del 25 todavía no ha llegado.
    assert banco["entradas"] == Decimal(0)
    serie = _historico(conexion)["banco"]
    assert _punto(serie, datetime.date(2026, 2, 28))["salidas"] == Decimal("10")
    assert _punto(serie, datetime.date(2026, 3, 5))["salidas"] == Decimal("20")
    assert saldos(conexion, hoy=datetime.date(2026, 3, 25))["banco"]["entradas"] == Decimal("1000")


def test_dia_de_cobro_31_en_febrero_es_el_ultimo_dia(tempDb):
    from core.db import getDb

    conexion = getDb()
    conexion.execute("INSERT INTO mensualidades (year, nombre, dia_cobro, febrero) VALUES ('2026', 'Alquiler', '31', '500')")
    conexion.commit()

    assert _punto(_historico(conexion)["banco"], datetime.date(2026, 2, 28))["salidas"] == Decimal("500")


def _detallados(conn, cuentaId, hoy=HOY):
    from stores.cuentas_historico import movimientosDetallados

    return movimientosDetallados(cuentaId, conn, hoy=hoy, aEuros=_aEuros)


@pytest.mark.parametrize("cuentaId", ["banco", "ahorro", "broker", "tarjeta"])
def test_saldo_tras_el_ultimo_movimiento_ocurrido_es_el_de_saldos(conn, cuentaId):
    from stores.cuentas_store import saldos

    esperado = saldos(conn, hoy=HOY, aEuros=_aEuros)[cuentaId]["saldo"]
    ocurridos = [m for m in _detallados(conn, cuentaId) if not m["pendiente"]]

    assert Decimal(ocurridos[-1]["saldo"]) == esperado


def test_detallados_incluye_cada_origen_y_marca_lo_pendiente(conn):
    banco = _detallados(conn, "banco")
    origenes = {m["origen"] for m in banco}

    assert {"transferencia", "comision", "ingreso", "gasto", "recurrente"} <= origenes
    futura = next(m for m in banco if m["fecha"] == "21-03-2026" and m["origen"] == "transferencia")
    assert futura["pendiente"] is True
    assert futura["kind"] == "salida"
    assert futura["contraparte"] == "Cuenta de ahorro"
    # Lo que no tiene fecha va el primero y no está pendiente.
    assert banco[0]["dia"] == "" and banco[0]["pendiente"] is False


def test_detallados_cada_saldo_es_el_anterior_mas_su_importe(conn):
    from stores.cuentas_store import obtenerCuenta

    movimientos = _detallados(conn, "broker")
    saldo = Decimal(obtenerCuenta("broker", conn)["saldo_inicial"])
    for m in movimientos:
        saldo += Decimal(m["cantidad"]) if m["kind"] == "entrada" else -Decimal(m["cantidad"])
        assert Decimal(m["saldo"]) == saldo
    assert {"dividendo"} <= {m["origen"] for m in movimientos}
    assert [m["orden"] for m in movimientos] == list(range(len(movimientos)))


def test_detallados_de_cuenta_inexistente_esta_vacio(conn):
    assert _detallados(conn, "nada") == []
