"""Punto único para pedir la cotización de un activo.

El despacho por proveedor (qué cliente llama, con qué clave y con qué respaldo)
vivía dentro de la vista `/api/market/quote`. El snapshot del servidor necesita
exactamente lo mismo sin pasar por HTTP, y copiar el `if provider ==` en dos
sitios significaba que añadir un proveedor arreglaba la pantalla y dejaba el
histórico valorando con precios viejos.

Dos cosas más viven aquí, ambas para gastar menos cuota gratuita:

* **Caché en memoria** (`cotizacion_ttl_segundos`): dashboard, cartera y el
  gráfico piden el mismo activo casi a la vez; la segunda y tercera petición
  reutilizan la primera respuesta en vez de volver a llamar al proveedor.
* **Respaldo entre proveedores distintos**, no solo entre claves del mismo
  proveedor (eso ya lo hacía `helpers.call_*_with_fallbacks`). Solo se prueba
  con símbolos "portables" -los que no llevan la sintaxis de un proveedor
  concreto-, porque el ticker de EODHD para una bolsa europea (`SAP.XETRA`) no
  significa nada para Finnhub, y al revés.
"""

import time
from threading import Lock

from core import settings, telegram_notifier
from providers.alpha_vantage_client import fetch_quote as _fetch_av_quote
from providers.eodhd_client import fetch_quote as _fetch_eodhd_quote
from providers.finnhub_client import convert_quote_currency, fetch_quote as _fetch_finnhub_quote
from providers.tradingview_client import fetch_quote as _fetch_tradingview_quote
from providers.yahoo_finance_client import fetch_quote as _fetch_yahoo_quote
from stores.asset_utils import EODHD_EXCHANGE_CODES, inferMarketProviderFromSymbol, normalizeMarketProvider
from stores.helpers import (
    call_alpha_vantage_with_fallbacks,
    call_eodhd_with_fallbacks,
    call_finnhub_with_fallbacks,
    is_rate_limited_error,
    is_temporary_service_error,
)

_FETCHERS = {
    "eodhd": lambda symbol: call_eodhd_with_fallbacks(lambda apiKey: _fetch_eodhd_quote(symbol, apiKey)),
    "yahoo": lambda symbol: _fetch_yahoo_quote(symbol),
    "alphavantage": lambda symbol: call_alpha_vantage_with_fallbacks(lambda apiKey: _fetch_av_quote(symbol, apiKey)),
    "finnhub": lambda symbol: call_finnhub_with_fallbacks(lambda apiKey: _fetch_finnhub_quote(symbol, apiKey)),
    "tradingview": lambda symbol: _fetch_tradingview_quote(symbol),
}

# Orden de respaldo para un símbolo portable. TradingView va detrás de Yahoo
# porque, igual que Yahoo, no lleva clave ni cuota documentada -es el scanner
# público de tradingview.com, no una API soportada-, así que se prueba antes
# que los proveedores con clave propia pero después del que ya lleva más
# tiempo probado en este dispatcher. Alpha Vantage va el último a propósito:
# su plan gratuito da 25 peticiones AL DÍA, la cuota más corta de las cinco,
# así que es el que menos conviene gastar de rebote.
_FALLBACK_ORDER = ("finnhub", "yahoo", "tradingview", "eodhd", "alphavantage")

# Cuánto se evita un proveedor tras un 429/cuota agotada, para no perder una
# petición del usuario intentando algo que ya sabemos que va a fallar.
_RATE_LIMIT_COOLDOWN_SECONDS = 300

# Nombre visible de cada proveedor para los avisos de Telegram (ver
# core.telegram_notifier). Es el mismo criterio que providers/estado.py, pero
# no se reutiliza ese diccionario: ahí las claves incluyen "divisas", que no
# despacha cotizaciones aquí.
_NOMBRE_PROVEEDOR = {
    "eodhd": "EODHD",
    "yahoo": "Yahoo Finance",
    "alphavantage": "Alpha Vantage",
    "finnhub": "Finnhub",
    "tradingview": "TradingView",
}

_state_lock = Lock()
_quote_cache: dict = {}          # f"{proveedor}:{symbol}" -> {"quote":, "ts":}
_provider_resting_until: dict = {}  # proveedor -> time.monotonic() hasta el que evitarlo


