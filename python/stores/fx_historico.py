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
import time
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal, InvalidOperation

from core.db import getDb, transaction
from providers.finnhub_client import fetchExchangeRate
from providers.yahoo_finance_client import fetchPriceSeries

log = logging.getLogger(__name__)

MONEDA_BASE = "EUR"

# Días hacia atrás que se piden alrededor de la fecha buscada. Cubre un puente
# largo más el cierre de año, que es la racha más larga sin sesión.
_MARGEN_DIAS = 10

# Formato de fecha en que se guardan las operaciones en esta aplicación.
_FORMATOS_ENTRADA = ("%d-%m-%Y", "%Y-%m-%d", "%d/%m/%Y")


def normalizarFecha(valor):
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


def _leerCache(par, fecha):
    """Tipo cacheado para esa fecha exacta, o el más reciente anterior."""
    fila = getDb().execute(
        "SELECT fecha, rate, origen FROM fx_rates "
        "WHERE par = ? AND fecha <= ? AND rate <> '' "
        "ORDER BY fecha DESC LIMIT 1",
        (par, fecha.isoformat()),
    ).fetchone()
    if not fila:
        return None
    # Un cierre de hace más de dos semanas no es "el de esa fecha": es que la
    # caché no llega hasta ahí y hay que pedirlo.
    cacheada = normalizarFecha(fila["fecha"])
    if cacheada is None or (fecha - cacheada).days > _MARGEN_DIAS:
        return None
    try:
        return Decimal(fila["rate"]), fila["origen"], fila["fecha"]
    except (InvalidOperation, TypeError):
        return None


def _guardar(par, puntos, origen):
    conn = getDb()
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

    serie, error = fetchPriceSeries(simbolo, inicio, fin)
    if error:
        return [], error

    puntos = []
    for punto in serie:
        dia = datetime.fromtimestamp(punto["ts"], UTC).date().isoformat()
        puntos.append((dia, f"{Decimal(str(punto['close'])):.8f}"))
    return puntos, None


def tasa(moneda, fecha, permitirDescarga=True):
    """Tipo de cambio de `moneda` a EUR en `fecha`.

    Devuelve `(rate, origen, fecha_usada)`, o `(None, motivo, "")` si no se
    pudo obtener. El euro consigo mismo es 1 y no consulta a nadie.
    """
    codigo = str(moneda or "").strip().upper()
    if not codigo or codigo == MONEDA_BASE:
        return Decimal("1"), "base", ""

    dia = normalizarFecha(fecha)
    if dia is None:
        return None, "fecha inválida", ""

    par = _par(codigo)
    cacheado = _leerCache(par, dia)
    if cacheado:
        return cacheado[0], cacheado[1], cacheado[2]

    if not permitirDescarga:
        return None, "sin dato en caché", ""

    puntos, error = _descargar(codigo, dia - timedelta(days=_MARGEN_DIAS), dia)
    if error:
        log.warning("[fx] No se pudo obtener %s en %s: %s", par, dia, error)
        return None, error, ""
    if not puntos:
        return None, "el proveedor no devolvió cierres", ""

    _guardar(par, puntos, "yahoo")
    cacheado = _leerCache(par, dia)
    if not cacheado:
        return None, "el proveedor no cubre esa fecha", ""
    return cacheado[0], cacheado[1], cacheado[2]


def _tipoAEuros(moneda):
    codigo = str(moneda or "").strip().upper()
    if not codigo or codigo == MONEDA_BASE:
        return Decimal("1")
    cacheado, _origen, _fecha = tasaActual(codigo, permitirDescarga=False)
    if cacheado is not None:
        return cacheado
    # El tipo de hoy lo cachea `fetchExchangeRate` (vigencia en `[proveedores]`).
    tipo, error = fetchExchangeRate(codigo, MONEDA_BASE, timeout=5)
    if error or not tipo or tipo <= 0:
        return None
    return Decimal(str(tipo))


