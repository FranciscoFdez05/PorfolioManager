import io
import json
import zipfile
import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request, Response

from api_stats import get_today_stats
from db import get_db, get_active_db_path

ajustes_bp = Blueprint("ajustes", __name__)
_BASE_DIR    = Path(__file__).resolve().parent.parent.parent
_API_DIR     = _BASE_DIR / "API"
_AJUSTES_JSON = _BASE_DIR / "data" / "JSON" / "ajustes.json"

# Claves globales (compartidas entre todos los portfolios)
_GLOBAL_DEFAULTS = {
    "autoBackupDays": 0,
    "staleHours": 24,
    "autoRefreshMinutes": 0,
    "snapshotMinutes": 60,
    "theme": "default",
    "sidebarCollapsed": False,
    "monedaBase": "EUR",
    "precioDecimalesAcciones": 2,
    "precioDecimalesEtf": 2,
    "precioDecimalesComoditis": 2,
    "precioDecimalesCripto": 4,
    "soloHorarioMercado": False,
    "soloMercadoTipos": ["acciones", "etfs", "comoditis"],
    "bloqueoInactividad": 0,
    "numLocale": "es-ES",
    "dateFormat": "DD/MM/YYYY",
    "maxBackups": 0,
}

# Claves por portfolio (cada DB tiene su propio archivo prefs_{id}.json)
_PORTFOLIO_DEFAULTS = {
    "hiddenAssets": [],
    "comparativaExcluded": [],
    "gastosHiddenTipos": [],
    "gastosHiddenMensualidades": [],
    "metricasActivosHidden": [],
    "metricasDisplayType": "doughnut",
    "metricasDistMetric": "netoActualEur",
    "metricasSectionsCollapsed": [],
}

_GLOBAL_KEYS    = set(_GLOBAL_DEFAULTS)
_PORTFOLIO_KEYS = set(_PORTFOLIO_DEFAULTS)

# Mantener por compatibilidad con código que aún usa _DEFAULTS
_DEFAULTS = {**_GLOBAL_DEFAULTS, **_PORTFOLIO_DEFAULTS}


def _active_portfolio_id() -> str:
    return get_active_db_path().stem


def _prefs_path(portfolio_id: str) -> Path:
    return _BASE_DIR / "data" / "JSON" / f"prefs_{portfolio_id}.json"


def _read_ajustes():
    if not _AJUSTES_JSON.exists():
        return dict(_GLOBAL_DEFAULTS)
    try:
        stored = json.loads(_AJUSTES_JSON.read_text("utf-8"))
        return {**_GLOBAL_DEFAULTS, **{k: v for k, v in stored.items() if k in _GLOBAL_KEYS}}
    except Exception:
        return dict(_GLOBAL_DEFAULTS)


def _write_ajustes(data):
    _AJUSTES_JSON.parent.mkdir(parents=True, exist_ok=True)
    _AJUSTES_JSON.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def _read_prefs(portfolio_id: str) -> dict:
    path = _prefs_path(portfolio_id)
    if not path.exists():
        # Migración: extraer claves por-portfolio desde ajustes.json si existen
        try:
            raw = json.loads(_AJUSTES_JSON.read_text("utf-8")) if _AJUSTES_JSON.exists() else {}
            migrated = {k: raw[k] for k in _PORTFOLIO_KEYS if k in raw}
            return {**_PORTFOLIO_DEFAULTS, **migrated}
        except Exception:
            pass
        return dict(_PORTFOLIO_DEFAULTS)
    try:
        stored = json.loads(path.read_text("utf-8"))
        return {**_PORTFOLIO_DEFAULTS, **stored}
    except Exception:
        return dict(_PORTFOLIO_DEFAULTS)


