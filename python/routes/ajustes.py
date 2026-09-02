import datetime
import io
import json
import logging
import re
import zipfile
from pathlib import Path

from flask import Blueprint, Response, jsonify, request

from core import paths, settings
from core.db import get_active_db_path, get_db
from core.errors import registrarFalloEscritura
from core.escritura import escribirJsonAtomico, temporalPara
from core.paths import AJUSTES_JSON as _AJUSTES_JSON, API_DIR as _API_DIR, JSON_DIR
from core.secret_store import read_secret_lines, write_secret_lines
from providers.api_stats import get_today_stats

log = logging.getLogger(__name__)

ajustes_bp = Blueprint("ajustes", __name__)

# Claves globales (compartidas entre todos los portfolios)
_FIAT_DEFAULTS = [
    {"code": "EUR", "name": "Euro"},
    {"code": "USD", "name": "Dólar estadounidense"},
    {"code": "GBP", "name": "Libra esterlina"},
    {"code": "CHF", "name": "Franco suizo"},
    {"code": "JPY", "name": "Yen japonés"},
]

# Expuesto aparte porque routes/snapshots.py necesita el mismo valor cuando
# ajustes.json no trae uno legible, y duplicarlo dejaba los dos sitios libres
# para divergir.
DEFAULT_SNAPSHOT_MINUTES = 60

_GLOBAL_DEFAULTS = {
    "autoBackupDays": 0,
    "staleHours": 24,
    "autoRefreshMinutes": 0,
    "snapshotMinutes": DEFAULT_SNAPSHOT_MINUTES,
    # Qué portfolios cubre el hilo de snapshots del servidor: solo el activo
    # (lo que hacía el navegador) o todos.
    "snapshotAlcance": "activo",
    "theme": "default",
    "sidebarCollapsed": False,
    "monedaBase": "EUR",
    "fiatCurrencies": _FIAT_DEFAULTS,
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
    "gastosMostrarPausadas": False,
    "metricasActivosHidden": [],
    "metricasDisplayType": "doughnut",
    "metricasDistMetric": "netoActualEur",
    "metricasSectionsCollapsed": [],
    "topMetricsConfig": {},
    "modulosConfig": {},
    "ahorroConfig": {"objetivoAhorro": 30, "presupuesto": {}},
}

_GLOBAL_KEYS    = set(_GLOBAL_DEFAULTS)
_PORTFOLIO_KEYS = set(_PORTFOLIO_DEFAULTS)

# Mantener por compatibilidad con código que aún usa _DEFAULTS
_DEFAULTS = {**_GLOBAL_DEFAULTS, **_PORTFOLIO_DEFAULTS}


def _active_portfolio_id() -> str:
    return get_active_db_path().stem


def _prefs_path(portfolio_id: str) -> Path:
    return JSON_DIR / f"prefs_{portfolio_id}.json"


def _read_ajustes():
    if not _AJUSTES_JSON.exists():
        return dict(_GLOBAL_DEFAULTS)
    try:
        stored = json.loads(_AJUSTES_JSON.read_text("utf-8"))
        return {**_GLOBAL_DEFAULTS, **{k: v for k, v in stored.items() if k in _GLOBAL_KEYS}}
    except Exception:
        return dict(_GLOBAL_DEFAULTS)


def _atomic_write_json(path: Path, data) -> None:
    """Escribe JSON de forma atómica y durable: tmp → fsync → rename.

    write_text() directo truncaba el fichero antes de escribirlo: un fallo a
    mitad dejaba un JSON inválido y _read_ajustes/_read_prefs caen al valor por
    defecto en silencio, es decir, todos los ajustes perdidos sin aviso.

    La mecánica vive ahora en core/escritura.py, que es de donde la toman
    también los backups y portfolios.json: era el mismo procedimiento escrito
    de tres formas distintas, y solo una de las tres era correcta.
    """
    escribirJsonAtomico(path, data)


