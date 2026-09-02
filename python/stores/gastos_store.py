import json

from core.db import get_db, transactional

_MAX_LABEL = 80
_MAX_NAME = 120
_MAX_SHORT = 30
_MAX_NOTA = 300

MONTH_KEYS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]
DEFAULT_MENSUALIDADES = []

# Cada frecuencia indica cada cuántos meses se renueva el cargo.
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


def normalize_dias_cobro(value):
    """Días de cobro que se salen del día por defecto, por mes.

    Entra un dict `{"marzo": "5"}` —o el JSON con el que se guarda— y sale otro
    con solo los meses reconocibles y los días entre 1 y 31. Se descarta lo
    demás en vez de rechazar la fila entera: un mes mal escrito no debe costar
    el guardado de una mensualidad.
    """
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip() else {}
        except ValueError:
            return {}

    if not isinstance(value, dict):
        return {}

    dias = {}
    for month in MONTH_KEYS:
        day = normalize_dia_cobro(value.get(month))
        if day:
            dias[month] = day
    return dias


def serialize_dias_cobro(value):
    """El dict de excepciones, listo para la columna. Vacío se guarda como ''."""
    dias = normalize_dias_cobro(value)
    return json.dumps(dias, ensure_ascii=False, sort_keys=True) if dias else ""


def normalize_year(year_value):
    text = str(year_value or "").strip()
    if not text.isdigit() or len(text) != 4:
        return None
    return text


def build_empty_month_summary():
    return dict.fromkeys(MONTH_KEYS, "")


def create_default_gastos_year(year):
    normalized_year = normalize_year(year)
    empty_months = build_empty_month_summary()
    return {
        "year": normalized_year,
        "gastosTipos": [],
        "mensualidades": [
            {"nombre": name, "meses": dict(empty_months)}
            for name in DEFAULT_MENSUALIDADES
        ],
        "months": {month: {"rows": []} for month in MONTH_KEYS},
    }


# --- Sanitize helpers (sin I/O, usados por rutas) ---

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


def sanitize_mensualidades_rows(rows):
    if not isinstance(rows, list):
        return []
    if len(rows) > 100:
        rows = rows[:100]

    # La tabla exige (year, nombre) único: se desduplican los nombres repetidos
    # en vez de dejar que el INSERT falle y se pierda todo el guardado.
    seen = set()

    def unique_name(value):
        base = str(value or "")[:_MAX_NAME].strip() or "Mensualidad"
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
            "diasCobro": normalize_dias_cobro(row.get("diasCobro")),
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


def sanitize_gastos_types(payload):
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


def sanitize_gastos_payload(payload, fallback_year=None):
    year = normalize_year(payload.get("year") or fallback_year)
    if not year:
        return None, "Año inválido"

    mensualidades = sanitize_mensualidades_rows(payload.get("mensualidades", []))

    gastos_tipos = sanitize_gastos_types(payload.get("gastosTipos", []))
    seen_tipos = {label.lower() for label in gastos_tipos}

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
            gastos_tipos.append(label)
            seen_tipos.add(normalized)

    return {
        "year": year,
        "gastosTipos": gastos_tipos,
        "mensualidades": mensualidades,
        "months": sanitized_months,
    }, None


# --- Persistencia ---

def read_gastos_types():
    conn = get_db()
    return [r["label"] for r in conn.execute("SELECT label FROM gastos_tipos ORDER BY rowid").fetchall()]


@transactional
def write_gastos_types(types):
    conn = get_db()
    sanitized = sanitize_gastos_types(types)
    conn.execute("DELETE FROM gastos_tipos")
    conn.executemany("INSERT INTO gastos_tipos (label) VALUES (?)", [(t,) for t in sanitized])
    conn.commit()


def list_gastos_years():
    conn = get_db()
    rows = conn.execute("SELECT year FROM gastos_years ORDER BY year").fetchall()
    return [r["year"] for r in rows]


def read_gastos_year(year):
    normalized = normalize_year(year)
    if not normalized:
        return None

    conn = get_db()
    if not conn.execute("SELECT 1 FROM gastos_years WHERE year = ? LIMIT 1", (normalized,)).fetchone():
        return None

    mensualidades = [
        {
            "nombre": r["nombre"],
            "categoria": r["categoria"],
            "importe": r["importe"],
            "frecuencia": normalize_frecuencia(r["frecuencia"]),
            "diaCobro": normalize_dia_cobro(r["dia_cobro"]),
            "diasCobro": normalize_dias_cobro(r["dias_cobro"]),
            "mesInicio": normalize_mes(r["mes_inicio"]),
            "activa": bool(r["activa"]),
            "nota": r["nota"],
            "meses": {month: r[month] for month in MONTH_KEYS},
        }
        for r in conn.execute(
            "SELECT nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
            "septiembre, octubre, noviembre, diciembre, "
            "categoria, importe, frecuencia, dia_cobro, dias_cobro, mes_inicio, activa, nota "
            "FROM mensualidades WHERE year = ? ORDER BY id",
            (normalized,)
        ).fetchall()
    ]

    months = {}
    for month in MONTH_KEYS:
        month_rows = conn.execute(
            "SELECT fecha, nombre, tipo, cantidad FROM gastos_rows "
            "WHERE year = ? AND month = ? ORDER BY id",
            (normalized, month)
        ).fetchall()
        months[month] = {"rows": [
            {"fecha": r["fecha"], "nombre": r["nombre"], "tipo": r["tipo"], "cantidad": r["cantidad"]}
            for r in month_rows
        ]}

    return {
        "year": normalized,
        "gastosTipos": read_gastos_types(),
        "mensualidades": mensualidades,
        "months": months,
    }


@transactional
def write_gastos_year(year, data):
    normalized = normalize_year(year)
    if not normalized:
        return

    conn = get_db()
    conn.execute("INSERT OR IGNORE INTO gastos_years (year) VALUES (?)", (normalized,))
    conn.execute("DELETE FROM gastos_rows WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM mensualidades WHERE year = ?", (normalized,))

    conn.executemany(
        "INSERT INTO mensualidades "
        "(year, nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
        "septiembre, octubre, noviembre, diciembre, "
        "categoria, importe, frecuencia, dia_cobro, dias_cobro, mes_inicio, activa, nota) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
             serialize_dias_cobro(m.get("diasCobro")),
             normalize_mes(m.get("mesInicio")),
             1 if m.get("activa", True) else 0,
             m.get("nota", ""))
            for m in data.get("mensualidades", [])
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
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        rows_to_insert
    )

    # Tipos son globales: añadir los nuevos sin borrar los existentes
    if data.get("gastosTipos"):
        existing = {r["label"] for r in conn.execute("SELECT label FROM gastos_tipos").fetchall()}
        conn.executemany(
            "INSERT OR IGNORE INTO gastos_tipos (label) VALUES (?)",
            [(t,) for t in data["gastosTipos"] if t not in existing]
        )

    conn.commit()


@transactional
def delete_gastos_year(year):
    normalized = normalize_year(year)
    if not normalized:
        return False

    conn = get_db()
    r = conn.execute("DELETE FROM gastos_years WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM gastos_rows WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM mensualidades WHERE year = ?", (normalized,))
    conn.commit()
    return r.rowcount > 0
