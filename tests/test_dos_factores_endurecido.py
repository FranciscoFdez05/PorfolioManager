"""Pruebas del endurecimiento de la verificación en dos pasos.

- SEC-10: el segundo paso del login caduca y deja de valer si las credenciales
  cambian después de acertar la contraseña, también al entrar con la frase.
- SEC-11: con la 2FA activa, cambiar el bot o el chat de Telegram exige la
  contraseña más un código enviado al chat actual o la frase.
- SEC-12: tope global de fallos de código o frase, independiente de la IP.

Telegram se sustituye por un buzón en memoria, como en test_dos_factores.py.
"""

import re

import pytest
from werkzeug.security import generate_password_hash

USUARIO = "francisco"
CLAVE = "una-contraseña-larga-de-prueba"
CSRF = "token-csrf-de-pruebas"
FRASE = "ábaco abeja abdomen abierto abismo abogado"
TOKEN_ACTUAL = "111111:token-actual"
CHAT_ACTUAL = "1000"


class Buzon:
    """Sustituto de Telegram: guarda lo que se manda y a qué chat iba."""

    def __init__(self):
        self.mensajes = []
        self.avisos = []

    def responder(self, texto: str) -> bool:
        from core import telegram_notifier

        self.mensajes.append((telegram_notifier.leerConfig()[1], texto))
        return True

    def notificar(self, categoria: str, texto: str, **_kwargs) -> bool:
        self.avisos.append((categoria, texto))
        return True

    def ultimoCodigo(self) -> str:
        for _chat, texto in reversed(self.mensajes):
            encontrado = re.search(r"\b(\d{6})\b", texto)
            if encontrado:
                return encontrado.group(1)
        raise AssertionError("No se ha mandado ningún código")


@pytest.fixture
def buzon(monkeypatch):
    from core import telegram_notifier

    falso = Buzon()
    monkeypatch.setattr(telegram_notifier, "responder", falso.responder)
    monkeypatch.setattr(telegram_notifier, "notificar", falso.notificar)
    return falso


@pytest.fixture
def entorno(datosAislados, monkeypatch, buzon):
    """Datos aislados, hash barato, Telegram falso y credenciales en disco."""
    from core import telegram_notifier
    from routes import auth

    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    monkeypatch.setenv("HASH_ITERACIONES", "100000")
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setattr(auth, "_AUTH_FILE", datosAislados["auth"])
    auth._saveCredentials(USUARIO, generate_password_hash(CLAVE, method="pbkdf2:sha256:100000"))
    auth._attempts.clear()
    telegram_notifier.escribirConfig(TOKEN_ACTUAL, CHAT_ACTUAL)
    return datosAislados


@pytest.fixture
def cliente(crearApp, entorno):
    from routes.ajustes import ajustesBp
    from routes.auth import authBp

    return crearApp(authBp, ajustesBp).test_client()


def _activar():
    from core import dos_factores

    dos_factores.activar(dos_factores.hashFrase(FRASE))


def _login(client, ip="127.0.0.1"):
    return client.post("/login", data={"username": USUARIO, "password": CLAVE},
                       environ_base={"REMOTE_ADDR": ip})


def _entrarEnAjustes(client):
    from core import sesion

    with client.session_transaction() as s:
        s["logged_in"] = True
        s["csrf_token"] = CSRF
        sesion.abrir(s)
    return {"X-CSRF-Token": CSRF}


def _adelantarReloj(monkeypatch, segundos):
    """Mueve el reloj de pared que ven auth.py y dos_factores.py."""
    import time as modTime

    ahora = modTime.time()
    monkeypatch.setattr(modTime, "time", lambda: ahora + segundos)


# ── SEC-10: el segundo paso caduca y depende de las credenciales ──────────────

def testLaFraseConElRetoVivoSigueEntrando(cliente, buzon):
    from core import dos_factores

    _activar()
    _login(cliente)

    respuesta = cliente.post("/login/2fa", data={"accion": "frase", "frase": FRASE})

    assert respuesta.headers["Location"] == "/"
    with cliente.session_transaction() as s:
        assert s["logged_in"] is True
    assert dos_factores.activa() is False


def testLaFraseConElRetoCaducadoSeRechaza(cliente, buzon, monkeypatch):
    from core import dos_factores

    _activar()
    _login(cliente)
    # Pasado el código (5 min) pero dentro del plazo del segundo paso (15 min):
    # lo que lo rechaza es el reto, no el plazo.
    _adelantarReloj(monkeypatch, 6 * 60)

    respuesta = cliente.post("/login/2fa", data={"accion": "frase", "frase": FRASE})

    assert respuesta.headers["Location"].endswith("/login")
    with cliente.session_transaction() as s:
        assert not s.get("logged_in")
        assert "reto2fa" not in s
    assert dos_factores.activa()


