"""Valora la cartera en el servidor, sin navegador de por medio.

Hasta ahora la única cifra de "cuánto vale el portfolio" la calculaba el
frontend (`refreshTopPortfolioMetrics`) y el servidor se limitaba a guardarla.
Eso ataba el histórico a que hubiera una pestaña abierta, y desde que la
rentabilidad anual se calcula con Modified Dietz sobre esos puntos, cada semana
sin abrir la web degradaba la métrica.

Las piezas se reutilizan, no se reimplementan:

  * la posición viva y su coste salen del FIFO del servidor
    (`ventas_fifo.carteraViva`), el mismo motor que liquida las ventas;
  * las cotizaciones, de `stores.market_data`, el mismo despacho por proveedor
    que usa `/api/market/quote`;
  * el cambio a euros, de `fetchExchangeRate`, que no gasta clave de API.

Lo que devuelve tiene la forma que espera `routes.snapshots.guardarSnapshot`,
que es la misma que manda el frontend.
"""

import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal

from core import dinero, paths, settings, telegram_notifier
from core.db import getActiveDbPath, getDb
from providers.finnhub_client import fetchExchangeRate
from stores import fx_historico, rendimiento_activo, ventas_fifo
from stores.helpers import normalizeCurrencyCode
from stores.market_data import fetchAssetQuote

log = logging.getLogger(__name__)

# Política cuando falta un dato. Un activo sin precio o un cambio caído no deben
# dejar el histórico sin puntos, pero tampoco aportar 0 € ni un precio inventado:
#
#   * Activo que tuvo precio: se valora con el último que se conoce (el
#     almacenado, o el último valor guardado en el histórico entre las
#     participaciones de entonces).
#   * Activo que nunca lo tuvo: se valora a su coste (invertido neto).
#   * Cambio de divisa ausente: el último conocido de la caché de la base; si no
#     hay ninguno, el punto no se puede dar.
#
# Todo fallback se registra y se marca. Si lo valorado así pesa más de
# `_FALLBACK_MAXIMO` de la cartera, el total no es fiable y el punto se omite.
_FALLBACK_MAXIMO = Decimal("0.20")
_HORAS_AVISO_FALLBACK = 6
_SEGUNDOS_AVISO_OMISION = 3600
_COOLDOWN_AVISO = 7 * 86400


class _Cambios:
    """Tipos de cambio a euros pedidos una sola vez por ejecución.

    El tipo llega del proveedor como float —ahí no hay elección— pero se guarda
    y se aplica como Decimal: este multiplicador entra en el valor de **toda**
    la cartera, y era el punto donde el error de coma flotante se amplificaba
    por el importe más grande del cálculo.
    """

    def __init__(self):
        self._cache = {"EUR": Decimal("1")}
        # Divisas sin ningún tipo conocido, valoradas 1:1: el total que sale con
        # ellas no es fiable y quien guarda el punto debe saberlo.
        self.sinTipo = set()
        # Divisas valoradas con el último tipo de la caché porque el proveedor falló.
        self.obsoletos = set()

    def aEuros(self, importe, moneda):
        divisa = normalizeCurrencyCode(moneda, fallback="EUR")
        if divisa not in self._cache:
            rate, error = fetchExchangeRate(divisa, "EUR")
            if error or not rate or rate <= 0:
                conocido, _origen, _fecha = fx_historico.tasaActual(divisa, permitirDescarga=False)
                if conocido is not None and conocido > 0:
                    log.warning("[valoracion] Sin cambio %s→EUR (%s); se usa el último conocido", divisa, error)
                    rate = conocido
                    self.obsoletos.add(divisa)
                else:
                    log.warning("[valoracion] Sin cambio %s→EUR (%s); se valora 1:1", divisa, error)
                    rate = 1
                    self.sinTipo.add(divisa)
            self._cache[divisa] = dinero.aDecimal(rate, "tipo de cambio", defecto=Decimal("1"))
        return dinero.aDecimal(importe) * self._cache[divisa]


def _activosEnCartera():
    """Datos de mercado de los activos que tienen posición viva."""
    cartera = ventas_fifo.carteraViva()
    if not cartera:
        return []

    conn = getDb()
    filas = conn.execute(
        "SELECT id, type, market_provider, market_symbol, finnhub_symbol, price, currency FROM activos"
    ).fetchall()

    activos = []
    for fila in filas:
        posicion = cartera.get(fila["id"])
        if posicion is None:
            continue
        moneda = normalizeCurrencyCode(fila["currency"], fallback="EUR")
        activos.append({
            "id":        fila["id"],
            "tipo":      fila["type"],
            "proveedor": fila["market_provider"],
            "simbolo":   str(fila["market_symbol"] or fila["finnhub_symbol"] or "").strip(),
            # `price` es una columna TEXT en formato español; `dinero` la lee
            # sin pasar por float, que es lo que hacía `_parse_num`.
            "precio":    dinero.aDecimal(fila["price"], "precio", defecto=Decimal("0")),
            "moneda":    moneda,
            # La cotización puede venir en otra divisa que la de la ficha, y el
            # coste está apuntado en la de la ficha: se guardan por separado
            # para no convertir el invertido con el cambio equivocado.
            "monedaCoste": moneda,
            # El FIFO ya las devuelve en Decimal: convertirlas a float aquí
            # tiraba la precisión del único motor que la mantenía.
            "cantidad":  posicion["cantidad"],
            "coste":     posicion["invertido"],
        })

    return activos


