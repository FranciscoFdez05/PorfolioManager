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
from flask import Flask, abort, g, make_response, send_from_directory

from admin import snapshot_scheduler
from admin.portfolios_manager import init_portfolios
from core import csp, seguridad_app, settings
from core.errors import register_error_handlers
from core.paths import AJUSTES_JSON, API_DIR, BACKUPS_DIR, BASE_DIR, INDEX_FILE
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
from routes.planes import planes_bp
from routes.portfolios import portfolios_bp
from routes.registros import registros_bp
from routes.salud import salud_bp
from routes.snapshots import snapshots_bp
from routes.trading import trading_bp
from routes.ventas import ventas_bp
from stores.app_data import ensureDataFile

# .env antes que nada: los ajustes admiten override por variable de entorno, y
# esas variables se definen aquí. Cargarlo después haría que los overrides de
# .env no se vieran.
load_dotenv()

# Configurar logging ANTES de init_portfolios(): esa llamada verifica la
# integridad de la BD, puede repararla o restaurarla desde un backup, y todos
# esos mensajes se perdían porque el logging aún no estaba inicializado.
logging.basicConfig(level=settings.nivelLog(), format=settings.formatoLog())

# Deja constancia en el log de con qué configuración arranca el proceso y avisa
# de los valores dudosos (fuera de rango, mal escritos, combinaciones que no
# funcionan). No aborta el arranque: los valores ya vienen acotados.
settings.registrarConfiguracion()

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

# Límite general (por defecto 5 MB) para no agotar memoria. Los endpoints de
# importación y restauración necesitan más: un export JSON completo del
# portfolio ya ronda los 25 MB, así que con el tope general aplicado a todo era
# imposible reimportar un backup propio (413 Request Entity Too Large). Ambos
# topes salen de [server] en config.ini; los aplica seguridad_app junto al resto
# de la configuración de sesión.
seguridad_app.aplicar_configuracion_sesion(app)

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
app.register_blueprint(planes_bp)
app.register_blueprint(portfolios_bp)
app.register_blueprint(trading_bp)
app.register_blueprint(registros_bp)
app.register_blueprint(salud_bp)
app.register_blueprint(snapshots_bp)
app.register_blueprint(ventas_bp)

# CSRF, tope de cuerpo, límite de escrituras, sesión y cabeceras de respuesta.
# El detalle vive en core/seguridad_app.py: aquí ocupaba 130 líneas que ningún
# test podía alcanzar, porque importar este módulo escribe sobre los datos
# reales (init_portfolios/ensureDataFile) y la suite tiene prohibido hacerlo.
seguridad_app.instalar(app)


# Directorios y ficheros que nunca deben ser accesibles desde el navegador
_BLOCKED_PREFIXES = ("python/", "data/", "api/", ".env", ".git/", "__pycache__/",
                     "logs/", ".venv/", "venv/", "node_modules/")
_ALLOWED_EXTENSIONS = {".html", ".css", ".js", ".ico", ".png", ".jpg", ".jpeg", ".svg", ".woff", ".woff2", ".ttf"}


@app.route("/")
def serveIndex():
    # index.html se sirve leído y no con send_from_directory porque hay que
    # sustituir el marcador del nonce de CSP por el de esta petición. El
    # fichero ya se enviaba con Cache-Control: no-store, así que releerlo no
    # cambia el número de lecturas de disco.
    g.csp_nonce = csp.generar_nonce()
    html = csp.insertar_nonce(INDEX_FILE.read_text("utf-8"), g.csp_nonce)
    response = make_response(html)
    response.headers["Content-Type"] = "text/html; charset=utf-8"
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
    if normalized.startswith("js/vendor/"):
        # Librerías de terceros: el contenido de una versión no cambia nunca, y
        # la URL lleva la versión en el `?v=`. Cachearlas un año evita volver a
        # bajar los 200 KB de Chart.js en cada carga de la página, que es lo
        # que pasaba cuando todo js/ se servía con no-store.
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif ext in (".js", ".css"):
        # Código propio: no-store. Antes las etiquetas llevaban además un `?v=`
        # a mano que había que acordarse de subir en cada cambio; con no-store
        # no aportaba nada y solo podía olvidarse, así que se quitaron.
        response.headers["Cache-Control"] = "no-store"
    return response


def _check_auto_backup():
    import json
    import re
    import sqlite3
    from datetime import datetime, timedelta

    ajustes_path = AJUSTES_JSON
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
        src = sqlite3.connect(str(db_path), timeout=settings.dbTimeout())
        dst = sqlite3.connect(str(tmp_path), timeout=settings.dbTimeout())
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
    """Cifra los API/*.key que sigan en texto plano de instalaciones previas.

    Se recorre el directorio en vez de una lista fija de nombres: así un
    proveedor nuevo queda cubierto sin tener que acordarse de añadirlo aquí, que
    es justo el descuido que dejaría una clave sin cifrar.
    """
    from core.secret_store import migrate_plaintext_if_needed

    if not API_DIR.is_dir():
        return

    for path in sorted(API_DIR.glob("*.key")):
        try:
            migrate_plaintext_if_needed(path)
        except Exception as e:
            logging.warning("No se pudo cifrar %s: %s", path.name, e)


# Inicialización al arrancar, tanto con Gunicorn como con el servidor de desarrollo
ensureDataFile()
_encrypt_api_keys_at_rest()
_check_auto_backup()
# El histórico de evolución lo programaba un setInterval del navegador, así que
# solo existía mientras hubiera una pestaña abierta. Este hilo lo guarda desde
# el servidor; con varios workers, el primero que reclama el hueco lo escribe.
snapshot_scheduler.iniciar()

if __name__ == "__main__":
    # Servidor de desarrollo. En Docker manda gunicorn (ver entrypoint.sh), que
    # lee los mismos valores de config.ini.
    logging.info("HTTP — %s:%s", settings.host(), settings.puerto())
    app.run(host=settings.host(), port=settings.puerto(), debug=settings.modoDebug())
