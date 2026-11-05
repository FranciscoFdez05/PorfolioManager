"""Pruebas de /api/wallets/validar-propias: comprueba sin guardar y sin devolver valores.

Es lo que evita que una dirección mal pegada en Nuevo activo deje un activo creado
sin su wallet, así que tiene que rechazar lo mismo que rechazaría el alta.
"""

import pytest

_DIRECCION = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa"
_ZPUB = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs"
_CLAVE_PUBLICA = "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"
_ETIQUETA = "Bitcoin"


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.wallets import walletsBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(walletsBp)
    return client, cabeceras, datosAislados


def _validar(client, cabeceras, filas, seguimiento=_ETIQUETA):
    return client.post("/api/wallets/validar-propias", json={"seguimiento": seguimiento, "filas": filas},
                       headers=cabeceras)


def _fila(valor, red="btc", tipo="auto"):
    return {"red": red, "tipo": tipo, "valor": valor}


@pytest.mark.parametrize("valor", [_DIRECCION, _ZPUB, _CLAVE_PUBLICA])
def testAceptaDireccionXpubYClavePublica(cliente, valor):
    client, cabeceras, _ = cliente

    respuesta = _validar(client, cabeceras, [_fila(valor)])

    assert respuesta.status_code == 200
    assert respuesta.get_json()["errores"] == []


def testNoGuardaNada(cliente):
    client, cabeceras, rutas = cliente

    _validar(client, cabeceras, [_fila(_DIRECCION)])

    assert not (rutas["claves"] / "wallets.key").exists()
    assert client.get("/api/wallets").get_json()["wallets"] == []


def testSeñalaSoloLasLineasQueFallanSinDevolverSuValor(cliente):
    client, cabeceras, _ = cliente
    malo = "bc1qnovalida"

    respuesta = _validar(client, cabeceras, [_fila(_DIRECCION), _fila(malo)])

    errores = respuesta.get_json()["errores"]
    assert [e["indice"] for e in errores] == [1]
    assert malo not in respuesta.get_data(as_text=True)


def testRechazaUnaFraseSemilla(cliente):
    client, cabeceras, _ = cliente

    respuesta = _validar(client, cabeceras, [_fila(" ".join(["abandon"] * 11 + ["about"]))])

    assert [e["indice"] for e in respuesta.get_json()["errores"]] == [0]


def testDetectaLasRepetidasEnLaLista(cliente):
    client, cabeceras, _ = cliente

    respuesta = _validar(client, cabeceras, [_fila(_DIRECCION), _fila(f"  {_DIRECCION} ")])

    assert [(e["indice"], e["error"]) for e in respuesta.get_json()["errores"]] == [
        (1, "Esa wallet está repetida en la lista")
    ]


def testDetectaLasYaEnlazadas(cliente):
    client, cabeceras, _ = cliente
    client.post("/api/wallets", json={"alias": "Satoshi", "red": "btc", "valor": _DIRECCION, "propia": False},
                headers=cabeceras)

    respuesta = _validar(client, cabeceras, [_fila(_DIRECCION)])

    assert respuesta.get_json()["errores"][0]["error"] == "Esa wallet ya está enlazada"


def testNoDejaMezclarlaConUnSeguimientoDeAjenas(cliente):
    client, cabeceras, _ = cliente
    client.post("/api/wallets", json={"alias": "Ballena", "red": "btc", "valor": _DIRECCION, "propia": False,
                                      "seguimiento": _ETIQUETA}, headers=cabeceras)

    respuesta = _validar(client, cabeceras, [_fila(_CLAVE_PUBLICA)])

    assert "ajenas" in respuesta.get_json()["errores"][0]["error"]


def testUnaRedDesconocidaEsUnErrorDeLinea(cliente):
    client, cabeceras, _ = cliente

    respuesta = _validar(client, cabeceras, [_fila(_DIRECCION, red="doge")])

    assert respuesta.get_json()["errores"][0]["indice"] == 0


def testElAltaConUnaRedDesconocidaEsUn400AunqueElValorSirvaEnOtra(cliente):
    """Antes daba un 500: el mensaje de «vale para otra red» buscaba el nombre de la pedida."""
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets", json={"alias": "X", "red": "doge", "valor": _DIRECCION, "propia": False},
                            headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == "valor"


def testSinSecretKeyDeCalidadNoValida(cliente, monkeypatch):
    client, cabeceras, _ = cliente
    monkeypatch.setenv("SECRET_KEY", "corta")

    respuesta = _validar(client, cabeceras, [_fila(_DIRECCION)])

    assert respuesta.status_code == 409
    assert "SECRET_KEY" in respuesta.get_json()["error"]


@pytest.mark.parametrize("cuerpo, campo", [
    ({"filas": []}, "seguimiento"),
    ({"seguimiento": _ETIQUETA, "filas": "x"}, "filas"),
    ({"seguimiento": _ETIQUETA, "filas": [{}] * 101}, "filas"),
])
def testValidaLaPeticion(cliente, cuerpo, campo):
    client, cabeceras, _ = cliente

    respuesta = client.post("/api/wallets/validar-propias", json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["field"] == campo


def testSinCsrfNoEntra(cliente):
    client, _cabeceras, _ = cliente

    assert _validar(client, {}, [_fila(_DIRECCION)]).status_code == 403
