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
import functools
import json
import re
from decimal import Decimal

from core.db import getDb, transactional
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

def normalizarNombre(valor):
    return re.sub(r"\s+", " ", str(valor or "")).strip()[:_MAX_NOMBRE].strip()


def _normalizarTipo(valor):
    tipo = str(valor or "").strip().lower()
    if tipo not in TIPOS:
        raise CuentaInvalida(f"El tipo de cuenta debe ser uno de: {', '.join(TIPOS)}")
    return tipo


def normalizarFecha(valor):
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


def _importePositivo(valor, campo="cantidad"):
    try:
        cantidad = aDecimal(valor, campo)
    except ImporteInvalido:
        raise CuentaInvalida("La cantidad no es un número válido") from None
    if cantidad <= 0:
        raise CuentaInvalida("La cantidad debe ser mayor que cero")
    return cantidad


def formatearImporte(cantidad):
    """Mismo formato que escribe la web en las celdas: «1.234,56 €»."""
    return aTextoEs(cantidad) + " €"


def _saldoInicial(valor):
    """Saldo de partida: vacío o un número (puede ser negativo). Texto canónico."""
    if valor is None or str(valor).strip() == "":
        return ""
    try:
        return aTexto(aDecimal(valor, "saldo inicial"), decimales=2)
    except ImporteInvalido:
        raise CuentaInvalida("El saldo inicial no es un número válido") from None


@functools.lru_cache(maxsize=8192)
def _decimal(texto):
    # Cacheado: los importes se repiten mucho y Decimal es inmutable, así que
    # compartir el resultado es seguro. Medido en perf/ con un portfolio de 39 MB.
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


def _filaACuenta(fila):
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


def listarCuentas(conn=None):
    conn = conn or getDb()
    filas = conn.execute(f"{_SELECT_CUENTAS} ORDER BY c.sort_order, c.rowid").fetchall()
    return [_filaACuenta(f) for f in filas]


def obtenerCuenta(cuentaId, conn=None):
    conn = conn or getDb()
    fila = conn.execute(f"{_SELECT_CUENTAS} WHERE c.id = ?", (cuentaId,)).fetchone()
    return _filaACuenta(fila) if fila else None


def cuentasDeTipo(tipo, conn=None):
    return [c for c in listarCuentas(conn) if c["tipo"] == tipo]


def resolverCuenta(valor, conn=None):
    """Identificador de la cuenta a la que se refiere `valor`; '' si es la bancaria.

    Acepta el identificador o el nombre (sin distinguir mayúsculas) y los alias de
    la cuenta bancaria. Lo demás es un error que dice cuáles valen.
    """
    texto = normalizarNombre(valor)
    if texto.lower() in _ALIAS_BANCO:
        return ""
    cuentas = listarCuentas(conn)
    for cuenta in cuentas:
        if texto.lower() in (cuenta["id"].lower(), cuenta["nombre"].lower()):
            return "" if cuenta["id"] == ID_BANCO else cuenta["id"]
    validas = ", ".join(c["nombre"] for c in cuentas)
    raise CuentaInvalida(f"La cuenta «{texto}» no existe. Cuentas: {validas}")


def cuentasValidasParaFilas(conn=None):
    """Identificadores con los que una fila de gastos o ingresos puede guardar su cuenta.

    La bancaria no está: en las filas es el vacío.
    """
    return {c["id"] for c in listarCuentas(conn) if c["id"] != ID_BANCO}


def normalizarCuentaDeFila(valor, validas):
    """Lo que se guarda en `cuenta` de una fila: '' (bancaria) o un identificador que existe.

    Una cuenta desconocida —borrada mientras tanto, o escrita a mano— vuelve a la
    bancaria en vez de dejar la fila apuntando a nada.
    """
    texto = str(valor or "").strip()
    return texto if texto in validas else ""


def etiquetasDeCuentas(conn=None):
    """Nombres que se ofrecen al elegir cuenta, con la bancaria la primera."""
    return [c["nombre"] for c in listarCuentas(conn)]


