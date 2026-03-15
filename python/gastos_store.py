import json

from app_data import ensureDataFile, gastosDir

GASTOS_TYPES = {"gasoil", "cafe", "comidas/cenas", "compras", "otros"}
MONTH_KEYS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
]
DEFAULT_MENSUALIDADES = ["iCloud", "Office", "Proton", "Spotify", "Rainbow", "ChatGPT", "AppleCare"]
DEFAULT_GASTOS_TYPES = ["Gasoil", "Café", "Comidas/Cenas", "Compras", "Otros"]


def normalize_year(year_value):
    text = str(year_value or "").strip()
    if not text.isdigit() or len(text) != 4:
        return None
    return text


def get_year_file(year):
    normalized_year = normalize_year(year)
    if not normalized_year:
        return None
    return gastosDir / f"{normalized_year}.json"


def build_empty_month_summary():
    return {month: "" for month in MONTH_KEYS}


def create_default_gastos_year(year):
    normalized_year = normalize_year(year)
    return {
        "year": normalized_year,
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


def list_gastos_years():
    ensureDataFile()
    years = []

    for file_path in gastosDir.glob("*.json"):
        year = normalize_year(file_path.stem)
        if year:
            years.append(year)

    return sorted(years)


def read_gastos_year(year):
    ensureDataFile()
    year_file = get_year_file(year)

    if year_file is None or not year_file.exists():
        return None

    with year_file.open("r", encoding="utf-8") as file:
        data = json.load(file)

    return sanitize_gastos_payload(data, year)[0]


def write_gastos_year(year, data):
    ensureDataFile()
    year_file = get_year_file(year)
    if year_file is None:
        return

    with year_file.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)


def delete_gastos_year(year):
    ensureDataFile()
    year_file = get_year_file(year)

    if year_file is None or not year_file.exists():
        return False

    year_file.unlink()
    return True


def sanitize_month_rows(rows):
    sanitized_rows = []

    for row in rows:
        tipo_original = str(row.get("tipo", "")).strip()
        tipo_normalizado = tipo_original.lower()

        if tipo_normalizado not in GASTOS_TYPES:
            continue

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


def sanitize_gastos_payload(payload, fallback_year=None):
    year = normalize_year(payload.get("year") or fallback_year)
    if not year:
        return None, "Año inválido"

    mensualidades = sanitize_mensualidades_rows(payload.get("mensualidades", []))
    if not mensualidades:
        mensualidades = create_default_gastos_year(year)["mensualidades"]

    months_payload = payload.get("months", {})
    sanitized_months = {}

    for month in MONTH_KEYS:
        month_data = months_payload.get(month, {})
        sanitized_months[month] = {
            "rows": sanitize_month_rows(month_data.get("rows", []))
        }

    return {
        "year": year,
        "mensualidades": mensualidades,
        "months": sanitized_months
    }, None
