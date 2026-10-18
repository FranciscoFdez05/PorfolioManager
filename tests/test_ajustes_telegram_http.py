"""Pruebas de /api/settings/telegram: guardar, leer, probar y borrar.

Mismo criterio de seguridad que las claves de API (`test_ajustes_http.py`):
el token nunca debe quedar en claro en disco.
"""

import json

import pytest

from core import telegram_notifier


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    telegram_notifier.reiniciarParaPruebas()

    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, cabeceras, datosAislados


def testSinConfigurarDevuelveNoConfigurado(cliente):
    client, _cabeceras, _rutas = cliente

    datos = client.get("/api/settings/telegram").get_json()

    assert datos["ok"] is True
    assert datos["configurado"] is False
    assert datos["hayToken"] is False
    assert "token" not in datos
    assert datos["chatId"] == ""


def testGuardarSinTokenOChatIdDaError(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post("/api/settings/telegram", json={"token": "", "chatId": "123"}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testGuardarYLeerConfig(cliente):
    client, cabeceras, _rutas = cliente

    guardado = client.post(
        "/api/settings/telegram",
        json={"token": "123456:ABC-token", "chatId": "987654321"},
        headers=cabeceras,
    )
    assert guardado.get_json()["ok"] is True

    datos = client.get("/api/settings/telegram").get_json()
    assert datos["configurado"] is True
    # Solo la máscara: el token entero ya no sale hacia el navegador.
    assert "token" not in datos
    assert datos["hayToken"] is True
    assert "123456:ABC-token" not in str(datos)
    assert datos["chatId"] == "987654321"


def testElTokenNoSeGuardaEnClaroEnDisco(cliente):
    client, cabeceras, rutas = cliente

    client.post(
        "/api/settings/telegram",
        json={"token": "123456:ABC-token", "chatId": "987654321"},
        headers=cabeceras,
    )

    crudo = (rutas["claves"] / "telegram.key").read_bytes()
    assert b"123456:ABC-token" not in crudo


def testBorrarConfig(cliente):
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


def testProbarSinConfigurarDaError(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post("/api/settings/telegram/prueba", headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testProbarConfiguradoEnviaElMensaje(cliente, monkeypatch):
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


# ── Qué avisos se reciben ─────────────────────────────────────────────────────

def testGetListaLasCategoriasConSuEstado(cliente):
    client, _cabeceras, _rutas = cliente

    datos = client.get("/api/settings/telegram").get_json()

    claves = [a["clave"] for a in datos["avisos"]]
    assert claves == list(telegram_notifier.CATEGORIAS_AVISO)
    porClave = {a["clave"]: a for a in datos["avisos"]}
    assert porClave["backup"]["activo"] is True
    assert porClave["resumen"]["activo"] is False
    assert porClave["backup"]["titulo"]
    assert datos["resumenHora"] == telegram_notifier.RESUMEN_HORA_DEFECTO
    assert datos["silenciadoHasta"] == 0


def testGuardarAvisosYHoraDelResumen(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post(
        "/api/settings/telegram/avisos",
        json={"avisos": {"backup": False, "resumen": True}, "resumenHora": 8},
        headers=cabeceras,
    )
    assert respuesta.get_json()["ok"] is True

    datos = client.get("/api/settings/telegram").get_json()
    porClave = {a["clave"]: a["activo"] for a in datos["avisos"]}
    assert porClave["backup"] is False and porClave["resumen"] is True
    assert porClave["precios"] is True, "lo que no se manda conserva su valor"
    assert datos["resumenHora"] == 8


def testGuardarAvisosDescartaCategoriasDesconocidas(cliente):
    client, cabeceras, rutas = cliente

    client.post("/api/settings/telegram/avisos", json={"avisos": {"inventada": True, "backup": False}},
                headers=cabeceras)

    guardado = json.loads(rutas["ajustes"].read_text("utf-8"))["telegramAvisos"]
    assert "inventada" not in guardado and guardado["backup"] is False


def testGuardarAvisosAcotaLaHora(cliente):
    client, cabeceras, _rutas = cliente

    client.post("/api/settings/telegram/avisos", json={"resumenHora": 99}, headers=cabeceras)

    assert client.get("/api/settings/telegram").get_json()["resumenHora"] == 23


def testAvisosConFormatoErroneoEs400(cliente):
    client, cabeceras, _rutas = cliente

    respuesta = client.post("/api/settings/telegram/avisos", json={"avisos": ["backup"]}, headers=cabeceras)

    assert respuesta.status_code == 400


def testGuardarOtrosAjustesNoBorraLosAvisosElegidos(cliente):
    """`ajustes.json` filtra por claves conocidas: si estas no lo fueran, se perderían."""
    client, cabeceras, _rutas = cliente
    client.post("/api/settings/telegram/avisos", json={"avisos": {"backup": False}, "resumenHora": 7},
                headers=cabeceras)

    client.post("/api/settings", json={"theme": "black"}, headers=cabeceras)

    datos = client.get("/api/settings/telegram").get_json()
    assert {a["clave"]: a["activo"] for a in datos["avisos"]}["backup"] is False
    assert datos["resumenHora"] == 7


def testGuardarConElTokenVacioConservaElGuardado(cliente):
    """El formulario ya no recibe el token: vacío significa «el que hay»."""
    from core import telegram_notifier

    client, cabeceras, _rutas = cliente
    client.post("/api/settings/telegram", json={"token": "123456:ABC-token", "chatId": "1"}, headers=cabeceras)

    respuesta = client.post("/api/settings/telegram", json={"token": "", "chatId": "2"}, headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    assert telegram_notifier.leerConfig() == ("123456:ABC-token", "2")
