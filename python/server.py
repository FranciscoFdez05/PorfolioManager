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
from flask import Flask, abort, g, make_response, request, send_from_directory

from admin import avisos_scheduler, snapshot_scheduler, telegram_listener
from admin.backup_manager import startScheduler as startBackupScheduler
from admin.portfolios_manager import initPortfolios
from core import atajo_acceso, csp, estaticos, paths, seguridad_app, settings, telegram_notifier, tls
from core.errors import registerErrorHandlers
from core.paths import API_DIR, BASE_DIR, INDEX_FILE
from core.version import __version__, insertarVersion
from routes.activos import activosBp
from routes.actualizacion import actualizacionBp
from routes.ajustes import ajustesBp
from routes.alertas import alertasBp
from routes.atajo import atajoBp
from routes.auth import authBp
from routes.backup import backupBp
from routes.categorias import categoriasBp
from routes.cuenta_ahorro import cuentaAhorroBp
from routes.cuentas import cuentasBp
from routes.gastos import gastosBp
from routes.herramientas import herramientasBp
from routes.ingresos import ingresosBp
from routes.market import marketBp
from routes.market_pulse import marketPulseBp
from routes.movimientos import movimientosBp
from routes.operaciones import operacionesBp
from routes.planes import planesBp
from routes.planes_cartera import planesCarteraBp
from routes.portfolios import portfoliosBp
from routes.registros import registrosBp
from routes.salud import saludBp
from routes.snapshots import snapshotsBp
from routes.tls import tlsBp
from routes.trading import tradingBp
from routes.ventas import ventasBp
from stores.app_data import ensureDataFile

# .env antes que nada: los ajustes admiten override por variable de entorno, y
# esas variables se definen aquí. Cargarlo después haría que los overrides de
# .env no se vieran.
load_dotenv()

# Configurar logging ANTES de initPortfolios(): esa llamada verifica la
# integridad de la BD, puede repararla o restaurarla desde un backup, y todos
# esos mensajes se perdían porque el logging aún no estaba inicializado.
logging.basicConfig(level=settings.nivelLog(), format=settings.formatoLog())

# Deja constancia en el log de con qué configuración arranca el proceso y avisa
# de los valores dudosos (fuera de rango, mal escritos, combinaciones que no
# funcionan). No aborta el arranque: los valores ya vienen acotados.
settings.registrarConfiguracion()

def _comprobarAlmacenamiento():
    """Avisa al arrancar si algún directorio de datos no se puede escribir.

    Es la comprobación que faltaba al pasar de Windows a Docker sobre Linux.
    En Windows el proceso es el dueño de la carpeta del proyecto y cualquier
    ruta relativa funciona; en el contenedor, data/, logs/ y API/ son volúmenes
    montados desde el host, con su propietario y sus permisos, y la aplicación
    corre como otro usuario. Cuando eso no encaja, la web se ve y se navega
    —leer no necesita permiso de escritura— pero **nada se guarda**: ni el
    backup, ni los ajustes, ni las claves de API.

    Se avisa y se sigue: el usuario puede entrar, ver sus datos y arreglar los
    permisos con el mensaje delante, en vez de encontrarse un contenedor que
    reinicia en bucle sin decir por qué.
    """
    informe = paths.diagnosticoAlmacenamiento()
    proceso = paths.descripcionProceso()
    fallos = {n: d for n, d in informe.items() if not d["escribible"]}

    for nombre, detalle in informe.items():
        logging.info("[rutas] %-11s %s", nombre, detalle["ruta"])

    if not fallos:
        return

    quien = f" (proceso uid={proceso['uid']} gid={proceso['gid']})" if proceso else ""
    for nombre, detalle in fallos.items():
        logging.critical(
            "[rutas] NO SE PUEDE ESCRIBIR en %s -> %s: %s%s",
            nombre, detalle["ruta"], detalle["motivo"], quien,
        )
    logging.critical(
        "[rutas] Mientras siga así no se guardará nada (backups, ajustes, claves). "
        "En Docker suele ser el propietario de los volúmenes montados: párate el "
        "stack y ejecuta en el host «sudo chown -R $(id -u):$(id -g) data logs API», "
        "o fija PUID/PGID en .env con tu usuario."
    )


_comprobarAlmacenamiento()

initPortfolios()

