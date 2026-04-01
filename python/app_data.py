from pathlib import Path
import json


baseDir = Path(__file__).resolve().parent.parent
dataDir = baseDir / "data"
activosDir = dataDir / "activos"
gastosDir = dataDir / "gastos"
ventasDir = dataDir / "ventas"
apiDir = baseDir / "API"
interesesFile = dataDir / "intereses.json"
dividendosFile = dataDir / "dividendos.json"
operacionesFile = dataDir / "operaciones.json"
ventasFile = dataDir / "ventas.json"
transaccionesFile = dataDir / "transacciones.json"
stablecoinsFile = dataDir / "stablecoins.json"
twelvedataKeyFile = apiDir / "twelvedata.key"
finnhubKeyFile = apiDir / "finnhub.key"
eodhdKeyFile = apiDir / "eodhd.key"
_eodhdKeyRotationIndex = 0


def ensureDataFile():
    dataDir.mkdir(parents=True, exist_ok=True)
    activosDir.mkdir(parents=True, exist_ok=True)
    gastosDir.mkdir(parents=True, exist_ok=True)
    ventasDir.mkdir(parents=True, exist_ok=True)
    apiDir.mkdir(parents=True, exist_ok=True)

    if not interesesFile.exists():
        with interesesFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)

    if not dividendosFile.exists():
        with dividendosFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)

    if not operacionesFile.exists():
        with operacionesFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)

    if not ventasFile.exists():
        with ventasFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)

    if not transaccionesFile.exists():
        with transaccionesFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)

    if not stablecoinsFile.exists():
        with stablecoinsFile.open("w", encoding="utf-8") as file:
            json.dump({"catalog": [], "enabledSymbols": [], "rows": []}, file, ensure_ascii=False, indent=2)


def readInteresesFile():
    ensureDataFile()

    with interesesFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeInteresesFile(data):
    ensureDataFile()

    with interesesFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readDividendosFile():
    ensureDataFile()

    with dividendosFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeDividendosFile(data):
    ensureDataFile()

    with dividendosFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readOperacionesFile():
    ensureDataFile()

    with operacionesFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeOperacionesFile(data):
    ensureDataFile()

    with operacionesFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readVentasFile():
    ensureDataFile()

    with ventasFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeVentasFile(data):
    ensureDataFile()

    with ventasFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readTransaccionesFile():
    ensureDataFile()

    with transaccionesFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeTransaccionesFile(data):
    ensureDataFile()

    with transaccionesFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readStablecoinsFile():
    ensureDataFile()

    with stablecoinsFile.open("r", encoding="utf-8") as file:
        return json.load(file)


def writeStablecoinsFile(data):
    ensureDataFile()

    with stablecoinsFile.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def readFinnhubApiKey():
    ensureDataFile()

    if finnhubKeyFile.exists():
        with finnhubKeyFile.open("r", encoding="utf-8") as file:
            for line in file:
                apiKey = line.strip()

                if apiKey and not apiKey.startswith("#"):
                    return apiKey

    if twelvedataKeyFile.exists():
        with twelvedataKeyFile.open("r", encoding="utf-8") as file:
            for line in file:
                apiKey = line.strip()

                if apiKey and not apiKey.startswith("#"):
                    return apiKey

    return None


def readEodhdApiKey():
    ensureDataFile()

    if eodhdKeyFile.exists():
        with eodhdKeyFile.open("r", encoding="utf-8") as file:
            for line in file:
                apiKey = line.strip()

                if apiKey and not apiKey.startswith("#"):
                    return apiKey

    return None


def readEodhdApiKeys():
    ensureDataFile()

    apiKeys = []

    if not eodhdKeyFile.exists():
        return apiKeys

    with eodhdKeyFile.open("r", encoding="utf-8") as file:
        for line in file:
            apiKey = line.strip()

            if apiKey and not apiKey.startswith("#") and apiKey not in apiKeys:
                apiKeys.append(apiKey)

    return apiKeys


def readRotatedEodhdApiKeys():
    global _eodhdKeyRotationIndex

    apiKeys = readEodhdApiKeys()

    if not apiKeys:
        return []

    startIndex = _eodhdKeyRotationIndex % len(apiKeys)
    _eodhdKeyRotationIndex = (startIndex + 1) % len(apiKeys)

    return apiKeys[startIndex:] + apiKeys[:startIndex]
