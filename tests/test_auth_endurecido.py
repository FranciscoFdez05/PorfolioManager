"""Endurecimiento de la autenticación tras la auditoría."""

import pytest
from werkzeug.security import generate_password_hash

from tests import test_auth_http

credenciales = test_auth_http.credenciales
cliente = test_auth_http.cliente


# ── H-16: el tiempo de respuesta no delata si el usuario existe ─────────────

@pytest.mark.parametrize("metodo", ["scrypt:16384:8:1", "pbkdf2:sha256:100000"])
def testElSenueloUsaElMismoMetodoQueElHashGuardado(metodo):
    from routes.auth import _senuelo

    guardado = generate_password_hash("x", method=metodo)

    assert _senuelo(guardado).split("$", 1)[0] == metodo


def testConUsuarioEquivocadoTambienSeCalculaUnHash(cliente, monkeypatch):
    from routes import auth

    comprobados = []
    original = auth.check_password_hash
    monkeypatch.setattr(auth, "check_password_hash", lambda h, p: comprobados.append(h) or original(h, p))

    cliente.post("/login", data={"username": "nadie", "password": "x"})

    assert len(comprobados) == 1


# ── H-17: login y logout no se pueden provocar desde otra web ───────────────

def testLoginDesdeOtroOrigenSeRechaza(cliente):
    r = cliente.post("/login", data={"username": "admin", "password": "x"},
                     headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


def testLoginDesdeLaPropiaPaginaOSinOrigenEntraAlFormulario(cliente):
    for cabeceras in ({"Origin": "http://localhost"}, {"Referer": "http://localhost/login"}, {}):
        r = cliente.post("/login", data={"username": "nadie", "password": "x"}, headers=cabeceras)
        assert r.status_code == 200  # el formulario con «usuario o contraseña incorrectos»


def testLogoutPorGetNoCierraLaSesion(cliente):
    from core import sesion as sesionApp

    with cliente.session_transaction() as s:
        s["logged_in"] = True
        sesionApp.abrir(s)

    cliente.get("/logout")

    with cliente.session_transaction() as s:
        assert s.get("logged_in")


def testLogoutPorPostSinCsrfNoCierraLaSesion(cliente):
    from core import sesion as sesionApp

    with cliente.session_transaction() as s:
        s["logged_in"] = True
        s["csrf_token"] = "bueno"
        sesionApp.abrir(s)

    assert cliente.post("/logout").status_code == 403
    with cliente.session_transaction() as s:
        assert s.get("logged_in")


# ── H-20: política de la contraseña nueva ────────────────────────────────────

@pytest.fixture
def dentro(clienteAutenticado, credenciales, monkeypatch):
    from routes.auth import authBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(authBp)
    return client, cabeceras


def _cambiar(client, cabeceras, **campos):
    return client.post("/api/settings/credentials/password", json=campos, headers=cabeceras)


def testUnaContrasenaCortaSeRechaza(dentro):
    client, cabeceras = dentro
    r = _cambiar(client, cabeceras, currentPassword="secreto-actual", newPassword="corta")
    assert r.status_code == 400
    assert "al menos" in r.get_json()["error"]


@pytest.mark.parametrize("campos", [
    {"currentPassword": 1, "newPassword": "una-contrasena-larga"},
    {"currentPassword": ["x"], "newPassword": "una-contrasena-larga"},
    {"currentPassword": "x", "newPassword": 12345678901},
])
def testTiposInesperadosNoDan500(dentro, campos):
    client, cabeceras = dentro
    assert _cambiar(client, cabeceras, **campos).status_code == 400


def testUnUsuarioDemasiadoLargoSeRechaza(dentro):
    client, cabeceras = dentro
    r = client.post("/api/settings/credentials/username",
                    json={"currentPassword": "x", "newUsername": "u" * 65}, headers=cabeceras)
    assert r.status_code == 400


# ── H-19: auth.dat se escribe sin poder quedarse a medias ───────────────────

def testAuthDatSeEscribeDeFormaAtomica(credenciales, monkeypatch):
    from routes import auth

    escritos = []
    monkeypatch.setattr(auth, "escribirAtomico", lambda ruta, datos, **kw: escritos.append(ruta))

    auth._saveCredentials("admin", "hash")

    assert escritos == [auth._AUTH_FILE]


# ── H-10: una revocación dura lo que puede durar la cookie ──────────────────

def testLaRevocacionDuraLoQueLaCookie(monkeypatch):
    from core import sesion, settings

    monkeypatch.setattr(settings, "sesionMaximaSegundos", lambda: 0)
    monkeypatch.setattr(sesion, "inactividadSegundos", lambda: 15 * 60)

    assert sesion._retencion() == sesion.COOKIE_DIAS * 24 * 3600


def testConCaducidadAbsolutaBastaConRecordarlaHastaEntonces(monkeypatch):
    from core import sesion, settings

    monkeypatch.setattr(settings, "sesionMaximaSegundos", lambda: 3600)

    assert sesion._retencion() == 3600