def _nombreLibre(nombre, conn, excepto=None):
    # Los alias de la cuenta bancaria («banco», «cuenta bancaria»…) son suyos: ninguna
    # otra cuenta puede llamarse así, pero ella sí puede quedarse con uno.
    if nombre.lower() in _ALIAS_BANCO and excepto != ID_BANCO:
        raise CuentaInvalida(f"«{nombre}» es el nombre de la cuenta bancaria")
    for cuenta in listarCuentas(conn):
        if cuenta["id"] != excepto and cuenta["nombre"].lower() == nombre.lower():
            raise CuentaInvalida(f"Ya existe una cuenta llamada «{nombre}»")


def _idNuevo(nombre, tipo, conn):
    slug = "".join(c if c.isalnum() else "-" for c in nombre.lower()).strip("-") or "cuenta"
    base = f"{tipo}-{slug}"
    candidato, n = base, 2
    while conn.execute("SELECT 1 FROM cuentas WHERE id = ?", (candidato,)).fetchone():
        candidato = f"{base}-{n}"
        n += 1
    return candidato


# ── Vínculo con las cuentas remuneradas ─────────────────────────────────────

def listarRemuneradas(conn=None):
    """Las cuentas remuneradas, cada una con la cuenta de dinero a la que va ('' si ninguna)."""
    conn = conn or getDb()
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


def _vincular(cuentaId, remuneradaId, conn):
    """Deja `cuenta_id` con `remunerada_id` ('' = sin remunerada).

    Una remunerada que ya está en otra cuenta no se mueve sin más: se rechaza y
    hay que quitarla antes de allí, para que un descuido no cambie la otra cuenta.
    """
    remuneradaId = str(remuneradaId or "").strip()
    if remuneradaId:
        fila = conn.execute("SELECT nombre FROM cuentas_remuneradas WHERE id = ?", (remuneradaId,)).fetchone()
        if fila is None:
            raise CuentaInvalida("La cuenta remunerada no existe")
        otra = conn.execute(
            "SELECT c.nombre FROM cuenta_remunerada_vinculo v JOIN cuentas c ON c.id = v.cuenta_id "
            "WHERE v.remunerada_id = ? AND v.cuenta_id <> ?",
            (remuneradaId, cuentaId),
        ).fetchone()
        if otra is not None:
            raise CuentaInvalida(
                f"La cuenta remunerada «{fila['nombre']}» ya está vinculada a «{otra['nombre']}». "
                "Quítala de allí primero."
            )
    conn.execute("DELETE FROM cuenta_remunerada_vinculo WHERE cuenta_id = ?", (cuentaId,))
    if remuneradaId:
        conn.execute(
            "INSERT INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) VALUES (?, ?)",
            (remuneradaId, cuentaId),
        )


def _marcarDividendos(cuentaId, cobra, conn):
    """Deja que `cuenta_id` cobre (o no) los dividendos.

    Pueden cobrarlos varias: cada dividendo va a una sola (la que trae apuntada o,
    sin ella, la primera marcada), así que no se suma dos veces.
    """
    conn.execute("UPDATE cuentas SET dividendos = ? WHERE id = ?", (1 if cobra else 0, cuentaId))


@transactional
def importarDividendos(cuentaId):
    """Pasa a la base la casilla antigua de dividendos de la ventana de ahorro.

    Solo si ninguna cuenta los cobra todavía: un cambio hecho ya en la base
    manda sobre la configuración vieja. Devuelve si se ha marcado.
    """
    conn = getDb()
    if conn.execute("SELECT 1 FROM cuentas WHERE dividendos = 1").fetchone():
        return False
    cursor = conn.execute("UPDATE cuentas SET dividendos = 1 WHERE id = ?", (cuentaId,))
    conn.commit()
    return cursor.rowcount > 0


@transactional
def importarVinculos(pares):
    """Da de alta los vínculos `(cuenta_id, remunerada_id)` que quepan.

    Para pasar a la tabla los que había en la configuración antigua: se saltan
    los que chocan con uno ya hecho (la cuenta o la remunerada ya tienen pareja)
    o apuntan a algo que no existe. Devuelve cuántos se han creado.
    """
    conn = getDb()
    creados = 0
    for cuentaId, remuneradaId in pares:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO cuenta_remunerada_vinculo (remunerada_id, cuenta_id) "
            "SELECT r.id, c.id FROM cuentas_remuneradas r, cuentas c WHERE r.id = ? AND c.id = ?",
            (remuneradaId, cuentaId),
        )
        creados += cursor.rowcount
    conn.commit()
    return creados


