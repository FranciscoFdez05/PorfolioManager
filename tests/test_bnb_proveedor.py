"""La API de BNB Smart Chain se puede elegir y cada fallo se explica con claridad.

El plan gratuito de Etherscan no incluye BNB: sin alternativa, esas wallets no se
leen, y con una sola fila compartida parecía que fallaba también Ethereum.

Ningún test sale a la red. Las respuestas de NodeReal siguen los ejemplos de su
documentación: la API real no se ha podido probar sin una clave.
"""

import json
from decimal import Decimal
from urllib.error import HTTPError

import pytest

from core import paths, proveedor_bnb
from providers import api_stats, blockchain_clients as bc, estado
from providers.api_stats import lastApiResults, recordApiResult

_MIA = "0x8f07f7312f3ede8b0094f09ab1554c8d89f47ddf"
_OTRA = "0x646eafba97ec6ee7631887cdee468b323dd65d4f"
_CLAVE = "clavedeprueba123"


def _elegir(idProveedor: str) -> None:
    paths.AJUSTES_JSON.parent.mkdir(parents=True, exist_ok=True)
    paths.AJUSTES_JSON.write_text(json.dumps({"bnbProveedor": idProveedor}), "utf-8")
    proveedor_bnb._cache["mtime"] = None


@pytest.fixture(autouse=True)
def limpio(monkeypatch, tmp_path):
    monkeypatch.setattr(paths, "AJUSTES_JSON", tmp_path / "ajustes.json")
    proveedor_bnb._cache["mtime"] = None
    estado.reiniciarParaPruebas()
    yield
    proveedor_bnb._cache["mtime"] = None
    estado.reiniciarParaPruebas()


def _nativa(**cambios) -> dict:
    return {"category": "external", "from": _OTRA, "to": _MIA, "value": "0xde0b6b3a7640000", "asset": "BNB",
            "hash": "0xaaa", "blockTimeStamp": 1620089457, "gasPrice": 5000000000, "gasUsed": 21000,
            "receiptsStatus": 1, **cambios}


def _token(**cambios) -> dict:
    return {"category": "20", "from": _MIA, "to": _OTRA,
            "value": "0x00000000000000000000000000000000000000000000000564d702d38f5e0000", "asset": "TWT",
            "hash": "0xbbb", "contractAddress": "0x4B0F1812e5Df2A09796481Ff14017e6005508003", "decimal": "18",
            "blockTimeStamp": 1610380207, **cambios}


def _lector(respuestas: dict) -> tuple[bc.LectorBnbNodeReal, list]:
    """Un lector con un doble que contesta según método y categoría, y sus peticiones."""
    peticiones = []

    def obtener(url, jsonBody=None, **_):
        peticiones.append((url, jsonBody))
        metodo = jsonBody["method"]
        if metodo == "nr_getTransactionByAddress":
            metodo = jsonBody["params"][0]["category"][0]
        respuesta = respuestas[metodo]
        return respuesta(jsonBody) if callable(respuesta) else respuesta

    return bc.LectorBnbNodeReal(apiKey=_CLAVE, obtenerJson=obtener), peticiones


def _transferencias(*filas, pageKey=None) -> dict:
    return {"result": {"transfers": list(filas), "pageKey": pageKey}}


# ── Selector ─────────────────────────────────────────────────────────────────

def testPorDefectoSigueSiendoEtherscan():
    assert proveedor_bnb.actual() == "etherscan"
    assert type(bc.lectorPara("bnb")) is bc.LectorEvm


def testConNodeRealElegidoLaFactoriaYElVisorLoUsan():
    _elegir("nodereal")

    assert isinstance(bc.lectorPara("bnb"), bc.LectorBnbNodeReal)
    assert isinstance(bc.lectorTokens("bnb"), bc.LectorBnbNodeReal)


def testElegirBnbNoCambiaLaApiDeEthereum():
    _elegir("nodereal")

    assert type(bc.lectorPara("eth")) is bc.LectorEvm


@pytest.mark.parametrize("guardado", ["inventada", 7, None])
def testUnValorGuardadoRaroVuelveAlPorDefecto(guardado):
    _elegir(guardado)

    assert proveedor_bnb.actual() == proveedor_bnb.POR_DEFECTO


