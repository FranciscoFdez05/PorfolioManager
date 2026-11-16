"""Pruebas del cuadro de amortización (core/amortizacion.py).

Las cifras de referencia salen de la fórmula del sistema francés calculada a
mano: 200.000 EUR al 3 % a 30 años dan 843,21 EUR de cuota.
"""

from datetime import date
from decimal import Decimal

import pytest

from core.amortizacion import (
    Amortizacion,
    AmortizacionInvalida,
    calcularCuota,
    generarCuadro,
    resumir,
    sumarMeses,
)

D = Decimal


def _fijo(tipo):
    return lambda _fecha: D(tipo)


def testCuotaFrancesaConocida():
    assert round(calcularCuota(D(200000), D(3), 360), 2) == D("843.21")


def testCuotaATipoCeroEsRepartoLineal():
    assert calcularCuota(D(1200), D(0), 12) == D(100)


def testPlazoNoPositivoSeRechaza():
    with pytest.raises(AmortizacionInvalida):
        calcularCuota(D(1000), D(3), 0)


def testSumarMesesRecortaAFinDeMesYRecuperaElDia():
    assert sumarMeses(date(2024, 1, 31), 1) == date(2024, 2, 29)
    assert sumarMeses(date(2024, 1, 31), 2) == date(2024, 3, 31)
    assert sumarMeses(date(2024, 11, 15), 3) == date(2025, 2, 15)


def testCuadroFijoLiquidaElCapitalExacto():
    cuadro = generarCuadro(D(200000), 360, date(2024, 1, 1), _fijo(3))
    assert len(cuadro) == 360
    assert cuadro[0].cuota == D("843.21")
    assert cuadro[-1].pendiente == D(0)
    assert sum(r.capital for r in cuadro) == D(200000)


def testPrimerReciboVenceUnMesDespues():
    cuadro = generarCuadro(D(1000), 10, date(2024, 1, 15), _fijo(0))
    assert cuadro[0].fecha == date(2024, 2, 15)
    assert all(r.cuota == D(100) for r in cuadro)


def testTipoCeroNoCobraIntereses():
    cuadro = generarCuadro(D(1200), 12, date(2024, 1, 1), _fijo(0))
    assert sum(r.interes for r in cuadro) == D(0)


def testVariableRecalculaLaCuotaEnCadaRevision():
    def tipo(fecha):
        return D(2) if fecha < date(2025, 1, 1) else D(4)

    cuadro = generarCuadro(D(100000), 120, date(2024, 1, 1), tipo, revisionMeses=12)
    assert cuadro[0].tipo == D(2)
    assert cuadro[11].tipo == D(2)
    assert cuadro[12].tipo == D(4)
    assert cuadro[12].cuota > cuadro[11].cuota
    assert cuadro[-1].pendiente == D(0)
    assert len(cuadro) == 120


def testVariableSemestralRevisaCadaSeisMeses():
    def tipo(fecha):
        return D(1) if fecha < date(2024, 7, 1) else D(3)

    cuadro = generarCuadro(D(50000), 60, date(2024, 1, 1), tipo, revisionMeses=6)
    assert cuadro[5].tipo == D(1)
    assert cuadro[6].tipo == D(3)


def testAmortizarReduciendoPlazoAcortaElCuadroYMantieneLaCuota():
    base = generarCuadro(D(100000), 240, date(2024, 1, 1), _fijo(3))
    extra = generarCuadro(
        D(100000), 240, date(2024, 1, 1), _fijo(3),
        amortizaciones=[Amortizacion(date(2025, 1, 1), D(20000), "plazo")],
    )
    assert len(extra) < len(base)
    assert extra[-1].cuota <= extra[0].cuota
    assert sum(r.interes for r in extra) < sum(r.interes for r in base)


def testAmortizarReduciendoCuotaMantieneElPlazo():
    base = generarCuadro(D(100000), 240, date(2024, 1, 1), _fijo(3))
    extra = generarCuadro(
        D(100000), 240, date(2024, 1, 1), _fijo(3),
        amortizaciones=[Amortizacion(date(2025, 1, 1), D(20000), "cuota")],
    )
    assert len(extra) == len(base)
    assert extra[-1].cuota < base[-1].cuota or extra[20].cuota < base[20].cuota


def testAmortizacionTotalLiquidaElPrestamo():
    cuadro = generarCuadro(
        D(10000), 60, date(2024, 1, 1), _fijo(3),
        amortizaciones=[Amortizacion(date(2024, 6, 1), D(999999), "plazo")],
    )
    assert cuadro[-1].pendiente == D(0)
    assert len(cuadro) <= 6


def testCapitalOPlazoInvalidosSeRechazan():
    with pytest.raises(AmortizacionInvalida):
        generarCuadro(D(0), 12, date(2024, 1, 1), _fijo(3))
    with pytest.raises(AmortizacionInvalida):
        generarCuadro(D(1000), 0, date(2024, 1, 1), _fijo(3))


def testResumenARepartoDeFechas():
    cuadro = generarCuadro(D(12000), 12, date(2024, 1, 1), _fijo(0))
    resumen = resumir(cuadro, D(12000), date(2024, 6, 1))
    assert resumen["cuotasPagadas"] == 5
    assert resumen["cuotasRestantes"] == 7
    assert resumen["capitalPendiente"] == D(7000)
    assert resumen["porcentajeAmortizado"].quantize(D("0.01")) == D("41.67")
    assert resumen["fechaFin"] == date(2025, 1, 1)
    assert resumen["liquidado"] is False


def testResumenAntesDelPrimerReciboNoHaPagadoNada():
    cuadro = generarCuadro(D(1000), 10, date(2024, 1, 1), _fijo(0))
    resumen = resumir(cuadro, D(1000), date(2023, 12, 1))
    assert resumen["cuotasPagadas"] == 0
    assert resumen["capitalPendiente"] == D(1000)


def testResumenDeUnPrestamoLiquidado():
    cuadro = generarCuadro(D(1000), 10, date(2024, 1, 1), _fijo(0))
    resumen = resumir(cuadro, D(1000), date(2030, 1, 1))
    assert resumen["liquidado"] is True
    assert resumen["capitalPendiente"] == D(0)
    assert resumen["proximaFecha"] is None


def testAhorroDeInteresesPorAmortizar():
    base = generarCuadro(D(100000), 240, date(2024, 1, 1), _fijo(3))
    extra = generarCuadro(
        D(100000), 240, date(2024, 1, 1), _fijo(3),
        amortizaciones=[Amortizacion(date(2025, 1, 1), D(20000), "plazo")],
    )
    resumen = resumir(extra, D(100000), date(2024, 6, 1), base)
    assert resumen["ahorroIntereses"] > 0
