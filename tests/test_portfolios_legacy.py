"""Pruebas de la migración del portfolio legacy (data/portfolio.db).

Regresión concreta: `_migrate_legacy_gastos` se ejecutaba en cada arranque
contra el portfolio activo, y como solo copia cuando el destino está vacío,
cualquier portfolio recién creado que estuviera activo se llevaba dentro los
gastos, mensualidades, categorías e ingresos del legacy. El resultado era que
dos portfolios que el usuario nunca había relacionado aparecían mezclados.
"""

import json
import sqlite3

import pytest


def _sembrar_legacy(ruta):
    """Un data/portfolio.db con datos de gastos e ingresos."""
    from core.db import init_db_at_path

    init_db_at_path(ruta)
    conn = sqlite3.connect(str(ruta))
    conn.executemany("INSERT INTO gastos_tipos (label) VALUES (?)", [("Gasoil",), ("Café",)])
    conn.execute(
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        ("2026", "enero", "10-01-2026", "Repostaje", "Gasoil", "60,00 €"),
    )
    conn.execute(
        "INSERT INTO mensualidades (year, nombre, enero) VALUES (?, ?, ?)",
        ("2026", "Netflix", "12,99"),
    )
    conn.execute(
        "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        ("2026", "enero", "31-01-2026", "Enero", "Nómina", "1.500,00 €"),
    )
    conn.commit()
    conn.close()


@pytest.fixture
def entorno(tmp_path, monkeypatch):
    """Aísla data/ del repositorio: nada de esto toca los datos reales."""
    from admin import portfolios_manager as pm

    directorio = tmp_path / "portfolios"
    directorio.mkdir()
    legacy = tmp_path / "portfolio.db"
    meta = tmp_path / "portfolios.json"

    monkeypatch.setattr(pm, "_PORTFOLIOS_DIR", directorio)
    monkeypatch.setattr(pm, "_LEGACY_DB", legacy)
    monkeypatch.setattr(pm, "_META_FILE", meta)
    # El backup de arranque escribe fuera de tmp_path; aquí no aporta nada.
    monkeypatch.setattr("admin.backup_manager.run_startup_backup", lambda *a, **k: None)

    return {"dir": directorio, "legacy": legacy, "meta": meta}


def _contar(ruta, tabla):
    conn = sqlite3.connect(str(ruta))
    try:
        return conn.execute(f"SELECT COUNT(*) FROM {tabla}").fetchone()[0]
    finally:
        conn.close()


def test_un_portfolio_activo_con_ruta_de_escape_no_abre_nada_fuera(entorno):
    """Segunda barrera, en el punto donde el id se convierte en una ruta.

    La primera es la validación al restaurar, que impide que un índice así se
    escriba. Esta cubre el fichero que ya está en disco —restaurado por una
    versión anterior, editado a mano o copiado de otra máquina—: sin ella, la
    base activa acababa fuera del directorio de datos y el valor se persistía,
    así que el desvío se repetía en cada arranque.
    """
    from admin.portfolios_manager import init_portfolios
    from core.db import get_active_db_path, init_db_at_path

    init_db_at_path(entorno["dir"] / "principal.db")
    entorno["meta"].write_text(json.dumps({
        "active": "../../../fuera/principal",
        "portfolios": [{"id": "principal", "name": "Principal"}],
    }), encoding="utf-8")

    init_portfolios()

    activa = get_active_db_path().resolve()
    assert activa.parent == entorno["dir"].resolve(), f"la base activa se fue a {activa}"
    assert not list(entorno["dir"].parent.parent.glob("fuera/*.db"))
    # Y no se queda para el siguiente arranque.
    assert json.loads(entorno["meta"].read_text())["active"] == "principal"


def test_un_portfolio_nuevo_activo_no_recibe_el_legacy(entorno):
    """El fallo original: activar un portfolio vacío y reiniciar lo contaminaba."""
    from admin.portfolios_manager import init_portfolios
    from core.db import init_db_at_path

    _sembrar_legacy(entorno["legacy"])
    init_db_at_path(entorno["dir"] / "principal.db")
    init_db_at_path(entorno["dir"] / "test2.db")

    entorno["meta"].write_text(json.dumps({
        "active": "test2",
        "portfolios": [{"id": "principal", "name": "Principal"}, {"id": "test2", "name": "Test2"}],
    }), encoding="utf-8")

    init_portfolios()

    test2 = entorno["dir"] / "test2.db"
    assert _contar(test2, "gastos_rows") == 0
    assert _contar(test2, "mensualidades") == 0
    assert _contar(test2, "gastos_tipos") == 0
    assert _contar(test2, "ingresos_rows") == 0


def test_el_portfolio_inicial_si_recibe_el_legacy(entorno):
    """La migración de una sola vez tiene que seguir funcionando."""
    from admin.portfolios_manager import init_portfolios
    from core.db import init_db_at_path

    _sembrar_legacy(entorno["legacy"])
    init_db_at_path(entorno["dir"] / "principal.db")

    entorno["meta"].write_text(json.dumps({
        "active": "principal",
        "portfolios": [{"id": "principal", "name": "Principal"}],
    }), encoding="utf-8")

    init_portfolios()

    principal = entorno["dir"] / "principal.db"
    assert _contar(principal, "gastos_rows") == 1
    assert _contar(principal, "mensualidades") == 1


def test_la_migracion_se_marca_y_no_se_repite(entorno):
    """Sin la marca, volvía a evaluarse en cada arranque."""
    from admin.portfolios_manager import init_portfolios
    from core.db import init_db_at_path

    _sembrar_legacy(entorno["legacy"])
    init_db_at_path(entorno["dir"] / "principal.db")
    entorno["meta"].write_text(json.dumps({
        "active": "principal",
        "portfolios": [{"id": "principal", "name": "Principal"}],
    }), encoding="utf-8")

    init_portfolios()
    assert json.loads(entorno["meta"].read_text(encoding="utf-8"))["legacyMigrated"] is True

    # Se vacía el portfolio y se rearranca: no debe volver a llenarse.
    conn = sqlite3.connect(str(entorno["dir"] / "principal.db"))
    conn.execute("DELETE FROM gastos_rows")
    conn.execute("DELETE FROM mensualidades")
    conn.commit()
    conn.close()

    init_portfolios()

    assert _contar(entorno["dir"] / "principal.db", "gastos_rows") == 0
