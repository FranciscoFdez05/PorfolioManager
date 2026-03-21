import json

from app_data import activosDir, dataDir, ensureDataFile
from asset_utils import slugify


def getAssetFile(assetId):
    safeAssetId = slugify(assetId)
    return activosDir / f"{safeAssetId}.json"


def readAssetFile(assetId):
    ensureDataFile()
    assetFile = getAssetFile(assetId)

    if not assetFile.exists():
        return None

    with assetFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeAssetFile(assetId, data):
    dataDir.mkdir(parents=True, exist_ok=True)
    activosDir.mkdir(parents=True, exist_ok=True)
    assetFile = getAssetFile(assetId)

    with assetFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def listAssets():
    ensureDataFile()
    assets = []

    for index, assetFile in enumerate(sorted(activosDir.glob("*.json"))):
        with assetFile.open("r", encoding="utf-8") as file:
            data = json.load(file)

        assets.append({
            "id": data.get("id", assetFile.stem),
            "name": data.get("name", assetFile.stem),
            "symbol": data.get("symbol", assetFile.stem.upper()),
            "finnhubSymbol": data.get("finnhubSymbol", ""),
            "type": data.get("type", ""),
            "order": data.get("order", index),
            "price": data.get("price", "0,00"),
            "currency": data.get("currency", "EUR"),
            "precioCurrency": data.get("precioCurrency", data.get("currency", "EUR")),
            "change": data.get("change", "+0,00%"),
            "status": data.get("status", "Mercado abierto"),
            "lastUpdated": data.get("lastUpdated", "")
        })

    return sorted(assets, key=lambda asset: (asset.get("order", 0), asset.get("symbol", "")))
