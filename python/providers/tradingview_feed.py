"""Cotizaciones del feed en tiempo real de TradingView (el WebSocket de sus gráficos).

El scanner HTTP de `tradingview_client` solo cubre lo que sale en las tablas
del screener: acciones, ETF, cripto, futuros y algunos CFD. Los índices
(`TVC:SPX`) y la mayoría de los CFD de brókers (`VANTAGE:SP500`,
`CAPITALCOM:US500`) no están ahí y la búsqueda los enseñaba "sin cotización"
aunque tradingview.com los cotice. El feed del gráfico sí los tiene, sin
cuenta ni clave (con el token anónimo `unauthorized_user_token`, el mismo que
usa la web sin sesión iniciada).

Comprobado contra el servidor real: `quote_add_symbols` contesta por cada
símbolo un `qsd` con `lp` (último precio), `ch`, `chp`, `currency_code` y
`prev_close_price`, seguido de `quote_completed`; un símbolo que no existe
llega como `qsd` con `"s": "error"`.

No hay librería de WebSocket entre las dependencias y para pedir una foto de
precios basta con lo mínimo del RFC 6455 (handshake, tramas de texto
enmascaradas, ping/pong y cierre), así que se implementa aquí sobre
`socket` + `ssl` en lugar de añadir una dependencia para esto solo.
"""

import base64
import hashlib
import json
import logging
import os
import re
import secrets
import socket
import ssl
import struct
import time
from collections.abc import Callable, Iterable

from core import settings
from providers.api_stats import recordApiCall
from providers.conexion import conectar
from providers.http import ProviderError

log = logging.getLogger(__name__)

FEED_HOST = "data.tradingview.com"
FEED_PORT = 443
FEED_PATH = "/socket.io/websocket?from=chart%2F&type=chart"
# El servidor rechaza el handshake sin un Origin de tradingview.com.
FEED_ORIGIN = "https://www.tradingview.com"

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_OPCODE_CONTINUATION = 0x0
_OPCODE_TEXT = 0x1
_OPCODE_CLOSE = 0x8
_OPCODE_PING = 0x9
_OPCODE_PONG = 0xA

_QUOTE_FIELDS = ["lp", "ch", "chp", "currency_code", "prev_close_price"]
_MESSAGE_HEADER_RE = re.compile(r"~m~(\d+)~m~")


class FeedError(ProviderError):
    """Fallo del protocolo del feed (handshake rechazado, trama inválida, cierre).

    Hereda de `ProviderError` (y por tanto de `URLError`) para que los
    llamantes lo traten igual que un fallo de conexión de los clientes HTTP.
    """


