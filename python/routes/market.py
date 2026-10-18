import logging
import os
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from urllib.error import HTTPError, URLError

from flask import Blueprint, jsonify, request

from core import dinero, paths, settings
from core.db import getActiveDbPath, getDb
from providers.alpha_vantage_client import searchSymbol as searchAvSymbol
from providers.eodhd_client import searchSymbol as buscarSimboloEodhd
from providers.finnhub_client import (
    fetchCandleClose,
    fetchCurrencies,
    fetchExchangeRate,
    fetchExchangeRates,
    searchSymbol,
)
from providers.http import motivoConexion
from providers.tradingview_client import (
    fetchStats as fetchTradingviewStats,
    searchSymbol as searchTradingviewSymbol,
)
from providers.yahoo_finance_client import searchSymbol as buscarSimboloYahoo
from stores import benchmark
from stores.asset_store import listAssets
from stores.asset_utils import SUPPORTED_ASSET_CURRENCIES
from stores.divisas_historico import HistoricoInvalido, historicoPar
from stores.helpers import (
    callAlphaVantageWithFallbacks,
    callEodhdWithFallbacks,
    callFinnhubWithFallbacks,
    isTemporaryServiceError,
    normalizeCurrencyCode,
    parseLooseNumber,
)
from stores.market_data import fetchAssetQuote

log = logging.getLogger(__name__)

# {(ruta de la cartera, periodo): {"data": {...}, "ts": float, "marca": float}}
# La cartera va en la clave: con solo el periodo, tras cambiar de cartera se
# servían durante horas las variaciones de los activos de la anterior.
_histCache = {}


def _ficheroInvalidacion():
    return paths.TMP_DIR / "historico-invalidado"


def _marcaInvalidacion() -> float:
    """Cuándo se invalidó la caché por última vez, en cualquier worker.

    La caché vive en la memoria de cada proceso, y /invalidate solo vaciaba la
    del worker que atendía la petición: el otro seguía sirviendo lo viejo. Con
    una marca en disco (un stat por petición) todos se enteran.
    """
    try:
        return _ficheroInvalidacion().stat().st_mtime
    except OSError:
        return 0.0

marketBp = Blueprint("market", __name__)


@marketBp.route("/api/exchange-rate", methods=["GET"])
def getExchangeRate():
    sourceCurrency = normalizeCurrencyCode(
        request.args.get("source") or request.args.get("from", ""), fallback="EUR"
    )
    targetCurrency = normalizeCurrencyCode(
        request.args.get("target") or request.args.get("to", ""), fallback=sourceCurrency
    )

    if sourceCurrency == targetCurrency:
        return jsonify({"ok": True, "source": sourceCurrency, "target": targetCurrency, "rate": 1.0})

    rate, error = fetchExchangeRate(sourceCurrency, targetCurrency)

    if error:
        statusCode = 503 if isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "source": sourceCurrency, "target": targetCurrency, "rate": rate})


@marketBp.route("/api/divisas", methods=["GET"])
def listDivisas():
    """Divisas a las que se puede pasar un activo ahora mismo, con su nombre.

    Las que admite el activo, filtradas por las que publica hoy el servicio de
    cambio: si dejara de convertir una, desaparece del selector en vez de
    fallar al guardar. Sin respuesta del servicio se ofrecen todas las del
    activo, y la conversión dirá en su momento si alguna no se puede hacer.
    """
    publicadas, error = fetchCurrencies()
    codigos = sorted(SUPPORTED_ASSET_CURRENCIES)

    if error:
        return jsonify({
            "ok": True,
            "divisas": [{"code": codigo, "name": codigo} for codigo in codigos],
            "aviso": error,
        })

    return jsonify({
        "ok": True,
        "divisas": [{"code": codigo, "name": publicadas[codigo]} for codigo in codigos if codigo in publicadas],
    })


@marketBp.route("/api/divisas/historico", methods=["GET"])
def getHistoricoDivisas():
    """Serie de un par de divisas para el comparador de Herramientas."""
    try:
        datos, error = historicoPar(
            request.args.get("base"), request.args.get("quote"), request.args.get("rango", "1M")
        )
    except HistoricoInvalido as invalido:
        return jsonify({"ok": False, "error": str(invalido)}), 400

    if error:
        return jsonify({"ok": False, "error": error}), 502

    return jsonify({"ok": True, **datos})