@transactional
def crearCuenta(nombre, tipo, saldoInicial="", remunerada="", dividendos=False, ahorro=None):
    """Crea una cuenta. `ahorro=None` la saca en la ventana de ahorro si es de tipo ahorro."""
    nombre = normalizarNombre(nombre)
    if not nombre:
        raise CuentaInvalida("Escribe un nombre para la cuenta")
    tipo = _normalizarTipo(tipo)
    conn = getDb()
    _nombreLibre(nombre, conn)
    if len(listarCuentas(conn)) >= _MAX_CUENTAS:
        raise CuentaInvalida("Has llegado al máximo de cuentas")
    inicial = _saldoInicial(saldoInicial)
    orden = conn.execute("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM cuentas").fetchone()[0]
    cuentaId = _idNuevo(nombre, tipo, conn)
    esAhorro = tipo == "ahorro" if ahorro is None else bool(ahorro)
    conn.execute(
        "INSERT INTO cuentas (id, nombre, tipo, saldo_inicial, sort_order, ahorro) VALUES (?, ?, ?, ?, ?, ?)",
        (cuentaId, nombre, tipo, inicial, orden, 1 if esAhorro else 0),
    )
    _vincular(cuentaId, remunerada, conn)
    _marcarDividendos(cuentaId, bool(dividendos), conn)
    conn.commit()
    return obtenerCuenta(cuentaId, conn)


@transactional
def modificarCuenta(cuentaId, nombre=None, saldoInicial=None, remunerada=None, dividendos=None, ahorro=None):
    """Cambia el nombre, el saldo inicial, la cuenta remunerada vinculada, si
    cobra los dividendos y/o si es de ahorro (`None` deja cada uno como está;
    `remunerada=''` la desvincula). El tipo no se cambia. La cuenta de ahorro
    principal no deja de serlo: la ventana de ahorro guarda su configuración
    con ella."""
    conn = getDb()
    cuenta = obtenerCuenta(cuentaId, conn)
    if cuenta is None:
        raise CuentaInvalida("La cuenta no existe")

    if nombre is not None:
        nombre = normalizarNombre(nombre)
        if not nombre:
            raise CuentaInvalida("Escribe un nombre para la cuenta")
        _nombreLibre(nombre, conn, excepto=cuentaId)
        conn.execute("UPDATE cuentas SET nombre = ? WHERE id = ?", (nombre, cuentaId))

    if saldoInicial is not None:
        conn.execute(
            "UPDATE cuentas SET saldo_inicial = ? WHERE id = ?", (_saldoInicial(saldoInicial), cuentaId)
        )

    if remunerada is not None:
        _vincular(cuentaId, remunerada, conn)
    if dividendos is not None:
        _marcarDividendos(cuentaId, bool(dividendos), conn)
    if ahorro is not None:
        if not ahorro and cuentaId == ID_AHORRO:
            raise CuentaInvalida(f"«{cuenta['nombre']}» es la cuenta de ahorro principal y no se puede quitar")
        conn.execute("UPDATE cuentas SET ahorro = ? WHERE id = ?", (1 if ahorro else 0, cuentaId))
    conn.commit()
    return obtenerCuenta(cuentaId, conn)


@transactional
def reordenarCuentas(ids):
    """Guarda el orden elegido por el usuario. Las cuentas que no vengan en `ids`
    (creadas mientras tanto) se quedan al final, en su orden de siempre."""
    conn = getDb()
    existentes = [c["id"] for c in listarCuentas(conn)]
    pedidas = [i for i in dict.fromkeys(ids or []) if i in existentes]
    resto = [i for i in existentes if i not in pedidas]
    for orden, cuentaId in enumerate(pedidas + resto, start=1):
        conn.execute("UPDATE cuentas SET sort_order = ? WHERE id = ?", (orden, cuentaId))
    conn.commit()


