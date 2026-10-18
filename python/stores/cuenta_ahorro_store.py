"""Cuentas de ahorro: configuración, aportación mensual automática y movimientos.

Una cuenta de ahorro es una cuenta de dinero más (`cuentas_store`, tipo `ahorro`).
Sus movimientos son transferencias desde y hacia otras cuentas —lo normal, la
bancaria—, más los ingresos cobrados y los gastos pagados con ella, que se
anotan en Ingresos y Gastos eligiendo esa cuenta. Meter dinero en ahorro **no es
un gasto**: es una transferencia.

Lo que este módulo añade a eso es lo propio de la ventana de ahorro: el objetivo
y la aportación mensual automática. Eso es configuración por cuenta y vive en
los ajustes del portfolio, no en la base de datos.

La cuenta remunerada de cada cuenta y la cuenta que cobra los dividendos ya no
están aquí: son de la cuenta, en la base (`cuentas_store`), valen para cualquier
tipo de cuenta y entran en su saldo. Antes se guardaban en esta configuración,
por nombre de cuenta; `vinculosDeConfig` y `dividendosDeConfig` sacan lo
antiguo para pasarlo a la base.
"""

import calendar
import datetime
import re

from core.dinero import ImporteInvalido, aDecimal, aTexto
from stores.cuentas_store import (
    ID_AHORRO,
    ID_BANCO,
    CuentaInvalida,
    crearTransferencia,
    listarCuentas,
    movimientosDeCuenta,
    normalizarNombre,
)

_MES = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_MAX_CUENTAS = 61


def claveDeCuenta(cuenta):
    """Con qué nombre se guarda la configuración de una cuenta de ahorro.

    La principal se guarda con el nombre vacío (así estaba antes de que las
    cuentas tuvieran identificador, y así sigue valiendo lo que ya hubiera); las
    demás, con su nombre.
    """
    return "" if cuenta["id"] == ID_AHORRO else cuenta["nombre"]


def cuentasDeAhorro(conn=None):
    """Las cuentas elegidas como de ahorro, sean del tipo que sean."""
    return [c for c in listarCuentas(conn) if c["ahorro"]]


def buscarPorClave(clave, conn=None):
    """La cuenta de ahorro a la que corresponde una clave de configuración."""
    for cuenta in cuentasDeAhorro(conn):
        if claveDeCuenta(cuenta).lower() == str(clave or "").lower():
            return cuenta
    return None


def listarMovimientos(conn=None):
    """Los movimientos de todas las cuentas de ahorro, cada uno con su cuenta."""
    movimientos = []
    for cuenta in cuentasDeAhorro(conn):
        for movimiento in movimientosDeCuenta(cuenta["id"], conn):
            movimientos.append({**movimiento, "cuenta": cuenta["id"], "cuenta_nombre": cuenta["nombre"]})
    return movimientos


# ── Configuración por cuenta (vive en los ajustes del portfolio) ────────────

def _importeCanonico(valor):
    try:
        numero = aDecimal(valor, "importe")
    except ImporteInvalido:
        return ""
    return aTexto(numero, decimales=2) if numero > 0 else ""


def _cuentaVacia(nombre):
    return {
        "nombre": nombre,
        "objetivo": "",
        "recurrente": {"activa": False, "importe": "", "dia": 1, "desde": ""},
    }


def _entradas(raw):
    """Las entradas por cuenta de una configuración, en la forma nueva o la antigua
    (una sola cuenta, con `cuentasRemuneradas` e `incluirDividendos` en la raíz)."""
    raw = raw if isinstance(raw, dict) else {}
    if isinstance(raw.get("cuentas"), list):
        return raw["cuentas"]
    return [{
        "nombre": "",
        "remuneradas": raw.get("cuentasRemuneradas", []),
        "incluirDividendos": raw.get("incluirDividendos", False),
    }]


def vinculosDeConfig(raw, conn=None):
    """Los vínculos cuenta ↔ remunerada que guardaba la configuración antigua.

    Lista de `(id de cuenta, id de remunerada)`, en el orden en que estaban: si
    una cuenta tenía varias, la tabla nueva se quedará con la primera que quepa.
    """
    pares = []
    for entrada in _entradas(raw)[:_MAX_CUENTAS]:
        if not isinstance(entrada, dict):
            continue
        ids = entrada.get("remuneradas")
        if not isinstance(ids, list) or not ids:
            continue
        cuenta = buscarPorClave(normalizarNombre(entrada.get("nombre")), conn)
        if cuenta is None:
            continue
        pares.extend((cuenta["id"], str(rid).strip()) for rid in ids[:100] if str(rid).strip())
    return pares


