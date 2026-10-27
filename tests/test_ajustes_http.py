"""Pruebas de /api/settings, /api/export/* y /api/import/*.

Son 660 líneas que no cubría ningún test y que deciden dos cosas delicadas:

  * **Qué se guarda como ajuste.** `saveSettings` no confía en el cuerpo: cada
    clave pasa por su lista de valores admitidos. Sin tests, cambiar una de esas
    listas y dejar entrar basura no lo nota nadie hasta que la aplicación pinta
    un tema inexistente o un número de decimales imposible.
  * **La importación**, que vacía todas las tablas antes de insertar. Es tan
    destructiva como restaurar un backup, y además acepta un fichero subido por
    el usuario.
"""

import io
import json
import zipfile

import pytest


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    return client, cabeceras, datosAislados


def _guardar(client, cabeceras, **campos):
    return client.post("/api/settings", json=campos, headers=cabeceras)


# ── Lectura ──────────────────────────────────────────────────────────────────

def testSinFicheroDeAjustesSeDevuelvenLosValoresPorDefecto(cliente):
    client, _cabeceras, _rutas = cliente
    datos = client.get("/api/settings").get_json()

    assert datos["ok"] is True
    assert datos["monedaBase"] == "EUR"
    assert datos["theme"] == "default"
    assert datos["dateFormat"] == "DD/MM/YYYY"


def testUnAjustesJsonIlegibleNoTumbaLaPantalla(cliente):
    """Caer a los valores por defecto es preferible a un 500 sin ajustes."""
    client, _cabeceras, rutas = cliente
    rutas["ajustes"].write_text("{esto no es json", encoding="utf-8")

    respuesta = client.get("/api/settings")

    assert respuesta.status_code == 200
    assert respuesta.get_json()["monedaBase"] == "EUR"


def testLasClavesDeApiSeDevuelvenContadasNuncaEnClaro(cliente):
    """La pantalla solo necesita saber cuántas hay; el valor no debe salir."""
    client, cabeceras, _rutas = cliente
    client.post("/api/settings/apikey", json={"finnhubKey": "clave-secreta-1"}, headers=cabeceras)
    client.post("/api/settings/apikey", json={"finnhubKey": "clave-secreta-2"}, headers=cabeceras)

    respuesta = client.get("/api/settings")

    assert respuesta.get_json()["finnhubKeyCount"] == 2
    assert "clave-secreta" not in respuesta.get_data(as_text=True)


def testLasClavesDeApiNoSeGuardanEnClaroEnDisco(cliente):
    """API/ está dentro del proyecto y acaba en cualquier copia del directorio."""
    client, cabeceras, rutas = cliente
    client.post("/api/settings/apikey", json={"finnhubKey": "clave-secreta-1"}, headers=cabeceras)

    crudo = (rutas["claves"] / "finnhub.key").read_bytes()
    assert b"clave-secreta-1" not in crudo


# ── Lista de claves y de dónde salen ─────────────────────────────────────────

_VARIABLES = ("FINNHUB_API_KEY", "EODHD_API_KEYS", "ALPHA_VANTAGE_API_KEYS")


@pytest.fixture(autouse=True)
def sinClavesEnElEntorno(monkeypatch):
    """El entorno gana al fichero, así que un `.env` cargado torcería la suite."""
    for variable in _VARIABLES:
        monkeypatch.delenv(variable, raising=False)


def _anadirClaves(client, cabeceras, *claves, campo="finnhubKey"):
    for clave in claves:
        client.post("/api/settings/apikey", json={campo: clave}, headers=cabeceras)


def _listar(client, proveedor="finnhub"):
    """El listado, con el valor de cada clave pedido aparte como hace el ojo.

    El listado ya no trae el valor (solo máscara y huella); estos tests
    comprueban qué claves hay, así que lo completan con /apikey/ver.
    """
    from tests.conftest import CSRF_PRUEBA

    info = client.get("/api/settings/apikeys").get_json()["proveedores"][proveedor]
    for clave in info["claves"]:
        respuesta = client.post(
            "/api/settings/apikey/ver",
            json={"proveedor": proveedor, "huella": clave["huella"]},
            headers={"X-CSRF-Token": CSRF_PRUEBA},
        )
        clave["clave"] = respuesta.get_json()["clave"]
    return info


