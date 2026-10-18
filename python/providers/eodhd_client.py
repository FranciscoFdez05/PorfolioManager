from datetime import datetime
from urllib.error import HTTPError, URLError
from urllib.parse import quote

from providers import (
    compactSymbol as _compactSymbol,
    fetchJson,
    formatDecimal as _formatDecimal,
    formatPercent as _formatPercent,
    normalizeText as _normalizeText,
    safeFloat as _safeFloat,
)

EODHD_SEARCH_URL = "https://eodhd.com/api/search"
EODHD_REALTIME_URL = "https://eodhd.com/api/real-time"

# Divisa en la que cotiza cada mercado de EODHD, por el sufijo del símbolo.
# `search` sí devuelve el campo `Currency`, pero `real-time` —de donde salen
# las cotizaciones— no lo trae nunca, así que hay que deducirlo del símbolo.
EXCHANGE_CURRENCIES = {
    "US": "USD", "NYSE": "USD", "NASDAQ": "USD", "AMEX": "USD", "BATS": "USD",
    "NMFQS": "USD", "OTC": "USD", "PINK": "USD", "INDX": "USD",
    "TO": "CAD", "V": "CAD", "NEO": "CAD",
    "XETRA": "EUR", "F": "EUR", "BE": "EUR", "DU": "EUR", "HM": "EUR",
    "HA": "EUR", "MU": "EUR", "STU": "EUR",
    "MC": "EUR", "PA": "EUR", "MI": "EUR", "AS": "EUR", "BR": "EUR",
    "LS": "EUR", "VI": "EUR", "IR": "EUR", "HE": "EUR", "AT": "EUR",
    "TL": "EUR", "RG": "EUR", "VS": "EUR",
    # La bolsa de Londres cotiza en peniques, no en libras. Etiquetarlo "GBP"
    # multiplicaría por cien el valor del activo; "GBX" no tiene conversión
    # automática, así que la aplicación lo dice en vez de inventárselo.
    "LSE": "GBX", "L": "GBX",
    "IL": "USD",
    "SW": "CHF", "VX": "CHF",
    "ST": "SEK", "CO": "DKK", "OL": "NOK", "IC": "ISK",
    "WAR": "PLN", "PR": "CZK", "BUD": "HUF", "RO": "RON",
    "AU": "AUD", "NZ": "NZD", "JP": "JPY", "HK": "HKD", "SG": "SGD",
    "KO": "KRW", "KQ": "KRW", "SHG": "CNY", "SHE": "CNY", "TW": "TWD",
    "NSE": "INR", "BSE": "INR", "JK": "IDR", "BK": "THB", "KLSE": "MYR",
    "SA": "BRL", "MX": "MXN", "SN": "CLP", "BA": "ARS",
    "IS": "TRY", "JSE": "ZAR", "TA": "ILS", "CA": "EGP",
}


def inferCurrencyFromSymbol(symbol, fallback="EUR"):
    """Divisa de la cotización, deducida del sufijo de mercado.

    `real-time` no devuelve el campo `currency` —solo lo trae `search`—, así que
    aquí se caía siempre al valor por defecto y **toda** cotización de EODHD
    quedaba etiquetada en euros. Un AAPL.US a 320 USD se mostraba como 320 €, y
    como la conversión a la divisa de la cartera mira justo esa etiqueta,
    tampoco se convertía: el error se quedaba en el dato guardado.
    """
    normalizedSymbol = str(symbol or "").strip().upper()

    if "." not in normalizedSymbol:
        return fallback

    code, _, market = normalizedSymbol.rpartition(".")

    if market == "FOREX":
        # Pares de seis letras (EURUSD, XAUEUR): cotizan en la segunda divisa.
        pair = code.replace("-", "").replace("/", "")
        return pair[3:] if len(pair) == 6 else fallback

    if market == "CC":
        # Cripto: BTC-USD.CC cotiza en la divisa que va tras el guion.
        _, separator, quoted = code.rpartition("-")
        return quoted if separator and len(quoted) >= 3 else "USD"

    return EXCHANGE_CURRENCIES.get(market, fallback)


def _mensajeHttp(error):
    """El código de EODHD, dicho en términos de lo que hay que hacer.

    El 402 es cuota diaria agotada —el plan gratuito da 20 peticiones al día por
    clave— y es de lejos el fallo más habitual. Como «EODHD devolvió HTTP 402»
    no lo dice, el corte parecía una avería del proveedor.
    """
    if error.code == 401:
        return "EODHD rechaza la API key (HTTP 401)"
    if error.code in (402, 429):
        return f"EODHD: cuota diaria agotada (HTTP {error.code})"
    if error.code == 403:
        return "El plan de EODHD no cubre ese símbolo (HTTP 403)"
    return f"EODHD devolvió HTTP {error.code}"
PREFERRED_EXCHANGES_BY_TYPE = {
    "acciones": {"US", "NYSE", "NASDAQ", "XETRA", "LSE", "PA"},
    "etfs": {"XETRA", "PA", "LSE", "US", "NYSE", "NASDAQ", "AS", "SW"},
    "cripto": {"CC"},
    "comoditis": {"FOREX", "CC"},
}


def _fetchJson(url, params=None, timeout=None):
    return fetchJson(url, params, timeout=timeout, provider="EODHD")


def _formatSymbol(item):
    code = str(item.get("Code", "")).strip().upper()
    exchange = str(item.get("Exchange", "")).strip().upper()

    if not code:
        return ""

    if not exchange:
        return code

    return f"{code}.{exchange}"


