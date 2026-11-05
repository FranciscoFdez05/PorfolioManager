"""Pruebas del servicio que importa movimientos de wallets a Transacciones."""

from dataclasses import replace
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from core import wallets_sync as wsync
from core.wallets_vigilancia import movimientoComoDict
from providers.blockchain_clients import (
    ENTRE_WALLETS,
    ENVIADA,
    RECIBIDA,
    ComisionPagada,
    ErrorLecturaWallet,
    MovimientoWallet,
)
from providers.listas_tokens import TokenPublico
from stores import revisiones
from stores.wallets_store import DireccionMarcada, MovimientoMarcado, TokenMarcado, TokenVerificado, Wallet

_FECHA = datetime(2026, 3, 9, 15, 30, tzinfo=UTC)
_ACTIVOS = [
    {"id": "bitcoin", "name": "Bitcoin", "symbol": "BITCOIN", "marketSymbol": "BITVAVO:BTCEUR"},
    {"id": "ethereum", "name": "Ethereum", "symbol": "ETH", "marketSymbol": "ETH-EUR"},
    {"id": "chainlink", "name": "Chainlink", "symbol": "PRUEBALINK", "marketSymbol": "LINK-EUR"},
]


def _mov(hash_="h1", simbolo="ETH", tipo=RECIBIDA, cantidad="1.50", comision=None, contrato="", nota=""):
    return MovimientoWallet(red="eth", hash=hash_, fecha=_FECHA, simbolo=simbolo, cantidad=Decimal(cantidad),
                            comision=None if comision is None else Decimal(comision), tipo=tipo,
                            contraparte="0xotra", contrato=contrato, nota=nota)


class RepositorioFalso:
    def __init__(self, wallet, tokens=(), marcas=()):
        self.wallet = wallet
        self.sincronizadas = []
        self.tokens = list(tokens)
        self.marcas = list(marcas)
        self.libreta = []
        self.movimientos = []
        self.contrapartes = {}

    def tokensVerificados(self):
        return list(self.tokens)

    def marcasToken(self):
        return list(self.marcas)

    def obtener(self, walletId):
        return self.wallet

    def marcarSincronizada(self, walletId, cuando):
        self.sincronizadas.append(walletId)

    def listar(self):
        return [self.wallet]

    def direcciones(self):
        return list(self.libreta)

    def movimientosMarcados(self):
        return list(self.movimientos)

    def contrapartesImportadas(self):
        return dict(self.contrapartes)

    def anotarContrapartes(self, nuevas):
        self.contrapartes.update(nuevas)


class Lector:
    def __init__(self, movimientos):
        self.movimientos = movimientos

    def leer(self, tipo, valor, limite):
        return self.movimientos


def _servicio(movimientos, filas=None, assetId="ethereum", conflictos=0, stablecoins=("USDC",), seguimiento="",
              tokens=(), marcas=(), publicos=(), verificarEntradas=False):
    estado = {"rows": list(filas or []), "revision": 4, "conflictos": conflictos, "escrituras": 0}

    def escribir(datos, revisionEsperada=None):
        estado["escrituras"] += 1
        if estado["conflictos"]:
            estado["conflictos"] -= 1
            estado["revision"] += 1
            raise revisiones.ConflictoRevision(estado["revision"])
        assert revisionEsperada == estado["revision"]
        estado["rows"] = datos["rows"]
        estado["revision"] += 1
        return estado["revision"]

    wallet = Wallet(id="w1", alias="Ledger ETH", red="eth", tipo="direccion", valor="0x" + "a" * 40,
                    assetId=assetId, creada="2026-01-01T00:00:00+00:00", seguimiento=seguimiento)
    repositorio = RepositorioFalso(wallet, tokens, marcas)
    servicio = wsync.SincronizadorWallets(
        repositorio=repositorio,
        fabricaLectores=lambda red: Lector(movimientos),
        leerActivos=lambda: _ACTIVOS,
        leerStablecoins=lambda: list(stablecoins),
        leerTransacciones=lambda: {"rows": list(estado["rows"])},
        escribirTransacciones=escribir,
        revisionActual=lambda: estado["revision"],
        maxMovimientos=lambda: 100,
        leerTokensPublicos=lambda: list(publicos),
        verificarEntradas=verificarEntradas,
    )
    return servicio, estado, repositorio


