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

import gzip
import logging
import os
import secrets
from datetime import timedelta

from flask import abort, g, make_response, redirect, request, session, url_for
from flask.sessions import SecureCookieSessionInterface

from core import csp, red_local, sesion, settings, tls
from core.rate_limit import LimitadorVentana

log = logging.getLogger(__name__)

# ── Qué queda fuera de la sesión ──────────────────────────────────────────────
# `salud.getHealth` es público porque el healthcheck del contenedor no tiene
# cookies. Su respuesta anónima se limita a estado y versión; el detalle
# (rutas, portfolio activo, uptime) solo sale con la sesión abierta.
# "auth.setup" estuvo aquí sin que existiera esa vista (el alta inicial es el
# script admin/setup_password.py, no una ruta). Se retira: una entrada que no
# corresponde a ningún endpoint no protege nada hoy, pero deja preparado que el
# día que alguien añada un `setup` al blueprint nazca público sin querer.
# `auth.logout` ya no está: cerrar sesión es un POST que pasa por el CSRF
# como cualquier otra escritura (antes un GET desde otra web bastaba).
PUBLIC_ENDPOINTS = {"auth.login", "salud.getHealth"}
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
    "movimientos.getCuentasLista",
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

# Tipos de respuesta que merece la pena comprimir: texto, que es justo lo que
# manda el HTML/JS/CSS/JSON de la aplicación. Binarios (imágenes, zips de
# backup) ya vienen comprimidos y gzip solo les añadiría trabajo.
_TIPOS_COMPRIMIBLES = {
    "text/html", "text/css", "text/plain", "text/xml",
    "application/javascript", "application/json", "application/xml",
    "image/svg+xml",
}
# Por debajo de esto la cabecera de gzip pesa más que lo que ahorra.
_COMPRESION_MIN_BYTES = 500
# Por encima, mejor no comprimir: `/api/export/json` puede rondar los 25 MB
# (ver ajustes.py) generados ya en memoria como un único str, y bufferizar
# encima la copia comprimida de un caso así, sobre una petición ocasional, no
# compensa frente al coste de CPU y memoria. Los estáticos (JS/CSS, el grueso
# del tráfico repetido) están muy por debajo de este tope.
_COMPRESION_MAX_BYTES = 3 * 1024 * 1024

# ── CSRF (double-submit cookie) ───────────────────────────────────────────────
# SESSION_COOKIE_SAMESITE=Lax ya bloquea los POST cross-site en navegadores
# actuales, pero no cubre navegadores antiguos ni peticiones same-site desde
# subdominios, y no es una defensa que se pueda auditar. El token se guarda en
# la sesión (firmada) y se replica en una cookie legible por JS, que el wrapper
# de js/csrf.js reenvía en la cabecera X-CSRF-Token.
CSRF_COOKIE = "csrf_token"
CSRF_HEADER = "X-CSRF-Token"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}


# ── SECRET_KEY ────────────────────────────────────────────────────────────────
# Los valores de ejemplo que se han publicado en .env.example. Están aquí y no
# se leen de ese fichero porque en Docker no se copia a la imagen.
SECRET_KEYS_DE_EJEMPLO = frozenset({"cambia_esto_por_una_clave_aleatoria_larga"})
SECRET_KEY_MIN_CARACTERES = 32


def rechazar_secret_key_insegura(clave: str) -> None:
    """Aborta el arranque con una SECRET_KEY de ejemplo o demasiado corta.

    Vacía no se rechaza: entonces el servidor genera una temporal y lo avisa en
    el log (sirve para probar). Lo que no puede pasar es arrancar con una clave
    que conoce cualquiera que haya leído el repositorio.
    """
    if not clave:
        return
    if clave in SECRET_KEYS_DE_EJEMPLO or clave.lower().startswith("cambia_esto"):
        raise SystemExit(
            "SECRET_KEY es la de ejemplo de .env.example: con ella cualquiera puede abrir "
            "una sesión sin contraseña. Genera una con: "
            "python -c \"import secrets; print(secrets.token_hex(32))\" y ponla en .env."
        )
    if len(clave) < SECRET_KEY_MIN_CARACTERES:
        raise SystemExit(
            f"SECRET_KEY tiene {len(clave)} caracteres; hacen falta al menos "
            f"{SECRET_KEY_MIN_CARACTERES}. Genera una con: "
            "python -c \"import secrets; print(secrets.token_hex(32))\""
        )


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


