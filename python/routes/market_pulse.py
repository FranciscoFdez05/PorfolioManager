from urllib.error import HTTPError, URLError

from flask import Blueprint, jsonify, request

from stores import market_pulse

market_pulse_bp = Blueprint("market_pulse", __name__)


def _tradingview_error_message(error):
    if isinstance(error, HTTPError):
        return f"TradingView devolvió HTTP {error.code}"
    return f"No se pudo conectar con TradingView: {error.reason}"


@market_pulse_bp.route("/api/market/pulse", methods=["GET"])
def getMarketPulse():
    """Índices, sectores, amplitud, mayores subidas/bajadas, extremos de RSI,
    volumen inusual y el Fear & Greed de cripto, para la página de
    Sentimiento de mercado.

    Cada sección se pide por separado: si el screener falla pero el scanner de
    cotizaciones va bien (o al revés), se devuelve lo que sí llegó con la
    sección que falló a `None` y su propio error, en vez de tirar toda la
    respuesta por un fallo parcial.
    """
    resultado = {"ok": True}

    try:
        resultado["snapshot"] = market_pulse.snapshot()
    except (HTTPError, URLError) as error:
        resultado["snapshot"] = None
        resultado["snapshotError"] = _tradingview_error_message(error)

    try:
        resultado["movers"] = market_pulse.top_movers(limit=10)
    except (HTTPError, URLError) as error:
        resultado["movers"] = None
        resultado["moversError"] = _tradingview_error_message(error)

    try:
        resultado["breadth"] = market_pulse.breadth()
    except (HTTPError, URLError) as error:
        resultado["breadth"] = None
        resultado["breadthError"] = _tradingview_error_message(error)

    try:
        resultado["rsi"] = market_pulse.rsi_extremes(limit=8)
    except (HTTPError, URLError) as error:
        resultado["rsi"] = None
        resultado["rsiError"] = _tradingview_error_message(error)

    try:
        resultado["unusualVolume"] = market_pulse.unusual_volume(limit=8)
    except (HTTPError, URLError) as error:
        resultado["unusualVolume"] = None
        resultado["unusualVolumeError"] = _tradingview_error_message(error)

    fear_greed_datos, fear_greed_error = market_pulse.fear_greed()
    resultado["fearGreed"] = fear_greed_datos
    if fear_greed_error:
        resultado["fearGreedError"] = fear_greed_error

    fear_greed_historia, fear_greed_historia_error = market_pulse.fear_greed_history()
    resultado["fearGreedHistory"] = fear_greed_historia
    if fear_greed_historia_error:
        resultado["fearGreedHistoryError"] = fear_greed_historia_error

    return jsonify(resultado)


@market_pulse_bp.route("/api/market/pulse/universe", methods=["GET"])
def getMarketPulseUniverse():
    """Las filas del treemap de "Distribución" para el universo pedido
    (`sp500`, `cripto` o `nasdaq100`), ya en la misma forma para los tres: el
    mosaico no sabe ni le importa si detrás hay un ETF de sector, una
    criptomoneda o una acción del Nasdaq 100.
    """
    clave = str(request.args.get("type", "sp500")).strip().lower()

    try:
        items = market_pulse.universe(clave)
    except (HTTPError, URLError) as error:
        return jsonify({"ok": False, "error": _tradingview_error_message(error)}), 503

    if items is None:
        return jsonify({"ok": False, "error": "Universo desconocido"}), 400

    return jsonify({"ok": True, "universe": clave, "items": items})
