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


def _get_fernet() -> Fernet | None:
    secret = os.environ.get("SECRET_KEY", "").strip().encode()
    if not secret:
        return None
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=_SALT, iterations=200_000)
    return Fernet(base64.urlsafe_b64encode(kdf.derive(secret)))


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
    payload = ("\n".join(str(l).strip() for l in lines if str(l).strip()) + "\n").encode("utf-8")

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
