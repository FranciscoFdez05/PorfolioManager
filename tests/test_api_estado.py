"""El diagnóstico de proveedores que se ve en Ajustes > API.

Lo que decide es cómo se traduce el fallo de un proveedor a algo accionable: no
es lo mismo "se acabó la cuota de hoy" (esperar a mañana) que "la clave ya no
vale" (entrar y cambiarla) o "no responde" (no es cosa del usuario). Si esos
tres casos acaban pintados igual, la pantalla no sirve de nada.

Ningún test sale a la red: se sustituye `fetchJson`, que es justo la frontera
por la que se habla con los proveedores.
"""

from urllib.error import HTTPError, URLError

import pytest

from providers import estado


@pytest.fixture(autouse=True)
def sinCache():
    estado.reiniciarParaPruebas()
    yield
    estado.reiniciarParaPruebas()


_LECTORES = ("readFinnhubApiKey", "readEodhdApiKey", "readAlphaVantageApiKey")
# EODHD y Alpha Vantage admiten varias claves y el sondeo las recorre, así que
# hay que parchear también estos: si no, la prueba acabaría leyendo las claves
# reales de API/ del equipo que ejecuta la suite.
_LECTORES_LISTA = ("readFinnhubApiKeys", "readEodhdApiKeys", "readAlphaVantageApiKeys")


def _claves(monkeypatch, valor, lista=None):
    from stores import app_data

    for lector in _LECTORES:
        monkeypatch.setattr(app_data, lector, lambda valor=valor: valor)

    if lista is None:
        lista = [valor] if valor else []

    for lector in _LECTORES_LISTA:
        monkeypatch.setattr(app_data, lector, lambda lista=lista: list(lista))


@pytest.fixture
def conClaves(monkeypatch):
    """Los tres proveedores con clave la tienen configurada."""
    _claves(monkeypatch, "clave-de-prueba")


def _respuesta(monkeypatch, funcion):
    monkeypatch.setattr(estado, "fetchJson", funcion)


def _porId(filas):
    return {fila["id"]: fila for fila in filas}


def _http(codigo):
    return HTTPError("https://proveedor", codigo, "nope", {}, None)


# ── Traducción de cada fallo ─────────────────────────────────────────────────

def testUnProveedorQueRespondeSaleOperativo(monkeypatch, conClaves):
    _respuesta(monkeypatch, lambda *a, **k: {"c": 1})

    assert _porId(estado.comprobar())["finnhub"]["estado"] == "ok"


def testSinClaveNoSeLlamaAlProveedor(monkeypatch):
    """Llamar sin clave gastaría una petición para obtener un 401 previsible."""
    llamadas = []
    _claves(monkeypatch, None)
    _respuesta(monkeypatch, lambda *a, **k: llamadas.append(k.get("provider")) or {})

    filas = _porId(estado.comprobar())

    assert filas["finnhub"]["estado"] == "sin_clave"
    assert filas["eodhd"]["estado"] == "sin_clave"
    assert filas["alphavantage"]["estado"] == "sin_clave"
    assert "Finnhub" not in llamadas


def testEl429EsCuotaAgotadaYNoUnaCaida(monkeypatch, conClaves):
    def falla(*a, **k):
        raise _http(429)

    _respuesta(monkeypatch, falla)

    assert _porId(estado.comprobar())["finnhub"]["estado"] == "limite"


def testEl402DeEodhdTambienEsCuota(monkeypatch, conClaves):
    def falla(*a, **k):
        raise _http(402)

    _respuesta(monkeypatch, falla)

    assert _porId(estado.comprobar())["eodhd"]["estado"] == "limite"


def testEl401SeñalaLaClaveNoElServicio(monkeypatch, conClaves):
    def falla(*a, **k):
        raise _http(401)

    _respuesta(monkeypatch, falla)

    assert _porId(estado.comprobar())["finnhub"]["estado"] == "clave"


def testEl403EsUnLimiteDePlanYNoUnaClaveRechazada(monkeypatch, conClaves):
    """Finnhub contesta 403 cuando el plan no cubre lo pedido, con la clave bien.

    Mandaba al usuario a cambiar una clave que funciona: el problema es el plan
    —fuera de EE. UU. y los históricos no entran en el gratuito— y ninguna clave
    nueva lo iba a arreglar.
    """
    def falla(*a, **k):
        raise _http(403)

    _respuesta(monkeypatch, falla)

    fila = _porId(estado.comprobar())["finnhub"]
    assert fila["estado"] == "plan"
    assert fila["etiqueta"] == "Fuera del plan"


