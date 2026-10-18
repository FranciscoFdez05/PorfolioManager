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
def enviados(datosAislados, tempDb, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    yield mensajes
    telegram_notifier.reiniciarParaPruebas()


def _avisos(datosAislados, **activados):
    datosAislados["ajustes"].write_text(json.dumps({"telegramAvisos": activados}), "utf-8")


def _aLas(monkeypatch, hora):
    class _Reloj(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 9, 30, hora, 0, 0)

    monkeypatch.setattr(avisos_scheduler, "datetime", _Reloj)


# ── Resumen diario ────────────────────────────────────────────────────────────

def testElResumenEstaApagadoDeFabrica(enviados, monkeypatch):
    _aLas(monkeypatch, 23)

    assert avisos_scheduler._pasadaResumen() is False
    assert enviados == []


def testElResumenSaleAPartirDeLaHoraElegida(enviados, datosAislados, monkeypatch):
    datosAislados["ajustes"].write_text(
        json.dumps({"telegramAvisos": {"resumen": True}, "telegramResumenHora": 21}), "utf-8"
    )
    monkeypatch.setattr(avisos_scheduler, "textoResumen", lambda: "🗓 Resumen del día")

    _aLas(monkeypatch, 20)
    assert avisos_scheduler._pasadaResumen() is False

    _aLas(monkeypatch, 21)
    assert avisos_scheduler._pasadaResumen() is True
    assert enviados == ["🗓 Resumen del día"]


def testElResumenSaleUnaSolaVezAlDia(enviados, datosAislados, monkeypatch):
    _avisos(datosAislados, resumen=True)
    monkeypatch.setattr(avisos_scheduler, "textoResumen", lambda: "resumen")
    _aLas(monkeypatch, 22)

    assert avisos_scheduler._pasadaResumen() is True
    assert avisos_scheduler._pasadaResumen() is False
    assert avisos_scheduler._pasadaResumen() is False
    assert len(enviados) == 1


def testElResumenNoGastaElReclamoSiTelegramNoEstaConfigurado(datosAislados, monkeypatch):
    """Si no, configurarlo por la tarde dejaría sin resumen hasta mañana."""
    from core import reclamo

    _avisos(datosAislados, resumen=True)
    _aLas(monkeypatch, 22)

    assert avisos_scheduler._pasadaResumen() is False
    assert reclamo.reclamar("resumen-diario", 20 * 3600) is True


def testElTextoDelResumenRecorreLosPortfolios(enviados, datosAislados, monkeypatch):
    from core.db import useDbPath

    primera = datosAislados["portfolios"] / "uno.db"
    segunda = datosAislados["portfolios"] / "dos.db"
    for ruta in (primera, segunda):
        with useDbPath(ruta):
            pass
    monkeypatch.setattr(
        avisos_scheduler, "rutasDePortfolios",
        lambda: [("uno", "Cartera Uno", primera), ("dos", "Cartera Dos", segunda)],
    )
    monkeypatch.setattr(resumen_cartera, "calcular", lambda: {
        "valor": 1000, "invertido": 800, "resultado": 200, "resultadoPct": 25,
        "variacionDia": None, "activos": 2, "preciosFrescos": 2, "alertasActivas": 0,
    })

    texto = avisos_scheduler.textoResumen()

    assert "Cartera Uno" in texto and "Cartera Dos" in texto
    assert "1.000,00 €" in texto


def testUnPortfolioQueFallaNoImpideElResumenDeLosDemas(enviados, datosAislados, monkeypatch):
    from core.db import useDbPath

    ruta = datosAislados["portfolios"] / "uno.db"
    with useDbPath(ruta):
        pass
    monkeypatch.setattr(avisos_scheduler, "rutasDePortfolios", lambda: [("uno", "Uno", ruta)])

    def _cae():
        raise RuntimeError("bd rota")

    monkeypatch.setattr(resumen_cartera, "calcular", _cae)

    assert "No se pudo calcular" in avisos_scheduler.textoResumen()


# ── Texto del resumen ─────────────────────────────────────────────────────────

def testFormatearCarteraConGananciaYVariacion():
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


def testFormatearCarteraVacia():
    texto = resumen_cartera.formatear("Principal", {"activos": 0})

    assert "Sin posiciones" in texto


# ── Versión nueva ─────────────────────────────────────────────────────────────

def testAvisaDeUnaVersionNuevaUnaSolaVez(enviados, monkeypatch):
    from core import version_remota

    monkeypatch.setattr(version_remota, "consultar", lambda: {"hayNueva": True, "publicada": "99.0.0"})

    assert avisos_scheduler._pasadaVersion() is True
    assert avisos_scheduler._pasadaVersion() is False
    assert len(enviados) == 1 and "99.0.0" in enviados[0]


def testUnaVersionAunMasNuevaVuelveAAvisar(enviados, monkeypatch):
    from core import version_remota

    for publicada in ("99.0.0", "99.1.0"):
        monkeypatch.setattr(version_remota, "consultar", lambda p=publicada: {"hayNueva": True, "publicada": p})
        avisos_scheduler._pasadaVersion()

    assert len(enviados) == 2


@pytest.mark.parametrize("info", [
    {"hayNueva": False, "publicada": "1.0.0"},
    {"hayNueva": None, "publicada": None},
])
def testSinVersionNuevaNoAvisa(enviados, monkeypatch, info):
    from core import version_remota

    monkeypatch.setattr(version_remota, "consultar", lambda: info)

    assert avisos_scheduler._pasadaVersion() is False
    assert enviados == []


def testConLaCategoriaApagadaNoPreguntaNiAvisa(enviados, datosAislados, monkeypatch):
    from core import version_remota

    _avisos(datosAislados, version=False)
    monkeypatch.setattr(version_remota, "consultar", lambda: pytest.fail("no debía consultar"))

    assert avisos_scheduler._pasadaVersion() is False


# ── Disco ─────────────────────────────────────────────────────────────────────

_Uso = namedtuple("Uso", "total used free")


def testAvisaSiQuedaPocoDisco(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "1024")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: _Uso(10**11, 10**11 - 10**8, 10**8))

    assert avisos_scheduler._pasadaDisco() is True
    assert "poco espacio" in enviados[0] and "95 MB" in enviados[0]


def testNoAvisaSiHayEspacio(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "1024")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: _Uso(10**12, 10**11, 9 * 10**11))

    assert avisos_scheduler._pasadaDisco() is False
    assert enviados == []


def testElAvisoDeDiscoNoSeRepiteEnUnDia(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "1024")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: _Uso(10**11, 10**11, 10**6))

    avisos_scheduler._pasadaDisco()
    avisos_scheduler._pasadaDisco()

    assert len(enviados) == 1


def testConElMinimoACeroNoMide(enviados, monkeypatch):
    monkeypatch.setenv("AVISOS_ESPACIO_MINIMO_MB", "0")
    monkeypatch.setattr(avisos_scheduler.shutil, "disk_usage", lambda ruta: pytest.fail("no debía medir"))

    assert avisos_scheduler._pasadaDisco() is False


# ── Hilo ──────────────────────────────────────────────────────────────────────

def testIniciarYDetenerEsIdempotente(datosAislados):
    hilo1 = avisos_scheduler.iniciar()
    hilo2 = avisos_scheduler.iniciar()

    assert hilo1 is hilo2 and hilo1.is_alive()

    avisos_scheduler.detener()

    assert not hilo1.is_alive()


def testUnaTareaQueFallaNoMataElHilo(caplog):
    def _cae():
        raise RuntimeError("boom")

    avisos_scheduler._ejecutar("prueba", _cae)

    assert "boom" in caplog.text
