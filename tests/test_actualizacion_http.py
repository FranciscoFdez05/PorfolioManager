"""El botón «Actualizar» de Ajustes > Datos.

La aplicación no actualiza nada: no puede. Dentro del contenedor no hay Docker
ni repositorio, y `docker-update.sh` para y recrea el contenedor que lo estaría
ejecutando —lo mataría justo antes de la comprobación de arranque y del
retroceso automático, que es lo que hace que actualizar sea seguro—. Lo que hace
el botón es dejar una señal en `data/tmp/` que recoge un vigilante del host.

Lo que se prueba aquí es ese contrato: que la señal se deja, que no se pisan dos
actualizaciones, y —lo que más ayuda a quien lo instala— que la pantalla puede
distinguir «el vigilante está trabajando» de «el vigilante no existe».

El GET lleva además la versión publicada en GitHub, que es lo único que sí se
puede averiguar desde dentro: `test_version_remota.py` cubre esa lógica, y aquí
solo se comprueba que llega a la respuesta y que `?refrescar=1` la fuerza.
"""

import json

import pytest

from core import actualizacion
from core.version import __version__
from tests.test_backup_http import _crearDb


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.actualizacion import actualizacionBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")

    client, cabeceras, _app = clienteAutenticado(actualizacionBp)
    return client, cabeceras


def _escribirEstado(estado, momento=None, **extra):
    """Escribe lo que dejaría el vigilante del host."""
    from core import paths

    paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
    (paths.TMP_DIR / actualizacion.NOMBRE_ESTADO).write_text(
        json.dumps({"estado": estado, "momento": momento or _ahora(), **extra}),
        encoding="utf-8",
    )


def _ahora(desplazamiento=0.0):
    from datetime import datetime, timedelta

    return (datetime.now().astimezone() - timedelta(seconds=desplazamiento)).isoformat()


def _senal():
    from core import paths

    return paths.TMP_DIR / actualizacion.NOMBRE_SOLICITUD


# ── Estado ───────────────────────────────────────────────────────────────────

def testSinNadaHechoNoHayNiSolicitudNiVigilante(cliente):
    client, _cabeceras = cliente

    datos = client.get("/api/actualizacion").get_json()

    assert datos["ok"] is True
    assert datos["version"] == __version__
    assert datos["solicitada"] is None
    assert datos["enMarcha"] is False
    # Es el dato que evita un botón girando para siempre: si el vigilante no
    # está instalado, la señal se queda ahí y no la recoge nadie.
    assert datos["vigilanteVisto"] is False


def testElRastroDelVigilanteEsLoQueDiceQueEstaInstalado(cliente):
    client, _cabeceras = cliente
    _escribirEstado("ok", codigo=0, detalle="todo bien")

    datos = client.get("/api/actualizacion").get_json()

    assert datos["vigilanteVisto"] is True
    assert datos["ultimo"]["estado"] == "ok"


def testUnFicheroDeEstadoIlegibleNoTumbaLaPantalla(cliente):
    """Lo escribe un proceso de fuera: puede pillarse a medias."""
    from core import paths

    client, _cabeceras = cliente
    paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
    (paths.TMP_DIR / actualizacion.NOMBRE_ESTADO).write_text("{esto no es json", encoding="utf-8")

    datos = client.get("/api/actualizacion").get_json()

    assert datos["ok"] is True
    assert datos["ultimo"] is None


def testUnCaracterDeControlEnElDetalleNoOcultaAlVigilante(cliente):
    """La salida de docker-update.sh trae colores ANSI: el ESC se coló en el JSON y
    la pantalla decía que el vigilante no daba señales aunque estuviera sano."""
    from core import paths

    client, _cabeceras = cliente
    paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
    (paths.TMP_DIR / actualizacion.NOMBRE_ESTADO).write_text(
        '{"estado": "ok", "momento": "2026-10-08T16:00:00+02:00", "codigo": 0, "detalle": "\x1b[1;36mbien"}',
        encoding="utf-8",
    )

    datos = client.get("/api/actualizacion").get_json()

    assert datos["vigilanteVisto"] is True
    assert datos["ultimo"]["estado"] == "ok"


def testElEstadoSinSesionEs401(crearApp, datosAislados, tempDb):
    from routes.actualizacion import actualizacionBp

    client = crearApp(actualizacionBp).test_client()
    assert client.get("/api/actualizacion").status_code == 401


# ── Solicitud ────────────────────────────────────────────────────────────────

def testPedirUnaActualizacionDejaLaSenal(cliente):
    client, cabeceras = cliente

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    dejado = json.loads(_senal().read_text(encoding="utf-8"))
    assert dejado["version"] == __version__
    assert dejado["momento"]


def testLaSolicitudSeVeEnElEstado(cliente):
    client, cabeceras = cliente
    client.post("/api/actualizacion", headers=cabeceras)

    datos = client.get("/api/actualizacion").get_json()

    assert datos["solicitada"]["version"] == __version__
    assert datos["haceSegundos"] is not None


