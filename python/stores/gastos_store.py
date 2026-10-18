import json

from core.db import getDb, transactional
from core.validation import normalizeYear
from stores import revisiones
from stores.cuentas_store import ID_BANCO, cuentasValidasParaFilas, normalizarCuentaDeFila

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


def normalizeDiasCobro(value):
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
        day = normalizeDiaCobro(value.get(month))
        if day:
            dias[month] = day
    return dias


def normalizeCuentasCobro(value):
    """Cuenta con la que se cobra cada mes cuando no es la habitual de la mensualidad.

    Como `normalizeDiasCobro`: entra un dict `{"marzo": "tarjeta"}` (o su JSON) y
    salen solo los meses reconocibles con un identificador de cuenta. Un mes mal
    escrito se descarta en vez de rechazar el guardado entero.
    """
    if isinstance(value, str):
        try:
            value = json.loads(value) if value.strip() else {}
        except ValueError:
            return {}

    if not isinstance(value, dict):
        return {}

    cuentas = {}
    for month in MONTH_KEYS:
        cuenta = str(value.get(month) or "")[:_MAX_SHORT * 2].strip()
        if cuenta:
            cuentas[month] = cuenta
    return cuentas


def serializeCuentasCobro(value, validas=None):
    """Las excepciones de cuenta, listas para la columna. Vacío se guarda como ''.

    Con `validas`, se descartan las que apuntan a una cuenta que no existe: ese
    mes vuelve a la cuenta habitual. Aquí la bancaria se guarda con su
    identificador, porque el vacío significa «la cuenta habitual de la
    mensualidad», que puede ser otra.
    """
    cuentas = normalizeCuentasCobro(value)
    if validas is not None:
        cuentas = {mes: c for mes, c in cuentas.items() if c in validas}
    return json.dumps(cuentas, ensure_ascii=False, sort_keys=True) if cuentas else ""


def serializeDiasCobro(value):
    """El dict de excepciones, listo para la columna. Vacío se guarda como ''."""
    dias = normalizeDiasCobro(value)
    return json.dumps(dias, ensure_ascii=False, sort_keys=True) if dias else ""


def buildEmptyMonthSummary():
    return dict.fromkeys(MONTH_KEYS, "")


def createDefaultGastosYear(year):
    normalizedYear = normalizeYear(year)
    emptyMonths = buildEmptyMonthSummary()
    return {
        "year": normalizedYear,
        "gastosTipos": [],
        "mensualidades": [
            {"nombre": name, "meses": dict(emptyMonths)}
            for name in DEFAULT_MENSUALIDADES
        ],
        "months": {month: {"rows": []} for month in MONTH_KEYS},
    }


# --- Sanitize helpers (sin I/O, usados por rutas) ---

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


def sanitizeMensualidadesRows(rows):
    if not isinstance(rows, list):
        return []
    rows = [row for row in rows if isinstance(row, dict)]
    if len(rows) > 100:
        rows = rows[:100]

    # La tabla exige (year, nombre) único: se desduplican los nombres repetidos
    # en vez de dejar que el INSERT falle y se pierda todo el guardado.
    seen = set()

    def uniqueName(value):
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
            "nombre": uniqueName(row.get("nombre", "")),
            "categoria": str(row.get("categoria", ""))[:_MAX_LABEL].strip(),
            "importe": str(row.get("importe", ""))[:_MAX_SHORT].strip(),
            "frecuencia": normalizeFrecuencia(row.get("frecuencia")),
            "diaCobro": normalizeDiaCobro(row.get("diaCobro")),
            "diasCobro": normalizeDiasCobro(row.get("diasCobro")),
            "cuentasCobro": normalizeCuentasCobro(row.get("cuentasCobro")),
            "mesInicio": normalizeMes(row.get("mesInicio")),
            "activa": bool(row.get("activa", True)),
            "nota": str(row.get("nota", ""))[:_MAX_NOTA].strip(),
            "cuenta": str(row.get("cuenta", ""))[:_MAX_SHORT * 2].strip(),
            "meses": {
                month: str(_dict(row.get("meses")).get(month, ""))[:_MAX_SHORT].strip()
                for month in MONTH_KEYS
            },
        }
        for row in rows
    ]


def _dict(valor):
    return valor if isinstance(valor, dict) else {}


def sanitizeGastosTypes(payload):
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


def sanitizeGastosPayload(payload, fallbackYear=None):
    year = normalizeYear(payload.get("year") or fallbackYear)
    if not year:
        return None, "Año inválido"

    mensualidades = sanitizeMensualidadesRows(payload.get("mensualidades", []))

    gastosTipos = sanitizeGastosTypes(payload.get("gastosTipos", []))
    seenTipos = {label.lower() for label in gastosTipos}

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
            gastosTipos.append(label)
            seenTipos.add(normalized)

    return {
        "year": year,
        "gastosTipos": gastosTipos,
        "mensualidades": mensualidades,
        "months": sanitizedMonths,
    }, None


# --- Persistencia ---

