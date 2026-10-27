"""Serie de valor y coste por tipo de activo, con caché por proceso.

`GET /api/portfolio/history/by-type` agrupaba en cada petición todas las filas
de asset_snapshots (466 k en un portfolio con unos meses de histórico): 530 ms
con el rango completo. Ningún índice lo arregla: leer la tabla cuesta 38 ms, lo
caro es agrupar (ver perf/baseline.md).

Aquí se guarda el agregado completo, (ts, tipo) -> sumas, y cada rango se
recorta de él, así que la respuesta es la misma que daba la consulta. El
agregado vale mientras no cambie nada de lo que lo produce:

- La BD (ruta y generación de `core.db`, que sube al restaurar o cambiar de
  portfolio, también desde otro worker).
- El tipo de cada activo (un cambio de tipo o un activo borrado mueve sumas).
- Las filas de asset_snapshots: se comparan el número de filas y el id máximo.
  Si solo hay filas nuevas al final (lo normal: un snapshot cada pocos
  minutos), se agregan esas y se suman a lo que había; las sumas son
  acumulables. Cualquier otra diferencia (una purga, un borrado suelto)
  recalcula todo.

Comprobarlo cuesta dos consultas sobre índices (~6 ms) por petición.
"""

import bisect
import threading

from core import db

_SQL_AGREGADO = """SELECT s.ts, a.type, SUM(s.price_eur) AS v, SUM(s.cost_eur) AS cost
                   FROM asset_snapshots s
                   JOIN activos a ON s.asset_id = a.id
                   WHERE {where} a.type IS NOT NULL AND a.type != ''
                   GROUP BY s.ts, a.type"""

_lock = threading.Lock()
_cache = {}  # ruta de la BD -> estado del agregado
_MAX_BDS = 4
_MAX_CUERPOS = 32  # cuerpos serializados por estado del agregado


def _firmaActivos(conn):
    fila = conn.execute(
        "SELECT group_concat(id || char(31) || type, char(30)) "
        "FROM (SELECT id, type FROM activos ORDER BY id)"
    ).fetchone()
    return fila[0] or ""


def _sumar(sumas, filas):
    for fila in filas:
        porTipo = sumas.setdefault(fila["ts"], {})
        previo = porTipo.get(fila["type"])
        coste = fila["cost"] or 0
        if previo is None:
            porTipo[fila["type"]] = [fila["v"], coste]
        else:
            previo[0] += fila["v"]
            previo[1] += coste


def _puntos(sumas):
    """La forma que devuelve la API: un dict por ts, ordenados por ts."""
    puntos = []
    for ts in sorted(sumas):
        punto = {"ts": ts}
        for tipo, (valor, coste) in sumas[ts].items():
            punto[tipo] = round(valor, 2)
            punto[f"c_{tipo}"] = round(coste, 2)
        puntos.append(punto)
    return puntos


def _estadoActual(conn):
    # Por separado: MIN y MAX en la misma consulta recorren la tabla (31 ms).
    filas = conn.execute("SELECT COUNT(*) FROM asset_snapshots").fetchone()[0]
    maxId = conn.execute("SELECT MAX(id) FROM asset_snapshots").fetchone()[0] or 0
    return filas, maxId


def _agregado(conn):
    clave = str(db.getActiveDbPath())
    firma = (db._resetGeneration, _firmaActivos(conn))
    filas, maxId = _estadoActual(conn)

    with _lock:
        previo = _cache.get(clave)
        if previo and previo["firma"] == firma and previo["filas"] == filas and previo["maxId"] == maxId:
            return previo

        sumas = None
        if previo and previo["firma"] == firma and maxId > previo["maxId"]:
            nuevas = conn.execute(
                "SELECT COUNT(*) FROM asset_snapshots WHERE id > ?", (previo["maxId"],)
            ).fetchone()[0]
            if previo["filas"] + nuevas == filas:
                sumas = previo["sumas"]
                _sumar(sumas, conn.execute(_SQL_AGREGADO.format(where="s.id > ? AND"), (previo["maxId"],)))

        if sumas is None:
            sumas = {}
            _sumar(sumas, conn.execute(_SQL_AGREGADO.format(where="")))

        puntos = _puntos(sumas)
        estado = {"firma": firma, "filas": filas, "maxId": maxId, "sumas": sumas,
                  "puntos": puntos, "tsOrdenados": [p["ts"] for p in puntos], "cuerpos": {}}
        _cache.pop(clave, None)
        _cache[clave] = estado
        while len(_cache) > _MAX_BDS:
            _cache.pop(next(iter(_cache)))
        return estado


def seriePorTipo(desdeTs=None):
    """Puntos con ts >= desdeTs (todos si es None), como los da la API."""
    estado = _agregado(db.getDb())
    if desdeTs is None:
        return estado["puntos"]
    return estado["puntos"][bisect.bisect_left(estado["tsOrdenados"], desdeTs):]


def cuerpoPorTipo(rangeParam, desdeTs, construir) -> bytes:
    """Cuerpo JSON ya serializado de `history/by-type` para un rango.

    Serializar los puntos era la mitad del coste de la respuesta con el rango
    completo (30 de 62 ms). El cuerpo se guarda dentro del estado del agregado,
    así que se invalida solo: cualquier cambio que rehaga el agregado (filas
    nuevas, cambio de tipo, restauración, otro portfolio) crea un estado nuevo
    sin cuerpos. La clave incluye el índice del primer punto del rango, porque
    los rangos relativos (1D, 1M...) deslizan su inicio con el tiempo.

    Args:
        rangeParam: Nombre del rango tal como sale en la respuesta.
        desdeTs: Primer `ts` incluido (todos si es None).
        construir: Función `(puntos) -> bytes` que serializa; solo se llama si
            el cuerpo no está guardado.

    Returns:
        El cuerpo, idéntico al que se obtendría sin caché.
    """
    estado = _agregado(db.getDb())
    inicio = 0 if desdeTs is None else bisect.bisect_left(estado["tsOrdenados"], desdeTs)
    clave = (rangeParam, inicio)
    with _lock:
        cuerpos = estado["cuerpos"]
        cuerpo = cuerpos.get(clave)
        if cuerpo is None:
            cuerpo = construir(estado["puntos"][inicio:])
            # Tope por si llegan nombres de rango arbitrarios en la URL.
            if len(cuerpos) >= _MAX_CUERPOS:
                cuerpos.clear()
            cuerpos[clave] = cuerpo
        return cuerpo


def invalidar():
    """Vacía la caché (lo usan los tests)."""
    with _lock:
        _cache.clear()
