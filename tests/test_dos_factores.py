"""Pruebas de la verificación en dos pasos por Telegram.

Cubren el módulo `core.dos_factores` (frase, retos, caducidad, intentos) y el
flujo HTTP completo: login con código, con frase de recuperación, activación y
desactivación desde Ajustes. Telegram se sustituye por un buzón en memoria: lo
que se prueba es qué se manda y cuándo, no la API de Telegram.
"""

import re

import pytest
from werkzeug.security import generate_password_hash

USUARIO = "francisco"
CLAVE = "una-contraseña-larga-de-prueba"
CSRF = "token-csrf-de-pruebas"


class Buzon:
    """Sustituto de Telegram: guarda los mensajes y puede simular una caída."""

    def __init__(self):
        self.mensajes = []
        self.avisos = []
        self.caido = False

    def responder(self, texto: str) -> bool:
        if self.caido:
            return False
        self.mensajes.append(texto)
        return True

    def notificar(self, categoria: str, texto: str, **_kwargs) -> bool:
        self.avisos.append((categoria, texto))
        return True

    def ultimoCodigo(self) -> str:
        return re.search(r"\b(\d{6})\b", self.mensajes[-1]).group(1)


@pytest.fixture
def buzon(monkeypatch):
    from core import telegram_notifier

    falso = Buzon()
    monkeypatch.setattr(telegram_notifier, "responder", falso.responder)
    monkeypatch.setattr(telegram_notifier, "notificar", falso.notificar)
    monkeypatch.setattr(telegram_notifier, "configurado", lambda: True)
    return falso


@pytest.fixture
def entorno(datosAislados, monkeypatch, buzon):
    """Datos aislados, hash barato y Telegram falso."""
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    # Mismo motivo que en test_auth_http.py: lo que se prueba es el flujo, no
    # la dureza del hash, y con 600.000 iteraciones la suite se alarga.
    monkeypatch.setenv("HASH_ITERACIONES", "100000")
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    return datosAislados


@pytest.fixture
def cliente(crearApp, entorno, monkeypatch):
    from routes import auth
    from routes.auth import authBp

    monkeypatch.setattr(auth, "_AUTH_FILE", entorno["auth"])
    auth._saveCredentials(USUARIO, generate_password_hash(CLAVE, method="pbkdf2:sha256:100000"))
    auth._attempts.clear()
    return crearApp(authBp).test_client()


def _entrarEnAjustes(client):
    from core import sesion

    with client.session_transaction() as s:
        s["logged_in"] = True
        s["csrf_token"] = CSRF
        sesion.abrir(s)
    return {"X-CSRF-Token": CSRF}


def _activarConFrase(frase: str = "ábaco abeja abdomen abierto abismo abogado"):
    from core import dos_factores

    dos_factores.activar(dos_factores.hashFrase(frase))
    return frase


def _login(client):
    return client.post("/login", data={"username": USUARIO, "password": CLAVE})


# ── Frase de recuperación ─────────────────────────────────────────────────────

@pytest.mark.parametrize("largo", [6, 12, 24])
def testLaFraseTieneLasPalabrasPedidasDeLaLista(largo):
    from core import dos_factores

    frase = dos_factores.generarFrase(largo)

    palabras = frase.split(" ")
    assert len(palabras) == largo
    assert set(palabras) <= set(dos_factores._palabras())


@pytest.mark.parametrize("largo", [0, 5, 13, 25])
def testUnLargoNoPermitidoSeRechaza(largo):
    from core import dos_factores

    with pytest.raises(ValueError):
        dos_factores.generarFrase(largo)


def testLaListaTieneLas2048PalabrasYSonDistintasSinTildes():
    from core import dos_factores

    palabras = dos_factores._palabras()
    assert len(palabras) == 2048
    assert len({dos_factores.normalizarFrase(p) for p in palabras}) == 2048


def testLaFraseSeComparaSinTildesNiMayusculasNiEspacios(entorno):
    from core import dos_factores

    fraseHash = dos_factores.hashFrase("ábaco abeja")

    assert dos_factores.fraseCoincide("  ABACO   abeja \n", fraseHash)
    assert not dos_factores.fraseCoincide("abeja ábaco", fraseHash)
    assert not dos_factores.fraseCoincide("", fraseHash)


