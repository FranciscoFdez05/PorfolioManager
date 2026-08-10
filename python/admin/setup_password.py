"""
Ejecutar una vez para configurar usuario y contraseña:

    python python/setup_password.py

Escribe las credenciales en data/auth.json y genera SECRET_KEY en .env si existe.
"""
import getpass
import json
import re
import secrets

from werkzeug.security import generate_password_hash

from core import settings
from core.paths import AUTH_FILE, ENV_FILE


def _update_env(key: str, value: str):
    if not ENV_FILE.exists():
        return
    content = ENV_FILE.read_text("utf-8")
    pattern = re.compile(rf"^{re.escape(key)}\s*=.*$", re.MULTILINE)
    new_line = f"{key}={value}"
    if pattern.search(content):
        content = pattern.sub(new_line, content)
    else:
        content = content.rstrip("\n") + f"\n{new_line}\n"
    ENV_FILE.write_text(content, "utf-8")


def main():
    print("=== Configuración de acceso — Portfolio Manager ===\n")

    username = input("Nombre de usuario [admin]: ").strip() or "admin"

    while True:
        pwd = getpass.getpass("Contraseña: ")
        pwd2 = getpass.getpass("Repite la contraseña: ")
        if pwd == pwd2:
            break
        print("Las contraseñas no coinciden, intenta de nuevo.\n")

    password_hash = generate_password_hash(pwd, method=settings.metodoHashPassword())
    secret_key    = secrets.token_hex(32)

    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(
        json.dumps({"username": username, "password_hash": password_hash}, indent=2),
        encoding="utf-8",
    )

    _update_env("SECRET_KEY", secret_key)

    print(f"\nListo. Credenciales guardadas en {AUTH_FILE}")
    print(f"  Usuario : {username}")
    print(f"  Hash    : {password_hash[:40]}…")
    print("\nReinicia el servidor para aplicar los cambios.")


if __name__ == "__main__":
    main()
