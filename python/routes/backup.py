import json
import re
import shutil
import sqlite3
import threading
import zipfile
import logging
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

from backup_manager import _remove_wal_sidecars
from routes.ajustes import _read_ajustes

log = logging.getLogger(__name__)

# Serializa crear/restaurar/borrar backups. Dos restores simultáneos (o un
# restore mientras se crea un backup) se pisaban los ficheros .db a medio
# escribir y dejaban la BD activa corrupta.
_BACKUP_LOCK = threading.Lock()

backup_bp = Blueprint("backup", __name__)

_BASE_DIR    = Path(__file__).resolve().parent.parent.parent
_BACKUP_DIR  = _BASE_DIR / "data" / "backups"
_PORTFOLIOS_DIR = _BASE_DIR / "data" / "portfolios"
_META_FILE   = _BASE_DIR / "data" / "portfolios.json"
_AJUSTES_SRC = _BASE_DIR / "data" / "JSON" / "ajustes.json"
_JSON_DIR    = _BASE_DIR / "data" / "JSON"

_RE_ZIP = re.compile(r'^backup_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.zip$')
_RE_DB  = re.compile(r'^portfolio_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.db$')
# Nombres de portfolio admisibles al restaurar entradas de un zip
_RE_SAFE_DB_NAME = re.compile(r'^[A-Za-z0-9_-]{1,64}\.db$')
_RE_SAFE_PREFS_NAME = re.compile(r'^prefs_[A-Za-z0-9_-]{1,64}\.json$')


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
        src = sqlite3.connect(str(src_path), timeout=15)
        dst = sqlite3.connect(str(dst_path), timeout=15)
        dst.execute("PRAGMA busy_timeout=15000")
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
    dest_dir = _BASE_DIR / "data" / "pre_restore" / ts
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


def _sqlite_copy_to_bytes(src_path: Path) -> bytes:
    """Copia un SQLite DB (incluyendo WAL pendiente) a bytes para incluir en el zip."""
    tmp_path = src_path.parent / f"_tmp_bak_{src_path.name}"
    try:
        _sqlite_copy(src_path, tmp_path)
        return tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)
        # Los sidecars del temporal quedaban huérfanos en data/portfolios y
        # _PORTFOLIOS_DIR.glob("*.db") no los limpia nunca.
        for suffix in ("-wal", "-shm"):
            Path(str(tmp_path) + suffix).unlink(missing_ok=True)


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
        from db import get_db
        conn = get_db()
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception as e:
        log.warning(f"[backup] No se pudo hacer checkpoint de la BD activa: {e}")


def _export_snapshots_json(db_path: Path) -> str:
    """Lee todos los snapshots del DB y los devuelve como JSON string."""
    conn = None
    try:
        conn = sqlite3.connect(str(db_path), timeout=15)
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


def _create_backup_locked():
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)

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
                    data = _sqlite_copy_to_bytes(db_file)
                    zf.writestr(f"portfolios/{db_file.name}", data)
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
        tmp_path.unlink(missing_ok=True)
        log.error(f"[backup] Error creando backup: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500

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


def _restore_locked():
    data = request.get_json(silent=True) or {}
    filename = str(data.get("filename", "")).strip()

    if not _is_valid(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    # Validar el zip ANTES de tocar nada: si está corrupto se abortaba a mitad
    # de la restauración, con parte de los portfolios ya sobrescritos.
    if _RE_ZIP.match(filename):
        try:
            with zipfile.ZipFile(str(backup_path), "r") as zf:
                bad = zf.testzip()
                if bad:
                    return jsonify({"ok": False, "error": f"Backup corrupto: {bad}"}), 400
        except zipfile.BadZipFile:
            return jsonify({"ok": False, "error": "El backup no es un ZIP válido"}), 400

    safety_dir = _safety_copy_before_restore()

    from db import invalidate_all_connections
    invalidate_all_connections()

    try:
        if _RE_ZIP.match(filename):
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
                            continue
                        dst_path = _PORTFOLIOS_DIR / db_name
                        raw = zf.read(name)
                        if not raw.startswith(b"SQLite format 3\x00"):
                            log.warning(f"[backup] Entrada {name} no es un SQLite válido, ignorada")
                            continue
                        tmp_path = _PORTFOLIOS_DIR / f"_restore_tmp_{db_name}"
                        try:
                            tmp_path.write_bytes(raw)
                            _sqlite_copy(tmp_path, dst_path)
                            _remove_wal_sidecars(dst_path)
                        finally:
                            tmp_path.unlink(missing_ok=True)
                            for suffix in ("-wal", "-shm"):
                                Path(str(tmp_path) + suffix).unlink(missing_ok=True)

                # Restaurar portfolios.json (escritura atómica)
                if "portfolios.json" in names:
                    _META_FILE.parent.mkdir(parents=True, exist_ok=True)
                    meta_tmp = _META_FILE.with_suffix(".tmp")
                    meta_tmp.write_bytes(zf.read("portfolios.json"))
                    meta_tmp.replace(_META_FILE)

                # Restaurar ajustes.json
                if "ajustes.json" in names:
                    _AJUSTES_SRC.parent.mkdir(parents=True, exist_ok=True)
                    _AJUSTES_SRC.write_bytes(zf.read("ajustes.json"))

                # Restaurar preferencias por-portfolio
                for name in names:
                    if name.startswith("prefs/") and name.endswith(".json"):
                        prefs_name = Path(name).name
                        if not _RE_SAFE_PREFS_NAME.match(prefs_name):
                            log.warning(f"[backup] Entrada de prefs ignorada por nombre inseguro: {name}")
                            continue
                        dst = _JSON_DIR / prefs_name
                        dst.parent.mkdir(parents=True, exist_ok=True)
                        dst.write_bytes(zf.read(name))

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
                            conn = sqlite3.connect(str(db_path), timeout=15)
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
                from portfolios_manager import init_portfolios
                init_portfolios()
            except Exception:
                pass

        else:
            # Formato legacy .db: restaura solo el portfolio activo
            from db import get_active_db_path
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
        log.error(f"[backup] Error en restore de {filename}: {e}")
        return jsonify({
            "ok": False,
            "error": str(e),
            "safetyCopy": str(safety_dir) if safety_dir else None,
        }), 500
    finally:
        # Los .db han cambiado bajo los pies de las conexiones cacheadas
        invalidate_all_connections()

    return jsonify({"ok": True, "safetyCopy": str(safety_dir) if safety_dir else None})


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
        backup_path.unlink(missing_ok=True)

    # Borrar ajustes snapshot legacy si existe
    ts_m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
    if ts_m:
        ajustes_snap = _BACKUP_DIR / f"ajustes_{ts_m.group(1)}.json"
        if ajustes_snap.exists():
            ajustes_snap.unlink()

    return jsonify({"ok": True, "backups": _list_backups()})
