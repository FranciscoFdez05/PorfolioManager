"""El despliegue con el servicio worker: scripts, imagen y compose.

El worker depende de que la web esté sana, así que `docker compose up -d` da error
si no lo está. Con `set -e`, eso cortaba docker-update.sh antes de la vuelta atrás.
Aquí se ejecuta de verdad ese tramo del script, con un `docker` y un `curl` falsos.
"""

import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

RAIZ = Path(__file__).resolve().parent.parent

necesitaSh = pytest.mark.skipif(shutil.which("sh") is None, reason="hace falta un sh")

# Sustituyen a lo que el script define antes del tramo que se ejecuta.
_preparacion = """set -e
SERVICIO=porfoliomanager
ESPERA_SALUD=2
PORT=5050
VERSION_NUEVA=2.0.0
VERSION_ANTERIOR=1.0.0
aviso() { echo "AVISO: $*"; }
error() { echo "ERROR: $*"; }
paso() { echo "PASO: $*"; }
fase() { :; }
"""

# `up` falla las primeras $UP_FALLOS veces; cada llamada queda apuntada.
_dockerFalso = """#!/bin/sh
echo "$*" >> "$REGISTRO"
if [ "$1 $2" = "compose up" ]; then
    hechas=$(grep -c "^compose up" "$REGISTRO")
    [ "$hechas" -gt "$UP_FALLOS" ] || exit 1
fi
exit 0
"""


def _ejecutarUpdate(tmp_path: Path, upFallos: int, webResponde: bool) -> tuple[subprocess.CompletedProcess, list[str]]:
    """Ejecuta docker-update.sh desde el paso de levantar, con dobles de docker y curl."""
    falsos = tmp_path / "bin"
    falsos.mkdir()
    for nombre, contenido in (("docker", _dockerFalso), ("curl", f"#!/bin/sh\nexit {0 if webResponde else 1}\n")):
        doble = falsos / nombre
        doble.write_bytes(contenido.encode("utf-8"))
        doble.chmod(0o755)

    texto = (RAIZ / "docker-update.sh").read_text("utf-8")
    tramo = texto[texto.index("# ── 6. Construir"):]
    script = tmp_path / "tramo.sh"
    script.write_bytes((_preparacion + tramo).encode("utf-8"))
    registro = tmp_path / "docker.log"
    registro.touch()

    entorno = {**os.environ, "PATH": f"{falsos}{os.pathsep}{os.environ['PATH']}",
               "REGISTRO": registro.as_posix(), "UP_FALLOS": str(upFallos)}
    resultado = subprocess.run(["sh", str(script)], capture_output=True, text=True, encoding="utf-8",
                               env=entorno, timeout=60)
    return resultado, registro.read_text("utf-8").splitlines()


@necesitaSh
def testSiLaWebNoArrancaLlegaALaVueltaAtras(tmp_path):
    resultado, llamadas = _ejecutarUpdate(tmp_path, upFallos=1, webResponde=False)

    assert "Volviendo atrás" in resultado.stdout
    assert "compose up -d --no-build" in llamadas
    assert "Se ha vuelto a la 1.0.0" in resultado.stdout
    assert resultado.returncode == 1


@necesitaSh
def testSiLaVueltaAtrasFallaSiguenLasIndicaciones(tmp_path):
    resultado, _ = _ejecutarUpdate(tmp_path, upFallos=99, webResponde=False)

    assert "tampoco ha arrancado" in resultado.stdout
    assert "pre-esquema" in resultado.stdout


@necesitaSh
def testSiLaWebTardaPeroAcabaSanaSeLevantaLoQueFaltaba(tmp_path):
    resultado, llamadas = _ejecutarUpdate(tmp_path, upFallos=1, webResponde=True)

    assert llamadas.count("compose up -d") == 2
    assert "Actualización correcta" in resultado.stdout
    assert resultado.returncode == 0


@necesitaSh
def testActualizacionNormalLevantaUnaSolaVez(tmp_path):
    resultado, llamadas = _ejecutarUpdate(tmp_path, upFallos=0, webResponde=True)

    assert llamadas.count("compose up -d") == 1
    assert resultado.returncode == 0


def testDockerUpNoMuereSiUpFalla():
    """Un `docker compose up` a secas cortaría antes del diagnóstico de la web."""
    texto = (RAIZ / "docker-up.sh").read_text("utf-8")

    assert 'docker compose up -d "$@" || upFallido=1' in texto
    assert not re.search(r"^docker compose up -d[^|\n]*$", texto, re.MULTILINE)


def testLaImagenNoLlevaNadaDeApi():
    lineas = (RAIZ / ".dockerignore").read_text("utf-8").splitlines()

    assert "API/*" in lineas


def testElWorkerTieneBuildYElVigilanteLoVigila():
    compose = (RAIZ / "docker-compose.yml").read_text("utf-8")
    bloqueWorker = compose[compose.index("\n  worker:"):compose.index("\n  # ── Proxy")]

    assert "build: ." in bloqueWorker
    assert "/app/data/tmp/worker.latido" in bloqueWorker
    assert "El worker=latido:/app/data/tmp/worker.latido" in compose
