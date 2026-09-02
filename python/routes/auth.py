import base64
import hmac
import json
import logging
import os
import re
import secrets
import threading
import time

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from flask import Blueprint, jsonify, make_response, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from core import settings
from core.paths import AUTH_FILE as _AUTH_FILE, LOGIN_HTML

auth_bp = Blueprint("auth", __name__)

_DEFAULT_HASH = generate_password_hash(secrets.token_hex(32), method=settings.metodoHashPassword())

logger = logging.getLogger(__name__)

# ── Límite de intentos de login ───────────────────────────────────────────────
# No había ninguno: se podía probar contraseñas de forma ilimitada contra
# /login. El número de intentos y la duración del bloqueo salen de [seguridad]
# en config.ini: endurecerlos no debería obligar a tocar código.
#
# El contador vive en memoria del proceso, igual que el de core/rate_limit.py y
# por el mismo motivo (no meter Redis en un despliegue que es un contenedor y un
# fichero SQLite). La consecuencia hay que tenerla presente al elegir el número:
# gunicorn corre con varios workers y cada uno lleva su cuenta, así que los
# intentos que de verdad hacen falta para bloquear una IP son los configurados
# multiplicados por el número de workers. La primera barrera del despliegue es
# que solo se llega desde la LAN o por WireGuard.
_attempts: dict[str, list] = {}   # ip -> [nº fallos, instante del último fallo]
_attempts_lock = threading.Lock()


def _client_ip() -> str:
    return request.remote_addr or "desconocida"


def _seconds_locked_out(ip: str) -> int:
    """Segundos que quedan de bloqueo para esta IP, 0 si puede intentarlo."""
    lockout = settings.bloqueoSegundos()
    with _attempts_lock:
        entry = _attempts.get(ip)
        if not entry or entry[0] < settings.maxIntentosLogin():
            return 0
        elapsed = time.monotonic() - entry[1]
        if elapsed >= lockout:
            _attempts.pop(ip, None)
            return 0
        return int(lockout - elapsed)


def _record_failure(ip: str) -> None:
    lockout = settings.bloqueoSegundos()
    with _attempts_lock:
        entry = _attempts.get(ip)
        if entry and time.monotonic() - entry[1] < lockout:
            entry[0] += 1
            entry[1] = time.monotonic()
        else:
            _attempts[ip] = [1, time.monotonic()]
        # Evitar que el diccionario crezca sin límite con IPs falsificadas
        if len(_attempts) > settings.maxIpsVigiladas():
            cutoff = time.monotonic() - lockout
            for stale in [k for k, v in _attempts.items() if v[1] < cutoff]:
                _attempts.pop(stale, None)


def _clear_failures(ip: str) -> None:
    with _attempts_lock:
        _attempts.pop(ip, None)


# Solo se admite como destino tras el login una ruta relativa de este host.
# Lista blanca en vez de lista negra: comprobar scheme/netloc dejaba pasar
# "/\evil.com", que los navegadores normalizan a "//evil.com" porque tratan la
# barra invertida como separador en URLs http(s). El carácter "\" no está en el
# conjunto permitido.
_SAFE_NEXT_RE = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$")


def _safe_next_url(next_url: str) -> str:
    """Devuelve next_url si es una ruta interna segura, o '/' en caso contrario."""
    if not next_url or not _SAFE_NEXT_RE.match(next_url):
        return "/"
    # "//host" y "/\host" son referencias protocol-relative: destino externo.
    if next_url.startswith("//"):
        return "/"
    return next_url


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


# ── Rutas ─────────────────────────────────────────────────────────────────────


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    # Con la sesión ya iniciada no hay nada que pedir: al volver atrás desde la
    # aplicación el navegador vuelve a solicitar /login (la respuesta se marca
    # como no almacenable, ver más abajo) y aquí se devuelve a la app.
    if session.get("logged_in"):
        return redirect(_safe_next_url(request.args.get("next") or "/"))

    error = None
    if request.method == "POST":
        ip = _client_ip()
        locked = _seconds_locked_out(ip)
        if locked:
            logger.warning("Login bloqueado por exceso de intentos desde %s", ip)
            error = f"Demasiados intentos fallidos. Vuelve a intentarlo en {locked // 60 + 1} min."
        else:
            username = request.form.get("username", "").strip()
            password = request.form.get("password", "")
            expected_user, password_hash = _load_credentials()

            # compare_digest evita filtrar por tiempo la longitud del usuario.
            # Se comparan bytes: con str lanza TypeError si el usuario enviado
            # tiene caracteres no ASCII, lo que devolvía un 500 y además saltaba
            # el registro del intento fallido.
            user_ok = hmac.compare_digest(
                username.encode("utf-8"), expected_user.encode("utf-8")
            )
            if user_ok and check_password_hash(password_hash, password):
                _clear_failures(ip)
                session.clear()
                session["logged_in"] = True
                session.permanent = False
                return redirect(_safe_next_url(request.args.get("next") or "/"))

            _record_failure(ip)
            logger.warning("Intento de login fallido desde %s", ip)
            error = "Usuario o contraseña incorrectos"

    html = LOGIN_HTML.read_text("utf-8")
    html = html.replace(
        "<!-- ERROR_PLACEHOLDER -->",
        f'<p class="loginError">{error}</p>' if error else "",
    )
    response = make_response(html)
    # Sin esto el navegador guarda la página en su caché de historial (bfcache) y
    # el botón "atrás" la muestra tal cual, sin preguntar al servidor, aunque la
    # sesión ya esté iniciada. no-store desactiva esa caché: al volver atrás se
    # repite la petición y la comprobación de arriba redirige a la aplicación.
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


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

    _current_user, password_hash = _load_credentials()
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

    new_hash = generate_password_hash(new_password, method=settings.metodoHashPassword())
    _save_credentials(current_user, new_hash)
    return jsonify({"ok": True})