def _refrescarPrecios(activos):
    """Pide cotización fresca de cada activo. Devuelve cuántas se obtuvieron.

    Un fallo no invalida el snapshot: ese activo se valora con el último precio
    conocido. Un hueco en el histórico hace más daño que un punto con un precio
    de hace unas horas, y el aviso queda en el log.
    """
    conSimbolo = [a for a in activos if a["simbolo"]]
    if not conSimbolo:
        return 0

    def _pedir(activo):
        try:
            return activo, fetchAssetQuote(activo["simbolo"], activo["proveedor"])
        except Exception as e:  # el hilo del scheduler no puede morir por esto
            return activo, (None, str(e))

    frescos = 0
    with ThreadPoolExecutor(max_workers=settings.maxPeticionesParalelas()) as pool:
        for activo, (quote, error) in pool.map(_pedir, conSimbolo):
            # `price` viene formateado a la española ("345,90"): float() directo
            # reventaba aquí, fuera del try de `_pedir`, y se llevaba por delante
            # el snapshot entero de la cartera por un solo activo. `dinero` lo
            # lee en Decimal y devuelve el defecto si no hay dato, que es lo que
            # descarta el activo unas líneas más abajo.
            precio = dinero.aDecimal((quote or {}).get("price"), "cotización", defecto=Decimal("0"))
            if error or precio <= 0:
                log.info("[valoracion] %s conserva su último precio (%s)", activo["id"], error or "sin cotización")
                continue
            activo["precio"] = precio
            activo["moneda"] = normalizeCurrencyCode((quote or {}).get("currency"), fallback=activo["moneda"])
            frescos += 1

    return frescos


def _ultimoPrecioConocido(conn, activo, posiciones):
    """Precio en euros por participación según el último valor del histórico, o None.

    El histórico guarda el valor de la posición, no el precio: se divide entre las
    participaciones que había en esa fecha, reconstruidas con las operaciones.
    """
    fila = conn.execute(
        "SELECT ts, price_eur FROM asset_snapshots WHERE asset_id = ? AND price_eur > 0 ORDER BY ts DESC LIMIT 1",
        (activo["id"],),
    ).fetchone()
    datos = posiciones.get(activo["id"])
    if fila is None or not datos:
        return None
    lotes = rendimiento_activo.lotesVivos(
        datos["filas"], datos["operaciones"], str(activo.get("tipo") or "").strip().lower() == "cripto",
        datos["ventas"], date.fromtimestamp(fila["ts"]), datos["transacciones"], datos["conversiones"],
    )
    cantidad = sum((lote["cantidad"] for lote in lotes), Decimal("0"))
    if cantidad <= 0:
        return None
    return dinero.aDecimal(fila["price_eur"]) / cantidad


def _estadoDeFallbacks():
    return paths.TMP_DIR / "valoracion-fallbacks.json"


def _leerEstado():
    try:
        datos = json.loads(_estadoDeFallbacks().read_text("utf-8"))
        return datos if isinstance(datos, dict) else {}
    except (OSError, ValueError):
        return {}


def _guardarEstado(datos):
    from core.escritura import escribirJsonAtomico

    try:
        escribirJsonAtomico(_estadoDeFallbacks(), datos)
    except OSError as error:
        log.warning("[valoracion] No se pudo guardar el estado de los fallbacks: %s", error)


