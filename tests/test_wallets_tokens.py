"""Pruebas de la regla de tokens verificados (core/wallets_tokens.py)."""

import pytest

from core.wallets_tokens import (
    IMITACION,
    LEGITIMO,
    RECONOCIDO,
    SIN_VERIFICAR,
    VERIFICADO,
    anotarConocidos,
    estadoToken,
    indiceMarcas,
    indicePublico,
    indiceVerificados,
    publicosRelacionados,
)
from providers.listas_tokens import TokenPublico
from stores.wallets_store import TokenConocido, TokenMarcado, TokenVerificado, WalletsRepository

_INDICE = indiceVerificados([
    TokenVerificado("eth", "0xpepe", "PEPE"),
    TokenVerificado("eth", "0xusdt", "USDT"),
    TokenVerificado("eth", "0xusdtpuente", "USDT"),
])


@pytest.mark.parametrize("red, simbolo, contrato, esperado", [
    ("eth", "PEPE", "0xpepe", VERIFICADO),
    ("eth", "PEPE", "0xcopia", IMITACION),
    ("eth", "USDT", "0xusdtpuente", VERIFICADO),
    ("eth", "SHIB", "0xshib", SIN_VERIFICAR),
    # La verificación es de una red: en BNB nadie ha confirmado ningún PEPE.
    ("bnb", "PEPE", "0xcopia", SIN_VERIFICAR),
    # Con el nombre de la moneda de la red es imitación aunque no haya nada verificado.
    ("eth", "ETH", "0xfalso", IMITACION),
    ("bnb", "BNB", "0xfalso", IMITACION),
    # Con acentos o marcas encima siguen siendo el mismo símbolo.
    ("eth", "ĖŢḤ", "0xfalso", IMITACION),
    ("eth", "PEPĖ", "0xcopia", IMITACION),
    ("eth", "PEPĖ", "0xpepe", VERIFICADO),
    # Sin contrato no es un token: la moneda nativa.
    ("eth", "ETH", "", ""),
])
def testEstadoToken(red, simbolo, contrato, esperado):
    assert estadoToken(red, simbolo, contrato, _INDICE) == esperado


def testSinNadaVerificadoTodoEstaSinVerificar():
    assert estadoToken("eth", "PEPE", "0xpepe", indiceVerificados([])) == SIN_VERIFICAR


def testUnaRedDesconocidaNoRompe():
    assert estadoToken("zzz", "PEPE", "0xpepe", _INDICE) == SIN_VERIFICAR


_MARCAS = indiceMarcas([
    TokenMarcado("eth", "0xcopia", "legitimo"),
    TokenMarcado("eth", "0xfalso", "legitimo"),
    TokenMarcado("eth", "0xshib", "imitacion"),
])


@pytest.mark.parametrize("red, simbolo, contrato, esperado", [
    # La marca del usuario manda sobre la detección automática.
    ("eth", "PEPE", "0xcopia", LEGITIMO),
    ("eth", "ETH", "0xfalso", LEGITIMO),
    ("eth", "SHIB", "0xshib", IMITACION),
    # Las marcas son de un contrato en una red.
    ("bnb", "SHIB", "0xshib", SIN_VERIFICAR),
    ("eth", "PEPE", "0xotra", IMITACION),
    ("eth", "PEPE", "0xpepe", VERIFICADO),
    # Sin contrato no hay token que marcar.
    ("eth", "ETH", "", ""),
])
def testLaMarcaDelUsuarioMandaSobreLaRegla(red, simbolo, contrato, esperado):
    assert estadoToken(red, simbolo, contrato, _INDICE, _MARCAS) == esperado


# ── Listas públicas ───────────────────────────────────────────────────────────

_PUBLICOS = indicePublico([
    TokenPublico("eth", "0xlink", "LINK"),
    # CoinGecko llama «RENDER» al contrato que en la red se llama «RNDR».
    TokenPublico("eth", "0xrender", "RENDER"),
    TokenPublico("eth", "0xpepe", "PEPE"),
    TokenPublico("bnb", "0xcake", "CAKE"),
])


