"""Pruebas de /login, /logout y el cambio de credenciales.

`routes/auth.py` es la única puerta de la aplicación y no la cubría ningún test:
el bloqueo por IP, el cifrado de auth.dat y la validación del parámetro `next`
son código con historia (cada uno arregla un fallo concreto) que hasta ahora
solo se podía comprobar a mano.

`datos_aislados` mueve AUTH_FILE a tmp_path, así que ningún caso escribe sobre
las credenciales reales de quien lance la suite.
"""

import json

import pytest
from werkzeug.security import generate_password_hash

USUARIO = "francisco"
CLAVE = "una-contraseña-larga-de-prueba"


@pytest.fixture
def credenciales(datos_aislados, monkeypatch):
    """Escribe unas credenciales conocidas en el AUTH_FILE aislado."""
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", datos_aislados["auth"])
    # De SECRET_KEY sale el Fernet con el que se cifra auth.dat. Sin ella el
    # fichero se guarda en claro (comportamiento deliberado, para no dejar fuera
    # a quien aún no la tenga configurada), así que aquí hay que fijarla o los
    # tests de cifrado estarían comprobando el camino degradado.
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    # pbkdf2 con 600.000 iteraciones tarda ~0,3 s por comprobación; varios tests
    # hacen una decena de intentos y la suite se iría a varios segundos sin nada
    # a cambio: lo que se prueba es el flujo, no la dureza del hash.
    monkeypatch.setenv("HASH_ITERACIONES", "100000")

    auth._save_credentials(USUARIO, generate_password_hash(CLAVE, method="pbkdf2:sha256:100000"))
    return datos_aislados["auth"]


@pytest.fixture
def cliente(crear_app, credenciales, monkeypatch):
    from routes.auth import auth_bp

    # El limitador de escrituras no cubre /login (tiene su propio bloqueo), pero
    # sí los endpoints de cambio de credenciales.
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    # Registro de intentos limpio: es estado global del módulo y, sin esto, el
    # primer test que agota los intentos dejaría bloqueados a los siguientes.
    from routes import auth
    auth._attempts.clear()

    app = crear_app(auth_bp)
    return app.test_client()


# ── Login ────────────────────────────────────────────────────────────────────

def test_login_correcto_abre_sesion(cliente):
    respuesta = cliente.post("/login", data={"username": USUARIO, "password": CLAVE})

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"] == "/"
    with cliente.session_transaction() as sesion:
        assert sesion["logged_in"] is True


def test_credenciales_incorrectas_no_abren_sesion(cliente):
    respuesta = cliente.post("/login", data={"username": USUARIO, "password": "otra"})

    assert respuesta.status_code == 200          # vuelve a pintar el formulario
    assert "incorrectos" in respuesta.get_data(as_text=True)
    with cliente.session_transaction() as sesion:
        assert not sesion.get("logged_in")


def test_el_error_no_distingue_usuario_de_contrasenia(cliente):
    """Decir cuál de los dos falla confirma qué usuarios existen."""
    con_usuario_malo = cliente.post("/login", data={"username": "nadie", "password": CLAVE})
    con_clave_mala = cliente.post("/login", data={"username": USUARIO, "password": "no"})

    assert "incorrectos" in con_usuario_malo.get_data(as_text=True)
    assert "incorrectos" in con_clave_mala.get_data(as_text=True)


def test_un_usuario_con_acentos_no_provoca_un_500(cliente):
    """`compare_digest` sobre str lanza TypeError con caracteres no ASCII.

    Además de devolver 500, ese camino se saltaba el registro del intento
    fallido, así que no contaba para el bloqueo por IP.
    """
    respuesta = cliente.post("/login", data={"username": "ñandú", "password": CLAVE})

    assert respuesta.status_code == 200
    from routes import auth
    assert auth._attempts  # el intento sí quedó registrado


def test_la_pagina_de_login_no_se_guarda_en_cache(cliente):
    """Sin esto, el botón "atrás" la mostraba desde la bfcache ya con sesión."""
    cabeceras = cliente.get("/login").headers

    assert "no-store" in cabeceras["Cache-Control"]


