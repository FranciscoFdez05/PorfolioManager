"""Aviso por Telegram: guardado del token/chat id y el cooldown entre avisos.

Nada sale a la red: se sustituye `telegram_notifier._enviar`. El cooldown es lo
que evita que un refresco de cartera con un proveedor caído mande un aviso por
cada activo que lo prueba.
"""

import pytest

from core import telegram_notifier


@pytest.fixture(autouse=True)
def _sinCooldownPrevio():
    telegram_notifier.reiniciarParaPruebas()
    yield
    telegram_notifier.reiniciarParaPruebas()


@pytest.fixture
def aislado(datosAislados, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    return datosAislados


def testSinConfigurarNoHayNadaQueLeer(aislado):
    assert telegram_notifier.leerConfig() == ("", "")
    assert telegram_notifier.configurado() is False


def testEscribirYLeerConfig(aislado):
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    assert telegram_notifier.leerConfig() == ("123456:ABC-token", "987654321")
    assert telegram_notifier.configurado() is True


def testLaConfigNoSeGuardaEnClaroEnDisco(aislado):
    from core import paths

    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    crudo = (paths.API_DIR / "telegram.key").read_bytes()
    assert b"123456:ABC-token" not in crudo
    assert b"987654321" not in crudo


def testBorrarConfigDejaDeEstarConfigurado(aislado):
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    telegram_notifier.borrarConfig()

    assert telegram_notifier.leerConfig() == ("", "")
    assert telegram_notifier.configurado() is False


def testNotificarProblemaNoMandaNadaSinConfigurar(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")

    assert llamadas == []


def testNotificarProblemaMandaElMensajeEsperado(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")

    assert len(llamadas) == 1
    assert "Finnhub" in llamadas[0]
    assert "HTTP 429" in llamadas[0]


def testNotificarProblemaRespetaElCooldown(aislado, monkeypatch):
    """Un refresco de cartera reintenta el mismo proveedor por cada activo: sin
    cooldown, cada refresco sería un aviso de Telegram por activo."""
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")

    assert len(llamadas) == 1


def testNotificarProblemaNoAgrupaProveedoresNiCategoriasDistintas(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificarProblema("cuota_agotada", "EODHD", "HTTP 402")
    telegram_notifier.notificarProblema("no_responde", "Finnhub", "timeout")

    assert len(llamadas) == 3


def testNotificarProblemaCategoriaDesconocidaNoLanza(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("categoria-inventada", "Finnhub", "detalle")

    assert llamadas == []


def testNotificarProblemaNoLanzaSiElEnvioFalla(aislado, monkeypatch):
    def _falla(*a):
        raise ValueError("Telegram caído")

    monkeypatch.setattr(telegram_notifier, "_enviar", _falla)
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("fallo", "Finnhub", "detalle")


def testEnviarPruebaSinConfigurarDaErrorClaro(aislado):
    ok, error = telegram_notifier.enviarPrueba()

    assert ok is False
    assert "token" in error or "chat" in error.lower()


def testNotificarRecuperadoSinFalloPrevioNoHaceNada(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarRecuperado("Finnhub")

    assert llamadas == []


def testNotificarRecuperadoTrasFalloMandaAviso(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificarRecuperado("Finnhub")

    assert len(llamadas) == 2
    assert "vuelve a responder" in llamadas[1]


def testNotificarRecuperadoLiberaElCooldown(aislado, monkeypatch):
    """Si Finnhub se recupera y vuelve a fallar justo después, no debe esperar
    el cooldown entero: el aviso de recuperación es lo que lo justifica."""
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificarRecuperado("Finnhub")
    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")

    assert len(llamadas) == 3


def testNotificarRecuperadoSoloAvisaUnaVez(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificarRecuperado("Finnhub")
    telegram_notifier.notificarRecuperado("Finnhub")

    assert len(llamadas) == 2


def testEnviarPruebaConfiguradoLlamaAEnviar(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append((token, chatId)))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    ok, error = telegram_notifier.enviarPrueba()

    assert ok is True
    assert error is None
    assert llamadas == [("123456:ABC-token", "987654321")]
