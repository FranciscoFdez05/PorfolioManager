"""Pruebas de /api/backup, /api/backups y /api/restore.

Restaurar es la operación más destructiva de la aplicación: sobrescribe todas
las bases de datos de portfolios, portfolios.json, ajustes.json y las
preferencias. Un fallo aquí no da un error en pantalla, se lleva por delante el
histórico completo del usuario. Estos tests cubren sobre todo lo que tiene que
pasar **cuando algo va mal**: nombre manipulado, zip corrupto, entradas con
rutas de escape, y la copia de seguridad previa que permite dar marcha atrás.

Ningún caso toca `data/`: el fixture `datosAislados` redirige a tmp_path todos
los directorios que usan estas rutas.
"""

import io
import json
import sqlite3
import zipfile
from pathlib import Path

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, monkeypatch):
    """Cliente con sesión + directorios de datos aislados + límites amplios."""
    from routes.backup import backupBp

    # El cupo de rutas pesadas es 30/hora en producción; varios tests hacen más
    # de una copia seguida y el 429 no es lo que quieren comprobar.
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")

    client, cabeceras, _app = clienteAutenticado(backupBp)
    return client, cabeceras, datosAislados


def _crearDb(ruta, filas=()):
    """Base SQLite mínima con la tabla que lee y restaura el módulo de backup."""
    conn = sqlite3.connect(str(ruta))
    conn.execute(
        "CREATE TABLE IF NOT EXISTS portfolio_snapshots ("
        " ts TEXT PRIMARY KEY, total_value REAL, total_invested REAL)"
    )
    conn.executemany(
        "INSERT OR REPLACE INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?,?,?)",
        filas,
    )
    conn.commit()
    conn.close()
    return ruta


def _snapshots(ruta):
    conn = sqlite3.connect(str(ruta))
    try:
        return [tuple(fila) for fila in conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts"
        )]
    finally:
        conn.close()


# ── Crear ────────────────────────────────────────────────────────────────────

def testCrearBackupEmpaquetaPortfoliosAjustesYManifest(cliente):
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])
    _crearDb(rutas["portfolios"] / "cripto.db", [("2026-01-02", 50.0, 40.0)])
    rutas["meta"].write_text(json.dumps({"active": "principal"}), encoding="utf-8")
    rutas["ajustes"].write_text(json.dumps({"maxBackups": 0}), encoding="utf-8")
    (rutas["json"] / "prefs_principal.json").write_text("{}", encoding="utf-8")

    respuesta = client.post("/api/backup", headers=cabeceras)
    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True

    with zipfile.ZipFile(rutas["backups"] / datos["filename"]) as zf:
        nombres = set(zf.namelist())
        manifest = json.loads(zf.read("manifest.json"))

    assert {"portfolios/principal.db", "portfolios/cripto.db"} <= nombres
    assert {"portfolios.json", "ajustes.json", "prefs/prefs_principal.json"} <= nombres
    # El JSON de snapshots es la red de seguridad si el .db llega ilegible.
    assert {"snapshots/principal.json", "snapshots/cripto.json"} <= nombres
    assert sorted(manifest["portfolios"]) == ["cripto", "principal"]


def testElBackupRecienCreadoApareceElPrimeroEnLaLista(cliente):
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    listado = client.get("/api/backups").get_json()["backups"]

    assert listado[0] == nombre


def testMaxBackupsBorraLosViejosPeroNuncaElRecienCreado(cliente):
    """El caso que hay que evitar: crear una copia y que la poda se la lleve."""
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")
    rutas["ajustes"].write_text(json.dumps({"maxBackups": 2}), encoding="utf-8")

    for viejo in ("backup_01-01-2020_00-00-00.zip", "backup_02-01-2020_00-00-00.zip",
                  "backup_03-01-2020_00-00-00.zip"):
        (rutas["backups"] / viejo).write_bytes(b"PK\x05\x06" + b"\x00" * 18)

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    restantes = client.get("/api/backups").get_json()["backups"]

    assert len(restantes) == 2
    assert nombre in restantes


