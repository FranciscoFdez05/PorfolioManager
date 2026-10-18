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
def _sinRed(monkeypatch):
    """Ninguna prueba de este fichero puede llamar a GitHub por descuido."""

    def _prohibido(url):
        raise AssertionError(f"se ha intentado descargar {url}")

    monkeypatch.setattr(version_remota, "_descargar", _prohibido)
    # Con versión nueva se piden también las novedades: aquí, ninguna.
    monkeypatch.setattr(version_remota, "_descargarChangelog", lambda url: "")


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
def testComparaVersiones(instalada, publicada, esperado):
    assert version_remota.hayNueva(instalada, publicada) is esperado


@pytest.mark.parametrize("publicada", [None, "", "1.8", "no-es-una-version", "v1.8.0"])
def testLoQueNoSePuedeCompararNoEsEstarAlDia(publicada):
    """`None`, no `False`: la pantalla no debe decir «al día» sin saberlo."""
    assert version_remota.hayNueva("1.7.0", publicada) is None


# ── Consulta ─────────────────────────────────────────────────────────────────

def testUnaVersionMasNuevaSeAnuncia(datosAislados, monkeypatch):
    _responder(monkeypatch, "9.9.9")

    resultado = version_remota.consultar()

    assert resultado["publicada"] == "9.9.9"
    assert resultado["hayNueva"] is True
    assert resultado["error"] is None
    assert resultado["activo"] is True


def testLaVersionInstaladaEsLaPublicada(datosAislados, monkeypatch):
    _responder(monkeypatch, __version__)

    resultado = version_remota.consultar()

    assert resultado["publicada"] == __version__
    assert resultado["hayNueva"] is False


def testLaSegundaConsultaNoVuelveAPreguntar(datosAislados, monkeypatch):
    """El panel se recarga cada 5 s durante una actualización."""
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)

    version_remota.consultar()
    version_remota.consultar()
    version_remota.consultar()

    assert len(llamadas) == 1


def testActualizarLaAplicacionInvalidaLaCache(datosAislados, monkeypatch):
    """La caché sobrevive en el volumen: no puede enseñar lo leído con la versión anterior."""
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)
    version_remota.consultar()
    datos = json.loads(_cache().read_text("utf-8"))
    datos["instalada"] = "0.0.1"
    _cache().write_text(json.dumps(datos), "utf-8")

    version_remota.consultar()

    assert len(llamadas) == 2


def testForzarSaltaLaCache(datosAislados, monkeypatch):
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)

    version_remota.consultar()
    # La caché recién escrita es más nueva que la espera mínima del forzado, así
    # que hay que envejecerla para simular el segundo clic en «Comprobar».
    _envejecerCache(version_remota.ESPERA_MINIMA_FORZADO_SEGUNDOS + 1)
    version_remota.consultar(forzar=True)

    assert len(llamadas) == 2


def testForzarDosVecesSeguidasNoMartilleaAGithub(datosAislados, monkeypatch):
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)

    version_remota.consultar(forzar=True)
    version_remota.consultar(forzar=True)

    assert len(llamadas) == 1


def _envejecerCache(segundos):
    from datetime import datetime, timedelta

    ruta = _cache()
    datos = json.loads(ruta.read_text("utf-8"))
    datos["momento"] = (datetime.now().astimezone() - timedelta(seconds=segundos)).isoformat()
    ruta.write_text(json.dumps(datos), encoding="utf-8")


def testLaCacheCaduca(datosAislados, monkeypatch):
    llamadas = []
    _responder(monkeypatch, "9.9.9", contador=llamadas)
    monkeypatch.setenv("ACTUALIZACION_CACHE_MINUTOS", "1")

    version_remota.consultar()
    _envejecerCache(120)
    version_remota.consultar()

    assert len(llamadas) == 2


# ── Fallos ───────────────────────────────────────────────────────────────────

def testUnFalloDeRedNoRompeElPanel(datosAislados, monkeypatch):
    from urllib.error import URLError

    def _falla(url):
        raise URLError("sin ruta al host")

    monkeypatch.setattr(version_remota, "_descargar", _falla)

    resultado = version_remota.consultar()

    assert resultado["publicada"] is None
    assert resultado["hayNueva"] is None
    assert "GitHub" in resultado["error"]


