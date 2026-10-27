"""Verificación en dos pasos (2FA) por Telegram, opcional.

Con la 2FA activada, usuario y contraseña ya no bastan para entrar: el servidor
manda un código de un solo uso al chat de Telegram configurado en Ajustes y la
sesión no se abre hasta que se escribe. Si se pierde el acceso a Telegram (bot
borrado, token revocado, móvil perdido), la frase de recuperación que se generó
al activarla deja entrar una vez y desactiva la 2FA.

**Dónde se guarda cada cosa.**

- Si está activada y el hash de la frase: `data/dos_factores.dat`, cifrado con
  la SECRET_KEY igual que `auth.dat`. Aparte de `auth.dat` para que cambiar el
  usuario o la contraseña no tenga que saber nada de esto. Borrar ese fichero
  desde el servidor es la salida de emergencia: desactiva la 2FA.
- Los retos pendientes (un código enviado y aún sin usar): `data/tmp`, con
  cerrojo entre procesos. No pueden ir en la cookie de sesión: está firmada
  pero no cifrada, y el hash de un código de seis dígitos se rompe offline al
  instante. Tampoco en memoria: con dos workers de gunicorn, el que manda el
  código y el que lo comprueba no tienen por qué ser el mismo.

**Por qué el código es de solo seis dígitos.** Lo que lo protege no es su
longitud sino que caduca en minutos, que cada reto admite pocos intentos y que
los fallos cuentan para el bloqueo por IP del login. Con los valores de serie,
acertar por fuerza bruta es del orden de una entre cien mil por reto, y cada
reto nuevo exige la contraseña y avisa al usuario por Telegram.

**La frase.** Palabras al azar de la lista BIP39 en español (2048 palabras, 11
bits cada una: 66 bits con 6 palabras, 132 con 12). Se compara sin tildes, sin
mayúsculas y sin espacios de más: la lista está hecha para que no haya dos
palabras que se confundan así, y lo que se apunta a mano en un papel no
conserva las tildes.
"""

import functools
import hashlib
import hmac
import json
import logging
import math
import secrets
import time
import unicodedata
from contextlib import contextmanager
from pathlib import Path

from cryptography.fernet import InvalidToken
from werkzeug.security import check_password_hash, generate_password_hash

from core import paths, settings, telegram_notifier
from core.bloqueo import exclusivo
from core.escritura import escribirAtomico, escribirJsonAtomico
from core.secret_store import fernetDeSecretKey

log = logging.getLogger(__name__)

LARGOS_FRASE = (6, 12, 24)
DIGITOS_CODIGO = 6
# Para qué se pidió cada código. Un código enviado para entrar no sirve para
# desactivar la 2FA desde Ajustes, ni al revés.
PROPOSITOS = frozenset({"login", "activar", "desactivar", "telegram"})
# Reenvíos por reto. Sin tope, reenviar renovaría los intentos sin fin mientras
# el reto siga vivo; el bloqueo por IP ya lo frena, esto lo deja acotado aunque
# el atacante cambie de IP.
MAX_ENVIOS_POR_RETO = 5

_LISTA_PALABRAS = Path(__file__).with_name("datos") / "bip39_es.txt"
_TAMANO_LISTA = 2048


class RetoInvalido(Exception):
    """El reto no existe, ha caducado, es de otro propósito o agotó sus intentos.

    El mensaje es apto para enseñárselo al usuario. Tras esto hay que volver a
    empezar (volver a escribir la contraseña), no reintentar el código.
    """


class CodigoIncorrecto(Exception):
    """El código no coincide; el reto sigue vivo con los intentos que le queden."""


class EsperaReenvio(Exception):
    """Se ha pedido otro código antes de tiempo.

    Attributes:
        segundos: Cuánto falta para poder pedirlo.
    """

    def __init__(self, segundos: int):
        super().__init__(f"Espera {segundos} s antes de pedir otro código")
        self.segundos = segundos


