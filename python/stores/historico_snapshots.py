"""Caché por proceso de lo que se deriva de `portfolio_snapshots`.

`GET /api/portfolio/history?range=ALL` y `GET /api/portfolio/rentabilidad`
leían y convertían en cada petición toda la tabla (unas 18 000 filas en una
cartera con meses de histórico: 13 ms de consulta, 5 ms de diccionarios y 20 ms
de JSON solo en el historial). Aquí se guardan, para la base activa:

- las filas ya convertidas a `{ts, v, i, f}`;
- el cuerpo JSON del historial completo;
- el resultado de `rentabilidad.resumen` cuando no hay punto «vivo».

Todo vale mientras no cambie la huella de la tabla: la ruta de la base activa
y su generación en `core.db` (sube al restaurar, importar o cambiar de
portfolio, también desde otro worker), el número de filas, el último `ts` y
`rowid`, y las sumas de `flujo`, `total_value` y `total_invested` (un cambio de
flujo o de valor en una fila existente mueve la suma). Calcularla cuesta una
sola pasada por la tabla (~2 ms) frente a los 40-50 ms de rehacerlo todo.

Con punto vivo (`value`/`invested` de la petición) el resultado depende de esos
dos números y del instante, así que ese caso no se cachea: solo se reutilizan
las filas.
"""

import datetime
import threading

from core import db, rentabilidad

_lock = threading.Lock()
_cache = {}  # ruta de la base -> {"huella": ..., "snaps": ..., "cuerpoAll": ..., "resumen": ...}
_MAX_BDS = 4

_SQL_HUELLA = (
    "SELECT COUNT(*), MAX(ts), MAX(rowid), TOTAL(flujo), TOTAL(total_value), TOTAL(total_invested) "
    "FROM portfolio_snapshots"
)
_SQL_FILAS = "SELECT ts, total_value, total_invested, flujo FROM portfolio_snapshots ORDER BY ts ASC"


def _huella(conn) -> tuple:
    """Identifica el contenido de la tabla y de la base que la contiene."""
    return (db._resetGeneration, *tuple(conn.execute(_SQL_HUELLA).fetchone()))


def _entrada(conn) -> dict:
    """Entrada de caché vigente de la base activa; la rehace si la huella cambió."""
    clave = str(db.getActiveDbPath())
    huella = _huella(conn)

    with _lock:
        entrada = _cache.get(clave)
        if entrada is not None and entrada["huella"] == huella:
            return entrada

        filas = conn.execute(_SQL_FILAS).fetchall()
        snaps = tuple(
            {"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"], "f": r["flujo"]} for r in filas
        )
        entrada = {"huella": huella, "snaps": snaps, "cuerpoAll": None, "resumen": None}
        _cache.pop(clave, None)
        _cache[clave] = entrada
        while len(_cache) > _MAX_BDS:
            _cache.pop(next(iter(_cache)))
        return entrada


def snapshots(conn=None) -> list:
    """Filas de `portfolio_snapshots` como `{ts, v, i, f}`, ordenadas por `ts`.

    Devuelve una lista nueva cada vez (el llamador puede añadir o sustituir
    puntos); los diccionarios se comparten y no deben modificarse.
    """
    return list(_entrada(conn or db.getDb())["snaps"])


def cuerpoHistorialCompleto(construir, conn=None) -> bytes:
    """Cuerpo de la respuesta de `history?range=ALL`.

    Args:
        construir: Función sin argumentos que produce el cuerpo (bytes) a partir
            de `snapshots()`; se llama solo cuando la caché no lo tiene.
        conn: Conexión; la de la base activa si falta.

    Returns:
        El cuerpo, idéntico al que se obtendría sin caché.
    """
    entrada = _entrada(conn or db.getDb())
    with _lock:
        if entrada["cuerpoAll"] is None:
            entrada["cuerpoAll"] = construir(list(entrada["snaps"]))
        return entrada["cuerpoAll"]


def resumenSinVivo(conn=None, hoy=None) -> dict:
    """`rentabilidad.resumen` de todo el histórico guardado (sin punto vivo).

    El resultado depende del día (la cobertura anual cuenta hasta hoy), así que
    se guarda junto a la fecha y se recalcula al cambiar de día.
    """
    hoy = hoy or datetime.date.today()
    entrada = _entrada(conn or db.getDb())
    with _lock:
        guardado = entrada["resumen"]
        if guardado is None or guardado[0] != hoy:
            guardado = (hoy, rentabilidad.resumen(list(entrada["snaps"]), hoy=hoy))
            entrada["resumen"] = guardado
        return guardado[1]


def invalidar() -> None:
    """Vacía la caché (lo usan los tests)."""
    with _lock:
        _cache.clear()
