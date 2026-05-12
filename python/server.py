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

from app_data import baseDir, ensureDataFile
from portfolios_manager import init_portfolios
from routes.activos import activos_bp
from routes.ajustes import ajustes_bp
from routes.auth import auth_bp
from routes.backup import backup_bp
from routes.gastos import gastos_bp
from routes.ingresos import ingresos_bp
from routes.market import market_bp
from routes.operaciones import operaciones_bp
from routes.portfolios import portfolios_bp
from routes.registros import registros_bp
from routes.ventas import ventas_bp

load_dotenv()
init_portfolios()

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s"
)

app = Flask(
    __name__,
    static_folder="../",
    static_url_path=""
)

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

# Limitar el tamaño de los cuerpos de petición a 5 MB para evitar agotamiento de memoria
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# SESSION_COOKIE_SECURE se activa solo cuando hay HTTPS (evita romper HTTP local)
app.config["SESSION_COOKIE_SECURE"] = os.environ.get("HTTPS_ENABLED", "false").lower() == "true"

app.register_blueprint(auth_bp)
app.register_blueprint(activos_bp)
app.register_blueprint(ajustes_bp)
app.register_blueprint(backup_bp)
app.register_blueprint(gastos_bp)
app.register_blueprint(ingresos_bp)
app.register_blueprint(market_bp)
app.register_blueprint(operaciones_bp)
app.register_blueprint(portfolios_bp)
app.register_blueprint(registros_bp)
app.register_blueprint(ventas_bp)

_PUBLIC_ENDPOINTS = {"auth.login", "auth.setup", "auth.logout", "static"}
_PUBLIC_EXTENSIONS = {".css", ".js", ".ico", ".png", ".jpg", ".jpeg", ".svg",
                      ".woff", ".woff2", ".ttf"}


@app.before_request
def require_login():
    if request.endpoint in _PUBLIC_ENDPOINTS:
        return
    # Archivos estáticos (CSS/JS/imágenes/fuentes) no exponen datos sensibles
    if os.path.splitext(request.path)[1].lower() in _PUBLIC_EXTENSIONS:
        return
    if not session.get("logged_in"):
        if request.path.startswith("/api/") or request.is_json:
            abort(401)
        return redirect(url_for("auth.login", next=request.path))


# Directorios y ficheros que nunca deben ser accesibles desde el navegador
_BLOCKED_PREFIXES = ("python/", "data/", "API/", ".env", ".git/", "__pycache__/")
_ALLOWED_EXTENSIONS = {".html", ".css", ".js", ".ico", ".png", ".jpg", ".jpeg", ".svg", ".woff", ".woff2", ".ttf"}


@app.after_request
def add_security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "SAMEORIGIN"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


@app.route("/")
def serveIndex():
    response = send_from_directory(baseDir, "index.html")
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/<path:path>")
def serveStatic(path):
    normalized = path.replace("\\", "/").lstrip("/")

    # Bloquear rutas que apunten a directorios sensibles o suban con ".."
    if ".." in normalized.split("/"):
        abort(404)

    for prefix in _BLOCKED_PREFIXES:
        if normalized.lower().startswith(prefix):
            abort(404)

    # Solo servir extensiones de ficheros estáticos conocidas
    ext = os.path.splitext(normalized)[1].lower()
    if ext and ext not in _ALLOWED_EXTENSIONS:
        abort(404)

    return send_from_directory(baseDir, normalized)


def _check_auto_backup():
    import json
    import re
    import sqlite3
    from datetime import datetime, timedelta

    ajustes_path = baseDir / "data" / "JSON" / "ajustes.json"
    days = 0
    try:
        if ajustes_path.exists():
            cfg = json.loads(ajustes_path.read_text("utf-8"))
            days = int(cfg.get("autoBackupDays") or 0)
    except Exception:
        return
    if days <= 0:
        return

    db_path = baseDir / "data" / "portfolio.db"
    if not db_path.exists():
        return

    backups_dir = baseDir / "data" / "backups"
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

    try:
        backups_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
        dst_path = backups_dir / f"portfolio_{ts}.db"
        src = sqlite3.connect(str(db_path))
        dst = sqlite3.connect(str(dst_path))
        src.backup(dst)
        dst.close()
        src.close()
        logging.info("Auto-backup creado: %s", dst_path.name)
    except Exception as e:
        logging.warning("Auto-backup fallido: %s", e)


# Inicialización al arrancar, tanto con Gunicorn como con el servidor de desarrollo
ensureDataFile()
_check_auto_backup()

if __name__ == "__main__":
    debug_mode = os.environ.get("FLASK_DEBUG", "false").lower() == "true"
    logging.info("HTTP — puerto 5000")
    app.run(host="0.0.0.0", port=5000, debug=debug_mode)