def testLaListaTraeCadaClaveEnmascaradaYSinSuValor(cliente):
    """Enmascarada para pintarla; el valor se pide aparte, clave a clave.

    Antes iba entero en el listado y quedaban todas las claves en la memoria de
    la pestaña cada vez que se abría Ajustes.
    """
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "abcdefghijklmnop", "1234567890123456")

    respuesta = client.get("/api/settings/apikeys")
    claves = respuesta.get_json()["proveedores"]["finnhub"]["claves"]

    assert [c["indice"] for c in claves] == [0, 1]
    assert claves[0]["vista"] == "abcd------mnop"
    assert claves[0]["longitud"] == 16
    assert "clave" not in claves[0]
    assert b"abcdefghijklmnop" not in respuesta.data

    ver = client.post("/api/settings/apikey/ver",
                      json={"proveedor": "finnhub", "huella": claves[0]["huella"]}, headers=cabeceras)
    assert ver.get_json() == {"ok": True, "clave": "abcdefghijklmnop"}
    assert ver.headers.get("Cache-Control") == "no-store"


def testVerUnaClaveExigeCsrfYUnaHuellaExistente(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "abcdefghijklmnop")

    assert client.post("/api/settings/apikey/ver",
                       json={"proveedor": "finnhub", "huella": "0" * 16}).status_code == 403
    assert client.post("/api/settings/apikey/ver",
                       json={"proveedor": "finnhub", "huella": "0" * 16}, headers=cabeceras).status_code == 404
    assert client.post("/api/settings/apikey/ver",
                       json={"proveedor": "otro", "huella": "x"}, headers=cabeceras).status_code == 400


def testBorrarPorHuella(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "primera-clave-aa", "segunda-clave-bb")
    huella = client.get("/api/settings/apikeys").get_json()["proveedores"]["finnhub"]["claves"][1]["huella"]

    respuesta = client.delete("/api/settings/apikey", json={"proveedor": "finnhub", "huella": huella},
                              headers=cabeceras)

    assert respuesta.get_json() == {"ok": True, "restantes": 1}
    assert [c["clave"] for c in _listar(client)["claves"]] == ["primera-clave-aa"]


def testLaListaDeClavesNoSeQuedaEnNingunaCache(cliente):
    """Lleva secretos dentro, así que no puede guardarla nadie por el camino."""
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "clave-secreta-1")

    respuesta = client.get("/api/settings/apikeys")

    assert respuesta.headers.get("Cache-Control") == "no-store"


def testUnaClaveCortaNoDejaVerNiLasPuntas(cliente):
    """Con ocho caracteres, enseñar cuatro y cuatro sería enseñarla entera."""
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "12345678")

    assert _listar(client)["claves"][0]["vista"] == "-" * 8


def testLosTresProveedoresSalenAunqueNoTenganClaves(cliente):
    """La interfaz pinta las tres filas; un proveedor ausente sería un hueco."""
    client, _cabeceras, _rutas = cliente

    proveedores = client.get("/api/settings/apikeys").get_json()["proveedores"]

    assert sorted(proveedores) == ["alphavantage", "eodhd", "finnhub"]
    assert proveedores["eodhd"]["claves"] == []


def testCadaProveedorListaSoloSusClaves(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "clave-de-finnhub", campo="finnhubKey")
    _anadirClaves(client, cabeceras, "clave-de-eodhd-1", campo="eodhdKeys")

    assert [c["clave"] for c in _listar(client, "finnhub")["claves"]] == ["clave-de-finnhub"]
    assert [c["clave"] for c in _listar(client, "eodhd")["claves"]] == ["clave-de-eodhd-1"]


def testElOrdenDeLaListaEsElDeLaRotacion(cliente):
    """El número de cada fila es con el que el panel de estado las nombra."""
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "primera-clave-aa", "segunda-clave-bb", "tercera-clave-cc")

    claves = _listar(client)["claves"]

    assert [c["clave"] for c in claves] == ["primera-clave-aa", "segunda-clave-bb", "tercera-clave-cc"]


def testSinVariableDeEntornoLasClavesSalenDelFichero(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "clave-del-fichero")

    info = _listar(client)

    assert info["origen"] == "fichero"
    assert info["ignoradas"] == 0
    assert info["variable"] == "FINNHUB_API_KEY"


def testMandaElFicheroYLaVariableQuedaDeRespaldo(cliente, monkeypatch):
    """La trampa que se comía instalaciones enteras, ahora del revés.

    Cuando mandaba el entorno, se podían añadir claves en Ajustes, verlas
    aparecer, darse de alta en otra cuenta del proveedor, y que la aplicación
    siguiera mandando la del `.env` —el valor de ejemplo de `.env.example`, en
    el caso que lo destapó— sin que nada lo insinuara. Ahora manda lo que se ve
    en pantalla, que es lo único que se puede arreglar desde ella.
    """
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "d41d8cd98f00b204e980", "9e800998ecf8427e1234")
    monkeypatch.setenv("FINNHUB_API_KEY", "3c59dc048e8850243be8")

    info = _listar(client)

    assert info["origen"] == "fichero"
    assert [c["clave"] for c in info["claves"]] == ["d41d8cd98f00b204e980", "9e800998ecf8427e1234"]
    # La del entorno no rompe nada, pero conviene decir que está de más.
    assert info["ignoradas"] == 1


