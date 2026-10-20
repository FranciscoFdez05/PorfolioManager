"""docker-up.sh cuenta la longitud de la contraseña en caracteres, no en bytes."""

import os
import subprocess
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CUENTA = "import os; print(len(os.environ['PW']))"


def testElScriptCuentaConPythonYNoConBytes():
    texto = (RAIZ / "docker-up.sh").read_text("utf-8")

    assert "len(os.environ['PW'])" in texto
    assert 'LARGO_PW="${#PW}"' in texto  # solo como respaldo


def testUnaContrasenaConAcentosSeCuentaPorCaracteres():
    entorno = {**os.environ, "PW": "ñ" * 9, "PYTHONUTF8": "1"}

    salida = subprocess.run(
        [sys.executable, "-c", CUENTA], capture_output=True, text=True, env=entorno, check=True
    ).stdout.strip()

    assert salida == "9"  # 18 bytes en UTF-8, pero menos de los 10 caracteres exigidos
