"""Estado de cada proveedor de datos de mercado.

El contador de "Peticiones API hoy" dice cuánta cuota se ha gastado, pero no si
el proveedor responde. Cuando la cartera deja de actualizar precios la pregunta
es otra: ¿se acabó la cuota, caducó la clave o está caído el servicio? Hasta
ahora había que abrir los logs del contenedor para distinguirlo.

Cada proveedor se comprueba con la llamada más barata que tiene —una cotización
de un símbolo conocido— y el fallo se traduce a uno de estos estados:

* ``ok``        — responde y devuelve datos.
* ``sin_clave`` — no hay clave configurada; el proveedor ni se llega a llamar.
* ``clave``     — la clave existe pero el proveedor la rechaza (401).
* ``plan``      — la clave vale, pero el plan no cubre lo que se ha pedido (403).
* ``limite``    — cuota agotada (429/402, o el aviso en el cuerpo de Alpha Vantage).
* ``caido``     — no contesta: timeout, corte de red o 5xx.
* ``error``     — contesta algo que no se entiende.

Los proveedores que admiten varias claves se comprueban recorriéndolas hasta
que una responde: el diagnóstico dice si el proveedor sirve, no si sirve la
primera clave de la lista.

**Las comprobaciones gastan cuota real**, así que se contabilizan en `api_stats`
como cualquier otra llamada y el resultado se cachea hasta que una llamada real
falle: ver la pantalla no puede acabar siendo el motivo de que se agote la cuota. Por eso la
respuesta lleva la antigüedad del dato en vez de fingir que se acaba de
comprobar.
"""

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
from urllib.error import HTTPError, URLError

from core import proveedores_pausados
from providers.api_stats import last_api_failure
from providers.http import fetch_json
from stores import app_data

log = logging.getLogger(__name__)

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


def _lista_claves(lector_lista, lector_legado):
    """Todas las claves configuradas del proveedor, en orden.

    El lector "legado" es el de una sola clave y sigue haciendo falta: cubre las
    instalaciones que nunca llegaron a configurar varias. Si no hay ninguna,
    corta la comprobación igual que `_clave`.
    """
    try:
        claves = [clave for clave in (lector_lista() or []) if clave]
    except Exception as error:
        log.debug("[estado] No se pudieron leer las claves: %s", error)
        claves = []
    return claves or [_clave(lector_legado)]


def _sondear_claves(claves, llamada):
    """Prueba las claves en orden y para en la primera que responde.

    Antes se sondeaba solo la primera. Con varias configuradas —EODHD da 20
    peticiones al día por clave, que es justo el motivo de poner varias— que la
    #1 se quedara sin cuota pintaba «EODHD · Cuota agotada» aunque las otras
    estuvieran enteras y la aplicación siguiera actualizando precios con ellas.
    El usuario veía un proveedor roto que no lo estaba.

    Mientras la primera responda —el caso normal— sigue costando una sola
    petición: solo baja por la lista cuando ya hay un fallo que explicar, y esas
    claves de más que se prueban son precisamente las que no tienen cuota que
    gastar.
    """
    ultimo_error = None

    for numero, clave in enumerate(claves, start=1):
        try:
            llamada(clave)
        except Exception as error:
            ultimo_error = error
            continue

        if numero == 1:
            return ""

        # Que responda la tercera no es lo mismo que responder a la primera: el
        # proveedor sirve, pero quedan menos claves de las que parece.
        return f"Responde la clave {numero} de {len(claves)}; las anteriores, no"

    raise ultimo_error


def _probar_finnhub():
    return _sondear_claves(
        _lista_claves(app_data.readFinnhubApiKeys, app_data.readFinnhubApiKey),
        lambda clave: fetch_json(
            "https://finnhub.io/api/v1/quote",
            {"symbol": "AAPL", "token": clave},
            timeout=_TIMEOUT, provider="Finnhub", retries=0,
        ),
    )


def _probar_eodhd():
    return _sondear_claves(
        _lista_claves(app_data.readEodhdApiKeys, app_data.readEodhdApiKey),
        lambda clave: fetch_json(
            "https://eodhd.com/api/real-time/AAPL.US",
            {"api_token": clave, "fmt": "json"},
            timeout=_TIMEOUT, provider="EODHD", retries=0,
        ),
    )


def _consultar_alpha_vantage(clave):
    payload = fetch_json(
        "https://www.alphavantage.co/query",
        {
            "function": "GLOBAL_QUOTE",
            "symbol": "AAPL",
            "apikey": clave,
        },
        timeout=_TIMEOUT, provider="Alpha Vantage", retries=0,
    )
    # Alpha Vantage no usa códigos HTTP para esto: el límite diario y la clave
    # inválida llegan como un 200 con un texto explicativo, así que sin mirar
    # el cuerpo saldría "Operativa" con la cuota agotada. Se mira aquí dentro,
    # y no después del sondeo, para que una clave sin cuota deje paso a la
    # siguiente en vez de dar por fallado al proveedor entero.
    if not isinstance(payload, dict):
        return
    aviso = payload.get("Note") or payload.get("Information")
    if aviso:
        raise _Limite(aviso)
    if payload.get("Error Message"):
        raise _Clave(payload["Error Message"])


