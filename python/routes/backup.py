import json
import logging
import re
import shutil
import sqlite3
import threading
import time
import zipfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

from admin.backup_manager import _remove_wal_sidecars
from core import paths, settings
from core.errors import mensajeAlmacenamiento, registrarFalloEscritura
from core.escritura import escribirAtomico, limpiarTemporal, rutaTemporal, temporalPara
from core.paths import (
    AJUSTES_JSON as _AJUSTES_SRC,
    BACKUPS_DIR as _BACKUP_DIR,
    DATA_DIR,
    JSON_DIR as _JSON_DIR,
    PORTFOLIOS_DIR as _PORTFOLIOS_DIR,
    PORTFOLIOS_META_FILE as _META_FILE,
)
from routes.ajustes import _read_ajustes

log = logging.getLogger(__name__)

# Serializa crear/restaurar/borrar backups. Dos restores simultáneos (o un
# restore mientras se crea un backup) se pisaban los ficheros .db a medio
# escribir y dejaban la BD activa corrupta.
_BACKUP_LOCK = threading.Lock()

backup_bp = Blueprint("backup", __name__)


_RE_ZIP = re.compile(r'^backup_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.zip$')
_RE_DB  = re.compile(r'^portfolio_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.db$')
# Nombres de portfolio admisibles al restaurar entradas de un zip
_RE_SAFE_DB_NAME = re.compile(r'^[A-Za-z0-9_-]{1,64}\.db$')
# Mismo alfabeto que exige admin.portfolios_manager para un id de portfolio: de
# ahí sale un nombre de fichero, así que ni barras ni puntos ni mayúsculas.
_RE_SAFE_PORTFOLIO_ID = re.compile(r'^[a-z0-9_-]{1,64}$')
_RE_SAFE_PREFS_NAME = re.compile(r'^prefs_[A-Za-z0-9_-]{1,64}\.json$')