@pytest.mark.parametrize("red, simbolo, contrato, esperado", [
    ("eth", "LINK", "0xlink", RECONOCIDO),
    ("eth", "LINK", "0xcopia", IMITACION),
    ("eth", "ŁINK", "0xcopia", SIN_VERIFICAR),
    ("eth", "LİNK", "0xcopia", IMITACION),
    # Se reconoce por contrato, aunque la lista lo llame de otra manera.
    ("eth", "RNDR", "0xrender", RECONOCIDO),
    ("eth", "SHIB", "0xshib", SIN_VERIFICAR),
    # Las listas son por red.
    ("bnb", "LINK", "0xcopia", SIN_VERIFICAR),
    ("eth", "CAKE", "0xcake", SIN_VERIFICAR),
    # Lo que confirma el usuario manda sobre las listas.
    ("eth", "PEPE", "0xpepe", IMITACION),
    ("eth", "PEPE", "0xmipepe", VERIFICADO),
    # Y la moneda de la red no se puede reconocer como token.
    ("eth", "ETH", "0xfalso", IMITACION),
])
def testLasListasPublicasDecidenLoQueNadieHaVerificado(red, simbolo, contrato, esperado):
    indice = indiceVerificados([TokenVerificado("eth", "0xmipepe", "PEPE")])

    assert estadoToken(red, simbolo, contrato, indice, publicos=_PUBLICOS) == esperado


def testLaMarcaDelUsuarioMandaSobreLasListas():
    marcas = indiceMarcas([TokenMarcado("eth", "0xlink", "imitacion"), TokenMarcado("eth", "0xcopia", "legitimo")])

    assert estadoToken("eth", "LINK", "0xlink", {}, marcas, _PUBLICOS) == IMITACION
    assert estadoToken("eth", "LINK", "0xcopia", {}, marcas, _PUBLICOS) == LEGITIMO


def testSinListasTodoSigueComoAntes():
    assert estadoToken("eth", "LINK", "0xlink", {}) == SIN_VERIFICAR


def testLosRelacionadosSonElPropioContratoYLosDeSuSimbolo():
    relacionados = publicosRelacionados(_PUBLICOS, [
        ("eth", "RNDR", "0xrender"),
        ("eth", "LINK", "0xcopia"),
        ("eth", "SHIB", "0xshib"),
        ("bnb", "LINK", "0xotra"),
    ])

    assert sorted(t.contrato for t in relacionados) == ["0xlink", "0xrender"]


def testLosRelacionadosNoSeRepiten():
    relacionados = publicosRelacionados(_PUBLICOS, [("eth", "LINK", "0xlink"), ("eth", "LINK", "0xcopia")])

    assert relacionados == [TokenPublico("eth", "0xlink", "LINK")]


# ── Tokens vistos ─────────────────────────────────────────────────────────────


def testAnotarConocidosGuardaLosTokensConContrato(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "a" * 16 + "0123456789abcdef0123456789abcdef")
    repositorio = WalletsRepository(ruta=tmp_path / "wallets.key")

    anotados = anotarConocidos(repositorio, "eth", [("0x1", "PEPE", "Pepe"), ("", "ETH", "")])

    assert anotados == 1
    assert repositorio.tokensConocidos() == [TokenConocido("eth", "0x1", "PEPE", "Pepe")]


def testAnotarConocidosSinSecretKeyNoRompeLaLectura(tmp_path, monkeypatch):
    # Quien sigue solo wallets ajenas no tiene por qué tener SECRET_KEY.
    monkeypatch.delenv("SECRET_KEY", raising=False)
    repositorio = WalletsRepository(ruta=tmp_path / "wallets.key")

    assert anotarConocidos(repositorio, "eth", [("0x1", "PEPE", "")]) == 0
    assert not repositorio.ruta.exists()
