"""Cuentas de dinero y transferencias entre ellas.

La cuenta bancaria de Gastos e Ingresos es la base de todo: lo que no dice otra
cosa va a ella. Pero hay dinero que está fuera —en una cuenta de ahorro, un
exchange, un broker u otra cuenta— y moverlo de un sitio a otro **no es un gasto
ni un ingreso**: es una transferencia. Por eso viven en su propia ventana y en
su propia tabla (`transferencias`), y no cuentan en las cifras de gastos.

Qué mueve el saldo de una cuenta:

  * las transferencias que entran y salen de ella. Una transferencia puede llevar
    comisión: la cantidad es lo que recibe la cuenta de destino y lo que sale del
    origen, y la comisión se anota **aparte** (`comisiones`) y se descuenta
    también del origen, sin mezclarse con las salidas;
  * los ingresos que se registran como cobrados en ella y los gastos pagados con
    ella (`gastos_rows.cuenta` / `ingresos_rows.cuenta`; vacío = bancaria);
  * las mensualidades y los ingresos recurrentes, que no son filas sino importes
    por mes, en la cuenta que llevan apuntada (vacío = bancaria);
  * el saldo inicial que se le haya puesto, para no tener que registrar toda la
    historia.

Ser de ahorro o remunerada no es un tipo de cuenta sino un papel que se le da a
una cuenta que ya existe: `cuentas.ahorro` la saca en la ventana Cuenta de
ahorro, y una cuenta remunerada (ventana Cuenta Remunerada) es siempre una
de estas cuentas, vinculada por la tabla `cuenta_remunerada_vinculo`: una por
cuenta y una cuenta por remunerada. Y una
de ellas puede cobrar los dividendos (`cuentas.dividendos`; si son varias, la
primera por orden es la de los dividendos sin cuenta apuntada). Lo que rinden
—los intereses netos de su remunerada y los dividendos que cobra, pasados a
euros— es dinero de esa cuenta y forma parte de su saldo
(`rendimientos`).

Solo cuenta lo que ya ha ocurrido (hasta el mes actual incluido): un recurrente
de diciembre no es dinero que ya esté en la cuenta en octubre.
"""

import datetime
import json
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

_SELECT_CUENTAS = (
    "SELECT c.id, c.nombre, c.tipo, c.saldo_inicial, c.dividendos, c.ahorro, v.remunerada_id, r.nombre AS remunerada_nombre "
    "FROM cuentas c "
    "LEFT JOIN cuenta_remunerada_vinculo v ON v.cuenta_id = c.id "
    "LEFT JOIN cuentas_remuneradas r ON r.id = v.remunerada_id"
)


def _fila_a_cuenta(fila):
    return {
        "id": fila["id"],
        "nombre": fila["nombre"],
        "tipo": fila["tipo"],
        "saldo_inicial": fila["saldo_inicial"],
        "protegida": fila["id"] in (ID_BANCO, ID_AHORRO),
        "remunerada": fila["remunerada_id"] or "",
        "remunerada_nombre": fila["remunerada_nombre"] or "",
        "dividendos": bool(fila["dividendos"]),
        "ahorro": bool(fila["ahorro"]),
    }


def listar_cuentas(conn=None):
    conn = conn or get_db()
    filas = conn.execute(f"{_SELECT_CUENTAS} ORDER BY c.sort_order, c.rowid").fetchall()
    return [_fila_a_cuenta(f) for f in filas]


def obtener_cuenta(cuenta_id, conn=None):
    conn = conn or get_db()
    fila = conn.execute(f"{_SELECT_CUENTAS} WHERE c.id = ?", (cuenta_id,)).fetchone()
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


# ── Vínculo con las cuentas remuneradas ─────────────────────────────────────

def listar_remuneradas(conn=None):
    """Las cuentas remuneradas, cada una con la cuenta de dinero a la que va ('' si ninguna)."""
    conn = conn or get_db()
    filas = conn.execute(
        "SELECT r.id, COALESCE(c.nombre, r.nombre) AS nombre, COALESCE(v.cuenta_id, '') AS cuenta_id, "
        "COALESCE(c.nombre, '') AS cuenta_nombre "
        "FROM cuentas_remuneradas r "
        "LEFT JOIN cuenta_remunerada_vinculo v ON v.remunerada_id = r.id "
        "LEFT JOIN cuentas c ON c.id = v.cuenta_id "
        "ORDER BY r.sort_order, r.rowid"
    ).fetchall()
    return [
        {"id": f["id"], "nombre": f["nombre"], "cuenta": f["cuenta_id"], "cuenta_nombre": f["cuenta_nombre"]}
        for f in filas
    ]


