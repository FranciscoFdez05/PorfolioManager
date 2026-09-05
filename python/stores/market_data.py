"""Punto único para pedir la cotización de un activo.

El despacho por proveedor (qué cliente llama, con qué clave y con qué respaldo)
vivía dentro de la vista `/api/market/quote`. El snapshot del servidor necesita
exactamente lo mismo sin pasar por HTTP, y copiar el `if provider ==` en dos
sitios significaba que añadir un proveedor arreglaba la pantalla y dejaba el
histórico valorando con precios viejos.
"""

from providers.alpha_vantage_client import fetch_quote as _fetch_av_quote
from providers.eodhd_client import fetch_quote as _fetch_eodhd_quote
from providers.finnhub_client import fetch_quote as _fetch_finnhub_quote
from providers.yahoo_finance_client import fetch_quote as _fetch_yahoo_quote
from stores.asset_utils import inferMarketProviderFromSymbol, normalizeMarketProvider
from stores.helpers import (
    call_alpha_vantage_with_fallbacks,
    call_eodhd_with_fallbacks,
    call_finnhub_with_fallbacks,
)


def fetch_asset_quote(symbol, provider=None):
    """Cotización de un símbolo. Devuelve `(quote, error)` como los clientes."""
    symbol = str(symbol or "").strip().upper()
    if not symbol:
        return None, "symbol requerido"

    proveedor = normalizeMarketProvider(
        str(provider or "").strip(), fallback=inferMarketProviderFromSymbol(symbol)
    )

    if proveedor == "eodhd":
        return call_eodhd_with_fallbacks(lambda apiKey: _fetch_eodhd_quote(symbol, apiKey))
    if proveedor == "yahoo":
        return _fetch_yahoo_quote(symbol)
    if proveedor == "alphavantage":
        return call_alpha_vantage_with_fallbacks(lambda apiKey: _fetch_av_quote(symbol, apiKey))

    return call_finnhub_with_fallbacks(lambda apiKey: _fetch_finnhub_quote(symbol, apiKey))