@marketBp.route("/api/divisas/cambio", methods=["GET"])
def getCambiosDivisa():
    """Comprobación del servicio de cambio para Ajustes: los tipos de `base` a
    las demás divisas del activo, de dónde salen, de qué fecha son y cuánto
    tardó en contestar. Es la misma fuente que usa la conversión de cotizaciones.
    """
    base = normalizeCurrencyCode(request.args.get("base", ""), fallback="EUR")
    if base not in SUPPORTED_ASSET_CURRENCIES:
        return jsonify({"ok": False, "error": f"Divisa no admitida: {base}"}), 400

    inicio = time.monotonic()
    datos, error = fetchExchangeRates(base, sorted(SUPPORTED_ASSET_CURRENCIES - {base}))
    ms = round((time.monotonic() - inicio) * 1000)

    if error:
        return jsonify({"ok": False, "error": error, "ms": ms}), 503

    nombres, _ = fetchCurrencies()
    nombres = nombres or {}
    return jsonify({
        "ok": True,
        "base": base,
        "fuente": datos["fuente"],
        "fecha": datos["fecha"],
        "ms": ms,
        "comprobado": datetime.now().astimezone().isoformat(timespec="seconds"),
        "cambios": [
            {"code": codigo, "name": nombres.get(codigo, codigo), "rate": rate}
            for codigo, rate in sorted(datos["rates"].items())
        ],
    })


@marketBp.route("/api/finnhub/search", methods=["GET"])
@marketBp.route("/api/market/search", methods=["GET"])
def searchFinnhubSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = callFinnhubWithFallbacks(
        lambda apiKey: searchSymbol(query, apiKey, assetName=assetName, preferredAssetType=assetType)
    )

    if error:
        statusCode = 503 if "API key" in error or isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@marketBp.route("/api/historical-changes", methods=["GET"])
def getHistoricalChanges():
    period = str(request.args.get("period", "semana")).strip().lower()
    if period not in ("semana", "mes", "ytd", "anyo"):
        return jsonify({"ok": False, "error": "Periodo inválido"}), 400

    # TTL 0 en [mercado] historico_ttl_segundos desactiva la caché: útil para
    # depurar sin tener que esperar a que caduque.
    ttl = settings.historicoTtlSegundos()
    clave = (str(getActiveDbPath()), period)
    marca = _marcaInvalidacion()
    cached = _histCache.get(clave)
    if ttl > 0 and cached and cached.get("marca") == marca and time.time() - cached["ts"] < ttl:
        return jsonify({"ok": True, "data": cached["data"], "cached": True})

    now = datetime.utcnow()
    if period == "semana":
        target = now - timedelta(days=7)
    elif period == "mes":
        target = now - timedelta(days=30)
    elif period == "ytd":
        target = datetime(now.year, 1, 2)
    else:
        target = now - timedelta(days=365)

    fromTs    = int(target.timestamp())
    safeLimit = int((now - timedelta(days=2)).timestamp())
    toTs      = min(fromTs + 10 * 86400, safeLimit)

    conn   = getDb()
    result = {}

    # Snapshot más reciente por activo (valor actual)
    latest: dict[str, float] = {}
    for row in conn.execute(
        "SELECT asset_id, price_eur FROM asset_snapshots "
        "WHERE ts = (SELECT MAX(ts) FROM asset_snapshots)"
    ).fetchall():
        latest[row["asset_id"]] = row["price_eur"]

    # Snapshot del periodo objetivo por activo (primer registro en la ventana)
    past: dict[str, float] = {}
    for row in conn.execute(
        "SELECT asset_id, price_eur FROM asset_snapshots "
        "WHERE ts BETWEEN ? AND ? ORDER BY ts ASC",
        (fromTs, toTs)
    ).fetchall():
        if row["asset_id"] not in past:
            past[row["asset_id"]] = row["price_eur"]

    assetsNeedingApi = []
    for asset in listAssets():
        aid  = asset["id"]
        cur  = latest.get(aid)
        prev = past.get(aid)
        if cur and prev and prev > 0:
            result[aid] = round((cur - prev) / prev * 100, 2)
        elif asset.get("marketSymbol") or asset.get("finnhubSymbol"):
            assetsNeedingApi.append(asset)

    # Fallback a Finnhub para activos sin snapshots almacenados
    if assetsNeedingApi:
        def fetchOne(asset):
            symbol    = str(asset.get("marketSymbol") or asset.get("finnhubSymbol") or "").strip()
            curPrice = parseLooseNumber(asset.get("price"))
            if not symbol or not curPrice or curPrice <= 0:
                return asset["id"], None
            histPrice, _ = callFinnhubWithFallbacks(
                lambda apiKey: fetchCandleClose(symbol, fromTs, toTs, apiKey)
            )
            if not histPrice or histPrice <= 0:
                return asset["id"], None
            # El precio actual sale de una columna TEXT (Decimal) y el histórico
            # de la API de Finnhub (float). Restarlos directamente es un
            # TypeError, así que el float del proveedor entra por `dinero`, que
            # lo convierte por su representación más corta en vez de arrastrar
            # la cola binaria.
            hist = dinero.aDecimal(histPrice, "precio histórico")
            variacion = (curPrice - hist) / hist * 100
            return asset["id"], float(dinero.redondear(variacion))

        with ThreadPoolExecutor(max_workers=settings.maxPeticionesParalelas()) as pool:
            futures = {pool.submit(fetchOne, a): a for a in assetsNeedingApi}
            for f in as_completed(futures):
                assetId, pct = f.result()
                if pct is not None:
                    result[assetId] = pct

    _histCache[clave] = {"data": result, "ts": time.time(), "marca": marca}
    return jsonify({"ok": True, "data": result, "cached": False})


