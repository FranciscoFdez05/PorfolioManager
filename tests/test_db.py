"""Esquema, transacciones y aislamiento de la capa de base de datos."""

import sqlite3

import pytest

from core import db


def test_el_esquema_se_crea_completo(temp_db):
    conn = db.get_db()
    tablas = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    esperadas = {
        "activos", "activo_rows", "operaciones", "gastos_rows", "mensualidades",
        "ingresos_rows", "ingresos_recurrentes", "ventas", "dividendos",
        "portfolio_snapshots", "asset_snapshots", "settings", "trading",
    }
    assert esperadas <= tablas


def test_migraciones_son_idempotentes(temp_db):
    # init_db() dos veces sobre la misma BD no debe fallar por ALTER duplicado.
    db.invalidate_all_connections()
    db.init_db()
    db.invalidate_all_connections()
    db.init_db()
    cols = {row[1] for row in db.get_db().execute("PRAGMA table_info(activos)")}
    assert {"color", "tv_symbol", "hidden"} <= cols


def test_foreign_keys_activas(temp_db):
    conn = db.get_db()
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO activo_rows (asset_id, fecha_operacion) VALUES ('inexistente', '2026-01-01')"
        )
        conn.commit()
    conn.rollback()


def test_borrado_en_cascada(temp_db):
    conn = db.get_db()
    conn.execute("INSERT INTO activos (id, name) VALUES ('btc', 'Bitcoin')")
    conn.execute("INSERT INTO activo_rows (asset_id, fecha_operacion) VALUES ('btc', '2026-01-01')")
    conn.commit()

    conn.execute("DELETE FROM activos WHERE id = 'btc'")
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM activo_rows").fetchone()[0] == 0


def test_transaction_confirma_al_salir(temp_db):
    with db.transaction() as conn:
        conn.execute("INSERT INTO activos (id, name) VALUES ('eth', 'Ethereum')")

    assert db.get_db().execute(
        "SELECT name FROM activos WHERE id = 'eth'"
    ).fetchone()["name"] == "Ethereum"


def test_transaction_revierte_ante_excepcion(temp_db):
    with pytest.raises(RuntimeError), db.transaction() as conn:
        conn.execute("INSERT INTO activos (id, name) VALUES ('sol', 'Solana')")
        raise RuntimeError("fallo a mitad")

    assert db.get_db().execute("SELECT COUNT(*) FROM activos WHERE id = 'sol'").fetchone()[0] == 0


def test_transaccion_huerfana_se_revierte_en_el_siguiente_get_db(temp_db):
    # Escenario real: una escritura falló dejando su transacción abierta con
    # DELETEs ya aplicados. El siguiente commit de otra operación la confirmaba
    # y los datos desaparecían en silencio.
    conn = db.get_db()
    conn.execute("INSERT INTO activos (id, name) VALUES ('ada', 'Cardano')")
    conn.commit()

    conn.execute("DELETE FROM activos WHERE id = 'ada'")  # transacción abierta
    assert conn.in_transaction

    conn = db.get_db()  # red de seguridad: rollback preventivo
    assert not conn.in_transaction
    assert conn.execute("SELECT COUNT(*) FROM activos WHERE id = 'ada'").fetchone()[0] == 1


def test_transactional_revierte_la_escritura_fallida(temp_db):
    @db.transactional
    def escritura_rota():
        conn = db.get_db()
        conn.execute("INSERT INTO activos (id, name) VALUES ('dot', 'Polkadot')")
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        escritura_rota()

    assert db.get_db().execute("SELECT COUNT(*) FROM activos WHERE id = 'dot'").fetchone()[0] == 0


def test_cambiar_de_bd_no_mezcla_datos(temp_db, tmp_path):
    # Ojo: hay que confirmar dentro de la misma transacción. Un
    # `get_db().execute(...)` seguido de `get_db().commit()` pierde el INSERT,
    # porque la segunda llamada detecta la transacción abierta y la revierte.
    with db.transaction() as conn:
        conn.execute("INSERT INTO activos (id, name) VALUES ('btc', 'Bitcoin')")

    otra = tmp_path / "otro_portfolio.db"
    db.set_active_db_path(otra)
    db.init_db()
    assert db.get_db().execute("SELECT COUNT(*) FROM activos").fetchone()[0] == 0

    db.set_active_db_path(temp_db)
    assert db.get_db().execute("SELECT COUNT(*) FROM activos").fetchone()[0] == 1


def test_init_db_at_path_no_cambia_la_bd_activa(temp_db, tmp_path):
    nueva = tmp_path / "nueva.db"
    db.init_db_at_path(nueva)

    assert nueva.exists()
    assert db.get_active_db_path() == temp_db
