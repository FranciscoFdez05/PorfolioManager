from db import get_db, transactional

_MAX_LABEL = 80
_MAX_NAME = 120
_MAX_SHORT = 30
_MAX_NOTA = 300

MONTH_KEYS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]
DEFAULT_RECURRENTES = []

# Cada frecuencia indica cada cuántos meses se repite el cobro.
FRECUENCIAS = {
    "mensual": 1,
    "bimestral": 2,
    "trimestral": 3,
    "cuatrimestral": 4,
    "semestral": 6,
    "anual": 12,
}
DEFAULT_FRECUENCIA = "mensual"


def normalize_frecuencia(value):
    text = str(value or "").strip().lower()
    return text if text in FRECUENCIAS else DEFAULT_FRECUENCIA


def normalize_mes(value):
    text = str(value or "").strip().lower()
    return text if text in MONTH_KEYS else MONTH_KEYS[0]


def normalize_dia_cobro(value):
    text = str(value or "").strip()
    if not text.isdigit():
        return ""
    day = int(text)
    return str(day) if 1 <= day <= 31 else ""


def normalize_year(year_value):
    text = str(year_value or "").strip()
    if not text.isdigit() or len(text) != 4:
        return None
    return text


def build_empty_month_summary():
    return {month: "" for month in MONTH_KEYS}


def create_default_ingresos_year(year):
    normalized_year = normalize_year(year)
    empty_months = build_empty_month_summary()
    return {
        "year": normalized_year,
        "ingresosTipos": [],
        "recurrentes": [
            {"nombre": name, "meses": dict(empty_months)}
            for name in DEFAULT_RECURRENTES
        ],
        "months": {month: {"rows": []} for month in MONTH_KEYS},
    }


def sanitize_month_rows(rows):
    if not isinstance(rows, list):
        return []
    if len(rows) > 1000:
        rows = rows[:1000]
    return [
        {
            "fecha": str(row.get("fecha", ""))[:_MAX_SHORT].strip(),
            "nombre": str(row.get("nombre", ""))[:_MAX_NAME].strip(),
            "tipo": str(row.get("tipo", ""))[:_MAX_LABEL].strip(),
            "cantidad": str(row.get("cantidad", ""))[:_MAX_SHORT].strip(),
        }
        for row in rows
    ]


def sanitize_recurrentes_rows(rows):
    if not isinstance(rows, list):
        return []
    if len(rows) > 100:
        rows = rows[:100]

    # La tabla exige (year, nombre) único: se desduplican los nombres repetidos
    # en vez de dejar que el INSERT falle y se pierda todo el guardado.
    seen = set()

    def unique_name(value):
        base = str(value or "")[:_MAX_NAME].strip() or "Recurrente"
        name = base
        suffix = 2
        while name.lower() in seen:
            name = f"{base} ({suffix})"[:_MAX_NAME]
            suffix += 1
        seen.add(name.lower())
        return name

    return [
        {
            "nombre": unique_name(row.get("nombre", "")),
            "categoria": str(row.get("categoria", ""))[:_MAX_LABEL].strip(),
            "importe": str(row.get("importe", ""))[:_MAX_SHORT].strip(),
            "frecuencia": normalize_frecuencia(row.get("frecuencia")),
            "diaCobro": normalize_dia_cobro(row.get("diaCobro")),
            "mesInicio": normalize_mes(row.get("mesInicio")),
            "activa": bool(row.get("activa", True)),
            "nota": str(row.get("nota", ""))[:_MAX_NOTA].strip(),
            "meses": {
                month: str(row.get("meses", {}).get(month, ""))[:_MAX_SHORT].strip()
                for month in MONTH_KEYS
            },
        }
        for row in rows
    ]


def sanitize_ingresos_types(payload):
    values = payload.get("types", payload) if isinstance(payload, dict) else payload
    if not isinstance(values, list):
        return []
    sanitized = []
    seen = set()
    for value in values[:200]:
        label = str(value or "")[:_MAX_LABEL].strip()
        normalized = label.lower()
        if not label or normalized in seen:
            continue
        sanitized.append(label)
        seen.add(normalized)
    return sanitized


def sanitize_ingresos_payload(payload, fallback_year=None):
    year = normalize_year(payload.get("year") or fallback_year)
    if not year:
        return None, "Año inválido"

    recurrentes = sanitize_recurrentes_rows(payload.get("recurrentes", []))

    ingresos_tipos = sanitize_ingresos_types(payload.get("ingresosTipos", []))
    seen_tipos = {label.lower() for label in ingresos_tipos}

    sanitized_months = {}
    for month in MONTH_KEYS:
        month_data = payload.get("months", {}).get(month, {})
        sanitized_rows = sanitize_month_rows(month_data.get("rows", []))
        sanitized_months[month] = {"rows": sanitized_rows}

        for row in sanitized_rows:
            label = str(row.get("tipo", "")).strip()
            normalized = label.lower()
            if not label or normalized in seen_tipos:
                continue
            ingresos_tipos.append(label)
            seen_tipos.add(normalized)

    return {
        "year": year,
        "ingresosTipos": ingresos_tipos,
        "recurrentes": recurrentes,
        "months": sanitized_months,
    }, None


def read_ingresos_types():
    conn = get_db()
    return [r["label"] for r in conn.execute("SELECT label FROM ingresos_tipos ORDER BY rowid").fetchall()]