def _write_prefs(portfolio_id: str, data: dict):
    path = _prefs_path(portfolio_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _read_key_file(path):
    if not path.exists():
        return ""
    lines = [l.strip() for l in path.read_text("utf-8").splitlines()
             if l.strip() and not l.startswith("#")]
    return "\n".join(lines)


def _write_key_file(path, value):
    path.parent.mkdir(exist_ok=True)
    path.write_text(value.strip() + "\n", encoding="utf-8")


def _append_key_file(path, value):
    path.parent.mkdir(exist_ok=True)
    existing = [k for k in _read_key_file(path).splitlines() if k.strip()]
    new_key = value.strip()
    if new_key and new_key not in existing:
        existing.append(new_key)
    path.write_text("\n".join(existing) + "\n", encoding="utf-8")


@ajustes_bp.route("/api/settings", methods=["GET"])
def get_settings():
    pid  = _active_portfolio_id()
    gcfg = _read_ajustes()
    pcfg = _read_prefs(pid)
    finnhub_raw      = _read_key_file(_API_DIR / "finnhub.key")
    eodhd_raw        = _read_key_file(_API_DIR / "eodhd.key")
    alphavantage_raw = _read_key_file(_API_DIR / "alphavantage.key")
    return jsonify({
        "ok":                    True,
        "finnhubKeyCount":       len([k for k in finnhub_raw.splitlines() if k.strip()]),
        "eodhdKeyCount":         len([k for k in eodhd_raw.splitlines() if k.strip()]),
        "alphaVantageKeyCount":  len([k for k in alphavantage_raw.splitlines() if k.strip()]),
        # Globales
        "autoBackupDays":        int(gcfg.get("autoBackupDays") or 0),
        "staleHours":            int(gcfg.get("staleHours") or 24),
        "autoRefreshMinutes":    int(gcfg.get("autoRefreshMinutes") or 0),
        "snapshotMinutes":       int(gcfg.get("snapshotMinutes") or 60),
        "theme":                 gcfg.get("theme") or "default",
        "sidebarCollapsed":      bool(gcfg.get("sidebarCollapsed", False)),
        "monedaBase":            gcfg.get("monedaBase") or "EUR",
        "precioDecimalesAcciones":  int(gcfg.get("precioDecimalesAcciones") or 2),
        "precioDecimalesEtf":       int(gcfg.get("precioDecimalesEtf") or 2),
        "precioDecimalesComoditis": int(gcfg.get("precioDecimalesComoditis") or 2),
        "precioDecimalesCripto":    int(gcfg.get("precioDecimalesCripto") or 4),
        "soloHorarioMercado":       bool(gcfg.get("soloHorarioMercado", False)),
        "soloMercadoTipos":         gcfg.get("soloMercadoTipos") or ["acciones", "etfs", "comoditis"],
        "bloqueoInactividad":       int(gcfg.get("bloqueoInactividad") or 0),
        "numLocale":                gcfg.get("numLocale") or "es-ES",
        "dateFormat":               gcfg.get("dateFormat") or "DD/MM/YYYY",
        "maxBackups":               int(gcfg.get("maxBackups") or 0),
        # Por-portfolio
        "hiddenAssets":             pcfg.get("hiddenAssets") or [],
        "comparativaExcluded":      pcfg.get("comparativaExcluded") or [],
        "gastosHiddenTipos":        pcfg.get("gastosHiddenTipos") or [],
        "gastosHiddenMensualidades": pcfg.get("gastosHiddenMensualidades") or [],
        "metricasActivosHidden":    pcfg.get("metricasActivosHidden") or [],
        "metricasDisplayType":      pcfg.get("metricasDisplayType") or "doughnut",
        "metricasDistMetric":       pcfg.get("metricasDistMetric") or "netoActualEur",
        "metricasSectionsCollapsed": pcfg.get("metricasSectionsCollapsed") or [],
    })


@ajustes_bp.route("/api/settings/apikey", methods=["POST"])
def append_api_key():
    data = request.get_json(silent=True) or {}
    if data.get("finnhubKey"):
        _append_key_file(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _append_key_file(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())
    if data.get("alphaVantageKeys"):
        _append_key_file(_API_DIR / "alphavantage.key", str(data["alphaVantageKeys"]).strip())
    return jsonify({
        "ok":               True,
        "finnhubKeys":      len([k for k in _read_key_file(_API_DIR / "finnhub.key").splitlines() if k.strip()]),
        "eodhdKeys":        len([k for k in _read_key_file(_API_DIR / "eodhd.key").splitlines() if k.strip()]),
        "alphaVantageKeys": len([k for k in _read_key_file(_API_DIR / "alphavantage.key").splitlines() if k.strip()]),
    })


@ajustes_bp.route("/api/stats/api-calls", methods=["GET"])
def get_api_call_stats():
    return jsonify({"ok": True, **get_today_stats()})


@ajustes_bp.route("/api/settings", methods=["POST"])
def save_settings():
    data = request.get_json(silent=True) or {}
    pid  = _active_portfolio_id()

    if data.get("finnhubKey"):
        _write_key_file(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _write_key_file(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())

    gcfg = _read_ajustes()
    pcfg = _read_prefs(pid)

    # ── Globales ──────────────────────────────────────────
    if "autoBackupDays" in data:
        gcfg["autoBackupDays"] = int(data["autoBackupDays"])
    if "staleHours" in data:
        gcfg["staleHours"] = int(data["staleHours"])
    if "autoRefreshMinutes" in data:
        gcfg["autoRefreshMinutes"] = int(data["autoRefreshMinutes"]) if int(data["autoRefreshMinutes"]) in {0, 1, 5, 15, 30, 60} else 0
    if "snapshotMinutes" in data:
        gcfg["snapshotMinutes"] = int(data["snapshotMinutes"]) if int(data["snapshotMinutes"]) in {0, 5, 15, 30, 60, 240, 1440} else 60
    if "theme" in data:
        gcfg["theme"] = str(data["theme"]) if data["theme"] in {"default", "black", "light"} else "default"
    if "sidebarCollapsed" in data:
        gcfg["sidebarCollapsed"] = bool(data["sidebarCollapsed"])
    if "monedaBase" in data:
        gcfg["monedaBase"] = str(data["monedaBase"]) if str(data["monedaBase"]) in {"EUR", "USD", "GBP", "CHF", "JPY"} else "EUR"
    _VALID_DECS  = {2, 4, 6, 8}
    _VALID_TIPOS = {"acciones", "etfs", "comoditis", "cripto"}
    for _k in ("precioDecimalesAcciones", "precioDecimalesEtf", "precioDecimalesComoditis", "precioDecimalesCripto"):
        if _k in data:
            try:
                v = int(data[_k])
                gcfg[_k] = v if v in _VALID_DECS else 2
            except (ValueError, TypeError):
                pass
    if "soloHorarioMercado" in data:
        gcfg["soloHorarioMercado"] = bool(data["soloHorarioMercado"])
    if "soloMercadoTipos" in data:
        raw = data["soloMercadoTipos"]
        gcfg["soloMercadoTipos"] = [t for t in raw if t in _VALID_TIPOS] if isinstance(raw, list) else []
    if "bloqueoInactividad" in data:
        gcfg["bloqueoInactividad"] = int(data["bloqueoInactividad"]) if int(data["bloqueoInactividad"]) in {0, 15, 30, 60, 240} else 0
    if "numLocale" in data:
        gcfg["numLocale"] = str(data["numLocale"]) if data["numLocale"] in {"es-ES", "en-US", "fr-FR"} else "es-ES"
    if "dateFormat" in data:
        gcfg["dateFormat"] = str(data["dateFormat"]) if data["dateFormat"] in {"DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"} else "DD/MM/YYYY"
    if "maxBackups" in data:
        v = int(data["maxBackups"])
        gcfg["maxBackups"] = v if v in {0, 5, 10, 20, 50} else 0

    # ── Por-portfolio ────────────────────────────────────
    if "hiddenAssets" in data:
        pcfg["hiddenAssets"] = [str(i) for i in data["hiddenAssets"] if i]
    if "metricasDisplayType" in data:
        pcfg["metricasDisplayType"] = str(data["metricasDisplayType"]) if data["metricasDisplayType"] in {"doughnut", "bar"} else "doughnut"
    if "metricasDistMetric" in data:
        pcfg["metricasDistMetric"] = str(data["metricasDistMetric"]) if data["metricasDistMetric"] in {"netoActualEur", "invertidoEur", "rendimientoEur"} else "netoActualEur"
    for _list_key in ("comparativaExcluded", "gastosHiddenTipos", "gastosHiddenMensualidades", "metricasActivosHidden", "metricasSectionsCollapsed"):
        if _list_key in data:
            raw = data[_list_key]
            pcfg[_list_key] = [str(t) for t in raw if isinstance(t, str) and t.strip()] if isinstance(raw, list) else []

    _write_ajustes(gcfg)
    _write_prefs(pid, pcfg)
    return jsonify({"ok": True})


@ajustes_bp.route("/api/export/json", methods=["GET"])
def export_json():
    pid  = _active_portfolio_id()
    conn = get_db()
    export = {
        "exported_at": datetime.datetime.utcnow().isoformat() + "Z",
        "version": 1,
        "ajustes": _read_ajustes(),
        "portfolio_prefs": _read_prefs(pid),
        "activos": [dict(r) for r in conn.execute("SELECT * FROM activos ORDER BY sort_order, rowid").fetchall()],
        "portfolio_snapshots": [dict(r) for r in conn.execute("SELECT * FROM portfolio_snapshots ORDER BY ts").fetchall()],
    }
    for table in ("dividendos", "gastos", "ingresos", "ventas", "transacciones",
                  "stablecoins", "operaciones", "bonos", "seguimiento"):
        try:
            export[table] = [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()]
        except Exception:
            export[table] = []

    payload = json.dumps(export, ensure_ascii=False, indent=2)
    return Response(
        payload,
        mimetype="application/json",
        headers={"Content-Disposition": f"attachment; filename=portfolio-export.json"}
    )


@ajustes_bp.route("/api/export/zip", methods=["GET"])
def export_zip():
    pid  = _active_portfolio_id()
    conn = get_db()
    export = {
        "exported_at": datetime.datetime.utcnow().isoformat() + "Z",
        "version": 1,
        "ajustes": _read_ajustes(),
        "portfolio_prefs": _read_prefs(pid),
        "activos": [dict(r) for r in conn.execute("SELECT * FROM activos ORDER BY sort_order, rowid").fetchall()],
        "portfolio_snapshots": [dict(r) for r in conn.execute("SELECT * FROM portfolio_snapshots ORDER BY ts").fetchall()],
    }
    for table in ("dividendos", "gastos", "ingresos", "ventas", "transacciones",
                  "stablecoins", "operaciones", "bonos", "seguimiento"):
        try:
            export[table] = [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY rowid").fetchall()]
        except Exception:
            export[table] = []

    json_bytes = json.dumps(export, ensure_ascii=False, indent=2).encode("utf-8")

    buf = io.BytesIO()
    date_str = datetime.datetime.utcnow().strftime("%Y-%m-%d")
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"portfolio-export-{date_str}.json", json_bytes)
        db_path = get_active_db_path()
        if db_path.exists():
            zf.write(str(db_path), f"portfolio-{date_str}.db")
        if _AJUSTES_JSON.exists():
            zf.write(str(_AJUSTES_JSON), "ajustes.json")
        prefs_file = _prefs_path(pid)
        if prefs_file.exists():
            zf.write(str(prefs_file), f"prefs_{pid}.json")

    buf.seek(0)
    return Response(
        buf.read(),
        mimetype="application/zip",
        headers={"Content-Disposition": f"attachment; filename=portfolio-export-{date_str}.zip"}
    )


def _restore_tables_from_dict(conn, data: dict):
    """Restaura tablas de la BD activa desde un dict de exportación."""
    import sqlite3 as _sqlite3
    tables = ["activos", "portfolio_snapshots", "dividendos", "gastos", "ingresos",
              "ventas", "transacciones", "stablecoins", "operaciones", "bonos", "seguimiento"]
    for table in tables:
        if table not in data or not isinstance(data[table], list):
            continue
        rows = data[table]
        if not rows:
            conn.execute(f"DELETE FROM {table}")
            continue
        try:
            actual_cols = {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}
            valid_cols  = [c for c in rows[0].keys() if c in actual_cols]
            if not valid_cols:
                continue
            conn.execute(f"DELETE FROM {table}")
            col_str      = ", ".join(f'"{c}"' for c in valid_cols)
            placeholders = ", ".join("?" for _ in valid_cols)
            conn.executemany(
                f"INSERT OR IGNORE INTO {table} ({col_str}) VALUES ({placeholders})",
                [[row.get(c) for c in valid_cols] for row in rows],
            )
        except Exception as e:
            conn.rollback()
            raise RuntimeError(f"Error restaurando {table}: {e}")
    conn.commit()


@ajustes_bp.route("/api/import/json", methods=["POST"])
def import_json():
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "No se recibió ningún archivo"}), 400
    try:
        data = json.loads(f.read().decode("utf-8"))
    except Exception:
        return jsonify({"ok": False, "error": "Archivo JSON inválido"}), 400

    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "Formato de archivo incorrecto"}), 400

    pid  = _active_portfolio_id()
    conn = get_db()

    if "ajustes" in data and isinstance(data["ajustes"], dict):
        _write_ajustes(data["ajustes"])
    if "portfolio_prefs" in data and isinstance(data["portfolio_prefs"], dict):
        _write_prefs(pid, data["portfolio_prefs"])

    try:
        _restore_tables_from_dict(conn, data)
    except RuntimeError as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True})


