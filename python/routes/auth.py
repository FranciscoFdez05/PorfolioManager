import hmac
import html as htmlLib
import json
import logging
import os
import re
import secrets
import threading
import time
from contextlib import contextmanager
from urllib.parse import urlsplit

from cryptography.fernet import Fernet, InvalidToken
from flask import Blueprint, Response, g, jsonify, make_response, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from core import alta_inicial, csp, dos_factores, paths, sesion, settings, telegram_notifier
from core.bloqueo import exclusivo
from core.escritura import escribirAtomico, escribirJsonAtomico
from core.paths import AUTH_FILE as _AUTH_FILE, LOGIN_2FA_HTML, LOGIN_HTML, SETUP_HTML
from core.secret_store import fernetDeSecretKey

authBp = Blueprint("auth", __name__)

_DEFAULT_HASH = generate_password_hash(secrets.token_hex(32), method=settings.metodoHashPassword())

_senuelos: dict[str, str] = {}


def _senuelo(passwordHash: str) -> str:
    """Hash de una contraseña aleatoria con el mismo método que `password_hash`.

    Se comprueba contra él cuando el usuario no coincide, para que esa
    comprobación cueste lo mismo que la de verdad. Se calcula una vez por método.
    """
    metodo = passwordHash.split("$", 1)[0] if "$" in passwordHash else ""
    if metodo not in _senuelos:
        try:
            _senuelos[metodo] = generate_password_hash(secrets.token_hex(16), method=metodo)
        except (ValueError, TypeError):
            _senuelos[metodo] = _DEFAULT_HASH
    return _senuelos[metodo]


# Política de credenciales al cambiarlas. No se aplica a la contraseña actual
# (quien ya la tiene puede seguir entrando), solo a la nueva. El máximo evita que
# un texto enorme convierta cada comprobación del hash en trabajo inútil.
MIN_LARGO_CONTRASENA = 10
MAX_LARGO_CONTRASENA = 256
MAX_LARGO_USUARIO = 64

logger = logging.getLogger(__name__)

# ── Límite de intentos de login ───────────────────────────────────────────────
# No había ninguno: se podía probar contraseñas de forma ilimitada contra
# /login. El número de intentos y la duración del bloqueo salen de [seguridad]
# en config.ini: endurecerlos no debería obligar a tocar código.
#
# El contador se guarda en un fichero de data/tmp con cerrojo entre procesos.
# Vivía en la memoria de cada worker de gunicorn, y entonces los intentos que de
# verdad hacían falta para bloquear una IP eran los configurados multiplicados
# por el número de workers (16 con los 2 de serie, y se reiniciaba con cada
# worker nuevo). Los instantes son de reloj de pared (time.time) porque el
# monotónico no se puede comparar entre procesos.
#
# Si el cerrojo no se consigue a tiempo se usa la memoria del proceso, como
# antes: un disco lento no puede dejar el login sin ningún límite.
_attempts: dict[str, list] = {}   # respaldo en memoria: ip -> [nº fallos, instante del último]
_attemptsLock = threading.Lock()


def _ficheroIntentos():
    return paths.TMP_DIR / "login-intentos.json"


@contextmanager
def _intentos():
    """El registro de intentos, compartido entre procesos; se guarda al salir."""
    ruta = _ficheroIntentos()
    with _attemptsLock, exclusivo(ruta.with_suffix(".lock"), espera=5, obligatorio=False) as conseguido:
        if not conseguido:
            yield _attempts
            return
        try:
            datos = json.loads(ruta.read_text("utf-8"))
            if not isinstance(datos, dict):
                datos = {}
        except (OSError, ValueError):
            datos = {}
        antes = json.dumps(datos, sort_keys=True)
        yield datos
        if json.dumps(datos, sort_keys=True) != antes:
            try:
                escribirJsonAtomico(ruta, datos, indent=None)
            except OSError as error:
                logger.warning("No se pudo guardar el registro de intentos de login: %s", error)


def _clientIp() -> str:
    return request.remote_addr or "desconocida"


def _secondsLockedOut(ip: str) -> int:
    """Segundos que quedan de bloqueo para esta IP, 0 si puede intentarlo."""
    lockout = settings.bloqueoSegundos()
    with _intentos() as intentos:
        entry = intentos.get(ip)
        if not entry or entry[0] < settings.maxIntentosLogin():
            return 0
        elapsed = time.time() - entry[1]
        if elapsed >= lockout:
            intentos.pop(ip, None)
            return 0
        return int(lockout - elapsed)


def _recordFailure(ip: str) -> None:
    lockout = settings.bloqueoSegundos()
    with _intentos() as intentos:
        entry = intentos.get(ip)
        if entry and time.time() - entry[1] < lockout:
            intentos[ip] = [entry[0] + 1, time.time()]
        else:
            intentos[ip] = [1, time.time()]
        # Evitar que el registro crezca sin límite con muchas IPs distintas
        if len(intentos) > settings.maxIpsVigiladas():
            cutoff = time.time() - lockout
            for stale in [k for k, v in intentos.items() if v[1] < cutoff]:
                intentos.pop(stale, None)


def _clearFailures(ip: str) -> None:
    with _intentos() as intentos:
        intentos.pop(ip, None)


def _avisarSiSeBloquea(ip: str) -> None:
    """Cuenta por Telegram que una IP acaba de agotar sus intentos de login.

    Se llama justo después de anotar un fallo: si con ese fallo la IP ha
    quedado bloqueada, es el momento de avisar. Los intentos siguientes ya
    rebotan contra el bloqueo sin pasar por aquí, así que no se repite. Alguien
    probando contraseñas contra un servidor doméstico es exactamente lo que
    quien lo administra quiere enterarse, y no lo vería hasta mirar el log.
    """
    locked = _secondsLockedOut(ip)
    if locked:
        telegram_notifier.notificar(
            "seguridad",
            f"🔐 Login bloqueado: la IP {ip} ha fallado {settings.maxIntentosLogin()} intentos seguidos.\n"
            f"No podrá volver a probar en {locked // 60 + 1} min. Si no eras tú, cambia la contraseña.",
            clave=f"login-bloqueo-{ip}", cooldown=settings.bloqueoSegundos(),
        )