def testUnFicheroDeAjustesRotoVuelveAlPorDefecto():
    paths.AJUSTES_JSON.write_text("{no es json", "utf-8")

    assert proveedor_bnb.actual() == proveedor_bnb.POR_DEFECTO


# ── Lector de NodeReal ───────────────────────────────────────────────────────

def testUnaRecepcionSeNormalizaComoLaDeEtherscan():
    lector, _ = _lector({"external": _transferencias(_nativa()), "20": _transferencias()})

    movimiento = lector.leer("direccion", _MIA, 10)[0]

    assert (movimiento.red, movimiento.simbolo, movimiento.tipo) == ("bnb", "BNB", bc.RECIBIDA)
    assert movimiento.cantidad == Decimal(1)
    assert movimiento.contraparte == _OTRA
    assert movimiento.comision is None


def testUnEnvioNativoLlevaSuComision():
    lector, _ = _lector({"external": _transferencias(_nativa(**{"from": _MIA, "to": _OTRA})),
                         "20": _transferencias()})

    movimiento = lector.leer("direccion", _MIA, 10)[0]

    assert movimiento.tipo == bc.ENVIADA
    assert movimiento.comision == Decimal("0.000105")


def testUnEnvioDeTokenNoInventaUnaComisionDeCero():
    """NodeReal no da el gas de los tokens: un «0» sería afirmar lo que no se sabe."""
    lector, _ = _lector({"external": _transferencias(), "20": _transferencias(_token())})

    movimiento = lector.leer("direccion", _MIA, 10)[0]

    assert movimiento.simbolo == "TWT"
    assert movimiento.cantidad == Decimal("99.5")
    assert movimiento.contrato == "0x4b0f1812e5df2a09796481ff14017e6005508003"
    assert movimiento.comisionTx is None
    assert "comisión" not in movimiento.nota


def testUnaTransaccionFallidaNoEsMovimientoPeroSiComision():
    lector, _ = _lector({"external": _transferencias(_nativa(**{"from": _MIA, "to": _OTRA, "receiptsStatus": 0})),
                         "20": _transferencias()})

    movimientos, comisiones = lector.leerConComisiones("direccion", _MIA, 10)

    assert movimientos == []
    assert [c.comision for c in comisiones] == [Decimal("0.000105")]


def testLasTransferenciasDeTokenDeValorCeroSeDescartan():
    lector, _ = _lector({"external": _transferencias(), "20": _transferencias(_token(value="0x0"))})

    assert lector.leer("direccion", _MIA, 10) == []


def testUnTokenSinDecimalesNoSeIntentaLeer():
    """Sin decimales el importe podría salir multiplicado por 10^18."""
    lector, _ = _lector({"external": _transferencias(), "20": _transferencias(_token(decimal=None))})

    assert lector.leer("direccion", _MIA, 10) == []


def testAdmiteLasDosFormasDelCampoDeFecha():
    fila = _nativa()
    fila["blockTimestamp"] = fila.pop("blockTimeStamp")
    lector, _ = _lector({"external": _transferencias(fila), "20": _transferencias()})

    assert lector.leer("direccion", _MIA, 10)[0].fecha.timestamp() == 1620089457


def testRecorreLasPaginasHastaElLimite():
    def paginas(cuerpo):
        if cuerpo["params"][0].get("pageKey") == "siguiente":
            return _transferencias(_nativa(hash="0x2"), pageKey="otra")
        return _transferencias(_nativa(hash="0x1"), pageKey="siguiente")

    lector, peticiones = _lector({"external": paginas, "20": _transferencias()})

    movimientos = lector.leer("direccion", _MIA, 2)

    assert {m.hash for m in movimientos} == {"0x1", "0x2"}
    externas = [p for _, p in peticiones if p["params"][0]["category"] == ["external"]]
    assert [p["params"][0]["maxCount"] for p in externas] == ["0x2", "0x1"]


def testNoPideRangoDeBloques():
    """Con rango, NodeReal limita la consulta a 1000 bloques: unos minutos de cadena."""
    lector, peticiones = _lector({"external": _transferencias(), "20": _transferencias()})

    lector.leer("direccion", _MIA, 10)

    for _, cuerpo in peticiones:
        assert not {"fromBlock", "toBlock"} & set(cuerpo["params"][0])


