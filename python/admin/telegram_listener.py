"""Hilo que escucha los mensajes entrantes del bot de Telegram.

Un bot de Telegram no puede escribirle primero a nadie: Telegram rechaza el
`sendMessage` con «Forbidden: bot can't initiate conversation with a user»
hasta que esa persona le ha mandado algo -normalmente `/start`- al menos una
vez. Este hilo hace long-polling contra `getUpdates` mientras haya un bot
configurado, y cuando llega un `/start`:

* Si viene del chat guardado en Ajustes, responde confirmando: ese
  intercambio es justo lo que desbloquea el aviso automático más adelante.
* Si viene de cualquier otro chat -el nombre de usuario del bot es público,
  así que cualquiera puede escribirle- lo ignora sin contestar nada. Devolver
  aunque sea un error confirmaría que hay un bot de verdad detrás y qué hace,
  que es justo lo que no le interesa a un bot pensado para un único usuario.

Vive en `admin/` junto al resto de hilos de fondo del proceso (backups,
snapshots), no en `core/telegram_notifier.py`, que es solo el lado de enviar.
"""

import json
import logging
import threading
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

from core import telegram_notifier

log = logging.getLogger(__name__)

_hilo: threading.Thread | None = None
_arranque = threading.Lock()
_parada = threading.Event()

# Cuánto espera Telegram antes de devolver una respuesta vacía a getUpdates.
_TIMEOUT_TELEGRAM = 30
# Margen sobre ese timeout para el propio urlopen: si se igualan, una respuesta
# que tarda justo lo que Telegram promete puede llegar cortada.
_TIMEOUT_PETICION = _TIMEOUT_TELEGRAM + 10
# Cada cuánto se vuelve a mirar si ya hay un bot configurado.
_ESPERA_SIN_CONFIGURAR = 30
# Tras un fallo de red o de Telegram, antes de reintentar.
_ESPERA_TRAS_FALLO = 15

_MENSAJE_CONFIRMACION = (
    "✅ Conectado. A partir de ahora avisaré aquí de problemas con los "
    "proveedores de cotizaciones."
)


def _get_updates(token: str, offset):
    parametros = {"timeout": _TIMEOUT_TELEGRAM}
    if offset is not None:
        parametros["offset"] = offset
    url = f"https://api.telegram.org/bot{token}/getUpdates?{urllib.parse.urlencode(parametros)}"
    with urllib.request.urlopen(url, timeout=_TIMEOUT_PETICION) as response:
        cuerpo = json.loads(response.read().decode("utf-8"))
    if not cuerpo.get("ok"):
        raise ValueError(cuerpo.get("description") or "Telegram rechazó getUpdates")
    return cuerpo.get("result") or []


def _procesar(update: dict, token: str, chat_id_configurado: str) -> None:
    mensaje = update.get("message") or {}
    texto = str(mensaje.get("text") or "").strip()
    remitente = str((mensaje.get("chat") or {}).get("id") or "")

    if texto != "/start" or not remitente:
        return

    if remitente != chat_id_configurado:
        log.info("[telegram] /start de un chat no autorizado, ignorado")
        return

    try:
        telegram_notifier._enviar(token, remitente, _MENSAJE_CONFIRMACION)
    except Exception as error:
        log.warning("[telegram] No se pudo confirmar el /start: %s", error)


def _bucle():
    offset = None

    while not _parada.is_set():
        token, chat_id = telegram_notifier.leerConfig()
        if not token or not chat_id:
            offset = None
            if _parada.wait(_ESPERA_SIN_CONFIGURAR):
                return
            continue

        try:
            updates = _get_updates(token, offset)
        except (HTTPError, URLError, ValueError, TimeoutError) as error:
            log.debug("[telegram] getUpdates falló, se reintenta: %s", error)
            if _parada.wait(_ESPERA_TRAS_FALLO):
                return
            continue
        except Exception as error:
            log.warning("[telegram] getUpdates: fallo inesperado: %s", error)
            if _parada.wait(_ESPERA_TRAS_FALLO):
                return
            continue

        for update in updates:
            offset = update["update_id"] + 1
            try:
                _procesar(update, token, chat_id)
            except Exception as error:
                log.warning("[telegram] No se pudo procesar una actualización: %s", error)


def iniciar():
    """Arranca el hilo de escucha. Idempotente."""
    global _hilo

    with _arranque:
        if _hilo is not None and _hilo.is_alive():
            return _hilo
        _parada.clear()
        _hilo = threading.Thread(target=_bucle, name="telegram-listener", daemon=True)
        _hilo.start()
        log.info("[telegram] Hilo de escucha arrancado")
        return _hilo


def detener(timeout=5):
    """Para el hilo. Pensado para los tests y para un apagado ordenado."""
    global _hilo
    _parada.set()
    if _hilo is not None:
        _hilo.join(timeout=timeout)
        _hilo = None
