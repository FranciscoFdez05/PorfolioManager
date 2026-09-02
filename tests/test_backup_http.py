"""Pruebas de /api/backup, /api/backups y /api/restore.

Restaurar es la operación más destructiva de la aplicación: sobrescribe todas
las bases de datos de portfolios, portfolios.json, ajustes.json y las
preferencias. Un fallo aquí no da un error en pantalla, se lleva por delante el
histórico completo del usuario. Estos tests cubren sobre todo lo que tiene que
pasar **cuando algo va mal**: nombre manipulado, zip corrupto, entradas con
rutas de escape, y la copia de seguridad previa que permite dar marcha atrás.

Ningún caso toca `data/`: el fixture `datos_aislados` redirige a tmp_path todos
los directorios que usan estas rutas.
"""

import json
import sqlite3
import zipfile

import pytest


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, monkeypatch):
    """Cliente con sesión + directorios de datos aislados + límites amplios."""
    from routes.backup import backup_bp

    # El cupo de rutas pesadas es 30/hora en producción; varios tests hacen más
    # de una copia seguida y el 429 no es lo que quieren comprobar.
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")

    client, cabeceras, _app = cliente_autenticado(backup_bp)
    return client, cabeceras, datos_aislados


def _crear_db(ruta, filas=()):
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

def test_crear_backup_empaqueta_portfolios_ajustes_y_manifest(cliente):
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])
    _crear_db(rutas["portfolios"] / "cripto.db", [("2026-01-02", 50.0, 40.0)])
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


def test_el_backup_recien_creado_aparece_el_primero_en_la_lista(cliente):
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    listado = client.get("/api/backups").get_json()["backups"]

    assert listado[0] == nombre


def test_maxBackups_borra_los_viejos_pero_nunca_el_recien_creado(cliente):
    """El caso que hay que evitar: crear una copia y que la poda se la lleve."""
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")
    rutas["ajustes"].write_text(json.dumps({"maxBackups": 2}), encoding="utf-8")

    for viejo in ("backup_01-01-2020_00-00-00.zip", "backup_02-01-2020_00-00-00.zip",
                  "backup_03-01-2020_00-00-00.zip"):
        (rutas["backups"] / viejo).write_bytes(b"PK\x05\x06" + b"\x00" * 18)

    nombre = client.post("/api/backup", headers=cabeceras).get_json()["filename"]
    restantes = client.get("/api/backups").get_json()["backups"]

    assert len(restantes) == 2
    assert nombre in restantes


def test_un_zip_a_medio_escribir_no_queda_en_el_listado(cliente):
    """El temporal `_tmp_backup_*.zip` no encaja con el patrón de nombres."""
    client, _cabeceras, rutas = cliente
    (rutas["backups"] / "_tmp_backup_01-01-2026_00-00-00.zip").write_bytes(b"a medias")

    assert client.get("/api/backups").get_json()["backups"] == []


def test_las_copias_temporales_no_se_dejan_caer_en_portfolios(cliente):
    """El .db temporal de cada copia va a data/tmp, no junto a los portfolios.

    En data/portfolios lo veía como un portfolio más cualquier `glob("*.db")`:
    la rotación de copias automáticas, el scheduler de snapshots y el listado de
    portfolios. Con un solo proceso la ventana era estrecha; con los dos workers
    y cuatro hilos de gunicorn del contenedor, no.
    """
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])

    assert client.post("/api/backup", headers=cabeceras).get_json()["ok"] is True

    assert sorted(p.name for p in rutas["portfolios"].iterdir()) == ["principal.db"]
    # Y el temporal tampoco se queda: ni el .db ni sus sidecars -wal/-shm.
    assert list((rutas["data"] / "tmp").iterdir()) == []