def testSinClavesEnElFicheroSeUsaLaDelEntorno(cliente, monkeypatch):
    """Un despliegue sin volumen para API/ no tiene dónde guardarlas."""
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "3c59dc048e8850243be8")

    info = _listar(client)

    assert info["origen"] == "entorno"
    assert [c["clave"] for c in info["claves"]] == ["3c59dc048e8850243be8"]
    assert info["ignoradas"] == 0


def testSinClavesEnNingunSitioElOrigenLoDice(cliente):
    client, _cabeceras, _rutas = cliente

    info = _listar(client)

    assert info["origen"] == "ninguno"
    assert info["claves"] == []


@pytest.mark.parametrize("ejemplo", [
    "tu_clave_finnhub",
    "tu_clave_EODHD1",
    "CLAVE1",
    "CLAVE_PRINCIPAL",
    "changeme",
    "your_api_key",
])
def testLosValoresDeEjemploDeLaDocumentacionSeDescartan(cliente, monkeypatch, ejemplo):
    """No son claves: su único efecto posible es romper el proveedor.

    Es el fallo que destapó todo esto: un `.env` copiado de `.env.example` y sin
    rellenar dejaba a Finnhub y EODHD mandando `tu_clave_finnhub` contra la API,
    con «Clave rechazada» en pantalla y ninguna pista de por qué.
    """
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", ejemplo)

    info = _listar(client)

    assert info["claves"] == []
    assert info["origen"] == "ninguno"


def testUnEjemploEnElEntornoNoTapaALaClaveDelFichero(cliente, monkeypatch):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "d41d8cd98f00b204e980")
    monkeypatch.setenv("FINNHUB_API_KEY", "tu_clave_finnhub")

    info = _listar(client)

    assert [c["clave"] for c in info["claves"]] == ["d41d8cd98f00b204e980"]
    # El ejemplo se descarta antes de contar, así que no figura como ignorada.
    assert info["ignoradas"] == 0


def testUnaClaveDeVerdadNoSeConfundeConUnEjemplo(cliente, monkeypatch):
    """El reconocimiento es estrecho a propósito: tirar una clave buena sería peor."""
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "d6s0abcdefghijklmnopsfe0")

    assert [c["clave"] for c in _listar(client)["claves"]] == ["d6s0abcdefghijklmnopsfe0"]


def testLaVariableDeEodhdAdmiteVariasSeparadasPorComa(cliente, monkeypatch):
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("EODHD_API_KEYS", "69c2aaaa1875, 69c2bbbb6133 ,69c2cccc7788")

    info = _listar(client, "eodhd")

    assert [c["clave"] for c in info["claves"]] == ["69c2aaaa1875", "69c2bbbb6133", "69c2cccc7788"]


def testLaVariableDeFinnhubEsUnaSolaClave(cliente, monkeypatch):
    """`FINNHUB_API_KEY` no se parte por comas: el lector real la usa entera."""
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "d41d,8cd9,8f00")

    assert [c["clave"] for c in _listar(client)["claves"]] == ["d41d,8cd9,8f00"]


def testUnaVariableVaciaNoCuenta(cliente, monkeypatch):
    """`.env.example` deja las líneas puestas; en blanco no deben contar."""
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "d41d8cd98f00b204e980")
    monkeypatch.setenv("FINNHUB_API_KEY", "   ")

    info = _listar(client)

    assert info["origen"] == "fichero"
    assert info["ignoradas"] == 0


def testListarLasClavesSinSesionEs401(crearApp, datosAislados, tempDb):
    """Es el único sitio del que salen las claves en claro."""
    from routes.ajustes import ajustesBp

    client = crearApp(ajustesBp).test_client()
    assert client.get("/api/settings/apikeys").status_code == 401


# ── Borrado de claves ────────────────────────────────────────────────────────

def _borrar(client, cabeceras, proveedor, clave):
    return client.delete(
        "/api/settings/apikey",
        json={"proveedor": proveedor, "clave": clave},
        headers=cabeceras,
    )


