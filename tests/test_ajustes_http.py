"""Pruebas de /api/settings, /api/export/* y /api/import/*.

Son 660 líneas que no cubría ningún test y que deciden dos cosas delicadas:

  * **Qué se guarda como ajuste.** `save_settings` no confía en el cuerpo: cada
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
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.ajustes import ajustes_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = cliente_autenticado(ajustes_bp)
    return client, cabeceras, datos_aislados


def _guardar(client, cabeceras, **campos):
    return client.post("/api/settings", json=campos, headers=cabeceras)


# ── Lectura ──────────────────────────────────────────────────────────────────

def test_sin_fichero_de_ajustes_se_devuelven_los_valores_por_defecto(cliente):
    client, _cabeceras, _rutas = cliente
    datos = client.get("/api/settings").get_json()

    assert datos["ok"] is True
    assert datos["monedaBase"] == "EUR"
    assert datos["theme"] == "default"
    assert datos["dateFormat"] == "DD/MM/YYYY"


def test_un_ajustes_json_ilegible_no_tumba_la_pantalla(cliente):
    """Caer a los valores por defecto es preferible a un 500 sin ajustes."""
    client, _cabeceras, rutas = cliente
    rutas["ajustes"].write_text("{esto no es json", encoding="utf-8")

    respuesta = client.get("/api/settings")

    assert respuesta.status_code == 200
    assert respuesta.get_json()["monedaBase"] == "EUR"


def test_las_claves_de_api_se_devuelven_contadas_nunca_en_claro(cliente):
    """La pantalla solo necesita saber cuántas hay; el valor no debe salir."""
    client, cabeceras, _rutas = cliente
    client.post("/api/settings/apikey", json={"finnhubKey": "clave-secreta-1"}, headers=cabeceras)
    client.post("/api/settings/apikey", json={"finnhubKey": "clave-secreta-2"}, headers=cabeceras)

    respuesta = client.get("/api/settings")

    assert respuesta.get_json()["finnhubKeyCount"] == 2
    assert "clave-secreta" not in respuesta.get_data(as_text=True)


def test_las_claves_de_api_no_se_guardan_en_claro_en_disco(cliente):
    """API/ está dentro del proyecto y acaba en cualquier copia del directorio."""
    client, cabeceras, rutas = cliente
    client.post("/api/settings/apikey", json={"finnhubKey": "clave-secreta-1"}, headers=cabeceras)

    crudo = (rutas["claves"] / "finnhub.key").read_bytes()
    assert b"clave-secreta-1" not in crudo


# ── Lista de claves y de dónde salen ─────────────────────────────────────────

_VARIABLES = ("FINNHUB_API_KEY", "EODHD_API_KEYS", "ALPHA_VANTAGE_API_KEYS")


@pytest.fixture(autouse=True)
def sin_claves_en_el_entorno(monkeypatch):
    """El entorno gana al fichero, así que un `.env` cargado torcería la suite."""
    for variable in _VARIABLES:
        monkeypatch.delenv(variable, raising=False)


def _anadir_claves(client, cabeceras, *claves, campo="finnhubKey"):
    for clave in claves:
        client.post("/api/settings/apikey", json={campo: clave}, headers=cabeceras)


def _listar(client, proveedor="finnhub"):
    return client.get("/api/settings/apikeys").get_json()["proveedores"][proveedor]


def test_la_lista_trae_cada_clave_enmascarada_y_entera(cliente):
    """Enmascarada para pintarla; entera para que el ojo no vuelva al servidor.

    Mandar el valor completo es una decisión con supuesto detrás —LAN cerrada,
    un solo usuario, sin salida a internet—: pedirlo aparte no protegería de
    nada que la propia conexión no expusiera ya, y metía una petición por cada
    pulsación del ojo.
    """
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "abcdefghijklmnop", "1234567890123456")

    claves = _listar(client)["claves"]

    assert [c["indice"] for c in claves] == [0, 1]
    assert claves[0]["vista"] == "abcd••••••mnop"
    assert claves[0]["clave"] == "abcdefghijklmnop"
    assert claves[0]["longitud"] == 16


def test_la_lista_de_claves_no_se_queda_en_ninguna_cache(cliente):
    """Lleva secretos dentro, así que no puede guardarla nadie por el camino."""
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "clave-secreta-1")

    respuesta = client.get("/api/settings/apikeys")

    assert respuesta.headers.get("Cache-Control") == "no-store"


def test_una_clave_corta_no_deja_ver_ni_las_puntas(cliente):
    """Con ocho caracteres, enseñar cuatro y cuatro sería enseñarla entera."""
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "12345678")

    assert _listar(client)["claves"][0]["vista"] == "•" * 8


def test_los_tres_proveedores_salen_aunque_no_tengan_claves(cliente):
    """La interfaz pinta las tres filas; un proveedor ausente sería un hueco."""
    client, _cabeceras, _rutas = cliente

    proveedores = client.get("/api/settings/apikeys").get_json()["proveedores"]

    assert sorted(proveedores) == ["alphavantage", "eodhd", "finnhub"]
    assert proveedores["eodhd"]["claves"] == []


def test_cada_proveedor_lista_solo_sus_claves(cliente):
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "clave-de-finnhub", campo="finnhubKey")
    _anadir_claves(client, cabeceras, "clave-de-eodhd-1", campo="eodhdKeys")

    assert [c["clave"] for c in _listar(client, "finnhub")["claves"]] == ["clave-de-finnhub"]
    assert [c["clave"] for c in _listar(client, "eodhd")["claves"]] == ["clave-de-eodhd-1"]


def test_el_orden_de_la_lista_es_el_de_la_rotacion(cliente):
    """El número de cada fila es con el que el panel de estado las nombra."""
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "primera-clave-aa", "segunda-clave-bb", "tercera-clave-cc")

    claves = _listar(client)["claves"]

    assert [c["clave"] for c in claves] == ["primera-clave-aa", "segunda-clave-bb", "tercera-clave-cc"]


def test_sin_variable_de_entorno_las_claves_salen_del_fichero(cliente):
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "clave-del-fichero")

    info = _listar(client)

    assert info["origen"] == "fichero"
    assert info["ignoradas"] == 0
    assert info["variable"] == "FINNHUB_API_KEY"


def test_manda_el_fichero_y_la_variable_queda_de_respaldo(cliente, monkeypatch):
    """La trampa que se comía instalaciones enteras, ahora del revés.

    Cuando mandaba el entorno, se podían añadir claves en Ajustes, verlas
    aparecer, darse de alta en otra cuenta del proveedor, y que la aplicación
    siguiera mandando la del `.env` —el valor de ejemplo de `.env.example`, en
    el caso que lo destapó— sin que nada lo insinuara. Ahora manda lo que se ve
    en pantalla, que es lo único que se puede arreglar desde ella.
    """
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "d41d8cd98f00b204e980", "9e800998ecf8427e1234")
    monkeypatch.setenv("FINNHUB_API_KEY", "3c59dc048e8850243be8")

    info = _listar(client)

    assert info["origen"] == "fichero"
    assert [c["clave"] for c in info["claves"]] == ["d41d8cd98f00b204e980", "9e800998ecf8427e1234"]
    # La del entorno no rompe nada, pero conviene decir que está de más.
    assert info["ignoradas"] == 1


def test_sin_claves_en_el_fichero_se_usa_la_del_entorno(cliente, monkeypatch):
    """Un despliegue sin volumen para API/ no tiene dónde guardarlas."""
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "3c59dc048e8850243be8")

    info = _listar(client)

    assert info["origen"] == "entorno"
    assert [c["clave"] for c in info["claves"]] == ["3c59dc048e8850243be8"]
    assert info["ignoradas"] == 0


def test_sin_claves_en_ningun_sitio_el_origen_lo_dice(cliente):
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
def test_los_valores_de_ejemplo_de_la_documentacion_se_descartan(cliente, monkeypatch, ejemplo):
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


def test_un_ejemplo_en_el_entorno_no_tapa_a_la_clave_del_fichero(cliente, monkeypatch):
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "d41d8cd98f00b204e980")
    monkeypatch.setenv("FINNHUB_API_KEY", "tu_clave_finnhub")

    info = _listar(client)

    assert [c["clave"] for c in info["claves"]] == ["d41d8cd98f00b204e980"]
    # El ejemplo se descarta antes de contar, así que no figura como ignorada.
    assert info["ignoradas"] == 0


def test_una_clave_de_verdad_no_se_confunde_con_un_ejemplo(cliente, monkeypatch):
    """El reconocimiento es estrecho a propósito: tirar una clave buena sería peor."""
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "d6s0abcdefghijklmnopsfe0")

    assert [c["clave"] for c in _listar(client)["claves"]] == ["d6s0abcdefghijklmnopsfe0"]


def test_la_variable_de_eodhd_admite_varias_separadas_por_coma(cliente, monkeypatch):
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("EODHD_API_KEYS", "69c2aaaa1875, 69c2bbbb6133 ,69c2cccc7788")

    info = _listar(client, "eodhd")

    assert [c["clave"] for c in info["claves"]] == ["69c2aaaa1875", "69c2bbbb6133", "69c2cccc7788"]


def test_la_variable_de_finnhub_es_una_sola_clave(cliente, monkeypatch):
    """`FINNHUB_API_KEY` no se parte por comas: el lector real la usa entera."""
    client, _cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "d41d,8cd9,8f00")

    assert [c["clave"] for c in _listar(client)["claves"]] == ["d41d,8cd9,8f00"]


def test_una_variable_vacia_no_cuenta(cliente, monkeypatch):
    """`.env.example` deja las líneas puestas; en blanco no deben contar."""
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "d41d8cd98f00b204e980")
    monkeypatch.setenv("FINNHUB_API_KEY", "   ")

    info = _listar(client)

    assert info["origen"] == "fichero"
    assert info["ignoradas"] == 0


def test_listar_las_claves_sin_sesion_es_401(crear_app, datos_aislados, temp_db):
    """Es el único sitio del que salen las claves en claro."""
    from routes.ajustes import ajustes_bp

    client = crear_app(ajustes_bp).test_client()
    assert client.get("/api/settings/apikeys").status_code == 401


# ── Borrado de claves ────────────────────────────────────────────────────────

def _borrar(client, cabeceras, proveedor, clave):
    return client.delete(
        "/api/settings/apikey",
        json={"proveedor": proveedor, "clave": clave},
        headers=cabeceras,
    )


def test_borrar_una_clave_deja_las_demas(cliente):
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "primera-clave-aa", "segunda-clave-bb", "tercera-clave-cc")

    respuesta = _borrar(client, cabeceras, "finnhub", "segunda-clave-bb")

    assert respuesta.get_json() == {"ok": True, "restantes": 2}
    assert [c["clave"] for c in _listar(client)["claves"]] == ["primera-clave-aa", "tercera-clave-cc"]


def test_se_borra_por_valor_y_no_por_posicion(cliente):
    """La lista que ve el usuario puede haberse quedado atrás.

    Con un índice viejo —otra pestaña, una clave añadida entretanto— se borraría
    la clave equivocada sin que nada lo advirtiera.
    """
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "primera-clave-aa", "segunda-clave-bb")

    _borrar(client, cabeceras, "finnhub", "primera-clave-aa")
    _borrar(client, cabeceras, "finnhub", "segunda-clave-bb")

    assert _listar(client)["claves"] == []


def test_borrar_la_ultima_clave_deja_el_proveedor_sin_ninguna(cliente):
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "clave-unica-aaa")

    respuesta = _borrar(client, cabeceras, "finnhub", "clave-unica-aaa")

    assert respuesta.get_json()["restantes"] == 0
    assert client.get("/api/settings").get_json()["finnhubKeyCount"] == 0


def test_borrar_no_toca_las_claves_de_los_otros_proveedores(cliente):
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "clave-de-finnhub", campo="finnhubKey")
    _anadir_claves(client, cabeceras, "clave-de-eodhd-1", campo="eodhdKeys")

    _borrar(client, cabeceras, "finnhub", "clave-de-finnhub")

    assert _listar(client, "finnhub")["claves"] == []
    assert [c["clave"] for c in _listar(client, "eodhd")["claves"]] == ["clave-de-eodhd-1"]


def test_el_fichero_sigue_cifrado_despues_de_borrar(cliente):
    """Se reescribe entero: si la reescritura lo dejara en claro, nadie lo vería."""
    client, cabeceras, rutas = cliente
    _anadir_claves(client, cabeceras, "clave-secreta-1", "clave-secreta-2")

    _borrar(client, cabeceras, "finnhub", "clave-secreta-1")

    crudo = (rutas["claves"] / "finnhub.key").read_bytes()
    assert b"clave-secreta-2" not in crudo


def test_borrar_una_clave_que_no_esta_es_404(cliente):
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "clave-secreta-1")

    assert _borrar(client, cabeceras, "finnhub", "clave-que-no-existe").status_code == 404


def test_una_clave_del_entorno_no_se_puede_borrar_desde_aqui(cliente, monkeypatch):
    """No está en el fichero: se quita del `.env` del servidor, no de esta pantalla."""
    client, cabeceras, _rutas = cliente
    monkeypatch.setenv("FINNHUB_API_KEY", "clave-del-entorno")

    assert _borrar(client, cabeceras, "finnhub", "clave-del-entorno").status_code == 404


@pytest.mark.parametrize("clave", ["", None])
def test_borrar_sin_decir_que_clave_no_borra_nada(cliente, clave):
    """Un cuerpo a medias no puede acabar vaciando el fichero."""
    client, cabeceras, _rutas = cliente
    _anadir_claves(client, cabeceras, "clave-secreta-1")

    respuesta = _borrar(client, cabeceras, "finnhub", clave)

    assert respuesta.status_code == 404
    assert client.get("/api/settings").get_json()["finnhubKeyCount"] == 1


def test_borrar_en_un_proveedor_que_no_existe_es_400(cliente):
    client, cabeceras, _rutas = cliente

    assert _borrar(client, cabeceras, "../../.env", "lo-que-sea").status_code == 400


def test_borrar_una_clave_sin_sesion_es_401(crear_app, datos_aislados, temp_db):
    from routes.ajustes import ajustes_bp

    client = crear_app(ajustes_bp).test_client()
    respuesta = client.delete("/api/settings/apikey", json={"proveedor": "finnhub", "clave": "x"})

    assert respuesta.status_code == 401


def test_borrar_una_clave_sin_csrf_es_403(cliente_autenticado, datos_aislados, temp_db):
    from routes.ajustes import ajustes_bp

    client, _cabeceras, _app = cliente_autenticado(ajustes_bp)
    respuesta = client.delete("/api/settings/apikey", json={"proveedor": "finnhub", "clave": "x"})

    assert respuesta.status_code == 403


# ── Escritura: validación de cada ajuste ─────────────────────────────────────

def test_los_ajustes_validos_se_persisten(cliente):
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
def test_un_valor_no_admitido_cae_al_por_defecto(cliente, campo, valor, esperado):
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
def test_los_valores_numericos_se_acotan_al_rango(cliente, campo, valor, minimo, maximo):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, **{campo: valor})

    guardado = client.get("/api/settings").get_json()[campo]
    assert minimo <= guardado <= maximo


def test_guardar_un_ajuste_no_pisa_los_demas(cliente):
    """El POST es parcial: solo toca las claves que trae."""
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, theme="black", maxBackups=20)
    _guardar(client, cabeceras, dateFormat="MM/DD/YYYY")

    datos = client.get("/api/settings").get_json()
    assert datos["theme"] == "black"
    assert datos["maxBackups"] == 20
    assert datos["dateFormat"] == "MM/DD/YYYY"


def test_los_tipos_de_mercado_desconocidos_se_filtran(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, soloMercadoTipos=["acciones", "inventado", "cripto"])

    assert client.get("/api/settings").get_json()["soloMercadoTipos"] == ["acciones", "cripto"]


def test_una_cadena_donde_se_espera_una_lista_no_provoca_un_500(cliente, tmp_path):
    """Un cuerpo con el tipo equivocado se descarta, no revienta la petición."""
    client, cabeceras, rutas = cliente
    respuesta = _guardar(client, cabeceras, soloMercadoTipos="acciones", hiddenAssets=[])

    assert respuesta.status_code == 200
    # Se guarda la lista vacía…
    assert json.loads(rutas["ajustes"].read_text("utf-8"))["soloMercadoTipos"] == []
    # …aunque get_settings la lea con `or [defectos]`, así que al releer salen
    # los tres tipos por defecto. Es el comportamiento actual, no un descuido
    # del test: con soloHorarioMercado desactivado la lista no se usa, y quien
    # la deje vacía a propósito verá que vuelven los valores iniciales.
    assert client.get("/api/settings").get_json()["soloMercadoTipos"] == [
        "acciones", "etfs", "comoditis",
    ]


def test_los_modulos_desconocidos_no_entran_en_la_configuracion(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, modulosConfig={"metricas": False, "moduloFantasma": True})

    guardado = client.get("/api/settings").get_json()["modulosConfig"]
    assert guardado == {"metricas": False}


def test_el_objetivo_de_ahorro_se_acota_entre_0_y_100(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, ahorroConfig={"objetivoAhorro": 500, "presupuesto": {"Casa": -20}})

    guardado = client.get("/api/settings").get_json()["ahorroConfig"]
    assert guardado["objetivoAhorro"] == 100.0
    assert guardado["presupuesto"]["Casa"] == 0.0


def test_un_objetivo_de_ahorro_que_no_es_numero_cae_al_defecto(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, ahorroConfig={"objetivoAhorro": "mucho"})

    assert client.get("/api/settings").get_json()["ahorroConfig"]["objetivoAhorro"] == 30.0


def test_las_divisas_fiat_exigen_codigo_y_nombre(cliente):
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


def test_las_preferencias_por_portfolio_van_a_su_propio_fichero(cliente):
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

def test_guardar_ajustes_sin_sesion_es_401(crear_app, datos_aislados, temp_db):
    from routes.ajustes import ajustes_bp

    client = crear_app(ajustes_bp).test_client()
    assert client.post("/api/settings", json={"theme": "black"}).status_code == 401


def test_exportar_sin_sesion_es_401(crear_app, datos_aislados, temp_db):
    """El export lleva dentro toda la base de datos."""
    from routes.ajustes import ajustes_bp

    client = crear_app(ajustes_bp).test_client()
    assert client.get("/api/export/json").status_code == 401


def test_importar_sin_csrf_es_403(cliente_autenticado, datos_aislados, temp_db):
    from routes.ajustes import ajustes_bp

    client, _cabeceras, _app = cliente_autenticado(ajustes_bp)
    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(b"{}"), "x.json")},
        content_type="multipart/form-data",
    )
    assert respuesta.status_code == 403


# ── Exportar ─────────────────────────────────────────────────────────────────

def test_el_export_json_incluye_las_tablas_reales_y_los_ajustes(cliente):
    """El export enumeraba una lista fija de nombres, 4 de ellos inexistentes."""
    client, cabeceras, _rutas = cliente
    from core.db import get_db

    _guardar(client, cabeceras, theme="black")
    conn = get_db()
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


def test_el_export_se_descarga_como_fichero(cliente):
    client, _cabeceras, _rutas = cliente
    cabeceras = client.get("/api/export/json").headers

    assert "attachment" in cabeceras["Content-Disposition"]
    assert cabeceras["Content-Type"].startswith("application/json")


def test_el_export_zip_lleva_el_json_el_db_y_los_ajustes(cliente):
    client, cabeceras, _rutas = cliente
    _guardar(client, cabeceras, theme="light")

    contenido = client.get("/api/export/zip").get_data()
    with zipfile.ZipFile(io.BytesIO(contenido)) as zf:
        nombres = zf.namelist()

    assert any(n.endswith(".db") for n in nombres)
    assert any(n.startswith("portfolio-export-") and n.endswith(".json") for n in nombres)
    assert "ajustes.json" in nombres


# ── Importar ─────────────────────────────────────────────────────────────────

def test_importar_sin_fichero_es_400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post("/api/import/json", data={}, headers=cabeceras,
                            content_type="multipart/form-data")
    assert respuesta.status_code == 400


def test_importar_un_json_invalido_es_400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(b"{no soy json"), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert respuesta.status_code == 400


def test_importar_una_lista_en_vez_de_un_objeto_es_400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(b"[1, 2, 3]"), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert respuesta.status_code == 400


def test_exportar_e_importar_devuelve_los_mismos_datos(cliente):
    """La ida y vuelta completa: es lo que hace un usuario que migra de máquina."""
    client, cabeceras, _rutas = cliente
    from core.db import get_db

    conn = get_db()
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
    conn = get_db()
    assert sorted(r[0] for r in conn.execute("SELECT label FROM gastos_tipos")) == ["Café", "Coche"]
    assert conn.execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 1


def test_una_tabla_que_no_existe_en_el_esquema_se_ignora(cliente):
    """Un export de una versión anterior no debe reventar la importación."""
    client, cabeceras, _rutas = cliente
    from core.db import get_db

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
    assert [r[0] for r in get_db().execute("SELECT label FROM gastos_tipos")] == ["Ocio"]


def test_una_columna_que_no_existe_se_descarta_sin_perder_la_fila(cliente):
    client, cabeceras, _rutas = cliente
    from core.db import get_db

    payload = json.dumps({
        "tables": {"gastos_tipos": [{"label": "Ocio", "columna_fantasma": "x"}]},
    }).encode()

    respuesta = client.post(
        "/api/import/json",
        data={"file": (io.BytesIO(payload), "export.json")},
        headers=cabeceras, content_type="multipart/form-data",
    )

    assert respuesta.status_code == 200
    assert [r[0] for r in get_db().execute("SELECT label FROM gastos_tipos")] == ["Ocio"]


def test_un_zip_que_no_es_un_zip_es_400(cliente):
    client, cabeceras, _rutas = cliente
    respuesta = client.post(
        "/api/import/zip",
        data={"file": (io.BytesIO(b"esto no es un zip"), "export.zip")},
        headers=cabeceras, content_type="multipart/form-data",
    )
    assert respuesta.status_code == 400


def test_un_prefs_con_ruta_de_escape_no_sale_de_data_json(cliente, tmp_path):
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
