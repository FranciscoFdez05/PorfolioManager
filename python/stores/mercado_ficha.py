"""Información de mercado de un activo para la pestaña "Mercado" de la ficha.

Junta tres fuentes sin ninguna lista por activo, bolsa o divisa:

* el scanner de TradingView para el ticker del activo (cotización, rendimiento,
  técnico, fundamentales);
* si es una cripto, la fila de su moneda base en el screener `coin`
  (suministro, FDV, volumen agregado);
* si es una cripto, el perpetuo USDT de Binance (derivados).

Cada fuente que falla o no tiene el dato llega como None: la ficha enseña
"sin datos", nunca un valor inventado. Un fallo en una parte secundaria no
tumba el resto.
"""

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError, URLError

from providers import binance_futures_client, tradingview_client
from providers.http import motivoConexion

log = logging.getLogger(__name__)

# Las cifras de mercado cambian poco entre aperturas de la pestaña y cada
# apertura son hasta cuatro peticiones: unos minutos de caché evitan gastar
# cuota de los proveedores al ir y venir entre pestañas.
_CACHE_TTL = 180
_CACHE_MAX = 64

_cache: dict = {}


def _isCrypto(stats: dict) -> bool:
    """Una cripto es lo que el propio scanner clasifica como tal."""
    return stats.get("subtype") == "crypto" and bool(stats.get("base_currency"))


def _guardedCall(label: str, call):
    """Ejecuta `call` y devuelve `(resultado, error)`; un fallo de red solo
    deja sin dato esa parte de la ficha."""
    try:
        return call(), None
    except HTTPError as error:
        log.warning("%s: HTTP %s", label, error.code)
        return None, f"{label} devolvió HTTP {error.code}"
    except URLError as error:
        return None, f"No se pudo conectar con {label}: {motivoConexion(error, label)}"


def _fetchCryptoParts(base: str, timeout: float | None) -> dict:
    """Moneda y derivados en paralelo: son dos proveedores independientes."""
    with ThreadPoolExecutor(max_workers=2) as pool:
        coinFuture = pool.submit(_guardedCall, "TradingView", lambda: tradingview_client.fetchCoin(base, timeout))
        derivativesFuture = pool.submit(
            _guardedCall, "Binance", lambda: binance_futures_client.fetchDerivatives(base, timeout)
        )
        coin, coinError = coinFuture.result()
        derivatives, derivativesError = derivativesFuture.result()
    return {
        "coin": coin,
        "coinError": coinError,
        "derivatives": derivatives,
        "derivativesError": derivativesError,
    }


def _build(ticker: str, timeout: float | None) -> dict:
    stats = tradingview_client.fetchFichaStats(ticker, timeout)
    if stats is None:
        return {"ticker": ticker, "stats": None, "isCrypto": False}

    result = {"ticker": ticker, "stats": stats, "isCrypto": _isCrypto(stats)}
    if result["isCrypto"]:
        result.update(_fetchCryptoParts(stats["base_currency"], timeout))
    return result


def _evictOldest() -> None:
    if len(_cache) < _CACHE_MAX:
        return
    oldest = min(_cache, key=lambda key: _cache[key]["ts"])
    del _cache[oldest]


def fichaMercado(ticker: str, timeout: float | None = None) -> dict:
    """Datos de mercado del ticker, cacheados unos minutos.

    Args:
        ticker: Ticker con mercado ya resuelto (`NASDAQ:AAPL`).
        timeout: Segundos máximos de cada petición; None usa config.ini.

    Returns:
        `{ticker, stats, isCrypto}` y, para cripto, `coin`, `derivatives` y sus
        `coinError`/`derivativesError`. `stats` es None si el scanner no conoce
        el ticker.

    Raises:
        HTTPError, URLError: Falla la consulta principal del ticker; no se
            cachea el fallo.
    """
    now = time.time()
    entry = _cache.get(ticker)
    if entry and now - entry["ts"] < _CACHE_TTL:
        return entry["value"]

    value = _build(ticker, timeout)
    _evictOldest()
    _cache[ticker] = {"ts": now, "value": value}
    return value