def _is_portable_symbol(symbol):
    """Si el símbolo no lleva atada la sintaxis de un proveedor concreto."""
    if ":" in symbol:
        return False
    if "." in symbol and symbol.rsplit(".", 1)[-1] in EODHD_EXCHANGE_CODES:
        return False
    return True


def _fallback_chain(primary, symbol):
    if not _is_portable_symbol(symbol):
        return (primary,)
    return (primary,) + tuple(p for p in _FALLBACK_ORDER if p != primary)


def _is_provider_resting(provider):
    until = _provider_resting_until.get(provider)
    return bool(until and time.monotonic() < until)


def _mark_provider_rate_limited(provider):
    with _state_lock:
        _provider_resting_until[provider] = time.monotonic() + _RATE_LIMIT_COOLDOWN_SECONDS


def _cached_quote(cache_key, ttl):
    if ttl <= 0:
        return None
    with _state_lock:
        entry = _quote_cache.get(cache_key)
    if entry and time.monotonic() - entry["ts"] < ttl:
        return entry["quote"]
    return None


def _store_quote(cache_key, quote, ttl):
    if ttl <= 0:
        return
    with _state_lock:
        _quote_cache[cache_key] = {"quote": quote, "ts": time.monotonic()}


def fetch_asset_quote(symbol, provider=None, use_cache=True, target_currency=None):
    """Cotización de un símbolo. Devuelve `(quote, error)` como los clientes.

    `use_cache=False` salta la lectura de caché sin desactivarla del todo: el
    resultado fresco se guarda igual, para que el próximo dashboard que la
    consulte no vea el precio viejo hasta que expire el TTL. Lo usa el botón
    "Actualizar cotización" (`routes/activos.py`), donde el usuario pide
    explícitamente un dato nuevo y devolverle el de hace unos segundos sería
    justo lo contrario de lo que pidió.

    `target_currency`, si se da, convierte la cotización a esa divisa antes de
    devolverla y de guardarla en caché -así un acierto de caché no repite la
    conversión- usando el tipo de cambio en tiempo real. Es la divisa que el
    activo tiene guardada en `convertCurrency`; vacío (el valor por defecto)
    deja el precio tal cual lo da el proveedor, que es el comportamiento de
    siempre. Si la conversión falla (divisa no soportada, servicio de cambio
    caído), se devuelve la cotización sin convertir en vez de fallar entera
    una petición que sí tiene un precio válido, solo que en otra divisa.
    """
    symbol = str(symbol or "").strip().upper()
    if not symbol:
        return None, "symbol requerido"

    proveedor_principal = normalizeMarketProvider(
        str(provider or "").strip(), fallback=inferMarketProviderFromSymbol(symbol)
    )
    target_currency = str(target_currency or "").strip().upper() or None

    ttl = settings.cotizacionTtlSegundos()
    cache_key = f"{proveedor_principal}:{symbol}:{target_currency or 'nativa'}"
    if use_cache:
        cached_quote = _cached_quote(cache_key, ttl)
        if cached_quote is not None:
            return cached_quote, None

    last_error = None
    for candidato in _fallback_chain(proveedor_principal, symbol):
        if _is_provider_resting(candidato):
            continue

        quote, error = _FETCHERS[candidato](symbol)

        if not error:
            telegram_notifier.notificar_recuperado(_NOMBRE_PROVEEDOR.get(candidato, candidato))
            if target_currency and target_currency != str(quote.get("currency", "")).strip().upper():
                converted, conv_error = convert_quote_currency(quote, target_currency)
                if not conv_error and converted:
                    quote = converted
            _store_quote(cache_key, quote, ttl)
            return quote, None

        if is_rate_limited_error(error):
            _mark_provider_rate_limited(candidato)
            categoria = "cuota_agotada"
        elif is_temporary_service_error(error):
            categoria = "no_responde"
        else:
            categoria = "fallo"
        telegram_notifier.notificar_problema(categoria, _NOMBRE_PROVEEDOR.get(candidato, candidato), error)

        last_error = error

    return None, last_error or "Todos los proveedores de mercado están en reposo por límite de peticiones"
