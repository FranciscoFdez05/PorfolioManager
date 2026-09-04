"""HTTPS encendido desde Ajustes.

Lo que se comprueba aquí es sobre todo **que no se pueda quedar a medias**. El
estado de este módulo decide si las cookies salen con `Secure`, y una cookie
`Secure` sobre una conexión en claro el navegador la descarta: si el estado
dijera «HTTPS activo» sobre un proxy sirviendo en texto plano, nadie podría
iniciar sesión y la única salida sería entrar por SSH a borrar un fichero. De
ahí que el orden importe —primero Caddy, y solo si acepta se guarda el estado—
y que un `estado.json` ilegible se lea como «desactivado» en vez de reventar.

No se levanta ningún Caddy: se sustituye `_admin`, que es la única función del
módulo que toca la red.
"""

import json

import pytest

from core import tls


@pytest.fixture(autouse=True)
def estado_aislado(tmp_path, monkeypatch):
    """Saca `data/tls/` del repositorio en todos los tests de este fichero.

    Se parchean las constantes del módulo y no `paths.DATA_DIR`, por lo mismo
    que explica conftest para `backup_manager`: `core.tls` las resuelve al
    importarse, así que reasignar el origen ya no alcanza a nadie.
    """
    destino = tmp_path / "tls"
    monkeypatch.setattr(tls, "TLS_DIR", destino, raising=False)
    monkeypatch.setattr(tls, "ESTADO_FILE", destino / "estado.json", raising=False)
    return destino


@pytest.fixture
def caddy(monkeypatch):
    """Caddy de mentira. Devuelve el registro de llamadas que ha recibido."""
    llamadas = []

    def _admin(ruta, datos=None, tipo=None):
        llamadas.append({"ruta": ruta, "datos": datos, "tipo": tipo})
        if ruta.startswith("/pki/ca/"):
            return json.dumps({"root_certificate": "-----BEGIN CERTIFICATE-----\nX\n"}).encode()
        return b"{}"

    monkeypatch.setattr(tls, "_admin", _admin)
    return llamadas


# ── Estado ────────────────────────────────────────────────────────────────────

def test_sin_fichero_el_https_esta_apagado():
    assert tls.leerEstado() == {"activado": False, "nombres": [], "actualizado": None}
    assert tls.httpsActivo() is False


def test_el_estado_va_y_vuelve():
    tls.guardarEstado(True, ["portfolio.casa", "192.168.1.50"])

    estado = tls.leerEstado()
    assert estado["activado"] is True
    assert estado["nombres"] == ["portfolio.casa", "192.168.1.50"]
    assert estado["actualizado"]
    assert tls.httpsActivo() is True


def test_un_estado_ilegible_se_lee_como_apagado(estado_aislado):
    """Es lo que consulta cada respuesta para decidir si la cookie lleva Secure.

    Reventar aquí sería tumbar la aplicación entera por un fichero corrupto, y
    caer del lado de «activado» dejaría fuera a todo el mundo.
    """
    estado_aislado.mkdir(parents=True, exist_ok=True)
    (estado_aislado / "estado.json").write_text("{roto", encoding="utf-8")

    assert tls.leerEstado()["activado"] is False
    assert tls.httpsActivo() is False


def test_el_entorno_gana_al_fichero(monkeypatch):
    """Quien pone HTTPS_ENABLED tiene un proxy propio delante y no pasa por aquí."""
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    assert tls.httpsActivo() is True


# ── Nombres ───────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("entrada,esperado", [
    ("https://portfolio.casa:5000/ajustes", "portfolio.casa"),
    ("http://192.168.1.50", "192.168.1.50"),
    ("  PORTFOLIO.Casa. ", "portfolio.casa"),
])
def test_se_acepta_lo_que_el_usuario_tiene_en_la_barra(entrada, esperado):
    """Exigirle que desmonte la URL solo genera certificados mal emitidos."""
    assert tls.normalizarNombres([entrada]) == [esperado]


def test_los_nombres_no_se_repiten():
    assert tls.normalizarNombres(["casa", "https://casa", "CASA"]) == ["casa"]


def test_se_descarta_lo_que_rompería_el_caddyfile():
    """Un nombre con espacios o llaves se colaría en la configuración generada."""
    assert tls.normalizarNombres(["", "  ", "a b", "x{y}", "bien"]) == ["bien"]


# ── Configuración generada ────────────────────────────────────────────────────

def test_apagado_el_proxy_sirve_en_claro():
    conf = tls.construirCaddyfile(False, ["casa"])

    assert "tls internal" not in conf
    assert "auto_https off" in conf
    assert "reverse_proxy porfoliomanager:" in conf


def test_encendido_se_emite_certificado_para_cada_nombre():
    conf = tls.construirCaddyfile(True, ["portfolio.casa", "192.168.1.50"])

    assert "tls internal" in conf
    assert "https://portfolio.casa:" in conf
    assert "https://192.168.1.50:" in conf