def testElSaldoVieneEnHexadecimal():
    lector, _ = _lector({"eth_getBalance": {"result": "0xde0b6b3a7640000"}})

    assert lector.saldo("direccion", _MIA) == Decimal(1)


def testUnSaldoIlegibleEsUnError():
    lector, _ = _lector({"eth_getBalance": {"result": "no-es-un-numero"}})

    with pytest.raises(bc.ErrorLecturaWallet, match="saldo inesperado"):
        lector.saldo("direccion", _MIA)


def testLosTokensSeLeenDeSusTenencias():
    tenencias = {"result": {"totalCount": "0x2", "details": [
        {"tokenAddress": "0x4B0F1812e5Df2A09796481Ff14017e6005508003", "tokenName": "Trust Wallet",
         "tokenSymbol": "TWT", "tokenDecimails": "0x12", "tokenBalance": "0xde0b6b3a7640000"},
        {"tokenAddress": "0xfcb5DF42e06A39E233dc707bb3a80311eFD11576", "tokenName": "Vacio",
         "tokenSymbol": "VAC", "tokenDecimails": "0x12", "tokenBalance": "0x0"},
    ]}}
    lector, _ = _lector({"nr_getTokenHoldings": tenencias, "20": _transferencias(_token())})

    saldos, sinLeer = lector.saldosTokens(_MIA, 40, 100)

    assert sinLeer == 0
    assert [(s.simbolo, s.cantidad) for s in saldos] == [("TWT", Decimal(1))]
    assert saldos[0].contrato == "0x4b0f1812e5df2a09796481ff14017e6005508003"
    assert saldos[0].ultimoMovimiento.timestamp() == 1610380207


def testUnTokenFueraDelHistorialNoSeInventaLaFecha():
    tenencias = {"result": {"totalCount": "0x1", "details": [
        {"tokenAddress": "0xabc", "tokenName": "X", "tokenSymbol": "XXX", "tokenDecimails": "0x12",
         "tokenBalance": "0x1"},
    ]}}
    lector, _ = _lector({"nr_getTokenHoldings": tenencias, "20": _transferencias()})

    assert lector.saldosTokens(_MIA, 40, 100)[0][0].ultimoMovimiento is None


def testLosTokensQueNoCabenSeCuentanComoSinLeer():
    detalle = {"tokenAddress": "0xabc", "tokenName": "X", "tokenSymbol": "XXX", "tokenDecimails": "0x12",
               "tokenBalance": "0x1"}
    lector, _ = _lector({"nr_getTokenHoldings": {"result": {"totalCount": "0x5", "details": [detalle] * 3}},
                         "20": _transferencias()})

    saldos, sinLeer = lector.saldosTokens(_MIA, 2, 100)

    assert len(saldos) == 2
    assert sinLeer == 3


def testSinClaveLoDiceSinLlamar():
    def obtener(*a, **k):
        pytest.fail("no debe llamar")

    lector = bc.LectorBnbNodeReal(obtenerJson=obtener)
    with pytest.MonkeyPatch.context() as parche:
        parche.setattr(bc, "readNodeRealApiKey", lambda: None)
        with pytest.raises(bc.ErrorLecturaWallet, match="Falta la clave de NodeReal"):
            lector.saldo("direccion", _MIA)


def testUnErrorEnElCuerpoQuedaEnElEstado():
    lector, _ = _lector({"eth_getBalance": {"error": {"code": -32005, "message": "Too many requests"}}})

    with pytest.raises(bc.ErrorLecturaWallet, match="Too many requests"):
        lector.saldo("direccion", _MIA)

    assert lastApiResults()[bc.ESTADO_BNB]["estado"] == "limite"


def testUnaClaveRechazadaLoDiceSinEnseñarLaUrl():
    """NodeReal lleva la clave en la ruta: nunca debe llegar a un mensaje."""
    def obtener(url, **_):
        raise HTTPError(url, 401, "Unauthorized", {}, None)

    lector = bc.LectorBnbNodeReal(apiKey=_CLAVE, obtenerJson=obtener)

    with pytest.raises(bc.ErrorLecturaWallet) as error:
        lector.saldo("direccion", _MIA)

    assert "rechaza la clave" in str(error.value)
    assert _CLAVE not in str(error.value)