class _WebSocket:
    """Cliente WebSocket mínimo y síncrono: solo lo que necesita el feed.

    Args:
        host: Servidor.
        port: Puerto TLS.
        path: Ruta con la query del handshake.
        origin: Cabecera Origin.
        timeout: Segundos para conectar y para cada lectura.
        maxFrameBytes: Tope de tamaño por trama, para no cargar en memoria lo
            que mande el servidor.
        connect: Función de conexión TCP, inyectable para los tests.
    """

    def __init__(
        self,
        host: str,
        port: int,
        path: str,
        origin: str,
        timeout: float,
        maxFrameBytes: int,
        connect: Callable[..., socket.socket] = conectar,
    ) -> None:
        self.host = host
        self.port = port
        self.path = path
        self.origin = origin
        self.timeout = timeout
        self.maxFrameBytes = maxFrameBytes
        self._connect = connect
        self._sock: socket.socket | None = None
        self._buffer = b""

    def __enter__(self) -> "_WebSocket":
        self.open()
        return self

    def __exit__(self, *excInfo) -> None:
        self.close()

    def open(self) -> None:
        """Conecta por TLS y hace el handshake.

        Raises:
            OSError: fallo de red o de TLS.
            FeedError: el servidor no acepta el cambio a WebSocket.
        """
        rawSock = self._connect((self.host, self.port), self.timeout)
        try:
            context = ssl.create_default_context()
            self._sock = context.wrap_socket(rawSock, server_hostname=self.host)
            self._handshake()
        except BaseException:
            (self._sock or rawSock).close()
            self._sock = None
            raise

    def _handshake(self) -> None:
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Origin: {self.origin}\r\n"
            f"User-Agent: {settings.proveedorUserAgent()}\r\n"
            "\r\n"
        )
        self._sock.sendall(request.encode("ascii"))

        while b"\r\n\r\n" not in self._buffer:
            if len(self._buffer) > 16384:
                raise FeedError("Cabeceras del handshake demasiado largas")
            self._buffer += self._recvChunk()
        rawHeaders, self._buffer = self._buffer.split(b"\r\n\r\n", 1)

        lines = rawHeaders.decode("latin-1").split("\r\n")
        if " 101 " not in f"{lines[0]} ":
            raise FeedError(f"El feed de TradingView rechazó la conexión ({lines[0].strip()})")
        headers = {
            name.strip().lower(): value.strip()
            for name, _, value in (line.partition(":") for line in lines[1:])
        }
        expected = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            raise FeedError("Handshake del feed de TradingView no válido")

    def _recvChunk(self) -> bytes:
        chunk = self._sock.recv(65536)
        if not chunk:
            raise FeedError("El feed de TradingView cerró la conexión")
        return chunk

    def _recvExact(self, size: int) -> bytes:
        while len(self._buffer) < size:
            self._buffer += self._recvChunk()
        data, self._buffer = self._buffer[:size], self._buffer[size:]
        return data

    def _sendFrame(self, opcode: int, payload: bytes) -> None:
        # RFC 6455 5.3: todo lo que manda el cliente va enmascarado.
        mask = os.urandom(4)
        size = len(payload)
        header = bytes([0x80 | opcode])
        if size < 126:
            header += bytes([0x80 | size])
        elif size < 65536:
            header += bytes([0x80 | 126]) + struct.pack(">H", size)
        else:
            header += bytes([0x80 | 127]) + struct.pack(">Q", size)
        masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
        self._sock.sendall(header + mask + masked)

    def sendText(self, text: str) -> None:
        """Manda un mensaje de texto.

        Args:
            text: Contenido del mensaje.
        """
        self._sendFrame(_OPCODE_TEXT, text.encode("utf-8"))

    def recvText(self, timeout: float) -> str:
        """Lee el siguiente mensaje de texto completo, contestando los ping.

        Args:
            timeout: Segundos máximos de espera para esta lectura.

        Returns:
            El texto del mensaje.

        Raises:
            TimeoutError: no llegó nada a tiempo.
            FeedError: el servidor cerró o mandó una trama fuera de tope.
        """
        self._sock.settimeout(max(timeout, 0.01))
        parts: list[bytes] = []
        while True:
            first, second = self._recvExact(2)
            final = bool(first & 0x80)
            opcode = first & 0x0F
            size = second & 0x7F
            if size == 126:
                size = struct.unpack(">H", self._recvExact(2))[0]
            elif size == 127:
                size = struct.unpack(">Q", self._recvExact(8))[0]
            if size > self.maxFrameBytes:
                raise FeedError("Trama del feed de TradingView demasiado grande")
            # El servidor nunca enmascara (RFC 6455 5.1); si lo hiciera, se descarta la clave.
            mask = self._recvExact(4) if second & 0x80 else b""
            payload = self._recvExact(size)
            if mask:
                payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

            if opcode == _OPCODE_PING:
                self._sendFrame(_OPCODE_PONG, payload)
                continue
            if opcode == _OPCODE_PONG:
                continue
            if opcode == _OPCODE_CLOSE:
                raise FeedError("El feed de TradingView cerró la conexión")
            if opcode in (_OPCODE_TEXT, _OPCODE_CONTINUATION):
                parts.append(payload)
                if final:
                    return b"".join(parts).decode("utf-8", errors="replace")

    def close(self) -> None:
        """Cierra la conexión sin esperar la respuesta del servidor."""
        if self._sock is None:
            return
        try:
            self._sendFrame(_OPCODE_CLOSE, b"")
        except OSError:
            pass  # la conexión ya estaba rota: solo queda soltar el socket
        finally:
            self._sock.close()
            self._sock = None


def encodeMessage(message: dict | str) -> str:
    """Envuelve un mensaje en el marco `~m~<longitud>~m~` del protocolo.

    Args:
        message: Un dict (se serializa a JSON) o un texto ya preparado.

    Returns:
        El mensaje enmarcado.
    """
    body = message if isinstance(message, str) else json.dumps(message, separators=(",", ":"))
    return f"~m~{len(body)}~m~{body}"


def splitMessages(text: str) -> list[str]:
    """Separa los mensajes enmarcados que vienen juntos en una trama.

    Se corta por la longitud declarada y no por el separador, porque `~m~`
    puede aparecer dentro del propio JSON (en una descripción, por ejemplo).
    La longitud es en caracteres: así la calcula el servidor (JavaScript).

    Args:
        text: Contenido de una trama de texto.

    Returns:
        Los mensajes, sin el marco.
    """
    messages = []
    position = 0
    while position < len(text):
        match = _MESSAGE_HEADER_RE.match(text, position)
        if not match:
            break
        start = match.end()
        end = start + int(match.group(1))
        messages.append(text[start:end])
        position = end
    return messages


