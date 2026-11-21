"""Equivalencias entre divisas y activos, para la herramienta de Herramientas.

El usuario arma una lista con divisas fiat (USD, GBP...) y tickers de
TradingView (acciones, ETF, cripto, metales...) y la herramienta dice cuánto de
cada uno equivale a una cantidad de otro, y cómo ha rendido cada uno en el
periodo elegido. Para eso todo tiene que estar en la misma moneda: aquí se pasa
cada serie a la moneda de referencia y el navegador solo divide.

No se guarda nada ni se pide nada nuevo a la red que no pidan ya otras
herramientas:

- Las velas de cada ticker salen de `series_tradingview.velasDelGrafico`, que ya
  dice en qué divisa cotiza y tiene su propia caché.
- El cambio de una divisa a la de referencia sale de
  `divisas_historico.historicoPar`, el mismo del comparador de divisas, también
  cacheado. Una divisa de la lista no es más que esa serie.

Nada se fija por activo ni por bolsa: la divisa la dice el feed. Si no la dice o
no hay cambio para ella, ese elemento llega con su error y los demás siguen.
"""

import logging
import threading
import time
from bisect import bisect_right
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor

from core import settings
from stores import divisas_historico, series_tradingview
from stores.divisas_historico import HistoricoInvalido, normalizarCodigo

log = logging.getLogger(__name__)

_DIA = 86400

# Rango → (cómo pedir las velas de un ticker, días que se miran atrás).
# Las velas se piden con las claves que ya entiende `velasDelGrafico`; los
# rangos diarios salen todos de la misma serie de un año, como en el comparador
# de divisas, así que cambiar entre 1M, 3M, 6M y 1A no pide nada nuevo.
# En 1D el recorte son las últimas 24 h de cotización, no «hoy» (ver
# `_recortar`), y en 5A se usan velas semanales.
_VELAS_ANUALES = {"rango": "1A"}
RANGOS = {
    "1D": ({"rango": "1D"}, 1),
    "1S": ({"rango": "7D"}, 7),
    "1M": (_VELAS_ANUALES, 31),
    "3M": (_VELAS_ANUALES, 92),
    "6M": (_VELAS_ANUALES, 183),
    "1A": (_VELAS_ANUALES, 366),
    "5A": ({"rango": "TODO", "temporalidad": "1S"}, 1830),
}

# Tope de elementos por petición: cada ticker es una conexión al feed si no
# está en caché, y una URL manipulada no debe poder abrir cientos.
MAX_ELEMENTOS = 25


class EquivalenciasInvalidas(ValueError):
    """Lista, moneda o rango no válidos. La ruta lo traduce a un 400."""


def _ahora() -> float:
    return time.time()


def leerLista(texto: str | None) -> list[str]:
    """Elementos separados por comas, en mayúsculas y sin repetir.

    Args:
        texto: El parámetro tal como llega (`"USD,gbp"`), o None.

    Returns:
        Los elementos limpios, en el orden en que llegaron.
    """
    return list(dict.fromkeys(p.strip().upper() for p in str(texto or "").split(",") if p.strip()))


def _validar(
    divisas: list[str], tickers: list[str], referencia: str, rango: str
) -> tuple[list[str], list[str], str, str]:
    """Normaliza la petición o la rechaza entera.

    Un ticker o una divisa con forma imposible es un error de la petición, no
    un elemento sin cotización: el frontend solo manda lo que sale del buscador
    y de la lista de divisas.
    """
    if not divisas and not tickers:
        raise EquivalenciasInvalidas("La lista está vacía")
    if len(divisas) + len(tickers) > MAX_ELEMENTOS:
        raise EquivalenciasInvalidas(f"Como mucho {MAX_ELEMENTOS} elementos")
    rango = str(rango or "").strip().upper()
    if rango not in RANGOS:
        raise EquivalenciasInvalidas(f"Rango no admitido: {rango or 'vacío'}")
    try:
        referencia = normalizarCodigo(referencia)
        divisas = [normalizarCodigo(d) for d in divisas]
    except HistoricoInvalido as error:
        raise EquivalenciasInvalidas(str(error)) from error
    validos = series_tradingview.normalizarSimbolos(tickers) if tickers else []
    if len(validos) != len(tickers):
        raise EquivalenciasInvalidas("Algún ticker no tiene un formato válido")
    return divisas, validos, referencia, rango