# ── Estado persistente: activada o no ─────────────────────────────────────────

def _archivoEstado() -> Path:
    # Se resuelve en cada llamada: los tests reasignan paths.DATA_DIR.
    return paths.DATA_DIR / "dos_factores.dat"


def _fernet():
    return fernetDeSecretKey(b"portfolio-2fa-v1")


def _leerEstado() -> dict:
    """Lo guardado, o {} si no hay nada o no se puede leer.

    Un fichero ilegible (lo normal: la SECRET_KEY ha cambiado) se trata como
    2FA desactivada y se registra como error, igual que hace auth.py con
    auth.dat. Cerrarse en banda dejaría fuera al usuario sin forma de arreglarlo
    desde la web, y quien puede estropear ficheros de data/ ya está dentro del
    servidor.
    """
    ruta = _archivoEstado()
    try:
        crudo = ruta.read_bytes()
    except FileNotFoundError:
        return {}
    except OSError as error:
        log.error("[2fa] No se pudo leer %s (%s); la 2FA queda desactivada", ruta.name, error)
        return {}
    fernet = _fernet()
    try:
        if fernet:
            crudo = fernet.decrypt(crudo)
        datos = json.loads(crudo)
    except (InvalidToken, ValueError) as error:
        log.error("[2fa] %s ilegible (%s); la 2FA queda desactivada. "
                  "Si cambiaste la SECRET_KEY, recupera la anterior.", ruta.name, type(error).__name__)
        return {}
    return datos if isinstance(datos, dict) else {}


def activa() -> bool:
    """¿Está activada la verificación en dos pasos?"""
    estado = _leerEstado()
    return bool(estado.get("activa")) and bool(estado.get("fraseHash"))


def activar(fraseHash: str) -> None:
    """Activa la 2FA con el hash de la frase de recuperación ya confirmada.

    Args:
        fraseHash: Resultado de `hashFrase` sobre la frase que se enseñó.

    Raises:
        OSError: Si no se puede escribir el fichero.
    """
    contenido = json.dumps({"activa": True, "fraseHash": fraseHash}).encode("utf-8")
    fernet = _fernet()
    escribirAtomico(_archivoEstado(), fernet.encrypt(contenido) if fernet else contenido, permisos=0o600)


def desactivar() -> None:
    """Desactiva la 2FA y olvida la frase. No falla si ya estaba desactivada.

    Raises:
        OSError: Si el fichero existe y no se puede borrar.
    """
    _archivoEstado().unlink(missing_ok=True)


# ── Frase de recuperación ─────────────────────────────────────────────────────

@functools.lru_cache(maxsize=1)
def _palabras() -> tuple:
    """Las 2048 palabras BIP39 en español, en NFC (el fichero viene en NFKD).

    El fichero se deja tal cual lo publica BIP39 para poder comparar su SHA-256
    con el oficial; la normalización se hace aquí.
    """
    palabras = tuple(
        unicodedata.normalize("NFC", linea.strip())
        for linea in _LISTA_PALABRAS.read_text("utf-8").splitlines()
        if linea.strip()
    )
    if len(palabras) != _TAMANO_LISTA:
        # Con menos palabras la frase tendría menos entropía de la que se anuncia.
        raise RuntimeError(f"{_LISTA_PALABRAS.name} tiene {len(palabras)} palabras, se esperaban {_TAMANO_LISTA}")
    return palabras


def generarFrase(numPalabras: int) -> str:
    """Frase de recuperación nueva, de palabras elegidas con `secrets`.

    Args:
        numPalabras: 6, 12 o 24.

    Returns:
        Las palabras separadas por un espacio, con sus tildes.

    Raises:
        ValueError: Si `numPalabras` no es uno de `LARGOS_FRASE`.

    Example:
        >>> len(generarFrase(12).split())
        12
    """
    if numPalabras not in LARGOS_FRASE:
        raise ValueError(f"La frase debe tener {', '.join(map(str, LARGOS_FRASE))} palabras")
    palabras = _palabras()
    return " ".join(secrets.choice(palabras) for _ in range(numPalabras))


