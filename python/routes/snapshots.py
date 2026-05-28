import time
import datetime

from flask import Blueprint, jsonify, request

from db import get_db
from routes.ajustes import _read_ajustes

snapshots_bp = Blueprint("snapshots", __name__)

_MIN_INTERVAL = 60

def _interval_seconds() -> int:
    minutes = int(_read_ajustes().get("snapshotMinutes") or 60)
    return max(_MIN_INTERVAL, minutes * 60)

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

    total_value    = round(float(frontend_value), 2)
    total_invested = round(float(frontend_inv), 2)

    conn.execute(
        "INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
        (now_ts, total_value, total_invested)
    )

    # Guardar valor en EUR por activo para histórico del heatmap
    # El frontend envía netoEur recién calculado con precios de mercado frescos
    for a in body.get("assets") or []:
        aid = a.get("id")
        v   = float(a.get("v") or 0)
        if aid and v > 0:
            conn.execute(
                "INSERT INTO asset_snapshots (ts, asset_id, price_eur) VALUES (?, ?, ?)",
                (now_ts, aid, round(v, 2))
            )

    conn.commit()
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
    if range_param == "YTD":
        jan1 = int(datetime.datetime(datetime.datetime.now().year, 1, 1).timestamp())
        rows = conn.execute(
            """SELECT s.ts, a.type, SUM(s.price_eur) as v
               FROM asset_snapshots s
               JOIN activos a ON s.asset_id = a.id
               WHERE s.ts >= ? AND a.type IS NOT NULL AND a.type != ''
               GROUP BY s.ts, a.type
               ORDER BY s.ts ASC""",
            (jan1,)
        ).fetchall()
    elif seconds is None:
        rows = conn.execute(
            """SELECT s.ts, a.type, SUM(s.price_eur) as v
               FROM asset_snapshots s
               JOIN activos a ON s.asset_id = a.id
               WHERE a.type IS NOT NULL AND a.type != ''
               GROUP BY s.ts, a.type
               ORDER BY s.ts ASC"""
        ).fetchall()
    else:
        rows = conn.execute(
            """SELECT s.ts, a.type, SUM(s.price_eur) as v
               FROM asset_snapshots s
               JOIN activos a ON s.asset_id = a.id
               WHERE s.ts >= ? AND a.type IS NOT NULL AND a.type != ''
               GROUP BY s.ts, a.type
               ORDER BY s.ts ASC""",
            (now_ts - seconds,)
        ).fetchall()

    ts_map = {}
    for r in rows:
        ts = r["ts"]
        if ts not in ts_map:
            ts_map[ts] = {}
        ts_map[ts][r["type"]] = round(r["v"], 2)

    data = [{"ts": ts, **types} for ts, types in sorted(ts_map.items())]
    return jsonify({"ok": True, "range": range_param, "data": data})


@snapshots_bp.route("/api/snapshots/purge", methods=["POST"])
def purge_snapshots():
    body = request.get_json(silent=True) or {}
    days = int(body.get("days", 0))
    if days == 0:
        return jsonify({"ok": True, "deleted": 0})
    conn = get_db()
    if days == -1:
        cur = conn.execute("DELETE FROM portfolio_snapshots")
        conn.execute("DELETE FROM asset_snapshots")
        conn.commit()
        return jsonify({"ok": True, "deleted": cur.rowcount})
    if days not in {30, 90, 180, 365}:
        return jsonify({"ok": False, "error": "Valor de días no permitido"}), 400
    cutoff = int(time.time()) - days * 86400
    cur = conn.execute("DELETE FROM portfolio_snapshots WHERE ts < ?", (cutoff,))
    conn.execute("DELETE FROM asset_snapshots WHERE ts < ?", (cutoff,))
    conn.commit()
    return jsonify({"ok": True, "deleted": cur.rowcount})
