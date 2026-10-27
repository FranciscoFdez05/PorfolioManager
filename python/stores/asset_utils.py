import re

from core import dinero
from core.errors import ValidationError

ALLOWED_ASSET_TYPES = {"cripto", "acciones", "etfs", "comoditis"}
_HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')


def sanitizeColor(value):
    s = str(value or "").strip()
    return s if _HEX_COLOR_RE.match(s) else ""
ALLOWED_MARKET_PROVIDERS = {"finnhub", "eodhd", "yahoo", "alphavantage", "tradingview"}
# Divisas en las que puede estar un activo (el menú «Moneda del activo» y el
# interruptor de conversión de «Editar activo»). Es lo que admite el modelo de
# datos del activo, no un límite de ninguna API: qué se puede convertir en cada
# momento lo dice el servicio de tipos de cambio (`/api/divisas`).
SUPPORTED_ASSET_CURRENCIES = {"EUR", "USD", "GBP", "CHF", "JPY"}
EODHD_EXCHANGE_CODES = {"XETRA", "PA", "LSE", "US", "SW", "AS", "MC", "MI", "DU", "BE", "F", "MU", "ST", "VI", "LS", "FOREX", "CC"}

_MAX_NAME = 120
_MAX_SYMBOL = 40
_MAX_TICKER = 60
_MAX_SHORT = 30
_MAX_TEXT = 200


def _trunc(value, maxLen):
    return str(value or "")[:maxLen]


def slugify(value):
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", str(value).strip().lower())
    normalized = normalized.strip("-")
    return normalized or "activo"


def createAssetSymbol(name):
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(name).upper())
    return cleaned[:24] or "ACTIVO"


def normalizeAssetCurrency(assetData, fallback="EUR"):
    """La moneda del activo: una sola, la del precio y la de lo invertido.

    Acepta `precioCurrency` como entrada porque clientes viejos (y copias de
    seguridad previas a la unificación) todavía la mandan, pero el activo
    guarda un único campo: tener dos permitía que divergieran y que la misma
    fila saliera con el precio en euros y el invertido en dólares.
    """
    raw = assetData.get("currency") or assetData.get("precioCurrency") or fallback
    normalized = _trunc(raw, 10).strip().upper()

    return normalized if normalized.isalpha() and 2 <= len(normalized) <= 5 else fallback


def normalizeConvertCurrency(value):
    """Divisa a la que convertir la cotización, o cadena vacía si está apagado.

    A diferencia de `normalizeAssetCurrency` (que siempre tiene que valer
    algo), aquí "sin valor" es un estado legítimo y el que viene por defecto:
    la cotización se guarda tal cual la da el proveedor. Un código no
    reconocido se trata igual que vacío -apagado- en vez de dar error, porque
    esto es una preferencia opcional, no un dato obligatorio del activo.
    """
    normalized = str(value or "").strip().upper()
    return normalized if normalized in SUPPORTED_ASSET_CURRENCIES else ""


def sanitizeAssetType(assetType):
    normalized = slugify(assetType).replace("-", "")

    if normalized not in ALLOWED_ASSET_TYPES:
        return None

    return normalized


def normalizeMarketProvider(provider, fallback="finnhub"):
    normalized = slugify(provider).replace("-", "")

    if normalized not in ALLOWED_MARKET_PROVIDERS:
        return fallback

    return normalized


def inferMarketProviderFromSymbol(symbol, fallback="finnhub"):
    normalizedSymbol = str(symbol or "").strip().upper()

    if not normalizedSymbol:
        return fallback

    if ":" in normalizedSymbol:
        return "finnhub"

    if "." in normalizedSymbol:
        exchangeCode = normalizedSymbol.rsplit(".", 1)[-1]

        if exchangeCode in EODHD_EXCHANGE_CODES:
            return "eodhd"

    return fallback


def createDefaultAssetPayload(name, assetType, assetId=None):
    return {
        "id": assetId or slugify(name),
        "name": str(name).strip(),
        "symbol": createAssetSymbol(name),
        "marketProvider": "finnhub",
        "marketSymbol": "",
        "finnhubSymbol": "",
        "type": assetType,
        "order": 0,
        "price": "0,00",
        "currency": "EUR",
        "change": "+0,00%",
        "status": "Mercado abierto",
        "lastUpdated": "",
        "color": "",
        "convertCurrency": "",
        "costeAnual": "",
        "operationRows": [],
        "conversionRows": [],
        "rows": []
    }