def _usos(cuentaId, conn):
    # En las filas, la cuenta bancaria es el vacío; el resto, su identificador.
    total = conn.execute(
        "SELECT COUNT(*) FROM transferencias WHERE origen = ? OR destino = ?", (cuentaId, cuentaId)
    ).fetchone()[0]
    # También los dividendos que cobró (columna `cuenta`): borrarla los dejaba
    # apuntando a una cuenta que ya no existe y pasaban a otra sin avisar.
    for tabla in ("gastos_rows", "ingresos_rows", "dividendos"):
        total += conn.execute(f"SELECT COUNT(*) FROM {tabla} WHERE cuenta = ?", (cuentaId,)).fetchone()[0]
    # Las mensualidades y los ingresos recurrentes también apuntan a una cuenta
    # (la habitual o la de algún mes): borrarla movía su dinero a la bancaria.
    for tabla in ("mensualidades", "ingresos_recurrentes"):
        for fila in conn.execute(f"SELECT cuenta, cuentas_cobro FROM {tabla}").fetchall():
            if fila["cuenta"] == cuentaId or cuentaId in _excepcionesDeCuenta(fila["cuentas_cobro"]).values():
                total += 1
    return total


@transactional
def eliminarCuenta(cuentaId):
    conn = getDb()
    cuenta = obtenerCuenta(cuentaId, conn)
    if cuenta is None:
        raise CuentaInvalida("La cuenta no existe")
    if cuenta["protegida"]:
        raise CuentaInvalida(f"«{cuenta['nombre']}» no se puede eliminar")
    usos = _usos(cuentaId, conn)
    if usos:
        raise CuentaEnUso(usos)
    conn.execute("DELETE FROM cuentas WHERE id = ?", (cuentaId,))
    conn.commit()


# ── Transferencias ──────────────────────────────────────────────────────────

def _yearMonth(textoFecha):
    coincide = _FECHA.match(str(textoFecha or "").strip())
    if not coincide:
        return "", ""
    _dia, mes, anio = (int(g) for g in coincide.groups())
    if not 1 <= mes <= 12:
        return "", ""
    return f"{anio:04d}", MONTH_KEYS[mes - 1]


def _filaATransferencia(fila, nombres):
    year, month = _yearMonth(fila["fecha"])
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


def listarTransferencias(conn=None):
    conn = conn or getDb()
    nombres = {c["id"]: c["nombre"] for c in listarCuentas(conn)}
    filas = conn.execute(
        "SELECT id, fecha, origen, destino, cantidad, comision, concepto, nota FROM transferencias ORDER BY id"
    ).fetchall()
    return [_filaATransferencia(f, nombres) for f in filas]


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
    return formatearImporte(importe) if importe else ""


def _prepararTransferencia(origen, destino, fecha, cantidad, concepto, nota, comision, conn):
    ids = {c["id"] for c in listarCuentas(conn)}
    origen = str(origen or "").strip() or ID_BANCO
    destino = str(destino or "").strip() or ID_BANCO
    for cuentaId in (origen, destino):
        if cuentaId not in ids:
            raise CuentaInvalida("Alguna de las cuentas no existe")
    if origen == destino:
        raise CuentaInvalida("El origen y el destino tienen que ser cuentas distintas")
    dia = normalizarFecha(fecha)
    importe = _importePositivo(cantidad)
    return (
        origen,
        destino,
        dia.strftime("%d-%m-%Y"),
        formatearImporte(importe),
        str(concepto or "").strip()[:120],
        str(nota or "").strip()[:300],
        _comision(comision),
    )


@transactional
def crearTransferencia(origen, destino, fecha, cantidad, concepto="", nota="", comision=""):
    conn = getDb()
    origen, destino, fecha, cantidad, concepto, nota, comision = _prepararTransferencia(
        origen, destino, fecha, cantidad, concepto, nota, comision, conn
    )
    cursor = conn.execute(
        "INSERT INTO transferencias (fecha, origen, destino, cantidad, concepto, nota, comision) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (fecha, origen, destino, cantidad, concepto, nota, comision),
    )
    conn.commit()
    return next(t for t in listarTransferencias(conn) if t["id"] == cursor.lastrowid)


