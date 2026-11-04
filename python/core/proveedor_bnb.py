"""Qué API lee las wallets de BNB Smart Chain, elegida en Ajustes > API.

El plan gratuito de Etherscan no incluye BNB Smart Chain, así que hace falta
poder elegir otra API sin perder Etherscan para Ethereum.

Se guarda en `ajustes.json` (`bnbProveedor`) y se lee del fichero en cada
consulta, con caché por fecha de modificación: lo escribe un worker de gunicorn
y lo tienen que ver todos.
"""

import json

from core import paths

ETHERSCAN = "etherscan"
NODEREAL = "nodereal"

# Nombre visible de cada API que se puede elegir, en el orden del selector.
OPCIONES = {ETHERSCAN: "Etherscan", NODEREAL: "NodeReal"}

# Etherscan sigue siendo el valor por defecto para no cambiar nada a quien ya
# tiene un plan de pago que cubre BNB.
POR_DEFECTO = ETHERSCAN

_cache: dict = {"mtime": None, "id": POR_DEFECTO}


def actual() -> str:
    """El id de la API que lee ahora las wallets de BNB.

    Returns:
        Una de las claves de `OPCIONES`; `POR_DEFECTO` si no hay nada guardado o
        lo guardado no se entiende.
    """
    try:
        mtime = paths.AJUSTES_JSON.stat().st_mtime_ns
    except OSError:
        return POR_DEFECTO
    if _cache["mtime"] == mtime:
        return _cache["id"]
    try:
        datos = json.loads(paths.AJUSTES_JSON.read_text("utf-8"))
    except (OSError, ValueError):
        return POR_DEFECTO
    guardado = datos.get("bnbProveedor") if isinstance(datos, dict) else None
    idProveedor = guardado if guardado in OPCIONES else POR_DEFECTO
    _cache["mtime"], _cache["id"] = mtime, idProveedor
    return idProveedor
