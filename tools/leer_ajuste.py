"""Imprime el valor efectivo de un ajuste, para los scripts de arranque.

    python tools/leer_ajuste.py server.port          → 5000
    python tools/leer_ajuste.py gunicorn.workers     → 2
    python tools/leer_ajuste.py --listar             → tabla completa con origen
    python tools/leer_ajuste.py --sombras [.env]     → choques entre .env y config.ini

Existe para que entrypoint.sh y docker-up.sh no tengan que reimplementar la
lectura de config.ini con `configparser` a mano: esas copias no aplicaban ni el
override por entorno ni los rangos válidos, así que un puerto inválido en
config.ini llegaba tal cual al mapeo de Docker.

Sin argumentos válidos devuelve un código de salida distinto de 0, para que el
script que lo llama pueda decidir si sigue con su propio valor por defecto.

`--sombras` es la comprobación que hace docker-up.sh antes de levantar el stack.
Lee el .env como lo leería Docker Compose y dice qué ajustes escritos en
config.ini no van a usarse porque una variable del .env los tapa. Se hace aquí,
en el host y antes de arrancar, porque el aviso equivalente del arranque queda
enterrado en el log del contenedor: nadie lo lee hasta que ya hay un problema.
"""

import os
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


def _cargarEnv(ruta):
    """Mete en el entorno las variables del .env, como haría Docker Compose.

    Parseo deliberadamente simple —`CLAVE=valor`, sin `export`, sin comillas ni
    continuaciones— porque es exactamente lo que admite el `env_file` de Compose.
    Los `$$` que docker-up.sh escribe para escapar el `$` del hash de la
    contraseña se dejan tal cual: aquí no se resuelve ninguna interpolación, y
    de esas variables (secretos) no se avisa nunca.
    """
    if not ruta.is_file():
        return

    for linea in ruta.read_text(encoding="utf-8", errors="replace").splitlines():
        linea = linea.strip()
        if not linea or linea.startswith("#") or "=" not in linea:
            continue
        clave, _, valor = linea.partition("=")
        clave = clave.strip()
        if clave:
            os.environ[clave] = valor.strip()


def _sombras(argumento):
    ruta = Path(argumento) if argumento else Path(__file__).resolve().parent.parent / ".env"
    _cargarEnv(ruta)

    avisos = settings.sombras()
    for aviso in avisos:
        print(aviso)

    # 0 = no hay choques. 3 (y no 1) para que quien llame pueda distinguir
    # "hay sombras" de "el ajuste no existe" sin mirar la salida.
    return 3 if avisos else 0


def _listar():
    filas = settings.diagnostico(incluirDescripcion=True)
    ancho = max(len(fila["nombre"]) for fila in filas)

    for aviso in settings.validar():
        print(f"AVISO: {aviso}", file=sys.stderr)

    for fila in filas:
        print(f"{fila['nombre']:<{ancho}}  {_formatear(fila['valor']):<24}  ({fila['origen']})")


def main(argv):
    if not argv or len(argv) > 2:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    if argv[0] in ("--sombras", "-s"):
        return _sombras(argv[1] if len(argv) == 2 else None)

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
