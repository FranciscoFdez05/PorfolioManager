import configparser
import logging
import mimetypes
import os
import secrets

mimetypes.add_type("text/css", ".css")
mimetypes.add_type("application/javascript", ".js")
mimetypes.add_type("image/svg+xml", ".svg")
mimetypes.add_type("font/woff", ".woff")
mimetypes.add_type("font/woff2", ".woff2")

from dotenv import load_dotenv
from flask import Flask, abort, redirect, request, send_from_directory, session, url_for

from admin.portfolios_manager import init_portfolios
from core.errors import register_error_handlers
from core.paths import API_DIR, BACKUPS_DIR, BASE_DIR, DATA_DIR
from routes.activos import activos_bp
from routes.ajustes import ajustes_bp
from routes.auth import auth_bp
from routes.backup import backup_bp
from routes.categorias import categorias_bp
from routes.gastos import gastos_bp
from routes.ingresos import ingresos_bp
from routes.market import market_bp
from routes.movimientos import movimientos_bp
from routes.operaciones import operaciones_bp
from routes.portfolios import portfolios_bp
from routes.registros import registros_bp
from routes.snapshots import snapshots_bp
from routes.trading import trading_bp
from routes.ventas import ventas_bp
from stores.app_data import ensureDataFile


def _read_runtime_config():
    config = configparser.ConfigParser()
    config.read(BASE_DIR / "config.ini", encoding="utf-8")

    server_section = config["server"] if config.has_section("server") else {}

    def _get_int(name, default):
        value = server_section.get(name, str(default)).strip()
        try:
            return int(value)
        except (TypeError, ValueError):
            return default

    host = server_section.get("host", "0.0.0.0").strip() or "0.0.0.0"
    port = _get_int("port", 5000)
    env_port = os.environ.get("PORT", "").strip()
    if env_port:
        try:
            port = int(env_port)
        except ValueError:
            pass
    debug_mode = server_section.get("debug", "false").strip().lower() in {"1", "true", "yes", "on"}

    return {
        "host": host,
        "port": port,
        "debug": debug_mode,
    }


load_dotenv()
runtime_config = _read_runtime_config()

# Configurar logging ANTES de init_portfolios(): esa llamada verifica la
# integridad de la BD, puede repararla o restaurarla desde un backup, y todos
# esos mensajes se perdían porque el logging aún no estaba inicializado.
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s"
)

init_portfolios()

# static_folder=None desactiva la ruta estática integrada de Flask. Con
# static_folder="../" + static_url_path="" esa ruta capturaba /<path:...> antes
# que serveStatic (y su endpoint "static" estaba en _PUBLIC_ENDPOINTS), así que
# .env, data/*.db, API/*.key y el código fuente se servían sin autenticación.
# Todo el contenido estático pasa ahora obligatoriamente por serveStatic.
app = Flask(__name__, static_folder=None)

_secret_key = os.environ.get("SECRET_KEY", "").strip()
if not _secret_key:
    logging.critical(
        "SECRET_KEY no configurada. Se usará una clave temporal: las sesiones serán "
        "inválidas entre reinicios y entre workers de Gunicorn (cada worker genera su "
        "propia clave, lo que también impide descifrar auth.dat y puede degradar las "
        "credenciales al estado sin acceso). Define SECRET_KEY en .env para producción."
    )
    _secret_key = secrets.token_hex(32)
app.secret_key = _secret_key

# Límite general de 5 MB para no agotar memoria. Los endpoints de importación y
# restauración necesitan más: un export JSON completo del portfolio ya ronda los
# 25 MB, así que con el tope de 5 MB aplicado a todo era imposible reimportar un
# backup propio (413 Request Entity Too Large).
_MAX_BODY_DEFAULT = 5 * 1024 * 1024
_MAX_BODY_UPLOAD = 256 * 1024 * 1024
_UPLOAD_PATHS = ("/api/import/json", "/api/import/zip", "/api/portfolios/import")

app.config["MAX_CONTENT_LENGTH"] = _MAX_BODY_UPLOAD
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# SESSION_COOKIE_SECURE se activa solo cuando hay HTTPS (evita romper HTTP local)
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("HTTPS_ENABLED", "false").lower() == "true"

# Antes que los blueprints, para que el request id ya esté disponible en los
# before_request de CSRF y de login (así sus warnings se pueden correlacionar
# con la respuesta que recibió el navegador).
register_error_handlers(app)

app.register_blueprint(auth_bp)
app.register_blueprint(activos_bp)
app.register_blueprint(ajustes_bp)
app.register_blueprint(backup_bp)
app.register_blueprint(categorias_bp)
app.register_blueprint(gastos_bp)
app.register_blueprint(ingresos_bp)
app.register_blueprint(market_bp)
app.register_blueprint(movimientos_bp)
app.register_blueprint(operaciones_bp)
app.register_blueprint(portfolios_bp)
app.register_blueprint(trading_bp)
app.register_blueprint(registros_bp)
app.register_blueprint(snapshots_bp)
app.register_blueprint(ventas_bp)

