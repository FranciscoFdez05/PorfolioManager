"""Herramientas fiscales: compensación de pérdidas y previsión del IRPF del ahorro.

Lo que se fija aquí:

  * La integración de la base del ahorro (art. 49 LIRPF): el cruce del 25 %
    entre rendimientos y ganancias, y el orden en que se aplican los saldos
    negativos de ejercicios anteriores.
  * Que la compensación mide el ahorro con el mismo motor que la pantalla de
    Ventas (cuota con y sin la venta) y que no guarda nada.
  * Que la previsión suma dividendos brutos, intereses y ventas del ejercicio
    pedido, y solo de ese.
"""

from datetime import date
from decimal import Decimal

import pytest

from core.fiscal_es import integrarBaseAhorro
from routes.herramientas import herramientasBp
from stores import herramientas_fiscal, ventas_fifo
from stores.app_data import writeDividendosFile, writeInteresesFile
from stores.asset_store import writeAssetFile
from stores.ventas_store import (
    readVentasYear,
    sanitizeVentasPayload,
    validarParaGuardar,
    writeVentasYear,
)

FECHA = date(2026, 9, 1)


def crearActivo(assetId, tipo="accion", filas=(), precio="0,00"):
    writeAssetFile(assetId, {
        "name": assetId.upper(),
        "symbol": assetId.upper(),
        "type": tipo,
        "price": precio,
        "rows": list(filas),
    })


def compra(fecha, participaciones, precio):
    return {
        "fechaOperacion": fecha,
        "tipoOperacion": "Compra",
        "participaciones": participaciones,
        "precioParticipacion": precio,
        "comisiones": "0",
    }


def guardarVenta(year, ventaId, fecha, assetId, cantidad, valor):
    filas = [{
        "id": ventaId, "fecha": fecha, "assetId": assetId,
        "cantidad": cantidad, "valorVenta": valor, "comisionVenta": "",
    }]
    payload, error = sanitizeVentasPayload({"year": year, "rows": filas}, year)
    assert error is None, error
    validarParaGuardar(payload)
    writeVentasYear(year, payload)
    return readVentasYear(year)


def dividendo(fecha, total, impuestos, moneda="EUR"):
    return {
        "fecha": fecha, "instrumento": "ACME", "acciones": "", "dividendoAccion": "",
        "impuestos": impuestos, "total": total, "monedaDividendo": moneda, "monedaTotal": moneda,
    }


# ── Integración de la base del ahorro (función pura) ─────────────────────────

def testSinSaldosNegativosNoHayCruce():
    r = integrarBaseAhorro(Decimal("1000"), Decimal("500"), [], 2026)

    assert r.cruzadoGypContraRcm == 0
    assert r.cruzadoRcmContraGyp == 0
    assert r.base == Decimal("1500")
    assert r.cuota == Decimal("285.00")


def testLaPerdidaPatrimonialCompensaComoMuchoEl25PorCientoDeLosRendimientos():
    r = integrarBaseAhorro(Decimal("1000"), Decimal("-600"), [], 2026)

    assert r.cruzadoGypContraRcm == Decimal("250")
    assert r.baseRcm == Decimal("750")
    assert r.base == Decimal("750")
    # Lo que no cabe en el 25 % pasa a los cuatro ejercicios siguientes.
    assert r.perdidaArrastrable == Decimal("350")


def testUnaPerdidaPequenaSeAbsorbeEntera():
    r = integrarBaseAhorro(Decimal("1000"), Decimal("-100"), [], 2026)

    assert r.cruzadoGypContraRcm == Decimal("100")
    assert r.base == Decimal("900")
    assert r.perdidaArrastrable == 0


def testElRendimientoNegativoCompensaConEl25PorCientoDeLasGanancias():
    r = integrarBaseAhorro(Decimal("-400"), Decimal("1000"), [], 2026)

    assert r.cruzadoRcmContraGyp == Decimal("250")
    assert r.base == Decimal("750")
    assert r.rcmNegativoArrastrable == Decimal("150")


def testLosArrastresVanPrimeroContraGananciasYLuegoContraRendimientos():
    r = integrarBaseAhorro(
        Decimal("1000"), Decimal("200"), [{"anio_origen": 2024, "importe": Decimal("500")}], 2026,
    )

    assert r.arrastresAplicadosGyp == Decimal("200")
    # Quedan 300, pero contra rendimientos solo cabe el 25 % de 1.000.
    assert r.arrastresAplicadosRcm == Decimal("250")
    assert r.base == Decimal("750")
    assert r.detalleArrastres[0]["restante"] == Decimal("50")


def testElCruceDelPropioAnioGastaElLimiteAntesQueLosArrastres():
    r = integrarBaseAhorro(
        Decimal("1000"), Decimal("-100"), [{"anio_origen": 2024, "importe": Decimal("500")}], 2026,
    )

    assert r.cruzadoGypContraRcm == Decimal("100")
    assert r.arrastresAplicadosRcm == Decimal("150")
    assert r.base == Decimal("750")


