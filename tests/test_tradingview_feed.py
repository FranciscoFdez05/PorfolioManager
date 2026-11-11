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
_realFetchSeries = tradingview_feed.fetchSeries
_realFetchSeriesWithCurrency = tradingview_feed.fetchSeriesWithCurrency


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


# --- Velas (fetchSeries) -------------------------------------------------------


def _sesiones(fake):
    """Sesión de gráfico creada para cada símbolo, en el orden en que se pidieron."""
    enviados = [json.loads(tradingview_feed.splitMessages(text)[0]) for text in fake.sent]
    sesiones = [m["p"][0] for m in enviados if m["m"] == "chart_create_session"]
    simbolos = [json.loads(m["p"][2][1:])["symbol"] for m in enviados if m["m"] == "resolve_symbol"]
    return dict(zip(simbolos, sesiones))


def _velas(sesion, *cierres, desde=1000, paso=300):
    barras = [{"i": i, "v": [desde + i * paso, 1.0, 2.0, 0.5, cierre, 10.0]} for i, cierre in enumerate(cierres)]
    return {"m": "timescale_update", "p": [sesion, {"s": {"s": barras}}]}


class GuionVelas(FakeWebSocket):
    """Socket falso que contesta según las sesiones que ha abierto el cliente.

    Las sesiones llevan un sufijo aleatorio, así que las tramas no se pueden
    escribir de antemano: `guion(sesiones)` las construye al primer `recvText`.
    """

    def __init__(self, guion):
        super().__init__([])
        self.guion = guion
        self.preparado = False

    def recvText(self, timeout):
        if not self.preparado:
            self.frames = [_framed(*mensajes) for mensajes in self.guion(_sesiones(self))]
            self.preparado = True
        return super().recvText(timeout)


def testFetchSeriesUnaSesionPorSimboloYCierresOrdenados():
    fake = GuionVelas(lambda s: [
        [_velas(s["NASDAQ:NDX"], 10.0, 11.0, 12.0)],
        [{"m": "series_completed", "p": [s["NASDAQ:NDX"], "s", "delayed_streaming_900"]}],
        [_velas(s["TVC:UKOIL"], 90.0, 91.0), {"m": "series_completed", "p": [s["TVC:UKOIL"], "s", "streaming"]}],
    ])

    series = _realFetchSeries(["nasdaq:ndx", "TVC:UKOIL", "NASDAQ:NDX"], "5", 300, timeout=5, socketFactory=fake.factory)

    assert series == {
        "NASDAQ:NDX": [(1000, 10.0), (1300, 11.0), (1600, 12.0)],
        "TVC:UKOIL": [(1000, 90.0), (1300, 91.0)],
    }
    # El feed admite una sola serie por sesión de gráfico: una sesión por símbolo.
    assert len(set(_sesiones(fake).values())) == 2
    creadas = [json.loads(tradingview_feed.splitMessages(t)[0]) for t in fake.sent]
    assert [m["p"][4:6] for m in creadas if m["m"] == "create_series"] == [["5", 300], ["5", 300]]
    assert fake.closed


def testFetchSeriesOmiteSimbolosInexistentesSinEsperar():
    fake = GuionVelas(lambda s: [
        [{"m": "symbol_error", "p": [s["FOO:NOPE"], "sym", "invalid symbol"]}],
        [_velas(s["SP:SPX"], 1.0, 2.0), {"m": "series_completed", "p": [s["SP:SPX"], "s"]}],
        # Si siguiera esperando a FOO:NOPE leería esta trama y luego TimeoutError.
        [_velas(s["SP:SPX"], 99.0)],
    ])

    series = _realFetchSeries(["FOO:NOPE", "SP:SPX"], "5", 300, timeout=5, socketFactory=fake.factory)

    assert series == {"SP:SPX": [(1000, 1.0), (1300, 2.0)]}
    assert len(fake.frames) == 1


