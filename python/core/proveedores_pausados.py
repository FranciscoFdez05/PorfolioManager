"""Proveedores de cotizaciones que el usuario ha pausado desde Ajustes > API.

Pausar un proveedor lo saca de la cadena de cotización (`stores.market_data`) y
del sondeo de estado (`providers.estado`): ni se le piden precios ni se gasta
cuota comprobando si responde. Sirve para un proveedor que da guerra (cuota
agotada, claves caducadas, ruido de avisos) sin tener que borrar sus claves.

Se guarda en `ajustes.json` (`apisPausadas`, lista de ids) y se lee del fichero
en cada consulta, con caché por fecha de modificación: lo escribe un worker de
gunicorn y lo tienen que ver todos.
"""

import json

from core import paths

# Los que despachan cotizaciones. "divisas" no está: pausarlo rompería todas las
# conversiones de moneda, no solo el precio de un activo.
PAUSABLES = ("finnhub", "eodhd", "alphavantage", "yahoo", "tradingview")

_cache: dict = {"mtime": None, "ids": frozenset()}


def pausados() -> frozenset:
    """Ids de los proveedores pausados ahora mismo."""
    try:
        mtime = paths.AJUSTES_JSON.stat().st_mtime_ns
    except OSError:
        return frozenset()
    if _cache["mtime"] == mtime:
        return _cache["ids"]
    try:
        datos = json.loads(paths.AJUSTES_JSON.read_text("utf-8"))
        lista = datos.get("apisPausadas") if isinstance(datos, dict) else None
    except (OSError, ValueError):
        return frozenset()
    ids = frozenset(p for p in (lista if isinstance(lista, list) else []) if p in PAUSABLES)
    _cache["mtime"], _cache["ids"] = mtime, ids
    return ids


def esta_pausado(proveedor: str) -> bool:
    return proveedor in pausados()
