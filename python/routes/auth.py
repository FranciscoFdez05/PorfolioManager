import hmac
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
from flask import Blueprint, g, jsonify, make_response, redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

from core import csp, paths, sesion, settings, telegram_notifier
from core.bloqueo import exclusivo
from core.escritura import escribirAtomico, escribirJsonAtomico
from core.paths import AUTH_FILE as _AUTH_FILE, LOGIN_HTML
from core.secret_store import fernetDeSecretKey

auth_bp = Blueprint("auth", __name__)

_DEFAULT_HASH = generate_password_hash(secrets.token_hex(32), method=settings.metodoHashPassword())

_senuelos: dict[str, str] = {}


def _senuelo(password_hash: str) -> str:
    """Hash de una contraseña aleatoria con el mismo método que `password_hash`.

    Se comprueba contra él cuando el usuario no coincide, para que esa
    comprobación cueste lo mismo que la de verdad. Se calcula una vez por método.
    """
    metodo = password_hash.split("$", 1)[0] if "$" in password_hash else ""
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
_attempts_lock = threading.Lock()


def _fichero_intentos():
    return paths.TMP_DIR / "login-intentos.json"


@contextmanager
def _intentos():
    """El registro de intentos, compartido entre procesos; se guarda al salir."""
    ruta = _fichero_intentos()
    with _attempts_lock, exclusivo(ruta.with_suffix(".lock"), espera=5, obligatorio=False) as conseguido:
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


def _client_ip() -> str:
    return request.remote_addr or "desconocida"


def _seconds_locked_out(ip: str) -> int:
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


def _record_failure(ip: str) -> None:
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


def _clear_failures(ip: str) -> None:
    with _intentos() as intentos:
        intentos.pop(ip, None)


def _avisar_si_se_bloquea(ip: str) -> None:
    """Cuenta por Telegram que una IP acaba de agotar sus intentos de login.

    Se llama justo después de anotar un fallo: si con ese fallo la IP ha
    quedado bloqueada, es el momento de avisar. Los intentos siguientes ya
    rebotan contra el bloqueo sin pasar por aquí, así que no se repite. Alguien
    probando contraseñas contra un servidor doméstico es exactamente lo que
    quien lo administra quiere enterarse, y no lo vería hasta mirar el log.
    """
    locked = _seconds_locked_out(ip)
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
    return fernetDeSecretKey(b"portfolio-auth-v1")


# ── Persistencia ──────────────────────────────────────────────────────────────

def _load_credentials() -> tuple[str, str]:
    """Devuelve (username, password_hash). Orden: auth.json (cifrado) > env vars > admin/admin."""
    ilegible = False
    if _AUTH_FILE.exists():
        ilegible = True  # hasta que se demuestre lo contrario
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
            _apartar_auth_ilegible()
        _save_credentials(u, h)
        return u, h

    logger.critical(
        "No hay credenciales configuradas. Define LOGIN_USERNAME y LOGIN_PASSWORD_HASH "
        "en el archivo .env, o usa el setup inicial. No se permitirá el acceso."
    )
    return "__no_user__", _DEFAULT_HASH


def _apartar_auth_ilegible() -> None:
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


def _save_credentials(username: str, password_hash: str) -> None:
    payload = json.dumps({"username": username, "password_hash": password_hash}).encode()
    fernet = _get_fernet()
    # Atómica: un corte a mitad de un write_bytes() dejaba auth.dat truncado, y
    # a partir de ahí se entraba con las credenciales del .env o con ninguna.
    escribirAtomico(_AUTH_FILE, fernet.encrypt(payload) if fernet else payload, permisos=0o600)


# ── Rutas ─────────────────────────────────────────────────────────────────────