def testUn5xxEsUnaCaidaDelProveedor(monkeypatch, conClaves):
    def falla(*a, **k):
        raise _http(503)

    _respuesta(monkeypatch, falla)

    assert _porId(estado.comprobar())["finnhub"]["estado"] == "caido"


def testSinConexionElProveedorFiguraComoCaido(monkeypatch, conClaves):
    def falla(*a, **k):
        raise URLError("Connection refused")

    _respuesta(monkeypatch, falla)

    fila = _porId(estado.comprobar())["yahoo"]
    assert fila["estado"] == "caido"
    assert "Connection refused" in fila["detalle"]


def testAlphaVantageAvisaDelLimiteDentroDeUn200(monkeypatch, conClaves):
    """Alpha Vantage devuelve 200 con una nota cuando se agota la cuota diaria.

    Mirando solo el código HTTP, la cuota agotada saldría como "Operativa": es
    exactamente el caso que esta pantalla existe para detectar.
    """
    def responde(url, params=None, **k):
        if "alphavantage" in url:
            return {"Note": "Thank you for using Alpha Vantage! Our standard API rate limit is…"}
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    fila = _porId(estado.comprobar())["alphavantage"]
    assert fila["estado"] == "limite"
    assert "rate limit" in fila["detalle"]


def testAlphaVantageDistingueLaClaveInvalida(monkeypatch, conClaves):
    def responde(url, params=None, **k):
        if "alphavantage" in url:
            return {"Error Message": "the parameter apikey is invalid"}
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    assert _porId(estado.comprobar())["alphavantage"]["estado"] == "clave"


def testUnProveedorCaidoNoArrastraALosDemas(monkeypatch, conClaves):
    def responde(url, params=None, **k):
        if "finnhub" in url:
            raise URLError("timed out")
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    filas = _porId(estado.comprobar())
    assert filas["finnhub"]["estado"] == "caido"
    assert filas["yahoo"]["estado"] == "ok"
    assert filas["divisas"]["estado"] == "ok"


def testElOrdenDeLaListaNoDependeDeQuienContesteAntes(monkeypatch, conClaves):
    _respuesta(monkeypatch, lambda *a, **k: {"c": 1})

    ids = [fila["id"] for fila in estado.comprobar()]

    assert ids == [proveedor[0] for proveedor in estado._PROVEEDORES]


# ── Varias claves por proveedor ──────────────────────────────────────────────

@pytest.fixture
def cuatroClaves(monkeypatch):
    """EODHD con cuatro claves, que es como se usa: 20 peticiones al día cada una."""
    _claves(monkeypatch, "clave-1", lista=["clave-1", "clave-2", "clave-3", "clave-4"])


def _sinCuota(clavesAgotadas):
    """fetchJson que da 402 en EODHD para las claves dadas y datos para el resto.

    Solo cuenta las llamadas a EODHD: los otros cuatro proveedores se sondean en
    la misma pasada y ensuciarían el recuento.
    """
    usadas = []

    def responde(url, params=None, **k):
        if "eodhd" not in url:
            return {"c": 1}

        clave = (params or {}).get("api_token")
        usadas.append(clave)
        if clave in clavesAgotadas:
            raise _http(402)
        return {"close": 1}

    return responde, usadas


def testUnaClaveSinCuotaNoDaPorCaidoAlProveedor(monkeypatch, cuatroClaves):
    """El sondeo miraba solo la primera clave.

    Con la #1 agotada, Ajustes decía «EODHD · Cuota agotada» mientras la
    aplicación seguía actualizando precios con las otras tres: el usuario veía
    roto lo que funcionaba.
    """
    responde, usadas = _sinCuota({"clave-1"})
    _respuesta(monkeypatch, responde)

    fila = _porId(estado.comprobar())["eodhd"]

    assert fila["estado"] == "ok"
    assert usadas.count("clave-2") == 1


def testSeAvisaDeLasClavesQueYaNoResponden(monkeypatch, cuatroClaves):
    """Operativa, sí, pero quedan menos claves de las que parece."""
    responde, _usadas = _sinCuota({"clave-1", "clave-2"})
    _respuesta(monkeypatch, responde)

    fila = _porId(estado.comprobar())["eodhd"]

    assert fila["estado"] == "ok"
    assert "clave 3 de 4" in fila["detalle"]


def testLaCuotaAgotadaSoloSeDeclaraSiFallanTodas(monkeypatch, cuatroClaves):
    responde, usadas = _sinCuota({"clave-1", "clave-2", "clave-3", "clave-4"})
    _respuesta(monkeypatch, responde)

    fila = _porId(estado.comprobar())["eodhd"]

    assert fila["estado"] == "limite"
    assert len(usadas) == 4