# Solo se admite como destino tras el login una ruta relativa de este host.
# Lista blanca en vez de lista negra: comprobar scheme/netloc dejaba pasar
# "/\evil.com", que los navegadores normalizan a "//evil.com" porque tratan la
# barra invertida como separador en URLs http(s). El carácter "\" no está en el
# conjunto permitido.
_SAFE_NEXT_RE = re.compile(r"^/[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$")


def _safeNextUrl(nextUrl: str) -> str:
    """Devuelve next_url si es una ruta interna segura, o '/' en caso contrario."""
    if not nextUrl or not _SAFE_NEXT_RE.match(nextUrl):
        return "/"
    # "//host" y "/\host" son referencias protocol-relative: destino externo.
    if nextUrl.startswith("//"):
        return "/"
    return nextUrl


# ── Cifrado ───────────────────────────────────────────────────────────────────

def _getFernet() -> Fernet | None:
    """Devuelve una instancia Fernet derivada de SECRET_KEY, o None si no hay clave."""
    return fernetDeSecretKey(b"portfolio-auth-v1")


# ── Persistencia ──────────────────────────────────────────────────────────────

def _loadCredentials() -> tuple[str, str]:
    """Devuelve (username, password_hash). Orden: auth.json (cifrado) > env vars > admin/admin."""
    ilegible = False
    if _AUTH_FILE.exists():
        ilegible = True  # hasta que se demuestre lo contrario
        try:
            raw = _AUTH_FILE.read_bytes()
            fernet = _getFernet()
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
                        _saveCredentials(u, h)
                        logger.info("auth.json migrado a formato cifrado")
                return u, h
        except Exception as error:
            # Antes se tragaba en silencio y el login pasaba a usar las
            # credenciales del .env sin que nada lo dijera.
            logger.error(
                "No se pudo leer %s (%s). Se usan las credenciales de LOGIN_USERNAME/"
                "LOGIN_PASSWORD_HASH si están definidas.", _AUTH_FILE.name, error,
            )

    # Env vars (Docker / .env)
    u = os.environ.get("LOGIN_USERNAME", "").strip()
    h = os.environ.get("LOGIN_PASSWORD_HASH", "").strip()
    if u and h:
        if ilegible:
            _apartarAuthIlegible()
        _saveCredentials(u, h)
        return u, h

    logger.critical(
        "No hay credenciales configuradas. Define LOGIN_USERNAME y LOGIN_PASSWORD_HASH "
        "en el archivo .env, o usa el setup inicial. No se permitirá el acceso."
    )
    return "__no_user__", _DEFAULT_HASH


def _apartarAuthIlegible() -> None:
    """Renombra un auth.dat que no se puede leer en vez de sobrescribirlo.

    Lo normal es que la SECRET_KEY haya cambiado: el fichero está bien, solo que
    cifrado con otra clave. Sobrescribirlo con las credenciales del .env
    devolvía en silencio la contraseña a la de la instalación y destruía la
    buena; recuperando la SECRET_KEY anterior ya no había vuelta atrás. Así queda
    al lado, con fecha, y se puede volver a poner en su sitio.
    """
    destino = _AUTH_FILE.with_name(f"{_AUTH_FILE.name}.ilegible-{time.strftime('%Y%m%d-%H%M%S')}")
    try:
        os.replace(_AUTH_FILE, destino)
        logger.error(
            "%s no se podía leer y se ha apartado como %s antes de escribir las credenciales "
            "del .env. Si cambiaste la SECRET_KEY, recupera la anterior y devuélvelo a su nombre.",
            _AUTH_FILE.name, destino.name,
        )
    except OSError as error:
        logger.error("No se pudo apartar %s (%s); se sobrescribirá.", _AUTH_FILE.name, error)


def _saveCredentials(username: str, passwordHash: str) -> None:
    payload = json.dumps({"username": username, "password_hash": passwordHash}).encode()
    fernet = _getFernet()
    # Atómica: un corte a mitad de un write_bytes() dejaba auth.dat truncado, y
    # a partir de ahí se entraba con las credenciales del .env o con ninguna.
    escribirAtomico(_AUTH_FILE, fernet.encrypt(payload) if fernet else payload, permisos=0o600)


# ── Rutas ─────────────────────────────────────────────────────────────────────


