"""Dividendos reinvertidos: la compra que generan en la ficha y en el FIFO.

El dividendo es la fuente de verdad y las compras de la ficha se regeneran desde
él (ver `stores/reinversion_dividendos.py`). Lo que hay que garantizar es que esa
compra existe donde la leen el FIFO y la posición, y que no se duplica ni se
pierde por guardar la ficha con una copia antigua, desmarcar el dividendo o
renombrar el activo.
"""

from datetime import date
from decimal import Decimal

import pytest


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.activos import activosBp
    from routes.registros import registrosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(activosBp, registrosBp)
    return client, cabeceras


def _crearActivo(client, cabeceras, nombre="Apple"):
    respuesta = client.post("/api/activos", json={"name": nombre, "type": "acciones"}, headers=cabeceras)
    assert respuesta.status_code == 201
    return respuesta.get_json()["asset"]["id"]


def _dividendo(**extra):
    base = {
        "fecha": "15-03-2025", "instrumento": "Apple", "acciones": "10", "dividendoAccion": "0,25",
        "impuestos": "0", "total": "2,50", "monedaDividendo": "EUR", "monedaTotal": "EUR",
    }
    return {**base, **extra}


def _guardarDividendos(client, cabeceras, *filas):
    return client.post("/api/dividendos", json={"rows": list(filas)}, headers=cabeceras)


def _reinvertido(**extra):
    return _dividendo(**{"reinvertido": True, "reinvParticipaciones": "0,05", "reinvPrecio": "50", **extra})


def _filasReinvertidas(client, activoId):
    ficha = client.get(f"/api/activos/{activoId}").get_json()
    return [fila for fila in ficha["rows"] if fila.get("reinvertido")]


def testUnDividendoReinvertidoCreaUnaCompraEnLaFicha(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)

    assert _guardarDividendos(client, cabeceras, _reinvertido()).status_code == 200

    filas = _filasReinvertidas(client, activoId)
    assert len(filas) == 1
    assert filas[0]["tipoOperacion"] == "Compra"
    assert filas[0]["fechaOperacion"] == "15-03-2025"
    assert filas[0]["participaciones"] == "0.05"
    assert filas[0]["precioParticipacion"] == "50"
    # 0,05 x 50 = 2,50, que es lo que dejó el dividendo.
    assert filas[0]["capitalInvertidoBruto"] == "2.5"


def testUnDividendoSinReinvertirNoCreaCompra(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)

    _guardarDividendos(client, cabeceras, _dividendo())

    assert _filasReinvertidas(client, activoId) == []


def testLaCompraReinvertidaEntraEnElFifo(cliente):
    from core import fifo
    from stores import ventas_fifo

    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)
    _guardarDividendos(client, cabeceras, _reinvertido())

    porActivo, _activos = ventas_fifo._operacionesDeFichas()
    operaciones = porActivo[activoId]
    assert [(op.tipo, op.cantidad, op.importe) for op in operaciones] == [
        (fifo.ADQUISICION, Decimal("0.05"), Decimal("2.5")),
    ]

    # Vender lo reinvertido consume ese lote, a su coste.
    venta = fifo.Operacion(
        ref="v", activoId=activoId, fecha=date(2025, 6, 1), tipo=fifo.TRANSMISION,
        cantidad=Decimal("0.05"), importe=Decimal("4"), orden=9,
    )
    resultados, vivos = fifo.aplicarFifo([*operaciones, venta])
    assert resultados[0].incidencia == ""
    assert resultados[0].costeAdquisicion == Decimal("2.5")
    assert vivos == []


def testGuardarLaFichaConUnaCopiaAntiguaNoDuplicaNiPierdeLaCompra(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)
    fichaAntigua = client.get(f"/api/activos/{activoId}").get_json()
    _guardarDividendos(client, cabeceras, _reinvertido())
    fichaNueva = client.get(f"/api/activos/{activoId}").get_json()

    # Una pestaña con la ficha de antes de la reinversión no la conoce: guardarla
    # no debe llevársela por delante.
    assert client.post(f"/api/activos/{activoId}", json=fichaAntigua, headers=cabeceras).status_code == 200
    assert len(_filasReinvertidas(client, activoId)) == 1

    # Y una que ya la trae (la ficha actual, reenviada entera) no la duplica.
    assert client.post(f"/api/activos/{activoId}", json=fichaNueva, headers=cabeceras).status_code == 200
    assert len(_filasReinvertidas(client, activoId)) == 1


def testGuardarLaFichaConservaLasComprasManualesYLasReinvertidas(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)
    _guardarDividendos(client, cabeceras, _reinvertido())
    ficha = client.get(f"/api/activos/{activoId}").get_json()
    ficha["rows"].append({"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra",
                          "participaciones": "10", "precioParticipacion": "40"})

    client.post(f"/api/activos/{activoId}", json=ficha, headers=cabeceras)

    filas = client.get(f"/api/activos/{activoId}").get_json()["rows"]
    assert sorted(bool(f["reinvertido"]) for f in filas) == [False, True]


