"""Pruebas de la capa que decide qué peticiones llegan a una vista.

Todo lo de aquí vivía en `server.py`, fuera del alcance de la suite, y es
justamente lo que separa una API privada de una abierta: sesión, CSRF, tope de
cuerpo, límite de escrituras y cabeceras de respuesta. `core.seguridad_app` lo
monta sobre una app mínima para poder comprobarlo sin tocar `data/`.
"""

import pytest
from flask import Blueprint, jsonify


@pytest.fixture
def bp_prueba():
    """Blueprint de juguete con un GET y un POST bajo /api/."""
    bp = Blueprint("prueba", __name__)

    @bp.route("/api/prueba", methods=["GET"])
    def leer():
        return jsonify({"ok": True})

    @bp.route("/api/prueba", methods=["POST"])
    def escribir():
        return jsonify({"ok": True, "escrito": True})

    @bp.route("/api/backup", methods=["POST"])
    def backup_falso():
        return jsonify({"ok": True})

    @bp.route("/pagina", methods=["GET"])
    def pagina():
        return "<html></html>"

    return bp


# ── Sesión ───────────────────────────────────────────────────────────────────

def test_api_sin_sesion_responde_401(crear_app, bp_prueba):
    client = crear_app(bp_prueba).test_client()
    assert client.get("/api/prueba").status_code == 401


def test_pagina_sin_sesion_redirige_al_login(crear_app, bp_prueba):
    """Y conserva el destino en ?next, para volver donde estaba tras entrar."""
    from routes.auth import auth_bp

    client = crear_app(bp_prueba, auth_bp).test_client()
    respuesta = client.get("/pagina")

    assert respuesta.status_code == 302
    assert "/login" in respuesta.headers["Location"]
    assert "next=/pagina" in respuesta.headers["Location"]


def test_con_sesion_la_api_responde(cliente_autenticado, bp_prueba):
    client, cabeceras, _ = cliente_autenticado(bp_prueba)
    assert client.get("/api/prueba").status_code == 200
    assert client.post("/api/prueba", headers=cabeceras).status_code == 200


def test_assets_del_login_se_sirven_sin_sesion(crear_app, bp_prueba):
    """La página de login necesita su CSS antes de que exista sesión."""
    from core.seguridad_app import _es_asset_publico

    assert _es_asset_publico("/css/base.css")
    assert _es_asset_publico("/js/core/csrf.js")
    assert _es_asset_publico("/favicon.ico")


@pytest.mark.parametrize("ruta", [
    "/data/portfolio.db",      # los datos no son un asset público
    "/python/server.py",       # ni el código
    "/css/../.env",            # ni nada que trepe fuera de css/
    "/notas.css",              # ni un .css que no esté bajo css/
])
def test_rutas_sensibles_no_cuentan_como_asset_publico(ruta):
    from core.seguridad_app import _es_asset_publico

    assert not _es_asset_publico(ruta)


# ── CSRF ─────────────────────────────────────────────────────────────────────

def test_post_con_sesion_pero_sin_token_csrf_es_403(cliente_autenticado, bp_prueba):
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    assert client.post("/api/prueba").status_code == 403


def test_post_con_token_csrf_ajeno_es_403(cliente_autenticado, bp_prueba):
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    respuesta = client.post("/api/prueba", headers={"X-CSRF-Token": "token-de-otra-sesion"})
    assert respuesta.status_code == 403


def test_sesion_sin_token_no_se_deja_pasar(cliente_autenticado, bp_prueba):
    """Fail-closed: una sesión emitida antes de existir el CSRF se rechaza.

    Lo contrario —dejar pasar si no hay token guardado— convertiría en un
    bypass trivial el simple hecho de borrar la clave de la sesión.
    """
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    with client.session_transaction() as sesion:
        del sesion["csrf_token"]

    assert client.post("/api/prueba", headers={"X-CSRF-Token": "loquesea"}).status_code == 403


def test_el_get_reemite_la_cookie_csrf(cliente_autenticado, bp_prueba):
    """Así una sesión que perdió el token se recupera sola al navegar."""
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    respuesta = client.get("/api/prueba")

    cookies = respuesta.headers.getlist("Set-Cookie")
    assert any("csrf_token=" in c for c in cookies)
    # Legible por JS a propósito: js/core/csrf.js la reenvía como cabecera.
    assert not any("csrf_token=" in c and "HttpOnly" in c for c in cookies)


def test_los_get_no_pasan_por_csrf(cliente_autenticado, bp_prueba):
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    assert client.get("/api/prueba").status_code == 200


# ── Límite de escrituras ─────────────────────────────────────────────────────