def testElSegundoPasoFueraDePlazoSeRechazaAunqueElRetoSigaVivo(cliente, buzon, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("SEGUNDO_PASO_MINUTOS", "1")
    _activar()
    _login(cliente)
    _adelantarReloj(monkeypatch, 90)

    respuesta = cliente.post("/login/2fa", data={"accion": "frase", "frase": FRASE})

    assert respuesta.headers["Location"].endswith("/login")
    assert dos_factores.activa()


def testCambiarLaContrasenaTrasElPrimerPasoInvalidaLaCookie(cliente, buzon):
    """El escenario de SEC-10: cookie del primer paso guardada antes del cambio."""
    from core import dos_factores, sesion

    _activar()
    _login(cliente)
    # Lo que hace changePassword (vía _renovarSesiones) desde otra sesión.
    sesion.invalidarTodas()

    conFrase = cliente.post("/login/2fa", data={"accion": "frase", "frase": FRASE})

    assert conFrase.headers["Location"].endswith("/login")
    with cliente.session_transaction() as s:
        assert not s.get("logged_in")
    assert dos_factores.activa()


def testCambiarLaContrasenaTambienInvalidaElCodigo(cliente, buzon):
    from core import sesion

    _activar()
    _login(cliente)
    codigo = buzon.ultimoCodigo()
    sesion.invalidarTodas()

    respuesta = cliente.post("/login/2fa", data={"accion": "codigo", "codigo": codigo})

    assert respuesta.headers["Location"].endswith("/login")
    with cliente.session_transaction() as s:
        assert not s.get("logged_in")


def testUnaCookieDelPrimerPasoSinMarcasSeRechaza(cliente, buzon):
    """Cookies emitidas antes de este control: no se sabe cuándo se acertó la contraseña."""
    from core import dos_factores

    _activar()
    retoId, _ = dos_factores.crearReto("login")
    with cliente.session_transaction() as s:
        s["reto2fa"] = retoId

    respuesta = cliente.post("/login/2fa", data={"accion": "frase", "frase": FRASE})

    assert respuesta.headers["Location"].endswith("/login")
    assert dos_factores.activa()


# ── SEC-11: cambiar el bot de Telegram con la 2FA activa ──────────────────────

def _guardarTelegram(client, cabeceras, **extra):
    cuerpo = {"token": "222222:token-del-atacante", "chatId": "2000", **extra}
    return client.post("/api/settings/telegram", json=cuerpo, headers=cabeceras)


def testSinCredencialesNoSeCambiaElBot(cliente, buzon):
    from core import telegram_notifier

    _activar()
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = _guardarTelegram(cliente, cabeceras)

    assert respuesta.status_code == 403
    assert respuesta.get_json()["requiereVerificacion"] is True
    assert telegram_notifier.leerConfig() == (TOKEN_ACTUAL, CHAT_ACTUAL)


def testSoloConLaContrasenaNoSeCambiaElBot(cliente, buzon):
    from core import telegram_notifier

    _activar()
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = _guardarTelegram(cliente, cabeceras, currentPassword=CLAVE)

    assert respuesta.status_code == 403
    assert telegram_notifier.leerConfig() == (TOKEN_ACTUAL, CHAT_ACTUAL)


def testConContrasenaIncorrectaNoSeCambiaElBot(cliente, buzon):
    from core import telegram_notifier

    _activar()
    cabeceras = _entrarEnAjustes(cliente)
    cliente.post("/api/settings/telegram/codigo", headers=cabeceras)

    respuesta = _guardarTelegram(cliente, cabeceras, currentPassword="otra", codigo=buzon.ultimoCodigo())

    assert respuesta.status_code == 400
    assert telegram_notifier.leerConfig() == (TOKEN_ACTUAL, CHAT_ACTUAL)


def testConCodigoIncorrectoNoSeCambiaElBot(cliente, buzon):
    from core import telegram_notifier

    _activar()
    cabeceras = _entrarEnAjustes(cliente)
    cliente.post("/api/settings/telegram/codigo", headers=cabeceras)
    malo = "000000" if buzon.ultimoCodigo() != "000000" else "111111"

    respuesta = _guardarTelegram(cliente, cabeceras, currentPassword=CLAVE, codigo=malo)

    assert respuesta.status_code == 400
    assert telegram_notifier.leerConfig() == (TOKEN_ACTUAL, CHAT_ACTUAL)


def testConContrasenaYCodigoSeGuardaYSeAvisaAlChatAnterior(cliente, buzon):
    from core import telegram_notifier

    _activar()
    cabeceras = _entrarEnAjustes(cliente)
    assert cliente.post("/api/settings/telegram/codigo", headers=cabeceras).status_code == 200
    chatDelCodigo, _texto = buzon.mensajes[-1]

    respuesta = _guardarTelegram(cliente, cabeceras, currentPassword=CLAVE, codigo=buzon.ultimoCodigo())

    assert respuesta.status_code == 200
    assert chatDelCodigo == CHAT_ACTUAL
    assert telegram_notifier.leerConfig() == ("222222:token-del-atacante", "2000")
    chatAviso, textoAviso = buzon.mensajes[-1]
    assert chatAviso == CHAT_ACTUAL
    assert "Se ha cambiado el bot" in textoAviso


def testConContrasenaYFraseSeGuarda(cliente, buzon):
    """Es la salida cuando el bot actual ya no funciona y el código no llega."""
    from core import dos_factores, telegram_notifier

    _activar()
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = _guardarTelegram(cliente, cabeceras, currentPassword=CLAVE, frase=FRASE)

    assert respuesta.status_code == 200
    assert telegram_notifier.leerConfig() == ("222222:token-del-atacante", "2000")
    assert dos_factores.activa()


def testElCodigoDeDesactivarNoSirveParaCambiarElBot(cliente, buzon):
    from core import telegram_notifier

    _activar()
    cabeceras = _entrarEnAjustes(cliente)
    cliente.post("/api/settings/2fa/codigo", headers=cabeceras)

    respuesta = _guardarTelegram(cliente, cabeceras, currentPassword=CLAVE, codigo=buzon.ultimoCodigo())

    assert respuesta.status_code == 400
    assert telegram_notifier.leerConfig() == (TOKEN_ACTUAL, CHAT_ACTUAL)


def testGuardarSinCambiosNoPideVerificacion(cliente, buzon):
    """«Enviar prueba» guarda antes de probar; con los mismos datos no cambia nada."""
    _activar()
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = cliente.post("/api/settings/telegram", json={"token": "", "chatId": CHAT_ACTUAL},
                             headers=cabeceras)

    assert respuesta.status_code == 200


def testSinDosFactoresSeGuardaComoAntes(cliente, buzon):
    from core import telegram_notifier

    cabeceras = _entrarEnAjustes(cliente)

    respuesta = _guardarTelegram(cliente, cabeceras)

    assert respuesta.status_code == 200
    assert telegram_notifier.leerConfig() == ("222222:token-del-atacante", "2000")
    assert buzon.mensajes == []


def testElCodigoParaCambiarElBotExigeLaDosFactores(cliente, buzon):
    cabeceras = _entrarEnAjustes(cliente)

    respuesta = cliente.post("/api/settings/telegram/codigo", headers=cabeceras)

    assert respuesta.status_code == 400
    assert buzon.mensajes == []


# ── SEC-12: tope global de fallos ─────────────────────────────────────────────

def testElTopeGlobalSuspendeElLoginAunqueCambieLaIp(cliente, buzon, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("FALLOS_2FA_POR_HORA", "4")
    _activar()

    # Cada IP falla una sola vez: el bloqueo por IP (8 intentos) no salta nunca.
    for numero in range(4):
        ip = f"10.0.0.{numero + 1}"
        _login(cliente, ip)
        codigo = buzon.ultimoCodigo()
        malo = "000000" if codigo != "000000" else "111111"
        cliente.post("/login/2fa", data={"accion": "codigo", "codigo": malo}, environ_base={"REMOTE_ADDR": ip})

    assert dos_factores.segundosSuspension() > 0
    assert any("queda suspendido" in texto for _chat, texto in buzon.mensajes)

    # Con la suspensión, ni el código bueno desde una IP nueva abre sesión.
    enviadosAntes = len(buzon.mensajes)
    respuesta = _login(cliente, "10.0.0.99")
    assert respuesta.headers["Location"].endswith("/login")
    assert len(buzon.mensajes) == enviadosAntes
    with cliente.session_transaction() as s:
        assert not s.get("logged_in")
        assert "suspendida" in s.get("errorLogin", "")


def testLaSuspensionCortaUnSegundoPasoYaEmpezado(cliente, buzon, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("FALLOS_2FA_POR_HORA", "1")
    _activar()
    _login(cliente)
    codigo = buzon.ultimoCodigo()
    dos_factores.anotarFalloGlobal()

    respuesta = cliente.post("/login/2fa", data={"accion": "codigo", "codigo": codigo})

    assert respuesta.headers["Location"].endswith("/login")
    with cliente.session_transaction() as s:
        assert not s.get("logged_in")


def testElAvisoDeSuspensionSaleUnaSolaVez(entorno, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("FALLOS_2FA_POR_HORA", "2")

    resultados = [dos_factores.anotarFalloGlobal() for _ in range(5)]

    assert resultados == [False, True, False, False, False]


def testLosFallosFueraDeLaVentanaNoCuentan(entorno, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("FALLOS_2FA_POR_HORA", "2")
    assert dos_factores.anotarFalloGlobal() is False
    _adelantarReloj(monkeypatch, dos_factores.VENTANA_FALLOS_SEGUNDOS + 1)

    assert dos_factores.anotarFalloGlobal() is False
    assert dos_factores.segundosSuspension() == 0


def testLaSuspensionTerminaAlAcabarLaVentana(entorno, monkeypatch):
    from core import dos_factores

    monkeypatch.setenv("FALLOS_2FA_POR_HORA", "1")
    assert dos_factores.anotarFalloGlobal() is True
    assert dos_factores.segundosSuspension() > 0

    _adelantarReloj(monkeypatch, dos_factores.VENTANA_FALLOS_SEGUNDOS + 1)

    assert dos_factores.segundosSuspension() == 0
