import re
import sqlite3
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

backup_bp = Blueprint("backup", __name__)

_BASE_DIR = Path(__file__).resolve().parent.parent.parent
_DB_PATH = _BASE_DIR / "data" / "portfolio.db"
_BACKUP_DIR = _BASE_DIR / "data" / "backups"
_FILENAME_RE = re.compile(r'^portfolio_\d{8}_\d{6}\.db$')


def _list_backups():
    if not _BACKUP_DIR.exists():
        return []
    files = sorted(
        [f.name for f in _BACKUP_DIR.iterdir() if _FILENAME_RE.match(f.name)],
        reverse=True
    )
    return files


@backup_bp.route("/api/backup", methods=["POST"])
def createBackup():
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"portfolio_{ts}.db"
    backup_path = _BACKUP_DIR / filename

    src = sqlite3.connect(str(_DB_PATH))
    dst = sqlite3.connect(str(backup_path))
    src.backup(dst)
    dst.close()
    src.close()

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

    # Close the thread-local connection so next request gets a fresh one
    from db import reset_db
    reset_db()

    src = sqlite3.connect(str(backup_path))
    dst = sqlite3.connect(str(_DB_PATH))
    src.backup(dst)
    dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    dst.commit()
    dst.close()
    src.close()

    return jsonify({"ok": True})