def test_las_lecturas_no_consumen_cupo(cliente_autenticado, bp_prueba, monkeypatch):
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "2")
    client, _cabeceras, _app = cliente_autenticado(bp_prueba)

    for _ in range(10):
        assert client.get("/api/prueba").status_code == 200


def test_al_pasarse_del_limite_responde_429_con_retry_after(cliente_autenticado, bp_prueba, monkeypatch):
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "3")
    client, cabeceras, _ = cliente_autenticado(bp_prueba)

    codigos = [client.post("/api/prueba", headers=cabeceras).status_code for _ in range(5)]

    assert codigos[:3] == [200, 200, 200]
    assert codigos[3:] == [429, 429]
    ultima = client.post("/api/prueba", headers=cabeceras)
    assert int(ultima.headers["Retry-After"]) > 0
    assert ultima.get_json()["ok"] is False


def test_el_limite_es_por_ip(cliente_autenticado, bp_prueba, monkeypatch):
    """Agotar el cupo desde una IP no debe dejar fuera al resto de la casa."""
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "2")
    client, cabeceras, _ = cliente_autenticado(bp_prueba)

    for _ in range(3):
        client.post("/api/prueba", headers=cabeceras, environ_base={"REMOTE_ADDR": "192.168.1.10"})

    otra = client.post("/api/prueba", headers=cabeceras, environ_base={"REMOTE_ADDR": "192.168.1.11"})
    assert otra.status_code == 200


def test_backup_tiene_un_cupo_propio_mas_estrecho(cliente_autenticado, bp_prueba, monkeypatch):
    """Copiar bases enteras es caro: el límite general se le queda largo."""
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "1000")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "2")
    client, cabeceras, _ = cliente_autenticado(bp_prueba)

    codigos = [client.post("/api/backup", headers=cabeceras).status_code for _ in range(4)]
    assert codigos == [200, 200, 429, 429]

    # El cupo pesado agotado no debe cerrar el resto de la aplicación.
    assert client.post("/api/prueba", headers=cabeceras).status_code == 200


def test_con_el_limite_a_cero_no_hay_freno(cliente_autenticado, bp_prueba, monkeypatch):
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _ = cliente_autenticado(bp_prueba)

    for _ in range(50):
        assert client.post("/api/prueba", headers=cabeceras).status_code == 200


def test_el_login_no_pasa_por_el_limitador(crear_app, monkeypatch):
    """Tiene su propio bloqueo por intentos fallidos, con mensaje al usuario."""
    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "1")
    from routes.auth import auth_bp

    client = crear_app(auth_bp).test_client()
    for _ in range(4):
        respuesta = client.post("/login", data={"username": "x", "password": "y"})
        assert respuesta.status_code != 429


# ── Tope de cuerpo ───────────────────────────────────────────────────────────

def test_cuerpo_por_encima_del_tope_es_413(cliente_autenticado, bp_prueba, monkeypatch):
    monkeypatch.setenv("MAX_CUERPO_MB", "1")
    client, cabeceras, _ = cliente_autenticado(bp_prueba)

    respuesta = client.post(
        "/api/prueba", headers=cabeceras,
        data=b"x" * (2 * 1024 * 1024), content_type="application/octet-stream",
    )
    assert respuesta.status_code == 413


def test_las_rutas_de_importacion_admiten_cuerpos_grandes(crear_app, monkeypatch):
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
def test_cabeceras_de_seguridad_en_toda_respuesta(cliente_autenticado, bp_prueba, cabecera, valor):
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    assert client.get("/api/prueba").headers[cabecera] == valor


def test_permissions_policy_cierra_los_permisos_del_navegador(cliente_autenticado, bp_prueba):
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    politica = client.get("/api/prueba").headers["Permissions-Policy"]

    for permiso in ("geolocation", "microphone", "camera"):
        assert f"{permiso}=()" in politica


def test_hay_csp_incluso_en_las_respuestas_de_error(crear_app, bp_prueba):
    """El 401 también se pinta en el navegador; no debe quedarse sin política."""
    client = crear_app(bp_prueba).test_client()
    respuesta = client.get("/api/prueba")

    assert respuesta.status_code == 401
    assert "default-src 'self'" in respuesta.headers["Content-Security-Policy"]


def test_la_csp_se_puede_desactivar_para_depurar(cliente_autenticado, bp_prueba, monkeypatch):
    monkeypatch.setenv("CSP_ACTIVADA", "false")
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)

    assert "Content-Security-Policy" not in client.get("/api/prueba").headers


# ── HTTPS: cookies, HSTS y proxy inverso ─────────────────────────────────────
# La aplicación nunca termina TLS: cuando hay HTTPS, lo pone un proxy delante
# (el Caddy del perfil `https` de docker-compose). Lo que se comprueba aquí es
# que activarlo tenga efecto de verdad —cookie con Secure, HSTS— y que la IP del
# cliente siga siendo la suya y no la del proxy, porque de esa IP dependen el
# límite de escrituras, el bloqueo por intentos de login y el filtro de red del
# Atajo de iOS.

