"""Pruebas de /api/planes-cartera.

El servidor no calcula nada de un plan: lo que hay que asegurar es la forma con
la que se guarda y se devuelve —plan → activos → operaciones, en el orden que
llegó— y los descartes que evitan basura en la base: un activo que ya no
existe se rechaza con un 400 (no con un error del motor), una operación
borrada se deja de guardar, y un activo o una operación repetidos dentro del
mismo plan se quedan con la primera aparición.
"""

import pytest


@pytest.fixture
def cliente(cliente_autenticado, temp_db, monkeypatch):
    from core.db import get_db
    from routes.planes_cartera import planes_cartera_bp

    conn = get_db()
    conn.execute("INSERT INTO activos (id, name) VALUES ('bitcoin', 'Bitcoin')")
    conn.execute("INSERT INTO activos (id, name) VALUES ('sp500', 'S&P 500')")
    conn.executemany(
        "INSERT INTO operaciones (id, asset_id, activo, orden, precio_orden, cantidad, total, estado) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            ("op-btc-1", "bitcoin", "Bitcoin", "Compra", "50000", "0,004", "200", "Activo"),
            ("op-btc-2", "bitcoin", "Bitcoin", "Compra", "60000", "0,005", "300", "Completado"),
            ("op-sp-1", "sp500", "S&P 500", "Compra", "5000", "0,4", "2000", "Activo"),
        ],
    )
    conn.commit()

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(planes_cartera_bp)
    return client, cabeceras


def _guardar(client, cabeceras, *planes):
    return client.post("/api/planes-cartera", json={"rows": list(planes)}, headers=cabeceras)


def _plan(**cambios):
    plan = {
        "id": "plan-1",
        "nombre": "Acumular en 2026",
        "archivado": False,
        "activos": [
            {"assetId": "bitcoin", "operaciones": ["op-btc-1", "op-btc-2"]},
            {"assetId": "sp500", "operaciones": ["op-sp-1"]},
        ],
    }
    plan.update(cambios)
    return plan


def test_sin_planes_la_lista_esta_vacia(cliente):
    client, _ = cliente
    assert client.get("/api/planes-cartera").get_json() == {"rows": []}


def test_un_plan_se_guarda_y_se_recupera_con_sus_activos_y_operaciones(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, _plan())
    assert respuesta.status_code == 200

    guardado = client.get("/api/planes-cartera").get_json()["rows"]
    assert guardado == [_plan()]


def test_el_orden_de_activos_y_operaciones_es_el_que_llego(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _plan(activos=[
        {"assetId": "sp500", "operaciones": ["op-sp-1"]},
        {"assetId": "bitcoin", "operaciones": ["op-btc-2", "op-btc-1"]},
    ]))

    activos = client.get("/api/planes-cartera").get_json()["rows"][0]["activos"]
    assert [a["assetId"] for a in activos] == ["sp500", "bitcoin"]
    assert activos[1]["operaciones"] == ["op-btc-2", "op-btc-1"]


def test_guardar_reemplaza_la_lista_entera(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _plan(id="plan-1"), _plan(id="plan-2", nombre="Otro"))
    _guardar(client, cabeceras, _plan(id="plan-2", nombre="Otro"))

    ids = [p["id"] for p in client.get("/api/planes-cartera").get_json()["rows"]]
    assert ids == ["plan-2"]


def test_archivado_se_conserva_como_booleano(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _plan(archivado="1"))
    assert client.get("/api/planes-cartera").get_json()["rows"][0]["archivado"] is True


def test_un_activo_que_no_existe_es_un_400(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, _plan(activos=[{"assetId": "oro", "operaciones": []}]))

    assert respuesta.status_code == 400
    assert "oro" in respuesta.get_json()["error"]
    # Y la lista anterior no se ha vaciado por el intento fallido.
    assert client.get("/api/planes-cartera").get_json() == {"rows": []}


def test_una_operacion_que_ya_no_existe_se_descarta_al_guardar(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _plan(activos=[
        {"assetId": "bitcoin", "operaciones": ["op-btc-1", "op-borrada", "op-btc-2"]},
    ]))

    activos = client.get("/api/planes-cartera").get_json()["rows"][0]["activos"]
    assert activos[0]["operaciones"] == ["op-btc-1", "op-btc-2"]


def test_activos_y_operaciones_repetidos_se_quedan_con_la_primera_aparicion(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _plan(activos=[
        {"assetId": "bitcoin", "operaciones": ["op-btc-1", "op-btc-1"]},
        {"assetId": "bitcoin", "operaciones": ["op-btc-2"]},
    ]))

    activos = client.get("/api/planes-cartera").get_json()["rows"][0]["activos"]
    assert activos == [{"assetId": "bitcoin", "operaciones": ["op-btc-1"]}]


def test_un_activo_sin_identificador_es_un_400(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, _plan(activos=[{"operaciones": []}]))
    assert respuesta.status_code == 400


def test_activos_debe_ser_una_lista(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, _plan(activos={"assetId": "bitcoin"}))
    assert respuesta.status_code == 400


def test_sin_nombre_el_plan_recibe_uno(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _plan(nombre="   "))
    assert client.get("/api/planes-cartera").get_json()["rows"][0]["nombre"] == "Plan 1"


def test_borrar_el_activo_se_lleva_su_linea_del_plan(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, _plan())

    from core.db import get_db
    conn = get_db()
    conn.execute("DELETE FROM activos WHERE id = 'sp500'")
    conn.commit()

    plan = client.get("/api/planes-cartera").get_json()["rows"][0]
    assert [a["assetId"] for a in plan["activos"]] == ["bitcoin"]
    # El plan sigue existiendo: perder un activo no borra la intención.
    assert plan["nombre"] == "Acumular en 2026"


def test_una_base_en_la_version_6_recibe_las_tablas(temp_db, tmp_path):
    """La migración 7 crea las tres tablas en una base que venga de la 6.

    `temp_db` no se usa en el cuerpo: está para que la base activa que se
    restaura al final sea la temporal del test y no la real del repositorio.
    """
    import sqlite3

    from core import db

    ruta = tmp_path / "vieja.db"
    with sqlite3.connect(ruta) as conn:
        conn.execute("CREATE TABLE activos (id TEXT PRIMARY KEY, name TEXT)")
        conn.execute("PRAGMA user_version = 6")

    original = db.get_active_db_path()
    try:
        db.set_active_db_path(ruta)
        db.init_db()
        conn = db.get_db()
        tablas = {fila[0] for fila in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"planes_cartera", "planes_cartera_activos", "planes_cartera_operaciones"} <= tablas
        assert conn.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    finally:
        db.set_active_db_path(original)
