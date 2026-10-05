"""Cuentas de ahorro: configuración, aportación mensual automática y movimientos.

Una cuenta de ahorro es una cuenta de dinero más (`cuentas_store`, tipo `ahorro`).
Sus movimientos son transferencias desde y hacia otras cuentas —lo normal, la
bancaria—, más los ingresos cobrados y los gastos pagados con ella, que se
anotan en Ingresos y Gastos eligiendo esa cuenta. Meter dinero en ahorro **no es
un gasto**: es una transferencia.

Lo que este módulo añade a eso es lo propio de la ventana de ahorro: el objetivo,
las cuentas remuneradas y los dividendos vinculados, y la aportación mensual
automática. Todo eso es configuración por cuenta y vive en los ajustes del
portfolio, no en la base de datos.
"""

import calendar
import datetime
import re

from core.dinero import ImporteInvalido, aDecimal, aTexto
from stores.cuentas_store import (
    ID_AHORRO,
    ID_BANCO,
    CuentaInvalida,
    crear_transferencia,
    listar_cuentas,
    movimientos_de_cuenta,
    normalizar_nombre,
)

_MES = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
_MAX_CUENTAS = 61


def clave_de_cuenta(cuenta):
    """Con qué nombre se guarda la configuración de una cuenta de ahorro.

    La principal se guarda con el nombre vacío (así estaba antes de que las
    cuentas tuvieran identificador, y así sigue valiendo lo que ya hubiera); las
    demás, con su nombre.
    """
    return "" if cuenta["id"] == ID_AHORRO else cuenta["nombre"]


def cuentas_de_ahorro(conn=None):
    return [c for c in listar_cuentas(conn) if c["tipo"] == "ahorro"]


def buscar_por_clave(clave, conn=None):
    """La cuenta de ahorro a la que corresponde una clave de configuración."""
    for cuenta in cuentas_de_ahorro(conn):
        if clave_de_cuenta(cuenta).lower() == str(clave or "").lower():
            return cuenta
    return None


def listar_movimientos(conn=None):
    """Los movimientos de todas las cuentas de ahorro, cada uno con su cuenta."""
    movimientos = []
    for cuenta in cuentas_de_ahorro(conn):
        for movimiento in movimientos_de_cuenta(cuenta["id"], conn):
            movimientos.append({**movimiento, "cuenta": cuenta["id"], "cuenta_nombre": cuenta["nombre"]})
    return movimientos


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
    for entrada in entradas[:_MAX_CUENTAS]:
        if not isinstance(entrada, dict):
            continue
        nombre = normalizar_nombre(entrada.get("nombre"))
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


def renombrar_en_config(config, de, a):
    """La configuración con la entrada `de` pasada a llamarse `a`."""
    normal = normalizar_config(config)
    for cuenta in normal["cuentas"]:
        if cuenta["nombre"].lower() == str(de or "").lower():
            cuenta["nombre"] = a
    return normal


# ── Aportación mensual automática ───────────────────────────────────────────

def _mes_siguiente(texto):
    anio, mes = int(texto[:4]), int(texto[5:7])
    return f"{anio + (mes == 12):04d}-{mes % 12 + 1:02d}"


def aplicar_recurrentes(config, generado, hoy=None):
    """Crea las aportaciones mensuales que ya tocan y no se han creado.

    Cada aportación es una transferencia desde la cuenta bancaria. `generado`
    guarda, por cuenta, el último mes creado (`YYYY-MM`). Es lo que hace
    idempotente la operación y lo que evita que reaparezca una aportación que el
    usuario borró a propósito. No está en la configuración que edita el
    navegador: allí una copia vieja lo pisaría y duplicaría aportaciones.

    Devuelve (nuevo `generado`, transferencias creadas).
    """
    hoy = hoy or datetime.date.today()
    mes_actual = f"{hoy.year:04d}-{hoy.month:02d}"
    generado = dict(generado or {})
    creados = []

    for entrada in normalizar_config(config)["cuentas"]:
        rec = entrada["recurrente"]
        if not (rec["activa"] and rec["importe"] and rec["desde"]):
            continue
        cuenta = buscar_por_clave(entrada["nombre"])
        if cuenta is None:
            continue

        clave = entrada["nombre"].lower() or "_"
        ultimo = generado.get(clave, "")
        mes = rec["desde"] if not ultimo else max(rec["desde"], _mes_siguiente(ultimo))

        while mes <= mes_actual:
            anio, num = int(mes[:4]), int(mes[5:7])
            dia = min(rec["dia"], calendar.monthrange(anio, num)[1])
            fecha = datetime.date(anio, num, dia)
            if fecha > hoy:
                break
            try:
                creados.append(crear_transferencia(
                    ID_BANCO, cuenta["id"], fecha.strftime("%d-%m-%Y"), rec["importe"],
                    "Ahorro mensual", "Aportación automática",
                ))
            except CuentaInvalida:
                break
            generado[clave] = mes
            mes = _mes_siguiente(mes)

    return generado, creados
