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


def _updateEnv(key: str, value: str):
    if not ENV_FILE.exists():
        return
    content = ENV_FILE.read_text("utf-8")
    pattern = re.compile(rf"^{re.escape(key)}\s*=.*$", re.MULTILINE)
    newLine = f"{key}={value}"
    if pattern.search(content):
        content = pattern.sub(newLine, content)
    else:
        content = content.rstrip("\n") + f"\n{newLine}\n"
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

    passwordHash = generate_password_hash(pwd, method=settings.metodoHashPassword())
    secretKey    = secrets.token_hex(32)

    AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(
        json.dumps({"username": username, "password_hash": passwordHash}, indent=2),
        encoding="utf-8",
    )

    _updateEnv("SECRET_KEY", secretKey)

    print(f"\nListo. Credenciales guardadas en {AUTH_FILE}")
    print(f"  Usuario : {username}")
    print(f"  Hash    : {passwordHash[:40]}…")
    print("\nReinicia el servidor para aplicar los cambios.")


if __name__ == "__main__":
    main()
