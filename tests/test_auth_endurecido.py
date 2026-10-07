"""Endurecimiento de la autenticación tras la auditoría."""

import pytest
from werkzeug.security import generate_password_hash

from tests import test_auth_http

credenciales = test_auth_http.credenciales
cliente = test_auth_http.cliente


# ── H-16: el tiempo de respuesta no delata si el usuario existe ─────────────

@pytest.mark.parametrize("metodo", ["scrypt:16384:8:1", "pbkdf2:sha256:100000"])
def test_el_senuelo_usa_el_mismo_metodo_que_el_hash_guardado(metodo):
    from routes.auth import _senuelo

    guardado = generate_password_hash("x", method=metodo)

    assert _senuelo(guardado).split("$", 1)[0] == metodo


def test_con_usuario_equivocado_tambien_se_calcula_un_hash(cliente, monkeypatch):
    from routes import auth

    comprobados = []
    original = auth.check_password_hash
    monkeypatch.setattr(auth, "check_password_hash", lambda h, p: comprobados.append(h) or original(h, p))

    cliente.post("/login", data={"username": "nadie", "password": "x"})

    assert len(comprobados) == 1


# ── H-17: login y logout no se pueden provocar desde otra web ───────────────

def test_login_desde_otro_origen_se_rechaza(cliente):
    r = cliente.post("/login", data={"username": "admin", "password": "x"},
                     headers={"Origin": "http://evil.example"})
    assert r.status_code == 403


def test_login_desde_la_propia_pagina_o_sin_origen_entra_al_formulario(cliente):
    for cabeceras in ({"Origin": "http://localhost"}, {"Referer": "http://localhost/login"}, {}):
        r = cliente.post("/login", data={"username": "nadie", "password": "x"}, headers=cabeceras)
        assert r.status_code == 200  # el formulario con «usuario o contraseña incorrectos»


def test_logout_por_get_no_cierra_la_sesion(cliente):
    from core import sesion as sesion_app

    with cliente.session_transaction() as s:
        s["logged_in"] = True
        sesion_app.abrir(s)

    cliente.get("/logout")

    with cliente.session_transaction() as s:
        assert s.get("logged_in")


def test_logout_por_post_sin_csrf_no_cierra_la_sesion(cliente):
    from core import sesion as sesion_app

    with cliente.session_transaction() as s:
        s["logged_in"] = True
        s["csrf_token"] = "bueno"
        sesion_app.abrir(s)

    assert cliente.post("/logout").status_code == 403
    with cliente.session_transaction() as s:
        assert s.get("logged_in")


# ── H-20: política de la contraseña nueva ────────────────────────────────────

@pytest.fixture
def dentro(cliente_autenticado, credenciales, monkeypatch):
    from routes.auth import auth_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(auth_bp)
    return client, cabeceras


def _cambiar(client, cabeceras, **campos):
    return client.post("/api/settings/credentials/password", json=campos, headers=cabeceras)


def test_una_contrasena_corta_se_rechaza(dentro):
    client, cabeceras = dentro
    r = _cambiar(client, cabeceras, currentPassword="secreto-actual", newPassword="corta")
    assert r.status_code == 400
    assert "al menos" in r.get_json()["error"]


@pytest.mark.parametrize("campos", [
    {"currentPassword": 1, "newPassword": "una-contrasena-larga"},
    {"currentPassword": ["x"], "newPassword": "una-contrasena-larga"},
    {"currentPassword": "x", "newPassword": 12345678901},
])
def test_tipos_inesperados_no_dan_500(dentro, campos):
    client, cabeceras = dentro
    assert _cambiar(client, cabeceras, **campos).status_code == 400


def test_un_usuario_demasiado_largo_se_rechaza(dentro):
    client, cabeceras = dentro
    r = client.post("/api/settings/credentials/username",
                    json={"currentPassword": "x", "newUsername": "u" * 65}, headers=cabeceras)
    assert r.status_code == 400


# ── H-19: auth.dat se escribe sin poder quedarse a medias ───────────────────

def test_auth_dat_se_escribe_de_forma_atomica(credenciales, monkeypatch):
    from routes import auth

    escritos = []
    monkeypatch.setattr(auth, "escribirAtomico", lambda ruta, datos, **kw: escritos.append(ruta))

    auth._save_credentials("admin", "hash")

    assert escritos == [auth._AUTH_FILE]


# ── H-10: una revocación dura lo que puede durar la cookie ──────────────────

def test_la_revocacion_dura_lo_que_la_cookie(monkeypatch):
    from core import sesion, settings

    monkeypatch.setattr(settings, "sesionMaximaSegundos", lambda: 0)
    monkeypatch.setattr(sesion, "inactividadSegundos", lambda: 15 * 60)

    assert sesion._retencion() == sesion.COOKIE_DIAS * 24 * 3600


def test_con_caducidad_absoluta_basta_con_recordarla_hasta_entonces(monkeypatch):
    from core import sesion, settings

    monkeypatch.setattr(settings, "sesionMaximaSegundos", lambda: 3600)

    assert sesion._retencion() == 3600

