"""Capa de seguridad de la aplicación: CSRF, sesión, tope de cuerpo, límite de
escrituras y cabeceras de respuesta.

Vivía suelta en `server.py` como una sucesión de `@app.before_request`. El
problema no era la organización, sino que quedaba **fuera del alcance de los
tests**: importar `server` ejecuta `init_portfolios()` y `ensureDataFile()`, que
escriben sobre los datos reales de quien lance la suite, así que conftest.py
prohíbe importarlo. Resultado: los cinco controles que deciden si una petición
entra o no eran justo lo único que nadie comprobaba.

Recogidos aquí, `instalar(app)` los monta sobre cualquier Flask, y un test puede
construir una app mínima con los blueprints que le interesen y comprobar de
verdad que un POST sin token CSRF recibe 403 o que /api/restore exige sesión.

`aplicar_proxy_inverso(app)` está aquí por el mismo motivo: de qué IP se cree
que viene una petición lo decide todo lo de abajo (el límite por IP, el bloqueo
de login, el filtro de red del Atajo), así que no podía quedarse sin test.

El orden de registro importa y es el que había:

  1. `verify_csrf`      — barato, y rechaza antes de tocar nada.
  2. `enforce_body_limit` — corta los cuerpos enormes antes de leerlos.
  3. `limit_writes`     — cuenta solo lo que va a llegar a la vista.
  4. `require_login`    — el último, para que un 401 no revele si el endpoint
                          existía o si el token era válido.
"""

import logging
import os
import secrets

from flask import abort, g, make_response, redirect, request, session, url_for

from core import csp, settings, tls
from core.rate_limit import LimitadorVentana

log = logging.getLogger(__name__)

# ── Qué queda fuera de la sesión ──────────────────────────────────────────────
# `salud.getHealth` es público porque el healthcheck del contenedor no tiene
# cookies. Su respuesta anónima se limita a estado y versión; el detalle
# (rutas, portfolio activo, uptime) solo sale con la sesión abierta.
PUBLIC_ENDPOINTS = {"auth.login", "auth.setup", "auth.logout", "salud.getHealth"}
# Endpoints del Atajo de iOS. No pueden usar la sesión ni el token CSRF (un
# Atajo no mantiene cookies), así que quedan fuera de require_login y de
# verify_csrf y se autentican por su cuenta: filtro de IP en core/red_local.py
# más firma HMAC en core/firma_hmac.py, ambos aplicados dentro de cada vista.
# Se mantienen aparte de PUBLIC_ENDPOINTS para que quede explícito que estas
# rutas no son públicas, solo se protegen de otra forma.
ATAJO_ENDPOINTS = {
    "movimientos.createMovimiento",
    "movimientos.getCategorias",
    "movimientos.getPortfoliosLista",
    "movimientos.prepararMovimiento",
    "movimientos.firmarTexto",
}
# Extensiones que la página de login necesita antes de autenticarse. Solo se
# aceptan bajo los directorios de PUBLIC_DIRS: cualquier otra ruta con estas
# extensiones sigue exigiendo sesión.
PUBLIC_EXTENSIONS = {".css", ".js", ".ico", ".png", ".jpg", ".jpeg", ".svg",
                     ".woff", ".woff2", ".ttf"}
PUBLIC_DIRS = ("css/", "js/", "img/")
PUBLIC_FILES = {"favicon.ico"}

# Endpoints de importación y restauración: necesitan cuerpos mucho mayores que
# el resto (un export JSON completo ronda los 25 MB).
UPLOAD_PATHS = ("/api/import/json", "/api/import/zip", "/api/portfolios/import")

# Rutas que copian bases de datos enteras. Tienen su propio cubo, mucho más
# estrecho que el general: cada una abre conexiones SQLite, vuelca el WAL y
# escribe ficheros de decenas de MB.
RUTAS_PESADAS = ("/api/backup", "/api/restore", "/api/import/", "/api/portfolios/import")

# ── CSRF (double-submit cookie) ───────────────────────────────────────────────
# SESSION_COOKIE_SAMESITE=Lax ya bloquea los POST cross-site en navegadores
# actuales, pero no cubre navegadores antiguos ni peticiones same-site desde
# subdominios, y no es una defensa que se pueda auditar. El token se guarda en
# la sesión (firmada) y se replica en una cookie legible por JS, que el wrapper
# de js/csrf.js reenvía en la cabecera X-CSRF-Token.
CSRF_COOKIE = "csrf_token"
CSRF_HEADER = "X-CSRF-Token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


def token_csrf_actual() -> str:
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def _ip_cliente() -> str:
    return request.remote_addr or "desconocida"


