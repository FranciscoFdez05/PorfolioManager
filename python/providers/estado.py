"""Estado de cada proveedor de datos de mercado.

El contador de "Peticiones API hoy" dice cuánta cuota se ha gastado, pero no si
el proveedor responde. Cuando la cartera deja de actualizar precios la pregunta
es otra: ¿se acabó la cuota, caducó la clave o está caído el servicio? Hasta
ahora había que abrir los logs del contenedor para distinguirlo.

Cada proveedor se comprueba con la llamada más barata que tiene —una cotización
de un símbolo conocido— y el fallo se traduce a uno de estos estados:

* ``ok``        — responde y devuelve datos.
* ``sin_clave`` — no hay clave configurada; el proveedor ni se llega a llamar.
* ``clave``     — la clave existe pero el proveedor la rechaza (401/403).
* ``limite``    — cuota agotada (429/402, o el aviso en el cuerpo de Alpha Vantage).
* ``caido``     — no contesta: timeout, corte de red o 5xx.
* ``error``     — contesta algo que no se entiende.

**Las comprobaciones gastan cuota real**, así que se contabilizan en `api_stats`
como cualquier otra llamada y el resultado se cachea: pulsar "Actualizar" en
bucle no puede acabar siendo el motivo de que se agote la cuota. Por eso la
respuesta lleva la antigüedad del dato en vez de fingir que se acaba de
comprobar.
"""

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from urllib.error import HTTPError, URLError

from providers.http import fetch_json
from stores import app_data

log = logging.getLogger(__name__)

# Segundos que vale un diagnóstico. Un proveedor caído no vuelve en medio
# minuto, y cada comprobación cuesta cuota.
TTL_CACHE = 60

# Los proveedores gratuitos tardan lo suyo cuando van justos, pero aquí hay
# alguien esperando delante de la pantalla: es mejor decir "no responde" a los
# seis segundos que dejar la pantalla colgada con el timeout normal.
_TIMEOUT = 6.0

_YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"

_lock = Lock()
_cache: dict = {"momento": 0.0, "proveedores": []}


class _Limite(Exception):
    """Contestó 200, pero el cuerpo dice que no queda cuota."""


class _Clave(Exception):
    """Contestó 200, pero el cuerpo dice que la clave no vale."""


class _SinClave(Exception):
    """No hay clave configurada, así que no se ha llegado a llamar."""


def _clave(lector):
    """La clave, o corta la comprobación antes de gastar una petición.

    Llamar sin clave devolvería un 401 previsible que cuenta como llamada y
    que además se pintaría como "clave rechazada": el usuario buscaría una clave
    mala donde lo que hay es un hueco.
    """
    try:
        valor = lector()
    except Exception as error:
        log.debug("[estado] No se pudo leer la clave: %s", error)
        raise _SinClave() from error
    if not valor:
        raise _SinClave()
    return valor


def _probar_finnhub():
    fetch_json(
        "https://finnhub.io/api/v1/quote",
        {"symbol": "AAPL", "token": _clave(app_data.readFinnhubApiKey)},
        timeout=_TIMEOUT, provider="Finnhub", retries=0,
    )


def _probar_eodhd():
    fetch_json(
        "https://eodhd.com/api/real-time/AAPL.US",
        {"api_token": _clave(app_data.readEodhdApiKey), "fmt": "json"},
        timeout=_TIMEOUT, provider="EODHD", retries=0,
    )


def _probar_alpha_vantage():
    payload = fetch_json(
        "https://www.alphavantage.co/query",
        {
            "function": "GLOBAL_QUOTE",
            "symbol": "AAPL",
            "apikey": _clave(app_data.readAlphaVantageApiKey),
        },
        timeout=_TIMEOUT, provider="Alpha Vantage", retries=0,
    )
    # Alpha Vantage no usa códigos HTTP para esto: el límite diario y la clave
    # inválida llegan como un 200 con un texto explicativo, así que sin mirar
    # el cuerpo saldría "Operativa" con la cuota agotada.
    if not isinstance(payload, dict):
        return
    aviso = payload.get("Note") or payload.get("Information")
    if aviso:
        raise _Limite(aviso)
    if payload.get("Error Message"):
        raise _Clave(payload["Error Message"])


