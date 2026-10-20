"""Control de revisión en ventas y en la ficha de activo, y lecturas que no escriben.

Mismo patrón que gastos e ingresos (ver stores/revisiones.py): la lectura trae
la revisión, el guardado la reenvía y, si no coincide, responde 409 con la
revisión actual en vez de borrar lo que entró desde otro sitio.
"""

import pytest


@pytest.fixture
def cliente(clienteAutenticado, tempDb, datosAislados, monkeypatch):
    from routes.activos import activosBp
    from routes.gastos import gastosBp
    from routes.ingresos import ingresosBp
    from routes.ventas import ventasBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(activosBp, ventasBp, gastosBp, ingresosBp)
    return client, cabeceras


def _crearActivo(client, cabeceras, nombre="Apple"):
    return client.post("/api/activos", json={"name": nombre, "type": "acciones", "marketSymbol": "AAPL"},
                       headers=cabeceras)


def _revisionLote(client, activoId="apple"):
    return client.get(f"/api/activos-lote?ids={activoId}").get_json()["revisiones"][activoId]


# ── Activos ───────────────────────────────────────────────────────────────────

def testElLoteTraeLaRevisionAparteYLaFichaSigueIgual(cliente):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)

    datos = client.get("/api/activos-lote?ids=apple").get_json()

    assert datos["revisiones"]["apple"] >= 1
    assert "revision" not in datos["assets"]["apple"]
    assert datos["assets"]["apple"] == client.get("/api/activos/apple").get_json()


def testGuardarConLaRevisionVigenteAvanzaLaRevision(cliente):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)
    ficha = client.get("/api/activos/apple").get_json()
    ficha["revision"] = _revisionLote(client)

    respuesta = client.post("/api/activos/apple", json=ficha, headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["revision"] == ficha["revision"] + 1
    assert _revisionLote(client) == ficha["revision"] + 1


def testGuardarConUnaRevisionAntiguaEs409YNoBorraLasFilas(cliente):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)
    ficha = client.get("/api/activos/apple").get_json()
    revisionVieja = _revisionLote(client)

    # Otra pestaña guarda una compra.
    otra = dict(ficha, rows=[{"fechaOperacion": "10-01-2026", "participaciones": "5"}], revision=revisionVieja)
    assert client.post("/api/activos/apple", json=otra, headers=cabeceras).status_code == 200

    # Esta pestaña, con la copia vieja y sin filas, intenta guardar.
    vieja = dict(ficha, rows=[], revision=revisionVieja, color="#123456")
    respuesta = client.post("/api/activos/apple", json=vieja, headers=cabeceras)

    assert respuesta.status_code == 409
    cuerpo = respuesta.get_json()
    assert cuerpo["conflicto"] is True
    assert cuerpo["revision"] == _revisionLote(client)
    assert len(client.get("/api/activos/apple").get_json()["rows"]) == 1


def testSinRevisionElGuardadoSigueComoSiempre(cliente):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)
    ficha = client.get("/api/activos/apple").get_json()

    assert client.post("/api/activos/apple", json=ficha, headers=cabeceras).status_code == 200
    assert client.post("/api/activos/apple", json=ficha, headers=cabeceras).status_code == 200


def testUnaRevisionQueNoEsEnteroEs400(cliente):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)
    ficha = client.get("/api/activos/apple").get_json()

    respuesta = client.post("/api/activos/apple", json=dict(ficha, revision="x"), headers=cabeceras)

    assert respuesta.status_code == 400


def testBorrarUnActivoAvanzaSuRevision(cliente):
    client, cabeceras = cliente
    _crearActivo(client, cabeceras)
    antes = _revisionLote(client)
    ficha = client.get("/api/activos/apple").get_json()

    client.delete("/api/activos/apple", headers=cabeceras)
    respuesta = client.post("/api/activos/apple", json=dict(ficha, revision=antes), headers=cabeceras)

    assert respuesta.status_code == 409


