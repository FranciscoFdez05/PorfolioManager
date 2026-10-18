"""Pruebas de la capa que decide qué peticiones llegan a una vista.

Todo lo de aquí vivía en `server.py`, fuera del alcance de la suite, y es
justamente lo que separa una API privada de una abierta: sesión, CSRF, tope de
cuerpo, límite de escrituras y cabeceras de respuesta. `core.seguridad_app` lo
monta sobre una app mínima para poder comprobarlo sin tocar `data/`.
"""

import json
import time

import pytest
from flask import Blueprint, jsonify


@pytest.fixture
def bpPrueba():
    """Blueprint de juguete con un GET y un POST bajo /api/."""
    bp = Blueprint("prueba", __name__)

    @bp.route("/api/prueba", methods=["GET"])
    def leer():
        return jsonify({"ok": True})

    @bp.route("/api/prueba", methods=["POST"])
    def escribir():
        return jsonify({"ok": True, "escrito": True})

    @bp.route("/api/backup", methods=["POST"])
    def backupFalso():
        return jsonify({"ok": True})

    @bp.route("/pagina", methods=["GET"])
    def pagina():
        return "<html></html>"

    return bp


# ── Sesión ───────────────────────────────────────────────────────────────────

def testApiSinSesionResponde401(crearApp, bpPrueba):
    client = crearApp(bpPrueba).test_client()
    assert client.get("/api/prueba").status_code == 401


def testPaginaSinSesionRedirigeAlLogin(crearApp, bpPrueba):
    """Y conserva el destino en ?next, para volver donde estaba tras entrar."""
    from routes.auth import authBp

    client = crearApp(bpPrueba, authBp).test_client()
    respuesta = client.get("/pagina")

    assert respuesta.status_code == 302
    assert "/login" in respuesta.headers["Location"]
    assert "next=/pagina" in respuesta.headers["Location"]


def testConSesionLaApiResponde(clienteAutenticado, bpPrueba):
    client, cabeceras, _ = clienteAutenticado(bpPrueba)
    assert client.get("/api/prueba").status_code == 200
    assert client.post("/api/prueba", headers=cabeceras).status_code == 200


def testAssetsDelLoginSeSirvenSinSesion(crearApp, bpPrueba):
    """La página de login necesita su CSS antes de que exista sesión."""
    from core.seguridad_app import _esAssetPublico

    assert _esAssetPublico("/css/base.css")
    assert _esAssetPublico("/js/core/csrf.js")
    assert _esAssetPublico("/favicon.ico")


@pytest.mark.parametrize("ruta", [
    "/data/portfolio.db",      # los datos no son un asset público
    "/python/server.py",       # ni el código
    "/css/../.env",            # ni nada que trepe fuera de css/
    "/notas.css",              # ni un .css que no esté bajo css/
])
def testRutasSensiblesNoCuentanComoAssetPublico(ruta):
    from core.seguridad_app import _esAssetPublico

    assert not _esAssetPublico(ruta)


# ── CSRF ─────────────────────────────────────────────────────────────────────

def testPostConSesionPeroSinTokenCsrfEs403(clienteAutenticado, bpPrueba):
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    assert client.post("/api/prueba").status_code == 403


def testPostConTokenCsrfAjenoEs403(clienteAutenticado, bpPrueba):
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    respuesta = client.post("/api/prueba", headers={"X-CSRF-Token": "token-de-otra-sesion"})
    assert respuesta.status_code == 403


def testSesionSinTokenNoSeDejaPasar(clienteAutenticado, bpPrueba):
    """Fail-closed: una sesión emitida antes de existir el CSRF se rechaza.

    Lo contrario —dejar pasar si no hay token guardado— convertiría en un
    bypass trivial el simple hecho de borrar la clave de la sesión.
    """
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    with client.session_transaction() as sesion:
        del sesion["csrf_token"]

    assert client.post("/api/prueba", headers={"X-CSRF-Token": "loquesea"}).status_code == 403