def test_sin_https_la_cookie_de_sesion_no_lleva_secure(crear_app, bp_prueba):
    """Marcarla Secure sobre HTTP haría que el navegador la tirase: sin login."""
    app = crear_app(bp_prueba)

    assert app.config["SESSION_COOKIE_SECURE"] is False
    assert app.config["REMEMBER_COOKIE_SECURE"] is False


def test_con_https_las_cookies_llevan_secure(crear_app, bp_prueba, monkeypatch):
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    app = crear_app(bp_prueba)

    assert app.config["SESSION_COOKIE_SECURE"] is True
    # No la usa nada hoy (no hay "recordarme"), pero los valores de fábrica de
    # Flask-Login son un año sin Secure: heredar la política de la sesión evita
    # que añadirla algún día abra el agujero sin que se note.
    assert app.config["REMEMBER_COOKIE_SECURE"] is True
    assert app.config["REMEMBER_COOKIE_HTTPONLY"] is True
    assert app.config["REMEMBER_COOKIE_SAMESITE"] == app.config["SESSION_COOKIE_SAMESITE"]


def test_la_cookie_csrf_hereda_el_secure_de_la_sesion(cliente_autenticado, bp_prueba, monkeypatch):
    """Va replicada fuera de la sesión firmada, así que necesita la misma protección."""
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)

    galletas = client.get("/api/prueba").headers.getlist("Set-Cookie")
    csrf = [c for c in galletas if c.startswith("csrf_token=")]

    assert csrf and "Secure" in csrf[0]


def test_sin_https_no_se_emite_hsts(cliente_autenticado, bp_prueba):
    """Emitirla en HTTP dejaría el host inaccesible un año, sin poder retirarlo."""
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    assert "Strict-Transport-Security" not in client.get("/api/prueba").headers


def test_con_https_se_emite_hsts(cliente_autenticado, bp_prueba, monkeypatch):
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    client, _cabeceras, _ = cliente_autenticado(bp_prueba)
    politica = client.get("/api/prueba").headers["Strict-Transport-Security"]

    assert "max-age=31536000" in politica
    # Sin includeSubDomains: apagarles el HTTP a los demás subdominios del
    # dominio desde aquí sería una sorpresa difícil de deshacer.
    assert "includeSubDomains" not in politica


def _origen_visto(app, **peticion):
    """(remote_addr, scheme) tal y como los ve una vista de la aplicación.

    El registro se hace en la propia vista y no en un `before_request` añadido a
    posteriori: ese se registraría después de `require_login`, que corta la
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

    client = app.test_client()
    # Solo la sesión: es un GET, así que no pasa por la comprobación de CSRF.
    with client.session_transaction() as sesion:
        sesion["logged_in"] = True

    client.get("/api/origen", **peticion)
    return visto.get("addr"), visto.get("scheme")


def test_sin_proxy_declarado_se_ignora_x_forwarded_for(crear_app, bp_prueba):
    """La cabecera la pone el cliente: hacerle caso sería regalar la suplantación.

    Es el caso por defecto —sin proxy delante— y el que hace que el bloqueo por
    intentos de login signifique algo: si bastara con mandar la cabecera, cada
    intento fallido se contaría contra una IP inventada distinta.
    """
    addr, _scheme = _origen_visto(
        crear_app(bp_prueba),
        headers={"X-Forwarded-For": "203.0.113.9"},
        environ_base={"REMOTE_ADDR": "10.0.0.2"},
    )

    assert addr == "10.0.0.2"


def test_con_un_proxy_declarado_se_recupera_la_ip_del_cliente(crear_app, bp_prueba, monkeypatch):
    monkeypatch.setenv("PROXY_FIX_HOPS", "1")

    addr, scheme = _origen_visto(
        crear_app(bp_prueba),
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


def test_un_salto_de_confianza_no_deja_elegir_la_ip_al_cliente(crear_app, bp_prueba, monkeypatch):
    """Con un proxy, solo vale la última entrada: la que escribió ese proxy.

    Si el cliente prefija la cabecera, sus valores quedan a la izquierda y se
    descartan. Declarar más saltos de los que hay es justo lo que rompería esto.
    """
    monkeypatch.setenv("PROXY_FIX_HOPS", "1")

    addr, _scheme = _origen_visto(
        crear_app(bp_prueba),
        headers={"X-Forwarded-For": "1.2.3.4, 203.0.113.9"},
        environ_base={"REMOTE_ADDR": "172.18.0.5"},
    )

    assert addr == "203.0.113.9"
