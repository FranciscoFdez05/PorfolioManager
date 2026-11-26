"""Canjes de valores por fusión: FIFO, normativa, posición, informe y rutas.

Lo que se comprueba es lo que la ley pide de un canje y lo que la aplicación
podría hacer mal sin avisar:

* En régimen neutral (art. 81.1 LIS) los títulos recibidos heredan el coste y la
  fecha de cada lote entregado, y una venta posterior los consume por esa fecha.
* La compensación en dinero rebaja el coste heredado; los picos se transmiten.
* En régimen general el canje es una permuta: ganancia a valor de mercado y
  lote nuevo con la fecha del canje.
* Los lotes heredados no son una recompra para la regla de los dos meses, y la
  pérdida aplazada que llevaban viaja con ellos.
"""

from datetime import date
from decimal import Decimal

import pytest

from core import canjes, fifo, informe_renta
from core.errors import ValidationError
from core.fifo import ADQUISICION, TRANSMISION, Operacion
from stores import canjes_store, rendimiento_activo, ventas_fifo
from stores.asset_store import writeAssetFile
from stores.ventas_store import (
    readVentasYear,
    sanitizeVentasPayload,
    validarParaGuardar,
    writeVentasYear,
)

# ── Utilidades ───────────────────────────────────────────────────────────────


