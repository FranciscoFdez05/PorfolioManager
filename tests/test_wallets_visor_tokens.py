"""Pruebas del visor de tokens: el lector de Etherscan, el servicio y los activos que se cruzan.

Ninguna prueba sale a la red: el lector recibe un `obtenerJson` falso con la
forma documentada de Etherscan v2.
"""

from datetime import UTC, datetime
from decimal import Decimal
from itertools import pairwise

import pytest

from core import wallets_visor_tokens as visor
from core.db import getDb
from core.wallets_tokens import IMITACION, RECONOCIDO, SIN_VERIFICAR, VERIFICADO
from providers import blockchain_clients as bc
from providers.listas_tokens import TokenPublico
from stores.asset_store import listarActivosParaTokens
from stores.wallets_store import TokenConocido, TokenPrecio, TokenVerificado, Wallet

_EVM = "0x" + "a" * 40
_OTRA_EVM = "0x" + "b" * 40
_FECHA = datetime(2026, 3, 9, 15, 30, tzinfo=UTC)


def _transferencia(contrato, simbolo, valor, recibida=True, tiempo=100, decimales=18, nombre=""):
    return {
        "hash": f"0x{contrato}{tiempo}", "timeStamp": str(tiempo), "contractAddress": contrato,
        "tokenSymbol": simbolo, "tokenName": nombre or simbolo, "tokenDecimal": str(decimales), "value": str(valor),
        "from": _OTRA_EVM if recibida else _EVM, "to": _EVM if recibida else _OTRA_EVM,
    }


class EtherscanFalso:
    """tokentx fijo y un saldo por contrato; apunta qué contratos se consultan."""

    def __init__(self, transferencias, saldos):
        self.transferencias = transferencias
        self.saldos = saldos
        self.consultados = []

    def __call__(self, url, params=None, **_):
        if params["action"] == "tokentx":
            datos = self.transferencias[: params["offset"]]
            if not datos:
                return {"status": "0", "message": "No transactions found", "result": []}
            return {"status": "1", "message": "OK", "result": datos}
        assert params["action"] == "tokenbalance" and params["address"] == _EVM
        self.consultados.append(params["contractaddress"])
        return {"status": "1", "message": "OK", "result": str(self.saldos.get(params["contractaddress"], 0))}


def _lector(etherscan):
    return bc.LectorEvm("eth", apiKey="CLAVE", obtenerJson=etherscan)


class RelojFalso:
    """Reloj que solo avanza cuando alguien duerme."""

    def __init__(self):
        self.ahora = 0.0
        self.pausas = []

    def __call__(self):
        return self.ahora

    def dormir(self, segundos):
        self.pausas.append(segundos)
        self.ahora += segundos


# ── Lector ───────────────────────────────────────────────────────────────────


def testConElHistorialCompletoSoloSePidenLosQueConservanAlgo():
    etherscan = EtherscanFalso(
        [
            _transferencia("0xusdc", "USDC", 5_000_000, tiempo=300, decimales=6, nombre="USD Coin"),
            _transferencia("0xlink", "LINK", 10**18, tiempo=200),
            _transferencia("0xlink", "LINK", 10**18, recibida=False, tiempo=250),
            # «Address poisoning»: valor cero, ni se cuenta.
            _transferencia("0xveneno", "USDC", 0, tiempo=400),
        ],
        {"0xusdc": 2_500_000},
    )

    saldos, sinLeer = _lector(etherscan).saldosTokens(_EVM.upper().replace("0X", "0x"), maximo=10, historial=100)

    assert etherscan.consultados == ["0xusdc"]
    assert sinLeer == 0
    assert saldos == [bc.SaldoToken(contrato="0xusdc", simbolo="USDC", nombre="USD Coin", cantidad=Decimal("2.5"),
                                    ultimoMovimiento=datetime.fromtimestamp(300, UTC))]