def testBorrarUnaClaveDejaLasDemas(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "primera-clave-aa", "segunda-clave-bb", "tercera-clave-cc")

    respuesta = _borrar(client, cabeceras, "finnhub", "segunda-clave-bb")

    assert respuesta.get_json() == {"ok": True, "restantes": 2}
    assert [c["clave"] for c in _listar(client)["claves"]] == ["primera-clave-aa", "tercera-clave-cc"]


def testSeBorraPorValorYNoPorPosicion(cliente):
    """La lista que ve el usuario puede haberse quedado atrás.

    Con un índice viejo —otra pestaña, una clave añadida entretanto— se borraría
    la clave equivocada sin que nada lo advirtiera.
    """
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "primera-clave-aa", "segunda-clave-bb")

    _borrar(client, cabeceras, "finnhub", "primera-clave-aa")
    _borrar(client, cabeceras, "finnhub", "segunda-clave-bb")

    assert _listar(client)["claves"] == []


def testBorrarLaUltimaClaveDejaElProveedorSinNinguna(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "clave-unica-aaa")

    respuesta = _borrar(client, cabeceras, "finnhub", "clave-unica-aaa")

    assert respuesta.get_json()["restantes"] == 0
    assert client.get("/api/settings").get_json()["finnhubKeyCount"] == 0


def testBorrarNoTocaLasClavesDeLosOtrosProveedores(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "clave-de-finnhub", campo="finnhubKey")
    _anadirClaves(client, cabeceras, "clave-de-eodhd-1", campo="eodhdKeys")

    _borrar(client, cabeceras, "finnhub", "clave-de-finnhub")

    assert _listar(client, "finnhub")["claves"] == []
    assert [c["clave"] for c in _listar(client, "eodhd")["claves"]] == ["clave-de-eodhd-1"]


def testElFicheroSigueCifradoDespuesDeBorrar(cliente):
    """Se reescribe entero: si la reescritura lo dejara en claro, nadie lo vería."""
    client, cabeceras, rutas = cliente
    _anadirClaves(client, cabeceras, "clave-secreta-1", "clave-secreta-2")

    _borrar(client, cabeceras, "finnhub", "clave-secreta-1")

    crudo = (rutas["claves"] / "finnhub.key").read_bytes()
    assert b"clave-secreta-2" not in crudo


def testBorrarUnaClaveQueNoEstaEs404(cliente):
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "clave-secreta-1")

    assert _borrar(client, cabeceras, "finnhub", "clave-que-no-existe").status_code == 404


def testUnaClaveDelEntornoNoSePuedeBorrarDesdeAqui(cliente, monkeypatch):
    """No está en el fichero: se quita del `.env` del servidor, no de esta pantalla."""
    client, cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "clave-del-entorno")

    assert _borrar(client, cabeceras, "finnhub", "clave-del-entorno").status_code == 404


@pytest.mark.parametrize("clave", ["", None])
def testBorrarSinDecirQueClaveNoBorraNada(cliente, clave):
    """Un cuerpo a medias no puede acabar vaciando el fichero."""
    client, cabeceras, _rutas = cliente
    _anadirClaves(client, cabeceras, "clave-secreta-1")

    respuesta = _borrar(client, cabeceras, "finnhub", clave)

    assert respuesta.status_code == 404
    assert client.get("/api/settings").get_json()["finnhubKeyCount"] == 1


def testBorrarEnUnProveedorQueNoExisteEs400(cliente):
    client, cabeceras, _rutas = cliente

    assert _borrar(client, cabeceras, "../../.env", "lo-que-sea").status_code == 400


def testBorrarUnaClaveSinSesionEs401(crearApp, datosAislados, tempDb):
    from routes.ajustes import ajustesBp

    client = crearApp(ajustesBp).test_client()
    respuesta = client.delete("/api/settings/apikey", json={"proveedor": "finnhub", "clave": "x"})

    assert respuesta.status_code == 401


def testBorrarUnaClaveSinCsrfEs403(clienteAutenticado, datosAislados, tempDb):
    from routes.ajustes import ajustesBp

    client, _cabeceras, _app = clienteAutenticado(ajustesBp)
    respuesta = client.delete("/api/settings/apikey", json={"proveedor": "finnhub", "clave": "x"})

    assert respuesta.status_code == 403


# ── Escritura: validación de cada ajuste ─────────────────────────────────────

