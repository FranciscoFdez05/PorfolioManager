"""Pruebas de /api/activos y del rendimiento agregado.

Es el CRUD sobre el que se apoya el resto de la aplicación: los identificadores
salen de `slugify(nombre)`, así que dos nombres distintos pueden colisionar en
el mismo activo, y el rendimiento por lote es la aritmética que pinta la tabla
principal. Nada de esto estaba cubierto.

Las rutas que llaman a un proveedor de mercado (`refresh-market-data`,
`currency`) se prueban solo hasta donde llegan sin red: qué responden cuando el
activo no existe o la moneda no está soportada. Salir a internet en la suite
haría que un PR dependiera de que Finnhub esté disponible.
"""

import pytest


@pytest.fixture
def cliente(cliente_autenticado, temp_db, monkeypatch):
    from routes.activos import activos_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(activos_bp)
    return client, cabeceras


def _crear(client, cabeceras, nombre, tipo="acciones", **extra):
    return client.post("/api/activos", json={"name": nombre, "type": tipo, **extra},
                       headers=cabeceras)


# ── Crear ────────────────────────────────────────────────────────────────────

def test_crear_activo_devuelve_201_y_el_payload(cliente):
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "Apple", "acciones", marketSymbol="aapl")

    assert respuesta.status_code == 201
    activo = respuesta.get_json()["asset"]
    assert activo["name"] == "Apple"
    assert activo["id"] == "apple"
    # El símbolo se normaliza a mayúsculas: los proveedores no aceptan otra cosa.
    assert activo["marketSymbol"] == "AAPL"


def test_el_nombre_es_obligatorio(cliente):
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "   ")

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_un_tipo_de_activo_invalido_se_rechaza(cliente):
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "Algo", tipo="inventado")

    assert respuesta.status_code == 400


def test_no_se_puede_crear_dos_veces_el_mismo_activo(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")
    respuesta = _crear(client, cabeceras, "Apple")

    assert respuesta.status_code == 409


def test_dos_nombres_que_producen_el_mismo_id_colisionan(cliente):
    """El id sale de slugify(nombre): "Apple Inc." y "apple-inc" son el mismo.

    Se prueba porque es sorprendente y determina el 409: si algún día slugify
    cambia, este test dirá qué nombres dejan de colisionar.
    """
    client, cabeceras = cliente
    primero = _crear(client, cabeceras, "Apple Inc.")
    segundo = _crear(client, cabeceras, "apple inc")

    assert primero.status_code == 201
    assert segundo.status_code == 409


def test_los_activos_se_crean_al_final_del_orden(cliente):
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos", "Tres"):
        _crear(client, cabeceras, nombre)

    ordenes = [a["order"] for a in client.get("/api/activos").get_json()["assets"]]
    assert ordenes == sorted(ordenes)


def test_un_color_manipulado_no_llega_al_html(cliente):
    """El color se inyecta en un atributo style del frontend."""
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "Apple", color="red; background: url(javascript:alert(1))")

    assert "javascript" not in respuesta.get_json()["asset"]["color"]


# ── Leer ─────────────────────────────────────────────────────────────────────