def _recortar(puntos: list[dict], rango: str, ahora: float) -> list[dict]:
    """Los puntos de la ventana del rango; si se queda en menos de dos, los dos últimos."""
    if not puntos:
        return []
    dias = RANGOS[rango][1]
    # 1D y 1S cuentan desde el último dato y no desde ahora: un sábado, las
    # últimas 24 h de una acción son las del viernes, no un gráfico vacío.
    desde = (puntos[-1]["ts"] if rango in ("1D", "1S") else ahora) - dias * _DIA
    dentro = [p for p in puntos if p["ts"] >= desde]
    return dentro if len(dentro) >= 2 else puntos[-2:]


def _convertir(puntos: list[dict], cambio: list[dict] | None) -> list[dict]:
    """Pasa cada cierre a la moneda de referencia con el cambio vigente en ese instante.

    Vigente es el último cierre del cambio que ya existía. Antes del primero se
    usa el primero: el mercado de divisas cierra el fin de semana y una cripto
    no, y no tiene sentido dejar sin valor el sábado.

    Args:
        puntos: `[{"ts", "close"}]` en la divisa del activo, en orden.
        cambio: `[{"ts", "close"}]` de 1 unidad de esa divisa en la de
            referencia, en orden; None si ya están en la de referencia.

    Returns:
        Los mismos instantes con el cierre convertido.
    """
    if cambio is None:
        return [dict(p) for p in puntos]
    instantes = [c["ts"] for c in cambio]
    convertidos = []
    for punto in puntos:
        indice = max(0, bisect_right(instantes, punto["ts"]) - 1)
        convertidos.append({"ts": punto["ts"], "close": punto["close"] * cambio[indice]["close"]})
    return convertidos


class _Cambios:
    """Cambios de cada divisa a la de referencia, pedidos una vez por petición.

    Varios tickers suelen cotizar en la misma divisa (USD): sin esto se pediría
    la misma serie una vez por ticker, aunque `historicoPar` la tenga en caché.
    """

    def __init__(self, referencia: str, ahora: float) -> None:
        self.referencia = referencia
        self.ahora = ahora
        self._series: dict[tuple[str, str], tuple[dict | None, str | None]] = {}
        # Los tickers se resuelven en hilos: sin candado, dos que cotizan en USD
        # pedirían el mismo cambio a la vez.
        self._candado = threading.Lock()

    def serie(self, divisa: str, rango: str) -> tuple[dict | None, str | None]:
        """`(datos de historicoPar, error)`; `(None, None)` si `divisa` es la de referencia."""
        if divisa == self.referencia:
            return None, None
        clave = (divisa, rango)
        with self._candado:
            if clave not in self._series:
                try:
                    self._series[clave] = divisas_historico.historicoPar(
                        divisa, self.referencia, rango, ahora=self.ahora
                    )
                except HistoricoInvalido as error:
                    self._series[clave] = (None, str(error))
            return self._series[clave]


def _velas(ticker: str, rango: str, velasDe: Callable) -> tuple[str, list[dict]] | None:
    """`(divisa, [{"ts", "close"}])` del ticker para el rango, o None si el feed no da nada."""
    parametros = RANGOS[rango][0]
    respuesta = velasDe(ticker, parametros["rango"], temporalidad=parametros.get("temporalidad"))
    if not respuesta:
        return None
    divisa, velas = respuesta
    return str(divisa).upper(), [{"ts": int(v[0]), "close": float(v[1])} for v in velas if v[1]]


def _elementoDivisa(divisa: str, rango: str, cambios: _Cambios) -> dict:
    """Una divisa de la lista: su precio es lo que vale una unidad en la de referencia."""
    if divisa == cambios.referencia:
        # La propia referencia vale 1 siempre. Dos puntos bastan para dibujar
        # su línea plana en el 0 % sin pedir nada.
        dias = RANGOS[rango][1]
        puntos = [{"ts": int(cambios.ahora - dias * _DIA), "close": 1.0}, {"ts": int(cambios.ahora), "close": 1.0}]
        return {"puntos": puntos, "actual": puntos[-1], "referencias": []}

    datos, error = cambios.serie(divisa, rango)
    if error:
        return {"error": error}
    return {"puntos": datos["puntos"], "actual": datos["actual"], "referencias": datos["referencias"]}


