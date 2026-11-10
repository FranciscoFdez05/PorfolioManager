"""Feed de TradingView por WebSocket y su uso como respaldo del scanner.

Nada sale a la red: el protocolo se prueba con un cliente WebSocket falso y el
enmarcado de tramas con un `socket.socketpair` local.
"""

import json
import socket
import struct
from urllib.error import URLError

import pytest

from providers import tradingview_client, tradingview_feed

# conftest sustituye `fetchQuotes` en cada test para que nada abra conexiones
# reales; la de verdad se guarda aquí, al importar, antes de ese parche.
_realFetchQuotes = tradingview_feed.fetchQuotes


def _framed(*messages):
    return "".join(tradingview_feed.encodeMessage(message) for message in messages)


def _qsd(symbol, values=None, status="ok"):
    data = {"n": symbol, "s": status, "v": values or {}}
    return {"m": "qsd", "p": ["qs_x", data]}


def _completed(symbol):
    return {"m": "quote_completed", "p": ["qs_x", symbol]}


class FakeWebSocket:
    """Cliente WebSocket falso: devuelve tramas guionizadas y anota lo enviado."""

    def __init__(self, frames):
        self.frames = list(frames)
        self.sent: list[str] = []
        self.closed = False

    def factory(self, *args, **kwargs):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *excInfo):
        self.closed = True

    def sendText(self, text):
        self.sent.append(text)

    def recvText(self, timeout):
        if not self.frames:
            raise TimeoutError
        return self.frames.pop(0)


def testEncodeYSplitSonInversos():
    text = _framed({"m": "a", "p": ["~m~5~m~ dentro del JSON"]}, "~h~3")

    messages = tradingview_feed.splitMessages(text)

    assert json.loads(messages[0])["p"][0] == "~m~5~m~ dentro del JSON"
    assert messages[1] == "~h~3"


def testFetchQuotesDevuelvePrecioVariacionYDivisa():
    fake = FakeWebSocket([
        _framed({"session_id": "x"}),
        _framed(
            _qsd("VANTAGE:SP500", {"lp": 7519.85, "chp": -0.56, "currency_code": "usd"}),
            _completed("VANTAGE:SP500"),
        ),
    ])

    quotes = _realFetchQuotes(["vantage:sp500"], timeout=5, socketFactory=fake.factory)

    assert quotes == {"VANTAGE:SP500": (7519.85, -0.56, "USD")}
    assert fake.closed
    enviados = [json.loads(tradingview_feed.splitMessages(text)[0]) for text in fake.sent]
    assert enviados[-1] == {"m": "quote_add_symbols", "p": [enviados[1]["p"][0], "VANTAGE:SP500"]}


def testFetchQuotesAcumulaCamposYCalculaVariacionSinChp():
    fake = FakeWebSocket([
        _framed(_qsd("TVC:SPX", {"lp": 110.0})),
        _framed(_qsd("TVC:SPX", {"prev_close_price": 100.0, "currency_code": "USD"}), _completed("TVC:SPX")),
    ])

    quotes = _realFetchQuotes(["TVC:SPX"], timeout=5, socketFactory=fake.factory)

    price, change, currency = quotes["TVC:SPX"]
    assert price == 110.0
    assert change == pytest.approx(10.0)
    assert currency == "USD"


def testFetchQuotesOmiteSimbolosInexistentesSinEsperar():
    fake = FakeWebSocket([
        _framed(_qsd("FOO:NOPE", status="error")),
        _framed(_qsd("TVC:SPX", {"lp": 1.0, "chp": 0}), _completed("TVC:SPX")),
        # Si siguiera esperando a FOO:NOPE leería esta trama y luego TimeoutError.
        _framed(_qsd("TVC:SPX", {"lp": 999.0})),
    ])

    quotes = _realFetchQuotes(["FOO:NOPE", "TVC:SPX"], timeout=5, socketFactory=fake.factory)

    assert quotes == {"TVC:SPX": (1.0, 0.0, "")}
    assert len(fake.frames) == 1


def testFetchQuotesDevuelveElLatido():
    fake = FakeWebSocket([
        _framed("~h~7"),
        _framed(_qsd("TVC:SPX", {"lp": 1.0, "chp": 0}), _completed("TVC:SPX")),
    ])

    _realFetchQuotes(["TVC:SPX"], timeout=5, socketFactory=fake.factory)

    assert tradingview_feed.encodeMessage("~h~7") in fake.sent


def testFetchQuotesSeCortaAlAgotarElPlazo():
    instantes = iter([0.0, 0.0, 100.0])
    fake = FakeWebSocket([_framed({"session_id": "x"}), _framed(_qsd("TVC:SPX", {"lp": 5.0}))])

    quotes = _realFetchQuotes(["TVC:SPX"], timeout=5, socketFactory=fake.factory, clock=lambda: next(instantes))

    assert quotes == {}
    assert len(fake.frames) == 1


def testFetchQuotesSinSimbolosNoConecta():
    def noDebeConectar(*args, **kwargs):
        raise AssertionError("no debería abrir conexión")

    assert _realFetchQuotes(["", "  "], socketFactory=noDebeConectar) == {}