def testImportaConElFormatoDeLaPantalla():
    servicio, estado, repositorio = _servicio([
        _mov("h1", tipo=RECIBIDA),
        _mov("h2", tipo=ENVIADA, cantidad="0.25", comision="0.000021"),
        _mov("h3", tipo=ENTRE_WALLETS, cantidad="1", comision="0.0001"),
    ])

    resultado = servicio.sincronizar("w1")

    assert resultado.comoDict() == {"anadidas": 3, "yaImportadas": 0, "sinActivo": {}, "revision": 5}
    recibida, enviada, interna = estado["rows"]
    assert recibida == {
        "id": recibida["id"], "assetId": "ethereum", "assetName": "Ethereum", "fechaOperacion": "09-03-2026",
        "total": "1.5", "comisionRed": "", "walletTipo": "recibida", "walletDesde": "0xotra",
        "walletDestino": "Ledger ETH", "hashTransaccion": "h1", "nota": "Importado de Ledger ETH",
    }
    assert (enviada["walletDesde"], enviada["walletDestino"], enviada["comisionRed"]) == ("Ledger ETH", "0xotra", "0.000021")
    assert (interna["walletDesde"], interna["walletDestino"]) == ("Ledger ETH", "Ledger ETH")
    assert repositorio.sincronizadas == ["w1"]


def testEnTransaccionesLaWalletEsElSeguimiento():
    # Las cinco direcciones de un Ledger son la misma wallet en la tabla.
    servicio, estado, _ = _servicio([_mov("h1", tipo=RECIBIDA)], seguimiento="Ledger")

    servicio.sincronizar("w1")

    assert (estado["rows"][0]["walletDestino"], estado["rows"][0]["nota"]) == ("Ledger", "Importado de Ledger")


def testSincronizarDosVecesNoDuplica():
    servicio, estado, _ = _servicio([_mov("h1"), _mov("h2")])
    servicio.sincronizar("w1")

    resultado = servicio.sincronizar("w1")

    assert (resultado.anadidas, resultado.yaImportadas) == (0, 2)
    assert len(estado["rows"]) == 2


def testRespetaLasFilasManualesConElMismoHash():
    manual = {"id": "transaccion-1", "assetId": "ethereum", "hashTransaccion": "H1", "total": "9"}
    servicio, estado, _ = _servicio([_mov("h1"), _mov("h2")], filas=[manual])

    resultado = servicio.sincronizar("w1")

    assert resultado.anadidas == 1
    assert estado["rows"][0] == manual


def testLosTokensSeBuscanPorSimboloYLosDesconocidosSeCuentan():
    servicio, estado, _ = _servicio([
        _mov("h1", simbolo="LINK", contrato="0xlink", nota="Token 0xlink"),
        _mov("h2", simbolo="USDC", contrato="0xusdc"),
        _mov("h3", simbolo="PEPE", contrato="0xpepe"),
        _mov("h4", simbolo="PEPE", contrato="0xpepe"),
    ])

    resultado = servicio.sincronizar("w1")

    assert resultado.sinActivo == {"PEPE": 2}
    assert [(f["assetId"], f["nota"]) for f in estado["rows"]] == [
        ("chainlink", "Importado de Ledger ETH · Token 0xlink"),
        ("stablecoin-USDC", "Importado de Ledger ETH"),
    ]


