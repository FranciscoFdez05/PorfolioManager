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
import time

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


@pytest.mark.parametrize("nombres,entrando,cubierto", [
    (["192.168.1.50"], "192.168.1.50", True),
    (["localhost"], "192.168.1.50", False),
    # localhost y 127.0.0.1 van siempre en el certificado, se escriban o no.
    (["192.168.1.50"], "localhost", True),
    (["192.168.1.50"], "127.0.0.1", True),
    # Lo que llega del Host de la petición viene con puerto y en cualquier caja.
    (["portfolio.casa"], "PORTFOLIO.Casa", True),
    # Sin nombre no hay nada que objetar.
    (["portfolio.casa"], "", True),
])
def test_se_sabe_si_el_certificado_cubriría_por_donde_entras(nombres, entrando, cubierto):
    """La pregunta que decide si activar el HTTPS te deja fuera de tu propia app."""
    assert tls.cubre(nombres, entrando) is cubierto


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


# ── Preparación ───────────────────────────────────────────────────────────────
# El paso que evita quedarse fuera: se emite el certificado sin que el puerto por
# el que está entrando el usuario deje de hablar en claro.

def test_preparando_el_puerto_de_siempre_no_cambia_de_esquema():
    """Es toda la razón de ser de este estado.

    Si al preparar el puerto pasara a TLS, estaríamos otra vez donde estábamos:
    la respuesta llega por un canal que el navegador ya no acepta, y el usuario
    se queda fuera antes de haber podido descargar el certificado.
    """
    conf = tls.construirCaddyfile(False, ["portfolio.casa"], preparando=True)

    puerto = tls.settings.puerto()
    assert f"http://:{puerto} {{" in conf
    assert f"https://portfolio.casa:{puerto}" not in conf
    assert "reverse_proxy porfoliomanager:" in conf


def test_preparando_se_emite_el_certificado_en_un_puerto_interno():
    """El puerto no está publicado en docker-compose: no es una segunda puerta
    de entrada, solo la excusa para que haya un certificado que emitir."""
    conf = tls.construirCaddyfile(False, ["portfolio.casa"], preparando=True)

    assert f"https://portfolio.casa:{tls.PUERTO_PREPARACION}" in conf
    assert "tls internal" in conf
    assert f"reverse_proxy porfoliomanager:{tls.PUERTO_PREPARACION}" not in conf


def test_se_prepara_con_los_mismos_nombres_con_los_que_se_activará():
    """Lo que se instala tiene que valer para lo que luego se sirva: emitir aquí
    una lista y allí otra dejaría al usuario con la CA puesta y el aviso igual."""
    preparado = tls.construirCaddyfile(False, ["portfolio.casa"], preparando=True)
    activado = tls.construirCaddyfile(True, ["portfolio.casa"])

    for nombre in ("portfolio.casa", "localhost", "127.0.0.1"):
        assert f"https://{nombre}:" in preparado
        assert f"https://{nombre}:" in activado


def test_el_sitio_de_comprobación_existe_en_los_dos_estados():
    """Antes de encender sirve para probar sin arriesgar nada; con el HTTPS ya
    puesto, para que un aparato nuevo se compruebe sin jugarse la entrada."""
    for conf in (
        tls.construirCaddyfile(False, ["casa"], preparando=True),
        tls.construirCaddyfile(True, ["casa"]),
    ):
        assert f"https://casa:{tls.PUERTO_PREPARACION}" in conf
        assert "El certificado funciona en este aparato" in conf


def test_el_sitio_de_comprobación_no_lleva_a_la_aplicación():
    """Es una página fija, no una segunda puerta de entrada: el puerto se
    publica, y lo que se publica tiene que poder mirarse sin encogerse."""
    conf = tls.construirCaddyfile(False, ["casa"], preparando=True)

    bloque = conf.split(f"https://casa:{tls.PUERTO_PREPARACION}")[1]
    assert "reverse_proxy" not in bloque