@authBp.route("/login", methods=["GET", "POST"])
def login():
    # Con la sesión ya iniciada no hay nada que pedir: al volver atrás desde la
    # aplicación el navegador vuelve a solicitar /login (la respuesta se marca
    # como no almacenable, ver más abajo) y aquí se devuelve a la app.
    if session.get("logged_in"):
        return redirect(_safeNextUrl(request.args.get("next") or "/"))
    if faltanCredenciales():
        return redirect(url_for("auth.setup"))

    # Un segundo paso que no se puede completar (código caducado, intentos
    # agotados) devuelve aquí con su motivo.
    error = session.pop("errorLogin", None)
    if request.method == "POST" and not _mismoOrigen():
        # Login CSRF: otra web podía enviar este formulario y dejar al usuario
        # dentro de la aplicación con una cuenta elegida por ella.
        logger.warning("Login rechazado: el formulario llega desde otro origen (%s)",
                       request.headers.get("Origin") or request.headers.get("Referer"))
        return "Origen no permitido", 403
    if request.method == "POST":
        ip = _clientIp()
        locked = _secondsLockedOut(ip)
        if locked:
            logger.warning("Login bloqueado por exceso de intentos desde %s", ip)
            error = f"Demasiados intentos fallidos. Vuelve a intentarlo en {locked // 60 + 1} min."
        else:
            username = request.form.get("username", "").strip()
            password = request.form.get("password", "")
            expectedUser, passwordHash = _loadCredentials()

            # compare_digest evita filtrar por tiempo la longitud del usuario.
            # Se comparan bytes: con str lanza TypeError si el usuario enviado
            # tiene caracteres no ASCII, lo que devolvía un 500 y además saltaba
            # el registro del intento fallido.
            userOk = hmac.compare_digest(
                username.encode("utf-8"), expectedUser.encode("utf-8")
            )
            # El hash se comprueba siempre, también con un usuario equivocado:
            # cortocircuitar con `and` hacía que la respuesta tardase ~100 ms
            # menos cuando el usuario no existía, y eso lo delataba. El señuelo
            # usa el mismo método y coste que el hash guardado; con uno de coste
            # distinto, la diferencia de tiempo se invertía pero seguía ahí.
            passOk = check_password_hash(passwordHash if userOk else _senuelo(passwordHash), password)
            if userOk and passOk:
                nextUrl = _safeNextUrl(request.args.get("next") or "/")
                # Con la 2FA activa la contraseña correcta no abre sesión ni
                # limpia los fallos de la IP: si los limpiase, repetir el login
                # daría intentos de código sin fin.
                if dos_factores.activa():
                    return _pedirSegundoPaso(nextUrl)
                _abrirSesion(ip)
                telegram_notifier.notificar("sesion", f"🔑 Inicio de sesión desde {ip}")
                return redirect(nextUrl)

            _recordFailure(ip)
            logger.warning("Intento de login fallido desde %s", ip)
            _avisarSiSeBloquea(ip)
            error = "Usuario o contraseña incorrectos"

    html = LOGIN_HTML.read_text("utf-8")
    html = html.replace(
        "<!-- ERROR_PLACEHOLDER -->",
        f'<p class="loginError">{error}</p>' if error else "",
    )
    return _paginaSinCache(html)


def _paginaSinCache(html: str):
    """Respuesta para las páginas de acceso: con nonce de CSP y sin caché."""
    # El botón de mostrar/ocultar la contraseña va en un script en línea. Con
    # la CSP sin 'unsafe-inline' solo corre si lleva el nonce de la petición,
    # que el after_request de core/seguridad_app.py recoge de `g`.
    g.csp_nonce = csp.generarNonce()
    html = csp.insertarNonce(html, g.csp_nonce)
    response = make_response(html)
    # Sin esto el navegador guarda la página en su caché de historial (bfcache) y
    # el botón "atrás" la muestra tal cual, sin preguntar al servidor, aunque la
    # sesión ya esté iniciada. no-store desactiva esa caché: al volver atrás se
    # repite la petición y la comprobación de arriba redirige a la aplicación.
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


def _abrirSesion(ip: str) -> None:
    """Abre la sesión autenticada tras superar todas las comprobaciones."""
    _clearFailures(ip)
    session.clear()
    session["logged_in"] = True
    # Permanente: sobrevive al cierre del navegador, que es lo que
    # hace que el móvil y el portátil puedan tener cada uno la suya
    # abierta sin volver a entrar. Caducidad y revocación, en
    # core/sesion.py.
    session.permanent = True
    # Identificador nuevo y marcas de tiempo: es lo que permite
    # caducar la sesión y revocarla en el logout. Va después de
    # clear() para que no herede nada de la sesión anterior.
    sesion.abrir(session)


# ── Alta inicial desde la web ─────────────────────────────────────────────────
# Solo con la instalación sin ninguna credencial. Un auth.dat que existe pero no
# se puede leer (SECRET_KEY cambiada) NO cuenta como «sin credenciales»: si
# contase, cualquiera de la LAN podría sustituir la cuenta buena por la suya.


class ErrorAlta(ValueError):
    """Dato del formulario de alta que no es válido; el mensaje es para el usuario."""


def faltanCredenciales() -> bool:
    """Indica si no hay cuenta configurada: ni auth.dat ni LOGIN_USERNAME/LOGIN_PASSWORD_HASH.

    Returns:
        True si la instalación está esperando el alta inicial.
    """
    if _AUTH_FILE.exists():
        return False
    return not (os.environ.get("LOGIN_USERNAME", "").strip()
                and os.environ.get("LOGIN_PASSWORD_HASH", "").strip())


def prepararAltaInicial() -> None:
    """Al arrancar sin cuenta, crea el código de alta y lo deja en el log.

    Lo llama server.py al importarse. Sin cuenta no hay nada más que hacer, así
    que el aviso va como WARNING para que se vea en `docker compose logs`.
    """
    if not faltanCredenciales():
        return
    try:
        codigo = alta_inicial.obtenerCodigo()
    except OSError as error:
        logger.critical("No hay credenciales y no se pudo crear el código de alta inicial: %s", error)
        return
    logger.warning(
        "No hay credenciales configuradas. Abre /setup en el navegador y usa el código %s "
        "(también está en %s).", codigo, alta_inicial.ruta(),
    )


def _validarAlta(username: str, password: str, password2: str) -> None:
    """Comprueba usuario y contraseña con la misma política que Ajustes.

    Raises:
        ErrorAlta: Con el motivo, listo para enseñarlo en el formulario.
    """
    if not username:
        raise ErrorAlta("El usuario no puede estar vacío")
    if len(username) > MAX_LARGO_USUARIO:
        raise ErrorAlta(f"El usuario no puede pasar de {MAX_LARGO_USUARIO} caracteres")
    if password != password2:
        raise ErrorAlta("Las contraseñas no coinciden")
    if len(password) < MIN_LARGO_CONTRASENA:
        raise ErrorAlta(f"La contraseña debe tener al menos {MIN_LARGO_CONTRASENA} caracteres")
    if len(password) > MAX_LARGO_CONTRASENA:
        raise ErrorAlta("La contraseña es demasiado larga")


