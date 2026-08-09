"""Pruebas de la gestión global del catálogo de categorías.

Lo que se comprueba de verdad aquí es que renombrar alcanza a TODOS los años:
es la razón de que esto viva en el servidor y no en el navegador.
"""

import pytest


@pytest.fixture
def datos(temp_db):
    """Dos años de gastos y uno de ingresos usando las mismas categorías."""
    from core.db import get_db

    conn = get_db()
    conn.executemany(
        "INSERT INTO gastos_tipos (label) VALUES (?)",
        [("Café",), ("Coche",), ("Compras",)],
    )
    conn.executemany(
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        [
            ("2025", "enero", "10-01-2025", "Bar", "Café", "2,00 €"),
            ("2026", "marzo", "04-03-2026", "Cafetería", "Café", "3,00 €"),
            ("2026", "abril", "01-04-2026", "Taller", "Coche", "90,00 €"),
        ],
    )
    conn.execute(
        "INSERT INTO mensualidades (year, nombre, categoria, importe) VALUES (?, ?, ?, ?)",
        ("2026", "Seguro", "Coche", "40,00"),
    )
    conn.executemany(
        "INSERT INTO ingresos_tipos (label) VALUES (?)",
        [("Nómina",), ("Ventas",)],
    )
    conn.execute(
        "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        ("2026", "enero", "31-01-2026", "Enero", "Nómina", "1.500,00 €"),
    )
    conn.commit()
    return conn


# ── Resumen ──────────────────────────────────────────────────────────────────

def test_resumen_cuenta_usos_de_todos_los_anios(datos):
    from stores.categorias_store import leerResumen

    resumen = leerResumen()
    usos = {item["label"]: item["usos"] for item in resumen["gasto"]}

    # Café aparece en 2025 y en 2026: si solo se mirara el año cargado saldría 1.
    assert usos["Café"] == 2
    # Coche: una fila de movimientos y una mensualidad.
    assert usos["Coche"] == 2
    assert usos["Compras"] == 0
    assert {item["label"]: item["usos"] for item in resumen["ingreso"]}["Nómina"] == 1


def test_resumen_incluye_categorias_que_solo_estan_en_filas(datos):
    """Una etiqueta que nunca llegó al catálogo también hay que poder editarla."""
    from core.db import get_db
    from stores.categorias_store import leerResumen

    conn = get_db()
    conn.execute(
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        ("2026", "mayo", "02-05-2026", "Farmacia", "Salud", "12,00 €"),
    )
    conn.commit()

    etiquetas = [item["label"] for item in leerResumen()["gasto"]]
    assert "Salud" in etiquetas


# ── Renombrar ────────────────────────────────────────────────────────────────

def test_renombrar_alcanza_todos_los_anios(datos):
    from stores.categorias_store import renombrarCategoria

    filas = renombrarCategoria("gasto", "Café", "Cafetería")

    assert filas == 2
    restantes = datos.execute("SELECT COUNT(*) AS n FROM gastos_rows WHERE tipo = 'Café'").fetchone()["n"]
    assert restantes == 0
    nuevas = datos.execute("SELECT year FROM gastos_rows WHERE tipo = 'Cafetería' ORDER BY year").fetchall()
    assert [r["year"] for r in nuevas] == ["2025", "2026"]


def test_renombrar_actualiza_el_catalogo(datos):
    from stores.categorias_store import renombrarCategoria

    renombrarCategoria("gasto", "Café", "Cafetería")

    etiquetas = [r["label"] for r in datos.execute("SELECT label FROM gastos_tipos").fetchall()]
    assert "Cafetería" in etiquetas
    assert "Café" not in etiquetas


def test_renombrar_actualiza_los_recurrentes(datos):
    from stores.categorias_store import renombrarCategoria

    renombrarCategoria("gasto", "Coche", "Vehículo")

    categoria = datos.execute("SELECT categoria FROM mensualidades WHERE nombre = 'Seguro'").fetchone()["categoria"]
    assert categoria == "Vehículo"


def test_renombrar_una_categoria_sin_catalogo_la_da_de_alta(datos):
    from stores.categorias_store import leerResumen, renombrarCategoria

    datos.execute(
        "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
        ("2026", "mayo", "02-05-2026", "Farmacia", "Salud", "12,00 €"),
    )
    datos.commit()

    renombrarCategoria("gasto", "Salud", "Farmacia")

    etiquetas = [item["label"] for item in leerResumen()["gasto"]]
    assert "Farmacia" in etiquetas
    assert "Salud" not in etiquetas