def test_la_página_de_comprobación_no_puede_romper_el_caddyfile():
    """Va dentro de un token entrecomillado: una comilla doble lo cerraría y una
    llave sería un marcador de Caddy. Las dos cosas dejarían al proxy sin
    configuración válida justo cuando se va a tocar el TLS."""
    assert '"' not in tls._PAGINA_PRUEBA
    assert "{" not in tls._PAGINA_PRUEBA and "}" not in tls._PAGINA_PRUEBA
    assert tls._PAGINA_PRUEBA.isascii()


def test_preparar_sin_nombres_deja_el_proxy_como_estaba():
    """Sin nombres no hay nada que emitir, y tocar el proxy para nada solo puede
    salir mal."""
    conf = tls.construirCaddyfile(False, [], preparando=True)

    assert "tls internal" not in conf
    assert "auto_https off" in conf


def test_preparar_devuelve_la_ca_ya_lista_para_instalar(caddy):
    """Devolver antes de tenerla sería ofrecer un botón de descarga que da 502."""
    pem = tls.preparar(["portfolio.casa"])

    assert pem.startswith("-----BEGIN CERTIFICATE-----")
    assert b"tls internal" in _ultimo_load(caddy)


def test_preparar_espera_a_que_la_ca_exista(monkeypatch):
    """La raíz se genera durante la emisión, no al aceptar la configuración: la
    primera vez puede no estar en la respuesta inmediatamente siguiente."""
    intentos = []

    def _tardon(ruta, datos=None, tipo=None):
        if not ruta.startswith("/pki/ca/"):
            return b"{}"
        intentos.append(ruta)
        if len(intentos) < 3:
            return b'{"root_certificate": ""}'
        return json.dumps({"root_certificate": "-----BEGIN CERTIFICATE-----\nX\n"}).encode()

    monkeypatch.setattr(tls, "_admin", _tardon)
    monkeypatch.setattr(tls, "_ESPERA_CA", 0)

    assert tls.preparar(["casa"]).startswith("-----BEGIN CERTIFICATE-----")
    assert len(intentos) == 3


def test_si_la_ca_no_llega_a_aparecer_se_dice(monkeypatch):
    """Callar aquí dejaría el panel ofreciendo un certificado que no existe."""
    monkeypatch.setattr(tls, "_admin", lambda *_a, **_k: b'{"root_certificate": ""}')
    monkeypatch.setattr(tls, "_ESPERA_CA", 0)

    with pytest.raises(tls.ErrorCaddy, match="no ha llegado a emitir"):
        tls.preparar(["casa"])


def test_hay_ca_que_instalar_en_cuanto_se_ha_emitido_algo(caddy):
    assert tls.caDisponible() is True


def test_sin_ca_todavía_el_panel_no_ofrece_descargarla(monkeypatch):
    """Es lo que decide si se enseña el botón de descarga: ofrecerlo sin CA sería
    ofrecer un error."""
    monkeypatch.setattr(tls, "_admin", lambda *_a, **_k: b'{"root_certificate": ""}')

    assert tls.caDisponible() is False


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


# ── Nombres sugeridos ─────────────────────────────────────────────────────────

def test_se_sugiere_el_nombre_de_la_barra_y_la_ip_de_la_lan(monkeypatch):
    """Las dos juntas, porque olvidar la IP de la LAN es el fallo silencioso de
    esta pantalla: el certificado se emite bien, pero no cubre por donde se
    entra desde el móvil."""
    monkeypatch.setenv("PORTFOLIO_LAN_IP", "192.168.1.163")

    assert tls.nombresSugeridos("portfolio.casa:5000") == ["portfolio.casa", "192.168.1.163"]


def test_sin_ip_de_la_lan_se_sugiere_lo_que_haya(monkeypatch):
    """Fuera de Docker nadie rellena PORTFOLIO_LAN_IP, y el panel tiene que
    seguir llegando con algo puesto."""
    monkeypatch.delenv("PORTFOLIO_LAN_IP", raising=False)

    assert tls.nombresSugeridos("localhost:5000") == ["localhost"]


