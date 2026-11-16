"""Ingresos pasivos: el cálculo puro (core.ingresos_pasivos) y /api/dividendos/resumen."""

from datetime import date
from decimal import Decimal

import pytest

from core.ingresos_pasivos import Cobro, PosicionActivo, leerFecha, resumirIngresosPasivos

HOY = date(2026, 6, 15)


def _cobro(fecha, instrumento, importe):
    return Cobro(fecha, instrumento, Decimal(importe))


@pytest.mark.parametrize("texto, esperado", [
    ("05-03-2026", date(2026, 3, 5)),
    ("2026-03-05", date(2026, 3, 5)),
    ("05/03/2026", date(2026, 3, 5)),
    ("05.03.2026", date(2026, 3, 5)),
    ("31-02-2026", None),
    ("03-2026", None),
    ("", None),
    (None, None),
    ("ab-cd-efgh", None),
])
def testLeerFecha(texto, esperado):
    assert leerFecha(texto) == esperado


def testSinCobrosTodoEsCeroYElYieldNoSeInventa():
    resumen = resumirIngresosPasivos([], {}, HOY)
    assert resumen["ultimos12Meses"] == 0
    assert resumen["yieldOnCostGlobal"] is None
    assert len(resumen["porMes"]) == 12
    assert all(m["importe"] == 0 for m in resumen["porMes"])


def testLaVentanaSonLosDoceMesesQueAcabanEnElActual():
    resumen = resumirIngresosPasivos([], {}, HOY)
    assert resumen["porMes"][0]["mes"] == "2025-07"
    assert resumen["porMes"][-1]["mes"] == "2026-06"


def testSumaDoceMesesYExcluyeLoAnteriorYLoFuturo():
    cobros = [
        _cobro(date(2026, 6, 1), "A", "100"),
        _cobro(date(2025, 7, 1), "A", "50"),
        _cobro(date(2025, 6, 30), "A", "999"),
        _cobro(date(2026, 6, 20), "A", "777"),
    ]
    resumen = resumirIngresosPasivos(cobros, {}, HOY)
    assert resumen["ultimos12Meses"] == 150
    assert resumen["mediaMensual"] == 12.5
    assert resumen["proyeccion12Meses"] == 150


def testTotalesPorAnioNaturalYSinFechaAparte():
    cobros = [
        _cobro(date(2026, 1, 10), "A", "30"),
        _cobro(date(2025, 12, 31), "A", "20"),
        _cobro(date(2024, 5, 5), "A", "10"),
        _cobro(None, "A", "5"),
    ]
    resumen = resumirIngresosPasivos(cobros, {}, HOY)
    assert resumen["anioActual"] == 30
    assert resumen["anioAnterior"] == 20
    assert resumen["sinFecha"] == 1
    assert resumen["ultimos12Meses"] == 50


def testYieldOnCostPorActivoYGlobal():
    cobros = [_cobro(date(2026, 3, 1), "Con coste", "40"), _cobro(date(2026, 4, 1), "Vendido", "60")]
    posiciones = {"Con coste": PosicionActivo(Decimal("1000"), Decimal("2000"))}
    resumen = resumirIngresosPasivos(cobros, posiciones, HOY)

    porNombre = {f["instrumento"]: f for f in resumen["porActivo"]}
    assert porNombre["Con coste"]["yieldOnCost"] == 4.0
    assert porNombre["Con coste"]["yieldSobreValor"] == 2.0
    assert porNombre["Vendido"]["yieldOnCost"] is None
    assert porNombre["Vendido"]["coste"] is None
    # El global solo mide lo que tiene coste: no diluye con el dividendo huérfano.
    assert resumen["yieldOnCostGlobal"] == 4.0
    assert resumen["ultimos12Meses"] == 100


def testElCosteDeUnActivoNoSeCuentaDosVecesAlGlobal():
    cobros = [_cobro(date(2026, 1, 1), "A", "10"), _cobro(date(2026, 2, 1), "A", "10")]
    resumen = resumirIngresosPasivos(cobros, {"A": PosicionActivo(Decimal("1000"), Decimal("1000"))}, HOY)
    assert resumen["yieldOnCostGlobal"] == 2.0


def testCosteCeroNoDividePorCero():
    cobros = [_cobro(date(2026, 1, 1), "A", "10")]
    resumen = resumirIngresosPasivos(cobros, {"A": PosicionActivo(Decimal(0), Decimal(0))}, HOY)
    assert resumen["porActivo"][0]["yieldOnCost"] is None
    assert resumen["yieldOnCostGlobal"] is None


def testLosActivosSalenOrdenadosPorLoCobrado():
    cobros = [_cobro(date(2026, 1, 1), "Poco", "1"), _cobro(date(2026, 1, 2), "Mucho", "9")]
    assert [f["instrumento"] for f in resumirIngresosPasivos(cobros, {}, HOY)["porActivo"]] == ["Mucho", "Poco"]


def testCambioDeAnioEnEnero():
    resumen = resumirIngresosPasivos([_cobro(date(2025, 2, 1), "A", "10")], {}, date(2026, 1, 15))
    assert resumen["porMes"][0]["mes"] == "2025-02"
    assert resumen["ultimos12Meses"] == 10


@pytest.fixture
def cliente(clienteAutenticado, tempDb):
    from routes.ingresos_pasivos import ingresosPasivosBp

    client, _cabeceras, _app = clienteAutenticado(ingresosPasivosBp)
    return client


def _fila(**cambios):
    base = {"fecha": "", "instrumento": "", "acciones": "", "dividendoAccion": "", "impuestos": "",
            "total": "", "monedaDividendo": "EUR", "monedaTotal": "EUR", "cuenta": ""}
    base.update(cambios)
    return base


def testRutaSinDividendos(cliente):
    datos = cliente.get("/api/dividendos/resumen").get_json()
    assert datos["ultimos12Meses"] == 0
    assert datos["porActivo"] == []


def testRutaIgnoraFilasSinTotalLegible(cliente):
    from stores.app_data import writeDividendosFile

    hoy = date.today()
    fecha = f"{hoy.day:02d}-{hoy.month:02d}-{hoy.year}"
    writeDividendosFile({"rows": [
        _fila(fecha=fecha, instrumento="Bueno", total="12,50"),
        _fila(fecha=fecha, instrumento="Vacio", total=""),
        _fila(fecha=fecha, instrumento="Roto", total="12abc"),
    ]})
    datos = cliente.get("/api/dividendos/resumen").get_json()
    assert [f["instrumento"] for f in datos["porActivo"]] == ["Bueno"]
    assert datos["ultimos12Meses"] == 12.5