def _crearCuentaInicial(username: str, password: str) -> bool:
    """Guarda la cuenta y consume el código. False si otra petición se adelantó.

    Bajo el mismo cerrojo que crea el código: dos envíos simultáneos con el
    código bueno no pueden acabar creando dos cuentas, la segunda pisando a la
    primera.
    """
    with exclusivo(alta_inicial.cerrojo(), espera=5, obligatorio=False):
        if not faltanCredenciales():
            return False
        _saveCredentials(username, generate_password_hash(password, method=settings.metodoHashPassword()))
        alta_inicial.consumir()
    return True


def _atenderAlta(ip: str):
    """Procesa el POST de /setup. Devuelve (respuesta, error)."""
    form = request.form
    # El código va primero y es lo único que cuenta como intento fallido:
    # equivocarse al repetir la contraseña no es un ataque.
    if not alta_inicial.coincide(form.get("codigo", "")):
        _recordFailure(ip)
        logger.warning("Código de alta inicial incorrecto desde %s", ip)
        _avisarSiSeBloquea(ip)
        return None, "El código de verificación no es correcto"
    username = form.get("username", "").strip()
    password = form.get("password", "")
    try:
        _validarAlta(username, password, form.get("password2", ""))
    except ErrorAlta as error:
        return None, str(error)
    try:
        creada = _crearCuentaInicial(username, password)
    except OSError as error:
        logger.error("No se pudo guardar la cuenta inicial: %s", error)
        return None, "No se pudo guardar la cuenta en el servidor. Revisa los permisos de data/."
    if not creada:
        return redirect(url_for("auth.login")), None
    logger.info("Cuenta inicial creada desde la web (%s)", ip)
    _abrirSesion(ip)
    return redirect("/"), None


@authBp.route("/setup", methods=["GET", "POST"])
def setup():
    """Alta de la primera cuenta, protegida por el código que deja el arranque."""
    if not faltanCredenciales():
        return redirect(url_for("auth.login"))
    if request.method == "POST" and not _mismoOrigen():
        logger.warning("Alta inicial rechazada: el formulario llega desde otro origen (%s)",
                       request.headers.get("Origin") or request.headers.get("Referer"))
        return "Origen no permitido", 403

    error = None
    if request.method == "POST":
        ip = _clientIp()
        locked = _secondsLockedOut(ip)
        if locked:
            error = f"Demasiados intentos fallidos. Vuelve a intentarlo en {locked // 60 + 1} min."
        else:
            respuesta, error = _atenderAlta(ip)
            if respuesta is not None:
                return respuesta
    else:
        # Por si se borró el fichero con la app en marcha: así siempre hay un
        # código que buscar en el servidor.
        try:
            alta_inicial.obtenerCodigo()
        except OSError as errorDisco:
            logger.critical("No se pudo crear el código de alta inicial: %s", errorDisco)

    # Tras un error se conserva lo escrito, salvo las contraseñas, para no
    # obligar a repetirlo todo. El código solo si era el bueno.
    codigo = request.form.get("codigo", "") if request.method == "POST" else ""
    html = SETUP_HTML.read_text("utf-8")
    html = html.replace("<!-- ERROR_PLACEHOLDER -->", f'<p class="loginError">{error}</p>' if error else "")
    html = html.replace("__USUARIO__", htmlLib.escape(request.form.get("username", "admin").strip(), quote=True))
    html = html.replace("__CODIGO__", htmlLib.escape(codigo if alta_inicial.coincide(codigo) else "", quote=True))
    html = html.replace("__FICHERO_CODIGO__", f"data/tmp/{alta_inicial.NOMBRE_FICHERO}")
    html = html.replace("__MIN_LARGO__", str(MIN_LARGO_CONTRASENA))
    return _paginaSinCache(html)


# ── Verificación en dos pasos en el login ─────────────────────────────────────
# El reto pendiente se guarda en el servidor (core/dos_factores.py); en la
# cookie solo va su identificador y adónde ir después. Sin `logged_in`, esa
# cookie no da acceso a nada más que a esta página.

_AVISO_SIN_TELEGRAM = ("No se ha podido enviar el código por Telegram. "
                       "Vuelve a pedirlo o entra con la frase de recuperación.")


# Cuándo se acertó la contraseña y con qué época de credenciales. La cookie sin
# `logged_in` vive lo que PERMANENT_SESSION_LIFETIME y `sesion.motivoInvalidez`
# no la mira: sin esto, una cookie del primer paso guardada antes de cambiar la
# contraseña seguía sirviendo para entrar con la frase meses después.
_INICIO_2FA = "inicio2fa"
_EPOCA_2FA = "epoca2fa"

_MOTIVO_CADUCADO = "La verificación ha caducado. Vuelve a escribir la contraseña."


def _mensajeSuspension(segundos: int) -> str:
    return ("Demasiados códigos incorrectos: la verificación en dos pasos queda suspendida. "
            f"Vuelve a intentarlo en {segundos // 60 + 1} min.")


def _pedirSegundoPaso(nextUrl: str):
    session.clear()
    suspension = dos_factores.segundosSuspension()
    if suspension:
        # Ni siquiera se manda el código: con la suspensión activa no se podría usar.
        session["errorLogin"] = _mensajeSuspension(suspension)
        return redirect(url_for("auth.login"))
    retoId, enviado = dos_factores.crearReto("login")
    session["reto2fa"] = retoId
    session["next2fa"] = nextUrl
    session[_INICIO_2FA] = time.time()
    session[_EPOCA_2FA] = sesion.leerEstado()["epoca"]
    if not enviado:
        session["aviso2fa"] = _AVISO_SIN_TELEGRAM
    return redirect(url_for("auth.loginDosPasos"))


