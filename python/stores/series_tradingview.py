"""Velas de TradingView para la línea de las casillas del mapa de Paneles.

La línea de cada casilla salía solo de los snapshots del servidor, que existen
para los activos de la cartera y no para lo añadido a mano en Seguimiento
(índices, materias primas...). Aquí se piden las velas de cada ticker al feed
de TradingView, con la misma ventana que el periodo del mapa; el frontend usa
estas y, si un ticker no tiene, vuelve a los snapshots.

La caché va por ticker y periodo y guarda también los que no tienen velas, para
no volver a preguntar por ellos en cada refresco del mapa.

El gráfico de la ficha del activo usa las mismas velas (`velasDelGrafico`) para
cubrir lo que los snapshots no cubren: sin ellas, una compra anterior al primer
snapshot no tenía dónde colocar su punto.
"""

import logging
import re
import threading
import time
from collections.abc import Callable, Iterable

from core import settings
from providers import tradingview_feed

log = logging.getLogger(__name__)

# Periodo del mapa → (resolución del feed, velas). Las velas cubren la ventana
# del periodo con margen; el frontend recorta a la ventana exacta:
#   dia: 5 min × 300 = 25 h.   semana: 1 h × 200 ≈ 8 días.
#   mes: 4 h × 200 ≈ 33 días.  anyo/ytd: diarias × 380 ≈ 1 año natural.
PERIODOS = {
    "dia": ("5", 300),
    "semana": ("60", 200),
    "mes": ("240", 200),
    "anyo": ("1D", 380),
    "ytd": ("1D", 380),
}

# Tope por petición: un mapa con todos los activos ronda los 40; sin tope, una
# URL manipulada abriría cientos de sesiones en el feed.
MAX_SIMBOLOS = 80

# Ticker de TradingView, con mercado o sin él (BITVAVO:BTCEUR, TVC:UKOIL,
# NYSE:BRK.B, CME_MINI:ES1!, AAPL): el feed resuelve los dos.
_SIMBOLO_RE = re.compile(r"^(?:[A-Z0-9_]{1,30}:)?[A-Z0-9_.!&/\-]{1,40}$")

# Rango del gráfico de la ficha → (resolución, velas), con las mismas ventanas
# que los periodos del mapa. «TODO» no está: sus velas dependen de cuánto hay
# que cubrir (ver `_velasDeTodo`).
RANGOS_FICHA = {
    "1D": ("5", 300),
    "7D": ("60", 200),
    "30D": ("240", 200),
    "YTD": ("1D", 380),
    "1A": ("1D", 380),
}

# Velas diarias como mucho en «TODO». Comprobado contra el feed: sin sesión
# iniciada da 5000 (unos 20 años de bolsa) y con más no da más.
MAX_VELAS_DIARIAS = 5000
# Días de más en «TODO», para que la primera vela no caiga justo después de la
# primera operación (festivos, fines de semana).
_MARGEN_DIAS_TODO = 10
_DIA = 86400

# (ticker, periodo) -> (instante, [[ts, cierre], ...])
_cache: dict[tuple[str, str], tuple[float, list[list]]] = {}
# (ticker, rango, velas) -> (instante, (divisa, [[ts, cierre, máximo, mínimo], ...]) o None)
_cacheFicha: dict[tuple[str, str, int], tuple[float, tuple[str, list[list]] | None]] = {}
_cacheLock = threading.Lock()


class PeriodoInvalido(ValueError):
    """Periodo que no está en `PERIODOS`. La ruta lo traduce a un 400."""


class SimbolosInvalidos(ValueError):
    """Lista de tickers vacía, demasiado larga o con formato no válido. La ruta lo traduce a un 400."""


def normalizarSimbolos(simbolos: Iterable[str]) -> list[str]:
    """Tickers en mayúsculas, sin repetir y con forma de ticker de TradingView.

    Los que no tienen esa forma se descartan sin error: el mapa manda el ticker
    de cada casilla tal cual, y uno raro no debe dejar sin línea a las demás.

    Args:
        simbolos: Tickers tal como llegan en la petición.

    Returns:
        Los tickers válidos, en el orden en que llegaron.

    Raises:
        SimbolosInvalidos: Si no llega ninguno o pasan de `MAX_SIMBOLOS`.
    """
    limpios = list(dict.fromkeys(s.strip().upper() for s in simbolos if s and s.strip()))
    if not limpios:
        raise SimbolosInvalidos("symbols requerido")
    if len(limpios) > MAX_SIMBOLOS:
        raise SimbolosInvalidos(f"Como mucho {MAX_SIMBOLOS} símbolos por petición")
    return [s for s in limpios if _SIMBOLO_RE.match(s)]