def testElGetReemiteLaCookieCsrf(clienteAutenticado, bpPrueba):
    """Así una sesión que perdió el token se recupera sola al navegar."""
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    respuesta = client.get("/api/prueba")

    cookies = respuesta.headers.getlist("Set-Cookie")
    assert any("csrf_token=" in c for c in cookies)
    # Legible por JS a propósito: js/core/csrf.js la reenvía como cabecera.
    assert not any("csrf_token=" in c and "HttpOnly" in c for c in cookies)


def testLosGetNoPasanPorCsrf(clienteAutenticado, bpPrueba):
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    assert client.get("/api/prueba").status_code == 200


# ── Límite de escrituras ─────────────────────────────────────────────────────

def testLasLecturasNoConsumenCupo(clienteAutenticado, bpPrueba, monkeypatch):
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "2")
    client, _cabeceras, _app = clienteAutenticado(bpPrueba)

    for _ in range(10):
        assert client.get("/api/prueba").status_code == 200


def testAlPasarseDelLimiteResponde429ConRetryAfter(clienteAutenticado, bpPrueba, monkeypatch):
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "3")
    client, cabeceras, _ = clienteAutenticado(bpPrueba)

    codigos = [client.post("/api/prueba", headers=cabeceras).status_code for _ in range(5)]

    assert codigos[:3] == [200, 200, 200]
    assert codigos[3:] == [429, 429]
    ultima = client.post("/api/prueba", headers=cabeceras)
    assert int(ultima.headers["Retry-After"]) > 0
    assert ultima.get_json()["ok"] is False


def testElLimiteEsPorIp(clienteAutenticado, bpPrueba, monkeypatch):
    """Agotar el cupo desde una IP no debe dejar fuera al resto de la casa."""
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "2")
    client, cabeceras, _ = clienteAutenticado(bpPrueba)

    for _ in range(3):
        client.post("/api/prueba", headers=cabeceras, environ_base={"REMOTE_ADDR": "192.168.1.10"})

    otra = client.post("/api/prueba", headers=cabeceras, environ_base={"REMOTE_ADDR": "192.168.1.11"})
    assert otra.status_code == 200


def testBackupTieneUnCupoPropioMasEstrecho(clienteAutenticado, bpPrueba, monkeypatch):
    """Copiar bases enteras es caro: el límite general se le queda largo."""
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "1000")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "2")
    client, cabeceras, _ = clienteAutenticado(bpPrueba)

    codigos = [client.post("/api/backup", headers=cabeceras).status_code for _ in range(4)]
    assert codigos == [200, 200, 429, 429]

    # El cupo pesado agotado no debe cerrar el resto de la aplicación.
    assert client.post("/api/prueba", headers=cabeceras).status_code == 200


def testConElLimiteACeroNoHayFreno(clienteAutenticado, bpPrueba, monkeypatch):
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _ = clienteAutenticado(bpPrueba)

    for _ in range(50):
        assert client.post("/api/prueba", headers=cabeceras).status_code == 200


def testElLoginNoPasaPorElLimitador(crearApp, monkeypatch):
    """Tiene su propio bloqueo por intentos fallidos, con mensaje al usuario."""
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "1")
    from routes.auth import authBp

    client = crearApp(authBp).test_client()
    for _ in range(4):
        respuesta = client.post("/login", data={"username": "x", "password": "y"})
        assert respuesta.status_code != 429


# ── Tope de cuerpo ───────────────────────────────────────────────────────────

def testCuerpoPorEncimaDelTopeEs413(clienteAutenticado, bpPrueba, monkeypatch):
    monkeypatch.setenv("MAX_CUERPO_MB", "1")
    client, cabeceras, _ = clienteAutenticado(bpPrueba)

    respuesta = client.post(
        "/api/prueba", headers=cabeceras,
        data=b"x" * (2 * 1024 * 1024), content_type="application/octet-stream",
    )
    assert respuesta.status_code == 413