def sanitizeAssetRows(rows):
    sanitizedRows = []

    for row in rows:
        legacyCryptoFee = _trunc(row.get("comisionesSatoshis", row.get("comisiones", "")), _MAX_SHORT).strip()
        cryptoFee = _trunc(row.get("comisionesCripto", legacyCryptoFee), _MAX_SHORT).strip()
        fiatFee = _trunc(row.get("comisionesFiat") or row.get("comisiones", ""), _MAX_SHORT).strip()
        currency = _trunc(row.get("currency", "EUR"), 10).strip().upper() or "EUR"

        if currency not in {"EUR", "USD"}:
            currency = "EUR"

        sanitizedRows.append({
            "fechaOperacion": _trunc(row.get("fechaOperacion", ""), _MAX_SHORT).strip(),
            "tipoOperacion": _trunc(row.get("tipoOperacion", ""), _MAX_SHORT).strip(),
            "exchange": _trunc(row.get("exchange", ""), _MAX_SHORT).strip(),
            "currency": currency,
            "participaciones": _trunc(row.get("participaciones", ""), _MAX_SHORT).strip(),
            "precioParticipacion": _trunc(row.get("precioParticipacion", ""), _MAX_SHORT).strip(),
            "capitalInvertidoBruto": _trunc(row.get("capitalInvertidoBruto", ""), _MAX_SHORT).strip(),
            "costeAnual": _trunc(row.get("costeAnual", ""), _MAX_SHORT).strip(),
            "comisiones": fiatFee,
            "comisionesFiat": fiatFee,
            "comisionesCripto": cryptoFee,
            "comisionesSatoshis": cryptoFee
        })

    return sanitizedRows


def sanitizeAssetOperationRows(rows):
    sanitizedRows = []

    for index, row in enumerate(rows or []):
        orden = str(row.get("orden", "Compra")).strip().capitalize()
        estado = str(row.get("estado", "Activo")).strip().capitalize()
        currency = str(row.get("currency", "EUR")).strip().upper() or "EUR"
        precioCurrency = str(row.get("precioCurrency", currency)).strip().upper() or currency

        if orden not in {"Compra", "Venta"}:
            orden = "Compra"

        if estado not in {"Activo", "Completado"}:
            estado = "Activo"

        if currency not in {"EUR", "USD"}:
            currency = "EUR"

        if precioCurrency not in {"EUR", "USD"}:
            precioCurrency = currency

        sanitizedRows.append({
            "id": _trunc(row.get("id", f"operacion-{index + 1}"), _MAX_SHORT).strip() or f"operacion-{index + 1}",
            "assetId": _trunc(row.get("assetId", ""), _MAX_SHORT).strip(),
            "activo": _trunc(row.get("activo", ""), _MAX_NAME).strip(),
            "fechaApertura": _trunc(row.get("fechaApertura", row.get("fecha", "")), _MAX_SHORT).strip(),
            "par": _trunc(row.get("par", ""), _MAX_SYMBOL).strip(),
            "stablecoinSymbol": _trunc(row.get("stablecoinSymbol", ""), _MAX_SYMBOL).strip().upper(),
            "orden": orden,
            "precioOrden": _trunc(row.get("precioOrden", row.get("precio", "")), _MAX_SHORT).strip(),
            "precioCurrency": precioCurrency,
            "cantidad": _trunc(row.get("cantidad", ""), _MAX_SHORT).strip(),
            "comisionesCripto": _trunc(row.get("comisionesCripto", row.get("comisiones", "")), _MAX_SHORT).strip(),
            "comisionesFiat": _trunc(row.get("comisionesFiat", ""), _MAX_SHORT).strip(),
            "total": _trunc(row.get("total", ""), _MAX_SHORT).strip(),
            "currency": currency,
            "estado": estado,
            "fechaCierre": _trunc(row.get("fechaCierre", ""), _MAX_SHORT).strip()
        })

    return sanitizedRows


