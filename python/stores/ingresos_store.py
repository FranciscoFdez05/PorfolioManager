from core.db import getDb, transactional
from core.validation import normalizeYear
from stores import revisiones
from stores.cuentas_store import ID_BANCO, cuentasValidasParaFilas, normalizarCuentaDeFila
from stores.gastos_store import normalizeCuentasCobro, serializeCuentasCobro

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


def normalizeFrecuencia(value):
    text = str(value or "").strip().lower()
    return text if text in FRECUENCIAS else DEFAULT_FRECUENCIA


def normalizeMes(value):
    text = str(value or "").strip().lower()
    return text if text in MONTH_KEYS else MONTH_KEYS[0]


def normalizeDiaCobro(value):
    text = str(value or "").strip()
    if not text.isdigit():
        return ""
    day = int(text)
    return str(day) if 1 <= day <= 31 else ""


def buildEmptyMonthSummary():
    return dict.fromkeys(MONTH_KEYS, "")


def createDefaultIngresosYear(year):
    normalizedYear = normalizeYear(year)
    emptyMonths = buildEmptyMonthSummary()
    return {
        "year": normalizedYear,
        "ingresosTipos": [],
        "recurrentes": [
            {"nombre": name, "meses": dict(emptyMonths)}
            for name in DEFAULT_RECURRENTES
        ],
        "months": {month: {"rows": []} for month in MONTH_KEYS},
    }


def _dict(valor):
    return valor if isinstance(valor, dict) else {}


def sanitizeMonthRows(rows):
    if not isinstance(rows, list):
        return []
    # Un elemento que no es un objeto (`[1, "x"]`) llegaba a `row.get` y daba 500.
    rows = [row for row in rows if isinstance(row, dict)]
    if len(rows) > 1000:
        rows = rows[:1000]
    return [
        {
            "fecha": str(row.get("fecha", ""))[:_MAX_SHORT].strip(),
            "nombre": str(row.get("nombre", ""))[:_MAX_NAME].strip(),
            "tipo": str(row.get("tipo", ""))[:_MAX_LABEL].strip(),
            "cantidad": str(row.get("cantidad", ""))[:_MAX_SHORT].strip(),
            "nota": str(row.get("nota", ""))[:_MAX_NOTA].strip(),
            "cuenta": str(row.get("cuenta", ""))[:_MAX_SHORT * 2].strip(),
        }
        for row in rows
    ]


def sanitizeRecurrentesRows(rows):
    if not isinstance(rows, list):
        return []
    rows = [row for row in rows if isinstance(row, dict)]
    if len(rows) > 100:
        rows = rows[:100]

    # La tabla exige (year, nombre) único: se desduplican los nombres repetidos
    # en vez de dejar que el INSERT falle y se pierda todo el guardado.
    seen = set()

    def uniqueName(value):
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
            "nombre": uniqueName(row.get("nombre", "")),
            "categoria": str(row.get("categoria", ""))[:_MAX_LABEL].strip(),
            "importe": str(row.get("importe", ""))[:_MAX_SHORT].strip(),
            "frecuencia": normalizeFrecuencia(row.get("frecuencia")),
            "diaCobro": normalizeDiaCobro(row.get("diaCobro")),
            "mesInicio": normalizeMes(row.get("mesInicio")),
            "activa": bool(row.get("activa", True)),
            "nota": str(row.get("nota", ""))[:_MAX_NOTA].strip(),
            "cuenta": str(row.get("cuenta", ""))[:_MAX_SHORT * 2].strip(),
            "cuentasCobro": normalizeCuentasCobro(row.get("cuentasCobro")),
            "meses": {
                month: str(_dict(row.get("meses")).get(month, ""))[:_MAX_SHORT].strip()
                for month in MONTH_KEYS
            },
        }
        for row in rows
    ]


def sanitizeIngresosTypes(payload):
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


