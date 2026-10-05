"""Cuentas de ahorro: dinero apartado de la cuenta bancaria.

No tienen tablas propias. Cada movimiento es una fila normal de gastos o de
ingresos con una categoría reservada:

- Meter dinero en la cuenta de ahorro es un **gasto** de la cuenta bancaria.
- Sacarlo es un **ingreso**.

Así el movimiento aparece en el día, mes y año que toca en las ventanas de
Gastos e Ingresos sin sincronizar nada, y también vale añadirlo desde allí
eligiendo esa categoría. Esta ventana solo lee esas filas y añade o quita las
suyas.

La cuenta principal usa la categoría `TIPO_AHORRO`. Las demás la llevan como
prefijo: `Cuenta de ahorro · Viaje`. Codificar la cuenta en la categoría evita
tocar el esquema, y de paso hace que cada cuenta salga sola en los
desplegables de Gastos e Ingresos.
"""

import calendar
import datetime
import re

from core.db import get_db, transactional
from core.dinero import ImporteInvalido, aDecimal, aTexto, aTextoEs

# Categoría reservada. Está fija en el código a propósito: la ventana reconoce
# los movimientos por ella, y si se pudiera renombrar dejarían de contarse.
TIPO_AHORRO = "Cuenta de ahorro"
SEPARADOR = " · "

MONTH_KEYS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]

INGRESO = "ingreso"  # dinero que entra en la cuenta de ahorro (gasto bancario)
RETIRO = "retiro"    # dinero que sale de la cuenta de ahorro (ingreso bancario)

# kind -> (tabla de filas, tabla del catálogo de categorías)
_TABLAS = {
    INGRESO: ("gastos_rows", "gastos_tipos"),
    RETIRO: ("ingresos_rows", "ingresos_tipos"),
}

_FECHA = re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$")
_MES = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_MAX_CUENTA = 60
_MAX_CUENTAS = 30


class MovimientoInvalido(ValueError):
    """Datos rechazados por validación. La ruta lo traduce a 400."""


class CuentaConMovimientos(Exception):
    """Se intenta eliminar una cuenta que todavía tiene movimientos."""


# ── Cuentas y categorías ────────────────────────────────────────────────────

def normalizar_cuenta(valor):
    """Nombre de cuenta limpio. Vacío es la cuenta principal."""
    return re.sub(r"\s+", " ", str(valor or "")).strip()[:_MAX_CUENTA].strip()


def tipo_de_cuenta(cuenta):
    nombre = normalizar_cuenta(cuenta)
    return f"{TIPO_AHORRO}{SEPARADOR}{nombre}" if nombre else TIPO_AHORRO


def cuenta_de_tipo(tipo):
    """Nombre de la cuenta a la que pertenece la categoría, o None si no es de ahorro.

    La cuenta principal devuelve cadena vacía.
    """
    texto = str(tipo or "").strip()
    base = TIPO_AHORRO.lower()
    bajo = texto.lower()
    if bajo == base:
        return ""
    if bajo.startswith(base + SEPARADOR):
        return texto[len(base) + len(SEPARADOR):].strip()
    return None


def esTipoReservado(etiqueta):
    return cuenta_de_tipo(etiqueta) is not None


def asegurar_categorias(conn=None, cuenta=""):
    """Da de alta la categoría de la cuenta en los catálogos de gastos e ingresos."""
    propia = conn is None
    conn = conn or get_db()
    tipo = tipo_de_cuenta(cuenta)
    for _tabla, catalogo in _TABLAS.values():
        conn.execute(f"INSERT OR IGNORE INTO {catalogo} (label) VALUES (?)", (tipo,))
    if propia:
        conn.commit()


def _filas_de_ahorro(conn, kind):
    tabla, _catalogo = _TABLAS[kind]
    filas = conn.execute(
        f"SELECT id, year, month, fecha, nombre, tipo, cantidad, nota FROM {tabla} "
        "WHERE tipo LIKE ? ORDER BY id",
        (TIPO_AHORRO + "%",),
    ).fetchall()
    return [f for f in filas if esTipoReservado(f["tipo"])]


def listar_cuentas():
    """Nombres de las cuentas que existen (sin la principal), por catálogo o por filas."""
    conn = get_db()
    nombres = {}
    for kind, (_tabla, catalogo) in _TABLAS.items():
        etiquetas = [r["label"] for r in conn.execute(f"SELECT label FROM {catalogo}").fetchall()]
        etiquetas += [f["tipo"] for f in _filas_de_ahorro(conn, kind)]
        for etiqueta in etiquetas:
            nombre = cuenta_de_tipo(etiqueta)
            if nombre:
                nombres.setdefault(nombre.lower(), nombre)
    return sorted(nombres.values(), key=str.lower)


