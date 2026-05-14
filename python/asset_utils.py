import re


ALLOWED_ASSET_TYPES = {"cripto", "acciones", "etfs", "comoditis"}
_HEX_COLOR_RE = re.compile(r'^#[0-9a-fA-F]{6}$')


def sanitize_color(value):
    s = str(value or "").strip()
    return s if _HEX_COLOR_RE.match(s) else ""
ALLOWED_MARKET_PROVIDERS = {"finnhub", "eodhd", "yahoo"}
EODHD_EXCHANGE_CODES = {"XETRA", "PA", "LSE", "US", "SW", "AS", "MC", "MI", "DU", "BE", "F", "MU", "ST", "VI", "LS", "FOREX", "CC"}

_MAX_NAME = 120
_MAX_SYMBOL = 40
_MAX_TICKER = 60
_MAX_SHORT = 30
_MAX_TEXT = 200


def _trunc(value, max_len):
    return str(value or "")[:max_len]


def slugify(value):
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", str(value).strip().lower())
    normalized = normalized.strip("-")
    return normalized or "activo"


def createAssetSymbol(name):
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(name).upper())
    return cleaned[:24] or "ACTIVO"


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
    normalized_symbol = str(symbol or "").strip().upper()

    if not normalized_symbol:
        return fallback

    if ":" in normalized_symbol:
        return "finnhub"

    if "." in normalized_symbol:
        exchange_code = normalized_symbol.rsplit(".", 1)[-1]

        if exchange_code in EODHD_EXCHANGE_CODES:
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
        "precioCurrency": "EUR",
        "change": "+0,00%",
        "status": "Mercado abierto",
        "lastUpdated": "",
        "color": "",
        "operationRows": [],
        "conversionRows": [],
        "rows": [
            {
                "fechaOperacion": "",
                "tipoOperacion": "Compra",
                "exchange": "",
                "currency": "EUR",
                "participaciones": "",
                "precioParticipacion": "",
                "capitalInvertidoBruto": "",
                "costeAnual": "",
                "comisiones": "",
                "comisionesFiat": "",
                "comisionesCripto": "",
                "comisionesSatoshis": ""
            }
        ]
    }


def sanitizeAssetRows(rows):
    sanitizedRows = []

    for row in rows:
        legacy_crypto_fee = _trunc(row.get("comisionesSatoshis", row.get("comisiones", "")), _MAX_SHORT).strip()
        crypto_fee = _trunc(row.get("comisionesCripto", legacy_crypto_fee), _MAX_SHORT).strip()
        fiat_fee = _trunc(row.get("comisionesFiat") or row.get("comisiones", ""), _MAX_SHORT).strip()
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
            "comisiones": fiat_fee,
            "comisionesFiat": fiat_fee,
            "comisionesCripto": crypto_fee,
            "comisionesSatoshis": crypto_fee
        })

    return sanitizedRows


def sanitizeAssetOperationRows(rows):
    sanitized_rows = []

    for index, row in enumerate(rows or []):
        orden = str(row.get("orden", "Compra")).strip().capitalize()
        estado = str(row.get("estado", "Activo")).strip().capitalize()
        currency = str(row.get("currency", "EUR")).strip().upper() or "EUR"
        precio_currency = str(row.get("precioCurrency", currency)).strip().upper() or currency

        if orden not in {"Compra", "Venta"}:
            orden = "Compra"

        if estado not in {"Activo", "Completado"}:
            estado = "Activo"

        if currency not in {"EUR", "USD"}:
            currency = "EUR"

        if precio_currency not in {"EUR", "USD"}:
            precio_currency = currency

        sanitized_rows.append({
            "id": _trunc(row.get("id", f"operacion-{index + 1}"), _MAX_SHORT).strip() or f"operacion-{index + 1}",
            "assetId": _trunc(row.get("assetId", ""), _MAX_SHORT).strip(),
            "activo": _trunc(row.get("activo", ""), _MAX_NAME).strip(),
            "fechaApertura": _trunc(row.get("fechaApertura", row.get("fecha", "")), _MAX_SHORT).strip(),
            "par": _trunc(row.get("par", ""), _MAX_SYMBOL).strip(),
            "stablecoinSymbol": _trunc(row.get("stablecoinSymbol", ""), _MAX_SYMBOL).strip().upper(),
            "orden": orden,
            "precioOrden": _trunc(row.get("precioOrden", row.get("precio", "")), _MAX_SHORT).strip(),
            "precioCurrency": precio_currency,
            "cantidad": _trunc(row.get("cantidad", ""), _MAX_SHORT).strip(),
            "comisionesCripto": _trunc(row.get("comisionesCripto", row.get("comisiones", "")), _MAX_SHORT).strip(),
            "total": _trunc(row.get("total", ""), _MAX_SHORT).strip(),
            "currency": currency,
            "estado": estado,
            "fechaCierre": _trunc(row.get("fechaCierre", ""), _MAX_SHORT).strip()
        })

    return sanitized_rows


def sanitizeAssetConversionRows(rows, asset_symbol=""):
    sanitized_rows = []
    normalized_symbol = str(asset_symbol or "").strip().upper()

    for index, row in enumerate(rows or []):
        conversion_type = str(row.get("tipo", row.get("tipoOperacion", ""))).strip()

        if not conversion_type and normalized_symbol:
            conversion_type = f"Convertidos a {normalized_symbol}"

        sanitized_rows.append({
            "id": str(row.get("id", f"conversion-{index + 1}")).strip() or f"conversion-{index + 1}",
            "fecha": str(row.get("fecha", row.get("fechaOperacion", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "tipo": conversion_type,
            "cantidad": str(row.get("cantidad", row.get("participaciones", ""))).strip()
        })

    return sanitized_rows


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
        "currency": _trunc(requestData.get("currency", "EUR"), 10).strip() or "EUR",
        "precioCurrency": _trunc(requestData.get("precioCurrency", requestData.get("currency", "EUR")), 10).strip() or "EUR",
        "change": _trunc(requestData.get("change", "+0,00%"), _MAX_SHORT).strip() or "+0,00%",
        "status": _trunc(requestData.get("status", "Mercado abierto"), _MAX_TEXT).strip() or "Mercado abierto",
        "lastUpdated": _trunc(requestData.get("lastUpdated", ""), _MAX_TEXT).strip(),
        "color": sanitize_color(requestData.get("color", "")),
        "tvSymbol": _trunc(requestData.get("tvSymbol", ""), _MAX_TICKER).strip(),
        "operationRows": sanitizeAssetOperationRows(requestData.get("operationRows", [])),
        "conversionRows": sanitizeAssetConversionRows(
            requestData.get("conversionRows", []),
            requestData.get("symbol") or createAssetSymbol(assetName)
        ),
        "rows": sanitizeAssetRows(rows)
    }

    if assetType == "cripto":
        payload["precioCurrency"] = payload["currency"]

    payload["marketProvider"] = normalizeMarketProvider(
        requestData.get("marketProvider", ""),
        fallback=inferMarketProviderFromSymbol(payload["marketSymbol"])
    )
    payload["finnhubSymbol"] = payload["marketSymbol"]

    return payload, None