def testLosAjustesValidosSePersisten(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, theme="black", monedaBase="USD", dateFormat="YYYY-MM-DD",
             maxBackups=10, precioDecimalesCripto=8)

    datos = client.get("/api/settings").get_json()

    assert datos["theme"] == "black"
    assert datos["monedaBase"] == "USD"
    assert datos["dateFormat"] == "YYYY-MM-DD"
    assert datos["maxBackups"] == 10
    assert datos["precioDecimalesCripto"] == 8


@pytest.mark.parametrize("campo,valor,esperado", [
    ("theme", "<script>alert(1)</script>", "default"),
    ("theme", "inexistente", "default"),
    ("monedaBase", "XXX", "EUR"),
    ("dateFormat", "DD.MM.YY", "DD/MM/YYYY"),
    ("numLocale", "de-DE", "es-ES"),
    ("maxBackups", 999, 0),                 # no está en el conjunto admitido
    ("precioDecimalesAcciones", 7, 2),      # solo 2, 4, 6 y 8
    ("bloqueoInactividad", 5, 0),           # solo 0, 15, 30, 60 y 240
    ("snapshotAlcance", "otro", "activo"),
    ("autoRefreshMinutes", 3, 0),
])
def testUnValorNoAdmitidoCaeAlPorDefecto(cliente, campo, valor, esperado):
    """Nada de lo que llega en el cuerpo se guarda tal cual."""
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, **{campo: valor})

    assert client.get("/api/settings").get_json()[campo] == esperado


@pytest.mark.parametrize("campo,valor,minimo,maximo", [
    ("autoBackupDays", 10_000, 0, 365),
    ("autoBackupDays", -5, 0, 365),
    ("staleHours", 0, 1, 8760),
    ("staleHours", 99_999, 1, 8760),
])
def testLosValoresNumericosSeAcotanAlRango(cliente, campo, valor, minimo, maximo):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, **{campo: valor})

    guardado = client.get("/api/settings").get_json()[campo]
    assert minimo <= guardado <= maximo


def testGuardarUnAjusteNoPisaLosDemas(cliente):
    """El POST es parcial: solo toca las claves que trae."""
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, theme="black", maxBackups=20)
    _guardar(client, cabeceras, dateFormat="MM/DD/YYYY")

    datos = client.get("/api/settings").get_json()
    assert datos["theme"] == "black"
    assert datos["maxBackups"] == 20
    assert datos["dateFormat"] == "MM/DD/YYYY"


def testLosTiposDeMercadoDesconocidosSeFiltran(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, soloMercadoTipos=["acciones", "inventado", "cripto"])

    assert client.get("/api/settings").get_json()["soloMercadoTipos"] == ["acciones", "cripto"]


def testUnaCadenaDondeSeEsperaUnaListaNoProvocaUn500(cliente, tmp_path):
    """Un cuerpo con el tipo equivocado se descarta, no revienta la petición."""
    client, cabeceras, rutas = cliente
    respuesta = _guardar(client, cabeceras, soloMercadoTipos="acciones", hiddenAssets=[])

    assert respuesta.status_code == 200
    # Se guarda la lista vacía…
    assert json.loads(rutas["ajustes"].read_text("utf-8"))["soloMercadoTipos"] == []
    # …aunque getSettings la lea con `or [defectos]`, así que al releer salen
    # los tres tipos por defecto. Es el comportamiento actual, no un descuido
    # del test: con soloHorarioMercado desactivado la lista no se usa, y quien
    # la deje vacía a propósito verá que vuelven los valores iniciales.
    assert client.get("/api/settings").get_json()["soloMercadoTipos"] == [
        "acciones", "etfs", "comoditis",
    ]


def testLosModulosDesconocidosNoEntranEnLaConfiguracion(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, modulosConfig={"metricas": False, "moduloFantasma": True})

    guardado = client.get("/api/settings").get_json()["modulosConfig"]
    assert guardado == {"metricas": False}


def testElObjetivoDeAhorroSeAcotaEntre0Y100(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, ahorroConfig={"objetivoAhorro": 500, "presupuesto": {"Casa": -20}})

    guardado = client.get("/api/settings").get_json()["ahorroConfig"]
    assert guardado["objetivoAhorro"] == 100.0
    assert guardado["presupuesto"]["Casa"] == 0.0


def testUnObjetivoDeAhorroQueNoEsNumeroCaeAlDefecto(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, ahorroConfig={"objetivoAhorro": "mucho"})

    assert client.get("/api/settings").get_json()["ahorroConfig"]["objetivoAhorro"] == 30.0