def testUnTokenConElSimboloDeLaNativaNoVaALaNativa():
    # Un token falso llamado «ETH» no debe sumarse al activo de la moneda nativa.
    servicio, estado, _ = _servicio([_mov("h1", simbolo="ETH", contrato="0xfalso")])

    resultado = servicio.sincronizar("w1")

    assert resultado.anadidas == 0
    assert resultado.sinActivo == {"ETH (token)": 1}
    assert estado["rows"] == []


def testConElContratoVerificadoLasCopiasNoSeImportan():
    servicio, estado, _ = _servicio([
        _mov("h1", simbolo="LINK", contrato="0xlink"),
        _mov("h2", simbolo="LINK", contrato="0xcopia"),
        _mov("h3", simbolo="LINK", contrato="0xcopia"),
    ], tokens=[TokenVerificado("eth", "0xlink", "LINK")])

    resultado = servicio.sincronizar("w1")

    assert resultado.sinActivo == {"LINK (imitación)": 2}
    assert [(f["hashTransaccion"], f["assetId"]) for f in estado["rows"]] == [("h1", "chainlink")]


def testLaVerificacionEsPorRed():
    # El LINK verificado en BNB no dice nada del LINK de Ethereum.
    servicio, estado, _ = _servicio([_mov("h1", simbolo="LINK", contrato="0xcopia")],
                                    tokens=[TokenVerificado("bnb", "0xlink", "LINK")])

    resultado = servicio.sincronizar("w1")

    assert resultado.anadidas == 1
    assert estado["rows"][0]["assetId"] == "chainlink"


def testLaMarcaDelUsuarioMandaSobreLaDeteccion():
    # El usuario desmiente una copia de un símbolo verificado y marca como
    # imitación un token que nada delataba.
    servicio, estado, _ = _servicio([
        _mov("h1", simbolo="LINK", contrato="0xpuente"),
        _mov("h2", simbolo="LINK", contrato="0xcopia"),
        _mov("h3", simbolo="USDC", contrato="0xspam"),
    ], tokens=[TokenVerificado("eth", "0xlink", "LINK")],
        marcas=[TokenMarcado("eth", "0xpuente", "legitimo"), TokenMarcado("eth", "0xspam", "imitacion")])

    resultado = servicio.sincronizar("w1")

    assert resultado.sinActivo == {"LINK (imitación)": 1, "USDC (imitación)": 1}
    assert [(f["hashTransaccion"], f["assetId"]) for f in estado["rows"]] == [("h1", "chainlink")]


def testLasListasPublicasDejanFueraLasCopiasSinVerificarNada():
    servicio, estado, _ = _servicio([
        _mov("h1", simbolo="LINK", contrato="0xlink"),
        _mov("h2", simbolo="LINK", contrato="0xcopia"),
    ], publicos=[TokenPublico("eth", "0xlink", "LINK")])

    resultado = servicio.sincronizar("w1")

    assert resultado.sinActivo == {"LINK (imitación)": 1}
    assert [(f["hashTransaccion"], f["assetId"]) for f in estado["rows"]] == [("h1", "chainlink")]


def testLoVerificadoPorElUsuarioMandaSobreLasListas():
    servicio, estado, _ = _servicio([
        _mov("h1", simbolo="LINK", contrato="0xlink"),
        _mov("h2", simbolo="LINK", contrato="0xmio"),
    ], tokens=[TokenVerificado("eth", "0xmio", "LINK")], publicos=[TokenPublico("eth", "0xlink", "LINK")])

    resultado = servicio.sincronizar("w1")

    assert resultado.sinActivo == {"LINK (imitación)": 1}
    assert [f["hashTransaccion"] for f in estado["rows"]] == ["h2"]


def testSinTokensNoSeDescarganLasListasPublicas():
    llamadas = []
    servicio, _, _ = _servicio([_mov("h1")])
    servicio._leerTokensPublicos = lambda: llamadas.append(1) or []

    servicio.sincronizar("w1")

    assert llamadas == []


