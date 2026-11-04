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
  * **Wallets** — con el intervalo elegido en Cripto > Seguimiento, saldo y
    movimientos nuevos de las wallets (ver `core.wallets_vigilancia`).
  * **Monedas de Satoshi** — cada pocos minutos, si está activada, los bloques
    nuevos de Bitcoin en busca de monedas de Satoshi gastadas
    (ver `core.satoshi_vigilancia`).

Con gunicorn, cada worker arranca su copia de este hilo. Lo que no se puede
repetir se reclama con `core.reclamo`, de modo que solo lo hace un proceso por
ronda; las alertas, además, se reclaman en la propia base de datos.
"""

import logging
import shutil
import threading
import time
from datetime import datetime

from core import paths, pulso, reclamo, settings, telegram_notifier
from core.db import useDbPath

log = logging.getLogger(__name__)

_hilo: threading.Thread | None = None
_arranque = threading.Lock()
_parada = threading.Event()

# Cada cuánto se despierta el hilo a mirar si toca alguna tarea.
_TICK = 20
_CADA_VERSION = 600
_CADA_DISCO = 600
# Sale un bloque cada ~10 minutos: mirar cada 5 basta para avisar a tiempo.
_CADA_SATOSHI = 300
# Una vuelta con muchas wallets ajenas tarda, a una llamada por segundo.
_plazoVueltaSegundos = 6 * 3600
# El resumen no se repite antes de 20 h: da margen para que un cambio de hora
# en Ajustes no lo mande dos veces el mismo día ni se salte uno.
_ENTRE_RESUMENES = 20 * 3600
_ENTRE_AVISOS_DISCO = 24 * 3600


def rutasDePortfolios():
    """[(id, nombre, ruta)] de todos los portfolios cuyo .db existe."""
    from admin.portfolios_manager import _portfolioDbPath, getPortfolios

    encontrados = []
    for portfolio in (getPortfolios() or {}).get("portfolios", []):
        try:
            ruta = _portfolioDbPath(portfolio.get("id", ""))
        except ValueError:
            continue
        # Un .db que no existe no se toca: abrirlo lo crearía vacío.
        if ruta.exists():
            encontrados.append((portfolio["id"], portfolio.get("name") or portfolio["id"], ruta))
    return encontrados


def _pasadaAlertas() -> int:
    from stores import alertas_store

    intervalo = settings.alertasIntervaloSegundos()
    if intervalo <= 0 or not reclamo.reclamar("alertas-pasada", intervalo * 0.8):
        return 0

    saltadas = 0
    for pid, _nombre, ruta in rutasDePortfolios():
        try:
            with useDbPath(ruta):
                if alertas_store.contarActivas():
                    saltadas += alertas_store.comprobarActivas(cartera=pid)
        except Exception as error:
            # Un portfolio con problemas no puede impedir vigilar los demás.
            log.warning("[avisos] Alertas de %s: %s", pid, error)
    return saltadas


def textoResumen() -> str:
    """El resumen diario de todos los portfolios, listo para enviar."""
    from stores import resumen_cartera

    bloques = []
    for pid, nombre, ruta in rutasDePortfolios():
        try:
            with useDbPath(ruta):
                bloques.append(resumen_cartera.formatear(nombre, resumen_cartera.calcular()))
        except Exception as error:
            log.warning("[avisos] Resumen de %s: %s", pid, error)
            bloques.append(f"{nombre}\nNo se pudo calcular ({str(error)[:80]}).")
    if not bloques:
        return ""
    fecha = datetime.now().strftime("%d/%m/%Y")
    return f"Resumen del {fecha}\n\n" + "\n\n".join(bloques)


def _pasadaResumen() -> bool:
    if not telegram_notifier.configurado() or not telegram_notifier.preferencias().get("resumen"):
        return False
    if datetime.now().hour < telegram_notifier.resumenHora():
        return False
    if not reclamo.reclamar("resumen-diario", _ENTRE_RESUMENES):
        return False

    texto = textoResumen()
    if not texto:
        return False
    return telegram_notifier.notificar("resumen", texto)


def _pasadaVersion() -> bool:
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
        f"Hay una versión nueva: {publicada} (tienes la {__version__}).\n"
        "Actualiza desde Ajustes > Datos.",
    )


def _pasadaDisco() -> bool:
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
        f"Queda poco espacio en el disco de datos: {libre / 1024 / 1024:.0f} MB libres "
        f"(el aviso salta por debajo de {minimo / 1024 / 1024:.0f} MB).\n"
        "Sin espacio no se pueden guardar copias, ajustes ni operaciones.",
        gravedad=telegram_notifier.AVISO,
        clave="disco", cooldown=_ENTRE_AVISOS_DISCO, compartido=True,
    )


def _pasadaWallets() -> int:
    """Revisa las wallets de Cripto > Seguimiento con el intervalo elegido en esa página."""
    from core import wallets_vigilancia
    from core.db import getActiveDbPath

    minutos = wallets_vigilancia.minutosVigilancia()
    if minutos <= 0 or not reclamo.reclamar("wallets-vigilancia", minutos * 60 * 0.9):
        return 0
    # Las wallets son de la instalación, pero el precio en euros de los avisos
    # sale del activo asociado en el portfolio activo.
    # Cada red se revisa en su hilo y useDbPath es por hilo: cada uno lo abre.
    ruta = getActiveDbPath()
    return wallets_vigilancia.VigilanteWallets().revisarTodas(contexto=lambda: useDbPath(ruta))


def _pasadaSatoshi() -> int:
    """Revisa los bloques nuevos en busca de monedas de Satoshi gastadas, si está activado."""
    from core import satoshi_vigilancia

    if not satoshi_vigilancia.SatoshiEstadoRepository().leer().activo:
        return 0
    if not reclamo.reclamar("satoshi-vigilancia", _CADA_SATOSHI * 0.9):
        return 0
    return satoshi_vigilancia.VigilanteSatoshi().revisar()


def _ejecutar(nombre, tarea) -> None:
    try:
        tarea()
    except Exception as error:
        # Ninguna tarea puede matar el hilo: las demás siguen valiendo.
        log.warning("[avisos] %s: %s", nombre, error)


def _bucle():
    proxima = {"version": 0.0, "disco": 0.0, "satoshi": 0.0}
    # Deja que el servidor termine de arrancar antes de la primera pasada.
    if _parada.wait(15):
        return

    while not _parada.is_set():
        pulso.marcar("avisos", _plazoVueltaSegundos)
        _ejecutar("alertas", _pasadaAlertas)
        _ejecutar("resumen", _pasadaResumen)
        _ejecutar("wallets", _pasadaWallets)

        ahora = time.monotonic()
        if ahora >= proxima["version"]:
            proxima["version"] = ahora + _CADA_VERSION
            _ejecutar("version", _pasadaVersion)
        if ahora >= proxima["disco"]:
            proxima["disco"] = ahora + _CADA_DISCO
            _ejecutar("disco", _pasadaDisco)
        if ahora >= proxima["satoshi"]:
            proxima["satoshi"] = ahora + _CADA_SATOSHI
            _ejecutar("satoshi", _pasadaSatoshi)

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
