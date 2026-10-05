"""Cuentas de dinero y transferencias entre ellas.

La cuenta bancaria de Gastos e Ingresos es la base de todo: lo que no dice otra
cosa va a ella. Pero hay dinero que está fuera —en una cuenta de ahorro, un
exchange, un broker u otra cuenta— y moverlo de un sitio a otro **no es un gasto
ni un ingreso**: es una transferencia. Por eso viven en su propia ventana y en
su propia tabla (`transferencias`), y no cuentan en las cifras de gastos.

Qué mueve el saldo de una cuenta:

  * las transferencias que entran y salen de ella;
  * los ingresos que se registran como cobrados en ella y los gastos pagados con
    ella (`gastos_rows.cuenta` / `ingresos_rows.cuenta`; vacío = bancaria);
  * en la bancaria, además, las mensualidades y los ingresos recurrentes, que no
    son filas sino importes por mes;
  * el saldo inicial que se le haya puesto, para no tener que registrar toda la
    historia.

Solo cuenta lo que ya ha ocurrido (hasta el mes actual incluido): un recurrente
de diciembre no es dinero que ya esté en la cuenta en octubre.
"""

import datetime
import re
from decimal import Decimal

from core.db import get_db, transactional
from core.dinero import ImporteInvalido, aDecimal, aDecimalONulo, aTexto, aTextoEs

TIPOS = ("banco", "ahorro", "exchange", "broker", "metalico")
ETIQUETAS_TIPO = {
    "banco": "Banco",
    "ahorro": "Ahorro",
    "exchange": "Exchange",
    "broker": "Broker",
    "metalico": "Metálico",
}

ID_BANCO = "banco"
ID_AHORRO = "ahorro"
NOMBRE_BANCO = "Cuenta bancaria"
# Con qué textos se pide la cuenta bancaria (API del móvil, popups): vacío y
# estos, se llame como se llame ahora. Cualquier otro es el nombre o el
# identificador de una cuenta.
_ALIAS_BANCO = {"", "banco", "bancaria", "cuenta bancaria", "cuenta banco"}

MONTH_KEYS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]

_FECHA = re.compile(r"^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$")
_MAX_NOMBRE = 60
_MAX_CUENTAS = 60


class CuentaInvalida(ValueError):
    """Datos rechazados por validación. La ruta lo traduce a 400."""


class CuentaEnUso(Exception):
    """Se intenta eliminar una cuenta que todavía tiene movimientos."""


# ── Validación ──────────────────────────────────────────────────────────────

def normalizar_nombre(valor):
    return re.sub(r"\s+", " ", str(valor or "")).strip()[:_MAX_NOMBRE].strip()


def _normalizar_tipo(valor):
    tipo = str(valor or "").strip().lower()
    if tipo not in TIPOS:
        raise CuentaInvalida(f"El tipo de cuenta debe ser uno de: {', '.join(TIPOS)}")
    return tipo


def normalizar_fecha(valor):
    """`date` de un texto dd-mm-aaaa. Vacío es hoy."""
    texto = str(valor or "").strip()
    if not texto:
        return datetime.date.today()
    coincide = _FECHA.match(texto)
    if not coincide:
        raise CuentaInvalida("La fecha debe tener el formato dd-mm-aaaa")
    dia, mes, anio = (int(g) for g in coincide.groups())
    try:
        return datetime.date(anio, mes, dia)
    except ValueError:
        raise CuentaInvalida("La fecha no existe") from None


def _importe_positivo(valor, campo="cantidad"):
    try:
        cantidad = aDecimal(valor, campo)
    except ImporteInvalido:
        raise CuentaInvalida("La cantidad no es un número válido") from None
    if cantidad <= 0:
        raise CuentaInvalida("La cantidad debe ser mayor que cero")
    return cantidad


def formatear_importe(cantidad):
    """Mismo formato que escribe la web en las celdas: «1.234,56 €»."""
    return aTextoEs(cantidad) + " €"