def _write_ajustes(data):
    _atomic_write_json(_AJUSTES_JSON, data)


def _read_prefs(portfolio_id: str) -> dict:
    path = _prefs_path(portfolio_id)
    if not path.exists():
        # Migración: extraer claves por-portfolio desde ajustes.json si existen
        try:
            raw = json.loads(_AJUSTES_JSON.read_text("utf-8")) if _AJUSTES_JSON.exists() else {}
            migrated = {k: raw[k] for k in _PORTFOLIO_KEYS if isinstance(raw, dict) and k in raw}
            return {**_PORTFOLIO_DEFAULTS, **migrated}
        except Exception:
            pass
        return dict(_PORTFOLIO_DEFAULTS)
    try:
        stored = json.loads(path.read_text("utf-8"))
        if not isinstance(stored, dict):
            return dict(_PORTFOLIO_DEFAULTS)
        # Filtrar a las claves conocidas, igual que _read_ajustes: un prefs
        # importado podía inyectar claves arbitrarias que luego se reescriben.
        return {**_PORTFOLIO_DEFAULTS, **{k: v for k, v in stored.items() if k in _PORTFOLIO_KEYS}}
    except Exception:
        return dict(_PORTFOLIO_DEFAULTS)


def _write_prefs(portfolio_id: str, data: dict):
    _atomic_write_json(_prefs_path(portfolio_id), data)


def _as_int(value, default, allowed=None):
    """int() tolerante. Un valor no numérico en ajustes.json (o en el JSON de un
    import) reventaba GET /api/settings con un 500 permanente que dejaba la app
    inutilizable, porque no había forma de corregir el ajuste desde la UI."""
    try:
        result = int(value)
    except (TypeError, ValueError):
        return default
    if allowed is not None and result not in allowed:
        return default
    return result


def _read_key_file(path):
    """Claves del fichero, descifrando si está en formato cifrado."""
    return "\n".join(read_secret_lines(path))


def _write_key_file(path, value):
    write_secret_lines(path, str(value).splitlines())


