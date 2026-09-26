"""Pruebas de /api/settings/telegram: guardar, leer, probar y borrar.

Mismo criterio de seguridad que las claves de API (`test_ajustes_http.py`):
el token nunca debe quedar en claro en disco.
"""

import pytest

from core import telegram_notifier


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.ajustes import ajustes_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    telegram_notifier.reiniciar_para_pruebas()

    client, cabeceras, _app = cliente_autenticado(ajustes_bp)
    return client, cabeceras, datos_aislados


def test_sin_configurar_devuelve_no_configurado(cliente):
    client, _cabeceras, _rutas = cliente

    datos = client.get("/api/settings/telegram").get_json()

    assert datos["ok"] is True
    assert datos["configurado"] is False
    assert datos["token"] == ""
    assert datos["chatId"] == ""


def test_guardar_sin_token_o_chat_id_da_error(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post("/api/settings/telegram", json={"token": "", "chatId": "123"}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_guardar_y_leer_config(cliente):
    client, cabeceras, _rutas = cliente

    guardado = client.post(
        "/api/settings/telegram",
        json={"token": "123456:ABC-token", "chatId": "987654321"},
        headers=cabeceras,
    )
    assert guardado.get_json()["ok"] is True

    datos = client.get("/api/settings/telegram").get_json()
    assert datos["configurado"] is True
    assert datos["token"] == "123456:ABC-token"
    assert datos["chatId"] == "987654321"


def test_el_token_no_se_guarda_en_claro_en_disco(cliente):
    client, cabeceras, rutas = cliente

    client.post(
        "/api/settings/telegram",
        json={"token": "123456:ABC-token", "chatId": "987654321"},
        headers=cabeceras,
    )

    crudo = (rutas["claves"] / "telegram.key").read_bytes()
    assert b"123456:ABC-token" not in crudo


def test_borrar_config(cliente):
    client, cabeceras, _rutas = cliente
    client.post(
        "/api/settings/telegram",
        json={"token": "123456:ABC-token", "chatId": "987654321"},
        headers=cabeceras,
    )

    borrado = client.delete("/api/settings/telegram", headers=cabeceras)
    assert borrado.get_json()["ok"] is True

    datos = client.get("/api/settings/telegram").get_json()
    assert datos["configurado"] is False


def test_probar_sin_configurar_da_error(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post("/api/settings/telegram/prueba", headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_probar_configurado_envia_el_mensaje(cliente, monkeypatch):
    client, cabeceras, _rutas = cliente
    client.post(
        "/api/settings/telegram",
        json={"token": "123456:ABC-token", "chatId": "987654321"},
        headers=cabeceras,
    )

    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))

    respuesta = client.post("/api/settings/telegram/prueba", headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    assert len(llamadas) == 1