_PUBLIC_ENDPOINTS = {"auth.login", "auth.setup", "auth.logout"}
# Endpoints del Atajo de iOS. No pueden usar la sesión ni el token CSRF (un
# Atajo no mantiene cookies), así que quedan fuera de require_login y de
# verify_csrf y se autentican por su cuenta: filtro de IP en core/red_local.py
# más firma HMAC en core/firma_hmac.py, ambos aplicados dentro de cada vista.
# Se mantienen aparte de _PUBLIC_ENDPOINTS para que quede explícito que estas
# rutas no son públicas, solo se protegen de otra forma.
_ATAJO_ENDPOINTS = {
    "movimientos.createMovimiento",
    "movimientos.getCategorias",
    "movimientos.getPortfoliosLista",
    "movimientos.prepararMovimiento",
    "movimientos.firmarTexto",
}
# Extensiones que la página de login necesita antes de autenticarse. Solo se
# aceptan bajo los directorios de _PUBLIC_DIRS: cualquier otra ruta con estas
# extensiones sigue exigiendo sesión.
_PUBLIC_EXTENSIONS = {".css", ".js", ".ico", ".png", ".jpg", ".jpeg", ".svg",
                      ".woff", ".woff2", ".ttf"}
_PUBLIC_DIRS = ("css/", "js/", "img/")
_PUBLIC_FILES = {"favicon.ico"}


# ── CSRF (double-submit cookie) ───────────────────────────────────────────────
# SESSION_COOKIE_SAMESITE=Lax ya bloquea los POST cross-site en navegadores
# actuales, pero no cubre navegadores antiguos ni peticiones same-site desde
# subdominios, y no es una defensa que se pueda auditar. El token se guarda en
# la sesión (firmada) y se replica en una cookie legible por JS, que el wrapper
# de js/csrf.js reenvía en la cabecera X-CSRF-Token.
_CSRF_COOKIE = "csrf_token"
_CSRF_HEADER = "X-CSRF-Token"
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


def _current_csrf_token() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


@app.before_request
def verify_csrf():
    if request.method in _SAFE_METHODS:
        return
    # El login es la única entrada sin sesión previa; lo protege el propio
    # formulario junto al límite de intentos por IP.
    if request.endpoint in _PUBLIC_ENDPOINTS or request.endpoint in _ATAJO_ENDPOINTS:
        return
    if not session.get("logged_in"):
        # Sin sesión no hay nada que proteger; require_login responde 401.
        return
    # Fail-closed: una sesión autenticada sin token (por ejemplo emitida por una
    # versión anterior a este control) no se puede validar, así que se rechaza en
    # vez de dejar pasar la petición. Cualquier GET posterior vuelve a emitir el
    # token en set_csrf_cookie, de modo que la sesión se recupera sola.
    expected = session.get("csrf_token")
    provided = request.headers.get(_CSRF_HEADER, "") or request.form.get("csrf_token", "")
    if not expected or not provided or not secrets.compare_digest(provided, expected):
        logging.warning("Petición %s %s rechazada por CSRF inválido", request.method, request.path)
        abort(403)


@app.after_request
def set_csrf_cookie(response):
    if session.get("logged_in"):
        response.set_cookie(
            _CSRF_COOKIE,
            _current_csrf_token(),
            httponly=False,          # el JS debe poder leerla para reenviarla
            samesite="Lax",
            secure=app.config["SESSION_COOKIE_SECURE"],
        )
    return response


@app.before_request
def enforce_body_limit():
    """Aplica el tope estricto a todo salvo a los endpoints de subida.

    MAX_CONTENT_LENGTH es global en Werkzeug 3.0 (no es escribible por
    petición), así que se fija al máximo de subida y aquí se restringe el resto.
    """
    if request.path in _UPLOAD_PATHS:
        return
    length = request.content_length
    if length is not None and length > _MAX_BODY_DEFAULT:
        abort(413)


@app.before_request
def require_login():
    if request.endpoint in _PUBLIC_ENDPOINTS or request.endpoint in _ATAJO_ENDPOINTS:
        return
    # Assets del login (CSS/JS/imágenes/fuentes), restringidos a sus directorios
    normalized_path = request.path.lstrip("/").replace("\\", "/")
    if (
        os.path.splitext(normalized_path)[1].lower() in _PUBLIC_EXTENSIONS
        and (normalized_path.startswith(_PUBLIC_DIRS) or normalized_path in _PUBLIC_FILES)
        and ".." not in normalized_path.split("/")
    ):
        return
    if not session.get("logged_in"):
        if request.path.startswith("/api/") or request.is_json:
            abort(401)
        return redirect(url_for("auth.login", next=request.path))