def _append_key_file(path, value):
    existing = read_secret_lines(path)
    new_key = str(value).strip()
    if new_key and new_key not in existing:
        existing.append(new_key)
    write_secret_lines(path, existing)


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
        "autoBackupDays":        _as_int(gcfg.get("autoBackupDays"), 0),
        "staleHours":            _as_int(gcfg.get("staleHours"), 24),
        "autoRefreshMinutes":    _as_int(gcfg.get("autoRefreshMinutes"), 0),
        "snapshotMinutes":       _as_int(gcfg.get("snapshotMinutes"), 60),
        "snapshotAlcance":       gcfg.get("snapshotAlcance") or "activo",
        "snapshotServidor":      settings.snapshotServidorActivo(),
        "theme":                 gcfg.get("theme") or "default",
        "sidebarCollapsed":      bool(gcfg.get("sidebarCollapsed", False)),
        "monedaBase":            gcfg.get("monedaBase") or "EUR",
        "precioDecimalesAcciones":  _as_int(gcfg.get("precioDecimalesAcciones"), 2),
        "precioDecimalesEtf":       _as_int(gcfg.get("precioDecimalesEtf"), 2),
        "precioDecimalesComoditis": _as_int(gcfg.get("precioDecimalesComoditis"), 2),
        "precioDecimalesCripto":    _as_int(gcfg.get("precioDecimalesCripto"), 4),
        "soloHorarioMercado":       bool(gcfg.get("soloHorarioMercado", False)),
        "soloMercadoTipos":         gcfg.get("soloMercadoTipos") or ["acciones", "etfs", "comoditis"],
        "bloqueoInactividad":       _as_int(gcfg.get("bloqueoInactividad"), 0),
        "numLocale":                gcfg.get("numLocale") or "es-ES",
        "dateFormat":               gcfg.get("dateFormat") or "DD/MM/YYYY",
        "maxBackups":               _as_int(gcfg.get("maxBackups"), 0),
        # Por-portfolio
        "hiddenAssets":             pcfg.get("hiddenAssets") or [],
        "comparativaExcluded":      pcfg.get("comparativaExcluded") or [],
        "gastosHiddenTipos":        pcfg.get("gastosHiddenTipos") or [],
        "gastosHiddenMensualidades": pcfg.get("gastosHiddenMensualidades") or [],
        "gastosMostrarPausadas":    bool(pcfg.get("gastosMostrarPausadas", False)),
        "metricasActivosHidden":    pcfg.get("metricasActivosHidden") or [],
        "metricasDisplayType":      pcfg.get("metricasDisplayType") or "doughnut",
        "metricasDistMetric":       pcfg.get("metricasDistMetric") or "netoActualEur",
        "metricasSectionsCollapsed": pcfg.get("metricasSectionsCollapsed") or [],
        "topMetricsConfig":         pcfg.get("topMetricsConfig") or {},
        "modulosConfig":            pcfg.get("modulosConfig") or {},
        "ahorroConfig":             pcfg.get("ahorroConfig") or {"objetivoAhorro": 30, "presupuesto": {}},
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
    # Faltaba: /api/settings/apikey sí permitía añadir claves de Alpha Vantage,
    # pero guardarlas desde la pantalla de ajustes las descartaba en silencio.
    if data.get("alphaVantageKeys"):
        _write_key_file(_API_DIR / "alphavantage.key", str(data["alphaVantageKeys"]).strip())

    gcfg = _read_ajustes()
    pcfg = _read_prefs(pid)

    # ── Globales ──────────────────────────────────────────
    if "autoBackupDays" in data:
        gcfg["autoBackupDays"] = max(0, min(365, _as_int(data["autoBackupDays"], 0)))
    if "staleHours" in data:
        gcfg["staleHours"] = max(1, min(8760, _as_int(data["staleHours"], 24)))
    if "autoRefreshMinutes" in data:
        gcfg["autoRefreshMinutes"] = _as_int(data["autoRefreshMinutes"], 0, {0, 1, 5, 15, 30, 60})
    if "snapshotMinutes" in data:
        gcfg["snapshotMinutes"] = _as_int(data["snapshotMinutes"], 60, {0, 5, 15, 30, 60, 240, 1440})
    if "snapshotAlcance" in data:
        alcance = str(data["snapshotAlcance"]).strip().lower()
        gcfg["snapshotAlcance"] = alcance if alcance in {"activo", "todos"} else "activo"
    if "theme" in data:
        gcfg["theme"] = str(data["theme"]) if data["theme"] in {"default", "black", "light"} else "default"
    if "sidebarCollapsed" in data:
        gcfg["sidebarCollapsed"] = bool(data["sidebarCollapsed"])
    if "fiatCurrencies" in data:
        raw = data["fiatCurrencies"]
        if isinstance(raw, list):
            validated = []
            seen = set()
            for item in raw:
                if isinstance(item, dict):
                    code = str(item.get("code", "")).strip().upper()
                    name = str(item.get("name", "")).strip()
                    if code and name and code.isalpha() and 2 <= len(code) <= 5 and code not in seen:
                        validated.append({"code": code, "name": name})
                        seen.add(code)
            if validated:
                gcfg["fiatCurrencies"] = validated
    if "monedaBase" in data:
        valid_codes = {c["code"] for c in gcfg.get("fiatCurrencies", _FIAT_DEFAULTS)}
        gcfg["monedaBase"] = str(data["monedaBase"]) if str(data["monedaBase"]) in valid_codes else "EUR"
    _VALID_DECS  = {2, 4, 6, 8}
    _VALID_TIPOS = {"acciones", "etfs", "comoditis", "cripto"}
    for _k in ("precioDecimalesAcciones", "precioDecimalesEtf", "precioDecimalesComoditis", "precioDecimalesCripto"):
        if _k in data:
            gcfg[_k] = _as_int(data[_k], 2, _VALID_DECS)
    if "soloHorarioMercado" in data:
        gcfg["soloHorarioMercado"] = bool(data["soloHorarioMercado"])
    if "soloMercadoTipos" in data:
        raw = data["soloMercadoTipos"]
        gcfg["soloMercadoTipos"] = [t for t in raw if t in _VALID_TIPOS] if isinstance(raw, list) else []
    if "bloqueoInactividad" in data:
        gcfg["bloqueoInactividad"] = _as_int(data["bloqueoInactividad"], 0, {0, 15, 30, 60, 240})
    if "numLocale" in data:
        gcfg["numLocale"] = str(data["numLocale"]) if data["numLocale"] in {"es-ES", "en-US", "fr-FR"} else "es-ES"
    if "dateFormat" in data:
        gcfg["dateFormat"] = str(data["dateFormat"]) if data["dateFormat"] in {"DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"} else "DD/MM/YYYY"
    if "maxBackups" in data:
        gcfg["maxBackups"] = _as_int(data["maxBackups"], 0, {0, 5, 10, 20, 50})

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
    if "gastosMostrarPausadas" in data:
        pcfg["gastosMostrarPausadas"] = bool(data["gastosMostrarPausadas"])
    if "topMetricsConfig" in data:
        raw = data["topMetricsConfig"]
        if isinstance(raw, dict):
            pcfg["topMetricsConfig"] = {k: bool(v) for k, v in raw.items() if isinstance(k, str)}
    _VALID_MODULOS = {
        "panelSuperior", "vistaGeneral", "activos", "gastos",
        "finanzas", "cripto", "herramientas", "metricas",
    }
    if "modulosConfig" in data:
        raw = data["modulosConfig"]
        if isinstance(raw, dict):
            pcfg["modulosConfig"] = {k: bool(v) for k, v in raw.items() if k in _VALID_MODULOS}
    if "ahorroConfig" in data:
        raw = data["ahorroConfig"]
        if isinstance(raw, dict):
            try:
                obj = max(0.0, min(100.0, float(raw.get("objetivoAhorro", 30))))
            except (ValueError, TypeError):
                obj = 30.0
            pres_raw = raw.get("presupuesto", {})
            presupuesto = {}
            if isinstance(pres_raw, dict):
                for k, v in pres_raw.items():
                    k_clean = str(k)[:80].strip()
                    try:
                        v_clean = max(0.0, min(100.0, float(v)))
                    except (ValueError, TypeError):
                        v_clean = 0.0
                    if k_clean:
                        presupuesto[k_clean] = v_clean
            pcfg["ahorroConfig"] = {"objetivoAhorro": obj, "presupuesto": presupuesto}

    try:
        _write_ajustes(gcfg)
        _write_prefs(pid, pcfg)
    except OSError as e:
        # Igual que en /api/backup: si el fallo es del disco (permisos del
        # volumen en Docker, montaje de solo lectura, disco lleno), el manejador
        # genérico devolvía "Error interno del servidor" y no había forma de
        # saber por qué los ajustes no se guardaban.
        mensaje = registrarFalloEscritura(
            log, "[ajustes] No se pudieron guardar los ajustes", e, JSON_DIR
        )
        return jsonify({"ok": False, "error": mensaje}), 500
    return jsonify({"ok": True})