def crearActivo(assetId, filas=(), tipo="accion", moneda="EUR"):
    writeAssetFile(assetId, {
        "name": assetId.upper(),
        "symbol": assetId.upper(),
        "type": tipo,
        "currency": moneda,
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


def guardarVentas(year, filas):
    payload, error = sanitizeVentasPayload({"year": year, "rows": filas}, year)
    assert error is None, error
    validarParaGuardar(payload)
    writeVentasYear(year, payload)
    return readVentasYear(year)


def venta(ventaId, fecha, assetId, cantidad, precio):
    return {"id": ventaId, "fecha": fecha, "assetId": assetId, "cantidad": cantidad,
            "valorVenta": precio, "comisionVenta": ""}


def guardarCanje(**datos):
    base = {
        "fecha": "01-06-2026",
        "activoOrigen": "tsla",
        "activoDestino": "spacex",
        "cantidadEntregada": "20",
        "cantidadRecibida": "40",
        "regimen": "neutral",
    }
    return canjes_store.guardar({**base, **datos})


@pytest.fixture
def cartera(tempDb):
    """TSLA en dos lotes (2020 a 100 € y 2022 a 200 €) y SPACEX vacío."""
    crearActivo("tsla", [compra("01-01-2020", "10", "100"), compra("01-01-2022", "10", "200")])
    crearActivo("spacex")
    return tempDb


def canjeDelAnio(anio="2026"):
    return ventas_fifo.calcularTodo()["canjes"][anio][0]


# ── Motor FIFO ───────────────────────────────────────────────────────────────


def testUnLoteHeredadoSeConsumeAntesQueLosPosterioresASuFecha():
    operaciones = [
        Operacion(ref="propia", activoId="b", fecha=date(2025, 3, 1), tipo=ADQUISICION,
                  cantidad=Decimal("5"), importe=Decimal("500")),
        Operacion(ref="heredada", activoId="b", fecha=date(2026, 6, 1), tipo=ADQUISICION,
                  cantidad=Decimal("5"), importe=Decimal("50"), fechaAntiguedad=date(2020, 1, 1)),
        Operacion(ref="venta", activoId="b", fecha=date(2026, 9, 1), tipo=TRANSMISION,
                  cantidad=Decimal("5"), importe=Decimal("100")),
    ]

    resultados, vivos = fifo.aplicarFifo(operaciones)

    assert [c.loteRef for c in resultados[0].lotes] == ["heredada"]
    assert resultados[0].lotes[0].fechaAdquisicion == date(2020, 1, 1)
    assert resultados[0].ganancia == Decimal("50")
    assert [lote.ref for lote in vivos] == ["propia"]


def testSinFechaDeAntiguedadElOrdenNoCambia():
    operaciones = [
        Operacion(ref="a", activoId="x", fecha=date(2024, 1, 1), tipo=ADQUISICION,
                  cantidad=Decimal("1"), importe=Decimal("10")),
        Operacion(ref="b", activoId="x", fecha=date(2023, 1, 1), tipo=ADQUISICION,
                  cantidad=Decimal("1"), importe=Decimal("20")),
        Operacion(ref="v", activoId="x", fecha=date(2025, 1, 1), tipo=TRANSMISION,
                  cantidad=Decimal("1"), importe=Decimal("30")),
    ]

    resultados, _ = fifo.aplicarFifo(operaciones)

    assert resultados[0].lotes[0].loteRef == "b"


def testLaEstrategiaDeRegimenDesconocidoFalla():
    with pytest.raises(canjes.CanjeError):
        canjes.estrategia("otro")


# ── Régimen neutral ──────────────────────────────────────────────────────────


def testElCanjeNeutralNoDeclaraYTraspasaCadaLoteConSuFecha(cartera):
    guardarCanje()

    fila = canjeDelAnio()

    assert fila["regimen"] == "neutral"
    assert fila["transmisiones"] == []
    assert fila["incidencia"] == ""
    assert fila["costeTraspasado"] == "3000.00"
    assert [(lote["fechaAdquisicion"], lote["cantidad"], lote["coste"]) for lote in fila["lotes"]] == [
        ("01-01-2020", "20.00000000", "1000.00"),
        ("01-01-2022", "20.00000000", "2000.00"),
    ]


def testUnaVentaPosteriorDelNuevoValorConsumeLasFechasOriginales(cartera):
    guardarCanje()
    guardarVentas("2026", [venta("v1", "01-09-2026", "spacex", "25", "100")])

    fila = readVentasYear("2026")["rows"][0]

    # 20 títulos del lote de 2020 (1.000 €) y 5 de los 20 del de 2022 (500 €).
    assert fila["costeAdquisicion"] == "1500.00"
    assert [(lote["fecha"], lote["cantidad"]) for lote in fila["lotes"]] == [
        ("01-01-2020", "20.00000000"),
        ("01-01-2022", "5.00000000"),
    ]
    assert fila["dineroDeclarar"] == "1000.00"


def testLosHeredadosVanPorDelanteDeLoQueYaHabiaEnElDestino(cartera):
    crearActivo("spacex", [compra("01-03-2025", "10", "500")])
    guardarCanje()
    guardarVentas("2026", [venta("v1", "01-09-2026", "spacex", "20", "100")])

    fila = readVentasYear("2026")["rows"][0]

    assert [lote["fecha"] for lote in fila["lotes"]] == ["01-01-2020"]
    assert fila["costeAdquisicion"] == "1000.00"


def testLaCompensacionEnDineroRebajaElCosteHeredado(cartera):
    guardarCanje(compensacion="100")

    fila = canjeDelAnio()

    # Se reparte por títulos entregados: 50 € a cada lote de 10.
    assert [lote["coste"] for lote in fila["lotes"]] == ["950.00", "1950.00"]
    assert fila["costeTraspasado"] == "2900.00"
    assert fila["transmisiones"] == []


def testUnaCompensacionMayorQueElCosteDejaCeroYAvisa(cartera):
    guardarCanje(compensacion="10000")

    fila = canjeDelAnio()

    assert [lote["coste"] for lote in fila["lotes"]] == ["0.00", "0.00"]
    assert fila["incidencia"] == canjes.INCIDENCIA_COMPENSACION
    assert fila["mensaje"]


def testLosPicosSeTransmitenConGananciaPorFifo(cartera):
    guardarCanje(cantidadRecibida="39", picosCantidad="1", picosImporte="60")
    guardarVentas("2026", [])

    fila = canjeDelAnio()
    resumen = readVentasYear("2026")["resumen"]

    # El título de picos sale del lote de 2020: 1.000 € / 20 = 50 €.
    assert len(fila["transmisiones"]) == 1
    picos = fila["transmisiones"][0]
    assert picos["costeAdquisicion"] == "50.00"
    assert picos["dineroDeclarar"] == "10.00"
    assert resumen["ganancias"] == "10.00"


def testSinTitulosSuficientesNoSeTraspasaNada(cartera):
    guardarCanje(cantidadEntregada="30", cantidadRecibida="60")

    fila = canjeDelAnio()

    assert fila["incidencia"] == fifo.INCIDENCIA_STOCK
    assert fila["lotes"] == []
    assert "fecha del canje" in fila["mensaje"]


def testLosLotesHeredadosNoBloqueanUnaPerdidaPorRecompra(cartera):
    crearActivo("spacex", [compra("01-01-2026", "10", "100")])
    guardarVentas("2026", [venta("v1", "15-05-2026", "spacex", "10", "50")])
    guardarCanje()

    fila = readVentasYear("2026")["rows"][0]

    assert fila["dineroDeclarar"] == "-500.00"
    assert fila["perdidaNoComputable"] == "0.00"


def testLaPerdidaAplazadaViajaConLosTitulosCanjeados(tempDb):
    crearActivo("tsla", [compra("02-01-2026", "10", "100"), compra("10-03-2026", "10", "50")])
    crearActivo("spacex")
    guardarVentas("2026", [
        venta("v1", "01-03-2026", "tsla", "10", "50"),
        venta("v2", "01-09-2026", "spacex", "10", "60"),
    ])
    guardarCanje(cantidadEntregada="10", cantidadRecibida="10")

    filas = {f["id"]: f for f in readVentasYear("2026")["rows"]}

    # La pérdida de 500 € queda bloqueada por la recompra del 10-03 y se libera
    # al vender los SPACEX que salieron de ella.
    assert filas["v1"]["perdidaNoComputable"] == "500.00"
    assert filas["v2"]["perdidaDiferidaLiberada"] == "500.00"
    assert filas["v2"]["dineroDeclarar"] == "-400.00"


def testLosCanjesEncadenadosConservanLaFechaOriginal(cartera):
    crearActivo("xai")
    guardarCanje()
    guardarCanje(fecha="01-07-2026", activoOrigen="spacex", activoDestino="xai",
                 cantidadEntregada="40", cantidadRecibida="40")
    guardarVentas("2026", [venta("v1", "01-09-2026", "xai", "1", "100")])

    fila = readVentasYear("2026")["rows"][0]

    assert fila["lotes"][0]["fecha"] == "01-01-2020"
    assert fila["costeAdquisicion"] == "50.00"


# ── Régimen general ──────────────────────────────────────────────────────────


def testElCanjeGravadoEsUnaPermutaAValorDeMercado(cartera):
    guardarCanje(regimen="gravado", valorMercado="5000", compensacion="100")
    guardarVentas("2026", [venta("v1", "01-09-2026", "spacex", "10", "150")])

    fila = canjeDelAnio()
    ventaSpacex = readVentasYear("2026")["rows"][0]

    entrega = fila["transmisiones"][0]
    assert entrega["valorTransmision"] == "5100.00"
    assert entrega["costeAdquisicion"] == "3000.00"
    assert entrega["dineroDeclarar"] == "2100.00"
    # El lote nuevo se adquiere el día del canje por el valor de mercado.
    assert ventaSpacex["lotes"][0]["fecha"] == "01-06-2026"
    assert ventaSpacex["costeAdquisicion"] == "1250.00"
    assert readVentasYear("2026")["resumen"]["ganancias"] == "2350.00"


def testElCanjeEnDolaresUsaElTipoAnotado(cartera):
    guardarCanje(regimen="gravado", valorMercado="5000", moneda="USD", fxRate="0.9")

    entrega = canjeDelAnio()["transmisiones"][0]

    assert entrega["valorTransmision"] == "4500.00"


# ── Posición de la cartera ───────────────────────────────────────────────────


def _posicion(conn, assetId):
    datos = rendimiento_activo.cargarPosiciones(conn)[assetId]
    lotes = rendimiento_activo.lotesVivos(
        datos["filas"], datos["operaciones"], False, datos["ventas"], None,
        datos["transacciones"], datos["conversiones"],
    )
    return lotes


def testLaPosicionPasaDelOrigenAlDestino(cartera):
    from core.db import getDb

    guardarCanje(compensacion="100")
    conn = getDb()

    assert _posicion(conn, "tsla") == []
    destino = _posicion(conn, "spacex")
    assert sum(lote["cantidad"] for lote in destino) == Decimal("40")
    assert sum(lote["coste"] for lote in destino) == Decimal("2900")
    assert [lote["fecha"] for lote in destino] == [date(2020, 1, 1), date(2022, 1, 1)]


def testLaPosicionAntesDelCanjeSigueEnElOrigen(cartera):
    from core.db import getDb

    guardarCanje()
    datos = rendimiento_activo.cargarPosiciones(getDb())

    dia = date(2026, 5, 31)
    origen = rendimiento_activo.posicionPorDias(
        datos["tsla"]["filas"], [], False, [], [dia, None])
    destino = rendimiento_activo.posicionPorDias(
        datos["spacex"]["filas"], [], False, [], [dia, None])

    assert origen[dia][0] == Decimal("20")
    assert destino[dia][0] == Decimal("0")
    assert origen[None][0] == Decimal("0")
    assert destino[None][0] == Decimal("40")


def testLosPicosSalenDeLaPosicionDelDestino(cartera):
    from core.db import getDb

    guardarCanje(cantidadRecibida="39", picosCantidad="1", picosImporte="60")

    assert sum(lote["cantidad"] for lote in _posicion(getDb(), "spacex")) == Decimal("39")


# ── Validación ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize("cambios, campo", [
    ({"activoDestino": "tsla"}, "activoDestino"),
    ({"activoOrigen": "noexiste"}, "activoOrigen"),
    ({"cantidadEntregada": "0"}, "cantidadEntregada"),
    ({"cantidadRecibida": "0"}, "cantidadRecibida"),
    ({"regimen": "gravado"}, "valorMercado"),
    ({"regimen": "otro"}, "regimen"),
    ({"fecha": "31-02-2026"}, "fecha"),
    ({"moneda": "USD", "compensacion": "10"}, "fxRate"),
    ({"moneda": "dolares"}, "moneda"),
    ({"compensacion": "-1"}, None),
])
def testRechazaUnCanjeInvalido(cartera, cambios, campo):
    with pytest.raises(ValidationError) as error:
        guardarCanje(**cambios)
    if campo:
        assert error.value.field == campo