def _motivoSegundoPasoInvalido() -> str | None:
    """Por qué el primer paso guardado en la cookie ya no vale, o None si sigue vigente.

    Returns:
        El mensaje para el usuario. Caducado y contraseña cambiada comparten
        mensaje a propósito: quien reutiliza una cookie vieja no tiene por qué
        saber cuál de las dos cosas ha pasado.
    """
    inicio = session.get(_INICIO_2FA)
    ahora = time.time()
    # Sin marca (cookie anterior a este control) o con una marca en el futuro
    # no se puede saber cuándo se acertó la contraseña: se rechaza.
    if not isinstance(inicio, (int, float)) or inicio > ahora + 60:
        return _MOTIVO_CADUCADO
    if ahora - inicio > settings.segundoPasoSegundos():
        logger.info("Segundo paso caducado (%d s desde la contraseña)", int(ahora - inicio))
        return _MOTIVO_CADUCADO
    if session.get(_EPOCA_2FA) != sesion.leerEstado()["epoca"]:
        logger.warning("Segundo paso rechazado: las credenciales han cambiado desde el primer paso (%s)",
                       _clientIp())
        return _MOTIVO_CADUCADO
    suspension = dos_factores.segundosSuspension()
    if suspension:
        return _mensajeSuspension(suspension)
    return None


def _volverAlLogin(motivo: str):
    """Abandona el segundo paso: hay que volver a escribir la contraseña."""
    dos_factores.descartarReto(session.get("reto2fa", ""))
    session.clear()
    session["errorLogin"] = motivo
    return redirect(url_for("auth.login"))


def _falloSegundoPaso(ip: str, que: str) -> None:
    # Cuenta para el mismo bloqueo por IP que la contraseña: es lo que impide
    # probar códigos a fuerza bruta.
    _recordFailure(ip)
    logger.warning("%s incorrecto en la verificación en dos pasos desde %s", que, ip)
    _avisarSiSeBloquea(ip)
    # El bloqueo por IP no frena a quien cambia de IP: cada contraseña acertada
    # da un reto nuevo con sus intentos. El tope global sí.
    try:
        suspendida = dos_factores.anotarFalloGlobal()
    except OSError as error:
        logger.error("No se pudo anotar el fallo en el contador global de la 2FA: %s", error)
        return
    if suspendida:
        _avisarSuspension(ip)


def _avisarSuspension(ip: str) -> None:
    """Registra y cuenta por Telegram que el segundo paso del login queda suspendido.

    Va por `responder` y no por `notificar`: es un aviso que el usuario tiene que
    ver aunque haya silenciado los avisos, porque también le impide entrar a él.
    """
    minutos = dos_factores.VENTANA_FALLOS_SEGUNDOS // 60
    logger.warning("Verificación en dos pasos suspendida %d min: %d fallos en una hora (último desde %s)",
                   minutos, settings.fallos2faPorHora(), ip)
    telegram_notifier.responder(
        f"Se han fallado {settings.fallos2faPorHora()} códigos o frases de la verificación en dos pasos "
        f"en una hora (el último desde {ip}). El login queda suspendido {minutos} min. "
        "Quien lo intenta conoce tu contraseña: cámbiala."
    )


def _completarSegundoPaso(ip: str, conFrase: bool):
    nextUrl = _safeNextUrl(session.get("next2fa") or "/")
    dos_factores.descartarReto(session.get("reto2fa", ""))
    _abrirSesion(ip)
    if conFrase:
        # La frase solo vale una vez: tras usarla la 2FA queda desactivada
        # hasta que se vuelva a activar desde Ajustes con una frase nueva.
        dos_factores.desactivar()
        logger.warning("Acceso con la frase de recuperación desde %s; 2FA desactivada", ip)
        telegram_notifier.notificar(
            "seguridad",
            f"Se ha entrado con la frase de recuperación desde {ip}. La verificación en dos pasos "
            "queda desactivada: vuelve a activarla en Ajustes > Cuenta. Si no has sido tú, cambia la contraseña.",
        )
    else:
        telegram_notifier.notificar("sesion", f"Inicio de sesión con verificación en dos pasos desde {ip}")
    return redirect(nextUrl)


def _atenderSegundoPaso(ip: str):
    """Procesa el POST de /login/2fa. Devuelve (respuesta, error, aviso)."""
    accion = request.form.get("accion", "codigo")
    retoId = session.get("reto2fa", "")

    if accion == "reenviar":
        try:
            enviado = dos_factores.reenviar(retoId, "login")
        except dos_factores.EsperaReenvio as espera:
            return None, str(espera), None
        except dos_factores.RetoInvalido as error:
            return _volverAlLogin(str(error)), None, None
        return None, None, "Código reenviado." if enviado else _AVISO_SIN_TELEGRAM

    if accion == "frase":
        # Igual que el código: la frase solo vale mientras el reto de este
        # login siga vivo. Se mira antes que la frase para no gastar el hash.
        try:
            dos_factores.datosReto(retoId, "login")
        except dos_factores.RetoInvalido as error:
            _falloSegundoPaso(ip, "Frase de recuperación")
            return _volverAlLogin(str(error)), None, None
        if dos_factores.fraseGuardadaCoincide(request.form.get("frase", "")):
            return _completarSegundoPaso(ip, conFrase=True), None, None
        _falloSegundoPaso(ip, "Frase de recuperación")
        return None, "La frase de recuperación no es correcta", None

    try:
        dos_factores.comprobarCodigo(retoId, "login", request.form.get("codigo", ""))
    except dos_factores.CodigoIncorrecto:
        _falloSegundoPaso(ip, "Código")
        return None, "Código incorrecto", None
    except dos_factores.RetoInvalido as error:
        _falloSegundoPaso(ip, "Código")
        return _volverAlLogin(str(error)), None, None
    return _completarSegundoPaso(ip, conFrase=False), None, None


