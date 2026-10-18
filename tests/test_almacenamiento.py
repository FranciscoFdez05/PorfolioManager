"""Comprobación de escritura de los directorios de datos y sus mensajes.

Es el problema que solo aparece al salir de Windows: en el PC de desarrollo el
proceso es el dueño de la carpeta del proyecto y escribir en `data/` nunca
falla; en Docker sobre Linux, `data/`, `logs/` y `API/` son volúmenes montados
desde el host, con su propietario y sus permisos, y la aplicación corre como
otro usuario. Cuando eso no encaja, la web se ve y se navega —leer no necesita
permiso de escritura— pero no se guarda nada.

Lo que se cubre aquí es que ese estado se **detecte** (comprobando con una
escritura real, no con los bits de permiso) y que el fallo llegue al usuario
diciendo la causa y el siguiente paso, en vez de un "Error al crear backup".
"""

import errno
import sqlite3

import pytest

from core import paths
from core.errors import mensajeAlmacenamiento

# ── Detección ─────────────────────────────────────────────────────────────────

def testUnDirectorioNormalEsEscribible(tmp_path):
    escribible, motivo = paths.comprobarEscritura(tmp_path)

    assert escribible is True
    assert motivo == ""


def testNoDejaElFicheroDePruebaDetras(tmp_path):
    paths.comprobarEscritura(tmp_path)

    assert list(tmp_path.iterdir()) == []


def testCreaElDirectorioSiNoExiste(tmp_path):
    destino = tmp_path / "data" / "tmp"

    assert paths.comprobarEscritura(destino)[0] is True
    assert destino.is_dir()


def testConCrearDesactivadoUnDirectorioAusenteNoSeCrea(tmp_path):
    destino = tmp_path / "no_montado"

    escribible, motivo = paths.comprobarEscritura(destino, crear=False)

    assert escribible is False
    assert motivo == "no existe"
    assert not destino.exists()


def testUnaRutaOcupadaPorUnFicheroNoEsEscribible(tmp_path):
    """Pasa cuando el volumen se monta sobre algo que no es un directorio."""
    ocupada = tmp_path / "data"
    ocupada.write_text("no soy un directorio", encoding="utf-8")

    escribible, motivo = paths.comprobarEscritura(ocupada)

    assert escribible is False
    assert motivo


def testElDiagnosticoListaTodosLosDirectoriosDeDatos(tmp_path, monkeypatch):
    for nombre in ("DATA_DIR", "PORTFOLIOS_DIR", "JSON_DIR", "BACKUPS_DIR", "LOGS_DIR", "API_DIR"):
        monkeypatch.setattr(paths, nombre, tmp_path / nombre.lower(), raising=False)

    informe = paths.diagnosticoAlmacenamiento()

    assert set(informe) == {"datos", "portfolios", "json", "backups", "logs", "claves"}
    assert all(d["escribible"] for d in informe.values())
    # La ruta absoluta es la mitad del diagnóstico: en Docker dice si la
    # aplicación resolvió la que se creía tener montada.
    assert informe["datos"]["ruta"] == str(tmp_path / "data_dir")


# ── Mensajes ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(("codigo", "fragmento"), [
    (errno.EACCES, "permiso de escritura"),
    (errno.EPERM, "no permitida"),
    (errno.EROFS, "solo lectura"),
    (errno.ENOSPC, "no queda espacio"),
    (errno.ENOENT, "no existe"),
    (errno.EIO, "entrada/salida"),
])
def testCadaFalloDelSistemaDeFicherosDiceSuCausa(codigo, fragmento):
    mensaje = mensajeAlmacenamiento(OSError(codigo, "…"), "/app/data/backups")

    assert fragmento in mensaje
    assert "/app/data/backups" in mensaje


def testElFalloDePermisosDiceCómoArreglarlo():
    """En Docker el usuario no puede tocar el código, pero sí los permisos."""
    mensaje = mensajeAlmacenamiento(PermissionError(errno.EACCES, "denied"), "/app/data")

    assert "chown" in mensaje
    assert "PUID" in mensaje


def testUnErrnoDesconocidoNoSeQuedaSinMensaje():
    mensaje = mensajeAlmacenamiento(OSError(4095, "Algo raro"), "/app/data")

    assert "/app/data" in mensaje
    assert "Algo raro" in mensaje


@pytest.mark.parametrize(("texto", "fragmento"), [
    ("attempt to write a readonly database", "solo lectura"),
    ("unable to open database file", "permiso de escritura sobre el directorio"),
    ("disk I/O error", "disco local"),
    ("database is locked", "bloqueada"),
    ("database disk image is malformed", "dañada"),
])
def testLosErroresDeSqliteSeTraducenALaCausaReal(texto, fragmento):
    """SQLite envuelve los fallos del sistema de ficheros en mensajes propios."""
    mensaje = mensajeAlmacenamiento(sqlite3.OperationalError(texto), "/app/data/portfolios")

    assert fragmento in mensaje
