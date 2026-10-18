"""El portfolio activo tiene que ser el mismo en todos los procesos.

Regresión: cada worker de gunicorn guardaba su propia copia de la BD activa en
una global de core/db.py. `switchPortfolio` solo actualizaba la del proceso que
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
    monkeypatch.setattr("admin.backup_manager.runStartupBackup", lambda *a, **k: None)

    pm.initPortfolios()
    otra = pm.createPortfolio("Otra")
    return {"pm": pm, "meta": meta, "otra": otra}


def _cambioDesdeOtroProceso(meta, activo):
    """Lo que hace switchPortfolio en el OTRO worker: solo toca el fichero."""
    datos = json.loads(meta.read_text("utf-8"))
    datos["active"] = activo
    meta.write_text(json.dumps(datos), "utf-8")
    # Garantiza una firma distinta aunque el sistema de ficheros tenga una
    # resolución de mtime gruesa.
    st = meta.stat()
    os.utime(meta, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))


def testUnCambioHechoPorOtroProcesoSeVeAqui(entorno):
    from core.db import getActiveDbPath

    assert getActiveDbPath().stem == "principal"

    _cambioDesdeOtroProceso(entorno["meta"], entorno["otra"])

    assert getActiveDbPath().stem == entorno["otra"]


def testLasEscriturasVanAlPortfolioQueOtroProcesoActivo(entorno):
    from core.db import getDb

    getDb()  # principal ya abierta y con esquema, como en un servidor en marcha
    _cambioDesdeOtroProceso(entorno["meta"], entorno["otra"])
    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, type) VALUES ('x', 'Escrito tras el cambio', 'acciones')")
    conn.commit()

    import sqlite3

    rutaOtra = entorno["pm"]._portfolioDbPath(entorno["otra"])
    rutaPrincipal = entorno["pm"]._portfolioDbPath("principal")
    with sqlite3.connect(rutaOtra) as c:
        assert c.execute("SELECT COUNT(*) FROM activos WHERE id = 'x'").fetchone()[0] == 1
    with sqlite3.connect(rutaPrincipal) as c:
        assert c.execute("SELECT COUNT(*) FROM activos WHERE id = 'x'").fetchone()[0] == 0


def testSinCambiosNoSeReleeElFichero(entorno, monkeypatch):
    from core.db import getActiveDbPath

    # createPortfolio (en el fixture) acaba de reescribir el fichero: esa
    # primera relectura es legítima. Lo que no debe haber es una por llamada.
    getActiveDbPath()
    lecturas = []
    original = entorno["pm"]._readMeta
    monkeypatch.setattr(entorno["pm"], "_readMeta", lambda: lecturas.append(1) or original())

    for _ in range(20):
        getActiveDbPath()

    assert lecturas == []


def testUnActivoInvalidoOInexistenteNoCambiaNada(entorno):
    from core.db import getActiveDbPath

    _cambioDesdeOtroProceso(entorno["meta"], "../fuera")
    assert getActiveDbPath().stem == "principal"

    _cambioDesdeOtroProceso(entorno["meta"], "no_existe")
    assert getActiveDbPath().stem == "principal"


def testElCambioPropioNoRebota(entorno):
    from core.db import getActiveDbPath

    entorno["pm"].switchPortfolio(entorno["otra"])
    assert getActiveDbPath().stem == entorno["otra"]
    entorno["pm"].switchPortfolio("principal")
    assert getActiveDbPath().stem == "principal"