def test_no_se_sugiere_dos_veces_lo_mismo(monkeypatch):
    """Se entra por la IP de la LAN: las dos pistas coinciden."""
    monkeypatch.setenv("PORTFOLIO_LAN_IP", "192.168.1.163")

    assert tls.nombresSugeridos("192.168.1.163:5000") == ["192.168.1.163"]


# ── Comprobación ──────────────────────────────────────────────────────────────

def test_el_resumen_saca_del_certificado_lo_que_se_pregunta():
    """Qué nombres cubre y cuánto le queda: lo demás del certificado no le
    resuelve ninguna duda a quien mira el panel."""
    fin = time.time() + 30 * 86400
    cert = {
        "subjectAltName": (
            ("DNS", "portfolio.casa"),
            ("IP Address", "192.168.1.50"),
            ("othername", "algo que no se pinta"),
        ),
        "notAfter": time.strftime("%b %d %H:%M:%S %Y GMT", time.gmtime(fin)),
    }

    resumen = tls._resumenCertificado(cert)

    assert resumen["cubre"] == ["portfolio.casa", "192.168.1.50"]
    # Hacia abajo a propósito: a un certificado con 29 horas le queda un día.
    assert resumen["dias"] in (29, 30)


def test_un_certificado_sin_fecha_no_revienta_la_prueba():
    """Viene de la red: si el campo falta o es raro, se informa sin fecha en vez
    de tumbar la comprobación entera."""
    resumen = tls._resumenCertificado({"notAfter": "el mes que viene"})

    assert resumen["caduca"] is None
    assert resumen["dias"] is None


def test_sin_certificado_todavía_la_prueba_dice_qué_falta(caddy):
    """Servir en claro es una decisión legítima del usuario, no un error. Pero
    aquí no hay nada que comprobar, y decirlo es más útil que un resultado
    vacío: lo que falta es pulsar el botón de emitir."""
    salida = tls.probar()

    assert salida["https"] is False
    assert salida["modo"] == "previo"
    assert "Emitir el certificado" in salida["error"]
    assert salida["nombres"] == []


def test_el_certificado_se_comprueba_antes_de_activar(caddy, monkeypatch):
    """El arreglo entero: la comprobación deja de ser un diagnóstico póstumo.

    Con el HTTPS apagado pero el certificado ya emitido, se comprueba contra el
    puerto de preparación —que sirve exactamente el mismo certificado—, así que
    se sabe si va a funcionar sin haberse jugado la sesión.
    """
    puertos = []

    def _fingido(contexto, nombre, puerto):
        puertos.append(puerto)
        return {"nombre": nombre, "ok": True, "error": None, "cubre": [nombre],
                "caduca": None, "dias": None}

    monkeypatch.setattr(tls, "_probarNombre", _fingido)
    monkeypatch.setattr(tls, "_contextoDeConfianza", lambda: None)
    tls.guardarEstado(False, ["portfolio.casa"])

    salida = tls.probar()

    assert salida["https"] is False
    assert salida["modo"] == "previo"
    assert salida["puerto"] == tls.PUERTO_PREPARACION
    assert puertos == [tls.PUERTO_PREPARACION]
    assert salida["error"] is None


def test_con_el_https_puesto_se_comprueba_el_puerto_de_verdad(caddy, monkeypatch):
    """Ahí la pregunta ya es otra: no si el certificado vale, sino si el puerto
    por el que entra la gente lo está sirviendo."""
    puertos = []

    def _fingido(contexto, nombre, puerto):
        puertos.append(puerto)
        return {"nombre": nombre, "ok": True, "error": None, "cubre": [nombre],
                "caduca": None, "dias": None}

    monkeypatch.setattr(tls, "_probarNombre", _fingido)
    monkeypatch.setattr(tls, "_contextoDeConfianza", lambda: None)
    tls.guardarEstado(True, ["portfolio.casa"])

    salida = tls.probar()

    assert salida["modo"] == "activo"
    assert puertos == [tls.settings.puerto()]