def readGastosTypes():
    conn = getDb()
    return [r["label"] for r in conn.execute("SELECT label FROM gastos_tipos ORDER BY rowid").fetchall()]


@transactional
def writeGastosTypes(types):
    conn = getDb()
    sanitized = sanitizeGastosTypes(types)
    conn.execute("DELETE FROM gastos_tipos")
    conn.executemany("INSERT INTO gastos_tipos (label) VALUES (?)", [(t,) for t in sanitized])
    conn.commit()


def listGastosYears():
    conn = getDb()
    rows = conn.execute("SELECT year FROM gastos_years ORDER BY year").fetchall()
    return [r["year"] for r in rows]


def readGastosYear(year):
    normalized = normalizeYear(year)
    if not normalized:
        return None

    conn = getDb()
    if not conn.execute("SELECT 1 FROM gastos_years WHERE year = ? LIMIT 1", (normalized,)).fetchone():
        return None

    mensualidades = [
        {
            "nombre": r["nombre"],
            "categoria": r["categoria"],
            "importe": r["importe"],
            "frecuencia": normalizeFrecuencia(r["frecuencia"]),
            "diaCobro": normalizeDiaCobro(r["dia_cobro"]),
            "diasCobro": normalizeDiasCobro(r["dias_cobro"]),
            "cuentasCobro": normalizeCuentasCobro(r["cuentas_cobro"]),
            "mesInicio": normalizeMes(r["mes_inicio"]),
            "activa": bool(r["activa"]),
            "nota": r["nota"],
            "cuenta": r["cuenta"],
            "meses": {month: r[month] for month in MONTH_KEYS},
        }
        for r in conn.execute(
            "SELECT nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
            "septiembre, octubre, noviembre, diciembre, "
            "categoria, importe, frecuencia, dia_cobro, dias_cobro, mes_inicio, activa, nota, cuenta, cuentas_cobro "
            "FROM mensualidades WHERE year = ? ORDER BY id",
            (normalized,)
        ).fetchall()
    ]

    months = {}
    for month in MONTH_KEYS:
        monthRows = conn.execute(
            "SELECT fecha, nombre, tipo, cantidad, nota, cuenta FROM gastos_rows "
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
        "gastosTipos": readGastosTypes(),
        "mensualidades": mensualidades,
        "months": months,
        "revision": revisiones.leer(conn, "gastos", normalized),
    }


@transactional
def writeGastosYear(year, data, revisionEsperada=None):
    """Sustituye el año entero. Devuelve la revisión nueva.

    Con `revision_esperada` lanza ConflictoRevision si el año cambió desde que
    el cliente lo leyó (ver stores/revisiones.py).
    """
    normalized = normalizeYear(year)
    if not normalized:
        return None

    conn = getDb()
    revisiones.tomarBloqueo(conn)
    revisiones.comprobar(conn, "gastos", normalized, revisionEsperada)
    conn.execute("INSERT OR IGNORE INTO gastos_years (year) VALUES (?)", (normalized,))
    conn.execute("DELETE FROM gastos_rows WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM mensualidades WHERE year = ?", (normalized,))

    validas = cuentasValidasParaFilas(conn)
    conn.executemany(
        "INSERT INTO mensualidades "
        "(year, nombre, enero, febrero, marzo, abril, mayo, junio, julio, agosto, "
        "septiembre, octubre, noviembre, diciembre, "
        "categoria, importe, frecuencia, dia_cobro, dias_cobro, mes_inicio, activa, nota, cuenta, cuentas_cobro) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
             serializeDiasCobro(m.get("diasCobro")),
             normalizeMes(m.get("mesInicio")),
             1 if m.get("activa", True) else 0,
             m.get("nota", ""),
             normalizarCuentaDeFila(m.get("cuenta"), validas),
             serializeCuentasCobro(m.get("cuentasCobro"), validas | {ID_BANCO}))
            for m in data.get("mensualidades", [])
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
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad, nota, cuenta) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        rowsToInsert
    )

    # Tipos son globales: añadir los nuevos sin borrar los existentes
    if data.get("gastosTipos"):
        existing = {r["label"] for r in conn.execute("SELECT label FROM gastos_tipos").fetchall()}
        conn.executemany(
            "INSERT OR IGNORE INTO gastos_tipos (label) VALUES (?)",
            [(t,) for t in data["gastosTipos"] if t not in existing]
        )

    nueva = revisiones.avanzar(conn, "gastos", normalized)
    conn.commit()
    return nueva


@transactional
def deleteGastosYear(year):
    normalized = normalizeYear(year)
    if not normalized:
        return False

    conn = getDb()
    r = conn.execute("DELETE FROM gastos_years WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM gastos_rows WHERE year = ?", (normalized,))
    conn.execute("DELETE FROM mensualidades WHERE year = ?", (normalized,))
    # Una pestaña que aún tenga el año abierto no debe poder resucitarlo al guardar.
    revisiones.avanzar(conn, "gastos", normalized)
    conn.commit()
    return r.rowcount > 0
