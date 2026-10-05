"""Histórico de un par de divisas, para el comparador de Herramientas.

Pide a Yahoo Finance la serie del par (`EURUSD=X`) y la devuelve lista para
dibujar. Dar la vuelta al par (USD contra EUR en vez de EUR contra USD) no
necesita otra petición: el navegador invierte la serie, 1/x punto a punto.

A diferencia de `fx_historico` —que cachea en SQLite cierres pasados que ya no
cambian—, aquí la serie incluye el presente y se pide a demanda desde un
selector que el usuario toca con frecuencia. Por eso la caché es en memoria y
con caducidad corta: basta para que cambiar de rango o de par no dispare una
ráfaga de peticiones, y no guarda en disco nada que envejezca en minutos.
"""

import logging
import re
import threading
import time
from datetime import UTC, datetime

from providers.yahoo_finance_client import fetch_price_series

log = logging.getLogger(__name__)

_DIA = 86400

# Rangos que ofrece el selector. `dias` es cuánto se mira atrás. Los diarios
# (`intervalo` 1d) salen todos de la misma serie de un año, así que cambiar entre
# 1M, 3M, 6M y 1A cuesta una sola petición. 1D y 1S son intradía; 5A, semanal.
RANGOS = {
    "1D": {"dias": 5, "intervalo": "5m", "ultimo_dia": True, "ttl": 120},  # últimas 24 h de cotización
    "1S": {"dias": 8, "intervalo": "30m", "ttl": 300},
    "1M": {"dias": 31, "intervalo": "1d", "ttl": 1800},
    "3M": {"dias": 92, "intervalo": "1d", "ttl": 1800},
    "6M": {"dias": 183, "intervalo": "1d", "ttl": 1800},
    "1A": {"dias": 366, "intervalo": "1d", "ttl": 1800},
    "5A": {"dias": 1830, "intervalo": "1wk", "ttl": 3600},
}

# Cambios que se calculan siempre, sea cual sea el rango dibujado: es la tabla
# de «cuánto ha variado en un día, una semana, un mes…».
PERIODOS = (("1D", 1), ("1S", 7), ("1M", 30), ("3M", 91), ("6M", 182), ("1A", 365))

_CODIGO = re.compile(r"^[A-Z]{3}$")

# Hasta cuántos días antes del objetivo se acepta una referencia. Si la serie
# empieza mucho después de lo pedido, ese cambio no existe y se omite en vez de
# comparar contra un punto que no es de entonces.
_TOLERANCIA_DIAS = 5

_cache = {}
_candado = threading.Lock()


class HistoricoInvalido(ValueError):
    """Par o rango no válido. La ruta lo traduce a 400."""


def _ahora():
    return time.time()


def normalizar_codigo(valor):
    codigo = str(valor or "").strip().upper()
    if not _CODIGO.match(codigo):
        raise HistoricoInvalido(f"«{valor}» no es un código de divisa de tres letras")
    return codigo


def _serie(simbolo, clave, intervalo, dias, ttl, ahora):
    """Serie cacheada. Devuelve (serie, error); un fallo no se cachea."""
    llave = (simbolo, clave)
    with _candado:
        guardada = _cache.get(llave)
        if guardada and ahora - guardada[0] < ttl:
            return guardada[1], None

    serie, error = fetch_price_series(
        simbolo, ahora - dias * _DIA, ahora, interval=intervalo
    )
    if error:
        return None, error

    with _candado:
        _cache[llave] = (ahora, serie)
    return serie, None


def _referencia(serie, dias):
    """Último punto que ya existía hace `dias` días, respecto al final de la serie."""
    ultimo = serie[-1]
    if dias == 1:
        # «Ayer» es el cierre de la sesión anterior, no hace 24 horas exactas:
        # el lunes por la mañana, hace 24 horas es domingo.
        dia_ultimo = datetime.fromtimestamp(ultimo["ts"], UTC).date()
        previos = [p for p in serie if datetime.fromtimestamp(p["ts"], UTC).date() < dia_ultimo]
        return previos[-1] if previos else None

    objetivo = ultimo["ts"] - dias * _DIA
    anteriores = [p for p in serie if p["ts"] <= objetivo]
    if anteriores:
        return anteriores[-1]
    # Sin nada anterior al objetivo: vale el primer punto solo si queda cerca.
    primero = serie[0]
    return primero if primero["ts"] - objetivo <= _TOLERANCIA_DIAS * _DIA else None


def _referencias(serie_anual):
    referencias = []
    for etiqueta, dias in PERIODOS:
        punto = _referencia(serie_anual, dias)
        if punto and punto["ts"] < serie_anual[-1]["ts"]:
            referencias.append({"rango": etiqueta, "ts": punto["ts"], "close": punto["close"]})
    return referencias


def historico_par(base, quote, rango, ahora=None):
    """Serie del par `base`/`quote` y los cambios por periodo.

    Devuelve `(datos, error)`. `datos` lleva los puntos del rango pedido, el
    último cierre y las referencias de cada periodo (el cambio se calcula en el
    navegador, para poder invertirlo sin volver a pedir nada).
    """
    base = normalizar_codigo(base)
    quote = normalizar_codigo(quote)
    if base == quote:
        raise HistoricoInvalido("Elige dos divisas distintas")
    rango = str(rango or "").strip().upper()
    if rango not in RANGOS:
        raise HistoricoInvalido(f"Rango no admitido: {rango or 'vacío'}")

    ahora = ahora if ahora is not None else _ahora()
    simbolo = f"{base}{quote}=X"
    ajustes = RANGOS[rango]

    anual, error = _serie(simbolo, "1A", "1d", RANGOS["1A"]["dias"], RANGOS["1A"]["ttl"], ahora)
    if error:
        return None, error

    if ajustes["intervalo"] == "1d":
        corte = ahora - ajustes["dias"] * _DIA
        puntos = [p for p in anual if p["ts"] >= corte] or anual[-2:]
    else:
        puntos, error = _serie(simbolo, rango, ajustes["intervalo"], ajustes["dias"], ajustes["ttl"], ahora)
        if error:
            return None, error
        if ajustes.get("ultimo_dia"):
            # Las últimas 24 horas de cotización, no «el día de hoy»: justo
            # después de medianoche UTC (o en fin de semana) hoy no tiene casi
            # puntos, y desde el cierre del viernes hasta el domingo no tiene ninguno.
            corte = puntos[-1]["ts"] - _DIA
            puntos = [p for p in puntos if p["ts"] >= corte]

    return {
        "base": base,
        "quote": quote,
        "rango": rango,
        "intervalo": ajustes["intervalo"],
        "puntos": puntos,
        # El cierre más reciente: el intradía en 1D y 1S; en el resto, el de la serie anual.
        "actual": puntos[-1] if ajustes["intervalo"] not in ("1d", "1wk") else anual[-1],
        "referencias": _referencias(anual),
    }, None


def vaciar_cache():
    with _candado:
        _cache.clear()
