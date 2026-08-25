"""Tipos de cambio históricos, cacheados en la base del portfolio.

Para separar el efecto divisa del efecto activo (`core.pnl_divisa`) hace falta
el tipo de cambio **del día de cada operación**, y ese dato no está en ninguna
parte de la aplicación: las operaciones guardan el importe y la divisa, pero el
tipo al que se cruzó se perdía. Reconstruirlo a posteriori solo es posible
pidiéndoselo a un proveedor de series históricas, y esa consulta es cara:

  * Un histórico de varios años son cientos de fechas distintas.
  * Los proveedores gratuitos limitan las llamadas por día.

De ahí la caché en SQLite (`fx_rates`) y no en memoria: un reinicio no puede
significar volver a gastar la cuota entera. Una vez guardado, un tipo de cambio
de una fecha pasada no cambia nunca, así que no caduca.

**Yahoo Finance** es la fuente porque es el único de los cuatro proveedores
conectados que sirve series diarias largas sin clave ni cuota, y cotiza los
pares de divisas como cualquier otro ticker (`USDEUR=X`).

**Fines de semana y festivos.** El mercado de divisas cierra, así que para una
operación de un sábado no existe cierre. Se usa el último disponible anterior o
igual a la fecha pedida, y se anota en `fx_fecha` cuál se usó: decirlo es
preferible a interpolar un tipo que nunca existió.
"""

import logging
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from core.db import get_db
from providers.yahoo_finance_client import fetch_price_series

log = logging.getLogger(__name__)

MONEDA_BASE = "EUR"

# Días hacia atrás que se piden alrededor de la fecha buscada. Cubre un puente
# largo más el cierre de año, que es la racha más larga sin sesión.
_MARGEN_DIAS = 10

# Formato de fecha en que se guardan las operaciones en esta aplicación.
_FORMATOS_ENTRADA = ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y")


def normalizar_fecha(valor):
    """Convierte a `date` cualquiera de los formatos que guarda la aplicación."""
    if isinstance(valor, datetime):
        return valor.date()
    if isinstance(valor, date):
        return valor
    texto = str(valor or "").strip()
    if not texto:
        return None
    for formato in _FORMATOS_ENTRADA:
        try:
            return datetime.strptime(texto, formato).date()
        except ValueError:
            continue
    return None


def _par(moneda):
    return f"{str(moneda or '').strip().upper()}/{MONEDA_BASE}"


def _leer_cache(par, fecha):
    """Tipo cacheado para esa fecha exacta, o el más reciente anterior."""
    fila = get_db().execute(
        "SELECT fecha, rate, origen FROM fx_rates "
        "WHERE par = ? AND fecha <= ? AND rate <> '' "
        "ORDER BY fecha DESC LIMIT 1",
        (par, fecha.isoformat()),
    ).fetchone()
    if not fila:
        return None
    # Un cierre de hace más de dos semanas no es "el de esa fecha": es que la
    # caché no llega hasta ahí y hay que pedirlo.
    cacheada = normalizar_fecha(fila["fecha"])
    if cacheada is None or (fecha - cacheada).days > _MARGEN_DIAS:
        return None
    try:
        return Decimal(fila["rate"]), fila["origen"], fila["fecha"]
    except (InvalidOperation, TypeError):
        return None


def _guardar(par, puntos, origen):
    conn = get_db()
    ahora = datetime.now(UTC).isoformat(timespec="seconds")
    conn.executemany(
        "INSERT OR REPLACE INTO fx_rates (par, fecha, rate, origen, obtenido_en) "
        "VALUES (?,?,?,?,?)",
        [(par, f, r, origen, ahora) for f, r in puntos],
    )
    conn.commit()


def _descargar(moneda, desde, hasta):
    """Serie diaria de `moneda`→EUR entre dos fechas. Devuelve `(puntos, error)`."""
    simbolo = f"{moneda}{MONEDA_BASE}=X"
    inicio = int(datetime.combine(desde, datetime.min.time(), UTC).timestamp())
    fin = int(datetime.combine(hasta, datetime.max.time(), UTC).timestamp())

    serie, error = fetch_price_series(simbolo, inicio, fin)
    if error:
        return [], error

    puntos = []
    for punto in serie:
        dia = datetime.fromtimestamp(punto["ts"], UTC).date().isoformat()
        puntos.append((dia, f"{Decimal(str(punto['close'])):.8f}"))
    return puntos, None


