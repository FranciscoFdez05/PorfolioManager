import datetime
import json
import logging
import time

from flask import Blueprint, jsonify, request

from core import dinero, rentabilidad, settings
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


def reservar_bucket(now_ts=None) -> bool:
    """Reclama el hueco horario actual para el hilo del servidor.

    True si lo consigue este proceso, False si ya lo tenía otro. Sin esto, los
    dos workers de gunicorn arrancarían su propio hilo, pedirían cotizaciones a
    la vez para el mismo punto y una de las dos tandas de llamadas se tiraría a
    la basura al perder el INSERT.

    No sustituye a la comprobación de `guardar_snapshot`: esto solo evita el
    trabajo duplicado *antes* de gastar la cuota de API.
    """
    now_ts = int(now_ts if now_ts is not None else time.time())
    bucket = now_ts // _interval_seconds()
    conn   = get_db()

    conn.execute("BEGIN IMMEDIATE")
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO snapshot_jobs (bucket, ts) VALUES (?, ?)", (bucket, now_ts)
        )
        # La tabla es un cerrojo, no un histórico: solo interesa el pasado
        # inmediato para que un reloj que retrocede unos segundos no vuelva a
        # reclamar un bucket ya hecho.
        conn.execute("DELETE FROM snapshot_jobs WHERE bucket < ?", (bucket - 100,))
        conn.commit()
        return cur.rowcount > 0
    except Exception:
        conn.rollback()
        raise


def _a_real(value):
    """Importe listo para una columna REAL, o `None` si no se entiende.

    Las columnas del histórico son REAL, así que el punto acaba en coma
    flotante quiera uno o no; lo que cambia es cómo se llega hasta ahí. Antes
    era `float(value)` directo, con dos consecuencias:

      * un importe en el formato español que usa el resto del proyecto
        ("1.234,56") levantaba ValueError y el snapshot se rechazaba con un
        400, dejando un hueco en el histórico;
      * el redondeo posterior con `round()` usa el criterio del banquero
        (2,675 -> 2,67), distinto del que aplica el resto del cálculo.

    Ahora se lee y se redondea en Decimal y se convierte una sola vez, al
    final. NaN e infinitos siguen descartándose: corromperían el histórico y
    ninguna consulta posterior podría volver a sacarlos de ahí.
    """
    numero = dinero.aDecimalONulo(value)
    if numero is None:
        return None
    return float(dinero.redondear(numero))


def guardar_snapshot(total_value, total_invested, assets=(), now_ts=None) -> bool:
    """Escribe un punto del histórico si el hueco horario sigue libre.

    Devuelve True si se guardó y False si ya había un snapshot en el mismo
    bucket. La comprobación y la inserción van dentro de un BEGIN IMMEDIATE: con
    dos workers de gunicorn (y ahora también con el hilo del servidor y una
    pestaña abierta a la vez) el SELECT y el INSERT sueltos dejaban una ventana
    en la que ambos veían el bucket vacío y se guardaban dos puntos casi
    simultáneos.
    """
    now_ts   = int(now_ts if now_ts is not None else time.time())
    interval = _interval_seconds()
    conn     = get_db()

    conn.execute("BEGIN IMMEDIATE")
    try:
        last = conn.execute(
            "SELECT ts FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        if last and _same_bucket(now_ts, last["ts"], interval):
            conn.rollback()
            return False

        conn.execute(
            "INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
            (now_ts, _a_real(total_value) or 0.0, _a_real(total_invested) or 0.0)
        )

        # Guardar valor en EUR por activo para histórico del heatmap
        for a in assets or ():
            if not isinstance(a, dict):
                continue
            aid = str(a.get("id") or "").strip()
            v   = _a_real(a.get("v") or 0)
            c   = _a_real(a.get("c") or 0)
            if aid and v is not None and v > 0:
                conn.execute(
                    "INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, ?, ?, ?)",
                    (now_ts, aid, v, c or 0.0)
                )

        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise


@snapshots_bp.route("/api/portfolio/snapshot", methods=["POST"])
def save_snapshot():
    body           = request.get_json(silent=True) or {}
    frontend_value = body.get("total_value")
    frontend_inv   = body.get("total_invested")

    if frontend_value is None or frontend_inv is None:
        return jsonify({"ok": True, "skipped": True})

    total_value    = _a_real(frontend_value)
    total_invested = _a_real(frontend_inv)
    if total_value is None or total_invested is None:
        return jsonify({"ok": False, "error": "Valores numéricos inválidos"}), 400

    assets = body.get("assets")
    if not isinstance(assets, list):
        assets = []

    # El frontend envía netoEur recién calculado con precios de mercado frescos,
    # así que su punto vale igual que el del hilo del servidor: gana el primero
    # que llegue al bucket.
    guardado = guardar_snapshot(total_value, total_invested, assets)
    if not guardado:
        return jsonify({"ok": True, "skipped": True})

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


@snapshots_bp.route("/api/portfolio/rentabilidad", methods=["GET"])
def get_rentabilidad():
    """TWR, XIRR, drawdown y volatilidad sobre todo el histórico.

    Acepta `value`/`invested` para clavar el último punto con lo que el
    frontend tiene en pantalla: los snapshots se guardan cada pocos minutos y
    sin esto las KPIs de rentabilidad no cuadrarían con las de arriba.
    """
    conn = get_db()
    rows = conn.execute(
        "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts ASC"
    ).fetchall()
    snaps = [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"]} for r in rows]

    valor_vivo     = _a_real(request.args.get("value"))
    invertido_vivo = _a_real(request.args.get("invested"))
    if valor_vivo is not None and invertido_vivo is not None:
        ahora = int(time.time())
        # Mismo criterio que el gráfico de evolución: si el último snapshot es
        # de hace nada, se sustituye en vez de añadir un punto pegado a él.
        if snaps and ahora - snaps[-1]["ts"] < 120:
            snaps[-1] = {"ts": ahora, "v": valor_vivo, "i": invertido_vivo}
        else:
            snaps.append({"ts": ahora, "v": valor_vivo, "i": invertido_vivo})

    datos = rentabilidad.resumen(snaps)
    return jsonify({"ok": True, **datos})


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
