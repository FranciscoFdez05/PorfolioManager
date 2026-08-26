"""Pruebas de /api/planes y /api/dca.

Lo que hay que asegurar aquí no es aritmética —el servidor no calcula nada de
un plan— sino que la normalización hace su trabajo: un estado inventado, un
contador de aportes que no es un número o una nota kilométrica no pueden llegar
a la base, porque el cliente los da por buenos al pintarlos.

Y lo que se añadió al bajar los planes a la ficha de cada activo: que un plan
sin activo, o con uno que ya no existe, se rechaza. Los planes se consultan
desde la ficha de su activo, así que uno huérfano se guardaría en un sitio del
que no se puede salir.
"""

import pytest


@pytest.fixture
def cliente(cliente_autenticado, temp_db, monkeypatch):
    from core.db import get_db
    from routes.planes import planes_bp

    conn = get_db()
    conn.execute("INSERT INTO activos (id, name) VALUES ('bitcoin', 'Bitcoin')")
    conn.execute("INSERT INTO activos (id, name) VALUES ('oro', 'Oro')")
    conn.commit()

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(planes_bp)
    return client, cabeceras


def _guardar(client, cabeceras, ruta, *filas):
    return client.post(ruta, json={"rows": list(filas)}, headers=cabeceras)


# ── Planes de inversión ──────────────────────────────────────────────────────

def test_sin_planes_la_lista_esta_vacia(cliente):
    client, _ = cliente
    assert client.get("/api/planes").get_json() == {"rows": []}


def test_un_plan_se_guarda_y_se_recupera_igual(cliente):
    client, cabeceras = cliente
    plan = {
        "id": "plan-btc", "assetId": "bitcoin", "nombre": "Bitcoin a 120k",
        "symbol": "btc", "ticker": "btc-usd", "marketProvider": "YAHOO",
        "currency": "usd", "precioEntrada": "60.000",
        "precioSalida": "120.000", "capital": "3.000",
        "horizonte": "Largo", "estado": "En curso", "fechaObjetivo": "31-12-2027",
        "notas": "Comprar en tramos",
    }
    assert _guardar(client, cabeceras, "/api/planes", plan).status_code == 200

    guardado = client.get("/api/planes").get_json()["rows"][0]
    assert guardado["id"] == "plan-btc"
    assert guardado["assetId"] == "bitcoin"
    assert guardado["precioEntrada"] == "60.000"
    assert guardado["estado"] == "En curso"
    # Símbolo y ticker en mayúsculas y proveedor en minúsculas: es lo que
    # esperaban las rutas de mercado, y así se quedan como el activo los tiene.
    assert (guardado["symbol"], guardado["ticker"]) == ("BTC", "BTC-USD")
    assert guardado["marketProvider"] == "yahoo"
    assert guardado["currency"] == "USD"


def test_un_plan_ya_no_guarda_direccion_ni_stop(cliente):
    """Un plan de inversión no es una operativa de trading."""
    client, cabeceras = cliente
    respuesta = _guardar(
        client, cabeceras, "/api/planes",
        {"id": "x", "assetId": "bitcoin", "direccion": "Corto", "stopLoss": "52.000"},
    )

    fila = respuesta.get_json()["rows"][0]
    assert "direccion" not in fila
    assert "stopLoss" not in fila


def test_guardar_reemplaza_la_lista_entera_y_conserva_el_orden(cliente):
    client, cabeceras = cliente
    _guardar(
        client, cabeceras, "/api/planes",
        {"id": "a", "assetId": "bitcoin", "nombre": "A"},
        {"id": "b", "assetId": "bitcoin", "nombre": "B"},
    )
    _guardar(
        client, cabeceras, "/api/planes",
        {"id": "b", "assetId": "bitcoin", "nombre": "B"},
        {"id": "c", "assetId": "oro", "nombre": "C"},
    )

    assert [f["id"] for f in client.get("/api/planes").get_json()["rows"]] == ["b", "c"]


