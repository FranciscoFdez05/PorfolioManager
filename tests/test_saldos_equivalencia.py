"""Equivalencia de `saldos` y `saldosDelMes` con su comportamiento previo.

Los valores esperados se obtuvieron ejecutando la implementación anterior (dos
llamadas completas a `saldos` por `saldosDelMes`) sobre estos mismos datos. Si
una optimización cambia una sola cifra, estos tests lo dicen.
"""

import datetime
from decimal import Decimal

import pytest

HOY = datetime.date(2026, 3, 20)


def _aEuros(importe, moneda):
    """Cambio fijo y determinista: nada de red en estos tests."""
    tipos = {"EUR": Decimal("1"), "USD": Decimal("0.9")}
    return importe * tipos.get(str(moneda or "EUR").upper(), Decimal("1"))


def _sembrar(conn):
    """Datos con cada tipo de movimiento y varias cuentas, antes y después de HOY."""
    conn.execute("UPDATE cuentas SET saldo_inicial = '1.500,25' WHERE id = 'banco'")
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, saldo_inicial, sort_order, dividendos) VALUES ('broker', 'Broker', 'broker', '200', 5, 1)")
    conn.execute("INSERT INTO cuentas (id, nombre, tipo, saldo_inicial, sort_order) VALUES ('tarjeta', 'Tarjeta', 'banco', '-50,5', 6)")
    conn.execute("INSERT INTO cuentas_remuneradas (id, nombre, sort_order) VALUES ('rem', 'Remunerada', 1)")
    conn.execute("INSERT INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) VALUES ('rem', 'ahorro')")

    for fecha, acumulado, impuestos in (
        ("15-01-2026", "10,00", "1,90"),
        ("2026-02-10", "12.5", "2"),
        ("03-2026", "20,00", "3,80"),
        ("15-04-2026", "99", "9"),
        ("basura", "5", "0"),
    ):
        conn.execute("INSERT INTO intereses_v2 (cuenta_id, fecha, acumulado, impuestos) VALUES ('rem', ?, ?, ?)", (fecha, acumulado, impuestos))

    for fecha, total, moneda, cuenta in (
        ("05-01-2026", "40,00", "EUR", "broker"),
        ("20-02-2026", "30", "USD", ""),
        ("28-02-2026", "15,50", "USD", "tarjeta"),
        ("10-03-2026", "8,25", "EUR", "inexistente"),
        ("25-03-2026", "100", "EUR", "broker"),
        ("01-05-2026", "7", "EUR", "broker"),
    ):
        conn.execute("INSERT INTO dividendos (fecha, instrumento, total, moneda_total, cuenta) VALUES (?, 'X', ?, ?, ?)", (fecha, total, moneda, cuenta))

    for fecha, origen, destino, cantidad, comision in (
        ("31-12-2025", "banco", "ahorro", "300", "0"),
        ("01-03-2026", "banco", "broker", "100,50", "1,25"),
        ("15-03-2026", "ahorro", "tarjeta", "40", ""),
        ("20-03-2026", "tarjeta", "banco", "10", "0,5"),
        ("21-03-2026", "banco", "ahorro", "999", "9"),
        ("10-02-2026", "broker", "inexistente", "25", "2"),
        ("sin fecha", "banco", "ahorro", "7", "0"),
    ):
        conn.execute(
            "INSERT INTO transferencias (fecha, origen, destino, cantidad, comision) VALUES (?, ?, ?, ?, ?)",
            (fecha, origen, destino, cantidad, comision),
        )

    for tabla, filas in (
        ("ingresos_rows", (("2026", "enero", "2.000,00", ""), ("2026", "marzo", "150", "ahorro"),
                           ("2026", "abril", "500", ""), ("2025", "diciembre", "75,5", "tarjeta"))),
        ("gastos_rows", (("2026", "febrero", "60,10", ""), ("2026", "marzo", "20", "tarjeta"),
                         ("2026", "marzo", "5", "borrada"), ("2026", "mayo", "80", "broker"))),
    ):
        for year, month, cantidad, cuenta in filas:
            conn.execute(f"INSERT INTO {tabla} (year, month, cantidad, cuenta) VALUES (?, ?, ?, ?)", (year, month, cantidad, cuenta))

    conn.execute(
        "INSERT INTO mensualidades (year, nombre, enero, febrero, marzo, abril, cuenta, cuentas_cobro) "
        "VALUES ('2026', 'Gym', '30,00', '30,00', '30,00', '30,00', 'tarjeta', '{\"marzo\": \"broker\"}')"
    )
    conn.execute("INSERT INTO mensualidades (year, nombre, diciembre, enero) VALUES ('2025', 'Seguro', '45', '1')")
    conn.execute(
        "INSERT INTO ingresos_recurrentes (year, nombre, enero, febrero, marzo, cuenta, cuentas_cobro) "
        "VALUES ('2026', 'Nomina', '1.000,00', '1.000,00', '1.000,00', '', '{\"febrero\": \"ahorro\", \"marzo\": \"zzz\"}')"
    )
    conn.commit()


