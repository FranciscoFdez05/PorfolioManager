from pathlib import Path
import json


baseDir = Path(__file__).resolve().parent.parent
dataDir = baseDir / "data"
activosDir = dataDir / "activos"
interesesFile = dataDir / "intereses.json"
dividendosFile = dataDir / "dividendos.json"


def ensureDataFile():
    dataDir.mkdir(parents=True, exist_ok=True)
    activosDir.mkdir(parents=True, exist_ok=True)

    if not interesesFile.exists():
        with interesesFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)

    if not dividendosFile.exists():
        with dividendosFile.open("w", encoding="utf-8") as file:
            json.dump({"rows": []}, file, ensure_ascii=False, indent=2)


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
