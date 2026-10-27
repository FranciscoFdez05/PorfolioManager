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

from core import proveedores_pausados, settings, telegram_notifier
from providers.alpha_vantage_client import fetchQuote as _fetchAvQuote
from providers.eodhd_client import fetchQuote as _fetchEodhdQuote
from providers.finnhub_client import convertQuoteCurrency, fetchQuote as _fetchFinnhubQuote
from providers.tradingview_client import fetchQuote as _fetchTradingviewQuote
from providers.yahoo_finance_client import fetchQuote as _fetchYahooQuote
from stores.asset_utils import EODHD_EXCHANGE_CODES, inferMarketProviderFromSymbol, normalizeMarketProvider
from stores.helpers import (
    callAlphaVantageWithFallbacks,
    callEodhdWithFallbacks,
    callFinnhubWithFallbacks,
    isRateLimitedError,
    isTemporaryServiceError,
)

_FETCHERS = {
    "eodhd": lambda symbol: callEodhdWithFallbacks(lambda apiKey: _fetchEodhdQuote(symbol, apiKey)),
    "yahoo": lambda symbol: _fetchYahooQuote(symbol),
    "alphavantage": lambda symbol: callAlphaVantageWithFallbacks(lambda apiKey: _fetchAvQuote(symbol, apiKey)),
    "finnhub": lambda symbol: callFinnhubWithFallbacks(lambda apiKey: _fetchFinnhubQuote(symbol, apiKey)),
    "tradingview": lambda symbol: _fetchTradingviewQuote(symbol),
}

# El orden de respaldo entre proveedores y el reposo tras un límite de
# peticiones son decisión del usuario: `[mercado] orden_respaldo` y
# `reposo_limite_segundos` en config.ini (ver core/settings.py).

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

_stateLock = Lock()
_quoteCache: dict = {}          # f"{proveedor}:{symbol}" -> {"quote":, "ts":}
_providerRestingUntil: dict = {}  # proveedor -> time.monotonic() hasta el que evitarlo


def _isPortableSymbol(symbol):
    """Si el símbolo no lleva atada la sintaxis de un proveedor concreto."""
    if ":" in symbol:
        return False
    return not ("." in symbol and symbol.rsplit(".", 1)[-1] in EODHD_EXCHANGE_CODES)


def _fallbackChain(primary, symbol):
    if not _isPortableSymbol(symbol):
        return (primary,)
    # Solo proveedores que existen: un nombre mal escrito en config.ini no puede
    # romper la cotización, se ignora.
    orden = [
        p for p in (str(nombre).strip().lower() for nombre in settings.ordenRespaldoProveedores())
        if p in _FETCHERS and p != primary
    ]
    return (primary, *dict.fromkeys(orden))


def _isProviderResting(provider):
    until = _providerRestingUntil.get(provider)
    return bool(until and time.monotonic() < until)


def _markProviderRateLimited(provider):
    reposo = settings.reposoLimiteSegundos()
    if reposo <= 0:
        return
    with _stateLock:
        _providerRestingUntil[provider] = time.monotonic() + reposo


def _cachedQuote(cacheKey, ttl):
    if ttl <= 0:
        return None
    with _stateLock:
        entry = _quoteCache.get(cacheKey)
    if entry and time.monotonic() - entry["ts"] < ttl:
        return entry["quote"]
    return None


def _storeQuote(cacheKey, quote, ttl):
    if ttl <= 0:
        return
    with _stateLock:
        _quoteCache[cacheKey] = {"quote": quote, "ts": time.monotonic()}


def _claveDeCotizacion(symbol, provider, targetCurrency):
    """`(symbol, proveedor, divisa, clave de caché)` normalizados de una cotización."""
    symbol = str(symbol or "").strip().upper()
    proveedorPrincipal = normalizeMarketProvider(
        str(provider or "").strip(), fallback=inferMarketProviderFromSymbol(symbol)
    )
    targetCurrency = str(targetCurrency or "").strip().upper() or None
    return symbol, proveedorPrincipal, targetCurrency, f"{proveedorPrincipal}:{symbol}:{targetCurrency or 'nativa'}"


def _ttlEfectivo(maxEdadSegundos):
    """TTL de la caché, recortado a `maxEdadSegundos` si quien llama pide más frescura."""
    ttl = settings.cotizacionTtlSegundos()
    if maxEdadSegundos is None:
        return ttl
    return min(ttl, max(0, int(maxEdadSegundos)))