def tipoActualEntre(desde, hacia):
    """Cuántas unidades de `hacia` vale una de `desde` hoy, o None si no se sabe.

    Pasa siempre por el euro, así que ir y volver es exacto. Es el cambio con el
    que el navegador convierte los importes de un activo a su divisa.
    """
    origen = _tipoAEuros(desde)
    destino = _tipoAEuros(hacia)
    if origen is None or destino is None or destino <= 0:
        return None
    return origen / destino


def tipoActualConMemo():
    """Crea un `tipoActualEntre` con memo propio, pensado para una sola petición.

    Cada par `(desde, hacia)` se resuelve una vez y se reutiliza durante todo el
    cálculo (también si el resultado es None). El memo vive en la función
    devuelta y muere con ella: no hay caché entre peticiones, así que un cambio
    de tipo nunca llega con retraso.

    Returns:
        Función `(desde, hacia) -> Decimal | None` equivalente a `tipoActualEntre`.

    Example:
        tipo = tipoActualConMemo()
        for activo in activos:
            calcular(..., tipo)
    """
    memo = {}

    def tipo(desde, hacia):
        clave = (desde, hacia)
        if clave not in memo:
            memo[clave] = tipoActualEntre(desde, hacia)
        return memo[clave]

    return tipo


def tasaActual(moneda, permitirDescarga=True):
    """Tipo de cambio de hoy. Es el que se aplica al valorar la posición."""
    return tasa(moneda, date.today(), permitirDescarga=permitirDescarga)


# ── Relleno del histórico ─────────────────────────────────────────────────────

# Tablas con operaciones fechadas y con divisa propia, y cómo se llama en cada
# una la columna de fecha. Todas comparten el trío fx_rate/fx_fecha/fx_origen.
_TABLAS = (
    ("activo_rows", "fecha_operacion", "currency"),
    ("activo_operation_rows", "fecha_apertura", "currency"),
    ("ventas", "fecha", "currency"),   # la divisa en que se tecleó la venta
)


def _divisaDeActivos():
    return {
        fila["id"]: str(fila["currency"] or MONEDA_BASE).upper()
        for fila in getDb().execute("SELECT id, currency FROM activos")
    }


# Tiempo máximo que una pasada dedica a pedir tipos a la red. Gunicorn mata el
# worker a los 120 s (`[gunicorn] timeout`): sin tope, un lote grande con el
# proveedor lento perdía todo lo resuelto. Lo que no quepa queda para la
# siguiente llamada, que es como ya funciona el relleno por lotes.
SEGUNDOS_MAX_POR_PASADA = 60


# (moneda, día) que el proveedor no supo dar, con el instante del fallo. Evita
# volver a pedirlos en cada tanda mientras haya otros por resolver.
_fallosRecientes = {}
_ESPERA_REINTENTO_SEGUNDOS = 3600


def _falloReciente(clave) -> bool:
    instante = _fallosRecientes.get(clave)
    return instante is not None and time.monotonic() - instante < _ESPERA_REINTENTO_SEGUNDOS


