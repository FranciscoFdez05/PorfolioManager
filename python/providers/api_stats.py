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


def _ruta_fichero():
    """Se resuelve en cada llamada: los tests redirigen los directorios."""
    return paths.JSON_DIR / "api_stats.json"


def _ruta_bloqueo():
    return paths.TMP_DIR / "api-stats.lock"


def _vacio(hoy: str) -> dict:
    return {"date": hoy, "counts": {}}


def _leer_fichero(hoy: str) -> dict:
    """Lo guardado, o un recuento vacío si no hay nada legible o es de ayer."""
    try:
        datos = json.loads(_ruta_fichero().read_text("utf-8"))
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


def record_api_call(provider: str) -> None:
    hoy = date.today().isoformat()
    with _lock:
        _sumar(_memoria, hoy, provider)
        try:
            with exclusivo(_ruta_bloqueo(), espera=_ESPERA_BLOQUEO, obligatorio=False):
                datos = _leer_fichero(hoy)
                _sumar(datos, hoy, provider)
                escribirJsonAtomico(_ruta_fichero(), datos)
        except OSError as error:
            # Sin permiso o sin espacio: se sigue contando en memoria. El aviso
            # de por qué no se puede escribir ya lo da el arranque.
            log.debug("[api_stats] No se pudo guardar el contador: %s", error)


def get_today_stats() -> dict:
    hoy = date.today().isoformat()
    with _lock:
        datos = _leer_fichero(hoy)
        # El respaldo solo se usa si el fichero no ha llegado a escribirse: ya
        # incluye lo que ha contado este proceso, así que sumarlos duplicaría.
        if not datos["counts"] and _memoria.get("date") == hoy:
            datos = {"date": hoy, "counts": dict(_memoria["counts"])}

    counts = datos["counts"]
    return {"date": hoy, "counts": counts, "total": sum(counts.values())}


def reiniciar_para_pruebas() -> None:
    """Vacía el respaldo en memoria. Simula un worker recién arrancado."""
    with _lock:
        _memoria["date"] = None
        _memoria["counts"] = {}