@transactional
def write_ingresos_types(types):
    conn = get_db()
    sanitized = sanitize_ingresos_types(types)
    conn.execute("DELETE FROM ingresos_tipos")
    conn.executemany("INSERT INTO ingresos_tipos (label) VALUES (?)", [(t,) for t in sanitized])
    conn.commit()


def list_ingresos_years():
    conn = get_db()
    rows = conn.execute(
        "SELECT DISTINCT year FROM ingresos_rows "
        "UNION SELECT DISTINCT year FROM ingresos_recurrentes "
        "ORDER BY year"
    ).fetchall()
    return [r["year"] for r in rows]


def read_ingresos_year(year):
    normalized = normalize_year(year)
    if not normalized:
        return None

    conn = get_db()
    has_rows = conn.execute(
        "SELECT 1 FROM ingresos_rows WHERE year = ? LIMIT 1", (normalized,)
    ).fetchone()
    has_rec = conn.execute(
        "SELECT 1 FROM ingresos_recurrentes WHERE year = ? LIMIT 1", (normalized,)
    ).fetchone()

    if not has_rows and not has_rec:
        return None

    recurrentes = [
        {
            "nombre": r["nombre"],
            "categoria": r["categoria"],
            "importe": r["importe"],
            "frecuencia": normalize_frecuencia(r["frecuencia"]),
            "diaCobro": normalize_dia_cobro(r["dia_cobro"]),
            "mesInicio": normalize_mes(r["mes_inicio"]),
            "activa": bool(r["activa"]),
            "nota": r["nota"],
            "meses": {month: r[month] for month in MONTH_KEYS},
        }
        for r in conn.execute(
            "SELECT nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
            "septiembre, octubre, noviembre, diciembre, "
            "categoria, importe, frecuencia, dia_cobro, mes_inicio, activa, nota "
            "FROM ingresos_recurrentes WHERE year = ? ORDER BY id",
            (normalized,)
        ).fetchall()
    ]

    months = {}
    for month in MONTH_KEYS:
        month_rows = conn.execute(
            "SELECT fecha, nombre, tipo, cantidad FROM ingresos_rows "
            "WHERE year = ? AND month = ? ORDER BY id",
            (normalized, month)
        ).fetchall()
        months[month] = {"rows": [
            {"fecha": r["fecha"], "nombre": r["nombre"], "tipo": r["tipo"], "cantidad": r["cantidad"]}
            for r in month_rows
        ]}

    return {
        "year": normalized,
        "ingresosTipos": read_ingresos_types(),
        "recurrentes": recurrentes,
        "months": months,
    }


@transactional
def write_ingresos_year(year, data):
    normalized = normalize_year(year)
    if not normalized:
        return

    conn = get_db()
    conn.execute("DELETE FROM ingresos_rows WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM ingresos_recurrentes WHERE year = ?", (normalized,))

    conn.executemany(
        "INSERT INTO ingresos_recurrentes "
        "(year, nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
        "septiembre, octubre, noviembre, diciembre, "
        "categoria, importe, frecuencia, dia_cobro, mes_inicio, activa, nota) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (normalized, m.get("nombre", ""),
             m.get("meses", {}).get("enero", ""), m.get("meses", {}).get("febrero", ""),
             m.get("meses", {}).get("marzo", ""), m.get("meses", {}).get("abril", ""),
             m.get("meses", {}).get("mayo", ""), m.get("meses", {}).get("junio", ""),
             m.get("meses", {}).get("julio", ""), m.get("meses", {}).get("agosto", ""),
             m.get("meses", {}).get("septiembre", ""), m.get("meses", {}).get("octubre", ""),
             m.get("meses", {}).get("noviembre", ""), m.get("meses", {}).get("diciembre", ""),
             m.get("categoria", ""), m.get("importe", ""),
             normalize_frecuencia(m.get("frecuencia")),
             normalize_dia_cobro(m.get("diaCobro")),
             normalize_mes(m.get("mesInicio")),
             1 if m.get("activa", True) else 0,
             m.get("nota", ""))
            for m in data.get("recurrentes", [])
        ]
    )

    rows_to_insert = []
    for month in MONTH_KEYS:
        for row in data.get("months", {}).get(month, {}).get("rows", []):
            rows_to_insert.append((
                normalized, month,
                row.get("fecha", ""), row.get("nombre", ""),
                row.get("tipo", ""), row.get("cantidad", ""),
            ))
    conn.executemany(
        "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        rows_to_insert
    )

    if data.get("ingresosTipos"):
        existing = {r["label"] for r in conn.execute("SELECT label FROM ingresos_tipos").fetchall()}
        conn.executemany(
            "INSERT OR IGNORE INTO ingresos_tipos (label) VALUES (?)",
            [(t,) for t in data["ingresosTipos"] if t not in existing]
        )

    conn.commit()


@transactional
def delete_ingresos_year(year):
    normalized = normalize_year(year)
    if not normalized:
        return False

    conn = get_db()
    r1 = conn.execute("DELETE FROM ingresos_rows WHERE year = ?", (normalized,))
    r2 = conn.execute("DELETE FROM ingresos_recurrentes WHERE year = ?", (normalized,))
    conn.commit()
    return (r1.rowcount + r2.rowcount) > 0
