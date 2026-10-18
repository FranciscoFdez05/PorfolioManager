"""Pruebas de /login, /logout y el cambio de credenciales.

`routes/auth.py` es la única puerta de la aplicación y no la cubría ningún test:
el bloqueo por IP, el cifrado de auth.dat y la validación del parámetro `next`
son código con historia (cada uno arregla un fallo concreto) que hasta ahora
solo se podía comprobar a mano.

`datosAislados` mueve AUTH_FILE a tmp_path, así que ningún caso escribe sobre
las credenciales reales de quien lance la suite.
"""

import json

import pytest
from werkzeug.security import generate_password_hash

USUARIO = "francisco"
CLAVE = "una-contraseña-larga-de-prueba"


@pytest.fixture
def credenciales(datosAislados, monkeypatch):
    """Escribe unas credenciales conocidas en el AUTH_FILE aislado."""
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", datosAislados["auth"])
    # De SECRET_KEY sale el Fernet con el que se cifra auth.dat. Sin ella el
    # fichero se guarda en claro (comportamiento deliberado, para no dejar fuera
    # a quien aún no la tenga configurada), así que aquí hay que fijarla o los
    # tests de cifrado estarían comprobando el camino degradado.
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    # pbkdf2 con 600.000 iteraciones tarda ~0,3 s por comprobación; varios tests
    # hacen una decena de intentos y la suite se iría a varios segundos sin nada
    # a cambio: lo que se prueba es el flujo, no la dureza del hash.
    monkeypatch.setenv("HASH_ITERACIONES", "100000")

    auth._saveCredentials(USUARIO, generate_password_hash(CLAVE, method="pbkdf2:sha256:100000"))
    return datosAislados["auth"]


@pytest.fixture
def cliente(crearApp, credenciales, monkeypatch):
    from routes.auth import authBp

    # El limitador de escrituras no cubre /login (tiene su propio bloqueo), pero
    # sí los endpoints de cambio de credenciales.
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    # Registro de intentos limpio: es estado global del módulo y, sin esto, el
    # primer test que agota los intentos dejaría bloqueados a los siguientes.
    from routes import auth
    auth._attempts.clear()

    app = crearApp(authBp)
    return app.test_client()


# ── Login ────────────────────────────────────────────────────────────────────

def testLoginCorrectoAbreSesion(cliente):
    respuesta = cliente.post("/login", data={"username": USUARIO, "password": CLAVE})

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"] == "/"
    with cliente.session_transaction() as sesion:
        assert sesion["logged_in"] is True


def testCredencialesIncorrectasNoAbrenSesion(cliente):
    respuesta = cliente.post("/login", data={"username": USUARIO, "password": "otra"})

    assert respuesta.status_code == 200          # vuelve a pintar el formulario
    assert "incorrectos" in respuesta.get_data(as_text=True)
    with cliente.session_transaction() as sesion:
        assert not sesion.get("logged_in")


def testElErrorNoDistingueUsuarioDeContrasenia(cliente):
    """Decir cuál de los dos falla confirma qué usuarios existen."""
    conUsuarioMalo = cliente.post("/login", data={"username": "nadie", "password": CLAVE})
    conClaveMala = cliente.post("/login", data={"username": USUARIO, "password": "no"})

    assert "incorrectos" in conUsuarioMalo.get_data(as_text=True)
    assert "incorrectos" in conClaveMala.get_data(as_text=True)


def testUnUsuarioConAcentosNoProvocaUn500(cliente):
    """`compare_digest` sobre str lanza TypeError con caracteres no ASCII.

    Además de devolver 500, ese camino se saltaba el registro del intento
    fallido, así que no contaba para el bloqueo por IP.
    """
    respuesta = cliente.post("/login", data={"username": "ñandú", "password": CLAVE})

    assert respuesta.status_code == 200
    assert _registro()  # el intento sí quedó registrado


def testLaPaginaDeLoginNoSeGuardaEnCache(cliente):
    """Sin esto, el botón "atrás" la mostraba desde la bfcache ya con sesión."""
    cabeceras = cliente.get("/login").headers

    assert "no-store" in cabeceras["Cache-Control"]