@authBp.route("/login/2fa", methods=["GET", "POST"])
def loginDosPasos():
    """Segundo paso del login: código de Telegram o frase de recuperación."""
    if session.get("logged_in"):
        return redirect("/")
    if not session.get("reto2fa"):
        return redirect(url_for("auth.login"))
    if request.method == "POST" and not _mismoOrigen():
        logger.warning("Segundo paso rechazado: el formulario llega desde otro origen (%s)",
                       request.headers.get("Origin") or request.headers.get("Referer"))
        return "Origen no permitido", 403
    motivo = _motivoSegundoPasoInvalido()
    if motivo:
        return _volverAlLogin(motivo)

    error = None
    aviso = session.pop("aviso2fa", None)
    if request.method == "POST":
        ip = _clientIp()
        locked = _secondsLockedOut(ip)
        if locked:
            error = f"Demasiados intentos fallidos. Vuelve a intentarlo en {locked // 60 + 1} min."
        else:
            respuesta, error, aviso = _atenderSegundoPaso(ip)
            if respuesta is not None:
                return respuesta

    usarFrase = request.args.get("modo") == "frase"
    html = LOGIN_2FA_HTML.read_text("utf-8")
    html = html.replace("<!-- ERROR_PLACEHOLDER -->", f'<p class="loginError">{error}</p>' if error else "")
    html = html.replace("<!-- AVISO_PLACEHOLDER -->", f'<p class="loginAviso">{aviso}</p>' if aviso else "")
    html = html.replace("__MODO__", "frase" if usarFrase else "codigo")
    html = html.replace("__MINUTOS__", str(settings.codigo2faMinutos()))
    return _paginaSinCache(html)


def _mismoOrigen() -> bool:
    """¿La petición sale de una página de este mismo host?

    Los navegadores mandan `Origin` en todo POST de formulario. Sin él (un
    cliente que no es un navegador) se mira `Referer`, y sin ninguno de los dos
    se deja pasar: no hay una página ajena de por medio que pueda hacer CSRF.
    """
    procedencia = request.headers.get("Origin") or request.headers.get("Referer")
    if not procedencia or procedencia == "null":
        return procedencia != "null"
    return urlsplit(procedencia).netloc.lower() == (request.host or "").lower()


@authBp.route("/logout", methods=["GET", "POST"])
def logout():
    # Cerrar sesión solo por POST, que pasa por el CSRF de core/seguridad_app.
    # Por GET bastaba un <img src="/logout"> en cualquier web para echar al
    # usuario. Un GET (un marcador antiguo) vuelve a la aplicación sin tocar nada.
    if request.method != "POST":
        return redirect("/" if session.get("logged_in") else url_for("auth.login"))
    # `sesion.cerrar` y no `session.clear()`: vaciar la cookie solo afecta al
    # navegador que la pidió. Cualquier copia de esa misma cookie seguía siendo
    # válida después de cerrar sesión, porque nada del lado del servidor la
    # rechazaba. Ahora el identificador queda revocado.
    sesion.cerrar(session)
    return redirect(url_for("auth.login"))


def _renovarSesiones() -> None:
    """Cierra todas las sesiones abiertas y vuelve a sellar la de quien lo pide.

    Cambiar la contraseña tiene que echar a quien estuviera dentro con la
    anterior; si no, el cambio no sirve para lo único que suele motivarlo. Se
    vuelve a sellar la sesión en curso para no expulsar también a quien acaba de
    hacer el cambio, que es el único que ya ha demostrado saber la contraseña
    nueva. El orden importa: `abrir` tiene que leer la época ya incrementada.
    """
    sesion.invalidarTodas()
    sesion.abrir(session)


def _cuerpoDict() -> dict:
    datos = request.get_json(silent=True)
    return datos if isinstance(datos, dict) else {}


def _texto(valor) -> str:
    """Cadena o vacío: un número o una lista llegaban a check_password_hash y
    terminaban en un 500."""
    return valor if isinstance(valor, str) else ""


def _rechazarSiBloqueado():
    """Respuesta 429 si esta IP ha agotado los intentos, o None si puede seguir.

    Comparte el contador con /login a propósito. Estos dos endpoints piden la
    contraseña actual, así que son un segundo sitio donde probarla: sin esto, el
    límite de intentos se esquivaba sondeando aquí, que además solo estaba
    frenado por el límite general de escrituras (dos órdenes de magnitud más
    holgado). Hace falta sesión para llegar, pero el escenario que importa —una
    cookie robada intentando averiguar la contraseña para cambiarla— entra por
    aquí, no por /login.
    """
    locked = _secondsLockedOut(_clientIp())
    if not locked:
        return None
    respuesta = jsonify({
        "ok": False,
        "error": f"Demasiados intentos fallidos. Vuelve a intentarlo en {locked // 60 + 1} min.",
    })
    respuesta.headers["Retry-After"] = str(locked)
    return respuesta, 429


@authBp.route("/api/settings/credentials/username", methods=["POST"])
def changeUsername():
    bloqueado = _rechazarSiBloqueado()
    if bloqueado:
        return bloqueado

    data = _cuerpoDict()
    currentPassword = _texto(data.get("currentPassword"))
    newUsername     = _texto(data.get("newUsername")).strip()

    if not newUsername:
        return jsonify({"ok": False, "error": "El nuevo usuario no puede estar vacío"}), 400
    if len(newUsername) > MAX_LARGO_USUARIO:
        return jsonify({"ok": False, "error": f"El usuario no puede pasar de {MAX_LARGO_USUARIO} caracteres"}), 400

    _currentUser, passwordHash = _loadCredentials()
    if not check_password_hash(passwordHash, currentPassword):
        _recordFailure(_clientIp())
        logger.warning("Contraseña actual incorrecta al cambiar el usuario desde %s", _clientIp())
        _avisarSiSeBloquea(_clientIp())
        return jsonify({"ok": False, "error": "Contraseña actual incorrecta"}), 400

    _clearFailures(_clientIp())
    _saveCredentials(newUsername, passwordHash)
    _renovarSesiones()
    telegram_notifier.notificar("seguridad", f"🔐 Se ha cambiado el usuario de acceso (desde {_clientIp()}).")
    return jsonify({"ok": True})