def crear_cuenta(nombre):
    nombre = normalizar_cuenta(nombre)
    if not nombre:
        raise MovimientoInvalido("Escribe un nombre para la cuenta")
    if nombre.lower() in {c.lower() for c in listar_cuentas()}:
        raise MovimientoInvalido(f"Ya existe una cuenta llamada «{nombre}»")
    if len(listar_cuentas()) >= _MAX_CUENTAS:
        raise MovimientoInvalido("Has llegado al máximo de cuentas")
    asegurar_categorias(cuenta=nombre)
    return nombre


@transactional
def renombrar_cuenta(origen, destino):
    origen = normalizar_cuenta(origen)
    destino = normalizar_cuenta(destino)
    if not origen:
        raise MovimientoInvalido("La cuenta principal no se puede renombrar")
    if not destino:
        raise MovimientoInvalido("Escribe un nombre para la cuenta")
    if origen.lower() == destino.lower() and origen == destino:
        return destino
    if destino.lower() != origen.lower() and destino.lower() in {c.lower() for c in listar_cuentas()}:
        raise MovimientoInvalido(f"Ya existe una cuenta llamada «{destino}»")

    conn = get_db()
    viejo, nuevo = tipo_de_cuenta(origen), tipo_de_cuenta(destino)
    for tabla, catalogo in _TABLAS.values():
        conn.execute(f"UPDATE {tabla} SET tipo = ? WHERE tipo = ? COLLATE NOCASE", (nuevo, viejo))
        conn.execute(f"DELETE FROM {catalogo} WHERE label = ? COLLATE NOCASE", (viejo,))
        conn.execute(f"INSERT OR IGNORE INTO {catalogo} (label) VALUES (?)", (nuevo,))
    conn.commit()
    return destino


@transactional
def eliminar_cuenta(nombre):
    nombre = normalizar_cuenta(nombre)
    if not nombre:
        raise MovimientoInvalido("La cuenta principal no se puede eliminar")

    conn = get_db()
    tipo = tipo_de_cuenta(nombre)
    for tabla, _catalogo in _TABLAS.values():
        usos = conn.execute(
            f"SELECT COUNT(*) AS n FROM {tabla} WHERE tipo = ? COLLATE NOCASE", (tipo,)
        ).fetchone()["n"]
        if usos:
            raise CuentaConMovimientos(usos)
    for _tabla, catalogo in _TABLAS.values():
        conn.execute(f"DELETE FROM {catalogo} WHERE label = ? COLLATE NOCASE", (tipo,))
    conn.commit()


# ── Validación ──────────────────────────────────────────────────────────────

def _normalizar_kind(valor):
    kind = str(valor or "").strip().lower()
    if kind not in _TABLAS:
        raise MovimientoInvalido("El tipo debe ser 'ingreso' o 'retiro'")
    return kind


def _normalizar_fecha(valor):
    texto = str(valor or "").strip()
    if not texto:
        return datetime.date.today()
    coincide = _FECHA.match(texto)
    if not coincide:
        raise MovimientoInvalido("La fecha debe tener el formato dd-mm-aaaa")
    dia, mes, anio = (int(g) for g in coincide.groups())
    try:
        return datetime.date(anio, mes, dia)
    except ValueError:
        raise MovimientoInvalido("La fecha no existe") from None


def _formatear_importe(valor):
    try:
        cantidad = aDecimal(valor, "cantidad")
    except ImporteInvalido:
        raise MovimientoInvalido("La cantidad no es un número válido") from None
    if cantidad <= 0:
        raise MovimientoInvalido("La cantidad debe ser mayor que cero")
    # Mismo formato que escribe la web en las celdas de gastos e ingresos.
    return aTextoEs(cantidad) + " €"


def _preparar(kind, fecha, nombre, cantidad, nota):
    kind = _normalizar_kind(kind)
    dia = _normalizar_fecha(fecha)
    importe = _formatear_importe(cantidad)
    nombre = str(nombre or "").strip()[:120] or (
        "Aportación a cuenta de ahorro" if kind == INGRESO else "Retirada de cuenta de ahorro"
    )
    return kind, dia, importe, nombre, str(nota or "").strip()[:300]


