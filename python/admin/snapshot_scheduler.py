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

from core import pulso, settings
from core.db import getActiveDbPath, useDbPath

log = logging.getLogger(__name__)

_hilo: threading.Thread | None = None
_arranque = threading.Lock()
_parada = threading.Event()

# Cada cuánto se vuelve a mirar Ajustes cuando los snapshots están desactivados.
_ESPERA_DESACTIVADO = 300
_ESPERA_REINTENTO = 300
_reintentoPendiente = False


def _ajustes():
    from stores.ajustes_store import _readAjustes
    return _readAjustes()


def _rutasObjetivo():
    """Bases de datos a las que hay que guardarles un punto.

    El alcance lo elige el usuario en Ajustes: 'activo' reproduce lo que hacía
    el navegador (solo el portfolio abierto) y 'todos' mantiene vivo el
    histórico de los que no se visitan, a cambio de multiplicar las llamadas a
    los proveedores por el número de portfolios.
    """
    if str(_ajustes().get("snapshotAlcance") or "activo").strip().lower() != "todos":
        return [getActiveDbPath()]

    from admin.portfolios_manager import _portfolioDbPath, getPortfolios

    rutas = []
    for portfolio in (getPortfolios() or {}).get("portfolios", []):
        try:
            ruta = _portfolioDbPath(portfolio.get("id", ""))
        except ValueError:
            continue
        # Un portfolio cuyo .db no existe todavía no se toca: crearlo aquí
        # dejaría una base vacía con un snapshot a cero que ensucia el gráfico.
        if ruta.exists():
            rutas.append(ruta)

    return rutas or [getActiveDbPath()]


def _intervalo() -> int:
    from routes.snapshots import _intervalSeconds
    return _intervalSeconds()


def _snapshotsActivos() -> bool:
    """False si el usuario ha puesto los snapshots en 'Off' en Ajustes."""
    from stores.ajustes_store import DEFAULT_SNAPSHOT_MINUTES
    try:
        minutos = int(_ajustes().get("snapshotMinutes", DEFAULT_SNAPSHOT_MINUTES))
    except (TypeError, ValueError):
        minutos = DEFAULT_SNAPSHOT_MINUTES
    return minutos > 0


def _esperaHastaSiguiente(ahora=None) -> float:
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


def _preciosSinPosicion(ruta) -> list:
    """Precios para los minigráficos de lo que no está en cartera, o nada si fallan.

    Son un extra del punto: si no se pueden pedir, el punto de la cartera se
    guarda igual y esas baldosas se quedan sin línea en este hueco.
    """
    from stores.valoracion import preciosSinPosicion

    try:
        return preciosSinPosicion()
    except Exception as e:
        log.warning("[snapshots] %s: no se pudieron cotizar los activos sin posición: %s", ruta.stem, e)
        return []


def ejecutarUnaVez(refrescarPrecios=True, esReintento=False) -> int:
    """Guarda el punto pendiente en cada portfolio objetivo. Devuelve cuántos."""
    from core.bloqueo import BloqueoOcupado
    from routes.backup import bloqueoSiLibre
    from routes.snapshots import guardarSnapshot, liberarBucket, reservarBucket
    from stores.valoracion import registrarFallbacks, registrarOmision, valorarPortfolio

    global _reintentoPendiente
    guardados = 0
    ahora = time.time()
    huboFallos = False
    try:
        rutas = _rutasObjetivo()
    except Exception as e:
        # Un portfolios.json ilegible o un fallo de disco aquí no puede matar
        # el hilo: sin esta guarda, los snapshots paraban hasta reiniciar.
        log.warning("[snapshots] No se pudo determinar qué portfolios guardar: %s", e)
        return 0

    for ruta in rutas:
        reservado = False
        liberar = False
        try:
            # Una importación o un restore reescribe la cartera: un punto tomado
            # a medias guardaría un valor que nunca existió. Si hay uno en curso
            # se salta, sin reclamar el hueco, y se vuelve en el siguiente.
            with bloqueoSiLibre(), useDbPath(ruta):
                if not reservarBucket(ahora):
                    log.debug("[snapshots] %s: el hueco actual ya está reclamado", ruta.stem)
                    continue
                reservado = True

                valoracion = valorarPortfolio(refrescarPrecios=refrescarPrecios)
                if valoracion["activos"] == 0:
                    log.debug("[snapshots] %s: sin posiciones que valorar", ruta.stem)
                    continue

                registrarFallbacks(valoracion.get("fallbacks", []))
                registrarOmision(not valoracion.get("completa", True))
                if not valoracion.get("completa", True):
                    log.warning(
                        "[snapshots] %s: valoración incompleta (falta un tipo de cambio o un precio); "
                        "no se guarda el punto", ruta.stem,
                    )
                    liberar = True
                    continue

                if guardarSnapshot(
                    valoracion["total_value"], valoracion["total_invested"], valoracion["assets"],
                    precios=_preciosSinPosicion(ruta) if refrescarPrecios else (),
                ):
                    guardados += 1
                    log.info(
                        "[snapshots] %s: %.2f € (invertido %.2f €, %d/%d precios frescos)",
                        ruta.stem, valoracion["total_value"], valoracion["total_invested"],
                        valoracion["precios_frescos"], valoracion["activos"],
                    )
        except BloqueoOcupado:
            log.info("[snapshots] Hay una copia, restauración o importación en curso; se salta este hueco")
        except Exception as e:
            # Un portfolio que falle no puede llevarse por delante a los demás
            # ni matar el hilo: el histórico se recupera en el siguiente hueco.
            log.warning("[snapshots] %s: no se pudo guardar el punto: %s", ruta.stem, e)
            liberar = reservado
        finally:
            if liberar:
                # El hueco reclamado queda libre para el reintento; si no, el
                # punto se perdería hasta el siguiente hueco.
                huboFallos = True
                try:
                    with useDbPath(ruta):
                        liberarBucket(ahora)
                except Exception as e:
                    log.warning("[snapshots] %s: no se pudo liberar el hueco: %s", ruta.stem, e)

    # Un solo reintento por hueco: evita pedir cotizaciones en bucle si el fallo persiste.
    _reintentoPendiente = huboFallos and not esReintento
    return guardados


# Valorar un portfolio pide cotizaciones, cada una con su timeout.
_plazoPasadaSegundos = 3 * 3600


def _bucle():
    global _reintentoPendiente
    while not _parada.is_set():
        reintento = _reintentoPendiente
        _reintentoPendiente = False
        try:
            activo = _snapshotsActivos()
            espera = _esperaHastaSiguiente() if activo else _ESPERA_DESACTIVADO
            if activo and reintento:
                espera = min(espera, _ESPERA_REINTENTO)
        except Exception as e:
            log.warning("[snapshots] No se pudo calcular la próxima ejecución: %s", e)
            activo, espera = False, _ESPERA_DESACTIVADO

        pulso.marcar("snapshots", espera + _plazoPasadaSegundos)
        if _parada.wait(espera):
            return
        if activo:
            ejecutarUnaVez(esReintento=reintento)


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