def seriesDeSimbolos(
    simbolos: Iterable[str],
    periodo: str,
    fetch: Callable[..., dict] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, list[list]]:
    """Cierres de cada ticker en la ventana del periodo, de la caché o del feed.

    Un fallo del feed no es un error para el mapa: se devuelve lo que haya en
    caché y el frontend usa los snapshots para el resto.

    Args:
        simbolos: Tickers ya normalizados (`normalizarSimbolos`).
        periodo: Una clave de `PERIODOS`.
        fetch: Función que pide las velas; por defecto, `tradingview_feed.fetchSeries`.
        clock: Reloj monotónico, inyectable para los tests.

    Returns:
        `{ticker: [[ts, cierre], ...]}`, solo con los que tienen al menos dos velas.

    Raises:
        PeriodoInvalido: Si `periodo` no existe.
    """
    if periodo not in PERIODOS:
        raise PeriodoInvalido(f"Periodo no admitido: {periodo or 'vacío'}")
    resolucion, velas = PERIODOS[periodo]
    fetch = fetch or tradingview_feed.fetchSeries
    ttl = settings.serieMapaTtlSegundos()
    ahora = clock()

    resultado, faltan = _leerCache(simbolos, periodo, ahora, ttl)
    if faltan:
        try:
            nuevas = fetch(faltan, resolucion, velas)
        except OSError as error:
            log.warning("No se pudieron pedir las velas de TradingView (%s): %s", periodo, error)
            nuevas = None
        if nuevas is not None:
            nuevas = {s: [[ts, cierre] for ts, cierre in nuevas.get(s, [])] for s in faltan}
            if ttl > 0:
                with _cacheLock:
                    _cache.update({(s, periodo): (ahora, puntos) for s, puntos in nuevas.items()})
            resultado.update(nuevas)

    return {s: puntos for s, puntos in resultado.items() if len(puntos) >= 2}


def _leerCache(
    simbolos: Iterable[str], periodo: str, ahora: float, ttl: int
) -> tuple[dict[str, list[list]], list[str]]:
    """Separa los tickers con velas vigentes en caché de los que hay que pedir."""
    resultado: dict[str, list[list]] = {}
    faltan: list[str] = []
    with _cacheLock:
        for simbolo in simbolos:
            guardado = _cache.get((simbolo, periodo))
            if guardado and ttl > 0 and ahora - guardado[0] < ttl:
                resultado[simbolo] = guardado[1]
            else:
                faltan.append(simbolo)
    return resultado, faltan


def _velasDeTodo(desdeTs: int, ahoraTs: float) -> int:
    """Velas diarias que cubren desde `desdeTs` hasta hoy, con margen y tope."""
    if desdeTs <= 0:
        return MAX_VELAS_DIARIAS
    dias = int((ahoraTs - desdeTs) // _DIA) + 1 + _MARGEN_DIAS_TODO
    return max(2, min(MAX_VELAS_DIARIAS, dias))


def velasDelGrafico(
    simbolo: str,
    rango: str,
    desdeTs: int = 0,
    ahoraTs: float | None = None,
    fetch: Callable[..., dict] | None = None,
    clock: Callable[[], float] = time.monotonic,
) -> tuple[str, list[list]] | None:
    """Velas de un ticker para el gráfico de la ficha de su activo, con su divisa.

    Como en el mapa, un fallo del feed no es un error: el gráfico se queda con
    los snapshots. Sin divisa tampoco sirven, porque no se pueden pasar a euros.

    Args:
        simbolo: Ticker ya normalizado (`normalizarSimbolos`).
        rango: Clave de `RANGOS_FICHA` o "TODO".
        desdeTs: En «TODO», desde cuándo hay que cubrir; 0 pide el máximo.
        ahoraTs: Instante actual (epoch), para contar los días de «TODO».
        fetch: Función que pide las velas; por defecto,
            `tradingview_feed.fetchSeriesWithCurrency`.
        clock: Reloj monotónico de la caché, inyectable para los tests.

    Returns:
        `(divisa, [[ts, cierre, máximo, mínimo], ...])` con al menos dos velas, o None.

    Raises:
        PeriodoInvalido: Si `rango` no existe.
    """
    if rango == "TODO":
        resolucion = "1D"
        velas = _velasDeTodo(desdeTs, time.time() if ahoraTs is None else ahoraTs)
    elif rango in RANGOS_FICHA:
        resolucion, velas = RANGOS_FICHA[rango]
    else:
        raise PeriodoInvalido(f"Rango no admitido: {rango or 'vacío'}")

    clave = (simbolo, rango, velas)
    ttl = settings.serieMapaTtlSegundos()
    ahora = clock()
    with _cacheLock:
        guardado = _cacheFicha.get(clave)
    if guardado and ttl > 0 and ahora - guardado[0] < ttl:
        return guardado[1]

    fetch = fetch or tradingview_feed.fetchSeriesWithCurrency
    try:
        respuesta = fetch([simbolo], resolucion, velas)
    except OSError as error:
        # Sin caché: el siguiente intento puede ir bien.
        log.warning("No se pudieron pedir las velas de %s (%s): %s", simbolo, rango, error)
        return None

    divisa, cierres = respuesta.get(simbolo, (None, []))
    resultado = (divisa, [list(vela) for vela in cierres]) if divisa and len(cierres) >= 2 else None
    if ttl > 0:
        with _cacheLock:
            _cacheFicha[clave] = (ahora, resultado)
    return resultado


def vaciarCache() -> None:
    """Vacía la caché de velas (para los tests)."""
    with _cacheLock:
        _cache.clear()
        _cacheFicha.clear()