def _insertar(conn, kind, dia, nombre, importe, nota, cuenta):
    tipo = tipo_de_cuenta(cuenta)
    tabla, _catalogo = _TABLAS[kind]
    year = str(dia.year)
    month = MONTH_KEYS[dia.month - 1]
    texto_fecha = dia.strftime("%d-%m-%Y")

    asegurar_categorias(conn, cuenta)
    if kind == INGRESO:
        # Los gastos sí llevan tabla de años: sin la fila, el año no sale en la web.
        conn.execute("INSERT OR IGNORE INTO gastos_years (year) VALUES (?)", (year,))
    cursor = conn.execute(
        f"INSERT INTO {tabla} (year, month, fecha, nombre, tipo, cantidad, nota) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (year, month, texto_fecha, nombre, tipo, importe, nota),
    )
    return {
        "id": cursor.lastrowid,
        "kind": kind,
        "cuenta": normalizar_cuenta(cuenta),
        "year": year,
        "month": month,
        "fecha": texto_fecha,
        "nombre": nombre,
        "cantidad": importe,
        "nota": nota,
    }


# ── Movimientos ─────────────────────────────────────────────────────────────

def listar_movimientos():
    """Todos los movimientos de todas las cuentas de ahorro, de todos los años."""
    conn = get_db()
    movimientos = []
    for kind in _TABLAS:
        movimientos.extend(
            {
                "id": f["id"],
                "kind": kind,
                "cuenta": cuenta_de_tipo(f["tipo"]),
                "year": f["year"],
                "month": f["month"],
                "fecha": f["fecha"],
                "nombre": f["nombre"],
                "cantidad": f["cantidad"],
                "nota": f["nota"],
            }
            for f in _filas_de_ahorro(conn, kind)
        )
    return movimientos


@transactional
def anadir_movimiento(kind, fecha, nombre, cantidad, nota="", cuenta=""):
    kind, dia, importe, nombre, nota = _preparar(kind, fecha, nombre, cantidad, nota)
    conn = get_db()
    movimiento = _insertar(conn, kind, dia, nombre, importe, nota, cuenta)
    conn.commit()
    return movimiento


def _fila_igual(conn, kind, row_id, fecha, cantidad):
    tabla, _catalogo = _TABLAS[kind]
    fila = conn.execute(
        f"SELECT id, tipo, fecha, cantidad FROM {tabla} WHERE id = ?", (row_id,)
    ).fetchone()
    if (
        fila
        and esTipoReservado(fila["tipo"])
        and fila["fecha"] == str(fecha or "")
        and fila["cantidad"] == str(cantidad or "")
    ):
        return fila
    return None


@transactional
def modificar_movimiento(kind, row_id, fecha_original, cantidad_original,
                         kind_nuevo, fecha, nombre, cantidad, nota=""):
    """Sustituye el movimiento por otro, conservando su cuenta.

    Se borra y se vuelve a crear porque cambiar la fecha puede cambiar el mes o
    el año, y cambiar de ingreso a retirada lo mueve de tabla. Primero se valida
    todo: si los datos nuevos no valen, el original queda intacto.
    """
    kind = _normalizar_kind(kind)
    kind_nuevo, dia, importe, nombre, nota = _preparar(kind_nuevo, fecha, nombre, cantidad, nota)

    conn = get_db()
    fila = _fila_igual(conn, kind, row_id, fecha_original, cantidad_original)
    if not fila:
        return None

    cuenta = cuenta_de_tipo(fila["tipo"])
    tabla, _catalogo = _TABLAS[kind]
    conn.execute(f"DELETE FROM {tabla} WHERE id = ?", (fila["id"],))
    movimiento = _insertar(conn, kind_nuevo, dia, nombre, importe, nota, cuenta)
    conn.commit()
    return movimiento


@transactional
def eliminar_movimiento(kind, row_id, fecha, cantidad):
    """Borra el movimiento si sigue siendo el mismo.

    Las ventanas de Gastos e Ingresos reescriben el año entero al guardar, y con
    ello cambian los ids. Por eso no basta el id: se exige que fecha e importe
    coincidan, para no borrar otra fila que haya heredado ese número.
    """
    kind = _normalizar_kind(kind)
    conn = get_db()
    fila = _fila_igual(conn, kind, row_id, fecha, cantidad)
    if not fila:
        return False
    tabla, _catalogo = _TABLAS[kind]
    conn.execute(f"DELETE FROM {tabla} WHERE id = ?", (fila["id"],))
    conn.commit()
    return True