def _saldo_inicial(valor):
    """Saldo de partida: vacío o un número (puede ser negativo). Texto canónico."""
    if valor is None or str(valor).strip() == "":
        return ""
    try:
        return aTexto(aDecimal(valor, "saldo inicial"), decimales=2)
    except ImporteInvalido:
        raise CuentaInvalida("El saldo inicial no es un número válido") from None


def _decimal(texto):
    return aDecimalONulo(texto) or Decimal(0)


# ── Cuentas ─────────────────────────────────────────────────────────────────
#
# La cuenta bancaria y la de ahorro principal las crea el esquema (paso 11 de
# core/db.py) y no se pueden borrar. Leerlas no escribe nada a propósito: una
# lectura que abriera una transacción de escritura dejaría la base bloqueada para
# los demás hilos hasta el siguiente commit.

def _fila_a_cuenta(fila):
    return {
        "id": fila["id"],
        "nombre": fila["nombre"],
        "tipo": fila["tipo"],
        "saldo_inicial": fila["saldo_inicial"],
        "protegida": fila["id"] in (ID_BANCO, ID_AHORRO),
    }


def listar_cuentas(conn=None):
    conn = conn or get_db()
    filas = conn.execute(
        "SELECT id, nombre, tipo, saldo_inicial FROM cuentas ORDER BY sort_order, rowid"
    ).fetchall()
    return [_fila_a_cuenta(f) for f in filas]


def obtener_cuenta(cuenta_id, conn=None):
    conn = conn or get_db()
    fila = conn.execute(
        "SELECT id, nombre, tipo, saldo_inicial FROM cuentas WHERE id = ?", (cuenta_id,)
    ).fetchone()
    return _fila_a_cuenta(fila) if fila else None


def cuentas_de_tipo(tipo, conn=None):
    return [c for c in listar_cuentas(conn) if c["tipo"] == tipo]


def resolver_cuenta(valor, conn=None):
    """Identificador de la cuenta a la que se refiere `valor`; '' si es la bancaria.

    Acepta el identificador o el nombre (sin distinguir mayúsculas) y los alias de
    la cuenta bancaria. Lo demás es un error que dice cuáles valen.
    """
    texto = normalizar_nombre(valor)
    if texto.lower() in _ALIAS_BANCO:
        return ""
    cuentas = listar_cuentas(conn)
    for cuenta in cuentas:
        if texto.lower() in (cuenta["id"].lower(), cuenta["nombre"].lower()):
            return "" if cuenta["id"] == ID_BANCO else cuenta["id"]
    validas = ", ".join(c["nombre"] for c in cuentas)
    raise CuentaInvalida(f"La cuenta «{texto}» no existe. Cuentas: {validas}")


def cuentas_validas_para_filas(conn=None):
    """Identificadores con los que una fila de gastos o ingresos puede guardar su cuenta.

    La bancaria no está: en las filas es el vacío.
    """
    return {c["id"] for c in listar_cuentas(conn) if c["id"] != ID_BANCO}


def normalizar_cuenta_de_fila(valor, validas):
    """Lo que se guarda en `cuenta` de una fila: '' (bancaria) o un identificador que existe.

    Una cuenta desconocida —borrada mientras tanto, o escrita a mano— vuelve a la
    bancaria en vez de dejar la fila apuntando a nada.
    """
    texto = str(valor or "").strip()
    return texto if texto in validas else ""


def etiquetas_de_cuentas(conn=None):
    """Nombres que se ofrecen al elegir cuenta, con la bancaria la primera."""
    return [c["nombre"] for c in listar_cuentas(conn)]


def _nombre_libre(nombre, conn, excepto=None):
    # Los alias de la cuenta bancaria («banco», «cuenta bancaria»…) son suyos: ninguna
    # otra cuenta puede llamarse así, pero ella sí puede quedarse con uno.
    if nombre.lower() in _ALIAS_BANCO and excepto != ID_BANCO:
        raise CuentaInvalida(f"«{nombre}» es el nombre de la cuenta bancaria")
    for cuenta in listar_cuentas(conn):
        if cuenta["id"] != excepto and cuenta["nombre"].lower() == nombre.lower():
            raise CuentaInvalida(f"Ya existe una cuenta llamada «{nombre}»")


