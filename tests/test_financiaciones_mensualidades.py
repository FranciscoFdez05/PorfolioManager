"""Cuotas de compras financiadas como mensualidades: generación, sincronización y protección."""


from stores.financiaciones_store import guardarFinanciaciones, sanearListado
from stores.gastos_store import (
    readGastosYear,
    sanitizeGastosPayload,
    writeGastosYear,
)


def _compra(**cambios):
    datos = {"articulo": "Portatil", "precio": "1200", "entrada": "0", "cuotas": 12,
             "tin": "0", "fechaInicio": "2020-01-15", "categoria": "Tecnologia"}
    datos.update(cambios)
    return datos


def _guardar(*compras):
    guardarFinanciaciones(sanearListado(list(compras)))


def _financiadas(year):
    return [m for m in readGastosYear(year)["mensualidades"] if m["financiacionId"]]


def testCadaCuotaCaeEnSuMesYSeCreanLosAniosPasados(tempDb):
    _guardar(_compra())
    filas2020 = _financiadas("2020")
    filas2021 = _financiadas("2021")
    assert len(filas2020) == 1 and len(filas2021) == 1
    meses = filas2020[0]["meses"]
    assert meses["febrero"] == "100,00 €" and meses["enero"] == ""
    assert meses["diciembre"] == "100,00 €"
    assert filas2021[0]["meses"]["enero"] == "100,00 €"
    assert filas2021[0]["meses"]["febrero"] == ""
    assert filas2020[0]["categoria"] == "Tecnologia"
    assert filas2020[0]["diaCobro"] == "15" and filas2020[0]["diasCobro"] == {}


def testElDiaDeCobroSeRecortaAlUltimoDiaDelMes(tempDb):
    _guardar(_compra(diaCobro="31"))
    fila = _financiadas("2020")[0]
    assert fila["diaCobro"] == "31"
    assert fila["diasCobro"]["febrero"] == "29" and "marzo" not in fila["diasCobro"]


def testBorrarLaCompraQuitaSusCuotas(tempDb):
    _guardar(_compra())
    guardarFinanciaciones([])
    assert _financiadas("2020") == []
    assert _financiadas("2021") == []


def testGuardarElAnioDesdeElClienteNoDuplicaNiPierdeLasCuotas(tempDb):
    _guardar(_compra())
    datos = readGastosYear("2020")
    payload, error = sanitizeGastosPayload(datos, "2020")
    assert error is None
    assert payload["mensualidades"] == []
    writeGastosYear("2020", payload)
    assert len(_financiadas("2020")) == 1


def testUnaMensualidadPropiaConElMismoNombreConvive(tempDb):
    _guardar(_compra())
    datos = readGastosYear("2020")
    datos["mensualidades"].append({"nombre": "Portatil", "importe": "5,00 €", "meses": {}})
    payload, _ = sanitizeGastosPayload(datos, "2020")
    writeGastosYear("2020", payload)
    nombres = [m["nombre"] for m in readGastosYear("2020")["mensualidades"]]
    assert sorted(nombres) == ["Portatil", "Portatil (financiada)"]


def testUnAnioFuturoRecibeLasCuotasAlCrearseSinHaberloPedido(tempDb):
    _guardar(_compra(fechaInicio="2999-01-15"))
    assert readGastosYear("2999") is None
    writeGastosYear("2999", {"year": "2999", "mensualidades": [], "months": {}})
    assert len(_financiadas("2999")) == 1


def testElPagoAnticipadoSumaEnSuMes(tempDb):
    _guardar(_compra(amortizaciones=[{"fecha": "2020-03-01", "importe": "300", "modo": "plazo"}]))
    meses = _financiadas("2020")[0]["meses"]
    assert meses["marzo"] == "400,00 €"
    assert meses["febrero"] == "100,00 €"
