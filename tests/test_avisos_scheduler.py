"""Tareas del hilo de avisos: resumen diario, versión nueva y disco casi lleno.

(Las alertas de precio, que también pasan por este hilo, están en
`test_alertas.py`.) Sin red ni esperas: cada pasada se llama directamente y
Telegram está sustituido por una lista.
"""

import json
from collections import namedtuple
from datetime import datetime

import pytest

from admin import avisos_scheduler
from core import telegram_notifier
from stores import resumen_cartera


@pytest.fixture
def enviados(datos_aislados, temp_db, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciar_para_pruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    yield mensajes
    telegram_notifier.reiniciar_para_pruebas()


def _avisos(datos_aislados, **activados):
    datos_aislados["ajustes"].write_text(json.dumps({"telegramAvisos": activados}), "utf-8")


def _a_las(monkeypatch, hora):
    class _Reloj(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 30, hora, 0, 0)

    monkeypatch.setattr(avisos_scheduler, "datetime", _Reloj)


# ── Resumen diario ────────────────────────────────────────────────────────────

def test_el_resumen_esta_apagado_de_fabrica(enviados, monkeypatch):
    _a_las(monkeypatch, 23)

    assert avisos_scheduler._pasada_resumen() is False
    assert enviados == []


def test_el_resumen_sale_a_partir_de_la_hora_elegida(enviados, datos_aislados, monkeypatch):
    datos_aislados["ajustes"].write_text(
        json.dumps({"telegramAvisos": {"resumen": True}, "telegramResumenHora": 21}), "utf-8"
    )
    monkeypatch.setattr(avisos_scheduler, "texto_resumen", lambda: "🗓 Resumen del día")

    _a_las(monkeypatch, 20)
    assert avisos_scheduler._pasada_resumen() is False

    _a_las(monkeypatch, 21)
    assert avisos_scheduler._pasada_resumen() is True
    assert enviados == ["🗓 Resumen del día"]


def test_el_resumen_sale_una_sola_vez_al_dia(enviados, datos_aislados, monkeypatch):
    _avisos(datos_aislados, resumen=True)
    monkeypatch.setattr(avisos_scheduler, "texto_resumen", lambda: "resumen")
    _a_las(monkeypatch, 22)

    assert avisos_scheduler._pasada_resumen() is True
    assert avisos_scheduler._pasada_resumen() is False
    assert avisos_scheduler._pasada_resumen() is False
    assert len(enviados) == 1


def test_el_resumen_no_gasta_el_reclamo_si_telegram_no_esta_configurado(datos_aislados, monkeypatch):
    """Si no, configurarlo por la tarde dejaría sin resumen hasta mañana."""
    from core import reclamo

    _avisos(datos_aislados, resumen=True)
    _a_las(monkeypatch, 22)

    assert avisos_scheduler._pasada_resumen() is False
    assert reclamo.reclamar("resumen-diario", 20 * 3600) is True


def test_el_texto_del_resumen_recorre_los_portfolios(enviados, datos_aislados, monkeypatch):
    from core.db import use_db_path

    primera = datos_aislados["portfolios"] / "uno.db"
    segunda = datos_aislados["portfolios"] / "dos.db"
    for ruta in (primera, segunda):
        with use_db_path(ruta):
            pass
    monkeypatch.setattr(
        avisos_scheduler, "rutas_de_portfolios",
        lambda: [("uno", "Cartera Uno", primera), ("dos", "Cartera Dos", segunda)],
    )
    monkeypatch.setattr(resumen_cartera, "calcular", lambda: {
        "valor": 1000, "invertido": 800, "resultado": 200, "resultadoPct": 25,
        "variacionDia": None, "activos": 2, "preciosFrescos": 2, "alertasActivas": 0,
    })

    texto = avisos_scheduler.texto_resumen()

    assert "Cartera Uno" in texto and "Cartera Dos" in texto
    assert "1.000,00 €" in texto


def test_un_portfolio_que_falla_no_impide_el_resumen_de_los_demas(enviados, datos_aislados, monkeypatch):
    from core.db import use_db_path

    ruta = datos_aislados["portfolios"] / "uno.db"
    with use_db_path(ruta):
        pass
    monkeypatch.setattr(avisos_scheduler, "rutas_de_portfolios", lambda: [("uno", "Uno", ruta)])

    def _cae():
        raise RuntimeError("bd rota")

    monkeypatch.setattr(resumen_cartera, "calcular", _cae)

    assert "No se pudo calcular" in avisos_scheduler.texto_resumen()


# ── Texto del resumen ─────────────────────────────────────────────────────────

def test_formatear_cartera_con_ganancia_y_variacion():
    from decimal import Decimal

    texto = resumen_cartera.formatear("Principal", {
        "valor": Decimal("12000"), "invertido": Decimal("10000"), "resultado": Decimal("2000"),
        "resultadoPct": Decimal("20"), "variacionDia": (Decimal("-150"), Decimal("-1.23")),
        "activos": 4, "preciosFrescos": 4, "alertasActivas": 2,
    })

    assert "12.000,00 €" in texto and "10.000,00 €" in texto
    assert "+2.000,00 € (+20,00 %)" in texto
    assert "-150,00 € (-1,23 %)" in texto
    assert "Alertas de precio activas: 2" in texto


def test_formatear_cartera_vacia():
    texto = resumen_cartera.formatear("Principal", {"activos": 0})

    assert "Sin posiciones" in texto


# ── Versión nueva ─────────────────────────────────────────────────────────────

def test_avisa_de_una_version_nueva_una_sola_vez(enviados, monkeypatch):
    from core import version_remota

    monkeypatch.setattr(version_remota, "consultar", lambda: {"hayNueva": True, "publicada": "99.0.0"})

    assert avisos_scheduler._pasada_version() is True
    assert avisos_scheduler._pasada_version() is False
    assert len(enviados) == 1 and "99.0.0" in enviados[0]


def test_una_version_aun_mas_nueva_vuelve_a_avisar(enviados, monkeypatch):
    from core import version_remota

    for publicada in ("99.0.0", "99.1.0"):
        monkeypatch.setattr(version_remota, "consultar", lambda p=publicada: {"hayNueva": True, "publicada": p})
        avisos_scheduler._pasada_version()

    assert len(enviados) == 2


@pytest.mark.parametrize("info", [
    {"hayNueva": False, "publicada": "1.0.0"},
    {"hayNueva": None, "publicada": None},
])
def test_sin_version_nueva_no_avisa(enviados, monkeypatch, info):
    from core import version_remota

    monkeypatch.setattr(version_remota, "consultar", lambda: info)

    assert avisos_scheduler._pasada_version() is False
    assert enviados == []


def test_con_la_categoria_apagada_no_pregunta_ni_avisa(enviados, datos_aislados, monkeypatch):
    from core import version_remota

    _avisos(datos_aislados, version=False)
    monkeypatch.setattr(version_remota, "consultar", lambda: pytest.fail("no debía consultar"))

    assert avisos_scheduler._pasada_version() is False


# ── Disco ─────────────────────────────────────────────────────────────────────

_Uso = namedtuple("Uso", "total used free")


def test_avisa_si_queda_poco_disco(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "1024")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: _Uso(10**11, 10**11 - 10**8, 10**8))

    assert avisos_scheduler._pasada_disco() is True
    assert "poco espacio" in enviados[0] and "95 MB" in enviados[0]


def test_no_avisa_si_hay_espacio(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "1024")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: _Uso(10**12, 10**11, 9 * 10**11))

    assert avisos_scheduler._pasada_disco() is False
    assert enviados == []


def test_el_aviso_de_disco_no_se_repite_en_un_dia(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "1024")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: _Uso(10**11, 10**11, 10**6))

    avisos_scheduler._pasada_disco()
    avisos_scheduler._pasada_disco()

    assert len(enviados) == 1


def test_con_el_minimo_a_cero_no_mide(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "0")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: pytest.fail("no debía medir"))

    assert avisos_scheduler._pasada_disco() is False


# ── Hilo ──────────────────────────────────────────────────────────────────────

def test_iniciar_y_detener_es_idempotente(datos_aislados):
    hilo1 = avisos_scheduler.iniciar()
    hilo2 = avisos_scheduler.iniciar()

    assert hilo1 is hilo2 and hilo1.is_alive()

    avisos_scheduler.detener()

    assert not hilo1.is_alive()


def test_una_tarea_que_falla_no_mata_el_hilo(caplog):
    def _cae():
        raise RuntimeError("boom")

    avisos_scheduler._ejecutar("prueba", _cae)

    assert "boom" in caplog.text