def testElScriptDelLoginLlevaElNonceDeLaCsp(cliente):
    """El botón de mostrar la contraseña iba en un onclick= y la CSP lo bloqueaba.

    Ahora va en un <script nonce>: el nonce del HTML tiene que ser el mismo que
    autoriza la cabecera, y no puede quedar el marcador sin rellenar.
    """
    import re

    respuesta = cliente.get("/login")
    html = respuesta.get_data(as_text=True)

    boton = re.search(r"<button[^>]*id=\"togglePassword\"[^>]*>", html).group(0)
    assert "onclick" not in boton
    assert "__CSP_NONCE__" not in html
    nonce = re.search(r'<script nonce="([^"]+)">', html).group(1)
    assert f"'nonce-{nonce}'" in respuesta.headers["Content-Security-Policy"]


def testConSesionAbiertaLoginDevuelveALaAplicacion(cliente):
    with cliente.session_transaction() as sesion:
        sesion["logged_in"] = True

    respuesta = cliente.get("/login")

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"] == "/"


def testLogoutCierraLaSesion(cliente):
    from core import sesion as sesionApp

    with cliente.session_transaction() as sesion:
        sesion["logged_in"] = True
        sesion["csrf_token"] = "token-de-prueba"
        sesionApp.abrir(sesion)

    respuesta = cliente.post("/logout", headers={"X-CSRF-Token": "token-de-prueba"})

    assert respuesta.status_code == 302
    with cliente.session_transaction() as sesion:
        assert not sesion.get("logged_in")


def testLaCookieDeSesionEsPermanente(cliente):
    """Sin fecha de caducidad, el navegador la tira al cerrarse —en el móvil,
    solo— y el usuario tenía que volver a entrar cada dos por tres. Cuánto vale
    de verdad lo decide el servidor (core/sesion.py), no esta fecha."""
    respuesta = cliente.post("/login", data={"username": USUARIO, "password": CLAVE})

    cookie = next(c for c in respuesta.headers.getlist("Set-Cookie") if c.startswith("pm_session_"))
    assert "Expires=" in cookie or "Max-Age=" in cookie
    with cliente.session_transaction() as sesion:
        assert sesion.permanent is True


# ── Destino tras el login (?next) ────────────────────────────────────────────

@pytest.mark.parametrize("destino", [
    "https://evil.com",
    "//evil.com",
    r"/\evil.com",        # los navegadores lo normalizan a //evil.com
    "http://evil.com/x",
    "javascript:alert(1)",
])
def testNextExternoSeDescarta(cliente, destino):
    """Un redirect abierto convierte el login en una página de phishing."""
    respuesta = cliente.post(
        f"/login?next={destino}", data={"username": USUARIO, "password": CLAVE},
    )
    assert respuesta.headers["Location"] == "/"


@pytest.mark.parametrize("destino", ["/metricas", "/html/analisis/metricas.html", "/?tab=activos"])
def testNextInternoSeRespeta(cliente, destino):
    respuesta = cliente.post(
        f"/login?next={destino}", data={"username": USUARIO, "password": CLAVE},
    )
    assert respuesta.headers["Location"] == destino


# ── Bloqueo por IP ───────────────────────────────────────────────────────────

def testTrasAgotarLosIntentosLaIpQuedaBloqueada(cliente, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "3")
    ip = {"REMOTE_ADDR": "192.168.1.99"}

    for _ in range(3):
        cliente.post("/login", data={"username": USUARIO, "password": "mal"}, environ_base=ip)

    # Incluso con la contraseña correcta: el bloqueo se comprueba antes.
    respuesta = cliente.post("/login", data={"username": USUARIO, "password": CLAVE}, environ_base=ip)

    assert "Demasiados intentos" in respuesta.get_data(as_text=True)
    with cliente.session_transaction() as sesion:
        assert not sesion.get("logged_in")


def testElBloqueoEsPorIp(cliente, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "2")

    for _ in range(3):
        cliente.post("/login", data={"username": USUARIO, "password": "mal"},
                     environ_base={"REMOTE_ADDR": "192.168.1.99"})

    otra = cliente.post("/login", data={"username": USUARIO, "password": CLAVE},
                        environ_base={"REMOTE_ADDR": "192.168.1.100"})

    assert otra.status_code == 302
    assert otra.headers["Location"] == "/"