def testNoSePisanDosActualizacionesALaVez(cliente):
    """El vigilante ya está construyendo la imagen: pedir otra no ayuda."""
    client, cabeceras = cliente
    _escribirEstado("en_marcha")

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.status_code == 409
    assert not _senal().exists()


def testUnEnMarchaViejoNoDejaElBotonMuerto(cliente):
    """Si el host se reinició a mitad, nadie va a escribir el resultado.

    Sin plazo, ese «en marcha» eterno dejaría el botón inservible para siempre.
    """
    client, cabeceras = cliente
    _escribirEstado("en_marcha", momento=_ahora(actualizacion.ESPERA_MAXIMA_SEGUNDOS + 60))

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    assert _senal().exists()


def testUnaActualizacionFallidaNoImpideReintentar(cliente):
    client, cabeceras = cliente
    _escribirEstado("fallo", codigo=1, detalle="el build reventó")

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    assert _senal().exists()


def testPedirlaDosVecesDejaUnaSolaSenal(cliente):
    """Un doble clic no puede convertirse en dos reconstrucciones seguidas."""
    client, cabeceras = cliente

    client.post("/api/actualizacion", headers=cabeceras)
    client.post("/api/actualizacion", headers=cabeceras)

    assert _senal().exists()
    assert json.loads(_senal().read_text(encoding="utf-8"))["version"] == __version__


def testPedirLaActualizacionSinSesionEs401(crearApp, datosAislados, tempDb):
    """Reconstruye y reinicia el servidor: no es un endpoint para desconocidos."""
    from routes.actualizacion import actualizacionBp

    client = crearApp(actualizacionBp).test_client()
    assert client.post("/api/actualizacion").status_code == 401


def testPedirLaActualizacionSinCsrfEs403(clienteAutenticado, datosAislados, tempDb):
    from routes.actualizacion import actualizacionBp

    client, _cabeceras, _app = clienteAutenticado(actualizacionBp)
    assert client.post("/api/actualizacion").status_code == 403


# ── Copia previa por Telegram ────────────────────────────────────────────────

@pytest.fixture
def telegramCapturado(datosAislados, monkeypatch):
    """Telegram configurado y un portfolio que copiar, sin salir a la red."""
    from core import paths, telegram_notifier

    monkeypatch.setattr(paths, "API_DIR", datosAislados["claves"])
    _crearDb(datosAislados["portfolios"] / "principal.db", [("2026-01-01", 100.0, 90.0)])
    datosAislados["meta"].write_text(json.dumps({"active": "principal"}), encoding="utf-8")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")

    capturado = {"ficheros": [], "textos": []}

    def _documento(_token, _chat, ruta, texto):
        # Si la señal ya estuviera, el vigilante podría matar el envío a medias.
        capturado["ficheros"].append((ruta.name, texto, _senal().exists()))

    monkeypatch.setattr(telegram_notifier, "_enviarDocumento", _documento)
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda _t, _c, texto: capturado["textos"].append(texto))
    return capturado


def _activarEnvioDeFichero(rutas):
    rutas["ajustes"].write_text(json.dumps({"telegramAvisos": {"backupFichero": True}}), encoding="utf-8")


def testActualizarMandaLaCopiaAntesDeDejarLaSenal(cliente, datosAislados, telegramCapturado):
    client, cabeceras = cliente
    _activarEnvioDeFichero(datosAislados)

    assert client.post("/api/actualizacion", headers=cabeceras).get_json()["ok"] is True

    [(nombre, pie, senalYaPuesta)] = telegramCapturado["ficheros"]
    assert senalYaPuesta is False
    assert _senal().exists()
    assert "previa a la actualización" in pie
    assert (datosAislados["backups"] / nombre).exists()
    # Con `_auto` el scheduler creería hecha la copia de esa noche.
    assert nombre.endswith(".zip") and not nombre.endswith("_auto.zip")


def testConElEnvioApagadoSoloLlegaElAvisoDeTexto(cliente, telegramCapturado):
    """El ZIP sale a los servidores de Telegram: actualizar no se salta ese interruptor."""
    client, cabeceras = cliente

    assert client.post("/api/actualizacion", headers=cabeceras).get_json()["ok"] is True

    assert telegramCapturado["ficheros"] == []
    assert len(telegramCapturado["textos"]) == 1
    assert "Copia de seguridad manual creada" in telegramCapturado["textos"][0]


def testSiLaCopiaFallaSeAvisaYSeActualizaIgual(cliente, telegramCapturado, monkeypatch):
    from routes import backup

    client, cabeceras = cliente

    def _falla(*, automatico):
        raise OSError("disco lleno")

    monkeypatch.setattr(backup, "_escribirBackup", _falla)

    assert client.post("/api/actualizacion", headers=cabeceras).get_json()["ok"] is True

    assert _senal().exists()
    assert len(telegramCapturado["textos"]) == 1
    assert "Ha fallado la copia previa" in telegramCapturado["textos"][0]
    assert "disco lleno" in telegramCapturado["textos"][0]


