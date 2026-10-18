"""Versión automática en las URLs de los JS y CSS propios (core/estaticos.py).

El código propio se servía con `no-cache`: el navegador preguntaba por los 102
ficheros en cada carga, y con un acceso remoto eso era más de un segundo
aunque no cambiase nada. Ahora index.html sale con un `?v=` calculado de cada
fichero, y la URL con la versión vigente se cachea un año. Lo que no puede
pasar: que tras cambiar un fichero el navegador siga usando el viejo. Por eso
la versión sale del propio fichero en cada petición, no de una constante.
"""

import os

import pytest

from core import estaticos


@pytest.fixture
def base(tmp_path):
    (tmp_path / "js" / "core").mkdir(parents=True)
    (tmp_path / "css").mkdir()
    (tmp_path / "js" / "core" / "app.js").write_text("console.log(1)", "utf-8")
    (tmp_path / "css" / "base.css").write_text("body{}", "utf-8")
    return tmp_path


def _html():
    return (
        '<link rel="stylesheet" href="css/base.css">\n'
        '<script defer src="js/core/app.js"></script>\n'
        '<script defer src="js/vendor/chart.umd.min.js?v=4.5.1"></script>\n'
        '<script defer src="js/core/no-existe.js"></script>\n'
        '<a href="css/base.css">texto, no etiqueta de recurso</a>\n'
    )


def testLasReferenciasPropiasLlevanLaVersionDelFichero(base):
    html = estaticos.versionarReferencias(_html(), base)

    versionJs = estaticos.firmaEstatico("js/core/app.js", base)
    versionCss = estaticos.firmaEstatico("css/base.css", base)
    assert f'src="js/core/app.js?v={versionJs}"' in html
    assert f'href="css/base.css?v={versionCss}"' in html


def testLoQueYaLlevaVersionONoExisteSeQuedaIgual(base):
    html = estaticos.versionarReferencias(_html(), base)

    assert 'src="js/vendor/chart.umd.min.js?v=4.5.1"' in html
    assert 'src="js/core/no-existe.js"' in html
    assert '<a href="css/base.css">' in html


def testCambiarElFicheroCambiaLaVersion(base):
    fichero = base / "js" / "core" / "app.js"
    antes = estaticos.firmaEstatico("js/core/app.js", base)

    fichero.write_text("console.log(2); // más largo", "utf-8")
    st = fichero.stat()
    os.utime(fichero, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000_000))

    assert estaticos.firmaEstatico("js/core/app.js", base) != antes


def testSoloLaVersionVigenteSeConsideraInmutable(base):
    vigente = estaticos.firmaEstatico("js/core/app.js", base)

    assert estaticos.esVersionVigente("js/core/app.js", vigente, base) is True
    assert estaticos.esVersionVigente("js/core/app.js", "otra", base) is False
    assert estaticos.esVersionVigente("js/core/app.js", None, base) is False
    assert estaticos.esVersionVigente("js/core/no-existe.js", vigente, base) is False


def testNoSeSaleDeLaCarpetaDelProyecto(base):
    assert estaticos.firmaEstatico("../fuera.js", base) is None
    assert estaticos.firmaEstatico("/etc/passwd", base) is None
    assert estaticos.firmaEstatico("C:/Windows/win.ini", base) is None
    html = estaticos.versionarReferencias('<script src="js/../../fuera.js"></script>', base)
    assert "?v=" not in html