# static_folder=None desactiva la ruta estática integrada de Flask. Con
# static_folder="../" + static_url_path="" esa ruta capturaba /<path:...> antes
# que serveStatic (y su endpoint "static" estaba en _PUBLIC_ENDPOINTS), así que
# .env, data/*.db, API/*.key y el código fuente se servían sin autenticación.
# Todo el contenido estático pasa ahora obligatoriamente por serveStatic.
app = Flask(__name__, static_folder=None)

_secretKey = os.environ.get("SECRET_KEY", "").strip()
# La de .env.example es pública: con ella cualquiera firma una cookie de sesión
# válida sin contraseña y descifra auth.dat y API/*.key. docker-setup la
# sustituye, pero copiar el ejemplo a mano arrancaba sin decir nada. Una clave
# corta tampoco: es la que firma la sesión y deriva el cifrado de los secretos.
seguridad_app.rechazarSecretKeyInsegura(_secretKey)
if not _secretKey:
    logging.critical(
        "SECRET_KEY no configurada. Se usará una clave temporal: las sesiones serán "
        "inválidas entre reinicios y entre workers de Gunicorn (cada worker genera su "
        "propia clave, lo que también impide descifrar auth.dat y puede degradar las "
        "credenciales al estado sin acceso). Define SECRET_KEY en .env para producción."
    )
    _secretKey = secrets.token_hex(32)
app.secret_key = _secretKey

# Con un proxy inverso delante (el Caddy del perfil `https`), la conexión que ve
# gunicorn sale siempre del proxy. El detalle está en core/seguridad_app.py,
# junto al resto de la capa de seguridad y al alcance de los tests.
seguridad_app.aplicarProxyInverso(app)

# Límite general (por defecto 5 MB) para no agotar memoria. Los endpoints de
# importación y restauración necesitan más: un export JSON completo del
# portfolio ya ronda los 25 MB, así que con el tope general aplicado a todo era
# imposible reimportar un backup propio (413 Request Entity Too Large). Ambos
# topes salen de [server] en config.ini; los aplica seguridad_app junto al resto
# de la configuración de sesión.
seguridad_app.aplicarConfiguracionSesion(app)

# Antes que los blueprints, para que el request id ya esté disponible en los
# before_request de CSRF y de login (así sus warnings se pueden correlacionar
# con la respuesta que recibió el navegador).
registerErrorHandlers(app)

app.register_blueprint(authBp)
app.register_blueprint(activosBp)
app.register_blueprint(atajoBp)
app.register_blueprint(actualizacionBp)
app.register_blueprint(ajustesBp)
app.register_blueprint(alertasBp)
app.register_blueprint(backupBp)
app.register_blueprint(categoriasBp)
app.register_blueprint(cuentaAhorroBp)
app.register_blueprint(cuentasBp)
app.register_blueprint(gastosBp)
app.register_blueprint(herramientasBp)
app.register_blueprint(ingresosBp)
app.register_blueprint(marketBp)
app.register_blueprint(marketPulseBp)
app.register_blueprint(movimientosBp)
app.register_blueprint(operacionesBp)
app.register_blueprint(planesBp)
app.register_blueprint(planesCarteraBp)
app.register_blueprint(portfoliosBp)
app.register_blueprint(tradingBp)
app.register_blueprint(registrosBp)
app.register_blueprint(saludBp)
app.register_blueprint(snapshotsBp)
app.register_blueprint(tlsBp)
app.register_blueprint(ventasBp)

# CSRF, tope de cuerpo, límite de escrituras, sesión y cabeceras de respuesta.
# El detalle vive en core/seguridad_app.py: aquí ocupaba 130 líneas que ningún
# test podía alcanzar, porque importar este módulo escribe sobre los datos
# reales (initPortfolios/ensureDataFile) y la suite tiene prohibido hacerlo.
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
    g.csp_nonce = csp.generarNonce()
    html = csp.insertarNonce(INDEX_FILE.read_text("utf-8"), g.csp_nonce)
    # La versión se inyecta aquí por lo mismo que el nonce: la plantilla es un
    # fichero estático y este es el único punto por el que pasa antes de salir.
    html = insertarVersion(html)
    # Cada JS/CSS propio con un ?v= sacado del propio fichero: la URL vigente
    # se cachea como inmutable en serveStatic (ver core/estaticos.py).
    html = estaticos.versionarReferencias(html)
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
    elif ext in (".js", ".css") and estaticos.esVersionVigente(normalized, request.args.get("v")):
        # Pedido con la versión que tiene ahora el fichero (la que pone
        # serveIndex): ese contenido no cambia nunca bajo esa URL. Si el
        # fichero cambia, el index.html siguiente pide otra.
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    elif ext in (".js", ".css"):
        # Código propio: no-cache (no "no-store"). send_from_directory ya manda
        # ETag/Last-Modified basados en el fichero real, así que el navegador
        # revalida en cada carga en vez de fiarse de un TTL; si el fichero no
        # cambió, la respuesta es un 304 sin cuerpo. Mismo nivel de seguridad
        # que no-store frente a servir una versión vieja, pero sin repetir la
        # descarga completa de los ~35 scripts y ~20 hojas de estilo cuando no
        # ha cambiado nada. No depende de acordarse de subir ningún `?v=` a
        # mano: la revalidación la decide el propio fichero en disco.
        response.headers["Cache-Control"] = "no-cache"
    return response