def sanitizeIngresosPayload(payload, fallbackYear=None):
    year = normalizeYear(payload.get("year") or fallbackYear)
    if not year:
        return None, "Año inválido"

    recurrentes = sanitizeRecurrentesRows(payload.get("recurrentes", []))

    ingresosTipos = sanitizeIngresosTypes(payload.get("ingresosTipos", []))
    seenTipos = {label.lower() for label in ingresosTipos}

    sanitizedMonths = {}
    for month in MONTH_KEYS:
        monthData = _dict(_dict(payload.get("months")).get(month))
        sanitizedRows = sanitizeMonthRows(monthData.get("rows", []))
        sanitizedMonths[month] = {"rows": sanitizedRows}

        for row in sanitizedRows:
            label = str(row.get("tipo", "")).strip()
            normalized = label.lower()
            if not label or normalized in seenTipos:
                continue
            ingresosTipos.append(label)
            seenTipos.add(normalized)

    return {
        "year": year,
        "ingresosTipos": ingresosTipos,
        "recurrentes": recurrentes,
        "months": sanitizedMonths,
    }, None


def readIngresosTypes():
    conn = getDb()
    return [r["label"] for r in conn.execute("SELECT label FROM ingresos_tipos ORDER BY rowid").fetchall()]


@transactional
def writeIngresosTypes(types):
    conn = getDb()
    sanitized = sanitizeIngresosTypes(types)
    conn.execute("DELETE FROM ingresos_tipos")
    conn.executemany("INSERT INTO ingresos_tipos (label) VALUES (?)", [(t,) for t in sanitized])
    conn.commit()


def listIngresosYears():
    conn = getDb()
    rows = conn.execute(
        "SELECT DISTINCT year FROM ingresos_rows "
        "UNION SELECT DISTINCT year FROM ingresos_recurrentes "
        "ORDER BY year"
    ).fetchall()
    return [r["year"] for r in rows]


def readIngresosYear(year):
    normalized = normalizeYear(year)
    if not normalized:
        return None

    conn = getDb()
    hasRows = conn.execute(
        "SELECT 1 FROM ingresos_rows WHERE year = ? LIMIT 1", (normalized,)
    ).fetchone()
    hasRec = conn.execute(
        "SELECT 1 FROM ingresos_recurrentes WHERE year = ? LIMIT 1", (normalized,)
    ).fetchone()

    if not hasRows and not hasRec:
        return None

    recurrentes = [
        {
            "nombre": r["nombre"],
            "categoria": r["categoria"],
            "importe": r["importe"],
            "frecuencia": normalizeFrecuencia(r["frecuencia"]),
            "diaCobro": normalizeDiaCobro(r["dia_cobro"]),
            "mesInicio": normalizeMes(r["mes_inicio"]),
            "activa": bool(r["activa"]),
            "nota": r["nota"],
            "cuenta": r["cuenta"],
            "cuentasCobro": normalizeCuentasCobro(r["cuentas_cobro"]),
            "meses": {month: r[month] for month in MONTH_KEYS},
        }
        for r in conn.execute(
            "SELECT nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
            "septiembre, octubre, noviembre, diciembre, "
            "categoria, importe, frecuencia, dia_cobro, mes_inicio, activa, nota, cuenta, cuentas_cobro "
            "FROM ingresos_recurrentes WHERE year = ? ORDER BY id",
            (normalized,)
        ).fetchall()
    ]

    months = {}
    for month in MONTH_KEYS:
        monthRows = conn.execute(
            "SELECT fecha, nombre, tipo, cantidad, nota, cuenta FROM ingresos_rows "
            "WHERE year = ? AND month = ? ORDER BY id",
            (normalized, month)
        ).fetchall()
        months[month] = {"rows": [
            {
                "fecha": r["fecha"], "nombre": r["nombre"], "tipo": r["tipo"],
                "cantidad": r["cantidad"], "nota": r["nota"], "cuenta": r["cuenta"],
            }
            for r in monthRows
        ]}

    return {
        "year": normalized,
        "ingresosTipos": readIngresosTypes(),
        "recurrentes": recurrentes,
        "months": months,
        "revision": revisiones.leer(conn, "ingresos", normalized),
    }


