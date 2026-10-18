"""Avisos por Telegram de sucesos: categorías, silencio y reparto entre workers.

Nada sale a la red: se sustituye `telegram_notifier._enviar`. Lo que se prueba
es la decisión de mandar o no mandar, que es lo que evita tanto un aviso que no
llega como un chat lleno de ruido.
"""

import json

import pytest

from core import reclamo, telegram_notifier


@pytest.fixture
def enviados(datosAislados, monkeypatch):
    """Telegram configurado y `_enviar` capturado. Devuelve la lista de textos."""
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    yield mensajes
    telegram_notifier.reiniciarParaPruebas()


def _guardarAjustes(datosAislados, **valores):
    datosAislados["ajustes"].write_text(json.dumps(valores), "utf-8")


# ── Preferencias ──────────────────────────────────────────────────────────────

def testSinElegirNadaValenLosDeFabrica(datosAislados):
    prefs = telegram_notifier.preferencias()

    assert set(prefs) == set(telegram_notifier.CATEGORIAS_AVISO)
    assert prefs["backup"] is True
    assert prefs["resumen"] is False, "el resumen diario es opt-in: nadie lo ha pedido"
    assert prefs["sesion"] is False, "avisar de cada login sería ruido por defecto"


def testLoElegidoMandaSobreLosDeFabrica(datosAislados):
    _guardarAjustes(datosAislados, telegramAvisos={"backup": False, "resumen": True})

    prefs = telegram_notifier.preferencias()

    assert prefs["backup"] is False
    assert prefs["resumen"] is True
    assert prefs["precios"] is True, "lo que no se toca conserva su valor de fábrica"


def testUnAjustesIlegibleNoRompeNada(datosAislados):
    datosAislados["ajustes"].write_text("{esto no es json", "utf-8")

    assert telegram_notifier.preferencias()["backup"] is True
    assert telegram_notifier.resumenHora() == telegram_notifier.RESUMEN_HORA_DEFECTO


@pytest.mark.parametrize("valor,esperado", [(8, 8), ("7", 7), (24, 21), (-1, 21), ("x", 21)])
def testLaHoraDelResumenSeAcota(datosAislados, valor, esperado):
    _guardarAjustes(datosAislados, telegramResumenHora=valor)

    assert telegram_notifier.resumenHora() == esperado


# ── notificar ─────────────────────────────────────────────────────────────────

def testNotificarEnviaSiEstaActivada(enviados):
    assert telegram_notifier.notificar("backup", "copia hecha") is True
    assert enviados == ["copia hecha"]


def testNotificarNoEnviaSinConfigurar(datosAislados, monkeypatch):
    llamadas = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda *a: llamadas.append(a))

    assert telegram_notifier.notificar("backup", "x") is False
    assert llamadas == []


def testNotificarRespetaUnaCategoriaApagada(enviados, datosAislados):
    _guardarAjustes(datosAislados, telegramAvisos={"backup": False})

    assert telegram_notifier.notificar("backup", "x") is False
    assert enviados == []


def testUnaCategoriaDesconocidaNoSeManda(enviados):
    assert telegram_notifier.notificar("inventada", "x") is False
    assert enviados == []


def testElCooldownEvitaRepetirElMismoAviso(enviados):
    assert telegram_notifier.notificar("sistema", "disco", clave="disco", cooldown=60) is True
    assert telegram_notifier.notificar("sistema", "disco", clave="disco", cooldown=60) is False
    assert telegram_notifier.notificar("sistema", "otro", clave="otra-cosa", cooldown=60) is True
    assert enviados == ["disco", "otro"]


def testElCooldownCompartidoSeCoordinaPorFichero(enviados):
    """Lo que dispara cada worker (el arranque) no puede salir dos veces."""
    assert telegram_notifier.notificar("sistema", "a", clave="arr", cooldown=60, compartido=True) is True
    # Simula al otro worker: mismo fichero de marca, memoria propia distinta.
    telegram_notifier.reiniciarParaPruebas()
    assert telegram_notifier.notificar("sistema", "b", clave="arr", cooldown=60, compartido=True) is False
    assert enviados == ["a"]