@transactional
def modificarTransferencia(transferenciaId, origen, destino, fecha, cantidad, concepto="", nota="", comision=""):
    conn = getDb()
    if not conn.execute("SELECT 1 FROM transferencias WHERE id = ?", (transferenciaId,)).fetchone():
        return None
    origen, destino, fecha, cantidad, concepto, nota, comision = _prepararTransferencia(
        origen, destino, fecha, cantidad, concepto, nota, comision, conn
    )
    conn.execute(
        "UPDATE transferencias SET fecha = ?, origen = ?, destino = ?, cantidad = ?, concepto = ?, nota = ?, "
        "comision = ? WHERE id = ?",
        (fecha, origen, destino, cantidad, concepto, nota, comision, transferenciaId),
    )
    conn.commit()
    return next(t for t in listarTransferencias(conn) if t["id"] == transferenciaId)


@transactional
def eliminarTransferencia(transferenciaId):
    conn = getDb()
    cursor = conn.execute("DELETE FROM transferencias WHERE id = ?", (transferenciaId,))
    conn.commit()
    return cursor.rowcount > 0


# ── Saldos y movimientos ────────────────────────────────────────────────────

def _cuentaDeFila(valor):
    return valor or ID_BANCO


def _excepcionesDeCuenta(texto):
    """`{mes: cuenta}` de la columna `cuentas_cobro` (JSON); vacío si no se entiende."""
    try:
        datos = json.loads(texto) if texto else {}
    except ValueError:
        return {}
    return {m: str(c) for m, c in datos.items() if m in MONTH_KEYS} if isinstance(datos, dict) else {}


def _yaOcurrido(year, month, hoy):
    """¿El mes de esa fila ya ha empezado? Las filas futuras no mueven el saldo."""
    try:
        return (int(year), MONTH_KEYS.index(month)) <= (hoy.year, hoy.month - 1)
    except (ValueError, TypeError):
        return True


def _anioMes(texto):
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


def _cambioAEuros():
    """Convierte a euros con el tipo de hoy, pidiendo cada divisa una sola vez.

    Sin servicio de cambio se cuenta 1:1, como la ventana de ahorro y la
    valoración de la cartera: mejor una cifra aproximada que un saldo que salta
    según responda o no el proveedor.
    """
    from providers.finnhub_client import fetchExchangeRate

    tipos = {"EUR": Decimal(1)}

    def aEuros(importe, moneda):
        divisa = str(moneda or "EUR").strip().upper() or "EUR"
        if divisa not in tipos:
            rate, error = fetchExchangeRate(divisa, "EUR")
            tipos[divisa] = Decimal(str(rate)) if not error and rate and rate > 0 else Decimal(1)
        return importe * tipos[divisa]

    return aEuros


def rendimientos(conn=None, hoy=None, aEuros=None):
    """Lo que han rendido las cuentas, hasta el mes actual: `{id: {intereses, dividendos}}`.

    Los intereses son los netos (acumulado menos impuestos) de la remunerada
    vinculada; los dividendos, el total cobrado, en euros, y solo en la cuenta
    que los cobra. Las cuentas sin nada no aparecen.
    """
    conn = conn or getDb()
    hoy = hoy or datetime.date.today()
    return _rendimientosEn(conn, [hoy], aEuros)[0]


