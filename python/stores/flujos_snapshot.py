"""Flujo de dinero entre dos snapshots.

TWR, XIRR y Dietz miden el rendimiento quitando lo que el inversor aportó o
retiró, y para eso necesitan ese flujo. Se deducía del cambio en `total_invested`,
pero eso es un coste, no dinero: al vender, el invertido baja el coste de lo
vendido y no lo cobrado, así que la ganancia realizada desaparecía del
rendimiento, y al moverse el tipo de cambio el invertido de los activos en
divisa se movía sin que entrara dinero.

Diseño. Se lleva un **total de caja**: la suma, en euros y con el tipo de cambio
de cada operación, de todo el dinero que han movido las compras (entra) y las ventas (cobro neto de comisión, sale). Cada snapshot guarda
`flujo = total de caja ahora - total de caja en el snapshot anterior`.

Lo que sale de ahí:

  * Una operación con fecha antigua apuntada hoy entra en el flujo del *siguiente*
    snapshot, que es cuando aparece en los datos con los que se valora la
    cartera. Los flujos ya guardados no se reescriben.
  * Editar o borrar una operación entra igual, con el signo que corresponda.
  * Las conversiones entre criptos y las transferencias entre wallets no mueven
    dinero fiat y no cuentan.
  * Una operación que no se puede convertir a euros (falta el tipo de cambio o el
    importe es ilegible) no se inventa: su firma se guarda y, mientras el
    conjunto de operaciones no convertibles cambie de un snapshot al siguiente,
    el flujo de ese tramo queda vacío (NULL) y quien lo use cae al cambio del
    invertido y lo marca como estimado.
  * El primer snapshot tras activar esto no tiene con qué compararse: guarda la
    base y su flujo queda vacío.
"""

import hashlib
import logging
from decimal import Decimal

from core import dinero

log = logging.getLogger(__name__)

CERO = Decimal("0")


def _factor(moneda, tipo):
    """Euros por unidad de `moneda`, o None si no se sabe (no se descarga ni se toma 1)."""
    divisa = str(moneda or "EUR").strip().upper() or "EUR"
    cambio = dinero.aDecimalONulo(tipo)
    if cambio is not None and cambio > 0:
        return cambio
    return Decimal("1") if divisa == "EUR" else None


def _importe(valor):
    """Importe leído, o None si el texto no vacío no se entiende."""
    if valor is None or not str(valor).strip():
        return CERO
    return dinero.aDecimalONulo(valor)