def test_localhost_va_siempre_en_el_certificado():
    """Por localhost entran el healthcheck y la comprobación de docker-update.sh.

    Caddy rechaza la conexión si el nombre no tiene sitio, así que sin esto una
    actualización se daría por fallida y volvería atrás sola.
    """
    conf = tls.construirCaddyfile(True, ["portfolio.casa"])

    assert "https://localhost:" in conf
    assert "https://127.0.0.1:" in conf


def test_encender_sin_nombres_no_puede_dar_un_proxy_cerrado():
    """Sin nombres no hay certificado posible: mejor en claro que inaccesible."""
    conf = tls.construirCaddyfile(True, [])

    assert "tls internal" not in conf
    assert "auto_https off" in conf


def test_la_api_de_admin_no_se_publica_pero_sí_escucha():
    """La aplicación tiene que alcanzarla desde su contenedor."""
    assert "admin :2019" in tls.construirCaddyfile(False, [])


# ── Hablar con el proxy ───────────────────────────────────────────────────────

def test_aplicar_manda_el_caddyfile_a_la_api_de_admin(caddy):
    tls.aplicar(True, ["casa"])

    assert len(caddy) == 1
    assert caddy[0]["ruta"] == "/load"
    assert caddy[0]["tipo"] == "text/caddyfile"
    assert b"tls internal" in caddy[0]["datos"]


def test_si_el_proxy_no_responde_se_dice_cuál_es(monkeypatch):
    def _muerto(*_a, **_k):
        raise OSError("connection refused")

    monkeypatch.setattr(tls, "_admin", _muerto)

    with pytest.raises(tls.ErrorCaddy, match="caddy"):
        tls.aplicar(True, ["casa"])


def test_la_ca_se_pide_por_la_api_y_no_leyendo_su_volumen(caddy):
    """El volumen de Caddy pertenece a root y la aplicación corre sin privilegios."""
    pem = tls.raizDeLaCa()

    assert pem.startswith("-----BEGIN CERTIFICATE-----")
    assert [c["ruta"] for c in caddy] == ["/pki/ca/local"]


def test_sin_ca_todavía_se_explica_en_vez_de_devolver_vacío(monkeypatch):
    monkeypatch.setattr(tls, "_admin", lambda *_a, **_k: b'{"root_certificate": ""}')

    with pytest.raises(tls.ErrorCaddy, match="Activa el HTTPS"):
        tls.raizDeLaCa()


# ── Arranque ──────────────────────────────────────────────────────────────────

def test_al_arrancar_se_reaplica_el_estado_guardado(caddy):
    """Caddy y el estado pueden separarse (contenedor recreado, arranque a mano).

    Si el proxy volviera a servir en claro con el estado diciendo que hay HTTPS,
    las cookies saldrían con Secure sobre una conexión que no lo es y nadie
    podría entrar.
    """
    tls.guardarEstado(True, ["casa"])
    tls.converger()

    assert b"tls internal" in _ultimo_load(caddy)


def test_converger_no_impide_arrancar_si_el_proxy_está_caído(monkeypatch):
    """Tiene que haber interfaz desde la que arreglarlo."""
    def _muerto(*_a, **_k):
        raise OSError("connection refused")

    monkeypatch.setattr(tls, "_admin", _muerto)
    monkeypatch.setattr(tls, "_ESPERA_REINTENTO", 0)
    tls.guardarEstado(True, ["casa"])

    tls.converger()  # no lanza


def test_converger_reintenta_mientras_el_proxy_arranca(monkeypatch):
    """Los dos contenedores arrancan a la vez y `depends_on` no espera a que
    Caddy escuche: el primer intento cae en esa ventana con frecuencia."""
    intentos = []

    def _lento(ruta, datos=None, tipo=None):
        intentos.append(ruta)
        if len(intentos) < 3:
            raise OSError("connection refused")
        return b"{}"

    monkeypatch.setattr(tls, "_admin", _lento)
    monkeypatch.setattr(tls, "_ESPERA_REINTENTO", 0)
    tls.guardarEstado(True, ["casa"])

    tls.converger()

    assert len(intentos) == 3


def test_con_https_impuesto_por_entorno_no_se_toca_el_proxy(caddy, monkeypatch):
    """Ahí el TLS lo lleva un proxy propio: reconfigurarlo lo machacaría."""
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    tls.converger()

    assert _ultimo_load(caddy) is None


def test_el_aviso_de_http_plano_solo_sale_sin_https():
    assert "claro" in tls.avisoSinHttps()

    tls.guardarEstado(True, ["casa"])
    assert tls.avisoSinHttps() is None


# ── Endpoints ─────────────────────────────────────────────────────────────────

def _ultimo_load(caddy):
    """Última configuración cargada. `proxyDisponible()` también llama a la API,
    así que mirar la última llamada a secas daría el sondeo, no el /load."""
    cargas = [c for c in caddy if c["ruta"] == "/load"]
    return cargas[-1]["datos"] if cargas else None


