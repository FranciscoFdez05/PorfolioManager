"""Coherencia de la versión y del CHANGELOG.

El número de versión vivía escrito a mano en tres ficheros y los tres decían
`1.0.0` porque nadie los subía. Como `/api/health` lo publica, el resultado era
un endpoint informando de una versión que no significaba nada.

Estas pruebas son el pegamento: si se sube la versión en `core/version.py` y se
olvida `pyproject.toml`, `package.json` o el CHANGELOG, CI lo dice. Es un tipo
de olvido que no rompe nada al ejecutar, así que solo lo detecta algo así.
"""

import json
import re
import tomllib
from pathlib import Path

import pytest

from core.version import __version__

RAIZ = Path(__file__).resolve().parent.parent

SEMVER = re.compile(r"^\d+\.\d+\.\d+$")


def testLaVersionEsSemver():
    assert SEMVER.match(__version__), f"{__version__!r} no es MAYOR.MENOR.PARCHE"


def testPyprojectDeclaraLaMismaVersion():
    datos = tomllib.loads((RAIZ / "pyproject.toml").read_text("utf-8"))
    assert datos["project"]["version"] == __version__


def testPackageJsonDeclaraLaMismaVersion():
    """El frontend no se publica como paquete, pero la versión se lee en `npm`."""
    datos = json.loads((RAIZ / "package.json").read_text("utf-8"))
    assert datos["version"] == __version__


def testLaPlantillaLlevaElMarcadorDeVersion():
    """index.html se sirve tal cual salvo por dos sustituciones: el nonce de CSP
    y la versión. Si alguien quita el marcador, la interfaz deja de decir qué
    versión está corriendo y nadie se entera hasta que hace falta saberlo."""
    from core.version import MARCADOR_VERSION

    index = (RAIZ / "index.html").read_text("utf-8")

    assert index.count(MARCADOR_VERSION) == 1, (
        f"index.html debe llevar exactamente un {MARCADOR_VERSION}"
    )


def testLaVersionSustituyeAlMarcador():
    from core.version import MARCADOR_VERSION, insertarVersion

    resultado = insertarVersion(f'<span class="appVersion">{MARCADOR_VERSION}</span>')

    assert resultado == f'<span class="appVersion">{__version__}</span>'


def testElBadgeDelReadmeDeclaraLaMismaVersion():
    """El badge del README es lo primero que se ve del proyecto.

    Y es justo lo que nadie mira al publicar: se quedó anunciando la 1.0.0
    mientras el código ya iba por la 1.1.0. Como el resto de comprobaciones de
    este fichero, aquí no se rompe nada al ejecutar, así que solo lo detecta
    algo así.
    """
    readme = (RAIZ / "README.md").read_text("utf-8")
    esperado = f"badge/versi%C3%B3n-{__version__}-blue"

    assert esperado in readme, (
        f"el badge del README no anuncia la {__version__}. Actualízalo en el "
        f"mismo commit en que subas la versión."
    )


# ── CHANGELOG ─────────────────────────────────────────────────────────────────

@pytest.fixture
def changelog():
    ruta = RAIZ / "CHANGELOG.md"
    assert ruta.exists(), "falta CHANGELOG.md"
    return ruta.read_text("utf-8")


def testElChangelogTieneEntradaParaEstaVersion(changelog):
    """Publicar sin decir qué cambió deja al que actualiza sin saber qué mirar."""
    assert f"## [{__version__}]" in changelog, (
        f"CHANGELOG.md no tiene la sección «## [{__version__}]». Añádela en el "
        f"mismo commit en que subas la versión."
    )


def testLasVersionesDelChangelogVanDeMayorAMenor(changelog):
    versiones = re.findall(r"^## \[(\d+\.\d+\.\d+)\]", changelog, re.M)
    assert versiones, "el CHANGELOG no lista ninguna versión"

    def clave(v):
        return tuple(int(p) for p in v.split("."))

    assert versiones == sorted(versiones, key=clave, reverse=True), (
        f"las versiones no están ordenadas de más nueva a más antigua: {versiones}"
    )


def testLaVersionActualEncabezaElChangelog(changelog):
    """La primera versión listada tiene que ser la que se está publicando."""
    primera = re.search(r"^## \[(\d+\.\d+\.\d+)\]", changelog, re.M)
    assert primera and primera.group(1) == __version__


def testCadaVersionDiceSiTocaElEsquema(changelog):
    """El dato que decide si la actualización se puede deshacer sin más.

    Una versión que sube `ESQUEMA_VERSION` deja una copia previa y se revierte
    restaurándola; una que no lo toca se revierte volviendo a la imagen
    anterior, sin tocar los datos. Quien actualiza necesita saber cuál es.
    """
    secciones = re.split(r"^## \[", changelog, flags=re.M)[1:]
    sinIndicar = [
        s.split("]")[0]
        for s in secciones
        if "Esquema de base de datos:" not in s
    ]
    assert not sinIndicar, (
        f"estas versiones no dicen si tocan el esquema: {sinIndicar}. "
        f"Añade una línea «Esquema de base de datos: …» en cada una."
    )


def testElEsquemaDeclaradoCoincideConElCodigo(changelog):
    """Si el CHANGELOG dice «sube al 2», `ESQUEMA_VERSION` tiene que ser 2."""
    from core.db import ESQUEMA_VERSION

    seccion = re.split(r"^## \[", changelog, flags=re.M)[1]
    declarado = re.search(r"Esquema de base de datos:\s*.*?(\d+)", seccion)
    assert declarado, "la línea del esquema de la versión actual no dice ningún número"
    assert int(declarado.group(1)) == ESQUEMA_VERSION, (
        f"el CHANGELOG dice esquema {declarado.group(1)} y core/db.py declara "
        f"{ESQUEMA_VERSION}"
    )