def testElEstadoSeGuardaCifrado(entorno):
    from core import dos_factores

    _activarConFrase()

    crudo = (entorno["auth"].parent / "dos_factores.dat").read_bytes()
    assert b"fraseHash" not in crudo
    assert dos_factores.activa()


def testUnEstadoIlegibleCuentaComoDesactivada(entorno):
    from core import dos_factores

    (entorno["auth"].parent / "dos_factores.dat").write_bytes(b"basura")

    assert dos_factores.activa() is False


# ── Retos ─────────────────────────────────────────────────────────────────────

def testElCodigoCorrectoSeConsumeUnaSolaVez(entorno, buzon):
    from core import dos_factores

    retoId, enviado = dos_factores.crearReto("login", {"x": 1})
    codigo = buzon.ultimoCodigo()

    assert enviado
    assert dos_factores.comprobarCodigo(retoId, "login", codigo) == {"x": 1}
    with pytest.raises(dos_factores.RetoInvalido):
        dos_factores.comprobarCodigo(retoId, "login", codigo)


def testUnCodigoDeOtroPropositoNoVale(entorno, buzon):
    from core import dos_factores

    retoId, _ = dos_factores.crearReto("desactivar")

    with pytest.raises(dos_factores.RetoInvalido):
        dos_factores.comprobarCodigo(retoId, "login", buzon.ultimoCodigo())


