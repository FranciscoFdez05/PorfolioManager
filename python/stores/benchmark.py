"""Series de índices con las que comparar la cartera.

El gráfico de evolución ya cuenta lo que ha hecho el portfolio; lo que no
cuenta es si eso es mucho o poco. Superponer un índice lo pone en contexto, y
la comparación honesta es contra el índice TWR de la cartera (`core.rentabilidad`),
no contra su valor en euros: la línea del portfolio no debe subir solo porque
se haya aportado.

Los cierres se piden a Yahoo Finance —el único de los cuatro proveedores
conectados que sirve series largas sin clave y que además cotiza los índices—
y se guardan en `benchmark_prices`, porque el pasado no cambia: sin caché,
cada visita a Métricas volvería a bajar años de cotizaciones.
"""

import datetime
import logging
import time

from core import settings
from core.db import get_db, transaction
from providers.yahoo_finance_client import fetch_price_series

log = logging.getLogger(__name__)

# Los índices ofrecidos. La clave es lo que viaja por la URL y se guarda en las
# preferencias del navegador; el símbolo es cosa del proveedor y puede cambiar
# sin romper los ajustes del usuario.
INDICES = {
    "sp500":     {"symbol": "^GSPC",     "nombre": "S&P 500",       "divisa": "USD"},
    "msciworld": {"symbol": "URTH",      "nombre": "MSCI World",    "divisa": "USD"},
    "nasdaq":    {"symbol": "^NDX",      "nombre": "Nasdaq 100",    "divisa": "USD"},
    "eurostoxx": {"symbol": "^STOXX50E", "nombre": "Euro Stoxx 50", "divisa": "EUR"},
    "ibex":      {"symbol": "^IBEX",     "nombre": "IBEX 35",       "divisa": "EUR"},
    "btc":       {"symbol": "BTC-EUR",   "nombre": "Bitcoin",       "divisa": "EUR"},
}

# Cuándo se considera que la caché ya no cubre el presente. Un día: los cierres
# son diarios y el de hoy no existe hasta que cierra el mercado.
_MARGEN_DIAS = 1

# Último intento por símbolo, para no repetir la llamada cada vez que se pinta
# el gráfico. Hace falta además de la caché en BD porque un fin de semana el
# último cierre es el del viernes y, sin esto, cada refresco volvería a
# preguntar por un dato que todavía no existe.
_ultimo_intento: dict[str, float] = {}


def catalogo():
    """Los índices disponibles, para que el desplegable no los repita."""
    return [{"clave": clave, **datos} for clave, datos in INDICES.items()]


def _cache(symbol, desde_ts, hasta_ts):
    filas = get_db().execute(
        "SELECT ts, close FROM benchmark_prices WHERE symbol = ? AND ts BETWEEN ? AND ? ORDER BY ts ASC",
        (symbol, int(desde_ts), int(hasta_ts)),
    ).fetchall()
    return [{"ts": f["ts"], "close": f["close"]} for f in filas]


def _guardar(symbol, serie):
    if not serie:
        return
    filas = [
        (symbol, datetime.date.fromtimestamp(p["ts"]).isoformat(), int(p["ts"]), float(p["close"]))
        for p in serie
    ]
    with transaction() as conn:
        conn.executemany(
            "INSERT INTO benchmark_prices (symbol, dia, ts, close) VALUES (?, ?, ?, ?) "
            "ON CONFLICT(symbol, dia) DO UPDATE SET ts = excluded.ts, close = excluded.close",
            filas,
        )


def _hace_falta_bajar(symbol, cacheada, desde_ts, hasta_ts):
    """¿La caché cubre el tramo pedido, o hay que volver a preguntar?

    TTL 0 en `[mercado] historico_ttl_segundos` desactiva la caché en memoria
    (no la de la BD), igual que en `/api/historical-changes`.
    """
    ttl = settings.historicoTtlSegundos()
    if ttl > 0 and time.time() - _ultimo_intento.get(symbol, 0) < ttl:
        return False
    if not cacheada:
        return True

    margen = _MARGEN_DIAS * 86400
    # Falta cola (el índice se ha movido desde la última visita) o falta cabeza
    # (el usuario ha estirado el rango hacia atrás).
    return cacheada[-1]["ts"] < hasta_ts - margen or cacheada[0]["ts"] > desde_ts + margen


def serie(clave, desde_ts, hasta_ts):
    """Cierres diarios del índice `clave` en el tramo pedido.

    Devuelve `({"clave", "symbol", "nombre", "data"}, error)`. Si la descarga
    falla pero hay algo cacheado, se sirve lo cacheado con el error a None: un
    índice de hace dos días sigue diciendo si la cartera va por delante o por
    detrás, y un gráfico vacío no dice nada.
    """
    indice = INDICES.get(str(clave or "").strip().lower())
    if not indice:
        return None, "Índice desconocido"

    symbol   = indice["symbol"]
    desde_ts = int(desde_ts)
    hasta_ts = int(hasta_ts)
    cacheada = _cache(symbol, desde_ts, hasta_ts)

    if _hace_falta_bajar(symbol, cacheada, desde_ts, hasta_ts):
        _ultimo_intento[symbol] = time.time()
        # Se baja un margen extra por delante para que un rango que empieza en
        # fin de semana o festivo tenga un cierre con el que arrancar la base 100.
        bajada, error = fetch_price_series(symbol, desde_ts - 7 * 86400, hasta_ts)
        if error:
            log.info("[benchmark] %s: %s", symbol, error)
            if not cacheada:
                return None, error
        else:
            _guardar(symbol, bajada)
            cacheada = _cache(symbol, desde_ts, hasta_ts)

    return {
        "clave":  str(clave).strip().lower(),
        "symbol": symbol,
        "nombre": indice["nombre"],
        "data":   cacheada,
    }, None
