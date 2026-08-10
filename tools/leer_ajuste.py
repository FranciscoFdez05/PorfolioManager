"""Imprime el valor efectivo de un ajuste, para los scripts de arranque.

    python tools/leer_ajuste.py server.port          → 5000
    python tools/leer_ajuste.py gunicorn.workers     → 2
    python tools/leer_ajuste.py --listar             → tabla completa con origen

Existe para que entrypoint.sh y docker-up.sh no tengan que reimplementar la
lectura de config.ini con `configparser` a mano: esas copias no aplicaban ni el
override por entorno ni los rangos válidos, así que un puerto inválido en
config.ini llegaba tal cual al mapeo de Docker.

Sin argumentos válidos devuelve un código de salida distinto de 0, para que el
script que lo llama pueda decidir si sigue con su propio valor por defecto.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))

from core import settings


def _formatear(valor):
    if isinstance(valor, bool):
        # Los scripts de shell comparan con "true"/"false", no con "True".
        return "true" if valor else "false"
    if isinstance(valor, (list, tuple)):
        return ",".join(str(item) for item in valor)
    return str(valor)


def _listar():
    filas = settings.diagnostico(incluirDescripcion=True)
    ancho = max(len(fila["nombre"]) for fila in filas)

    for aviso in settings.validar():
        print(f"AVISO: {aviso}", file=sys.stderr)

    for fila in filas:
        print(f"{fila['nombre']:<{ancho}}  {_formatear(fila['valor']):<24}  ({fila['origen']})")


def main(argv):
    if len(argv) != 1:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    if argv[0] in ("--listar", "-l"):
        _listar()
        return 0

    try:
        print(_formatear(settings.obtener(argv[0])))
    except KeyError as error:
        print(error, file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
