"""Pruebas de los lectores on-chain con respuestas simuladas.

Ninguna prueba sale a la red: cada lector recibe un `obtenerJson` falso que
devuelve respuestas con la forma documentada de cada API.
"""

import hashlib
from datetime import datetime, timezone
from decimal import Decimal
from urllib.error import HTTPError, URLError

import pytest

from providers import blockchain_clients as bc

_BIP84_ZPUB = (
    "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"
)
_RECEPCION0 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu"
_CAMBIO0 = "bc1q8c6fshw2dlwun7ekn9qwf37cu2rn755upcp6el"
_AJENA = "bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g"
_EVM = "0x" + "a" * 40
_OTRA_EVM = "0x" + "b" * 40


def _txBtc(txid, entradas, salidas, fee=0, tiempo=1_700_000_000):
    return {
        "txid": txid, "fee": fee, "status": {"confirmed": True, "block_time": tiempo},
        "vin": [{"prevout": {"scriptpubkey_address": d, "value": v}} for d, v in entradas],
        "vout": [{"scriptpubkey_address": d, "value": v} for d, v in salidas],
    }


class EsploraFalsa:
    """Esplora con un historial fijo por dirección; el resto, sin uso."""

    def __init__(self, historial):
        self.historial = historial
        self.consultadas = []

    def __call__(self, url, params=None, **_):
        direccion = url.split("/api/", 1)[1].split("/")[1]
        self.consultadas.append(direccion)
        return self.historial.get(direccion, [])


def testBitcoinXpubExploraHastaElGapYClasificaLosMovimientos():
    recibida = _txBtc("t1", [(_AJENA, 150_000)], [(_RECEPCION0, 100_000), (_AJENA, 49_000)], fee=1000, tiempo=1)
    enviada = _txBtc("t2", [(_RECEPCION0, 100_000)], [(_AJENA, 60_000), (_CAMBIO0, 39_500)], fee=500, tiempo=2)
    esplora = EsploraFalsa({_RECEPCION0: [recibida, enviada], _CAMBIO0: [enviada]})
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", gapLimit=3, obtenerJson=esplora)

    movimientos = lector.leer("xpub", _BIP84_ZPUB, 100)

    assert [m.hash for m in movimientos] == ["t2", "t1"]
    salida, entrada = movimientos
    assert (salida.tipo, salida.cantidad, salida.comision, salida.contraparte) == (
        bc.ENVIADA, Decimal("0.0006"), Decimal("0.000005"), _AJENA)
    assert (entrada.tipo, entrada.cantidad, entrada.comision, entrada.contraparte) == (
        bc.RECIBIDA, Decimal("0.001"), None, _AJENA)
    assert entrada.fecha == datetime(1970, 1, 1, 0, 0, 1, tzinfo=timezone.utc)
    # Una llamada por dirección: recepción 0 usada + 3 sin uso; cambio igual.
    assert len(esplora.consultadas) == 8
    assert esplora.consultadas.count(_AJENA) == 1


def testBitcoinEntreDireccionesPropias():
    tx = _txBtc("t3", [(_RECEPCION0, 10_000)], [(_CAMBIO0, 9_000)], fee=1000)

    movimiento = bc.LectorBitcoin._normalizar(tx, {_RECEPCION0, _CAMBIO0})

    assert (movimiento.tipo, movimiento.cantidad, movimiento.comision) == (bc.ENTRE_WALLETS, Decimal("0.00009"), Decimal("0.00001"))


def testBitcoinGastarloTodoEnComisionEsUnaEnviadaNoEntreWallets():
    tx = _txBtc("t4", [(_RECEPCION0, 16_734)], [(None, 0)], fee=16_734)

    movimiento = bc.LectorBitcoin._normalizar(tx, {_RECEPCION0})

    assert (movimiento.tipo, movimiento.cantidad, movimiento.comision, movimiento.contraparte) == (
        bc.ENVIADA, Decimal("0"), Decimal("0.00016734"), "")


def testBitcoinPaginaYDescartaLasNoConfirmadas():
    pagina1 = [_txBtc(f"a{i}", [], [("x", 1)]) for i in range(25)]
    pendiente = {**_txBtc("p", [], [("x", 1)]), "status": {"confirmed": False}}
    pagina2 = [_txBtc("b0", [], [("x", 1)])]
    rutas = []

    def obtener(url, params=None, **_):
        rutas.append(url)
        return [pendiente, *pagina1] if url.endswith("/txs") else pagina2

    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=obtener)
    usada, txs = lector._historial("x", 100)

    assert usada is True
    assert [t["txid"] for t in txs] == [f"a{i}" for i in range(25)] + ["b0"]
    assert rutas[1].endswith("/txs/chain/a24")