def testUnFalloAlEnviarNoLanza(enviados, monkeypatch):
    def _cae(*a):
        raise OSError("sin red")

    monkeypatch.setattr(telegram_notifier, "_enviar", _cae)

    assert telegram_notifier.notificar("backup", "x") is False


def testResponderIgnoraCategoriasYSilencio(enviados, datosAislados):
    """Lo que contesta el bot a una pregunta no es un aviso."""
    _guardarAjustes(datosAislados, telegramAvisos=dict.fromkeys(telegram_notifier.CATEGORIAS_AVISO, False))
    telegram_notifier.silenciar(3600)

    assert telegram_notifier.responder("pong") is True
    assert enviados == ["pong"]


def testLosAvisosDeProveedoresTambienRespetanSuCategoria(enviados, datosAislados):
    _guardarAjustes(datosAislados, telegramAvisos={"proveedores": False})

    telegram_notifier.notificarProblema("cuota_agotada", "Finnhub", "429")

    assert enviados == []


def testElTextoLargoSeRecortaAlLimiteDeTelegram(datosAislados, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    capturado = {}

    class _Respuesta:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def read(self):
            return b'{"ok": true}'

    def _urlopen(peticion, timeout=None):
        capturado["cuerpo"] = json.loads(peticion.data.decode("utf-8"))
        return _Respuesta()

    monkeypatch.setattr(telegram_notifier.urllib.request, "urlopen", _urlopen)

    telegram_notifier._enviar("t", "1", "x" * 9000)

    assert len(capturado["cuerpo"]["text"]) <= 4096


# ── Silencio ──────────────────────────────────────────────────────────────────

def testSilenciarCallaLosAvisosYActivarLosDevuelve(enviados):
    telegram_notifier.silenciar(3600)
    assert telegram_notifier.silenciadoHasta() > 0
    assert telegram_notifier.notificar("backup", "x") is False

    telegram_notifier.quitarSilencio()
    assert telegram_notifier.silenciadoHasta() == 0
    assert telegram_notifier.notificar("backup", "x") is True


def testUnSilencioCaducadoYaNoCalla(enviados):
    telegram_notifier.silenciar(3600)
    telegram_notifier._archivoSilencio().write_text("1000", "utf-8")

    assert telegram_notifier.silenciadoHasta() == 0
    assert telegram_notifier.notificar("backup", "x") is True


def testElArranqueSoloLoCuentaElPrimerWorker(enviados):
    telegram_notifier.notificarArranque("9.9.9")
    telegram_notifier.reiniciarParaPruebas()  # el otro worker: memoria propia
    telegram_notifier.notificarArranque("9.9.9")

    assert len(enviados) == 1
    assert "9.9.9" in enviados[0]


# ── reclamo ───────────────────────────────────────────────────────────────────

def testReclamarCadaNSegundos(datosAislados):
    assert reclamo.reclamar("tarea", 60) is True
    assert reclamo.reclamar("tarea", 60) is False
    assert reclamo.reclamar("otra", 60) is True


def testReclamarDeNuevoPasadoElPlazo(datosAislados):
    assert reclamo.reclamar("tarea", 60) is True
    # Con plazo 0 ya ha pasado "el tiempo" desde el reclamo anterior.
    assert reclamo.reclamar("tarea", 0) is True


def testReclamarUnaSolaVezHastaQueSeLibere(datosAislados):
    assert reclamo.reclamar("version-2.0.0", None) is True
    assert reclamo.reclamar("version-2.0.0", None) is False

    reclamo.liberar("version-2.0.0")

    assert reclamo.reclamar("version-2.0.0", None) is True


def testLaClaveNoPuedeEscaparDelDirectorio(datosAislados):
    from core import paths

    reclamo.reclamar("../../etc/passwd", 60)

    assert not (paths.TMP_DIR.parent.parent / "etc").exists()
    assert all(p.parent == paths.TMP_DIR for p in paths.TMP_DIR.glob("reclamo-*"))
