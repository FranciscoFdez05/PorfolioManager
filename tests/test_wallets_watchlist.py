"""Pruebas de la lista «Seguimiento» de la Watchlist (core/wallets_watchlist.py)."""

import pytest

from core.wallets_watchlist import TIPO_MONEDA, TIPO_TOKEN, ListaWatchlist
from providers.listas_tokens import TokenPublico
from stores import wallets_store as ws

_SECRET = "a" * 16 + "0123456789abcdef0123456789abcdef"
_ACTIVOS = [{"id": "link", "name": "Chainlink", "symbol": "LINK", "marketSymbol": "", "type": "cripto"}]


@pytest.fixture
def repositorio(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", _SECRET)
    return ws.WalletsRepository(ruta=tmp_path / "wallets.key")


def _wallet(red, valor, assetId="", propia=True):
    return ws.Wallet(id=ws.nuevoId(), alias=f"Wallet {valor[-4:]}", red=red, tipo="direccion", valor=valor,
                     assetId=assetId, creada=ws.ahoraIso(), propia=propia)


def _lista(repositorio, publicos=()):
    return ListaWatchlist(repositorio, leerActivos=lambda: _ACTIVOS, leerStablecoins=lambda: ["USDC"],
                          leerTokensPublicos=lambda: list(publicos))


def testUnaMonedaPorRedConElPrimerActivoAsociado(repositorio):
    repositorio.anadir(_wallet("eth", "0x" + "a" * 40, propia=False))
    repositorio.anadir(_wallet("eth", "0x" + "b" * 40, assetId="ethereum"))

    entradas = _lista(repositorio).entradas()

    assert [(e["tipo"], e["red"], e["simbolo"], e["assetId"]) for e in entradas] == [
        (TIPO_MONEDA, "eth", "ETH", "ethereum")
    ]


def testSinWalletsNoHayNada(repositorio):
    assert _lista(repositorio).entradas() == []


def testLosTokensSalenConSuActivoTickerYEtiquetaYSinImitaciones(repositorio):
    repositorio.anadir(_wallet("eth", "0x" + "a" * 40, assetId="ethereum"))
    repositorio.anotarTokensConocidos([
        ws.TokenConocido("eth", "0xlink", "LINK", "Chainlink"),
        ws.TokenConocido("eth", "0xpepe", "PEPE", "Pepe"),
        ws.TokenConocido("eth", "0xusdc", "USDC"),
        # Copia de LINK (la lista pública dice que el auténtico es 0xlink) y token con el nombre de la red.
        ws.TokenConocido("eth", "0xcopia", "LINK"),
        ws.TokenConocido("eth", "0xfalso", "ETH"),
        # De una red sin wallets enlazadas ya: no se enseña.
        ws.TokenConocido("bnb", "0xcake", "CAKE"),
    ])
    repositorio.guardarPrecioToken(ws.TokenPrecio("eth", "0xpepe", "tradingview", "BINANCE:PEPEUSDT"))
    repositorio.marcarSospechoso("eth", "0xpepe")

    tokens = [e for e in _lista(repositorio, [TokenPublico("eth", "0xlink", "LINK")]).entradas()
              if e["tipo"] == TIPO_TOKEN]

    assert [t["contrato"] for t in tokens] == ["0xlink", "0xpepe", "0xusdc"]
    link, pepe, usdc = tokens
    assert (link["assetId"], link["ticker"], link["sospechoso"]) == ("link", "", False)
    assert (pepe["assetId"], pepe["proveedor"], pepe["ticker"], pepe["sospechoso"]) == (
        "", "tradingview", "BINANCE:PEPEUSDT", True
    )
    assert (usdc["assetId"], usdc["nombre"]) == ("stablecoin-USDC", "USDC")


def testElTickerPuestoAManoMandaSobreElActivo(repositorio):
    repositorio.anadir(_wallet("eth", "0x" + "a" * 40))
    repositorio.anotarTokensConocidos([ws.TokenConocido("eth", "0xlink", "LINK")])
    repositorio.guardarPrecioToken(ws.TokenPrecio("eth", "0xlink", "yahoo", "LINK-EUR"))

    token = _lista(repositorio).entradas()[1]

    assert (token["assetId"], token["ticker"]) == ("", "LINK-EUR")


def testElTickerDeLaMonedaMandaSobreSuActivo(repositorio):
    repositorio.anadir(_wallet("bnb", "0x" + "a" * 40, assetId="ethereum"))
    repositorio.anadir(_wallet("eth", "0x" + "b" * 40, assetId="ethereum"))
    repositorio.guardarPrecioToken(ws.TokenPrecio("bnb", "", "tradingview", "BINANCE:BNBEUR"))

    bnb, eth = _lista(repositorio).entradas()

    assert (bnb["assetId"], bnb["proveedor"], bnb["ticker"]) == ("", "tradingview", "BINANCE:BNBEUR")
    assert (eth["assetId"], eth["ticker"]) == ("ethereum", "")


def testSinTokensNoSeDescarganLasListas(repositorio):
    repositorio.anadir(_wallet("eth", "0x" + "a" * 40))
    lista = ListaWatchlist(repositorio, leerTokensPublicos=lambda: pytest.fail("no debe descargar las listas"))

    assert len(lista.entradas()) == 1