def testUnZipAMedioEscribirNoQuedaEnElListado(cliente):
    """El temporal `_tmp_backup_*.zip` no encaja con el patrón de nombres."""
    client, _cabeceras, rutas = cliente
    (rutas["backups"] / "_tmp_backup_01-01-2026_00-00-00.zip").write_bytes(b"a medias")

    assert client.get("/api/backups").get_json()["backups"] == []


def testLasCopiasTemporalesNoSeDejanCaerEnPortfolios(cliente):
    """El .db temporal de cada copia va a data/tmp, no junto a los portfolios.

    En data/portfolios lo veía como un portfolio más cualquier `glob("*.db")`:
    la rotación de copias automáticas, el scheduler de snapshots y el listado de
    portfolios. Con un solo proceso la ventana era estrecha; con los dos workers
    y cuatro hilos de gunicorn del contenedor, no.
    """
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])

    assert client.post("/api/backup", headers=cabeceras).get_json()["ok"] is True

    assert sorted(p.name for p in rutas["portfolios"].iterdir()) == ["principal.db"]
    # Y el temporal tampoco se queda: ni el .db ni sus sidecars -wal/-shm. El
    # único fichero que sí es normal encontrar aquí es el lock entre procesos
    # que comparte con la copia automática del scheduler (admin.backup_manager):
    # no es un temporal a medio escribir, vive todo lo que vive el proceso.
    restantes = [p.name for p in (rutas["data"] / "tmp").iterdir()]
    assert restantes == ["backup-automatico.lock"]


def testUnFalloDePermisosSeDevuelveConSuCausa(cliente, monkeypatch):
    """El caso de Docker: el volumen montado no deja escribir.

    Antes salía un 500 con `str(e)` a secas —o el "Error interno del servidor"
    del manejador genérico— y en pantalla un "Error al crear backup" que no
    distinguía entre permisos, disco lleno y base de datos bloqueada.
    """
    import errno

    from routes import backup as rutasBackup

    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    def _denegado(*_args, **_kwargs):
        raise PermissionError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(rutasBackup.zipfile, "ZipFile", _denegado)

    respuesta = client.post("/api/backup", headers=cabeceras)
    datos = respuesta.get_json()

    assert respuesta.status_code == 500
    assert datos["ok"] is False
    assert "permiso de escritura" in datos["error"]
    # La ruta concreta es la mitad del diagnóstico: dice qué volumen mirar.
    assert str(rutas["backups"]) in datos["error"]


def testUnPortfolioDanadoNoSeCopiaYSeDiceQueFalla(cliente):
    """La copia comprueba la integridad de cada portfolio antes de meterlo en el
    zip; el error dice cuál y por qué, y no queda ningún zip a medias."""
    client, cabeceras, rutas = cliente
    ruta = _crearDb(rutas["portfolios"] / "principal.db")
    conn = sqlite3.connect(str(ruta))
    conn.executescript(
        "CREATE TABLE activos (id TEXT PRIMARY KEY);"
        "CREATE TABLE activo_rows (id INTEGER PRIMARY KEY, activo TEXT REFERENCES activos(id));"
        "INSERT INTO activo_rows (activo) VALUES ('fantasma');"
    )
    conn.close()

    respuesta = client.post("/api/backup", headers=cabeceras)
    datos = respuesta.get_json()

    assert respuesta.status_code == 500
    assert "principal.db no pasa la comprobación de integridad" in datos["error"]
    assert "activo_rows" in datos["error"]
    assert list(rutas["backups"].glob("*.zip")) == []


def testNoSeEmpiezaElZipSiElDestinoNoEsEscribible(cliente, monkeypatch):
    """La comprobación va antes de tocar nada, para no dejar un zip a medias."""
    from core import paths
    from routes import backup as rutasBackup

    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    monkeypatch.setattr(
        paths, "comprobarEscritura",
        lambda directorio, crear=True: (False, "Read-only file system"),
    )
    monkeypatch.setattr(rutasBackup, "paths", paths)

    respuesta = client.post("/api/backup", headers=cabeceras)
    datos = respuesta.get_json()

    assert respuesta.status_code == 500
    assert "Read-only file system" in datos["error"]
    assert not any(rutas["backups"].iterdir())