def _elementoTicker(ticker: str, rango: str, cambios: _Cambios, velasDe: Callable) -> dict:
    """Un ticker de la lista, con su serie y sus referencias ya en la moneda de referencia."""
    anual = _velas(ticker, "1A", velasDe)
    delRango = anual if RANGOS[rango][0] is _VELAS_ANUALES else _velas(ticker, rango, velasDe)
    if not anual or not delRango or len(delRango[1]) < 2:
        return {"error": "TradingView no da cotización con divisa para este ticker"}
    divisa = anual[0]

    cambioAnual, error = cambios.serie(divisa, "1A")
    if error:
        return {"divisa": divisa, "error": f"Sin cambio de {divisa} a {cambios.referencia}: {error}"}
    cambioRango = cambioAnual
    if delRango is not anual:
        cambioRango, error = cambios.serie(divisa, rango)
        if error:
            return {"divisa": divisa, "error": f"Sin cambio de {divisa} a {cambios.referencia}: {error}"}

    serieAnual = _convertir(anual[1], cambioAnual["puntos"] if cambioAnual else None)
    puntos = _recortar(_convertir(delRango[1], cambioRango["puntos"] if cambioRango else None), rango, cambios.ahora)
    return {
        "divisa": divisa,
        "puntos": puntos,
        "actual": puntos[-1],
        # Las mismas referencias que el comparador de divisas, calculadas sobre
        # la serie ya convertida: así la variación incluye el tipo de cambio.
        "referencias": divisas_historico._referencias(serieAnual),
    }


def equivalencias(
    divisas: list[str],
    tickers: list[str],
    referencia: str,
    rango: str,
    ahora: float | None = None,
    velasDe: Callable | None = None,
) -> dict:
    """Series de cada elemento en la moneda de referencia, listas para comparar.

    Args:
        divisas: Códigos fiat de tres letras.
        tickers: Tickers de TradingView (`BITSTAMP:BTCUSD`, `NASDAQ:AAPL`).
        referencia: Moneda en la que se expresa todo (la moneda base de la app).
        rango: Una clave de `RANGOS`.
        ahora: Instante actual (epoch); inyectable para los tests.
        velasDe: Función que da las velas de un ticker; por defecto,
            `series_tradingview.velasDelGrafico`. Inyectable para los tests.

    Returns:
        `{"referencia", "rango", "elementos": [...]}`. Cada elemento lleva `tipo`
        («divisa» o «activo») e `id`, y o bien `puntos`, `actual` y
        `referencias` (todo en la moneda de referencia), o bien `error`.

    Raises:
        EquivalenciasInvalidas: Si la lista, la moneda o el rango no valen.

    Example:
        >>> equivalencias(["USD"], ["BITSTAMP:BTCUSD"], "EUR", "1M")  # doctest: +SKIP
        {'referencia': 'EUR', 'rango': '1M', 'elementos': [{'tipo': 'divisa', 'id': 'USD', ...}, ...]}
    """
    divisas, tickers, referencia, rango = _validar(divisas, tickers, referencia, rango)
    cambios = _Cambios(referencia, ahora if ahora is not None else _ahora())
    velasDe = velasDe or series_tradingview.velasDelGrafico

    elementos = [{"tipo": "divisa", "id": d, **_elementoDivisa(d, rango, cambios)} for d in divisas]

    # Las velas de cada ticker son una conexión al feed: en paralelo, como las
    # cotizaciones de la cartera. Los cambios ya pedidos los comparte `cambios`.
    if tickers:
        with ThreadPoolExecutor(max_workers=min(len(tickers), settings.maxPeticionesParalelas())) as pool:
            resultados = pool.map(lambda t: _elementoTicker(t, rango, cambios, velasDe), tickers)
            elementos += [{"tipo": "activo", "id": t, **r} for t, r in zip(tickers, resultados, strict=True)]

    for elemento in elementos:
        if "error" in elemento:
            log.info("[equivalencias] %s sin cotización: %s", elemento["id"], elemento["error"])

    return {"referencia": referencia, "rango": rango, "elementos": elementos}