def testLasRutasDeImportacionAdmitenCuerposGrandes(crearApp, monkeypatch):
    """Un export JSON completo ronda los 25 MB: con el tope general no entraba."""
    monkeypatch.setenv("MAX_CUERPO_MB", "1")
    from core.seguridad_app import UPLOAD_PATHS

    assert "/api/import/json" in UPLOAD_PATHS
    assert "/api/portfolios/import" in UPLOAD_PATHS


# ── Cabeceras de respuesta ───────────────────────────────────────────────────

@pytest.mark.parametrize("cabecera,valor", [
    ("X-Content-Type-Options", "nosniff"),
    ("X-Frame-Options", "SAMEORIGIN"),
    ("Referrer-Policy", "strict-origin-when-cross-origin"),
])
def testCabecerasDeSeguridadEnTodaRespuesta(clienteAutenticado, bpPrueba, cabecera, valor):
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    assert client.get("/api/prueba").headers[cabecera] == valor


def testPermissionsPolicyCierraLosPermisosDelNavegador(clienteAutenticado, bpPrueba):
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    politica = client.get("/api/prueba").headers["Permissions-Policy"]

    for permiso in ("geolocation", "microphone", "camera"):
        assert f"{permiso}=()" in politica


def testHayCspInclusoEnLasRespuestasDeError(crearApp, bpPrueba):
    """El 401 también se pinta en el navegador; no debe quedarse sin política."""
    client = crearApp(bpPrueba).test_client()
    respuesta = client.get("/api/prueba")

    assert respuesta.status_code == 401
    assert "default-src 'self'" in respuesta.headers["Content-Security-Policy"]


def testLaCspSePuedeDesactivarParaDepurar(clienteAutenticado, bpPrueba, monkeypatch):
    monkeypatch.setenv("CSP_ACTIVADA", "false")
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)

    assert "Content-Security-Policy" not in client.get("/api/prueba").headers


# ── HTTPS: cookies, HSTS y proxy inverso ─────────────────────────────────────
# La aplicación nunca termina TLS: cuando hay HTTPS, lo pone un proxy delante
# (el Caddy del perfil `https` de docker-compose). Lo que se comprueba aquí es
# que activarlo tenga efecto de verdad —cookie con Secure, HSTS— y que la IP del
# cliente siga siendo la suya y no la del proxy, porque de esa IP dependen el
# límite de escrituras, el bloqueo por intentos de login y el filtro de red del
# Atajo de iOS.

# ── Varias sesiones y caducidad ──────────────────────────────────────────────
# El login real vive en routes/auth.py; aquí se sella la sesión igual que él
# (`sesion.abrir`) y se comprueba contra un endpoint protegido, que es donde
# `requireLogin` decide si sigue valiendo.

def _entrar(app):
    from core import sesion

    client = app.test_client()
    with client.session_transaction() as sesionPrueba:
        sesionPrueba["logged_in"] = True
        sesionPrueba["csrf_token"] = "token-de-prueba"
        sesionPrueba.permanent = True
        sesion.abrir(sesionPrueba)
    return client


def _salir(client):
    return client.post("/logout", headers={"X-CSRF-Token": "token-de-prueba"})


def testDosDispositivosTienenSesionesIndependientes(crearApp, bpPrueba):
    """Entrar desde el móvil no echa al portátil, y cerrar en uno no cierra el otro."""
    from routes.auth import authBp

    app = crearApp(bpPrueba, authBp)
    portatil = _entrar(app)
    movil = _entrar(app)
    assert portatil.get("/api/prueba").status_code == 200
    assert movil.get("/api/prueba").status_code == 200

    _salir(movil)

    assert portatil.get("/api/prueba").status_code == 200
    assert movil.get("/api/prueba").status_code == 401