def testUnaRespuestaNoJsonNoDejaLaClaveEnElLog(caplog):
    from providers import http

    class Respuesta:
        def read(self, _):
            return b"<html>mantenimiento</html>"

    with caplog.at_level("WARNING", logger=http.log.name), pytest.raises(http.ProviderResponseError):
        http._readJson(Respuesta(), bc.urlNodeReal(_CLAVE))

    assert "bsc-mainnet.nodereal.io" in caplog.text
    assert _CLAVE not in caplog.text


def testLaClaveNoPuedeCambiarLaRutaDeLaUrl():
    assert bc.urlNodeReal("a/../b") == "https://bsc-mainnet.nodereal.io/v1/a%2F..%2Fb"


# ── Filas separadas ──────────────────────────────────────────────────────────

_AVISO_BNB = {"status": "0", "message": "NOTOK",
              "result": "Free API access is not supported for this chain. Please upgrade your api plan."}


def _etherscanQueNoCubreBnb(url, params=None, **_):
    return _AVISO_BNB if (params or {}).get("chainid") == 56 else {"status": "1", "result": "0"}


@pytest.fixture
def conClaves(monkeypatch):
    from stores import app_data

    for lector in ("readFinnhubApiKey", "readEodhdApiKey", "readAlphaVantageApiKey", "readEtherscanApiKey",
                   "readNodeRealApiKey"):
        monkeypatch.setattr(app_data, lector, lambda: _CLAVE)
    for lector in ("readFinnhubApiKeys", "readEodhdApiKeys", "readAlphaVantageApiKeys"):
        monkeypatch.setattr(app_data, lector, lambda: [_CLAVE])
    monkeypatch.setattr(bc, "readEtherscanApiKey", lambda: _CLAVE)


def _porId(datos: dict) -> dict:
    return {fila["id"]: fila for fila in datos["proveedores"]}


def testUnFalloDeBnbNoMarcaEthereumComoFallido(monkeypatch, conClaves):
    monkeypatch.setattr(estado, "fetchJson", _etherscanQueNoCubreBnb)

    filas = _porId(estado.obtener(forzar=True))

    assert filas["etherscan"]["estado"] == "ok"
    assert filas["bnb"]["estado"] == "plan"


def testLasLecturasRealesAnotanCadaRedEnSuFila():
    def obtener(url, params=None, **_):
        return _AVISO_BNB

    with pytest.raises(bc.ErrorLecturaWallet):
        bc.LectorEvm("bnb", apiKey=_CLAVE, obtenerJson=obtener).saldo("direccion", _MIA)

    resultados = lastApiResults()
    assert resultados[bc.ESTADO_BNB]["estado"] == "plan"
    assert bc.ESTADO_ETHERSCAN not in resultados


def testHayUnaFilaPorCadaRedSinClave(monkeypatch, conClaves):
    monkeypatch.setattr(estado, "fetchJson", lambda *a, **k: {"c": 1})

    filas = _porId(estado.obtener(forzar=True))

    assert {"esplora", "solana", "xrpl"} <= set(filas)
    assert {filas[i]["estado"] for i in ("esplora", "solana", "xrpl")} == {"ok"}


def testSiBitcoinTiraDelRespaldoSeDice(monkeypatch, conClaves):
    from core import settings

    # URLs fijas: las de verdad dependen del config.ini y del entorno.
    monkeypatch.setattr(settings, "walletsEsploraUrl", lambda: "https://principal.test/api")
    monkeypatch.setattr(settings, "walletsEsploraUrlRespaldo", lambda: "https://respaldo.test/api")

    def obtener(url, params=None, **_):
        if "principal.test" in url:
            raise HTTPError(url, 503, "caido", {}, None)
        return 900000

    monkeypatch.setattr(estado, "fetchJson", obtener)

    fila = _porId(estado.obtener(forzar=True))["esplora"]

    assert fila["estado"] == "ok"
    assert "respaldo.test" in fila["motivo"]
    assert "principal.test" in fila["motivo"]