def _id_nuevo(nombre, tipo, conn):
    slug = "".join(c if c.isalnum() else "-" for c in nombre.lower()).strip("-") or "cuenta"
    base = f"{tipo}-{slug}"
    candidato, n = base, 2
    while conn.execute("SELECT 1 FROM cuentas WHERE id = ?", (candidato,)).fetchone():
        candidato = f"{base}-{n}"
        n += 1
    return candidato


@transactional
def crear_cuenta(nombre, tipo, saldo_inicial=""):
    nombre = normalizar_nombre(nombre)
    if not nombre:
        raise CuentaInvalida("Escribe un nombre para la cuenta")
    tipo = _normalizar_tipo(tipo)
    conn = get_db()
    _nombre_libre(nombre, conn)
    if len(listar_cuentas(conn)) >= _MAX_CUENTAS:
        raise CuentaInvalida("Has llegado al máximo de cuentas")
    inicial = _saldo_inicial(saldo_inicial)
    orden = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM cuentas").fetchone()[0]
    cuenta_id = _id_nuevo(nombre, tipo, conn)
    conn.execute(
        "INSERT INTO cuentas (id, nombre, tipo, saldo_inicial, sort_order) VALUES (?, ?, ?, ?, ?)",
        (cuenta_id, nombre, tipo, inicial, orden),
    )
    conn.commit()
    return obtener_cuenta(cuenta_id, conn)


@transactional
def modificar_cuenta(cuenta_id, nombre=None, saldo_inicial=None):
    """Cambia el nombre y/o el saldo inicial. El tipo no se cambia: pasar una
    cuenta de ahorro a exchange la sacaría de la ventana de ahorro con su historia."""
    conn = get_db()
    cuenta = obtener_cuenta(cuenta_id, conn)
    if cuenta is None:
        raise CuentaInvalida("La cuenta no existe")

    if nombre is not None:
        nombre = normalizar_nombre(nombre)
        if not nombre:
            raise CuentaInvalida("Escribe un nombre para la cuenta")
        _nombre_libre(nombre, conn, excepto=cuenta_id)
        conn.execute("UPDATE cuentas SET nombre = ? WHERE id = ?", (nombre, cuenta_id))

    if saldo_inicial is not None:
        conn.execute(
            "UPDATE cuentas SET saldo_inicial = ? WHERE id = ?", (_saldo_inicial(saldo_inicial), cuenta_id)
        )
    conn.commit()
    return obtener_cuenta(cuenta_id, conn)


def _usos(cuenta_id, conn):
    # En las filas, la cuenta bancaria es el vacío; el resto, su identificador.
    total = conn.execute(
        "SELECT COUNT(*) FROM transferencias WHERE origen = ? OR destino = ?", (cuenta_id, cuenta_id)
    ).fetchone()[0]
    for tabla in ("gastos_rows", "ingresos_rows"):
        total += conn.execute(f"SELECT COUNT(*) FROM {tabla} WHERE cuenta = ?", (cuenta_id,)).fetchone()[0]
    return total


@transactional
def eliminar_cuenta(cuenta_id):
    conn = get_db()
    cuenta = obtener_cuenta(cuenta_id, conn)
    if cuenta is None:
        raise CuentaInvalida("La cuenta no existe")
    if cuenta["protegida"]:
        raise CuentaInvalida(f"«{cuenta['nombre']}» no se puede eliminar")
    usos = _usos(cuenta_id, conn)
    if usos:
        raise CuentaEnUso(usos)
    conn.execute("DELETE FROM cuentas WHERE id = ?", (cuenta_id,))
    conn.commit()


# ── Transferencias ──────────────────────────────────────────────────────────

def _year_month(texto_fecha):
    coincide = _FECHA.match(str(texto_fecha or "").strip())
    if not coincide:
        return "", ""
    _dia, mes, anio = (int(g) for g in coincide.groups())
    if not 1 <= mes <= 12:
        return "", ""
    return f"{anio:04d}", MONTH_KEYS[mes - 1]