def _rendimientosEn(conn, fechas, aEuros=None):
    """`rendimientos` para varias fechas de corte, leyendo cada tabla una sola vez.

    Cada fila se interpreta (fecha, importe, cambio) una vez y se suma en el
    resultado de cada fecha a la que ya ha llegado. Devuelve una lista paralela
    a `fechas`.
    """
    resultados = [{} for _ in fechas]

    for fila in conn.execute(
        "SELECT v.cuenta_id, i.fecha, i.acumulado, i.impuestos FROM intereses_v2 i "
        "JOIN cuenta_remunerada_vinculo v ON v.remunerada_id = i.cuenta_id"
    ).fetchall():
        year, month = _anioMes(fila["fecha"])
        if not year:
            continue
        neto = None
        for hoy, resultado in zip(fechas, resultados, strict=True):
            if not _yaOcurrido(year, month, hoy):
                continue
            if neto is None:
                neto = _decimal(fila["acumulado"]) - _decimal(fila["impuestos"])
            datos = resultado.setdefault(fila["cuenta_id"], {"intereses": Decimal(0), "dividendos": Decimal(0)})
            datos["intereses"] += neto

    # Cada dividendo va a la cuenta que trae apuntada; los que no la tienen (o la
    # tienen de una cuenta borrada) van a la que cobra los dividendos, si hay.
    cobra = conn.execute("SELECT id FROM cuentas WHERE dividendos = 1 ORDER BY sort_order, rowid").fetchone()
    existentes = {fila["id"] for fila in conn.execute("SELECT id FROM cuentas").fetchall()}
    for fila in conn.execute("SELECT fecha, total, moneda_total, cuenta FROM dividendos").fetchall():
        destino = fila["cuenta"] if fila["cuenta"] in existentes else (cobra["id"] if cobra is not None else None)
        if destino is None:
            continue
        year, month = _anioMes(fila["fecha"])
        if not year:
            continue
        enEuros = None
        for hoy, resultado in zip(fechas, resultados, strict=True):
            if not _yaOcurrido(year, month, hoy):
                continue
            if enEuros is None:
                aEuros = aEuros or _cambioAEuros()
                enEuros = aEuros(_decimal(fila["total"]), fila["moneda_total"])
            datos = resultado.setdefault(destino, {"intereses": Decimal(0), "dividendos": Decimal(0)})
            datos["dividendos"] += enEuros

    return resultados


def saldos(conn=None, hoy=None, aEuros=None):
    """Saldo de cada cuenta a día de hoy:
    `{id: {inicial, entradas, salidas, comisiones, intereses, dividendos, saldo}}`."""
    conn = conn or getDb()
    hoy = hoy or datetime.date.today()
    return _saldosEn(conn, [hoy], aEuros)[0]


def _saldosEn(conn, fechas, aEuros=None):
    """`saldos` para varias fechas de corte en un solo recorrido de las tablas.

    `saldosDelMes` necesita el saldo al cierre del mes anterior y al final del
    mes: leer y convertir cada fila una vez y sumarla en cada corte evita
    repetir el recorrido entero. Devuelve una lista paralela a `fechas`.
    """
    cuentas = listarCuentas(conn)
    acumulados = [
        {c["id"]: {"entradas": Decimal(0), "salidas": Decimal(0), "comisiones": Decimal(0)} for c in cuentas}
        for _ in fechas
    ]
    rendidos = _rendimientosEn(conn, fechas, aEuros)
    existentes = acumulados[0]

    for fila in conn.execute("SELECT fecha, origen, destino, cantidad, comision FROM transferencias").fetchall():
        year, month = _yearMonth(fila["fecha"])
        importe = _decimal(fila["cantidad"])
        comision = _decimal(fila["comision"])
        for hoy, acumulado in zip(fechas, acumulados, strict=True):
            if year and not _yaOcurrido(year, month, hoy):
                continue
            if fila["destino"] in existentes:
                acumulado[fila["destino"]]["entradas"] += importe
            if fila["origen"] in existentes:
                acumulado[fila["origen"]]["salidas"] += importe
                # La comisión se cuenta aparte: no es dinero que llegue a otra cuenta.
                acumulado[fila["origen"]]["comisiones"] += comision

    for tabla, campo in (("ingresos_rows", "entradas"), ("gastos_rows", "salidas")):
        for fila in conn.execute(f"SELECT year, month, cantidad, cuenta FROM {tabla}").fetchall():
            cuentaId = _cuentaDeFila(fila["cuenta"])
            if cuentaId not in existentes:
                continue
            importe = _decimal(fila["cantidad"])
            for hoy, acumulado in zip(fechas, acumulados, strict=True):
                if _yaOcurrido(fila["year"], fila["month"], hoy):
                    acumulado[cuentaId][campo] += importe

    # Mensualidades e ingresos recurrentes: importes por mes, de la cuenta con la
    # que se pagan o en la que se cobran (vacía, o una que ya no existe, = bancaria).
    for tabla, campo in (("ingresos_recurrentes", "entradas"), ("mensualidades", "salidas")):
        columnas = ", ".join(["year", "cuenta", "cuentas_cobro", *MONTH_KEYS])
        for fila in conn.execute(f"SELECT {columnas} FROM {tabla}").fetchall():
            habitual = _cuentaDeFila(fila["cuenta"])
            # Un mes puede cobrarse con otra cuenta que la habitual de la fila.
            excepciones = _excepcionesDeCuenta(fila["cuentas_cobro"])
            for mes in MONTH_KEYS:
                # Una celda vacía vale cero y sumar cero no cambia nada: evita
                # una conversión (con su excepción) por cada mes sin importe.
                if not fila[mes]:
                    continue
                destino = _cuentaDeFila(excepciones.get(mes)) if mes in excepciones else habitual
                if destino not in existentes:
                    destino = ID_BANCO
                importe = None
                for hoy, acumulado in zip(fechas, acumulados, strict=True):
                    if _yaOcurrido(fila["year"], mes, hoy):
                        if importe is None:
                            importe = _decimal(fila[mes])
                        acumulado[destino][campo] += importe

    return [
        {
            cuenta["id"]: _saldoDeCuenta(cuenta, acumulado[cuenta["id"]], rendido.get(cuenta["id"], {}))
            for cuenta in cuentas
        }
        for acumulado, rendido in zip(acumulados, rendidos, strict=True)
    ]


