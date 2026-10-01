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

Desde la 2.10 también contesta a los comandos del chat autorizado (`/estado`,
`/cartera`, `/backup`…): la lógica de cada uno está en `admin/telegram_comandos.py`
y aquí solo se decide quién puede hablar y se envía la respuesta.

**Un solo oyente.** gunicorn arranca este hilo en cada worker, pero Telegram solo
admite una sesión de `getUpdates` por bot (la segunda recibe un 409) y, con
comandos, dos oyentes contestarían dos veces. El oyente toma un bloqueo de
fichero (`core.bloqueo`) que dura lo que dura el proceso; el otro worker espera y
lo releva si el primero muere.

Vive en `admin/` junto al resto de hilos de fondo del proceso (backups,
snapshots), no en `core/telegram_notifier.py`, que es solo el lado de enviar.
"""

import json
import logging
import threading
import time
import urllib.parse
import urllib.request
from urllib.error import HTTPError, URLError

from admin import telegram_comandos
from core import paths, telegram_notifier
from core.bloqueo import exclusivo

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

# Un comando más viejo que esto no se ejecuta. Si el servidor estuvo parado, los
# mensajes se acumulan en Telegram, y ejecutar al arrancar un /backup escrito
# ayer no es lo que nadie quiere.
_MAX_EDAD_COMANDO = 300

_MENSAJE_CONFIRMACION = (
    "✅ Conectado. A partir de ahora avisaré aquí de lo que pase en el servidor "
    "(copias de seguridad, alertas de precio, proveedores…) y puedes preguntarme "
    "con comandos. Escribe /ayuda para verlos."
)

# Token para el que ya se registró el menú de comandos de Telegram.
_menu_registrado: str | None = None


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


def _responder(token: str, chat_id: str, texto: str) -> None:
    try:
        telegram_notifier._enviar(token, chat_id, texto)
    except Exception as error:
        log.warning("[telegram] No se pudo responder: %s", error)


def _procesar(update: dict, token: str, chat_id_configurado: str) -> None:
    mensaje = update.get("message") or {}
    texto = str(mensaje.get("text") or "").strip()
    remitente = str((mensaje.get("chat") or {}).get("id") or "")

    comando, _args = telegram_comandos.partir(texto)
    if comando is None or not remitente:
        return

    if remitente != chat_id_configurado:
        log.info("[telegram] /%s de un chat no autorizado, ignorado", comando)
        return

    if comando == "start":
        _responder(token, remitente, _MENSAJE_CONFIRMACION)
        return

    enviado = mensaje.get("date")
    if isinstance(enviado, (int, float)) and time.time() - enviado > _MAX_EDAD_COMANDO:
        log.info("[telegram] /%s ignorado: se escribió hace más de %s s", comando, _MAX_EDAD_COMANDO)
        return

    respuesta = telegram_comandos.responder(texto)
    if respuesta:
        _responder(token, remitente, respuesta)


def _registrar_menu(token: str) -> None:
    """Publica la lista de comandos para que Telegram la ofrezca al escribir «/»."""
    global _menu_registrado
    if _menu_registrado == token:
        return
    try:
        cuerpo = json.dumps({"commands": [
            {"command": nombre, "description": ayuda[:256]} for nombre, ayuda in telegram_comandos.COMANDOS
        ]}).encode("utf-8")
        peticion = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/setMyCommands", data=cuerpo,
            headers={"Content-Type": "application/json"},
        )
        with urllib.request.urlopen(peticion, timeout=_TIMEOUT_PETICION):
            pass
        _menu_registrado = token
    except Exception as error:
        # Es un adorno: sin menú los comandos funcionan igual escritos a mano.
        log.debug("[telegram] No se pudo registrar el menú de comandos: %s", error)


def _escuchar() -> bool:
    """Bucle de sondeo mientras se tenga el turno. True si hay que terminar el hilo."""
    offset = None

    while not _parada.is_set():
        token, chat_id = telegram_notifier.leerConfig()
        if not token or not chat_id:
            offset = None
            if _parada.wait(_ESPERA_SIN_CONFIGURAR):
                return True
            continue

        _registrar_menu(token)

        try:
            updates = _get_updates(token, offset)
        except (HTTPError, URLError, ValueError, TimeoutError) as error:
            log.debug("[telegram] getUpdates falló, se reintenta: %s", error)
            if _parada.wait(_ESPERA_TRAS_FALLO):
                return True
            continue
        except Exception as error:
            log.warning("[telegram] getUpdates: fallo inesperado: %s", error)
            if _parada.wait(_ESPERA_TRAS_FALLO):
                return True
            continue

        for update in updates:
            offset = update["update_id"] + 1
            try:
                _procesar(update, token, chat_id)
            except Exception as error:
                log.warning("[telegram] No se pudo procesar una actualización: %s", error)
    return True


def _ruta_bloqueo():
    return paths.TMP_DIR / "telegram-listener.lock"


def _bucle():
    while not _parada.is_set():
        # El bloqueo se mantiene mientras dura la escucha. Si otro worker ya es
        # el oyente, este espera y vuelve a intentarlo: si el otro muere, el
        # sistema suelta su bloqueo y este lo releva.
        with exclusivo(_ruta_bloqueo(), obligatorio=False) as conseguido:
            if conseguido:
                if _escuchar():
                    return
        if _parada.wait(_ESPERA_SIN_CONFIGURAR):
            return


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
