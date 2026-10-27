import datetime
import json
import logging
import time

from flask import Blueprint, current_app, jsonify, request

from core import dinero, rentabilidad, settings
from core.db import getDb, transaction
from routes.ajustes import DEFAULT_SNAPSHOT_MINUTES, _readAjustes
from stores import historico_snapshots, historico_tipos
from stores.flujos_snapshot import tomarFlujo

log = logging.getLogger(__name__)

snapshotsBp = Blueprint("snapshots", __name__)


def _intervalSeconds() -> int:
    """Intervalo entre snapshots: lo que pida Ajustes, con un suelo del config.

    El intervalo es una preferencia del usuario (Ajustes), pero el suelo es un
    ajuste de despliegue: protege la BD de que un valor demasiado bajo llene la
    tabla de snapshots.
    """
    try:
        minutes = int(_readAjustes().get("snapshotMinutes") or DEFAULT_SNAPSHOT_MINUTES)
    except (TypeError, ValueError):
        minutes = DEFAULT_SNAPSHOT_MINUTES
    return max(settings.snapshotIntervaloMinimo(), minutes * 60)

def _sameBucket(tsA: int, tsB: int, interval: int) -> bool:
    return tsA // interval == tsB // interval


def tramoOcupado(nowTs=None) -> bool:
    """Si el último snapshot ya cae en el hueco horario de `nowTs`.

    Lectura previa y barata para no valorar la cartera (decenas de ms) cuando el
    punto se va a rechazar igualmente. No es la comprobación definitiva: esa
    sigue dentro del BEGIN IMMEDIATE de `guardarSnapshot`, que es la única que
    cierra la carrera entre workers.

    Args:
        nowTs: Instante a comprobar; por defecto, ahora.

    Returns:
        True si el hueco está ocupado.
    """
    nowTs = int(nowTs if nowTs is not None else time.time())
    last = getDb().execute("SELECT ts FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1").fetchone()
    return bool(last) and _sameBucket(nowTs, last["ts"], _intervalSeconds())


