"""Hilo que guarda los snapshots del histórico aunque no haya nadie mirando.

El punto de evolución lo programaba `applySnapshotSchedule()` con un
`setInterval` del navegador: una semana sin abrir la web era una semana sin
histórico, y desde que la rentabilidad anual se calcula con Modified Dietz sobre
esos puntos, cada hueco degrada directamente la métrica.

Este hilo hace el mismo trabajo desde el servidor, con el mismo intervalo de
Ajustes y contra la misma función de escritura (`routes.snapshots`), de modo que
los dos caminos no pueden divergir. Conviven sin duplicar puntos: el bucket lo
reclama quien llegue primero.

Vive en `admin/` porque es una tarea del proceso, como los backups automáticos,
no una ruta HTTP.
"""

import logging
import threading
import time

from core import settings
from core.db import get_active_db_path, use_db_path

log = logging.getLogger(__name__)

_hilo: threading.Thread | None = None
_arranque = threading.Lock()
_parada = threading.Event()

# Cada cuánto se vuelve a mirar Ajustes cuando los snapshots están desactivados.
_ESPERA_DESACTIVADO = 300


def _ajustes():
    from routes.ajustes import _read_ajustes
    return _read_ajustes()


def _rutas_objetivo():
    """Bases de datos a las que hay que guardarles un punto.

    El alcance lo elige el usuario en Ajustes: 'activo' reproduce lo que hacía
    el navegador (solo el portfolio abierto) y 'todos' mantiene vivo el
    histórico de los que no se visitan, a cambio de multiplicar las llamadas a
    los proveedores por el número de portfolios.
    """
    if str(_ajustes().get("snapshotAlcance") or "activo").strip().lower() != "todos":
        return [get_active_db_path()]

    from admin.portfolios_manager import _portfolio_db_path, get_portfolios

    rutas = []
    for portfolio in (get_portfolios() or {}).get("portfolios", []):
        try:
            ruta = _portfolio_db_path(portfolio.get("id", ""))
        except ValueError:
            continue
        # Un portfolio cuyo .db no existe todavía no se toca: crearlo aquí
        # dejaría una base vacía con un snapshot a cero que ensucia el gráfico.
        if ruta.exists():
            rutas.append(ruta)

    return rutas or [get_active_db_path()]


def _intervalo() -> int:
    from routes.snapshots import _interval_seconds
    return _interval_seconds()


def _snapshots_activos() -> bool:
    """False si el usuario ha puesto los snapshots en 'Off' en Ajustes."""
    from routes.ajustes import DEFAULT_SNAPSHOT_MINUTES
    try:
        minutos = int(_ajustes().get("snapshotMinutes", DEFAULT_SNAPSHOT_MINUTES))
    except (TypeError, ValueError):
        minutos = DEFAULT_SNAPSHOT_MINUTES
    return minutos > 0


def _espera_hasta_siguiente(ahora=None) -> float:
    """Segundos hasta el próximo hueco horario, más la gracia.

    Los buckets están alineados al reloj (igual que en el navegador), y la
    gracia deja pasar primero al frontend: si hay una pestaña abierta, su punto
    ya viene con los precios que el usuario está viendo, así que es preferible
    al que calcularía el servidor pidiendo las mismas cotizaciones otra vez.
    """
    ahora = time.time() if ahora is None else ahora
    intervalo = _intervalo()
    gracia = min(settings.snapshotServidorGracia(), max(1, intervalo // 4))
    siguiente = (int(ahora) // intervalo + 1) * intervalo + gracia
    return max(1.0, siguiente - ahora)


def ejecutar_una_vez(refrescar_precios=True) -> int:
    """Guarda el punto pendiente en cada portfolio objetivo. Devuelve cuántos."""
    from routes.snapshots import guardar_snapshot, reservar_bucket
    from stores.valoracion import valorar_portfolio

    guardados = 0
    for ruta in _rutas_objetivo():
        try:
            with use_db_path(ruta):
                if not reservar_bucket():
                    log.debug("[snapshots] %s: el hueco actual ya está reclamado", ruta.stem)
                    continue

                valoracion = valorar_portfolio(refrescar_precios=refrescar_precios)
                if valoracion["activos"] == 0:
                    log.debug("[snapshots] %s: sin posiciones que valorar", ruta.stem)
                    continue

                if guardar_snapshot(
                    valoracion["total_value"], valoracion["total_invested"], valoracion["assets"]
                ):
                    guardados += 1
                    log.info(
                        "[snapshots] %s: %.2f € (invertido %.2f €, %d/%d precios frescos)",
                        ruta.stem, valoracion["total_value"], valoracion["total_invested"],
                        valoracion["precios_frescos"], valoracion["activos"],
                    )
        except Exception as e:
            # Un portfolio que falle no puede llevarse por delante a los demás
            # ni matar el hilo: el histórico se recupera en el siguiente hueco.
            log.warning("[snapshots] %s: no se pudo guardar el punto: %s", ruta.stem, e)

    return guardados


def _bucle():
    while not _parada.is_set():
        try:
            activo = _snapshots_activos()
            espera = _espera_hasta_siguiente() if activo else _ESPERA_DESACTIVADO
        except Exception as e:
            log.warning("[snapshots] No se pudo calcular la próxima ejecución: %s", e)
            activo, espera = False, _ESPERA_DESACTIVADO

        if _parada.wait(espera):
            return
        if activo:
            ejecutar_una_vez()


def iniciar():
    """Arranca el hilo si el despliegue lo permite. Idempotente."""
    global _hilo

    if not settings.snapshotServidorActivo():
        log.info("[snapshots] Hilo del servidor desactivado por configuración")
        return None

    with _arranque:
        if _hilo is not None and _hilo.is_alive():
            return _hilo
        _parada.clear()
        _hilo = threading.Thread(target=_bucle, name="snapshot-scheduler", daemon=True)
        _hilo.start()
        log.info("[snapshots] Hilo del servidor arrancado")
        return _hilo


def detener(timeout=5):
    """Para el hilo. Pensado para los tests y para un apagado ordenado."""
    global _hilo
    _parada.set()
    if _hilo is not None:
        _hilo.join(timeout=timeout)
        _hilo = None