def testUnaDireccionSoloConPendientesCuentaComoUsada():
    pendiente = {**_txBtc("p", [], [("x", 1)]), "status": {"confirmed": False}}
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=lambda *a, **k: [pendiente])

    assert lector._historial("x", 100) == (True, [])


def _utxoEsplora(txid, valor, altura=None, vout=0):
    estado = {"confirmed": altura is not None}
    if altura is not None:
        estado.update(block_height=altura, block_time=1_700_000_000)
    return {"txid": txid, "vout": vout, "value": valor, "status": estado}


def _estadisticasEsplora(recibidas=0, gastadas=0, pendientesRecibidas=0, pendientesGastadas=0):
    return {
        "chain_stats": {"tx_count": recibidas + gastadas, "funded_txo_count": recibidas, "spent_txo_count": gastadas},
        "mempool_stats": {"tx_count": pendientesRecibidas + pendientesGastadas,
                          "funded_txo_count": pendientesRecibidas, "spent_txo_count": pendientesGastadas},
    }


class EsploraUtxos:
    """Esplora para el visor de UTXOs: estadísticas y UTXOs fijos por dirección."""

    def __init__(self, estadisticas=None, utxos=None, altura=870_000):
        self.estadisticas = estadisticas or {}
        self.utxos = utxos or {}
        self.altura = altura
        self.rutas = []

    def __call__(self, url, params=None, **_):
        ruta = url.split("/api/", 1)[1]
        self.rutas.append(ruta)
        if ruta == "blocks/tip/height":
            return self.altura
        direccion = ruta.split("/")[1]
        if ruta.endswith("/utxo"):
            return self.utxos.get(direccion, [])
        return self.estadisticas.get(direccion, _estadisticasEsplora())


def testUtxosDeUnaDireccionOrdenadosConLosPendientes():
    esplora = EsploraUtxos(utxos={_AJENA: [
        _utxoEsplora("a", 1_000, altura=800_000),
        _utxoEsplora("b", 50_000, altura=860_000, vout=3),
        _utxoEsplora("c", 7_000),
    ]})
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=esplora)

    utxos, altura = lector.utxos("direccion", _AJENA)

    assert altura == 870_000
    assert [(u.txid, u.satoshis, u.altura) for u in utxos] == [("b", 50_000, 860_000), ("c", 7_000, None), ("a", 1_000, 800_000)]
    assert utxos[0].vout == 3
    assert utxos[0].cantidad == Decimal("0.0005")
    assert utxos[0].fecha == datetime.fromtimestamp(1_700_000_000, timezone.utc)
    assert utxos[1].fecha is None
    assert {u.direccion for u in utxos} == {_AJENA}


def testUtxosDeUnaXpubSoloPidenLasDireccionesConSalidas():
    esplora = EsploraUtxos(
        estadisticas={
            # Recepción 0 se vació del todo; cambio 0 conserva una salida.
            _RECEPCION0: _estadisticasEsplora(recibidas=1, gastadas=1),
            _CAMBIO0: _estadisticasEsplora(recibidas=1),
        },
        utxos={_CAMBIO0: [_utxoEsplora("t2", 39_500, altura=869_990, vout=1)]},
    )
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", gapLimit=3, obtenerJson=esplora)

    utxos, _altura = lector.utxos("xpub", _BIP84_ZPUB)

    assert [(u.txid, u.direccion) for u in utxos] == [("t2", _CAMBIO0)]
    assert [r for r in esplora.rutas if r.endswith("/utxo")] == [f"address/{_CAMBIO0}/utxo"]


def testUtxoSoloEnLaMempoolCuentaComoSalida():
    esplora = EsploraUtxos(estadisticas={_RECEPCION0: _estadisticasEsplora(pendientesRecibidas=1)})
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", gapLimit=1, obtenerJson=esplora)

    lector.utxos("xpub", _BIP84_ZPUB)

    assert f"address/{_RECEPCION0}/utxo" in esplora.rutas


def testUtxosDescartaEntradasConFormaRara():
    esplora = EsploraUtxos(utxos={_AJENA: ["basura", {"vout": 0}, _utxoEsplora("ok", 10, altura=1)]})
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=esplora)

    assert [u.txid for u in lector.utxos("direccion", _AJENA)[0]] == ["ok"]


@pytest.mark.parametrize("utxos, altura", [({_AJENA: {"error": "x"}}, 1), ({}, "870000"), ({}, True)])
def testUtxosConRespuestaInesperadaEsUnError(utxos, altura):
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=EsploraUtxos(utxos=utxos, altura=altura))

    with pytest.raises(bc.ErrorLecturaWallet, match="inesperada"):
        lector.utxos("direccion", _AJENA)


