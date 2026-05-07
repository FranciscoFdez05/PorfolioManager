import shutil
import sqlite3
import tempfile

from flask import Blueprint, jsonify, request, send_file

from portfolios_manager import (
    _PORTFOLIOS_DIR,
    _safe_id,
    create_portfolio,
    delete_portfolio,
    get_portfolios,
    rename_portfolio,
    switch_portfolio,
)

portfolios_bp = Blueprint("portfolios", __name__)


@portfolios_bp.route("/api/portfolios", methods=["GET"])
def list_portfolios():
    meta = get_portfolios()
    return jsonify({"ok": True, "active": meta["active"], "portfolios": meta["portfolios"]})


@portfolios_bp.route("/api/portfolios", methods=["POST"])
def new_portfolio():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "Nombre requerido"}), 400
    try:
        pid = create_portfolio(name)
        return jsonify({"ok": True, "id": pid})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfolios_bp.route("/api/portfolios/switch", methods=["POST"])
def do_switch():
    data = request.get_json(silent=True) or {}
    pid = str(data.get("id", "")).strip()
    if not pid:
        return jsonify({"ok": False, "error": "ID requerido"}), 400
    try:
        switch_portfolio(pid)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfolios_bp.route("/api/portfolios/<pid>", methods=["DELETE"])
def remove_portfolio(pid):
    try:
        delete_portfolio(pid)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfolios_bp.route("/api/portfolios/<pid>/rename", methods=["POST"])
def rename(pid):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "Nombre requerido"}), 400
    try:
        rename_portfolio(pid, name)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfolios_bp.route("/api/portfolios/<pid>/export", methods=["GET"])
def export_portfolio(pid):
    meta = get_portfolios()
    portfolio = next((p for p in meta["portfolios"] if p["id"] == pid), None)
    if not portfolio:
        return jsonify({"ok": False, "error": "Portfolio no encontrado"}), 404

    db_file = _PORTFOLIOS_DIR / f"{pid}.db"
    if not db_file.exists():
        return jsonify({"ok": False, "error": "Fichero de base de datos no encontrado"}), 404

    safe_name = _safe_id(portfolio["name"]) or pid
    download_name = f"portfolio_{safe_name}.db"

    # Enviar una copia para no bloquear el fichero activo
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".db")
    tmp.close()
    shutil.copy2(str(db_file), tmp.name)

    return send_file(
        tmp.name,
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=download_name,
    )


@portfolios_bp.route("/api/portfolios/import", methods=["POST"])
def import_portfolio():
    name = request.form.get("name", "").strip()
    file = request.files.get("file")

    if not name:
        return jsonify({"ok": False, "error": "Nombre requerido"}), 400
    if not file:
        return jsonify({"ok": False, "error": "Fichero requerido"}), 400

    # Validar que el fichero es un SQLite válido
    header = file.read(16)
    if not header.startswith(b"SQLite format 3"):
        return jsonify({"ok": False, "error": "El fichero no es una base de datos SQLite válida"}), 400
    file.seek(0)

    # Generar ID y guardar
    meta = get_portfolios()
    base_id = _safe_id(name)
    pid = base_id
    existing_ids = {p["id"] for p in meta["portfolios"]}
    counter = 2
    while pid in existing_ids:
        pid = f"{base_id}_{counter}"
        counter += 1

    _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
    dest = _PORTFOLIOS_DIR / f"{pid}.db"
    file.save(str(dest))

    # Verificar integridad básica
    try:
        conn = sqlite3.connect(str(dest))
        conn.execute("PRAGMA integrity_check")
        conn.close()
    except Exception:
        dest.unlink(missing_ok=True)
        return jsonify({"ok": False, "error": "La base de datos importada está corrupta"}), 400

    meta["portfolios"].append({"id": pid, "name": name})
    from portfolios_manager import _write_meta
    _write_meta(meta)

    return jsonify({"ok": True, "id": pid})
