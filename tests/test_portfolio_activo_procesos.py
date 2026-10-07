"""El portfolio activo tiene que ser el mismo en todos los procesos.

Regresión: cada worker de gunicorn guardaba su propia copia de la BD activa en
una global de core/db.py. `switch_portfolio` solo actualizaba la del proceso que
atendía la petición, así que el otro worker seguía leyendo y ESCRIBIENDO en el
portfolio anterior: la cabecera decía «Otra» y el movimiento acababa en
«Principal». Aquí se simula el otro proceso escribiendo portfolios.json igual
que lo haría él.
"""

import json
import os

import pytest


@pytest.fixture
def entorno(tmp_path, monkeypatch):
    from admin import portfolios_manager as pm

    directorio = tmp_path / "portfolios"
    directorio.mkdir()
    meta = tmp_path / "portfolios.json"

    monkeypatch.setattr(pm, "_PORTFOLIOS_DIR", directorio)
    monkeypatch.setattr(pm, "_LEGACY_DB", tmp_path / "portfolio.db")
    monkeypatch.setattr(pm, "_META_FILE", meta)
    monkeypatch.setattr("admin.backup_manager.run_startup_backup", lambda *a, **k: None)

    pm.init_portfolios()
    otra = pm.create_portfolio("Otra")
    return {"pm": pm, "meta": meta, "otra": otra}


def _cambio_desde_otro_proceso(meta, activo):
    """Lo que hace switch_portfolio en el OTRO worker: solo toca el fichero."""
    datos = json.loads(meta.read_text("utf-8"))
    datos["active"] = activo
    meta.write_text(json.dumps(datos), "utf-8")
    # Garantiza una firma distinta aunque el sistema de ficheros tenga una
    # resolución de mtime gruesa.
    st = meta.stat()
    os.utime(meta, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


def test_un_cambio_hecho_por_otro_proceso_se_ve_aqui(entorno):
    from core.db import get_active_db_path

    assert get_active_db_path().stem == "principal"

    _cambio_desde_otro_proceso(entorno["meta"], entorno["otra"])

    assert get_active_db_path().stem == entorno["otra"]


def test_las_escrituras_van_al_portfolio_que_otro_proceso_activo(entorno):
    from core.db import get_db

    get_db()  # principal ya abierta y con esquema, como en un servidor en marcha
    _cambio_desde_otro_proceso(entorno["meta"], entorno["otra"])
    conn = get_db()
    conn.execute("INSERT INTO activos (id, name, type) VALUES ('x', 'Escrito tras el cambio', 'acciones')")
    conn.commit()

    import sqlite3

    ruta_otra = entorno["pm"]._portfolio_db_path(entorno["otra"])
    ruta_principal = entorno["pm"]._portfolio_db_path("principal")
    with sqlite3.connect(ruta_otra) as c:
        assert c.execute("SELECT COUNT(*) FROM activos WHERE id = 'x'").fetchone()[0] == 1
    with sqlite3.connect(ruta_principal) as c:
        assert c.execute("SELECT COUNT(*) FROM activos WHERE id = 'x'").fetchone()[0] == 0


def test_sin_cambios_no_se_relee_el_fichero(entorno, monkeypatch):
    from core.db import get_active_db_path

    # create_portfolio (en el fixture) acaba de reescribir el fichero: esa
    # primera relectura es legítima. Lo que no debe haber es una por llamada.
    get_active_db_path()
    lecturas = []
    original = entorno["pm"]._read_meta
    monkeypatch.setattr(entorno["pm"], "_read_meta", lambda: lecturas.append(1) or original())

    for _ in range(20):
        get_active_db_path()

    assert lecturas == []


def test_un_activo_invalido_o_inexistente_no_cambia_nada(entorno):
    from core.db import get_active_db_path

    _cambio_desde_otro_proceso(entorno["meta"], "../fuera")
    assert get_active_db_path().stem == "principal"

    _cambio_desde_otro_proceso(entorno["meta"], "no_existe")
    assert get_active_db_path().stem == "principal"


def test_el_cambio_propio_no_rebota(entorno):
    from core.db import get_active_db_path

    entorno["pm"].switch_portfolio(entorno["otra"])
    assert get_active_db_path().stem == entorno["otra"]
    entorno["pm"].switch_portfolio("principal")
    assert get_active_db_path().stem == "principal"