def testAgotarLosIntentosAnulaElReto(entorno, buzon, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("INTENTOS_CODIGO_2FA", "3")
    retoId, _ = dos_factores.crearReto("login")
    codigo = buzon.ultimoCodigo()
    malo = "000000" if codigo != "000000" else "111111"

    for _ in range(2):
        with pytest.raises(dos_factores.CodigoIncorrecto):
            dos_factores.comprobarCodigo(retoId, "login", malo)
    with pytest.raises(dos_factores.RetoInvalido):
        dos_factores.comprobarCodigo(retoId, "login", malo)
    # Ni el código bueno sirve ya.
    with pytest.raises(dos_factores.RetoInvalido):
        dos_factores.comprobarCodigo(retoId, "login", codigo)


def testUnCodigoCaducadoNoVale(entorno, buzon, monkeypatch):
    from core import dos_factores

    retoId, _ = dos_factores.crearReto("login")
    codigo = buzon.ultimoCodigo()
    ahora = dos_factores.time.time()
    monkeypatch.setattr(dos_factores.time, "time", lambda: ahora + 3600)

    with pytest.raises(dos_factores.RetoInvalido):
        dos_factores.comprobarCodigo(retoId, "login", codigo)


def testReenviarAntesDeTiempoSeRechazaYDespuesInvalidaElAnterior(entorno, buzon, monkeypatch):
    from core import dos_factores

    retoId, _ = dos_factores.crearReto("login")
    primero = buzon.ultimoCodigo()

    with pytest.raises(dos_factores.EsperaReenvio):
        dos_factores.reenviar(retoId, "login")

    ahora = dos_factores.time.time()
    monkeypatch.setattr(dos_factores.time, "time", lambda: ahora + 61)
    assert dos_factores.reenviar(retoId, "login")
    segundo = buzon.ultimoCodigo()

    if primero != segundo:
        with pytest.raises(dos_factores.CodigoIncorrecto):
            dos_factores.comprobarCodigo(retoId, "login", primero)
    assert dos_factores.comprobarCodigo(retoId, "login", segundo) == {}


def testLosReenviosTienenTope(entorno, buzon, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("REENVIO_2FA_SEGUNDOS", "0")
    retoId, _ = dos_factores.crearReto("login")
    for _ in range(dos_factores.MAX_ENVIOS_POR_RETO - 1):
        dos_factores.reenviar(retoId, "login")

    with pytest.raises(dos_factores.RetoInvalido):
        dos_factores.reenviar(retoId, "login")


# ── Login con la 2FA activa ───────────────────────────────────────────────────

def testSinDosFactoresElLoginNoCambia(cliente, buzon):
    respuesta = _login(cliente)

    assert respuesta.headers["Location"] == "/"
    assert buzon.mensajes == []


def testLaContrasenaCorrectaNoAbreSesionYMandaElCodigo(cliente, buzon):
    _activarConFrase()

    respuesta = _login(cliente)

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"].endswith("/login/2fa")
    assert len(buzon.mensajes) == 1
    with cliente.session_transaction() as s:
        assert not s.get("logged_in")
    # Sin sesión, la aplicación sigue cerrada.
    assert cliente.get("/api/settings/2fa").status_code == 401


def testElCodigoCorrectoAbreLaSesion(cliente, buzon):
    _activarConFrase()
    _login(cliente)

    respuesta = cliente.post("/login/2fa", data={"accion": "codigo", "codigo": buzon.ultimoCodigo()})

    assert respuesta.headers["Location"] == "/"
    with cliente.session_transaction() as s:
        assert s["logged_in"] is True
        assert "reto2fa" not in s


def testElCodigoIncorrectoCuentaComoIntentoFallido(cliente, buzon):
    from routes import auth

    _activarConFrase()
    _login(cliente)
    codigo = buzon.ultimoCodigo()
    malo = "000000" if codigo != "000000" else "111111"

    respuesta = cliente.post("/login/2fa", data={"accion": "codigo", "codigo": malo})

    assert respuesta.status_code == 200
    assert "Código incorrecto" in respuesta.get_data(as_text=True)
    with auth._intentos() as intentos:
        assert intentos["127.0.0.1"][0] == 1


def testLaContrasenaCorrectaNoBorraLosFallosDeCodigo(cliente, buzon):
    """Si el login limpiase los fallos, repetirlo daría intentos de código sin fin."""
    from routes import auth

    _activarConFrase()
    _login(cliente)
    cliente.post("/login/2fa", data={"accion": "codigo", "codigo": "abcdef"})
    _login(cliente)

    with auth._intentos() as intentos:
        assert intentos["127.0.0.1"][0] == 1


def testLaFraseAbreSesionYDesactivaLaDosFactores(cliente, buzon):
    from core import dos_factores

    frase = _activarConFrase()
    _login(cliente)

    respuesta = cliente.post("/login/2fa?modo=frase", data={"accion": "frase", "frase": frase.upper()})

    assert respuesta.headers["Location"] == "/"
    assert dos_factores.activa() is False
    assert any(c == "seguridad" and "frase de recuperación" in t for c, t in buzon.avisos)


def testUnaFraseIncorrectaNoEntra(cliente, buzon):
    from core import dos_factores

    _activarConFrase()
    _login(cliente)

    respuesta = cliente.post("/login/2fa", data={"accion": "frase", "frase": "esto no es"})

    assert "no es correcta" in respuesta.get_data(as_text=True)
    assert dos_factores.activa()
    with cliente.session_transaction() as s:
        assert not s.get("logged_in")


def testSinTelegramSeAvisaYQuedaLaFrase(cliente, buzon):
    _activarConFrase()
    buzon.caido = True

    _login(cliente)
    pagina = cliente.get("/login/2fa").get_data(as_text=True)

    assert "No se ha podido enviar el código" in pagina


def testElSegundoPasoSinRetoVuelveAlLogin(cliente):
    respuesta = cliente.get("/login/2fa")

    assert respuesta.status_code == 302
    assert respuesta.headers["Location"].endswith("/login")


def testElSegundoPasoRechazaOtroOrigen(cliente, buzon):
    _activarConFrase()
    _login(cliente)

    respuesta = cliente.post("/login/2fa", data={"accion": "codigo", "codigo": buzon.ultimoCodigo()},
                             headers={"Origin": "https://evil.example"})

    assert respuesta.status_code == 403


def testElNextSeConservaTrasElSegundoPaso(cliente, buzon):
    _activarConFrase()
    cliente.post("/login?next=/html/sesion/ajustes.html", data={"username": USUARIO, "password": CLAVE})

    respuesta = cliente.post("/login/2fa", data={"accion": "codigo", "codigo": buzon.ultimoCodigo()})

    assert respuesta.headers["Location"] == "/html/sesion/ajustes.html"


# ── Ajustes: activar y desactivar ─────────────────────────────────────────────

def testActivarDesdeAjustes(cliente, buzon):
    from core import dos_factores

    cabeceras = _entrarEnAjustes(cliente)
    inicio = cliente.post("/api/settings/2fa/activar/iniciar",
                          json={"currentPassword": CLAVE, "palabras": 6}, headers=cabeceras)
    frase = inicio.get_json()["frase"]

    assert inicio.status_code == 200
    assert len(frase.split()) == 6
    assert not dos_factores.activa()

    confirmar = cliente.post("/api/settings/2fa/activar/confirmar",
                             json={"codigo": buzon.ultimoCodigo(), "frase": frase}, headers=cabeceras)

    assert confirmar.status_code == 200
    assert dos_factores.activa()
    assert dos_factores.fraseGuardadaCoincide(frase)


def testActivarExigeLaContrasena(cliente, buzon):
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = cliente.post("/api/settings/2fa/activar/iniciar",
                             json={"currentPassword": "otra", "palabras": 12}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert buzon.mensajes == []


@pytest.mark.parametrize("palabras", [7, "12", True, 12.0, None])
def testActivarRechazaUnLargoInvalido(cliente, palabras):
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = cliente.post("/api/settings/2fa/activar/iniciar",
                             json={"currentPassword": CLAVE, "palabras": palabras}, headers=cabeceras)

    assert respuesta.status_code == 400


def testActivarSinTelegramSeRechaza(cliente, monkeypatch):
    from core import telegram_notifier

    monkeypatch.setattr(telegram_notifier, "configurado", lambda: False)
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = cliente.post("/api/settings/2fa/activar/iniciar",
                             json={"currentPassword": CLAVE, "palabras": 12}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert "Telegram" in respuesta.get_json()["error"]


def testUnaFraseMalCopiadaNoGastaElCodigo(cliente, buzon):
    from core import dos_factores

    cabeceras = _entrarEnAjustes(cliente)
    frase = cliente.post("/api/settings/2fa/activar/iniciar",
                         json={"currentPassword": CLAVE, "palabras": 6}, headers=cabeceras).get_json()["frase"]
    codigo = buzon.ultimoCodigo()

    mal = cliente.post("/api/settings/2fa/activar/confirmar",
                       json={"codigo": codigo, "frase": "otra cosa"}, headers=cabeceras)
    bien = cliente.post("/api/settings/2fa/activar/confirmar",
                        json={"codigo": codigo, "frase": frase}, headers=cabeceras)

    assert mal.status_code == 400
    assert bien.status_code == 200
    assert dos_factores.activa()


def testDesactivarConCodigo(cliente, buzon):
    from core import dos_factores

    _activarConFrase()
    cabeceras = _entrarEnAjustes(cliente)
    assert cliente.post("/api/settings/2fa/codigo", headers=cabeceras).status_code == 200

    respuesta = cliente.post("/api/settings/2fa/desactivar",
                             json={"currentPassword": CLAVE, "codigo": buzon.ultimoCodigo()}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert not dos_factores.activa()


def testDesactivarConFrase(cliente, buzon):
    from core import dos_factores

    frase = _activarConFrase()
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = cliente.post("/api/settings/2fa/desactivar",
                             json={"currentPassword": CLAVE, "frase": frase}, headers=cabeceras)

    assert respuesta.status_code == 200
    assert not dos_factores.activa()


def testDesactivarSoloConLaContrasenaNoBasta(cliente, buzon):
    from core import dos_factores

    _activarConFrase()
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = cliente.post("/api/settings/2fa/desactivar",
                             json={"currentPassword": CLAVE}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert dos_factores.activa()


def testPedirOtroCodigoParaDesactivarRespetaLaEspera(cliente, buzon):
    _activarConFrase()
    cabeceras = _entrarEnAjustes(cliente)
    cliente.post("/api/settings/2fa/codigo", headers=cabeceras)

    respuesta = cliente.post("/api/settings/2fa/codigo", headers=cabeceras)

    assert respuesta.status_code == 429
    assert len(buzon.mensajes) == 1


def testNoSeBorraTelegramConLaDosFactoresActiva(clienteAutenticado, entorno, buzon):
    from routes.ajustes import ajustesBp

    _activarConFrase()
    client, cabeceras, _app = clienteAutenticado(ajustesBp)

    respuesta = client.delete("/api/settings/telegram", headers=cabeceras)

    assert respuesta.status_code == 409
