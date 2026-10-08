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

**Avisos de otros sucesos.** Además de los proveedores, el servidor cuenta por
aquí copias de seguridad, restauraciones, alertas de precio, bloqueos de login,
arranques, disco casi lleno, versión nueva y el resumen diario. Todos pasan por
`notificar(categoria, texto)`, que respeta dos decisiones del usuario: qué
categorías quiere recibir (Ajustes > Telegram, `telegramAvisos` en
`ajustes.json`) y el silencio temporal que pone `/silenciar` desde el chat. Lo
segundo vive en un fichero de `data/tmp` y no en memoria porque el chat lo
atiende un worker y los avisos salen de los dos.

Lo que responde el bot a un comando no pasa por aquí: es la respuesta a una
pregunta, no un aviso, y ni las categorías ni el silencio deben callarla.
"""

import json
import logging
import time
import urllib.request
import uuid
from pathlib import Path
from threading import Lock
from urllib.error import HTTPError, URLError

from core import paths, reclamo
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

# Tipos de aviso que el usuario puede activar o apagar en Ajustes > Telegram:
# clave -> (título que se enseña, ¿activado si no ha elegido nada?). El orden es
# el de la pantalla. Un aviso de una clave que no esté aquí no se manda: mejor
# eso que un tipo sin interruptor que nadie puede callar.
CATEGORIAS_AVISO = {
    "proveedores": ("Problemas con los proveedores de cotizaciones", True),
    "backup": ("Copias de seguridad (creadas, fallidas, restauradas)", True),
    # Aparte y apagado de fábrica: es el ZIP con todas las carteras (y las
    # claves si se incluyen) subido a los servidores de Telegram, que no cifra
    # los chats con bots de extremo a extremo. Antes salía con el aviso de
    # «backup», encendido por defecto, en cuanto se configuraba el bot.
    "backupFichero": ("Enviar el fichero de cada copia automática (todos tus datos)", False),
    "precios": ("Alertas de precio de los activos", True),
    "seguridad": ("Seguridad (login bloqueado, cambio de contraseña)", True),
    "sistema": ("Estado del servidor (arranque, disco, base de datos)", True),
    "version": ("Hay una versión nueva publicada", True),
    "sesion": ("Cada inicio de sesión correcto", False),
    "resumen": ("Resumen diario de la cartera", False),
}

RESUMEN_HORA_DEFECTO = 21
# Telegram rechaza mensajes de más de 4096 caracteres; se deja margen.
_MAX_TEXTO = 4000

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
    texto = str(texto)
    if len(texto) > _MAX_TEXTO:
        texto = texto[:_MAX_TEXTO - 1] + "…"
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


_AVISO_SIN_START = (
    'Telegram no deja que el bot escriba primero: abre el chat con tu bot '
    '(busca el nombre de usuario que te dio @BotFather) y pulsa "Iniciar" '
    'antes de volver a probar.'
)


def enviarPrueba():
    """Manda un mensaje de prueba ignorando el cooldown. Devuelve (ok, error)."""
    token, chatId = leerConfig()
    if not token or not chatId:
        return False, "Falta el token del bot o el ID de chat"
    try:
        _enviar(token, chatId, "✅ PortfolioManager: conexión con Telegram correcta")
        return True, None
    except HTTPError as error:
        descripcion = ""
        try:
            cuerpo = json.loads(error.read().decode("utf-8", errors="replace"))
            descripcion = str(cuerpo.get("description") or "")
        except Exception:
            pass
        # El caso más común con diferencia: el chat existe (el ID es correcto)
        # pero esa persona nunca le ha escrito nada al bot, y Telegram no deja
        # que un bot inicie la conversación. Sin esto, el error crudo de
        # Telegram no dice qué hacer para arreglarlo.
        if "initiate conversation" in descripcion.lower() or "bot was blocked" in descripcion.lower():
            return False, _AVISO_SIN_START
        return False, f"Telegram devolvió HTTP {error.code}: {descripcion or str(error)}"[:300]
    except URLError as error:
        from providers.http import motivo_conexion
        return False, f"No se pudo conectar con Telegram: {motivo_conexion(error, 'Telegram')}"
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
    if not _permitido("proveedores"):
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


# ── Preferencias y silencio ───────────────────────────────────────────────────

def _ajustesGuardados() -> dict:
    """`ajustes.json` tal cual, o {} si no existe o no se puede leer.

    Se lee el fichero y no `routes.ajustes._read_ajustes`: este módulo es de
    `core`, que no importa de `routes`, y el vigilante lo carga solo, sin Flask.
    """
    try:
        datos = json.loads(paths.AJUSTES_JSON.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return datos if isinstance(datos, dict) else {}


def preferencias() -> dict:
    """Qué categorías de aviso están activadas: {categoria: bool}, todas presentes."""
    guardadas = _ajustesGuardados().get("telegramAvisos")
    guardadas = guardadas if isinstance(guardadas, dict) else {}
    return {
        clave: bool(guardadas[clave]) if clave in guardadas else defecto
        for clave, (_titulo, defecto) in CATEGORIAS_AVISO.items()
    }


def resumenHora() -> int:
    """Hora local (0-23) a la que sale el resumen diario."""
    try:
        hora = int(_ajustesGuardados().get("telegramResumenHora", RESUMEN_HORA_DEFECTO))
    except (TypeError, ValueError):
        return RESUMEN_HORA_DEFECTO
    return hora if 0 <= hora <= 23 else RESUMEN_HORA_DEFECTO


def _archivoSilencio():
    return paths.TMP_DIR / "telegram-silencio"


def silenciadoHasta() -> float:
    """Instante (epoch) hasta el que los avisos están callados; 0 si no lo están."""
    try:
        hasta = float(_archivoSilencio().read_text("utf-8").strip())
    except (OSError, ValueError):
        return 0.0
    return hasta if hasta > time.time() else 0.0


def silenciar(segundos: float) -> float:
    """Calla los avisos automáticos durante `segundos`. Devuelve el instante final."""
    hasta = time.time() + max(0.0, float(segundos))
    archivo = _archivoSilencio()
    archivo.parent.mkdir(parents=True, exist_ok=True)
    archivo.write_text(f"{hasta:.0f}", "utf-8")
    return hasta


def quitarSilencio() -> None:
    try:
        _archivoSilencio().unlink(missing_ok=True)
    except OSError:
        pass


def _permitido(categoria: str) -> bool:
    """¿Se puede mandar ahora un aviso de esta categoría?"""
    if silenciadoHasta():
        return False
    return preferencias().get(categoria, False)


# ── Avisos de sucesos ─────────────────────────────────────────────────────────

def notificar(categoria: str, texto: str, *, clave: str | None = None,
              cooldown: float = 0, compartido: bool = False) -> bool:
    """Manda `texto` si hay Telegram, la categoría está activada y no hay silencio.

    `clave` + `cooldown` evitan repetir el mismo aviso antes de `cooldown`
    segundos. Con `compartido=True` esa espera se coordina entre los workers de
    gunicorn (`core.reclamo`), imprescindible para lo que dispara cada uno por
    su cuenta, como el arranque. Devuelve si se llegó a enviar. Nunca lanza: un
    aviso que falla no puede tumbar el backup o el login que lo origina.
    """
    try:
        if categoria not in CATEGORIAS_AVISO:
            log.debug("[telegram] Categoría de aviso desconocida: %r", categoria)
            return False

        token, chatId = leerConfig()
        if not token or not chatId or not _permitido(categoria):
            return False

        if clave is not None and cooldown > 0:
            if compartido:
                if not reclamo.reclamar(f"aviso-{clave}", cooldown):
                    return False
            else:
                ahora = time.monotonic()
                with _lock:
                    anterior = _ultimoAviso.get(("evento", clave))
                    if anterior is not None and ahora - anterior < cooldown:
                        return False
                    _ultimoAviso[("evento", clave)] = ahora

        _enviar(token, chatId, texto)
        return True
    except Exception as error:
        log.warning("[telegram] No se pudo enviar el aviso (%s): %s", categoria, error)
        return False


_API_DOC_URL = "https://api.telegram.org/bot{token}/sendDocument"
# Límite de Telegram para ficheros subidos por un bot.
MAX_BYTES_DOCUMENTO = 50 * 1024 * 1024
_TIMEOUT_DOCUMENTO = 120.0


def _enviar_documento(token: str, chatId: str, ruta, texto: str) -> None:
    ruta = Path(ruta)
    limite = uuid.uuid4().hex
    cabecera = b"".join(
        (f"--{limite}\r\nContent-Disposition: form-data; name=\"{nombre}\"\r\n\r\n{valor}\r\n").encode()
        for nombre, valor in (("chat_id", chatId), ("caption", str(texto)[:1000]))
    ) + (
        f"--{limite}\r\nContent-Disposition: form-data; name=\"document\"; "
        f"filename=\"{ruta.name}\"\r\nContent-Type: application/zip\r\n\r\n"
    ).encode()
    cuerpo = cabecera + ruta.read_bytes() + f"\r\n--{limite}--\r\n".encode()
    request = urllib.request.Request(
        _API_DOC_URL.format(token=token),
        data=cuerpo,
        headers={"Content-Type": f"multipart/form-data; boundary={limite}"},
    )
    with urllib.request.urlopen(request, timeout=_TIMEOUT_DOCUMENTO) as response:
        respuesta = json.loads(response.read().decode("utf-8"))
    if not respuesta.get("ok"):
        raise ValueError(respuesta.get("description") or "Telegram rechazó el fichero")


def notificar_archivo(categoria: str, ruta, texto: str) -> bool:
    """Manda un fichero (con `texto` de pie) con las mismas reglas que `notificar`.

    Si pesa más de lo que admite Telegram no se intenta: se avisa con un mensaje
    para que no parezca que la copia salió. Devuelve si se mandó algo al chat
    (fichero o ese mensaje). Nunca lanza.
    """
    try:
        if categoria not in CATEGORIAS_AVISO:
            return False
        token, chatId = leerConfig()
        if not token or not chatId or not _permitido(categoria):
            return False
        tamano = Path(ruta).stat().st_size
        if tamano > MAX_BYTES_DOCUMENTO:
            _enviar(token, chatId, f"{texto}\n⚠️ No se ha podido adjuntar: pesa {tamano / 1024 / 1024:.0f} MB y "
                                   "Telegram admite 50 MB como máximo.")
            return True
        _enviar_documento(token, chatId, ruta, texto)
        return True
    except Exception as error:
        log.warning("[telegram] No se pudo enviar el fichero (%s): %s", categoria, error)
        return False


def responder_archivo(ruta, texto: str) -> bool:
    """Manda un fichero al chat configurado sin pasar por categorías ni silencio.

    Es la respuesta a algo que el usuario pidió (`/backup`). Si pesa más de lo
    que admite Telegram manda solo `texto` con el aviso. Nunca lanza.
    """
    try:
        token, chatId = leerConfig()
        if not token or not chatId:
            return False
        tamano = Path(ruta).stat().st_size
        if tamano > MAX_BYTES_DOCUMENTO:
            _enviar(token, chatId, f"{texto}\n⚠️ No se ha podido adjuntar: pesa {tamano / 1024 / 1024:.0f} MB y "
                                   "Telegram admite 50 MB como máximo.")
        else:
            _enviar_documento(token, chatId, ruta, texto)
        return True
    except Exception as error:
        log.warning("[telegram] No se pudo responder con el fichero: %s", error)
        return False


def responder(texto: str) -> bool:
    """Manda `texto` al chat configurado sin pasar por categorías ni silencio."""
    try:
        token, chatId = leerConfig()
        if not token or not chatId:
            return False
        _enviar(token, chatId, texto)
        return True
    except Exception as error:
        log.warning("[telegram] No se pudo responder: %s", error)
        return False


def notificar_arranque(version: str) -> None:
    """Aviso de servidor iniciado. Los dos workers llegan aquí; solo habla el primero."""
    notificar("sistema", f"🟢 PortfolioManager {version} iniciado",
              clave="arranque", cooldown=90, compartido=True)


def reiniciar_para_pruebas() -> None:
    """Vacía el cooldown y el estado de caídos en memoria. Simula un proceso recién arrancado."""
    with _lock:
        _ultimoAviso.clear()
        _proveedoresCaidos.clear()
