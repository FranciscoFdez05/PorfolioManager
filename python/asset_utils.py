import re


ALLOWED_ASSET_TYPES = {"cripto", "acciones", "etfs", "comoditis"}


def slugify(value):
    normalized = re.sub(r"[^a-zA-Z0-9]+", "-", str(value).strip().lower())
    normalized = normalized.strip("-")
    return normalized or "activo"


def createAssetSymbol(name):
    cleaned = re.sub(r"[^A-Za-z0-9]", "", str(name).upper())
    return cleaned[:10] or "ACTIVO"


def sanitizeAssetType(assetType):
    normalized = slugify(assetType).replace("-", "")

    if normalized not in ALLOWED_ASSET_TYPES:
        return None

    return normalized


def createDefaultAssetPayload(name, assetType, assetId=None):
    return {
        "id": assetId or slugify(name),
        "name": str(name).strip(),
        "symbol": createAssetSymbol(name),
        "finnhubSymbol": "",
        "type": assetType,
        "order": 0,
        "price": "0,00",
        "currency": "USD",
        "change": "+0,00%",
        "status": "Mercado abierto",
        "rows": [
            {
                "fechaOperacion": "",
                "tipoOperacion": "Compra",
                "participaciones": "",
                "precioParticipacion": "",
                "capitalInvertidoBruto": "",
                "comisiones": ""
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
            "comisiones": str(row.get("comisiones", "")).strip()
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
        "finnhubSymbol": str(requestData.get("finnhubSymbol", "")).strip().upper(),
        "type": assetType,
        "order": int(requestData.get("order", 0) or 0),
        "price": str(requestData.get("price", "0,00")).strip(),
        "currency": str(requestData.get("currency", "USD")).strip() or "USD",
        "change": str(requestData.get("change", "+0,00%")).strip() or "+0,00%",
        "status": str(requestData.get("status", "Mercado abierto")).strip() or "Mercado abierto",
        "rows": sanitizeAssetRows(rows)
    }

    return payload, None