def test_listar_sin_activos_devuelve_una_lista_vacia(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/activos").get_json()["assets"] == []


def test_leer_un_activo_inexistente_es_404(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/activos/no-existe").status_code == 404


def test_leer_un_activo_devuelve_su_ficha(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple", marketSymbol="AAPL")

    datos = client.get("/api/activos/apple").get_json()

    assert datos["name"] == "Apple"
    assert datos["marketSymbol"] == "AAPL"
    assert isinstance(datos["rows"], list)


# ── Guardar ──────────────────────────────────────────────────────────────────

def test_guardar_una_ficha_persiste_las_filas(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")
    ficha = client.get("/api/activos/apple").get_json()
    ficha["rows"] = [{
        "fechaOperacion": "10-01-2026",
        "tipoOperacion": "Compra",
        "participaciones": "10",
        "capitalInvertidoBruto": "1000",
    }]

    respuesta = client.post("/api/activos/apple", json=ficha, headers=cabeceras)

    assert respuesta.status_code == 200
    guardado = client.get("/api/activos/apple").get_json()
    assert len(guardado["rows"]) == 1
    assert guardado["rows"][0]["participaciones"] == "10"


def test_guardar_sin_operationRows_no_borra_las_que_ya_habia(cliente):
    """El formulario de la ficha no envía las operaciones de cripto.

    Sin esta salvaguarda, guardar cualquier cambio en la ficha se llevaba por
    delante el histórico de operaciones del activo.
    """
    client, cabeceras = cliente
    _crear(client, cabeceras, "Bitcoin", tipo="cripto")
    ficha = client.get("/api/activos/bitcoin").get_json()
    ficha["operationRows"] = [{
        "fecha": "10-01-2026", "orden": "Compra", "cantidad": "0,5",
        "total": "20000", "estado": "Completado",
    }]
    client.post("/api/activos/bitcoin", json=ficha, headers=cabeceras)

    sin_operaciones = {k: v for k, v in ficha.items() if k != "operationRows"}
    client.post("/api/activos/bitcoin", json=sin_operaciones, headers=cabeceras)

    assert len(client.get("/api/activos/bitcoin").get_json()["operationRows"]) == 1


# ── Reordenar ────────────────────────────────────────────────────────────────

def test_reordenar_con_la_lista_completa(cliente):
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos", "Tres"):
        _crear(client, cabeceras, nombre)

    respuesta = client.post("/api/activos/reorder",
                            json={"orderedAssetIds": ["tres", "uno", "dos"]}, headers=cabeceras)

    assert respuesta.status_code == 200
    ids = [a["id"] for a in client.get("/api/activos").get_json()["assets"]]
    assert ids == ["tres", "uno", "dos"]


def test_una_lista_de_orden_incompleta_se_rechaza(cliente):
    """Aceptarla dejaría fuera del orden a los activos que faltasen."""
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos"):
        _crear(client, cabeceras, nombre)

    respuesta = client.post("/api/activos/reorder",
                            json={"orderedAssetIds": ["uno"]}, headers=cabeceras)

    assert respuesta.status_code == 400


def test_mover_un_activo_hacia_arriba(cliente):
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos"):
        _crear(client, cabeceras, nombre)

    client.post("/api/activos/reorder", json={"assetId": "dos", "direction": "up"},
                headers=cabeceras)

    ids = [a["id"] for a in client.get("/api/activos").get_json()["assets"]]
    assert ids == ["dos", "uno"]


def test_mover_el_primero_hacia_arriba_no_hace_nada(cliente):
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos"):
        _crear(client, cabeceras, nombre)

    respuesta = client.post("/api/activos/reorder", json={"assetId": "uno", "direction": "up"},
                            headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["moved"] is False


@pytest.mark.parametrize("cuerpo,codigo", [
    ({"direction": "up"}, 400),                        # sin assetId
    ({"assetId": "uno", "direction": "lateral"}, 400),  # dirección inventada
    ({"assetId": "no-existe", "direction": "up"}, 404),
])
def test_reordenar_con_datos_incoherentes(cliente, cuerpo, codigo):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Uno")

    assert client.post("/api/activos/reorder", json=cuerpo, headers=cabeceras).status_code == codigo


# ── Borrar ───────────────────────────────────────────────────────────────────

def test_borrar_un_activo(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")

    assert client.delete("/api/activos/apple", headers=cabeceras).status_code == 200
    assert client.get("/api/activos/apple").status_code == 404


def test_borrar_un_activo_inexistente_es_404(cliente):
    client, cabeceras = cliente
    assert client.delete("/api/activos/no-existe", headers=cabeceras).status_code == 404


# ── Moneda ───────────────────────────────────────────────────────────────────

def test_cambiar_a_la_misma_moneda_no_convierte_nada(cliente):
    """Y, sobre todo, no llama al proveedor de tipos de cambio."""
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")

    respuesta = client.post("/api/activos/apple/currency", json={"currency": "EUR"},
                            headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["converted"] is False


def test_una_moneda_no_soportada_se_rechaza_sin_salir_a_la_red(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")

    respuesta = client.post("/api/activos/apple/currency", json={"currency": "XYZ"},
                            headers=cabeceras)

    assert respuesta.status_code == 400
    assert "Moneda no soportada" in respuesta.get_json()["error"]


def test_cambiar_la_moneda_de_un_activo_inexistente_es_404(cliente):
    client, cabeceras = cliente
    respuesta = client.post("/api/activos/no-existe/currency", json={"currency": "USD"},
                            headers=cabeceras)
    assert respuesta.status_code == 404


def test_refrescar_un_activo_inexistente_es_404(cliente):
    client, cabeceras = cliente
    respuesta = client.post("/api/activos/no-existe/refresh-market-data", headers=cabeceras)
    assert respuesta.status_code == 404


# ── Rendimiento agregado ─────────────────────────────────────────────────────

def _ficha_con_filas(client, cabeceras, nombre, precio, filas, tipo="acciones"):
    _crear(client, cabeceras, nombre, tipo=tipo)
    asset_id = nombre.lower()
    ficha = client.get(f"/api/activos/{asset_id}").get_json()
    ficha["price"] = precio
    ficha["rows"] = filas
    client.post(f"/api/activos/{asset_id}", json=ficha, headers=cabeceras)
    return asset_id


def test_el_rendimiento_descuenta_las_comisiones_del_invertido(cliente):
    client, cabeceras = cliente
    asset_id = _ficha_con_filas(client, cabeceras, "Apple", "120", [{
        "fechaOperacion": "10-01-2026",
        "tipoOperacion": "Compra",
        "participaciones": "10",
        "capitalInvertidoBruto": "1000",
        "comisiones": "50",
    }])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[asset_id]

    # Invertido neto = 1000 bruto - 50 de comisiones.
    assert datos["invertidoNeto"] == 950.0
    assert datos["netoActual"] == 1200.0
    assert datos["rendimiento"] == 250.0
    assert datos["rendimientoPct"] == pytest.approx(26.32, abs=0.01)


def test_una_venta_reduce_las_participaciones_pero_no_lo_invertido(cliente):
    client, cabeceras = cliente
    asset_id = _ficha_con_filas(client, cabeceras, "Apple", "100", [
        {"fechaOperacion": "10-01-2026", "tipoOperacion": "Compra",
         "participaciones": "10", "capitalInvertidoBruto": "1000"},
        {"fechaOperacion": "11-01-2026", "tipoOperacion": "Venta",
         "participaciones": "4", "capitalInvertidoBruto": "500"},
    ])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[asset_id]

    assert datos["netoActual"] == 600.0     # quedan 6 participaciones a 100
    assert datos["invertidoNeto"] == 1000.0


def test_vender_mas_de_lo_que_hay_no_produce_un_valor_negativo(cliente):
    """Un descuadre en los datos no debe pintar una cartera en negativo."""
    client, cabeceras = cliente
    asset_id = _ficha_con_filas(client, cabeceras, "Apple", "100", [
        {"fechaOperacion": "10-01-2026", "tipoOperacion": "Compra",
         "participaciones": "5", "capitalInvertidoBruto": "500"},
        {"fechaOperacion": "11-01-2026", "tipoOperacion": "Venta",
         "participaciones": "50", "capitalInvertidoBruto": "5000"},
    ])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[asset_id]

    assert datos["netoActual"] == 0.0


def test_sin_invertido_el_porcentaje_es_cero_y_no_divide_por_cero(cliente):
    client, cabeceras = cliente
    asset_id = _ficha_con_filas(client, cabeceras, "Apple", "100", [])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[asset_id]

    assert datos["rendimientoPct"] == 0
    assert datos["invertidoNeto"] == 0


def test_los_importes_se_leen_en_formato_espaniol(cliente):
    """El frontend guarda "1.234,56": leerlo como float daría 1,234."""
    client, cabeceras = cliente
    asset_id = _ficha_con_filas(client, cabeceras, "Apple", "1.500,00", [{
        "fechaOperacion": "10-01-2026", "tipoOperacion": "Compra",
        "participaciones": "1", "capitalInvertidoBruto": "1.234,56",
    }])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[asset_id]

    assert datos["invertidoNeto"] == 1234.56
    assert datos["netoActual"] == 1500.0


# ── Sesión ───────────────────────────────────────────────────────────────────

def test_los_activos_no_se_leen_sin_sesion(crear_app, temp_db):
    from routes.activos import activos_bp

    client = crear_app(activos_bp).test_client()
    assert client.get("/api/activos").status_code == 401


def test_borrar_un_activo_sin_csrf_es_403(cliente_autenticado, temp_db):
    from routes.activos import activos_bp

    client, _cabeceras, _app = cliente_autenticado(activos_bp)
    assert client.delete("/api/activos/apple").status_code == 403