# ── Restaurar: rechazos ──────────────────────────────────────────────────────

@pytest.mark.parametrize("nombre", [
    "../../.env",
    "..\\..\\data\\portfolio.db",
    "/etc/passwd",
    "backup.zip",                        # sin marca de tiempo
    "portfolio_2026-01-01.db",           # formato de fecha que no es el suyo
    "backup_01-01-2026_00-00-00.zip.bak",
    "",
])
def testRestoreRechazaNombresQueNoSonDeUnBackup(cliente, nombre):
    """El nombre viene del cuerpo JSON: es entrada de usuario, no una ruta."""
    client, cabeceras, _rutas = cliente
    respuesta = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testRestoreDeUnBackupInexistenteEs404(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"}, headers=cabeceras,
    )
    assert respuesta.status_code == 404


def testUnZipCorruptoSeRechazaAntesDeTocarNada(cliente):
    """Abortar a mitad dejaría parte de los portfolios ya sobrescritos."""
    client, cabeceras, rutas = cliente
    original = _crearDb(rutas["portfolios"] / "principal.db", [("2026-06-01", 999.0, 888.0)])
    (rutas["backups"] / "backup_01-01-2026_00-00-00.zip").write_bytes(b"esto no es un zip")

    respuesta = client.post(
        "/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"}, headers=cabeceras,
    )

    assert respuesta.status_code == 400
    # La base activa sigue intacta: es lo único que importa de este test.
    assert _snapshots(original) == [("2026-06-01", 999.0, 888.0)]


def testRestoreSinSesionEs401(crearApp, datosAislados):
    """La ruta más destructiva no puede quedar detrás de una comprobación floja."""
    from routes.backup import backupBp

    client = crearApp(backupBp).test_client()
    respuesta = client.post("/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"})
    assert respuesta.status_code == 401


def testRestoreConSesionPeroSinCsrfEs403(clienteAutenticado, datosAislados):
    from routes.backup import backupBp

    client, _cabeceras, _app = clienteAutenticado(backupBp)
    respuesta = client.post("/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"})
    assert respuesta.status_code == 403


# ── Restaurar: entradas maliciosas dentro del zip ────────────────────────────

def testUnaEntradaConRutaDeEscapeNoSaleDelDirectorio(cliente, tmp_path):
    """`portfolios/../../../../evil.db` no debe escribir fuera de data/portfolios."""
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")
    fuera = tmp_path / "evil.db"

    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/../../../../evil.db", b"SQLite format 3\x00" + b"\x00" * 100)

    respuesta = client.post(
        "/api/restore", json={"filename": rutaZip.name}, headers=cabeceras,
    )

    assert respuesta.status_code == 200
    assert not fuera.exists()
    assert not (rutas["data"] / "evil.db").exists()
    # `Path(name).name` deja "evil.db": el ../ se descarta y el fichero solo
    # puede aterrizar dentro de data/portfolios, nunca fuera.
    assert not any(p.name == "evil.db" for p in rutas["data"].rglob("evil.db")
                   if p.parent != rutas["portfolios"])


def testUnaEntradaDanadaNoTumbaElRestoDeLaRestauracion(cliente):
    """Los 16 bytes de cabecera SQLite se pueden acertar con basura detrás.

    Antes, esa entrada lanzaba desde `_sqlite_copy` y abortaba el restore
    entero: los portfolios ya procesados quedaban mezclados con los que aún no
    se habían tocado, y la respuesta era un 500 sin decir cuál falló.
    """
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")
    _crearDb(rutas["portfolios"] / "cripto.db")

    bueno = _crearDb(rutas["data"] / "bueno.db", [("2026-01-01", 5.0, 4.0)])
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/cripto.db", b"SQLite format 3\x00" + b"basura" * 50)
        zf.writestr("portfolios/principal.db", bueno.read_bytes())

    datos = client.post(
        "/api/restore", json={"filename": rutaZip.name}, headers=cabeceras,
    ).get_json()

    assert datos["ok"] is True
    # El portfolio sano se restaura aunque el otro venga roto.
    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-01-01", 5.0, 4.0)]
    # Y la respuesta dice exactamente cuál se quedó fuera.
    assert any("cripto.db" in aviso for aviso in datos["ignorados"])