def test_un_estado_inventado_cae_al_valor_por_defecto(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(
        client, cabeceras, "/api/planes",
        {"id": "x", "assetId": "bitcoin", "estado": "Regular", "horizonte": "Eterno"},
    )

    fila = respuesta.get_json()["rows"][0]
    assert (fila["estado"], fila["horizonte"]) == ("Pendiente", "Medio")


def test_un_plan_sin_activo_se_rechaza(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, "/api/planes", {"id": "x", "nombre": "Suelto"})

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_un_plan_con_un_activo_que_no_existe_se_rechaza(cliente):
    """Pasa al borrar un activo desde otra pestaña y guardar desde esta."""
    client, cabeceras = cliente
    respuesta = _guardar(
        client, cabeceras, "/api/planes", {"id": "x", "assetId": "fantasma", "nombre": "Plan"},
    )

    assert respuesta.status_code == 400
    assert "fantasma" in respuesta.get_json()["error"]


def test_borrar_el_activo_se_lleva_sus_planes(cliente):
    from core.db import get_db

    client, cabeceras = cliente
    _guardar(client, cabeceras, "/api/planes", {"id": "x", "assetId": "oro", "nombre": "Oro"})
    _guardar(client, cabeceras, "/api/dca", {"id": "y", "assetId": "oro", "importe": "100"})

    conn = get_db()
    conn.execute("DELETE FROM activos WHERE id = 'oro'")
    conn.commit()

    assert client.get("/api/planes").get_json()["rows"] == []
    assert client.get("/api/dca").get_json()["rows"] == []


def test_un_plan_sin_id_recibe_uno(cliente):
    client, cabeceras = cliente
    fila = _guardar(
        client, cabeceras, "/api/planes", {"assetId": "bitcoin", "nombre": "Sin id"},
    ).get_json()["rows"][0]
    assert fila["id"] == "plan-1"


def test_una_nota_kilometrica_se_rechaza(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(
        client, cabeceras, "/api/planes", {"id": "x", "assetId": "bitcoin", "notas": "n" * 501},
    )

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_rows_tiene_que_ser_una_lista(cliente):
    client, cabeceras = cliente
    assert client.post("/api/planes", json={"rows": "no"}, headers=cabeceras).status_code == 400


# ── DCA ──────────────────────────────────────────────────────────────────────

def test_un_plan_dca_se_guarda_y_se_recupera_igual(cliente):
    client, cabeceras = cliente
    dca = {
        "id": "dca-msci", "assetId": "bitcoin", "nombre": "World mensual",
        "importe": "300", "frecuencia": "Mensual", "fechaInicio": "01-01-2026",
        "aportesObjetivo": "24", "estado": "Activo",
    }
    assert _guardar(client, cabeceras, "/api/dca", dca).status_code == 200

    guardado = client.get("/api/dca").get_json()["rows"][0]
    assert guardado["frecuencia"] == "Mensual"
    assert guardado["aportesObjetivo"] == "24"
    assert guardado["assetId"] == "bitcoin"


def test_el_numero_de_aportes_no_numerico_se_rechaza(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(
        client, cabeceras, "/api/dca", {"id": "x", "assetId": "bitcoin", "aportesObjetivo": "muchos"},
    )

    assert respuesta.status_code == 400


def test_el_numero_de_aportes_vacio_se_admite(cliente):
    """Un DCA indefinido —aportar hasta nuevo aviso— es un caso legítimo."""
    client, cabeceras = cliente
    fila = _guardar(
        client, cabeceras, "/api/dca", {"id": "x", "assetId": "bitcoin", "aportesObjetivo": ""},
    ).get_json()["rows"][0]

    assert fila["aportesObjetivo"] == ""


def test_una_frecuencia_inventada_cae_a_mensual(cliente):
    client, cabeceras = cliente
    fila = _guardar(
        client, cabeceras, "/api/dca",
        {"id": "x", "assetId": "bitcoin", "frecuencia": "Cada luna llena"},
    ).get_json()["rows"][0]

    assert fila["frecuencia"] == "Mensual"


def test_un_plan_dca_sin_activo_se_rechaza(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, "/api/dca", {"id": "x", "importe": "100"})

    assert respuesta.status_code == 400


def test_los_dos_recursos_no_se_pisan(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, "/api/planes", {"id": "plan-1", "assetId": "bitcoin", "nombre": "Plan"})
    _guardar(client, cabeceras, "/api/dca", {"id": "dca-1", "assetId": "bitcoin", "nombre": "DCA"})

    assert len(client.get("/api/planes").get_json()["rows"]) == 1
    assert len(client.get("/api/dca").get_json()["rows"]) == 1