# Directorios y ficheros que nunca deben ser accesibles desde el navegador
_BLOCKED_PREFIXES = ("python/", "data/", "api/", ".env", ".git/", "__pycache__/",
                     "logs/", ".venv/", "venv/", "node_modules/")
_ALLOWED_EXTENSIONS = {".html", ".css", ".js", ".ico", ".png", ".jpg", ".jpeg", ".svg", ".woff", ".woff2", ".ttf"}


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


@app.route("/")
def serveIndex():
    response = send_from_directory(BASE_DIR, "index.html")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/<path:path>")
def serveStatic(path):
    normalized = path.replace("\\", "/").lstrip("/")

    # Bloquear rutas que apunten a directorios sensibles o suban con ".."
    segments = normalized.split("/")
    if ".." in segments:
        abort(404)

    # Ningún segmento oculto: bloquea .env, .git, .htpasswd… en cualquier nivel
    if any(segment.startswith(".") for segment in segments):
        abort(404)

    for prefix in _BLOCKED_PREFIXES:
        if normalized.lower().startswith(prefix):
            abort(404)

    # Solo servir extensiones de ficheros estáticos conocidas. Sin extensión
    # tampoco se sirve: evita exponer ficheros como Dockerfile o LICENSE.
    ext = os.path.splitext(normalized)[1].lower()
    if ext not in _ALLOWED_EXTENSIONS:
        abort(404)

    response = send_from_directory(BASE_DIR, normalized)
    if ext in (".js", ".css"):
        response.headers["Cache-Control"] = "no-store"
    return response


def _check_auto_backup():
    import json
    import re
    import sqlite3
    from datetime import datetime, timedelta

    ajustes_path = DATA_DIR / "JSON" / "ajustes.json"
    days = 0
    try:
        if ajustes_path.exists():
            cfg = json.loads(ajustes_path.read_text("utf-8"))
            days = int(cfg.get("autoBackupDays") or 0)
    except Exception:
        return
    if days <= 0:
        return

    # La BD activa, NO data/portfolio.db: ese fichero es el legacy congelado en
    # el momento de la migración a multi-portfolio. Apuntar ahí generaba
    # backups de datos obsoletos que, al restaurarlos, sobrescribían la BD real.
    from core.db import get_active_db_path
    db_path = get_active_db_path()
    if not db_path.exists():
        return

    backups_dir = BACKUPS_DIR
    filename_re = re.compile(r'^portfolio_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.db$')
    if backups_dir.exists():
        candidates = sorted(
            [f for f in backups_dir.iterdir() if filename_re.match(f.name)],
            key=lambda f: f.name,
            reverse=True
        )
        if candidates:
            m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', candidates[0].name)
            if m:
                try:
                    last_dt = datetime.strptime(m.group(1), "%d-%m-%Y_%H-%M-%S")
                    if datetime.now() - last_dt < timedelta(days=days):
                        return
                except ValueError:
                    pass

    src = dst = None
    tmp_path = None
    try:
        backups_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
        dst_path = backups_dir / f"portfolio_{ts}.db"
        # Escribir a temporal y renombrar: si el proceso muere a mitad, no queda
        # un portfolio_*.db truncado que luego se ofrezca como restaurable.
        tmp_path = backups_dir / f"_tmp_portfolio_{ts}.db"
        src = sqlite3.connect(str(db_path), timeout=10)
        dst = sqlite3.connect(str(tmp_path), timeout=10)
        src.backup(dst)
        dst.close()
        dst = None
        src.close()
        src = None
        tmp_path.replace(dst_path)
        logging.info("Auto-backup creado: %s", dst_path.name)
    except Exception as e:
        for conn in (dst, src):
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
        if tmp_path is not None:
            tmp_path.unlink(missing_ok=True)
        logging.warning("Auto-backup fallido: %s", e)


def _encrypt_api_keys_at_rest():
    """Cifra los API/*.key que sigan en texto plano de instalaciones previas."""
    from core.secret_store import migrate_plaintext_if_needed
    for name in ("finnhub.key", "eodhd.key", "alphavantage.key", "twelvedata.key"):
        try:
            migrate_plaintext_if_needed(API_DIR / name)
        except Exception as e:
            logging.warning("No se pudo cifrar %s: %s", name, e)


# Inicialización al arrancar, tanto con Gunicorn como con el servidor de desarrollo
ensureDataFile()
_encrypt_api_keys_at_rest()
_check_auto_backup()

if __name__ == "__main__":
    debug_mode = runtime_config["debug"] or os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    logging.info("HTTP — puerto %s", runtime_config["port"])
    app.run(host=runtime_config["host"], port=runtime_config["port"], debug=debug_mode)