# ── Configuración por cuenta (vive en los ajustes del portfolio) ────────────

def _importe_canonico(valor):
    try:
        numero = aDecimal(valor, "importe")
    except ImporteInvalido:
        return ""
    return aTexto(numero, decimales=2) if numero > 0 else ""


def _cuenta_vacia(nombre):
    return {
        "nombre": nombre,
        "remuneradas": [],
        "incluirDividendos": False,
        "objetivo": "",
        "recurrente": {"activa": False, "importe": "", "dia": 1, "desde": ""},
    }


def normalizar_config(raw):
    """Configuración de las cuentas de ahorro, con la forma que guarda y lee todo.

    Acepta también la forma antigua (una sola cuenta, con `cuentasRemuneradas` e
    `incluirDividendos` en la raíz), que pasa a ser la cuenta principal.
    """
    raw = raw if isinstance(raw, dict) else {}
    if isinstance(raw.get("cuentas"), list):
        entradas = raw["cuentas"]
    else:
        entradas = [{
            "nombre": "",
            "remuneradas": raw.get("cuentasRemuneradas", []),
            "incluirDividendos": raw.get("incluirDividendos", False),
        }]

    cuentas = []
    vistos = set()
    for entrada in entradas[:_MAX_CUENTAS + 1]:
        if not isinstance(entrada, dict):
            continue
        nombre = normalizar_cuenta(entrada.get("nombre"))
        if nombre.lower() in vistos:
            continue
        vistos.add(nombre.lower())

        remuneradas = []
        origen = entrada.get("remuneradas", [])
        for cid in (origen if isinstance(origen, list) else [])[:100]:
            cid = str(cid).strip()[:120]
            if cid and cid not in remuneradas:
                remuneradas.append(cid)

        rec = entrada.get("recurrente") if isinstance(entrada.get("recurrente"), dict) else {}
        try:
            dia = max(1, min(31, int(rec.get("dia", 1))))
        except (TypeError, ValueError):
            dia = 1
        desde = str(rec.get("desde", "")).strip()

        cuentas.append({
            "nombre": nombre,
            "remuneradas": remuneradas,
            "incluirDividendos": bool(entrada.get("incluirDividendos", False)),
            "objetivo": _importe_canonico(entrada.get("objetivo")),
            "recurrente": {
                "activa": bool(rec.get("activa", False)),
                "importe": _importe_canonico(rec.get("importe")),
                "dia": dia,
                "desde": desde if _MES.match(desde) else "",
            },
        })

    if "" not in vistos:
        cuentas.insert(0, _cuenta_vacia(""))
    return {"cuentas": cuentas}


# ── Aportación mensual automática ───────────────────────────────────────────

def _mes_siguiente(texto):
    anio, mes = int(texto[:4]), int(texto[5:7])
    return f"{anio + (mes == 12):04d}-{mes % 12 + 1:02d}"


def aplicar_recurrentes(config, generado, hoy=None):
    """Crea las aportaciones mensuales que ya tocan y no se han creado.

    `generado` guarda, por cuenta, el último mes creado (`YYYY-MM`). Es lo que
    hace idempotente la operación y lo que evita que reaparezca una aportación
    que el usuario borró a propósito. No está en la configuración que edita el
    navegador: allí una copia vieja lo pisaría y duplicaría aportaciones.

    Devuelve (nuevo `generado`, movimientos creados).
    """
    hoy = hoy or datetime.date.today()
    mes_actual = f"{hoy.year:04d}-{hoy.month:02d}"
    generado = dict(generado or {})
    creados = []

    for cuenta in normalizar_config(config)["cuentas"]:
        rec = cuenta["recurrente"]
        if not (rec["activa"] and rec["importe"] and rec["desde"]):
            continue

        clave = cuenta["nombre"].lower() or "_"
        ultimo = generado.get(clave, "")
        mes = rec["desde"] if not ultimo else max(rec["desde"], _mes_siguiente(ultimo))

        while mes <= mes_actual:
            anio, num = int(mes[:4]), int(mes[5:7])
            dia = min(rec["dia"], calendar.monthrange(anio, num)[1])
            fecha = datetime.date(anio, num, dia)
            if fecha > hoy:
                break
            creados.append(anadir_movimiento(
                INGRESO, fecha.strftime("%d-%m-%Y"), "Ahorro mensual", rec["importe"],
                "Aportación automática", cuenta["nombre"],
            ))
            generado[clave] = mes
            mes = _mes_siguiente(mes)

    return generado, creados
