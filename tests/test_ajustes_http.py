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