def _saldoDeCuenta(cuenta, datos, extra):
    """Desglose de una cuenta a partir de lo acumulado y de lo que ha rendido."""
    inicial = _decimal(cuenta["saldo_inicial"])
    intereses = extra.get("intereses", Decimal(0))
    dividendos = extra.get("dividendos", Decimal(0))
    return {
        "inicial": inicial,
        "entradas": datos["entradas"],
        "salidas": datos["salidas"],
        "comisiones": datos["comisiones"],
        "intereses": intereses,
        "dividendos": dividendos,
        "saldo": inicial + datos["entradas"] - datos["salidas"] - datos["comisiones"] + intereses + dividendos,
    }


def saldosDelMes(year, month, conn=None, aEuros=None):
    """Punto de partida de cada cuenta para dibujar su mes:
    `{id: {inicial, rendimientos}}`.

    `inicial` es el saldo con el que la cuenta entra en el mes (todo lo ocurrido
    hasta el mes anterior) y `rendimientos` lo que ese mes le suman los intereses
    y dividendos, que no tienen día propio.
    """
    conn = conn or getDb()
    indice = MONTH_KEYS.index(month)
    primerDia = datetime.date(int(year), indice + 1, 1)
    finDeMes = (primerDia + datetime.timedelta(days=32)).replace(day=1) - datetime.timedelta(days=1)
    aEuros = aEuros or _cambioAEuros()
    antes, despues = _saldosEn(conn, [primerDia - datetime.timedelta(days=1), finDeMes], aEuros)
    return {
        cuentaId: {
            "inicial": datos["saldo"],
            "rendimientos": (despues[cuentaId]["intereses"] + despues[cuentaId]["dividendos"])
            - (datos["intereses"] + datos["dividendos"]),
        }
        for cuentaId, datos in antes.items()
    }


def movimientosDeCuenta(cuentaId, conn=None):
    """Todo lo que mueve una cuenta, mezclado: transferencias, ingresos y gastos.

    Cada uno lleva `origen` (de dónde sale el dato: transferencia, gasto o
    ingreso) y `kind` (`entrada` o `salida` para esa cuenta).
    """
    conn = conn or getDb()
    nombres = {c["id"]: c["nombre"] for c in listarCuentas(conn)}
    movimientos = []

    for t in listarTransferencias(conn):
        if cuentaId not in (t["origen"], t["destino"]):
            continue
        entra = t["destino"] == cuentaId
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
            if _cuentaDeFila(fila["cuenta"]) != cuentaId:
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
