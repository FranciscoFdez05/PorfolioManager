"""Cliente de los futuros perpetuos de Binance (API pública, sin clave).

Da la parte de derivados de la pestaña "Mercado" de la ficha: interés abierto,
tasa de financiación y base del perpetuo frente al índice. El mercado de
referencia es el perpetuo `<MONEDA>USDT`; si Binance no tiene ese contrato
(monedas pequeñas, o con prefijo de múltiplo como 1000PEPE) se devuelve None y
la ficha dice "sin derivados", no se adivina otro símbolo.
"""

import logging
import re
from urllib.error import HTTPError

from providers.http import fetchJson

log = logging.getLogger(__name__)

BINANCE_FUTURES_URL = "https://fapi.binance.com/fapi/v1"

# La moneda base entra en la query string: se acota a lo que puede ser un
# símbolo de Binance para no reenviar texto arbitrario al proveedor.
_BASE_RE = re.compile(r"^[A-Z0-9]{1,20}$")

# Código con el que Binance rechaza un símbolo sin contrato (-1121).
_INVALID_SYMBOL_STATUS = 400


def _fetch(path: str, symbol: str, timeout: float | None) -> dict:
    return fetchJson(f"{BINANCE_FUTURES_URL}/{path}", {"symbol": symbol}, timeout=timeout, provider="Binance")


def _toFloat(value) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def fetchDerivatives(baseCurrency: str, timeout: float | None = None) -> dict | None:
    """Datos del perpetuo `<baseCurrency>USDT` de Binance.

    Args:
        baseCurrency: Moneda base (`BTC`), tal cual la publica el scanner.
        timeout: Segundos máximos de cada petición; None usa config.ini.

    Returns:
        `{symbol, markPrice, indexPrice, basisPct, fundingRate, nextFundingTime,
        openInterest, openInterestUsd, volume24hUsd}` (tiempos en ms Unix, tasa
        y base en fracción/porcentaje tal cual), o None si Binance no tiene el
        contrato.

    Raises:
        HTTPError, URLError: Fallo del proveedor distinto de "símbolo inexistente"
            (p. ej. 451 por región); quien llama decide qué enseñar.
    """
    base = str(baseCurrency or "").strip().upper()
    if not _BASE_RE.match(base):
        return None
    symbol = f"{base}USDT"

    try:
        premium = _fetch("premiumIndex", symbol, timeout)
    except HTTPError as error:
        if error.code == _INVALID_SYMBOL_STATUS:
            log.info("Binance no tiene perpetuo para %s", symbol)
            return None
        raise

    openInterest = _fetch("openInterest", symbol, timeout)
    ticker = _fetch("ticker/24hr", symbol, timeout)

    markPrice = _toFloat(premium.get("markPrice"))
    indexPrice = _toFloat(premium.get("indexPrice"))
    contracts = _toFloat(openInterest.get("openInterest"))
    basisPct = None
    if markPrice is not None and indexPrice:
        basisPct = (markPrice / indexPrice - 1) * 100

    return {
        "symbol": symbol,
        "markPrice": markPrice,
        "indexPrice": indexPrice,
        "basisPct": basisPct,
        "fundingRate": _toFloat(premium.get("lastFundingRate")),
        "nextFundingTime": premium.get("nextFundingTime"),
        "openInterest": contracts,
        # El interés abierto llega en unidades de la moneda: se valora al precio
        # de marca para compararlo con la capitalización.
        "openInterestUsd": contracts * markPrice if contracts is not None and markPrice is not None else None,
        "volume24hUsd": _toFloat(ticker.get("quoteVolume")),
    }
