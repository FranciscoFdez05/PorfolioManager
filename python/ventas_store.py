from db import get_db
from gastos_store import normalize_year

_MAX_SHORT = 30
_MAX_NAME = 120


def create_default_ventas_year(year):
    return {"year": normalize_year(year), "rows": []}


def sanitize_ventas_rows(rows):
    if not isinstance(rows, list):
        return []
    if len(rows) > 500:
        rows = rows[:500]
    sanitized = []
    for index, row in enumerate(rows):
        sanitized.append({
            "id": str(row.get("id", f"venta-{index + 1}"))[:_MAX_SHORT].strip() or f"venta-{index + 1}",
            "fecha": str(row.get("fecha", ""))[:_MAX_SHORT].strip(),
            "assetId": str(row.get("assetId", ""))[:_MAX_SHORT].strip(),
            "activo": str(row.get("activo", ""))[:_MAX_NAME].strip(),
            "cantidad": str(row.get("cantidad", ""))[:_MAX_SHORT].strip(),
            "valorCompra": str(row.get("valorCompra", row.get("precioCompra", row.get("valor_compra", ""))))[:_MAX_SHORT].strip(),
            "valorVenta": str(row.get("valorVenta", row.get("precioVenta", row.get("valor_venta", ""))))[:_MAX_SHORT].strip(),
            "dineroDeclarar": str(row.get("dineroDeclarar", row.get("gananciaRealizada", "")))[:_MAX_SHORT].strip(),
            "tramo1": str(row.get("tramo1", ""))[:_MAX_SHORT].strip(),
            "tramo2": str(row.get("tramo2", ""))[:_MAX_SHORT].strip(),
            "tramo3": str(row.get("tramo3", ""))[:_MAX_SHORT].strip(),
            "tramo4": str(row.get("tramo4", ""))[:_MAX_SHORT].strip(),
            "tramo5": str(row.get("tramo5", ""))[:_MAX_SHORT].strip(),
            "totalPagar": str(row.get("totalPagar", row.get("impuestos", "")))[:_MAX_SHORT].strip(),
            "bruto": str(row.get("bruto", ""))[:_MAX_SHORT].strip(),
            "neto": str(row.get("neto", ""))[:_MAX_SHORT].strip(),
        })
    return sanitized


def sanitize_ventas_payload(payload, fallback_year=None):
    year = normalize_year(payload.get("year") or fallback_year)
    if not year:
        return None, "Año inválido"
    return {"year": year, "rows": sanitize_ventas_rows(payload.get("rows", []))}, None


def list_ventas_years():
    conn = get_db()
    return [r["year"] for r in conn.execute("SELECT year FROM ventas_years ORDER BY year").fetchall()]


def read_ventas_year(year):
    normalized = normalize_year(year)
    if not normalized:
        return None

    conn = get_db()
    year_exists = conn.execute("SELECT 1 FROM ventas_years WHERE year = ?", (normalized,)).fetchone()
    if not year_exists:
        return None

    rows = conn.execute(
        "SELECT id, fecha, asset_id, activo, cantidad, valor_compra, valor_venta, "
        "dinero_declarar, tramo1, tramo2, tramo3, tramo4, tramo5, total_pagar, bruto, neto "
        "FROM ventas WHERE year = ? ORDER BY rowid",
        (normalized,)
    ).fetchall()

    return {
        "year": normalized,
        "rows": [
            {
                "id": r["id"],
                "fecha": r["fecha"],
                "assetId": r["asset_id"],
                "activo": r["activo"],
                "cantidad": r["cantidad"],
                "valorCompra": r["valor_compra"],
                "valorVenta": r["valor_venta"],
                "dineroDeclarar": r["dinero_declarar"],
                "tramo1": r["tramo1"],
                "tramo2": r["tramo2"],
                "tramo3": r["tramo3"],
                "tramo4": r["tramo4"],
                "tramo5": r["tramo5"],
                "totalPagar": r["total_pagar"],
                "bruto": r["bruto"],
                "neto": r["neto"],
            }
            for r in rows
        ],
    }


def write_ventas_year(year, data):
    normalized = normalize_year(year)
    if not normalized:
        return

    conn = get_db()
    conn.execute("INSERT OR IGNORE INTO ventas_years (year) VALUES (?)", (normalized,))
    conn.execute("DELETE FROM ventas WHERE year = ?", (normalized,))
    conn.executemany(
        "INSERT INTO ventas "
        "(id, year, fecha, asset_id, activo, cantidad, valor_compra, valor_venta, "
        "dinero_declarar, tramo1, tramo2, tramo3, tramo4, tramo5, total_pagar, bruto, neto) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), normalized, r.get("fecha", ""), r.get("assetId", ""),
             r.get("activo", ""), r.get("cantidad", ""), r.get("valorCompra", ""),
             r.get("valorVenta", ""), r.get("dineroDeclarar", ""),
             r.get("tramo1", ""), r.get("tramo2", ""), r.get("tramo3", ""),
             r.get("tramo4", ""), r.get("tramo5", ""), r.get("totalPagar", ""),
             r.get("bruto", ""), r.get("neto", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


def delete_ventas_year(year):
    normalized = normalize_year(year)
    if not normalized:
        return False

    conn = get_db()
    conn.execute("DELETE FROM ventas WHERE year = ?", (normalized,))
    result = conn.execute("DELETE FROM ventas_years WHERE year = ?", (normalized,))
    conn.commit()
    return result.rowcount > 0


def migrate_legacy_ventas_if_needed(default_year):
    """En la versión SQLite no hay ficheros legacy que migrar.
    Si no hay ningún año crea uno vacío con el año por defecto.
    También migra años existentes en la tabla ventas que no estén en ventas_years."""
    conn = get_db()
    conn.execute("INSERT OR IGNORE INTO ventas_years (year) SELECT DISTINCT year FROM ventas")
    conn.commit()
    years = list_ventas_years()
    if years:
        return years
    write_ventas_year(default_year, create_default_ventas_year(default_year))
    return [default_year]


def read_all_ventas_rows():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, fecha, asset_id, activo, cantidad, valor_compra, valor_venta, "
        "dinero_declarar, tramo1, tramo2, tramo3, tramo4, tramo5, total_pagar, bruto, neto "
        "FROM ventas ORDER BY year, rowid"
    ).fetchall()
    return [
        {
            "id": r["id"],
            "fecha": r["fecha"],
            "assetId": r["asset_id"],
            "activo": r["activo"],
            "cantidad": r["cantidad"],
            "valorCompra": r["valor_compra"],
            "valorVenta": r["valor_venta"],
            "dineroDeclarar": r["dinero_declarar"],
            "tramo1": r["tramo1"],
            "tramo2": r["tramo2"],
            "tramo3": r["tramo3"],
            "tramo4": r["tramo4"],
            "tramo5": r["tramo5"],
            "totalPagar": r["total_pagar"],
            "bruto": r["bruto"],
            "neto": r["neto"],
        }
        for r in rows
    ]


def extract_year_from_sale_date(value, fallback_year):
    text = str(value or "").strip()
    if len(text) >= 4 and text[:4].isdigit() and (len(text) == 4 or text[4] in "-/"):
        return text[:4]
    if len(text) >= 4 and text[-4:].isdigit():
        return text[-4:]
    return fallback_year