def _valorEurCanonico(valor, indice):
    """Valor de mercado en euros de una conversión: texto canónico, o vacío si no hay.

    Raises:
        ValidationError: Si no es un importe legible o es negativo.
    """
    texto = str(valor if valor is not None else "").strip()
    if not texto:
        return ""
    campo = f"conversionRows[{indice}].valorEur"
    try:
        importe = dinero.aDecimal(texto, campo)
    except dinero.ImporteInvalido:
        raise ValidationError("El valor en euros de la conversión no es un importe válido", field=campo) from None
    if importe < 0:
        raise ValidationError("El valor en euros de la conversión no puede ser negativo", field=campo)
    return dinero.aTexto(importe, campo)


def sanitizeAssetConversionRows(rows, assetSymbol=""):
    sanitizedRows = []
    normalizedSymbol = str(assetSymbol or "").strip().upper()

    for index, row in enumerate(rows or []):
        conversionType = str(row.get("tipo", row.get("tipoOperacion", ""))).strip()

        if not conversionType and normalizedSymbol:
            conversionType = f"Convertidos a {normalizedSymbol}"

        sanitizedRows.append({
            "id": str(row.get("id", f"conversion-{index + 1}")).strip() or f"conversion-{index + 1}",
            "fecha": str(row.get("fecha", row.get("fechaOperacion", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "tipo": conversionType,
            "cantidad": str(row.get("cantidad", row.get("participaciones", ""))).strip(),
            "cantidadContraparte": str(row.get("cantidadContraparte", "")).strip()[:_MAX_SHORT],
            "comision": str(row.get("comision", "")).strip()[:_MAX_SHORT],
            "comisionMoneda": str(row.get("comisionMoneda", "")).strip().upper()[:_MAX_SHORT],
            "valorEur": _valorEurCanonico(row.get("valorEur", ""), index)
        })

    return sanitizedRows


def sanitizeAssetPayload(requestData, fallbackAssetId=None):
    assetName = _trunc(requestData.get("name", ""), _MAX_NAME).strip()
    assetType = sanitizeAssetType(requestData.get("type", ""))

    if not assetName:
        return None, "El nombre del activo es obligatorio"

    if not assetType:
        return None, "Tipo de activo inválido"

    assetId = fallbackAssetId or slugify(requestData.get("id") or assetName)
    rows = requestData.get("rows", [])

    if not isinstance(rows, list):
        return None, "rows debe ser una lista"

    if len(rows) > 500:
        return None, "Demasiadas filas (máximo 500)"

    payload = {
        "id": assetId,
        "name": assetName,
        "symbol": _trunc(requestData.get("symbol") or createAssetSymbol(assetName), _MAX_SYMBOL).strip() or createAssetSymbol(assetName),
        "marketSymbol": _trunc(requestData.get("marketSymbol", requestData.get("finnhubSymbol", "")), _MAX_TICKER).strip().upper(),
        "type": assetType,
        "order": int(requestData.get("order", 0) or 0),
        "price": _trunc(requestData.get("price", "0,00"), _MAX_SHORT).strip(),
        "currency": normalizeAssetCurrency(requestData),
        "change": _trunc(requestData.get("change", "+0,00%"), _MAX_SHORT).strip() or "+0,00%",
        "status": _trunc(requestData.get("status", "Mercado abierto"), _MAX_TEXT).strip() or "Mercado abierto",
        "lastUpdated": _trunc(requestData.get("lastUpdated", ""), _MAX_TEXT).strip(),
        "color": sanitizeColor(requestData.get("color", "")),
        "tvSymbol": _trunc(requestData.get("tvSymbol", ""), _MAX_TICKER).strip(),
        "convertCurrency": normalizeConvertCurrency(requestData.get("convertCurrency", "")),
        "costeAnual": _trunc(requestData.get("costeAnual", ""), _MAX_SHORT).strip(),
        # El cliente reenvía el activo entero al guardar, así que si `hidden` no
        # se copia aquí el upsert lo reescribe a 0 y el activo oculto reaparece.
        "hidden": bool(requestData.get("hidden", False)),
        "operationRows": sanitizeAssetOperationRows(requestData.get("operationRows", [])),
        "conversionRows": sanitizeAssetConversionRows(
            requestData.get("conversionRows", []),
            requestData.get("symbol") or createAssetSymbol(assetName)
        ),
        "rows": sanitizeAssetRows(rows)
    }

    payload["marketProvider"] = normalizeMarketProvider(
        requestData.get("marketProvider", ""),
        fallback=inferMarketProviderFromSymbol(payload["marketSymbol"])
    )
    payload["finnhubSymbol"] = payload["marketSymbol"]

    return payload, None
