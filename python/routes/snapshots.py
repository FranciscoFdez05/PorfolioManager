import time
import datetime

from flask import Blueprint, jsonify, request

from db import get_db
from finnhub_client import fetch_exchange_rate
from helpers import parse_loose_number
from routes.ajustes import _read_ajustes

snapshots_bp = Blueprint("snapshots", __name__)

_MIN_INTERVAL = 60  # mínimo 1 minuto de intervalo

def _interval_seconds() -> int:
    minutes = int(_read_ajustes().get("snapshotMinutes") or 60)
    return max(_MIN_INTERVAL, minutes * 60)

def _same_bucket(ts_a: int, ts_b: int, interval: int) -> bool:
    """True si ambos timestamps caen en el mismo cubo de intervalo alineado al reloj."""
    return ts_a // interval == ts_b // interval


def _compute_portfolio_totals() -> tuple[float, float]:
    """Devuelve (total_value_eur, total_invested_eur) calculado desde la BD activa."""
    conn = get_db()
    assets = conn.execute(
        "SELECT id, price, currency, precio_currency, type FROM activos"
    ).fetchall()

    _rate_cache: dict[str, float] = {}

    def to_eur(amount: float, currency: str) -> float:
        if not currency or currency.upper() == "EUR" or amount == 0:
            return amount
        key = currency.upper()
        if key not in _rate_cache:
            rate, err = fetch_exchange_rate(key, "EUR")
            _rate_cache[key] = (rate or 1.0) if not err else 1.0
        return amount * _rate_cache[key]

    total_value = 0.0
    total_invested = 0.0

    for asset in assets:
        asset_id = asset["id"]
        asset_type = str(asset["type"] or "").strip().lower()
        is_crypto = asset_type == "cripto"
        current_price = parse_loose_number(str(asset["price"] or "")) or 0
        price_currency = str(asset["precio_currency"] or asset["currency"] or "EUR")

        rows = conn.execute(
            "SELECT tipo_operacion, participaciones, capital_invertido_bruto, "
            "comisiones, comisiones_fiat, currency FROM activo_rows WHERE asset_id = ?",
            (asset_id,)
        ).fetchall()

        op_rows = conn.execute(
            "SELECT orden, cantidad, comisiones_cripto, total, currency "
            "FROM activo_operation_rows WHERE asset_id = ? AND estado = 'Completado'",
            (asset_id,)
        ).fetchall()

        total_participaciones = 0.0
        total_invertido_bruto = 0.0
        total_comisiones_fiat = 0.0

        for row in rows:
            tipo = str(row["tipo_operacion"] or "").strip().lower()
            partic = parse_loose_number(str(row["participaciones"] or "")) or 0
            capital = parse_loose_number(str(row["capital_invertido_bruto"] or "")) or 0
            comis = parse_loose_number(str(row["comisiones"] or "")) or 0
            comis_fiat = parse_loose_number(str(row["comisiones_fiat"] or "")) or 0
            row_currency = str(row["currency"] or "EUR")

            if tipo == "venta":
                total_participaciones -= partic
            else:
                total_participaciones += partic
                total_invertido_bruto += to_eur(capital, row_currency)
                fee = comis_fiat if is_crypto else comis
                total_comisiones_fiat += to_eur(fee, row_currency)

        for op in op_rows:
            orden = str(op["orden"] or "").strip().lower()
            cantidad = parse_loose_number(str(op["cantidad"] or "")) or 0
            comis_cripto = parse_loose_number(str(op["comisiones_cripto"] or "")) or 0
            total_fiat = parse_loose_number(str(op["total"] or "")) or 0
            op_currency = str(op["currency"] or "EUR")

            if orden == "venta":
                total_participaciones -= cantidad + comis_cripto
            else:
                total_participaciones += max(0, cantidad - comis_cripto)
                total_invertido_bruto += to_eur(total_fiat, op_currency)

        inverted_neto = max(0, total_invertido_bruto - total_comisiones_fiat)
        neto_actual_local = max(0, total_participaciones) * current_price
        neto_actual_eur = to_eur(neto_actual_local, price_currency)

        total_value += neto_actual_eur
        total_invested += inverted_neto

    return round(total_value, 2), round(total_invested, 2)


@snapshots_bp.route("/api/portfolio/snapshot", methods=["POST"])
def save_snapshot():
    conn = get_db()
    now_ts = int(time.time())
    interval = _interval_seconds()

    last = conn.execute(
        "SELECT ts FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1"
    ).fetchone()
    if last and _same_bucket(now_ts, last["ts"], interval):
        return jsonify({"ok": True, "skipped": True})

    body = request.get_json(silent=True) or {}
    frontend_value    = body.get("total_value")
    frontend_invested = body.get("total_invested")

    if frontend_value is not None and frontend_invested is not None:
        total_value    = round(float(frontend_value), 2)
        total_invested = round(float(frontend_invested), 2)
    else:
        total_value, total_invested = _compute_portfolio_totals()

    conn.execute(
        "INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
        (now_ts, total_value, total_invested)
    )
    conn.commit()
    return jsonify({"ok": True, "skipped": False, "total_value": total_value, "total_invested": total_invested})


@snapshots_bp.route("/api/portfolio/history", methods=["GET"])
def get_history():
    from datetime import datetime
    range_param = request.args.get("range", "1M")
    now_ts = int(time.time())

    range_map = {
        "1D":  86400,
        "1W":  7 * 86400,
        "1M":  30 * 86400,
        "3M":  90 * 86400,
        "6M":  180 * 86400,
        "1Y":  365 * 86400,
        "ALL": None,
        "YTD": None,
    }
    seconds = range_map.get(range_param, 30 * 86400)

    conn = get_db()
    if range_param == "YTD":
        jan1 = int(datetime(datetime.now().year, 1, 1).timestamp())
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots "
            "WHERE ts >= ? ORDER BY ts ASC",
            (jan1,)
        ).fetchall()
    elif seconds is None:
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts ASC"
        ).fetchall()
    else:
        since = now_ts - seconds
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots "
            "WHERE ts >= ? ORDER BY ts ASC",
            (since,)
        ).fetchall()

    data = [
        {"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"]}
        for r in rows
    ]
    return jsonify({"ok": True, "range": range_param, "data": data})


@snapshots_bp.route("/api/snapshots/purge", methods=["POST"])
def purge_snapshots():
    body = request.get_json(silent=True) or {}
    days = int(body.get("days", 0))
    if days == 0:
        return jsonify({"ok": True, "deleted": 0})
    if days not in {30, 90, 180, 365}:
        return jsonify({"ok": False, "error": "Valor de días no permitido"}), 400
    cutoff = int(time.time()) - days * 86400
    conn = get_db()
    cur = conn.execute("DELETE FROM portfolio_snapshots WHERE ts < ?", (cutoff,))
    conn.commit()
    return jsonify({"ok": True, "deleted": cur.rowcount})
