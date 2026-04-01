import json

from app_data import ensureDataFile, ventasDir, ventasFile
from gastos_store import normalize_year


def get_ventas_year_file(year):
    normalized_year = normalize_year(year)
    if not normalized_year:
        return None
    return ventasDir / f"ventas{normalized_year}.json"


def get_legacy_ventas_year_file(year):
    normalized_year = normalize_year(year)
    if not normalized_year:
        return None
    return ventasDir / f"{normalized_year}.json"


def resolve_existing_ventas_year_file(year):
    preferred_file = get_ventas_year_file(year)
    legacy_file = get_legacy_ventas_year_file(year)

    if preferred_file and preferred_file.exists():
        return preferred_file

    if legacy_file and legacy_file.exists():
        return legacy_file

    return preferred_file


def extract_year_from_ventas_filename(file_path):
    stem = file_path.stem
    normalized_stem = stem.lower()

    if normalized_stem.startswith("ventas"):
        return normalize_year(stem[6:])

    return normalize_year(stem)


def create_default_ventas_year(year):
    normalized_year = normalize_year(year)
    return {
        "year": normalized_year,
        "rows": []
    }


def sanitize_ventas_rows(rows):
    sanitized_rows = []

    for index, row in enumerate(rows if isinstance(rows, list) else []):
        sanitized_rows.append({
            "id": str(row.get("id", f"venta-{index + 1}")).strip() or f"venta-{index + 1}",
            "fecha": str(row.get("fecha", "")).strip(),
            "assetId": str(row.get("assetId", "")).strip(),
            "activo": str(row.get("activo", "")).strip(),
            "cantidad": str(row.get("cantidad", "")).strip(),
            "valorCompra": str(row.get("valorCompra", row.get("precioCompra", row.get("valor_compra", "")))).strip(),
            "valorVenta": str(row.get("valorVenta", row.get("precioVenta", row.get("valor_venta", "")))).strip(),
            "dineroDeclarar": str(row.get("dineroDeclarar", row.get("gananciaRealizada", ""))).strip(),
            "tramo1": str(row.get("tramo1", "")).strip(),
            "tramo2": str(row.get("tramo2", "")).strip(),
            "tramo3": str(row.get("tramo3", "")).strip(),
            "tramo4": str(row.get("tramo4", "")).strip(),
            "tramo5": str(row.get("tramo5", "")).strip(),
            "totalPagar": str(row.get("totalPagar", row.get("impuestos", ""))).strip(),
            "bruto": str(row.get("bruto", "")).strip(),
            "neto": str(row.get("neto", "")).strip()
        })

    return sanitized_rows


def sanitize_ventas_payload(payload, fallback_year=None):
    year = normalize_year(payload.get("year") or fallback_year)
    if not year:
        return None, "Año inválido"

    return {
        "year": year,
        "rows": sanitize_ventas_rows(payload.get("rows", []))
    }, None


def list_ventas_years():
    ensureDataFile()
    years = []

    for file_path in ventasDir.glob("*.json"):
        year = extract_year_from_ventas_filename(file_path)
        if year and year not in years:
            years.append(year)

    return sorted(years)


def read_ventas_year(year):
    ensureDataFile()
    year_file = resolve_existing_ventas_year_file(year)

    if year_file is None or not year_file.exists():
        return None

    with year_file.open("r", encoding="utf-8") as file:
        data = json.load(file)

    return sanitize_ventas_payload(data, year)[0]


def write_ventas_year(year, data):
    ensureDataFile()
    year_file = get_ventas_year_file(year)
    legacy_year_file = get_legacy_ventas_year_file(year)

    if year_file is None:
        return

    with year_file.open("w", encoding="utf-8") as file:
        json.dump(data, file, ensure_ascii=False, indent=2)

    if legacy_year_file and legacy_year_file.exists() and legacy_year_file != year_file:
        legacy_year_file.unlink()


def delete_ventas_year(year):
    ensureDataFile()
    year_file = get_ventas_year_file(year)
    legacy_year_file = get_legacy_ventas_year_file(year)
    deleted = False

    for file_path in (year_file, legacy_year_file):
        if file_path is not None and file_path.exists():
            file_path.unlink()
            deleted = True

    return deleted


def extract_year_from_sale_date(value, fallback_year):
    text = str(value or "").strip()

    if len(text) >= 4 and text[:4].isdigit() and (len(text) == 4 or text[4] in "-/"):
        return text[:4]

    if len(text) >= 4 and text[-4:].isdigit():
        return text[-4:]

    return fallback_year


def migrate_legacy_ventas_if_needed(default_year):
    ensureDataFile()
    existing_years = list_ventas_years()

    if existing_years:
        return existing_years

    legacy_rows = []

    if ventasFile.exists():
        with ventasFile.open("r", encoding="utf-8") as file:
            legacy_data = json.load(file)
        legacy_rows = sanitize_ventas_rows(legacy_data.get("rows", []))

    if not legacy_rows:
        payload = create_default_ventas_year(default_year)
        write_ventas_year(default_year, payload)
        return [default_year]

    rows_by_year = {}

    for row in legacy_rows:
        row_year = normalize_year(extract_year_from_sale_date(row.get("fecha", ""), default_year)) or default_year
        rows_by_year.setdefault(row_year, []).append(row)

    for year, rows in rows_by_year.items():
        write_ventas_year(year, {"year": year, "rows": rows})

    return list_ventas_years()


def read_all_ventas_rows():
    ensureDataFile()
    rows = []

    for year in list_ventas_years():
        payload = read_ventas_year(year)
        rows.extend(payload.get("rows", []) if payload else [])

    return rows
