"""Tiempo de arranque y memoria del servidor sobre una instancia aislada.

Arranca la aplicación N veces y mide el tiempo hasta que /api/health responde
200 y la memoria residente (RSS, proceso y sus hijos) en ese momento. Mide
también, en un proceso aparte, cuánto tarda solo `import server` (importar los
módulos y ejecutar la inicialización: initPortfolios, esquema, schedulers).

Uso:
    python perf/medir_arranque.py [--veces 5] [--json salida.json]
"""

import argparse
import json
import statistics
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import entorno
from carga_http import rssMb

_IMPORTAR = (
    "import time, sys, os; t = time.perf_counter(); import server; "
    "print(round(time.perf_counter() - t, 3)); sys.stdout.flush(); os._exit(0)"
)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--veces", type=int, default=5)
    parser.add_argument("--servidor", default=None)
    parser.add_argument("--json")
    args = parser.parse_args()

    arranques, memorias, imports = [], [], []
    for i in range(args.veces):
        with entorno.Instancia(servidor=args.servidor, reutilizarDatos=i > 0) as inst:
            arranques.append(inst.segundosArranque)
            memorias.append(rssMb(inst.proc))
            destino = inst.destino

    variables = entorno.variablesEntorno(destino, entorno.puertoLibre())
    for _ in range(args.veces):
        salida = subprocess.run([sys.executable, "-c", _IMPORTAR], cwd=str(entorno.DIR_PYTHON),
                                env=variables, capture_output=True, text=True)
        imports.append(float(salida.stdout.strip().splitlines()[-1]))

    resultado = {
        "servidor": args.servidor or ("gunicorn" if sys.platform != "win32" else "waitress"),
        "segundosHastaHealth": {"mediana": round(statistics.median(arranques), 2),
                                "min": round(min(arranques), 2), "max": round(max(arranques), 2)},
        "segundosImportServer": {"mediana": round(statistics.median(imports), 3),
                                 "min": round(min(imports), 3), "max": round(max(imports), 3)},
        "rssAlArrancarMb": {"mediana": statistics.median([m for m in memorias if m is not None] or [0])},
    }
    print(json.dumps(resultado, indent=2))
    if args.json:
        Path(args.json).write_text(json.dumps(resultado, indent=2), "utf-8")


if __name__ == "__main__":
    main()
