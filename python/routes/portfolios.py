import io
import os
import sqlite3
import tempfile
from pathlib import Path

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
from asset_utils import slugify

portfolios_bp = Blueprint("portfolios", __name__)


def _open_portfolio_db(db_file):
    conn = sqlite3.connect(str(db_file), check_same_thread=False, timeout=15)
    conn.row_factory = sqlite3.Row
    return conn


def _sqlite_backup(src_path: Path, dst_path: Path):
    """Copia consistente de un .db (incluye el WAL pendiente)."""
    src = dst = None
    try:
        src = sqlite3.connect(str(src_path), timeout=15)
        dst = sqlite3.connect(str(dst_path), timeout=15)
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


def _read_asset_from_portfolio_db(conn, asset_id, pid, portfolio_name):
    """Read a single asset from a given DB connection, returning camelCase data with prefixed IDs."""
    safe_id = slugify(asset_id)
    row = conn.execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, "
        "sort_order, price, currency, precio_currency, change, status, last_updated, color, tv_symbol "
        "FROM activos WHERE id = ?",
        (safe_id,)
    ).fetchone()
    if row is None:
        return None

    prefixed_id = f"{pid}__{row['id']}"
    result = {
        "id": prefixed_id,
        "originalId": row["id"],
        "portfolioId": pid,
        "portfolioName": portfolio_name,
        "name": row["name"],
        "symbol": row["symbol"],
        "marketProvider": row["market_provider"],
        "marketSymbol": row["market_symbol"],
        "finnhubSymbol": row["finnhub_symbol"],
        "type": row["type"],
        "order": row["sort_order"],
        "price": row["price"],
        "currency": row["currency"],
        "precioCurrency": row["precio_currency"],
        "change": row["change"],
        "status": row["status"],
        "lastUpdated": row["last_updated"],
        "color": row["color"],
        "tvSymbol": row["tv_symbol"],
    }

    result["rows"] = [
        {
            "fechaOperacion": r["fecha_operacion"],
            "tipoOperacion": r["tipo_operacion"],
            "exchange": r["exchange"],
            "currency": r["currency"],
            "participaciones": r["participaciones"],
            "precioParticipacion": r["precio_participacion"],
            "capitalInvertidoBruto": r["capital_invertido_bruto"],
            "costeAnual": r["coste_anual"],
            "comisiones": r["comisiones"],
            "comisionesFiat": r["comisiones_fiat"],
            "comisionesCripto": r["comisiones_cripto"],
            "comisionesSatoshis": r["comisiones_satoshis"],
        }
        for r in conn.execute(
            "SELECT fecha_operacion, tipo_operacion, exchange, currency, participaciones, "
            "precio_participacion, capital_invertido_bruto, coste_anual, comisiones, "
            "comisiones_fiat, comisiones_cripto, comisiones_satoshis "
            "FROM activo_rows WHERE asset_id = ? ORDER BY id",
            (safe_id,)
        ).fetchall()
    ]

    result["operationRows"] = [
        {
            "id": r["id"],
            "assetId": prefixed_id,
            "activo": r["activo"],
            "fechaApertura": r["fecha_apertura"],
            "par": r["par"],
            "stablecoinSymbol": r["stablecoin_symbol"],
            "orden": r["orden"],
            "precioOrden": r["precio_orden"],
            "precioCurrency": r["precio_currency"],
            "cantidad": r["cantidad"],
            "comisionesCripto": r["comisiones_cripto"],
            "total": r["total"],
            "currency": r["currency"],
            "estado": r["estado"],
            "fechaCierre": r["fecha_cierre"],
        }
        for r in conn.execute(
            "SELECT id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
            "precio_currency, cantidad, comisiones_cripto, total, currency, estado, fecha_cierre "
            "FROM activo_operation_rows WHERE asset_id = ? ORDER BY rowid",
            (safe_id,)
        ).fetchall()
    ]

    result["conversionRows"] = [
        {
            "id": r["id"],
            "fecha": r["fecha"],
            "par": r["par"],
            "tipo": r["tipo"],
            "cantidad": r["cantidad"],
        }
        for r in conn.execute(
            "SELECT id, fecha, par, tipo, cantidad FROM activo_conversion_rows "
            "WHERE asset_id = ? ORDER BY rowid",
            (safe_id,)
        ).fetchall()
    ]

    return result


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

    # Copia consistente en memoria: shutil.copy2 del .db en caliente puede dejar
    # fuera lo que aún está en el -wal, y el NamedTemporaryFile(delete=False)
    # anterior nunca se borraba, acumulando una copia completa de la BD en el
    # directorio temporal en cada exportación.
    from backup_manager import _remove_wal_sidecars
    tmp_path = Path(tempfile.gettempdir()) / f"_export_{pid}_{os.getpid()}.db"
    try:
        _sqlite_backup(db_file, tmp_path)
        payload = tmp_path.read_bytes()
    except Exception as e:
        return jsonify({"ok": False, "error": f"No se pudo exportar: {e}"}), 500
    finally:
        tmp_path.unlink(missing_ok=True)
        _remove_wal_sidecars(tmp_path)

    return send_file(
        io.BytesIO(payload),
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
    # Guardar en temporal y validar antes de publicarlo como portfolio: escribir
    # directamente en dest dejaba un .db corrupto en data/portfolios si la
    # validación fallaba y el unlink no llegaba a ejecutarse.
    tmp_dest = _PORTFOLIOS_DIR / f"_import_tmp_{pid}.db"
    try:
        file.save(str(tmp_dest))

        # Verificar integridad de verdad: antes se ejecutaba el PRAGMA pero
        # nunca se miraba el resultado, así que cualquier BD que se pudiera
        # abrir se aceptaba aunque integrity_check devolviese errores.
        conn = None
        try:
            conn = sqlite3.connect(str(tmp_dest), timeout=15)
            result = conn.execute("PRAGMA integrity_check").fetchone()
            if not result or result[0] != "ok":
                return jsonify({"ok": False, "error": "La base de datos importada está corrupta"}), 400
            if not conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name='activos'"
            ).fetchone():
                return jsonify({"ok": False, "error": "El fichero no es un portfolio de esta aplicación"}), 400
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass

        tmp_dest.replace(dest)
    except Exception as e:
        return jsonify({"ok": False, "error": f"No se pudo importar: {e}"}), 400
    finally:
        tmp_dest.unlink(missing_ok=True)
        for suffix in ("-wal", "-shm"):
            Path(str(tmp_dest) + suffix).unlink(missing_ok=True)

    meta["portfolios"].append({"id": pid, "name": name})
    from portfolios_manager import _write_meta
    _write_meta(meta)

    return jsonify({"ok": True, "id": pid})