def _scoreResult(item, normalizedQuery, normalizedAssetName="", preferredAssetType=""):
    code = str(item.get("Code", "")).strip().upper()
    name = str(item.get("Name", "")).strip()
    exchange = str(item.get("Exchange", "")).strip().upper()
    resultType = str(item.get("Type", "")).strip().lower()
    compactCode = _compactSymbol(code)
    compactQuery = _compactSymbol(normalizedQuery)
    normalizedName = _normalizeText(name)
    score = 0

    if compactQuery:
        if compactCode == compactQuery:
            score += 500
        if compactCode.startswith(compactQuery):
            score += 220
        if compactQuery in normalizedName:
            score += 180

    if normalizedAssetName:
        if normalizedAssetName == normalizedName:
            score += 260
        elif normalizedAssetName in normalizedName:
            score += 160

    if preferredAssetType == "etfs":
        if resultType == "etf":
            score += 320
        elif any(token in normalizedName for token in ("etf", "etp", "etc", "ucits", "ishares", "xtrackers", "amundi", "vanguard", "wisdomtree")):
            score += 200
        elif resultType == "fund":
            score += 80
    elif preferredAssetType == "acciones":
        if resultType in {"stock", "common stock"}:
            score += 250
        elif resultType == "etf":
            score += 40
    elif preferredAssetType == "cripto":
        if resultType == "crypto":
            score += 280
    elif preferredAssetType == "comoditis":
        if any(token in normalizedName for token in ("gold", "silver", "oil", "brent", "crude", "commodity")):
            score += 280

    if preferredAssetType in PREFERRED_EXCHANGES_BY_TYPE and exchange in PREFERRED_EXCHANGES_BY_TYPE[preferredAssetType]:
        score += 90

    return score


def searchSymbol(queryText, apiKey, timeout=None, limit=8, assetName="", preferredAssetType=""):
    normalizedQuery = str(queryText or "").strip()

    if not normalizedQuery:
        return None, "Escribe un nombre o ticker para buscar"

    if not apiKey:
        return None, "No se ha encontrado la API key de EODHD"

    searchType = "all"

    if preferredAssetType == "acciones":
        searchType = "stock"
    elif preferredAssetType == "etfs":
        searchType = "etf"
    elif preferredAssetType == "cripto":
        searchType = "crypto"

    try:
        payload = _fetchJson(
            f"{EODHD_SEARCH_URL}/{quote(normalizedQuery)}",
            {
                "api_token": apiKey,
                "fmt": "json",
                "limit": max(1, min(int(limit or 8), 15)),
                "type": searchType
            },
            timeout=timeout
        )
    except HTTPError as error:
        return None, _mensajeHttp(error)
    except URLError:
        return None, "No se pudo conectar con EODHD"

    normalizedAssetName = _normalizeText(assetName)
    rankedResults = []
    seenSymbols = set()

    for item in payload or []:
        symbol = _formatSymbol(item)
        code = str(item.get("Code", "")).strip().upper()
        name = str(item.get("Name", "")).strip()
        exchange = str(item.get("Exchange", "")).strip().upper()
        previousClose = item.get("previousClose")
        currency = str(item.get("Currency", "")).strip().upper()

        if not code or not name or symbol in seenSymbols:
            continue

        seenSymbols.add(symbol)
        rankedResults.append((
            _scoreResult(item, normalizedQuery, normalizedAssetName, preferredAssetType),
            {
                "symbol": symbol,
                "displaySymbol": symbol,
                "description": name,
                "type": str(item.get("Type", "")).strip() or "market",
                "exchange": exchange,
                "provider": "eodhd",
                "price": str(previousClose) if previousClose not in (None, "") else "",
                "currency": currency,
                "change": ""
            }
        ))

    rankedResults.sort(key=lambda row: (-row[0], row[1]["symbol"]))
    return [item for _, item in rankedResults[:limit]], None


def fetchQuote(symbol, apiKey, timeout=None):
    normalizedSymbol = str(symbol or "").strip().upper()

    if not normalizedSymbol:
        return None, "El ticker de EODHD es obligatorio"

    if not apiKey:
        return None, "No se ha encontrado la API key de EODHD"

    try:
        payload = _fetchJson(
            f"{EODHD_REALTIME_URL}/{quote(normalizedSymbol)}",
            {
                "api_token": apiKey,
                "fmt": "json"
            },
            timeout=timeout
        )
    except HTTPError as error:
        return None, _mensajeHttp(error)
    except URLError:
        return None, "No se pudo conectar con EODHD"

    currentPrice = _safeFloat(payload.get("close"), fallback=0.0)
    previousClose = _safeFloat(payload.get("previousClose"), fallback=0.0)
    percentChange = _safeFloat(payload.get("change_p"), fallback=0.0)

    if abs(percentChange) < 1e-9 and previousClose > 0 and currentPrice > 0:
        absoluteChange = _safeFloat(payload.get("change"), fallback=0.0)
        if abs(absoluteChange) > 1e-9:
            percentChange = absoluteChange / previousClose * 100
        elif abs(currentPrice - previousClose) > 1e-9:
            percentChange = (currentPrice - previousClose) / previousClose * 100

    if currentPrice <= 0:
        currentPrice = previousClose

    currency = (str(payload.get("currency", "")).strip().upper()
                or inferCurrencyFromSymbol(normalizedSymbol))

    if currentPrice <= 0 and previousClose <= 0:
        return None, "EODHD no devolvió cotización para ese ticker"

    return {
        "symbol": normalizedSymbol,
        "price": _formatDecimal(currentPrice),
        "currency": currency,
        "change": _formatPercent(percentChange),
        "status": "Cotización actualizada",
        "lastUpdated": datetime.now().astimezone().isoformat(),
        "marketData": {
            "currentPrice": currentPrice,
            "percentChange": percentChange,
            "previousClose": previousClose
        }
    }, None
