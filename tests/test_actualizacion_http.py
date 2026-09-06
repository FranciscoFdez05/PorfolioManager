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


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.actualizacion import actualizacion_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")

    client, cabeceras, _app = cliente_autenticado(actualizacion_bp)
    return client, cabeceras


def _escribir_estado(estado, momento=None, **extra):
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

def test_sin_nada_hecho_no_hay_ni_solicitud_ni_vigilante(cliente):
    client, _cabeceras = cliente

    datos = client.get("/api/actualizacion").get_json()

    assert datos["ok"] is True
    assert datos["version"] == __version__
    assert datos["solicitada"] is None
    assert datos["enMarcha"] is False
    # Es el dato que evita un botón girando para siempre: si el vigilante no
    # está instalado, la señal se queda ahí y no la recoge nadie.
    assert datos["vigilanteVisto"] is False


def test_el_rastro_del_vigilante_es_lo_que_dice_que_esta_instalado(cliente):
    client, _cabeceras = cliente
    _escribir_estado("ok", codigo=0, detalle="todo bien")

    datos = client.get("/api/actualizacion").get_json()

    assert datos["vigilanteVisto"] is True
    assert datos["ultimo"]["estado"] == "ok"


def test_un_fichero_de_estado_ilegible_no_tumba_la_pantalla(cliente):
    """Lo escribe un proceso de fuera: puede pillarse a medias."""
    from core import paths

    client, _cabeceras = cliente
    paths.TMP_DIR.mkdir(parents=True, exist_ok=True)
    (paths.TMP_DIR / actualizacion.NOMBRE_ESTADO).write_text("{esto no es json", encoding="utf-8")

    datos = client.get("/api/actualizacion").get_json()

    assert datos["ok"] is True
    assert datos["ultimo"] is None


def test_el_estado_sin_sesion_es_401(crear_app, datos_aislados, temp_db):
    from routes.actualizacion import actualizacion_bp

    client = crear_app(actualizacion_bp).test_client()
    assert client.get("/api/actualizacion").status_code == 401


# ── Solicitud ────────────────────────────────────────────────────────────────

def test_pedir_una_actualizacion_deja_la_senal(cliente):
    client, cabeceras = cliente

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    dejado = json.loads(_senal().read_text(encoding="utf-8"))
    assert dejado["version"] == __version__
    assert dejado["momento"]


def test_la_solicitud_se_ve_en_el_estado(cliente):
    client, cabeceras = cliente
    client.post("/api/actualizacion", headers=cabeceras)

    datos = client.get("/api/actualizacion").get_json()

    assert datos["solicitada"]["version"] == __version__
    assert datos["haceSegundos"] is not None


def test_no_se_pisan_dos_actualizaciones_a_la_vez(cliente):
    """El vigilante ya está construyendo la imagen: pedir otra no ayuda."""
    client, cabeceras = cliente
    _escribir_estado("en_marcha")

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.status_code == 409
    assert not _senal().exists()


def test_un_en_marcha_viejo_no_deja_el_boton_muerto(cliente):
    """Si el host se reinició a mitad, nadie va a escribir el resultado.

    Sin plazo, ese «en marcha» eterno dejaría el botón inservible para siempre.
    """
    client, cabeceras = cliente
    _escribir_estado("en_marcha", momento=_ahora(actualizacion.ESPERA_MAXIMA_SEGUNDOS + 60))

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    assert _senal().exists()


def test_una_actualizacion_fallida_no_impide_reintentar(cliente):
    client, cabeceras = cliente
    _escribir_estado("fallo", codigo=1, detalle="el build reventó")

    respuesta = client.post("/api/actualizacion", headers=cabeceras)

    assert respuesta.get_json()["ok"] is True
    assert _senal().exists()


def test_pedirla_dos_veces_deja_una_sola_senal(cliente):
    """Un doble clic no puede convertirse en dos reconstrucciones seguidas."""
    client, cabeceras = cliente

    client.post("/api/actualizacion", headers=cabeceras)
    client.post("/api/actualizacion", headers=cabeceras)

    assert _senal().exists()
    assert json.loads(_senal().read_text(encoding="utf-8"))["version"] == __version__


def test_pedir_la_actualizacion_sin_sesion_es_401(crear_app, datos_aislados, temp_db):
    """Reconstruye y reinicia el servidor: no es un endpoint para desconocidos."""
    from routes.actualizacion import actualizacion_bp

    client = crear_app(actualizacion_bp).test_client()
    assert client.post("/api/actualizacion").status_code == 401


def test_pedir_la_actualizacion_sin_csrf_es_403(cliente_autenticado, datos_aislados, temp_db):
    from routes.actualizacion import actualizacion_bp

    client, _cabeceras, _app = cliente_autenticado(actualizacion_bp)
    assert client.post("/api/actualizacion").status_code == 403


# ── Versión publicada ────────────────────────────────────────────────────────

def _responder_github(monkeypatch, version="9.9.9", contador=None):
    from core import version_remota

    def _falso(url):
        if contador is not None:
            contador.append(url)
        return f'__version__ = "{version}"'

    monkeypatch.setattr(version_remota, "_descargar", _falso)


def test_el_estado_dice_si_hay_version_nueva(cliente, monkeypatch):
    client, _cabeceras = cliente
    _responder_github(monkeypatch, "9.9.9")

    remota = client.get("/api/actualizacion").get_json()["remota"]

    assert remota["publicada"] == "9.9.9"
    assert remota["hayNueva"] is True


def test_refrescar_vuelve_a_preguntar(cliente, monkeypatch):
    """El botón «Comprobar»: sin él habría que esperar a que caducara la caché."""
    client, _cabeceras = cliente
    llamadas = []
    _responder_github(monkeypatch, "9.9.9", contador=llamadas)

    client.get("/api/actualizacion")
    from core import version_remota

    monkeypatch.setattr(version_remota, "ESPERA_MINIMA_FORZADO_SEGUNDOS", 0)
    client.get("/api/actualizacion?refrescar=1")

    assert len(llamadas) == 2


def test_un_github_inalcanzable_no_rompe_el_panel(cliente, monkeypatch):
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
