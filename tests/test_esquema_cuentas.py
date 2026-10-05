"""Paso 11 del esquema: las aportaciones a ahorro dejan de ser gastos."""

import pytest


@pytest.fixture
def conn(temp_db):
    from core.db import get_db

    return get_db()


def _viejo(conn):
    """Los datos como los dejaba la versión anterior: categorías reservadas en filas."""
    conn.execute("DELETE FROM cuentas")
    conn.executemany("INSERT INTO gastos_tipos (label) VALUES (?)", [("Comida",), ("Cuenta de ahorro",), ("Cuenta de ahorro · Viaje",)])
    conn.executemany("INSERT INTO ingresos_tipos (label) VALUES (?)", [("Nómina",), ("Cuenta de ahorro",)])
    conn.executemany(
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad, nota) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
            ("2026", "enero", "05-01-2026", "Inicial", "Cuenta de ahorro", "6.000,00 €", ""),
            ("2026", "marzo", "05-03-2026", "Hucha", "Cuenta de ahorro · Viaje", "200,00 €", "para Roma"),
            ("2026", "marzo", "06-03-2026", "Super", "Comida", "40,00 €", ""),
            ("2026", "abril", "", "Sin fecha", "cuenta de AHORRO", "10,00 €", ""),
        ],
    )
    conn.execute(
        "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad, nota) VALUES "
        "('2026', 'mayo', '10-05-2026', 'Retirada', 'Cuenta de ahorro', '300,00 €', ''), "
        "('2026', 'mayo', '01-05-2026', 'Nómina mayo', 'Nómina', '2.000,00 €', '')"
    )
    conn.commit()


def _migrar(conn):
    from core import db

    db._esquema_11(conn)
    conn.commit()


def _transferencias(conn):
    return [dict(f) for f in conn.execute("SELECT * FROM transferencias ORDER BY id").fetchall()]


def test_las_aportaciones_pasan_a_transferencias_del_banco_al_ahorro(conn):
    _viejo(conn)

    _migrar(conn)

    t = {x["concepto"]: x for x in _transferencias(conn)}
    assert (t["Inicial"]["origen"], t["Inicial"]["destino"], t["Inicial"]["cantidad"]) == ("banco", "ahorro", "6.000,00 €")
    assert t["Hucha"]["nota"] == "para Roma"
    assert t["Hucha"]["origen"] == "banco"


def test_las_retiradas_pasan_a_transferencias_del_ahorro_al_banco(conn):
    _viejo(conn)

    _migrar(conn)

    retirada = next(x for x in _transferencias(conn) if x["concepto"] == "Retirada")
    assert (retirada["origen"], retirada["destino"], retirada["fecha"]) == ("ahorro", "banco", "10-05-2026")


def test_esas_filas_dejan_de_ser_gastos_e_ingresos(conn):
    _viejo(conn)

    _migrar(conn)

    assert [r["nombre"] for r in conn.execute("SELECT nombre FROM gastos_rows").fetchall()] == ["Super"]
    assert [r["nombre"] for r in conn.execute("SELECT nombre FROM ingresos_rows").fetchall()] == ["Nómina mayo"]


def test_cada_cuenta_de_ahorro_que_habia_se_da_de_alta(conn):
    _viejo(conn)

    _migrar(conn)

    cuentas = {c["id"]: dict(c) for c in conn.execute("SELECT * FROM cuentas").fetchall()}
    assert cuentas["banco"]["tipo"] == "banco"
    assert cuentas["ahorro"]["tipo"] == "ahorro"
    viaje = next(c for c in cuentas.values() if c["nombre"] == "Viaje")
    assert viaje["tipo"] == "ahorro"
    assert next(x for x in _transferencias(conn) if x["concepto"] == "Hucha")["destino"] == viaje["id"]


def test_una_fila_sin_fecha_la_toma_del_mes(conn):
    _viejo(conn)

    _migrar(conn)

    assert next(x for x in _transferencias(conn) if x["concepto"] == "Sin fecha")["fecha"] == "01-04-2026"


def test_las_categorias_reservadas_salen_del_catalogo(conn):
    _viejo(conn)

    _migrar(conn)

    assert [r["label"] for r in conn.execute("SELECT label FROM gastos_tipos").fetchall()] == ["Comida"]
    assert [r["label"] for r in conn.execute("SELECT label FROM ingresos_tipos").fetchall()] == ["Nómina"]


def test_las_filas_que_no_eran_de_ahorro_conservan_su_cuenta_bancaria(conn):
    _viejo(conn)

    _migrar(conn)

    assert {r["cuenta"] for r in conn.execute("SELECT cuenta FROM gastos_rows").fetchall()} == {""}


def test_la_migracion_es_idempotente(conn):
    _viejo(conn)

    _migrar(conn)
    antes = _transferencias(conn)
    _migrar(conn)

    assert _transferencias(conn) == antes


def test_una_base_nueva_trae_las_dos_cuentas_basicas(conn):
    from stores.cuentas_store import listar_cuentas

    assert [c["id"] for c in listar_cuentas(conn)] == ["banco", "ahorro"]