def testPorDefectoLaSesionNoCaducaPorInactividad(crearApp, bpPrueba, datosAislados):
    """«No cerrar» es el valor de fábrica: sin tocar Ajustes, una sesión de hace
    un mes sigue valiendo mientras no se cierre ni cambien las credenciales."""
    from core import sesion

    client = _entrar(crearApp(bpPrueba))
    with client.session_transaction() as sesionPrueba:
        sesionPrueba[sesion.VISTA] = time.time() - 30 * 24 * 3600
        sesionPrueba[sesion.CREADA] = time.time() - 30 * 24 * 3600

    assert client.get("/api/prueba").status_code == 200


def testLaInactividadSeLeeDeAjustes(crearApp, bpPrueba, datosAislados):
    """El plazo lo fija Ajustes > Seguridad y lo aplica el servidor, no solo la pestaña."""
    from core import sesion

    datosAislados["ajustes"].write_text(json.dumps({"bloqueoInactividad": 15}), "utf-8")

    client = _entrar(crearApp(bpPrueba))
    with client.session_transaction() as sesionPrueba:
        sesionPrueba[sesion.VISTA] = time.time() - 14 * 60
    assert client.get("/api/prueba").status_code == 200

    with client.session_transaction() as sesionPrueba:
        sesionPrueba[sesion.VISTA] = time.time() - 16 * 60
    assert client.get("/api/prueba").status_code == 401


def testUnValorDeInactividadFueraDeLaListaNoCierraNada(crearApp, bpPrueba, datosAislados):
    """Un ajustes.json editado a mano con un número raro no puede dejar fuera al usuario."""
    from core import sesion

    datosAislados["ajustes"].write_text(json.dumps({"bloqueoInactividad": 7}), "utf-8")

    client = _entrar(crearApp(bpPrueba))
    with client.session_transaction() as sesionPrueba:
        sesionPrueba[sesion.VISTA] = time.time() - 3600

    assert client.get("/api/prueba").status_code == 200


def testSinHttpsLaCookieDeSesionNoLlevaSecure(crearApp, bpPrueba):
    """Marcarla Secure sobre HTTP haría que el navegador la tirase: sin login."""
    app = crearApp(bpPrueba)

    assert app.config["SESSION_COOKIE_SECURE"] is False
    assert app.config["REMEMBER_COOKIE_SECURE"] is False


def testConHttpsLasCookiesLlevanSecure(crearApp, bpPrueba, monkeypatch):
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    app = crearApp(bpPrueba)

    assert app.config["SESSION_COOKIE_SECURE"] is True
    # No la usa nada hoy (no hay "recordarme"), pero los valores de fábrica de
    # Flask-Login son un año sin Secure: heredar la política de la sesión evita
    # que añadirla algún día abra el agujero sin que se note.
    assert app.config["REMEMBER_COOKIE_SECURE"] is True
    assert app.config["REMEMBER_COOKIE_HTTPONLY"] is True
    assert app.config["REMEMBER_COOKIE_SAMESITE"] == app.config["SESSION_COOKIE_SAMESITE"]


def testLaCookieCsrfHeredaElSecureDeLaSesion(clienteAutenticado, bpPrueba, monkeypatch):
    """Va replicada fuera de la sesión firmada, así que necesita la misma protección."""
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)

    galletas = client.get("/api/prueba").headers.getlist("Set-Cookie")
    csrf = [c for c in galletas if c.startswith("csrf_token=")]

    assert csrf and "Secure" in csrf[0]


def testSinHttpsNoSeEmiteHsts(clienteAutenticado, bpPrueba):
    """Emitirla en HTTP dejaría el host inaccesible un año, sin poder retirarlo."""
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    assert "Strict-Transport-Security" not in client.get("/api/prueba").headers