def testConElHistorialCortadoTambienSePidenLosDeNetoNegativo():
    """Lo que entró antes de lo leído no se ve: el neto no es fiable."""
    etherscan = EtherscanFalso(
        [
            _transferencia("0xsteth", "STETH", 10**18, recibida=False, tiempo=500),
            _transferencia("0xusdc", "USDC", 10**6, tiempo=400, decimales=6),
        ],
        {"0xsteth": 3 * 10**17, "0xusdc": 10**6},
    )

    saldos, _sinLeer = _lector(etherscan).saldosTokens(_EVM, maximo=10, historial=2)

    # Primero los que el historial dice que tienen saldo.
    assert etherscan.consultados == ["0xusdc", "0xsteth"]
    assert [s.cantidad for s in saldos] == [Decimal("1"), Decimal("0.3")]


def testElTopeDejaContadosLosQueNoSeLeenYHayPausaEntreLlamadas():
    etherscan = EtherscanFalso(
        [_transferencia(f"0xt{i}", f"T{i}", 1, tiempo=100 + i) for i in range(5)],
        {f"0xt{i}": 1 for i in range(5)},
    )
    reloj = RelojFalso()
    obtener = bc.conRitmoEtherscan(etherscan, ritmo=bc.Ritmo(bc._ETHERSCAN_INTERVALO, reloj), dormir=reloj.dormir)

    saldos, sinLeer = _lector(obtener).saldosTokens(_EVM, maximo=3, historial=100)

    assert etherscan.consultados == ["0xt4", "0xt3", "0xt2"]
    assert (len(saldos), sinLeer) == (3, 2)
    # tokentx sale sin esperar; cada saldo, un intervalo después del anterior.
    assert reloj.pausas == pytest.approx([bc._ETHERSCAN_INTERVALO] * 3)


def testElRitmoSeComparteEntreLectoresYNoBajaDeTresPorSegundo():
    """Movimientos y tokens de wallets distintas gastan la misma cuota de Etherscan."""
    reloj = RelojFalso()
    ritmo = bc.Ritmo(bc._ETHERSCAN_INTERVALO, reloj)
    llamadas = []

    def etherscan(url, params=None, **_):
        llamadas.append(reloj.ahora)
        return {"status": "1", "message": "OK", "result": "1"}

    for _i in range(4):
        lector = bc.LectorEvm("eth", apiKey="CLAVE",
                              obtenerJson=bc.conRitmoEtherscan(etherscan, ritmo=ritmo, dormir=reloj.dormir))
        lector.saldo("direccion", _EVM)

    assert all(b - a >= 1 / 3 for a, b in pairwise(llamadas))


def testSiEtherscanCortaSeEsperaYSeRepite():
    reloj = RelojFalso()
    respuestas = [
        {"status": "0", "message": "NOTOK", "result": "Max calls per sec rate limit reached (3/sec)"},
        {"status": "1", "message": "OK", "result": "7"},
    ]
    obtener = bc.conRitmoEtherscan(lambda url, params=None, **_: respuestas.pop(0),
                                   ritmo=bc.Ritmo(bc._ETHERSCAN_INTERVALO, reloj), dormir=reloj.dormir)

    assert bc.LectorEvm("eth", apiKey="CLAVE", obtenerJson=obtener).saldo("direccion", _EVM) == Decimal("7E-18")
    assert bc._ETHERSCAN_ESPERA_LIMITE in reloj.pausas


def testOtrosErroresDeEtherscanNoSeRepiten():
    pedidas = []

    def obtener(url, params=None, **_):
        pedidas.append(params["action"])
        return {"status": "0", "message": "NOTOK", "result": "Invalid API Key"}

    lector = bc.LectorEvm("eth", apiKey="CLAVE",
                          obtenerJson=bc.conRitmoEtherscan(obtener, ritmo=bc.Ritmo(0), dormir=lambda _s: None))
    with pytest.raises(bc.ErrorLecturaWallet, match="Invalid API Key"):
        lector.saldo("direccion", _EVM)
    assert pedidas == ["balance"]