def testUnaEntradaQueNoEsSqliteSeIgnora(cliente):
    """Escribir esos bytes como .db dejaría el portfolio ilegible."""
    client, cabeceras, rutas = cliente
    original = _crearDb(rutas["portfolios"] / "principal.db", [("2026-06-01", 10.0, 5.0)])

    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", b"<html>no soy una base de datos</html>")

    respuesta = client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert _snapshots(original) == [("2026-06-01", 10.0, 5.0)]


def testUnNombreDePrefsManipuladoSeIgnora(cliente):
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("prefs/ajustes.json", b'{"robado": true}')
        zf.writestr("prefs/prefs_principal.json", b'{"tema": "oscuro"}')

    client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras)

    # `ajustes.json` no encaja con prefs_<id>.json: se ignora, y el ajustes.json
    # global no se toca desde una entrada de prefs.
    assert not (rutas["json"] / "ajustes.json").exists()
    assert json.loads((rutas["json"] / "prefs_principal.json").read_text()) == {"tema": "oscuro"}


# ── Restaurar: el índice de portfolios ───────────────────────────────────────
#
# `portfolios.json` es el único contenido del zip que acaba usándose como ruta:
# de su campo `active` sale el nombre del fichero .db que la aplicación abrirá.
# Los .db y los prefs se filtran por nombre desde el principio; el índice no lo
# hacía, y desde que «Importar ZIP» acepta un archivo subido su contenido puede
# venir de fuera de esta instalación.

def _zipConIndice(rutas, indice):
    origen = _crearDb(rutas["data"] / "origen.db", [("2026-01-01", 1.0, 1.0)])
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())
        zf.writestr("portfolios.json", indice)
    return rutaZip


@pytest.mark.parametrize("active", [
    "../../../../tmp/principal",     # sale del directorio de datos
    "..",
    "principal/../otro",
    "Principal",                     # el alfabeto de un id es en minúsculas
    "con espacio",
])
def testUnPortfolioActivoManipuladoNoSeRestaura(cliente, active):
    """El id del activo decide qué fichero se abre: si no es un id, no entra.

    Un `active` como '../../../tmp/principal' dejaba la base activa fuera del
    volumen de datos, y el valor se persistía: el desvío sobrevivía a cada
    arranque, mientras los backups seguían mirando data/portfolios.
    """
    client, cabeceras, rutas = cliente
    rutas["meta"].write_text(json.dumps({"active": "principal",
                                         "portfolios": [{"id": "principal", "name": "P"}]}))
    rutaZip = _zipConIndice(rutas, json.dumps({
        "active": active,
        "portfolios": [{"id": "principal", "name": "P"}],
    }))

    datos = client.post("/api/restore", json={"filename": rutaZip.name},
                        headers=cabeceras).get_json()

    assert json.loads(rutas["meta"].read_text())["active"] == "principal"
    assert any("portfolios.json" in entrada for entrada in datos["ignorados"]), (
        "restaurar a medias sin decirlo es peor que no restaurar"
    )


def testUnIdManipuladoEnLaListaTampocoPasa(cliente):
    """No solo `active`: de cada id de la lista sale también un nombre de fichero."""
    client, cabeceras, rutas = cliente
    rutas["meta"].write_text(json.dumps({"active": "principal", "portfolios": []}))
    rutaZip = _zipConIndice(rutas, json.dumps({
        "active": "principal",
        "portfolios": [{"id": "../../otro", "name": "P"}],
    }))

    client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras)

    assert json.loads(rutas["meta"].read_text())["portfolios"] == []


@pytest.mark.parametrize("crudo", [b"no soy json", b"[]", b'"principal"', b"\xff\xfe"])
def testUnIndiceIlegibleSeIgnoraYSeDice(cliente, crudo):
    client, cabeceras, rutas = cliente
    rutas["meta"].write_text(json.dumps({"active": "principal", "portfolios": []}))
    origen = _crearDb(rutas["data"] / "origen.db", [("2026-01-01", 1.0, 1.0)])
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())
        zf.writestr("portfolios.json", crudo)

    datos = client.post("/api/restore", json={"filename": rutaZip.name},
                        headers=cabeceras).get_json()

    assert json.loads(rutas["meta"].read_text())["active"] == "principal"
    assert any("portfolios.json" in entrada for entrada in datos["ignorados"])