def testConUnaSolaClaveElSondeoNoGastaDeMas(monkeypatch, conClaves):
    """El caso normal sigue costando una petición, que es cuota real."""
    usadas = []

    def responde(url, params=None, **k):
        if "eodhd" in url:
            usadas.append((params or {}).get("api_token"))
        return {"close": 1}

    _respuesta(monkeypatch, responde)
    estado.comprobar()

    assert usadas == ["clave-de-prueba"]


def testFinnhubTambienPruebaTodasSusClaves(monkeypatch):
    """Finnhub era el único proveedor sin respaldo.

    Usaba siempre la primera clave del fichero: con tres configuradas, que la
    primera estuviera caducada dejaba sin cotizar a todos sus activos aunque las
    otras dos valieran, y la pantalla solo sabía decir «Clave rechazada» sin
    poder señalar cuál de las tres era la mala.
    """
    _claves(monkeypatch, "clave-1", lista=["clave-1", "clave-2", "clave-3"])

    def responde(url, params=None, **k):
        if "finnhub" in url and (params or {}).get("token") == "clave-1":
            raise _http(401)
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    fila = _porId(estado.comprobar())["finnhub"]

    assert fila["estado"] == "ok"
    assert "clave 2 de 3" in fila["detalle"]


def testFinnhubSoloDaLaClavePorMalaSiFallanTodas(monkeypatch):
    _claves(monkeypatch, "clave-1", lista=["clave-1", "clave-2"])

    def responde(url, params=None, **k):
        if "finnhub" in url:
            raise _http(401)
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    assert _porId(estado.comprobar())["finnhub"]["estado"] == "clave"


def testAlphaVantagePasaALaSiguienteClaveSiLaPrimeraNoTieneCuota(monkeypatch):
    """El aviso de cuota de Alpha Vantage llega dentro de un 200.

    Si se mirase después del sondeo en vez de por clave, la primera agotada
    daría por agotado al proveedor entero.
    """
    _claves(monkeypatch, "clave-1", lista=["clave-1", "clave-2"])

    def responde(url, params=None, **k):
        if "alphavantage" in url and (params or {}).get("apikey") == "clave-1":
            return {"Note": "standard API rate limit"}
        return {"c": 1}

    _respuesta(monkeypatch, responde)

    assert _porId(estado.comprobar())["alphavantage"]["estado"] == "ok"


# ── Caché ────────────────────────────────────────────────────────────────────

def testElResultadoSeCacheaParaNoGastarCuota(monkeypatch, conClaves):
    """El sondeo son llamadas reales: refrescar la pantalla no puede repetirlo."""
    llamadas = []
    _respuesta(monkeypatch, lambda *a, **k: llamadas.append(1) or {"c": 1})

    estado.obtener()
    segunda = estado.obtener()

    assert segunda["cacheado"] is True
    assert len(llamadas) == len(estado._PROVEEDORES)


def testForzarVuelveAComprobar(monkeypatch, conClaves):
    llamadas = []
    _respuesta(monkeypatch, lambda *a, **k: llamadas.append(1) or {"c": 1})

    estado.obtener()
    segunda = estado.obtener(forzar=True)

    assert segunda["cacheado"] is False
    assert len(llamadas) == 2 * len(estado._PROVEEDORES)


# ── Endpoint ─────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb):
    from routes.ajustes import ajustesBp

    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, cabeceras


def testElEndpointDevuelveUnaFilaPorProveedor(cliente, monkeypatch, conClaves):
    client, _cabeceras = cliente
    _respuesta(monkeypatch, lambda *a, **k: {"c": 1})

    datos = client.get("/api/stats/api-estado").get_json()

    assert datos["ok"] is True
    assert len(datos["proveedores"]) == len(estado._PROVEEDORES)
    assert all(fila["estado"] == "ok" for fila in datos["proveedores"])


def testElEndpointNoPublicaLaClave(cliente, monkeypatch):
    """El detalle del error viene del proveedor y podría arrastrar la URL."""
    client, _cabeceras = cliente
    _claves(monkeypatch, "clave-secreta-1")

    def falla(*a, **k):
        raise URLError("no se pudo conectar")

    _respuesta(monkeypatch, falla)

    assert "clave-secreta-1" not in client.get("/api/stats/api-estado").get_data(as_text=True)


def testElEndpointExigeSesion(crearApp):
    """Es un diagnóstico: dice qué proveedores usa la instalación y si fallan.

    Además, sondear sin sesión sería una forma gratuita de gastarle la cuota a
    otro.
    """
    from routes.ajustes import ajustesBp

    client = crearApp(ajustesBp).test_client()

    assert client.get("/api/stats/api-estado").status_code == 401