@auth_bp.route("/login", methods=["GET", "POST"])
def login():
    # Con la sesión ya iniciada no hay nada que pedir: al volver atrás desde la
    # aplicación el navegador vuelve a solicitar /login (la respuesta se marca
    # como no almacenable, ver más abajo) y aquí se devuelve a la app.
    if session.get("logged_in"):
        return redirect(_safe_next_url(request.args.get("next") or "/"))

    error = None
    if request.method == "POST" and not _mismo_origen():
        # Login CSRF: otra web podía enviar este formulario y dejar al usuario
        # dentro de la aplicación con una cuenta elegida por ella.
        logger.warning("Login rechazado: el formulario llega desde otro origen (%s)",
                       request.headers.get("Origin") or request.headers.get("Referer"))
        return "Origen no permitido", 403
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
            # El hash se comprueba siempre, también con un usuario equivocado:
            # cortocircuitar con `and` hacía que la respuesta tardase ~100 ms
            # menos cuando el usuario no existía, y eso lo delataba. El señuelo
            # usa el mismo método y coste que el hash guardado; con uno de coste
            # distinto, la diferencia de tiempo se invertía pero seguía ahí.
            pass_ok = check_password_hash(password_hash if user_ok else _senuelo(password_hash), password)
            if user_ok and pass_ok:
                _clear_failures(ip)
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
                telegram_notifier.notificar("sesion", f"🔑 Inicio de sesión desde {ip}")
                return redirect(_safe_next_url(request.args.get("next") or "/"))

            _record_failure(ip)
            logger.warning("Intento de login fallido desde %s", ip)
            _avisar_si_se_bloquea(ip)
            error = "Usuario o contraseña incorrectos"

    html = LOGIN_HTML.read_text("utf-8")
    html = html.replace(
        "<!-- ERROR_PLACEHOLDER -->",
        f'<p class="loginError">{error}</p>' if error else "",
    )
    # El botón de mostrar/ocultar la contraseña va en un script en línea. Con
    # la CSP sin 'unsafe-inline' solo corre si lleva el nonce de la petición,
    # que el after_request de core/seguridad_app.py recoge de `g`.
    g.csp_nonce = csp.generar_nonce()
    html = csp.insertar_nonce(html, g.csp_nonce)
    response = make_response(html)
    # Sin esto el navegador guarda la página en su caché de historial (bfcache) y
    # el botón "atrás" la muestra tal cual, sin preguntar al servidor, aunque la
    # sesión ya esté iniciada. no-store desactiva esa caché: al volver atrás se
    # repite la petición y la comprobación de arriba redirige a la aplicación.
    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    response.headers["Pragma"] = "no-cache"
    return response


def _mismo_origen() -> bool:
    """¿La petición sale de una página de este mismo host?

    Los navegadores mandan `Origin` en todo POST de formulario. Sin él (un
    cliente que no es un navegador) se mira `Referer`, y sin ninguno de los dos
    se deja pasar: no hay una página ajena de por medio que pueda hacer CSRF.
    """
    procedencia = request.headers.get("Origin") or request.headers.get("Referer")
    if not procedencia or procedencia == "null":
        return procedencia != "null"
    return urlsplit(procedencia).netloc.lower() == (request.host or "").lower()


@auth_bp.route("/logout", methods=["GET", "POST"])
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


def _renovar_sesiones() -> None:
    """Cierra todas las sesiones abiertas y vuelve a sellar la de quien lo pide.

    Cambiar la contraseña tiene que echar a quien estuviera dentro con la
    anterior; si no, el cambio no sirve para lo único que suele motivarlo. Se
    vuelve a sellar la sesión en curso para no expulsar también a quien acaba de
    hacer el cambio, que es el único que ya ha demostrado saber la contraseña
    nueva. El orden importa: `abrir` tiene que leer la época ya incrementada.
    """
    sesion.invalidarTodas()
    sesion.abrir(session)


def _cuerpo_dict() -> dict:
    datos = request.get_json(silent=True)
    return datos if isinstance(datos, dict) else {}


def _texto(valor) -> str:
    """Cadena o vacío: un número o una lista llegaban a check_password_hash y
    terminaban en un 500."""
    return valor if isinstance(valor, str) else ""