def testDesmarcarOBorrarElDividendoQuitaLaCompra(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)
    _guardarDividendos(client, cabeceras, _reinvertido())

    _guardarDividendos(client, cabeceras, _dividendo())
    assert _filasReinvertidas(client, activoId) == []

    _guardarDividendos(client, cabeceras, _reinvertido())
    assert len(_filasReinvertidas(client, activoId)) == 1
    _guardarDividendos(client, cabeceras)
    assert _filasReinvertidas(client, activoId) == []


def testEditarLaReinversionActualizaLaCompra(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)
    _guardarDividendos(client, cabeceras, _reinvertido())

    _guardarDividendos(client, cabeceras, _dividendo(
        reinvertido=True, reinvParticipaciones="0,1", reinvPrecio="25"))

    filas = _filasReinvertidas(client, activoId)
    assert [(f["participaciones"], f["precioParticipacion"]) for f in filas] == [("0.1", "25")]


def testVariosDividendosGeneranVariasCompras(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)

    _guardarDividendos(client, cabeceras, _reinvertido(), _reinvertido(fecha="15-06-2025"))

    assert [f["fechaOperacion"] for f in _filasReinvertidas(client, activoId)] == ["15-03-2025", "15-06-2025"]


def testRenombrarElActivoConservaLaCompra(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)
    _guardarDividendos(client, cabeceras, _reinvertido())
    ficha = client.get(f"/api/activos/{activoId}").get_json()
    ficha["name"] = "Apple Inc"

    assert client.post(f"/api/activos/{activoId}", json=ficha, headers=cabeceras).status_code == 200

    assert len(_filasReinvertidas(client, activoId)) == 1
    dividendos = client.get("/api/dividendos").get_json()["rows"]
    assert dividendos[0]["instrumento"] == "Apple Inc"


def testUnInstrumentoQueNoEsUnActivoNoGeneraCompra(cliente):
    client, cabeceras = cliente
    activoId = _crearActivo(client, cabeceras)

    respuesta = _guardarDividendos(client, cabeceras, _reinvertido(instrumento="Otro"))

    assert respuesta.status_code == 200
    assert _filasReinvertidas(client, activoId) == []


@pytest.mark.parametrize("cambios", [
    {"reinvParticipaciones": ""},
    {"reinvParticipaciones": "0"},
    {"reinvParticipaciones": "abc"},
    {"reinvPrecio": ""},
    {"reinvPrecio": "0"},
    {"fecha": ""},
    {"fecha": "03-2025"},
    {"instrumento": ""},
])
def testUnaReinversionIncompletaSeRechaza(cliente, cambios):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)

    respuesta = _guardarDividendos(client, cabeceras, _reinvertido(**cambios))

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testLosDatosDeReinversionVuelvenEnLaLectura(cliente):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)
    _guardarDividendos(client, cabeceras, _reinvertido(), _dividendo())

    reinvertido, normal = client.get("/api/dividendos").get_json()["rows"]

    assert reinvertido["reinvertido"] is True
    assert reinvertido["reinvParticipaciones"] == "0.05"
    assert reinvertido["reinvPrecio"] == "50"
    assert normal["reinvertido"] is False
    assert normal["reinvParticipaciones"] == ""


def testElCambioDeDivisaConvierteElPrecioDeLaReinversion(tempDb):
    from core.db import getDb
    from stores import reinversion_dividendos

    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, type, currency) VALUES ('apple', 'Apple', 'acciones', 'USD')")
    conn.execute(
        "INSERT INTO dividendos (fecha, instrumento, reinvertido, reinv_participaciones, reinv_precio) "
        "VALUES ('15-03-2025', 'Apple', 1, '2', '100')"
    )

    reinversion_dividendos.convertirPrecios(conn, "Apple", Decimal("0.5"))

    assert conn.execute("SELECT reinv_precio FROM dividendos").fetchone()[0] == "50"


def testUnDividendoReinvertidoNoSumaAlSaldoDeLaCuenta(tempDb):
    from stores import cuentas_store
    from stores.app_data import writeDividendosFile

    cuentaId = cuentas_store.crearCuenta("Broker", "broker", saldoInicial="100", dividendos=True)["id"]
    base = {"fecha": "15-03-2025", "instrumento": "Apple", "monedaTotal": "EUR", "total": "10,00"}
    writeDividendosFile({"rows": [
        base,
        {**base, "reinvertido": True, "reinvParticipaciones": "1", "reinvPrecio": "10"},
    ]})

    datos = cuentas_store.saldos()[cuentaId]

    # Solo el dividendo cobrado llega a la cuenta: el otro se gastó en comprar.
    assert datos["dividendos"] == Decimal("10")
    assert datos["saldo"] == Decimal("110")
