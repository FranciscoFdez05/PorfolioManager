"""El Atajo de iOS gestionado desde Ajustes > API.

Dos cosas se comprueban aquí, y las dos son «que no mienta»:

- **El fichero .shortcut**, que no se puede probar sin un iPhone delante. Lo que
  sí se puede es fijar lo que rompería el atajo en silencio: que el cuerpo del
  envío vaya como `Archivo` y no como JSON (con JSON, Atajos reserializa el
  texto y la firma falla con un 401 que parece un problema de clave), que las
  posiciones de las variables dentro de las URL cuadren, y que el fichero no
  lleve dentro ningún secreto.
- **El diagnóstico**, que existe justamente para no tener que leer el log: si
  dijera «falta la clave» cuando lo que pasa es que no se puede descifrar,
  llevaría a generar una nueva y a perder la que había.
"""

import plistlib

import pytest

from core import atajo, atajo_shortcut, firma_hmac

BASE = "http://192.168.1.163:5000"


@pytest.fixture(autouse=True)
def clave_aislada(tmp_path, monkeypatch):
    """Saca API/movimientos.key del repositorio en todos los tests del fichero."""
    destino = tmp_path / "movimientos.key"
    monkeypatch.setattr(firma_hmac, "rutaFicheroClave", lambda: destino)
    monkeypatch.delenv(firma_hmac.ENV_CLAVE, raising=False)
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    return destino


def _acciones(base=BASE):
    return plistlib.loads(atajo_shortcut.construir(base))["WFWorkflowActions"]


def _urls(acciones):
    return [
        a["WFWorkflowActionParameters"]["WFURL"]["Value"]["string"]
        for a in acciones
        if "WFURL" in a["WFWorkflowActionParameters"]
    ]


# ── El fichero .shortcut ──────────────────────────────────────────────────────

def test_el_atajo_es_un_plist_con_las_cuatro_llamadas():
    """Portfolios, categorías, preparar y enviar, en ese orden."""
    urls = _urls(_acciones())

    assert urls[0] == f"{BASE}/api/portfolios-lista"
    assert urls[1].startswith(f"{BASE}/api/categorias?portfolio=")
    assert urls[2] == f"{BASE}/api/preparar"
    assert urls[3] == f"{BASE}/api/movimiento"


def test_el_envio_va_como_archivo_y_no_como_json():
    """Es el detalle que rompe el atajo sin dejar rastro: con `Json`, Atajos
    vuelve a serializar el cuerpo, cambian los bytes y la firma deja de valer.
    El 401 resultante parece un problema de clave y no lo es."""
    envio = next(
        a["WFWorkflowActionParameters"]
        for a in _acciones()
        if a["WFWorkflowActionParameters"].get("WFURL", {}).get("Value", {}).get("string", "").endswith("/api/movimiento")
    )

    assert envio["WFHTTPBodyType"] == "File"
    assert envio["WFRequestVariable"]["Value"]["VariableName"] == "envio"

    cabeceras = [c["WFKey"]["Value"]["string"] for c in envio["WFHTTPHeaders"]["Value"]["WFDictionaryFieldValueItems"]]
    assert cabeceras == ["Content-Type", "X-Signature", "X-Timestamp"]


def test_las_variables_caen_donde_dice_el_mapa_de_posiciones():
    """Atajos localiza cada variable por su posición dentro del texto. Si el mapa
    y la cadena se calcularan por separado, tocar una letra de la URL metería la
    variable en otro sitio y el atajo se importaría roto."""
    url = next(
        a["WFWorkflowActionParameters"]["WFURL"]["Value"]
        for a in _acciones()
        if "categorias" in a["WFWorkflowActionParameters"].get("WFURL", {}).get("Value", {}).get("string", "")
    )

    for rango, adjunto in url["attachmentsByRange"].items():
        posicion = int(rango.strip("{}").split(",")[0])
        assert url["string"][posicion] == atajo_shortcut.HUECO, adjunto


def test_el_movimiento_no_lleva_fecha():
    """La pone el servidor con el día en que llega la petición: preguntarla sería
    un paso más en algo que tiene que caber en una pulsación."""
    preparar = next(
        a["WFWorkflowActionParameters"]
        for a in _acciones()
        if "WFJSONValues" in a["WFWorkflowActionParameters"]
    )
    campos = [c["WFKey"]["Value"]["string"] for c in preparar["WFJSONValues"]["Value"]["WFDictionaryFieldValueItems"]]

    assert campos == ["tipo", "categoria", "nombre", "importe", "portfolio"]
    assert "fecha" not in campos


def test_el_fichero_no_lleva_ninguna_clave(clave_aislada):
    """Puede guardarse en Archivos o mandarse por AirDrop: lo único sensible que
    contiene es la dirección del servidor. El atajo pide la firma en cada uso."""
    firma_hmac.escribirClaveNueva(clave_aislada)
    secreto = firma_hmac.obtenerClaveSecreta().decode()

    assert secreto.encode() not in atajo_shortcut.construir(BASE)


def test_la_barra_final_no_duplica_la_del_endpoint():
    assert _urls(_acciones(BASE + "/"))[0] == f"{BASE}/api/portfolios-lista"


# ── Diagnóstico ───────────────────────────────────────────────────────────────