def test_un_fallo_de_permisos_se_devuelve_con_su_causa(cliente, monkeypatch):
    """El caso de Docker: el volumen montado no deja escribir.

    Antes salía un 500 con `str(e)` a secas —o el "Error interno del servidor"
    del manejador genérico— y en pantalla un "Error al crear backup" que no
    distinguía entre permisos, disco lleno y base de datos bloqueada.
    """
    import errno

    from routes import backup as rutas_backup

    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")

    def _denegado(*_args, **_kwargs):
        raise PermissionError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(rutas_backup.zipfile, "ZipFile", _denegado)

    respuesta = client.post("/api/backup", headers=cabeceras)
    datos = respuesta.get_json()

    assert respuesta.status_code == 500
    assert datos["ok"] is False
    assert "permiso de escritura" in datos["error"]
    # La ruta concreta es la mitad del diagnóstico: dice qué volumen mirar.
    assert str(rutas["backups"]) in datos["error"]


def test_no_se_empieza_el_zip_si_el_destino_no_es_escribible(cliente, monkeypatch):
    """La comprobación va antes de tocar nada, para no dejar un zip a medias."""
    from core import paths
    from routes import backup as rutas_backup

    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")

    monkeypatch.setattr(
        paths, "comprobarEscritura",
        lambda directorio, crear=True: (False, "Read-only file system"),
    )
    monkeypatch.setattr(rutas_backup, "paths", paths)

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
def test_restore_rechaza_nombres_que_no_son_de_un_backup(cliente, nombre):
    """El nombre viene del cuerpo JSON: es entrada de usuario, no una ruta."""
    client, cabeceras, _rutas = cliente
    respuesta = client.post("/api/restore", json={"filename": nombre}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_restore_de_un_backup_inexistente_es_404(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"}, headers=cabeceras,
    )
    assert respuesta.status_code == 404


def test_un_zip_corrupto_se_rechaza_antes_de_tocar_nada(cliente):
    """Abortar a mitad dejaría parte de los portfolios ya sobrescritos."""
    client, cabeceras, rutas = cliente
    original = _crear_db(rutas["portfolios"] / "principal.db", [("2026-06-01", 999.0, 888.0)])
    (rutas["backups"] / "backup_01-01-2026_00-00-00.zip").write_bytes(b"esto no es un zip")

    respuesta = client.post(
        "/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"}, headers=cabeceras,
    )

    assert respuesta.status_code == 400
    # La base activa sigue intacta: es lo único que importa de este test.
    assert _snapshots(original) == [("2026-06-01", 999.0, 888.0)]


def test_restore_sin_sesion_es_401(crear_app, datos_aislados):
    """La ruta más destructiva no puede quedar detrás de una comprobación floja."""
    from routes.backup import backup_bp

    client = crear_app(backup_bp).test_client()
    respuesta = client.post("/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"})
    assert respuesta.status_code == 401


def test_restore_con_sesion_pero_sin_csrf_es_403(cliente_autenticado, datos_aislados):
    from routes.backup import backup_bp

    client, _cabeceras, _app = cliente_autenticado(backup_bp)
    respuesta = client.post("/api/restore", json={"filename": "backup_01-01-2026_00-00-00.zip"})
    assert respuesta.status_code == 403


# ── Restaurar: entradas maliciosas dentro del zip ────────────────────────────

def test_una_entrada_con_ruta_de_escape_no_sale_del_directorio(cliente, tmp_path):
    """`portfolios/../../../../evil.db` no debe escribir fuera de data/portfolios."""
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")
    fuera = tmp_path / "evil.db"

    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/../../../../evil.db", b"SQLite format 3\x00" + b"\x00" * 100)

    respuesta = client.post(
        "/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras,
    )

    assert respuesta.status_code == 200
    assert not fuera.exists()
    assert not (rutas["data"] / "evil.db").exists()
    # `Path(name).name` deja "evil.db": el ../ se descarta y el fichero solo
    # puede aterrizar dentro de data/portfolios, nunca fuera.
    assert not any(p.name == "evil.db" for p in rutas["data"].rglob("evil.db")
                   if p.parent != rutas["portfolios"])


