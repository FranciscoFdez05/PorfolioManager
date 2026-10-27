"""Pruebas del alta de la primera cuenta desde la web (/setup).

/setup es pública por fuerza (aún no hay sesión), así que lo que se comprueba
sobre todo es que solo atiende sin ninguna credencial, que sin el código del
servidor no crea nada y que un error en el formulario no obliga a empezar de
cero.
"""

import pytest

from core import alta_inicial

USUARIO = "francisco"
CLAVE = "una-contraseña-larga-de-prueba"


@pytest.fixture
def sinCuenta(datosAislados, monkeypatch):
    """Instalación sin auth.dat ni credenciales en el entorno."""
    from routes import auth

    monkeypatch.setattr(auth, "_AUTH_FILE", datosAislados["auth"])
    monkeypatch.delenv("LOGIN_USERNAME", raising=False)
    monkeypatch.delenv("LOGIN_PASSWORD_HASH", raising=False)
    monkeypatch.setenv("HASH_ITERACIONES", "100000")
    auth._attempts.clear()
    return datosAislados["auth"]


@pytest.fixture
def cliente(crearApp, sinCuenta):
    from routes.auth import authBp

    return crearApp(authBp).test_client()


def _alta(cliente, codigo, usuario=USUARIO, clave=CLAVE, repetida=None):
    return cliente.post("/setup", data={
        "codigo": codigo, "username": usuario,
        "password": clave, "password2": clave if repetida is None else repetida,
    })


# ── Código ────────────────────────────────────────────────────────────────────

def testElCodigoSeCreaUnaVezYSeReutiliza(datosAislados):
    primero = alta_inicial.obtenerCodigo()

    assert alta_inicial.obtenerCodigo() == primero
    assert len(alta_inicial.normalizar(primero)) == alta_inicial.LARGO
    assert set(alta_inicial.normalizar(primero)) <= set(alta_inicial.ALFABETO)


def testElCodigoNoDistingueMayusculasNiGuiones(datosAislados):
    codigo = alta_inicial.obtenerCodigo()

    assert alta_inicial.coincide(codigo.lower().replace("-", " "))
    assert not alta_inicial.coincide("")
    assert not alta_inicial.coincide(None)


def testSinCodigoGuardadoNadaCoincide(datosAislados):
    assert not alta_inicial.coincide("")
    assert not alta_inicial.coincide("ABCD-EFGH-JKMN")


def testConsumirBorraElCodigo(datosAislados):
    codigo = alta_inicial.obtenerCodigo()
    alta_inicial.consumir()

    assert not alta_inicial.ruta().exists()
    assert not alta_inicial.coincide(codigo)
    alta_inicial.consumir()  # sin fichero no falla


def testUnFicheroCorruptoSeSustituye(datosAislados):
    alta_inicial.ruta().parent.mkdir(parents=True, exist_ok=True)
    alta_inicial.ruta().write_text("basura", "utf-8")

    codigo = alta_inicial.obtenerCodigo()

    assert len(alta_inicial.normalizar(codigo)) == alta_inicial.LARGO


# ── /setup y /login ───────────────────────────────────────────────────────────

def testLoginSinCuentaLlevaAlAlta(cliente):
    respuesta = cliente.get("/login")

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"].endswith("/setup")


def testElAltaCreaLaCuentaYAbreSesion(cliente):
    from routes import auth

    cliente.get("/setup")
    respuesta = _alta(cliente, alta_inicial.obtenerCodigo())

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"] == "/"
    assert auth._loadCredentials()[0] == USUARIO
    assert not alta_inicial.ruta().exists()
    with cliente.session_transaction() as sesion:
        assert sesion["logged_in"] is True


def testConCodigoIncorrectoNoSeCreaNada(cliente, sinCuenta):
    alta_inicial.obtenerCodigo()
    respuesta = _alta(cliente, "ABCD-EFGH-JKMN")

    assert respuesta.status_code == 200
    assert "no es correcto" in respuesta.get_data(as_text=True)
    assert not sinCuenta.exists()


def testProbarCodigosAgotaLosIntentosDeLaIp(cliente, sinCuenta):
    """Sin esto el código se podría adivinar a fuerza bruta."""
    from core import settings

    codigo = alta_inicial.obtenerCodigo()
    for _ in range(settings.maxIntentosLogin()):
        _alta(cliente, "ABCD-EFGH-JKMN")

    respuesta = _alta(cliente, codigo)

    assert "Demasiados intentos" in respuesta.get_data(as_text=True)
    assert not sinCuenta.exists()


def testTrasUnErrorSeVuelveAPedirSinPerderLoEscrito(cliente, sinCuenta):
    codigo = alta_inicial.obtenerCodigo()

    respuesta = _alta(cliente, codigo, repetida="otra-cosa-distinta")
    texto = respuesta.get_data(as_text=True)

    assert respuesta.status_code == 200
    assert "no coinciden" in texto
    assert f'value="{codigo}"' in texto
    assert f'value="{USUARIO}"' in texto
    assert not sinCuenta.exists()
    # Y el segundo intento, corregido, funciona sin reiniciar nada.
    assert _alta(cliente, codigo).status_code == 302
    assert sinCuenta.exists()


@pytest.mark.parametrize("usuario, clave, motivo", [
    ("", CLAVE, "vacío"),
    ("x" * 65, CLAVE, "64"),
    (USUARIO, "corta", "al menos"),
    (USUARIO, "x" * 257, "demasiado larga"),
])
def testValidaUsuarioYContrasena(cliente, sinCuenta, usuario, clave, motivo):
    respuesta = _alta(cliente, alta_inicial.obtenerCodigo(), usuario=usuario, clave=clave)

    assert motivo in respuesta.get_data(as_text=True)
    assert not sinCuenta.exists()


def testUnUsuarioConHtmlSeEscapa(cliente):
    respuesta = _alta(cliente, "MAL", usuario='"><script>x</script>')

    assert "<script>x</script>" not in respuesta.get_data(as_text=True)


def testConCuentaYaCreadaElAltaNoAtiende(cliente, sinCuenta):
    codigo = alta_inicial.obtenerCodigo()
    _alta(cliente, codigo)

    otro = cliente.application.test_client()
    respuesta = _alta(otro, codigo, usuario="intruso")

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"].endswith("/login")
    from routes import auth
    assert auth._loadCredentials()[0] == USUARIO


def testUnAuthIlegibleNoAbreElAlta(cliente, sinCuenta):
    """Con la SECRET_KEY cambiada auth.dat no se lee, pero la cuenta existe."""
    sinCuenta.write_bytes(b"cifrado-con-otra-clave")

    assert cliente.get("/setup").headers["Location"].endswith("/login")


def testConCredencialesEnElEntornoElAltaNoAtiende(cliente, monkeypatch):
    monkeypatch.setenv("LOGIN_USERNAME", "admin")
    monkeypatch.setenv("LOGIN_PASSWORD_HASH", "pbkdf2:sha256:1$a$b")

    assert cliente.get("/setup").headers["Location"].endswith("/login")


def testDesdeOtroOrigenSeRechaza(cliente):
    respuesta = cliente.post("/setup", data={"codigo": "x"}, headers={"Origin": "http://evil.example"})

    assert respuesta.status_code == 403


def testPrepararAltaInicialSoloCreaCodigoSinCuenta(sinCuenta):
    from routes import auth

    auth.prepararAltaInicial()
    assert alta_inicial.ruta().exists()

    alta_inicial.consumir()
    sinCuenta.write_bytes(b"cuenta")
    auth.prepararAltaInicial()
    assert not alta_inicial.ruta().exists()