def testUnTokenConElNombreDeLaMonedaNoSeSumaAunqueSeaLegitimo():
    servicio, estado, _ = _servicio([_mov("h1", simbolo="ETH", contrato="0xfalso")],
                                    marcas=[TokenMarcado("eth", "0xfalso", "legitimo")])

    resultado = servicio.sincronizar("w1")

    assert resultado.sinActivo == {"ETH (token)": 1}
    assert estado["rows"] == []


def testSinTokensNoSeLeeLaListaDeVerificados():
    llamadas = []
    servicio, _, _ = _servicio([_mov("h1")])
    servicio._leerTokensVerificados = lambda: llamadas.append(1) or []

    servicio.sincronizar("w1")

    assert llamadas == []


def testReintentaTrasUnConflictoDeRevision():
    servicio, estado, _ = _servicio([_mov("h1")], conflictos=1)

    resultado = servicio.sincronizar("w1")

    assert resultado.anadidas == 1
    assert estado["escrituras"] == 2


def testSeRindeSiElConflictoNoCesa():
    servicio, _, repositorio = _servicio([_mov("h1")], conflictos=10)

    with pytest.raises(ErrorLecturaWallet):
        servicio.sincronizar("w1")
    assert repositorio.sincronizadas == []


def testElActivoDeLaWalletTieneQueExistir():
    servicio, estado, _ = _servicio([_mov("h1")], assetId="borrado")

    with pytest.raises(wsync.ActivoDeWalletInexistente):
        servicio.sincronizar("w1")
    assert estado["escrituras"] == 0


@pytest.mark.parametrize("valor, texto", [
    (Decimal("0.000120"), "0.00012"),
    (Decimal("1E-8"), "0.00000001"),
    (Decimal("100"), "100"),
    (Decimal("0E-18"), "0"),
    (None, ""),
])
def testTextoDecimal(valor, texto):
    assert wsync.textoDecimal(valor) == texto


# ── Libreta de direcciones ────────────────────────────────────────────────────

_OTRA = "0x" + "b" * 40


def _movLibreta(hash_="h1", tipo=ENVIADA, contraparte=_OTRA):
    return MovimientoWallet(red="eth", hash=hash_, fecha=_FECHA, simbolo="ETH", cantidad=Decimal("1"),
                            comision=None, tipo=tipo, contraparte=contraparte)


def testImportaConLaLibretaYApuntaLaContraparte():
    servicio, estado, repositorio = _servicio([_movLibreta("h1"), _movLibreta("h2", tipo=RECIBIDA)])
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="Exodus", propia=True)]

    servicio.sincronizar("w1")

    assert [(f["walletTipo"], f["walletDesde"], f["walletDestino"]) for f in estado["rows"]] == [
        (ENTRE_WALLETS, "Ledger ETH", "Exodus"),
        (ENTRE_WALLETS, "Exodus", "Ledger ETH"),
    ]
    assert sorted(c["sentido"] for c in repositorio.contrapartes.values()) == [ENVIADA, RECIBIDA]


def testReetiquetarCambiaSoloLasFilasDeEsaDireccionYSePuedeDeshacer():
    otraMas = "0x" + "c" * 40
    servicio, estado, repositorio = _servicio([_movLibreta("h1"), _movLibreta("h2", contraparte=otraMas)])
    servicio.sincronizar("w1")
    # Un cambio a mano en una fila de otra dirección no se toca.
    estado["rows"][1]["walletTipo"] = ENTRE_WALLETS

    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="Exodus", propia=True)]
    assert servicio.reetiquetar("eth", _OTRA.upper().replace("0X", "0x")) == 1
    assert [(f["walletTipo"], f["walletDestino"]) for f in estado["rows"]] == [
        (ENTRE_WALLETS, "Exodus"), (ENTRE_WALLETS, otraMas),
    ]

    repositorio.libreta = []
    assert servicio.reetiquetar("eth", _OTRA) == 1
    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["walletDestino"]) == (ENVIADA, _OTRA)
    assert servicio.reetiquetar("eth", _OTRA) == 0