def normalizarFrase(texto: str) -> str:
    """Forma canónica para comparar: minúsculas, sin tildes, un espacio entre palabras.

    Example:
        >>> normalizarFrase("  Ábaco   ABEJA ")
        'abaco abeja'
    """
    descompuesto = unicodedata.normalize("NFKD", str(texto))
    sinTildes = "".join(c for c in descompuesto if not unicodedata.combining(c))
    return " ".join(sinTildes.lower().split())


def hashFrase(frase: str) -> str:
    """Hash PBKDF2 de la frase normalizada, con el mismo coste que la contraseña."""
    return generate_password_hash(normalizarFrase(frase), method=settings.metodoHashPassword())


def fraseCoincide(frase: str, fraseHash: str) -> bool:
    """¿`frase` corresponde a `fraseHash`? Falso con cualquier entrada vacía."""
    if not frase or not fraseHash:
        return False
    return check_password_hash(fraseHash, normalizarFrase(frase))


def fraseGuardadaCoincide(frase: str) -> bool:
    """¿`frase` es la frase de recuperación de la 2FA activa?"""
    return fraseCoincide(frase, str(_leerEstado().get("fraseHash") or ""))


# ── Retos: códigos enviados y pendientes ──────────────────────────────────────

def _archivoRetos() -> Path:
    return paths.TMP_DIR / "2fa-retos.json"


@contextmanager
def _retos():
    """Los retos pendientes, compartidos entre procesos; se guardan al salir.

    Mismo esquema que el registro de intentos de login en routes/auth.py. Los
    caducados se podan en cada acceso, así que el fichero no crece.
    """
    ruta = _archivoRetos()
    with exclusivo(ruta.with_suffix(".lock"), espera=5, obligatorio=False):
        try:
            datos = json.loads(ruta.read_text("utf-8"))
            if not isinstance(datos, dict):
                datos = {}
        except (OSError, ValueError):
            datos = {}
        antes = json.dumps(datos, sort_keys=True)
        ahora = time.time()
        for retoId in [k for k, v in datos.items() if not isinstance(v, dict) or v.get("caduca", 0) <= ahora]:
            datos.pop(retoId, None)
        # finally: comprobarCodigo y reenviar lanzan desde dentro del `with`
        # después de anotar un fallo o retirar el reto, y eso también se guarda.
        try:
            yield datos
        finally:
            if json.dumps(datos, sort_keys=True) != antes:
                escribirJsonAtomico(ruta, datos, indent=None)


def _hashCodigo(codigo: str, sal: str) -> str:
    # Solo evita dejar el código en claro en data/tmp: con un millón de
    # combinaciones no resiste un ataque offline, y no hace falta que lo haga
    # (ver el docstring del módulo).
    return hmac.new(sal.encode(), codigo.encode(), hashlib.sha256).hexdigest()


def _codigoNuevo() -> str:
    return f"{secrets.randbelow(10 ** DIGITOS_CODIGO):0{DIGITOS_CODIGO}d}"


def _textoCodigo(codigo: str, proposito: str) -> str:
    minutos = settings.codigo2faMinutos()
    if proposito == "login":
        return (f"Código de acceso a PortfolioManager: {codigo}\n"
                f"Caduca en {minutos} min. Si no has sido tú, alguien conoce tu contraseña: cámbiala.")
    if proposito == "telegram":
        return (f"Código para cambiar el bot o el chat de Telegram de PortfolioManager: {codigo}\n"
                f"Caduca en {minutos} min. Si no has sido tú, no lo compartas y cambia la contraseña.")
    accion = "activar" if proposito == "activar" else "desactivar"
    return f"Código para {accion} la verificación en dos pasos: {codigo}\nCaduca en {minutos} min."