def _problema_del_indice(crudo: bytes) -> str | None:
    """Motivo por el que no se puede confiar en un `portfolios.json` del zip.

    Devuelve None si el índice es utilizable. Se comprueba lo que después se
    convierte en una ruta: el id del portfolio activo y el de cada uno de los
    listados, porque `admin.portfolios_manager` construye con ellos el nombre
    del fichero `.db` que abrirá.

    No valida el resto del contenido —nombres visibles, claves de más— a
    propósito: lo que hay que impedir es que un id decida qué fichero se abre,
    no imponer un esquema a un fichero que puede crecer con las versiones.
    """
    try:
        meta = json.loads(crudo.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        return f"no es JSON válido ({error})"

    if not isinstance(meta, dict):
        return "no es un objeto JSON"

    ids = [meta.get("active")]

    listados = meta.get("portfolios")
    if listados is not None:
        if not isinstance(listados, list):
            return "la lista de portfolios no es una lista"
        for entrada in listados:
            if not isinstance(entrada, dict):
                return "hay un portfolio que no es un objeto"
            ids.append(entrada.get("id"))

    for pid in ids:
        # `active` puede faltar: quien lo lee tiene su propio valor por defecto.
        if pid is None:
            continue
        if not isinstance(pid, str) or not _RE_SAFE_PORTFOLIO_ID.match(pid):
            return f"identificador de portfolio no admisible: {pid!r}"

    return None


def _parse_dt(name):
    m = re.search(r'(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})', name)
    if not m:
        return datetime.min
    try:
        return datetime.strptime(m.group(1), "%d-%m-%Y_%H-%M-%S")
    except ValueError:
        return datetime.min


def _is_valid(name):
    return bool(_RE_ZIP.match(name) or _RE_DB.match(name))


def _list_backups():
    if not _BACKUP_DIR.exists():
        return []
    files = [
        f.name for f in _BACKUP_DIR.iterdir()
        if _RE_ZIP.match(f.name) or _RE_DB.match(f.name)
    ]
    return sorted(files, key=_parse_dt, reverse=True)


def _sqlite_copy(src_path: Path, dst_path: Path):
    src = dst = None
    try:
        src = sqlite3.connect(str(src_path), timeout=settings.backupSqliteTimeout())
        dst = sqlite3.connect(str(dst_path), timeout=settings.backupSqliteTimeout())
        dst.execute(f"PRAGMA busy_timeout={settings.backupSqliteTimeout() * 1000}")
        src.backup(dst)
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst.commit()
    finally:
        for conn in (dst, src):
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass


def _safety_copy_before_restore() -> Path | None:
    """Guarda el estado actual de todos los portfolios antes de sobrescribirlos.

    Sin esto, restaurar el backup equivocado destruía de forma irreversible todo
    lo introducido desde ese backup: /api/restore sobrescribía los .db sin
    conservar ninguna copia del estado previo.
    """
    if not _PORTFOLIOS_DIR.exists():
        return None
    ts = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
    dest_dir = DATA_DIR / "pre_restore" / ts
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        for db_file in sorted(_PORTFOLIOS_DIR.glob("*.db")):
            _sqlite_copy(db_file, dest_dir / db_file.name)
        if _META_FILE.exists():
            shutil.copy2(str(_META_FILE), str(dest_dir / "portfolios.json"))
        if _AJUSTES_SRC.exists():
            shutil.copy2(str(_AJUSTES_SRC), str(dest_dir / "ajustes.json"))
        log.info(f"[backup] Copia previa al restore guardada en {dest_dir}")
        return dest_dir
    except Exception as e:
        log.error(f"[backup] No se pudo crear la copia previa al restore: {e}")
        return None


def _tmp_dir(crear=True) -> Path:
    """Carpeta de temporales (core.paths.TMP_DIR), creada a demanda.

    Se lee del módulo `paths` en cada llamada, y no con un `from … import` al
    principio: así sigue siendo la única definición de la ruta y los tests, que
    la reasignan para no tocar el `data/` real, alcanzan también a este módulo.
    """
    destino = paths.TMP_DIR
    if crear:
        destino.mkdir(parents=True, exist_ok=True)
    return destino


@contextmanager
def _copia_temporal(src_path: Path):
    """Copia consistente de un .db en un fichero temporal, ya cerrada.

    El temporal va a data/tmp y no a data/portfolios: allí, un
    `_tmp_bak_x.db` a medio escribir entraba en cualquier `glob("*.db")` —la
    rotación de copias automáticas, el scheduler de snapshots, el listado de
    portfolios— como si fuera un portfolio de verdad. Con el servidor de
    desarrollo (un proceso, un hilo) la ventana era estrecha; con los dos
    workers y cuatro hilos de gunicorn del contenedor, deja de serlo.

    Se devuelve la ruta y no los bytes porque zipfile puede leer del fichero
    directamente: cargar en memoria una BD de decenas de MB por cada portfolio
    era gratis en un PC y no lo es en el servidor doméstico donde corre esto.
    """
    with temporalPara(src_path, directorio=_tmp_dir()) as tmp_path:
        _sqlite_copy(src_path, tmp_path)
        yield tmp_path


def _checkpoint_active_db():
    """Vuelca el WAL de la BD activa antes de copiarla al zip.

    Sustituye al antiguo _snapshot_now(), que importaba
    routes.snapshots._compute_portfolio_totals — una función que no existe en
    ningún módulo. Su ImportError se tragaba el 'except Exception: pass', así
    que el paso previo al backup nunca hizo nada. Los totales solo puede
    calcularlos el frontend (los envía a /api/portfolio/snapshot con precios de
    mercado frescos), de modo que aquí basta con asegurar que lo ya confirmado
    esté en el fichero .db.
    """
    try:
        from core.db import get_db
        conn = get_db()
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception as e:
        log.warning(f"[backup] No se pudo hacer checkpoint de la BD activa: {e}")


def _export_snapshots_json(db_path: Path) -> str:
    """Lee todos los snapshots del DB y los devuelve como JSON string."""
    conn = None
    try:
        conn = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts ASC"
        ).fetchall()
        data = [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"]} for r in rows]
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        log.warning(f"[backup] No se pudieron exportar snapshots de {db_path.name}: {e}")
        return "[]"
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


@backup_bp.route("/api/backup", methods=["POST"])
def createBackup():
    with _BACKUP_LOCK:
        return _create_backup_locked()


def _preparar_destino():
    """Comprueba que se pueda escribir donde va a ir la copia. (ok, mensaje).

    Se hace **antes** de empezar el zip, y creando un fichero de verdad: con el
    volumen de Docker montado de solo lectura o perteneciente a otro usuario, la
    copia fallaba a mitad y el usuario recibía un 500 sin causa.
    """
    for destino in (_BACKUP_DIR, _tmp_dir(crear=False)):
        escribible, motivo = paths.comprobarEscritura(destino)
        if not escribible:
            return False, (
                f"no se puede escribir en {destino}: {motivo}. "
                "Comprueba los permisos del volumen de datos"
            )
    return True, ""


def _limpiar_temporales_huerfanos(antiguedad_segundos=3600):
    """Barre las copias temporales que dejó un proceso muerto a media copia.

    El `finally` de _copia_temporal cubre cualquier excepción, pero no que el
    contenedor se pare —o que Docker mate al worker— justo mientras copia. Sin
    esto, cada uno de esos cortes deja para siempre una copia entera de la base
    de datos ocupando disco.
    """
    limite = time.time() - antiguedad_segundos
    try:
        candidatos = list(_tmp_dir(crear=False).glob("_bak_*"))
    except OSError:
        return
    for viejo in candidatos:
        try:
            if viejo.stat().st_mtime < limite:
                viejo.unlink(missing_ok=True)
                log.info("[backup] Temporal huérfano eliminado: %s", viejo.name)
        except OSError:
            pass


def _create_backup_locked():
    try:
        _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        mensaje = registrarFalloEscritura(
            log, "[backup] No se pudo preparar el directorio de copias", e, _BACKUP_DIR
        )
        return jsonify({"ok": False, "error": mensaje}), 500

    listo, motivo = _preparar_destino()
    if not listo:
        log.error("[backup] Destino no escribible: %s", motivo)
        return jsonify({"ok": False, "error": motivo}), 500

    _limpiar_temporales_huerfanos()
    _checkpoint_active_db()

    ts = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
    filename = f"backup_{ts}.zip"
    backup_path = _BACKUP_DIR / filename
    tmp_path = _BACKUP_DIR / f"_tmp_{filename}"

    portfolio_names = []
    try:
        with zipfile.ZipFile(str(tmp_path), "w", zipfile.ZIP_DEFLATED) as zf:
            # Todos los portfolios + snapshots JSON de seguridad
            if _PORTFOLIOS_DIR.exists():
                for db_file in sorted(_PORTFOLIOS_DIR.glob("*.db")):
                    with _copia_temporal(db_file) as copia:
                        zf.write(str(copia), f"portfolios/{db_file.name}")
                    snap_json = _export_snapshots_json(db_file)
                    zf.writestr(f"snapshots/{db_file.stem}.json", snap_json)
                    portfolio_names.append(db_file.stem)

            # Meta de portfolios
            if _META_FILE.exists():
                zf.write(str(_META_FILE), "portfolios.json")

            # Ajustes globales
            if _AJUSTES_SRC.exists():
                zf.write(str(_AJUSTES_SRC), "ajustes.json")

            # Preferencias por-portfolio
            if _JSON_DIR.exists():
                for prefs_file in sorted(_JSON_DIR.glob("prefs_*.json")):
                    zf.write(str(prefs_file), f"prefs/{prefs_file.name}")

            # Manifest con metadatos del backup
            manifest = {
                "created_at": datetime.now().isoformat(),
                "version": 2,
                "portfolios": portfolio_names,
            }
            zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

        # Validar el zip antes de aceptarlo como definitivo
        with zipfile.ZipFile(str(tmp_path), "r") as zf:
            bad = zf.testzip()
            if bad:
                raise RuntimeError(f"Zip corrupto: {bad}")

        tmp_path.replace(backup_path)

    except Exception as e:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        # Traza completa al log y, al usuario, la causa real: sin ella el
        # "Error al crear backup" de la pantalla de Ajustes no distinguía entre
        # un volumen sin permisos, un disco lleno y una BD bloqueada.
        mensaje = registrarFalloEscritura(log, "[backup] Error creando backup", e, _BACKUP_DIR)
        return jsonify({"ok": False, "error": mensaje}), 500

    all_backups = _list_backups()
    try:
        max_backups = int(_read_ajustes().get("maxBackups") or 0)
    except (TypeError, ValueError):
        max_backups = 0
    if max_backups > 0 and len(all_backups) > max_backups:
        for old in all_backups[max_backups:]:
            # Nunca borrar el que acabamos de crear, pase lo que pase con el orden
            if old == filename:
                continue
            (_BACKUP_DIR / old).unlink(missing_ok=True)
        all_backups = _list_backups()

    return jsonify({"ok": True, "filename": filename, "backups": all_backups})


@backup_bp.route("/api/backups", methods=["GET"])
def listBackups():
    return jsonify({"backups": _list_backups()})


@backup_bp.route("/api/restore", methods=["POST"])
def restoreBackup():
    with _BACKUP_LOCK:
        return _restore_locked()


def es_backup_completo(nombres) -> bool:
    """¿Este zip es una copia de seguridad de todas las carteras?

    Se distingue por la carpeta `portfolios/`, que es donde el backup guarda
    cada `.db`; un export de una sola cartera lo lleva en la raíz. Saberlo
    importa porque el mismo fichero se puede soltar en dos sitios distintos de
    la interfaz, y el «Importar ZIP» de Ajustes se tragaba el backup en
    silencio: no encontraba el `.db` en la raíz, restauraba solo los ajustes y
    respondía que todo había ido bien.
    """
    return any(n.startswith("portfolios/") and n.endswith(".db") for n in nombres)


def restaurar_backup_subido(zip_path: Path):
    """Restaura un backup que llega subido, en vez de estar en data/backups.

    Toma el mismo cerrojo que /api/restore: da igual por dónde entre el
    fichero, dos restauraciones a la vez se pisan los `.db` igual de mal. La
    respuesta es la misma que la de /api/restore —incluidos `safetyCopy` e
    `ignorados`—, que es justo lo que el usuario necesita saber.
    """
    with _BACKUP_LOCK:
        return _restaurar_archivo(zip_path, zip_path.name, es_zip=True)


def _restore_locked():
    data = request.get_json(silent=True) or {}
    filename = str(data.get("filename", "")).strip()

    if not _is_valid(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    return _restaurar_archivo(backup_path, filename, es_zip=bool(_RE_ZIP.match(filename)))


def _restaurar_archivo(backup_path: Path, filename: str, *, es_zip: bool):
    """El restore propiamente dicho, ya con el fichero localizado.

    Separado de la vista porque hay dos caminos hasta aquí: restaurar una copia
    de la lista de Ajustes y subir ese mismo zip por «Importar ZIP». Antes cada
    uno tenía su propia idea de qué hacer con el fichero.
    """
    # Validar el zip ANTES de tocar nada: si está corrupto se abortaba a mitad
    # de la restauración, con parte de los portfolios ya sobrescritos.
    if es_zip:
        try:
            with zipfile.ZipFile(str(backup_path), "r") as zf:
                bad = zf.testzip()
                if bad:
                    return jsonify({"ok": False, "error": f"Backup corrupto: {bad}"}), 400
        except zipfile.BadZipFile:
            return jsonify({"ok": False, "error": "El backup no es un ZIP válido"}), 400

    safety_dir = _safety_copy_before_restore()

    # Entradas del zip que no se han podido restaurar. Se acumulan en vez de
    # abortar: si el backup trae cinco portfolios y uno está dañado, interesa
    # recuperar los otros cuatro y saber cuál falta, no perderlo todo.
    ignorados: list[str] = []

    from core.db import invalidate_all_connections
    invalidate_all_connections()

    try:
        if es_zip:
            with zipfile.ZipFile(str(backup_path), "r") as zf:
                names = zf.namelist()

                # Restaurar cada portfolio DB
                _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
                for name in names:
                    if name.startswith("portfolios/") and name.endswith(".db"):
                        # Path(...).name descarta cualquier ../ del nombre de entrada
                        db_name = Path(name).name
                        if not _RE_SAFE_DB_NAME.match(db_name):
                            log.warning(f"[backup] Entrada de zip ignorada por nombre inseguro: {name}")
                            ignorados.append(f"{name}: nombre no admisible")
                            continue
                        dst_path = _PORTFOLIOS_DIR / db_name
                        raw = zf.read(name)
                        if not raw.startswith(b"SQLite format 3\x00"):
                            log.warning(f"[backup] Entrada {name} no es un SQLite válido, ignorada")
                            ignorados.append(f"{name}: no es un fichero SQLite")
                            continue
                        # El temporal va a data/tmp: `_restore_tmp_<x>.db` en
                        # data/portfolios entraba en los `glob("*.db")` como un
                        # portfolio más mientras duraba la restauración.
                        tmp_path = rutaTemporal(dst_path, directorio=_tmp_dir())
                        try:
                            tmp_path.write_bytes(raw)
                            _sqlite_copy(tmp_path, dst_path)
                            _remove_wal_sidecars(dst_path)
                        except Exception as e:
                            # La cabecera "SQLite format 3" son 16 bytes: acertarla
                            # no garantiza que el resto del fichero sea legible.
                            # Antes, una sola entrada así abortaba la restauración
                            # completa y dejaba los portfolios ya procesados
                            # mezclados con los que aún no se habían tocado. Ahora
                            # se salta y se informa de cuál falló.
                            log.error(f"[backup] No se pudo restaurar {name}: {e}")
                            ignorados.append(f"{name}: {e}")
                        finally:
                            limpiarTemporal(tmp_path)

                # Restaurar portfolios.json (escritura atómica)
                #
                # Es el único contenido del zip que se usa como ruta: de aquí
                # sale el id del portfolio activo, y con él el fichero .db que
                # la aplicación abrirá al arrancar. Los .db y los prefs ya se
                # filtran por nombre; esto es lo mismo para el índice, y hace
                # falta desde que se puede importar un zip que no ha generado
                # esta instalación. Un índice que no pase se ignora y se dice:
                # mejor quedarse con el que ya había que restaurar uno que
                # apunta fuera del directorio de datos.
                if "portfolios.json" in names:
                    meta_cruda = zf.read("portfolios.json")
                    problema = _problema_del_indice(meta_cruda)
                    if problema:
                        log.warning("[backup] portfolios.json ignorado: %s", problema)
                        ignorados.append(f"portfolios.json: {problema}")
                    else:
                        escribirAtomico(_META_FILE, meta_cruda)

                # Restaurar ajustes.json
                if "ajustes.json" in names:
                    escribirAtomico(_AJUSTES_SRC, zf.read("ajustes.json"))

                # Restaurar preferencias por-portfolio
                for name in names:
                    if name.startswith("prefs/") and name.endswith(".json"):
                        prefs_name = Path(name).name
                        if not _RE_SAFE_PREFS_NAME.match(prefs_name):
                            log.warning(f"[backup] Entrada de prefs ignorada por nombre inseguro: {name}")
                            ignorados.append(f"{name}: nombre no admisible")
                            continue
                        escribirAtomico(_JSON_DIR / prefs_name, zf.read(name))

                # Restaurar snapshots desde JSON de seguridad si el DB restaurado quedó vacío
                for name in names:
                    if name.startswith("snapshots/") and name.endswith(".json"):
                        stem = Path(name).stem
                        db_path = _PORTFOLIOS_DIR / f"{stem}.db"
                        if not db_path.exists():
                            continue
                        conn = None
                        try:
                            snap_data = json.loads(zf.read(name).decode("utf-8"))
                            if not isinstance(snap_data, list) or not snap_data:
                                continue
                            conn = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
                            has_rows = conn.execute(
                                "SELECT 1 FROM portfolio_snapshots LIMIT 1"
                            ).fetchone()
                            if not has_rows:
                                conn.executemany(
                                    "INSERT OR IGNORE INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?,?,?)",
                                    [(r["ts"], r["v"], r["i"]) for r in snap_data
                                     if isinstance(r, dict) and "ts" in r]
                                )
                                conn.commit()
                        except Exception as e:
                            log.warning(f"[backup] No se pudieron restaurar snapshots de {name}: {e}")
                        finally:
                            if conn is not None:
                                try:
                                    conn.close()
                                except Exception:
                                    pass

            # Re-activar el portfolio que estaba activo en el backup
            try:
                from admin.portfolios_manager import init_portfolios
                init_portfolios()
            except Exception:
                pass

        else:
            # Formato legacy .db: restaura solo el portfolio activo
            from core.db import get_active_db_path
            active_db = get_active_db_path()
            _sqlite_copy(backup_path, active_db)
            _remove_wal_sidecars(active_db)

            ts_m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
            if ts_m:
                ajustes_bak = _BACKUP_DIR / f"ajustes_{ts_m.group(1)}.json"
                if ajustes_bak.exists():
                    _AJUSTES_SRC.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ajustes_bak, _AJUSTES_SRC)

    except Exception as e:
        mensaje = registrarFalloEscritura(
            log, f"[backup] Error en restore de {filename}", e, _PORTFOLIOS_DIR
        )
        return jsonify({
            "ok": False,
            "error": mensaje,
            "safetyCopy": str(safety_dir) if safety_dir else None,
            "ignorados": ignorados,
        }), 500
    finally:
        # Los .db han cambiado bajo los pies de las conexiones cacheadas
        invalidate_all_connections()

    if ignorados:
        log.warning("[backup] Restauración parcial: %d entradas ignoradas", len(ignorados))
    return jsonify({
        "ok": True,
        "safetyCopy": str(safety_dir) if safety_dir else None,
        # El frontend debe avisar si la restauración fue parcial: un "ok" a
        # secas después de perder un portfolio sería el peor resultado posible.
        "ignorados": ignorados,
    })


@backup_bp.route("/api/backups/<filename>", methods=["DELETE"])
def deleteBackup(filename):
    filename = filename.strip()
    if not _is_valid(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    with _BACKUP_LOCK:
        # No dejar al usuario sin ningún backup: el último es la única red de
        # seguridad frente a una corrupción o un borrado accidental.
        if len(_list_backups()) <= 1:
            return jsonify({
                "ok": False,
                "error": "No se puede eliminar el único backup existente",
            }), 400
        try:
            backup_path.unlink(missing_ok=True)
        except OSError as e:
            log.exception("[backup] No se pudo eliminar %s", filename)
            return jsonify({
                "ok": False,
                "error": mensajeAlmacenamiento(e, backup_path),
            }), 500

    # Borrar ajustes snapshot legacy si existe
    ts_m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
    if ts_m:
        ajustes_snap = _BACKUP_DIR / f"ajustes_{ts_m.group(1)}.json"
        if ajustes_snap.exists():
            ajustes_snap.unlink()

    return jsonify({"ok": True, "backups": _list_backups()})
