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
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.activos import activosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(activosBp)
    return client, cabeceras


def _crear(client, cabeceras, nombre, tipo="acciones", **extra):
    return client.post("/api/activos", json={"name": nombre, "type": tipo, **extra},
                       headers=cabeceras)


# ── Crear ────────────────────────────────────────────────────────────────────

def testCrearActivoDevuelve201YElPayload(cliente):
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "Apple", "acciones", marketSymbol="aapl")

    assert respuesta.status_code == 201
    activo = respuesta.get_json()["asset"]
    assert activo["name"] == "Apple"
    assert activo["id"] == "apple"
    # El símbolo se normaliza a mayúsculas: los proveedores no aceptan otra cosa.
    assert activo["marketSymbol"] == "AAPL"


def testElNombreEsObligatorio(cliente):
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "   ")

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testUnTipoDeActivoInvalidoSeRechaza(cliente):
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "Algo", tipo="inventado")

    assert respuesta.status_code == 400


def testNoSePuedeCrearDosVecesElMismoActivo(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")
    respuesta = _crear(client, cabeceras, "Apple")

    assert respuesta.status_code == 409


def testDosNombresQueProducenElMismoIdColisionan(cliente):
    """El id sale de slugify(nombre): "Apple Inc." y "apple-inc" son el mismo.

    Se prueba porque es sorprendente y determina el 409: si algún día slugify
    cambia, este test dirá qué nombres dejan de colisionar.
    """
    client, cabeceras = cliente
    primero = _crear(client, cabeceras, "Apple Inc.")
    segundo = _crear(client, cabeceras, "apple inc")

    assert primero.status_code == 201
    assert segundo.status_code == 409


def testLosActivosSeCreanAlFinalDelOrden(cliente):
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos", "Tres"):
        _crear(client, cabeceras, nombre)

    ordenes = [a["order"] for a in client.get("/api/activos").get_json()["assets"]]
    assert ordenes == sorted(ordenes)


def testUnColorManipuladoNoLlegaAlHtml(cliente):
    """El color se inyecta en un atributo style del frontend."""
    client, cabeceras = cliente
    respuesta = _crear(client, cabeceras, "Apple", color="red; background: url(javascript:alert(1))")

    assert "javascript" not in respuesta.get_json()["asset"]["color"]


# ── Leer ─────────────────────────────────────────────────────────────────────

def testListarSinActivosDevuelveUnaListaVacia(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/activos").get_json()["assets"] == []


def testLeerUnActivoInexistenteEs404(cliente):
    client, _cabeceras = cliente
    assert client.get("/api/activos/no-existe").status_code == 404


def testLeerUnActivoDevuelveSuFicha(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple", marketSymbol="AAPL")

    datos = client.get("/api/activos/apple").get_json()

    assert datos["name"] == "Apple"
    assert datos["marketSymbol"] == "AAPL"
    assert isinstance(datos["rows"], list)


# ── Guardar ──────────────────────────────────────────────────────────────────

def testGuardarUnaFichaPersisteLasFilas(cliente):
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


def testGuardarSinOperationRowsNoBorraLasQueYaHabia(cliente):
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

    sinOperaciones = {k: v for k, v in ficha.items() if k != "operationRows"}
    client.post("/api/activos/bitcoin", json=sinOperaciones, headers=cabeceras)

    assert len(client.get("/api/activos/bitcoin").get_json()["operationRows"]) == 1


def testEditarLaCabeceraSinMandarLasFilasNoBorraElHistorico(cliente):
    """Renombrar o cambiar el color no puede llevarse las compras por delante.

    Guardar reescribe el activo entero, así que un cuerpo sin `rows` las
    borraba: cambiar el color de un activo desde la vista de Activos vaciaba su
    histórico de compras sin decir nada, y respondía 200.
    """
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")
    ficha = client.get("/api/activos/apple").get_json()
    ficha["rows"] = [{"fechaOperacion": "10-01-2026", "participaciones": "10"}]
    client.post("/api/activos/apple", json=ficha, headers=cabeceras)

    soloCabecera = {k: v for k, v in ficha.items() if k not in ("rows", "conversionRows")}
    soloCabecera["color"] = "#242222"
    respuesta = client.post("/api/activos/apple", json=soloCabecera, headers=cabeceras)

    assert respuesta.status_code == 200
    guardado = client.get("/api/activos/apple").get_json()
    assert guardado["color"] == "#242222", "el cambio pedido sí tiene que guardarse"
    assert len(guardado["rows"]) == 1, "las compras no se mandaron, así que no se tocan"


def testMandarLasFilasVaciasSigueVaciandolas(cliente):
    """Borrar la última fila desde la tabla tiene que seguir funcionando.

    Es la diferencia entre "no mando las filas" y "mando que no hay ninguna":
    conservar en los dos casos dejaría un activo con una fila imborrable.
    """
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")
    ficha = client.get("/api/activos/apple").get_json()
    ficha["rows"] = [{"fechaOperacion": "10-01-2026", "participaciones": "10"}]
    client.post("/api/activos/apple", json=ficha, headers=cabeceras)

    ficha["rows"] = []
    client.post("/api/activos/apple", json=ficha, headers=cabeceras)

    assert client.get("/api/activos/apple").get_json()["rows"] == []


# ── Reordenar ────────────────────────────────────────────────────────────────

def testReordenarConLaListaCompleta(cliente):
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos", "Tres"):
        _crear(client, cabeceras, nombre)

    respuesta = client.post("/api/activos/reorder",
                            json={"orderedAssetIds": ["tres", "uno", "dos"]}, headers=cabeceras)

    assert respuesta.status_code == 200
    ids = [a["id"] for a in client.get("/api/activos").get_json()["assets"]]
    assert ids == ["tres", "uno", "dos"]


def testUnaListaDeOrdenIncompletaSeRechaza(cliente):
    """Aceptarla dejaría fuera del orden a los activos que faltasen."""
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos"):
        _crear(client, cabeceras, nombre)

    respuesta = client.post("/api/activos/reorder",
                            json={"orderedAssetIds": ["uno"]}, headers=cabeceras)

    assert respuesta.status_code == 400


def testMoverUnActivoHaciaArriba(cliente):
    client, cabeceras = cliente
    for nombre in ("Uno", "Dos"):
        _crear(client, cabeceras, nombre)

    client.post("/api/activos/reorder", json={"assetId": "dos", "direction": "up"},
                headers=cabeceras)

    ids = [a["id"] for a in client.get("/api/activos").get_json()["assets"]]
    assert ids == ["dos", "uno"]


def testMoverElPrimeroHaciaArribaNoHaceNada(cliente):
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
def testReordenarConDatosIncoherentes(cliente, cuerpo, codigo):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Uno")

    assert client.post("/api/activos/reorder", json=cuerpo, headers=cabeceras).status_code == codigo


# ── Borrar ───────────────────────────────────────────────────────────────────

def testBorrarUnActivo(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")

    assert client.delete("/api/activos/apple", headers=cabeceras).status_code == 200
    assert client.get("/api/activos/apple").status_code == 404


def testBorrarUnActivoInexistenteEs404(cliente):
    client, cabeceras = cliente
    assert client.delete("/api/activos/no-existe", headers=cabeceras).status_code == 404


# ── Moneda ───────────────────────────────────────────────────────────────────

def testCambiarALaMismaMonedaNoConvierteNada(cliente):
    """Y, sobre todo, no llama al proveedor de tipos de cambio."""
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")

    respuesta = client.post("/api/activos/apple/currency", json={"currency": "EUR"},
                            headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["converted"] is False


def testUnaMonedaNoSoportadaSeRechazaSinSalirALaRed(cliente):
    client, cabeceras = cliente
    _crear(client, cabeceras, "Apple")

    respuesta = client.post("/api/activos/apple/currency", json={"currency": "XYZ"},
                            headers=cabeceras)

    assert respuesta.status_code == 400
    assert "Moneda no soportada" in respuesta.get_json()["error"]


def testCambiarLaMonedaDeUnActivoInexistenteEs404(cliente):
    client, cabeceras = cliente
    respuesta = client.post("/api/activos/no-existe/currency", json={"currency": "USD"},
                            headers=cabeceras)
    assert respuesta.status_code == 404


def testRefrescarUnActivoInexistenteEs404(cliente):
    client, cabeceras = cliente
    respuesta = client.post("/api/activos/no-existe/refresh-market-data", headers=cabeceras)
    assert respuesta.status_code == 404


def _cotizacion(symbol, price, currency):
    return {
        "symbol": symbol, "price": price, "currency": currency, "change": "+0,00%",
        "status": "Cotización actualizada", "lastUpdated": "2026-01-01T00:00:00",
        "marketData": {}
    }


def testRefrescarConvierteALaDivisaDelActivo(cliente, monkeypatch):
    """Un ticker en USD sobre un activo en EUR se guarda en EUR.

    La divisa del activo es también la de lo invertido y el rendimiento resta
    uno del otro sin convertir: si el precio se guardara en la divisa del
    ticker, las compras en euros se leerían como dólares.
    """
    import routes.activos as activos_route

    client, cabeceras = cliente
    _crear(client, cabeceras, "Oro", tipo="comoditis", marketSymbol="OANDA:XAUUSD",
           marketProvider="tradingview")

    llamadas = []

    def fakeFetchAssetQuote(symbol, provider=None, useCache=True, targetCurrency=None):
        llamadas.append((symbol, provider, targetCurrency))
        return _cotizacion(symbol, "3789,52", targetCurrency), None

    monkeypatch.setattr(activos_route, "fetchAssetQuote", fakeFetchAssetQuote)

    respuesta = client.post("/api/activos/oro/refresh-market-data", headers=cabeceras)

    assert respuesta.status_code == 200
    assert llamadas == [("OANDA:XAUUSD", "tradingview", "EUR")]
    activo = respuesta.get_json()["asset"]
    assert activo["currency"] == "EUR"
    assert activo["price"] == "3789,52"


def testRefrescarSinTipoDeCambioNoGuardaUnPrecioEnOtraDivisa(cliente, monkeypatch):
    """Si la conversión falla, `fetchAssetQuote` devuelve la cotización en su
    divisa original. Guardarla sería poner 4321 dólares con la etiqueta de
    euros; se rechaza y el precio anterior se queda como estaba."""
    import routes.activos as activos_route

    client, cabeceras = cliente
    _crear(client, cabeceras, "Oro", tipo="comoditis", marketSymbol="GC=F", marketProvider="yahoo")
    antes = client.get("/api/activos/oro", headers=cabeceras).get_json()

    monkeypatch.setattr(
        activos_route, "fetchAssetQuote",
        lambda symbol, provider=None, useCache=True, targetCurrency=None: (
            _cotizacion(symbol, "4321,20", "USD"), None
        ),
    )

    respuesta = client.post("/api/activos/oro/refresh-market-data", headers=cabeceras)

    assert respuesta.status_code == 503
    despues = client.get("/api/activos/oro", headers=cabeceras).get_json()
    assert despues["price"] == antes["price"]
    assert despues["currency"] == "EUR"


def testElAutoguardadoNoBorraConvertCurrencyNiHidden(cliente):
    """El autoguardado de la ficha reenvía el activo sin estas dos claves."""
    client, cabeceras = cliente
    _crear(client, cabeceras, "Oro", tipo="comoditis")
    client.post("/api/activos/oro", json={
        "name": "Oro", "type": "comoditis", "convertCurrency": "EUR", "hidden": True, "rows": []
    }, headers=cabeceras)

    client.post("/api/activos/oro", json={"name": "Oro", "type": "comoditis", "rows": []},
                headers=cabeceras)

    activo = client.get("/api/activos/oro", headers=cabeceras).get_json()
    assert activo["convertCurrency"] == "EUR"
    assert activo["hidden"] is True


def testCambiarLaMonedaDelActivoArrastraConvertCurrency(cliente, monkeypatch):
    """Si la divisa fijada y la del activo se separaran, el siguiente refresco
    guardaría el precio en una y las compras seguirían en la otra."""
    from decimal import Decimal

    import routes.activos as activos_route

    client, cabeceras = cliente
    _crear(client, cabeceras, "Oro", tipo="comoditis")
    client.post("/api/activos/oro", json={
        "name": "Oro", "type": "comoditis", "convertCurrency": "EUR", "rows": []
    }, headers=cabeceras)
    monkeypatch.setattr(activos_route, "convertAmount",
                        lambda valor, origen, destino: (Decimal(valor) * Decimal("1.14"), None))
    monkeypatch.setattr(activos_route, "convertAssetRowsCurrency",
                        lambda filas, *args, **kwargs: (filas, None))

    respuesta = client.post("/api/activos/oro/currency", json={"currency": "USD"}, headers=cabeceras)

    assert respuesta.status_code == 200
    activo = client.get("/api/activos/oro", headers=cabeceras).get_json()
    assert activo["currency"] == "USD"
    assert activo["convertCurrency"] == "USD"


# ── Rendimiento agregado ─────────────────────────────────────────────────────

def _fichaConFilas(client, cabeceras, nombre, precio, filas, tipo="acciones"):
    _crear(client, cabeceras, nombre, tipo=tipo)
    assetId = nombre.lower()
    ficha = client.get(f"/api/activos/{assetId}").get_json()
    ficha["price"] = precio
    ficha["rows"] = filas
    client.post(f"/api/activos/{assetId}", json=ficha, headers=cabeceras)
    return assetId


def testElRendimientoDescuentaLasComisionesDelInvertido(cliente):
    client, cabeceras = cliente
    assetId = _fichaConFilas(client, cabeceras, "Apple", "120", [{
        "fechaOperacion": "10-01-2026",
        "tipoOperacion": "Compra",
        "participaciones": "10",
        "capitalInvertidoBruto": "1000",
        "comisiones": "50",
    }])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[assetId]

    # Invertido neto = 1000 bruto - 50 de comisiones.
    assert datos["invertidoNeto"] == 950.0
    assert datos["netoActual"] == 1200.0
    assert datos["rendimiento"] == 250.0
    assert datos["rendimientoPct"] == pytest.approx(26.32, abs=0.01)


def testUnaVentaReduceLasParticipacionesPeroNoLoInvertido(cliente):
    client, cabeceras = cliente
    assetId = _fichaConFilas(client, cabeceras, "Apple", "100", [
        {"fechaOperacion": "10-01-2026", "tipoOperacion": "Compra",
         "participaciones": "10", "capitalInvertidoBruto": "1000"},
        {"fechaOperacion": "11-01-2026", "tipoOperacion": "Venta",
         "participaciones": "4", "capitalInvertidoBruto": "500"},
    ])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[assetId]

    assert datos["netoActual"] == 600.0     # quedan 6 participaciones a 100
    assert datos["invertidoNeto"] == 1000.0


def testVenderMasDeLoQueHayNoProduceUnValorNegativo(cliente):
    """Un descuadre en los datos no debe pintar una cartera en negativo."""
    client, cabeceras = cliente
    assetId = _fichaConFilas(client, cabeceras, "Apple", "100", [
        {"fechaOperacion": "10-01-2026", "tipoOperacion": "Compra",
         "participaciones": "5", "capitalInvertidoBruto": "500"},
        {"fechaOperacion": "11-01-2026", "tipoOperacion": "Venta",
         "participaciones": "50", "capitalInvertidoBruto": "5000"},
    ])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[assetId]

    assert datos["netoActual"] == 0.0


def testSinInvertidoElPorcentajeEsCeroYNoDividePorCero(cliente):
    client, cabeceras = cliente
    assetId = _fichaConFilas(client, cabeceras, "Apple", "100", [])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[assetId]

    assert datos["rendimientoPct"] == 0
    assert datos["invertidoNeto"] == 0


def testLosImportesSeLeenEnFormatoEspaniol(cliente):
    """El frontend guarda "1.234,56": leerlo como float daría 1,234."""
    client, cabeceras = cliente
    assetId = _fichaConFilas(client, cabeceras, "Apple", "1.500,00", [{
        "fechaOperacion": "10-01-2026", "tipoOperacion": "Compra",
        "participaciones": "1", "capitalInvertidoBruto": "1.234,56",
    }])

    datos = client.get("/api/activos/rendimiento-batch").get_json()[assetId]

    assert datos["invertidoNeto"] == 1234.56
    assert datos["netoActual"] == 1500.0


# ── Sesión ───────────────────────────────────────────────────────────────────

def testLosActivosNoSeLeenSinSesion(crearApp, tempDb):
    from routes.activos import activosBp

    client = crearApp(activosBp).test_client()
    assert client.get("/api/activos").status_code == 401


def testBorrarUnActivoSinCsrfEs403(clienteAutenticado, tempDb):
    from routes.activos import activosBp

    client, _cabeceras, _app = clienteAutenticado(activosBp)
    assert client.delete("/api/activos/apple").status_code == 403


# ── Divisas del selector ─────────────────────────────────────────────────────

@pytest.fixture
def clienteMercado(clienteAutenticado, monkeypatch):
    from routes.market import marketBp

    client, cabeceras, _app = clienteAutenticado(marketBp)
    return client, cabeceras


def testLasDivisasSalenDelServicioDeCambio(clienteMercado, monkeypatch):
    """Se ofrecen las del activo que el servicio publica, con su nombre."""
    import routes.market as market_route

    client, cabeceras = clienteMercado
    monkeypatch.setattr(market_route, "fetchCurrencies", lambda: (
        {"EUR": "Euro", "USD": "United States Dollar", "SEK": "Swedish Krona"}, None
    ))

    divisas = client.get("/api/divisas", headers=cabeceras).get_json()["divisas"]

    # SEK la publica el servicio pero el activo no la admite; GBP, CHF y JPY al
    # revés. Solo quedan las que cumplen las dos cosas.
    assert divisas == [
        {"code": "EUR", "name": "Euro"},
        {"code": "USD", "name": "United States Dollar"},
    ]


def testSinServicioDeCambioSeOfrecenLasDelActivo(clienteMercado, monkeypatch):
    import routes.market as market_route

    client, cabeceras = clienteMercado
    monkeypatch.setattr(market_route, "fetchCurrencies",
                        lambda: (None, "No se pudo conectar al servicio de cambio de divisa"))

    respuesta = client.get("/api/divisas", headers=cabeceras).get_json()

    assert [d["code"] for d in respuesta["divisas"]] == ["CHF", "EUR", "GBP", "JPY", "USD"]
    assert "aviso" in respuesta


def testTiposDeCambioParaAjustes(clienteMercado, monkeypatch):
    import routes.market as market_route

    client, cabeceras = clienteMercado
    pedidos = []

    def fakeRates(base, targets, timeout=None):
        pedidos.append((base, list(targets)))
        return {"rates": {"USD": 1.14, "GBP": 0.86}, "fuente": "Frankfurter (referencia diaria del BCE)",
                "fecha": "2026-09-25"}, None

    monkeypatch.setattr(market_route, "fetchExchangeRates", fakeRates)
    monkeypatch.setattr(market_route, "fetchCurrencies", lambda: ({"USD": "United States Dollar"}, None))

    datos = client.get("/api/divisas/cambio?base=eur", headers=cabeceras).get_json()

    assert datos["ok"] is True
    assert datos["base"] == "EUR"
    assert datos["fecha"] == "2026-09-25"
    # Se pide a la vez el cambio a todas las demás divisas del activo.
    assert pedidos == [("EUR", ["CHF", "GBP", "JPY", "USD"])]
    assert {"code": "USD", "name": "United States Dollar", "rate": 1.14} in datos["cambios"]


def testTiposDeCambioSinServicioResponde503(clienteMercado, monkeypatch):
    import routes.market as market_route

    client, cabeceras = clienteMercado
    monkeypatch.setattr(market_route, "fetchExchangeRates",
                        lambda base, targets, timeout=None: (None, "No se pudo conectar al servicio de cambio de divisa"))

    respuesta = client.get("/api/divisas/cambio?base=EUR", headers=cabeceras)

    assert respuesta.status_code == 503
    assert "No se pudo conectar" in respuesta.get_json()["error"]