def testSiCaenLasDosEsplorasLaFilaLoDice(monkeypatch, conClaves):
    def obtener(url, params=None, **_):
        if "/blocks/tip/height" in url:
            raise HTTPError(url, 503, "caido", {}, None)
        return {"c": 1}

    monkeypatch.setattr(estado, "fetchJson", obtener)

    assert _porId(estado.obtener(forzar=True))["esplora"]["estado"] == "caido"


def testElLectorDeBitcoinAvisaSiRespondeElRespaldo(monkeypatch):
    monkeypatch.setattr(bc, "esperarTurnoEsplora", lambda *a, **k: None)
    bc.olvidarEsploraCaidas()

    def obtener(url, **_):
        if url.startswith("https://principal.test"):
            raise HTTPError(url, 503, "caido", {}, None)
        return "ok"

    lector = bc.LectorBitcoin(baseUrl="https://principal.test", respaldoUrl="https://respaldo.test",
                              obtenerJson=obtener)
    lector._get("ruta")
    bc.olvidarEsploraCaidas()

    assert "respaldo.test" in lastApiResults()[bc.ESTADO_ESPLORA]["detalle"]


def testUnLimiteDelRpcDeSolanaLlegaASuFila(monkeypatch, conClaves):
    def obtener(url, params=None, jsonBody=None, **_):
        if jsonBody and jsonBody.get("method") == "getHealth":
            return {"error": {"code": 429, "message": "Too many requests from your IP"}}
        return {"c": 1}

    monkeypatch.setattr(estado, "fetchJson", obtener)

    fila = _porId(estado.obtener(forzar=True))["solana"]

    assert (fila["estado"], fila["etiqueta"]) == ("limite", "Limitada")
    assert "IP" in fila["motivo"]


def testXrplConErrorEnElCuerpoLlegaASuFila():
    def obtener(url, params=None, jsonBody=None, **_):
        return {"result": {"status": "error", "error": "slowDown"}}

    with pytest.raises(bc.ErrorLecturaWallet):
        bc.LectorXrp(rpcUrl="https://xrpl.test", obtenerJson=obtener).saldo("direccion", "rCuenta")

    assert lastApiResults()[bc.ESTADO_XRPL]["estado"] == "limite"


def testUnaCuentaXrpSinActivarNoCuentaComoFallo():
    def obtener(url, params=None, jsonBody=None, **_):
        return {"result": {"status": "error", "error": "actNotFound"}}

    assert bc.LectorXrp(rpcUrl="https://xrpl.test", obtenerJson=obtener).saldo("direccion", "rCuenta") == 0
    assert bc.ESTADO_XRPL not in lastApiResults()


# ── Mensajes ─────────────────────────────────────────────────────────────────

def testElFueraDePlanDeBnbDiceQueHacer(monkeypatch, conClaves):
    monkeypatch.setattr(estado, "fetchJson", _etherscanQueNoCubreBnb)

    fila = _porId(estado.obtener(forzar=True))["bnb"]

    assert "plan gratuito" in fila["motivo"]
    assert "Ethereum sigue funcionando" in fila["motivo"]
    assert "NodeReal" in fila["motivo"]
    assert "Free API" in fila["detalle"]


def testElErrorDeLaWalletDeBnbTambienDiceQueHacer():
    with pytest.raises(bc.ErrorLecturaWallet) as error:
        bc.LectorEvm("bnb", apiKey=_CLAVE, obtenerJson=lambda *a, **k: _AVISO_BNB).saldo("direccion", _MIA)

    assert "NodeReal" in str(error.value)
    assert "Free API" in str(error.value)


def testFueraDePlanEnEtherscanDiceQueFilaLoAnota():
    with pytest.raises(bc.ErrorFueraDePlan) as error:
        bc.LectorEvm("bnb", apiKey=_CLAVE, obtenerJson=lambda *a, **k: _AVISO_BNB).saldo("direccion", _MIA)

    assert error.value.fila == bc.ESTADO_BNB


def testFueraDePlanEnNodeRealDiceQueFilaLoAnota():
    lector, _ = _lector({"eth_getBalance": {"error": {"message": "method not supported on your plan"}}})

    with pytest.raises(bc.ErrorFueraDePlan) as error:
        lector.saldo("direccion", _MIA)

    assert error.value.fila == bc.ESTADO_BNB
    assert lastApiResults()[bc.ESTADO_BNB]["estado"] == "plan"