def _vincular(cuenta_id, remunerada_id, conn):
    """Deja `cuenta_id` con `remunerada_id` ('' = sin remunerada).

    Una remunerada que ya está en otra cuenta no se mueve sin más: se rechaza y
    hay que quitarla antes de allí, para que un descuido no cambie la otra cuenta.
    """
    remunerada_id = str(remunerada_id or "").strip()
    if remunerada_id:
        fila = conn.execute("SELECT nombre FROM cuentas_remuneradas WHERE id = ?", (remunerada_id,)).fetchone()
        if fila is None:
            raise CuentaInvalida("La cuenta remunerada no existe")
        otra = conn.execute(
            "SELECT c.nombre FROM cuenta_remunerada_vinculo v JOIN cuentas c ON c.id = v.cuenta_id "
            "WHERE v.remunerada_id = ? AND v.cuenta_id <> ?",
            (remunerada_id, cuenta_id),
        ).fetchone()
        if otra is not None:
            raise CuentaInvalida(
                f"La cuenta remunerada «{fila['nombre']}» ya está vinculada a «{otra['nombre']}». "
                "Quítala de allí primero."
            )
    conn.execute("DELETE FROM cuenta_remunerada_vinculo WHERE cuenta_id = ?", (cuenta_id,))
    if remunerada_id:
        conn.execute(
            "INSERT INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) VALUES (?, ?)",
            (remunerada_id, cuenta_id),
        )


def _marcar_dividendos(cuenta_id, cobra, conn):
    """Deja que `cuenta_id` cobre (o no) los dividendos.

    Pueden cobrarlos varias: cada dividendo va a una sola (la que trae apuntada o,
    sin ella, la primera marcada), así que no se suma dos veces.
    """
    conn.execute("UPDATE cuentas SET dividendos = ? WHERE id = ?", (1 if cobra else 0, cuenta_id))


@transactional
def importar_dividendos(cuenta_id):
    """Pasa a la base la casilla antigua de dividendos de la ventana de ahorro.

    Solo si ninguna cuenta los cobra todavía: un cambio hecho ya en la base
    manda sobre la configuración vieja. Devuelve si se ha marcado.
    """
    conn = get_db()
    if conn.execute("SELECT 1 FROM cuentas WHERE dividendos = 1").fetchone():
        return False
    cursor = conn.execute("UPDATE cuentas SET dividendos = 1 WHERE id = ?", (cuenta_id,))
    conn.commit()
    return cursor.rowcount > 0


@transactional
def importar_vinculos(pares):
    """Da de alta los vínculos `(cuenta_id, remunerada_id)` que quepan.

    Para pasar a la tabla los que había en la configuración antigua: se saltan
    los que chocan con uno ya hecho (la cuenta o la remunerada ya tienen pareja)
    o apuntan a algo que no existe. Devuelve cuántos se han creado.
    """
    conn = get_db()
    creados = 0
    for cuenta_id, remunerada_id in pares:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) "
            "SELECT r.id, c.id FROM cuentas_remuneradas r, cuentas c WHERE r.id = ? AND c.id = ?",
            (remunerada_id, cuenta_id),
        )
        creados += cursor.rowcount
    conn.commit()
    return creados


@transactional
def crear_cuenta(nombre, tipo, saldo_inicial="", remunerada="", dividendos=False, ahorro=None):
    """Crea una cuenta. `ahorro=None` la saca en la ventana de ahorro si es de tipo ahorro."""
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
    es_ahorro = tipo == "ahorro" if ahorro is None else bool(ahorro)
    conn.execute(
        "INSERT INTO cuentas (id, nombre, tipo, saldo_inicial, sort_order, ahorro) VALUES (?, ?, ?, ?, ?, ?)",
        (cuenta_id, nombre, tipo, inicial, orden, 1 if es_ahorro else 0),
    )
    _vincular(cuenta_id, remunerada, conn)
    _marcar_dividendos(cuenta_id, bool(dividendos), conn)
    conn.commit()
    return obtener_cuenta(cuenta_id, conn)