def testGuardaEditaYBorra(cartera):
    canje = guardarCanje(nota="Folleto de fusión")
    assert canje["fecha"] == "01-06-2026"
    assert canje["cantidadEntregada"] == "20"

    editado = canjes_store.guardar({**canje, "cantidadRecibida": "30"}, canje["id"])
    assert editado["cantidadRecibida"] == "30"
    assert len(canjes_store.listar()) == 1

    assert canjes_store.borrar(canje["id"]) is True
    assert canjes_store.listar() == []
    assert canjes_store.borrar(canje["id"]) is False


def testBorrarElActivoBorraSusCanjes(cartera):
    from stores.asset_store import deleteAssetFile

    guardarCanje()
    deleteAssetFile("spacex")

    assert canjes_store.listar() == []


# ── Informe de la renta ──────────────────────────────────────────────────────


def testElInformeIncluyeLosCanjesYSusLotes(cartera):
    guardarCanje(cantidadRecibida="39", picosCantidad="1", picosImporte="60")
    datos = guardarVentas("2026", [])

    informe = informe_renta.construir("2026", datos["rows"], datos["resumen"],
                                      datos["permutas"], datos["canjes"])
    csvTexto = informe_renta.aCsv(informe)
    htmlTexto = informe_renta.aHtml(informe)

    assert "CANJES DE VALORES" in csvTexto
    assert "art. 81 LIS" in csvTexto
    assert "Adquirido el 01-01-2020" in csvTexto
    assert "Canjes de valores" in htmlTexto
    assert "01-01-2022" in htmlTexto
    assert informe["totales"][0][1] == "10,00"


