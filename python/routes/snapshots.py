import datetime
import json
import logging
import time

from flask import Blueprint, jsonify, request

from core import settings
from core.db import get_db, transaction
from routes.ajustes import DEFAULT_SNAPSHOT_MINUTES, _read_ajustes

log = logging.getLogger(__name__)

snapshots_bp = Blueprint("snapshots", __name__)


def _interval_seconds() -> int:
    """Intervalo entre snapshots: lo que pida Ajustes, con un suelo del config.

    El intervalo es una preferencia del usuario (Ajustes), pero el suelo es un
    ajuste de despliegue: protege la BD de que un valor demasiado bajo llene la
    tabla de snapshots.
    """
    try:
        minutes = int(_read_ajustes().get("snapshotMinutes") or DEFAULT_SNAPSHOT_MINUTES)
    except (TypeError, ValueError):
        minutes = DEFAULT_SNAPSHOT_MINUTES
    return max(settings.snapshotIntervaloMinimo(), minutes * 60)

def _same_bucket(ts_a: int, ts_b: int, interval: int) -> bool:
    return ts_a // interval == ts_b // interval


@snapshots_bp.route("/api/portfolio/snapshot", methods=["POST"])
def save_snapshot():
    conn = get_db()
    now_ts   = int(time.time())
    interval = _interval_seconds()

    last = conn.execute(
        "SELECT ts FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1"
    ).fetchone()
    if last and _same_bucket(now_ts, last["ts"], interval):
        return jsonify({"ok": True, "skipped": True})

    body           = request.get_json(silent=True) or {}
    frontend_value = body.get("total_value")
    frontend_inv   = body.get("total_invested")

    if frontend_value is None or frontend_inv is None:
        return jsonify({"ok": True, "skipped": True})

    def _to_float(value):
        try:
            result = float(value)
        except (TypeError, ValueError):
            return None
        # NaN/inf corromperían los cálculos del histórico
        if result != result or result in (float("inf"), float("-inf")):
            return None
        return result

    total_value    = _to_float(frontend_value)
    total_invested = _to_float(frontend_inv)
    if total_value is None or total_invested is None:
        return jsonify({"ok": False, "error": "Valores numéricos inválidos"}), 400
    total_value    = round(total_value, 2)
    total_invested = round(total_invested, 2)

    assets = body.get("assets")
    if not isinstance(assets, list):
        assets = []

    with transaction() as conn:
        conn.execute(
            "INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
            (now_ts, total_value, total_invested)
        )

        # Guardar valor en EUR por activo para histórico del heatmap
        # El frontend envía netoEur recién calculado con precios de mercado frescos
        for a in assets:
            if not isinstance(a, dict):
                continue
            aid = str(a.get("id") or "").strip()
            v   = _to_float(a.get("v") or 0)
            c   = _to_float(a.get("c") or 0)
            if aid and v is not None and v > 0:
                conn.execute(
                    "INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, ?, ?, ?)",
                    (now_ts, aid, round(v, 2), round(c or 0, 2))
                )

    return jsonify({"ok": True, "skipped": False, "total_value": total_value, "total_invested": total_invested})