def testUnLoginCorrectoLimpiaLosFallosPrevios(cliente, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "3")
    ip = {"REMOTE_ADDR": "192.168.1.101"}

    cliente.post("/login", data={"username": USUARIO, "password": "mal"}, environ_base=ip)
    cliente.post("/login", data={"username": USUARIO, "password": CLAVE}, environ_base=ip)

    assert "192.168.1.101" not in _registro()


def testElRegistroDeIntentosNoCreceSinLimite(monkeypatch):
    """Con IPs falsificadas el diccionario sería un consumo de memoria abierto."""
    import time

    from routes import auth

    monkeypatch.setenv("MAX_IPS_VIGILADAS", "20")
    monkeypatch.setenv("BLOQUEO_SEGUNDOS", "1")
    viejos = {f"10.0.0.{i}": [1, time.time() - 100] for i in range(30)}  # ya caducados
    auth._ficheroIntentos().write_text(json.dumps(viejos), encoding="utf-8")

    auth._recordFailure("10.9.9.9")

    assert len(_registro()) < 30


def testElBloqueoNoDependeDeLaMemoriaDelProceso(cliente, monkeypatch):
    """Con varios workers cada uno llevaba su cuenta: 8 intentos por worker.

    El registro vive ahora en un fichero compartido. Vaciar la memoria del
    proceso (lo que vería otro worker, o uno recién arrancado) no lo levanta.
    """
    from routes import auth

    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "2")
    ip = {"REMOTE_ADDR": "192.168.1.150"}
    for _ in range(2):
        cliente.post("/login", data={"username": USUARIO, "password": "mal"}, environ_base=ip)
    auth._attempts.clear()

    respuesta = cliente.post("/login", data={"username": USUARIO, "password": CLAVE}, environ_base=ip)

    assert "Demasiados intentos" in respuesta.get_data(as_text=True)


# ── Almacenamiento de credenciales ───────────────────────────────────────────

def testAuthDatSeGuardaCifrado(credenciales):
    """El fichero está dentro de data/, que acaba en los backups y en los zips."""
    crudo = credenciales.read_bytes()

    assert USUARIO.encode() not in crudo
    # Cifrado con Fernet: el contenido ya no es JSON legible.
    with pytest.raises(json.JSONDecodeError):
        json.loads(crudo)


def testUnAuthDatEnTextoPlanoSeMigraAlLeerlo(credenciales, monkeypatch):
    """Instalaciones anteriores a que existiera el cifrado deben seguir entrando."""
    from routes import auth

    plano = json.dumps({"username": "antiguo", "password_hash": "hash-cualquiera"}).encode()
    credenciales.write_bytes(plano)

    usuario, _hash = auth._loadCredentials()

    assert usuario == "antiguo"
    # Y al leerlo se ha reescrito ya cifrado, sin pedirle nada al usuario.
    assert credenciales.read_bytes() != plano
    assert b"antiguo" not in credenciales.read_bytes()


def testSinCredencialesNoSePermiteElAcceso(datosAislados, monkeypatch):
    """El fallback nunca puede ser admin/admin ni "deja pasar a todos"."""
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", datosAislados["auth"])
    monkeypatch.delenv("LOGIN_USERNAME", raising=False)
    monkeypatch.delenv("LOGIN_PASSWORD_HASH", raising=False)

    usuario, passwordHash = auth._loadCredentials()

    assert usuario == "__no_user__"
    from werkzeug.security import check_password_hash
    for intento in ("", "admin", "password", "__no_user__"):
        assert not check_password_hash(passwordHash, intento)


# ── Cambio de credenciales ───────────────────────────────────────────────────

@pytest.fixture
def clienteDentro(clienteAutenticado, credenciales, monkeypatch):
    from routes.auth import authBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(authBp)
    return client, cabeceras


