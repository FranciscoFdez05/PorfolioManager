"""Patrimonio neto: lo que se tiene menos lo que se debe.

Lógica pura. Quien la llama (`stores.patrimonio_store`) reúne las partidas desde
la base de datos y las entrega ya en euros; aquí solo se agrupan y se suman, de
modo que el criterio de qué entra en cada lado se puede probar sin datos reales.

Una cuenta con saldo negativo (descubierto) entra en los activos restando: el
neto es el mismo que si fuera una deuda y no hace falta duplicar la regla.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from decimal import Decimal

from core import dinero

GRUPOS_ACTIVO = ("inversiones", "cuentas", "rentaFija")
GRUPOS_PASIVO = ("hipotecas", "financiaciones", "microcreditos")

_CERO = Decimal(0)


@dataclass(frozen=True)
class Partida:
    """Un elemento del patrimonio.

    Attributes:
        grupo: Uno de `GRUPOS_ACTIVO` o `GRUPOS_PASIVO`.
        nombre: Etiqueta para el desglose.
        importe: Valor en euros; en los pasivos, la deuda pendiente en positivo.
    """

    grupo: str
    nombre: str
    importe: Decimal


def _suma(partidas: Iterable[Partida]) -> Decimal:
    return sum((p.importe for p in partidas), _CERO)


def _euros(valor: Decimal) -> float:
    return float(dinero.redondear(valor, 2))


def _lado(partidas: list[Partida], grupos: tuple[str, ...]) -> dict:
    return {
        "total": _euros(_suma(partidas)),
        "grupos": [
            {
                "grupo": grupo,
                "total": _euros(_suma(p for p in partidas if p.grupo == grupo)),
                "partidas": [{"nombre": p.nombre, "importe": _euros(p.importe)}
                             for p in partidas if p.grupo == grupo],
            }
            for grupo in grupos
        ],
    }


def componerPatrimonio(activos: Iterable[Partida], pasivos: Iterable[Partida]) -> dict:
    """Suma activos y pasivos y calcula el patrimonio neto.

    Args:
        activos: Partidas con grupo en `GRUPOS_ACTIVO`.
        pasivos: Partidas con grupo en `GRUPOS_PASIVO`.

    Returns:
        `{"activos": {...}, "pasivos": {...}, "neto": float}`; cada lado trae su
        `total` y un desglose por grupo con sus partidas.

    Raises:
        ValueError: si una partida trae un grupo que no corresponde a su lado.
            Un grupo mal puesto no debe desaparecer del total sin avisar.
    """
    activos = list(activos)
    pasivos = list(pasivos)
    for partida in activos:
        if partida.grupo not in GRUPOS_ACTIVO:
            raise ValueError(f"Grupo de activo desconocido: {partida.grupo}")
    for partida in pasivos:
        if partida.grupo not in GRUPOS_PASIVO:
            raise ValueError(f"Grupo de pasivo desconocido: {partida.grupo}")

    return {
        "activos": _lado(activos, GRUPOS_ACTIVO),
        "pasivos": _lado(pasivos, GRUPOS_PASIVO),
        "neto": _euros(_suma(activos) - _suma(pasivos)),
    }