def _encryptApiKeysAtRest():
    """Cifra los API/*.key que sigan en texto plano de instalaciones previas.

    Se recorre el directorio en vez de una lista fija de nombres: así un
    proveedor nuevo queda cubierto sin tener que acordarse de añadirlo aquí, que
    es justo el descuido que dejaría una clave sin cifrar.
    """
    from core.secret_store import migratePlaintextIfNeeded

    if not API_DIR.is_dir():
        return

    for path in sorted(API_DIR.glob("*.key")):
        try:
            migratePlaintextIfNeeded(path)
        except Exception as e:
            logging.warning("No se pudo cifrar %s: %s", path.name, e)


# Inicialización al arrancar, tanto con Gunicorn como con el servidor de desarrollo
ensureDataFile()
_encryptApiKeysAtRest()
# Las copias automáticas se comprueban ya al iniciar portfolios y luego cada
# hora. Así cambiar la frecuencia en Ajustes no exige reiniciar el servidor.
startBackupScheduler()
# El histórico de evolución lo programaba un setInterval del navegador, así que
# solo existía mientras hubiera una pestaña abierta. Este hilo lo guarda desde
# el servidor; con varios workers, el primero que reclama el hueco lo escribe.
snapshot_scheduler.iniciar()
# Escucha el /start del bot de Telegram: sin ese intercambio previo, Telegram
# no deja que el bot le escriba primero a nadie. El hilo se queda dormido solo
# comprobando cada rato si ya hay un bot configurado en Ajustes.
telegram_listener.iniciar()
# Alertas de precio, resumen diario, versión nueva y disco: lo que el servidor
# vigila por su cuenta y cuenta por Telegram (ver admin/avisos_scheduler.py).
avisos_scheduler.iniciar()
# Los dos workers llegan aquí; el aviso de arranque lo manda solo el primero.
telegram_notifier.notificarArranque(__version__)

# Reaplica en el proxy el estado de HTTPS guardado desde Ajustes. Va al final
# porque no condiciona nada de lo anterior, y no aborta si el proxy no responde:
# la aplicación tiene que poder arrancar para que haya una interfaz desde la que
# arreglarlo. El detalle, en core/tls.py.
tls.converger()

_avisoTls = tls.avisoSinHttps()
if _avisoTls:
    logging.warning("[tls] %s", _avisoTls)

# Igual que el de arriba: no es una configuración mal puesta, es una decisión
# tomada desde la interfaz. Pero desde fuera no se distingue de un servidor que
# sí comprueba quién escribe, así que tiene que quedar escrito al arrancar.
_avisoFirma = atajo_acceso.avisoSinFirma()
if _avisoFirma:
    logging.warning("[atajo] %s", _avisoFirma)

if __name__ == "__main__":
    # Servidor de desarrollo. En Docker manda gunicorn (ver entrypoint.sh), que
    # lee los mismos valores de config.ini.
    logging.info("HTTP — %s:%s", settings.host(), settings.puerto())
    # El servidor de desarrollo anunciaba «Werkzeug/x.y Python/x.y» en cada
    # respuesta. En Docker contesta gunicorn tras Caddy y no dan versiones.
    from werkzeug.serving import WSGIRequestHandler

    WSGIRequestHandler.server_version = "PorfolioManager"
    WSGIRequestHandler.sys_version = ""
    app.run(host=settings.host(), port=settings.puerto(), debug=settings.modoDebug())