# Los nombres de tabla se interpolan en las consultas de export/import porque
# SQLite no admite parametrizar identificadores. Se restringen a un patrón
# seguro: una BD subida por /api/portfolios/import podría traer una tabla con
# comillas o corchetes en el nombre y romper el entrecomillado.
_SAFE_TABLE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

# Nombres de fichero de prefs admisibles al importar un zip (mismo patrón que
# usa el restore de backups en routes/backup.py)
_RE_SAFE_PREFS_NAME = re.compile(r"^prefs_[A-Za-z0-9_-]{1,64}\.json$")


def _real_tables(conn) -> list:
    """Tablas de datos que existen realmente en la BD activa, en orden estable."""
    nombres = [
        r[0] for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
    ]
    seguras = [n for n in nombres if _SAFE_TABLE_RE.match(n)]
    for descartada in set(nombres) - set(seguras):
        log.warning("[export] Tabla con nombre no admitido, se omite: %r", descartada)
    return seguras


def _build_export(conn, pid: str) -> dict:
    """Volcado completo de la BD activa.

    Antes se exportaba una lista fija de 11 nombres de los que 4 ni existían
    ('gastos', 'ingresos', 'stablecoins', 'seguimiento'), y quedaban fuera
    tablas con todos los movimientos: activo_rows, activo_operation_rows,
    gastos_rows, mensualidades, ingresos_rows, intereses_v2, staking_rows,
    earn_rows, trading, renta_fija, private_market… El "export completo" perdía
    casi todos los datos. Ahora se enumera el esquema real.
    """
    export = {
        "exported_at": datetime.datetime.now(datetime.UTC).isoformat(),
        "version": 3,
        "ajustes": _read_ajustes(),
        "portfolio_prefs": _read_prefs(pid),
        "tables": {},
    }
    for table in _real_tables(conn):
        rows = conn.execute(f'SELECT * FROM "{table}"').fetchall()
        export["tables"][table] = [dict(r) for r in rows]
    return export