def testUnLimiteDeEtherscanNoCuentaComoFueraDePlan():
    limite = {"status": "0", "message": "NOTOK", "result": "Max calls per sec rate limit reached"}

    with pytest.raises(bc.ErrorLecturaWallet) as error:
        bc.LectorEvm("bnb", apiKey=_CLAVE, obtenerJson=lambda *a, **k: limite).saldo("direccion", _MIA)

    assert not isinstance(error.value, bc.ErrorFueraDePlan)


def testElAvisoDePlanEnEthereumNoMandaACambiarLaApiDeBnb():
    with pytest.raises(bc.ErrorLecturaWallet) as error:
        bc.LectorEvm("eth", apiKey=_CLAVE, obtenerJson=lambda *a, **k: _AVISO_BNB).saldo("direccion", _MIA)

    assert "NodeReal" not in str(error.value)


@pytest.mark.parametrize("detalle, etiqueta, texto", [
    ("Max calls per sec rate limit reached (3/sec)", "Frenada", "por segundo"),
    ("Max daily rate limit reached", "Cuota agotada", "cuota"),
    ("HTTP 402", "Cuota agotada", "cuota"),
])
def testCadaLimiteDeUnaClaveSeExplicaDistinto(detalle, etiqueta, texto):
    recordApiResult(bc.ESTADO_ETHERSCAN, "limite", detalle)

    with pytest.MonkeyPatch.context() as parche:
        from stores import app_data
        parche.setattr(app_data, "readEtherscanApiKey", lambda: _CLAVE)
        fila = _porId(estado.obtener())["etherscan"]

    assert fila["etiqueta"] == etiqueta
    assert texto in fila["motivo"]


def testUnServicioSinCuentaNoDiceCuotaAgotada():
    recordApiResult(bc.ESTADO_ESPLORA, "limite", "HTTP 429")

    fila = _porId(estado.obtener())["esplora"]

    assert fila["etiqueta"] == "Limitada"
    assert "cuota" not in fila["motivo"].lower()


@pytest.mark.parametrize("idFila, texto", [
    ("etherscan", "plan gratuito no incluye BNB"),
    ("solana", "tokens SPL no se leen"),
    ("xrpl", "otras divisas"),
])
def testCadaFilaDiceQueCubre(idFila, texto):
    assert texto in _porId(estado.obtener())[idFila]["cubre"]


def testLaFilaDeBnbOfreceElegirApi():
    fila = _porId(estado.obtener())["bnb"]

    assert [o["id"] for o in fila["opciones"]] == ["etherscan", "nodereal"]
    assert fila["seleccion"] == "etherscan"
    assert "Etherscan" in fila["cubre"]


def testConNodeRealSinClaveLaFilaLoDice(monkeypatch):
    from stores import app_data

    _elegir("nodereal")
    monkeypatch.setattr(app_data, "readNodeRealApiKey", lambda: None)

    fila = _porId(estado.obtener())["bnb"]

    assert fila["estado"] == "sin_clave"
    assert "nodereal.io" in fila["motivo"]
    assert "NodeReal" in fila["cubre"]


def testComprobarNodeRealPruebaElHistorialYNoEnseñaLaClave(monkeypatch, conClaves):
    _elegir("nodereal")
    llamadas = []

    def obtener(url, params=None, jsonBody=None, **_):
        llamadas.append((url, jsonBody))
        if "nodereal" in url:
            return {"error": {"message": "method not supported on your plan"}}
        return {"c": 1}

    monkeypatch.setattr(estado, "fetchJson", obtener)

    fila = _porId(estado.obtener(forzar=True))["bnb"]

    assert fila["estado"] == "plan"
    assert _CLAVE not in json.dumps(fila)
    cuerpos = [cuerpo for url, cuerpo in llamadas if "nodereal" in url]
    assert cuerpos[0]["method"] == "nr_getTransactionByAddress"


def testOlvidarUnResultadoDejaLaFilaSinDatos():
    recordApiResult(bc.ESTADO_BNB, "plan", "viejo")

    api_stats.olvidarApiResult(bc.ESTADO_BNB)

    assert bc.ESTADO_BNB not in lastApiResults()