def testElPlazoCortaLasLlamadasSiguientes(monkeypatch):
    reloj = iter([0.0, 5.0, 11.0])
    monkeypatch.setattr(bc.time, "monotonic", lambda: next(reloj))
    obtener = bc.conPlazo(lambda *a, **k: "ok", 10)

    assert obtener() == "ok"
    with pytest.raises(bc.ErrorLecturaWallet, match="plazo_segundos"):
        obtener()


def testUnaUrlNoHttpSeRechaza():
    with pytest.raises(bc.ErrorLecturaWallet, match="config.ini"):
        bc.LectorBitcoin(baseUrl="file:///etc/passwd", obtenerJson=lambda *a, **k: {}).leer("direccion", _AJENA, 10)


def _etherscan(txlist, tokentx):
    def obtener(url, params=None, **_):
        datos = txlist if params["action"] == "txlist" else tokentx
        if not datos:
            return {"status": "0", "message": "No transactions found", "result": []}
        return {"status": "1", "message": "OK", "result": datos}
    return obtener


def testEvmNativoYTokens():
    txlist = [
        {"hash": "0x1", "timeStamp": "200", "from": _OTRA_EVM, "to": _EVM, "value": str(10**18), "isError": "0",
         "gasUsed": "21000", "gasPrice": "1000000000"},
        {"hash": "0x2", "timeStamp": "300", "from": _EVM, "to": _OTRA_EVM, "value": str(5 * 10**17), "isError": "0",
         "gasUsed": "21000", "gasPrice": "1000000000"},
        {"hash": "0x3", "timeStamp": "400", "from": _EVM, "to": _OTRA_EVM, "value": "0", "isError": "0",
         "gasUsed": "50000", "gasPrice": "1000000000"},
        {"hash": "0x4", "timeStamp": "500", "from": _EVM, "to": _OTRA_EVM, "value": "1", "isError": "1",
         "gasUsed": "21000", "gasPrice": "1"},
    ]
    tokentx = [
        {"hash": "0x3", "timeStamp": "400", "from": _EVM, "to": _OTRA_EVM, "value": "2500000", "tokenSymbol": "USDC",
         "tokenDecimal": "6", "contractAddress": "0xC0FFEE", "gasUsed": "50000", "gasPrice": "1000000000"},
        {"hash": "0x5", "timeStamp": "600", "from": _OTRA_EVM, "to": _EVM, "value": "0", "tokenSymbol": "USDC",
         "tokenDecimal": "6", "contractAddress": "0xfa4e"},
    ]
    lector = bc.LectorEvm("eth", apiKey="CLAVE", obtenerJson=_etherscan(txlist, tokentx))

    movimientos = lector.leer("direccion", _EVM, 100)

    assert [(m.hash, m.simbolo, m.tipo) for m in movimientos] == [
        ("0x3", "USDC", bc.ENVIADA), ("0x2", "ETH", bc.ENVIADA), ("0x1", "ETH", bc.RECIBIDA),
    ]
    token, enviada, recibida = movimientos
    assert token.cantidad == Decimal("2.5") and token.contrato == "0xc0ffee"
    assert "0.00005 ETH" in token.nota
    assert enviada.comision == Decimal("0.000021")
    assert recibida.comision is None and recibida.contraparte == _OTRA_EVM


def testComisionTxYDireccionPropiaSeRellenanAunqueLaComisionLaPagueOtro():
    """La recibida no suma comisión, pero la de la transacción se ve igual."""
    recibida = _txBtc("t1", [(_AJENA, 150_000)], [(_RECEPCION0, 100_000), (_AJENA, 49_000)], fee=1000)
    enviada = _txBtc("t2", [(_RECEPCION0, 100_000)], [(_AJENA, 60_000), (_CAMBIO0, 39_500)], fee=500)
    propias = {_RECEPCION0, _CAMBIO0}

    entrada = bc.LectorBitcoin._normalizar(recibida, propias)
    salida = bc.LectorBitcoin._normalizar(enviada, propias)

    assert (entrada.comision, entrada.comisionTx, entrada.propia) == (None, Decimal("0.00001"), _RECEPCION0)
    assert (salida.comision, salida.comisionTx, salida.propia) == (
        Decimal("0.000005"), Decimal("0.000005"), _RECEPCION0)

    txEvm = {"hash": "0x1", "timeStamp": "200", "from": _OTRA_EVM, "to": _EVM, "value": "1", "isError": "0",
             "gasUsed": "21000", "gasPrice": "1000000000"}
    evm = bc.LectorEvm("eth", apiKey="CLAVE")._normalizarNativo(txEvm, _EVM, "ETH")
    assert (evm.comision, evm.comisionTx, evm.propia) == (None, Decimal("0.000021"), _EVM)


def testEvmSinClaveDaUnErrorClaro(monkeypatch):
    monkeypatch.setattr(bc, "readEtherscanApiKey", lambda: None)

    with pytest.raises(bc.ErrorLecturaWallet, match="clave de Etherscan"):
        bc.LectorEvm("bnb", obtenerJson=_etherscan([], [])).leer("direccion", _EVM, 10)


