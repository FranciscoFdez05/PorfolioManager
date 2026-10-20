"""El cerrojo del vigilante no se queda huérfano tras un reinicio o una muerte brusca."""

import os
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

from core import actualizacion

SCRIPT = Path(__file__).resolve().parent.parent / "tools" / "actualizador" / "portfolio-actualizador.sh"

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("sh") is None,
    reason="el vigilante es un script POSIX del host Linux",
)


def _proyecto(tmp_path):
    (tmp_path / "logs").mkdir()
    actualizar = tmp_path / "docker-update.sh"
    actualizar.write_text("#!/bin/sh\necho actualizado\n", encoding="utf-8")
    actualizar.chmod(0o755)
    (tmp_path / "data" / "tmp").mkdir(parents=True)
    (tmp_path / "data" / "tmp" / actualizacion.NOMBRE_SOLICITUD).write_text("{}", encoding="utf-8")
    return tmp_path


def _ejecutar(proyecto):
    return subprocess.run(["sh", str(SCRIPT), str(proyecto)], capture_output=True, text=True, timeout=30)


def _cerrojo(proyecto):
    return proyecto / "data" / "tmp" / "actualizacion.lock"


def _estado(proyecto):
    return proyecto / "data" / "tmp" / actualizacion.NOMBRE_ESTADO


def _pidMuerto():
    proceso = subprocess.Popen(["sh", "-c", "exit 0"])
    proceso.wait()
    return proceso.pid


def _envejecer(ruta, minutos):
    antes = time.time() - minutos * 60
    os.utime(ruta, (antes, antes))


def testCerrojoConPidMuertoSeRecuperaYActualiza(tmp_path):
    proyecto = _proyecto(tmp_path)
    _cerrojo(proyecto).mkdir()
    (_cerrojo(proyecto) / "pid").write_text(str(_pidMuerto()), encoding="utf-8")

    _ejecutar(proyecto)

    assert "ok" in _estado(proyecto).read_text("utf-8")
    assert not _cerrojo(proyecto).exists()


def testCerrojoConPidVivoYRecienteSeRespeta(tmp_path):
    proyecto = _proyecto(tmp_path)
    _cerrojo(proyecto).mkdir()
    (_cerrojo(proyecto) / "pid").write_text(str(os.getpid()), encoding="utf-8")

    _ejecutar(proyecto)

    assert _cerrojo(proyecto).exists()
    assert (proyecto / "data" / "tmp" / actualizacion.NOMBRE_SOLICITUD).exists()


def testCerrojoConPidVivoPeroDeMasDe35MinutosSeRecupera(tmp_path):
    proyecto = _proyecto(tmp_path)
    _cerrojo(proyecto).mkdir()
    pid = _cerrojo(proyecto) / "pid"
    pid.write_text(str(os.getpid()), encoding="utf-8")
    _envejecer(pid, 40)

    _ejecutar(proyecto)

    assert "ok" in _estado(proyecto).read_text("utf-8")
    assert not _cerrojo(proyecto).exists()


def testCerrojoSinPidSoloSeRecuperaPasadoUnMinuto(tmp_path):
    proyecto = _proyecto(tmp_path)
    _cerrojo(proyecto).mkdir()

    _ejecutar(proyecto)
    assert _cerrojo(proyecto).exists()

    _envejecer(_cerrojo(proyecto), 5)
    _ejecutar(proyecto)
    assert not _cerrojo(proyecto).exists()
    assert "ok" in _estado(proyecto).read_text("utf-8")


def testElFicheroDeEstadoQuedaLegibleParaOtrosUsuarios(tmp_path):
    proyecto = _proyecto(tmp_path)

    _ejecutar(proyecto)

    modo = stat.S_IMODE(_estado(proyecto).stat().st_mode)
    assert modo & 0o044 == 0o044
