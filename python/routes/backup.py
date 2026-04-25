import json
import re
import shutil
import sqlite3
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

backup_bp = Blueprint("backup", __name__)

_BASE_DIR   = Path(__file__).resolve().parent.parent.parent
_DB_PATH    = _BASE_DIR / "data" / "portfolio.db"
_BACKUP_DIR = _BASE_DIR / "data" / "backups"
_AJUSTES_SRC = _BASE_DIR / "data" / "JSON" / "ajustes.json"
_FILENAME_RE = re.compile(r'^portfolio_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.db$')


def _parse_backup_dt(name):
    m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', name)
    if not m:
        return datetime.min
    try:
        return datetime.strptime(m.group(1), "%d-%m-%Y_%H-%M-%S")
    except ValueError:
        return datetime.min


def _list_backups():
    if not _BACKUP_DIR.exists():
        return []
    files = sorted(
        [f.name for f in _BACKUP_DIR.iterdir() if _FILENAME_RE.match(f.name)],
        key=_parse_backup_dt,
        reverse=True
    )
    return files


@backup_bp.route("/api/backup", methods=["POST"])
def createBackup():
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
    filename = f"portfolio_{ts}.db"
    backup_path = _BACKUP_DIR / filename

    src = sqlite3.connect(str(_DB_PATH))
    dst = sqlite3.connect(str(backup_path))
    src.backup(dst)
    dst.close()
    src.close()

    # Also save ajustes.json alongside the db backup
    if _AJUSTES_SRC.exists():
        ajustes_backup = _BACKUP_DIR / f"ajustes_{ts}.json"
        shutil.copy2(_AJUSTES_SRC, ajustes_backup)

    return jsonify({"ok": True, "filename": filename, "backups": _list_backups()})


@backup_bp.route("/api/backups", methods=["GET"])
def listBackups():
    return jsonify({"backups": _list_backups()})


@backup_bp.route("/api/restore", methods=["POST"])
def restoreBackup():
    data = request.get_json(silent=True) or {}
    filename = str(data.get("filename", "")).strip()

    if not _FILENAME_RE.match(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    from db import invalidate_all_connections
    invalidate_all_connections()

    src = sqlite3.connect(str(backup_path))
    dst = sqlite3.connect(str(_DB_PATH))
    src.backup(dst)
    dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    dst.commit()
    dst.close()
    src.close()

    # Restore ajustes.json if a matching snapshot exists
    ts = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
    if ts:
        ajustes_backup = _BACKUP_DIR / f"ajustes_{ts.group(1)}.json"
        if ajustes_backup.exists():
            _AJUSTES_SRC.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ajustes_backup, _AJUSTES_SRC)

    return jsonify({"ok": True})


@backup_bp.route("/api/backups/<filename>", methods=["DELETE"])
def deleteBackup(filename):
    filename = filename.strip()
    if not _FILENAME_RE.match(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    backup_path.unlink()

    # Also remove matching ajustes snapshot if it exists
    ts = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
    if ts:
        ajustes_snap = _BACKUP_DIR / f"ajustes_{ts.group(1)}.json"
        if ajustes_snap.exists():
            ajustes_snap.unlink()

    return jsonify({"ok": True, "backups": _list_backups()})