# ── Rutas ────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    monkeypatch.setattr(paths, "AJUSTES_JSON", datosAislados["ajustes"])
    proveedor_bnb._cache["mtime"] = None
    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, cabeceras, datosAislados


def testElegirApiDeBnbSeGuardaYLoVeLaFila(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post("/api/settings/bnb-proveedor", json={"proveedor": "nodereal"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert proveedor_bnb.actual() == "nodereal"
    filas = _porId(client.get("/api/stats/api-estado").get_json())
    assert filas["bnb"]["seleccion"] == "nodereal"


def testGuardarOtrosAjustesNoPierdeLaApiDeBnb(cliente):
    client, cabeceras, _rutas = cliente
    client.post("/api/settings/bnb-proveedor", json={"proveedor": "nodereal"}, headers=cabeceras)

    client.post("/api/settings", json={"monedaBase": "USD"}, headers=cabeceras)
    proveedor_bnb._cache["mtime"] = None

    assert proveedor_bnb.actual() == "nodereal"


def testUnaApiDesconocidaSeRechazaSinGuardar(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post("/api/settings/bnb-proveedor", json={"proveedor": "inventada"}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert proveedor_bnb.actual() == proveedor_bnb.POR_DEFECTO


def testCambiarDeApiOlvidaElFalloDeLaAnterior(cliente):
    """El «Fuera del plan» era de Etherscan: no debe quedarse pegado a NodeReal."""
    client, cabeceras, _rutas = cliente
    recordApiResult(bc.ESTADO_BNB, "plan", "viejo")

    client.post("/api/settings/bnb-proveedor", json={"proveedor": "nodereal"}, headers=cabeceras)

    assert bc.ESTADO_BNB not in lastApiResults()


@pytest.mark.parametrize("campo", ["etherscanKey", "noderealKey"])
def testGuardarOtraClaveOlvidaElFalloDePlanDeBnb(cliente, campo):
    """Es lo que levanta la pausa de la vigilancia sin esperar al reintento diario."""
    client, cabeceras, _rutas = cliente
    recordApiResult(bc.ESTADO_BNB, "plan", "de la clave anterior")

    respuesta = client.post("/api/settings/apikey", json={campo: "K7XQ2M9R4TB8VN3P"}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert bc.ESTADO_BNB not in lastApiResults()


def testLaClaveDeNodeRealSeSustituyeYLaUsanLasWallets(cliente):
    from stores.app_data import readNodeRealApiKey

    client, cabeceras, rutas = cliente
    for clave in ("PRIMERA1", "SEGUNDA2"):
        respuesta = client.post("/api/settings/apikey", json={"noderealKey": clave}, headers=cabeceras)
        assert respuesta.status_code == 200

    assert respuesta.get_json()["noderealKeys"] == 1
    assert readNodeRealApiKey() == "SEGUNDA2"
    assert b"SEGUNDA2" not in (rutas["claves"] / "nodereal.key").read_bytes()


@pytest.mark.parametrize("clave", ["a/../b", "no vale;", "x" * 201])
def testUnaClaveDeNodeRealRaraSeRechaza(cliente, clave):
    """Va en la ruta de la URL: una barra cambiaría a dónde se llama."""
    client, cabeceras, rutas = cliente

    respuesta = client.post("/api/settings/apikey", json={"noderealKey": clave}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == "noderealKey"
    assert not (rutas["claves"] / "nodereal.key").exists()


def testLaClaveDeNodeRealSeListaEnmascaradaYSePuedeBorrar(cliente):
    client, cabeceras, _rutas = cliente
    client.post("/api/settings/apikey", json={"noderealKey": "K7XQ2M9R4TB8VN3P"}, headers=cabeceras)

    info = client.get("/api/settings/apikeys").get_json()["proveedores"]["nodereal"]
    assert "K7XQ2M9R4TB8VN3P" not in json.dumps(info)

    respuesta = client.delete("/api/settings/apikey", json={"proveedor": "nodereal", "huella": info["claves"][0]["huella"]},
                              headers=cabeceras)

    assert respuesta.status_code == 200
    assert client.get("/api/settings/apikeys").get_json()["proveedores"]["nodereal"]["claves"] == []