def _probar_alpha_vantage():
    return _sondear_claves(
        _lista_claves(app_data.readAlphaVantageApiKeys, app_data.readAlphaVantageApiKey),
        _consultar_alpha_vantage,
    )


def _probar_yahoo():
    fetch_json(
        "https://query1.finance.yahoo.com/v8/finance/chart/AAPL",
        {"range": "1d", "interval": "1d"},
        timeout=_TIMEOUT, provider="Yahoo Finance", retries=0,
        headers={"User-Agent": _YAHOO_UA},
    )


def _probar_tradingview():
    fetch_json(
        "https://scanner.tradingview.com/global/scan",
        timeout=_TIMEOUT, provider="TradingView", retries=0,
        json_body={
            "symbols": {"tickers": ["NASDAQ:AAPL"], "query": {"types": []}},
            "columns": ["close"],
        },
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
    ("tradingview",  "TradingView",    _probar_tradingview),
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
        # Instante del diagnóstico: un fallo real posterior pide repetirlo.
        "_momento": time.monotonic(),
    }


def _por_codigo(codigo):
    if codigo == 401:
        return "clave", "Clave rechazada"
    if codigo == 403:
        # Finnhub usa el 403 para "tu plan no cubre esto" —bolsas fuera de
        # EE. UU., históricos— con la clave perfectamente válida. Pintarlo como
        # clave rechazada mandaba al usuario a cambiar una clave que funciona,
        # y a no encontrar nunca el problema, que es el plan.
        return "plan", "Fuera del plan"
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
        detalle_ok = probar()
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
    return fin("ok", "Operativa", detalle_ok or "")


def _diagnosticar_o_pausa(id_proveedor, nombre, probar):
    # Un proveedor pausado no se sondea: sería gastar cuota en algo que el
    # usuario ha apagado a propósito.
    if proveedores_pausados.esta_pausado(id_proveedor):
        return _fila(id_proveedor, nombre, "pausada", "Pausada", "Pausada desde Ajustes")
    return _diagnosticar(id_proveedor, nombre, probar)


def _con_pausa(proveedores):
    """Marca `pausable` y `pausada` con el ajuste de ahora, no el de cuando se cacheó."""
    pausados = proveedores_pausados.pausados()
    filas = []
    for fila in proveedores:
        fila = dict({k: v for k, v in fila.items() if k != "_momento"}, pausable=fila["id"] in proveedores_pausados.PAUSABLES, pausada=fila["id"] in pausados)
        if fila["pausada"] and fila["estado"] != "pausada":
            fila.update(estado="pausada", etiqueta="Pausada", detalle="Pausada desde Ajustes", ms=0)
        filas.append(fila)
    return filas


def comprobar():
    """Diagnostica todos los proveedores en paralelo, sin mirar la caché."""
    # En serie serían cinco timeouts encadenados: medio minuto con todo caído.
    # En paralelo, el peor caso es un timeout.
    with ThreadPoolExecutor(max_workers=len(_PROVEEDORES)) as pool:
        # `map` conserva el orden de entrada, que es el declarado arriba: una
        # lista que se reordena sola según quién conteste antes sería ilegible.
        return list(pool.map(lambda datos: _diagnosticar_o_pausa(*datos), _PROVEEDORES))


def _fallo_posterior(fila) -> bool:
    """¿Falló una llamada real de este proveedor después de su último diagnóstico?"""
    return last_api_failure(fila["nombre"]) > fila.get("_momento", 0.0)


def obtener(forzar: bool = False) -> dict:
    """Estado de los proveedores, sin gastar cuota salvo que haga falta.

    El diagnóstico dura hasta que una llamada real de un proveedor falla (clave,
    cuota, caída): entonces se vuelve a comprobar solo ese. Abrir la pantalla o
    dejarla abierta no sondea nada. La primera vez tras arrancar no hay nada
    cacheado y se comprueba todo; `forzar` lo repite todo a petición del usuario.
    """
    with _lock:
        previas = list(_cache["proveedores"])

    if forzar or not previas:
        proveedores = comprobar()
    else:
        pendientes = {fila["id"] for fila in previas if _fallo_posterior(fila)}
        if not pendientes:
            return _respuesta_cacheada(previas)
        proveedores = [
            _diagnosticar_o_pausa(*datos) if datos[0] in pendientes else fila
            for datos, fila in zip(_PROVEEDORES, previas)
        ]

    with _lock:
        _cache["momento"] = time.monotonic()
        _cache["proveedores"] = proveedores

    return {
        "proveedores": _con_pausa(proveedores),
        "edadSegundos": 0,
        "cacheado": False,
    }


def _respuesta_cacheada(proveedores) -> dict:
    with _lock:
        edad = round(time.monotonic() - _cache["momento"])
    return {
        "proveedores": _con_pausa(proveedores),
        "edadSegundos": edad,
        "cacheado": True,
    }


def reiniciar_para_pruebas() -> None:
    """Vacía la caché. Simula un worker recién arrancado."""
    with _lock:
        _cache["momento"] = 0.0
        _cache["proveedores"] = []
