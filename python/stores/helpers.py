from core import dinero
from core.db import transaction
from providers.finnhub_client import convertAmount
from stores.app_data import (
    readAlphaVantageApiKey,
    readEodhdApiKey,
    readFinnhubApiKeys,
    readRotatedAlphaVantageApiKeys,
    readRotatedEodhdApiKeys,
)
from stores.asset_utils import sanitizeAssetOperationRows, slugify


def normalizeCurrencyCode(currency, fallback="EUR"):
    normalized = str(currency or "").strip().upper()

    if normalized in {"USDT", "USDC", "BUSD", "DAI", "FDUSD", "PYUSD", "TUSD", "USDE"} or normalized.endswith("USD"):
        return "USD"

    if normalized in {"EURC"} or normalized.endswith("EUR"):
        return "EUR"

    return normalized or fallback


def callFinnhubWithFallbacks(callback):
    """Prueba las claves de Finnhub en orden y se queda con la primera que sirve.

    Finnhub era el único proveedor sin respaldo: usaba siempre la primera clave
    del fichero y ninguna más. Con tres configuradas, que la primera estuviera
    caducada dejaba a los diecinueve activos de Finnhub sin cotizar aunque las
    otras dos fueran perfectamente válidas, y desde la interfaz no había forma
    de saber cuál de las tres era la mala: solo se veía «Clave rechazada».

    No rota, a diferencia de EODHD y Alpha Vantage. Ahí la rotación reparte una
    cuota diaria muy corta; aquí el límite es por minuto y de sobra, así que el
    orden estable es preferible: la clave que se usa es siempre la primera de la
    lista que funcione, que es lo que la pantalla enseña.
    """
    apiKeys = readFinnhubApiKeys()

    if not apiKeys:
        return None, "No se ha encontrado ninguna API key de Finnhub"

    lastError = None

    for apiKey in apiKeys:
        try:
            result, error = callback(apiKey)
        except Exception as exc:
            result = None
            error = str(exc)

        if not error:
            return result, None

        lastError = error

    return None, lastError or "Todas las API keys de Finnhub han fallado"


def callEodhdWithFallbacks(callback):
    apiKeys = readRotatedEodhdApiKeys()

    if not apiKeys:
        legacyKey = readEodhdApiKey()

        if legacyKey:
            apiKeys = [legacyKey]

    if not apiKeys:
        return None, "No se ha encontrado ninguna API key de EODHD"

    lastError = None

    for apiKey in apiKeys:
        try:
            result, error = callback(apiKey)
        except Exception as exc:
            result = None
            error = str(exc)

        if not error:
            return result, None

        lastError = error

    return None, lastError or "Todas las API keys de EODHD han fallado"


def callAlphaVantageWithFallbacks(callback):
    apiKeys = readRotatedAlphaVantageApiKeys()

    if not apiKeys:
        legacyKey = readAlphaVantageApiKey()

        if legacyKey:
            apiKeys = [legacyKey]

    if not apiKeys:
        return None, "No se ha encontrado ninguna API key de Alpha Vantage"

    lastError = None

    for apiKey in apiKeys:
        try:
            result, error = callback(apiKey)
        except Exception as exc:
            result = None
            error = str(exc)

        if not error:
            return result, None

        lastError = error

    return None, lastError or "Todas las API keys de Alpha Vantage han fallado"


def parseLooseNumber(value):
    """Importe de una columna TEXT a `Decimal`, o `None` si no se entiende.

    Devuelve `Decimal` y no `float` porque lo que sale de aquí se acumula: los
    totales de invertido y de participaciones de `/api/activos/rendimiento-batch`
    se sumaban en coma flotante fila a fila. La conversión es la de
    `core.dinero`, la única del proyecto.

    Antes descartaba cualquier carácter que no fuera dígito, coma, punto o
    signo, de modo que "12abc34" se convertía en 1234 sin decir nada. Ahora eso
    devuelve `None` y quien llama decide: todos los llamadores ya escriben
    `or 0`, así que un dato corrupto pasa a contar como cero en vez de como una
    cifra inventada.
    """
    return dinero.aDecimalONulo(value)


def formatDecimal(value, digits=2):
    """Importe en formato español sin separador de miles ("1234,56").

    Es formato de **presentación**. Que además acabe guardado en algunas
    columnas TEXT es la deuda que describe `core.dinero`: mientras siga siendo
    así, al menos la conversión de ida y la de vuelta son la misma.
    """
    return dinero.aTextoEs(value, decimales=digits, miles=False)


def isTemporaryServiceError(error):
    normalizedError = str(error or "").lower()
    return any(fragment in normalizedError for fragment in ("conectar", "divisa", "tard", "timeout"))


def isRateLimitedError(error):
    """Si el error es un 429/cuota agotada, y no otra cosa.

    Los mensajes no llevan un código de error propio, así que se distingue por
    los fragmentos que ya escriben `_mensajeHttp` de cada cliente: "límite" y
    "cuota" (EODHD, Finnhub) o el "429" que queda tal cual en los proveedores
    sin traducción específica (Yahoo, Alpha Vantage). Sirve para marcar el
    proveedor como de reposo un rato y no insistir con él en la próxima
    cotización (ver `stores.market_data`).
    """
    normalizedError = str(error or "").lower()
    return any(fragment in normalizedError for fragment in ("límite", "cuota", "429"))