def testFetchSeriesDescartaLasSesionesSinCompletar():
    fake = GuionVelas(lambda s: [[_velas(s["SP:SPX"], 1.0, 2.0)]])

    assert _realFetchSeries(["SP:SPX"], "5", 300, timeout=5, socketFactory=fake.factory) == {}


def testFetchSeriesIgnoraVelasMalFormadasYDevuelveElLatido():
    fake = GuionVelas(lambda s: [
        ["~h~3"],
        [
            {"m": "timescale_update", "p": [s["SP:SPX"], {"s": {"s": [
                {"i": 0, "v": [1000, 1, 1, 1, 5.0]},
                {"i": 1, "v": ["x", 1, 1, 1, 6.0]},
                {"i": 2, "v": [1600, 1, 1, 1]},
                {"i": 3, "v": [1900, 1, 1, 1, 0]},
                "basura",
            ]}}]},
            {"m": "series_completed", "p": [s["SP:SPX"], "s"]},
        ],
    ])

    series = _realFetchSeries(["SP:SPX"], "5", 300, timeout=5, socketFactory=fake.factory)

    assert series == {"SP:SPX": [(1000, 5.0)]}
    assert tradingview_feed.encodeMessage("~h~3") in fake.sent


def testFetchSeriesErrorCriticoSube():
    fake = GuionVelas(lambda s: [[{"m": "critical_error", "p": ["x", "exceed limit of series in the session"]}]])

    with pytest.raises(tradingview_feed.FeedError):
        _realFetchSeries(["SP:SPX"], "5", 300, timeout=5, socketFactory=fake.factory)


def testFetchSeriesWithCurrencyDevuelveLaDivisaDeCadaSimbolo():
    fake = GuionVelas(lambda s: [
        [
            {"m": "symbol_resolved", "p": [s["NASDAQ:AAPL"], "sym", {"name": "AAPL", "currency_code": "usd"}]},
            {"m": "symbol_resolved", "p": [s["XETR:SAP"], "sym", {"name": "SAP"}]},
        ],
        [_velas(s["NASDAQ:AAPL"], 1.0, 2.0), {"m": "series_completed", "p": [s["NASDAQ:AAPL"], "s"]}],
        [_velas(s["XETR:SAP"], 3.0), {"m": "series_completed", "p": [s["XETR:SAP"], "s"]}],
    ])

    series = _realFetchSeriesWithCurrency(["NASDAQ:AAPL", "XETR:SAP"], "1D", 2, timeout=5, socketFactory=fake.factory)

    # `_velas` pone máximo 2 y mínimo 0,5; un cierre de 3 sube el máximo a 3.
    assert series == {
        "NASDAQ:AAPL": ("USD", [(1000, 1.0, 2.0, 0.5), (1300, 2.0, 2.0, 0.5)]),
        "XETR:SAP": (None, [(1000, 3.0, 3.0, 0.5)]),
    }


def testFetchSeriesWithCurrencyMaximoYMinimoIlegiblesUsanElCierre():
    fake = GuionVelas(lambda s: [[
        {"m": "timescale_update", "p": [s["SP:SPX"], {"s": {"s": [
            {"i": 0, "v": [1000, 1, "x", None, 5.0]},
            {"i": 1, "v": [1300, 1, 7.0, 0, 6.0]},
        ]}}]},
        {"m": "series_completed", "p": [s["SP:SPX"], "s"]},
    ]])

    series = _realFetchSeriesWithCurrency(["SP:SPX"], "1D", 2, timeout=5, socketFactory=fake.factory)

    assert series == {"SP:SPX": (None, [(1000, 5.0, 5.0, 5.0), (1300, 6.0, 7.0, 6.0)])}


def testFetchSeriesSinSimbolosNoConecta():
    def noDebeConectar(*args, **kwargs):
        raise AssertionError("no debería abrir conexión")

    assert _realFetchSeries([" "], "5", 300, socketFactory=noDebeConectar) == {}


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