def test_una_entrada_danada_no_tumba_el_resto_de_la_restauracion(cliente):
    """Los 16 bytes de cabecera SQLite se pueden acertar con basura detrás.

    Antes, esa entrada lanzaba desde `_sqlite_copy` y abortaba el restore
    entero: los portfolios ya procesados quedaban mezclados con los que aún no
    se habían tocado, y la respuesta era un 500 sin decir cuál falló.
    """
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")
    _crear_db(rutas["portfolios"] / "cripto.db")

    bueno = _crear_db(rutas["data"] / "bueno.db", [("2026-01-01", 5.0, 4.0)])
    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/cripto.db", b"SQLite format 3\x00" + b"basura" * 50)
        zf.writestr("portfolios/principal.db", bueno.read_bytes())

    datos = client.post(
        "/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras,
    ).get_json()

    assert datos["ok"] is True
    # El portfolio sano se restaura aunque el otro venga roto.
    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-01-01", 5.0, 4.0)]
    # Y la respuesta dice exactamente cuál se quedó fuera.
    assert any("cripto.db" in aviso for aviso in datos["ignorados"])


def test_una_entrada_que_no_es_sqlite_se_ignora(cliente):
    """Escribir esos bytes como .db dejaría el portfolio ilegible."""
    client, cabeceras, rutas = cliente
    original = _crear_db(rutas["portfolios"] / "principal.db", [("2026-06-01", 10.0, 5.0)])

    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/principal.db", b"<html>no soy una base de datos</html>")

    respuesta = client.post("/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert _snapshots(original) == [("2026-06-01", 10.0, 5.0)]


def test_un_nombre_de_prefs_manipulado_se_ignora(cliente):
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")

    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("prefs/ajustes.json", b'{"robado": true}')
        zf.writestr("prefs/prefs_principal.json", b'{"tema": "oscuro"}')

    client.post("/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras)

    # `ajustes.json` no encaja con prefs_<id>.json: se ignora, y el ajustes.json
    # global no se toca desde una entrada de prefs.
    assert not (rutas["json"] / "ajustes.json").exists()
    assert json.loads((rutas["json"] / "prefs_principal.json").read_text()) == {"tema": "oscuro"}


# ── Restaurar: camino feliz ──────────────────────────────────────────────────

def test_restore_devuelve_los_datos_del_backup(cliente):
    client, cabeceras, rutas = cliente
    # Estado actual, que el restore debe sustituir.
    _crear_db(rutas["portfolios"] / "principal.db", [("2026-06-01", 999.0, 888.0)])

    origen = _crear_db(rutas["data"] / "origen.db", [("2026-01-01", 100.0, 90.0)])
    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())
        zf.writestr("portfolios.json", json.dumps({"active": "principal",
                                                   "portfolios": [{"id": "principal", "name": "P"}]}))
        zf.writestr("ajustes.json", json.dumps({"maxBackups": 7}))

    respuesta = client.post("/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-01-01", 100.0, 90.0)]
    assert json.loads(rutas["ajustes"].read_text())["maxBackups"] == 7
    assert json.loads(rutas["meta"].read_text())["active"] == "principal"


def test_restore_guarda_una_copia_del_estado_previo(cliente):
    """Sin esto, restaurar el backup equivocado es irreversible."""
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db", [("2026-06-01", 999.0, 888.0)])

    origen = _crear_db(rutas["data"] / "origen.db", [("2026-01-01", 1.0, 1.0)])
    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())

    datos = client.post(
        "/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras,
    ).get_json()

    from pathlib import Path
    copia = Path(datos["safetyCopy"])
    assert copia.is_dir()
    # Lo que había antes del restore sigue recuperable byte a byte.
    assert _snapshots(copia / "principal.db") == [("2026-06-01", 999.0, 888.0)]


