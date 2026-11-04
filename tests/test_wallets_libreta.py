"""Pruebas de la libreta de direcciones (core/wallets_libreta.py): cómo clasifica cada contraparte."""

from datetime import datetime, timezone
from decimal import Decimal

import pytest

from core import wallets_libreta as wl
from providers.blockchain_clients import ENTRE_WALLETS, ENVIADA, RECIBIDA, MovimientoWallet
from stores.wallets_store import DireccionMarcada, Wallet

_BECH32 = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"
_SATOSHI = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
_EVM = "0x" + "b" * 40


def _wallet(valor=_BECH32, red="btc", tipo="direccion", propia=True, alias="Ledger", seguimiento=""):
    return Wallet(id="w1", alias=alias, red=red, tipo=tipo, valor=valor, assetId="btc",
                  creada="2026-01-01T00:00:00+00:00", propia=propia, seguimiento=seguimiento)


def _mov(tipo=ENVIADA, contraparte=_BECH32, red="btc"):
    return MovimientoWallet(red=red, hash="h1", fecha=datetime(2026, 1, 1, tzinfo=timezone.utc), simbolo="BTC",
                            cantidad=Decimal("1"), comision=None, tipo=tipo, contraparte=contraparte)


@pytest.mark.parametrize("tipo, propia, esperado", [
    (ENVIADA, True, ENTRE_WALLETS),
    (RECIBIDA, True, ENTRE_WALLETS),
    (ENVIADA, False, ENVIADA),
    (RECIBIDA, False, RECIBIDA),
    (ENTRE_WALLETS, False, ENTRE_WALLETS),
])
def testClasificarSegunLaMarca(tipo, propia, esperado):
    entrada = wl.EntradaLibreta("btc", _BECH32, "", propia=propia)

    assert wl.clasificar(tipo, entrada) == esperado


def testSinEntradaElTipoNoCambia():
    assert wl.clasificar(ENVIADA, None) == ENVIADA


def testLasWalletsPropiasEnlazadasCuentanComoPropias():
    libreta = wl.Libreta.desde([], [_wallet(seguimiento="Mi Ledger")])

    entrada = libreta.buscar("btc", _BECH32)

    assert entrada.propia and entrada.enlazada
    assert entrada.apodo == "Mi Ledger"


@pytest.mark.parametrize("wallet", [
    _wallet(propia=False),
    _wallet(tipo="xpub", valor="zpub-cualquiera"),
])
def testLasAjenasYLasXpubNoEntranSolas(wallet):
    assert wl.Libreta.desde([], [wallet]).buscar(wallet.red, wallet.valor) is None


def testUnaMarcaManualMandaSobreLaEnlazada():
    marcada = DireccionMarcada(red="btc", direccion=_BECH32, apodo="Exchange", propia=False)

    entrada = wl.Libreta.desde([marcada], [_wallet()]).buscar("btc", _BECH32)

    assert (entrada.propia, entrada.enlazada, entrada.apodo) == (False, False, "Exchange")


def testBuscarComparaEnFormaCanonica():
    libreta = wl.Libreta.desde([DireccionMarcada(red="eth", direccion=_EVM, apodo="Mía", propia=True)], [])

    assert libreta.buscar("eth", _EVM.upper().replace("0X", "0x")).apodo == "Mía"
    # Cada red tiene su libreta: la misma dirección en otra red no está marcada.
    assert libreta.buscar("bnb", _EVM) is None
    assert libreta.buscar("eth", "") is None


def testCanonicaDejaTalCualLoQueNoEsUnaDireccion():
    assert wl.canonica("btc", "  no es una dirección ") == "no es una dirección"


def testAplicarCambiaSoloElTipo():
    libreta = wl.Libreta([wl.EntradaLibreta("btc", _BECH32, "Ledger", propia=True)])
    movimiento = _mov()

    aplicado = wl.aplicar(movimiento, libreta)

    assert aplicado.tipo == ENTRE_WALLETS
    assert aplicado.contraparte == movimiento.contraparte
    sinMarca = _mov(contraparte=_SATOSHI)
    assert wl.aplicar(sinMarca, libreta) is sinMarca


def testAnotarConservaElSentidoYEsIdempotente():
    libreta = wl.Libreta([wl.EntradaLibreta("btc", _BECH32, "Ledger", propia=True)])
    crudo = {"tipo": ENVIADA, "contraparte": _BECH32.upper()}

    anotado = wl.anotar(crudo, "btc", libreta)

    assert anotado["tipo"] == ENTRE_WALLETS
    assert anotado["sentido"] == ENVIADA
    assert anotado["contraparteClave"] == _BECH32
    assert (anotado["contraparteApodo"], anotado["contraparteMarca"]) == ("Ledger", "propia")
    assert wl.anotar(anotado, "btc", libreta) == anotado
    # Al quitar la marca, vuelve el tipo que leyó la red.
    assert wl.anotar(anotado, "btc", wl.Libreta())["tipo"] == ENVIADA


def testNombreContraparte():
    entrada = wl.EntradaLibreta("btc", _BECH32, "", propia=False)

    assert wl.nombreContraparte(_BECH32, entrada) == _BECH32
    assert wl.nombreContraparte(_BECH32, wl.EntradaLibreta("btc", _BECH32, "Binance", False)) == "Binance"