def testUnIndiceCorrectoSeRestauraEntero(cliente):
    """La validación no puede volverse una excusa para no restaurar lo bueno."""
    client, cabeceras, rutas = cliente
    rutaZip = _zipConIndice(rutas, json.dumps({
        "active": "otro-2",
        "portfolios": [{"id": "principal", "name": "P"}, {"id": "otro-2", "name": "Otro"}],
    }))

    datos = client.post("/api/restore", json={"filename": rutaZip.name},
                        headers=cabeceras).get_json()

    assert json.loads(rutas["meta"].read_text())["active"] == "otro-2"
    assert not [e for e in datos["ignorados"] if "portfolios.json" in e]


# ── Restaurar: camino feliz ──────────────────────────────────────────────────

def testRestoreDevuelveLosDatosDelBackup(cliente):
    client, cabeceras, rutas = cliente
    # Estado actual, que el restore debe sustituir.
    _crearDb(rutas["portfolios"] / "principal.db", [("2026-06-01", 999.0, 888.0)])

    origen = _crearDb(rutas["data"] / "origen.db", [("2026-01-01", 100.0, 90.0)])
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())
        zf.writestr("portfolios.json", json.dumps({"active": "principal",
                                                   "portfolios": [{"id": "principal", "name": "P"}]}))
        zf.writestr("ajustes.json", json.dumps({"maxBackups": 7}))

    respuesta = client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-01-01", 100.0, 90.0)]
    assert json.loads(rutas["ajustes"].read_text())["maxBackups"] == 7
    assert json.loads(rutas["meta"].read_text())["active"] == "principal"


def testRestoreGuardaUnaCopiaDelEstadoPrevio(cliente):
    """Sin esto, restaurar el backup equivocado es irreversible."""
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db", [("2026-06-01", 999.0, 888.0)])

    origen = _crearDb(rutas["data"] / "origen.db", [("2026-01-01", 1.0, 1.0)])
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())

    datos = client.post(
        "/api/restore", json={"filename": rutaZip.name}, headers=cabeceras,
    ).get_json()

    from pathlib import Path
    copia = Path(datos["safetyCopy"])
    assert copia.is_dir()
    # Lo que había antes del restore sigue recuperable byte a byte.
    assert _snapshots(copia / "principal.db") == [("2026-06-01", 999.0, 888.0)]


def testLaCopiaPreviaAlRestoreGuardaTambienLasPreferencias(cliente):
    """Las preferencias llevan los paneles: el restore las pisa como a los .db,
    así que la copia previa tiene que poder devolverlas también."""
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")
    actuales = {"panelesConfig": {"activo": "p1", "paneles": [{"id": "p1", "nombre": "Mío", "widgets": []}]}}
    (rutas["json"] / "prefs_principal.json").write_text(json.dumps(actuales), encoding="utf-8")

    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", _crearDb(rutas["data"] / "origen.db").read_bytes())
        zf.writestr("prefs/prefs_principal.json", json.dumps({"panelesConfig": {}}))

    datos = client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras).get_json()

    copia = Path(datos["safetyCopy"])
    assert json.loads((copia / "prefs_principal.json").read_text("utf-8")) == actuales


def testLosSnapshotsSeRecuperanDelJsonSiElDbLlegaSinEllos(cliente):
    """El .db puede venir de una versión anterior sin esa tabla poblada."""
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    vacio = _crearDb(rutas["data"] / "vacio.db")
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", vacio.read_bytes())
        zf.writestr("snapshots/principal.json", json.dumps(
            [{"ts": "2026-03-01", "v": 42.0, "i": 40.0}]
        ))

    client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras)

    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-03-01", 42.0, 40.0)]