def reservarBucket(nowTs=None) -> bool:
    """Reclama el hueco horario actual para el hilo del servidor.

    True si lo consigue este proceso, False si ya lo tenía otro. Sin esto, los
    dos workers de gunicorn arrancarían su propio hilo, pedirían cotizaciones a
    la vez para el mismo punto y una de las dos tandas de llamadas se tiraría a
    la basura al perder el INSERT.

    No sustituye a la comprobación de `guardarSnapshot`: esto solo evita el
    trabajo duplicado *antes* de gastar la cuota de API.
    """
    nowTs = int(nowTs if nowTs is not None else time.time())
    bucket = nowTs // _intervalSeconds()
    conn   = getDb()

    conn.execute("BEGIN IMMEDIATE")
    try:
        cur = conn.execute(
            "INSERT OR IGNORE INTO snapshot_jobs (bucket, ts) VALUES (?, ?)", (bucket, nowTs)
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


def _aReal(value):
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
    try:
        return float(dinero.redondear(numero))
    except dinero.ImporteInvalido:
        # Demasiados dígitos para Decimal: se trata como un importe ilegible.
        return None


def guardarSnapshot(totalValue, totalInvested, assets=(), nowTs=None) -> bool:
    """Escribe un punto del histórico si el hueco horario sigue libre.

    Devuelve True si se guardó y False si ya había un snapshot en el mismo
    bucket. La comprobación y la inserción van dentro de un BEGIN IMMEDIATE: con
    dos workers de gunicorn (y ahora también con el hilo del servidor y una
    pestaña abierta a la vez) el SELECT y el INSERT sueltos dejaban una ventana
    en la que ambos veían el bucket vacío y se guardaban dos puntos casi
    simultáneos.
    """
    nowTs   = int(nowTs if nowTs is not None else time.time())
    interval = _intervalSeconds()
    conn     = getDb()

    conn.execute("BEGIN IMMEDIATE")
    try:
        last = conn.execute(
            "SELECT ts FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1"
        ).fetchone()
        if last and _sameBucket(nowTs, last["ts"], interval):
            conn.rollback()
            return False

        # Mismo instante y misma transacción que el valor: el flujo es lo que ha
        # entrado o salido entre este punto y el anterior (stores/flujos_snapshot.py).
        conn.execute(
            "INSERT INTO portfolio_snapshots (ts, total_value, total_invested, flujo) VALUES (?, ?, ?, ?)",
            (nowTs, _aReal(totalValue) or 0.0, _aReal(totalInvested) or 0.0, tomarFlujo(conn))
        )

        # Guardar valor en EUR por activo para histórico del heatmap
        for a in assets or ():
            if not isinstance(a, dict):
                continue
            aid = str(a.get("id") or "").strip()
            v   = _aReal(a.get("v") or 0)
            c   = _aReal(a.get("c") or 0)
            if aid and v is not None and v > 0:
                conn.execute(
                    "INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, ?, ?, ?)",
                    (nowTs, aid, v, c or 0.0)
                )

        conn.commit()
        return True
    except Exception:
        conn.rollback()
        raise


# Diferencia relativa máxima entre el total que calcula la pestaña (precios
# recién refrescados) y el que calcula el servidor (últimos precios guardados).
_TOLERANCIA_SNAPSHOT = 0.02


def _omitido(motivo: str):
    """Respuesta de un snapshot que no se guarda, con el motivo.

    Motivos: sin_totales, pestana_sin_precios, sin_posiciones,
    valoracion_incompleta, totales_distintos, importacion_en_curso y
    tramo_ocupado.
    """
    return jsonify({"ok": True, "skipped": True, "motivo": motivo})


def _coinciden(cliente: float, servidor: float) -> bool:
    return abs(cliente - servidor) <= _TOLERANCIA_SNAPSHOT * max(abs(servidor), 1.0)


@snapshotsBp.route("/api/portfolio/snapshot", methods=["POST"])
def saveSnapshot():
    body           = request.get_json(silent=True) or {}
    frontendValue = body.get("total_value")
    frontendInv   = body.get("total_invested")

    if frontendValue is None or frontendInv is None:
        return _omitido("sin_totales")

    totalValue    = _aReal(frontendValue)
    totalInvested = _aReal(frontendInv)
    if totalValue is None or totalInvested is None:
        return jsonify({"ok": False, "error": "Valores numéricos inválidos"}), 400
    if totalValue < 0 or totalInvested < 0:
        return jsonify({"ok": False, "error": "Los valores no pueden ser negativos"}), 400
    if totalValue == 0 and totalInvested > 0:
        # Una página que aún no ha cargado los precios manda valor cero con lo
        # invertido ya calculado; guardarlo ocuparía el hueco con un punto falso
        # y rechazaría el bueno ("gana el primero").
        return _omitido("pestana_sin_precios")

    # Los totales de la pestaña solo se validan arriba: una pestaña a medio cargar
    # (o con otra cartera) mandaba un punto falso que ocupaba el hueco del bueno.
    # El punto que se guarda lo calcula el servidor con sus datos, igual que el
    # hilo de fondo; el hueco sigue siendo del primero que llegue.
    from core.bloqueo import BloqueoOcupado
    from routes.backup import bloqueoSiLibre
    from stores.valoracion import valorarPortfolio

    try:
        # Una importación o un restore está sustituyendo la cartera.
        with bloqueoSiLibre():
            if tramoOcupado():
                return _omitido("tramo_ocupado")
            valoracion = valorarPortfolio(refrescarPrecios=False)
            if valoracion["activos"] == 0:
                return _omitido("sin_posiciones")
            if not valoracion["completa"]:
                return _omitido("valoracion_incompleta")
            if not _coinciden(totalValue, valoracion["total_value"]):
                # Dos cálculos independientes que no coinciden: o la pestaña está
                # a medio cargar, o la valoración del servidor no cuenta algo. En
                # los dos casos un punto guardado ahora sería falso.
                log.warning(
                    "[snapshots] El navegador calcula %.2f y el servidor %.2f; no se guarda el punto",
                    totalValue, valoracion["total_value"],
                )
                return _omitido("totales_distintos")
            log.info(
                "[snapshots] Manual: el navegador calcula %.2f y el servidor %.2f; se guarda el del servidor",
                totalValue, valoracion["total_value"],
            )
            guardado = guardarSnapshot(
                valoracion["total_value"], valoracion["total_invested"], valoracion["assets"]
            )
    except BloqueoOcupado:
        return _omitido("importacion_en_curso")
    if not guardado:
        return _omitido("tramo_ocupado")

    return jsonify({
        "ok": True, "skipped": False,
        "total_value": valoracion["total_value"], "total_invested": valoracion["total_invested"],
    })


@snapshotsBp.route("/api/portfolio/history", methods=["GET"])
def getHistory():
    rangeParam = request.args.get("range", "1M")
    nowTs      = int(time.time())

    rangeMap = {
        "1D": 86400, "1W": 7*86400, "1M": 30*86400,
        "3M": 90*86400, "6M": 180*86400, "1Y": 365*86400,
        "ALL": None, "YTD": None,
    }
    seconds = rangeMap.get(rangeParam, 30 * 86400)

    conn = getDb()
    if rangeParam == "YTD":
        jan1 = int(datetime.datetime(datetime.datetime.now().year, 1, 1).timestamp())
        rows = conn.execute(
            "SELECT ts, total_value, total_invested, flujo FROM portfolio_snapshots "
            "WHERE ts >= ? ORDER BY ts ASC", (jan1,)
        ).fetchall()
    elif seconds is None:
        # El historial completo es lo caro (18 000 filas): su cuerpo JSON se
        # reutiliza mientras la tabla no cambie (stores/historico_snapshots.py).
        def construir(snaps):
            return jsonify({"ok": True, "range": rangeParam, "data": snaps}).get_data()

        return current_app.response_class(
            historico_snapshots.cuerpoHistorialCompleto(construir, conn), mimetype="application/json"
        )
    else:
        rows = conn.execute(
            "SELECT ts, total_value, total_invested, flujo FROM portfolio_snapshots "
            "WHERE ts >= ? ORDER BY ts ASC", (nowTs - seconds,)
        ).fetchall()

    return jsonify({
        "ok": True, "range": rangeParam,
        "data": [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"], "f": r["flujo"]} for r in rows]
    })


@snapshotsBp.route("/api/portfolio/history/by-type", methods=["GET"])
def getHistoryByType():
    rangeParam = request.args.get("range", "1M")
    nowTs      = int(time.time())

    rangeMap = {
        "1D": 86400, "1W": 7*86400, "1M": 30*86400,
        "3M": 90*86400, "6M": 180*86400, "1Y": 365*86400,
        "ALL": None, "YTD": None,
    }
    seconds = rangeMap.get(rangeParam, 30 * 86400)

    # El agrupado de asset_snapshots se cachea por proceso y cada rango se
    # recorta de él (ver stores/historico_tipos.py): agruparlo en cada
    # petición eran 530 ms con el rango completo.
    if rangeParam == "YTD":
        jan1 = int(datetime.datetime(datetime.datetime.now().year, 1, 1).timestamp())
        desdeTs = jan1
    elif seconds is None:
        desdeTs = None
    else:
        desdeTs = nowTs - seconds

    # El cuerpo JSON también se guarda, con la misma vigencia que el agregado.
    def construir(data):
        return jsonify({"ok": True, "range": rangeParam, "data": data}).get_data()

    return current_app.response_class(
        historico_tipos.cuerpoPorTipo(rangeParam, desdeTs, construir), mimetype="application/json"
    )


@snapshotsBp.route("/api/portfolio/rentabilidad", methods=["GET"])
def getRentabilidad():
    """TWR, XIRR, drawdown y volatilidad sobre todo el histórico.

    Acepta `value`/`invested` para clavar el último punto con lo que el
    frontend tiene en pantalla: los snapshots se guardan cada pocos minutos y
    sin esto las KPIs de rentabilidad no cuadrarían con las de arriba.
    """
    conn = getDb()
    valorVivo     = _aReal(request.args.get("value"))
    invertidoVivo = _aReal(request.args.get("invested"))
    if valorVivo is None or invertidoVivo is None:
        # Sin punto vivo el resultado solo depende de la tabla: se reutiliza
        # mientras no cambie (stores/historico_snapshots.py).
        return jsonify({"ok": True, **historico_snapshots.resumenSinVivo(conn)})

    snaps = historico_snapshots.snapshots(conn)
    if valorVivo is not None and invertidoVivo is not None:
        ahora = int(time.time())
        # Mismo criterio que el gráfico de evolución: si el último snapshot es
        # de hace nada, se sustituye en vez de añadir un punto pegado a él.
        if snaps and ahora - snaps[-1]["ts"] < 120:
            # El flujo del punto sustituido sigue valiendo: es lo que entró desde el anterior.
            snaps[-1] = {"ts": ahora, "v": valorVivo, "i": invertidoVivo, "f": snaps[-1].get("f")}
        else:
            snaps.append({"ts": ahora, "v": valorVivo, "i": invertidoVivo})

    datos = rentabilidad.resumen(snaps)
    return jsonify({"ok": True, **datos})


def _safetyCopySnapshots():
    """Vuelca los snapshots a JSON antes de un borrado destructivo."""
    from core.db import getActiveDbPath
    try:
        conn = getDb()
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts"
        ).fetchall()
        if not rows:
            return None
        base = getActiveDbPath().parent.parent / "pre_restore"
        base.mkdir(parents=True, exist_ok=True)
        stamp = datetime.datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
        dest = base / f"snapshots_{getActiveDbPath().stem}_{stamp}.json"
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


@snapshotsBp.route("/api/snapshots/purge", methods=["POST"])
def purgeSnapshots():
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
        safety = _safetyCopySnapshots()
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
