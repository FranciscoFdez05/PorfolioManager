"""Aviso por Telegram cuando un proveedor de cotizaciones da problemas.

El token del bot y el ID de chat se guardan como el resto de secretos de la
aplicación (`core.secret_store`, el mismo cifrado que `API/*.key`), no en
`ajustes.json`: son credenciales, no preferencias.

Los avisos los dispara quien detecta el problema —hoy, `stores.market_data`
cuando un proveedor falla al pedir una cotización real— con una de tres
categorías: cuota agotada, no responde, o un fallo genérico. No hay sondeo
propio: comprobar el estado de un proveedor solo para decidir si avisar
gastaría la misma cuota gratuita que se quiere vigilar (ver el docstring de
`providers.estado`).

Un mismo aviso (misma categoría y mismo proveedor) no se repite antes de
`_COOLDOWN_SEGUNDOS`: un refresco de cartera reintenta el proveedor caído en
cada activo, y sin este margen cada refresco sería un aviso de Telegram por
activo.

Cuando un proveedor que estaba avisado como caído vuelve a dar una cotización
válida, `notificar_recuperado` manda un aviso de vuelta y libera su cooldown:
así, si vuelve a fallar justo después, se avisa sin esperar el margen entero.
Sin esto, la única forma de saber que un proveedor se había arreglado era
comprobarlo a mano en Ajustes.
"""

import json
import logging
import time
import urllib.request
from threading import Lock
from urllib.error import HTTPError, URLError

from core import paths
from core.secret_store import read_secret_lines, write_secret_lines

log = logging.getLogger(__name__)

_API_URL = "https://api.telegram.org/bot{token}/sendMessage"
_TIMEOUT = 10.0
_COOLDOWN_SEGUNDOS = 1800

_PLANTILLAS = {
    "cuota_agotada": "⚠️ Cuota agotada de {sujeto}",
    "no_responde": "🔌 {sujeto} no responde",
    "fallo": "❌ Fallo de {sujeto}",
}

_lock = Lock()
_ultimoAviso: dict = {}
_proveedoresCaidos: set = set()


def _archivoConfig():
    # Se resuelve en cada llamada, no al importar: los tests reasignan
    # paths.API_DIR a un directorio temporal (ver tests/conftest.py), igual
    # que hace el resto del código que lee de API/.
    return paths.API_DIR / "telegram.key"


def leerConfig():
    """(token, chatId) guardados, o ("", "") si no hay nada configurado."""
    lineas = read_secret_lines(_archivoConfig())
    token = lineas[0] if len(lineas) > 0 else ""
    chatId = lineas[1] if len(lineas) > 1 else ""
    return token, chatId


def escribirConfig(token: str, chatId: str) -> None:
    write_secret_lines(_archivoConfig(), [str(token).strip(), str(chatId).strip()])


def borrarConfig() -> None:
    write_secret_lines(_archivoConfig(), [])


def configurado() -> bool:
    token, chatId = leerConfig()
    return bool(token) and bool(chatId)


def _enviar(token: str, chatId: str, texto: str) -> None:
    payload = json.dumps({"chat_id": chatId, "text": texto}).encode("utf-8")
    request = urllib.request.Request(
        _API_URL.format(token=token),
        data=payload,
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=_TIMEOUT) as response:
        cuerpo = json.loads(response.read().decode("utf-8"))
    if not cuerpo.get("ok"):
        raise ValueError(cuerpo.get("description") or "Telegram rechazó el mensaje")


def enviarPrueba():
    """Manda un mensaje de prueba ignorando el cooldown. Devuelve (ok, error)."""
    token, chatId = leerConfig()
    if not token or not chatId:
        return False, "Falta el token del bot o el ID de chat"
    try:
        _enviar(token, chatId, "✅ PortfolioManager: conexión con Telegram correcta")
        return True, None
    except HTTPError as error:
        try:
            detalle = error.read().decode("utf-8", errors="replace")
        except Exception:
            detalle = str(error)
        return False, f"Telegram devolvió HTTP {error.code}: {detalle[:200]}"
    except URLError as error:
        return False, f"No se pudo conectar con Telegram: {error.reason}"
    except Exception as error:
        return False, str(error)[:200]


def notificar_problema(categoria: str, sujeto: str, detalle: str = "") -> None:
    """Manda un aviso si hay Telegram configurado y no se ha mandado ya hace poco.

    Nunca lanza: un fallo mandando el aviso no debe tumbar el refresco de
    cotizaciones que lo dispara.
    """
    plantilla = _PLANTILLAS.get(categoria)
    if plantilla is None:
        log.debug("[telegram] Categoría de aviso desconocida: %r", categoria)
        return

    token, chatId = leerConfig()
    if not token or not chatId:
        return

    clave = (categoria, sujeto)
    ahora = time.monotonic()
    with _lock:
        _proveedoresCaidos.add(sujeto)
        anterior = _ultimoAviso.get(clave)
        if anterior is not None and ahora - anterior < _COOLDOWN_SEGUNDOS:
            return
        _ultimoAviso[clave] = ahora

    texto = plantilla.format(sujeto=sujeto)
    if detalle:
        texto += f"\n{str(detalle)[:300]}"

    try:
        _enviar(token, chatId, texto)
    except Exception as error:
        log.warning("[telegram] No se pudo enviar el aviso (%s/%s): %s", categoria, sujeto, error)


def notificar_recuperado(sujeto: str) -> None:
    """Avisa de que `sujeto` vuelve a responder, si antes se había avisado de un fallo suyo.

    Silencioso si nunca se avisó de que estuviera caído: no todo activo que se
    cotiza bien es un proveedor que se ha "recuperado" de nada.
    """
    token, chatId = leerConfig()
    if not token or not chatId:
        return

    with _lock:
        if sujeto not in _proveedoresCaidos:
            return
        _proveedoresCaidos.discard(sujeto)
        for clave in [clave for clave in _ultimoAviso if clave[1] == sujeto]:
            _ultimoAviso.pop(clave, None)

    try:
        _enviar(token, chatId, f"✅ {sujeto} vuelve a responder")
    except Exception as error:
        log.warning("[telegram] No se pudo enviar el aviso de recuperación (%s): %s", sujeto, error)


def reiniciar_para_pruebas() -> None:
    """Vacía el cooldown y el estado de caídos en memoria. Simula un proceso recién arrancado."""
    with _lock:
        _ultimoAviso.clear()
        _proveedoresCaidos.clear()
