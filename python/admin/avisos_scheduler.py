"""Hilo que vigila por su cuenta lo que merece un aviso por Telegram.

Igual que `snapshot_scheduler`, existe para que nada dependa de que haya una
pestaña abierta. Cada tarea corre a su ritmo dentro del mismo hilo:

  * **Alertas de precio** — cada `[avisos] alertas_intervalo_minutos`, pide la
    cotización de los activos que tienen alguna alerta activa (y solo esos) y
    evalúa las alertas de todos los portfolios.
  * **Resumen diario** — a la hora elegida en Ajustes > Telegram, si el usuario
    lo ha activado.
  * **Versión nueva** — una vez por versión publicada, leyendo la caché de
    `core.version_remota` (no añade llamadas a GitHub).
  * **Disco casi lleno** — cuando el volumen de datos baja de
    `[avisos] espacio_minimo_mb`. Sin espacio no se guarda nada.

Con gunicorn, cada worker arranca su copia de este hilo. Lo que no se puede
repetir se reclama con `core.reclamo`, de modo que solo lo hace un proceso por
ronda; las alertas, además, se reclaman en la propia base de datos.
"""

import logging
import shutil
import threading
import time
from datetime import datetime

from core import paths, reclamo, settings, telegram_notifier
from core.db import use_db_path

log = logging.getLogger(__name__)

_hilo: threading.Thread | None = None
_arranque = threading.Lock()
_parada = threading.Event()

# Cada cuánto se despierta el hilo a mirar si toca alguna tarea.
_TICK = 20
_CADA_VERSION = 600
_CADA_DISCO = 600
# El resumen no se repite antes de 20 h: da margen para que un cambio de hora
# en Ajustes no lo mande dos veces el mismo día ni se salte uno.
_ENTRE_RESUMENES = 20 * 3600
_ENTRE_AVISOS_DISCO = 24 * 3600


def rutas_de_portfolios():
    """[(id, nombre, ruta)] de todos los portfolios cuyo .db existe."""
    from admin.portfolios_manager import _portfolio_db_path, get_portfolios

    encontrados = []
    for portfolio in (get_portfolios() or {}).get("portfolios", []):
        try:
            ruta = _portfolio_db_path(portfolio.get("id", ""))
        except ValueError:
            continue
        # Un .db que no existe no se toca: abrirlo lo crearía vacío.
        if ruta.exists():
            encontrados.append((portfolio["id"], portfolio.get("name") or portfolio["id"], ruta))
    return encontrados


def _pasada_alertas() -> int:
    from stores import alertas_store

    intervalo = settings.alertasIntervaloSegundos()
    if intervalo <= 0 or not reclamo.reclamar("alertas-pasada", intervalo * 0.8):
        return 0

    saltadas = 0
    for pid, _nombre, ruta in rutas_de_portfolios():
        try:
            with use_db_path(ruta):
                if alertas_store.contar_activas():
                    saltadas += alertas_store.comprobar_activas(cartera=pid)
        except Exception as error:
            # Un portfolio con problemas no puede impedir vigilar los demás.
            log.warning("[avisos] Alertas de %s: %s", pid, error)
    return saltadas


def texto_resumen() -> str:
    """El resumen diario de todos los portfolios, listo para enviar."""
    from stores import resumen_cartera

    bloques = []
    for pid, nombre, ruta in rutas_de_portfolios():
        try:
            with use_db_path(ruta):
                bloques.append(resumen_cartera.formatear(nombre, resumen_cartera.calcular()))
        except Exception as error:
            log.warning("[avisos] Resumen de %s: %s", pid, error)
            bloques.append(f"📊 {nombre}\nNo se pudo calcular ({str(error)[:80]}).")
    if not bloques:
        return ""
    fecha = datetime.now().strftime("%d/%m/%Y")
    return f"🗓 Resumen del {fecha}\n\n" + "\n\n".join(bloques)


def _pasada_resumen() -> bool:
    if not telegram_notifier.configurado() or not telegram_notifier.preferencias().get("resumen"):
        return False
    if datetime.now().hour < telegram_notifier.resumenHora():
        return False
    if not reclamo.reclamar("resumen-diario", _ENTRE_RESUMENES):
        return False

    texto = texto_resumen()
    if not texto:
        return False
    return telegram_notifier.notificar("resumen", texto)


def _pasada_version() -> bool:
    from core import version_remota
    from core.version import __version__

    if not telegram_notifier.configurado() or not telegram_notifier.preferencias().get("version"):
        return False

    info = version_remota.consultar()
    if not info.get("hayNueva"):
        return False
    publicada = info["publicada"]
    if not reclamo.reclamar(f"version-{publicada}", None):
        return False
    return telegram_notifier.notificar(
        "version",
        f"🆕 Hay una versión nueva: {publicada} (tienes la {__version__}).\n"
        "Actualiza desde Ajustes > Datos.",
    )


def _pasada_disco() -> bool:
    minimo = settings.espacioMinimoBytes()
    if minimo <= 0:
        return False
    try:
        libre = shutil.disk_usage(paths.DATA_DIR).free
    except OSError as error:
        log.debug("[avisos] No se pudo medir el disco: %s", error)
        return False
    if libre >= minimo:
        return False
    return telegram_notifier.notificar(
        "sistema",
        f"💽 Queda poco espacio en el disco de datos: {libre / 1024 / 1024:.0f} MB libres "
        f"(el aviso salta por debajo de {minimo / 1024 / 1024:.0f} MB).\n"
        "Sin espacio no se pueden guardar copias, ajustes ni operaciones.",
        clave="disco", cooldown=_ENTRE_AVISOS_DISCO, compartido=True,
    )


def _ejecutar(nombre, tarea) -> None:
    try:
        tarea()
    except Exception as error:
        # Ninguna tarea puede matar el hilo: las demás siguen valiendo.
        log.warning("[avisos] %s: %s", nombre, error)


def _bucle():
    proxima = {"version": 0.0, "disco": 0.0}
    # Deja que el servidor termine de arrancar antes de la primera pasada.
    if _parada.wait(15):
        return

    while not _parada.is_set():
        _ejecutar("alertas", _pasada_alertas)
        _ejecutar("resumen", _pasada_resumen)

        ahora = time.monotonic()
        if ahora >= proxima["version"]:
            proxima["version"] = ahora + _CADA_VERSION
            _ejecutar("version", _pasada_version)
        if ahora >= proxima["disco"]:
            proxima["disco"] = ahora + _CADA_DISCO
            _ejecutar("disco", _pasada_disco)

        if _parada.wait(_TICK):
            return


def iniciar():
    """Arranca el hilo. Idempotente."""
    global _hilo

    with _arranque:
        if _hilo is not None and _hilo.is_alive():
            return _hilo
        _parada.clear()
        _hilo = threading.Thread(target=_bucle, name="avisos-scheduler", daemon=True)
        _hilo.start()
        log.info("[avisos] Hilo de avisos arrancado")
        return _hilo


def detener(timeout=5):
    """Para el hilo. Pensado para los tests y para un apagado ordenado."""
    global _hilo
    _parada.set()
    if _hilo is not None:
        _hilo.join(timeout=timeout)
        _hilo = None