def convertAssetRowsCurrency(rows, sourceCurrency, targetCurrency, assetType="", fields=None):
    convertedRows = []
    normalizedAssetType = str(assetType or "").strip().lower()

    for row in rows or []:
        convertedRow = dict(row)

        if normalizedAssetType != "cripto":
            moneyFields = ("precioParticipacion", "capitalInvertidoBruto", "comisiones")
        else:
            moneyFields = ("precioParticipacion", "capitalInvertidoBruto", "comisiones", "comisionesFiat")

        if fields:
            allowedFields = set(fields)
            moneyFields = tuple(fieldName for fieldName in moneyFields if fieldName in allowedFields)

        for fieldName in moneyFields:
            parsedValue = parseLooseNumber(convertedRow.get(fieldName, ""))

            if parsedValue is None:
                continue

            convertedValue, error = convertAmount(parsedValue, sourceCurrency, targetCurrency)

            if error:
                return None, error

            convertedRow[fieldName] = formatDecimal(convertedValue)

        convertedRows.append(convertedRow)

    return convertedRows, None


def buildCompletedOperationsByAsset(rows):
    operationsByAsset = {}

    for row in rows or []:
        assetId = slugify(row.get("assetId", ""))
        estado = str(row.get("estado", "")).strip().capitalize()

        if not assetId or estado != "Completado":
            continue

        operationsByAsset.setdefault(assetId, []).append({
            "id": str(row.get("id", "")).strip(),
            "assetId": assetId,
            "activo": str(row.get("activo", "")).strip(),
            "fechaApertura": str(row.get("fechaApertura", row.get("fecha", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "stablecoinSymbol": str(row.get("stablecoinSymbol", "")).strip().upper(),
            "orden": str(row.get("orden", "Compra")).strip().capitalize(),
            "precioOrden": str(row.get("precioOrden", row.get("precio", ""))).strip(),
            "precioCurrency": str(row.get("precioCurrency", row.get("currency", "EUR"))).strip().upper(),
            "cantidad": str(row.get("cantidad", "")).strip(),
            "comisionesCripto": str(row.get("comisionesCripto", row.get("comisiones", ""))).strip(),
            "comisionesFiat": str(row.get("comisionesFiat", "")).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": str(row.get("currency", "EUR")).strip().upper(),
            "estado": "Completado",
            "fechaCierre": str(row.get("fechaCierre", "")).strip()
        })

    return {assetId: sanitizeAssetOperationRows(assetRows) for assetId, assetRows in operationsByAsset.items()}


# Columnas de activo_operation_rows que salen de la operación, en el orden en que
# se comparan y se insertan. El trío fx_* no está: se hereda de la fila previa.
_CAMPOS_OPERACION = (
    ("id", "id"), ("activo", "activo"), ("fecha_apertura", "fechaApertura"), ("par", "par"),
    ("stablecoin_symbol", "stablecoinSymbol"), ("orden", "orden"), ("precio_orden", "precioOrden"),
    ("precio_currency", "precioCurrency"), ("cantidad", "cantidad"),
    ("comisiones_cripto", "comisionesCripto"), ("comisiones_fiat", "comisionesFiat"),
    ("total", "total"), ("currency", "currency"), ("estado", "estado"), ("fecha_cierre", "fechaCierre"),
)


def syncCompletedOperationsIntoAssets(rows):
    """Copia las operaciones completadas a `activo_operation_rows` de cada activo.

    Antes reescribía el activo entero (`writeAssetFile`) por cada activo y en
    cada GET /api/operaciones: borraba y reinsertaba también sus compras, perdía
    el tipo de cambio histórico de todas ellas y hacía un commit por activo.

    Ahora toca solo la tabla derivada, en una única transacción, y solo los
    activos cuyo contenido difiere: en el caso normal no escribe nada. El tipo
    de cambio ya anotado se conserva por (fecha, divisa), que es de lo que
    depende.
    """
    operationsByAsset = buildCompletedOperationsByAsset(rows)
    columnas = [c for c, _ in _CAMPOS_OPERACION]
    lista = ", ".join(columnas)

    with transaction() as conn:
        existentes = {}
        for fila in conn.execute(
            f"SELECT asset_id, {lista}, fx_rate, fx_fecha, fx_origen "
            "FROM activo_operation_rows ORDER BY rowid"
        ):
            existentes.setdefault(fila["asset_id"], []).append(fila)

        idsActivos = {r[0] for r in conn.execute("SELECT id FROM activos")}
        for assetId in idsActivos:
            deseadas = [
                tuple(str(op.get(clave, "")) for _, clave in _CAMPOS_OPERACION)
                for op in operationsByAsset.get(assetId, [])
            ]
            previas = existentes.get(assetId, [])
            if [tuple(str(f[c]) for c in columnas) for f in previas] == deseadas:
                continue

            fx = {(f["fecha_apertura"], f["currency"]): (f["fx_rate"], f["fx_fecha"], f["fx_origen"])
                  for f in previas if f["fx_rate"]}
            indiceFecha = columnas.index("fecha_apertura")
            indiceDivisa = columnas.index("currency")
            conn.execute("DELETE FROM activo_operation_rows WHERE asset_id = ?", (assetId,))
            conn.executemany(
                f"INSERT INTO activo_operation_rows (asset_id, {lista}, fx_rate, fx_fecha, fx_origen) "
                f"VALUES ({', '.join('?' * (len(columnas) + 4))})",
                [
                    (assetId, *valores,
                     *fx.get((valores[indiceFecha], valores[indiceDivisa]), ("", "", "")))
                    for valores in deseadas
                ],
            )