def _origenes_de_comprobacion() -> tuple[str, ...]:
    """El puerto donde el panel comprueba si ESTE navegador se fía del certificado.

    Va en `connect-src` porque, si no, la comprobación la bloquea la propia CSP
    y el navegador no dice por qué: parecería que el certificado falla cuando lo
    que ha fallado es la política. Se arma con el host de esta misma petición
    —no se abre a nadie más— y con el puerto que sirve una página fija.
    """
    host = (request.host or "").split(":")[0]
    if not host:
        return ()
    return (f"https://{host}:{tls.PUERTO_PREPARACION}",)


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

        MAX_CONTENT_LENGTH (el de la app) se fija al máximo de subida, y aquí se
        restringe el resto. Mirar solo `Content-Length` no bastaba: con
        `Transfer-Encoding: chunked` no hay cabecera de longitud y un cuerpo de
        12 MB llegaba entero a la vista. Fijar `request.max_content_length`
        (Flask ≥ 3.1) hace que el propio lector corte en el tope, venga como
        venga el cuerpo.
        """
        if request.path in UPLOAD_PATHS:
            return
        tope = settings.maxCuerpoBytes()
        request.max_content_length = tope
        longitud = request.content_length
        if longitud is not None and longitud > tope:
            abort(413)
        if longitud is None and request.method not in SAFE_METHODS:
            # Con chunked, Werkzeug corta en el tope pero en silencio: la vista
            # recibía un JSON truncado y lo trataba como vacío. Se lee aquí (como
            # mucho `tope` bytes, queda en caché para la vista) y, si aún quedaba
            # cuerpo, se responde 413 como con Content-Length.
            request.get_data(cache=True)
            if request.stream.read(1):
                abort(413)
        return None

    @app.before_request
    def limit_writes():
        if request.method in SAFE_METHODS:
            return
        # El login lo frena _seconds_locked_out(), que además distingue entre
        # intentos fallidos y correctos; contarlo dos veces solo daría 429 donde
        # ya hay un mensaje de bloqueo escrito para el usuario.
        if request.endpoint == "auth.login":
            return
        # Sin sesión (y fuera del Atajo, que se autentica por su cuenta) la
        # petición acaba en el 401 de require_login sin tocar nada. Contarla
        # aquí dejaba que cualquiera agotase el cupo de la IP y el usuario
        # legítimo detrás de esa misma IP (NAT, proxy) recibiera 429.
        if not session.get("logged_in") and request.endpoint not in ATAJO_ENDPOINTS:
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
            return _sin_sesion()

        # Que la cookie tenga firma válida solo dice que la emitimos nosotros,
        # no que siga valiendo. Aquí se comprueba lo que la firma no cubre:
        # caducidad, revocación en el logout y cambio de credenciales. El
        # detalle, en core/sesion.py.
        motivo = sesion.motivoInvalidez(session)
        if motivo:
            log.info("Sesión rechazada en %s %s: %s", request.method, request.path, motivo)
            session.clear()
            return _sin_sesion()

        sesion.refrescar(session)
        # El nombre por el que entra una sesión válida es legítimo por
        # definición: el Atajo lo admitirá después (ver core/red_local.py).
        red_local.anotarHostConSesion(request.host)

    @app.before_request
    def exigir_objeto_json():
        """Un cuerpo JSON de escritura tiene que ser un objeto.

        Ninguna ruta acepta otra cosa, pero casi todas hacían
        `request.get_json(silent=True) or {}` y luego `.get(...)`: con `[1]` o
        `"x"` eso era un AttributeError y un 500 (79 rutas lo daban en la
        auditoría). Rechazarlo aquí, con un 400 que dice qué pasa, cubre las
        que existen y las que se añadan. Un JSON ilegible no se toca: cada
        ruta ya lo trata como cuerpo vacío.
        """
        if request.method in SAFE_METHODS or not request.is_json:
            return None
        datos = request.get_json(silent=True)
        if datos is not None and not isinstance(datos, dict):
            return make_response({"ok": False, "error": "El cuerpo JSON debe ser un objeto"}, 400)
        return None

    def _sin_sesion():
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
                # Mismo criterio que la cookie de sesión (_SesionConSecureDinamico).
                secure=tls.httpsActivo(),
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
            response.headers["Content-Security-Policy"] = csp.construir(
                g.get("csp_nonce", ""), _origenes_de_comprobacion()
            )
        return response

    @app.after_request
    def comprimir_respuesta(response):
        """Gzip para HTML/CSS/JS/JSON cuando el cliente lo acepta.

        No hay por qué depender de que haya un proxy delante que comprima (Caddy
        es opcional, ver `aplicar_proxy_inverso`): sin esto, una instalación sin
        proxy —o con uno que no comprima— transfiere el JS/CSS propios enteros y
        sin comprimir en cada carga.
        """
        vary = {v.strip() for v in response.headers.get("Vary", "").split(",") if v.strip()}
        vary.add("Accept-Encoding")
        response.headers["Vary"] = ", ".join(sorted(vary))

        if (
            response.status_code in (304, 206)
            or "Content-Encoding" in response.headers
            or response.mimetype not in _TIPOS_COMPRIMIBLES
            or "gzip" not in request.headers.get("Accept-Encoding", "").lower()
        ):
            return response

        # Los estáticos (send_from_directory) llegan aquí con
        # direct_passthrough=True y ya con Content-Length calculado por
        # Werkzeug: se mira antes de tocar el cuerpo para no bufferizar en
        # memoria una respuesta que resulte demasiado grande para comprimir.
        longitud = response.content_length
        if longitud is None or not (_COMPRESION_MIN_BYTES <= longitud <= _COMPRESION_MAX_BYTES):
            return response

        # Los estáticos llegan en direct_passthrough (el fichero se sirve como
        # iterador, no como bytes ya cargados): hay que desactivarlo para poder
        # leer el cuerpo entero y sustituirlo por la versión comprimida.
        response.direct_passthrough = False
        cuerpo = response.get_data()
        response.set_data(gzip.compress(cuerpo, compresslevel=6))
        response.headers["Content-Encoding"] = "gzip"
        response.headers["Content-Length"] = str(len(response.get_data()))
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


class _SesionConSecureDinamico(SecureCookieSessionInterface):
    """La cookie de sesión lleva Secure según el estado del HTTPS en cada momento."""

    def get_cookie_secure(self, app):
        return tls.httpsActivo()


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
    # Cookie permanente: con fecha de caducidad, para que el navegador no la
    # tire al cerrarse (en el móvil ocurre solo). Cuánto vale de verdad lo
    # decide core/sesion.py en cada petición, no esta fecha. Sin
    # SESSION_REFRESH_EACH_REQUEST=False, Flask reemitiría la cookie en cada
    # respuesta por el mero hecho de ser permanente; `sesion.refrescar` ya la
    # renueva como mucho una vez por minuto, que es cuando cambia algo.
    app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(days=sesion.COOKIE_DIAS)
    app.config["SESSION_REFRESH_EACH_REQUEST"] = False
    app.config["SESSION_COOKIE_HTTPONLY"] = True
    app.config["SESSION_COOKIE_SAMESITE"] = settings.cookieSameSite()
    # SESSION_COOKIE_SECURE se activa solo cuando hay HTTPS (evita romper HTTP local).
    # Sale de core.tls y no de settings porque el interruptor está en Ajustes: el
    # ajuste de config.ini es solo el override de despliegue.
    app.config["SESSION_COOKIE_SECURE"] = tls.httpsActivo()
    # Lo de arriba es solo el valor inicial. Con varios workers, activar el
    # HTTPS desde Ajustes solo reasignaba app.config en el worker que atendía
    # esa petición: el otro seguía emitiendo la cookie sin Secure (o con Secure
    # por HTTP al desactivarlo, y el login entraba en bucle). La interfaz de
    # sesión lo pregunta en cada respuesta, igual que ya hace la cabecera HSTS.
    app.session_interface = _SesionConSecureDinamico()
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
