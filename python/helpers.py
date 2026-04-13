from app_data import readEodhdApiKey, readRotatedEodhdApiKeys
from asset_store import listAssets, readAssetFile, writeAssetFile
from asset_utils import sanitizeAssetOperationRows, slugify
from finnhub_client import convert_amount


def normalize_currency_code(currency, fallback="EUR"):
    normalized = str(currency or "").strip().upper()

    if normalized in {"USDT", "USDC", "BUSD", "DAI", "FDUSD", "PYUSD", "TUSD", "USDE"} or normalized.endswith("USD"):
        return "USD"

    if normalized in {"EURC"} or normalized.endswith("EUR"):
        return "EUR"

    return normalized or fallback


def call_eodhd_with_fallbacks(callback):
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


def parse_loose_number(value):
    text = str(value or "").strip()

    if not text:
        return None

    cleaned = "".join(character for character in text if character.isdigit() or character in ",.-")

    if not cleaned:
        return None

    if "," in cleaned and "." in cleaned:
        normalized = cleaned.replace(".", "").replace(",", ".")
    else:
        normalized = cleaned.replace(",", ".")

    try:
        return float(normalized)
    except ValueError:
        return None


def format_decimal(value, digits=2):
    return f"{float(value):.{digits}f}".replace(".", ",")


def is_temporary_service_error(error):
    normalized_error = str(error or "").lower()
    return any(fragment in normalized_error for fragment in ("conectar", "divisa", "tard", "timeout"))


def convert_asset_rows_currency(rows, source_currency, target_currency, asset_type="", fields=None):
    converted_rows = []
    normalized_asset_type = str(asset_type or "").strip().lower()

    for row in rows or []:
        converted_row = dict(row)

        if normalized_asset_type != "cripto":
            money_fields = ("precioParticipacion", "capitalInvertidoBruto", "comisiones")
        else:
            money_fields = ("precioParticipacion", "capitalInvertidoBruto", "comisiones", "comisionesFiat")

        if fields:
            allowed_fields = set(fields)
            money_fields = tuple(field_name for field_name in money_fields if field_name in allowed_fields)

        for field_name in money_fields:
            parsed_value = parse_loose_number(converted_row.get(field_name, ""))

            if parsed_value is None:
                continue

            converted_value, error = convert_amount(parsed_value, source_currency, target_currency)

            if error:
                return None, error

            converted_row[field_name] = format_decimal(converted_value)

        converted_rows.append(converted_row)

    return converted_rows, None


def build_completed_operations_by_asset(rows):
    operations_by_asset = {}

    for row in rows or []:
        asset_id = slugify(row.get("assetId", ""))
        estado = str(row.get("estado", "")).strip().capitalize()

        if not asset_id or estado != "Completado":
            continue

        operations_by_asset.setdefault(asset_id, []).append({
            "id": str(row.get("id", "")).strip(),
            "assetId": asset_id,
            "activo": str(row.get("activo", "")).strip(),
            "fechaApertura": str(row.get("fechaApertura", row.get("fecha", ""))).strip(),
            "par": str(row.get("par", "")).strip(),
            "stablecoinSymbol": str(row.get("stablecoinSymbol", "")).strip().upper(),
            "orden": str(row.get("orden", "Compra")).strip().capitalize(),
            "precioOrden": str(row.get("precioOrden", row.get("precio", ""))).strip(),
            "precioCurrency": str(row.get("precioCurrency", row.get("currency", "EUR"))).strip().upper(),
            "cantidad": str(row.get("cantidad", "")).strip(),
            "comisionesCripto": str(row.get("comisionesCripto", row.get("comisiones", ""))).strip(),
            "total": str(row.get("total", "")).strip(),
            "currency": str(row.get("currency", "EUR")).strip().upper(),
            "estado": "Completado",
            "fechaCierre": str(row.get("fechaCierre", "")).strip()
        })

    return {asset_id: sanitizeAssetOperationRows(asset_rows) for asset_id, asset_rows in operations_by_asset.items()}


def sync_completed_operations_into_assets(rows):
    operations_by_asset = build_completed_operations_by_asset(rows)

    for asset in listAssets():
        asset_id = asset["id"]
        asset_data = readAssetFile(asset_id)

        if asset_data is None:
            continue

        asset_data["operationRows"] = operations_by_asset.get(asset_id, [])
        writeAssetFile(asset_id, asset_data)