def testEvmPropagaElMensajeDeEtherscan():
    def obtener(url, params=None, **_):
        return {"status": "0", "message": "NOTOK", "result": "Invalid API Key"}

    with pytest.raises(bc.ErrorLecturaWallet, match="Invalid API Key"):
        bc.LectorEvm("eth", apiKey="X", obtenerJson=obtener).leer("direccion", _EVM, 10)


def testUn429SeTraduceSinDatosDeLaPeticion():
    def obtener(url, params=None, **_):
        raise HTTPError(url, 429, "Too Many Requests", {}, None)

    with pytest.raises(bc.ErrorLecturaWallet) as error:
        bc.LectorEvm("eth", apiKey="SECRETA", obtenerJson=obtener).leer("direccion", _EVM, 10)
    assert "limitado" in str(error.value)
    assert "SECRETA" not in str(error.value) and _EVM not in str(error.value)


_SOL = "So1aDirecc1onPropiaXXXXXXXXXXXXXXXXXXXXXXXX"
_SOL_OTRA = "OtraDirecc1onXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"


def _txSol(claves, pre, post, fee=5000, tiempo=1000, err=None):
    return {"blockTime": tiempo, "meta": {"err": err, "fee": fee, "preBalances": pre, "postBalances": post},
            "transaction": {"message": {"accountKeys": [{"pubkey": c} for c in claves]}}}


def testSolanaEnviadaPagandoComisionYRecibida():
    enviada = _txSol([_SOL, _SOL_OTRA], [10_000_000_000, 0], [8_999_995_000, 1_000_000_000])
    recibida = _txSol([_SOL_OTRA, _SOL], [5_000_000_000, 0], [2_999_995_000, 2_000_000_000])
    respuestas = {
        "getSignaturesForAddress": [{"signature": "s1", "err": None}, {"signature": "s2", "err": None},
                                    {"signature": "sx", "err": {"fallo": 1}}],
    }
    porFirma = {"s1": enviada, "s2": recibida}

    def obtener(url, params=None, jsonBody=None, **_):
        if isinstance(jsonBody, list):
            return [{"id": p["id"], "result": porFirma[p["params"][0]]} for p in jsonBody]
        return {"result": respuestas[jsonBody["method"]]}

    movimientos = bc.LectorSolana(rpcUrl="https://sol.test", obtenerJson=obtener).leer("direccion", _SOL, 100)

    assert [(m.hash, m.tipo, m.cantidad, m.comision, m.contraparte) for m in movimientos] == [
        ("s1", bc.ENVIADA, Decimal("1"), Decimal("0.000005"), _SOL_OTRA),
        ("s2", bc.RECIBIDA, Decimal("2"), None, _SOL_OTRA),
    ]


def testSolanaSinLotesPideUnaAUna():
    tx = _txSol([_SOL_OTRA, _SOL], [10, 0], [5, 5])
    llamadas = []

    def obtener(url, params=None, jsonBody=None, **_):
        llamadas.append(jsonBody)
        if isinstance(jsonBody, list):
            return {"error": {"message": "batch no soportado"}}
        if jsonBody["method"] == "getSignaturesForAddress":
            return {"result": [{"signature": "s1", "err": None}]}
        return {"result": tx}

    movimientos = bc.LectorSolana(rpcUrl="https://sol.test", obtenerJson=obtener).leer("direccion", _SOL, 100)

    assert [m.cantidad for m in movimientos] == [Decimal("0.000000005")]
    assert llamadas[-1]["method"] == "getTransaction"


_XRP = "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"
_XRP_OTRA = "rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe"


def testXrpPagosYDescartes():
    def entrada(origen, destino, importe, resultado="tesSUCCESS", tipo="Payment"):
        return {"tx": {"TransactionType": tipo, "Account": origen, "Destination": destino, "Amount": importe,
                       "Fee": "12", "date": 0, "hash": f"H{len(str(importe))}{origen[:3]}"},
                "meta": {"TransactionResult": resultado, "delivered_amount": importe}}

    transacciones = [
        entrada(_XRP, _XRP_OTRA, "1500000"),
        entrada(_XRP_OTRA, _XRP, "2000000"),
        entrada(_XRP_OTRA, _XRP, {"currency": "USD", "value": "5"}),
        entrada(_XRP, _XRP_OTRA, "1", resultado="tecPATH_DRY"),
        entrada(_XRP, _XRP_OTRA, "1", tipo="OfferCreate"),
    ]

    def obtener(url, params=None, jsonBody=None, **_):
        return {"result": {"status": "success", "transactions": transacciones}}

    movimientos = bc.LectorXrp(rpcUrl="https://xrpl.test", obtenerJson=obtener).leer("direccion", _XRP, 100)

    assert [(m.tipo, m.cantidad, m.comision) for m in movimientos] == [
        (bc.ENVIADA, Decimal("1.5"), Decimal("0.000012")), (bc.RECIBIDA, Decimal("2"), None),
    ]
    assert movimientos[0].fecha == datetime(2000, 1, 1, tzinfo=timezone.utc)