def testUnFalloConservaLaUltimaVersionConocida(datosAislados, monkeypatch):
    """Saber que hace horas había una 9.9.9 es más útil que un hueco."""
    from urllib.error import URLError

    _responder(monkeypatch, "9.9.9")
    version_remota.consultar()
    _envejecerCache(10 ** 6)

    def _falla(url):
        raise URLError("sin ruta al host")

    monkeypatch.setattr(version_remota, "_descargar", _falla)

    resultado = version_remota.consultar()

    assert resultado["publicada"] == "9.9.9"
    assert resultado["error"]


def testUnFalloNoSeReintentaEnCadaCargaDelPanel(datosAislados, monkeypatch):
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


def testUnaRespuestaSinVersionSeTrataComoFallo(datosAislados, monkeypatch):
    monkeypatch.setattr(version_remota, "_descargar", lambda url: "<html>404</html>")

    resultado = version_remota.consultar()

    assert resultado["publicada"] is None
    assert "versión" in resultado["error"]


def testUnRepositorioMalEscritoNoLlegaALlamar(datosAislados, monkeypatch):
    # La descarga sigue siendo la prohibida del fixture: si esto llamara, falla.
    monkeypatch.setenv("ACTUALIZACION_REPO", "esto no es un repositorio")

    resultado = version_remota.consultar()

    assert resultado["publicada"] is None
    assert "no son válidos" in resultado["error"]


def testDesactivadaNoPreguntaNiPinta(datosAislados, monkeypatch):
    monkeypatch.setenv("ACTUALIZACION_COMPROBAR", "false")

    resultado = version_remota.consultar()

    assert resultado["activo"] is False
    assert resultado["publicada"] is None


def testLaUrlApuntaALaRamaConfigurada(monkeypatch):
    monkeypatch.setenv("ACTUALIZACION_REPO", "alguien/otro-repo")
    monkeypatch.setenv("ACTUALIZACION_RAMA", "pruebas")

    url = version_remota._url()

    assert url == (
        "https://raw.githubusercontent.com/alguien/otro-repo/pruebas/python/core/version.py"
    )


# ── Novedades ────────────────────────────────────────────────────────────────

_CHANGELOG = """# Changelog

Introducción.

---

## [9.9.9] — 2026-12-01

### Añadido

- Lo último.

---

## [9.9.8] — 2026-11-30

- Lo penúltimo.

---

## [0.0.1] — 2020-01-01

- Lo de siempre.

---

## [0.0.0] — 2019-01-01
"""


def testLasNovedadesSonLasPosterioresALaInstalada():
    novedades = version_remota.extraerNovedades(_CHANGELOG, "1.0.0")

    assert [n["version"] for n in novedades] == ["9.9.9", "9.9.8"]
    assert novedades[0]["fecha"] == "2026-12-01"
    assert "Lo último" in novedades[0]["texto"]
    # El separador entre versiones no es contenido.
    assert not novedades[0]["texto"].rstrip().endswith("---")


def testUnaSeccionCortadaAlFinalNoSeDaPorBuena():
    """El changelog se descarga a medias: la última sección del trozo puede
    estar incompleta, y es mejor no enseñarla que enseñarla mutilada."""
    cortado = _CHANGELOG.split("## [9.9.8]")[0] + "## [9.9.8] — 2026-11-30\n\n- Lo pen"

    novedades = version_remota.extraerNovedades(cortado, "1.0.0")

    assert [n["version"] for n in novedades] == ["9.9.9"]


def testLasNovedadesLleganALaConsulta(datosAislados, monkeypatch):
    _responder(monkeypatch, "9.9.9")
    monkeypatch.setattr(version_remota, "_descargarChangelog", lambda url: _CHANGELOG)

    resultado = version_remota.consultar()

    assert [n["version"] for n in resultado["novedades"]] == ["9.9.9", "9.9.8"]


def testAlDiaNoSePidenNovedades(datosAislados, monkeypatch):
    _responder(monkeypatch, __version__)

    def _prohibido(url):
        raise AssertionError("sin versión nueva no hay novedades que leer")

    monkeypatch.setattr(version_remota, "_descargarChangelog", _prohibido)

    assert version_remota.consultar()["novedades"] == []


def testSinNovedadesLegiblesSigueHabiendoVersionNueva(datosAislados, monkeypatch):
    from urllib.error import URLError

    _responder(monkeypatch, "9.9.9")

    def _falla(url):
        raise URLError("sin ruta al host")

    monkeypatch.setattr(version_remota, "_descargarChangelog", _falla)

    resultado = version_remota.consultar()

    assert resultado["hayNueva"] is True
    assert resultado["novedades"] == []