def testConHttpsSeEmiteHsts(clienteAutenticado, bpPrueba, monkeypatch):
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    client, _cabeceras, _ = clienteAutenticado(bpPrueba)
    politica = client.get("/api/prueba").headers["Strict-Transport-Security"]

    assert "max-age=31536000" in politica
    # Sin includeSubDomains: apagarles el HTTP a los demás subdominios del
    # dominio desde aquí sería una sorpresa difícil de deshacer.
    assert "includeSubDomains" not in politica


def _origenVisto(app, **peticion):
    """(remote_addr, scheme) tal y como los ve una vista de la aplicación.

    El registro se hace en la propia vista y no en un `before_request` añadido a
    posteriori: ese se registraría después de `requireLogin`, que corta la
    petición con 401 antes de llegar. Y es justo lo que ve una vista lo que
    importa, porque de ahí salen la IP del log, la del límite de escrituras y la
    del filtro de red del Atajo.
    """
    from flask import jsonify, request

    visto = {}

    @app.route("/api/origen")
    def _origen():
        visto["addr"] = request.remote_addr
        visto["scheme"] = request.scheme
        return jsonify({"ok": True})

    from core import sesion

    client = app.test_client()
    # Solo la sesión: es un GET, así que no pasa por la comprobación de CSRF.
    # Se sella con `sesion.abrir` igual que en el login real; sin identificador
    # ni marcas de tiempo, `requireLogin` la rechaza antes de llegar a la vista
    # y el helper devolvería None en vez de la IP que se quiere comprobar.
    with client.session_transaction() as sesionPrueba:
        sesionPrueba["logged_in"] = True
        sesion.abrir(sesionPrueba)

    client.get("/api/origen", **peticion)
    return visto.get("addr"), visto.get("scheme")


def testSinProxyDeclaradoSeIgnoraXForwardedFor(crearApp, bpPrueba):
    """La cabecera la pone el cliente: hacerle caso sería regalar la suplantación.

    Es el caso por defecto —sin proxy delante— y el que hace que el bloqueo por
    intentos de login signifique algo: si bastara con mandar la cabecera, cada
    intento fallido se contaría contra una IP inventada distinta.
    """
    addr, _scheme = _origenVisto(
        crearApp(bpPrueba),
        headers={"X-Forwarded-For": "203.0.113.9"},
        environ_base={"REMOTE_ADDR": "10.0.0.2"},
    )

    assert addr == "10.0.0.2"


def testConUnProxyDeclaradoSeRecuperaLaIpDelCliente(crearApp, bpPrueba, monkeypatch):
    monkeypatch.setenv("PROXY_FIX_HOPS", "1")

    addr, scheme = _origenVisto(
        crearApp(bpPrueba),
        headers={"X-Forwarded-For": "203.0.113.9", "X-Forwarded-Proto": "https"},
        environ_base={"REMOTE_ADDR": "172.18.0.5"},
    )

    # 172.18.0.5 sería la IP del contenedor de Caddy: con ella, un solo atacante
    # agotaría el límite de escrituras de todos y el bloqueo por intentos de
    # login dejaría fuera a cualquiera que llegase por el mismo proxy.
    assert addr == "203.0.113.9"
    # Y el esquema original, para que request.is_secure no diga que la petición
    # llegó en claro solo porque el tramo proxy → aplicación lo sea.
    assert scheme == "https"


def testUnSaltoDeConfianzaNoDejaElegirLaIpAlCliente(crearApp, bpPrueba, monkeypatch):
    """Con un proxy, solo vale la última entrada: la que escribió ese proxy.

    Si el cliente prefija la cabecera, sus valores quedan a la izquierda y se
    descartan. Declarar más saltos de los que hay es justo lo que rompería esto.
    """
    monkeypatch.setenv("PROXY_FIX_HOPS", "1")

    addr, _scheme = _origenVisto(
        crearApp(bpPrueba),
        headers={"X-Forwarded-For": "1.2.3.4, 203.0.113.9"},
        environ_base={"REMOTE_ADDR": "172.18.0.5"},
    )

    assert addr == "203.0.113.9"
