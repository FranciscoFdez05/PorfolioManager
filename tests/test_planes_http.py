"""Pruebas de /api/planes y /api/dca.

Lo que hay que asegurar aquí no es aritmética —el servidor no calcula nada de
un plan— sino que la normalización hace su trabajo: un estado inventado, un
contador de aportes que no es un número o una nota kilométrica no pueden llegar
a la base, porque el cliente los da por buenos al pintarlos.
"""

import pytest


@pytest.fixture
def cliente(cliente_autenticado, temp_db, monkeypatch):
    from routes.planes import planes_bp

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
        "direccion": "Largo", "currency": "usd", "precioEntrada": "60.000",
        "precioSalida": "120.000", "stopLoss": "52.000", "capital": "3.000",
        "horizonte": "Largo", "estado": "En curso", "fechaObjetivo": "31-12-2027",
        "notas": "Comprar en tramos",
    }
    assert _guardar(client, cabeceras, "/api/planes", plan).status_code == 200

    guardado = client.get("/api/planes").get_json()["rows"][0]
    assert guardado["id"] == "plan-btc"
    assert guardado["precioEntrada"] == "60.000"
    assert guardado["estado"] == "En curso"
    # Símbolo y ticker en mayúsculas y proveedor en minúsculas: es lo que
    # esperan las rutas de mercado que luego piden la cotización.
    assert (guardado["symbol"], guardado["ticker"]) == ("BTC", "BTC-USD")
    assert guardado["marketProvider"] == "yahoo"
    assert guardado["currency"] == "USD"


def test_guardar_reemplaza_la_lista_entera_y_conserva_el_orden(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, "/api/planes", {"id": "a", "nombre": "A"}, {"id": "b", "nombre": "B"})
    _guardar(client, cabeceras, "/api/planes", {"id": "b", "nombre": "B"}, {"id": "c", "nombre": "C"})

    assert [f["id"] for f in client.get("/api/planes").get_json()["rows"]] == ["b", "c"]


def test_un_estado_inventado_cae_al_valor_por_defecto(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, "/api/planes", {"id": "x", "estado": "Regular", "direccion": "Lateral"})

    fila = respuesta.get_json()["rows"][0]
    assert (fila["estado"], fila["direccion"]) == ("Pendiente", "Largo")


def test_un_plan_sin_id_recibe_uno(cliente):
    client, cabeceras = cliente
    fila = _guardar(client, cabeceras, "/api/planes", {"nombre": "Sin id"}).get_json()["rows"][0]
    assert fila["id"] == "plan-1"


def test_una_nota_kilometrica_se_rechaza(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, "/api/planes", {"id": "x", "notas": "n" * 501})

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_rows_tiene_que_ser_una_lista(cliente):
    client, cabeceras = cliente
    assert client.post("/api/planes", json={"rows": "no"}, headers=cabeceras).status_code == 400


# ── DCA ──────────────────────────────────────────────────────────────────────

def test_un_plan_dca_se_guarda_y_se_recupera_igual(cliente):
    client, cabeceras = cliente
    dca = {
        "id": "dca-msci", "nombre": "World mensual", "importe": "300",
        "frecuencia": "Mensual", "fechaInicio": "01-01-2026",
        "aportesObjetivo": "24", "estado": "Activo",
    }
    assert _guardar(client, cabeceras, "/api/dca", dca).status_code == 200

    guardado = client.get("/api/dca").get_json()["rows"][0]
    assert guardado["frecuencia"] == "Mensual"
    assert guardado["aportesObjetivo"] == "24"


def test_el_numero_de_aportes_no_numerico_se_rechaza(cliente):
    client, cabeceras = cliente
    respuesta = _guardar(client, cabeceras, "/api/dca", {"id": "x", "aportesObjetivo": "muchos"})

    assert respuesta.status_code == 400


def test_el_numero_de_aportes_vacio_se_admite(cliente):
    """Un DCA indefinido —aportar hasta nuevo aviso— es un caso legítimo."""
    client, cabeceras = cliente
    fila = _guardar(client, cabeceras, "/api/dca", {"id": "x", "aportesObjetivo": ""}).get_json()["rows"][0]

    assert fila["aportesObjetivo"] == ""


def test_una_frecuencia_inventada_cae_a_mensual(cliente):
    client, cabeceras = cliente
    fila = _guardar(client, cabeceras, "/api/dca", {"id": "x", "frecuencia": "Cada luna llena"}).get_json()["rows"][0]

    assert fila["frecuencia"] == "Mensual"


def test_los_dos_recursos_no_se_pisan(cliente):
    client, cabeceras = cliente
    _guardar(client, cabeceras, "/api/planes", {"id": "plan-1", "nombre": "Plan"})
    _guardar(client, cabeceras, "/api/dca", {"id": "dca-1", "nombre": "DCA"})

    assert len(client.get("/api/planes").get_json()["rows"]) == 1
    assert len(client.get("/api/dca").get_json()["rows"]) == 1