def test_la_prueba_vuelve_a_levantar_el_sitio_de_comprobación(monkeypatch):
    """Se cae al reiniciar la aplicación, porque al arrancar se reaplica el
    estado guardado y ahí el HTTPS está apagado.

    Sin esto, el botón daría «no se puede conectar» al día siguiente y parecería
    un problema del certificado, que es justo lo que se viene a descartar.
    """
    cargas = []

    def _admin(ruta, datos=None, tipo=None):
        if ruta == "/load":
            cargas.append(datos)
            return b"{}"
        if ruta.startswith("/pki/ca/"):
            return json.dumps({"root_certificate": "-----BEGIN CERTIFICATE-----\nX\n"}).encode()
        # La configuración cargada no menciona el puerto de comprobación: es lo
        # que queda tras un reinicio con el HTTPS apagado.
        return b'{"apps": {"http": {"servers": {"srv0": {"listen": [":5000"]}}}}}'

    monkeypatch.setattr(tls, "_admin", _admin)
    monkeypatch.setattr(tls, "_probarNombre", lambda *_a: {
        "nombre": "casa", "ok": True, "error": None, "cubre": [], "caduca": None, "dias": None,
    })
    monkeypatch.setattr(tls, "_contextoDeConfianza", lambda: None)
    tls.guardarEstado(False, ["casa"])

    tls.probar()

    assert cargas, "no se ha vuelto a levantar el sitio de comprobación"
    assert f"https://casa:{tls.PUERTO_PREPARACION}".encode() in cargas[-1]


def test_con_el_proxy_caido_la_prueba_dice_dónde_mirar(monkeypatch):
    def _muerto(ruta, datos=None, tipo=None):
        raise OSError("connection refused")

    monkeypatch.setattr(tls, "_admin", _muerto)
    tls.guardarEstado(True, ["portfolio.casa"])

    salida = tls.probar()

    assert salida["proxy"] is False
    assert "caddy" in salida["error"]
    assert salida["nombres"] == []


def test_se_comprueba_cada_nombre_y_manda_el_que_caduca_antes(caddy, monkeypatch):
    """El resumen se queda con el plazo más corto porque es el que va a dar el
    primer susto; con el más largo, un certificado a punto de caducar se
    escondería detrás de otro recién emitido."""
    plazos = {"portfolio.casa": 90, "192.168.1.50": 7}

    def _fingido(contexto, nombre, puerto):
        return {"nombre": nombre, "ok": True, "error": None, "cubre": [nombre],
                "caduca": f"2026-01-{plazos[nombre]:02d}", "dias": plazos[nombre]}

    monkeypatch.setattr(tls, "_probarNombre", _fingido)
    monkeypatch.setattr(tls, "_contextoDeConfianza", lambda: None)
    tls.guardarEstado(True, ["portfolio.casa", "192.168.1.50"])

    salida = tls.probar()

    assert [r["nombre"] for r in salida["nombres"]] == ["portfolio.casa", "192.168.1.50"]
    assert salida["dias"] == 7


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
    assert client.get("/api/tls/prueba").status_code == 401
    assert client.post("/api/tls/preparar", json={"nombres": ["casa"]}).status_code == 401


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
    # El puerto de comprobación lo pone el servidor y el nombre lo pone el
    # navegador: la URL para probar desde el aparato se arma con los dos.
    assert datos["puertoPrueba"] == tls.PUERTO_PREPARACION


