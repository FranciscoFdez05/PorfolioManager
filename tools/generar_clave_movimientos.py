"""Genera y guarda la clave de firma del Atajo de iOS.

Herramienta de un solo uso, fuera del código que sirve la aplicación:

    python tools/generar_clave_movimientos.py

Escribe la clave en el fichero que indique [atajo] fichero_clave en config.ini
(por defecto API/movimientos.key). Ese directorio está en .gitignore y el
contenido se cifra en reposo con SECRET_KEY, igual que las claves de los
proveedores de cotizaciones, así que la clave nunca llega al repositorio.

Reinicia el servidor después: la clave se lee al verificar cada petición, pero
si el fichero estaba cifrado con otra SECRET_KEY no se podrá descifrar.

Volver a ejecutarlo genera una clave nueva e invalida las firmas anteriores,
que es justo lo que hay que hacer si sospechas que se ha filtrado. Por eso pide
confirmación si el fichero ya existe.
"""

import sys
from pathlib import Path

# El código vive en python/ y se importa de forma plana, igual que en gunicorn.
_PYTHON_DIR = Path(__file__).resolve().parent.parent / "python"
if str(_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(_PYTHON_DIR))

from dotenv import load_dotenv  # noqa: E402

from core.firma_hmac import escribirClaveNueva, rutaFicheroClave  # noqa: E402
from core.paths import BASE_DIR  # noqa: E402


def main():
    # SECRET_KEY sale de .env y es lo que cifra el fichero en reposo.
    load_dotenv(BASE_DIR / ".env")

    ruta = rutaFicheroClave()

    if ruta.exists():
        print(f"{ruta} ya existe.")
        print("Sobrescribirlo invalida las firmas anteriores, pero no obliga a")
        print("reconfigurar el Atajo: no guarda la clave, la pide a /api/firmar.")
        respuesta = input("¿Generar una clave nueva? [s/N]: ").strip().lower()
        if respuesta not in ("s", "si", "sí", "y", "yes"):
            print("Cancelado. No se ha modificado nada.")
            return 1

    escribirClaveNueva(ruta)

    print(f"Clave escrita en {ruta}")
    print()
    print("Lo mismo se puede hacer desde Ajustes > API, sin entrar por SSH.")
    print()
    print("Siguiente paso:")
    print("  - Reinicia el servidor para que la lea.")
    print("  - Revisa [atajo] redes_permitidas en config.ini y ajusta el rango")
    print("    de WireGuard al Address de tu interfaz wg0.")
    print()
    print("La ruta del fichero se configura en [atajo] fichero_clave (config.ini).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
