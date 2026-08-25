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


def test_la_version_es_semver():
    assert SEMVER.match(__version__), f"{__version__!r} no es MAYOR.MENOR.PARCHE"


def test_pyproject_declara_la_misma_version():
    datos = tomllib.loads((RAIZ / "pyproject.toml").read_text("utf-8"))
    assert datos["project"]["version"] == __version__


def test_package_json_declara_la_misma_version():
    """El frontend no se publica como paquete, pero la versión se lee en `npm`."""
    datos = json.loads((RAIZ / "package.json").read_text("utf-8"))
    assert datos["version"] == __version__


# ── CHANGELOG ─────────────────────────────────────────────────────────────────

@pytest.fixture
def changelog():
    ruta = RAIZ / "CHANGELOG.md"
    assert ruta.exists(), "falta CHANGELOG.md"
    return ruta.read_text("utf-8")


def test_el_changelog_tiene_entrada_para_esta_version(changelog):
    """Publicar sin decir qué cambió deja al que actualiza sin saber qué mirar."""
    assert f"## [{__version__}]" in changelog, (
        f"CHANGELOG.md no tiene la sección «## [{__version__}]». Añádela en el "
        f"mismo commit en que subas la versión."
    )


def test_las_versiones_del_changelog_van_de_mayor_a_menor(changelog):
    versiones = re.findall(r"^## \[(\d+\.\d+\.\d+)\]", changelog, re.M)
    assert versiones, "el CHANGELOG no lista ninguna versión"

    def clave(v):
        return tuple(int(p) for p in v.split("."))

    assert versiones == sorted(versiones, key=clave, reverse=True), (
        f"las versiones no están ordenadas de más nueva a más antigua: {versiones}"
    )


def test_la_version_actual_encabeza_el_changelog(changelog):
    """La primera versión listada tiene que ser la que se está publicando."""
    primera = re.search(r"^## \[(\d+\.\d+\.\d+)\]", changelog, re.M)
    assert primera and primera.group(1) == __version__


def test_cada_version_dice_si_toca_el_esquema(changelog):
    """El dato que decide si la actualización se puede deshacer sin más.

    Una versión que sube `ESQUEMA_VERSION` deja una copia previa y se revierte
    restaurándola; una que no lo toca se revierte volviendo a la imagen
    anterior, sin tocar los datos. Quien actualiza necesita saber cuál es.
    """
    secciones = re.split(r"^## \[", changelog, flags=re.M)[1:]
    sin_indicar = [
        s.split("]")[0]
        for s in secciones
        if "Esquema de base de datos:" not in s
    ]
    assert not sin_indicar, (
        f"estas versiones no dicen si tocan el esquema: {sin_indicar}. "
        f"Añade una línea «Esquema de base de datos: …» en cada una."
    )


def test_el_esquema_declarado_coincide_con_el_codigo(changelog):
    """Si el CHANGELOG dice «sube al 2», `ESQUEMA_VERSION` tiene que ser 2."""
    from core.db import ESQUEMA_VERSION

    seccion = re.split(r"^## \[", changelog, flags=re.M)[1]
    declarado = re.search(r"Esquema de base de datos:\s*.*?(\d+)", seccion)
    assert declarado, "la línea del esquema de la versión actual no dice ningún número"
    assert int(declarado.group(1)) == ESQUEMA_VERSION, (
        f"el CHANGELOG dice esquema {declarado.group(1)} y core/db.py declara "
        f"{ESQUEMA_VERSION}"
    )