def testReetiquetarAprendeLaContraparteDeFilasAntiguas():
    servicio, estado, repositorio = _servicio([_movLibreta("h1")])
    servicio.sincronizar("w1")
    # Como si se hubiera importado antes de existir la libreta.
    repositorio.contrapartes = {}
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="Binance", propia=False)]

    assert servicio.reetiquetar("eth", _OTRA) == 1
    assert estado["rows"][0]["walletDestino"] == "Binance"
    assert list(repositorio.contrapartes.values()) == [{"red": "eth", "direccion": _OTRA, "sentido": ENVIADA}]


@pytest.mark.parametrize("cambios", [
    {"walletDestino": "Lo edité a mano"},
    {"id": "manual-1"},
    {"walletTipo": ENTRE_WALLETS},
])
def testUnaFilaQueNoSePuedeDeducirNoSeReetiqueta(cambios):
    fila = wsync.filaDeMovimiento(_movLibreta(), {"id": "ethereum", "name": "Ethereum"}, "Ledger ETH")

    assert wsync.contraparteDeFila({**fila, **cambios}) is None


# ── Comisiones que bajan la posición ──────────────────────────────────────────

class LectorConComisiones(Lector):
    def __init__(self, movimientos, comisiones):
        super().__init__(movimientos)
        self.comisiones = comisiones

    def leerConComisiones(self, tipo, valor, limite):
        return self.movimientos, self.comisiones


def _conComisiones(movimientos, comisiones, filas=None):
    servicio, estado, repositorio = _servicio(movimientos, filas=filas)
    servicio._fabricaLectores = lambda red: LectorConComisiones(movimientos, comisiones)
    return servicio, estado, repositorio


def _gas(hash_="h9", comision="0.0004"):
    return ComisionPagada(red="eth", hash=hash_, fecha=_FECHA, comision=Decimal(comision))


def testElGasDeUnTokenSeDescuentaDeLaMonedaDeLaRed():
    token = _mov("h9", simbolo="USDC", tipo=ENVIADA, contrato="0x" + "d" * 40)
    servicio, estado, _ = _conComisiones([token], [_gas()])

    resultado = servicio.sincronizar("w1")

    assert resultado.anadidas == 2
    gas = next(f for f in estado["rows"] if f["assetId"] == "ethereum")
    assert (gas["walletTipo"], gas["total"], gas["comisionRed"]) == (ENTRE_WALLETS, "0.0004", "0.0004")
    assert gas["hashTransaccion"] == "h9"


def testVolverASincronizarNoDuplicaElGas():
    servicio, estado, _ = _conComisiones([], [_gas()])

    servicio.sincronizar("w1")
    resultado = servicio.sincronizar("w1")

    assert (resultado.anadidas, resultado.yaImportadas) == (0, 1)
    assert len(estado["rows"]) == 1


def testSiLaTransaccionMueveLaMonedaSeQuedaSuMovimiento():
    servicio, estado, _ = _conComisiones([_mov("h9", tipo=ENVIADA, comision="0.0004")], [_gas()])

    servicio.sincronizar("w1")

    assert [(f["walletTipo"], f["total"]) for f in estado["rows"]] == [(ENVIADA, "1.5")]


def _recibo(hash_="h1", comisionTx="0.00002", red="eth", contrato=""):
    return MovimientoWallet(red=red, hash=hash_, fecha=_FECHA, simbolo="ETH", cantidad=Decimal("1"), comision=None,
                            tipo=RECIBIDA, contraparte=_OTRA, contrato=contrato,
                            comisionTx=Decimal(comisionTx))


def testUnReciboDeUnaDireccionPropiaDescuentaLaComision():
    servicio, estado, repositorio = _servicio([_recibo()])
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]

    servicio.sincronizar("w1")

    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (ENTRE_WALLETS, "0.00002")


def testUnReciboDeUnTerceroNoDescuentaComision():
    servicio, estado, _ = _servicio([_recibo()])

    servicio.sincronizar("w1")

    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (RECIBIDA, "")