def _probar_yahoo():
    fetch_json(
        "https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
        {"range": "1d", "interval": "1d"},
        timeout=_TIMEOUT, provider="Yahoo Finance", retries=0,
        headers={"User-Agent": _YAHOO_UA},
    )


def _probar_divisas():
    fetch_json(
        "https://api.frankfurter.app/latest",
        {"from": "EUR", "to": "USD"},
        timeout=_TIMEOUT, provider="Tipo de cambio", retries=0,
    )


# (id, nombre visible, comprobación)
_PROVEEDORES = (
    ("finnhub",      "Finnhub",        _probar_finnhub),
    ("eodhd",        "EODHD",          _probar_eodhd),
    ("alphavantage", "Alpha Vantage",  _probar_alpha_vantage),
    ("yahoo",        "Yahoo Finance",  _probar_yahoo),
    ("divisas",      "Tipo de cambio", _probar_divisas),
)


def _fila(id_proveedor, nombre, estado, etiqueta, detalle="", ms=0):
    return {
        "id": id_proveedor,
        "nombre": nombre,
        "estado": estado,
        "etiqueta": etiqueta,
        "detalle": str(detalle)[:200],
        "ms": ms,
    }


def _por_codigo(codigo):
    if codigo in (401, 403):
        return "clave", "Clave rechazada"
    if codigo in (402, 429):
        # 402 es lo que devuelve EODHD cuando se agota el plan del día.
        return "limite", "Cuota agotada"
    if codigo >= 500:
        return "caido", "Caída"
    return "error", f"HTTP {codigo}"


def _diagnosticar(id_proveedor, nombre, probar):
    inicio = time.monotonic()

    def fin(estado, etiqueta, detalle=""):
        ms = round((time.monotonic() - inicio) * 1000)
        return _fila(id_proveedor, nombre, estado, etiqueta, detalle, ms)

    try:
        probar()
    except _SinClave:
        return fin("sin_clave", "Sin clave", "No hay ninguna clave configurada")
    except _Limite as error:
        return fin("limite", "Cuota agotada", error)
    except _Clave as error:
        return fin("clave", "Clave rechazada", error)
    except HTTPError as error:
        estado, etiqueta = _por_codigo(error.code)
        return fin(estado, etiqueta, f"HTTP {error.code}")
    except (TimeoutError, URLError) as error:
        return fin("caido", "No responde", getattr(error, "reason", error))
    except Exception as error:
        log.debug("[estado] %s falló de forma inesperada: %s", nombre, error)
        return fin("error", "Error", error)
    return fin("ok", "Operativa")


def comprobar():
    """Diagnostica todos los proveedores en paralelo, sin mirar la caché."""
    # En serie serían cinco timeouts encadenados: medio minuto con todo caído.
    # En paralelo, el peor caso es un timeout.
    with ThreadPoolExecutor(max_workers=len(_PROVEEDORES)) as pool:
        # `map` conserva el orden de entrada, que es el declarado arriba: una
        # lista que se reordena sola según quién conteste antes sería ilegible.
        return list(pool.map(lambda datos: _diagnosticar(*datos), _PROVEEDORES))


def obtener(forzar: bool = False) -> dict:
    """Estado de los proveedores; de la caché mientras siga fresco."""
    ahora = time.monotonic()
    with _lock:
        fresco = _cache["proveedores"] and (ahora - _cache["momento"]) < TTL_CACHE
        if fresco and not forzar:
            return {
                "proveedores": list(_cache["proveedores"]),
                "edadSegundos": round(ahora - _cache["momento"]),
                "cacheado": True,
                "ttlSegundos": TTL_CACHE,
            }

    proveedores = comprobar()

    with _lock:
        _cache["momento"] = time.monotonic()
        _cache["proveedores"] = proveedores

    return {
        "proveedores": proveedores,
        "edadSegundos": 0,
        "cacheado": False,
        "ttlSegundos": TTL_CACHE,
    }


def reiniciar_para_pruebas() -> None:
    """Vacía la caché. Simula un worker recién arrancado."""
    with _lock:
        _cache["momento"] = 0.0
        _cache["proveedores"] = []
