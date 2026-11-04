"""Llamadas gastadas hoy en cada proveedor de cotizaciones.

Los proveedores gratuitos limitan las peticiones por día, así que el contador
de Ajustes es lo que dice si queda margen para refrescar la cartera otra vez.

Estaba en un diccionario en memoria del proceso. Con el servidor de desarrollo
—un proceso— eso cuenta bien. En el servidor, gunicorn levanta dos workers y
cada uno llevaba su propia cuenta: la pantalla mostraba las llamadas del worker
que respondiera esa petición, es decir, aproximadamente la mitad, y el número
cambiaba al recargar según a quién le tocara. Con una cuota diaria por delante,
un contador que enseña la mitad es peor que no tener contador.

El recuento vive ahora en un JSON compartido, con el bloqueo de ficheros de
`core.bloqueo` alrededor del leer-sumar-escribir para que dos workers no se
pisen. El diccionario en memoria se mantiene como respaldo: si el disco falla,
el contador se queda corto pero **nunca** rompe la consulta de cotizaciones,
que es lo que el usuario ha pedido de verdad.
"""

import json
import logging
import time
from datetime import date
from threading import Lock

from core import paths
from core.bloqueo import exclusivo
from core.escritura import escribirJsonAtomico

log = logging.getLogger(__name__)

# Protege del resto de hilos de ESTE proceso; del resto de procesos protege el
# bloqueo de fichero.
_lock = Lock()

# Respaldo en memoria, con la misma forma que el fichero. Se actualiza siempre,
# se lee solo cuando el fichero no está disponible.
_memoria: dict = {"date": None, "counts": {}}

# Segundos que se espera al otro worker. Es un contador: si no se consigue el
# turno enseguida, se suma igual y como mucho se pierde una llamada de la
# cuenta. Bloquear una petición de cotización por esto sería el intercambio
# equivocado.
_ESPERA_BLOQUEO = 1.0


def _rutaFichero():
    """Se resuelve en cada llamada: los tests redirigen los directorios."""
    return paths.JSON_DIR / "api_stats.json"


def _rutaBloqueo():
    return paths.TMP_DIR / "api-stats.lock"


def _vacio(hoy: str) -> dict:
    return {"date": hoy, "counts": {}}


def _leerFichero(hoy: str) -> dict:
    """Lo guardado, o un recuento vacío si no hay nada legible o es de ayer."""
    try:
        datos = json.loads(_rutaFichero().read_text("utf-8"))
    except (OSError, ValueError):
        return _vacio(hoy)

    if not isinstance(datos, dict) or datos.get("date") != hoy:
        return _vacio(hoy)

    counts = datos.get("counts")
    if not isinstance(counts, dict):
        return _vacio(hoy)

    return {"date": hoy, "counts": {str(k): int(v) for k, v in counts.items()
                                    if isinstance(v, (int, float))}}


def _sumar(datos: dict, hoy: str, provider: str) -> None:
    if datos.get("date") != hoy:
        datos["date"] = hoy
        datos["counts"] = {}
    datos["counts"][provider] = datos["counts"].get(provider, 0) + 1


def recordApiCall(provider: str) -> None:
    hoy = date.today().isoformat()
    with _lock:
        _sumar(_memoria, hoy, provider)
        try:
            with exclusivo(_rutaBloqueo(), espera=_ESPERA_BLOQUEO, obligatorio=False):
                datos = _leerFichero(hoy)
                _sumar(datos, hoy, provider)
                escribirJsonAtomico(_rutaFichero(), datos)
        except OSError as error:
            # Sin permiso o sin espacio: se sigue contando en memoria. El aviso
            # de por qué no se puede escribir ya lo da el arranque.
            log.debug("[api_stats] No se pudo guardar el contador: %s", error)


# ── Resultado de la última llamada real ──────────────────────────────────────
# El estado de Ajustes › API sale de aquí y no de sondeos propios: cada sondeo
# gasta cuota, y una pantalla que pregunta sola acababa siendo la que la agotaba.
# Vive en un JSON compartido por lo mismo que el contador: con dos workers, cada
# uno vería solo las llamadas que ha hecho él.

# Respaldo en memoria: {proveedor: {"estado", "detalle", "ms", "momento"}}.
_ultimos: dict = {}


def _rutaEstado():
    return paths.JSON_DIR / "api_estado.json"


def _rutaBloqueoEstado():
    return paths.TMP_DIR / "api-estado.lock"


def _leerEstado() -> dict:
    try:
        datos = json.loads(_rutaEstado().read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(datos, dict):
        return {}
    return {str(k): v for k, v in datos.items() if isinstance(v, dict) and v.get("estado")}


def recordApiResult(provider: str, estado: str, detalle: str = "", ms: int = 0) -> None:
    """Anota cómo terminó la última llamada real a un proveedor.

    Args:
        provider: Nombre visible del proveedor, el mismo que usa el contador.
        estado: ``ok``, ``clave``, ``plan``, ``limite``, ``caido`` o ``error``.
        detalle: Motivo legible (nunca la URL: podría llevar la clave).
        ms: Duración de la llamada.
    """
    fila = {"estado": estado, "detalle": str(detalle or "")[:200], "ms": int(ms or 0), "momento": time.time()}
    with _lock:
        _ultimos[provider] = fila
        try:
            with exclusivo(_rutaBloqueoEstado(), espera=_ESPERA_BLOQUEO, obligatorio=False):
                datos = _leerEstado()
                datos[provider] = fila
                escribirJsonAtomico(_rutaEstado(), datos)
        except OSError as error:
            log.debug("[api_stats] No se pudo guardar el estado: %s", error)


def olvidarApiResult(provider: str) -> None:
    """Borra el último resultado de un proveedor.

    Al cambiar la API que hay detrás de una fila, el resultado guardado es de la
    anterior: enseñarlo diría que falla algo que todavía no se ha probado.

    Args:
        provider: Nombre visible del proveedor, el mismo de `recordApiResult`.
    """
    with _lock:
        _ultimos.pop(provider, None)
        try:
            with exclusivo(_rutaBloqueoEstado(), espera=_ESPERA_BLOQUEO, obligatorio=False):
                datos = _leerEstado()
                if datos.pop(provider, None) is not None:
                    escribirJsonAtomico(_rutaEstado(), datos)
        except OSError as error:
            log.debug("[api_stats] No se pudo guardar el estado: %s", error)


def lastApiResults() -> dict:
    """El último resultado de cada proveedor, el más reciente entre disco y memoria."""
    with _lock:
        datos = _leerEstado()
        for proveedor, fila in _ultimos.items():
            if fila["momento"] > datos.get(proveedor, {}).get("momento", 0):
                datos[proveedor] = fila
    return datos


def getTodayStats() -> dict:
    hoy = date.today().isoformat()
    with _lock:
        datos = _leerFichero(hoy)
        # El respaldo solo se usa si el fichero no ha llegado a escribirse: ya
        # incluye lo que ha contado este proceso, así que sumarlos duplicaría.
        if not datos["counts"] and _memoria.get("date") == hoy:
            datos = {"date": hoy, "counts": dict(_memoria["counts"])}

    counts = datos["counts"]
    return {"date": hoy, "counts": counts, "total": sum(counts.values())}


def reiniciarParaPruebas() -> None:
    """Vacía el respaldo en memoria. Simula un worker recién arrancado."""
    with _lock:
        _memoria["date"] = None
        _memoria["counts"] = {}
        _ultimos.clear()