def edadEnCache(symbol, provider=None, targetCurrency=None, maxEdadSegundos=None):
    """Segundos que lleva en caché la cotización que serviría `fetchAssetQuote`, o `None`.

    Permite a la ruta decir si el precio que devuelve es de la caché y cuánto
    hace que se pidió al proveedor, sin cambiar lo que devuelve `fetchAssetQuote`.

    Args:
        symbol: Símbolo del activo.
        provider: Proveedor de mercado; se infiere del símbolo si falta.
        targetCurrency: Divisa a la que se convertía la cotización.
        maxEdadSegundos: Si se da, tope a la vigencia (ver `fetchAssetQuote`).

    Returns:
        Edad en segundos si hay una entrada vigente; `None` si no la hay.
    """
    _symbol, _proveedor, _divisa, cacheKey = _claveDeCotizacion(symbol, provider, targetCurrency)
    ttl = _ttlEfectivo(maxEdadSegundos)
    if ttl <= 0:
        return None
    with _stateLock:
        entry = _quoteCache.get(cacheKey)
    if not entry:
        return None
    edad = time.monotonic() - entry["ts"]
    return edad if edad < ttl else None


def fetchAssetQuote(symbol, provider=None, useCache=True, targetCurrency=None, maxEdadSegundos=None):
    """Cotización de un símbolo. Devuelve `(quote, error)` como los clientes.

    `use_cache=False` salta la lectura de caché sin desactivarla del todo: el
    resultado fresco se guarda igual, para que el próximo dashboard que la
    consulte no vea el precio viejo hasta que expire el TTL. Lo usa el botón
    "Actualizar cotización" (`routes/activos.py`), donde el usuario pide
    explícitamente un dato nuevo y devolverle el de hace unos segundos sería
    justo lo contrario de lo que pidió.

    `target_currency`, si se da, convierte la cotización a esa divisa antes de
    devolverla y de guardarla en caché -así un acierto de caché no repite la
    conversión- usando el tipo de cambio en tiempo real. El refresco de un
    activo pasa aquí la divisa del activo (`routes/activos.py`); sin ella, el
    precio sale tal cual lo da el proveedor. Si la conversión falla (divisa no
    soportada, servicio de cambio caído), se devuelve la cotización sin
    convertir en vez de fallar entera: quien necesite la divisa exacta tiene
    que comprobar `quote["currency"]`, como hace ese refresco.
    """
    symbol, proveedorPrincipal, targetCurrency, cacheKey = _claveDeCotizacion(symbol, provider, targetCurrency)
    if not symbol:
        return None, "symbol requerido"

    ttl = settings.cotizacionTtlSegundos()
    if useCache:
        # `maxEdadSegundos` recorta solo esta lectura (no lo que se guarda): el
        # refresco automático no debe recibir un precio más viejo que su intervalo.
        cachedQuote = _cachedQuote(cacheKey, _ttlEfectivo(maxEdadSegundos))
        if cachedQuote is not None:
            return cachedQuote, None

    lastError = None
    for candidato in _fallbackChain(proveedorPrincipal, symbol):
        if _isProviderResting(candidato) or proveedores_pausados.estaPausado(candidato):
            continue

        quote, error = _FETCHERS[candidato](symbol)

        if not error:
            telegram_notifier.notificarRecuperado(_NOMBRE_PROVEEDOR.get(candidato, candidato))
            if targetCurrency and targetCurrency != str(quote.get("currency", "")).strip().upper():
                converted, convError = convertQuoteCurrency(quote, targetCurrency)
                if not convError and converted:
                    quote = converted
            _storeQuote(cacheKey, quote, ttl)
            return quote, None

        lastError = error

        # «No devolvió cotización» es el proveedor contestando bien y sin
        # conocer ese ticker: no es una caída suya. Avisar de ello hacía que
        # cada activo sin datos disparase «Fallo de Finnhub» y, justo después,
        # el siguiente activo bueno, «vuelve a responder».
        if "no devolvió cotización" in str(error):
            continue

        if isRateLimitedError(error):
            _markProviderRateLimited(candidato)
            categoria = "cuota_agotada"
        elif isTemporaryServiceError(error):
            categoria = "no_responde"
        else:
            categoria = "fallo"
        telegram_notifier.notificarProblema(
            categoria, _NOMBRE_PROVEEDOR.get(candidato, candidato), f"Al cotizar {symbol}: {error}"
        )

    if lastError is None and any(proveedores_pausados.estaPausado(p) for p in _fallbackChain(proveedorPrincipal, symbol)):
        return None, "Los proveedores de este activo están pausados (Ajustes > API)"
    return None, lastError or "Todos los proveedores de mercado están en reposo por límite de peticiones"