def _parseQuote(values: dict) -> tuple[float, float, str] | None:
    """`(precio, variación %, divisa)` de los campos acumulados de un símbolo."""
    try:
        price = float(values.get("lp") or 0)
    except (TypeError, ValueError):
        return None
    if price <= 0:
        return None

    changePercent = values.get("chp")
    if changePercent is None:
        # Sin `chp` se calcula con el cierre anterior, si lo hay; si no, 0.
        try:
            previousClose = float(values.get("prev_close_price") or 0)
        except (TypeError, ValueError):
            previousClose = 0.0
        changePercent = (price / previousClose - 1) * 100 if previousClose > 0 else 0.0

    currency = str(values.get("currency_code") or "").strip().upper()
    return price, float(changePercent), currency


def _handleMessage(
    rawMessage: str,
    socketClient: _WebSocket,
    pending: set[str],
    fields: dict[str, dict],
) -> None:
    """Procesa un mensaje del feed: latidos, datos de cotización y fin de símbolo."""
    if rawMessage.startswith("~h~"):
        # Latido: si no se devuelve, el servidor corta la sesión.
        socketClient.sendText(encodeMessage(rawMessage))
        return
    try:
        message = json.loads(rawMessage)
    except ValueError:
        return  # mensajes de control que no son JSON: no afectan a las cotizaciones
    if not isinstance(message, dict):
        return

    method = message.get("m")
    params = message.get("p") or []
    if method == "qsd" and len(params) > 1 and isinstance(params[1], dict):
        data = params[1]
        symbol = str(data.get("n") or "").upper()
        if data.get("s") == "error":
            pending.discard(symbol)
        elif isinstance(data.get("v"), dict):
            fields.setdefault(symbol, {}).update(data["v"])
    elif method == "quote_completed" and len(params) > 1:
        pending.discard(str(params[1]).upper())
    elif method in ("critical_error", "protocol_error"):
        raise FeedError(f"El feed de TradingView devolvió {method}")


def fetchQuotes(
    symbols: Iterable[str],
    timeout: float | None = None,
    socketFactory: Callable[..., _WebSocket] = _WebSocket,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, tuple[float, float, str]]:
    """Cotiza varios símbolos de TradingView en una sola sesión del feed.

    Espera hasta que cada símbolo esté completo o dé error, o hasta agotar el
    plazo; lo que no llegue a tiempo se queda fuera del resultado.

    Args:
        symbols: Tickers con mercado (`VANTAGE:SP500`).
        timeout: Plazo total en segundos. Por defecto, el de [proveedores].
        socketFactory: Constructor del cliente WebSocket, inyectable para los tests.
        clock: Reloj monotónico, inyectable para los tests.

    Returns:
        `{ticker: (precio, variación %, divisa)}` de los que tienen precio.

    Raises:
        OSError: fallo de red o de TLS (incluye `FeedError` y `TimeoutError`
            al conectar).

    Example:
        >>> fetchQuotes(["VANTAGE:SP500"])  # doctest: +SKIP
        {'VANTAGE:SP500': (7519.85, -0.56, 'USD')}
    """
    wanted = list(dict.fromkeys(str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()))
    if not wanted:
        return {}

    totalTimeout = float(timeout or settings.proveedorTimeout())
    deadline = clock() + totalTimeout
    pending = set(wanted)
    fields: dict[str, dict] = {}
    session = f"qs_{secrets.token_hex(6)}"

    recordApiCall("TradingView")
    with socketFactory(
        FEED_HOST, FEED_PORT, FEED_PATH, FEED_ORIGIN, totalTimeout, settings.proveedorMaxRespuestaBytes()
    ) as socketClient:
        for method, params in (
            ("set_auth_token", ["unauthorized_user_token"]),
            ("quote_create_session", [session]),
            ("quote_set_fields", [session, *_QUOTE_FIELDS]),
            ("quote_add_symbols", [session, *wanted]),
        ):
            socketClient.sendText(encodeMessage({"m": method, "p": params}))

        while pending:
            remaining = deadline - clock()
            if remaining <= 0:
                break
            try:
                text = socketClient.recvText(remaining)
            except TimeoutError:
                break
            for rawMessage in splitMessages(text):
                _handleMessage(rawMessage, socketClient, pending, fields)

    if pending:
        log.info("El feed de TradingView no completó a tiempo: %s", ", ".join(sorted(pending)))

    quotes = {}
    for symbol in wanted:
        parsed = _parseQuote(fields.get(symbol, {}))
        if parsed:
            quotes[symbol] = parsed
    return quotes