def testEvmComisionesSinMovimientoDeLaMoneda():
    gas = {"gasUsed": "50000", "gasPrice": "1000000000", "isError": "0"}
    txlist = [
        {**gas, "hash": "0xmueve", "timeStamp": "1", "from": _EVM, "to": _OTRA_EVM, "value": "5"},
        {**gas, "hash": "0xaprobar", "timeStamp": "2", "from": _EVM, "to": _OTRA_EVM, "value": "0"},
        {**gas, "hash": "0xfallida", "timeStamp": "3", "from": _EVM, "to": _OTRA_EVM, "value": "9", "isError": "1"},
        {**gas, "hash": "0xajena", "timeStamp": "4", "from": _OTRA_EVM, "to": _EVM, "value": "0"},
    ]
    lector = bc.LectorEvm("eth", apiKey="CLAVE", obtenerJson=_etherscan(txlist, []))

    movimientos, comisiones = lector.leerConComisiones("direccion", _EVM, 100)

    assert [m.hash for m in movimientos] == ["0xmueve"]
    assert [(c.hash, c.comision) for c in comisiones] == [
        ("0xaprobar", Decimal("0.00005")), ("0xfallida", Decimal("0.00005")),
    ]


def testEvmUnTokenDeSpamNoInventaComisiones():
    # La transferencia dice que sale de la wallet, pero la transacción la firmó otro.
    tokentx = [{"hash": "0xspam", "timeStamp": "1", "from": _EVM, "to": _OTRA_EVM, "value": "5", "tokenSymbol": "FAKE",
                "tokenDecimal": "0", "contractAddress": "0xfa4e", "gasUsed": "50000", "gasPrice": "1000000000"}]
    lector = bc.LectorEvm("eth", apiKey="CLAVE", obtenerJson=_etherscan([], tokentx))

    assert lector.leerConComisiones("direccion", _EVM, 100)[1] == []


def testSolanaComisionSinMovimientoSoloSiPagaEstaWallet():
    pagada = _txSol([_SOL, _SOL_OTRA], [10_000, 0], [5_000, 0])
    ajena = _txSol([_SOL_OTRA, _SOL], [10_000, 7], [5_000, 7])
    porFirma = {"s1": pagada, "s2": ajena}

    def obtener(url, params=None, jsonBody=None, **_):
        if isinstance(jsonBody, list):
            return [{"id": p["id"], "result": porFirma[p["params"][0]]} for p in jsonBody]
        return {"result": [{"signature": "s1", "err": None}, {"signature": "s2", "err": None}]}

    lector = bc.LectorSolana(rpcUrl="https://sol.test", obtenerJson=obtener)
    movimientos, comisiones = lector.leerConComisiones("direccion", _SOL, 100)

    assert movimientos == []
    assert [(c.hash, c.comision) for c in comisiones] == [("s1", Decimal("0.000005"))]


def testXrpComisionSinMovimientoSoloSiPagaEstaWallet():
    def entrada(origen, hashTx, resultado="tesSUCCESS", tipo="TrustSet"):
        return {"tx": {"TransactionType": tipo, "Account": origen, "Destination": _XRP_OTRA, "Amount": "1",
                       "Fee": "12", "date": 0, "hash": hashTx}, "meta": {"TransactionResult": resultado}}

    transacciones = [
        entrada(_XRP, "H1"),
        entrada(_XRP, "H2", resultado="tecPATH_DRY", tipo="Payment"),
        entrada(_XRP_OTRA, "H3"),
    ]

    def obtener(url, params=None, jsonBody=None, **_):
        return {"result": {"status": "success", "transactions": transacciones}}

    _movimientos, comisiones = bc.LectorXrp(rpcUrl="https://xrpl.test", obtenerJson=obtener).leerConComisiones(
        "direccion", _XRP, 100)

    assert [(c.hash, c.comision) for c in comisiones] == [("H1", Decimal("0.000012")), ("H2", Decimal("0.000012"))]


def testBitcoinNoTieneComisionesSueltas():
    class SoloLeer:
        def leer(self, tipo, valor, limite):
            return ["movimiento"]

    assert bc.leerConComisiones(SoloLeer(), "direccion", _AJENA, 10) == (["movimiento"], [])