def testMarcarElOrigenPoneYQuitaLaComisionDeLoYaImportado():
    servicio, estado, repositorio = _servicio([_recibo()])
    servicio.sincronizar("w1")

    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]
    assert servicio.reetiquetar("eth", _OTRA) == 1
    assert estado["rows"][0]["comisionRed"] == "0.00002"

    repositorio.libreta = []
    assert servicio.reetiquetar("eth", _OTRA) == 1
    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (RECIBIDA, "")


def testReetiquetarNoTocaUnaComisionEscritaAMano():
    servicio, estado, repositorio = _servicio([_recibo()])
    servicio.sincronizar("w1")
    estado["rows"][0]["comisionRed"] = "0.5"

    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]
    servicio.reetiquetar("eth", _OTRA)
    assert estado["rows"][0]["comisionRed"] == "0.5"

    repositorio.libreta = []
    servicio.reetiquetar("eth", _OTRA)
    assert estado["rows"][0]["comisionRed"] == "0.5"


def testVolverASincronizarCompletaLaComisionDeFilasAntiguas():
    servicio, estado, repositorio = _servicio([_recibo()])
    servicio.sincronizar("w1")
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]
    # Como si se hubiera reetiquetado antes de apuntar la comisión de la transacción.
    estado["rows"][0]["walletTipo"] = ENTRE_WALLETS

    servicio.sincronizar("w1")

    assert estado["rows"][0]["comisionRed"] == "0.00002"


def testEnTokensNoSeUsaLaComisionDeLaTransaccion():
    assert not wsync.reciboConComision(RECIBIDA, "0x" + "d" * 40)


def testEnBitcoinUnOrigenPropioDescuentaLaComision():
    assert wsync.reciboConComision(RECIBIDA, "")


def testMarcarSoloLaTransaccionNoAplicaLaComisionDelOrigen():
    # Retirada de un exchange: la de la red sería la de todo su lote.
    servicio, estado, repositorio = _servicio([_recibo()])
    repositorio.movimientos = [_marca(comision="")]

    servicio.sincronizar("w1")

    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (ENTRE_WALLETS, "")


def testSincronizarCompletaLaComisionDeUnaTransaccionMarcadaConOrigenPropio():
    servicio, estado, repositorio = _servicio([_recibo()])
    servicio.sincronizar("w1")
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]
    repositorio.movimientos = [_marca(comision="")]
    estado["rows"][0]["walletTipo"] = ENTRE_WALLETS

    servicio.sincronizar("w1")

    assert estado["rows"][0]["comisionRed"] == "0.00002"


def _filaAntigua(**cambios):
    """Como quedó una fila importada antes de apuntar la comisión de un origen propio."""
    return {"id": "wallet-antigua", "assetId": "ethereum", "total": "1", "comisionRed": "", "walletTipo": ENTRE_WALLETS,
            "walletDesde": _OTRA, "walletDestino": "Ledger", "hashTransaccion": "H1", "nota": "", **cambios}


def _conRecientes(repositorio, *movimientos):
    repositorio.wallet = replace(repositorio.wallet, recientes=[movimientoComoDict(m) for m in movimientos])


def testCompletarComisionesArreglaLaFilaAntiguaSinLeerLaRedYSeAprende():
    servicio, estado, repositorio = _servicio([], filas=[_filaAntigua()])
    _conRecientes(repositorio, _recibo())
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]
    repositorio.movimientos = [_marca(comision="")]

    assert servicio.completarComisiones() == 1
    assert estado["rows"][0]["comisionRed"] == "0.00002"
    assert repositorio.contrapartes["wallet-antigua"]["comisionTx"] == "0.00002"
    assert repositorio.sincronizadas == []

    assert servicio.completarComisiones() == 0
    assert estado["escrituras"] == 1


