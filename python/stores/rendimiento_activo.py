"""Totales de un activo: participaciones vivas, invertido neto y rendimiento.

Había dos copias de este cálculo. `listAssets` (la lista de la barra lateral y
del resumen) sumaba en `float` con un lector de importes; la ruta
`/api/activos/rendimiento-batch` (la tabla principal) sumaba en `Decimal` con
otro. La fórmula era la misma, pero cada arreglo había que hacerlo dos veces, y
en coma flotante el error de cada suma se arrastra hasta el total que se enseña:
la barra lateral y la tabla podían diferir en un céntimo para el mismo activo.

Aquí queda una sola versión, en `Decimal` y con el lector de `core.dinero`. Los
importes están en la divisa del activo; el desglose entre efecto activo y efecto
divisa (con el tipo de cambio de cada compra) lo añade la ruta batch encima de
estos totales.
"""

from dataclasses import dataclass
from decimal import Decimal

from core import dinero

CERO = Decimal("0")


def numero(valor) -> Decimal:
    """Importe de una columna TEXT; vacío o ilegible cuenta como cero."""
    return dinero.aDecimalONulo(valor) or CERO


@dataclass(frozen=True)
class Totales:
    participaciones: Decimal
    invertidoBruto: Decimal
    invertidoNeto: Decimal
    netoActual: Decimal
    rendimiento: Decimal
    rendimientoPct: Decimal

    def paraJson(self) -> dict:
        """Las cifras que enseña la interfaz, redondeadas una sola vez al final."""
        return {
            "rendimiento": float(dinero.redondear(self.rendimiento)),
            "invertidoNeto": float(dinero.redondear(self.invertidoNeto)),
            "rendimientoPct": float(dinero.redondear(self.rendimientoPct)),
            "netoActual": float(dinero.redondear(self.netoActual)),
        }


def calcular(filas, operaciones, esCripto: bool, precio) -> Totales:
    """Totales a partir de las filas del activo y sus operaciones completadas.

    `filas` son filas de `activo_rows` (tipo_operacion, participaciones,
    capital_invertido_bruto, comisiones, comisiones_fiat) y `operaciones` de
    `activo_operation_rows` en estado Completado (orden, cantidad,
    comisiones_cripto, total). Sirven `sqlite3.Row` o diccionarios.
    """
    participaciones = CERO
    invertidoBruto = CERO
    comisiones = CERO

    for fila in filas:
        if str(fila["tipo_operacion"] or "").strip().lower() == "venta":
            participaciones -= numero(fila["participaciones"])
        else:
            participaciones += numero(fila["participaciones"])
            invertidoBruto += numero(fila["capital_invertido_bruto"])
            # En cripto la comisión que resta del invertido es la de fiat; la de
            # cripto ya se descontó de las participaciones recibidas.
            comisiones += numero(fila["comisiones_fiat"] if esCripto else fila["comisiones"])

    for op in operaciones:
        cantidad = numero(op["cantidad"])
        comisionCripto = numero(op["comisiones_cripto"])
        if str(op["orden"] or "").strip().lower() == "venta":
            participaciones -= cantidad + comisionCripto
        else:
            participaciones += max(CERO, cantidad - comisionCripto)
            invertidoBruto += numero(op["total"])

    invertidoNeto = max(CERO, invertidoBruto - comisiones)
    netoActual = max(CERO, participaciones) * numero(precio)
    rendimiento = netoActual - invertidoNeto
    rendimientoPct = rendimiento / invertidoNeto * 100 if invertidoNeto > 0 else CERO

    return Totales(participaciones, invertidoBruto, invertidoNeto, netoActual, rendimiento, rendimientoPct)
