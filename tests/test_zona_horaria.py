"""TZ con nombre IANA en Windows: la librería de C lo leía como UTC."""

import pytest

from core.zona_horaria import descartarTzIanaEnWindows


@pytest.mark.parametrize(
    ("plataforma", "valor", "seQuita"),
    [
        ("win32", "Europe/Madrid", True),
        ("win32", "CET-1CEST", False),
        ("linux", "Europe/Madrid", False),
    ],
)
def testSoloSeQuitaUnNombreIanaEnWindows(plataforma, valor, seQuita):
    entorno = {"TZ": valor}

    assert descartarTzIanaEnWindows(entorno, plataforma) is seQuita
    assert ("TZ" in entorno) is not seQuita


def testSinTzNoHaceNada():
    entorno = {}

    assert descartarTzIanaEnWindows(entorno, "win32") is False
    assert entorno == {}
