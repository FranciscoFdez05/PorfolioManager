import io
import sqlite3
import tempfile
import zipfile
from pathlib import Path

from flask import Blueprint, jsonify, request, send_file

from admin.portfolios_manager import (
    _PORTFOLIOS_DIR,
    NombreDuplicado,
    _safeId,
    createPortfolio,
    deletePortfolio,
    getPortfolios,
    registrarPortfolio,
    renamePortfolio,
    switchPortfolio,
)
from core import paths, settings, zip_seguro
from core.copia_sqlite import copiar as copiarSqlite
from core.escritura import limpiarTemporal, rutaTemporal, temporalPara
from stores.asset_utils import slugify

portfoliosBp = Blueprint("portfolios", __name__)


def _openPortfolioDb(dbFile):
    conn = sqlite3.connect(str(dbFile), check_same_thread=False, timeout=settings.backupSqliteTimeout())
    conn.row_factory = sqlite3.Row
    return conn


def _readAssetFromPortfolioDb(conn, assetId, pid, portfolioName):
    """Read a single asset from a given DB connection, returning camelCase data with prefixed IDs."""
    safeId = slugify(assetId)
    row = conn.execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, "
        "sort_order, price, currency, change, status, last_updated, color, tv_symbol, coste_anual "
        "FROM activos WHERE id = ?",
        (safeId,)
    ).fetchone()
    if row is None:
        return None

    prefixedId = f"{pid}__{row['id']}"
    result = {
        "id": prefixedId,
        "originalId": row["id"],
        "portfolioId": pid,
        "portfolioName": portfolioName,
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
        "costeAnual": row["coste_anual"],
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
            (safeId,)
        ).fetchall()
    ]

    result["operationRows"] = [
        {
            "id": r["id"],
            "assetId": prefixedId,
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
            (safeId,)
        ).fetchall()
    ]

    result["conversionRows"] = [
        {
            "id": r["id"],
            "fecha": r["fecha"],
            "par": r["par"],
            "tipo": r["tipo"],
            "cantidad": r["cantidad"],
            "cantidadContraparte": r["cantidad_contraparte"],
            "comision": r["comision"],
            "comisionMoneda": r["comision_moneda"],
            "valorEur": r["valor_eur"],
        }
        for r in conn.execute(
            "SELECT id, fecha, par, tipo, cantidad, cantidad_contraparte, comision, comision_moneda, valor_eur "
            "FROM activo_conversion_rows "
            "WHERE asset_id = ? ORDER BY rowid",
            (safeId,)
        ).fetchall()
    ]

    return result


@portfoliosBp.route("/api/portfolios", methods=["GET"])
def listPortfolios():
    meta = getPortfolios()
    return jsonify({"ok": True, "active": meta["active"], "portfolios": meta["portfolios"]})


@portfoliosBp.route("/api/portfolios", methods=["POST"])
def newPortfolio():
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "Nombre requerido"}), 400
    try:
        pid = createPortfolio(name)
        return jsonify({"ok": True, "id": pid})
    except NombreDuplicado as e:
        return jsonify({"ok": False, "error": str(e)}), 409
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfoliosBp.route("/api/portfolios/switch", methods=["POST"])
def doSwitch():
    data = request.get_json(silent=True) or {}
    pid = str(data.get("id", "")).strip()
    if not pid:
        return jsonify({"ok": False, "error": "ID requerido"}), 400
    try:
        switchPortfolio(pid)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfoliosBp.route("/api/portfolios/<pid>", methods=["DELETE"])
def removePortfolio(pid):
    try:
        deletePortfolio(pid)
        return jsonify({"ok": True})
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfoliosBp.route("/api/portfolios/<pid>/rename", methods=["POST"])
def rename(pid):
    data = request.get_json(silent=True) or {}
    name = str(data.get("name", "")).strip()
    if not name:
        return jsonify({"ok": False, "error": "Nombre requerido"}), 400
    try:
        renamePortfolio(pid, name)
        return jsonify({"ok": True})
    except NombreDuplicado as e:
        return jsonify({"ok": False, "error": str(e)}), 409
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400


@portfoliosBp.route("/api/portfolios/<pid>/export", methods=["GET"])
def exportPortfolio(pid):
    meta = getPortfolios()
    portfolio = next((p for p in meta["portfolios"] if p["id"] == pid), None)
    if not portfolio:
        return jsonify({"ok": False, "error": "Portfolio no encontrado"}), 404

    dbFile = _PORTFOLIOS_DIR / f"{pid}.db"
    if not dbFile.exists():
        return jsonify({"ok": False, "error": "Fichero de base de datos no encontrado"}), 404

    safeName = _safeId(portfolio["name"]) or pid
    downloadName = f"portfolio_{safeName}.db"

    # Copia consistente en memoria: shutil.copy2 del .db en caliente puede dejar
    # fuera lo que aún está en el -wal, y el NamedTemporaryFile(delete=False)
    # anterior nunca se borraba, acumulando una copia completa de la BD en el
    # directorio temporal en cada exportación.
    # El nombre llevaba el pid, que distingue a los dos workers de gunicorn pero
    # no a sus cuatro hilos: dos exportaciones del mismo portfolio a la vez
    # escribían el mismo fichero. rutaTemporal añade el hilo y un aleatorio.
    with temporalPara(dbFile, directorio=Path(tempfile.gettempdir())) as tmpPath:
        try:
            copiarSqlite(dbFile, tmpPath)
            payload = tmpPath.read_bytes()
        except Exception as e:
            return jsonify({"ok": False, "error": f"No se pudo exportar: {e}"}), 500

    return send_file(
        io.BytesIO(payload),
        mimetype="application/octet-stream",
        as_attachment=True,
        download_name=downloadName,
    )


