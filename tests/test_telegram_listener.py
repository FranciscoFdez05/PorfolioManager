"""Hilo de escucha del bot: responde solo al chat configurado, ignora al resto.

Nada sale a la red: se sustituye `telegram_notifier._enviar`. El bucle en sí
(`_bucle`/`iniciar`/`detener`) solo se prueba en el arranque y parada del hilo;
la lógica de negocio vive en `_procesar`, que se prueba directamente.
"""

import pytest

from admin import telegram_listener
from core import telegram_notifier


@pytest.fixture(autouse=True)
def _sin_estado_previo():
    telegram_notifier.reiniciar_para_pruebas()
    yield
    telegram_listener.detener()
    telegram_notifier.reiniciar_para_pruebas()


def _update(texto, chat_id, update_id=1):
    return {
        "update_id": update_id,
        "message": {"text": texto, "chat": {"id": chat_id}},
    }


def test_start_del_chat_configurado_responde(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append((chatId, texto)))

    telegram_listener._procesar(_update("/start", 123456789), "token-123", "123456789")

    assert len(llamadas) == 1
    assert llamadas[0][0] == "123456789"
    assert "Conectado" in llamadas[0][1]


def test_start_de_otro_chat_se_ignora(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_listener._procesar(_update("/start", 999999999), "token-123", "123456789")

    assert llamadas == []


def test_mensaje_que_no_es_start_se_ignora(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_listener._procesar(_update("hola", 123456789), "token-123", "123456789")

    assert llamadas == []


def test_update_sin_mensaje_no_lanza(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_listener._procesar({"update_id": 1}, "token-123", "123456789")

    assert llamadas == []


def test_fallo_al_confirmar_no_lanza(monkeypatch):
    def _falla(*a):
        raise ValueError("Telegram caído")

    monkeypatch.setattr(telegram_notifier, "_enviar", _falla)

    telegram_listener._procesar(_update("/start", 123456789), "token-123", "123456789")


def test_iniciar_y_detener_es_idempotente(datos_aislados):
    hilo1 = telegram_listener.iniciar()
    hilo2 = telegram_listener.iniciar()

    assert hilo1 is hilo2
    assert hilo1.is_alive()

    telegram_listener.detener()

    assert not hilo1.is_alive()
