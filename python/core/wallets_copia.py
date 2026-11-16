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
from core.wallets_carpeta import carpetaWalletsDe, idsDePortfolios
from stores.carteras_conocidas_store import NOMBRE_FICHERO as NOMBRE_CARTERAS, CarterasUsuarioRepository
from stores.wallets_store import NOMBRE_FICHERO, NOMBRE_FICHERO_AJENAS, WalletError, WalletsRepository

log = logging.getLogger(__name__)

# Clave dentro del paquete. Las versiones anteriores la ignoran, como a cualquier
# proveedor de claves que no conocen.
CLAVE_PAQUETE = "walletsSeguimiento"
_PARTE_WALLETS = "wallets"
_PARTE_CARTERAS = "carteras"
_PARTE_SATOSHI = "satoshi"
_PARTE_PORTFOLIOS = "porPortfolio"


def _repositoriosDe(idPortfolio: str) -> tuple[WalletsRepository, CarterasUsuarioRepository]:
    """Los almacenes de wallets y carteras de un portfolio, estén o no activos."""
    carpeta = carpetaWalletsDe(idPortfolio)
    return (WalletsRepository(ruta=carpeta / NOMBRE_FICHERO),
            CarterasUsuarioRepository(ruta=carpeta / NOMBRE_CARTERAS))


def ficherosGuardados() -> list[Path]:
    """Los ficheros de `API/` que una restauración puede sustituir, los que existan."""
    candidatos = [paths.API_DIR / NOMBRE_ESTADO]
    for idPortfolio in idsDePortfolios():
        carpeta = carpetaWalletsDe(idPortfolio)
        candidatos += [carpeta / nombre for nombre in (NOMBRE_FICHERO, NOMBRE_FICHERO_AJENAS, NOMBRE_CARTERAS)]
    return [ruta for ruta in candidatos if ruta.exists()]


def _volcarPortfolio(repositorio: WalletsRepository, carteras: CarterasUsuarioRepository) -> dict:
    """Wallets y catálogo de un portfolio; sin las partes vacías ni las que no se pueden leer."""
    partes = {}
    try:
        wallets = repositorio.volcado()
        if any(wallets.get(clave) for clave in wallets if clave != "version"):
            partes[_PARTE_WALLETS] = wallets
    except WalletError as error:
        log.error("[wallets] Las wallets no entran en esta copia: %s", error)
    try:
        catalogo = carteras.volcado()
        if catalogo:
            partes[_PARTE_CARTERAS] = catalogo
    except WalletError as error:
        log.error("[wallets] El catálogo de carteras no entra en esta copia: %s", error)
    return partes


def volcar(
    repositorio: WalletsRepository | None = None,
    carteras: CarterasUsuarioRepository | None = None,
    satoshi: SatoshiEstadoRepository | None = None,
) -> dict:
    """Lo que hay guardado, por partes; sin las vacías ni las que no se pueden leer.

    Sin `repositorio` ni `carteras` se vuelcan los de todos los portfolios, cada
    uno bajo su id en `porPortfolio`.

    Args:
        repositorio: Almacén de wallets de un solo portfolio.
        carteras: Catálogo del usuario de un solo portfolio.
        satoshi: Estado de la vigilancia de Satoshi.

    Returns:
        `{parte: contenido}`, vacío si no hay nada que copiar.
    """
    partes = {}
    if repositorio is not None or carteras is not None:
        partes.update(_volcarPortfolio(repositorio or WalletsRepository(), carteras or CarterasUsuarioRepository()))
    else:
        porPortfolio = {}
        for idPortfolio in idsDePortfolios():
            contenido = _volcarPortfolio(*_repositoriosDe(idPortfolio))
            if contenido:
                porPortfolio[idPortfolio] = contenido
        if porPortfolio:
            partes[_PARTE_PORTFOLIOS] = porPortfolio
    repositorioSatoshi = satoshi or SatoshiEstadoRepository()
    if repositorioSatoshi.ruta.exists():
        partes[_PARTE_SATOSHI] = asdict(repositorioSatoshi.leer())
    return partes


def _restaurarPortfolio(partes: dict, repositorio: WalletsRepository, carteras: CarterasUsuarioRepository) -> list[str]:
    """Restaura las wallets y el catálogo de un portfolio; lo que falla queda en el log."""
    restauradas = []
    if isinstance(partes.get(_PARTE_WALLETS), dict):
        try:
            repositorio.restaurarVolcado(partes[_PARTE_WALLETS])
            restauradas.append(NOMBRE_FICHERO)
        except WalletError as error:
            log.error("[wallets] No se han podido restaurar las wallets: %s", error)
    if _PARTE_CARTERAS in partes:
        try:
            carteras.restaurarVolcado(partes[_PARTE_CARTERAS])
            restauradas.append(NOMBRE_CARTERAS)
        except WalletError as error:
            log.error("[wallets] No se ha podido restaurar el catálogo de carteras: %s", error)
    return restauradas


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
    # Una copia de antes de separar por portfolio trae sus partes sueltas: van al activo.
    sueltas = {clave: partes[clave] for clave in (_PARTE_WALLETS, _PARTE_CARTERAS) if clave in partes}
    if sueltas:
        restauradas += _restaurarPortfolio(sueltas, repositorio or WalletsRepository(),
                                           carteras or CarterasUsuarioRepository())
    porPortfolio = partes.get(_PARTE_PORTFOLIOS)
    if isinstance(porPortfolio, dict):
        for idPortfolio, contenido in porPortfolio.items():
            if not isinstance(contenido, dict):
                continue
            try:
                repos = _repositoriosDe(idPortfolio)
            except ValueError as error:
                log.error("[wallets] Wallets de un portfolio con id no válido, se ignoran: %s", error)
                continue
            restauradas += [nombre for nombre in _restaurarPortfolio(contenido, *repos) if nombre not in restauradas]
    if _PARTE_SATOSHI in partes:
        try:
            (satoshi or SatoshiEstadoRepository()).restaurar(partes[_PARTE_SATOSHI])
            restauradas.append(NOMBRE_ESTADO)
        except (ValueError, TypeError, OSError) as error:
            log.error("[wallets] No se ha podido restaurar la vigilancia de Satoshi: %s", error)
    return restauradas
