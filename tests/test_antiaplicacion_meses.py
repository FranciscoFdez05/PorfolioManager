"""La regla de los dos meses se mide en meses naturales, no en 60 días."""

from datetime import date
from decimal import Decimal

import pytest

from core import fifo, fiscal_es
from core.fiscal_es import sumarMeses


@pytest.mark.parametrize("origen, meses, esperado", [
    (date(2025, 12, 31), 2, date(2026, 2, 28)),
    (date(2023, 12, 31), 2, date(2024, 2, 29)),
    (date(2026, 3, 31), -1, date(2026, 2, 28)),
    (date(2026, 1, 15), -2, date(2025, 11, 15)),
    (date(2026, 10, 20), 12, date(2027, 10, 20)),
    (date(2024, 2, 29), 12, date(2025, 2, 28)),
])
def testSumarMesesRecortaAlUltimoDiaDelMes(origen, meses, esperado):
    assert sumarMeses(origen, meses) == esperado


def _operaciones(fechaRecompra):
    d = Decimal
    return [
        fifo.Operacion("c1", "a", date(2025, 1, 10), fifo.ADQUISICION, d(10), d(1000), d(0), 1),
        fifo.Operacion("v1", "a", date(2025, 12, 31), fifo.TRANSMISION, d(10), d(500), d(0), 2),
        fifo.Operacion("c2", "a", fechaRecompra, fifo.ADQUISICION, d(10), d(500), d(0), 3),
    ]


def testRecompraEnElUltimoDiaDeLosDosMesesBloquea():
    resultados, _ = fiscal_es.calcularConNormativa(_operaciones(date(2026, 2, 28)), "acciones")

    assert resultados[0].perdidaNoComputable > 0


def testRecompraAlDia60PeroFueraDeLosDosMesesNoBloquea():
    # 1 de marzo: 60 días después del 31 de diciembre, pero ya más de dos meses.
    resultados, _ = fiscal_es.calcularConNormativa(_operaciones(date(2026, 3, 1)), "acciones")

    assert resultados[0].perdidaNoComputable == 0


def testCriptoUsaUnAnioNatural():
    resultados, _ = fiscal_es.calcularConNormativa(_operaciones(date(2026, 12, 31)), "cripto")

    assert resultados[0].perdidaNoComputable > 0