def _armarCodigo(reto: dict) -> str:
    """Pone un código nuevo en `reto` (sin enviarlo) y devuelve el código en claro."""
    codigo = _codigoNuevo()
    ahora = time.time()
    reto["sal"] = secrets.token_hex(16)
    reto["codigoHash"] = _hashCodigo(codigo, reto["sal"])
    reto["intentos"] = 0
    reto["envios"] = int(reto.get("envios", 0)) + 1
    reto["enviado"] = ahora
    reto["caduca"] = ahora + settings.codigo2faMinutos() * 60
    return codigo


def crearReto(proposito: str, datos: dict | None = None) -> tuple[str, bool]:
    """Genera un código, lo guarda como reto pendiente y lo manda por Telegram.

    Args:
        proposito: Uno de `PROPOSITOS`.
        datos: Valores que acompañan al reto y devuelve `comprobarCodigo` (por
            ejemplo, el hash de la frase pendiente de confirmar al activar).

    Returns:
        (retoId, enviado). `enviado` es False si Telegram no está configurado
        o no aceptó el mensaje; el reto existe igualmente para que se pueda
        reenviar o usar la frase de recuperación.

    Raises:
        ValueError: Si `proposito` no es válido.
    """
    if proposito not in PROPOSITOS:
        raise ValueError(f"Propósito de reto desconocido: {proposito!r}")
    retoId = secrets.token_urlsafe(24)
    reto = {"proposito": proposito, "datos": dict(datos or {})}
    codigo = _armarCodigo(reto)
    with _retos() as retos:
        retos[retoId] = reto
    return retoId, telegram_notifier.responder(_textoCodigo(codigo, proposito))


def _retoVigente(retos: dict, retoId: str, proposito: str) -> dict:
    reto = retos.get(retoId) if retoId else None
    if not reto or reto.get("proposito") != proposito:
        raise RetoInvalido("El código ha caducado. Vuelve a empezar.")
    return reto


def reenviar(retoId: str, proposito: str) -> bool:
    """Sustituye el código del reto por uno nuevo y lo manda.

    El código anterior deja de valer y los intentos vuelven a cero.

    Returns:
        Si Telegram aceptó el mensaje.

    Raises:
        RetoInvalido: Si el reto no existe, ha caducado o ya no admite reenvíos.
        EsperaReenvio: Si aún no ha pasado `reenvio_2fa_segundos` desde el último.
    """
    with _retos() as retos:
        reto = _retoVigente(retos, retoId, proposito)
        falta = math.ceil(reto.get("enviado", 0) + settings.reenvio2faSegundos() - time.time())
        if falta > 0:
            raise EsperaReenvio(falta)
        if int(reto.get("envios", 0)) >= MAX_ENVIOS_POR_RETO:
            retos.pop(retoId, None)
            raise RetoInvalido("Se han pedido demasiados códigos. Vuelve a empezar.")
        codigo = _armarCodigo(reto)
    return telegram_notifier.responder(_textoCodigo(codigo, proposito))


def comprobarCodigo(retoId: str, proposito: str, codigo: str) -> dict:
    """Valida `codigo` contra el reto y, si es correcto, lo consume.

    Args:
        retoId: El que devolvió `crearReto`.
        proposito: El mismo con el que se creó.
        codigo: Lo que ha escrito el usuario; se ignoran espacios.

    Returns:
        Los `datos` que se guardaron con el reto.

    Raises:
        CodigoIncorrecto: Si no coincide y quedan intentos.
        RetoInvalido: Si el reto no vale o con este fallo agota los intentos.
    """
    codigo = "".join(str(codigo or "").split())
    with _retos() as retos:
        reto = _retoVigente(retos, retoId, proposito)
        correcto = (
            len(codigo) == DIGITOS_CODIGO and codigo.isdigit()
            and hmac.compare_digest(_hashCodigo(codigo, reto["sal"]), reto["codigoHash"])
        )
        if correcto:
            retos.pop(retoId, None)
            return dict(reto.get("datos") or {})
        reto["intentos"] = int(reto.get("intentos", 0)) + 1
        if reto["intentos"] >= settings.intentosCodigo2fa():
            retos.pop(retoId, None)
            raise RetoInvalido("Demasiados códigos incorrectos. Vuelve a empezar.")
    raise CodigoIncorrecto("Código incorrecto")