# ── Velas ────────────────────────────────────────────────────────────────────
#
# Comprobado contra el servidor real: cada sesión de gráfico admite una sola
# serie (con dos contesta `critical_error` «exceed limit of series in the
# session» y cierra), así que se abre una sesión por símbolo, todas en la misma
# conexión (42 a la vez responden en ~1 s). `timescale_update` trae las velas
# como `{"i": n, "v": [ts, apertura, máximo, mínimo, cierre, volumen?]}` y
# `series_completed` cierra la petición; un símbolo que no existe llega como
# `symbol_error` + `series_error`. Los índices (NASDAQ:NDX, SP:SPX) vienen con
# retraso (`delayed_streaming_600/900`), pero vienen. La divisa en que cotiza
# el símbolo llega antes, en `symbol_resolved` (`currency_code`: NASDAQ:AAPL →
# USD, XETR:SAP → EUR).

_SERIES_ERRORS = ("symbol_error", "series_error")


def _handleSeriesMessage(
    rawMessage: str,
    socketClient: _WebSocket,
    pending: set[str],
    closes: dict[str, dict[int, tuple[float, float, float]]],
    currencies: dict[str, str] | None = None,
) -> None:
    """Procesa un mensaje del feed de velas: latidos, divisa, velas y fin o error de sesión."""
    if rawMessage.startswith("~h~"):
        socketClient.sendText(encodeMessage(rawMessage))
        return
    try:
        message = json.loads(rawMessage)
    except ValueError:
        return  # mensajes de control que no son JSON
    if not isinstance(message, dict):
        return

    method = message.get("m")
    params = message.get("p") or []
    session = str(params[0]) if params else ""
    if method in ("timescale_update", "du") and len(params) > 1 and isinstance(params[1], dict):
        for series in params[1].values():
            if isinstance(series, dict) and isinstance(series.get("s"), list):
                for bar in series["s"]:
                    _addBar(closes.setdefault(session, {}), bar)
    elif method == "symbol_resolved" and currencies is not None and len(params) > 2 and isinstance(params[2], dict):
        currency = str(params[2].get("currency_code") or "").strip().upper()
        if currency:
            currencies[session] = currency
    elif method == "series_completed" or method in _SERIES_ERRORS:
        pending.discard(session)
    elif method in ("critical_error", "protocol_error"):
        raise FeedError(f"El feed de TradingView devolvió {method}")


def _addBar(closesBySession: dict[int, tuple[float, float, float]], bar: object) -> None:
    """Anota cierre, máximo y mínimo de una vela; las que no traen `[ts, ..., cierre]` válido se ignoran.

    Un máximo o un mínimo ilegible se sustituye por el cierre: la vela sigue
    sirviendo para la línea, solo que sin rango.
    """
    values = bar.get("v") if isinstance(bar, dict) else None
    if not isinstance(values, list) or len(values) < 5:
        return
    try:
        timestamp, close = int(values[0]), float(values[4])
    except (TypeError, ValueError):
        return
    if close <= 0:
        return
    try:
        high, low = float(values[2]), float(values[3])
    except (TypeError, ValueError):
        high = low = close
    high = max(high, close)
    low = min(low, close) if low > 0 else close
    closesBySession[timestamp] = (close, high, low)


def fetchSeries(
    symbols: Iterable[str],
    resolution: str,
    bars: int,
    timeout: float | None = None,
    socketFactory: Callable[..., _WebSocket] = _WebSocket,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, list[tuple[int, float]]]:
    """Velas de cierre de varios símbolos de TradingView en una sola conexión.

    Args:
        symbols: Tickers con mercado (`NASDAQ:NDX`).
        resolution: Resolución del feed: minutos ("5", "60", "240") o "1D".
        bars: Cuántas velas pedir, contando hacia atrás desde la última.
        timeout: Plazo total en segundos. Por defecto, el de [proveedores].
        socketFactory: Constructor del cliente WebSocket, inyectable para los tests.
        clock: Reloj monotónico, inyectable para los tests.

    Returns:
        `{ticker: [(ts, cierre), ...]}` ordenado por `ts`, solo de los que
        tienen velas. Lo que no existe o no llega a tiempo se queda fuera.

    Raises:
        OSError: fallo de red o de TLS (incluye `FeedError`).

    Example:
        >>> fetchSeries(["NASDAQ:NDX"], "5", 300)  # doctest: +SKIP
        {'NASDAQ:NDX': [(1793893800, 26749.43), ...]}
    """
    series = _fetchSeriesSessions(symbols, resolution, bars, timeout, socketFactory, clock)
    return {symbol: [(ts, close) for ts, close, _high, _low in bars] for symbol, (_currency, bars) in series.items()}


