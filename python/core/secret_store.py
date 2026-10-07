"""Cifrado en reposo de las claves de API (API/*.key).

Las claves se guardaban en texto plano. Cualquier lectura del volumen de datos
—una copia de seguridad mal protegida, un backup del host, un fallo de permisos—
las exponía directamente. Se cifran con la misma derivación que data/auth.dat:
Fernet sobre una clave PBKDF2-HMAC-SHA256 derivada de SECRET_KEY.

Compatible hacia atrás: un fichero en texto plano se lee igual y se migra a
formato cifrado en la siguiente escritura, así que no hace falta reconfigurar
nada al actualizar.
"""
import base64
import functools
import logging
import os
import tempfile
from pathlib import Path

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

log = logging.getLogger(__name__)

# Prefijo que marca un fichero ya cifrado
_ENCRYPTED_PREFIX = b"ENC1:"
# Salt distinto al de auth.dat: claves derivadas independientes por propósito
_SALT = b"portfolio-apikeys-v1"


# Iteraciones de PBKDF2 para las claves derivadas de SECRET_KEY. Cambiarlas deja
# ilegibles auth.dat y API/*.key ya guardados: no es un ajuste.
_ITERACIONES_SECRET_KEY = 200_000


def fernetDerivado(secreto: bytes, salt: bytes, iteraciones: int) -> Fernet:
    """Fernet con una clave PBKDF2-HMAC-SHA256 derivada de `secreto`.

    Es la única derivación del proyecto: había tres copias (aquí, en
    routes/auth.py y en core/exportables.py) que tenían que coincidir byte a
    byte para que los ficheros ya cifrados siguieran abriéndose.
    """
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=iteraciones)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(secreto)))


@functools.lru_cache(maxsize=8)
def _fernetCacheado(secreto: bytes, salt: bytes) -> Fernet:
    return fernetDerivado(secreto, salt, _ITERACIONES_SECRET_KEY)


def fernetDeSecretKey(salt: bytes) -> Fernet | None:
    """Fernet derivado de SECRET_KEY para un propósito (`salt`), o None sin clave.

    Se cachea por (clave, salt): antes cada lectura de un secreto repetía las
    200.000 iteraciones, y se leen varios en cada carga de Ajustes y en cada
    petición del Atajo. Si SECRET_KEY cambia, cambia la entrada de la caché.
    """
    secreto = os.environ.get("SECRET_KEY", "").strip().encode()
    if not secreto:
        return None
    return _fernetCacheado(secreto, salt)


def _get_fernet() -> Fernet | None:
    return fernetDeSecretKey(_SALT)


def read_secret_lines(path: Path) -> list:
    """Devuelve las líneas útiles del fichero, descifrando si hace falta."""
    if not path.exists():
        return []
    try:
        raw = path.read_bytes()
    except OSError as e:
        log.error("No se pudo leer %s: %s", path.name, e)
        return []

    if raw.startswith(_ENCRYPTED_PREFIX):
        fernet = _get_fernet()
        if fernet is None:
            log.error(
                "%s está cifrado pero SECRET_KEY no está definida: no se pueden "
                "leer las claves de API.", path.name
            )
            return []
        try:
            raw = fernet.decrypt(raw[len(_ENCRYPTED_PREFIX):])
        except InvalidToken:
            log.error(
                "No se pudo descifrar %s. ¿Ha cambiado SECRET_KEY desde que se "
                "guardaron las claves?", path.name
            )
            return []

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        log.error("Contenido ilegible en %s", path.name)
        return []

    return [line.strip() for line in text.splitlines()
            if line.strip() and not line.strip().startswith("#")]


def write_secret_lines(path: Path, lines) -> None:
    """Escribe las líneas cifradas de forma atómica (tmp → fsync → rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = ("\n".join(str(line).strip() for line in lines if str(line).strip()) + "\n").encode("utf-8")

    fernet = _get_fernet()
    if fernet is not None:
        payload = _ENCRYPTED_PREFIX + fernet.encrypt(payload)
    else:
        log.warning(
            "SECRET_KEY no definida: %s se guardará en texto plano. Define "
            "SECRET_KEY en .env para cifrar las claves de API.", path.name
        )

    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp_name, str(path))
        try:
            os.chmod(str(path), 0o600)
        except OSError:
            pass  # sistemas de ficheros sin permisos POSIX (p. ej. Windows)
    except Exception:
        Path(tmp_name).unlink(missing_ok=True)
        raise


def migrate_plaintext_if_needed(path: Path) -> bool:
    """Reescribe cifrado un fichero que aún esté en texto plano."""
    if not path.exists() or _get_fernet() is None:
        return False
    try:
        if path.read_bytes().startswith(_ENCRYPTED_PREFIX):
            return False
    except OSError:
        return False
    lines = read_secret_lines(path)
    if not lines:
        return False
    write_secret_lines(path, lines)
    log.info("%s migrado a formato cifrado", path.name)
    return True