def _rechazar_si_bloqueado():
    """Respuesta 429 si esta IP ha agotado los intentos, o None si puede seguir.

    Comparte el contador con /login a propósito. Estos dos endpoints piden la
    contraseña actual, así que son un segundo sitio donde probarla: sin esto, el
    límite de intentos se esquivaba sondeando aquí, que además solo estaba
    frenado por el límite general de escrituras (dos órdenes de magnitud más
    holgado). Hace falta sesión para llegar, pero el escenario que importa —una
    cookie robada intentando averiguar la contraseña para cambiarla— entra por
    aquí, no por /login.
    """
    locked = _seconds_locked_out(_client_ip())
    if not locked:
        return None
    respuesta = jsonify({
        "ok": False,
        "error": f"Demasiados intentos fallidos. Vuelve a intentarlo en {locked // 60 + 1} min.",
    })
    respuesta.headers["Retry-After"] = str(locked)
    return respuesta, 429


@auth_bp.route("/api/settings/credentials/username", methods=["POST"])
def change_username():
    bloqueado = _rechazar_si_bloqueado()
    if bloqueado:
        return bloqueado

    data = _cuerpo_dict()
    current_password = _texto(data.get("currentPassword"))
    new_username     = _texto(data.get("newUsername")).strip()

    if not new_username:
        return jsonify({"ok": False, "error": "El nuevo usuario no puede estar vacío"}), 400
    if len(new_username) > MAX_LARGO_USUARIO:
        return jsonify({"ok": False, "error": f"El usuario no puede pasar de {MAX_LARGO_USUARIO} caracteres"}), 400

    _current_user, password_hash = _load_credentials()
    if not check_password_hash(password_hash, current_password):
        _record_failure(_client_ip())
        logger.warning("Contraseña actual incorrecta al cambiar el usuario desde %s", _client_ip())
        _avisar_si_se_bloquea(_client_ip())
        return jsonify({"ok": False, "error": "Contraseña actual incorrecta"}), 400

    _clear_failures(_client_ip())
    _save_credentials(new_username, password_hash)
    _renovar_sesiones()
    telegram_notifier.notificar("seguridad", f"🔐 Se ha cambiado el usuario de acceso (desde {_client_ip()}).")
    return jsonify({"ok": True})


@auth_bp.route("/api/settings/credentials/password", methods=["POST"])
def change_password():
    bloqueado = _rechazar_si_bloqueado()
    if bloqueado:
        return bloqueado

    data = _cuerpo_dict()
    current_password = _texto(data.get("currentPassword"))
    new_password     = data.get("newPassword", "")

    if not isinstance(new_password, str) or not new_password:
        return jsonify({"ok": False, "error": "La nueva contraseña no puede estar vacía"}), 400
    if len(new_password) < MIN_LARGO_CONTRASENA:
        return jsonify({
            "ok": False,
            "error": f"La nueva contraseña debe tener al menos {MIN_LARGO_CONTRASENA} caracteres",
        }), 400
    if len(new_password) > MAX_LARGO_CONTRASENA:
        return jsonify({"ok": False, "error": "La nueva contraseña es demasiado larga"}), 400

    current_user, password_hash = _load_credentials()
    if not check_password_hash(password_hash, current_password):
        _record_failure(_client_ip())
        logger.warning("Contraseña actual incorrecta al cambiar la contraseña desde %s", _client_ip())
        _avisar_si_se_bloquea(_client_ip())
        return jsonify({"ok": False, "error": "Contraseña actual incorrecta"}), 400

    _clear_failures(_client_ip())
    new_hash = generate_password_hash(new_password, method=settings.metodoHashPassword())
    _save_credentials(current_user, new_hash)
    _renovar_sesiones()
    telegram_notifier.notificar("seguridad", f"🔐 Se ha cambiado la contraseña de acceso (desde {_client_ip()}).")
    return jsonify({"ok": True})