@transactional
def modificar_cuenta(cuenta_id, nombre=None, saldo_inicial=None, remunerada=None, dividendos=None, ahorro=None):
    """Cambia el nombre, el saldo inicial, la cuenta remunerada vinculada, si
    cobra los dividendos y/o si es de ahorro (`None` deja cada uno como está;
    `remunerada=''` la desvincula). El tipo no se cambia. La cuenta de ahorro
    principal no deja de serlo: la ventana de ahorro guarda su configuración
    con ella."""
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

    if remunerada is not None:
        _vincular(cuenta_id, remunerada, conn)
    if dividendos is not None:
        _marcar_dividendos(cuenta_id, bool(dividendos), conn)
    if ahorro is not None:
        if not ahorro and cuenta_id == ID_AHORRO:
            raise CuentaInvalida(f"«{cuenta['nombre']}» es la cuenta de ahorro principal y no se puede quitar")
        conn.execute("UPDATE cuentas SET ahorro = ? WHERE id = ?", (1 if ahorro else 0, cuenta_id))
    conn.commit()
    return obtener_cuenta(cuenta_id, conn)


@transactional
def reordenar_cuentas(ids):
    """Guarda el orden elegido por el usuario. Las cuentas que no vengan en `ids`
    (creadas mientras tanto) se quedan al final, en su orden de siempre."""
    conn = get_db()
    existentes = [c["id"] for c in listar_cuentas(conn)]
    pedidas = [i for i in dict.fromkeys(ids or []) if i in existentes]
    resto = [i for i in existentes if i not in pedidas]
    for orden, cuenta_id in enumerate(pedidas + resto, start=1):
        conn.execute("UPDATE cuentas SET sort_order = ? WHERE id = ?", (orden, cuenta_id))
    conn.commit()


def _usos(cuenta_id, conn):
    # En las filas, la cuenta bancaria es el vacío; el resto, su identificador.
    total = conn.execute(
        "SELECT COUNT(*) FROM transferencias WHERE origen = ? OR destino = ?", (cuenta_id, cuenta_id)
    ).fetchone()[0]
    # También los dividendos que cobró (columna `cuenta`): borrarla los dejaba
    # apuntando a una cuenta que ya no existe y pasaban a otra sin avisar.
    for tabla in ("gastos_rows", "ingresos_rows", "dividendos"):
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
        "comision": fila["comision"],
        "concepto": fila["concepto"],
        "nota": fila["nota"],
    }


def listar_transferencias(conn=None):
    conn = conn or get_db()
    nombres = {c["id"]: c["nombre"] for c in listar_cuentas(conn)}
    filas = conn.execute(
        "SELECT id, fecha, origen, destino, cantidad, comision, concepto, nota FROM transferencias ORDER BY id"
    ).fetchall()
    return [_fila_a_transferencia(f, nombres) for f in filas]


def _comision(valor):
    """Texto canónico de la comisión: vacío si no hay (o es 0), nunca negativa."""
    if valor is None or str(valor).strip() == "":
        return ""
    try:
        importe = aDecimal(valor, "comisión")
    except ImporteInvalido:
        raise CuentaInvalida("La comisión no es un número válido") from None
    if importe < 0:
        raise CuentaInvalida("La comisión no puede ser negativa")
    return formatear_importe(importe) if importe else ""


def _preparar_transferencia(origen, destino, fecha, cantidad, concepto, nota, comision, conn):
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
        _comision(comision),
    )


@transactional
def crear_transferencia(origen, destino, fecha, cantidad, concepto="", nota="", comision=""):
    conn = get_db()
    origen, destino, fecha, cantidad, concepto, nota, comision = _preparar_transferencia(
        origen, destino, fecha, cantidad, concepto, nota, comision, conn
    )
    cursor = conn.execute(
        "INSERT INTO transferencias (fecha, origen, destino, cantidad, concepto, nota, comision) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (fecha, origen, destino, cantidad, concepto, nota, comision),
    )
    conn.commit()
    return next(t for t in listar_transferencias(conn) if t["id"] == cursor.lastrowid)


