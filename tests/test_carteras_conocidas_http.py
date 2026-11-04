"""Pruebas de /api/wallets/catalogo con la capa de seguridad real (sesión y CSRF)."""

import pytest

_GENESIS = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.carteras_conocidas import carterasConocidasBp
    from routes.wallets import walletsBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(carterasConocidasBp, walletsBp)
    return client, cabeceras, datosAislados


def _guardar(client, cabeceras, **cambios):
    datos = {"nombre": "Mi ballena", "categoria": "persona",
             "direcciones": [{"red": "btc", "valor": "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"}], **cambios}
    return client.post("/api/wallets/catalogo/guardar", json=datos, headers=cabeceras)


def testBuscarDevuelveElCatalogoDeSerie(cliente):
    client, _, _ = cliente

    datos = client.get("/api/wallets/catalogo?q=satoshi").get_json()

    assert [c["id"] for c in datos["carteras"]] == ["satoshi"]
    satoshi = datos["carteras"][0]
    assert satoshi["origen"] == "serie"
    assert satoshi["fuentes"][0]["url"].startswith("https://")
    assert any(d["valor"] == _GENESIS and d["enlazada"] is False for d in satoshi["direcciones"])
    assert {c["clave"] for c in datos["categorias"]} >= {"exchange", "gobierno"}


def testSinFiltroDevuelveTodasHastaElLimite(cliente):
    client, _, _ = cliente

    assert len(client.get("/api/wallets/catalogo").get_json()["carteras"]) > 20
    assert len(client.get("/api/wallets/catalogo?limite=2").get_json()["carteras"]) == 2
    assert len(client.get("/api/wallets/catalogo?limite=nada").get_json()["carteras"]) > 20


def testMarcaLasDireccionesQueYaSeSiguen(cliente):
    client, cabeceras, _ = cliente
    enlace = client.post("/api/wallets", headers=cabeceras, json={
        "alias": "Génesis", "red": "btc", "tipo": "direccion", "valor": _GENESIS, "assetId": "", "propia": False})
    assert enlace.status_code == 200

    satoshi = client.get("/api/wallets/catalogo?q=satoshi").get_json()["carteras"][0]

    assert [d["valor"] for d in satoshi["direcciones"] if d["enlazada"]] == [_GENESIS]


def testGuardarEditarYQuitarUnaPropia(cliente):
    client, cabeceras, rutas = cliente

    respuesta = _guardar(client, cabeceras)
    cartera = respuesta.get_json()["cartera"]
    editada = _guardar(client, cabeceras, id=cartera["id"], nombre="Ballena azul")
    encontradas = client.get("/api/wallets/catalogo?q=azul").get_json()["carteras"]
    quitada = client.post("/api/wallets/catalogo/eliminar", json={"id": cartera["id"]}, headers=cabeceras)

    assert respuesta.status_code == 200 and cartera["origen"] == "propia"
    assert editada.status_code == 200
    assert [c["nombre"] for c in encontradas] == ["Ballena azul"]
    assert quitada.status_code == 200
    assert client.get("/api/wallets/catalogo?q=azul").get_json()["carteras"] == []
    assert b"bc1qw508" not in (rutas["claves"] / "carteras.key").read_bytes()


def testOcultarYRestaurarUnaDeSerie(cliente):
    client, cabeceras, _ = cliente

    oculta = client.post("/api/wallets/catalogo/eliminar", json={"id": "binance"}, headers=cabeceras)
    datos = client.get("/api/wallets/catalogo?q=binance").get_json()
    restaurada = client.post("/api/wallets/catalogo/restaurar", json={"id": "binance"}, headers=cabeceras)

    assert oculta.status_code == 200
    assert "binance" not in [c["id"] for c in datos["carteras"]]
    assert {"id": "binance", "nombre": "Binance"} in datos["ocultas"]
    assert restaurada.get_json()["cartera"]["origen"] == "serie"
    assert client.get("/api/wallets/catalogo?q=binance").get_json()["ocultas"] == []


@pytest.mark.parametrize("cambios, campo", [
    ({"nombre": ""}, "nombre"),
    ({"direcciones": [{"red": "btc", "valor": "bc1qnovalida"}]}, "direcciones.0"),
    ({"id": "x" * 41}, "id"),
])
def testGuardarValida(cliente, cambios, campo):
    client, cabeceras, _ = cliente

    respuesta = _guardar(client, cabeceras, **cambios)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == campo


@pytest.mark.parametrize("ruta, cuerpo, estado", [
    ("/api/wallets/catalogo/eliminar", {"id": "no-existe"}, 404),
    ("/api/wallets/catalogo/restaurar", {"id": "no-existe"}, 404),
    ("/api/wallets/catalogo/eliminar", {}, 400),
    ("/api/wallets/catalogo/guardar", {"id": "no-existe", "nombre": "X", "direcciones": [
        {"red": "btc", "valor": _GENESIS}]}, 404),
])
def testErrores(cliente, ruta, cuerpo, estado):
    client, cabeceras, _ = cliente

    assert client.post(ruta, json=cuerpo, headers=cabeceras).status_code == estado


def testSinSecretKeySeBuscaPeroNoSeGuarda(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    monkeypatch.setenv("SECRET_KEY", "corta")

    assert client.get("/api/wallets/catalogo?q=binance").status_code == 200
    respuesta = _guardar(client, cabeceras)
    assert respuesta.status_code == 409
    assert "SECRET_KEY" in respuesta.get_json()["error"]


def testSinCsrfNoSeGuarda(cliente):
    client, _, _ = cliente

    assert _guardar(client, {}).status_code == 403


def testSinSesionNoSeBusca(crearApp, datosAislados, tempDb):
    from routes.carteras_conocidas import carterasConocidasBp

    assert crearApp(carterasConocidasBp).test_client().get("/api/wallets/catalogo").status_code == 401
