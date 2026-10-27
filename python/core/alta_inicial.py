"""Código de un solo uso para crear la cuenta desde la web en el primer arranque.

Sin credenciales, la aplicación no deja entrar a nadie, y la página de alta
(/setup) es pública por fuerza: aún no hay sesión. Si solo pidiese usuario y
contraseña, el primero de la LAN que la abriese se quedaría con la cuenta. El
código demuestra que quien la crea tiene acceso al servidor: se escribe en
`data/tmp/alta-inicial.txt` (en Docker, la carpeta `data/` del host, que es
donde lo lee docker-up.sh) y en el log del proceso, sitios que solo ve quien
administra la máquina.

Va en un fichero y no en memoria porque gunicorn levanta varios workers: cada
uno importa la aplicación y todos tienen que aceptar el mismo código.

Ejemplo:
    >>> codigo = obtenerCodigo()          # lo crea si aún no existe
    >>> coincide(codigo.lower())          # guiones y mayúsculas dan igual
    True
    >>> consumir()                        # tras crear la cuenta
"""

import hmac
import logging
import secrets
from pathlib import Path

from core import paths
from core.bloqueo import exclusivo
from core.escritura import escribirAtomico

logger = logging.getLogger(__name__)

# Sin 0/O ni 1/I/L: se copia a mano desde una terminal y no debe haber dudas.
# 31 símbolos x 12 posiciones, unos 59 bits; con el bloqueo por IP de /login,
# adivinarlo por fuerza bruta no es viable.
ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
LARGO = 12
GRUPO = 4

NOMBRE_FICHERO = "alta-inicial.txt"


def ruta() -> Path:
    """Fichero del código. Se lee `paths.TMP_DIR` en cada llamada: los tests lo redirigen."""
    return paths.TMP_DIR / NOMBRE_FICHERO


def cerrojo() -> Path:
    """Cerrojo entre procesos que serializa crear el código y consumirlo."""
    return ruta().with_suffix(".lock")


def normalizar(codigo: str) -> str:
    """Quita espacios y guiones y pasa a mayúsculas.

    Args:
        codigo: Lo que ha escrito el usuario.

    Returns:
        El código en la forma en que se guarda, sin separadores.
    """
    if not isinstance(codigo, str):
        return ""
    return "".join(c for c in codigo.upper() if c not in " -\t")


def formatear(codigo: str) -> str:
    """Agrupa el código de cuatro en cuatro para que se lea mejor (`ABCD-EFGH-JKMN`)."""
    limpio = normalizar(codigo)
    return "-".join(limpio[i:i + GRUPO] for i in range(0, len(limpio), GRUPO))


def _leer() -> str:
    try:
        return normalizar(ruta().read_text("utf-8").strip())
    except FileNotFoundError:
        return ""


def _generar() -> str:
    return "".join(secrets.choice(ALFABETO) for _ in range(LARGO))


def obtenerCodigo() -> str:
    """Devuelve el código vigente, creándolo si aún no existe.

    Lo llaman a la vez todos los workers al arrancar; el cerrojo hace que solo
    uno lo cree y los demás lean ese mismo.

    Returns:
        El código formateado en grupos.

    Raises:
        OSError: Si no se puede escribir en `data/tmp`.
    """
    with exclusivo(cerrojo(), espera=5, obligatorio=False):
        codigo = _leer()
        if len(codigo) != LARGO:
            codigo = _generar()
            # 0600: en Docker el fichero es del usuario del host (PUID), así que
            # lo puede leer quien lanzó docker-up.sh y nadie más.
            escribirAtomico(ruta(), formatear(codigo) + "\n", permisos=0o600)
    return formatear(codigo)


def coincide(codigo: str) -> bool:
    """Indica si `codigo` es el vigente. Sin código guardado, nunca coincide.

    Args:
        codigo: Lo que ha escrito el usuario, con o sin guiones.

    Returns:
        True si coincide con el guardado.
    """
    guardado = _leer()
    if not guardado:
        return False
    return hmac.compare_digest(normalizar(codigo).encode("utf-8"), guardado.encode("utf-8"))


def consumir() -> None:
    """Borra el código una vez creada la cuenta: no debe servir para una segunda."""
    try:
        ruta().unlink()
    except FileNotFoundError:
        pass
    except OSError as error:
        # La cuenta ya existe y /setup deja de atender aunque el fichero siga
        # ahí, así que no es motivo para fallar el alta; solo se avisa.
        logger.warning("No se pudo borrar %s: %s", ruta(), error)


__all__ = ["cerrojo", "coincide", "consumir", "formatear", "normalizar", "obtenerCodigo", "ruta"]
