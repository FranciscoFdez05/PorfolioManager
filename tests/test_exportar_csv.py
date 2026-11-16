"""Exportación a CSV: generación pura (core.exportar_csv) y /api/exportar/<modulo>.csv."""

import pytest

from core.exportar_csv import BOM, generarCsv, textoSeguro


@pytest.mark.parametrize("texto", ["=1+1", "+34 600", "-cmd", "@SUM(A1)", "\tx", '=HYPERLINK("http://x";"v")'])
def testLoQueEmpiezaComoFormulaQuedaComoTexto(texto):
    assert textoSeguro(texto) == "'" + texto


@pytest.mark.parametrize("texto", ["-12,50", "-12,50 €", "+1.234,56", "-5", "12,50 EUR", "Apple", "", "10-01-2026"])
def testImportesYTextoNormalNoCambian(texto):
    assert textoSeguro(texto) == texto


def testNoneEsCeldaVacia():
    assert textoSeguro(None) == ""


def testElCsvLlevaBomSeparadorYCabecera():
    salida = generarCsv([("a", "Columna A"), ("b", "B")], [{"a": "x", "b": "1,5"}])
    assert salida == BOM + "Columna A;B\r\nx;1,5\r\n"


def testUnaClaveAusenteEsCeldaVaciaYElOrdenEsElDeLasColumnas():
    assert generarCsv([("b", "B"), ("a", "A")], [{"a": "1"}]) == BOM + "B;A\r\n;1\r\n"


def testUnPuntoYComaEnElTextoSeEntrecomilla():
    assert generarCsv([("a", "A")], [{"a": "uno;dos"}]) == BOM + 'A\r\n"uno;dos"\r\n'


def testLaFormulaSeNeutralizaEnLaFila():
    assert generarCsv([("a", "A")], [{"a": "=cmd"}]).endswith("'=cmd\r\n")


@pytest.fixture
def cliente(clienteAutenticado, tempDb):
    from routes.exportar import exportarBp

    client, _cabeceras, _app = clienteAutenticado(exportarBp)
    return client


def testModuloDesconocidoDa404(cliente):
    assert cliente.get("/api/exportar/inventado.csv").status_code == 404


def testGastosExigeAnio(cliente):
    assert cliente.get("/api/exportar/gastos.csv").status_code == 400
    assert cliente.get("/api/exportar/gastos.csv?anio=abc").status_code == 400


def testAnioSinDatosDa404(cliente):
    assert cliente.get("/api/exportar/ingresos.csv?anio=1999").status_code == 404


def testDividendosSeExportaConCabeceraYFilas(cliente):
    from stores.app_data import writeDividendosFile

    writeDividendosFile({"rows": [{
        "fecha": "05-03-2026", "instrumento": "=Mala", "acciones": "10", "dividendoAccion": "0,5",
        "impuestos": "1,00", "total": "4,00", "monedaDividendo": "EUR", "monedaTotal": "EUR", "cuenta": ""}]})
    resp = cliente.get("/api/exportar/dividendos.csv")
    assert resp.status_code == 200
    assert resp.mimetype == "text/csv"
    assert "dividendos.csv" in resp.headers["Content-Disposition"]
    texto = resp.get_data(as_text=True)
    assert texto.startswith(BOM + "Fecha;Instrumento;")
    assert "05-03-2026;'=Mala;10;" in texto


def testGastosDeUnAnioLleganConSuMes(cliente):
    from stores.gastos_store import createDefaultGastosYear, writeGastosYear

    datos = createDefaultGastosYear("2026")
    datos["months"]["marzo"]["rows"] = [{"fecha": "02-03-2026", "nombre": "Luz", "tipo": "Hogar",
                                         "cantidad": "40,00 €", "nota": "", "cuenta": ""}]
    writeGastosYear("2026", datos)
    resp = cliente.get("/api/exportar/gastos.csv?anio=2026")
    assert resp.status_code == 200
    assert "gastos-2026.csv" in resp.headers["Content-Disposition"]
    assert "marzo;02-03-2026;Luz;Hogar;40,00 €" in resp.get_data(as_text=True)


def testCuentasSinMovimientosSeExportaSinFallar(cliente):
    resp = cliente.get("/api/exportar/cuentas.csv")
    assert resp.status_code == 200
    assert resp.get_data(as_text=True).startswith(BOM + "Cuenta;Tipo;")


def testCuentasIncluyeSaldoInicialYSaldo(cliente):
    from stores.cuentas_store import crearCuenta

    crearCuenta("Cuenta nomina", "banco", saldoInicial="1000")
    texto = cliente.get("/api/exportar/cuentas.csv").get_data(as_text=True)
    fila = next(linea for linea in texto.splitlines() if linea.startswith("Cuenta nomina;"))
    campos = fila.split(";")
    assert campos[2] == "1.000,00"
    assert campos[5] == "1.000,00"
