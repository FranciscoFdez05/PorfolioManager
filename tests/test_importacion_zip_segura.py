"""Importar un ZIP no puede destruir la cartera ni tumbar el proceso.

Regresiones de la auditoría:

- «Importar ZIP» aceptaba cualquier SQLite en la raíz —una vacía incluida— y con
  ella sustituía la cartera activa, sin copia previa y sin cerrojo.
- Las tres rutas que abren ZIP subidos (importar, restaurar, importar cartera)
  descomprimían a memoria sin mirar el tamaño: 1 MB de ZIP con 1 GB de ceros
  llevaba el proceso a 2 GB.
"""

import io
import sqlite3
import zipfile

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, monkeypatch):
    """Ajustes + copias + carteras, con la cartera activa dentro de portfolios/."""
    from core import db
    from routes.ajustes import ajustesBp
    from routes.backup import backupBp
    from routes.portfolios import portfoliosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    # Sin índice, la primera consulta de carteras lo inicializaría y haría
    # una copia automática por el camino.
    datosAislados["meta"].write_text(
        '{"active": "principal", "legacyMigrated": true,'
        ' "portfolios": [{"id": "principal", "name": "Principal"}]}',
        "utf-8",
    )
    original = db.getActiveDbPath()
    activa = datosAislados["portfolios"] / "principal.db"
    db.setActiveDbPath(activa)
    conn = db.getDb()
    conn.execute("INSERT INTO activos (id, name, type) VALUES ('previo', 'Activo previo', 'acciones')")
    conn.commit()

    client, cabeceras, _app = clienteAutenticado(ajustesBp, backupBp, portfoliosBp)
    yield client, cabeceras, datosAislados

    db.resetDb()
    db.setActiveDbPath(original)
    db.invalidateAllConnections()


def _activos():
    from core.db import getDb

    return [fila[0] for fila in getDb().execute("SELECT id FROM activos ORDER BY id")]


def _zip(entradas):
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for nombre, contenido in entradas.items():
            zf.writestr(nombre, contenido)
    return buf.getvalue()


def _sqlite(ruta, conActivos=True):
    conn = sqlite3.connect(str(ruta))
    if conActivos:
        conn.execute("CREATE TABLE activos (id TEXT PRIMARY KEY, name TEXT, type TEXT)")
        conn.execute("INSERT INTO activos VALUES ('importado', 'Importado', 'acciones')")
    else:
        conn.execute("CREATE TABLE otra_cosa (x)")
    conn.commit()
    conn.close()
    return ruta.read_bytes()


def _subir(client, cabeceras, ruta, contenido, **campos):
    return client.post(
        ruta, data={"file": (io.BytesIO(contenido), "subida.zip"), **campos},
        headers=cabeceras, content_type="multipart/form-data",
    )


# ── Importar ZIP con una base en la raíz ─────────────────────────────────────

def testUnaSqliteVaciaNoSustituyeLaCartera(cliente, tmp_path):
    client, cabeceras, _rutas = cliente
    vacia = tmp_path / "vacia.db"
    sqlite3.connect(str(vacia)).close()

    r = _subir(client, cabeceras, "/api/import/zip", _zip({"portfolio-2026.db": vacia.read_bytes()}))

    assert r.status_code == 400
    assert _activos() == ["previo"]


def testUnaSqliteQueNoEsUnPortfolioSeRechaza(cliente, tmp_path):
    client, cabeceras, _rutas = cliente
    contenido = _sqlite(tmp_path / "otra.db", conActivos=False)

    r = _subir(client, cabeceras, "/api/import/zip", _zip({"portfolio-2026.db": contenido}))

    assert r.status_code == 400
    assert "no es un portfolio" in r.get_json()["error"]
    assert _activos() == ["previo"]


def testUnFicheroQueNoEsSqliteSeRechaza(cliente):
    client, cabeceras, _rutas = cliente

    r = _subir(client, cabeceras, "/api/import/zip", _zip({"portfolio-2026.db": b"no soy una base"}))

    assert r.status_code == 400
    assert _activos() == ["previo"]