@ajustes_bp.route("/api/export/json", methods=["GET"])
def export_json():
    pid  = _active_portfolio_id()
    conn = get_db()
    export = _build_export(conn, pid)

    payload = json.dumps(export, ensure_ascii=False, indent=2)
    return Response(
        payload,
        mimetype="application/json",
        headers={"Content-Disposition": "attachment; filename=portfolio-export.json"}
    )


@ajustes_bp.route("/api/export/zip", methods=["GET"])
def export_zip():
    pid  = _active_portfolio_id()
    conn = get_db()
    export = _build_export(conn, pid)

    json_bytes = json.dumps(export, ensure_ascii=False, indent=2).encode("utf-8")

    buf = io.BytesIO()
    date_str = datetime.datetime.now().strftime("%Y-%m-%d")
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr(f"portfolio-export-{date_str}.json", json_bytes)
        db_path = get_active_db_path()
        if db_path.exists():
            # Copia vía API de backup: zf.write() del .db en caliente puede
            # capturar páginas a medias y dejar en el zip una BD corrupta,
            # porque los cambios recientes viven aún en el fichero -wal.
            zf.writestr(f"portfolio-{date_str}.db", _consistent_db_bytes(db_path))
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


def _consistent_db_bytes(db_path) -> bytes:
    """Bytes de una copia consistente del .db (incluye el WAL pendiente).

    El temporal va a data/tmp. Antes se llamaba `_tmp_export_<portfolio>.db` y
    se creaba **dentro de data/portfolios**, donde todo el proyecto hace
    `glob("*.db")` para saber qué portfolios existen: exportar mientras corría
    una copia de seguridad metía la exportación a medias en el backup como si
    fuera un portfolio más.
    """
    import sqlite3 as _sqlite3
    with temporalPara(db_path, directorio=paths.TMP_DIR) as tmp:
        return _copiar_db_a_bytes(db_path, tmp, _sqlite3)


def _copiar_db_a_bytes(db_path, tmp, _sqlite3) -> bytes:
    src = dst = None
    try:
        src = _sqlite3.connect(str(db_path), timeout=settings.dbTimeout())
        dst = _sqlite3.connect(str(tmp), timeout=settings.dbTimeout())
        src.backup(dst)
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst.commit()
        dst.close()
        dst = None
        src.close()
        src = None
        return tmp.read_bytes()
    finally:
        for conn in (dst, src):
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass


def _restore_tables_from_dict(conn, data: dict):
    """Restaura tablas de la BD activa desde un dict de exportación.

    Todo ocurre en UNA transacción: si algo falla se revierte por completo. La
    versión anterior ejecutaba 'DELETE FROM gastos' (tabla inexistente) fuera de
    su try/except, así que importar el propio export siempre lanzaba
    OperationalError con las tablas ya vaciadas dentro de una transacción
    abierta que nadie revertía.
    """
    tables_payload = data.get("tables")
    if not isinstance(tables_payload, dict):
        # Formato legacy: las tablas eran claves de primer nivel
        tables_payload = {k: v for k, v in data.items() if isinstance(v, list)}

    existing = set(_real_tables(conn))
    skipped = [name for name in tables_payload if name not in existing]
    if skipped:
        log.warning("[import] Tablas del fichero que no existen en el esquema, ignoradas: %s",
                    ", ".join(sorted(skipped)))

    targets = [t for t in sorted(tables_payload)
               if t in existing and isinstance(tables_payload[t], list)]

    try:
        # Aplaza la verificación de FK al commit, para poder insertar hijos antes
        # que padres sin violar las referencias.
        conn.execute("PRAGMA defer_foreign_keys=ON")

        # Pasada 1: vaciar TODO antes de insertar nada. Intercalar DELETE e
        # INSERT perdía datos: activo_rows se insertaba antes del
        # 'DELETE FROM activos' (orden alfabético) y el ON DELETE CASCADE de
        # activos borraba las filas recién insertadas. defer_foreign_keys no
        # evita eso: aplaza la comprobación de constraints, no las acciones
        # CASCADE.
        for table in targets:
            conn.execute(f'DELETE FROM "{table}"')

        # Pasada 2: insertar
        for table in targets:
            rows = tables_payload[table]
            if not rows or not isinstance(rows[0], dict):
                continue
            actual_cols = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}
            valid_cols = [c for c in rows[0] if c in actual_cols]
            if not valid_cols:
                continue
            col_str      = ", ".join(f'"{c}"' for c in valid_cols)
            placeholders = ", ".join("?" for _ in valid_cols)
            conn.executemany(
                f'INSERT OR IGNORE INTO "{table}" ({col_str}) VALUES ({placeholders})',
                [[row.get(c) for c in valid_cols] for row in rows if isinstance(row, dict)],
            )
        conn.commit()
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        raise RuntimeError(f"Error restaurando datos: {e}") from e


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

    db_path  = get_active_db_path()
    json_dir = _AJUSTES_JSON.parent

    try:
        buf = io.BytesIO(raw_bytes)
        with zipfile.ZipFile(buf, "r") as zf:
            names = zf.namelist()

            # Buscar .db en la raíz del ZIP (export format: portfolio-{date}.db)
            root_db = next((n for n in names if n.endswith(".db") and "/" not in n), None)

            if root_db:
                from core.db import invalidate_all_connections
                raw_db = zf.read(root_db)
                tmp    = db_path.parent / f"_import_tmp_{db_path.name}"
                try:
                    tmp.write_bytes(raw_db)
                    invalidate_all_connections()
                    src = _sqlite3.connect(str(tmp), timeout=settings.backupSqliteTimeout())
                    dst = _sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
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

            # Restaurar prefs por-portfolio. El nombre se reduce a su parte
            # final y se valida contra un patrón: comprobar solo que no hubiera
            # "/" dejaba pasar entradas como "prefs_..\..\algo.json", que en
            # Windows escriben fuera de data/JSON (allí "\" sí separa rutas).
            for name in names:
                prefs_name = Path(name).name
                if _RE_SAFE_PREFS_NAME.match(prefs_name):
                    json_dir.mkdir(parents=True, exist_ok=True)
                    (json_dir / prefs_name).write_bytes(zf.read(name))
                elif prefs_name.startswith("prefs_"):
                    log.warning("[import] Entrada de prefs ignorada por nombre inseguro: %r", name)

    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500

    return jsonify({"ok": True})