# ── Rutas ────────────────────────────────────────────────────────────────────


@pytest.fixture
def cliente(clienteAutenticado, cartera):
    from routes.canjes import canjesBp

    client, cabeceras, _app = clienteAutenticado(canjesBp)
    return client, cabeceras


def testLaRutaCreaPrevisualizaYDevuelveLaPosicion(cliente):
    client, cabeceras = cliente
    cuerpo = {"fecha": "01-06-2026", "activoOrigen": "tsla", "activoDestino": "spacex",
              "cantidadEntregada": "20", "cantidadRecibida": "40", "regimen": "neutral"}

    previa = client.post("/api/canjes/previsualizar", json=cuerpo, headers=cabeceras)
    assert previa.status_code == 200
    assert previa.get_json()["previsualizacion"]["costeTraspasado"] == "3000.00"
    assert client.get("/api/canjes").get_json()["rows"] == []

    creado = client.post("/api/canjes", json=cuerpo, headers=cabeceras)
    assert creado.status_code == 201
    canjeId = creado.get_json()["canje"]["id"]

    lista = client.get("/api/canjes").get_json()
    assert [fila["id"] for fila in lista["rows"]] == [canjeId]
    movimientos = {(m["assetId"], m["tipo"]) for m in lista["posicion"]}
    assert movimientos == {("tsla", "Venta"), ("spacex", "Compra")}
    assert {m["fechaAntiguedad"] for m in lista["posicion"] if m["tipo"] == "Compra"} == {
        "01-01-2020", "01-01-2022",
    }

    # Previsualizar la edición no cuenta el canje guardado dos veces.
    previaEdicion = client.post("/api/canjes/previsualizar", json={**cuerpo, "id": canjeId},
                                headers=cabeceras).get_json()["previsualizacion"]
    assert previaEdicion["incidencia"] == ""

    assert client.delete(f"/api/canjes/{canjeId}", headers=cabeceras).status_code == 200
    assert client.delete(f"/api/canjes/{canjeId}", headers=cabeceras).status_code == 404


def testLaRutaRechazaDatosInvalidosCon400(cliente):
    client, cabeceras = cliente

    respuesta = client.post("/api/canjes", json={"activoOrigen": "tsla"}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testEditarUnCanjeInexistenteDa404(cliente):
    client, cabeceras = cliente

    respuesta = client.put("/api/canjes/nada", json={}, headers=cabeceras)

    assert respuesta.status_code == 404
