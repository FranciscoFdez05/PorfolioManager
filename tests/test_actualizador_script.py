"""El vigilante del host (`tools/actualizador/portfolio-actualizador.sh`), ejecutado de verdad.

Es un script de shell que corre fuera de la aplicación, así que lo único que
comparte con ella es el fichero `data/tmp/actualizacion.estado`. Lo que se
comprueba aquí es que ese fichero sea siempre un JSON que la aplicación pueda
leer, también cuando `docker-update.sh` escribe colores o comillas. Un estado
ilegible hacía que Ajustes dijera que el vigilante no daba señales de vida.
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from core import actualizacion

SCRIPT = Path(__file__).resolve().parent.parent / "tools" / "actualizador" / "portfolio-actualizador.sh"

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("sh") is None,
    reason="el vigilante es un script POSIX del host Linux",
)


def _proyecto(tmp_path, salida_update=""):
    """Un proyecto de mentira con un docker-update.sh que imprime `salida_update`."""
    (tmp_path / "logs").mkdir()
    actualizar = tmp_path / "docker-update.sh"
    actualizar.write_text(f"#!/bin/sh\nprintf '%b' '{salida_update}'\n", encoding="utf-8")
    actualizar.chmod(0o755)
    return tmp_path


def _ejecutar(proyecto):
    return subprocess.run(["sh", str(SCRIPT), str(proyecto)], capture_output=True, text=True, timeout=30)


def _estado(proyecto):
    ruta = proyecto / "data" / "tmp" / actualizacion.NOMBRE_ESTADO
    return json.loads(ruta.read_text("utf-8"))


def _pedir(proyecto):
    (proyecto / "data" / "tmp").mkdir(parents=True, exist_ok=True)
    (proyecto / "data" / "tmp" / actualizacion.NOMBRE_SOLICITUD).write_text("{}", encoding="utf-8")


def test_sin_peticion_deja_constancia_de_que_esta_vivo(tmp_path):
    proyecto = _proyecto(tmp_path)

    resultado = _ejecutar(proyecto)

    assert resultado.returncode == 0
    assert _estado(proyecto)["estado"] == "inactivo"


def test_no_pisa_un_resultado_real_con_el_de_estar_vivo(tmp_path):
    proyecto = _proyecto(tmp_path)
    _pedir(proyecto)
    _ejecutar(proyecto)
    assert _estado(proyecto)["estado"] == "ok"

    _ejecutar(proyecto)

    assert _estado(proyecto)["estado"] == "ok"


def test_la_salida_con_colores_y_comillas_sigue_siendo_json_valido(tmp_path):
    proyecto = _proyecto(tmp_path, r'\033[1;36m── Actualización\033[0m correcta "x" \\ fin\n')
    _pedir(proyecto)

    resultado = _ejecutar(proyecto)

    assert resultado.returncode == 0
    estado = _estado(proyecto)  # json.loads estricto: un ESC suelto lo haría fallar
    assert estado["estado"] == "ok"
    assert "\x1b" not in estado["detalle"]
    assert '"x"' in estado["detalle"]


def test_un_fallo_se_cuenta_con_su_codigo(tmp_path):
    proyecto = _proyecto(tmp_path)
    (proyecto / "docker-update.sh").write_text("#!/bin/sh\necho roto\nexit 3\n", encoding="utf-8")
    _pedir(proyecto)

    _ejecutar(proyecto)

    estado = _estado(proyecto)
    assert estado["estado"] == "fallo"
    assert estado["codigo"] == 3
    assert "roto" in estado["detalle"]


def test_lo_que_escribe_la_aplicacion_lo_lee_la_aplicacion(tmp_path, datos_aislados):
    """El contrato entero: el JSON del script pasa por el lector de `core.actualizacion`."""
    proyecto = _proyecto(tmp_path, r'\033[31mrojo\033[0m\n')
    _pedir(proyecto)
    _ejecutar(proyecto)

    leido = actualizacion._leer_json(proyecto / "data" / "tmp" / actualizacion.NOMBRE_ESTADO)

    assert leido is not None
    assert leido["estado"] == "ok"