def test_los_snapshots_se_recuperan_del_json_si_el_db_llega_sin_ellos(cliente):
    """El .db puede venir de una versión anterior sin esa tabla poblada."""
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")

    vacio = _crear_db(rutas["data"] / "vacio.db")
    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/principal.db", vacio.read_bytes())
        zf.writestr("snapshots/principal.json", json.dumps(
            [{"ts": "2026-03-01", "v": 42.0, "i": 40.0}]
        ))

    client.post("/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras)

    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-03-01", 42.0, 40.0)]


def test_los_snapshots_del_json_no_pisan_los_que_ya_trae_el_db(cliente):
    """El JSON es un plan B, no la fuente principal."""
    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")

    origen = _crear_db(rutas["data"] / "origen.db", [("2026-05-05", 7.0, 6.0)])
    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())
        zf.writestr("snapshots/principal.json", json.dumps(
            [{"ts": "1999-01-01", "v": 0.0, "i": 0.0}]
        ))

    client.post("/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras)

    assert _snapshots(rutas["portfolios"] / "principal.db") == [("2026-05-05", 7.0, 6.0)]


def test_restaurar_deja_la_base_sin_ficheros_wal_huerfanos(cliente):
    """Un -wal viejo se re-aplicaría sobre la base restaurada y la corrompería."""
    client, cabeceras, rutas = cliente
    destino = _crear_db(rutas["portfolios"] / "principal.db")
    from pathlib import Path
    Path(str(destino) + "-wal").write_bytes(b"wal de la base anterior")

    origen = _crear_db(rutas["data"] / "origen.db", [("2026-01-01", 1.0, 1.0)])
    ruta_zip = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    with zipfile.ZipFile(ruta_zip, "w") as zf:
        zf.writestr("portfolios/principal.db", origen.read_bytes())

    client.post("/api/restore", json={"filename": ruta_zip.name}, headers=cabeceras)

    assert not Path(str(destino) + "-wal").exists()
    # Y ningún temporal del proceso de restauración se queda por el medio.
    assert not list(rutas["portfolios"].glob("_restore_tmp_*"))


# ── Borrar ───────────────────────────────────────────────────────────────────

def test_no_se_puede_borrar_el_unico_backup(cliente):
    """Es la única red de seguridad frente a una corrupción o un borrado."""
    client, cabeceras, rutas = cliente
    unico = rutas["backups"] / "backup_01-01-2026_00-00-00.zip"
    unico.write_bytes(b"PK\x05\x06" + b"\x00" * 18)

    respuesta = client.delete(f"/api/backups/{unico.name}", headers=cabeceras)

    assert respuesta.status_code == 400
    assert unico.exists()


def test_borrar_con_mas_de_uno_funciona(cliente):
    client, cabeceras, rutas = cliente
    for nombre in ("backup_01-01-2026_00-00-00.zip", "backup_02-01-2026_00-00-00.zip"):
        (rutas["backups"] / nombre).write_bytes(b"PK\x05\x06" + b"\x00" * 18)

    respuesta = client.delete("/api/backups/backup_01-01-2026_00-00-00.zip", headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["backups"] == ["backup_02-01-2026_00-00-00.zip"]
    assert not (rutas["backups"] / "backup_01-01-2026_00-00-00.zip").exists()


@pytest.mark.parametrize("nombre", ["..%2F..%2F.env", "cualquiera.zip", "backup_.zip"])
def test_borrar_rechaza_nombres_que_no_son_de_un_backup(cliente, nombre):
    client, cabeceras, _rutas = cliente
    respuesta = client.delete(f"/api/backups/{nombre}", headers=cabeceras)
    assert respuesta.status_code in (400, 404)


def test_una_copia_temporal_abandonada_se_barre_en_la_siguiente(cliente):
    """Si el contenedor muere a media copia, el temporal no se queda para siempre."""
    import os
    import time

    client, cabeceras, rutas = cliente
    _crear_db(rutas["portfolios"] / "principal.db")

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