def testCompletarComisionesNoTocaLoQueNoEsSuyo():
    filas = [
        _filaAntigua(comisionRed="0"),
        _filaAntigua(id="wallet-recibida", walletTipo=RECIBIDA),
        _filaAntigua(id="wallet-otro", assetId="bitcoin"),
    ]
    servicio, estado, repositorio = _servicio([], filas=filas)
    _conRecientes(repositorio, _recibo())
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]

    assert servicio.completarComisiones() == 0
    assert estado["rows"] == filas
    assert estado["escrituras"] == 0


def testCompletarComisionesRespetaUnExchangeYNoAnadeFilas():
    # Marcada sin dar el origen por propio: es una retirada, la comisión no es suya.
    servicio, estado, repositorio = _servicio([], filas=[_filaAntigua()])
    _conRecientes(repositorio, _recibo(), _recibo(hash_="h2"))
    repositorio.movimientos = [_marca(comision="")]

    assert servicio.completarComisiones() == 0
    assert [f["comisionRed"] for f in estado["rows"]] == [""]


def testCompletarComisionesReintentaSiLasFilasCambian():
    servicio, estado, repositorio = _servicio([], filas=[_filaAntigua()], conflictos=1)
    _conRecientes(repositorio, _recibo())
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]

    assert servicio.completarComisiones() == 1
    assert estado["rows"][0]["comisionRed"] == "0.00002"


def testMarcarComoAjenaAnulaLaComisionDelOrigenPropio():
    servicio, estado, repositorio = _servicio([_recibo()])
    servicio.sincronizar("w1")
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]
    servicio.reetiquetar("eth", _OTRA)
    assert estado["rows"][0]["comisionRed"] == "0.00002"

    repositorio.movimientos = [_marca(propia=False, comision="")]
    servicio.reetiquetar("eth", _OTRA)

    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (RECIBIDA, "")


# ── Transacciones marcadas una a una ──────────────────────────────────────────

def _marca(propia=True, comision="0.001", hash_="h1"):
    return MovimientoMarcado(red="eth", hash=hash_, contrato="", propia=propia, comision=comision, assetId="ethereum")


def testUnRetiroMarcadoSeImportaEntreWalletsConSuComision():
    servicio, estado, repositorio = _servicio([_movLibreta("h1", tipo=RECIBIDA), _movLibreta("h2", tipo=RECIBIDA)])
    repositorio.movimientos = [_marca()]

    servicio.sincronizar("w1")

    assert [(f["walletTipo"], f["comisionRed"]) for f in estado["rows"]] == [
        (ENTRE_WALLETS, "0.001"), (RECIBIDA, ""),
    ]


def testAplicarMarcaCorrigeLaFilaYaImportadaYSeDeshace():
    servicio, estado, repositorio = _servicio([_movLibreta("h1", tipo=RECIBIDA)])
    servicio.sincronizar("w1")

    repositorio.movimientos = [_marca()]
    assert servicio.aplicarMarca("eth", "H1", "ethereum", RECIBIDA, "") == 1
    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (ENTRE_WALLETS, "0.001")

    repositorio.movimientos = []
    assert servicio.aplicarMarca("eth", "h1", "ethereum", RECIBIDA, "") == 1
    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (RECIBIDA, "")
    assert servicio.aplicarMarca("eth", "h1", "ethereum", RECIBIDA, "") == 0


def testLaMarcaMandaSobreLaDeSuDireccion():
    servicio, estado, repositorio = _servicio([_movLibreta("h1")])
    servicio.sincronizar("w1")
    repositorio.movimientos = [_marca(propia=False, comision="")]

    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="Exodus", propia=True)]
    servicio.reetiquetar("eth", _OTRA)

    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["walletDestino"]) == (ENVIADA, "Exodus")