def registrarFallbacks(fallbacks, ahora=None):
    """Avisa por Telegram, una sola vez, de los activos que llevan horas valorados con fallback.

    El primer instante en que se vio cada fallback se recuerda en `data/tmp`; los
    que dejan de estar se olvidan, así que si vuelven a fallar empieza otra
    cuenta. El aviso respeta las categorías y el silencio de Telegram y se
    coordina entre workers.
    """
    ahora = time.time() if ahora is None else ahora
    cartera = getActiveDbPath().stem
    anterior = _leerEstado()
    estado = {}
    for item in fallbacks:
        clave = f"{cartera}|{item['id']}|{item['motivo']}"
        estado[clave] = anterior.get(clave, ahora)
        if ahora - estado[clave] > _HORAS_AVISO_FALLBACK * 3600:
            telegram_notifier.notificar(
                "proveedores",
                f"Cartera {cartera}: «{item['id']}» lleva más de {_HORAS_AVISO_FALLBACK} h valorado "
                f"con un valor de reserva ({item['motivo']}). Revisa su cotización.",
                clave=f"fallback-{clave}", cooldown=_COOLDOWN_AVISO, compartido=True,
            )
    # Se conserva lo de otras carteras: el estado es común a todas.
    otras = {k: v for k, v in anterior.items() if not k.startswith(f"{cartera}|")}
    _guardarEstado({**otras, **estado})


def registrarOmision(omitido, ahora=None):
    """Avisa una vez si llevan más de una hora seguidas omitiéndose los snapshots."""
    ahora = time.time() if ahora is None else ahora
    cartera = getActiveDbPath().stem
    clave = f"omision|{cartera}"
    estado = _leerEstado()
    if not omitido:
        if clave in estado:
            estado.pop(clave)
            _guardarEstado(estado)
        return
    desde = estado.get(clave, ahora)
    if clave not in estado:
        estado[clave] = desde
        _guardarEstado(estado)
    if ahora - desde > _SEGUNDOS_AVISO_OMISION:
        telegram_notifier.notificar(
            "sistema",
            f"Cartera {cartera}: llevan más de una hora sin guardarse snapshots porque la valoración "
            "no es fiable (faltan precios o tipos de cambio).",
            clave=f"omision-{cartera}", cooldown=_COOLDOWN_AVISO, compartido=True,
        )


def valorarPortfolio(refrescarPrecios=True):
    """Valor y coste de la cartera en euros, más el desglose por activo.

    Devuelve `{"total_value", "total_invested", "assets": [{"id", "v", "c"}],
    "precios_frescos", "activos": n, "completa", "fallbacks"}`. Los activos sin
    precio se valoran con un valor de reserva (ver la política arriba) y salen en
    `fallbacks`; `completa` es False si lo valorado así pesa demasiado o falta
    algún tipo de cambio.
    """
    activos = _activosEnCartera()
    frescos = _refrescarPrecios(activos) if refrescarPrecios else 0

    cambios = _Cambios()
    totalValue = Decimal("0")
    totalInvested = Decimal("0")
    valorDeReserva = Decimal("0")
    desglose = []
    fallbacks = []
    conn = getDb()
    posiciones = rendimiento_activo.cargarPosiciones(conn) if any(a["precio"] <= 0 for a in activos) else {}

    for activo in activos:
        costeEur = cambios.aEuros(activo["coste"], activo["monedaCoste"])
        motivo = ""
        if activo["precio"] <= 0:
            previo = _ultimoPrecioConocido(conn, activo, posiciones)
            if previo is not None:
                valorEur = activo["cantidad"] * previo
                motivo = "ultimo_precio_conocido"
            else:
                # Nunca ha tenido precio: a su coste, que es la práctica habitual.
                valorEur = costeEur
                motivo = "sin_precio_valorado_a_coste"
            log.warning("[valoracion] %s sin precio: se valora con un valor de reserva (%s)", activo["id"], motivo)
            fallbacks.append({"id": activo["id"], "motivo": motivo})
            valorDeReserva += valorEur
        else:
            valorEur = cambios.aEuros(activo["cantidad"] * activo["precio"], activo["moneda"])

        totalValue += valorEur
        totalInvested += costeEur
        if valorEur > 0:
            # `float` aquí y no antes: las columnas del histórico son REAL, así
            # que el punto acaba en coma flotante igualmente. La diferencia es
            # que ahora se convierte **el total ya sumado en Decimal** en vez de
            # ir acumulando el error activo a activo.
            desglose.append({
                "id": activo["id"],
                "v": float(dinero.redondear(valorEur)),
                "c": float(dinero.redondear(costeEur)),
            })

    return {
        "total_value":     float(dinero.redondear(totalValue)),
        "total_invested":  float(dinero.redondear(totalInvested)),
        "assets":          desglose,
        "precios_frescos": frescos,
        "activos":         len(activos),
        "fallbacks":       fallbacks,
        "tiposObsoletos":  sorted(cambios.obsoletos),
        # False si falta algún tipo de cambio, o si lo valorado con un valor de
        # reserva pesa más de `_FALLBACK_MAXIMO` de la cartera: el total sería
        # una aproximación y no debe entrar en el histórico.
        "completa":        not cambios.sinTipo and (
            valorDeReserva == 0 or (totalValue > 0 and valorDeReserva / totalValue <= _FALLBACK_MAXIMO)
        ),
    }