def test_con_sesion_abierta_login_devuelve_a_la_aplicacion(cliente):
    with cliente.session_transaction() as sesion:
        sesion["logged_in"] = True

    respuesta = cliente.get("/login")

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"] == "/"


def test_logout_cierra_la_sesion(cliente):
    with cliente.session_transaction() as sesion:
        sesion["logged_in"] = True

    respuesta = cliente.get("/logout")

    assert respuesta.status_code == 302
    with cliente.session_transaction() as sesion:
        assert not sesion.get("logged_in")


# ── Destino tras el login (?next) ────────────────────────────────────────────

@pytest.mark.parametrize("destino", [
    "https://evil.com",
    "//evil.com",
    r"/\evil.com",        # los navegadores lo normalizan a //evil.com
    "http://evil.com/x",
    "javascript:alert(1)",
])
def test_next_externo_se_descarta(cliente, destino):
    """Un redirect abierto convierte el login en una página de phishing."""
    respuesta = cliente.post(
        f"/login?next={destino}", data={"username": USUARIO, "password": CLAVE},
    )
    assert respuesta.headers["Location"] == "/"


@pytest.mark.parametrize("destino", ["/metricas", "/html/analisis/metricas.html", "/?tab=activos"])
def test_next_interno_se_respeta(cliente, destino):
    respuesta = cliente.post(
        f"/login?next={destino}", data={"username": USUARIO, "password": CLAVE},
    )
    assert respuesta.headers["Location"] == destino


# ── Bloqueo por IP ───────────────────────────────────────────────────────────

def test_tras_agotar_los_intentos_la_ip_queda_bloqueada(cliente, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "3")
    ip = {"REMOTE_ADDR": "192.168.1.99"}

    for _ in range(3):
        cliente.post("/login", data={"username": USUARIO, "password": "mal"}, environ_base=ip)

    # Incluso con la contraseña correcta: el bloqueo se comprueba antes.
    respuesta = cliente.post("/login", data={"username": USUARIO, "password": CLAVE}, environ_base=ip)

    assert "Demasiados intentos" in respuesta.get_data(as_text=True)
    with cliente.session_transaction() as sesion:
        assert not sesion.get("logged_in")


def test_el_bloqueo_es_por_ip(cliente, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "2")

    for _ in range(3):
        cliente.post("/login", data={"username": USUARIO, "password": "mal"},
                     environ_base={"REMOTE_ADDR": "192.168.1.99"})

    otra = cliente.post("/login", data={"username": USUARIO, "password": CLAVE},
                        environ_base={"REMOTE_ADDR": "192.168.1.100"})

    assert otra.status_code == 302
    assert otra.headers["Location"] == "/"


def test_un_login_correcto_limpia_los_fallos_previos(cliente, monkeypatch):
    monkeypatch.setenv("MAX_INTENTOS_LOGIN", "3")
    ip = {"REMOTE_ADDR": "192.168.1.101"}

    cliente.post("/login", data={"username": USUARIO, "password": "mal"}, environ_base=ip)
    cliente.post("/login", data={"username": USUARIO, "password": CLAVE}, environ_base=ip)

    from routes import auth
    assert "192.168.1.101" not in auth._attempts


def test_el_registro_de_intentos_no_crece_sin_limite(monkeypatch):
    """Con IPs falsificadas el diccionario sería un consumo de memoria abierto."""
    import time

    from routes import auth

    monkeypatch.setenv("MAX_IPS_VIGILADAS", "20")
    monkeypatch.setenv("BLOQUEO_SEGUNDOS", "1")
    auth._attempts.clear()

    for i in range(30):
        auth._attempts[f"10.0.0.{i}"] = [1, time.monotonic() - 100]  # ya caducados
    auth._record_failure("10.9.9.9")

    assert len(auth._attempts) < 30


# ── Almacenamiento de credenciales ───────────────────────────────────────────

