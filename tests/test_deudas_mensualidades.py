"""Hipotecas y microcréditos como mensualidades: generación, origen, convivencia y borrado."""

from stores.financiaciones_store import guardarFinanciaciones, sanearListado as sanearFinanciaciones
from stores.gastos_store import readGastosYear
from stores.hipotecas_store import guardarHipotecas, sanearListado as sanearHipotecas
from stores.microcreditos_store import guardarMicrocreditos, sanearListado as sanearMicrocreditos


def _hipoteca(**cambios):
    datos = {"alias": "Vivienda", "tipo": "fija", "capital": "12000", "fechaInicio": "2020-01-15",
             "plazoMeses": 12, "tin": "0", "categoria": "Vivienda"}
    datos.update(cambios)
    return datos


def _micro(**cambios):
    datos = {"nombre": "Rapido", "modo": "unico", "importe": "300", "comision": "45",
             "fechaInicio": "2020-03-01", "fechaVencimiento": "2020-03-31", "categoria": "Deudas"}
    datos.update(cambios)
    return datos


def _generadas(year):
    return [m for m in readGastosYear(year)["mensualidades"] if m["financiacionId"]]


def testLaHipotecaCaeCadaMesConSuOrigenYSuCategoria(tempDb):
    guardarHipotecas(sanearHipotecas([_hipoteca()]))
    filas = _generadas("2020")
    assert len(filas) == 1
    fila = filas[0]
    assert fila["origen"] == "hipoteca"
    assert fila["financiacionId"].startswith("hipoteca:")
    assert fila["categoria"] == "Vivienda"
    assert fila["meses"]["febrero"] == "1.000,00 €" and fila["meses"]["enero"] == ""
    assert fila["meses"]["diciembre"] == "1.000,00 €"
    assert fila["diaCobro"] == "15"


def testElPagoUnicoCaeEnElMesDelVencimientoConLaComision(tempDb):
    guardarMicrocreditos(sanearMicrocreditos([_micro()]))
    fila = _generadas("2020")[0]
    assert fila["origen"] == "microcredito"
    assert fila["meses"]["marzo"] == "345,00 €"
    assert sum(1 for v in fila["meses"].values() if v) == 1
    assert fila["diaCobro"] == "31"


def testElPagoUnicoDevueltoCaeEnLaFechaDeDevolucion(tempDb):
    guardarMicrocreditos(sanearMicrocreditos(
        [_micro(devuelto=True, fechaDevolucion="2020-02-20", fechaInicio="2020-02-01")]))
    fila = _generadas("2020")[0]
    assert fila["meses"]["febrero"] == "345,00 €" and fila["meses"]["marzo"] == ""
    assert fila["diaCobro"] == "20"


def testElMicrocreditoEnCuotasGeneraUnaFilaMensual(tempDb):
    guardarMicrocreditos(sanearMicrocreditos(
        [_micro(modo="cuotas", importe="600", cuotas=6, tin="0", fechaInicio="2020-01-10")]))
    fila = _generadas("2020")[0]
    assert [v for v in fila["meses"].values() if v] == ["100,00 €"] * 6


def testLasTresOrigenesConviveYCadaUnoBorraSoloLoSuyo(tempDb):
    guardarFinanciaciones(sanearFinanciaciones(
        [{"articulo": "Portatil", "precio": "1200", "entrada": "0", "cuotas": 12, "tin": "0",
          "fechaInicio": "2020-01-15"}]))
    guardarHipotecas(sanearHipotecas([_hipoteca()]))
    guardarMicrocreditos(sanearMicrocreditos([_micro()]))
    assert {f["origen"] for f in _generadas("2020")} == {"financiada", "hipoteca", "microcredito"}

    guardarMicrocreditos(sanearMicrocreditos([]))
    assert {f["origen"] for f in _generadas("2020")} == {"financiada", "hipoteca"}
    guardarHipotecas(sanearHipotecas([]))
    assert {f["origen"] for f in _generadas("2020")} == {"financiada"}


def testUnaMensualidadPropiaConElMismoNombreConvive(tempDb):
    from stores.gastos_store import sanitizeGastosPayload, writeGastosYear

    guardarHipotecas(sanearHipotecas([_hipoteca(alias="Casa")]))
    datos = readGastosYear("2020")
    datos["mensualidades"].append({"nombre": "Casa", "importe": "5,00 €", "meses": {}})
    payload, _ = sanitizeGastosPayload(datos, "2020")
    writeGastosYear("2020", payload)
    nombres = sorted(m["nombre"] for m in readGastosYear("2020")["mensualidades"])
    assert nombres == ["Casa", "Casa (hipoteca)"]


def testGuardarSinCambiosNoAvanzaLaRevision(tempDb):
    # Con id fijo: sin él cada guardado asigna uno nuevo y las filas sí cambian.
    guardarHipotecas(sanearHipotecas([_hipoteca(id="h1")]))
    antes = readGastosYear("2020")["revision"]
    guardarHipotecas(sanearHipotecas([_hipoteca(id="h1")]))
    assert readGastosYear("2020")["revision"] == antes
