"""Pruebas de core.microcreditos: validación y cálculo, sin base de datos."""

from datetime import date
from decimal import Decimal

import pytest

from core.errors import ValidationError
from core.microcreditos import calcularMicrocredito, sanearMicrocredito, taeDePagoUnico

hoy = date(2026, 6, 15)


def _unico(**cambios):
    datos = {"nombre": "Prestamo rapido", "modo": "unico", "importe": "300", "comision": "45",
             "fechaInicio": "2026-06-01", "fechaVencimiento": "2026-07-01"}
    datos.update(cambios)
    return sanearMicrocredito(datos)


def _cuotas(**cambios):
    datos = {"nombre": "Credito personal", "modo": "cuotas", "importe": "600", "cuotas": 6,
             "tin": "0", "fechaInicio": "2026-01-15"}
    datos.update(cambios)
    return sanearMicrocredito(datos)


def testPagoUnicoActivoCalculaCosteYDiasRestantes():
    resumen = calcularMicrocredito(_unico(), hoy)["resumen"]
    assert resumen["estado"] == "activo"
    assert resumen["totalAPagar"] == 345.0
    assert resumen["coste"] == 45.0
    assert resumen["pendiente"] == 345.0
    assert resumen["plazoDias"] == 30
    assert resumen["diasRestantes"] == 16
    assert 40 < resumen["progreso"] < 60


def testPagoUnicoVencidoSiPasaLaFechaSinDevolver():
    resumen = calcularMicrocredito(_unico(fechaVencimiento="2026-06-10"), hoy)["resumen"]
    assert resumen["estado"] == "vencido"
    assert resumen["diasRestantes"] == -5
    assert resumen["pendiente"] == 345.0


def testPagoUnicoDevueltoNoDebeNada():
    resumen = calcularMicrocredito(_unico(devuelto=True, fechaVencimiento="2026-06-10"), hoy)["resumen"]
    assert resumen["estado"] == "devuelto"
    assert resumen["liquidado"] is True
    assert resumen["pendiente"] == 0
    assert resumen["pagado"] == 345.0
    assert resumen["progreso"] == 100


def testVencerElMismoDiaTodaviaEsActivo():
    resumen = calcularMicrocredito(_unico(fechaVencimiento="2026-06-15"), hoy)["resumen"]
    assert resumen["estado"] == "activo"
    assert resumen["diasRestantes"] == 0


def testTaeDePagoUnicoCortoEsMuyAlta():
    assert round(taeDePagoUnico(Decimal(300), Decimal(45), 30), 2) == 447.63


def testTaeSinComisionEsCero():
    assert taeDePagoUnico(Decimal(300), Decimal(0), 30) == 0


def testTaeConPlazoCeroUsaUnDia():
    assert taeDePagoUnico(Decimal(100), Decimal(1), 0) is not None


def testTaeDesbordadaDevuelveNone():
    assert taeDePagoUnico(Decimal("0.01"), Decimal(1000000), 1) is None


def testCuotasSinInteresesReparteElImporte():
    calculo = calcularMicrocredito(_cuotas(), hoy)
    resumen = calculo["resumen"]
    assert resumen["cuotaMensual"] == 100.0
    assert resumen["coste"] == 0
    assert resumen["totalAPagar"] == 600.0
    assert resumen["totalCuotas"] == 6
    assert resumen["tae"] == 0
    assert len(calculo["cuadro"]) == 6


def testCuotasConInteresesSuperanElImporte():
    resumen = calcularMicrocredito(_cuotas(tin="24", fechaInicio="2026-06-01"), hoy)["resumen"]
    assert resumen["coste"] > 0
    assert resumen["totalAPagar"] > 600
    assert resumen["cuotasPagadas"] == 0
    assert resumen["estado"] == "activo"
    assert resumen["tae"] > 24


def testCuotasLiquidadasPasanADevuelto():
    resumen = calcularMicrocredito(_cuotas(fechaInicio="2020-01-01"), hoy)["resumen"]
    assert resumen["estado"] == "devuelto"
    assert resumen["pendiente"] == 0
    assert resumen["diasRestantes"] == 0


def testCambiarDeModoDescartaLosCamposDelOtro():
    saneado = _cuotas(comision="99", fechaVencimiento="2026-12-01", devuelto=True)
    assert saneado["comision"] == "0"
    assert saneado["fechaVencimiento"] == ""
    assert saneado["devuelto"] is False
    saneado = _unico(cuotas=12, tin="30")
    assert saneado["cuotas"] == 0
    assert saneado["tin"] == "0"


@pytest.mark.parametrize("cambios", [
    {"nombre": ""},
    {"importe": "0"},
    {"importe": "-5"},
    {"importe": "abc"},
    {"comision": "-1"},
    {"fechaInicio": "2026-13-40"},
    {"fechaVencimiento": ""},
    {"fechaVencimiento": "2026-05-01"},
    {"devuelto": True, "fechaDevolucion": "2026-05-01"},
])
def testPagoUnicoRechazaDatosInvalidos(cambios):
    with pytest.raises(ValidationError):
        _unico(**cambios)


@pytest.mark.parametrize("cambios", [
    {"cuotas": 0},
    {"cuotas": 61},
    {"cuotas": None},
    {"tin": "-1"},
    {"tin": "1001"},
])
def testCuotasRechazaDatosInvalidos(cambios):
    with pytest.raises(ValidationError):
        _cuotas(**cambios)


def testModoDesconocidoCaeEnPagoUnico():
    assert _unico(modo="otro")["modo"] == "unico"