@ajustes_bp.route("/api/import/zip", methods=["POST"])
def import_zip():
    import sqlite3 as _sqlite3
    f = request.files.get("file")
    if not f:
        return jsonify({"ok": False, "error": "No se recibió ningún archivo"}), 400

    raw_bytes = f.read()
    try:
        buf = io.BytesIO(raw_bytes)
        with zipfile.ZipFile(buf, "r") as zf:
            bad = zf.testzip()
            if bad:
                return jsonify({"ok": False, "error": f"ZIP corrupto: {bad}"}), 400
            names = zf.namelist()
    except zipfile.BadZipFile:
        return jsonify({"ok": False, "error": "El archivo no es un ZIP válido"}), 400

    pid      = _active_portfolio_id()
    db_path  = get_active_db_path()
    json_dir = _AJUSTES_JSON.parent

    try:
        buf = io.BytesIO(raw_bytes)
        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()

            # Buscar .db en la raíz del ZIP (export format: portfolio-{date}.db)
            root_db = next((n for n in names if n.endswith(".db") and "/" not in n), None)

            if root_db:
                from db import invalidate_all_connections
                raw_db = zf.read(root_db)
                tmp    = db_path.parent / f"_import_tmp_{db_path.name}"
                try:
                    tmp.write_bytes(raw_db)
                    invalidate_all_connections()
                    src = _sqlite3.connect(str(tmp))
                    dst = _sqlite3.connect(str(db_path))
                    src.backup(dst)
                    dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
                    dst.commit()
                    dst.close()
                    src.close()
                finally:
                    tmp.unlink(missing_ok=True)
            else:
                # Sin .db → restaurar desde el JSON interno
                json_name = next((n for n in names if n.endswith(".json") and "export" in n and "/" not in n), None)
                if json_name:
                    data = json.loads(zf.read(json_name).decode("utf-8"))
                    if isinstance(data, dict):
                        conn = get_db()
                        _restore_tables_from_dict(conn, data)

            # Restaurar ajustes.json
            if "ajustes.json" in names:
                json_dir.mkdir(parents=True, exist_ok=True)
                _AJUSTES_JSON.write_bytes(zf.read("ajustes.json"))

            # Restaurar prefs por-portfolio
            for name in names:
                if name.startswith("prefs_") and name.endswith(".json") and "/" not in name:
                    (json_dir / name).write_bytes(zf.read(name))

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True})

