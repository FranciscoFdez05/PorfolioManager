"""La comprobación de «¿hay versión nueva publicada?».

Es la parte del botón de actualizar que sí puede hacerse desde dentro del
contenedor, porque es solo una lectura: `python/core/version.py` de la rama en
GitHub, comparado con la versión instalada. Lo que se prueba aquí es lo que
decide qué pinta la pantalla y cuántas veces se llama a GitHub.

Ninguna prueba sale a la red: se sustituye la descarga, que es justo la costura
que separa «hablar con GitHub» de «decidir qué significa la respuesta».
"""

import json

import pytest

from core import version_remota
from core.version import __version__


@pytest.fixture(autouse=True)
def _sin_red(monkeypatch):
    """Ninguna prueba de este fichero puede llamar a GitHub por descuido."""

    def _prohibido(url):
        raise AssertionError(f"se ha intentado descargar {url}")

    monkeypatch.setattr(version_remota, "_descargar", _prohibido)


def _responder(monkeypatch, version="9.9.9", contador=None):
    """Sustituye la descarga por un version.py de mentira."""

    def _falso(url):
        if contador is not None:
            contador.append(url)
        return f'"""Docstring."""\n\n__version__ = "{version}"\n'

    monkeypatch.setattr(version_remota, "_descargar", _falso)


def _cache():
    from core import paths

    return paths.TMP_DIR / version_remota.NOMBRE_CACHE


# ── Comparación de versiones ─────────────────────────────────────────────────

@pytest.mark.parametrize(
    "instalada,publicada,esperado",
    [
        ("1.7.0", "1.8.0", True),
        ("1.7.0", "1.7.1", True),
        ("1.7.0", "2.0.0", True),
        ("1.7.0", "1.7.0", False),
        # Publicar una versión más baja pasa al volver atrás una release: no es
        # «hay actualización», y decir que sí llevaría a instalar hacia atrás.
        ("1.10.0", "1.9.0", False),
        # Comparación numérica, no alfabética: "1.10.0" > "1.9.0".
        ("1.9.0", "1.10.0", True),
    ],
)
def test_compara_versiones(instalada, publicada, esperado):
    assert version_remota.hayNueva(instalada, publicada) is esperado


@pytest.mark.parametrize("publicada", [None, "", "1.8", "no-es-una-version", "v1.8.0"])
def test_lo_que_no_se_puede_comparar_no_es_estar_al_dia(publicada):
    """`None`, no `False`: la pantalla no debe decir «al día» sin saberlo."""
    assert version_remota.hayNueva("1.7.0", publicada) is None


# ── Consulta ─────────────────────────────────────────────────────────────────

def test_una_version_mas_nueva_se_anuncia(datos_aislados, monkeypatch):
    _responder(monkeypatch, "9.9.9")

    resultado = version_remota.consultar()

    assert resultado["publicada"] == "9.9.9"
    assert resultado["hayNueva"] is True
    assert resultado["error"] is None
    assert resultado["activo"] is True


def test_la_version_instalada_es_la_publicada(datos_aislados, monkeypatch):
    _responder(monkeypatch, __version__)

    resultado = version_remota.consultar()

    assert resultado["publicada"] == __version__
    assert resultado["hayNueva"] is False


def test_la_segunda_consulta_no_vuelve_a_preguntar(datos_aislados, monkeypatch):
    """El panel se recarga cada 5 s durante una actualización."""
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)

    version_remota.consultar()
    version_remota.consultar()
    version_remota.consultar()

    assert len(llamadas) == 1


def test_forzar_salta_la_cache(datos_aislados, monkeypatch):
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)

    version_remota.consultar()
    # La caché recién escrita es más nueva que la espera mínima del forzado, así
    # que hay que envejecerla para simular el segundo clic en «Comprobar».
    _envejecer_cache(version_remota.ESPERA_MINIMA_FORZADO_SEGUNDOS + 1)
    version_remota.consultar(forzar=True)

    assert len(llamadas) == 2