def tasa(moneda, fecha, permitir_descarga=True):
    """Tipo de cambio de `moneda` a EUR en `fecha`.

    Devuelve `(rate, origen, fecha_usada)`, o `(None, motivo, "")` si no se
    pudo obtener. El euro consigo mismo es 1 y no consulta a nadie.
    """
    codigo = str(moneda or "").strip().upper()
    if not codigo or codigo == MONEDA_BASE:
        return Decimal("1"), "base", ""

    dia = normalizar_fecha(fecha)
    if dia is None:
        return None, "fecha inválida", ""

    par = _par(codigo)
    cacheado = _leer_cache(par, dia)
    if cacheado:
        return cacheado[0], cacheado[1], cacheado[2]

    if not permitir_descarga:
        return None, "sin dato en caché", ""

    puntos, error = _descargar(codigo, dia - timedelta(days=_MARGEN_DIAS), dia)
    if error:
        log.warning("[fx] No se pudo obtener %s en %s: %s", par, dia, error)
        return None, error, ""
    if not puntos:
        return None, "el proveedor no devolvió cierres", ""

    _guardar(par, puntos, "yahoo")
    cacheado = _leer_cache(par, dia)
    if not cacheado:
        return None, "el proveedor no cubre esa fecha", ""
    return cacheado[0], cacheado[1], cacheado[2]


def tasa_actual(moneda, permitir_descarga=True):
    """Tipo de cambio de hoy. Es el que se aplica al valorar la posición."""
    return tasa(moneda, date.today(), permitir_descarga=permitir_descarga)


# ── Relleno del histórico ─────────────────────────────────────────────────────

# Tablas con operaciones fechadas y con divisa propia, y cómo se llama en cada
# una la columna de fecha. Todas comparten el trío fx_rate/fx_fecha/fx_origen.
_TABLAS = (
    ("activo_rows", "fecha_operacion", "currency"),
    ("activo_operation_rows", "fecha_apertura", "currency"),
    ("ventas", "fecha", None),   # las ventas heredan la divisa del activo
)


def _divisa_de_activos():
    return {
        fila["id"]: str(fila["currency"] or MONEDA_BASE).upper()
        for fila in get_db().execute("SELECT id, currency FROM activos")
    }


def rellenar_pendientes(limite=500, permitir_descarga=True):
    """Completa `fx_rate` en las operaciones que no lo tienen.

    Se hace por lotes y no de golpe: el histórico completo de una cartera con
    años de operaciones son cientos de peticiones, y bloquear una petición HTTP
    ese rato daría un timeout en el navegador. La llamada se puede repetir hasta
    que `pendientes` llegue a cero.

    Las operaciones ya en euros se marcan con tipo 1 sin consultar a nadie:
    dejarlas vacías haría que cada pasada volviera a mirarlas.
    """
    conn = get_db()
    divisas = _divisa_de_activos()
    resueltas = 0
    fallidas = 0
    # Caché por (moneda, fecha) dentro de la propia pasada: una cartera real
    # tiene muchas operaciones del mismo día y la misma divisa.
    memoria = {}

    for tabla, columna_fecha, columna_divisa in _TABLAS:
        cols = {row[1] for row in conn.execute(f"PRAGMA table_info({tabla})")}
        if "fx_rate" not in cols:
            continue

        filas = conn.execute(
            # `rowid` se alía: en una tabla con `id INTEGER PRIMARY KEY` es un
            # alias de esa columna y sqlite3.Row no expone la clave "rowid".
            f"SELECT rowid AS fila_id, asset_id, {columna_fecha} AS fecha"
            + (f", {columna_divisa} AS divisa" if columna_divisa else "")
            + f" FROM {tabla} WHERE fx_rate = '' LIMIT ?",
            (limite - resueltas - fallidas,),
        ).fetchall()

        for fila in filas:
            moneda = (
                str(fila["divisa"] or MONEDA_BASE).upper()
                if columna_divisa
                else divisas.get(fila["asset_id"], MONEDA_BASE)
            )
            dia = normalizar_fecha(fila["fecha"])
            if dia is None:
                fallidas += 1
                continue

            clave = (moneda, dia)
            if clave not in memoria:
                memoria[clave] = tasa(moneda, dia, permitir_descarga=permitir_descarga)
            rate, origen, fecha_usada = memoria[clave]

            if rate is None:
                fallidas += 1
                continue

            conn.execute(
                f"UPDATE {tabla} SET fx_rate = ?, fx_fecha = ?, fx_origen = ? WHERE rowid = ?",
                (f"{rate:.8f}", fecha_usada or dia.isoformat(), origen, fila["fila_id"]),
            )
            resueltas += 1

            if resueltas + fallidas >= limite:
                break
        if resueltas + fallidas >= limite:
            break

    conn.commit()
    return {"resueltas": resueltas, "fallidas": fallidas, "pendientes": contar_pendientes()}


def contar_pendientes():
    """Operaciones sin tipo de cambio anotado, por tabla."""
    conn = get_db()
    total = 0
    for tabla, _fecha, _divisa in _TABLAS:
        cols = {row[1] for row in conn.execute(f"PRAGMA table_info({tabla})")}
        if "fx_rate" not in cols:
            continue
        total += conn.execute(
            f"SELECT COUNT(*) FROM {tabla} WHERE fx_rate = ''"
        ).fetchone()[0]
    return total