@snapshots_bp.route("/api/portfolio/history", methods=["GET"])
def get_history():
    range_param = request.args.get("range", "1M")
    now_ts      = int(time.time())

    range_map = {
        "1D": 86400, "1W": 7*86400, "1M": 30*86400,
        "3M": 90*86400, "6M": 180*86400, "1Y": 365*86400,
        "ALL": None, "YTD": None,
    }
    seconds = range_map.get(range_param, 30 * 86400)

    conn = get_db()
    if range_param == "YTD":
        jan1 = int(datetime.datetime(datetime.datetime.now().year, 1, 1).timestamp())
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots "
            "WHERE ts >= ? ORDER BY ts ASC", (jan1,)
        ).fetchall()
    elif seconds is None:
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts ASC"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots "
            "WHERE ts >= ? ORDER BY ts ASC", (now_ts - seconds,)
        ).fetchall()

    return jsonify({
        "ok": True, "range": range_param,
        "data": [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"]} for r in rows]
    })


@snapshots_bp.route("/api/portfolio/history/by-type", methods=["GET"])
def get_history_by_type():
    range_param = request.args.get("range", "1M")
    now_ts      = int(time.time())

    range_map = {
        "1D": 86400, "1W": 7*86400, "1M": 30*86400,
        "3M": 90*86400, "6M": 180*86400, "1Y": 365*86400,
        "ALL": None, "YTD": None,
    }
    seconds = range_map.get(range_param, 30 * 86400)

    conn = get_db()
    _SQL = """SELECT s.ts, a.type, SUM(s.price_eur) as v, SUM(s.cost_eur) as cost
              FROM asset_snapshots s
              JOIN activos a ON s.asset_id = a.id
              WHERE {where} a.type IS NOT NULL AND a.type != ''
              GROUP BY s.ts, a.type
              ORDER BY s.ts ASC"""

    if range_param == "YTD":
        jan1 = int(datetime.datetime(datetime.datetime.now().year, 1, 1).timestamp())
        rows = conn.execute(_SQL.format(where="s.ts >= ? AND"), (jan1,)).fetchall()
    elif seconds is None:
        rows = conn.execute(_SQL.format(where="")).fetchall()
    else:
        rows = conn.execute(_SQL.format(where="s.ts >= ? AND"), (now_ts - seconds,)).fetchall()

    ts_map = {}
    for r in rows:
        ts = r["ts"]
        if ts not in ts_map:
            ts_map[ts] = {}
        ts_map[ts][r["type"]]          = round(r["v"], 2)
        ts_map[ts][f"c_{r['type']}"]   = round(r["cost"] or 0, 2)

    data = [{"ts": ts, **types} for ts, types in sorted(ts_map.items())]
    return jsonify({"ok": True, "range": range_param, "data": data})


def _safety_copy_snapshots():
    """Vuelca los snapshots a JSON antes de un borrado destructivo."""
    from core.db import get_active_db_path
    try:
        conn = get_db()
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts"
        ).fetchall()
        if not rows:
            return None
        base = get_active_db_path().parent.parent / "pre_restore"
        base.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
        dest = base / f"snapshots_{get_active_db_path().stem}_{stamp}.json"
        dest.write_text(
            json.dumps([{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"]} for r in rows],
                       ensure_ascii=False),
            encoding="utf-8",
        )
        log.info("[snapshots] Copia previa al purgado guardada en %s", dest)
        return str(dest)
    except Exception as e:
        log.error("[snapshots] No se pudo guardar la copia previa al purgado: %s", e)
        return None


@snapshots_bp.route("/api/snapshots/purge", methods=["POST"])
def purge_snapshots():
    body = request.get_json(silent=True) or {}
    try:
        days = int(body.get("days", 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Valor de días inválido"}), 400
    if days == 0:
        return jsonify({"ok": True, "deleted": 0})
    if days == -1:
        # Borrado total del histórico: irreversible. Exige confirmación explícita
        # y deja antes una copia en data/pre_restore/, igual que el restore.
        if str(body.get("confirm", "")).strip().upper() != "BORRAR TODO":
            return jsonify({
                "ok": False,
                "error": "Para borrar todo el histórico envía confirm='BORRAR TODO'",
            }), 400
        safety = _safety_copy_snapshots()
        with transaction() as conn:
            cur = conn.execute("DELETE FROM portfolio_snapshots")
            conn.execute("DELETE FROM asset_snapshots")
        return jsonify({"ok": True, "deleted": cur.rowcount, "safetyCopy": safety})
    if days not in {30, 90, 180, 365}:
        return jsonify({"ok": False, "error": "Valor de días no permitido"}), 400
    cutoff = int(time.time()) - days * 86400
    with transaction() as conn:
        cur = conn.execute("DELETE FROM portfolio_snapshots WHERE ts < ?", (cutoff,))
        conn.execute("DELETE FROM asset_snapshots WHERE ts < ?", (cutoff,))
    return jsonify({"ok": True, "deleted": cur.rowcount})