def _pagoXrp(amount: str, entregado: str, hashTx: str) -> dict:
    return {"tx": {"TransactionType": "Payment", "Account": _XRP_OTRA, "Destination": _XRP, "Amount": amount,
                   "Fee": "12", "date": 0, "hash": hashTx},
            "meta": {"TransactionResult": "tesSUCCESS", "delivered_amount": entregado}}


def testXrpPagoParcialCuentaLoEntregadoNoLoAnunciado():
    movimiento = bc.LectorXrp._normalizar(_pagoXrp("1000000", "5", "PARCIAL"), _XRP)

    assert movimiento.cantidad == Decimal("0.000005")


def testXrpImporteEntregadoDesconocidoSeOmiteSinRomperLaLectura(caplog):
    transacciones = [_pagoXrp("1000000", "unavailable", "ANTIGUO"), _pagoXrp("2000000", "2000000", "NORMAL")]

    def obtener(url, params=None, jsonBody=None, **_):
        return {"result": {"status": "success", "transactions": transacciones}}

    with caplog.at_level("WARNING", logger=bc.log.name):
        movimientos = bc.LectorXrp(rpcUrl="https://xrpl.test", obtenerJson=obtener).leer("direccion", _XRP, 100)

    assert [m.hash for m in movimientos] == ["NORMAL"]
    assert "ANTIGUO" in caplog.text


def testXrpCuentaSinActivarNoEsUnError():
    def obtener(url, params=None, jsonBody=None, **_):
        return {"result": {"status": "error", "error": "actNotFound"}}

    assert bc.LectorXrp(rpcUrl="https://xrpl.test", obtenerJson=obtener).leer("direccion", _XRP, 10) == []


def testLaFactoriaCubreTodasLasRedes():
    from core.cripto_direcciones import REDES

    for red in REDES:
        assert hasattr(bc.lectorPara(red), "leer")
    with pytest.raises(bc.ErrorLecturaWallet):
        bc.lectorPara("doge")


# ── Saldos ────────────────────────────────────────────────────────────────────


def testSaldoBitcoinDeUnaDireccion():
    def obtener(url, params=None, **_):
        return {"chain_stats": {"tx_count": 3, "funded_txo_sum": 150_000, "spent_txo_sum": 50_000},
                "mempool_stats": {"tx_count": 0}}

    assert bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=obtener).saldo(
        "direccion", _AJENA) == Decimal("0.001")


def testSaldoBitcoinDeUnaXpubSumaLasDireccionesUsadas():
    saldos = {_RECEPCION0: 100_000, _CAMBIO0: 39_500}

    def obtener(url, params=None, **_):
        direccion = url.rsplit("/", 1)[1]
        satoshis = saldos.get(direccion, 0)
        return {"chain_stats": {"tx_count": 1 if satoshis else 0, "funded_txo_sum": satoshis, "spent_txo_sum": 0},
                "mempool_stats": {"tx_count": 0}}

    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", gapLimit=2, obtenerJson=obtener)

    assert lector.saldo("xpub", _BIP84_ZPUB) == Decimal("0.001395")


def testSaldoEvm():
    def obtener(url, params=None, **_):
        assert params["action"] == "balance" and params["chainid"] == 56
        return {"status": "1", "message": "OK", "result": "2500000000000000000"}

    assert bc.LectorEvm("bnb", apiKey="X", obtenerJson=obtener).saldo("direccion", _EVM) == Decimal("2.5")


def testSaldoEvmConErrorDeEtherscan():
    def obtener(url, params=None, **_):
        return {"status": "0", "message": "NOTOK", "result": "Free API access is not supported for this chain"}

    with pytest.raises(bc.ErrorLecturaWallet, match="not supported"):
        bc.LectorEvm("bnb", apiKey="X", obtenerJson=obtener).saldo("direccion", _EVM)


def testSaldoSolana():
    def obtener(url, params=None, jsonBody=None, **_):
        return {"result": {"context": {"slot": 1}, "value": 1_500_000_000}}

    assert bc.LectorSolana(rpcUrl="https://sol.test", obtenerJson=obtener).saldo("direccion", _SOL) == Decimal("1.5")


@pytest.mark.parametrize("respuesta, esperado", [
    ({"result": {"status": "success", "account_data": {"Balance": "25000000"}}}, Decimal("25")),
    ({"result": {"status": "error", "error": "actNotFound"}}, Decimal("0")),
])
def testSaldoXrp(respuesta, esperado):
    lector = bc.LectorXrp(rpcUrl="https://xrpl.test", obtenerJson=lambda *a, **k: respuesta)

    assert lector.saldo("direccion", _XRP) == esperado