def _movimientos(conn):
    """`(partes, descripcion)` de cada operación que mueve dinero fiat.

    `partes` son `(importe, moneda, tipo)` ya con el signo del dinero que entra
    en la cartera: positivo al comprar (sale del bolsillo), negativo al cobrar.
    `partes` es None si la operación no se puede leer. La comisión se cuenta
    según la convención de cada fuente, para no contarla dos veces:

      * Filas de la ficha: el capital invertido bruto ya incluye la comisión (con
        100 € y 2 € de comisión, la inversión neta es 98), así que el dinero que
        sale es el propio capital, o precio por participaciones si no hay capital.
      * Operaciones: la comisión en euros va aparte del precio de la orden (el
        coste del lote es precio por cantidad más comisión); al vender, el cobro
        es precio por cantidad menos comisión.
      * Ventas: el valor de venta es el precio bruto y la comisión se resta.
    """
    for fila in conn.execute(
        "SELECT asset_id, tipo_operacion, participaciones, precio_participacion, "
        "capital_invertido_bruto, currency, fx_rate FROM activo_rows"
    ):
        tipoFila = str(fila["tipo_operacion"] or "").strip().lower()
        if "convertidos" in tipoFila:
            continue  # conversión entre criptos: no mueve dinero fiat
        cantidad = _importe(fila["participaciones"])
        precio = _importe(fila["precio_participacion"])
        bruto = _importe(fila["capital_invertido_bruto"])
        if None in (cantidad, precio, bruto):
            yield None, f"{fila['asset_id']}|ficha|{fila['tipo_operacion']}|{fila['participaciones']}"
            continue
        importe = bruto if bruto > 0 else precio * cantidad
        yield [((-1 if tipoFila == "venta" else 1) * importe, fila["currency"], fila["fx_rate"])], ""

    for fila in conn.execute(
        "SELECT asset_id, orden, cantidad, precio_orden, precio_currency, total, comisiones_fiat, currency, fx_rate "
        "FROM activo_operation_rows WHERE estado = 'Completado'"
    ):
        cantidad = _importe(fila["cantidad"])
        precio = _importe(fila["precio_orden"])
        total = _importe(fila["total"])
        comision = _importe(fila["comisiones_fiat"])
        descripcion = f"{fila['asset_id']}|op|{fila['orden']}|{fila['cantidad']}"
        if None in (cantidad, precio, total, comision):
            yield None, descripcion
            continue
        esVenta = str(fila["orden"] or "").strip().lower() == "venta"
        divisaPrecio = str(fila["precio_currency"] or fila["currency"] or "EUR").strip().upper()
        divisaTotal = str(fila["currency"] or "EUR").strip().upper()
        if precio > 0 and divisaPrecio != divisaTotal and divisaPrecio != "EUR":
            yield None, descripcion  # el precio está en una divisa de la que no hay tipo
            continue
        if precio > 0:
            base = (precio * cantidad, divisaPrecio, "" if divisaPrecio == "EUR" else fila["fx_rate"])
        else:
            base = (total, divisaTotal, fila["fx_rate"])
        signo = -1 if esVenta else 1
        # La comisión de una operación spot va siempre en euros: encarece la compra
        # y, al vender, resta del cobro (en los dos casos suma al flujo).
        yield [(signo * base[0], base[1], base[2]), (comision, "EUR", "")], ""

    for fila in conn.execute(
        "SELECT id, year, asset_id, cantidad, valor_venta, comision_venta, currency, fx_rate FROM ventas"
    ):
        cantidad = _importe(fila["cantidad"])
        precio = _importe(fila["valor_venta"])
        comision = _importe(fila["comision_venta"])
        if None in (cantidad, precio, comision):
            yield None, f"{fila['asset_id']}|venta|{fila['year']}|{fila['cantidad']}"
            continue
        yield [(-cantidad * precio, fila["currency"], fila["fx_rate"]),
               (comision, fila["currency"], fila["fx_rate"])], ""


def totalDeCaja(conn):
    """`(total en euros, firma)` de todo el dinero que han movido las operaciones.

    La firma identifica el conjunto de operaciones que no se han podido convertir:
    vacía si no hay ninguna.
    """
    total = CERO
    pendientes = []
    for partes, descripcion in _movimientos(conn):
        if partes is None:
            pendientes.append(descripcion)
            continue
        subtotal = CERO
        for importe, moneda, tipo in partes:
            factor = _factor(moneda, tipo)
            if factor is None:
                subtotal = None
                break
            subtotal += importe * factor
        if subtotal is None:
            pendientes.append(descripcion or "|".join(f"{m}|{t}|{i}" for i, m, t in partes))
            continue
        total += subtotal
    firma = hashlib.sha256("\n".join(sorted(pendientes)).encode("utf-8")).hexdigest()[:16] if pendientes else ""
    return total, firma


def tomarFlujo(conn):
    """Flujo en euros desde el snapshot anterior, o None si no es fiable. Guarda la base nueva.

    Va dentro de la misma transacción que inserta el snapshot: si el INSERT se
    revierte, la base también.
    """
    try:
        total, firma = totalDeCaja(conn)
    except Exception as error:  # el snapshot no puede perderse por esto
        log.warning("[flujos] No se pudo calcular el flujo: %s", error)
        return None

    anterior = conn.execute("SELECT total, firma FROM snapshot_flujo_base WHERE id = 1").fetchone()
    conn.execute(
        "INSERT INTO snapshot_flujo_base (id, total, firma) VALUES (1, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET total = excluded.total, firma = excluded.firma",
        (float(total), firma),
    )
    if anterior is None or anterior["firma"] != firma:
        return None
    return round(float(total) - float(anterior["total"]), 6)