def _es_asset_publico(path: str) -> bool:
    """CSS/JS/imágenes que la página de login necesita antes de autenticarse."""
    normalizado = path.lstrip("/").replace("\\", "/")
    return (
        os.path.splitext(normalizado)[1].lower() in PUBLIC_EXTENSIONS
        and (normalizado.startswith(PUBLIC_DIRS) or normalizado in PUBLIC_FILES)
        and ".." not in normalizado.split("/")
    )


def instalar(app, *, limite_escrituras=None, limite_pesadas=None):
    """Registra los controles sobre `app` y devuelve los dos limitadores.

    Se devuelven para que los tests puedan reiniciarlos entre casos: son estado
    en memoria del proceso y, sin eso, el primer test que agota el cubo dejaría
    fallando a todos los siguientes.
    """
    if limite_escrituras is None:
        limite_escrituras = LimitadorVentana(
            settings.escriturasPorMinuto, ventana_segundos=60,
            max_clientes=settings.maxIpsVigiladas,
        )
    if limite_pesadas is None:
        limite_pesadas = LimitadorVentana(
            settings.escriturasPesadasPorHora, ventana_segundos=3600,
            max_clientes=settings.maxIpsVigiladas,
        )

    @app.before_request
    def verify_csrf():
        if request.method in SAFE_METHODS:
            return
        # El login es la única entrada sin sesión previa; lo protege el propio
        # formulario junto al límite de intentos por IP.
        if request.endpoint in PUBLIC_ENDPOINTS or request.endpoint in ATAJO_ENDPOINTS:
            return
        if not session.get("logged_in"):
            # Sin sesión no hay nada que proteger; require_login responde 401.
            return
        # Fail-closed: una sesión autenticada sin token (por ejemplo emitida por
        # una versión anterior a este control) no se puede validar, así que se
        # rechaza en vez de dejar pasar la petición. Cualquier GET posterior
        # vuelve a emitir el token en set_csrf_cookie, de modo que la sesión se
        # recupera sola.
        esperado = session.get("csrf_token")
        recibido = request.headers.get(CSRF_HEADER, "") or request.form.get("csrf_token", "")
        if not esperado or not recibido or not secrets.compare_digest(recibido, esperado):
            log.warning("Petición %s %s rechazada por CSRF inválido", request.method, request.path)
            abort(403)

    @app.before_request
    def enforce_body_limit():
        """Aplica el tope estricto a todo salvo a los endpoints de subida.

        MAX_CONTENT_LENGTH es global en Werkzeug 3.0 (no es escribible por
        petición), así que se fija al máximo de subida y aquí se restringe el
        resto.
        """
        if request.path in UPLOAD_PATHS:
            return
        longitud = request.content_length
        if longitud is not None and longitud > settings.maxCuerpoBytes():
            abort(413)

    @app.before_request
    def limit_writes():
        if request.method in SAFE_METHODS:
            return
        # El login lo frena _seconds_locked_out(), que además distingue entre
        # intentos fallidos y correctos; contarlo dos veces solo daría 429 donde
        # ya hay un mensaje de bloqueo escrito para el usuario.
        if request.endpoint == "auth.login":
            return

        ip = _ip_cliente()
        espera = limite_escrituras.consumir(ip)
        if not espera and request.path.startswith(RUTAS_PESADAS):
            espera = limite_pesadas.consumir(ip)
        if not espera:
            return

        log.warning("Límite de escrituras alcanzado por %s en %s %s", ip, request.method, request.path)
        respuesta = make_response(
            {"ok": False, "error": "Demasiadas peticiones. Espera unos segundos e inténtalo de nuevo."},
            429,
        )
        respuesta.headers["Retry-After"] = str(espera)
        return respuesta

    @app.before_request
    def require_login():
        if request.endpoint in PUBLIC_ENDPOINTS or request.endpoint in ATAJO_ENDPOINTS:
            return
        if _es_asset_publico(request.path):
            return
        if not session.get("logged_in"):
            if request.path.startswith("/api/") or request.is_json:
                abort(401)
            return redirect(url_for("auth.login", next=request.path))

    @app.after_request
    def set_csrf_cookie(response):
        if session.get("logged_in"):
            response.set_cookie(
                CSRF_COOKIE,
                token_csrf_actual(),
                httponly=False,          # el JS debe poder leerla para reenviarla
                samesite=app.config["SESSION_COOKIE_SAMESITE"],
                secure=app.config["SESSION_COOKIE_SECURE"],
            )
        return response

    @app.after_request
    def add_security_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "SAMEORIGIN"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # Ninguna pantalla necesita cámara, micrófono ni geolocalización:
        # cerrarlas evita que un script inyectado pueda siquiera pedir permiso.
        response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=(), payment=()"
        if tls.httpsActivo():
            # Sin HSTS, tener HTTPS delante no impide que la primera visita
            # («escribo la dirección en la barra») salga por HTTP y sea
            # interceptable antes de la redirección del proxy. Con la cabecera,
            # el navegador recuerda el dominio y a partir de la segunda visita
            # ni siquiera intenta el HTTP.
            #
            # Solo se emite con https_activado: puesta en una instalación por
            # HTTP dejaría el nombre del host inaccesible durante un año en cada
            # navegador que la hubiera visto, y sin manera de retirarlo desde el
            # servidor.
            #
            # Sin includeSubDomains a propósito: el subdominio de la aplicación
            # no manda sobre lo que haya en los demás del mismo dominio, y
            # apagarles el HTTP a todos desde aquí sería una sorpresa.
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        if settings.cspActivada():
            # El nonce lo fija la vista que sirve index.html; el resto de
            # respuestas no llevan scripts en línea, así que su política queda
            # aún más cerrada.
            response.headers["Content-Security-Policy"] = csp.construir(g.get("csp_nonce", ""))
        return response

    return limite_escrituras, limite_pesadas