def testLosArrastresCaducadosOPosterioresNoSeAplican():
    r = integrarBaseAhorro(
        Decimal("1000"), Decimal("0"),
        [{"anio_origen": 2021, "importe": Decimal("500")}, {"anio_origen": 2026, "importe": Decimal("500")}],
        2026,
    )

    assert r.arrastresAplicadosRcm == 0
    assert r.base == Decimal("1000")


def testUsaLaEscalaDelEjercicio():
    r = integrarBaseAhorro(Decimal("0"), Decimal("10000"), [], 2026)

    # 6.000 al 19 % y 4.000 al 21 %.
    assert r.cuota == Decimal("1980.00")


# ── Compensación de pérdidas ─────────────────────────────────────────────────

def testLaPerdidaAhorraLaCuotaDeLaGananciaYaRealizada(tempDb):
    crearActivo("gana", filas=[compra("01-01-2023", "10", "100")], precio="300")
    guardarVenta("2026", "v1", "01-03-2026", "gana", "10", "300")   # +2.000 €
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")], precio="50")   # -500 €

    dato = herramientas_fiscal.compensacionDePerdidas(FECHA)

    assert dato["ejercicio"]["cuota"] == "380.00"
    [candidata] = dato["candidatas"]
    assert candidata["id"] == "acme"
    assert candidata["perdida"] == "500.00"
    assert candidata["ahorroCuota"] == "95.00"
    assert candidata["perdidaParaAnosSiguientes"] == "0.00"
    assert candidata["ventanaMeses"] == 2
    # La ventana incluye el 1-11; el primer día libre es el siguiente.
    assert candidata["recompraDesde"] == "02-11-2026"


def testSinGananciasLaPerdidaPasaAEjerciciosSiguientes(tempDb):
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")], precio="50")

    dato = herramientas_fiscal.compensacionDePerdidas(FECHA)

    [candidata] = dato["candidatas"]
    assert candidata["ahorroCuota"] == "0.00"
    assert candidata["perdidaParaAnosSiguientes"] == "500.00"


def testLasPosicionesEnGananciaNoSonCandidatas(tempDb):
    crearActivo("beta", filas=[compra("01-01-2023", "10", "10")], precio="20")

    dato = herramientas_fiscal.compensacionDePerdidas(FECHA)

    assert dato["candidatas"] == []
    assert dato["noEvaluables"] == []


def testSinCotizacionNoSeEvaluaYSeDice(tempDb):
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")], precio="0,00")

    dato = herramientas_fiscal.compensacionDePerdidas(FECHA)

    assert dato["candidatas"] == []
    assert dato["noEvaluables"] == [{"id": "acme", "nombre": "ACME", "motivo": "Sin cotización guardada."}]


def testVenderTodaLaPosicionNoSeBloqueaPorLaCompraReciente(tempDb):
    """Las participaciones compradas hace poco también se venden: no hay recompra."""
    crearActivo("acme", filas=[
        compra("01-01-2023", "10", "100"),
        compra("15-08-2026", "5", "50"),
    ], precio="50")

    [candidata] = herramientas_fiscal.compensacionDePerdidas(FECHA)["candidatas"]

    assert candidata["perdida"] == "500.00"
    assert candidata["perdidaNoComputable"] == "0.00"


def testCriptoTieneUnAnioDeVentana(tempDb):
    crearActivo("btc", tipo="cripto", filas=[compra("01-01-2023", "1", "40000")], precio="20000")

    [candidata] = herramientas_fiscal.compensacionDePerdidas(FECHA)["candidatas"]

    assert candidata["ventanaMeses"] == 12
    assert candidata["recompraDesde"] == "02-09-2027"


def testVenderlasTodasNoAhorraMasQueLaCuotaDelEjercicio(tempDb):
    crearActivo("gana", filas=[compra("01-01-2023", "10", "100")], precio="160")
    guardarVenta("2026", "v1", "01-03-2026", "gana", "10", "160")   # +600 €
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")], precio="50")   # -500 €
    crearActivo("beta", filas=[compra("01-01-2023", "10", "100")], precio="70")   # -300 €

    dato = herramientas_fiscal.compensacionDePerdidas(FECHA)

    assert [c["id"] for c in dato["candidatas"]] == ["acme", "beta"]
    assert [c["ahorroCuota"] for c in dato["candidatas"]] == ["95.00", "57.00"]
    assert dato["conjunta"]["activos"] == 2
    assert dato["conjunta"]["ahorroCuota"] == "114.00"
    assert dato["conjunta"]["cuotaDespues"] == "0.00"
    assert dato["conjunta"]["perdidaParaAnosSiguientes"] == "200.00"


def testLaCompensacionNoGuardaNada(tempDb):
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")], precio="50")
    antes = ventas_fifo.carteraViva()["acme"]["cantidad"]

    herramientas_fiscal.compensacionDePerdidas(FECHA)

    assert ventas_fifo.carteraViva()["acme"]["cantidad"] == antes
    assert ventas_fifo.calcularTodo()["liquidaciones"].get("2026") is None


# ── Previsión del IRPF del ahorro ────────────────────────────────────────────