def testCambiarLaDivisaConLaFichaCambiadaEntretantoEs409(cliente, monkeypatch):
    import routes.activos as rutas
    from stores.asset_store import readAssetFile, writeAssetFile

    client, cabeceras = cliente
    _crearActivo(client, cabeceras)

    def convertirYMientrasTantoOtroGuarda(importe, origen, destino):
        ficha = readAssetFile("apple")
        ficha["rows"] = [{"fechaOperacion": "10-01-2026", "participaciones": "5"}]
        writeAssetFile("apple", ficha)
        return importe, None

    monkeypatch.setattr(rutas, "convertAmount", convertirYMientrasTantoOtroGuarda)

    respuesta = client.post("/api/activos/apple/currency", json={"currency": "USD"}, headers=cabeceras)

    assert respuesta.status_code == 409
    ficha = client.get("/api/activos/apple").get_json()
    assert ficha["currency"] != "USD"
    assert len(ficha["rows"]) == 1


# ── Refresco de cotización (B-10) ─────────────────────────────────────────────

def _cotizacion(symbol="AAPL", price="200,00", currency="EUR"):
    return {
        "symbol": symbol, "price": price, "currency": currency, "change": "+1,00%",
        "status": "Cotización actualizada", "lastUpdated": "2026-01-01T00:00:00", "marketData": {},
    }


def testRefrescarNoPisaLoQueSeEditoMientrasSeConsultaElProveedor(cliente, monkeypatch):
    import routes.activos as rutas
    from stores.asset_store import readAssetFile, writeAssetFile

    client, cabeceras = cliente
    _crearActivo(client, cabeceras)

    def proveedorLento(symbol, provider, useCache=True, targetCurrency="EUR"):
        ficha = readAssetFile("apple")
        ficha["color"] = "#abcdef"
        ficha["rows"] = [{"fechaOperacion": "10-01-2026", "participaciones": "5"}]
        writeAssetFile("apple", ficha)
        return _cotizacion(), None

    monkeypatch.setattr(rutas, "fetchAssetQuote", proveedorLento)

    respuesta = client.post("/api/activos/apple/refresh-market-data", headers=cabeceras)

    assert respuesta.status_code == 200
    ficha = client.get("/api/activos/apple").get_json()
    assert ficha["price"] == "200,00"
    assert ficha["color"] == "#abcdef"
    assert len(ficha["rows"]) == 1


def testRefrescarConLaDivisaCambiadaEntretantoNoGuardaElPrecio(cliente, monkeypatch):
    import routes.activos as rutas
    from stores.asset_store import readAssetFile, writeAssetFile

    client, cabeceras = cliente
    _crearActivo(client, cabeceras)
    precioAntes = client.get("/api/activos/apple").get_json()["price"]

    def proveedorLento(symbol, provider, useCache=True, targetCurrency="EUR"):
        ficha = readAssetFile("apple")
        ficha["currency"] = "USD"
        writeAssetFile("apple", ficha)
        return _cotizacion(), None

    monkeypatch.setattr(rutas, "fetchAssetQuote", proveedorLento)

    respuesta = client.post("/api/activos/apple/refresh-market-data", headers=cabeceras)

    assert respuesta.status_code == 409
    ficha = client.get("/api/activos/apple").get_json()
    assert ficha["currency"] == "USD"
    assert ficha["price"] == precioAntes


# ── Ventas ────────────────────────────────────────────────────────────────────

def _venta(id_="v1", cantidad="1"):
    return {"id": id_, "fecha": "10-02-2026", "assetId": "apple", "cantidad": cantidad, "valorVenta": "10"}


def _prepararVentas(client, cabeceras):
    _crearActivo(client, cabeceras)
    ficha = client.get("/api/activos/apple").get_json()
    ficha["rows"] = [{"fechaOperacion": "10-01-2026", "tipoOperacion": "Compra",
                      "participaciones": "10", "precioParticipacion": "5"}]
    client.post("/api/activos/apple", json=ficha, headers=cabeceras)