def _fila_a_transferencia(fila, nombres):
    year, month = _year_month(fila["fecha"])
    return {
        "id": fila["id"],
        "fecha": fila["fecha"],
        "year": year,
        "month": month,
        "origen": fila["origen"],
        "destino": fila["destino"],
        "origen_nombre": nombres.get(fila["origen"], fila["origen"]),
        "destino_nombre": nombres.get(fila["destino"], fila["destino"]),
        "cantidad": fila["cantidad"],
        "concepto": fila["concepto"],
        "nota": fila["nota"],
    }


def listar_transferencias(conn=None):
    conn = conn or get_db()
    nombres = {c["id"]: c["nombre"] for c in listar_cuentas(conn)}
    filas = conn.execute(
        "SELECT id, fecha, origen, destino, cantidad, concepto, nota FROM transferencias ORDER BY id"
    ).fetchall()
    return [_fila_a_transferencia(f, nombres) for f in filas]


def _preparar_transferencia(origen, destino, fecha, cantidad, concepto, nota, conn):
    ids = {c["id"] for c in listar_cuentas(conn)}
    origen = str(origen or "").strip() or ID_BANCO
    destino = str(destino or "").strip() or ID_BANCO
    for cuenta_id in (origen, destino):
        if cuenta_id not in ids:
            raise CuentaInvalida("Alguna de las cuentas no existe")
    if origen == destino:
        raise CuentaInvalida("El origen y el destino tienen que ser cuentas distintas")
    dia = normalizar_fecha(fecha)
    importe = _importe_positivo(cantidad)
    return (
        origen,
        destino,
        dia.strftime("%d-%m-%Y"),
        formatear_importe(importe),
        str(concepto or "").strip()[:120],
        str(nota or "").strip()[:300],
    )


@transactional
def crear_transferencia(origen, destino, fecha, cantidad, concepto="", nota=""):
    conn = get_db()
    origen, destino, fecha, cantidad, concepto, nota = _preparar_transferencia(
        origen, destino, fecha, cantidad, concepto, nota, conn
    )
    cursor = conn.execute(
        "INSERT INTO transferencias (fecha, origen, destino, cantidad, concepto, nota) VALUES (?, ?, ?, ?, ?, ?)",
        (fecha, origen, destino, cantidad, concepto, nota),
    )
    conn.commit()
    return next(t for t in listar_transferencias(conn) if t["id"] == cursor.lastrowid)


@transactional
def modificar_transferencia(transferencia_id, origen, destino, fecha, cantidad, concepto="", nota=""):
    conn = get_db()
    if not conn.execute("SELECT 1 FROM transferencias WHERE id = ?", (transferencia_id,)).fetchone():
        return None
    origen, destino, fecha, cantidad, concepto, nota = _preparar_transferencia(
        origen, destino, fecha, cantidad, concepto, nota, conn
    )
    conn.execute(
        "UPDATE transferencias SET fecha = ?, origen = ?, destino = ?, cantidad = ?, concepto = ?, nota = ? WHERE id = ?",
        (fecha, origen, destino, cantidad, concepto, nota, transferencia_id),
    )
    conn.commit()
    return next(t for t in listar_transferencias(conn) if t["id"] == transferencia_id)


@transactional
def eliminar_transferencia(transferencia_id):
    conn = get_db()
    cursor = conn.execute("DELETE FROM transferencias WHERE id = ?", (transferencia_id,))
    conn.commit()
    return cursor.rowcount > 0


# ── Saldos y movimientos ────────────────────────────────────────────────────

def _cuenta_de_fila(valor):
    return valor or ID_BANCO


def _ya_ocurrido(year, month, hoy):
    """¿El mes de esa fila ya ha empezado? Las filas futuras no mueven el saldo."""
    try:
        return (int(year), MONTH_KEYS.index(month)) <= (hoy.year, hoy.month - 1)
    except (ValueError, TypeError):
        return True


