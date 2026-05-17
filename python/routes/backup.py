import json
import re
import shutil
import sqlite3
import zipfile
import logging
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

from routes.ajustes import _read_ajustes

log = logging.getLogger(__name__)

backup_bp = Blueprint("backup", __name__)

_BASE_DIR    = Path(__file__).resolve().parent.parent.parent
_BACKUP_DIR  = _BASE_DIR / "data" / "backups"
_PORTFOLIOS_DIR = _BASE_DIR / "data" / "portfolios"
_META_FILE   = _BASE_DIR / "data" / "portfolios.json"
_AJUSTES_SRC = _BASE_DIR / "data" / "JSON" / "ajustes.json"
_JSON_DIR    = _BASE_DIR / "data" / "JSON"

_RE_ZIP = re.compile(r'^backup_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.zip$')
_RE_DB  = re.compile(r'^portfolio_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.db$')


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
    src = sqlite3.connect(str(src_path))
    dst = sqlite3.connect(str(dst_path))
    src.backup(dst)
    dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    dst.commit()
    dst.close()
    src.close()


def _sqlite_copy_to_bytes(src_path: Path) -> bytes:
    """Copia un SQLite DB (incluyendo WAL pendiente) a bytes para incluir en el zip."""
    tmp_path = src_path.parent / f"_tmp_bak_{src_path.name}"
    try:
        src = sqlite3.connect(str(src_path))
        tmp = sqlite3.connect(str(tmp_path))
        src.backup(tmp)
        tmp.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        tmp.commit()
        tmp.close()
        src.close()
        return tmp_path.read_bytes()
    finally:
        tmp_path.unlink(missing_ok=True)


def _snapshot_now():
    """Guarda un snapshot del portfolio activo con los totales actuales.
    Se llama antes de crear el zip para que el DB dentro del backup tenga datos frescos."""
    try:
        import time as _time
        from routes.snapshots import _compute_portfolio_totals
        from db import get_db
        conn = get_db()
        now_ts = int(_time.time())
        total_value, total_invested = _compute_portfolio_totals()
        conn.execute(
            "INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
            (now_ts, total_value, total_invested)
        )
        conn.commit()
    except Exception:
        pass


def _export_snapshots_json(db_path: Path) -> str:
    """Lee todos los snapshots del DB y los devuelve como JSON string."""
    try:
        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts ASC"
        ).fetchall()
        conn.close()
        data = [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"]} for r in rows]
        return json.dumps(data, ensure_ascii=False)
    except Exception:
        return "[]"


@backup_bp.route("/api/backup", methods=["POST"])
def createBackup():
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    _snapshot_now()

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
    except Exception:
        max_backups = 0
    if max_backups > 0 and len(all_backups) > max_backups:
        for old in all_backups[max_backups:]:
            (_BACKUP_DIR / old).unlink(missing_ok=True)
        all_backups = _list_backups()

    return jsonify({"ok": True, "filename": filename, "backups": all_backups})


@backup_bp.route("/api/backups", methods=["GET"])
def listBackups():
    return jsonify({"backups": _list_backups()})


@backup_bp.route("/api/restore", methods=["POST"])
def restoreBackup():
    data = request.get_json(silent=True) or {}
    filename = str(data.get("filename", "")).strip()

    if not _is_valid(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    from db import invalidate_all_connections
    invalidate_all_connections()

    try:
        if _RE_ZIP.match(filename):
            # Validar integridad del zip antes de restaurar
            with zipfile.ZipFile(str(backup_path), "r") as zf:
                bad = zf.testzip()
                if bad:
                    return jsonify({"ok": False, "error": f"Backup corrupto: {bad}"}), 400

            with zipfile.ZipFile(str(backup_path), "r") as zf:
                names = zf.namelist()

                # Restaurar cada portfolio DB
                _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
                for name in names:
                    if name.startswith("portfolios/") and name.endswith(".db"):
                        db_name = Path(name).name
                        dst_path = _PORTFOLIOS_DIR / db_name
                        raw = zf.read(name)
                        tmp_path = _PORTFOLIOS_DIR / f"_restore_tmp_{db_name}"
                        try:
                            tmp_path.write_bytes(raw)
                            _sqlite_copy(tmp_path, dst_path)
                        finally:
                            tmp_path.unlink(missing_ok=True)

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
                        try:
                            snap_data = json.loads(zf.read(name).decode("utf-8"))
                            if not snap_data:
                                continue
                            conn = sqlite3.connect(str(db_path))
                            has_rows = conn.execute(
                                "SELECT 1 FROM portfolio_snapshots LIMIT 1"
                            ).fetchone()
                            if not has_rows:
                                conn.executemany(
                                    "INSERT OR IGNORE INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?,?,?)",
                                    [(r["ts"], r["v"], r["i"]) for r in snap_data]
                                )
                                conn.commit()
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
            src = sqlite3.connect(str(backup_path))
            dst = sqlite3.connect(str(get_active_db_path()))
            src.backup(dst)
            dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            dst.commit()
            dst.close()
            src.close()

            ts_m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
            if ts_m:
                ajustes_bak = _BACKUP_DIR / f"ajustes_{ts_m.group(1)}.json"
                if ajustes_bak.exists():
                    _AJUSTES_SRC.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(ajustes_bak, _AJUSTES_SRC)

    except Exception as e:
        log.error(f"[backup] Error en restore de {filename}: {e}")
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True})


@backup_bp.route("/api/backups/<filename>", methods=["DELETE"])
def deleteBackup(filename):
    filename = filename.strip()
    if not _is_valid(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    backup_path.unlink()

    # Borrar ajustes snapshot legacy si existe
    ts_m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
    if ts_m:
        ajustes_snap = _BACKUP_DIR / f"ajustes_{ts_m.group(1)}.json"
        if ajustes_snap.exists():
            ajustes_snap.unlink()

    return jsonify({"ok": True, "backups": _list_backups()})