def test_auth_dat_se_guarda_cifrado(credenciales):
    """El fichero está dentro de data/, que acaba en los backups y en los zips."""
    crudo = credenciales.read_bytes()

    assert USUARIO.encode() not in crudo
    # Cifrado con Fernet: el contenido ya no es JSON legible.
    with pytest.raises(json.JSONDecodeError):
        json.loads(crudo)


def test_un_auth_dat_en_texto_plano_se_migra_al_leerlo(credenciales, monkeypatch):
    """Instalaciones anteriores a que existiera el cifrado deben seguir entrando."""
    from routes import auth

    plano = json.dumps({"username": "antiguo", "password_hash": "hash-cualquiera"}).encode()
    credenciales.write_bytes(plano)

    usuario, _hash = auth._load_credentials()

    assert usuario == "antiguo"
    # Y al leerlo se ha reescrito ya cifrado, sin pedirle nada al usuario.
    assert credenciales.read_bytes() != plano
    assert b"antiguo" not in credenciales.read_bytes()


def test_sin_credenciales_no_se_permite_el_acceso(datos_aislados, monkeypatch):
    """El fallback nunca puede ser admin/admin ni "deja pasar a todos"."""
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", datos_aislados["auth"])
    monkeypatch.delenv("LOGIN_USERNAME", raising=False)
    monkeypatch.delenv("LOGIN_PASSWORD_HASH", raising=False)

    usuario, password_hash = auth._load_credentials()

    assert usuario == "__no_user__"
    from werkzeug.security import check_password_hash
    for intento in ("", "admin", "password", "__no_user__"):
        assert not check_password_hash(password_hash, intento)


# ── Cambio de credenciales ───────────────────────────────────────────────────

@pytest.fixture
def cliente_dentro(cliente_autenticado, credenciales, monkeypatch):
    from routes.auth import auth_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(auth_bp)
    return client, cabeceras


def test_cambiar_contrasenia_exige_la_actual(cliente_dentro):
    client, cabeceras = cliente_dentro
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": "la que no es", "newPassword": "nueva-clave-larga"},
        headers=cabeceras,
    )

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_cambiar_contrasenia_con_la_actual_correcta(cliente_dentro, credenciales):
    from routes import auth

    client, cabeceras = cliente_dentro
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": "nueva-clave-larga"},
        headers=cabeceras,
    )

    assert respuesta.status_code == 200
    from werkzeug.security import check_password_hash
    _usuario, nuevo_hash = auth._load_credentials()
    assert check_password_hash(nuevo_hash, "nueva-clave-larga")


def test_no_se_admite_una_contrasenia_vacia(cliente_dentro):
    client, cabeceras = cliente_dentro
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": ""},
        headers=cabeceras,
    )

    assert respuesta.status_code == 400


def test_cambiar_usuario_conserva_el_hash_de_la_contrasenia(cliente_dentro):
    from routes import auth

    client, cabeceras = cliente_dentro
    _usuario, hash_previo = auth._load_credentials()

    respuesta = client.post(
        "/api/settings/credentials/username",
        json={"currentPassword": CLAVE, "newUsername": "nuevo"},
        headers=cabeceras,
    )

    assert respuesta.status_code == 200
    usuario, hash_nuevo = auth._load_credentials()
    assert usuario == "nuevo"
    assert hash_nuevo == hash_previo


def test_cambiar_credenciales_sin_sesion_es_401(crear_app, credenciales):
    from routes.auth import auth_bp

    client = crear_app(auth_bp).test_client()
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": "otra-clave-larga"},
    )

    assert respuesta.status_code == 401


def test_cambiar_credenciales_sin_csrf_es_403(cliente_autenticado, credenciales):
    from routes.auth import auth_bp

    client, _cabeceras, _app = cliente_autenticado(auth_bp)
    respuesta = client.post(
        "/api/settings/credentials/password",
        json={"currentPassword": CLAVE, "newPassword": "otra-clave-larga"},
    )

    assert respuesta.status_code == 403