def testLasDivisasFiatExigenCodigoYNombre(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, fiatCurrencies=[
        {"code": "eur", "name": "Euro"},
        {"code": "N0K", "name": "Con un cero"},    # no es alfabético
        {"code": "GBP", "name": ""},               # sin nombre
        {"code": "GBP", "name": "Libra"},
    ])
    # monedaBase se valida contra la lista recién guardada.
    _guardar(client, cabeceras, monedaBase="GBP")

    assert client.get("/api/settings").get_json()["monedaBase"] == "GBP"


def testLosPanelesSeGuardanYSeLeen(cliente):
    client, cabeceras, _rutas = cliente
    paneles = {
        "activo": "p2",
        "paneles": [
            {"id": "p1", "nombre": "Research", "cfg": {"fila": "44", "bordes": False}, "widgets": [
                {"id": "w1", "tipo": "mapa", "w": 8, "h": 7, "cfg": {"periodo": "dia", "activos": ["a", "b"]}},
            ]},
            {"id": "p2", "nombre": "Vacío", "cfg": {}, "widgets": []},
        ],
    }
    _guardar(client, cabeceras, panelesConfig=paneles)

    assert client.get("/api/settings").get_json()["panelesConfig"] == paneles


def testLosWidgetsDeMercadoYLosTickersSueltosSeGuardan(cliente):
    """Los tipos nuevos pasan el filtro y un ticker suelto («tk|…») es una
    cadena más de la lista: tiene que llegar entera."""
    client, cabeceras, _rutas = cliente
    tipos = [
        "mapaMercado", "instrumento", "tecnico", "ficha", "perfil", "noticias", "calendario",
        "miedoCodicia", "amplitud", "indices", "sectores", "escaner", "metrica",
    ]
    ticker = "tk|NASDAQ:AMD|Advanced Micro Devices Inc.|acciones"
    _guardar(client, cabeceras, panelesConfig={"activo": "p1", "paneles": [
        {"id": "p1", "nombre": "Mercado", "widgets": [
            {"id": f"w{i}", "tipo": tipo, "w": 4, "h": 5, "cfg": {"activos": [ticker], "activo": ticker}}
            for i, tipo in enumerate(tipos)
        ]},
    ]})

    widgets = client.get("/api/settings").get_json()["panelesConfig"]["paneles"][0]["widgets"]
    assert [w["tipo"] for w in widgets] == tipos
    assert widgets[0]["cfg"] == {"activos": [ticker], "activo": ticker}


def testLosPanelesDescartanLoQueLaPantallaNoSabePintar(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, panelesConfig={
        "activo": "inexistente",
        "paneles": [
            {"id": "p1", "nombre": "  ", "widgets": [
                {"id": "w1", "tipo": "widgetFantasma", "w": 4, "h": 4},
                {"id": "w2", "tipo": "grafico", "w": 99, "h": -3, "cfg": {"anidado": {"x": 1}, "vincular": True}},
                {"id": "w2", "tipo": "notas", "w": 3, "h": 3},   # id repetido
            ]},
            "esto no es un panel",
        ],
    })

    guardado = client.get("/api/settings").get_json()["panelesConfig"]
    assert guardado["activo"] == "p1"
    [panel] = guardado["paneles"]
    assert panel["nombre"] == "Panel"
    assert panel["widgets"] == [{"id": "w2", "tipo": "grafico", "w": 12, "h": 2, "cfg": {"vincular": True}}]


def testLasPreferenciasPorPortfolioVanASuPropioFichero(cliente):
    """Cada portfolio tiene su prefs_<id>.json: no deben mezclarse con los globales."""
    client, cabeceras, rutas = cliente
    _guardar(client, cabeceras, hiddenAssets=["1", "2"], theme="light")

    globales = json.loads(rutas["ajustes"].read_text("utf-8"))
    assert "theme" in globales
    assert "hiddenAssets" not in globales

    prefs = list(rutas["json"].glob("prefs_*.json"))
    assert len(prefs) == 1
    assert json.loads(prefs[0].read_text("utf-8"))["hiddenAssets"] == ["1", "2"]


# ── Sesión y CSRF ────────────────────────────────────────────────────────────

def testGuardarAjustesSinSesionEs401(crearApp, datosAislados, tempDb):
    from routes.ajustes import ajustesBp

    client = crearApp(ajustesBp).test_client()
    assert client.post("/api/settings", json={"theme": "black"}).status_code == 401


def testExportarSinSesionEs401(crearApp, datosAislados, tempDb):
    """El export lleva dentro toda la base de datos."""
    from routes.ajustes import ajustesBp

    client = crearApp(ajustesBp).test_client()
    assert client.get("/api/export/json").status_code == 401