def testLosSnapshotsDelJsonNoPisanLosQueYaTraeElDb(cliente):
    """El JSON es un plan B, no la fuente principal."""
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    origen = _crearDb(rutas["data"] / "origen.db", [("2026-05-05", 7.0, 6.0)])
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())
        zf.writestr("snapshots/principal.json", json.dumps(
            [{"ts": "1999-01-01", "v": 0.0, "i": 0.0}]
        ))

    client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras)

    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-05-05", 7.0, 6.0)]


def testRestaurarDejaLaBaseSinFicherosWalHuerfanos(cliente):
    """Un -wal viejo se re-aplicaría sobre la base restaurada y la corrompería."""
    client, cabeceras, rutas = cliente
    destino = _crearDb(rutas["portfolios"] / "principal.db")
    from pathlib import Path
    Path(str(destino) + "-wal").write_bytes(b"wal de la base anterior")

    origen = _crearDb(rutas["data"] / "origen.db", [("2026-01-01", 1.0, 1.0)])
    rutaZip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(rutaZip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())

    client.post("/api/restore", json={"filename": rutaZip.name}, headers=cabeceras)

    assert not Path(str(destino) + "-wal").exists()
    # Y ningún temporal del proceso de restauración se queda por el medio.
    assert not list(rutas["portfolios"].glob("_restore_tmp_*"))


# ── Borrar ───────────────────────────────────────────────────────────────────

def testNoSePuedeBorrarElUnicoBackup(cliente):
    """Es la única red de seguridad frente a una corrupción o un borrado."""
    client, cabeceras, rutas = cliente
    unico = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    unico.write_bytes(b"PK\x05\x06" + b"\x00" * 18)

    respuesta = client.delete(f"/api/backups/{unico.name}", headers=cabeceras)

    assert respuesta.status_code == 400
    assert unico.exists()