def testAplicarMarcaNoTocaOtroActivoDeLaMismaTransaccion():
    filas = [{"id": "manual", "assetId": "usdc", "hashTransaccion": "h1", "walletTipo": RECIBIDA, "comisionRed": ""}]
    servicio, estado, repositorio = _servicio([], filas=filas)
    repositorio.movimientos = [_marca()]

    assert servicio.aplicarMarca("eth", "h1", "ethereum", RECIBIDA, "") == 0
    assert estado["rows"] == filas


def testUnaFilaAManoSeMarcaYSeDesmarca():
    filas = [{"id": "manual", "assetId": "ethereum", "hashTransaccion": "h1", "walletTipo": RECIBIDA, "comisionRed": ""}]
    servicio, estado, repositorio = _servicio([], filas=filas)
    repositorio.movimientos = [_marca()]

    assert servicio.aplicarMarca("eth", "h1", "ethereum", RECIBIDA, "") == 1
    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (ENTRE_WALLETS, "0.001")

    repositorio.movimientos = []
    assert servicio.aplicarMarca("eth", "h1", "ethereum", RECIBIDA, "") == 1
    assert (estado["rows"][0]["walletTipo"], estado["rows"][0]["comisionRed"]) == (RECIBIDA, "")


def testAplicarMarcaReintentaSiTransaccionesCambia():
    servicio, estado, repositorio = _servicio([_movLibreta("h1", tipo=RECIBIDA)])
    servicio.sincronizar("w1")
    repositorio.movimientos = [_marca()]
    estado["conflictos"] = 1

    assert servicio.aplicarMarca("eth", "h1", "ethereum", RECIBIDA, "") == 1


def testLaComisionDeQuienEnviaCompletaLaFilaDeQuienRecibe():
    recibida = _mov("h1", tipo=RECIBIDA)
    filas = [wsync.filaDeMovimiento(recibida, {"id": "ethereum", "name": "Ethereum"}, "Fría")]
    servicio, estado, _ = _servicio([_mov("h1", tipo=ENVIADA, comision="0.002")], filas=filas)

    resultado = servicio.sincronizar("w1")

    assert (resultado.anadidas, resultado.yaImportadas) == (0, 1)
    assert estado["rows"][0]["comisionRed"] == "0.002"
    assert estado["rows"][0]["walletTipo"] == RECIBIDA


def testUnaComisionYaPuestaNoSeSustituye():
    fila = wsync.filaDeMovimiento(_mov("h1", tipo=RECIBIDA), {"id": "ethereum", "name": "Ethereum"}, "Fría")
    servicio, estado, _ = _servicio([_mov("h1", tipo=ENVIADA, comision="0.002")],
                                    filas=[{**fila, "comisionRed": "0"}])

    servicio.sincronizar("w1")

    assert estado["escrituras"] == 0
    assert estado["rows"][0]["comisionRed"] == "0"


def testReetiquetarReintentaSiTransaccionesCambia():
    servicio, estado, repositorio = _servicio([_movLibreta("h1")])
    servicio.sincronizar("w1")
    repositorio.libreta = [DireccionMarcada(red="eth", direccion=_OTRA, apodo="", propia=True)]
    estado["conflictos"] = 1

    assert servicio.reetiquetar("eth", _OTRA) == 1
    assert estado["rows"][0]["walletTipo"] == ENTRE_WALLETS


# ── Importación limitada ──────────────────────────────────────────────────────

def _servicioLimitado(movimientos, limite):
    servicio, _, _ = _servicio(movimientos)
    servicio._maxMovimientos = lambda: limite
    return servicio


def testSiSeLlenaLaLecturaAvisaDeQuePuedeHaberMas():
    servicio = _servicioLimitado([_mov("h1"), _mov("h2")], 2)

    datos = servicio.sincronizar("w1").comoDict()

    assert datos["truncada"] is True
    assert (datos["limite"], datos["desde"]) == (2, _FECHA.strftime("%d-%m-%Y"))


def testSinLlenarLaLecturaNoAvisa():
    datos = _servicioLimitado([_mov("h1")], 2).sincronizar("w1").comoDict()

    assert "truncada" not in datos