@pytest.fixture
def bp_tls():
    from routes.tls import tls_bp
    return tls_bp


def test_los_endpoints_exigen_sesion(crear_app, bp_tls):
    """Un certificado raíz es público, pero instalarlo es decidir confiar en una
    autoridad para todos los sitios: servirlo sin autenticar invita a que alguien
    enlace a él desde fuera."""
    client = crear_app(bp_tls).test_client()

    assert client.get("/api/tls").status_code == 401
    assert client.get("/api/tls/ca.crt").status_code == 401


def test_el_estado_sugiere_el_nombre_por_el_que_has_entrado(cliente_autenticado, bp_tls, caddy):
    """Desde dentro de un contenedor no hay forma de saber la IP de la LAN, pero
    el Host de esta misma petición es literalmente lo que el usuario tiene
    escrito en la barra del navegador."""
    client, _cab, _app = cliente_autenticado(bp_tls)

    datos = client.get("/api/tls").get_json()

    assert datos["ok"] is True
    # El cliente de pruebas entra por localhost; en producción esto vale la IP o
    # el nombre que el usuario tenga escrito en la barra, que es justo lo que
    # hay que meter en el certificado.
    assert datos["nombreActual"] == "localhost"
    assert datos["activado"] is False


def test_activar_sin_nombres_se_rechaza(cliente_autenticado, bp_tls, caddy):
    client, cab, _app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls", headers=cab, json={"activado": True, "nombres": []})

    assert res.status_code == 400
    assert res.get_json()["field"] == "nombres"
    assert _ultimo_load(caddy) is None


def test_activar_configura_el_proxy_y_guarda_el_estado(cliente_autenticado, bp_tls, caddy):
    client, cab, app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls", headers=cab, json={
        "activado": True, "nombres": ["https://portfolio.casa:5000/"],
    })

    assert res.status_code == 200
    assert res.get_json()["activado"] is True
    assert b"tls internal" in _ultimo_load(caddy)
    assert tls.leerEstado()["nombres"] == ["portfolio.casa"]
    # La política de la cookie cambia sin reiniciar: Flask la lee de app.config
    # en cada respuesta, así que la siguiente ya sale con Secure.
    assert app.config["SESSION_COOKIE_SECURE"] is True


def test_si_el_proxy_rechaza_la_configuracion_no_se_guarda_nada(cliente_autenticado, bp_tls, monkeypatch):
    """El orden es lo que evita el bloqueo total.

    Un estado que dijera «HTTPS activo» sobre un proxy sirviendo en claro haría
    que las cookies salieran con Secure, el navegador las descartaría y no se
    podría iniciar sesión: la única salida sería entrar por SSH.
    """
    def _muerto(*_a, **_k):
        raise OSError("connection refused")

    monkeypatch.setattr(tls, "_admin", _muerto)
    client, cab, app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls", headers=cab, json={"activado": True, "nombres": ["casa"]})

    assert res.status_code == 502
    assert tls.leerEstado()["activado"] is False
    assert app.config["SESSION_COOKIE_SECURE"] is False


def test_desactivar_devuelve_el_proxy_a_texto_plano(cliente_autenticado, bp_tls, caddy):
    client, cab, app = cliente_autenticado(bp_tls)
    client.post("/api/tls", headers=cab, json={"activado": True, "nombres": ["casa"]})

    res = client.post("/api/tls", headers=cab, json={"activado": False})

    assert res.status_code == 200
    assert b"tls internal" not in _ultimo_load(caddy)
    assert tls.leerEstado()["activado"] is False
    assert app.config["SESSION_COOKIE_SECURE"] is False


def test_con_https_impuesto_por_entorno_el_interruptor_se_niega(cliente_autenticado, bp_tls, caddy, monkeypatch):
    """Aceptarlo machacaría la configuración del proxy que lleva ese despliegue."""
    monkeypatch.setenv("HTTPS_ENABLED", "true")
    client, cab, _app = cliente_autenticado(bp_tls)

    assert client.get("/api/tls").get_json()["gestionadoPorEntorno"] is True

    res = client.post("/api/tls", headers=cab, json={"activado": False})
    assert res.status_code == 409
    assert _ultimo_load(caddy) is None


def test_la_ca_se_descarga_como_fichero(cliente_autenticado, bp_tls, caddy):
    """El tipo x-x509-ca-cert es el que hace que iOS ofrezca instalarlo como
    perfil en vez de enseñarlo como texto."""
    client, _cab, _app = cliente_autenticado(bp_tls)

    res = client.get("/api/tls/ca.crt")

    assert res.status_code == 200
    assert res.headers["Content-Type"] == "application/x-x509-ca-cert"
    assert "attachment" in res.headers["Content-Disposition"]
    assert res.data.startswith(b"-----BEGIN CERTIFICATE-----")