def test_forzar_dos_veces_seguidas_no_martillea_a_github(datos_aislados, monkeypatch):
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)

    version_remota.consultar(forzar=True)
    version_remota.consultar(forzar=True)

    assert len(llamadas) == 1


def _envejecer_cache(segundos):
    from datetime import datetime, timedelta

    ruta = _cache()
    datos = json.loads(ruta.read_text("utf-8"))
    datos["momento"] = (datetime.now().astimezone() - timedelta(seconds=segundos)).isoformat()
    ruta.write_text(json.dumps(datos), encoding="utf-8")


def test_la_cache_caduca(datos_aislados, monkeypatch):
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)
    monkeypatch.setenv("ACTUALIZACION_CACHE_MINUTOS", "1")

    version_remota.consultar()
    _envejecer_cache(120)
    version_remota.consultar()

    assert len(llamadas) == 2


# ── Fallos ───────────────────────────────────────────────────────────────────

def test_un_fallo_de_red_no_rompe_el_panel(datos_aislados, monkeypatch):
    from urllib.error import URLError

    def _falla(url):
        raise URLError("sin ruta al host")

    monkeypatch.setattr(version_remota, "_descargar", _falla)

    resultado = version_remota.consultar()

    assert resultado["publicada"] is None
    assert resultado["hayNueva"] is None
    assert "GitHub" in resultado["error"]


def test_un_fallo_conserva_la_ultima_version_conocida(datos_aislados, monkeypatch):
    """Saber que hace horas había una 9.9.9 es más útil que un hueco."""
    from urllib.error import URLError

    _responder(monkeypatch, "9.9.9")
    version_remota.consultar()
    _envejecer_cache(10 ** 6)

    def _falla(url):
        raise URLError("sin ruta al host")

    monkeypatch.setattr(version_remota, "_descargar", _falla)

    resultado = version_remota.consultar()

    assert resultado["publicada"] == "9.9.9"
    assert resultado["error"]


def test_un_fallo_no_se_reintenta_en_cada_carga_del_panel(datos_aislados, monkeypatch):
    """Con GitHub caído, cada apertura de Ajustes se comería el timeout."""
    from urllib.error import URLError

    llamadas = []

    def _falla(url):
        llamadas.append(url)
        raise URLError("sin ruta al host")

    monkeypatch.setattr(version_remota, "_descargar", _falla)

    version_remota.consultar()
    version_remota.consultar()

    assert len(llamadas) == 1


def test_una_respuesta_sin_version_se_trata_como_fallo(datos_aislados, monkeypatch):
    monkeypatch.setattr(version_remota, "_descargar", lambda url: "<html>404</html>")

    resultado = version_remota.consultar()

    assert resultado["publicada"] is None
    assert "versión" in resultado["error"]


def test_un_repositorio_mal_escrito_no_llega_a_llamar(datos_aislados, monkeypatch):
    # La descarga sigue siendo la prohibida del fixture: si esto llamara, falla.
    monkeypatch.setenv("ACTUALIZACION_REPO", "esto no es un repositorio")

    resultado = version_remota.consultar()

    assert resultado["publicada"] is None
    assert "no son válidos" in resultado["error"]


def test_desactivada_no_pregunta_ni_pinta(datos_aislados, monkeypatch):
    monkeypatch.setenv("ACTUALIZACION_COMPROBAR", "false")

    resultado = version_remota.consultar()

    assert resultado["activo"] is False
    assert resultado["publicada"] is None


def test_la_url_apunta_a_la_rama_configurada(monkeypatch):
    monkeypatch.setenv("ACTUALIZACION_REPO", "alguien/otro-repo")
    monkeypatch.setenv("ACTUALIZACION_RAMA", "pruebas")

    url = version_remota._url()

    assert url == (
        "https://raw.githubusercontent.com/alguien/otro-repo/pruebas/python/core/version.py"
    )