def testBitcoinClavePublicaRevisaSusDireccionesYUneElHistorial():
    claveG = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
    segwit = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
    legacy = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
    recibida = _txBtc("t1", [(_AJENA, 60_000)], [(legacy, 50_000)], tiempo=1)
    enviada = _txBtc("t2", [(legacy, 50_000)], [(segwit, 49_000)], fee=1000, tiempo=2)
    esplora = EsploraFalsa({legacy: [recibida, enviada], segwit: [enviada]})
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=esplora)

    movimientos = lector.leer("clave", claveG, 100)

    assert [(m.hash, m.tipo) for m in movimientos] == [("t2", bc.ENTRE_WALLETS), ("t1", bc.RECIBIDA)]
    # Legacy, SegWit compatible, SegWit nativa, Taproot y las dos formas P2PK:
    # una llamada cada una.
    assert len(esplora.consultadas) == 6


def testSaldoBitcoinDeUnaClavePublicaSumaSusDirecciones():
    saldos = {"1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH": 10_000, "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4": 5_000}

    def obtener(url, params=None, **_):
        satoshis = saldos.get(url.rsplit("/", 1)[1], 0)
        return {"chain_stats": {"tx_count": 1, "funded_txo_sum": satoshis, "spent_txo_sum": 0},
                "mempool_stats": {"tx_count": 0}}

    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=obtener)

    assert lector.saldo("clave", "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798") == (
        Decimal("0.00015"))


_CLAVE_G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"
# SHA-256 (sin invertir) de «21 <clave> ac», el script P2PK de la clave comprimida.
_SCRIPTHASH_G = hashlib.sha256(bytes.fromhex("21" + _CLAVE_G + "ac")).hexdigest()


def _salidaP2pk(clave, valor):
    return {"scriptpubkey": f"{len(clave) // 2:02x}{clave}ac", "scriptpubkey_type": "p2pk", "value": valor}


def testSaldoBitcoinDeUnaClavePublicaCuentaSusSalidasP2pk():
    def obtener(url, params=None, **_):
        satoshis = 5_000_000_000 if url.endswith(f"/scripthash/{_SCRIPTHASH_G}") else 0
        return {"chain_stats": {"tx_count": 1, "funded_txo_sum": satoshis, "spent_txo_sum": 0},
                "mempool_stats": {"tx_count": 0}}

    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=obtener)

    assert lector.saldo("clave", _CLAVE_G) == Decimal("50")


def testBitcoinClavePublicaReconoceComoSuyaUnaRecompensaP2pk():
    minado = {"txid": "c1", "fee": 0, "status": {"confirmed": True, "block_time": 1},
              "vin": [{"is_coinbase": True, "prevout": None}], "vout": [_salidaP2pk(_CLAVE_G, 5_000_000_000)]}
    gasto = {"txid": "g1", "fee": 1000, "status": {"confirmed": True, "block_time": 2},
             "vin": [{"prevout": _salidaP2pk(_CLAVE_G, 5_000_000_000)}],
             "vout": [{"scriptpubkey_address": _AJENA, "value": 4_999_999_000}]}
    esplora = EsploraFalsa({_SCRIPTHASH_G: [gasto, minado]})
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=esplora)

    movimientos = lector.leer("clave", _CLAVE_G, 100)

    assert [(m.hash, m.tipo, m.cantidad, m.propia) for m in movimientos] == [
        ("g1", bc.ENVIADA, Decimal("49.99999"), _CLAVE_G),
        ("c1", bc.RECIBIDA, Decimal("50"), _CLAVE_G),
    ]
    assert movimientos[0].contraparte == _AJENA


def testUtxosDeUnaClavePublicaIncluyenLosP2pk():
    def obtener(url, params=None, **_):
        if url.endswith("blocks/tip/height"):
            return 900_000
        if url.endswith(f"/scripthash/{_SCRIPTHASH_G}/utxo"):
            return [{"txid": "c1", "vout": 0, "value": 5_000_000_000,
                     "status": {"confirmed": True, "block_height": 3, "block_time": 1}}]
        return []

    utxos, _ = bc.LectorBitcoin(baseUrl="https://esplora.test/api", obtenerJson=obtener).utxos("clave", _CLAVE_G)

    assert [(u.txid, u.satoshis, u.direccion) for u in utxos] == [("c1", 5_000_000_000, _CLAVE_G)]


def testBitcoinXpubTaprootConsultaSusDireccionesBc1p():
    xpub = ("xpub6BgBgsespWvERF3LHQu6CnqdvfEvtMcQjYrcRzx53QJjSxarj2afYWcLteoGVky7D3UKDP9QyrLprQ3VCECoY49yfdDEHGCtMMj92"
            "pReUsQ")
    taproot0 = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"
    esplora = EsploraFalsa({taproot0: [_txBtc("t1", [(_AJENA, 20_000)], [(taproot0, 10_000)])]})
    lector = bc.LectorBitcoin(baseUrl="https://esplora.test/api", gapLimit=1, obtenerJson=esplora)

    movimientos = lector.leer("xpub", f"tr({xpub})", 100)

    assert [(m.hash, m.tipo, m.cantidad) for m in movimientos] == [("t1", bc.RECIBIDA, Decimal("0.0001"))]
    assert esplora.consultadas[0] == taproot0