def testSinTransferenciasNoSePideNingunSaldo():
    etherscan = EtherscanFalso([], {})

    assert _lector(etherscan).saldosTokens(_EVM, maximo=10, historial=100) == ([], 0)
    assert etherscan.consultados == []


def testElLimiteDeEtherscanSubeComoError():
    def obtener(url, params=None, **_):
        if params["action"] == "tokentx":
            return {"status": "1", "message": "OK", "result": [_transferencia("0xusdc", "USDC", 1)]}
        return {"status": "0", "message": "NOTOK", "result": "Max rate limit reached"}

    with pytest.raises(bc.ErrorLecturaWallet, match="rate limit"):
        _lector(obtener).saldosTokens(_EVM, maximo=10, historial=100)


def testSiElLimiteSigueTrasLosReintentosSubeComoError():
    pedidas = []

    def obtener(url, params=None, **_):
        pedidas.append(params["action"])
        return {"status": "0", "message": "NOTOK", "result": "Max calls per sec rate limit reached (3/sec)"}

    lector = bc.LectorEvm("eth", apiKey="CLAVE",
                          obtenerJson=bc.conRitmoEtherscan(obtener, ritmo=bc.Ritmo(0), dormir=lambda _s: None))
    with pytest.raises(bc.ErrorLecturaWallet, match="rate limit"):
        lector.saldo("direccion", _EVM)
    assert len(pedidas) == bc._ETHERSCAN_REINTENTOS + 1


def testSoloEthYBnbTienenVisor():
    assert bc.redesConTokens() == {"eth", "bnb"}
    with pytest.raises(bc.ErrorLecturaWallet, match="visor de tokens"):
        bc.lectorTokens("btc")


# ── Servicio ─────────────────────────────────────────────────────────────────

_ACTIVOS = [
    {"id": "ethereum", "name": "Ethereum", "symbol": "ETH", "marketSymbol": "", "type": "cripto"},
    {"id": "cspx", "name": "iShares Core S&P 500", "symbol": "CSPX", "marketSymbol": "LSE:CSPX", "type": "etfs"},
]


def _saldo(contrato, simbolo, cantidad):
    return bc.SaldoToken(contrato=contrato, simbolo=simbolo, nombre=simbolo, cantidad=Decimal(cantidad),
                         ultimoMovimiento=_FECHA)


class RepositorioFalso:
    def __init__(self, red="eth", tokens=(), precios=()):
        self.wallet = Wallet(id="w1", alias="Ledger", red=red, tipo="direccion", valor=_EVM, assetId="ethereum",
                             creada="2026-01-01T00:00:00")
        self.tokens = list(tokens)
        self.precios = list(precios)
        self.anotados = []

    def obtener(self, walletId):
        return self.wallet

    def tokensVerificados(self):
        return list(self.tokens)

    def marcasToken(self):
        return []

    def preciosToken(self):
        return list(self.precios)

    def anotarTokensConocidos(self, tokens):
        self.anotados.extend(tokens)
        return len(tokens)


class LectorFalso:
    def __init__(self, saldos, sinLeer=0):
        self.saldos = saldos
        self.sinLeer = sinLeer
        self.pedidos = []

    def saldosTokens(self, valor, maximo, historial):
        self.pedidos.append((valor, maximo, historial))
        return self.saldos, self.sinLeer


def _servicio(saldos, repositorio=None, precios=None, sinLeer=0, publicos=()):
    lector = LectorFalso(saldos, sinLeer)
    precios = {"cspx": Decimal("500"), "ethereum": Decimal("3000")} if precios is None else precios

    def precioEur(assetId):
        valor = precios.get(assetId)
        if isinstance(valor, Exception):
            raise valor
        return valor

    servicio = visor.VisorTokens(
        repositorio=repositorio or RepositorioFalso(),
        fabricaLector=lambda red: lector,
        leerActivos=lambda: _ACTIVOS,
        leerStablecoins=lambda: ["USDC"],
        precioEur=precioEur,
        maxTokens=lambda: 7,
        historial=lambda: 300,
        leerTokensPublicos=lambda: list(publicos),
    )
    return servicio, lector