def testBorrarConMasDeUnoFunciona(cliente):
    client, cabeceras, rutas = cliente
    for nombre in ("backup_01-01-2026_00-00-00.zip", "backup_02-01-2026_00-00-00.zip"):
        (rutas["backups"] / nombre).write_bytes(b"PK\x05\x06" + b"\x00" * 18)

    respuesta = client.delete("/api/backups/backup_01-01-2026_00-00-00.zip", headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["backups"] == ["backup_02-01-2026_00-00-00.zip"]
    assert not (rutas["backups"] / "backup_01-01-2026_00-00-00.zip").exists()


@pytest.mark.parametrize("nombre", ["..%2F..%2F.env", "cualquiera.zip", "backup_.zip"])
def testBorrarRechazaNombresQueNoSonDeUnBackup(cliente, nombre):
    client, cabeceras, _rutas = cliente
    respuesta = client.delete(f"/api/backups/{nombre}", headers=cabeceras)
    assert respuesta.status_code in (400, 404)


def testUnaCopiaTemporalAbandonadaSeBarreEnLaSiguiente(cliente):
    """Si el contenedor muere a media copia, el temporal no se queda para siempre."""
    import os
    import time

    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    tmp = rutas["data"] / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    huerfano = tmp / "_bak_999_1_principal.db"
    huerfano.write_bytes(b"copia a medias")
    viejo = time.time() - 7200
    os.utime(huerfano, (viejo, viejo))

    reciente = tmp / "_bak_999_2_principal.db"
    reciente.write_bytes(b"de otro worker que sigue vivo")

    assert client.post("/api/backup", headers=cabeceras).get_json()["ok"] is True

    assert not huerfano.exists()
    assert reciente.exists()


# ── Importar un backup desde Ajustes ─────────────────────────────────────────

@pytest.fixture
def clienteCompleto(clienteAutenticado, datosAislados, monkeypatch):
    """Cliente con los dos blueprints: el mismo zip entra por Ajustes y por copias."""
    from routes.ajustes import ajustesBp
    from routes.backup import backupBp

    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")

    client, cabeceras, _app = clienteAutenticado(backupBp, ajustesBp)
    return client, cabeceras, datosAislados


def testImportarUnZipDeBackupRestauraLasBasesDeDatos(clienteCompleto):
    """El fallo que se veía en producción.

    «Importar ZIP» buscaba el `.db` en la raíz del zip. Una copia de seguridad lo
    lleva bajo `portfolios/`, así que no encontraba ninguno, restauraba solo los
    ajustes y respondía que todo había ido bien: la pantalla decía «importado» y
    las carteras seguían exactamente como estaban.
    """
    client, cabeceras, rutas = clienteCompleto
    _crearDb(rutas["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])
    _crearDb(rutas["portfolios"] / "cripto.db", [("2026-01-02", 50.0, 40.0)])
    rutas["meta"].write_text(json.dumps({"active": "principal"}), encoding="utf-8")

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    contenido = (rutas["backups"] / nombre).read_bytes()

    # Los datos cambian después de la copia: si la importación funciona, vuelven.
    _crearDb(rutas["portfolios"] / "principal.db", [("2030-12-31", 1.0, 1.0)])
    (rutas["portfolios"] / "cripto.db").unlink()

    respuesta = client.post(
        "/api/import/zip",
        data={"file": (io.BytesIO(contenido), nombre)},
        headers=cabeceras,
        content_type="multipart/form-data",
    )

    assert respuesta.status_code == 200, respuesta.get_json()
    assert respuesta.get_json()["ok"] is True
    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-01-01", 100.0, 90.0)]
    assert (rutas["portfolios"] / "cripto.db").exists()
    assert _snapshots(rutas["portfolios"] / "cripto.db") == [("2026-01-02", 50.0, 40.0)]


def testImportarUnBackupDejaCopiaPrevia(clienteCompleto):
    """Sobrescribe todas las carteras, así que vale la misma red que /api/restore."""
    client, cabeceras, rutas = clienteCompleto
    _crearDb(rutas["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    contenido = (rutas["backups"] / nombre).read_bytes()

    datos = client.post(
        "/api/import/zip",
        data={"file": (io.BytesIO(contenido), nombre)},
        headers=cabeceras,
        content_type="multipart/form-data",
    ).get_json()

    assert datos["safetyCopy"]
    assert (Path(datos["safetyCopy"]) / "principal.db").exists()


_PANELES = {
    "activo": "p1",
    "paneles": [
        {"id": "p1", "nombre": "Research", "cfg": {"fila": "44"}, "widgets": [
            {"id": "w1", "tipo": "mapa", "w": 8, "h": 7, "cfg": {"periodo": "mes"}},
            {"id": "w2", "tipo": "grafico", "w": 4, "h": 7, "cfg": {"activo": "tk|NASDAQ:AMD|AMD|acciones"}},
        ]},
    ],
}


def _prepararPortfolio(rutas):
    _crearDb(rutas["portfolios"] / "principal.db")
    rutas["meta"].write_text(
        json.dumps({"active": "principal", "portfolios": [{"id": "principal", "name": "P"}]}),
        encoding="utf-8",
    )


def testLosPanelesVuelvenAlRestaurarUnaCopia(clienteCompleto):
    """Los paneles viven en prefs_<id>.json: la copia los lleva y el restore los
    devuelve, aunque después de la copia se hayan cambiado o borrado."""
    client, cabeceras, rutas = clienteCompleto
    _prepararPortfolio(rutas)
    client.post("/api/settings", json={"panelesConfig": _PANELES}, headers=cabeceras)

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    with zipfile.ZipFile(rutas["backups"] / nombre) as zf:
        assert json.loads(zf.read("prefs/prefs_principal.json"))["panelesConfig"] == _PANELES

    client.post("/api/settings", json={"panelesConfig": {"activo": "", "paneles": []}}, headers=cabeceras)
    assert client.get("/api/settings").get_json()["panelesConfig"]["paneles"] == []

    respuesta = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)

    assert respuesta.status_code == 200, respuesta.get_json()
    assert client.get("/api/settings").get_json()["panelesConfig"] == _PANELES


def testLosPanelesVuelvenAlImportarElZipDeUnaCopia(clienteCompleto):
    """Lo mismo por «Importar ZIP» de Ajustes, que es otra puerta de entrada."""
    client, cabeceras, rutas = clienteCompleto
    _prepararPortfolio(rutas)
    client.post("/api/settings", json={"panelesConfig": _PANELES}, headers=cabeceras)
    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    contenido = (rutas["backups"] / nombre).read_bytes()
    client.post("/api/settings", json={"panelesConfig": {"activo": "", "paneles": []}}, headers=cabeceras)

    respuesta = client.post(
        "/api/import/zip",
        data={"file": (io.BytesIO(contenido), nombre)},
        headers=cabeceras,
        content_type="multipart/form-data",
    )

    assert respuesta.status_code == 200, respuesta.get_json()
    assert client.get("/api/settings").get_json()["panelesConfig"] == _PANELES


def testUnZipSinNadaReconocibleSeRechaza(clienteCompleto):
    """Antes respondía «ok» sin haber importado nada."""
    client, cabeceras, _rutas = clienteCompleto
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("cualquier-cosa.txt", b"nada que ver")
    buf.seek(0)

    respuesta = client.post(
        "/api/import/zip",
        data={"file": (buf, "cosas.zip")},
        headers=cabeceras,
        content_type="multipart/form-data",
    )

    assert respuesta.status_code == 400
    assert "no contiene" in respuesta.get_json()["error"]


# ── Avisos por Telegram ──────────────────────────────────────────────────────

@pytest.fixture
def telegram(datosAislados, monkeypatch):
    """Telegram configurado sobre las rutas aisladas; devuelve lo que se enviaría."""
    from core import telegram_notifier

    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    yield mensajes
    telegram_notifier.reiniciarParaPruebas()


def testCrearUnaCopiaManualSeCuentaPorTelegram(cliente, telegram):
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]

    assert len(telegram) == 1
    assert "manual" in telegram[0] and nombre in telegram[0]
    assert "1 portfolio" in telegram[0] and "MB" in telegram[0]


def testUnaCopiaFallidaSeCuentaPorTelegram(cliente, telegram, monkeypatch):
    from routes import backup as rutasBackup

    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    def _falla(*_a, **_k):
        raise OSError("disco lleno")

    monkeypatch.setattr(rutasBackup.zipfile, "ZipFile", _falla)

    assert client.post("/api/backup", headers=cabeceras).status_code == 500
    assert len(telegram) == 1 and "Ha fallado" in telegram[0]


def testLaCopiaAutomaticaSeCuentaPorTelegram(cliente, telegram):
    from routes.backup import crearBackupAutomatico

    _client, _cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    nombre = crearBackupAutomatico()

    assert len(telegram) == 1
    assert "automática" in telegram[0] and nombre in telegram[0]


def testLaCopiaAutomaticaFallidaSeCuentaYSePropaga(cliente, telegram, monkeypatch):
    from routes import backup as rutasBackup

    _client, _cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")
    monkeypatch.setattr(rutasBackup, "_escribirBackup", lambda automatico: (_ for _ in ()).throw(OSError("sin espacio")))

    with pytest.raises(OSError):
        rutasBackup.crearBackupAutomatico()

    assert len(telegram) == 1 and "sin espacio" in telegram[0]


def testRestaurarYBorrarSeCuentanPorTelegram(cliente, telegram):
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")
    primera = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    telegram.clear()

    restaurada = client.post("/api/restore", json={"filename": primera}, headers=cabeceras)
    assert restaurada.status_code == 200
    assert len(telegram) == 1 and "restaurada" in telegram[0] and primera in telegram[0]

    segunda = "backup_01-01-2020_00-00-00.zip"
    (rutas["backups"] / segunda).write_bytes(b"PK\x05\x06" + b"\x00" * 18)
    telegram.clear()
    assert client.delete(f"/api/backups/{segunda}", headers=cabeceras).status_code == 200
    assert len(telegram) == 1 and "eliminada" in telegram[0]


def testUnRestoreDeUnZipCorruptoNoDiceQueHaRestaurado(cliente, telegram):
    client, cabeceras, rutas = cliente
    (rutas["backups"] / "backup_01-01-2026_00-00-00.zip").write_bytes(b"esto no es un zip")

    client.post("/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"}, headers=cabeceras)

    assert telegram == []


def testSinTelegramConfiguradoLasCopiasSiguenFuncionando(cliente):
    client, cabeceras, rutas = cliente
    _crearDb(rutas["portfolios"] / "principal.db")

    assert client.post("/api/backup", headers=cabeceras).get_json()["ok"] is True
