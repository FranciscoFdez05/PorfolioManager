"""Aviso por Telegram: guardado del token/chat id y el cooldown entre avisos.

Nada sale a la red: se sustituye `telegram_notifier._enviar`. El cooldown es lo
que evita que un refresco de cartera con un proveedor caído mande un aviso por
cada activo que lo prueba.
"""

import pytest

from core import telegram_notifier


@pytest.fixture(autouse=True)
def _sin_cooldown_previo():
    telegram_notifier.reiniciar_para_pruebas()
    yield
    telegram_notifier.reiniciar_para_pruebas()


@pytest.fixture
def aislado(datos_aislados, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    return datos_aislados


def test_sin_configurar_no_hay_nada_que_leer(aislado):
    assert telegram_notifier.leerConfig() == ("", "")
    assert telegram_notifier.configurado() is False


def test_escribir_y_leer_config(aislado):
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    assert telegram_notifier.leerConfig() == ("123456:ABC-token", "987654321")
    assert telegram_notifier.configurado() is True


def test_la_config_no_se_guarda_en_claro_en_disco(aislado):
    from core import paths

    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    crudo = (paths.API_DIR / "telegram.key").read_bytes()
    assert b"123456:ABC-token" not in crudo
    assert b"987654321" not in crudo


def test_borrar_config_deja_de_estar_configurado(aislado):
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    telegram_notifier.borrarConfig()

    assert telegram_notifier.leerConfig() == ("", "")
    assert telegram_notifier.configurado() is False


def test_notificar_problema_no_manda_nada_sin_configurar(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")

    assert llamadas == []


def test_notificar_problema_manda_el_mensaje_esperado(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")

    assert len(llamadas) == 1
    assert "Finnhub" in llamadas[0]
    assert "HTTP 429" in llamadas[0]


def test_notificar_problema_respeta_el_cooldown(aislado, monkeypatch):
    """Un refresco de cartera reintenta el mismo proveedor por cada activo: sin
    cooldown, cada refresco sería un aviso de Telegram por activo."""
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")

    assert len(llamadas) == 1


def test_notificar_problema_no_agrupa_proveedores_ni_categorias_distintas(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificar_problema("cuota_agotada", "EODHD", "HTTP 402")
    telegram_notifier.notificar_problema("no_responde", "Finnhub", "timeout")

    assert len(llamadas) == 3


def test_notificar_problema_categoria_desconocida_no_lanza(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("categoria-inventada", "Finnhub", "detalle")

    assert llamadas == []


def test_notificar_problema_no_lanza_si_el_envio_falla(aislado, monkeypatch):
    def _falla(*a):
        raise ValueError("Telegram caído")

    monkeypatch.setattr(telegram_notifier, "_enviar", _falla)
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("fallo", "Finnhub", "detalle")


def test_enviar_prueba_sin_configurar_da_error_claro(aislado):
    ok, error = telegram_notifier.enviarPrueba()

    assert ok is False
    assert "token" in error or "chat" in error.lower()


def test_notificar_recuperado_sin_fallo_previo_no_hace_nada(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_recuperado("Finnhub")

    assert llamadas == []


def test_notificar_recuperado_tras_fallo_manda_aviso(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificar_recuperado("Finnhub")

    assert len(llamadas) == 2
    assert "vuelve a responder" in llamadas[1]


def test_notificar_recuperado_libera_el_cooldown(aislado, monkeypatch):
    """Si Finnhub se recupera y vuelve a fallar justo después, no debe esperar
    el cooldown entero: el aviso de recuperación es lo que lo justifica."""
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificar_recuperado("Finnhub")
    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")

    assert len(llamadas) == 3


def test_notificar_recuperado_solo_avisa_una_vez(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    telegram_notifier.notificar_problema("cuota_agotada", "Finnhub", "HTTP 429")
    telegram_notifier.notificar_recuperado("Finnhub")
    telegram_notifier.notificar_recuperado("Finnhub")

    assert len(llamadas) == 2


def test_enviar_prueba_configurado_llama_a_enviar(aislado, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append((token, chatId)))
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    ok, error = telegram_notifier.enviarPrueba()

    assert ok is True
    assert error is None
    assert llamadas == [("123456:ABC-token", "987654321")]