def _dbDeUnZip(origen, destino: Path):
    """Extrae a `destino` la base de datos de un ZIP de la aplicación. Devuelve el error o None.

    Vale tanto el ZIP de «Exportar ZIP» —que lleva el `.db` en la raíz— como una
    copia de seguridad de una sola cartera, que lo lleva bajo `portfolios/`. Si
    la copia trae varias, no hay forma de adivinar cuál se quiere: se dice cuáles
    hay y se manda a Restaurar, que es lo que recupera todas de una vez.

    Se extrae a disco y con los límites de core/zip_seguro.py: antes se leía
    entera a memoria, y un ZIP pequeño con gigas de ceros tumbaba el worker.
    """
    try:
        with zipfile.ZipFile(origen, "r") as zf:
            zip_seguro.comprobar(zf)
            dañada = zf.testzip()
            if dañada:
                return f"El ZIP está dañado: {dañada}"
            bases = [n for n in zf.namelist() if n.endswith(".db")]
            if not bases:
                return "El ZIP no contiene ninguna base de datos"
            if len(bases) > 1:
                nombres = ", ".join(sorted(Path(n).stem for n in bases))
                return (
                    f"El ZIP contiene varias carteras ({nombres}). Para recuperarlas "
                    "todas usa Ajustes → Copias de seguridad → Restaurar."
                )
            zip_seguro.extraer(zf, bases[0], destino)
    except zipfile.BadZipFile:
        return "El archivo no es un ZIP válido"
    except zip_seguro.ZipNoAdmitido as error:
        return str(error)

    if not zip_seguro.esSqlite(destino):
        return "Lo que hay dentro del ZIP no es una base de datos SQLite"
    return None


@portfoliosBp.route("/api/portfolios/import", methods=["POST"])
def importPortfolio():
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

    esZip = header.startswith(b"PK")
    if not esZip and not file.read(16).startswith(b"SQLite format 3"):
        return jsonify({"ok": False, "error": "El fichero no es una base de datos SQLite válida"}), 400
    file.seek(0)

    # Guardar en temporal y validar antes de publicarlo como portfolio: escribir
    # directamente en dest dejaba un .db corrupto en data/portfolios si la
    # validación fallaba y el unlink no llegaba a ejecutarse.
    # El temporal va a data/tmp: en data/portfolios, un `_import_tmp_x.db` a
    # medio subir lo veía como un portfolio más cualquier `glob("*.db")` —la
    # copia automática, el backup manual, la rotación—, y con ficheros de
    # decenas de MB esa ventana dura segundos, no un instante.
    # El id se elige después, ya validado y bajo el cerrojo del índice
    # (admin.portfolios_manager.registrarPortfolio): elegirlo aquí, sin
    # cerrojo, dejaba que dos importaciones simultáneas se quedaran con el mismo.
    tmpDest = rutaTemporal(_PORTFOLIOS_DIR / "importacion.db", directorio=paths.TMP_DIR)
    try:
        if esZip:
            error = _dbDeUnZip(file.stream, tmpDest)
            if error:
                return jsonify({"ok": False, "error": error}), 400
        else:
            file.save(str(tmpDest))

        # Verificar integridad de verdad: antes se ejecutaba el PRAGMA pero
        # nunca se miraba el resultado, así que cualquier BD que se pudiera
        # abrir se aceptaba aunque integrity_check devolviese errores.
        conn = None
        try:
            conn = sqlite3.connect(str(tmpDest), timeout=settings.backupSqliteTimeout())
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

        pid = registrarPortfolio(name[:50], lambda destino: tmpDest.replace(destino), renombrarSiExiste=True)
    except Exception as e:
        return jsonify({"ok": False, "error": f"No se pudo importar: {e}"}), 400
    finally:
        limpiarTemporal(tmpDest)

    return jsonify({"ok": True, "id": pid})


@portfoliosBp.route("/api/portfolios/all-assets", methods=["GET"])
def allPortfoliosAssets():
    meta = getPortfolios()
    result = []
    for p in meta["portfolios"]:
        dbFile = _PORTFOLIOS_DIR / f"{p['id']}.db"
        if not dbFile.exists():
            continue
        conn = _openPortfolioDb(dbFile)
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


@portfoliosBp.route("/api/portfolios/<pid>/activo/<assetId>", methods=["GET"])
def portfolioActivo(pid, assetId):
    meta = getPortfolios()
    portfolio = next((p for p in meta["portfolios"] if p["id"] == pid), None)
    if not portfolio:
        return jsonify({"ok": False, "error": "Portfolio no encontrado"}), 404
    dbFile = _PORTFOLIOS_DIR / f"{pid}.db"
    if not dbFile.exists():
        return jsonify({"ok": False, "error": "DB no encontrada"}), 404
    conn = _openPortfolioDb(dbFile)
    try:
        result = _readAssetFromPortfolioDb(conn, assetId, pid, portfolio["name"])
        if result is None:
            return jsonify({"ok": False, "error": "Activo no encontrado"}), 404
        return jsonify(result)
    finally:
        conn.close()