def _escenarioIrpf():
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")])
    guardarVenta("2026", "v1", "01-03-2026", "acme", "10", "40")   # -600 €
    writeDividendosFile({"rows": [
        dividendo("15-04-2026", "900", "100"),   # 1.000 € brutos
        dividendo("15-04-2025", "5000", "0"),    # otro ejercicio
    ]})
    writeInteresesFile({"cuentas": [{
        "id": "c1", "nombre": "Banco",
        "rows": [{"fecha": "31-03-2026", "acumulado": "200", "impuestos": "38"}],
    }]})


def testLaPrevisionIntegraVentasDividendosEIntereses(tempDb):
    _escenarioIrpf()

    dato = herramientas_fiscal.previsionIrpfAhorro(2026)

    assert dato["rendimientos"]["dividendosBrutos"] == "1000.00"
    assert dato["rendimientos"]["interesesBrutos"] == "200.00"
    assert dato["rendimientos"]["total"] == "1200.00"
    assert dato["integracion"]["saldoGyp"] == "-600.00"
    assert dato["integracion"]["cruzadoGypContraRcm"] == "300.00"
    assert dato["integracion"]["perdidaArrastrable"] == "300.00"
    assert dato["base"] == "900.00"
    assert dato["cuota"] == "171.00"
    assert dato["retencionesApuntadas"] == "138.00"
    assert dato["resultado"] == "33.00"


def testLasRetencionesIndicadasSustituyenALasApuntadas(tempDb):
    _escenarioIrpf()

    dato = herramientas_fiscal.previsionIrpfAhorro(2026, Decimal("50"))

    assert dato["retencionesAplicadas"] == "50.00"
    assert dato["resultado"] == "121.00"


def testUnEjercicioSinVentasAplicaLoPendienteDelAnterior(tempDb):
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")])
    guardarVenta("2025", "v1", "01-03-2025", "acme", "10", "50")   # -500 € en 2025
    writeDividendosFile({"rows": [dividendo("15-04-2026", "1000", "0")]})

    dato = herramientas_fiscal.previsionIrpfAhorro(2026)

    assert dato["integracion"]["arrastresAplicadosRcm"] == "250.00"
    assert dato["integracion"]["detalleArrastres"][0]["restante"] == "250.00"
    assert dato["base"] == "750.00"
    assert dato["cuota"] == "142.50"


def testUnDividendoEnDivisaSinTipoSeAvisaYNoSeInventa(tempDb):
    writeDividendosFile({"rows": [dividendo("15-04-2026", "100", "15", moneda="USD")]})

    dato = herramientas_fiscal.previsionIrpfAhorro(2026)

    assert dato["rendimientos"]["dividendosBrutos"] == "0.00"
    assert any("USD" in aviso for aviso in dato["advertencias"])


def testUnEjercicioVacioDaCero(tempDb):
    dato = herramientas_fiscal.previsionIrpfAhorro(2026)

    assert dato["base"] == "0.00"
    assert dato["cuota"] == "0.00"
    assert dato["resultado"] == "0.00"


@pytest.mark.parametrize("texto", ["20x6", "1999", "3000", "-1"])
def testLeerAnioRechazaLoQueNoEsUnEjercicio(texto):
    with pytest.raises(herramientas_fiscal.EntradaInvalida):
        herramientas_fiscal.leerAnio(texto)


def testLeerRetencionesAceptaComaYRechazaNegativos():
    assert herramientas_fiscal.leerRetenciones("12,50") == Decimal("12.50")
    assert herramientas_fiscal.leerRetenciones("") is None
    with pytest.raises(herramientas_fiscal.EntradaInvalida):
        herramientas_fiscal.leerRetenciones("-3")


# ── Rutas ────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, tempDb):
    client, _cabeceras, _app = clienteAutenticado(herramientasBp)
    return client


def testRutaCompensacion(cliente):
    crearActivo("acme", filas=[compra("01-01-2023", "10", "100")], precio="50")

    res = cliente.get("/api/herramientas/compensacion?fecha=01-09-2026")

    assert res.status_code == 200
    datos = res.get_json()
    assert datos["ok"] is True
    assert datos["compensacion"]["anio"] == "2026"
    assert datos["compensacion"]["candidatas"][0]["id"] == "acme"


def testRutaCompensacionRechazaUnaFechaIlegible(cliente):
    res = cliente.get("/api/herramientas/compensacion?fecha=32-13-2026")

    assert res.status_code == 400
    assert res.get_json()["ok"] is False


def testRutaIrpf(cliente):
    _escenarioIrpf()

    res = cliente.get("/api/herramientas/irpf-ahorro?anio=2026&retenciones=50")

    assert res.status_code == 200
    assert res.get_json()["prevision"]["resultado"] == "121.00"


@pytest.mark.parametrize("consulta", ["anio=dos-mil", "anio=2026&retenciones=-1"])
def testRutaIrpfRechazaParametrosInvalidos(cliente, consulta):
    res = cliente.get(f"/api/herramientas/irpf-ahorro?{consulta}")

    assert res.status_code == 400
    assert res.get_json()["ok"] is False
