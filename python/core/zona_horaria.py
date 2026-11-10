"""Zona horaria del proceso cuando se arranca en Windows.

`.env` trae `TZ=Europe/Madrid` para el contenedor, donde Linux entiende el
nombre IANA. En Windows la librería de C solo entiende `TZ` en formato POSIX
("CET-1CEST"): con un nombre IANA lo lee como un desfase de cero y todo el
proceso pasa a UTC sin avisar. «Hoy» empezaba entonces a la 01:00 hora local y
los minigráficos del día perdían los puntos de esa primera hora (o de dos en
verano). Windows ya usa la zona del sistema, así que ahí ese `TZ` sobra.
"""

import logging
import os
import sys

log = logging.getLogger(__name__)


def descartarTzIanaEnWindows(entorno=os.environ, plataforma: str = sys.platform) -> bool:
    """Quita `TZ` del entorno si es un nombre IANA y el proceso corre en Windows.

    Hay que llamarla justo después de `load_dotenv()`, antes de que nada pida
    la hora local.

    Args:
        entorno: Variables de entorno del proceso; inyectable para los tests.
        plataforma: Valor de `sys.platform`; inyectable para los tests.

    Returns:
        True si se ha quitado.
    """
    valor = entorno.get("TZ", "")
    # Los nombres IANA llevan región y ciudad ("Europe/Madrid"); el formato
    # POSIX que sí entiende Windows ("CET-1CEST") no lleva barra.
    if not plataforma.startswith("win") or "/" not in valor:
        return False
    del entorno["TZ"]
    log.debug("TZ=%s ignorada en Windows: se usa la zona horaria del sistema", valor)
    return True