def testUnaImportacionValidaDejaCopiaDelEstadoAnterior(cliente, tmp_path):
    client, cabeceras, rutas = cliente
    contenido = _sqlite(tmp_path / "buena.db")

    r = _subir(client, cabeceras, "/api/import/zip", _zip({"portfolio-2026.db": contenido}))

    assert r.status_code == 200, r.get_json()
    assert _activos() == ["importado"]
    copia = rutas["data"] / "pre_restore" / r.get_json()["copiaPrevia"] / "principal.db"
    with sqlite3.connect(str(copia)) as conn:
        assert [f[0] for f in conn.execute("SELECT id FROM activos")] == ["previo"]


def testSinCopiaPreviaNoSeImportaNada(cliente, tmp_path, monkeypatch):
    from routes import backup

    client, cabeceras, _rutas = cliente
    monkeypatch.setattr(backup, "_safetyCopyBeforeRestore", lambda: None)
    contenido = _sqlite(tmp_path / "buena.db")

    r = _subir(client, cabeceras, "/api/import/zip", _zip({"portfolio-2026.db": contenido}))

    assert r.status_code == 500
    assert _activos() == ["previo"]


def testUnAjustesJsonQueNoEsJsonNoSeEscribe(cliente):
    client, cabeceras, rutas = cliente

    r = _subir(client, cabeceras, "/api/import/zip", _zip({"ajustes.json": b"{roto"}))

    assert r.status_code == 400
    assert not rutas["ajustes"].exists()


def testImportarJsonTambienDejaCopiaPrevia(cliente):
    client, cabeceras, rutas = cliente

    r = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(b'{"tables": {"activos": []}}'), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )

    assert r.status_code == 200
    assert (rutas["data"] / "pre_restore" / r.get_json()["copiaPrevia"] / "principal.db").exists()


# ── Zip bombs ────────────────────────────────────────────────────────────────

@pytest.fixture
def limitesPequenos(monkeypatch):
    """Límites de unos pocos MB para no tener que fabricar gigas en un test."""
    from core import settings, zip_seguro

    monkeypatch.setattr(settings, "maxSubidaBytes", lambda: 1024 * 1024)  # total: 4 MB
    monkeypatch.setattr(zip_seguro, "_UMBRAL_PROPORCION", 1024 * 1024)
    monkeypatch.setattr(zip_seguro, "_MAX_EN_MEMORIA", 2 * 1024 * 1024)


def _bomba(nombre, megas=8):
    return _zip({nombre: b"\0" * (megas * 1024 * 1024)})


@pytest.mark.parametrize("ruta, nombre", [
    ("/api/import/zip", "portfolio-2026.db"),
    ("/api/import/zip", "export-2026.json"),
    ("/api/portfolios/import", "portfolios/otra.db"),
])
def testUnaBombaSeRechazaSinDescomprimirla(cliente, limitesPequenos, monkeypatch, ruta, nombre):
    client, cabeceras, _rutas = cliente
    # Si llegara a descomprimirse, testzip() sería lo primero en hacerlo.
    monkeypatch.setattr(zipfile.ZipFile, "testzip", lambda self: pytest.fail("se descomprimió"))

    r = _subir(client, cabeceras, ruta, _bomba(nombre), name="Bomba")

    assert r.status_code == 400
    assert _activos() == ["previo"]


def testLaRestauracionRechazaUnaBomba(cliente, limitesPequenos):
    client, cabeceras, rutas = cliente
    contenido = _zip({"portfolios/principal.db": b"\0" * (8 * 1024 * 1024), "portfolios.json": b"{}"})
    (rutas["backups"] / "backup_01-01-2026_00-00-00.zip").write_bytes(contenido)

    r = client.post("/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"}, headers=cabeceras)

    assert r.status_code == 400
    assert _activos() == ["previo"]


def testComprobarAdmiteUnZipNormalYRechazaLaProporcionAnomala(limitesPequenos):
    from core import zip_seguro

    with zipfile.ZipFile(io.BytesIO(_zip({"a.json": b'{"x": 1}' * 1000})), "r") as zf:
        zip_seguro.comprobar(zf)

    with zipfile.ZipFile(io.BytesIO(_bomba("a.db", megas=2)), "r") as zf, \
            pytest.raises(zip_seguro.ZipNoAdmitido, match="compresión anómala"):
        zip_seguro.comprobar(zf)
