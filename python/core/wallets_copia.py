"""Las wallets dentro del paquete cifrado de las copias de seguridad y las exportaciones.

Van en el mismo paquete que las claves de API (`core.exportables`), con su misma
contraseña: wallets propias y ajenas, libreta, marcas y tokens, el catálogo del
usuario y el estado de la vigilancia de Satoshi. Salen en claro de `API/` y, al
restaurar, se vuelven a cifrar con la SECRET_KEY de esta instalación: es lo que
permite recuperarlas en un servidor recién montado.

Cada parte se vuelca y se restaura por separado: un `wallets.key` de otra
SECRET_KEY no debe dejar sin copia a lo demás, ni tumbar una restauración que
ya ha recuperado los portfolios. Lo que falla queda en el log y no sale en la
lista de lo restaurado.
"""

import logging
from dataclasses import asdict
from pathlib import Path

from core import paths
from core.satoshi_vigilancia import NOMBRE_ESTADO, SatoshiEstadoRepository
from stores.carteras_conocidas_store import NOMBRE_FICHERO as NOMBRE_CARTERAS, CarterasUsuarioRepository
from stores.wallets_store import NOMBRE_FICHERO, NOMBRE_FICHERO_AJENAS, WalletError, WalletsRepository

log = logging.getLogger(__name__)

# Clave dentro del paquete. Las versiones anteriores la ignoran, como a cualquier
# proveedor de claves que no conocen.
CLAVE_PAQUETE = "walletsSeguimiento"
_PARTE_WALLETS = "wallets"
_PARTE_CARTERAS = "carteras"
_PARTE_SATOSHI = "satoshi"


def ficherosGuardados() -> list[Path]:
    """Los ficheros de `API/` que una restauración puede sustituir, los que existan."""
    nombres = (NOMBRE_FICHERO, NOMBRE_FICHERO_AJENAS, NOMBRE_CARTERAS, NOMBRE_ESTADO)
    return [ruta for ruta in (paths.API_DIR / nombre for nombre in nombres) if ruta.exists()]


def volcar(
    repositorio: WalletsRepository | None = None,
    carteras: CarterasUsuarioRepository | None = None,
    satoshi: SatoshiEstadoRepository | None = None,
) -> dict:
    """Lo que hay guardado, por partes; sin las vacías ni las que no se pueden leer.

    Args:
        repositorio: Almacén de wallets.
        carteras: Catálogo del usuario.
        satoshi: Estado de la vigilancia de Satoshi.

    Returns:
        `{parte: contenido}`, vacío si no hay nada que copiar.
    """
    partes = {}
    try:
        wallets = (repositorio or WalletsRepository()).volcado()
        if any(wallets.get(clave) for clave in wallets if clave != "version"):
            partes[_PARTE_WALLETS] = wallets
    except WalletError as error:
        log.error("[wallets] Las wallets no entran en esta copia: %s", error)
    try:
        catalogo = (carteras or CarterasUsuarioRepository()).volcado()
        if catalogo:
            partes[_PARTE_CARTERAS] = catalogo
    except WalletError as error:
        log.error("[wallets] El catálogo de carteras no entra en esta copia: %s", error)
    repositorioSatoshi = satoshi or SatoshiEstadoRepository()
    if repositorioSatoshi.ruta.exists():
        partes[_PARTE_SATOSHI] = asdict(repositorioSatoshi.leer())
    return partes


def restaurar(
    partes,
    repositorio: WalletsRepository | None = None,
    carteras: CarterasUsuarioRepository | None = None,
    satoshi: SatoshiEstadoRepository | None = None,
) -> list[str]:
    """Sustituye lo guardado por lo del paquete, parte a parte.

    Args:
        partes: Resultado de `volcar`, leído de un ZIP: no se da por bueno.
        repositorio: Almacén de wallets.
        carteras: Catálogo del usuario.
        satoshi: Estado de la vigilancia de Satoshi.

    Returns:
        Las partes restauradas, para decirlo en la respuesta.
    """
    if not isinstance(partes, dict):
        log.warning("[wallets] La copia trae las wallets con una forma desconocida: se ignoran")
        return []
    restauradas = []
    if isinstance(partes.get(_PARTE_WALLETS), dict):
        try:
            (repositorio or WalletsRepository()).restaurarVolcado(partes[_PARTE_WALLETS])
            restauradas.append(NOMBRE_FICHERO)
        except WalletError as error:
            log.error("[wallets] No se han podido restaurar las wallets: %s", error)
    if _PARTE_CARTERAS in partes:
        try:
            (carteras or CarterasUsuarioRepository()).restaurarVolcado(partes[_PARTE_CARTERAS])
            restauradas.append(NOMBRE_CARTERAS)
        except WalletError as error:
            log.error("[wallets] No se ha podido restaurar el catálogo de carteras: %s", error)
    if _PARTE_SATOSHI in partes:
        try:
            (satoshi or SatoshiEstadoRepository()).restaurar(partes[_PARTE_SATOSHI])
            restauradas.append(NOMBRE_ESTADO)
        except (ValueError, TypeError, OSError) as error:
            log.error("[wallets] No se ha podido restaurar la vigilancia de Satoshi: %s", error)
    return restauradas