@portfolios_bp.route("/api/portfolios/all-assets", methods=["GET"])
def all_portfolios_assets():
    meta = get_portfolios()
    result = []
    for p in meta["portfolios"]:
        db_file = _PORTFOLIOS_DIR / f"{p['id']}.db"
        if not db_file.exists():
            continue
        conn = _open_portfolio_db(db_file)
        try:
            assets = conn.execute(
                "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, "
                "sort_order, price, currency, precio_currency, change, status, last_updated, color, tv_symbol, "
                "COALESCE(hidden, 0) as hidden "
                "FROM activos ORDER BY sort_order"
            ).fetchall()
            for row in assets:
                result.append({
                    "id": f"{p['id']}__{row['id']}",
                    "originalId": row["id"],
                    "portfolioId": p["id"],
                    "portfolioName": p["name"],
                    "name": row["name"],
                    "symbol": row["symbol"],
                    "marketProvider": row["market_provider"],
                    "marketSymbol": row["market_symbol"],
                    "finnhubSymbol": row["finnhub_symbol"],
                    "type": row["type"],
                    "order": row["sort_order"],
                    "price": row["price"],
                    "currency": row["currency"],
                    "precioCurrency": row["precio_currency"],
                    "change": row["change"],
                    "status": row["status"],
                    "lastUpdated": row["last_updated"],
                    "color": row["color"],
                    "tvSymbol": row["tv_symbol"],
                    "hidden": bool(row["hidden"]),
                })
        except Exception:
            pass
        finally:
            conn.close()
    return jsonify({"ok": True, "assets": result})


@portfolios_bp.route("/api/portfolios/<pid>/activo/<asset_id>", methods=["GET"])
def portfolio_activo(pid, asset_id):
    meta = get_portfolios()
    portfolio = next((p for p in meta["portfolios"] if p["id"] == pid), None)
    if not portfolio:
        return jsonify({"ok": False, "error": "Portfolio no encontrado"}), 404
    db_file = _PORTFOLIOS_DIR / f"{pid}.db"
    if not db_file.exists():
        return jsonify({"ok": False, "error": "DB no encontrada"}), 404
    conn = _open_portfolio_db(db_file)
    try:
        result = _read_asset_from_portfolio_db(conn, asset_id, pid, portfolio["name"])
        if result is None:
            return jsonify({"ok": False, "error": "Activo no encontrado"}), 404
        return jsonify(result)
    finally:
        conn.close()
