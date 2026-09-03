"""El diagnóstico de proveedores que se ve en Ajustes > API.

Lo que decide es cómo se traduce el fallo de un proveedor a algo accionable: no
es lo mismo "se acabó la cuota de hoy" (esperar a mañana) que "la clave ya no
vale" (entrar y cambiarla) o "no responde" (no es cosa del usuario). Si esos
tres casos acaban pintados igual, la pantalla no sirve de nada.

Ningún test sale a la red: se sustituye `fetch_json`, que es justo la frontera
por la que se habla con los proveedores.
"""

from urllib.error import HTTPError, URLError

import pytest

from providers import estado


@pytest.fixture(autouse=True)
def sin_cache():
    estado.reiniciar_para_pruebas()
    yield
    estado.reiniciar_para_pruebas()


_LECTORES = ("readFinnhubApiKey", "readEodhdApiKey", "readAlphaVantageApiKey")


def _claves(monkeypatch, valor):
    from stores import app_data

    for lector in _LECTORES:
        monkeypatch.setattr(app_data, lector, lambda valor=valor: valor)


@pytest.fixture
def con_claves(monkeypatch):
    """Los tres proveedores con clave la tienen configurada."""
    _claves(monkeypatch, "clave-de-prueba")


def _respuesta(monkeypatch, funcion):
    monkeypatch.setattr(estado, "fetch_json", funcion)


def _por_id(filas):
    return {fila["id"]: fila for fila in filas}


def _http(codigo):
    return HTTPError("https://proveedor", codigo, "nope", {}, None)


# ── Traducción de cada fallo ─────────────────────────────────────────────────

def test_un_proveedor_que_responde_sale_operativo(monkeypatch, con_claves):
    _respuesta(monkeypatch, lambda *a, **k: {"c": 1})

    assert _por_id(estado.comprobar())["finnhub"]["estado"] == "ok"


def test_sin_clave_no_se_llama_al_proveedor(monkeypatch):
    """Llamar sin clave gastaría una petición para obtener un 401 previsible."""
    llamadas = []
    _claves(monkeypatch, None)
    _respuesta(monkeypatch, lambda *a, **k: llamadas.append(k.get("provider")) or {})

    filas = _por_id(estado.comprobar())

    assert filas["finnhub"]["estado"] == "sin_clave"
    assert filas["eodhd"]["estado"] == "sin_clave"
    assert filas["alphavantage"]["estado"] == "sin_clave"
    assert "Finnhub" not in llamadas


def test_el_429_es_cuota_agotada_y_no_una_caida(monkeypatch, con_claves):
    def falla(*a, **k):
        raise _http(429)

    _respuesta(monkeypatch, falla)

    assert _por_id(estado.comprobar())["finnhub"]["estado"] == "limite"


def test_el_402_de_eodhd_tambien_es_cuota(monkeypatch, con_claves):
    def falla(*a, **k):
        raise _http(402)

    _respuesta(monkeypatch, falla)

    assert _por_id(estado.comprobar())["eodhd"]["estado"] == "limite"


def test_el_401_señala_la_clave_no_el_servicio(monkeypatch, con_claves):
    def falla(*a, **k):
        raise _http(401)

    _respuesta(monkeypatch, falla)

    assert _por_id(estado.comprobar())["finnhub"]["estado"] == "clave"


def test_un_5xx_es_una_caida_del_proveedor(monkeypatch, con_claves):
    def falla(*a, **k):
        raise _http(503)

    _respuesta(monkeypatch, falla)

    assert _por_id(estado.comprobar())["finnhub"]["estado"] == "caido"


def test_sin_conexion_el_proveedor_figura_como_caido(monkeypatch, con_claves):
    def falla(*a, **k):
        raise URLError("Connection refused")

    _respuesta(monkeypatch, falla)

    fila = _por_id(estado.comprobar())["yahoo"]
    assert fila["estado"] == "caido"
    assert "Connection refused" in fila["detalle"]