def test_sin_fichero_el_estado_dice_que_no_hay_clave():
    assert atajo.estado(BASE)["clave"] == {
        "hay": False,
        "origen": "ninguna",
        "detalle": "movimientos.key",
    }


def test_con_clave_el_estado_dice_de_dónde_sale(clave_aislada):
    firma_hmac.escribirClaveNueva(clave_aislada)

    clave = atajo.estado(BASE)["clave"]

    assert clave["hay"] is True
    assert clave["origen"] == "fichero"


def test_una_clave_ilegible_no_se_confunde_con_una_que_falta(clave_aislada, monkeypatch):
    """Son dos averías con soluciones opuestas —generar otra, o recuperar la
    SECRET_KEY— y antes se veían idénticas: las dos acaban en una lista vacía.
    Confundirlas lleva a generar una clave nueva y perder la que había."""
    firma_hmac.escribirClaveNueva(clave_aislada)
    monkeypatch.setenv("SECRET_KEY", "otra-clave-distinta-0123456789abcdef0123456789")

    clave = atajo.estado(BASE)["clave"]

    assert clave["hay"] is False
    assert clave["origen"] == "ilegible"
    assert "SECRET_KEY" in clave["detalle"]


def test_la_variable_de_entorno_manda_sobre_el_fichero(clave_aislada, monkeypatch):
    firma_hmac.escribirClaveNueva(clave_aislada)
    monkeypatch.setenv(firma_hmac.ENV_CLAVE, "clave-por-entorno")

    assert atajo.estado(BASE)["clave"]["origen"] == "entorno"


# ── Prueba en seco ────────────────────────────────────────────────────────────

def test_la_prueba_para_en_el_primer_paso_que_falla():
    """Señalar la avería, no listar síntomas: sin clave, lo que viene después
    tampoco puede funcionar y decirlo solo añade ruido."""
    salida = atajo.probar()

    assert salida["ok"] is False
    assert [p["ok"] for p in salida["pasos"]] == [True, True, False]
    assert salida["pasos"][-1]["paso"] == "Hay clave de firma"


def test_con_todo_puesto_la_prueba_firma_y_verifica(clave_aislada):
    """El último paso hace el mismo camino que una petición real del Atajo: si
    la clave estuviera ilegible o el reloj imposible, saldría aquí y no en el
    iPhone."""
    firma_hmac.escribirClaveNueva(clave_aislada)

    salida = atajo.probar()

    assert salida["ok"] is True
    assert [p["paso"] for p in salida["pasos"]][-1] == "Firma y verificación"
    assert all(p["ok"] for p in salida["pasos"])


def test_la_prueba_no_escribe_ningún_movimiento(clave_aislada, monkeypatch):
    """Una comprobación que deja un gasto de mentira en el portfolio no se puede
    repetir sin ensuciar los datos.

    El cepo se pone en el store: si algún día se completa la prueba con el alta
    de verdad, lo natural sería llamar ahí, y este test lo cazaría antes de que
    llegue a los datos de nadie.
    """
    import stores.movimientos_store as store

    firma_hmac.escribirClaveNueva(clave_aislada)
    monkeypatch.setattr(
        store, "crearMovimiento",
        lambda *a, **k: pytest.fail("la prueba en seco no debe crear movimientos"),
    )

    assert atajo.probar()["ok"] is True


# ── Endpoints ─────────────────────────────────────────────────────────────────

@pytest.fixture
def bp_atajo():
    from routes.atajo import atajo_bp
    return atajo_bp


def test_los_endpoints_del_panel_exigen_sesión(crear_app, bp_atajo):
    """Son los de la web app, no los del Atajo: el Atajo se autentica por IP y
    firma, pero esto se abre desde el navegador y va detrás del login."""
    client = crear_app(bp_atajo).test_client()

    assert client.get("/api/atajo").status_code == 401
    assert client.get("/api/atajo/descargar").status_code == 401


def test_el_panel_devuelve_el_estado(cliente_autenticado, bp_atajo):
    client, _cab, _app = cliente_autenticado(bp_atajo)

    datos = client.get("/api/atajo").get_json()

    assert datos["ok"] is True
    assert datos["clave"]["hay"] is False
    # La dirección sale del Host de la petición: desde dentro del contenedor no
    # hay forma de saber por cuál lo alcanza el iPhone.
    assert datos["urlBase"].endswith("localhost")


def test_generar_la_clave_desde_el_panel_la_deja_utilizable(cliente_autenticado, bp_atajo, clave_aislada):
    client, cab, _app = cliente_autenticado(bp_atajo)

    datos = client.post("/api/atajo/clave", headers=cab).get_json()

    assert datos["ok"] is True
    assert datos["clave"]["hay"] is True
    assert clave_aislada.exists()
    assert firma_hmac.obtenerClaveSecreta()


def test_la_descarga_es_un_atajo_con_nombre_de_fichero(cliente_autenticado, bp_atajo):
    client, _cab, _app = cliente_autenticado(bp_atajo)

    res = client.get("/api/atajo/descargar")

    assert res.status_code == 200
    assert "PorfolioManager.shortcut" in res.headers["Content-Disposition"]
    assert plistlib.loads(res.data)["WFWorkflowActions"]