def testUnEtfTokenizadoSeAsociaAlEtfDeActivosYSeValora():
    servicio, lector = _servicio([_saldo("0xcspx", "CSPX", "2"), _saldo("0xusdc", "USDC", "10")], sinLeer=3)

    resultado = servicio.leer("w1")

    assert lector.pedidos == [(_EVM, 7, 300)]
    etf, stable = resultado["tokens"]
    assert etf["activo"] == {"id": "cspx", "name": "iShares Core S&P 500", "type": "etfs"}
    assert (etf["valorEur"], etf["estado"], etf["cantidad"]) == ("1000", SIN_VERIFICAR, "2")
    assert etf["ultimoMovimiento"] == _FECHA.isoformat()
    # Una stablecoin activada se reconoce, pero no está en Activos: sin precio.
    assert stable["activo"] == {"id": "stablecoin-USDC", "name": "USDC", "type": "stablecoin"}
    assert stable["valorEur"] == ""
    assert resultado["sinLeer"] == 3


def testUnaImitacionLlevaSuEstadoParaQueLaPaginaNoLaValore():
    repositorio = RepositorioFalso(tokens=[TokenVerificado("eth", "0xcspx", "CSPX")])
    servicio, _lector = _servicio([_saldo("0xcspx", "CSPX", "1"), _saldo("0xfalso", "CSPX", "1000")], repositorio)

    bueno, copia = servicio.leer("w1")["tokens"]

    assert bueno["estado"] == VERIFICADO
    assert copia["estado"] == IMITACION
    # Activo y valor viajan igual: si el usuario la desmiente, la página no relee la red.
    assert copia["activo"]["id"] == "cspx"


def testUnContratoDeLasListasPublicasSaleReconocidoYSusCopiasComoImitacion():
    publicos = [TokenPublico("eth", "0xcspx", "CSPX"), TokenPublico("eth", "0xotro", "OTRO")]
    servicio, _lector = _servicio([_saldo("0xcspx", "CSPX", "1"), _saldo("0xfalso", "CSPX", "1000"),
                                   _saldo("0xpepe", "PEPE", "5")], publicos=publicos)

    resultado = servicio.leer("w1")

    assert [t["estado"] for t in resultado["tokens"]] == [RECONOCIDO, IMITACION, SIN_VERIFICAR]
    # Solo lo que la página necesita para esos tokens, no la lista entera.
    assert resultado["tokensPublicos"] == [{"red": "eth", "contrato": "0xcspx", "simbolo": "CSPX"}]


def testSinTokensConSaldoNoSeDescarganLasListas():
    llamadas = []
    servicio, _lector = _servicio([])
    servicio._leerTokensPublicos = lambda: llamadas.append(1) or []

    assert servicio.leer("w1") == {"tokens": [], "sinLeer": 0, "tokensPublicos": []}
    assert llamadas == []


def testUnTokenQueNoEstaEnActivosSeEnsenaSinActivo():
    servicio, _lector = _servicio([_saldo("0xpepe", "PEPE", "1000000")])

    token = servicio.leer("w1")["tokens"][0]

    assert (token["activo"], token["valorEur"]) == (None, "")


def testSinPrecioOConElCambioCaidoNoHayValorPeroSiToken():
    servicio, _lector = _servicio([_saldo("0xcspx", "CSPX", "1")], precios={"cspx": RuntimeError("sin cambio")})

    token = servicio.leer("w1")["tokens"][0]

    assert token["activo"]["id"] == "cspx"
    assert token["valorEur"] == ""