def testSiTelegramFallaSeActualizaIgual(cliente, datosAislados, telegramCapturado, monkeypatch):
    from core import telegram_notifier

    client, cabeceras = cliente
    _activarEnvioDeFichero(datosAislados)

    def _sinRed(*_args):
        raise OSError("sin red")

    monkeypatch.setattr(telegram_notifier, "_enviarDocumento", _sinRed)

    assert client.post("/api/actualizacion", headers=cabeceras).get_json()["ok"] is True

    assert _senal().exists()
    assert len(telegramCapturado["textos"]) == 1


def testConUnaActualizacionEnMarchaNoSeHaceCopia(cliente, datosAislados, telegramCapturado):
    client, cabeceras = cliente
    _activarEnvioDeFichero(datosAislados)
    _escribirEstado("en_marcha")

    assert client.post("/api/actualizacion", headers=cabeceras).status_code == 409

    assert telegramCapturado["ficheros"] == []
    assert list(datosAislados["backups"].glob("backup_*.zip")) == []


def testUnDobleClicNoMandaDosCopias(cliente, datosAislados, telegramCapturado):
    client, cabeceras = cliente
    _activarEnvioDeFichero(datosAislados)

    client.post("/api/actualizacion", headers=cabeceras)
    client.post("/api/actualizacion", headers=cabeceras)

    assert len(telegramCapturado["ficheros"]) == 1


def testUnaSenalAbandonadaNoEvitaLaCopiaDelSiguienteIntento(cliente, datosAislados, telegramCapturado):
    """Pasado el plazo, la copia que acompañó a esa señal ya no vale como previa."""
    client, cabeceras = cliente
    _activarEnvioDeFichero(datosAislados)
    _senal().parent.mkdir(parents=True, exist_ok=True)
    _senal().write_text(
        json.dumps({"momento": _ahora(actualizacion.ESPERA_MAXIMA_SEGUNDOS + 60), "version": __version__}),
        encoding="utf-8",
    )

    client.post("/api/actualizacion", headers=cabeceras)

    assert len(telegramCapturado["ficheros"]) == 1


# ── Versión publicada ────────────────────────────────────────────────────────

def _responderGithub(monkeypatch, version="9.9.9", contador=None):
    from core import version_remota

    def _falso(url):
        if contador is not None:
            contador.append(url)
        return f'__version__ = "{version}"'

    monkeypatch.setattr(version_remota, "_descargar", _falso)
    monkeypatch.setattr(version_remota, "_descargarChangelog", lambda url: "")


def testElEstadoDiceSiHayVersionNueva(cliente, monkeypatch):
    client, _cabeceras = cliente
    _responderGithub(monkeypatch, "9.9.9")

    remota = client.get("/api/actualizacion").get_json()["remota"]

    assert remota["publicada"] == "9.9.9"
    assert remota["hayNueva"] is True


def testRefrescarVuelveAPreguntar(cliente, monkeypatch):
    """El botón «Comprobar»: sin él habría que esperar a que caducara la caché."""
    client, _cabeceras = cliente
    llamadas = []
    _responderGithub(monkeypatch, "9.9.9", contador=llamadas)

    client.get("/api/actualizacion")
    from core import version_remota

    monkeypatch.setattr(version_remota, "ESPERA_MINIMA_FORZADO_SEGUNDOS", 0)
    client.get("/api/actualizacion?refrescar=1")

    assert len(llamadas) == 2


def testUnGithubInalcanzableNoRompeElPanel(cliente, monkeypatch):
    """La actualización sigue pudiéndose pedir aunque no se sepa qué hay fuera."""
    from urllib.error import URLError

    from core import version_remota

    client, cabeceras = cliente

    def _falla(url):
        raise URLError("sin ruta al host")

    monkeypatch.setattr(version_remota, "_descargar", _falla)

    datos = client.get("/api/actualizacion").get_json()

    assert datos["ok"] is True
    assert datos["version"] == __version__
    assert datos["remota"]["publicada"] is None
    assert datos["remota"]["error"]
    assert client.post("/api/actualizacion", headers=cabeceras).get_json()["ok"] is True


# ── Fase en curso ────────────────────────────────────────────────────────────

def testLaFaseQueDejaDockerUpdateLlegaAlEstado(cliente):
    """Es la barra de progreso: docker-update.sh la escribe en cada paso."""
    from core import paths

    client, _cabeceras = cliente
    paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
    (paths.TMP_DIR / actualizacion.NOMBRE_FASE).write_text(
        json.dumps({"fase": "construyendo", "momento": _ahora(), "detalle": "9.9.9"}),
        encoding="utf-8",
    )

    datos = client.get("/api/actualizacion").get_json()

    assert datos["fase"]["fase"] == "construyendo"
    assert datos["fase"]["detalle"] == "9.9.9"


def testSinFaseNoHayFase(cliente):
    """Un vigilante antiguo no la deja: la pantalla tiene que poder sin ella."""
    client, _cabeceras = cliente

    assert client.get("/api/actualizacion").get_json()["fase"] is None
