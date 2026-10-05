"""Cuenta de ahorro: los movimientos son filas de gastos (aportar) e ingresos (retirar)."""

import pytest


@pytest.fixture
def cliente(cliente_autenticado, datos_aislados, temp_db, monkeypatch):
    from routes.cuenta_ahorro import cuenta_ahorro_bp
    from routes.gastos import gastos_bp
    from routes.ingresos import ingresos_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")

    client, cabeceras, _app = cliente_autenticado(cuenta_ahorro_bp, gastos_bp, ingresos_bp)
    return client, cabeceras


def _anadir(client, cabeceras, **campos):
    return client.post("/api/cuenta-ahorro/movimientos", json=campos, headers=cabeceras)


def test_una_aportacion_es_un_gasto_en_su_dia_mes_y_anio(cliente):
    client, cabeceras = cliente

    res = _anadir(client, cabeceras, kind="ingreso", fecha="15-03-2027", cantidad="1500", nombre="Marzo")

    assert res.status_code == 201
    gastos = client.get("/api/gastos/2027").get_json()
    fila = gastos["months"]["marzo"]["rows"][0]
    assert fila["fecha"] == "15-03-2027"
    assert fila["tipo"] == "Cuenta de ahorro"
    assert fila["cantidad"] == "1.500,00 €"
    # Y no aparece en ningún otro mes ni en ingresos.
    assert gastos["months"]["abril"]["rows"] == []
    assert client.get("/api/ingresos/2027").get_json()["months"]["marzo"]["rows"] == []


def test_una_retirada_es_un_ingreso(cliente):
    client, cabeceras = cliente

    _anadir(client, cabeceras, kind="retiro", fecha="02-06-2026", cantidad="250,50")

    fila = client.get("/api/ingresos/2026").get_json()["months"]["junio"]["rows"][0]
    assert fila["tipo"] == "Cuenta de ahorro"
    assert fila["cantidad"] == "250,50 €"
    assert fila["nombre"] == "Retirada de cuenta de ahorro"


def test_el_listado_trae_aportaciones_y_retiradas_de_todos_los_anios(cliente):
    client, cabeceras = cliente
    _anadir(client, cabeceras, kind="ingreso", fecha="01-01-2026", cantidad="100")
    _anadir(client, cabeceras, kind="retiro", fecha="01-02-2027", cantidad="40")

    movs = client.get("/api/cuenta-ahorro").get_json()["movimientos"]

    assert [(m["kind"], m["year"], m["month"]) for m in movs] == [
        ("ingreso", "2026", "enero"),
        ("retiro", "2027", "febrero"),
    ]


def test_un_gasto_con_la_categoria_reservada_tambien_cuenta(cliente):
    """Añadido desde la ventana de Gastos, sin pasar por esta API."""
    client, cabeceras = cliente
    client.post(
        "/api/gastos/2026",
        json={"year": "2026", "months": {"mayo": {"rows": [
            {"fecha": "05-05-2026", "nombre": "Hucha", "tipo": "Cuenta de ahorro", "cantidad": "30,00 €"}
        ]}}},
        headers=cabeceras,
    )

    movs = client.get("/api/cuenta-ahorro").get_json()["movimientos"]

    assert [(m["kind"], m["nombre"]) for m in movs] == [("ingreso", "Hucha")]


def test_la_categoria_reservada_siempre_esta_en_los_catalogos(cliente):
    client, _cabeceras = cliente

    assert "Cuenta de ahorro" in client.get("/api/gastos-tipos").get_json()["types"]
    assert "Cuenta de ahorro" in client.get("/api/ingresos-tipos").get_json()["types"]


def test_guardar_el_catalogo_sin_la_categoria_reservada_no_la_pierde(cliente):
    client, cabeceras = cliente

    client.post("/api/gastos-tipos", json={"types": ["Café"]}, headers=cabeceras)

    assert "Cuenta de ahorro" in client.get("/api/gastos-tipos").get_json()["types"]


@pytest.mark.parametrize(
    "campos",
    [
        {"kind": "otro", "cantidad": "10"},
        {"kind": "ingreso", "cantidad": "abc"},
        {"kind": "ingreso", "cantidad": "0"},
        {"kind": "ingreso", "cantidad": "-5"},
        {"kind": "ingreso", "cantidad": "10", "fecha": "31-02-2026"},
        {"kind": "ingreso", "cantidad": "10", "fecha": "ayer"},
    ],
)
def test_los_datos_invalidos_se_rechazan(cliente, campos):
    client, cabeceras = cliente

    assert _anadir(client, cabeceras, **campos).status_code == 400
    assert client.get("/api/cuenta-ahorro").get_json()["movimientos"] == []


def test_eliminar_borra_la_fila_de_gastos(cliente):
    client, cabeceras = cliente
    mov = _anadir(client, cabeceras, kind="ingreso", fecha="10-04-2026", cantidad="75").get_json()["movimiento"]

    res = client.post(
        "/api/cuenta-ahorro/movimientos/eliminar",
        json={"kind": "ingreso", "id": mov["id"], "fecha": mov["fecha"], "cantidad": mov["cantidad"]},
        headers=cabeceras,
    )

    assert res.status_code == 200
    assert client.get("/api/gastos/2026").get_json()["months"]["abril"]["rows"] == []


def test_eliminar_no_toca_una_fila_que_ha_heredado_el_id(cliente):
    """Gastos reescribe el año al guardar y los ids cambian: no vale borrar solo por id."""
    client, cabeceras = cliente
    mov = _anadir(client, cabeceras, kind="ingreso", fecha="10-04-2026", cantidad="75").get_json()["movimiento"]

    res = client.post(
        "/api/cuenta-ahorro/movimientos/eliminar",
        json={"kind": "ingreso", "id": mov["id"], "fecha": "10-04-2026", "cantidad": "99,00 €"},
        headers=cabeceras,
    )

    assert res.status_code == 404
    assert len(client.get("/api/cuenta-ahorro").get_json()["movimientos"]) == 1


def test_la_categoria_reservada_no_se_puede_renombrar_ni_eliminar(temp_db):
    from stores.categorias_store import CategoriaInvalida, eliminarCategoria, renombrarCategoria
    from stores.cuenta_ahorro_store import asegurar_categorias

    asegurar_categorias()

    with pytest.raises(CategoriaInvalida):
        renombrarCategoria("gasto", "Cuenta de ahorro", "Hucha")
    with pytest.raises(CategoriaInvalida):
        renombrarCategoria("gasto", "Otra", "cuenta de AHORRO")
    with pytest.raises(CategoriaInvalida):
        eliminarCategoria("ingreso", "Cuenta de ahorro")