def fetchSeriesWithCurrency(
    symbols: Iterable[str],
    resolution: str,
    bars: int,
    timeout: float | None = None,
    socketFactory: Callable[..., _WebSocket] = _WebSocket,
    clock: Callable[[], float] = time.monotonic,
) -> dict[str, tuple[str | None, list[tuple[int, float, float, float]]]]:
    """Como `fetchSeries`, pero con la divisa de cada símbolo y el máximo y mínimo de cada vela.

    La divisa hace falta para pasar las velas a otra: el ticker no la dice
    (NASDAQ:AAPL va en USD aunque el activo se apunte en euros). El máximo y
    el mínimo dicen si un precio se pudo pagar ese día.

    Args:
        symbols: Tickers con mercado (`NASDAQ:NDX`).
        resolution: Resolución del feed: minutos ("5", "60", "240") o "1D".
        bars: Cuántas velas pedir, contando hacia atrás desde la última.
        timeout: Plazo total en segundos. Por defecto, el de [proveedores].
        socketFactory: Constructor del cliente WebSocket, inyectable para los tests.
        clock: Reloj monotónico, inyectable para los tests.

    Returns:
        `{ticker: (divisa, [(ts, cierre, máximo, mínimo), ...])}`, con la divisa
        en mayúsculas o None si el feed no la dio. Mismo filtrado que `fetchSeries`.

    Raises:
        OSError: fallo de red o de TLS (incluye `FeedError`).

    Example:
        >>> fetchSeriesWithCurrency(["NASDAQ:AAPL"], "1D", 1)  # doctest: +SKIP
        {'NASDAQ:AAPL': ('USD', [(1794407400, 268.9, 271.2, 266.0)])}
    """
    return _fetchSeriesSessions(symbols, resolution, bars, timeout, socketFactory, clock)


def _fetchSeriesSessions(
    symbols: Iterable[str],
    resolution: str,
    bars: int,
    timeout: float | None,
    socketFactory: Callable[..., _WebSocket],
    clock: Callable[[], float],
) -> dict[str, tuple[str | None, list[tuple[int, float, float, float]]]]:
    """Cuerpo común de `fetchSeries` y `fetchSeriesWithCurrency`: una sesión de gráfico por símbolo."""
    wanted = list(dict.fromkeys(str(symbol).strip().upper() for symbol in symbols if str(symbol).strip()))
    if not wanted:
        return {}

    totalTimeout = float(timeout or settings.proveedorTimeout())
    deadline = clock() + totalTimeout
    sessions = {f"cs_{secrets.token_hex(4)}_{index}": symbol for index, symbol in enumerate(wanted)}
    pending = set(sessions)
    closes: dict[str, dict[int, tuple[float, float, float]]] = {}
    currencies: dict[str, str] = {}

    recordApiCall("TradingView")
    with socketFactory(
        FEED_HOST, FEED_PORT, FEED_PATH, FEED_ORIGIN, totalTimeout, settings.proveedorMaxRespuestaBytes()
    ) as socketClient:
        socketClient.sendText(encodeMessage({"m": "set_auth_token", "p": ["unauthorized_user_token"]}))
        for session, symbol in sessions.items():
            symbolSpec = "=" + json.dumps({"symbol": symbol, "adjustment": "splits"}, separators=(",", ":"))
            for method, params in (
                ("chart_create_session", [session, ""]),
                ("resolve_symbol", [session, "sym", symbolSpec]),
                ("create_series", [session, "s", "s", "sym", resolution, int(bars), ""]),
            ):
                socketClient.sendText(encodeMessage({"m": method, "p": params}))

        while pending:
            remaining = deadline - clock()
            if remaining <= 0:
                break
            try:
                text = socketClient.recvText(remaining)
            except TimeoutError:
                break
            for rawMessage in splitMessages(text):
                _handleSeriesMessage(rawMessage, socketClient, pending, closes, currencies)

    if pending:
        log.info("Velas de TradingView sin completar a tiempo: %s", ", ".join(sorted(sessions[s] for s in pending)))

    # Las sesiones sin completar se descartan: con parte de las velas, la línea
    # y el máximo/mínimo serían de un tramo arbitrario.
    return {
        sessions[session]: (currencies.get(session), [(ts, *bar) for ts, bar in sorted(byTimestamp.items())])
        for session, byTimestamp in closes.items()
        if session in sessions and session not in pending and byTimestamp
    }