@transactional
def writeIngresosYear(year, data, revisionEsperada=None):
    """Sustituye el año entero. Devuelve la revisión nueva.

    Con `revision_esperada` lanza ConflictoRevision si el año cambió desde que
    el cliente lo leyó (ver stores/revisiones.py).
    """
    normalized = normalizeYear(year)
    if not normalized:
        return None

    conn = getDb()
    revisiones.tomarBloqueo(conn)
    revisiones.comprobar(conn, "ingresos", normalized, revisionEsperada)
    conn.execute("DELETE FROM ingresos_rows WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM ingresos_recurrentes WHERE year = ?", (normalized,))

    validas = cuentasValidasParaFilas(conn)
    conn.executemany(
        "INSERT INTO ingresos_recurrentes "
        "(year, nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
        "septiembre, octubre, noviembre, diciembre, "
        "categoria, importe, frecuencia, dia_cobro, mes_inicio, activa, nota, cuenta, cuentas_cobro) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (normalized, m.get("nombre", ""),
             m.get("meses", {}).get("enero", ""), m.get("meses", {}).get("febrero", ""),
             m.get("meses", {}).get("marzo", ""), m.get("meses", {}).get("abril", ""),
             m.get("meses", {}).get("mayo", ""), m.get("meses", {}).get("junio", ""),
             m.get("meses", {}).get("julio", ""), m.get("meses", {}).get("agosto", ""),
             m.get("meses", {}).get("septiembre", ""), m.get("meses", {}).get("octubre", ""),
             m.get("meses", {}).get("noviembre", ""), m.get("meses", {}).get("diciembre", ""),
             m.get("categoria", ""), m.get("importe", ""),
             normalizeFrecuencia(m.get("frecuencia")),
             normalizeDiaCobro(m.get("diaCobro")),
             normalizeMes(m.get("mesInicio")),
             1 if m.get("activa", True) else 0,
             m.get("nota", ""),
             normalizarCuentaDeFila(m.get("cuenta"), validas),
             serializeCuentasCobro(m.get("cuentasCobro"), validas | {ID_BANCO}))
            for m in data.get("recurrentes", [])
        ]
    )

    rowsToInsert = []
    for month in MONTH_KEYS:
        for row in data.get("months", {}).get(month, {}).get("rows", []):
            rowsToInsert.append((
                normalized, month,
                row.get("fecha", ""), row.get("nombre", ""),
                row.get("tipo", ""), row.get("cantidad", ""),
                row.get("nota", ""),
                normalizarCuentaDeFila(row.get("cuenta"), validas),
            ))
    conn.executemany(
        "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad, nota, cuenta) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rowsToInsert
    )

    if data.get("ingresosTipos"):
        existing = {r["label"] for r in conn.execute("SELECT label FROM ingresos_tipos").fetchall()}
        conn.executemany(
            "INSERT OR IGNORE INTO ingresos_tipos (label) VALUES (?)",
            [(t,) for t in data["ingresosTipos"] if t not in existing]
        )

    nueva = revisiones.avanzar(conn, "ingresos", normalized)
    conn.commit()
    return nueva


@transactional
def deleteIngresosYear(year):
    normalized = normalizeYear(year)
    if not normalized:
        return False

    conn = getDb()
    r1 = conn.execute("DELETE FROM ingresos_rows WHERE year = ?", (normalized,))
    r2 = conn.execute("DELETE FROM ingresos_recurrentes WHERE year = ?", (normalized,))
    # Una pestaña que aún tenga el año abierto no debe poder resucitarlo al guardar.
    revisiones.avanzar(conn, "ingresos", normalized)
    conn.commit()
    return (r1.rowcount + r2.rowcount) > 0