@authBp.route("/api/settings/credentials/password", methods=["POST"])
def changePassword():
    bloqueado = _rechazarSiBloqueado()
    if bloqueado:
        return bloqueado

    data = _cuerpoDict()
    currentPassword = _texto(data.get("currentPassword"))
    newPassword     = data.get("newPassword", "")

    if not isinstance(newPassword, str) or not newPassword:
        return jsonify({"ok": False, "error": "La nueva contraseña no puede estar vacía"}), 400
    if len(newPassword) < MIN_LARGO_CONTRASENA:
        return jsonify({
            "ok": False,
            "error": f"La nueva contraseña debe tener al menos {MIN_LARGO_CONTRASENA} caracteres",
        }), 400
    if len(newPassword) > MAX_LARGO_CONTRASENA:
        return jsonify({"ok": False, "error": "La nueva contraseña es demasiado larga"}), 400

    currentUser, passwordHash = _loadCredentials()
    if not check_password_hash(passwordHash, currentPassword):
        _recordFailure(_clientIp())
        logger.warning("Contraseña actual incorrecta al cambiar la contraseña desde %s", _clientIp())
        _avisarSiSeBloquea(_clientIp())
        return jsonify({"ok": False, "error": "Contraseña actual incorrecta"}), 400

    _clearFailures(_clientIp())
    newHash = generate_password_hash(newPassword, method=settings.metodoHashPassword())
    _saveCredentials(currentUser, newHash)
    _renovarSesiones()
    telegram_notifier.notificar("seguridad", f"🔐 Se ha cambiado la contraseña de acceso (desde {_clientIp()}).")
    return jsonify({"ok": True})


# ── Verificación en dos pasos: Ajustes > Cuenta ───────────────────────────────
# Activar y desactivar piden la contraseña actual, y desactivar además el
# código o la frase: una cookie robada no basta para quitar la 2FA.

def _errorJson(mensaje: str, estado: int = 400):
    return jsonify({"ok": False, "error": mensaje}), estado


def _comprobarContrasenaActual(currentPassword: str, para: str):
    """None si la contraseña es la actual; si no, la respuesta de error.

    Anota el fallo en el mismo contador que /login, por lo mismo que
    `_rechazarSiBloqueado`.
    """
    _usuario, passwordHash = _loadCredentials()
    if check_password_hash(passwordHash, currentPassword):
        return None
    ip = _clientIp()
    _recordFailure(ip)
    logger.warning("Contraseña actual incorrecta al %s desde %s", para, ip)
    _avisarSiSeBloquea(ip)
    return _errorJson("Contraseña actual incorrecta")


@authBp.route("/api/settings/2fa", methods=["GET"])
def getDosFactores():
    return jsonify({
        "ok": True,
        "activa": dos_factores.activa(),
        "telegramConfigurado": telegram_notifier.configurado(),
        "largosFrase": list(dos_factores.LARGOS_FRASE),
        "minutosCodigo": settings.codigo2faMinutos(),
    })


@authBp.route("/api/settings/2fa/activar/iniciar", methods=["POST"])
def iniciarActivacionDosFactores():
    """Comprueba la contraseña, genera la frase y manda el código de activación."""
    bloqueado = _rechazarSiBloqueado()
    if bloqueado:
        return bloqueado
    data = _cuerpoDict()
    if dos_factores.activa():
        return _errorJson("La verificación en dos pasos ya está activada")
    if not telegram_notifier.configurado():
        return _errorJson("Configura antes el bot en Ajustes > Telegram")
    numPalabras = data.get("palabras")
    # type() y no isinstance: True pasaría por 1 y 6.0 por 6.
    if type(numPalabras) is not int or numPalabras not in dos_factores.LARGOS_FRASE:
        return _errorJson("Elige una frase de 6, 12 o 24 palabras")
    errorClave = _comprobarContrasenaActual(_texto(data.get("currentPassword")), "activar la 2FA")
    if errorClave:
        return errorClave
    _clearFailures(_clientIp())

    frase = dos_factores.generarFrase(numPalabras)
    retoId, enviado = dos_factores.crearReto("activar", {"fraseHash": dos_factores.hashFrase(frase)})
    if not enviado:
        dos_factores.descartarReto(retoId)
        return _errorJson("No se pudo enviar el código por Telegram. Comprueba el bot con «Probar» "
                          "en Ajustes > Telegram.", 502)
    session["reto2faAjustes"] = retoId
    return jsonify({"ok": True, "frase": frase})


@authBp.route("/api/settings/2fa/activar/confirmar", methods=["POST"])
def confirmarActivacionDosFactores():
    """Activa la 2FA si el código es el enviado y la frase la que se enseñó."""
    data = _cuerpoDict()
    retoId = session.get("reto2faAjustes", "")
    try:
        datos = dos_factores.datosReto(retoId, "activar")
        # La frase se mira antes que el código para no gastar el código si solo
        # falla la frase (un error al copiarla, lo más probable).
        if not dos_factores.fraseCoincide(_texto(data.get("frase")), datos.get("fraseHash", "")):
            return _errorJson("La frase no coincide con la que se te ha mostrado")
        dos_factores.comprobarCodigo(retoId, "activar", _texto(data.get("codigo")))
    except dos_factores.CodigoIncorrecto:
        return _errorJson("Código incorrecto")
    except dos_factores.RetoInvalido as error:
        session.pop("reto2faAjustes", None)
        return _errorJson(f"{error} Pulsa de nuevo «Activar».")

    session.pop("reto2faAjustes", None)
    try:
        dos_factores.activar(datos["fraseHash"])
    except OSError as error:
        logger.error("No se pudo guardar la activación de la 2FA: %s", error)
        return _errorJson("No se pudo guardar la configuración en el servidor", 500)
    telegram_notifier.notificar("seguridad", f"Verificación en dos pasos activada (desde {_clientIp()}).")
    return jsonify({"ok": True})