def test_preparar_emite_el_certificado_sin_encender_nada(cliente_autenticado, bp_tls, caddy):
    """El caso entero de este endpoint: al terminar hay algo que instalar y la
    conexión sigue exactamente como estaba.

    Si de aquí saliera el HTTPS activado, la respuesta viajaría por un puerto que
    ya solo habla TLS y el navegador la rechazaría: el usuario se quedaría fuera
    con el certificado sin descargar, que es justo lo que se viene a evitar.
    """
    client, cab, app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls/preparar", headers=cab, json={
        "nombres": ["https://portfolio.casa:5000/"],
    })

    assert res.status_code == 200
    datos = res.get_json()
    assert datos["activado"] is False
    assert datos["caDisponible"] is True
    # Los nombres se recuerdan: entre instalar el certificado y volver a pulsar
    # se pasa por los Ajustes del móvil, y se recarga la página más de una vez.
    assert datos["nombres"] == ["portfolio.casa"]
    assert tls.leerEstado()["activado"] is False
    # Y la cookie sigue sin Secure, porque esto sigue viajando en claro. Al revés
    # el navegador la descartaría y no se podría ni iniciar sesión.
    assert app.config["SESSION_COOKIE_SECURE"] is False


def test_preparar_deja_el_puerto_de_la_aplicacion_en_claro(cliente_autenticado, bp_tls, caddy):
    client, cab, _app = cliente_autenticado(bp_tls)

    client.post("/api/tls/preparar", headers=cab, json={"nombres": ["portfolio.casa"]})

    cargado = _ultimo_load(caddy).decode()
    assert f"http://:{tls.settings.puerto()} {{" in cargado
    assert f"https://portfolio.casa:{tls.PUERTO_PREPARACION}" in cargado


def test_preparar_sin_nombres_se_rechaza(cliente_autenticado, bp_tls, caddy):
    """La misma validación que activar: el certificado que se emite es el mismo,
    y lo que no vale en un paso no puede colarse por el otro."""
    client, cab, _app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls/preparar", headers=cab, json={"nombres": []})

    assert res.status_code == 400
    assert res.get_json()["field"] == "nombres"
    assert _ultimo_load(caddy) is None


def test_preparar_con_el_https_ya_puesto_no_toca_el_proxy(cliente_autenticado, bp_tls, caddy):
    """Ahí no hay nada que preparar —la CA ya existe y se descarga tal cual—, y
    recargar el proxy con la configuración en claro tiraría al usuario."""
    client, cab, _app = cliente_autenticado(bp_tls)
    client.post("/api/tls", headers=cab, json={"activado": True, "nombres": ["casa"]})

    res = client.post("/api/tls/preparar", headers=cab, json={"nombres": ["casa"]})

    assert res.status_code == 409
    assert b"tls internal" in _ultimo_load(caddy)


def test_la_comprobacion_levanta_el_puerto_si_se_ha_caido(cliente_autenticado, bp_tls, monkeypatch):
    """El sitio de comprobación no sobrevive a un reinicio: al arrancar se
    reaplica el estado guardado, y con el HTTPS apagado ahí no hay TLS.

    Sin esto, «Probar en este aparato» llevaba a una conexión rechazada, que
    manda a revisar el certificado cuando lo que pasa es que no hay nadie
    escuchando.
    """
    cargas = []

    def _admin(ruta, datos=None, tipo=None):
        if ruta == "/load":
            cargas.append(datos)
            return b"{}"
        if ruta.startswith("/pki/ca/"):
            return json.dumps({"root_certificate": "-----BEGIN CERTIFICATE-----\nX\n"}).encode()
        return b'{"apps": {"http": {"servers": {"srv0": {"listen": [":5000"]}}}}}'

    monkeypatch.setattr(tls, "_admin", _admin)
    client, cab, _app = cliente_autenticado(bp_tls)
    tls.guardarEstado(False, ["192.168.1.163"])

    res = client.post("/api/tls/comprobacion", headers=cab)

    assert res.status_code == 200
    assert res.get_json()["listo"] is True
    assert f"https://192.168.1.163:{tls.PUERTO_PREPARACION}".encode() in cargas[-1]
    # Y sigue sin encender nada: el puerto de la aplicación en claro.
    assert f"http://:{tls.settings.puerto()}".encode() in cargas[-1]


