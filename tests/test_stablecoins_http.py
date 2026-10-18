"""POST /api/stablecoins: normalización del catálogo, los activados y las filas.

routes/operaciones.py no tenía ninguna prueba. saveStablecoins se partió en
funciones pequeñas (era la de mayor complejidad del módulo, 41); estas pruebas
fijan el comportamiento que tenía antes del cambio.
"""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.operaciones import operacionesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(operacionesBp)
    return client, cabeceras


def _guardar(client, cabeceras, **cuerpo):
    respuesta = client.post("/api/stablecoins", json=cuerpo, headers=cabeceras)
    return respuesta.status_code, respuesta.get_json()


def _simbolos(datos):
    return [e["symbol"] for e in datos["data"]["catalog"]]


def testElCatalogoSeNormalizaYSinRepetidos(cliente):
    client, cabeceras = cliente
    _, datos = _guardar(client, cabeceras, catalog=["usdt", {"symbol": "USDT"}, "dai", " eur-c "])
    assert _simbolos(datos) == ["USDT", "DAI", "EURC"]


def testLosActivadosFueraDelCatalogoSeDescartan(cliente):
    client, cabeceras = cliente
    _, datos = _guardar(client, cabeceras, catalog=["USDT", "DAI"], enabledSymbols=["dai", "usdc", "DAI"])
    assert datos["data"]["enabledSymbols"] == ["DAI"]


def testSinCatalogoSeDeduceDeLosActivados(cliente):
    client, cabeceras = cliente
    _, datos = _guardar(client, cabeceras, enabledSymbols=["usdc", "dai"],
                        rows=[{"stablecoinSymbol": "fdusd"}])
    assert _simbolos(datos) == ["USDC", "DAI"]


def testSinCatalogoNiActivadosSeDeduceDeLasFilas(cliente):
    client, cabeceras = cliente
    _, datos = _guardar(client, cabeceras, rows=[{"stablecoinSymbol": "fdusd"}, {"stablecoinSymbol": "FDUSD"},
                                                  {"stablecoinSymbol": "usdt"}])
    assert _simbolos(datos) == ["FDUSD", "USDT"]


def testUnaFilaConSimboloDesconocidoTomaElPrimerActivado(cliente):
    client, cabeceras = cliente
    _, datos = _guardar(client, cabeceras, catalog=["USDT", "DAI"], enabledSymbols=["DAI"],
                        rows=[{"stablecoinSymbol": "XYZ"}])
    assert datos["data"]["rows"][0]["stablecoinSymbol"] == "DAI"


@pytest.mark.parametrize("tipo, esperado", [("compra", "Compra"), ("venta", "Venta"), ("Gasto", "Venta"),
                                            ("otro", "Compra")])
def testTipoDeMovimiento(cliente, tipo, esperado):
    client, cabeceras = cliente
    _, datos = _guardar(client, cabeceras, catalog=["USDT"], rows=[{"stablecoinSymbol": "USDT", "tipo": tipo}])
    assert datos["data"]["rows"][0]["tipo"] == esperado


def testDivisaYIdPorDefecto(cliente):
    client, cabeceras = cliente
    _, datos = _guardar(client, cabeceras, catalog=["USDT"],
                        rows=[{"stablecoinSymbol": "USDT", "currency": "gbp"}, {"currency": "eur", "id": "x"}])
    filas = datos["data"]["rows"]
    assert [f["currency"] for f in filas] == ["USD", "EUR"]
    assert [f["id"] for f in filas] == ["stablecoin-1", "x"]


def testLoGuardadoSeVuelveALeer(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, catalog=["USDT"], enabledSymbols=["USDT"],
             rows=[{"stablecoinSymbol": "USDT", "cantidad": "10", "nota": "n"}])

    leido = client.get("/api/stablecoins").get_json()

    assert [e["symbol"] for e in leido["catalog"]] == ["USDT"]
    assert leido["rows"][0]["cantidad"] == "10"


@pytest.mark.parametrize("cuerpo", [{"catalog": "x"}, {"enabledSymbols": 1}, {"rows": "x"}, {"rows": [1]}])
def testEstructurasIncorrectasSon400(cliente, cuerpo):
    client, cabeceras = cliente
    status, _ = _guardar(client, cabeceras, **cuerpo)
    assert status == 400