def datosReto(retoId: str, proposito: str) -> dict:
    """Los `datos` de un reto vigente, sin consumirlo.

    Raises:
        RetoInvalido: Si el reto no existe o ha caducado.
    """
    with _retos() as retos:
        return dict(_retoVigente(retos, retoId, proposito).get("datos") or {})


def descartarReto(retoId: str) -> None:
    """Olvida un reto (por ejemplo, al entrar con la frase de recuperación)."""
    if not retoId:
        return
    with _retos() as retos:
        retos.pop(retoId, None)


# ── Tope global de fallos ─────────────────────────────────────────────────────
# El bloqueo por IP del login no frena a quien conoce la contraseña y cambia de
# IP: cada contraseña acertada abre un reto nuevo con sus propios intentos. Este
# contador suma los fallos de código o frase de todas las IPs y, al llegar al
# tope de `[seguridad] fallos_2fa_por_hora`, suspende el segundo paso del login
# durante una ventana entera. Solo puede dispararlo quien ya tiene la
# contraseña, así que no sirve para dejar fuera al usuario desde fuera.

VENTANA_FALLOS_SEGUNDOS = 3600


def _archivoFallos() -> Path:
    return paths.TMP_DIR / "2fa-fallos.json"


@contextmanager
def _registroFallos():
    """El registro global de fallos, compartido entre procesos; se guarda al salir.

    Mismo esquema que `_retos`: fichero en data/tmp con cerrojo entre procesos.
    """
    ruta = _archivoFallos()
    with exclusivo(ruta.with_suffix(".lock"), espera=5, obligatorio=False):
        try:
            datos = json.loads(ruta.read_text("utf-8"))
            if not isinstance(datos, dict):
                datos = {}
        except (OSError, ValueError):
            datos = {}
        antes = json.dumps(datos, sort_keys=True)
        try:
            yield datos
        finally:
            if json.dumps(datos, sort_keys=True) != antes:
                escribirJsonAtomico(ruta, datos, indent=None)


def _hastaValido(datos: dict) -> float:
    hasta = datos.get("suspendidoHasta", 0)
    return float(hasta) if isinstance(hasta, (int, float)) else 0.0


def anotarFalloGlobal() -> bool:
    """Suma un fallo de código o frase al contador global de la cuenta.

    Returns:
        True solo cuando este fallo es el que activa la suspensión, para que
        quien llama avise una vez y no con cada fallo posterior.

    Raises:
        OSError: Si no se puede guardar el registro.
    """
    ahora = time.time()
    tope = settings.fallos2faPorHora()
    with _registroFallos() as datos:
        fallos = [t for t in datos.get("fallos") or [] if isinstance(t, (int, float))
                  and t > ahora - VENTANA_FALLOS_SEGUNDOS]
        fallos.append(ahora)
        if len(fallos) >= tope and _hastaValido(datos) <= ahora:
            datos["suspendidoHasta"] = ahora + VENTANA_FALLOS_SEGUNDOS
            datos["fallos"] = []
            return True
        # Acotada al tope: más entradas no cambian ninguna decisión.
        datos["fallos"] = fallos[-tope:]
    return False


def segundosSuspension() -> int:
    """Segundos que le quedan a la suspensión del segundo paso; 0 si no la hay."""
    with _registroFallos() as datos:
        return max(0, math.ceil(_hastaValido(datos) - time.time()))