def testImportarSinCsrfEs403(clienteAutenticado, datosAislados, tempDb):
    from routes.ajustes import ajustesBp

    client, _cabeceras, _app = clienteAutenticado(ajustesBp)
    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(b"{}"), "x.json")},
        content_type="multipart/form-data",
    )
    assert respuesta.status_code == 403


# ── Exportar ─────────────────────────────────────────────────────────────────

def testElExportJsonIncluyeLasTablasRealesYLosAjustes(cliente):
    """El export enumeraba una lista fija de nombres, 4 de ellos inexistentes."""
    client, cabeceras, _rutas = cliente
    from core.db import getDb

    _guardar(client, cabeceras, theme="black")
    conn = getDb()
    conn.execute("INSERT INTO gastos_tipos (label) VALUES (?)", ("Café",))
    conn.commit()

    datos = json.loads(client.get("/api/export/json").get_data(as_text=True))

    assert datos["version"] == 3
    assert datos["ajustes"]["theme"] == "black"
    assert "portfolio_prefs" in datos
    # Tablas que la versión antigua se dejaba fuera.
    for tabla in ("activo_rows", "gastos_rows", "mensualidades", "ingresos_rows"):
        assert tabla in datos["tables"]
    assert [f["label"] for f in datos["tables"]["gastos_tipos"]] == ["Café"]


def testElExportSeDescargaComoFichero(cliente):
    client, _cabeceras, _rutas = cliente
    cabeceras = client.get("/api/export/json").headers

    assert "attachment" in cabeceras["Content-Disposition"]
    assert cabeceras["Content-Type"].startswith("application/json")


def testElExportZipLlevaElJsonElDbYLosAjustes(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, theme="light")

    contenido = client.get("/api/export/zip").get_data()
    with zipfile.ZipFile(io.BytesIO(contenido)) as zf:
        nombres = zf.namelist()

    assert any(n.endswith(".db") for n in nombres)
    assert any(n.startswith("portfolio-export-") and n.endswith(".json") for n in nombres)
    assert "ajustes.json" in nombres


def testElJsonExportadoCoincideConLaBaseFilaAFila(cliente):
    """El JSON se escribe a trozos: que siga siendo JSON válido con tablas
    vacías, varias filas, nulos y texto no ASCII."""
    client, _cabeceras, _rutas = cliente
    from core.db import getDb

    conn = getDb()
    conn.executemany("INSERT INTO gastos_tipos (label) VALUES (?)", [("Café",), ("Ñu \"comillas\"",), ("😀",)])
    conn.commit()

    datos = json.loads(client.get("/api/export/json").get_data(as_text=True))

    esperado = [dict(fila) for fila in conn.execute("SELECT * FROM gastos_tipos")]
    assert datos["tables"]["gastos_tipos"] == esperado
    assert datos["tables"]["gastos_rows"] == []


def testElDbDelZipExportadoEstaIntegro(cliente, tmp_path):
    client, cabeceras, _rutas = cliente
    import sqlite3

    contenido = client.post("/api/export/zip", json={}, headers=cabeceras).get_data()
    with zipfile.ZipFile(io.BytesIO(contenido)) as zf:
        assert zf.testzip() is None
        nombreDb = next(n for n in zf.namelist() if n.endswith(".db"))
        nombreJson = next(n for n in zf.namelist() if n.endswith(".json") and n.startswith("portfolio-export-"))
        (tmp_path / "copia.db").write_bytes(zf.read(nombreDb))
        assert json.loads(zf.read(nombreJson))["version"] == 3

    conn = sqlite3.connect(str(tmp_path / "copia.db"))
    try:
        assert conn.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    finally:
        conn.close()


@pytest.mark.parametrize("peticion", [("get", "/api/export/json"), ("post", "/api/export/zip")])
def testUnaBaseDanadaNoSeExportaYSeDiceQueFalla(cliente, monkeypatch, peticion):
    """Antes de exportar se comprueba la integridad de lo que se va a entregar.
    Un fichero que parece una copia y no sirve para restaurar es peor que un
    error: el usuario tiene que saber que la base está dañada."""
    from routes import ajustes

    client, cabeceras, _rutas = cliente
    monkeypatch.setattr(ajustes, "problemasDeIntegridad", lambda _ruta: ["*** in database main *** Page 7: btreeInitPage() returns error code 11"])
    metodo, url = peticion

    respuesta = getattr(client, metodo)(url, headers=cabeceras)
    datos = respuesta.get_json()

    assert respuesta.status_code == 409
    assert datos["ok"] is False
    assert "dañada" in datos["error"]
    assert "Page 7" in datos["error"]