def saldos(conn=None, hoy=None):
    """Saldo de cada cuenta a día de hoy: `{id: {inicial, entradas, salidas, saldo}}`."""
    conn = conn or get_db()
    hoy = hoy or datetime.date.today()
    cuentas = listar_cuentas(conn)
    acumulado = {c["id"]: {"entradas": Decimal(0), "salidas": Decimal(0)} for c in cuentas}

    for fila in conn.execute("SELECT fecha, origen, destino, cantidad FROM transferencias").fetchall():
        year, month = _year_month(fila["fecha"])
        if year and not _ya_ocurrido(year, month, hoy):
            continue
        importe = _decimal(fila["cantidad"])
        if fila["destino"] in acumulado:
            acumulado[fila["destino"]]["entradas"] += importe
        if fila["origen"] in acumulado:
            acumulado[fila["origen"]]["salidas"] += importe

    for tabla, campo in (("ingresos_rows", "entradas"), ("gastos_rows", "salidas")):
        for fila in conn.execute(f"SELECT year, month, cantidad, cuenta FROM {tabla}").fetchall():
            cuenta_id = _cuenta_de_fila(fila["cuenta"])
            if cuenta_id in acumulado and _ya_ocurrido(fila["year"], fila["month"], hoy):
                acumulado[cuenta_id][campo] += _decimal(fila["cantidad"])

    # Mensualidades e ingresos recurrentes: importes por mes, y siempre de la bancaria.
    for tabla, campo in (("ingresos_recurrentes", "entradas"), ("mensualidades", "salidas")):
        columnas = ", ".join(["year", *MONTH_KEYS])
        for fila in conn.execute(f"SELECT {columnas} FROM {tabla}").fetchall():
            for mes in MONTH_KEYS:
                if _ya_ocurrido(fila["year"], mes, hoy):
                    acumulado[ID_BANCO][campo] += _decimal(fila[mes])

    resultado = {}
    for cuenta in cuentas:
        datos = acumulado[cuenta["id"]]
        inicial = _decimal(cuenta["saldo_inicial"])
        resultado[cuenta["id"]] = {
            "inicial": inicial,
            "entradas": datos["entradas"],
            "salidas": datos["salidas"],
            "saldo": inicial + datos["entradas"] - datos["salidas"],
        }
    return resultado


def movimientos_de_cuenta(cuenta_id, conn=None):
    """Todo lo que mueve una cuenta, mezclado: transferencias, ingresos y gastos.

    Cada uno lleva `origen` (de dónde sale el dato: transferencia, gasto o
    ingreso) y `kind` (`entrada` o `salida` para esa cuenta).
    """
    conn = conn or get_db()
    nombres = {c["id"]: c["nombre"] for c in listar_cuentas(conn)}
    movimientos = []

    for t in listar_transferencias(conn):
        if cuenta_id not in (t["origen"], t["destino"]):
            continue
        entra = t["destino"] == cuenta_id
        otra = t["origen"] if entra else t["destino"]
        movimientos.append({
            "origen": "transferencia",
            "id": t["id"],
            "kind": "entrada" if entra else "salida",
            "contraparte_id": otra,
            "contraparte": nombres.get(otra, otra),
            "fecha": t["fecha"],
            "year": t["year"],
            "month": t["month"],
            "nombre": t["concepto"],
            "cantidad": t["cantidad"],
            "nota": t["nota"],
        })

    for tabla, origen, kind in (("ingresos_rows", "ingreso", "entrada"), ("gastos_rows", "gasto", "salida")):
        for fila in conn.execute(
            f"SELECT id, year, month, fecha, nombre, tipo, cantidad, nota, cuenta FROM {tabla} ORDER BY id"
        ).fetchall():
            if _cuenta_de_fila(fila["cuenta"]) != cuenta_id:
                continue
            movimientos.append({
                "origen": origen,
                "id": fila["id"],
                "kind": kind,
                "contraparte_id": "",
                "contraparte": fila["tipo"],
                "fecha": fila["fecha"],
                "year": fila["year"],
                "month": fila["month"],
                "nombre": fila["nombre"],
                "cantidad": fila["cantidad"],
                "nota": fila["nota"],
            })
    return movimientos
