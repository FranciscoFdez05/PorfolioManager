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
    invertido_bruto: Decimal
    invertido_neto: Decimal
    neto_actual: Decimal
    rendimiento: Decimal
    rendimiento_pct: Decimal

    def para_json(self) -> dict:
        """Las cifras que enseña la interfaz, redondeadas una sola vez al final."""
        return {
            "rendimiento": float(dinero.redondear(self.rendimiento)),
            "invertidoNeto": float(dinero.redondear(self.invertido_neto)),
            "rendimientoPct": float(dinero.redondear(self.rendimiento_pct)),
            "netoActual": float(dinero.redondear(self.neto_actual)),
        }


def calcular(filas, operaciones, es_cripto: bool, precio) -> Totales:
    """Totales a partir de las filas del activo y sus operaciones completadas.

    `filas` son filas de `activo_rows` (tipo_operacion, participaciones,
    capital_invertido_bruto, comisiones, comisiones_fiat) y `operaciones` de
    `activo_operation_rows` en estado Completado (orden, cantidad,
    comisiones_cripto, total). Sirven `sqlite3.Row` o diccionarios.
    """
    participaciones = CERO
    invertido_bruto = CERO
    comisiones = CERO

    for fila in filas:
        if str(fila["tipo_operacion"] or "").strip().lower() == "venta":
            participaciones -= numero(fila["participaciones"])
        else:
            participaciones += numero(fila["participaciones"])
            invertido_bruto += numero(fila["capital_invertido_bruto"])
            # En cripto la comisión que resta del invertido es la de fiat; la de
            # cripto ya se descontó de las participaciones recibidas.
            comisiones += numero(fila["comisiones_fiat"] if es_cripto else fila["comisiones"])

    for op in operaciones:
        cantidad = numero(op["cantidad"])
        comision_cripto = numero(op["comisiones_cripto"])
        if str(op["orden"] or "").strip().lower() == "venta":
            participaciones -= cantidad + comision_cripto
        else:
            participaciones += max(CERO, cantidad - comision_cripto)
            invertido_bruto += numero(op["total"])

    invertido_neto = max(CERO, invertido_bruto - comisiones)
    neto_actual = max(CERO, participaciones) * numero(precio)
    rendimiento = neto_actual - invertido_neto
    rendimiento_pct = rendimiento / invertido_neto * 100 if invertido_neto > 0 else CERO

    return Totales(participaciones, invertido_bruto, invertido_neto, neto_actual, rendimiento, rendimiento_pct)