def testElPrecioDeCadaActivoSePideUnaVez():
    pedidos = []
    servicio = visor.VisorTokens(
        repositorio=RepositorioFalso(),
        fabricaLector=lambda red: LectorFalso([_saldo("0xa", "CSPX", "1"), _saldo("0xb", "CSPX", "2")]),
        leerActivos=lambda: _ACTIVOS, leerStablecoins=lambda: [],
        precioEur=lambda assetId: pedidos.append(assetId) or Decimal("1"),
        maxTokens=lambda: 10, historial=lambda: 10,
    )

    servicio.leer("w1")

    assert pedidos == ["cspx"]


def _servicioConTicker(saldos, precios, precioTicker):
    servicio, _lector = _servicio(saldos, RepositorioFalso(precios=precios))
    servicio._precioTicker = precioTicker
    return servicio


def testUnTokenSinActivoSeValoraConSuTicker():
    pedidos = []
    ticker = TokenPrecio("eth", "0xpepe", "tradingview", "BINANCE:PEPEUSDT")
    servicio = _servicioConTicker([_saldo("0xpepe", "PEPE", "1000")], [ticker],
                                  lambda proveedor, simbolo: pedidos.append((proveedor, simbolo)) or Decimal("0.002"))

    token = servicio.leer("w1")["tokens"][0]

    assert pedidos == [("tradingview", "BINANCE:PEPEUSDT")]
    assert (token["activo"], token["valorEur"]) == (None, "2")
    assert token["precio"] == {"proveedor": "tradingview", "ticker": "BINANCE:PEPEUSDT"}


def testElTickerPuestoAManoMandaSobreElActivo():
    ticker = TokenPrecio("eth", "0xcspx", "yahoo", "CSPX.L")
    servicio = _servicioConTicker([_saldo("0xcspx", "CSPX", "2")], [ticker], lambda proveedor, simbolo: Decimal("7"))

    token = servicio.leer("w1")["tokens"][0]

    # El activo sigue saliendo, pero el valor es el del ticker (2 × 7) y no el del activo (2 × 500).
    assert token["activo"]["id"] == "cspx"
    assert token["valorEur"] == "14"


def _proveedorCaido(proveedor, simbolo):
    raise RuntimeError("caído")


@pytest.mark.parametrize("precioTicker", [lambda proveedor, simbolo: None, _proveedorCaido])
def testUnTickerSinCotizacionDejaElTokenSinValor(precioTicker):
    ticker = TokenPrecio("eth", "0xpepe", "tradingview", "BINANCE:PEPEUSDT")
    servicio = _servicioConTicker([_saldo("0xpepe", "PEPE", "1000")], [ticker], precioTicker)

    assert servicio.leer("w1")["tokens"][0]["valorEur"] == ""


def testLeerAnotaLosTokensVistos():
    repositorio = RepositorioFalso()
    servicio, _lector = _servicio([_saldo("0xpepe", "PEPE", "1")], repositorio)

    servicio.leer("w1")

    assert repositorio.anotados == [TokenConocido("eth", "0xpepe", "PEPE", "PEPE")]


def testUnaRedSinTokensNoLlegaALeer():
    servicio = visor.VisorTokens(repositorio=RepositorioFalso(red="btc"),
                                 fabricaLector=lambda red: pytest.fail("no debe leer la red"))

    with pytest.raises(visor.RedSinVisorTokens, match="Ethereum"):
        servicio.leer("w1")


# ── Activos que se cruzan con tokens ────────────────────────────────────────


def testEntranCriptosYEtfsYLasCriptosVanPrimero(tempDb):
    conn = getDb()
    conn.executemany(
        "INSERT INTO activos (id, name, symbol, type, sort_order) VALUES (?, ?, ?, ?, ?)",
        [
            ("etf1", "ETF uno", "UNO", "ETFs ", 0),
            ("aapl", "Apple", "AAPL", "acciones", 1),
            ("eth", "Ethereum", "ETH", "cripto", 5),
            ("oro", "Oro", "XAU", "comoditis", 2),
        ],
    )
    conn.commit()

    activos = listarActivosParaTokens()

    assert [(a["id"], a["type"]) for a in activos] == [("eth", "cripto"), ("etf1", "etfs")]