def test_renombrar_a_un_nombre_existente_falla(datos):
    from stores.categorias_store import CategoriaInvalida, renombrarCategoria

    with pytest.raises(CategoriaInvalida):
        renombrarCategoria("gasto", "Café", "Coche")

    # Y no ha tocado nada por el camino.
    assert datos.execute("SELECT COUNT(*) AS n FROM gastos_rows WHERE tipo = 'Café'").fetchone()["n"] == 2


def test_renombrar_al_mismo_nombre_no_hace_nada(datos):
    from stores.categorias_store import renombrarCategoria

    assert renombrarCategoria("gasto", "Café", "Café") == 0


@pytest.mark.parametrize(("tipo", "de", "a"), [
    ("transferencia", "Café", "Bar"),
    ("gasto", "", "Bar"),
    ("gasto", "Café", "   "),
])
def test_renombrar_valida_la_entrada(datos, tipo, de, a):
    from stores.categorias_store import CategoriaInvalida, renombrarCategoria

    with pytest.raises(CategoriaInvalida):
        renombrarCategoria(tipo, de, a)


def test_renombrar_ingresos_es_independiente_de_gastos(datos):
    from stores.categorias_store import renombrarCategoria

    renombrarCategoria("ingreso", "Nómina", "Salario")

    assert datos.execute("SELECT COUNT(*) AS n FROM ingresos_rows WHERE tipo = 'Salario'").fetchone()["n"] == 1
    # El catálogo de gastos no se toca.
    assert datos.execute("SELECT COUNT(*) AS n FROM gastos_tipos WHERE label = 'Café'").fetchone()["n"] == 1


# ── Eliminar ─────────────────────────────────────────────────────────────────

def test_eliminar_categoria_sin_uso(datos):
    from stores.categorias_store import eliminarCategoria

    assert eliminarCategoria("gasto", "Compras") is True
    assert datos.execute("SELECT COUNT(*) AS n FROM gastos_tipos WHERE label = 'Compras'").fetchone()["n"] == 0


def test_eliminar_categoria_en_uso_en_otro_anio_falla(datos):
    """El caso que el frontend no podía detectar: uso en un año no cargado."""
    from stores.categorias_store import CategoriaEnUso, eliminarCategoria

    with pytest.raises(CategoriaEnUso) as excinfo:
        eliminarCategoria("gasto", "Café")

    assert excinfo.value.usos == 2
    assert datos.execute("SELECT COUNT(*) AS n FROM gastos_tipos WHERE label = 'Café'").fetchone()["n"] == 1


def test_eliminar_categoria_usada_solo_por_un_recurrente_falla(datos):
    from stores.categorias_store import CategoriaEnUso, eliminarCategoria

    datos.execute("DELETE FROM gastos_rows WHERE tipo = 'Coche'")
    datos.commit()

    with pytest.raises(CategoriaEnUso):
        eliminarCategoria("gasto", "Coche")


# ── Rutas HTTP ───────────────────────────────────────────────────────────────

@pytest.fixture
def categorias_app(datos):
    from flask import Flask

    from core.errors import register_error_handlers
    from routes.categorias import categorias_bp

    app = Flask(__name__)
    app.config["TESTING"] = True
    register_error_handlers(app)
    app.register_blueprint(categorias_bp)
    return app


def test_endpoint_resumen(categorias_app):
    client = categorias_app.test_client()
    datos = client.get("/api/categorias/resumen").get_json()

    assert datos["ok"] is True
    assert {item["label"] for item in datos["categorias"]["gasto"]} == {"Café", "Coche", "Compras"}


def test_endpoint_renombrar(categorias_app):
    client = categorias_app.test_client()
    respuesta = client.post("/api/categorias/renombrar", json={"tipo": "gasto", "de": "Café", "a": "Cafetería"})

    assert respuesta.status_code == 200
    assert respuesta.get_json()["filas"] == 2


def test_endpoint_renombrar_invalido_da_400(categorias_app):
    client = categorias_app.test_client()
    respuesta = client.post("/api/categorias/renombrar", json={"tipo": "gasto", "de": "Café", "a": "Coche"})

    assert respuesta.status_code == 400
    assert "Coche" in respuesta.get_json()["error"]


def test_endpoint_eliminar_en_uso_da_409(categorias_app):
    client = categorias_app.test_client()
    respuesta = client.post("/api/categorias/eliminar", json={"tipo": "gasto", "label": "Café"})

    assert respuesta.status_code == 409
    assert respuesta.get_json()["usos"] == 2


def test_endpoint_eliminar_sin_uso(categorias_app):
    client = categorias_app.test_client()
    respuesta = client.post("/api/categorias/eliminar", json={"tipo": "gasto", "label": "Compras"})

    assert respuesta.status_code == 200