@authBp.route("/api/settings/2fa/codigo", methods=["POST"])
def enviarCodigoDesactivacion():
    """Manda el código para desactivar; si ya hay uno pendiente, lo reenvía."""
    if not dos_factores.activa():
        return _errorJson("La verificación en dos pasos no está activada")
    retoId = session.get("reto2faDesactivar", "")
    try:
        enviado = dos_factores.reenviar(retoId, "desactivar")
    except dos_factores.EsperaReenvio as espera:
        respuesta, estado = _errorJson(str(espera), 429)
        respuesta.headers["Retry-After"] = str(espera.segundos)
        return respuesta, estado
    except dos_factores.RetoInvalido:
        retoId, enviado = dos_factores.crearReto("desactivar")
        session["reto2faDesactivar"] = retoId
    if not enviado:
        return _errorJson("No se pudo enviar el código por Telegram. Usa la frase de recuperación.", 502)
    return jsonify({"ok": True})


@authBp.route("/api/settings/2fa/desactivar", methods=["POST"])
def desactivarDosFactores():
    """Desactiva la 2FA con la contraseña actual más el código o la frase."""
    bloqueado = _rechazarSiBloqueado()
    if bloqueado:
        return bloqueado
    if not dos_factores.activa():
        return _errorJson("La verificación en dos pasos no está activada")
    data = _cuerpoDict()
    errorClave = _comprobarContrasenaActual(_texto(data.get("currentPassword")), "desactivar la 2FA")
    if errorClave:
        return errorClave

    ip = _clientIp()
    frase = _texto(data.get("frase")).strip()
    if frase:
        if not dos_factores.fraseGuardadaCoincide(frase):
            _falloSegundoPaso(ip, "Frase de recuperación")
            return _errorJson("La frase de recuperación no es correcta")
    else:
        try:
            dos_factores.comprobarCodigo(session.get("reto2faDesactivar", ""), "desactivar",
                                         _texto(data.get("codigo")))
        except dos_factores.CodigoIncorrecto:
            _falloSegundoPaso(ip, "Código")
            return _errorJson("Código incorrecto")
        except dos_factores.RetoInvalido as error:
            session.pop("reto2faDesactivar", None)
            return _errorJson(f"{error} Pide otro código.")

    _clearFailures(ip)
    session.pop("reto2faDesactivar", None)
    try:
        dos_factores.desactivar()
    except OSError as error:
        logger.error("No se pudo desactivar la 2FA: %s", error)
        return _errorJson("No se pudo guardar la configuración en el servidor", 500)
    telegram_notifier.notificar("seguridad", f"Verificación en dos pasos desactivada (desde {ip}).")
    return jsonify({"ok": True})


# ── Verificación en dos pasos: cambiar el bot de Telegram ─────────────────────
# Con la 2FA activa, el bot y el chat son el segundo factor: cambiarlos solo con
# la sesión permitía a una cookie robada mandarse los códigos a su propio chat y
# desactivar la 2FA. Se pide lo mismo que para desactivarla: la contraseña más
# un código enviado al chat ACTUAL o la frase de recuperación.

_RETO_TELEGRAM = "reto2faTelegram"


@authBp.route("/api/settings/telegram/codigo", methods=["POST"])
def enviarCodigoCambioTelegram():
    """Manda al chat actual el código que autoriza cambiar el bot o el chat.

    Si ya hay uno pendiente, lo reenvía respetando la espera entre envíos.
    """
    if not dos_factores.activa():
        return _errorJson("La verificación en dos pasos no está activada")
    retoId = session.get(_RETO_TELEGRAM, "")
    try:
        enviado = dos_factores.reenviar(retoId, "telegram")
    except dos_factores.EsperaReenvio as espera:
        respuesta, estado = _errorJson(str(espera), 429)
        respuesta.headers["Retry-After"] = str(espera.segundos)
        return respuesta, estado
    except dos_factores.RetoInvalido:
        retoId, enviado = dos_factores.crearReto("telegram")
        session[_RETO_TELEGRAM] = retoId
    if not enviado:
        return _errorJson("No se pudo enviar el código por Telegram. Usa la frase de recuperación.", 502)
    return jsonify({"ok": True})


def autorizarCambioTelegram(data: dict) -> tuple[Response, int] | None:
    """Comprueba que se puede cambiar el bot o el chat de Telegram.

    Sin la 2FA activa no exige nada, como hasta ahora. Con ella, la contraseña
    actual más el código enviado al chat actual o la frase de recuperación. El
    código se consume solo si todo es correcto.

    Args:
        data: Cuerpo JSON de la petición, con `currentPassword` y `codigo` o `frase`.

    Returns:
        None si se puede seguir; si no, la respuesta de error con su estado
        (403 cuando faltan las credenciales, 400 si son incorrectas, 429 si la
        IP está bloqueada).
    """
    if not dos_factores.activa():
        return None
    bloqueado = _rechazarSiBloqueado()
    if bloqueado:
        return bloqueado
    currentPassword = _texto(data.get("currentPassword"))
    frase = _texto(data.get("frase")).strip()
    codigo = _texto(data.get("codigo")).strip()
    if not currentPassword or not (frase or codigo):
        # `requiereVerificacion` le dice al formulario que pida los datos que faltan.
        respuesta = jsonify({
            "ok": False,
            "requiereVerificacion": True,
            "error": "Con la verificación en dos pasos activa, confirma el cambio con tu contraseña "
                     "y un código enviado al chat actual o la frase de recuperación.",
        })
        return respuesta, 403
    errorClave = _comprobarContrasenaActual(currentPassword, "cambiar el bot de Telegram")
    if errorClave:
        return errorClave

    ip = _clientIp()
    if frase:
        if not dos_factores.fraseGuardadaCoincide(frase):
            _falloSegundoPaso(ip, "Frase de recuperación")
            return _errorJson("La frase de recuperación no es correcta")
    else:
        try:
            dos_factores.comprobarCodigo(session.get(_RETO_TELEGRAM, ""), "telegram", codigo)
        except dos_factores.CodigoIncorrecto:
            _falloSegundoPaso(ip, "Código")
            return _errorJson("Código incorrecto")
        except dos_factores.RetoInvalido as error:
            session.pop(_RETO_TELEGRAM, None)
            return _errorJson(f"{error} Pide otro código.")

    _clearFailures(ip)
    session.pop(_RETO_TELEGRAM, None)
    return None
