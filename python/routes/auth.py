import base64
import json
import logging
import os
import re
import secrets
from pathlib import Path
from urllib.parse import urlparse

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from flask import Blueprint, jsonify, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

auth_bp = Blueprint("auth", __name__)

_BASE_DIR     = Path(__file__).resolve().parent.parent.parent
_AUTH_FILE    = _BASE_DIR / "data" / "auth.dat"
_ENV_FILE     = _BASE_DIR / ".env"
_DEFAULT_HASH = generate_password_hash(secrets.token_hex(32), method="pbkdf2:sha256:600000")

logger = logging.getLogger(__name__)


# ── Cifrado ───────────────────────────────────────────────────────────────────

def _get_fernet() -> Fernet | None:
    """Devuelve una instancia Fernet derivada de SECRET_KEY, o None si no hay clave."""
    secret = os.environ.get("SECRET_KEY", "").strip().encode()
    if not secret:
        return None
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=b"portfolio-auth-v1",
        iterations=200_000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(secret))
    return Fernet(key)


# ── Persistencia ──────────────────────────────────────────────────────────────

def _load_credentials() -> tuple[str, str]:
    """Devuelve (username, password_hash). Orden: auth.json (cifrado) > env vars > admin/admin."""
    if _AUTH_FILE.exists():
        try:
            raw = _AUTH_FILE.read_bytes()
            fernet = _get_fernet()
            if fernet:
                try:
                    raw = fernet.decrypt(raw)
                except InvalidToken:
                    # Fichero en texto plano (migración desde versión anterior)
                    pass
            data = json.loads(raw)
            u = str(data.get("username", "")).strip()
            h = str(data.get("password_hash", "")).strip()
            if u and h:
                # Migración automática: si se leyó en plano y hay clave, re-guardar cifrado
                if fernet:
                    try:
                        fernet.decrypt(_AUTH_FILE.read_bytes())
                    except InvalidToken:
                        _save_credentials(u, h)
                        logger.info("auth.json migrado a formato cifrado")
                return u, h
        except Exception:
            pass

    # Env vars (Docker / .env)
    u = os.environ.get("LOGIN_USERNAME", "").strip()
    h = os.environ.get("LOGIN_PASSWORD_HASH", "").strip()
    if u and h:
        _save_credentials(u, h)
        return u, h

    logger.critical(
        "No hay credenciales configuradas. Define LOGIN_USERNAME y LOGIN_PASSWORD_HASH "
        "en el archivo .env, o usa el setup inicial. No se permitirá el acceso."
    )
    return "__no_user__", _DEFAULT_HASH


def _save_credentials(username: str, password_hash: str) -> None:
    payload = json.dumps({"username": username, "password_hash": password_hash}).encode()
    fernet = _get_fernet()
    _AUTH_FILE.parent.mkdir(parents=True, exist_ok=True)
    if fernet:
        _AUTH_FILE.write_bytes(fernet.encrypt(payload))
    else:
        _AUTH_FILE.write_bytes(payload)


def _update_env_key(key: str, value: str) -> None:
    """Actualiza o inserta una clave en .env (solo para SECRET_KEY)."""
    if not _ENV_FILE.exists():
        return
    content = _ENV_FILE.read_text("utf-8")
    pattern = re.compile(rf"^{re.escape(key)}\s*=.*$", re.MULTILINE)
    new_line = f"{key}={value}"
    if pattern.search(content):
        content = pattern.sub(new_line, content)
    else:
        content = content.rstrip("\n") + f"\n{new_line}\n"
    _ENV_FILE.write_text(content, "utf-8")


# ── Rutas ─────────────────────────────────────────────────────────────────────

_LOGIN_HTML = _BASE_DIR / "html" / "login.html"


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    error = None
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        expected_user, password_hash = _load_credentials()

        if username == expected_user and check_password_hash(password_hash, password):
            session["logged_in"] = True
            session.permanent = False
            next_url = request.args.get("next") or "/"
            parsed = urlparse(next_url)
            if parsed.scheme or parsed.netloc:
                next_url = "/"
            return redirect(next_url)

        error = "Usuario o contraseña incorrectos"

    html = _LOGIN_HTML.read_text("utf-8")
    html = html.replace(
        "<!-- ERROR_PLACEHOLDER -->",
        f'<p class="loginError">{error}</p>' if error else "",
    )
    return html


@auth_bp.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


@auth_bp.route("/api/settings/credentials/username", methods=["POST"])
def change_username():
    data = request.get_json(silent=True) or {}
    current_password = data.get("currentPassword", "")
    new_username     = data.get("newUsername", "").strip()

    if not new_username:
        return jsonify({"ok": False, "error": "El nuevo usuario no puede estar vacío"}), 400

    current_user, password_hash = _load_credentials()
    if not check_password_hash(password_hash, current_password):
        return jsonify({"ok": False, "error": "Contraseña actual incorrecta"}), 400

    _save_credentials(new_username, password_hash)
    return jsonify({"ok": True})


@auth_bp.route("/api/settings/credentials/password", methods=["POST"])
def change_password():
    data = request.get_json(silent=True) or {}
    current_password = data.get("currentPassword", "")
    new_password     = data.get("newPassword", "")

    if not new_password:
        return jsonify({"ok": False, "error": "La nueva contraseña no puede estar vacía"}), 400

    current_user, password_hash = _load_credentials()
    if not check_password_hash(password_hash, current_password):
        return jsonify({"ok": False, "error": "Contraseña actual incorrecta"}), 400

    new_hash = generate_password_hash(new_password, method="pbkdf2:sha256:600000")
    _save_credentials(current_user, new_hash)
    return jsonify({"ok": True})
