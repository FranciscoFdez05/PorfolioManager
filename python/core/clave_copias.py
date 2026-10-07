"""Contraseña propia de las claves de API en las copias de seguridad.

La copia automática no puede pedir ninguna contraseña: nadie está delante. Por eso
la contraseña no se guarda, se guarda lo que hace falta para *cifrar* con ella.

Al fijarla se deriva una clave (PBKDF2-HMAC-SHA256, 600.000 iteraciones, sal
aleatoria) y se guarda junto a la propia contraseña —para poder volver a verla en
Ajustes tras confirmar la contraseña de la web—, todo cifrado con la SECRET_KEY de
la instalación (core.secret_store, como las claves de API). Cada copia lleva las
claves cifradas con esa clave y la sal; para abrirlas, fuera de este servidor, hace
falta repetir la derivación con la contraseña. En este mismo servidor, si la sal
coincide, se abren sin preguntar.

Qué cubre y qué no: quien solo tiene el ZIP (Telegram, un disco, la nube) no puede
leer las claves sin la contraseña. Quien tenga el volumen de datos **y** la
SECRET_KEY puede cifrar y descifrar las copias de esta instalación y leer la
contraseña: úsala solo para esto y no la reutilices en otros sitios.
"""
import base64
import json
import logging
import os

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from core import paths
from core.secret_store import fernetDeSecretKey, read_secret_lines, write_secret_lines

log = logging.getLogger(__name__)

NOMBRE_FICHERO = "backup_clave.dat"
FORMATO = "pbkdf2-sha256+fernet"
ITERACIONES = 600_000
MIN_LARGO = 8
MAX_LARGO = 200
_SAL_FERNET = b"portfolio-backup-clave-v1"


class SinSecretKey(Exception):
    """No hay SECRET_KEY: la clave derivada quedaría en claro en el disco."""


def _ruta():
    return paths.DATA_DIR / NOMBRE_FICHERO


def _derivar(contrasena: str, sal: bytes, iteraciones: int = ITERACIONES) -> bytes:
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=sal, iterations=iteraciones)
    return base64.urlsafe_b64encode(kdf.derive(contrasena.encode("utf-8")))


def _leer() -> dict | None:
    """{"sal": bytes, "clave": bytes} o None si no hay o no se puede leer."""
    lineas = read_secret_lines(_ruta())
    if not lineas:
        return None
    try:
        datos = json.loads(lineas[0])
        return {
            "sal": base64.b64decode(datos["sal"]),
            "clave": datos["clave"].encode("ascii"),
            "contrasena": datos.get("contrasena"),
        }
    except (ValueError, KeyError, TypeError, AttributeError):
        log.error("[backup] %s ilegible: se ignora la contraseña de las copias", NOMBRE_FICHERO)
        return None


def configurada() -> bool:
    return _leer() is not None


def contrasena_guardada() -> str | None:
    """La contraseña fijada, o None si no hay (o se fijó antes de poder guardarla)."""
    guardada = _leer()
    texto = guardada["contrasena"] if guardada else None
    return texto if isinstance(texto, str) and texto else None


def validar(contrasena) -> str | None:
    """Mensaje de error si la contraseña no vale, o None."""
    if not isinstance(contrasena, str) or len(contrasena) < MIN_LARGO:
        return f"La contraseña debe tener al menos {MIN_LARGO} caracteres"
    if len(contrasena) > MAX_LARGO:
        return f"La contraseña no puede pasar de {MAX_LARGO} caracteres"
    return None


def fijar(contrasena: str) -> None:
    """Guarda la clave derivada de `contrasena`. Las copias anteriores no cambian."""
    if fernetDeSecretKey(_SAL_FERNET) is None:
        raise SinSecretKey()
    sal = os.urandom(16)
    linea = json.dumps({
        "sal": base64.b64encode(sal).decode("ascii"),
        "clave": _derivar(contrasena, sal).decode("ascii"),
        "contrasena": contrasena,
    })
    write_secret_lines(_ruta(), [linea])


def quitar() -> None:
    _ruta().unlink(missing_ok=True)


def cifrar(claves: dict) -> dict | None:
    """Paquete JSON con las claves cifradas, o None si no hay contraseña fijada.

    Mismo formato que el export manual con contraseña: se abre con
    `exportables.descifrarClaves(paquete, contrasena)`.
    """
    guardada = _leer()
    if guardada is None:
        return None
    datos = json.dumps(claves, ensure_ascii=False).encode("utf-8")
    return {
        "formato": FORMATO,
        "iteraciones": ITERACIONES,
        "salt": base64.b64encode(guardada["sal"]).decode("ascii"),
        "datos": Fernet(guardada["clave"]).encrypt(datos).decode("ascii"),
    }


def abrir_sin_contrasena(paquete) -> dict | None:
    """Las claves del paquete si son de la contraseña fijada en este servidor, o None."""
    guardada = _leer()
    if guardada is None or not isinstance(paquete, dict):
        return None
    try:
        if base64.b64decode(str(paquete.get("salt", ""))) != guardada["sal"]:
            return None
        claves = json.loads(Fernet(guardada["clave"]).decrypt(str(paquete.get("datos", "")).encode("ascii")))
    except (ValueError, TypeError, InvalidToken):
        return None
    return claves if isinstance(claves, dict) else None