@marketBp.route("/api/market/benchmarks", methods=["GET"])
def listBenchmarks():
    return jsonify({"ok": True, "indices": benchmark.catalogo()})


@marketBp.route("/api/market/benchmark", methods=["GET"])
def getBenchmark():
    """Cierres diarios del índice pedido, para superponerlo a la evolución."""
    clave = request.args.get("indice", "")
    ahora = int(time.time())
    try:
        desde = int(request.args.get("from") or (ahora - 365 * 86400))
        hasta = int(request.args.get("to") or ahora)
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Rango inválido"}), 400
    if desde >= hasta:
        return jsonify({"ok": False, "error": "Rango inválido"}), 400

    datos, error = benchmark.serie(clave, desde, hasta)
    if error:
        statusCode = 503 if isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, **datos})


@marketBp.route("/api/historical-changes/invalidate", methods=["POST"])
def invalidateHistoricalCache():
    _histCache.clear()
    # Para los demás workers: su caché se descarta al ver la marca nueva.
    try:
        ruta = _ficheroInvalidacion()
        ruta.parent.mkdir(parents=True, exist_ok=True)
        ruta.touch()
        ahora = time.time()
        os.utime(ruta, (ahora, ahora))
    except OSError as error:
        log.warning("No se pudo marcar la caché de variaciones como invalidada: %s", error)
    return jsonify({"ok": True})


@marketBp.route("/api/eodhd/search", methods=["GET"])
def searchEodhdSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = callEodhdWithFallbacks(
        lambda apiKey: buscarSimboloEodhd(query, apiKey, assetName=assetName, preferredAssetType=assetType)
    )

    if error:
        statusCode = 503 if "API key" in error or isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@marketBp.route("/api/yahoo/search", methods=["GET"])
def searchYahooSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = buscarSimboloYahoo(query, assetName=assetName, preferredAssetType=assetType)

    if error:
        statusCode = 503 if isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@marketBp.route("/api/alphavantage/search", methods=["GET"])
def searchAlphaVantageSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = callAlphaVantageWithFallbacks(
        lambda apiKey: searchAvSymbol(query, apiKey, assetName=assetName, preferredAssetType=assetType)
    )

    if error:
        statusCode = 503 if "API key" in error or isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})

@marketBp.route("/api/tradingview/search", methods=["GET"])
def searchTradingViewSymbol():
    query = str(request.args.get("q", "")).strip()
    assetName = str(request.args.get("assetName", "")).strip()
    assetType = str(request.args.get("assetType", "")).strip()
    results, error = searchTradingviewSymbol(query, assetName=assetName, preferredAssetType=assetType)

    if error:
        statusCode = 503 if isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({"ok": True, "results": results})


@marketBp.route("/api/tradingview/stats", methods=["GET"])
def getTradingViewStats():
    """Fundamentales y técnico del scanner de TradingView, para la página de
    Estadísticas de mercado.

    Los tickers ya vienen resueltos por el frontend (`buildTVSymbol`, el mismo
    que abre el gráfico de cada activo): aquí no se adivina ni se completa
    ningún ticker, solo se pide al scanner lo que llega en la petición.
    """
    rawSymbols = str(request.args.get("symbols", "")).strip()
    symbols = sorted({s.strip().upper() for s in rawSymbols.split(",") if s.strip()})

    if not symbols:
        return jsonify({"ok": False, "error": "symbols requerido"}), 400

    try:
        stats = fetchTradingviewStats(symbols)
    except HTTPError as error:
        return jsonify({"ok": False, "error": f"TradingView devolvió HTTP {error.code}"}), 503
    except URLError as error:
        return jsonify({"ok": False, "error": f"No se pudo conectar con TradingView: {motivoConexion(error, 'TradingView')}"}), 503

    return jsonify({"ok": True, "data": stats})


@marketBp.route("/api/market/quote", methods=["GET"])
def getMarketQuote():
    symbol = str(request.args.get("symbol", "")).strip().upper()
    providerRaw = str(request.args.get("provider", "")).strip()

    if not symbol:
        return jsonify({"ok": False, "error": "symbol requerido"}), 400

    quote, error = fetchAssetQuote(symbol, providerRaw)

    if error:
        statusCode = 503 if "API key" in error or isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    return jsonify({
        "ok":          True,
        "price":       quote.get("price"),
        "change":      quote.get("change"),
        "currency":    quote.get("currency", "EUR"),
        "lastUpdated": quote.get("lastUpdated"),
    })