def dividendosDeConfig(raw, conn=None):
    """Identificador de la cuenta que tenía marcados los dividendos en la
    configuración antigua, o `None`."""
    for entrada in _entradas(raw)[:_MAX_CUENTAS]:
        if isinstance(entrada, dict) and entrada.get("incluirDividendos"):
            cuenta = buscarPorClave(normalizarNombre(entrada.get("nombre")), conn)
            if cuenta is not None:
                return cuenta["id"]
    return None


def normalizarConfig(raw):
    """Configuración de las cuentas de ahorro, con la forma que guarda y lee todo.

    Acepta también la forma antigua, que pasa a ser la cuenta principal. Las
    remuneradas y los dividendos se quitan: viven en la base (ver
    `vinculosDeConfig` y `dividendosDeConfig`).
    """
    entradas = _entradas(raw)

    cuentas = []
    vistos = set()
    for entrada in entradas[:_MAX_CUENTAS]:
        if not isinstance(entrada, dict):
            continue
        nombre = normalizarNombre(entrada.get("nombre"))
        if nombre.lower() in vistos:
            continue
        vistos.add(nombre.lower())

        rec = entrada.get("recurrente") if isinstance(entrada.get("recurrente"), dict) else {}
        try:
            dia = max(1, min(31, int(rec.get("dia", 1))))
        except (TypeError, ValueError):
            dia = 1
        desde = str(rec.get("desde", "")).strip()

        cuentas.append({
            "nombre": nombre,
            "objetivo": _importeCanonico(entrada.get("objetivo")),
            "recurrente": {
                "activa": bool(rec.get("activa", False)),
                "importe": _importeCanonico(rec.get("importe")),
                "dia": dia,
                "desde": desde if _MES.match(desde) else "",
            },
        })

    if "" not in vistos:
        cuentas.insert(0, _cuentaVacia(""))
    return {"cuentas": cuentas}


def renombrarEnConfig(config, de, a):
    """La configuración con la entrada `de` pasada a llamarse `a`."""
    normal = normalizarConfig(config)
    for cuenta in normal["cuentas"]:
        if cuenta["nombre"].lower() == str(de or "").lower():
            cuenta["nombre"] = a
    return normal


# ── Aportación mensual automática ───────────────────────────────────────────

def _mesSiguiente(texto):
    anio, mes = int(texto[:4]), int(texto[5:7])
    return f"{anio + (mes == 12):04d}-{mes % 12 + 1:02d}"


def aplicarRecurrentes(config, generado, hoy=None):
    """Crea las aportaciones mensuales que ya tocan y no se han creado.

    Cada aportación es una transferencia desde la cuenta bancaria. `generado`
    guarda, por cuenta, el último mes creado (`YYYY-MM`). Es lo que hace
    idempotente la operación y lo que evita que reaparezca una aportación que el
    usuario borró a propósito. No está en la configuración que edita el
    navegador: allí una copia vieja lo pisaría y duplicaría aportaciones.

    Devuelve (nuevo `generado`, transferencias creadas).
    """
    hoy = hoy or datetime.date.today()
    mesActual = f"{hoy.year:04d}-{hoy.month:02d}"
    generado = dict(generado or {})
    creados = []

    for entrada in normalizarConfig(config)["cuentas"]:
        rec = entrada["recurrente"]
        if not (rec["activa"] and rec["importe"] and rec["desde"]):
            continue
        cuenta = buscarPorClave(entrada["nombre"])
        if cuenta is None:
            continue

        clave = entrada["nombre"].lower() or "_"
        ultimo = generado.get(clave, "")
        mes = rec["desde"] if not ultimo else max(rec["desde"], _mesSiguiente(ultimo))

        while mes <= mesActual:
            anio, num = int(mes[:4]), int(mes[5:7])
            dia = min(rec["dia"], calendar.monthrange(anio, num)[1])
            fecha = datetime.date(anio, num, dia)
            if fecha > hoy:
                break
            try:
                creados.append(crearTransferencia(
                    ID_BANCO, cuenta["id"], fecha.strftime("%d-%m-%Y"), rec["importe"],
                    "Ahorro mensual", "Aportación automática",
                ))
            except CuentaInvalida:
                break
            generado[clave] = mes
            mes = _mesSiguiente(mes)

    return generado, creados