def testFetchQuotesErrorCriticoSube():
    fake = FakeWebSocket([_framed({"m": "critical_error", "p": []})])

    with pytest.raises(tradingview_feed.FeedError):
        _realFetchQuotes(["TVC:SPX"], timeout=5, socketFactory=fake.factory)


# --- Enmarcado RFC 6455 sobre un socket local ---------------------------------


def _serverFrame(opcode, payload, final=True):
    header = bytes([(0x80 if final else 0) | opcode])
    size = len(payload)
    if size < 126:
        header += bytes([size])
    else:
        header += bytes([126]) + struct.pack(">H", size)
    return header + payload


def _readClientFrame(sock):
    first, second = sock.recv(2)
    size = second & 0x7F
    if size == 126:
        size = struct.unpack(">H", sock.recv(2))[0]
    mask = sock.recv(4)
    payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(sock.recv(size)))
    return first & 0x0F, bool(second & 0x80), payload


@pytest.fixture
def parSockets():
    cliente, servidor = socket.socketpair()
    ws = tradingview_feed._WebSocket("h", 443, "/", "o", 5, maxFrameBytes=1000)
    ws._sock = cliente
    yield ws, servidor
    cliente.close()
    servidor.close()


def testSendTextVaEnmascarado(parSockets):
    ws, servidor = parSockets

    ws.sendText("x" * 200)

    opcode, enmascarado, payload = _readClientFrame(servidor)
    assert (opcode, enmascarado, payload) == (0x1, True, b"x" * 200)


def testRecvTextUneFragmentosYContestaPing(parSockets):
    ws, servidor = parSockets
    servidor.sendall(
        _serverFrame(0x1, b"hola ", final=False) + _serverFrame(0x9, b"p") + _serverFrame(0x0, b"mundo")
    )

    assert ws.recvText(5) == "hola mundo"
    assert _readClientFrame(servidor) == (0xA, True, b"p")


def testRecvTextRechazaTramaDemasiadoGrande(parSockets):
    ws, servidor = parSockets
    servidor.sendall(_serverFrame(0x1, b"x" * 1001))

    with pytest.raises(tradingview_feed.FeedError):
        ws.recvText(5)


def testRecvTextCierreDelServidor(parSockets):
    ws, servidor = parSockets
    servidor.sendall(_serverFrame(0x8, b""))

    with pytest.raises(tradingview_feed.FeedError):
        ws.recvText(5)


# --- Respaldo en el cliente ----------------------------------------------------


def _scannerVacio(url, params=None, timeout=None, jsonBody=None, headers=None):
    if jsonBody is not None:
        return {"data": []}
    return {
        "symbols": [
            {"symbol": "SP500", "exchange": "VANTAGE", "description": "S&P Index Cash CFD (USD)",
             "type": "index", "currency_code": "USD"},
        ]
    }


def testSearchSymbolCotizaConElFeedLoQueElScannerNoTiene(monkeypatch):
    monkeypatch.setattr(tradingview_client, "_fetchJson", _scannerVacio)
    monkeypatch.setattr(
        tradingview_feed, "fetchQuotes", lambda symbols, timeout=None: {"VANTAGE:SP500": (7519.85, -0.56, "USD")}
    )

    results, error = tradingview_client.searchSymbol("VANTAGE:SP500")

    assert error is None
    assert results[0]["symbol"] == "VANTAGE:SP500"
    assert results[0]["price"] != ""
    assert results[0]["currency"] == "USD"


def testFetchQuoteUsaElFeedSiElScannerNoLoTiene(monkeypatch):
    monkeypatch.setattr(tradingview_client, "_fetchJson", _scannerVacio)
    monkeypatch.setattr(tradingview_feed, "fetchQuotes", lambda symbols, timeout=None: {"TVC:SPX": (100.0, 1.0, "USD")})

    quote, error = tradingview_client.fetchQuote("TVC:SPX")

    assert error is None
    assert quote["marketData"]["currentPrice"] == 100.0
    assert quote["status"] == "Cotización actualizada"


def testFallosDelFeedQuedanEnSinCotizacion(monkeypatch):
    def feedCaido(symbols, timeout=None):
        raise URLError("sin red")

    monkeypatch.setattr(tradingview_client, "_fetchJson", _scannerVacio)
    monkeypatch.setattr(tradingview_feed, "fetchQuotes", feedCaido)

    results, error = tradingview_client.searchSymbol("VANTAGE:SP500")
    quote, quoteError = tradingview_client.fetchQuote("VANTAGE:SP500")

    assert error is None and results[0]["price"] == ""
    assert quote is None and "no devolvió cotización" in quoteError


def testElFeedNoSePideSiElScannerYaCotiza(monkeypatch):
    def scannerConPrecio(url, params=None, timeout=None, jsonBody=None, headers=None):
        return {"data": [{"s": "NASDAQ:AAPL", "d": [1.0, 0.0, "USD"]}]}

    def noDebeLlamarse(symbols, timeout=None):
        raise AssertionError("el feed no hacía falta")

    monkeypatch.setattr(tradingview_client, "_fetchJson", scannerConPrecio)
    monkeypatch.setattr(tradingview_feed, "fetchQuotes", noDebeLlamarse)

    quote, error = tradingview_client.fetchQuote("NASDAQ:AAPL")

    assert error is None and quote["marketData"]["currentPrice"] == 1.0