def rellenarPendientes(limite=500, permitirDescarga=True, segundosMax=SEGUNDOS_MAX_POR_PASADA):
    """Completa `fx_rate` en las operaciones que no lo tienen.

    Se hace por lotes y no de golpe: el histórico completo de una cartera con
    años de operaciones son cientos de peticiones, y bloquear una petición HTTP
    ese rato daría un timeout en el navegador. La llamada se puede repetir hasta
    que `pendientes` llegue a cero.

    Las operaciones ya en euros se marcan con tipo 1 sin consultar a nadie:
    dejarlas vacías haría que cada pasada volviera a mirarlas.

    Dos fases: primero se resuelven los tipos (que pueden ir a la red) **sin
    ninguna transacción abierta**, y después se escriben todos en una sola y
    corta. Antes el primer UPDATE abría la transacción y la dejaba abierta
    mientras se descargaban los siguientes: el resto de escrituras de la
    aplicación esperaban `busy_timeout` y fallaban con «database is locked».
    """
    conn = getDb()
    divisas = _divisaDeActivos()
    resueltas = 0
    fallidas = 0
    # Caché por (moneda, fecha) dentro de la propia pasada: una cartera real
    # tiene muchas operaciones del mismo día y la misma divisa.
    memoria = {}
    # (tabla, rowid, rate, fecha_usada, origen) que se escriben al final.
    actualizaciones = []
    fin = time.monotonic() + max(1, segundosMax)

    for tabla, columnaFecha, columnaDivisa in _TABLAS:
        cols = {row[1] for row in conn.execute(f"PRAGMA table_info({tabla})")}
        if "fx_rate" not in cols:
            continue

        # Sin LIMIT: los que fallan se quedan siempre en la tabla y, con él,
        # volvían a ser los primeros de cada tanda y tapaban a los nuevos. El
        # tope (`limite`) se aplica a los que se resuelven.
        filas = conn.execute(
            # `rowid` se alía: en una tabla con `id INTEGER PRIMARY KEY` es un
            # alias de esa columna y sqlite3.Row no expone la clave "rowid".
            f"SELECT rowid AS fila_id, asset_id, {columnaFecha} AS fecha"
            + (f", {columnaDivisa} AS divisa" if columnaDivisa else "")
            + f" FROM {tabla} WHERE fx_rate = ''"
        ).fetchall()

        for fila in filas:
            moneda = (
                str(fila["divisa"] or MONEDA_BASE).upper()
                if columnaDivisa
                else divisas.get(fila["asset_id"], MONEDA_BASE)
            )
            dia = normalizarFecha(fila["fecha"])
            if dia is None:
                fallidas += 1
                continue

            clave = (moneda, dia)
            if clave not in memoria:
                if _falloReciente(clave):
                    # Falló hace poco: reintentarlo ahora solo gasta la pasada
                    # y no deja llegar a los que sí se pueden resolver.
                    memoria[clave] = (None, "falló hace poco", "")
                else:
                    if time.monotonic() > fin:
                        break  # sin tiempo para más descargas: el resto, en la siguiente pasada
                    memoria[clave] = tasa(moneda, dia, permitirDescarga=permitirDescarga)
                    if memoria[clave][0] is None and permitirDescarga:
                        _fallosRecientes[clave] = time.monotonic()
            rate, origen, fechaUsada = memoria[clave]

            if rate is None:
                fallidas += 1
                continue

            actualizaciones.append(
                (tabla, fila["fila_id"], f"{rate:.8f}", fechaUsada or dia.isoformat(), origen)
            )
            resueltas += 1

            if resueltas >= limite:
                break
        if resueltas >= limite or time.monotonic() > fin:
            break

    if actualizaciones:
        with transaction() as escritura:
            for tabla, filaId, rate, fechaUsada, origen in actualizaciones:
                # `tabla` sale de _TABLAS (constantes del módulo), no de fuera.
                escritura.execute(
                    f"UPDATE {tabla} SET fx_rate = ?, fx_fecha = ?, fx_origen = ? WHERE rowid = ?",
                    (rate, fechaUsada, origen, filaId),
                )
    elif conn.in_transaction:
        conn.commit()
    return {"resueltas": resueltas, "fallidas": fallidas, "pendientes": contarPendientes()}


def contarPendientes():
    """Operaciones sin tipo de cambio anotado, por tabla."""
    conn = getDb()
    total = 0
    for tabla, _fecha, _divisa in _TABLAS:
        cols = {row[1] for row in conn.execute(f"PRAGMA table_info({tabla})")}
        if "fx_rate" not in cols:
            continue
        total += conn.execute(
            f"SELECT COUNT(*) FROM {tabla} WHERE fx_rate = ''"
        ).fetchone()[0]
    return total