def test_la_comprobacion_no_toca_el_proxy_si_ya_está_en_pie(cliente_autenticado, bp_tls, monkeypatch):
    """Recargar la configuración por gusto es tocar el proxy que sostiene la
    sesión: si el puerto ya está, no se hace nada."""
    cargas = []

    def _admin(ruta, datos=None, tipo=None):
        if ruta == "/load":
            cargas.append(datos)
            return b"{}"
        if ruta.startswith("/pki/ca/"):
            return json.dumps({"root_certificate": "-----BEGIN CERTIFICATE-----\nX\n"}).encode()
        return f'{{"listen": [":{tls.PUERTO_PREPARACION}"]}}'.encode()

    monkeypatch.setattr(tls, "_admin", _admin)
    client, cab, _app = cliente_autenticado(bp_tls)
    tls.guardarEstado(False, ["casa"])

    assert client.post("/api/tls/comprobacion", headers=cab).status_code == 200
    assert cargas == []


def test_la_comprobacion_sin_certificado_dice_qué_falta(cliente_autenticado, bp_tls, caddy):
    client, cab, _app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls/comprobacion", headers=cab)

    assert res.status_code == 409
    assert "Emitir el certificado" in res.get_json()["error"]


def test_activar_sin_nombres_se_rechaza(cliente_autenticado, bp_tls, caddy):
    client, cab, _app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls", headers=cab, json={"activado": True, "nombres": []})

    assert res.status_code == 400
    assert res.get_json()["field"] == "nombres"
    assert _ultimo_load(caddy) is None


def test_no_se_activa_un_certificado_que_no_cubre_por_donde_entras(cliente_autenticado, bp_tls, caddy):
    """El fallo que se lleva por delante el acceso, y no puede ser lo que nadie
    quería.

    Al saltar a https:// por esa misma dirección el navegador corta, y la
    pantalla desde la que se arregla queda detrás del aviso: la única salida es
    saltárselo o entrar por SSH. Así que no se acepta, y el mensaje dice qué
    nombre falta.
    """
    from core.errors import ValidationError
    from routes.tls import _validar_que_no_te_deja_fuera

    _client, _cab, app = cliente_autenticado(bp_tls)

    # Se entra por la petición y no por el cliente porque cambiarle el Host le
    # cambia también el origen de la cookie: se acabaría comprobando el login,
    # no esto. Lo que decide aquí es el Host, y es lo que se fija.
    with (
        app.test_request_context("/api/tls", headers={"Host": "192.168.1.50:5000"}),
        pytest.raises(ValidationError) as fallo,
    ):
        _validar_que_no_te_deja_fuera(["portfolio.casa"])

    assert "192.168.1.50" in str(fallo.value)
    assert _ultimo_load(caddy) is None
    assert tls.leerEstado()["activado"] is False


def test_activar_desde_localhost_no_se_bloquea(cliente_autenticado, bp_tls, caddy):
    """Es el caso normal de quien enciende esto desde el propio servidor: el
    certificado lleva localhost siempre, así que nadie se queda fuera."""
    client, cab, _app = cliente_autenticado(bp_tls)

    res = client.post("/api/tls", headers=cab, json={
        "activado": True, "nombres": ["192.168.1.50"],
    })

    assert res.status_code == 200


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


def test_la_prueba_contesta_aunque_no_haya_nada_que_comprobar(cliente_autenticado, bp_tls, caddy):
    """Con el HTTPS apagado sigue siendo un 200: la interfaz necesita pintar el
    estado, no un error."""
    client, _cab, _app = cliente_autenticado(bp_tls)

    datos = client.get("/api/tls/prueba").get_json()

    assert datos["ok"] is True
    assert datos["https"] is False
