import re


ALLOWED_ASSET_TYPES = {"cripto", "acciones", "etfs", "comoditis"}
ALLOWED_MARKET_PROVIDERS = {"finnhub", "eodhd"}
EODHD_EXCHANGE_CODES = {"XETRA", "PA", "LSE", "US", "SW", "AS", "MC", "MI", "DU", "BE", "F", "MU", "ST", "VI", "LS"}


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
        legacy_crypto_fee = str(row.get("comisionesSatoshis", row.get("comisiones", ""))).strip()
        crypto_fee = str(row.get("comisionesCripto", legacy_crypto_fee)).strip()
        fiat_fee = str(row.get("comisionesFiat", "")).strip()
        currency = str(row.get("currency", "EUR")).strip().upper() or "EUR"

        if currency not in {"EUR", "USD"}:
            currency = "EUR"

        sanitizedRows.append({
            "fechaOperacion": str(row.get("fechaOperacion", "")).strip(),
            "tipoOperacion": str(row.get("tipoOperacion", "")).strip(),
            "exchange": str(row.get("exchange", "")).strip(),
            "currency": currency,
            "participaciones": str(row.get("participaciones", "")).strip(),
            "precioParticipacion": str(row.get("precioParticipacion", "")).strip(),
            "capitalInvertidoBruto": str(row.get("capitalInvertidoBruto", "")).strip(),
            "costeAnual": str(row.get("costeAnual", "")).strip(),
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

        if estado not in {"Activo", "Cerrado", "Completado"}:
            estado = "Activo"

        if currency not in {"EUR", "USD"}:
            currency = "EUR"

        if precio_currency not in {"EUR", "USD"}:
            precio_currency = currency

        sanitized_rows.append({
            "id": str(row.get("id", f"operacion-{index + 1}")).strip() or f"operacion-{index + 1}",
            "assetId": str(row.get("assetId", "")).strip(),
            "activo": str(row.get("activo", "")).strip(),
            "fechaApertura": str(row.get("fechaApertura", row.get("fecha", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "stablecoinSymbol": str(row.get("stablecoinSymbol", "")).strip().upper(),
            "orden": orden,
            "precioOrden": str(row.get("precioOrden", row.get("precio", ""))).strip(),
            "precioCurrency": precio_currency,
            "cantidad": str(row.get("cantidad", "")).strip(),
            "comisionesCripto": str(row.get("comisionesCripto", row.get("comisiones", ""))).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": currency,
            "estado": estado,
            "fechaCierre": str(row.get("fechaCierre", "")).strip()
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
    assetName = str(requestData.get("name", "")).strip()
    assetType = sanitizeAssetType(requestData.get("type", ""))

    if not assetName:
        return None, "El nombre del activo es obligatorio"

    if not assetType:
        return None, "Tipo de activo inválido"

    assetId = fallbackAssetId or slugify(requestData.get("id") or assetName)
    rows = requestData.get("rows", [])

    if not isinstance(rows, list):
        return None, "rows debe ser una lista"

    payload = {
        "id": assetId,
        "name": assetName,
        "symbol": str(requestData.get("symbol") or createAssetSymbol(assetName)).strip() or createAssetSymbol(assetName),
        "marketSymbol": str(requestData.get("marketSymbol", requestData.get("finnhubSymbol", ""))).strip().upper(),
        "type": assetType,
        "order": int(requestData.get("order", 0) or 0),
        "price": str(requestData.get("price", "0,00")).strip(),
        "currency": str(requestData.get("currency", "EUR")).strip() or "EUR",
        "precioCurrency": str(requestData.get("precioCurrency", requestData.get("currency", "EUR"))).strip() or "EUR",
        "change": str(requestData.get("change", "+0,00%")).strip() or "+0,00%",
        "status": str(requestData.get("status", "Mercado abierto")).strip() or "Mercado abierto",
        "lastUpdated": str(requestData.get("lastUpdated", "")).strip(),
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
