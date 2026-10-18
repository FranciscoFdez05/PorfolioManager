"""Hilo de escucha del bot: responde solo al chat configurado, ignora al resto.

Nada sale a la red: se sustituye `telegram_notifier._enviar`. El bucle en sí
(`_bucle`/`iniciar`/`detener`) solo se prueba en el arranque y parada del hilo;
la lógica de negocio vive en `_procesar`, que se prueba directamente.
"""

import pytest

from admin import telegram_listener
from core import telegram_notifier


@pytest.fixture(autouse=True)
def _sinEstadoPrevio():
    telegram_notifier.reiniciarParaPruebas()
    yield
    telegram_listener.detener()
    telegram_notifier.reiniciarParaPruebas()


def _update(texto, chatId, updateId=1):
    return {
        "update_id": updateId,
        "message": {"text": texto, "chat": {"id": chatId}},
    }


def testStartDelChatConfiguradoResponde(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append((chatId, texto)))

    telegram_listener._procesar(_update("/start", 123456789), "token-123", "123456789")

    assert len(llamadas) == 1
    assert llamadas[0][0] == "123456789"
    assert "Conectado" in llamadas[0][1]


def testStartDeOtroChatSeIgnora(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_listener._procesar(_update("/start", 999999999), "token-123", "123456789")

    assert llamadas == []


def testMensajeQueNoEsStartSeIgnora(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_listener._procesar(_update("hola", 123456789), "token-123", "123456789")

    assert llamadas == []


def testUpdateSinMensajeNoLanza(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_listener._procesar({"update_id": 1}, "token-123", "123456789")

    assert llamadas == []


def testFalloAlConfirmarNoLanza(monkeypatch):
    def _falla(*a):
        raise ValueError("Telegram caído")

    monkeypatch.setattr(telegram_notifier, "_enviar", _falla)

    telegram_listener._procesar(_update("/start", 123456789), "token-123", "123456789")


def testIniciarYDetenerEsIdempotente(datosAislados):
    hilo1 = telegram_listener.iniciar()
    hilo2 = telegram_listener.iniciar()

    assert hilo1 is hilo2
    assert hilo1.is_alive()

    telegram_listener.detener()

    assert not hilo1.is_alive()


# ── Comandos ─────────────────────────────────────────────────────────────────

def _comando(texto, chatId=123456789, hace=0, updateId=1):
    import time

    return {
        "update_id": updateId,
        "message": {"text": texto, "chat": {"id": chatId}, "date": int(time.time()) - hace},
    }


def testUnComandoDelChatConfiguradoSeContesta(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append((chatId, texto)))

    telegram_listener._procesar(_comando("/ping"), "token-123", "123456789")

    assert len(llamadas) == 1
    assert llamadas[0][0] == "123456789" and "pong" in llamadas[0][1]


def testUnComandoDeOtroChatNoSeContestaNiSeEjecuta(monkeypatch):
    """Ni siquiera con un comando desconocido: no se confirma que hay un bot detrás."""
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))
    ejecutados = []
    from admin import telegram_comandos
    monkeypatch.setattr(telegram_comandos, "responder", lambda texto: ejecutados.append(texto) or "x")

    for texto in ("/backup", "/estado", "/inventado", "/ayuda"):
        telegram_listener._procesar(_comando(texto, chatId=999999999), "token-123", "123456789")

    assert llamadas == [] and ejecutados == []


def testUnComandoViejoNoSeEjecuta(monkeypatch):
    """Tras un apagado, Telegram entrega lo escrito hace horas: un /backup de ayer no."""
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    telegram_listener._procesar(_comando("/ping", hace=3600), "token-123", "123456789")

    assert llamadas == []


def testStartViejoSiSeContesta(monkeypatch):
    """/start es el que desbloquea al bot: no caduca."""
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))

    telegram_listener._procesar(_comando("/start", hace=3600), "token-123", "123456789")

    assert len(llamadas) == 1 and "/ayuda" in llamadas[0]


def testUnComandoDesconocidoDelChatAutorizadoSeContesta(monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chatId, texto: llamadas.append(texto))

    telegram_listener._procesar(_comando("/inventado"), "token-123", "123456789")

    assert len(llamadas) == 1 and "/ayuda" in llamadas[0]


def testElBucleSigueConLaSiguienteActualizacionTrasUnFallo(monkeypatch, datosAislados):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.escribirConfig("123456:ABC-token", "123456789")
    monkeypatch.setattr(telegram_listener, "_registrarMenu", lambda token: None)

    vistos = []

    def _procesar(update, token, chat):
        vistos.append(update["update_id"])
        if update["update_id"] == 1:
            raise RuntimeError("falla la primera")
        telegram_listener._parada.set()

    monkeypatch.setattr(telegram_listener, "_procesar", _procesar)
    monkeypatch.setattr(telegram_listener, "_getUpdates", lambda token, offset: [{"update_id": 1}, {"update_id": 2}])
    telegram_listener._parada.clear()

    assert telegram_listener._escuchar() is True
    assert vistos == [1, 2]
    telegram_listener._parada.clear()


def testDosWorkersNoEscuchanALaVez(monkeypatch, datosAislados):
    """Telegram devuelve 409 a la segunda sesión de getUpdates, y contestaría doble."""
    from core.bloqueo import exclusivo

    escuchas = []
    monkeypatch.setattr(telegram_listener, "_escuchar", lambda: escuchas.append(1) or True)
    monkeypatch.setattr(telegram_listener, "_ESPERA_SIN_CONFIGURAR", 0.05)

    with exclusivo(telegram_listener._rutaBloqueo(), obligatorio=False) as otroWorker:
        assert otroWorker is True
        # Este "worker" lo intenta en un hilo aparte (el bloqueo es por
        # descriptor abierto) mientras el otro sigue teniéndolo.
        import threading

        telegram_listener._parada.clear()
        hilo = threading.Thread(target=telegram_listener._bucle, daemon=True)
        hilo.start()
        hilo.join(0.3)
        telegram_listener._parada.set()
        hilo.join(2)

    assert escuchas == []
    telegram_listener._parada.clear()


def testElMenuDeComandosSeRegistraUnaVezPorToken(monkeypatch):
    peticiones = []

    class _Respuesta:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    def _urlopen(peticion, timeout=None):
        peticiones.append(peticion.full_url)
        return _Respuesta()

    monkeypatch.setattr(telegram_listener.urllib.request, "urlopen", _urlopen)
    monkeypatch.setattr(telegram_listener, "_menuRegistrado", None)

    telegram_listener._registrarMenu("token-A")
    telegram_listener._registrarMenu("token-A")
    telegram_listener._registrarMenu("token-B")

    assert len(peticiones) == 2 and all(p.endswith("/setMyCommands") for p in peticiones)


def testUnFalloRegistrandoElMenuSeIgnora(monkeypatch):
    def _cae(*a, **k):
        raise OSError("sin red")

    monkeypatch.setattr(telegram_listener.urllib.request, "urlopen", _cae)
    monkeypatch.setattr(telegram_listener, "_menuRegistrado", None)

    telegram_listener._registrarMenu("token-A")

    assert telegram_listener._menuRegistrado is None, "hay que reintentarlo en la siguiente vuelta"