@transactional
def modificar_transferencia(transferencia_id, origen, destino, fecha, cantidad, concepto="", nota="", comision=""):
    conn = get_db()
    if not conn.execute("SELECT 1 FROM transferencias WHERE id = ?", (transferencia_id,)).fetchone():
        return None
    origen, destino, fecha, cantidad, concepto, nota, comision = _preparar_transferencia(
        origen, destino, fecha, cantidad, concepto, nota, comision, conn
    )
    conn.execute(
        "UPDATE transferencias SET fecha = ?, origen = ?, destino = ?, cantidad = ?, concepto = ?, nota = ?, "
        "comision = ? WHERE id = ?",
        (fecha, origen, destino, cantidad, concepto, nota, comision, transferencia_id),
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


def _excepciones_de_cuenta(texto):
    """`{mes: cuenta}` de la columna `cuentas_cobro` (JSON); vacío si no se entiende."""
    try:
        datos = json.loads(texto) if texto else {}
    except ValueError:
        return {}
    return {m: str(c) for m, c in datos.items() if m in MONTH_KEYS} if isinstance(datos, dict) else {}


def _ya_ocurrido(year, month, hoy):
    """¿El mes de esa fila ya ha empezado? Las filas futuras no mueven el saldo."""
    try:
        return (int(year), MONTH_KEYS.index(month)) <= (hoy.year, hoy.month - 1)
    except (ValueError, TypeError):
        return True


def _anio_mes(texto):
    """`(año, clave del mes)` de una fecha dd-mm-aaaa, aaaa-mm-dd, mm-aaaa o
    aaaa-mm (las que aceptan intereses y dividendos); `("", "")` si no se entiende."""
    partes = re.split(r"[-/.]", str(texto or "").strip())
    if not 2 <= len(partes) <= 3 or not all(p.isdigit() for p in partes):
        return "", ""
    if len(partes[0]) == 4:
        anio, mes = partes[0], partes[1]
    else:
        anio, mes = partes[-1], partes[-2]
    if len(anio) != 4 or not 1 <= int(mes) <= 12:
        return "", ""
    return anio, MONTH_KEYS[int(mes) - 1]


def _cambio_a_euros():
    """Convierte a euros con el tipo de hoy, pidiendo cada divisa una sola vez.

    Sin servicio de cambio se cuenta 1:1, como la ventana de ahorro y la
    valoración de la cartera: mejor una cifra aproximada que un saldo que salta
    según responda o no el proveedor.
    """
    from providers.finnhub_client import fetch_exchange_rate

    tipos = {"EUR": Decimal(1)}

    def a_euros(importe, moneda):
        divisa = str(moneda or "EUR").strip().upper() or "EUR"
        if divisa not in tipos:
            rate, error = fetch_exchange_rate(divisa, "EUR")
            tipos[divisa] = Decimal(str(rate)) if not error and rate and rate > 0 else Decimal(1)
        return importe * tipos[divisa]

    return a_euros


def rendimientos(conn=None, hoy=None, a_euros=None):
    """Lo que han rendido las cuentas, hasta el mes actual: `{id: {intereses, dividendos}}`.

    Los intereses son los netos (acumulado menos impuestos) de la remunerada
    vinculada; los dividendos, el total cobrado, en euros, y solo en la cuenta
    que los cobra. Las cuentas sin nada no aparecen.
    """
    conn = conn or get_db()
    hoy = hoy or datetime.date.today()
    resultado = {}

    for fila in conn.execute(
        "SELECT v.cuenta_id, i.fecha, i.acumulado, i.impuestos FROM intereses_v2 i "
        "JOIN cuenta_remunerada_vinculo v ON v.remunerada_id = i.cuenta_id"
    ).fetchall():
        year, month = _anio_mes(fila["fecha"])
        if not year or not _ya_ocurrido(year, month, hoy):
            continue
        datos = resultado.setdefault(fila["cuenta_id"], {"intereses": Decimal(0), "dividendos": Decimal(0)})
        datos["intereses"] += _decimal(fila["acumulado"]) - _decimal(fila["impuestos"])

    # Cada dividendo va a la cuenta que trae apuntada; los que no la tienen (o la
    # tienen de una cuenta borrada) van a la que cobra los dividendos, si hay.
    cobra = conn.execute("SELECT id FROM cuentas WHERE dividendos = 1 ORDER BY sort_order, rowid").fetchone()
    existentes = {fila["id"] for fila in conn.execute("SELECT id FROM cuentas").fetchall()}
    for fila in conn.execute("SELECT fecha, total, moneda_total, cuenta FROM dividendos").fetchall():
        destino = fila["cuenta"] if fila["cuenta"] in existentes else (cobra["id"] if cobra is not None else None)
        if destino is None:
            continue
        year, month = _anio_mes(fila["fecha"])
        if not year or not _ya_ocurrido(year, month, hoy):
            continue
        a_euros = a_euros or _cambio_a_euros()
        datos = resultado.setdefault(destino, {"intereses": Decimal(0), "dividendos": Decimal(0)})
        datos["dividendos"] += a_euros(_decimal(fila["total"]), fila["moneda_total"])

    return resultado


def saldos(conn=None, hoy=None, a_euros=None):
    """Saldo de cada cuenta a día de hoy:
    `{id: {inicial, entradas, salidas, comisiones, intereses, dividendos, saldo}}`."""
    conn = conn or get_db()
    hoy = hoy or datetime.date.today()
    cuentas = listar_cuentas(conn)
    acumulado = {
        c["id"]: {"entradas": Decimal(0), "salidas": Decimal(0), "comisiones": Decimal(0)} for c in cuentas
    }
    rendido = rendimientos(conn, hoy, a_euros)

    for fila in conn.execute("SELECT fecha, origen, destino, cantidad, comision FROM transferencias").fetchall():
        year, month = _year_month(fila["fecha"])
        if year and not _ya_ocurrido(year, month, hoy):
            continue
        importe = _decimal(fila["cantidad"])
        if fila["destino"] in acumulado:
            acumulado[fila["destino"]]["entradas"] += importe
        if fila["origen"] in acumulado:
            acumulado[fila["origen"]]["salidas"] += importe
            # La comisión se cuenta aparte: no es dinero que llegue a otra cuenta.
            acumulado[fila["origen"]]["comisiones"] += _decimal(fila["comision"])

    for tabla, campo in (("ingresos_rows", "entradas"), ("gastos_rows", "salidas")):
        for fila in conn.execute(f"SELECT year, month, cantidad, cuenta FROM {tabla}").fetchall():
            cuenta_id = _cuenta_de_fila(fila["cuenta"])
            if cuenta_id in acumulado and _ya_ocurrido(fila["year"], fila["month"], hoy):
                acumulado[cuenta_id][campo] += _decimal(fila["cantidad"])

    # Mensualidades e ingresos recurrentes: importes por mes, de la cuenta con la
    # que se pagan o en la que se cobran (vacía, o una que ya no existe, = bancaria).
    for tabla, campo in (("ingresos_recurrentes", "entradas"), ("mensualidades", "salidas")):
        extra = ", cuentas_cobro" if tabla == "mensualidades" else ""
        columnas = ", ".join(["year", "cuenta", *MONTH_KEYS]) + extra
        for fila in conn.execute(f"SELECT {columnas} FROM {tabla}").fetchall():
            habitual = _cuenta_de_fila(fila["cuenta"])
            # Un mes puede cobrarse con otra cuenta que la habitual de la mensualidad.
            excepciones = _excepciones_de_cuenta(fila["cuentas_cobro"]) if extra else {}
            for mes in MONTH_KEYS:
                if _ya_ocurrido(fila["year"], mes, hoy):
                    destino = _cuenta_de_fila(excepciones.get(mes)) if mes in excepciones else habitual
                    if destino not in acumulado:
                        destino = ID_BANCO
                    acumulado[destino][campo] += _decimal(fila[mes])

    resultado = {}
    for cuenta in cuentas:
        datos = acumulado[cuenta["id"]]
        inicial = _decimal(cuenta["saldo_inicial"])
        extra = rendido.get(cuenta["id"], {})
        intereses = extra.get("intereses", Decimal(0))
        dividendos = extra.get("dividendos", Decimal(0))
        resultado[cuenta["id"]] = {
            "inicial": inicial,
            "entradas": datos["entradas"],
            "salidas": datos["salidas"],
            "comisiones": datos["comisiones"],
            "intereses": intereses,
            "dividendos": dividendos,
            "saldo": inicial + datos["entradas"] - datos["salidas"] - datos["comisiones"] + intereses + dividendos,
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
            "comision": t["comision"],
            "nota": t["nota"],
        })
        # La comisión sale de la cuenta de origen como un movimiento propio, para
        # que el saldo y las listas cuadren con lo que de verdad pagó esa cuenta.
        if not entra and _decimal(t["comision"]) > 0:
            movimientos.append({
                "origen": "comision",
                "id": t["id"],
                "kind": "salida",
                "contraparte_id": otra,
                "contraparte": nombres.get(otra, otra),
                "fecha": t["fecha"],
                "year": t["year"],
                "month": t["month"],
                "nombre": f"Comisión · {t['concepto']}" if t["concepto"] else "Comisión",
                "cantidad": t["comision"],
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
