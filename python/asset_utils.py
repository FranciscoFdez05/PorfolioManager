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
        "rows": [
            {
                "fechaOperacion": "",
                "tipoOperacion": "Compra",
                "participaciones": "",
                "precioParticipacion": "",
                "capitalInvertidoBruto": "",
                "costeAnual": "",
                "comisiones": "",
                "comisionesSatoshis": ""
            }
        ]
    }


def sanitizeAssetRows(rows):
    sanitizedRows = []

    for row in rows:
        sanitizedRows.append({
            "fechaOperacion": str(row.get("fechaOperacion", "")).strip(),
            "tipoOperacion": str(row.get("tipoOperacion", "")).strip(),
            "participaciones": str(row.get("participaciones", "")).strip(),
            "precioParticipacion": str(row.get("precioParticipacion", "")).strip(),
            "capitalInvertidoBruto": str(row.get("capitalInvertidoBruto", "")).strip(),
            "costeAnual": str(row.get("costeAnual", "")).strip(),
            "comisiones": str(row.get("comisiones", "")).strip(),
            "comisionesSatoshis": str(row.get("comisionesSatoshis", "")).strip()
        })

    return sanitizedRows


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
        "rows": sanitizeAssetRows(rows)
    }

    payload["marketProvider"] = normalizeMarketProvider(
        requestData.get("marketProvider", ""),
        fallback=inferMarketProviderFromSymbol(payload["marketSymbol"])
    )
    payload["finnhubSymbol"] = payload["marketSymbol"]

    return payload, None
