"""Pruebas de las listas públicas de tokens (providers/listas_tokens.py).

Ninguna sale a la red: la descarga es un `obtenerJson` falso.
"""

from urllib.error import URLError

from providers import listas_tokens
from providers.listas_tokens import ListasTokens, TokenPublico, tokensDeLista

_LINK = "0x514910771af9ca656af840dff83e8264ecf986ca"
_CAKE = "0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82"
_REDES = {1: "eth", 56: "bnb"}


def _lista(*tokens):
    return {"name": "Prueba", "tokens": [
        {"chainId": cadena, "address": contrato, "symbol": simbolo} for cadena, contrato, simbolo in tokens
    ]}


class Reloj:
    def __init__(self):
        self.ahora = 1000.0

    def __call__(self):
        return self.ahora


class Fuente:
    """Respuestas por URL; una excepción como respuesta se lanza."""

    def __init__(self, respuestas):
        self.respuestas = respuestas
        self.pedidas = []

    def __call__(self, url, **_):
        self.pedidas.append(url)
        respuesta = self.respuestas[url]
        if isinstance(respuesta, Exception):
            raise respuesta
        return respuesta


def _listas(fuente, reloj=None, urls=("https://a", "https://b"), horas=24):
    return ListasTokens(urls=lambda: list(urls), horas=lambda: horas, obtenerJson=fuente, reloj=reloj or Reloj())


def testSoloEntranLasRedesQueSeLeenYEnFormaCanonica():
    datos = _lista((1, _LINK.upper().replace("0X", "0x"), "link"), (56, _CAKE, "Cake"), (137, _LINK, "LINK"))

    assert tokensDeLista(datos, _REDES) == [TokenPublico("eth", _LINK, "LINK"), TokenPublico("bnb", _CAKE, "CAKE")]


def testLasEntradasMalFormadasSeDescartanUnaAUna():
    datos = {"tokens": [
        "no es un dict",
        {"chainId": 1, "address": "0x123", "symbol": "CORTO"},
        {"chainId": 1, "address": _LINK, "symbol": "· ·"},
        {"chainId": "1", "address": _LINK, "symbol": "LINK"},
        {"chainId": 1, "address": _LINK, "symbol": "LINK"},
    ]}

    assert tokensDeLista(datos, _REDES) == [TokenPublico("eth", _LINK, "LINK")]


def testUnaRespuestaSinTokensNoRompe():
    assert tokensDeLista(["no", "es", "una", "lista"], _REDES) == []
    assert tokensDeLista({"tokens": "nada"}, _REDES) == []


def testJuntaLasListasSinRepetirContrato():
    fuente = Fuente({"https://a": _lista((1, _LINK, "LINK")),
                     "https://b": _lista((1, _LINK, "LINK"), (56, _CAKE, "CAKE"))})

    tokens = _listas(fuente).tokens()

    assert sorted(t.contrato for t in tokens) == sorted([_LINK, _CAKE])


def testSeDescargaUnaVezHastaQueCaduca():
    fuente = Fuente({"https://a": _lista((1, _LINK, "LINK"))})
    reloj = Reloj()
    listas = _listas(fuente, reloj, urls=("https://a",), horas=24)

    listas.tokens()
    reloj.ahora += 23 * 3600
    listas.tokens()
    assert fuente.pedidas == ["https://a"]

    reloj.ahora += 2 * 3600
    listas.tokens()
    assert fuente.pedidas == ["https://a", "https://a"]


def testSiUnaListaFallaSeSigueConSuUltimaCopiaYSeReintentaAntes():
    fuente = Fuente({"https://a": _lista((1, _LINK, "LINK")), "https://b": _lista((56, _CAKE, "CAKE"))})
    reloj = Reloj()
    listas = _listas(fuente, reloj)
    listas.tokens()

    reloj.ahora += 25 * 3600
    fuente.respuestas["https://a"] = URLError("caída")
    assert {t.contrato for t in listas.tokens()} == {_LINK, _CAKE}

    # El reintento de la que falló llega mucho antes que la renovación diaria de la otra.
    fuente.pedidas.clear()
    reloj.ahora += 16 * 60
    listas.tokens()
    assert fuente.pedidas == ["https://a"]


def testSinCopiaPreviaUnaListaCaidaNoAportaNada():
    fuente = Fuente({"https://a": TimeoutError(), "https://b": _lista((56, _CAKE, "CAKE"))})

    assert _listas(fuente).tokens() == [TokenPublico("bnb", _CAKE, "CAKE")]


def testSoloSeAdmitenUrlHttp():
    fuente = Fuente({})

    assert _listas(fuente, urls=("file:///etc/passwd",)).tokens() == []
    assert fuente.pedidas == []


def testSinListasConfiguradasNoSeDescargaNada():
    fuente = Fuente({})

    assert _listas(fuente, urls=()).tokens() == []
    assert fuente.pedidas == []


def testLaFuncionDelModuloUsaLaCacheCompartida(monkeypatch):
    fuente = Fuente({"https://a": _lista((1, _LINK, "LINK"))})
    monkeypatch.setattr(listas_tokens, "_LISTAS", _listas(fuente, urls=("https://a",)))

    listas_tokens.tokensPublicos()
    listas_tokens.tokensPublicos()

    assert fuente.pedidas == ["https://a"]
