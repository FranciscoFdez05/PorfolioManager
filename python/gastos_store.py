import json

from app_data import ensureDataFile, gastosDir

MONTH_KEYS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
]
DEFAULT_MENSUALIDADES = ["iCloud", "Office", "Proton", "Spotify", "Rainbow", "ChatGPT", "AppleCare"]
GASTOS_TYPES_FILE = gastosDir / "tipos.json"

def normalize_year(year_value):
    text = str(year_value or "").strip()
    if not text.isdigit() or len(text) != 4:
        return None
    return text


def get_year_file(year):
    normalized_year = normalize_year(year)
    if not normalized_year:
        return None
    return gastosDir / f"gastos{normalized_year}.json"


def get_legacy_year_file(year):
    normalized_year = normalize_year(year)
    if not normalized_year:
        return None
    return gastosDir / f"{normalized_year}.json"


def resolve_existing_year_file(year):
    preferred_file = get_year_file(year)
    legacy_file = get_legacy_year_file(year)

    if preferred_file and preferred_file.exists():
        return preferred_file

    if legacy_file and legacy_file.exists():
        return legacy_file

    return preferred_file


def extract_year_from_gastos_filename(file_path):
    stem = file_path.stem
    normalized_stem = stem.lower()

    if normalized_stem.startswith("gastos"):
        return normalize_year(stem[6:])

    return normalize_year(stem)


def build_empty_month_summary():
    return {month: "" for month in MONTH_KEYS}


def create_default_gastos_year(year):
    normalized_year = normalize_year(year)
    return {
        "year": normalized_year,
        "gastosTipos": [],
        "mensualidades": [
            {"nombre": name, "meses": build_empty_month_summary()}
            for name in DEFAULT_MENSUALIDADES
        ],
        "months": {
            month: {
                "rows": []
            }
            for month in MONTH_KEYS
        }
    }


def read_gastos_types():
    ensureDataFile()

    if not GASTOS_TYPES_FILE.exists():
        return []

    with GASTOS_TYPES_FILE.open("r", encoding="utf-8") as file:
        data = json.load(file)

    return sanitize_gastos_types(data)


def write_gastos_types(types):
    ensureDataFile()

    with GASTOS_TYPES_FILE.open("w", encoding="utf-8") as file:
        json.dump({"types": sanitize_gastos_types(types)}, file, ensure_ascii=False, indent=2)


def list_gastos_years():
    ensureDataFile()
    years = []

    for file_path in gastosDir.glob("*.json"):
        year = extract_year_from_gastos_filename(file_path)
        if year and year not in years:
            years.append(year)

    return sorted(years)


def read_gastos_year(year):
    ensureDataFile()
    year_file = resolve_existing_year_file(year)

    if year_file is None or not year_file.exists():
        return None

    with year_file.open("r", encoding="utf-8") as file:
        data = json.load(file)

    return sanitize_gastos_payload(data, year)[0]


def write_gastos_year(year, data):
    ensureDataFile()
    year_file = get_year_file(year)
    legacy_year_file = get_legacy_year_file(year)
    if year_file is None:
        return

    with year_file.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)

    if legacy_year_file and legacy_year_file.exists() and legacy_year_file != year_file:
        legacy_year_file.unlink()


def delete_gastos_year(year):
    ensureDataFile()
    year_file = get_year_file(year)
    legacy_year_file = get_legacy_year_file(year)
    deleted = False

    for file_path in (year_file, legacy_year_file):
        if file_path is not None and file_path.exists():
            file_path.unlink()
            deleted = True

    return deleted


def sanitize_month_rows(rows):
    sanitized_rows = []

    for row in rows:
        tipo_original = str(row.get("tipo", "")).strip()

        sanitized_rows.append({
            "fecha": str(row.get("fecha", "")).strip(),
            "nombre": str(row.get("nombre", "")).strip(),
            "tipo": tipo_original,
            "cantidad": str(row.get("cantidad", "")).strip()
        })

    return sanitized_rows


def sanitize_mensualidades_rows(rows):
    sanitized_rows = []

    for row in rows if isinstance(rows, list) else []:
        meses = row.get("meses", {})
        sanitized_rows.append({
            "nombre": str(row.get("nombre", "")).strip() or "Mensualidad",
            "meses": {
                month: str(meses.get(month, "")).strip()
                for month in MONTH_KEYS
            }
        })

    return sanitized_rows


def sanitize_gastos_types(payload):
    values = payload.get("types", payload) if isinstance(payload, dict) else payload
    sanitized = []
    seen = set()

    for value in values if isinstance(values, list) else []:
        label = str(value or "").strip()
        normalized = label.lower()

        if not label or normalized in seen:
            continue

        sanitized.append(label)
        seen.add(normalized)

    return sanitized


def sanitize_gastos_payload(payload, fallback_year=None):
    year = normalize_year(payload.get("year") or fallback_year)
    if not year:
        return None, "Año inválido"

    mensualidades = sanitize_mensualidades_rows(payload.get("mensualidades", []))
    if not mensualidades:
        mensualidades = create_default_gastos_year(year)["mensualidades"]

    gastos_tipos = []
    seen_tipos = set()

    for value in payload.get("gastosTipos", []) if isinstance(payload.get("gastosTipos", []), list) else []:
        label = str(value or "").strip()
        normalized = label.lower()

        if not label or normalized in seen_tipos:
            continue

        gastos_tipos.append(label)
        seen_tipos.add(normalized)

    months_payload = payload.get("months", {})
    sanitized_months = {}

    for month in MONTH_KEYS:
        month_data = months_payload.get(month, {})
        sanitized_rows = sanitize_month_rows(month_data.get("rows", []))
        sanitized_months[month] = {
            "rows": sanitized_rows
        }

        for row in sanitized_rows:
            label = str(row.get("tipo", "")).strip()
            normalized = label.lower()

            if not label or normalized in seen_tipos:
                continue

            gastos_tipos.append(label)
            seen_tipos.add(normalized)

    return {
        "year": year,
        "gastosTipos": gastos_tipos,
        "mensualidades": mensualidades,
        "months": sanitized_months
    }, None
