"""Carpeta de las wallets enlazadas de cada portfolio.

Las wallets, su libreta, las carteras conocidas y las lecturas guardadas son de
cada portfolio: una wallet de seguimiento de un portfolio no debe verse ni
vigilarse desde otro. Viven en `API/portfolios/<id>/`, y el portfolio sale de la
BD activa del hilo (`core.db.getActiveDbPath`), así que `useDbPath` también las
redirige: la vigilancia en segundo plano recorre los portfolios con él.

Lo que es de la instalación y no de un portfolio (claves de API, estado de la
vigilancia de Satoshi) sigue directamente en `API/`.
"""

import logging
import re
from pathlib import Path

from core import db, paths

log = logging.getLogger(__name__)

NOMBRE_SUBCARPETA = "portfolios"
# Mismo patrón que `portfolios_manager._portfolioDbPath`: el id acaba en una ruta.
_PATRON_ID = re.compile(r"[a-z0-9_-]{1,64}")
# Lo que había en API/ antes de separar por portfolio. Los dos ficheros de
# bloqueo se mueven con ellos para no dejar cerrojos huérfanos.
_ANTIGUOS = (
    "wallets.key",
    "wallets_ajenas.json",
    "carteras.key",
    "wallets_lecturas",
    ".wallets.key.lock",
    ".carteras.key.lock",
)


def carpetaWalletsDe(idPortfolio: str) -> Path:
    """Carpeta de las wallets de un portfolio.

    Args:
        idPortfolio: Id del portfolio.

    Returns:
        `API/portfolios/<id>`, sin crearla.

    Raises:
        ValueError: si el id no tiene la forma de un id de portfolio.
    """
    if not _PATRON_ID.fullmatch(idPortfolio or ""):
        raise ValueError(f"Id de portfolio no válido: {idPortfolio!r}")
    return paths.API_DIR / NOMBRE_SUBCARPETA / idPortfolio


def carpetaWalletsActiva() -> Path:
    """Carpeta de las wallets del portfolio de la BD activa de este hilo."""
    return carpetaWalletsDe(db.getActiveDbPath().stem)


def migrarWalletsAlPortfolio(idPortfolio: str) -> list[str]:
    """Mueve las wallets globales de antes a la carpeta de un portfolio.

    Es idempotente y tolera dos workers a la vez: lo que ya no está en `API/`
    (porque el otro lo movió) se salta, y nada pisa lo que ya hay en destino.

    Args:
        idPortfolio: Portfolio que se queda con las wallets que había.

    Returns:
        Los nombres de lo movido.
    """
    destino = carpetaWalletsDe(idPortfolio)
    movidos = []
    for nombre in _ANTIGUOS:
        origen = paths.API_DIR / nombre
        if not origen.exists() or (destino / nombre).exists():
            continue
        try:
            destino.mkdir(parents=True, exist_ok=True)
            origen.replace(destino / nombre)
        except FileNotFoundError:
            continue
        except OSError as error:
            log.error("[wallets] No se pudo mover %s a %s: %s", nombre, destino, error)
            continue
        movidos.append(nombre)
    if movidos:
        log.info("[wallets] Wallets de antes asignadas al portfolio '%s': %s", idPortfolio, ", ".join(movidos))
    return movidos


def idsDePortfolios() -> list[str]:
    """Ids de todos los portfolios conocidos.

    Returns:
        Los ids del índice de portfolios; vacío si el índice aún no existe.
    """
    # Sin inicializar: lo llaman las copias de seguridad, que no deben activar
    # portfolios ni lanzar la copia de arranque.
    from admin.portfolios_manager import leerIndice

    return [p["id"] for p in (leerIndice() or {}).get("portfolios", []) if _PATRON_ID.fullmatch(p.get("id", ""))]
