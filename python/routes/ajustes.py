import json
from pathlib import Path

from flask import Blueprint, jsonify, request

from api_stats import get_today_stats
from finnhub_client import fetch_exchange_rate

ajustes_bp = Blueprint("ajustes", __name__)
_BASE_DIR    = Path(__file__).resolve().parent.parent.parent
_API_DIR     = _BASE_DIR / "API"
_AJUSTES_JSON = _BASE_DIR / "data" / "JSON" / "ajustes.json"

_DEFAULTS = {
    "autoBackupDays": 0,
    "staleHours": 24,
    "autoRefreshMinutes": 0,
    "hiddenAssets": [],
    "theme": "default",
    "metricasDisplayType": "doughnut",
    "metricasDistMetric": "netoActualEur",
    "comparativaExcluded": [],
    "monedaBase": "EUR",
}


def _read_ajustes():
    if not _AJUSTES_JSON.exists():
        return dict(_DEFAULTS)
    try:
        stored = json.loads(_AJUSTES_JSON.read_text("utf-8"))
        return {**_DEFAULTS, **stored}
    except Exception:
        return dict(_DEFAULTS)


def _write_ajustes(data):
    _AJUSTES_JSON.parent.mkdir(parents=True, exist_ok=True)
    _AJUSTES_JSON.write_text(
        json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8"
    )


def get_setting(key):
    return _read_ajustes().get(key, _DEFAULTS.get(key, ""))


def set_setting(key, value):
    data = _read_ajustes()
    data[key] = value
    _write_ajustes(data)


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
    cfg = _read_ajustes()
    finnhub_raw = _read_key_file(_API_DIR / "finnhub.key")
    eodhd_raw   = _read_key_file(_API_DIR / "eodhd.key")
    return jsonify({
        "ok":             True,
        "finnhubKeyCount": len([k for k in finnhub_raw.splitlines() if k.strip()]),
        "eodhdKeyCount":   len([k for k in eodhd_raw.splitlines() if k.strip()]),
        "autoBackupDays":     int(cfg.get("autoBackupDays") or 0),
        "staleHours":         int(cfg.get("staleHours") or 24),
        "autoRefreshMinutes": int(cfg.get("autoRefreshMinutes") or 0),
        "hiddenAssets":        cfg.get("hiddenAssets") or [],
        "theme":               cfg.get("theme") or "default",
        "metricasDisplayType": cfg.get("metricasDisplayType") or "doughnut",
        "metricasDistMetric":  cfg.get("metricasDistMetric") or "netoActualEur",
        "comparativaExcluded": cfg.get("comparativaExcluded") or [],
        "gastosHiddenTipos":          cfg.get("gastosHiddenTipos") or [],
        "gastosHiddenMensualidades":  cfg.get("gastosHiddenMensualidades") or [],
        "metricasActivosHidden":      cfg.get("metricasActivosHidden") or [],
        "sidebarCollapsed":           bool(cfg.get("sidebarCollapsed", False)),
        "monedaBase":                 cfg.get("monedaBase") or "EUR",
    })


@ajustes_bp.route("/api/settings/apikey", methods=["POST"])
def append_api_key():
    data = request.get_json(silent=True) or {}
    if data.get("finnhubKey"):
        _append_key_file(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _append_key_file(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())
    return jsonify({
        "ok":         True,
        "finnhubKeys": len([k for k in _read_key_file(_API_DIR / "finnhub.key").splitlines() if k.strip()]),
        "eodhdKeys":   len([k for k in _read_key_file(_API_DIR / "eodhd.key").splitlines() if k.strip()]),
    })


@ajustes_bp.route("/api/stats/api-calls", methods=["GET"])
def get_api_call_stats():
    return jsonify({"ok": True, **get_today_stats()})


@ajustes_bp.route("/api/settings", methods=["POST"])
def save_settings():
    data = request.get_json(silent=True) or {}

    if data.get("finnhubKey"):
        _write_key_file(_API_DIR / "finnhub.key", str(data["finnhubKey"]).strip())
    if data.get("eodhdKeys"):
        _write_key_file(_API_DIR / "eodhd.key", str(data["eodhdKeys"]).strip())

    cfg = _read_ajustes()
    if "autoBackupDays" in data:
        cfg["autoBackupDays"] = int(data["autoBackupDays"])
    if "staleHours" in data:
        cfg["staleHours"] = int(data["staleHours"])
    if "autoRefreshMinutes" in data:
        cfg["autoRefreshMinutes"] = int(data["autoRefreshMinutes"]) if int(data["autoRefreshMinutes"]) in {0, 1, 5, 15, 30, 60} else 0
    if "hiddenAssets" in data:
        cfg["hiddenAssets"] = [str(i) for i in data["hiddenAssets"] if i]
    if "theme" in data:
        cfg["theme"] = str(data["theme"]) if data["theme"] in {"default", "black", "light"} else "default"
    if "metricasDisplayType" in data:
        cfg["metricasDisplayType"] = str(data["metricasDisplayType"]) if data["metricasDisplayType"] in {"doughnut", "bar"} else "doughnut"
    if "metricasDistMetric" in data:
        cfg["metricasDistMetric"] = str(data["metricasDistMetric"]) if data["metricasDistMetric"] in {"netoActualEur", "invertidoEur", "rendimientoEur"} else "netoActualEur"
    if "comparativaExcluded" in data:
        raw = data["comparativaExcluded"]
        cfg["comparativaExcluded"] = [str(t) for t in raw if isinstance(t, str) and t.strip()] if isinstance(raw, list) else []
    if "gastosHiddenTipos" in data:
        raw = data["gastosHiddenTipos"]
        cfg["gastosHiddenTipos"] = [str(t) for t in raw if isinstance(t, str) and t.strip()] if isinstance(raw, list) else []
    if "gastosHiddenMensualidades" in data:
        raw = data["gastosHiddenMensualidades"]
        cfg["gastosHiddenMensualidades"] = [str(t) for t in raw if isinstance(t, str) and t.strip()] if isinstance(raw, list) else []
    if "metricasActivosHidden" in data:
        raw = data["metricasActivosHidden"]
        cfg["metricasActivosHidden"] = [str(t) for t in raw if isinstance(t, str) and t.strip()] if isinstance(raw, list) else []
    if "sidebarCollapsed" in data:
        cfg["sidebarCollapsed"] = bool(data["sidebarCollapsed"])
    if "monedaBase" in data:
        cfg["monedaBase"] = str(data["monedaBase"]) if str(data["monedaBase"]) in {"EUR", "USD"} else "EUR"

    _write_ajustes(cfg)
    return jsonify({"ok": True})


@ajustes_bp.route("/api/exchange-rate", methods=["GET"])
def get_exchange_rate():
    source = str(request.args.get("from", "USD")).strip().upper()
    target = str(request.args.get("to", "EUR")).strip().upper()
    if source == target:
        return jsonify({"ok": True, "rate": 1.0, "from": source, "to": target})
    rate, error = fetch_exchange_rate(source, target)
    if error:
        return jsonify({"ok": False, "error": error}), 502
    return jsonify({"ok": True, "rate": rate, "from": source, "to": target})

