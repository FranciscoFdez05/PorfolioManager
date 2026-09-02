import io
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from admin.portfolios_manager import (
    _PORTFOLIOS_DIR,
    _safe_id,
    create_portfolio,
    delete_portfolio,
    get_portfolios,
    rename_portfolio,
    switch_portfolio,
)
from core import paths, settings
from core.escritura import limpiarTemporal, rutaTemporal, temporalPara
from stores.asset_utils import slugify

portfolios_bp = Blueprint("portfolios", __name__)


def _open_portfolio_db(db_file):
    conn = sqlite3.connect(str(db_file), check_same_thread=False, timeout=settings.backupSqliteTimeout())
    conn.row_factory = sqlite3.Row
    return conn


def _sqlite_backup(src_path: Path, dst_path: Path):
    """Copia consistente de un .db (incluye el WAL pendiente)."""
    src = dst = None
    try:
        src = sqlite3.connect(str(src_path), timeout=settings.backupSqliteTimeout())
        dst = sqlite3.connect(str(dst_path), timeout=settings.backupSqliteTimeout())
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
        "sort_order, price, currency, change, status, last_updated, color, tv_symbol "
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
            "comisionesFiat": r["comisiones_fiat"],
            "total": r["total"],
            "currency": r["currency"],
            "estado": r["estado"],
            "fechaCierre": r["fecha_cierre"],
        }
        for r in conn.execute(
            "SELECT id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
            "precio_currency, cantidad, comisiones_cripto, comisiones_fiat, total, currency, estado, fecha_cierre "
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
    # El nombre llevaba el pid, que distingue a los dos workers de gunicorn pero
    # no a sus cuatro hilos: dos exportaciones del mismo portfolio a la vez
    # escribían el mismo fichero. rutaTemporal añade el hilo y un aleatorio.
    with temporalPara(db_file, directorio=Path(tempfile.gettempdir())) as tmp_path:
        try:
            _sqlite_backup(db_file, tmp_path)
            payload = tmp_path.read_bytes()
        except Exception as e:
            return jsonify({"ok": False, "error": f"No se pudo exportar: {e}"}), 500

    return send_file(
        io.BytesIO(payload),
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=download_name,
    )


def _db_de_un_zip(datos: bytes):
    """Saca la base de datos de un ZIP de la aplicación. Devuelve (bytes, error).

    Vale tanto el ZIP de «Exportar ZIP» —que lleva el `.db` en la raíz— como una
    copia de seguridad de una sola cartera, que lo lleva bajo `portfolios/`. Si
    la copia trae varias, no hay forma de adivinar cuál se quiere: se dice cuáles
    hay y se manda a Restaurar, que es lo que recupera todas de una vez.
    """
    try:
        with zipfile.ZipFile(io.BytesIO(datos), "r") as zf:
            dañada = zf.testzip()
            if dañada:
                return None, f"El ZIP está dañado: {dañada}"
            bases = [n for n in zf.namelist() if n.endswith(".db")]
            if not bases:
                return None, "El ZIP no contiene ninguna base de datos"
            if len(bases) > 1:
                nombres = ", ".join(sorted(Path(n).stem for n in bases))
                return None, (
                    f"El ZIP contiene varias carteras ({nombres}). Para recuperarlas "
                    "todas usa Ajustes → Copias de seguridad → Restaurar."
                )
            contenido = zf.read(bases[0])
    except zipfile.BadZipFile:
        return None, "El archivo no es un ZIP válido"

    if not contenido.startswith(b"SQLite format 3"):
        return None, "Lo que hay dentro del ZIP no es una base de datos SQLite"
    return contenido, None


@portfolios_bp.route("/api/portfolios/import", methods=["POST"])
def import_portfolio():
    name = request.form.get("name", "").strip()
    file = request.files.get("file")

    if not name:
        return jsonify({"ok": False, "error": "Nombre requerido"}), 400
    if not file:
        return jsonify({"ok": False, "error": "Fichero requerido"}), 400

    # El fichero puede ser el .db suelto o el ZIP que genera «Exportar ZIP»:
    # los dos salen de esta misma aplicación y no tiene sentido que uno se
    # acepte y el otro dé «no es una base de datos SQLite válida», que es lo
    # que pasaba al elegir aquí el zip.
    header = file.read(4)
    file.seek(0)

    if header.startswith(b"PK"):
        contenido, error = _db_de_un_zip(file.read())
        if error:
            return jsonify({"ok": False, "error": error}), 400
        file = io.BytesIO(contenido)
    elif not file.read(16).startswith(b"SQLite format 3"):
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
    # El temporal va a data/tmp: en data/portfolios, un `_import_tmp_x.db` a
    # medio subir lo veía como un portfolio más cualquier `glob("*.db")` —la
    # copia automática, el backup manual, la rotación—, y con ficheros de
    # decenas de MB esa ventana dura segundos, no un instante.
    tmp_dest = rutaTemporal(dest, directorio=paths.TMP_DIR)
    try:
        if hasattr(file, "save"):
            file.save(str(tmp_dest))
        else:
            tmp_dest.write_bytes(file.read())

        # Verificar integridad de verdad: antes se ejecutaba el PRAGMA pero
        # nunca se miraba el resultado, así que cualquier BD que se pudiera
        # abrir se aceptaba aunque integrity_check devolviese errores.
        conn = None
        try:
            conn = sqlite3.connect(str(tmp_dest), timeout=settings.backupSqliteTimeout())
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
        limpiarTemporal(tmp_dest)

    meta["portfolios"].append({"id": pid, "name": name})
    from admin.portfolios_manager import _write_meta
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
                "sort_order, price, currency, change, status, last_updated, color, tv_symbol, "
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