def aplicar_proxy_inverso(app) -> int:
    """Instala ProxyFix si hay proxies de confianza declarados. Devuelve cuántos.

    Con Caddy (u otro proxy) delante, la conexión que ve gunicorn sale siempre
    del proxy: sin esto, `request.remote_addr` valdría la IP del contenedor del
    proxy en **todas** las peticiones. Y esa IP es con la que se registran los
    intentos de login, se cuenta el límite de escrituras y se filtra el Atajo de
    iOS, así que el efecto no es solo un log inútil: un único atacante agotaría
    el cubo de escrituras de todo el mundo, y el bloqueo tras N intentos
    fallidos dejaría fuera a cualquiera que llegase por el mismo proxy.

    El número de saltos se declara, no se adivina: ProxyFix toma el elemento
    `saltos`-ésimo por la derecha de X-Forwarded-For. Poner de más deja que el
    cliente prefije la cabecera y elija con qué IP se le cuenta —justo la
    falsificación de la que este ajuste protege—, así que el valor tiene que ser
    exactamente el número de proxies que reescriben la cabecera.

    Con 0 (el defecto, sin proxy) no se instala nada y las X-Forwarded-* se
    ignoran por completo, que es lo correcto: ahí llegan del cliente.
    """
    saltos = settings.proxySaltos()
    if not saltos:
        return 0

    from werkzeug.middleware.proxy_fix import ProxyFix

    app.wsgi_app = ProxyFix(
        app.wsgi_app,
        x_for=saltos,
        # x_proto hace que request.is_secure sepa que la petición original era
        # HTTPS aunque el tramo proxy→aplicación sea HTTP plano.
        x_proto=saltos,
        # x_host/x_port/x_prefix a 0: nada construye URLs absolutas a partir del
        # Host (las redirecciones del login son relativas), así que confiar en
        # X-Forwarded-Host solo añadiría una vía de envenenamiento del host sin
        # ganar nada.
        x_host=0,
        x_port=0,
        x_prefix=0,
    )
    log.info("ProxyFix activo con %d salto(s) de confianza", saltos)
    return saltos


def aplicar_configuracion_sesion(app):
    """Cookies de sesión y topes de cuerpo. Separado de `instalar` porque son
    valores de `app.config`, no manejadores, y algún test quiere lo uno sin lo
    otro.

    Se puede volver a llamar con la aplicación en marcha, y es lo que hace el
    endpoint que activa el HTTPS desde Ajustes: Flask consulta estas claves de
    `app.config` cada vez que emite la cookie, así que reasignarlas cambia la
    política a partir de la respuesta siguiente sin reiniciar el proceso.
    """
    app.config["MAX_CONTENT_LENGTH"] = settings.maxSubidaBytes()
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = settings.cookieSameSite()
    # SESSION_COOKIE_SECURE se activa solo cuando hay HTTPS (evita romper HTTP local).
    # Sale de core.tls y no de settings porque el interruptor está en Ajustes: el
    # ajuste de config.ini es solo el override de despliegue.
    app.config["SESSION_COOKIE_SECURE"] = tls.httpsActivo()
    # REMEMBER_COOKIE_* no lo usa nada hoy: no hay Flask-Login ni "recordarme",
    # el login abre una sesión no permanente. Se fijan igualmente porque el día
    # que se añada, los valores de fábrica de esa extensión son un año de
    # duración, sin Secure y sin SameSite, y el descuido no se vería: la
    # aplicación funcionaría igual, solo que con una cookie de larga vida
    # viajando en claro. Dejarlos escritos aquí hace que herede la misma
    # política que la sesión.
    app.config["REMEMBER_COOKIE_HTTPONLY"] = True
    app.config["REMEMBER_COOKIE_SAMESITE"] = app.config["SESSION_COOKIE_SAMESITE"]
    app.config["REMEMBER_COOKIE_SECURE"] = app.config["SESSION_COOKIE_SECURE"]