@pytest.fixture
def conn(tempDb):
    from core.db import getDb

    conexion = getDb()
    _sembrar(conexion)
    return conexion


def _plano(resultado):
    return {c: {k: str(v) for k, v in d.items()} for c, d in resultado.items()}


GOLDEN_SALDOS = {'banco': {'inicial': '1500.25',
           'entradas': '4010.00',
           'salidas': '1512.60',
           'comisiones': '10.25',
           'intereses': '0',
           'dividendos': '0',
           'saldo': '3987.40'},
 'ahorro': {'inicial': '0',
            'entradas': '2456.00',
            'salidas': '40',
            'comisiones': '0',
            'intereses': '34.80',
            'dividendos': '0',
            'saldo': '2450.80'},
 'broker': {'inicial': '200',
            'entradas': '100.50',
            'salidas': '55.00',
            'comisiones': '2',
            'intereses': '0',
            'dividendos': '175.25',
            'saldo': '418.75'},
 'tarjeta': {'inicial': '-50.5',
             'entradas': '115.5',
             'salidas': '90.00',
             'comisiones': '0.5',
             'intereses': '0',
             'dividendos': '13.950',
             'saldo': '-11.550'}}

GOLDEN_MES = {('2026', 'marzo'): {'banco': {'inicial': '4087.15', 'rendimientos': '0'},
                     'ahorro': {'inicial': '1325.60', 'rendimientos': '16.20'},
                     'broker': {'inicial': '240.00', 'rendimientos': '108.25'},
                     'tarjeta': {'inicial': '-21.050', 'rendimientos': '0.000'}},
 ('2026', 'enero'): {'banco': {'inicial': '1147.25', 'rendimientos': '0'},
                     'ahorro': {'inicial': '307', 'rendimientos': '8.10'},
                     'broker': {'inicial': '200', 'rendimientos': '40.00'},
                     'tarjeta': {'inicial': '25.0', 'rendimientos': '0'}},
 ('2026', 'febrero'): {'banco': {'inicial': '4147.25', 'rendimientos': '0'},
                       'ahorro': {'inicial': '315.10', 'rendimientos': '10.50'},
                       'broker': {'inicial': '240.00', 'rendimientos': '27.00'},
                       'tarjeta': {'inicial': '-5.00', 'rendimientos': '13.950'}},
 ('2026', 'diciembre'): {'banco': {'inicial': '4487.40', 'rendimientos': '0'},
                         'ahorro': {'inicial': '2540.80', 'rendimientos': '0.00'},
                         'broker': {'inicial': '345.75', 'rendimientos': '0.00'},
                         'tarjeta': {'inicial': '-41.550', 'rendimientos': '0.000'}},
 ('2025', 'diciembre'): {'banco': {'inicial': '1492.25', 'rendimientos': '0'},
                         'ahorro': {'inicial': '7', 'rendimientos': '0'},
                         'broker': {'inicial': '200', 'rendimientos': '0'},
                         'tarjeta': {'inicial': '-50.5', 'rendimientos': '0'}}}


def testSaldosCoincideConElComportamientoPrevio(conn):
    from stores.cuentas_store import saldos

    obtenido = _plano(saldos(conn, hoy=HOY, aEuros=_aEuros))
    assert obtenido == GOLDEN_SALDOS


@pytest.mark.parametrize("year,month", [("2026", "marzo"), ("2026", "enero"), ("2026", "febrero"), ("2026", "diciembre"), ("2025", "diciembre")])
def testSaldosDelMesCoincideConElComportamientoPrevio(conn, year, month):
    from stores.cuentas_store import saldosDelMes

    obtenido = _plano(saldosDelMes(year, month, conn, aEuros=_aEuros))
    assert obtenido == GOLDEN_MES[(year, month)]


def testSaldosDelMesEsSaldosDeAntesYRendimientosDelMes(conn):
    """Relación definitoria, independiente de los valores concretos."""
    from stores.cuentas_store import MONTH_KEYS, saldos, saldosDelMes

    year, month = "2026", "febrero"
    primerDia = datetime.date(2026, 2, 1)
    finDeMes = datetime.date(2026, 2, 28)
    antes = saldos(conn, primerDia - datetime.timedelta(days=1), _aEuros)
    despues = saldos(conn, finDeMes, _aEuros)
    obtenido = saldosDelMes(year, month, conn, aEuros=_aEuros)

    assert month in MONTH_KEYS
    assert set(obtenido) == set(antes)
    for cuentaId, datos in antes.items():
        assert obtenido[cuentaId]["inicial"] == datos["saldo"]
        esperado = (despues[cuentaId]["intereses"] + despues[cuentaId]["dividendos"]) - (datos["intereses"] + datos["dividendos"])
        assert obtenido[cuentaId]["rendimientos"] == esperado
