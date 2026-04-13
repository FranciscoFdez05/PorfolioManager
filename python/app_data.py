import json
import os
from pathlib import Path


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

_FILE_DEFAULTS = [
    (interesesFile, {"rows": []}),
    (dividendosFile, {"rows": []}),
    (operacionesFile, {"rows": []}),
    (ventasFile, {"rows": []}),
    (transaccionesFile, {"rows": []}),
    (stablecoinsFile, {"catalog": [], "enabledSymbols": [], "rows": []}),
]


def _read_json(file_path):
    with file_path.open("r", encoding="utf-8") as file:
        return json.load(file)


def _write_json(file_path, data):
    with file_path.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def _read_first_api_key(file_path):
    if not file_path.exists():
        return None
    with file_path.open("r", encoding="utf-8") as file:
        for line in file:
            apiKey = line.strip()
            if apiKey and not apiKey.startswith("#"):
                return apiKey
    return None


def ensureDataFile():
    for directory in (dataDir, activosDir, gastosDir, ventasDir, apiDir):
        directory.mkdir(parents=True, exist_ok=True)

    for file_path, default in _FILE_DEFAULTS:
        if not file_path.exists():
            _write_json(file_path, default)


def readInteresesFile():
    ensureDataFile()
    return _read_json(interesesFile)


def writeInteresesFile(data):
    ensureDataFile()
    _write_json(interesesFile, data)


def readDividendosFile():
    ensureDataFile()
    return _read_json(dividendosFile)


def writeDividendosFile(data):
    ensureDataFile()
    _write_json(dividendosFile, data)


def readOperacionesFile():
    ensureDataFile()
    return _read_json(operacionesFile)


def writeOperacionesFile(data):
    ensureDataFile()
    _write_json(operacionesFile, data)


def readVentasFile():
    ensureDataFile()
    return _read_json(ventasFile)


def writeVentasFile(data):
    ensureDataFile()
    _write_json(ventasFile, data)


def readTransaccionesFile():
    ensureDataFile()
    return _read_json(transaccionesFile)


def writeTransaccionesFile(data):
    ensureDataFile()
    _write_json(transaccionesFile, data)


def readStablecoinsFile():
    ensureDataFile()
    return _read_json(stablecoinsFile)


def writeStablecoinsFile(data):
    ensureDataFile()
    _write_json(stablecoinsFile, data)


def readFinnhubApiKey():
    key = os.environ.get("FINNHUB_API_KEY", "").strip()
    if key:
        return key
    ensureDataFile()
    return _read_first_api_key(finnhubKeyFile) or _read_first_api_key(twelvedataKeyFile)


def readEodhdApiKey():
    env_keys = os.environ.get("EODHD_API_KEYS", "").strip()
    if env_keys:
        first_key = env_keys.split(",")[0].strip()
        if first_key:
            return first_key
    ensureDataFile()
    return _read_first_api_key(eodhdKeyFile)


def readEodhdApiKeys():
    env_keys_str = os.environ.get("EODHD_API_KEYS", "").strip()
    if env_keys_str:
        return [k.strip() for k in env_keys_str.split(",") if k.strip()]

    ensureDataFile()

    if not eodhdKeyFile.exists():
        return []

    seen = set()
    apiKeys = []

    with eodhdKeyFile.open("r", encoding="utf-8") as file:
        for line in file:
            apiKey = line.strip()
            if apiKey and not apiKey.startswith("#") and apiKey not in seen:
                apiKeys.append(apiKey)
                seen.add(apiKey)

    return apiKeys


def readRotatedEodhdApiKeys():
    global _eodhdKeyRotationIndex

    apiKeys = readEodhdApiKeys()

    if not apiKeys:
        return []

    startIndex = _eodhdKeyRotationIndex % len(apiKeys)
    _eodhdKeyRotationIndex = (startIndex + 1) % len(apiKeys)

    return apiKeys[startIndex:] + apiKeys[:startIndex]