def test_alpha_vantage_avisa_del_limite_dentro_de_un_200(monkeypatch, con_claves):
    """Alpha Vantage devuelve 200 con una nota cuando se agota la cuota diaria.

    Mirando solo el código HTTP, la cuota agotada saldría como "Operativa": es
    exactamente el caso que esta pantalla existe para detectar.
    """
    def responde(url, params=None, **k):
        if "alphavantage" in url:
            return {"Note": "Thank you for using Alpha Vantage! Our standard API rate limit is…"}
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    fila = _por_id(estado.comprobar())["alphavantage"]
    assert fila["estado"] == "limite"
    assert "rate limit" in fila["detalle"]


def test_alpha_vantage_distingue_la_clave_invalida(monkeypatch, con_claves):
    def responde(url, params=None, **k):
        if "alphavantage" in url:
            return {"Error Message": "the parameter apikey is invalid"}
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    assert _por_id(estado.comprobar())["alphavantage"]["estado"] == "clave"


def test_un_proveedor_caido_no_arrastra_a_los_demas(monkeypatch, con_claves):
    def responde(url, params=None, **k):
        if "finnhub" in url:
            raise URLError("timed out")
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    filas = _por_id(estado.comprobar())
    assert filas["finnhub"]["estado"] == "caido"
    assert filas["yahoo"]["estado"] == "ok"
    assert filas["divisas"]["estado"] == "ok"


def test_el_orden_de_la_lista_no_depende_de_quien_conteste_antes(monkeypatch, con_claves):
    _respuesta(monkeypatch, lambda *a, **k: {"c": 1})

    ids = [fila["id"] for fila in estado.comprobar()]

    assert ids == [proveedor[0] for proveedor in estado._PROVEEDORES]


# ── Caché ────────────────────────────────────────────────────────────────────

def test_el_resultado_se_cachea_para_no_gastar_cuota(monkeypatch, con_claves):
    """El sondeo son llamadas reales: refrescar la pantalla no puede repetirlo."""
    llamadas = []
    _respuesta(monkeypatch, lambda *a, **k: llamadas.append(1) or {"c": 1})

    estado.obtener()
    segunda = estado.obtener()

    assert segunda["cacheado"] is True
    assert len(llamadas) == len(estado._PROVEEDORES)


def test_forzar_vuelve_a_comprobar(monkeypatch, con_claves):
    llamadas = []
    _respuesta(monkeypatch, lambda *a, **k: llamadas.append(1) or {"c": 1})

    estado.obtener()
    segunda = estado.obtener(forzar=True)

    assert segunda["cacheado"] is False
    assert len(llamadas) == 2 * len(estado._PROVEEDORES)


# ── Endpoint ─────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db):
    from routes.ajustes import ajustes_bp

    client, cabeceras, _app = cliente_autenticado(ajustes_bp)
    return client, cabeceras


def test_el_endpoint_devuelve_una_fila_por_proveedor(cliente, monkeypatch, con_claves):
    client, _cabeceras = cliente
    _respuesta(monkeypatch, lambda *a, **k: {"c": 1})

    datos = client.get("/api/stats/api-estado").get_json()

    assert datos["ok"] is True
    assert len(datos["proveedores"]) == len(estado._PROVEEDORES)
    assert all(fila["estado"] == "ok" for fila in datos["proveedores"])


def test_el_endpoint_no_publica_la_clave(cliente, monkeypatch):
    """El detalle del error viene del proveedor y podría arrastrar la URL."""
    client, _cabeceras = cliente
    _claves(monkeypatch, "clave-secreta-1")

    def falla(*a, **k):
        raise URLError("no se pudo conectar")

    _respuesta(monkeypatch, falla)

    assert "clave-secreta-1" not in client.get("/api/stats/api-estado").get_data(as_text=True)


def test_el_endpoint_exige_sesion(crear_app):
    """Es un diagnóstico: dice qué proveedores usa la instalación y si fallan.

    Además, sondear sin sesión sería una forma gratuita de gastarle la cuota a
    otro.
    """
    from routes.ajustes import ajustes_bp

    client = crear_app(ajustes_bp).test_client()

    assert client.get("/api/stats/api-estado").status_code == 401