# ── Esplora de respaldo ───────────────────────────────────────────────────────

_PRINCIPAL = "https://principal.test/api"
_RESPALDO = "https://respaldo.test/api"


@pytest.fixture
def esploraLimpia():
    bc.olvidarEsploraCaidas()
    yield
    bc.olvidarEsploraCaidas()


class EsploraConCaida:
    """Responde un saldo vacío salvo en las bases de `caidas`, que fallan con `error`."""

    def __init__(self, caidas, error):
        self.caidas = caidas
        self.error = error
        self.bases = []

    def __call__(self, url, params=None, **_):
        base = url.split("/address/", 1)[0]
        self.bases.append(base)
        if base in self.caidas:
            raise self.error(url)
        return _estadisticasEsplora(recibidas=1)


def _sinConexion(url):
    return URLError(TimeoutError("timed out"))


def _http(codigo):
    return lambda url: HTTPError(url, codigo, "fallo", {}, None)


def _lectorConRespaldo(obtener, reloj=lambda: 0.0):
    return bc.LectorBitcoin(baseUrl=_PRINCIPAL, respaldoUrl=_RESPALDO, obtenerJson=obtener, reloj=reloj)


@pytest.mark.parametrize("error", [_sinConexion, _http(503), _http(429)])
def testSiLaPrincipalFallaPorElServidorSeUsaElRespaldo(esploraLimpia, error):
    esplora = EsploraConCaida({_PRINCIPAL}, error)

    _lectorConRespaldo(esplora).saldo("direccion", _AJENA)

    assert esplora.bases == [_PRINCIPAL, _RESPALDO]


def testTrasUnaCaidaSeVaDirectoAlRespaldoHastaQuePasaElRato(esploraLimpia):
    esplora = EsploraConCaida({_PRINCIPAL}, _sinConexion)
    _lectorConRespaldo(esplora).saldo("direccion", _AJENA)
    esplora.bases.clear()

    _lectorConRespaldo(esplora, reloj=lambda: 10.0).saldo("direccion", _AJENA)
    assert esplora.bases == [_RESPALDO]

    esplora.caidas = set()
    esplora.bases.clear()
    _lectorConRespaldo(esplora, reloj=lambda: 10_000.0).saldo("direccion", _AJENA)
    assert esplora.bases == [_PRINCIPAL]


def testUn404NoPasaAlRespaldo(esploraLimpia):
    esplora = EsploraConCaida({_PRINCIPAL}, _http(404))

    with pytest.raises(bc.ErrorLecturaWallet, match="HTTP 404"):
        _lectorConRespaldo(esplora).saldo("direccion", _AJENA)
    assert esplora.bases == [_PRINCIPAL]


def testSiFallanLasDosSubeElErrorDelRespaldo(esploraLimpia):
    esplora = EsploraConCaida({_PRINCIPAL, _RESPALDO}, _http(502))

    with pytest.raises(bc.ErrorLecturaWallet, match="HTTP 502"):
        _lectorConRespaldo(esplora).saldo("direccion", _AJENA)
    assert esplora.bases == [_PRINCIPAL, _RESPALDO]


def testElRespaldoIgualALaPrincipalNoRepiteLaLlamada(esploraLimpia):
    esplora = EsploraConCaida({_PRINCIPAL}, _sinConexion)

    with pytest.raises(bc.ErrorLecturaWallet, match="No se pudo conectar"):
        bc.LectorBitcoin(baseUrl=_PRINCIPAL, respaldoUrl=_PRINCIPAL + "/",
                         obtenerJson=esplora).saldo("direccion", _AJENA)
    assert esplora.bases == [_PRINCIPAL]


def testSinBaseExplicitaLasUrlSalenDeLosAjustes(esploraLimpia, monkeypatch):
    monkeypatch.setattr(bc.settings, "walletsEsploraUrl", lambda: _PRINCIPAL)
    monkeypatch.setattr(bc.settings, "walletsEsploraUrlRespaldo", lambda: _RESPALDO)
    esplora = EsploraConCaida({_PRINCIPAL}, _sinConexion)

    bc.LectorBitcoin(obtenerJson=esplora).saldo("direccion", _AJENA)

    assert esplora.bases == [_PRINCIPAL, _RESPALDO]


def testUnaUrlDeRespaldoNoHttpSeRechaza(esploraLimpia):
    with pytest.raises(bc.ErrorLecturaWallet, match="respaldo"):
        bc.LectorBitcoin(baseUrl=_PRINCIPAL, respaldoUrl="ftp://x",
                         obtenerJson=lambda *a, **k: {}).saldo("direccion", _AJENA)