def testUnFalloDeDiscoAlExportarDevuelveSuCausa(cliente, monkeypatch):
    """Mismo criterio que /api/backup: un volumen sin permisos tiene que decirse,
    no acabar en un «Error al exportar» sin más."""
    import errno

    from routes import ajustes

    client, _cabeceras, _rutas = cliente

    def _denegado(*_args, **_kwargs):
        raise PermissionError(errno.EACCES, "Permission denied")

    monkeypatch.setattr(ajustes.tempfile, "TemporaryFile", _denegado)

    respuesta = client.get("/api/export/json")

    assert respuesta.status_code == 500
    assert "permiso de escritura" in respuesta.get_json()["error"]


def testExportarNoDejaTemporalesEnData(cliente):
    from core import paths

    client, cabeceras, _rutas = cliente
    antes = set(paths.TMP_DIR.iterdir())

    client.get("/api/export/json").get_data()
    client.post("/api/export/zip", json={}, headers=cabeceras).get_data()

    assert set(paths.TMP_DIR.iterdir()) - antes == set()


# ── Importar ─────────────────────────────────────────────────────────────────

def testImportarSinFicheroEs400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post("/api/import/json", data={}, headers=cabeceras,
                            content_type="multipart/form-data")
    assert respuesta.status_code == 400


def testImportarUnJsonInvalidoEs400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(b"{no soy json"), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert respuesta.status_code == 400


def testImportarUnaListaEnVezDeUnObjetoEs400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(b"[1, 2, 3]"), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert respuesta.status_code == 400


def testExportarEImportarDevuelveLosMismosDatos(cliente):
    """La ida y vuelta completa: es lo que hace un usuario que migra de máquina."""
    client, cabeceras, _rutas = cliente
    from core.db import getDb

    conn = getDb()
    conn.executemany("INSERT INTO gastos_tipos (label) VALUES (?)", [("Café",), ("Coche",)])
    conn.execute(
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?,?,?,?,?,?)",
        ("2026", "enero", "10-01-2026", "Bar", "Café", "2,00 €"),
    )
    conn.commit()
    export = client.get("/api/export/json").get_data()

    # Se destruye el estado actual…
    conn.execute("DELETE FROM gastos_rows")
    conn.execute("DELETE FROM gastos_tipos")
    conn.commit()

    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(export), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )

    assert respuesta.status_code == 200
    conn = getDb()
    assert sorted(r[0] for r in conn.execute("SELECT label FROM gastos_tipos")) == ["Café", "Coche"]
    assert conn.execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 1


def testUnaTablaQueNoExisteEnElEsquemaSeIgnora(cliente):
    """Un export de una versión anterior no debe reventar la importación."""
    client, cabeceras, _rutas = cliente
    from core.db import getDb

    payload = json.dumps({
        "version": 3,
        "tables": {
            "tabla_de_otra_version": [{"a": 1}],
            "gastos_tipos": [{"label": "Ocio"}],
        },
    }).encode()

    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(payload), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )

    assert respuesta.status_code == 200
    assert [r[0] for r in getDb().execute("SELECT label FROM gastos_tipos")] == ["Ocio"]


def testUnaColumnaQueNoExisteSeDescartaSinPerderLaFila(cliente):
    client, cabeceras, _rutas = cliente
    from core.db import getDb

    payload = json.dumps({
        "tables": {"gastos_tipos": [{"label": "Ocio", "columna_fantasma": "x"}]},
    }).encode()

    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(payload), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )

    assert respuesta.status_code == 200
    assert [r[0] for r in getDb().execute("SELECT label FROM gastos_tipos")] == ["Ocio"]


def testUnZipQueNoEsUnZipEs400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/import/zip",
        data={"file": (io.BytesIO(b"esto no es un zip"), "export.zip")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert respuesta.status_code == 400


def testUnPrefsConRutaDeEscapeNoSaleDeDataJson(cliente, tmp_path):
    """En Windows "\\" también separa rutas: comprobar solo "/" no bastaba."""
    client, cabeceras, rutas = cliente

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("prefs_..\\..\\robado.json", b'{"x": 1}')
        zf.writestr("prefs_principal.json", b'{"hiddenAssets": ["9"]}')
    buf.seek(0)

    client.post(
        "/api/import/zip",
        data={"file": (buf, "export.zip")},
        headers=cabeceras, content_type="multipart/form-data",
    )

    assert not (rutas["data"] / "robado.json").exists()
    assert not (tmp_path / "robado.json").exists()
    assert (rutas["json"] / "prefs_principal.json").exists()