def testVentasDevuelveLaRevisionYElGuardadoLaAvanza(cliente):
    client, cabeceras = cliente
    _prepararVentas(client, cabeceras)

    primera = client.post("/api/ventas/2026", json={"rows": [_venta()]}, headers=cabeceras).get_json()
    leida = client.get("/api/ventas/2026").get_json()
    segunda = client.post(
        "/api/ventas/2026", json={"rows": [_venta()], "revision": leida["revision"]}, headers=cabeceras
    ).get_json()

    assert leida["revision"] == primera["revision"]
    assert segunda["revision"] == leida["revision"] + 1


def testVentasConUnaRevisionAntiguaEs409YConservaLoGuardado(cliente):
    client, cabeceras = cliente
    _prepararVentas(client, cabeceras)
    client.post("/api/ventas/2026", json={"rows": [_venta("v1")]}, headers=cabeceras)
    vieja = client.get("/api/ventas/2026").get_json()["revision"]
    client.post("/api/ventas/2026", json={"rows": [_venta("v1"), _venta("v2")], "revision": vieja},
                headers=cabeceras)

    respuesta = client.post("/api/ventas/2026", json={"rows": [_venta("v1")], "revision": vieja},
                            headers=cabeceras)

    assert respuesta.status_code == 409
    assert respuesta.get_json()["conflicto"] is True
    assert len(client.get("/api/ventas/2026").get_json()["rows"]) == 2


def testBorrarUnEjercicioDeVentasInvalidaLasRevisionesAntiguas(cliente):
    client, cabeceras = cliente
    _prepararVentas(client, cabeceras)
    client.post("/api/ventas/2026", json={"rows": [_venta()]}, headers=cabeceras)
    vieja = client.get("/api/ventas/2026").get_json()["revision"]
    client.delete("/api/ventas/2026", headers=cabeceras)

    respuesta = client.post("/api/ventas/2026", json={"rows": [_venta()], "revision": vieja},
                            headers=cabeceras)

    assert respuesta.status_code == 409


# ── Las lecturas no escriben ──────────────────────────────────────────────────

@pytest.mark.parametrize("ruta", ["/api/gastos", "/api/ingresos", "/api/ventas"])
def testLeerLosAniosDeUnaCarteraVaciaNoEscribeNada(cliente, ruta):
    from datetime import date

    from core.db import getDb

    client, _cabeceras = cliente
    antes = getDb().total_changes

    datos = client.get(ruta).get_json()

    assert getDb().total_changes == antes
    assert datos["years"] == [str(date.today().year)]


@pytest.mark.parametrize("ruta", ["gastos", "ventas"])
def testElAnioActualDeUnaCarteraVaciaSeLeeVacioSinCrearlo(cliente, ruta):
    from datetime import date

    from core.db import getDb

    client, _cabeceras = cliente
    anio = str(date.today().year)
    antes = getDb().total_changes

    respuesta = client.get(f"/api/{ruta}/{anio}")

    assert respuesta.status_code == 200
    assert respuesta.get_json()["revision"] == 0
    assert getDb().total_changes == antes


def testElAnioVirtualSeCreaAlGuardarLaPrimeraVez(cliente):
    from datetime import date

    client, cabeceras = cliente
    anio = str(date.today().year)
    datos = client.get(f"/api/gastos/{anio}").get_json()
    datos["months"]["enero"]["rows"].append(
        {"fecha": f"01-01-{anio}", "nombre": "x", "tipo": "Ocio", "cantidad": "5,00 €"}
    )

    respuesta = client.post(f"/api/gastos/{anio}", json=datos, headers=cabeceras)

    assert respuesta.status_code == 200
    assert client.get("/api/gastos").get_json()["years"] == [anio]
    assert client.get(f"/api/gastos/{anio}").get_json()["revision"] == 1


def testUnAnioQueNoExisteSigueSiendo404(cliente):
    client, _cabeceras = cliente

    assert client.get("/api/gastos/1999").status_code == 404
    assert client.get("/api/ventas/1999").status_code == 404