def testCambiarContraseniaExigeLaActual(clienteDentro):
    client, cabeceras = clienteDentro
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": "la que no es", "newPassword": "nueva-clave-larga"},
        headers=cabeceras,
    )

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testCambiarContraseniaConLaActualCorrecta(clienteDentro, credenciales):
    from routes import auth

    client, cabeceras = clienteDentro
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": "nueva-clave-larga"},
        headers=cabeceras,
    )

    assert respuesta.status_code == 200
    from werkzeug.security import check_password_hash
    _usuario, nuevoHash = auth._loadCredentials()
    assert check_password_hash(nuevoHash, "nueva-clave-larga")


def testNoSeAdmiteUnaContraseniaVacia(clienteDentro):
    client, cabeceras = clienteDentro
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": ""},
        headers=cabeceras,
    )

    assert respuesta.status_code == 400


def testCambiarUsuarioConservaElHashDeLaContrasenia(clienteDentro):
    from routes import auth

    client, cabeceras = clienteDentro
    _usuario, hashPrevio = auth._loadCredentials()

    respuesta = client.post(
        "/api/settings/credentials/username",
        json={"currentPassword": CLAVE, "newUsername": "nuevo"},
        headers=cabeceras,
    )

    assert respuesta.status_code == 200
    usuario, hashNuevo = auth._loadCredentials()
    assert usuario == "nuevo"
    assert hashNuevo == hashPrevio


def testCambiarCredencialesSinSesionEs401(crearApp, credenciales):
    from routes.auth import authBp

    client = crearApp(authBp).test_client()
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": "otra-clave-larga"},
    )

    assert respuesta.status_code == 401


def testCambiarCredencialesSinCsrfEs403(clienteAutenticado, credenciales):
    from routes.auth import authBp

    client, _cabeceras, _app = clienteAutenticado(authBp)
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": "otra-clave-larga"},
    )

    assert respuesta.status_code == 403


# ── Avisos por Telegram ──────────────────────────────────────────────────────

@pytest.fixture
def telegram(credenciales, monkeypatch):
    """Telegram configurado sobre las rutas aisladas; devuelve lo que se enviaría."""
    from core import telegram_notifier

    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    yield mensajes
    telegram_notifier.reiniciarParaPruebas()


def testElBloqueoDeUnaIpSeCuentaUnaSolaVez(cliente, telegram, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "3")
    ip = {"REMOTE_ADDR": "192.168.1.99"}

    for _ in range(6):
        cliente.post("/login", data={"username": USUARIO, "password": "mal"}, environ_base=ip)

    assert len(telegram) == 1
    assert "192.168.1.99" in telegram[0] and "bloqueado" in telegram[0].lower()


def testLosFallosSueltosNoAvisan(cliente, telegram, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "5")

    for _ in range(4):
        cliente.post("/login", data={"username": USUARIO, "password": "mal"})

    assert telegram == []


def testElLoginCorrectoSoloAvisaSiSeHaPedido(cliente, telegram, datosAislados):
    cliente.post("/login", data={"username": USUARIO, "password": CLAVE})
    assert telegram == [], "por defecto avisar de cada login sería ruido"

    datosAislados["ajustes"].write_text(json.dumps({"telegramAvisos": {"sesion": True}}), "utf-8")
    with cliente.session_transaction() as sesion:
        sesion.clear()
    cliente.post("/login", data={"username": USUARIO, "password": CLAVE})

    assert len(telegram) == 1 and "Inicio de sesión" in telegram[0]


def testCambiarLaContraseniaSeCuenta(clienteDentro, telegram):
    client, cabeceras = clienteDentro
    client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": "nueva-clave-larga"},
        headers=cabeceras,
    )

    assert len(telegram) == 1 and "contraseña" in telegram[0]


def testUnaContraseniaActualIncorrectaNoAvisaDelCambio(clienteDentro, telegram):
    client, cabeceras = clienteDentro
    client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": "mal", "newPassword": "nueva-clave-larga"},
        headers=cabeceras,
    )

    assert telegram == []


def _registro():
    """El registro de intentos de login tal como lo ven todos los workers."""
    from routes import auth

    ruta = auth._ficheroIntentos()
    return json.loads(ruta.read_text("utf-8")) if ruta.exists() else {}
