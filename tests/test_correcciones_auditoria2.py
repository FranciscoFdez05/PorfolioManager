"""Regresiones de la auditoría del 2026-10-26 (B-13 en adelante).

Cada prueba reproduce un fallo concreto que estaba abierto; los comentarios
dicen cuál.
"""

import pytest

# ── B-13: un POST sin cuerpo válido no puede vaciar tablas ───────────────────

@pytest.fixture
def clienteListas(clienteAutenticado, tempDb, monkeypatch):
    from routes.operaciones import operacionesBp
    from routes.registros import registrosBp
    from routes.trading import tradingBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(tradingBp, operacionesBp, registrosBp)
    return client, cabeceras


@pytest.mark.parametrize("ruta,fila", [
    ("/api/trading", {"id": "t1", "fecha": "01-01-2025", "moneda": "BTC", "capital": "100"}),
    ("/api/transacciones", {"id": "x1"}),
])
def testPostSinRowsNoVaciaLaTabla(clienteListas, ruta, fila):
    client, cabeceras = clienteListas
    assert client.post(ruta, json={"rows": [fila]}, headers=cabeceras).status_code == 200

    for cuerpo in ({}, {"rowz": []}):
        respuesta = client.post(ruta, json=cuerpo, headers=cabeceras)
        assert respuesta.status_code == 400

    basura = client.post(ruta, data="no es json", content_type="text/plain", headers=cabeceras)
    assert basura.status_code == 400
    assert len(client.get(ruta).get_json()["rows"]) == 1


def testPostSinRowsNoVaciaOperaciones(clienteListas):
    client, cabeceras = clienteListas
    client.post("/api/operaciones", json={"rows": [{"id": "o1", "assetId": "x"}]}, headers=cabeceras)

    assert client.post("/api/operaciones", json={}, headers=cabeceras).status_code == 400
    assert len(client.get("/api/operaciones").get_json()["rows"]) == 1


def testPostSinDatosNoVaciaLasStablecoins(clienteListas):
    client, cabeceras = clienteListas
    fila = {"id": "s1", "stablecoinSymbol": "USDT", "tipo": "Compra", "cantidad": "10", "total": "10"}
    client.post("/api/stablecoins", json={"catalog": ["USDT"], "enabledSymbols": ["USDT"], "rows": [fila]},
                headers=cabeceras)

    assert client.post("/api/stablecoins", json={}, headers=cabeceras).status_code == 400
    assert len(client.get("/api/stablecoins").get_json()["rows"]) == 1

    # Guardar solo el catálogo tampoco vacía las filas.
    assert client.post("/api/stablecoins", json={"catalog": ["USDT"], "enabledSymbols": ["USDT"]},
                       headers=cabeceras).status_code == 200
    assert len(client.get("/api/stablecoins").get_json()["rows"]) == 1


def testRowsVaciasExplicitasSiVacian(clienteListas):
    # Borrar la última fila sigue siendo legítimo: se manda rows=[] a propósito.
    client, cabeceras = clienteListas
    client.post("/api/trading", json={"rows": [{"id": "t1"}]}, headers=cabeceras)

    assert client.post("/api/trading", json={"rows": []}, headers=cabeceras).status_code == 200
    assert client.get("/api/trading").get_json()["rows"] == []


# ── B-17: las ventas retiran el coste FIFO del invertido ─────────────────────

def _fila(tipo, participaciones, capital, fecha="01-01-2025", **extra):
    return {
        "tipo_operacion": tipo, "participaciones": participaciones,
        "capital_invertido_bruto": capital, "comisiones": "", "comisiones_fiat": "",
        "fecha_operacion": fecha, **extra,
    }


def testElInvertidoDescuentaElCosteFifoDeLoVendido():
    from decimal import Decimal

    from stores import rendimiento_activo

    filas = [
        _fila("Compra", "10", "1000", "01-01-2025"),
        _fila("Venta", "5", "750", "02-01-2025"),
    ]
    totales = rendimiento_activo.calcular(filas, [], False, "150,00")

    assert totales.participaciones == Decimal("5")
    assert totales.invertidoNeto == Decimal("500")
    assert totales.rendimiento == Decimal("250")


def testLaVentaConsumeLosLotesMasAntiguosPrimero():
    from decimal import Decimal

    from stores import rendimiento_activo

    # Dos compras a precios distintos: vender 10 se lleva la barata (fecha
    # anterior) aunque en la lista vaya después.
    filas = [
        _fila("Compra", "10", "2000", "05-02-2025"),
        _fila("Compra", "10", "1000", "01-01-2025"),
        _fila("Venta", "10", "0", "10-03-2025"),
    ]
    totales = rendimiento_activo.calcular(filas, [], False, "0")

    assert totales.invertidoNeto == Decimal("2000")


def testElDesglosePorDivisaUsaSoloLoQueSigueEnCartera():
    from decimal import Decimal

    from routes.activos import _descomponerPorDivisa

    filas = [
        _fila("Compra", "10", "1000", "01-01-2025", fx_rate="0.9"),
        _fila("Venta", "5", "0", "02-01-2025"),
    ]
    resultado = _descomponerPorDivisa(filas, Decimal("5"), Decimal("200"), Decimal("1"))

    # Quedan 5 que costaron 500 a 0,9 y valen 1000 a 1,0.
    assert resultado.invertidoEur == Decimal("450")
    assert resultado.valorEur == Decimal("1000")


# ── B-16: la comisión en cripto sale de las participaciones ──────────────────

def testElFifoDelServidorRestaLaComisionCriptoDeLaFicha(tempDb):
    from decimal import Decimal

    from stores import asset_store, ventas_fifo

    asset_store.writeAssetFile("btc", {
        "name": "BTC", "type": "cripto", "price": "100,00", "currency": "EUR",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra",
                  "participaciones": "1", "capitalInvertidoBruto": "100",
                  "comisionesCripto": "0.001"}],
    })

    assert ventas_fifo.carteraViva()["btc"]["cantidad"] == Decimal("0.999")


def testElRendimientoRestaLaComisionCriptoDeLaFicha():
    from decimal import Decimal

    from stores import rendimiento_activo

    filas = [_fila("Compra", "1", "100", comisiones_cripto="0.001")]
    assert rendimiento_activo.calcular(filas, [], True, "100").participaciones == Decimal("0.999")
    # En un activo que no es cripto esa columna no pinta nada.
    assert rendimiento_activo.calcular(filas, [], False, "100").participaciones == Decimal("1")


# ── B-18: sin tipo de cambio actual el desglose no es completo ───────────────

def testSinTipoActualElDesgloseSeMarcaIncompleto():
    from decimal import Decimal

    from core import pnl_divisa

    lotes = [{"invertido": Decimal(1000), "valorActual": Decimal(1200), "fxCompra": "0.90"}]

    assert pnl_divisa.descomponerLotes(lotes, None).completo is False
    assert pnl_divisa.descomponer(Decimal(1000), Decimal(1200), "0.90", None).completo is False
    assert pnl_divisa.descomponerLotes(lotes, Decimal("0.95")).completo is True


# ── B-19: historical-changes no confunde aportaciones con subida de precio ───

def _snapshotsDeActivo(conn, valorAntes, costeAntes, valorAhora, costeAhora):
    import time

    ahora = int(time.time())
    conn.execute("INSERT INTO asset_snapshots(ts, asset_id, price_eur, cost_eur) VALUES (?,?,?,?)",
                 (ahora - 4 * 86400, "acc", valorAntes, costeAntes))
    conn.execute("INSERT INTO asset_snapshots(ts, asset_id, price_eur, cost_eur) VALUES (?,?,?,?)",
                 (ahora - 60, "acc", valorAhora, costeAhora))
    conn.commit()


@pytest.fixture
def clienteMercado(clienteAutenticado, tempDb):
    from core.db import getDb
    from routes.market import _histCache, marketBp
    from stores import asset_store

    _histCache.clear()
    client, cabeceras, _app = clienteAutenticado(marketBp)
    asset_store.writeAssetFile("acc", {"name": "Acc", "type": "acciones", "price": "10", "currency": "EUR"})
    return client, cabeceras, getDb()


def testComprarMasNoSeLeeComoSubidaDePrecio(clienteMercado):
    client, cabeceras, conn = clienteMercado
    # Mismo precio unitario: la posición pasó de 10 a 20 participaciones.
    _snapshotsDeActivo(conn, 100.0, 100.0, 200.0, 200.0)

    datos = client.get("/api/historical-changes?period=semana", headers=cabeceras).get_json()["data"]

    assert "acc" not in datos


def testSinCambiosDePosicionSeCalculaLaVariacion(clienteMercado):
    client, cabeceras, conn = clienteMercado
    _snapshotsDeActivo(conn, 100.0, 100.0, 110.0, 100.0)

    datos = client.get("/api/historical-changes?period=semana", headers=cabeceras).get_json()["data"]

    assert datos["acc"] == 10.0


# ── B-20: una valoración con datos inventados no entra en el histórico ───────

def testSinTipoDeCambioLaValoracionSeMarcaIncompleta(tempDb, monkeypatch):
    from stores import asset_store, valoracion

    asset_store.writeAssetFile("usd", {
        "name": "USD", "type": "acciones", "price": "10", "currency": "USD", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                  "capitalInvertidoBruto": "10"}],
    })
    monkeypatch.setattr(valoracion, "fetchExchangeRate", lambda origen, destino: (None, "sin red"))

    assert valoracion.valorarPortfolio(refrescarPrecios=False)["completa"] is False


def testUnActivoSinPrecioMarcaLaValoracionIncompleta(tempDb):
    from stores import asset_store, valoracion

    asset_store.writeAssetFile("nuevo", {
        "name": "Nuevo", "type": "acciones", "price": "0,00", "currency": "EUR", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                  "capitalInvertidoBruto": "10"}],
    })

    assert valoracion.valorarPortfolio(refrescarPrecios=False)["completa"] is False


def testElHiloNoGuardaUnaValoracionIncompleta(tempDb, monkeypatch):
    from admin import snapshot_scheduler
    from core.db import getDb
    from stores import valoracion

    monkeypatch.setattr(snapshot_scheduler, "_rutasObjetivo", lambda: [tempDb])
    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 3600)
    monkeypatch.setattr(valoracion, "valorarPortfolio", lambda refrescarPrecios=True: {
        "total_value": 1.0, "total_invested": 1.0, "assets": [], "precios_frescos": 0,
        "activos": 1, "completa": False,
    })

    assert snapshot_scheduler.ejecutarUnaVez(refrescarPrecios=False) == 0
    assert getDb().execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0] == 0


# ── B-21: una venta con importe ilegible se rechaza ──────────────────────────

@pytest.mark.parametrize("campo", ["valor_venta", "comision_venta"])
def testUnaVentaConImporteIlegibleEsIncidenciaDePrecio(campo):
    from stores import ventas_fifo

    fila = {"asset_id": "acc", "cantidad": "10", "valor_venta": "5", "comision_venta": "0",
            "fecha": "02-02-2025", "year": "2025"}
    fila[campo] = "1.234.5"

    assert ventas_fifo.validarVenta(fila, {"acc": {}}) == (None, ventas_fifo.INCIDENCIA_PRECIO)
    # Vacío sigue siendo legible: una venta sin comisión es lo normal.
    fila[campo] = ""
    assert ventas_fifo.validarVenta(fila, {"acc": {}})[1] == ""


# ── B-22: no se borra una cuenta que usan mensualidades o recurrentes ────────

def testNoSePuedeBorrarUnaCuentaConMensualidades(tempDb):
    import datetime

    from core.db import getDb
    from stores import cuentas_store as cs

    cuenta = cs.crearCuenta("Broker X", "broker")
    cuentaId = cuenta["id"] if isinstance(cuenta, dict) else cuenta
    conn = getDb()
    conn.execute("INSERT INTO mensualidades (year, nombre, cuenta, enero) VALUES (?, ?, ?, ?)",
                 (str(datetime.date.today().year), "Alquiler", cuentaId, "100"))
    conn.commit()

    with pytest.raises(cs.CuentaEnUso):
        cs.eliminarCuenta(cuentaId)


# ── B-23: importar JSON no descarta filas en silencio ────────────────────────

def testImportarConservaLasColumnasDeTodasLasFilas(tempDb):
    from core.db import getDb
    from routes.ajustes import _restoreTablesFromDict

    conn = getDb()
    _restoreTablesFromDict(conn, {"tables": {"activos": [
        {"id": "a", "name": "A"}, {"id": "c", "name": "C", "sort_order": 3}]}})

    filas = {r["id"]: r["sort_order"] for r in conn.execute("SELECT id, sort_order FROM activos")}
    assert filas == {"a": 0, "c": 3}


def testImportarUnaFilaInvalidaRevierteTodoEnVezDeDescartarla(tempDb):
    from core.db import getDb
    from routes.ajustes import _restoreTablesFromDict

    conn = getDb()
    conn.execute("INSERT INTO activos(id, name) VALUES ('previo', 'Previo')")
    conn.commit()

    with pytest.raises(RuntimeError):
        _restoreTablesFromDict(conn, {"tables": {"activos": [
            {"id": "a", "name": "A"}, {"id": "b", "name": None}]}})

    assert [r["id"] for r in conn.execute("SELECT id FROM activos")] == ["previo"]


# ── B-25: /currency lee la revisión antes que el activo ──────────────────────

def testCambiarDivisaConUnGuardadoIntermedioDaConflicto(clienteAutenticado, tempDb, monkeypatch):
    from decimal import Decimal

    import routes.activos as rutas
    from stores import asset_store

    client, cabeceras, _app = clienteAutenticado(rutas.activosBp)
    ficha = {"name": "Acc", "type": "acciones", "price": "10,00", "currency": "USD"}
    asset_store.writeAssetFile("acc", ficha)

    monkeypatch.setattr(rutas, "convertAmount", lambda valor, origen, destino: (Decimal("9"), None))
    lecturaReal = rutas.readAssetFile

    def lecturaConGuardadoIntermedio(assetId):
        datos = lecturaReal(assetId)
        asset_store.writeAssetFile("acc", ficha)   # otro sitio guarda justo después de leer
        return datos

    monkeypatch.setattr(rutas, "readAssetFile", lecturaConGuardadoIntermedio)

    respuesta = client.post("/api/activos/acc/currency", json={"currency": "EUR"}, headers=cabeceras)

    assert respuesta.status_code == 409


# ── B-27: el snapshot del navegador no admite valores absurdos ───────────────

def testElSnapshotRechazaNegativosYNoGuardaValorCeroConInvertido(clienteAutenticado, tempDb):
    from core.db import getDb
    from routes.snapshots import snapshotsBp

    client, cabeceras, _app = clienteAutenticado(snapshotsBp)

    negativo = client.post("/api/portfolio/snapshot", json={"total_value": -5, "total_invested": 10},
                           headers=cabeceras)
    assert negativo.status_code == 400

    sinPrecios = client.post("/api/portfolio/snapshot", json={"total_value": 0, "total_invested": 100},
                             headers=cabeceras)
    assert sinPrecios.get_json()["skipped"] is True
    assert getDb().execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0] == 0


# ── B-28: demasiadas ventas se rechazan en vez de recortarse ─────────────────

def testMasDeQuinientasVentasSeRechazan():
    from stores.ventas_store import sanitizeVentasPayload

    filas = [{"id": f"v{i}", "fecha": "01-01-2025", "assetId": "a", "cantidad": "1", "valorVenta": "1"}
             for i in range(501)]
    payload, error = sanitizeVentasPayload({"year": "2025", "rows": filas}, "2025")

    assert payload is None
    assert "500" in error


# ── B-29: pre_restore se poda y no colisiona ─────────────────────────────────

def testLaPodaConservaLasCopiasMasRecientesYNoTocaLosFicheros(tmp_path):
    import os

    from routes.backup import _podarCopiasPrevias

    for indice in range(5):
        carpeta = tmp_path / f"copia{indice}"
        carpeta.mkdir()
        os.utime(carpeta, (1000 + indice, 1000 + indice))
    (tmp_path / "snapshots_x.json").write_text("[]", "utf-8")

    _podarCopiasPrevias(tmp_path, conservar=2)

    assert sorted(p.name for p in tmp_path.iterdir()) == ["copia3", "copia4", "snapshots_x.json"]


def testDosCopiasPreviasEnElMismoSegundoNoComparten(datosAislados, monkeypatch):
    from routes import backup

    (datosAislados["portfolios"] / "a.db").write_bytes(b"")
    monkeypatch.setattr(backup, "copiarSqlite", lambda origen, destino: destino.write_bytes(b"x"))

    primera = backup._safetyCopyBeforeRestore()
    segunda = backup._safetyCopyBeforeRestore()

    assert primera != segunda
    assert primera.exists() and segunda.exists()


# ── B-30: un portfolios.json ilegible no borra el índice ─────────────────────

def testUnIndiceIlegibleSeReconstruyeDesdeLosDbEnDisco(datosAislados):
    from admin import portfolios_manager as pm

    datosAislados["meta"].write_text("{esto no es json", "utf-8")
    (datosAislados["portfolios"] / "principal.db").write_bytes(b"")
    (datosAislados["portfolios"] / "viajes.db").write_bytes(b"")

    meta = pm._reconstruirIndice()

    assert [p["id"] for p in meta["portfolios"]] == ["principal", "viajes"]
    assert meta["active"] == "principal"
    assert list(datosAislados["data"].glob("portfolios.json.ilegible-*"))


# ── B-31: el informe usa los totales exactos del resumen ─────────────────────

def testElInformeNoSumaFilasRedondeadas():
    from core import informe_renta

    filas = [{"dineroDeclarar": "0.01", "incidencia": ""} for _ in range(3)]
    informe = informe_renta.construir("2025", filas, {"ganancias": "0.04", "perdidas": "0"})

    assert informe["totales"][0][1] == "0,04"


# ── B-32: la sincronización de operaciones solo escribe si hay cambios ───────

def testLaSincronizacionNoAvanzaLaRevisionSiNoHayCambios(tempDb):
    from core.db import getDb
    from stores import asset_store, revisiones
    from stores.helpers import syncCompletedOperationsIntoAssets

    asset_store.writeAssetFile("eth", {"name": "ETH", "type": "cripto", "price": "1", "currency": "EUR"})
    operacion = {"id": "o1", "assetId": "eth", "estado": "Completado", "orden": "Compra",
                 "cantidad": "1", "total": "100", "fechaApertura": "01-01-2025"}

    syncCompletedOperationsIntoAssets([operacion])
    revision = revisiones.actual("activos", "eth")
    syncCompletedOperationsIntoAssets([operacion])

    assert getDb().execute("SELECT COUNT(*) FROM activo_operation_rows").fetchone()[0] == 1
    assert revisiones.actual("activos", "eth") == revision


# ── B-33: borrar un portfolio no deja el .db fuera del índice ────────────────

def testSiFallaElMoveElPortfolioSigueEnElIndice(datosAislados, monkeypatch):
    import json

    from admin import portfolios_manager as pm

    datosAislados["meta"].write_text(json.dumps({
        "active": "a", "portfolios": [{"id": "a", "name": "A"}, {"id": "b", "name": "B"}],
    }), "utf-8")
    (datosAislados["portfolios"] / "b.db").write_bytes(b"")

    def fallar(origen, destino):
        raise PermissionError("en uso")

    monkeypatch.setattr(pm.shutil, "move", fallar)

    with pytest.raises(PermissionError):
        pm.deletePortfolio("b")

    assert [p["id"] for p in json.loads(datosAislados["meta"].read_text("utf-8"))["portfolios"]] == ["a", "b"]


def testUnDbSueltoDanadoNoSustituyeALaBaseActiva(datosAislados, tempDb):
    from routes import backup

    roto = datosAislados["backups"] / "portfolio_01-01-2025_00-00-00.db"
    roto.write_text("no soy sqlite", "utf-8")

    with pytest.raises(RuntimeError):
        backup._restaurarDbSuelto(roto, roto.name)


# ── B-15: el FIFO fiscal convierte cada operación con su propio tipo ─────────

def _compraEnDivisa(moneda, fx, capital="1000", fecha="01-01-2025", **extra):
    return {"fechaOperacion": fecha, "tipoOperacion": "Compra", "participaciones": "10",
            "capitalInvertidoBruto": capital, "currency": moneda, "fxRate": fx, **extra}


def _venderYCalcular(assetId, valorVenta, fx, fecha="02-02-2025", comision="0"):
    from core.db import getDb
    from stores import ventas_fifo
    from stores.ventas_store import writeVentasYear

    writeVentasYear("2025", {"year": "2025", "rows": [
        {"id": "v1", "fecha": fecha, "assetId": assetId, "cantidad": "10",
         "valorVenta": valorVenta, "comisionVenta": comision}]})
    conn = getDb()
    conn.execute("UPDATE ventas SET fx_rate = ? WHERE id = 'v1'", (fx,))
    conn.commit()
    return ventas_fifo.calcularTodo()["filas"][("2025", "v1")]


def testCompraYVentaEnDolaresSeConviertenCadaUnaConSuTipo(tempDb):
    from stores import asset_store

    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "70", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "0.5")],
    })

    fila = _venderYCalcular("aapl", "70", "0.6")

    # Coste 1000 USD x 0,5 = 500 EUR; venta 700 USD x 0,6 = 420 EUR.
    assert fila["incidencia"] == ""
    assert fila["costeAdquisicion"] == "500.00"
    assert fila["valorTransmision"] == "420.00"
    assert fila["dineroDeclarar"] == "-80.00"


def testSinTipoEnLaVentaLaVentaSaleConIncidenciaYNoSuma(tempDb):
    from stores import asset_store, ventas_fifo

    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "70", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "0.5")],
    })

    fila = _venderYCalcular("aapl", "70", "")

    assert fila["incidencia"] == "tipo_cambio_pendiente"
    assert fila["dineroDeclarar"] == ""
    assert ventas_fifo.calcularTodo()["liquidaciones"]["2025"].saldo == 0


def testSinTipoEnLaCompraLaVentaQueLaConsumeSaleConIncidencia(tempDb):
    from stores import asset_store

    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "70", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "")],
    })

    fila = _venderYCalcular("aapl", "70", "0.6")

    assert fila["incidencia"] == "tipo_cambio_pendiente"
    assert fila["dineroDeclarar"] == ""


def testUnActivoEnEurosNoNecesitaTipoYNoCambiaElResultado(tempDb):
    from stores import asset_store

    asset_store.writeAssetFile("eur", {
        "name": "EUR", "type": "acciones", "price": "120", "currency": "EUR",
        "rows": [_compraEnDivisa("EUR", "")],
    })

    fila = _venderYCalcular("eur", "120", "")

    assert fila["incidencia"] == ""
    assert fila["costeAdquisicion"] == "1000.00"
    assert fila["valorTransmision"] == "1200.00"
    assert fila["dineroDeclarar"] == "200.00"


def testLaVentaGuardaLaDivisaDelActivoYLaConservaSiElActivoCambia(tempDb):
    from core.db import getDb
    from stores import asset_store
    from stores.ventas_store import writeVentasYear

    ficha = {"name": "AAPL", "type": "acciones", "price": "70", "currency": "USD",
             "rows": [_compraEnDivisa("USD", "0.5")]}
    asset_store.writeAssetFile("aapl", ficha)
    anio = {"year": "2025", "rows": [{"id": "v1", "fecha": "02-02-2025", "assetId": "aapl",
                                       "cantidad": "5", "valorVenta": "70"}]}
    writeVentasYear("2025", anio)
    asset_store.writeAssetFile("aapl", {**ficha, "currency": "EUR"})
    writeVentasYear("2025", anio)

    assert getDb().execute("SELECT currency FROM ventas WHERE id = 'v1'").fetchone()[0] == "USD"


def testLaMigracionDaALasVentasViejasLaDivisaDeSuActivo(tempDb):
    from core import db
    from core.db import getDb

    conn = getDb()
    conn.execute("INSERT INTO activos(id, name, currency) VALUES ('aapl', 'AAPL', 'USD')")
    conn.execute("INSERT INTO ventas(id, year, asset_id, currency) VALUES ('v1', '2025', 'aapl', '')")
    conn.execute("INSERT INTO ventas(id, year, asset_id, currency) VALUES ('v2', '2025', 'borrado', '')")
    db._esquema24(conn)

    divisas = {r["id"]: r["currency"] for r in conn.execute("SELECT id, currency FROM ventas")}
    assert divisas == {"v1": "USD", "v2": "EUR"}


def testCambiarLaDivisaDelActivoActualizaLaDivisaYElTipoDeSusFilas(clienteAutenticado, tempDb, monkeypatch):
    from decimal import Decimal

    import routes.activos as rutas
    from stores import asset_store, helpers

    client, cabeceras, _app = clienteAutenticado(rutas.activosBp)
    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "10", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "0.5")],
    })
    monkeypatch.setattr(rutas, "convertAmount", lambda valor, origen, destino: (Decimal("9"), None))
    monkeypatch.setattr(helpers, "convertAmount", lambda valor, origen, destino: (Decimal("900"), None))

    respuesta = client.post("/api/activos/aapl/currency", json={"currency": "EUR"}, headers=cabeceras)
    assert respuesta.status_code == 200

    fila = asset_store.readAssetFile("aapl")["rows"][0]
    assert fila["currency"] == "EUR"
    # El tipo se reescala con el de la conversión para que el coste en euros no cambie.
    assert Decimal(fila["fxRate"]) == pytest.approx(Decimal("0.5") / 9, abs=Decimal("1e-11"))

    respuesta = client.post("/api/activos/aapl/currency", json={"currency": "USD"}, headers=cabeceras)
    assert respuesta.status_code == 200
    fila = asset_store.readAssetFile("aapl")["rows"][0]
    assert fila["currency"] == "USD"
    assert Decimal(fila["fxRate"]) == pytest.approx(Decimal("0.5"), abs=Decimal("1e-9"))


# ── B-21: una compra ilegible contamina las ventas que la consumen ───────────

def testUnaCompraIlegibleDejaLaVentaConIncidencia(tempDb):
    from stores import asset_store

    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "12", "currency": "EUR",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "10",
                  "precioParticipacion": "1.2.3", "capitalInvertidoBruto": "100", "currency": "EUR"}],
    })

    fila = _venderYCalcular("acc", "12", "")

    assert fila["incidencia"] == "compra_importe_ilegible"
    assert fila["dineroDeclarar"] == ""


# ── B-31 (tercera tanda): el saldo mostrado es ganancias menos pérdidas ──────

def testElSaldoMostradoEsGananciasMenosPerdidasMostradas():
    from decimal import Decimal

    from core.fiscal_es import Liquidacion
    from stores.ventas_fifo import serializarLiquidacion

    # 314,706 y 57,264 se muestran 314,71 y 57,26; su saldo exacto, 257,442,
    # se mostraba 257,44 y la resta de lo mostrado da 257,45.
    liquidacion = Liquidacion(
        anio="2008", ganancias=Decimal("314.706"), perdidas=Decimal("57.264"),
        saldo=Decimal("257.442"), base=Decimal("257.442"),
    )

    resumen = serializarLiquidacion(liquidacion)

    assert Decimal(resumen["ganancias"]) - Decimal(resumen["perdidas"]) == Decimal(resumen["saldo"])
    assert resumen["saldo"] == "257.45"


# ── B-23 (tercera tanda): campos obligatorios vacíos y claves nulas ──────────

@pytest.mark.parametrize("tabla,fila", [
    ("trading", {"id": "t1", "fecha": ""}),
    ("trading", {"id": None, "fecha": "01-01-2025"}),
    ("activo_rows", {"asset_id": "a", "fecha_operacion": "  "}),
    ("activos", {"id": "a", "name": ""}),
    ("ventas", {"id": "v1", "year": "2025", "fecha": ""}),
])
def testImportarRechazaCamposObligatoriosVaciosConMensajeClaro(tempDb, tabla, fila):
    from core.db import getDb
    from routes.ajustes import ImportacionInvalida, _restoreTablesFromDict

    conn = getDb()
    conn.execute("INSERT INTO activos(id, name) VALUES ('a', 'A')")
    conn.commit()

    with pytest.raises(ImportacionInvalida) as error:
        _restoreTablesFromDict(conn, {"tables": {"activos": [{"id": "a", "name": "A"}], tabla: [fila]}})

    assert tabla in str(error.value)
    assert "fila 1" in str(error.value)
    assert conn.execute("SELECT COUNT(*) FROM activos").fetchone()[0] == 1


def testImportarUnaFilaInvalidaDevuelve400ConElMensaje(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    import io
    import json

    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    cuerpo = json.dumps({"tables": {"trading": [{"id": "t1", "fecha": ""}]}}).encode("utf-8")

    respuesta = client.post("/api/import/json", data={"file": (io.BytesIO(cuerpo), "x.json")},
                            content_type="multipart/form-data", headers=cabeceras)

    assert respuesta.status_code == 400
    assert "trading" in respuesta.get_json()["error"]


# ── B-17 (tercera tanda): las ventas de la tabla Ventas también cuentan ──────

def testLasVentasDeLaTablaVentasRestanDelInvertidoEnLaLista(tempDb):
    from stores import asset_store
    from stores.asset_store import listAssets

    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "150,00", "currency": "EUR",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "10",
                  "capitalInvertidoBruto": "1000", "currency": "EUR"}],
    })
    _venderYCalcular("acc", "150", "", comision="0")

    from core.db import getDb
    conn = getDb()
    conn.execute("UPDATE ventas SET cantidad = '5' WHERE id = 'v1'")
    conn.commit()
    activo = next(a for a in listAssets() if a["id"] == "acc")

    assert activo["invertidoNeto"] == 500.0
    assert activo["rendimiento"] == 250.0


def testElBatchYElDesgloseUsanLasVentasDeLaTablaVentas(clienteAutenticado, tempDb, monkeypatch):
    import routes.activos as rutas
    from core.db import getDb
    from providers import finnhub_client
    from routes.activos import activosBp
    from stores import asset_store

    finnhub_client.clearExchangeRateCache()
    monkeypatch.setattr(rutas, "fetchExchangeRate", lambda origen, destino, timeout=None: (0.8, None))
    client, _cabeceras, _app = clienteAutenticado(activosBp)
    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "150,00", "currency": "USD",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "10",
                  "capitalInvertidoBruto": "1000", "currency": "USD", "fxRate": "1"}],
    })
    conn = getDb()
    conn.execute("INSERT OR IGNORE INTO ventas_years(year) VALUES ('2025')")
    conn.execute("INSERT INTO ventas(id, year, fecha, asset_id, cantidad, valor_venta, currency) "
                 "VALUES ('v1', '2025', '02-02-2025', 'acc', '5', '150', 'USD')")
    conn.commit()

    datos = client.get("/api/activos/rendimiento-batch").get_json()["acc"]

    assert datos["invertidoNeto"] == 500.0
    assert datos["netoActual"] == 750.0
    assert datos["rendimiento"] == 250.0
    # El desglose usa lo que sigue en cartera (5 a 150 USD) y lo convierte con el tipo de hoy.
    divisa = datos["divisa"]
    assert divisa["valorEur"] == "600.00"        # 750 USD x 0,8, no 750 EUR
    assert divisa["invertidoEur"] == "500.00"    # 500 USD x 1 (tipo de la compra)
    assert float(divisa["efectoActivo"]) + float(divisa["efectoDivisa"]) == pytest.approx(float(divisa["total"]), abs=0.01)
    assert divisa["total"] == "100.00"


# ── B-19 (tercera tanda): la variación sale aunque la posición cambiara ──────

def testLaVariacionDePrecioSeReconstruyeSiCambioLaPosicion(clienteMercado):
    import datetime

    from stores import asset_store

    client, cabeceras, conn = clienteMercado
    hoy = datetime.date.today()
    fecha = lambda dias: (hoy - datetime.timedelta(days=dias)).strftime("%d-%m-%Y")  # noqa: E731
    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "11", "currency": "EUR",
        "rows": [
            {"fechaOperacion": fecha(60), "tipoOperacion": "Compra", "participaciones": "10",
             "capitalInvertidoBruto": "100", "currency": "EUR"},
            {"fechaOperacion": fecha(2), "tipoOperacion": "Compra", "participaciones": "10",
             "capitalInvertidoBruto": "110", "currency": "EUR"},
        ],
    })
    # Hace 4 días: 10 participaciones a 10 EUR. Ahora: 20 a 11 EUR (+10 %).
    _snapshotsDeActivo(conn, 100.0, 100.0, 220.0, 210.0)

    datos = client.get("/api/historical-changes?period=semana", headers=cabeceras).get_json()["data"]

    assert datos["acc"] == 10.0


# ── Cambiar la divisa del activo no altera el resultado fiscal ───────────────

def testCambiarLaDivisaNoAlteraElResultadoFiscalDeVentasPasadas(clienteAutenticado, tempDb, monkeypatch):
    from decimal import Decimal

    import routes.activos as rutas
    from stores import asset_store, helpers, ventas_fifo

    client, cabeceras, _app = clienteAutenticado(rutas.activosBp)
    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "90", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "0.8")],
    })
    antes = _venderYCalcular("aapl", "90", "0.9")
    assert antes["costeAdquisicion"] == "800.00"

    tasa = Decimal("0.9")   # euros por dólar de hoy, distinto del de la compra
    monkeypatch.setattr(rutas, "convertAmount", lambda valor, origen, destino: (Decimal(valor) * tasa, None))
    monkeypatch.setattr(helpers, "convertAmount", lambda valor, origen, destino: (Decimal(valor) * tasa, None))

    respuesta = client.post("/api/activos/aapl/currency", json={"currency": "EUR"}, headers=cabeceras)
    assert respuesta.status_code == 200

    fila = asset_store.readAssetFile("aapl")["rows"][0]
    assert fila["currency"] == "EUR"
    assert fila["capitalInvertidoBruto"].startswith("900")   # se ve convertido a hoy

    despues = ventas_fifo.calcularTodo()["filas"][("2025", "v1")]
    for campo in ("costeAdquisicion", "valorTransmision", "dineroDeclarar"):
        assert despues[campo] == antes[campo], campo
    assert despues["incidencia"] == ""


# ── 7: no se toma un snapshot durante una importación o un restore ───────────

def testElHiloDeSnapshotsSeSaltaElHuecoMientrasHayUnaImportacion(datosAislados, tempDb, monkeypatch):
    from admin import snapshot_scheduler
    from core.db import getDb
    from routes.backup import bloqueoRestauracion
    from stores import asset_store, valoracion

    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "10", "currency": "EUR", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                  "capitalInvertidoBruto": "10", "currency": "EUR"}],
    })
    monkeypatch.setattr(snapshot_scheduler, "_rutasObjetivo", lambda: [tempDb])
    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 3600)
    llamadas = []
    original = valoracion.valorarPortfolio
    monkeypatch.setattr(valoracion, "valorarPortfolio",
                        lambda refrescarPrecios=True: llamadas.append(1) or original(refrescarPrecios=False))

    with bloqueoRestauracion():
        assert snapshot_scheduler.ejecutarUnaVez(refrescarPrecios=False) == 0
    assert llamadas == []
    assert getDb().execute("SELECT COUNT(*) FROM snapshot_jobs").fetchone()[0] == 0

    # Terminada la importación, el mismo hueco sigue libre y se guarda.
    assert snapshot_scheduler.ejecutarUnaVez(refrescarPrecios=False) == 1


def testElSnapshotDelNavegadorSeOmiteMientrasHayUnaImportacion(clienteAutenticado, datosAislados, tempDb):
    from core.db import getDb
    from routes.backup import bloqueoRestauracion
    from routes.snapshots import snapshotsBp

    client, cabeceras, _app = clienteAutenticado(snapshotsBp)
    cuerpo = {"total_value": 120661, "total_invested": 100000}

    with bloqueoRestauracion():
        respuesta = client.post("/api/portfolio/snapshot", json=cuerpo, headers=cabeceras)

    assert respuesta.get_json()["skipped"] is True
    assert getDb().execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0] == 0


# ── 8: «Rellenar tipos de cambio» avanza aunque haya fallidos ────────────────

def testLosFallidosNoBloqueanLaTandaSiguiente(tempDb, monkeypatch):
    from decimal import Decimal

    from core.db import getDb
    from stores import asset_store, fx_historico

    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "1", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "", fecha=fecha) for fecha in ("01-01-2025", "02-01-2025", "03-01-2025")],
    })
    fx_historico._fallosRecientes.clear()
    peticiones = []

    def tasaFalsa(moneda, dia, permitirDescarga=True):
        peticiones.append(dia.day)
        if dia.day == 1:
            return None, "sin datos", ""
        return Decimal("0.9"), "prueba", dia.isoformat()

    monkeypatch.setattr(fx_historico, "tasa", tasaFalsa)

    primera = fx_historico.rellenarPendientes(limite=1)
    segunda = fx_historico.rellenarPendientes(limite=1)

    assert primera["resueltas"] == 1
    assert segunda["resueltas"] == 1
    assert peticiones.count(1) == 1   # el fallido no se vuelve a pedir en la tanda siguiente
    assert getDb().execute("SELECT COUNT(*) FROM activo_rows WHERE fx_rate = ''").fetchone()[0] == 1
    fx_historico._fallosRecientes.clear()


# ── 9: importar un ajuste numérico escrito como texto ────────────────────────

def testUnAjusteNumericoComoTextoSeConvierteYElInvalidoSeInforma():
    from routes.ajustes import _GLOBAL_DEFAULTS, _coercionarImportados

    ajustes, ignorados = _coercionarImportados(
        {"autoBackupDays": "20", "staleHours": "abc", "autoRefreshMinutes": "2.5", "theme": "black"},
        _GLOBAL_DEFAULTS,
    )

    assert ajustes["autoBackupDays"] == 20
    assert sorted(ignorados) == ["autoRefreshMinutes", "staleHours"]
    assert ajustes["theme"] == "black"


def testImportarJsonGuardaElAjusteNumericoYAvisaDelInvalido(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    import io
    import json

    from routes.ajustes import _readAjustes, ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    cuerpo = json.dumps({"tables": {}, "ajustes": {"autoBackupDays": "20", "staleHours": "mucho"}}).encode("utf-8")

    respuesta = client.post("/api/import/json", data={"file": (io.BytesIO(cuerpo), "x.json")},
                            content_type="multipart/form-data", headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["ajustesIgnorados"] == ["staleHours"]
    assert _readAjustes()["autoBackupDays"] == 20


# ── 11: el mensaje del límite dice la espera real ────────────────────────────

@pytest.mark.parametrize("segundos,texto", [
    (1, "1 segundo"), (30, "30 segundos"), (60, "1 minuto"), (2100, "35 minutos"), (7300, "3 horas"),
])
def testElMensajeDelLimiteDiceLaEsperaReal(segundos, texto):
    from core.seguridad_app import textoEspera

    assert textoEspera(segundos) == texto


# ── 12: revisiones en Trading, Operaciones, Stablecoins y Transacciones ──────

_LISTAS_CON_REVISION = [
    ("/api/trading", {"id": "t1", "fecha": "01-01-2025", "moneda": "BTC"},
     {"id": "t2", "fecha": "02-01-2025", "moneda": "ETH"}),
    ("/api/operaciones", {"id": "o1", "assetId": "x", "fechaApertura": "01-01-2025"},
     {"id": "o2", "assetId": "x", "fechaApertura": "02-01-2025"}),
    ("/api/stablecoins", {"id": "s1", "stablecoinSymbol": "USDT", "tipo": "Compra", "cantidad": "10"},
     {"id": "s2", "stablecoinSymbol": "USDT", "tipo": "Compra", "cantidad": "20"}),
    ("/api/transacciones", {"id": "x1", "assetId": "a"}, {"id": "x2", "assetId": "a"}),
]


@pytest.mark.parametrize("ruta,primera,otra", _LISTAS_CON_REVISION)
def testUnaPestanaDesactualizadaNoPisaLoQueGuardoOtra(clienteListas, ruta, primera, otra):
    client, cabeceras = clienteListas
    base = client.get(ruta).get_json()["revision"]
    assert isinstance(base, int)

    # Otra pestaña guarda con la revisión que leyó y la hace avanzar.
    guardado = client.post(ruta, json={"rows": [primera], "revision": base}, headers=cabeceras)
    assert guardado.status_code == 200
    nueva = guardado.get_json()["revision"]
    assert nueva == base + 1

    # La pestaña desactualizada guarda con la revisión vieja: se rechaza y no borra nada.
    rechazado = client.post(ruta, json={"rows": [otra], "revision": base}, headers=cabeceras)
    assert rechazado.status_code == 409
    assert rechazado.get_json()["conflicto"] is True
    assert rechazado.get_json()["revision"] == nueva
    ids = [fila["id"] for fila in client.get(ruta).get_json()["rows"]]
    assert ids == [primera["id"]]

    # Con la revisión actual sí se guarda, y sin revisión se comporta como siempre.
    assert client.post(ruta, json={"rows": [primera, otra], "revision": nueva}, headers=cabeceras).status_code == 200
    assert client.post(ruta, json={"rows": [primera]}, headers=cabeceras).status_code == 200


@pytest.mark.parametrize("ruta,primera,otra", _LISTAS_CON_REVISION)
def testUnaRevisionQueNoEsUnEnteroEsUn400(clienteListas, ruta, primera, otra):
    client, cabeceras = clienteListas

    respuesta = client.post(ruta, json={"rows": [primera], "revision": "abc"}, headers=cabeceras)

    assert respuesta.status_code == 400


def testIdaYVueltaDeDivisaNoPierdeCentimosNiAlteraElResultadoFiscal(clienteAutenticado, tempDb, monkeypatch):
    from decimal import Decimal

    import routes.activos as rutas
    from stores import asset_store, ventas_fifo

    client, cabeceras, _app = clienteAutenticado(rutas.activosBp)
    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "90", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "0.8123", capital="1000", precioParticipacion="100.33")],
    })
    antes = _venderYCalcular("aapl", "90", "0.8571")

    tasa = Decimal("0.8577")
    monkeypatch.setattr(rutas, "convertAmount", lambda valor, origen, destino: (Decimal(valor) * tasa, None))
    for moneda in ("EUR", "USD"):
        respuesta = client.post("/api/activos/aapl/currency", json={"currency": moneda}, headers=cabeceras)
        assert respuesta.status_code == 200

    fila = asset_store.readAssetFile("aapl")["rows"][0]
    assert fila["capitalInvertidoBruto"] == "1000"
    assert fila["precioParticipacion"] == "100.33"
    despues = ventas_fifo.calcularTodo()["filas"][("2025", "v1")]
    for campo in ("costeAdquisicion", "valorTransmision", "dineroDeclarar"):
        assert despues[campo] == antes[campo], campo


# ── E: una variación imposible no se muestra como dato ───────────────────────

def testUnaVariacionImposibleSeDescarta(clienteMercado):
    client, cabeceras, conn = clienteMercado
    # Misma posición (mismo coste) y el valor se multiplica por 50 en una semana.
    _snapshotsDeActivo(conn, 100.0, 100.0, 5000.0, 100.0)

    datos = client.get("/api/historical-changes?period=semana", headers=cabeceras).get_json()["data"]

    assert "acc" not in datos


# ── F: mensajes de importación limpios ───────────────────────────────────────

def testImportarConUnAssetIdInexistenteDice400ConTablaFilaYCampo(tempDb):
    from core.db import getDb
    from routes.ajustes import ImportacionInvalida, _restoreTablesFromDict

    conn = getDb()
    datos = {"tables": {
        "activos": [{"id": "a", "name": "A"}],
        "activo_rows": [{"asset_id": "a", "fecha_operacion": "01-01-2025"},
                        {"asset_id": "no-existe", "fecha_operacion": "02-01-2025"}],
    }}

    with pytest.raises(ImportacionInvalida) as error:
        _restoreTablesFromDict(conn, datos)

    mensaje = str(error.value)
    assert "activo_rows" in mensaje and "fila 2" in mensaje and "asset_id" in mensaje
    assert "FOREIGN KEY" not in mensaje


def testUnNullObligatorioNoMuestraElTextoDeSqlite(tempDb):
    from core.db import getDb
    from routes.ajustes import ImportacionInvalida, _restoreTablesFromDict

    conn = getDb()

    with pytest.raises(ImportacionInvalida) as error:
        _restoreTablesFromDict(conn, {"tables": {"gastos_rows": [
            {"year": "2025", "month": "enero", "cantidad": None}]}})

    mensaje = str(error.value)
    assert "gastos_rows" in mensaje and "cantidad" in mensaje
    assert "constraint" not in mensaje.lower() and "(" not in mensaje


# ── G: un ajuste inválido conserva el valor que ya tenía ─────────────────────

def testUnAjusteInvalidoConservaSuValorAnterior(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    import io
    import json

    from routes.ajustes import _readAjustes, _writeAjustes, ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)
    _writeAjustes({"autoRefreshMinutes": 5, "staleHours": 48})
    cuerpo = json.dumps({"tables": {}, "ajustes": {"autoRefreshMinutes": "abc", "staleHours": "12"}}).encode("utf-8")

    respuesta = client.post("/api/import/json", data={"file": (io.BytesIO(cuerpo), "x.json")},
                            content_type="multipart/form-data", headers=cabeceras)

    assert respuesta.get_json()["ajustesIgnorados"] == ["autoRefreshMinutes"]
    ajustes = _readAjustes()
    assert ajustes["autoRefreshMinutes"] == 5   # conserva el de antes, no el 0 de fábrica
    assert ajustes["staleHours"] == 12


# ── H: el servidor calcula el snapshot manual e ignora los totales del navegador ─

def testElSnapshotManualGuardaLosTotalesDelServidor(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from core.db import getDb
    from routes.snapshots import snapshotsBp
    from stores import asset_store

    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 3600)
    client, cabeceras, _app = clienteAutenticado(snapshotsBp)
    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "12", "currency": "EUR", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "10",
                  "capitalInvertidoBruto": "100", "currency": "EUR"}],
    })

    respuesta = client.post("/api/portfolio/snapshot",
                            json={"total_value": 120.4, "total_invested": 99999, "assets": [{"id": "x", "v": 1}]},
                            headers=cabeceras)

    assert respuesta.get_json()["skipped"] is False
    fila = getDb().execute("SELECT total_value, total_invested FROM portfolio_snapshots").fetchone()
    assert (fila["total_value"], fila["total_invested"]) == (120.0, 100.0)
    assert getDb().execute("SELECT COUNT(*) FROM asset_snapshots WHERE asset_id = 'x'").fetchone()[0] == 0


def testElSnapshotManualSinPosicionesNoGuardaNada(clienteAutenticado, datosAislados, tempDb):
    from core.db import getDb
    from routes.snapshots import snapshotsBp

    client, cabeceras, _app = clienteAutenticado(snapshotsBp)

    respuesta = client.post("/api/portfolio/snapshot", json={"total_value": 500, "total_invested": 400},
                            headers=cabeceras)

    assert respuesta.get_json()["skipped"] is True
    assert getDb().execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0] == 0


# ── B: dos filas con el mismo id son un 400, no un 500 ───────────────────────

@pytest.mark.parametrize("ruta,primera,otra", _LISTAS_CON_REVISION)
def testDosFilasConElMismoIdSonUn400(clienteListas, ruta, primera, otra):
    client, cabeceras = clienteListas

    respuesta = client.post(ruta, json={"rows": [primera, {**otra, "id": primera["id"]}]}, headers=cabeceras)

    assert respuesta.status_code == 400
    assert primera["id"] in respuesta.get_json()["error"]


# ── Quinta tanda: la valoración del servidor cuenta lo mismo que el navegador ─

def _casoDePosicion():
    import json
    from pathlib import Path

    return json.loads((Path(__file__).resolve().parent.parent / "tests-js" / "posicion-casos.json")
                      .read_text(encoding="utf-8"))


def _cargarCasoDePosicion(caso):
    from core.db import getDb
    from stores import asset_store
    from stores.ventas_store import writeVentasYear

    asset_store.writeAssetFile(caso["asset"]["id"], caso["asset"])
    writeVentasYear("2025", {"year": "2025", "rows": [
        {"id": v["id"], "fecha": v["fecha"], "assetId": v["assetId"], "cantidad": v["cantidad"], "valorVenta": "1"}
        for v in caso["ventas"]]})
    conn = getDb()
    for t in caso["transacciones"]:
        conn.execute(
            "INSERT INTO transacciones (id, asset_id, fecha_operacion, total, comision_red, wallet_tipo) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (t["id"], t["assetId"], t["fechaOperacion"], t["total"], t["comisionRed"], t["walletTipo"]))
    conn.commit()


def testLaCarteraDelServidorTieneLasMismasParticipacionesQueElNavegador(tempDb):
    from decimal import Decimal

    from stores import ventas_fifo

    caso = _casoDePosicion()
    _cargarCasoDePosicion(caso)

    cartera = ventas_fifo.carteraViva()

    assert cartera["btc"]["cantidad"] == Decimal(caso["cantidadEsperada"])


def testLaValoracionDelServidorUsaEsasParticipaciones(tempDb):
    from stores import valoracion

    caso = _casoDePosicion()
    _cargarCasoDePosicion(caso)

    resultado = valoracion.valorarPortfolio(refrescarPrecios=False)

    # Las participaciones del caso a 100 EUR cada una.
    assert resultado["total_value"] == pytest.approx(float(caso["cantidadEsperada"]) * 100)


def testElRendimientoYElBatchCuentanLasMismasParticipaciones(clienteAutenticado, tempDb):
    from routes.activos import activosBp

    client, _cabeceras, _app = clienteAutenticado(activosBp)
    caso = _casoDePosicion()
    _cargarCasoDePosicion(caso)

    datos = client.get("/api/activos/rendimiento-batch").get_json()["btc"]

    assert datos["netoActual"] == pytest.approx(float(caso["cantidadEsperada"]) * 100)


def testElSnapshotManualNoSeGuardaSiElNavegadorYElServidorNoCoinciden(
        clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from core.db import getDb
    from routes.snapshots import snapshotsBp
    from stores import asset_store

    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 3600)
    client, cabeceras, _app = clienteAutenticado(snapshotsBp)
    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "12", "currency": "EUR", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "10",
                  "capitalInvertidoBruto": "100", "currency": "EUR"}],
    })

    respuesta = client.post("/api/portfolio/snapshot", json={"total_value": 238800, "total_invested": 100},
                            headers=cabeceras)

    assert respuesta.get_json()["skipped"] is True
    assert getDb().execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0] == 0


def testUnAssetIdVacioDiceQueFaltaElCampoObligatorio(tempDb):
    from core.db import getDb
    from routes.ajustes import ImportacionInvalida, _restoreTablesFromDict

    conn = getDb()

    with pytest.raises(ImportacionInvalida) as error:
        _restoreTablesFromDict(conn, {"tables": {
            "activos": [{"id": "a", "name": "A"}],
            "activo_rows": [{"asset_id": "", "fecha_operacion": "01-01-2025"}],
        }})

    assert str(error.value) == "Tabla «activo_rows», fila 1: falta el campo obligatorio «asset_id»"


# ── Sexta tanda A: un solo invertido, el de la ficha ─────────────────────────

@pytest.fixture
def cambioDelCaso(monkeypatch):
    """Cambio USD/EUR fijo, el mismo que usa el caso compartido con el navegador."""
    from decimal import Decimal

    from stores import fx_historico

    tasa = Decimal(_casoDePosicion()["tipoUsdEur"])
    monkeypatch.setattr(fx_historico, "tasaActual", lambda moneda, permitirDescarga=True: (None, "prueba", ""))
    monkeypatch.setattr(fx_historico, "fetchExchangeRate", lambda moneda, destino, timeout=None: (float(tasa), None))
    from providers import finnhub_client

    finnhub_client.clearExchangeRateCache()


def testElInvertidoDelServidorEsElDeLaFichaDelNavegador(tempDb, cambioDelCaso):
    from decimal import Decimal

    from stores import ventas_fifo

    caso = _casoDePosicion()
    _cargarCasoDePosicion(caso)

    posicion = ventas_fifo.carteraViva()["btc"]

    assert posicion["coste"] == pytest.approx(Decimal(caso["invertidoBrutoEsperado"]), abs=Decimal("1e-6"))
    assert posicion["invertido"] == pytest.approx(Decimal(caso["invertidoNetoEsperado"]), abs=Decimal("1e-6"))
    assert posicion["cantidad"] == Decimal(caso["cantidadEsperada"])


def testListaBatchYSnapshotDanElMismoInvertido(clienteAutenticado, tempDb, cambioDelCaso):
    from routes.activos import activosBp
    from stores import valoracion
    from stores.asset_store import listAssets

    client, _cabeceras, _app = clienteAutenticado(activosBp)
    caso = _casoDePosicion()
    _cargarCasoDePosicion(caso)
    esperado = round(float(caso["invertidoNetoEsperado"]), 2)

    lista = next(a for a in listAssets() if a["id"] == "btc")["invertidoNeto"]
    batch = client.get("/api/activos/rendimiento-batch").get_json()["btc"]["invertidoNeto"]
    snapshot = valoracion.valorarPortfolio(refrescarPrecios=False)
    desglose = next(a for a in snapshot["assets"] if a["id"] == "btc")["c"]

    assert lista == batch == desglose == esperado
    assert snapshot["total_invested"] == esperado


# ── Sexta tanda B y C: el servidor guarda lo suyo y dice por qué omite ───────

@pytest.fixture
def snapshotConPosicion(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.snapshots import snapshotsBp
    from stores import asset_store

    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 3600)
    client, cabeceras, _app = clienteAutenticado(snapshotsBp)
    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "12", "currency": "EUR", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "10",
                  "capitalInvertido": "", "capitalInvertidoBruto": "100", "currency": "EUR"}],
    })
    return client, cabeceras


def _enviar(client, cabeceras, valor=120.0):
    return client.post("/api/portfolio/snapshot", json={"total_value": valor, "total_invested": 100},
                       headers=cabeceras).get_json()


def testElSnapshotManualGuardaSiempreElTotalDelServidorDentroDeLaTolerancia(snapshotConPosicion):
    from core.db import getDb

    client, cabeceras = snapshotConPosicion

    respuesta = _enviar(client, cabeceras, valor=121.9)   # el navegador dice 121,9; el servidor, 120

    assert respuesta["skipped"] is False and respuesta["total_value"] == 120.0
    assert getDb().execute("SELECT total_value FROM portfolio_snapshots").fetchone()[0] == 120.0


def testCadaOmisionDiceSuMotivo(snapshotConPosicion, clienteAutenticado):
    from routes.backup import bloqueoRestauracion

    client, cabeceras = snapshotConPosicion

    assert _enviar(client, cabeceras, valor=5000)["motivo"] == "totales_distintos"
    with bloqueoRestauracion():
        assert _enviar(client, cabeceras)["motivo"] == "importacion_en_curso"
    assert _enviar(client, cabeceras)["skipped"] is False
    assert _enviar(client, cabeceras)["motivo"] == "tramo_ocupado"
    sinTotales = client.post("/api/portfolio/snapshot", json={}, headers=cabeceras).get_json()
    assert sinTotales["motivo"] == "sin_totales"
    sinPrecios = client.post("/api/portfolio/snapshot", json={"total_value": 0, "total_invested": 5},
                             headers=cabeceras).get_json()
    assert sinPrecios["motivo"] == "pestana_sin_precios"


def testSinPosicionesYValoracionIncompletaTienenMotivoPropio(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.snapshots import snapshotsBp
    from stores import asset_store, valoracion

    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 3600)
    client, cabeceras, _app = clienteAutenticado(snapshotsBp)

    assert _enviar(client, cabeceras)["motivo"] == "sin_posiciones"

    asset_store.writeAssetFile("usd", {
        "name": "USD", "type": "acciones", "price": "10", "currency": "USD", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                  "capitalInvertidoBruto": "10", "currency": "USD"}],
    })
    monkeypatch.setattr(valoracion, "fetchExchangeRate", lambda origen, destino: (None, "sin red"))
    assert _enviar(client, cabeceras, valor=10)["motivo"] == "valoracion_incompleta"


# ── Sexta tanda D: lo que guarda el cambio de divisa se lee igual en todas partes ─

@pytest.mark.parametrize("texto,esperado", [
    ("89.381", "89.381"), ("893.81", "893.81"), ("1000", "1000"),
    ("0.00011135", "0.00011135"), ("1234.56789012", "1234.56789012"), ("100.33", "100.33"),
])
def testLosImportesConvertidosSeLeenConLosParsersDelServidor(texto, esperado):
    from decimal import Decimal

    from core import dinero
    from stores.helpers import parseLooseNumber

    assert dinero.aDecimal(texto) == Decimal(esperado)
    assert parseLooseNumber(texto) == Decimal(esperado)


def testLoQueGuardaElCambioDeDivisaVuelveALeerseIgual(clienteAutenticado, tempDb, monkeypatch):
    from decimal import Decimal

    import routes.activos as rutas
    from core import dinero
    from stores import asset_store

    client, cabeceras, _app = clienteAutenticado(rutas.activosBp)
    asset_store.writeAssetFile("aapl", {
        "name": "AAPL", "type": "acciones", "price": "90", "currency": "USD",
        "rows": [_compraEnDivisa("USD", "0.9", capital="100", precioParticipacion="100.33")],
    })
    monkeypatch.setattr(rutas, "convertAmount", lambda valor, origen, destino: (Decimal(valor) * Decimal("0.89"), None))

    assert client.post("/api/activos/aapl/currency", json={"currency": "EUR"}, headers=cabeceras).status_code == 200
    fila = asset_store.readAssetFile("aapl")["rows"][0]

    # 100,33 USD x 0,89 = 89,2937: sin separador de miles y con punto decimal.
    assert fila["precioParticipacion"] == "89.2937"
    assert "," not in fila["precioParticipacion"]
    assert dinero.aDecimal(fila["precioParticipacion"]) == Decimal("89.2937")
    assert dinero.aDecimal(fila["capitalInvertidoBruto"]) == Decimal("89")


# ── Sexta tanda E: script de detección de snapshots mal valorados ────────────

def _cargarDetector():
    import importlib.util
    from pathlib import Path

    ruta = Path(__file__).resolve().parent.parent / "tools" / "detectar_snapshots_erroneos.py"
    especificacion = importlib.util.spec_from_file_location("detectar_snapshots_erroneos", ruta)
    modulo = importlib.util.module_from_spec(especificacion)
    especificacion.loader.exec_module(modulo)
    return modulo


def _carteraConSnapshots(tempDb, serie, capital="100000", **extra):
    # `serie` es una lista de (total, invertido) cada 5 minutos desde un instante fijo.
    from core.db import getDb

    _activoConPosicion("fondo", "100,00", participaciones="1000", capital=capital, **extra)
    conn = getDb()
    for indice, (total, invertido) in enumerate(serie):
        conn.execute("INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
                     (1_790_000_000 + indice * 300, total, invertido))
    conn.commit()
    return conn


def testElDetectorListaLosPuntosFalsosSinTocarLaBase(tempDb, capsys):
    detector = _cargarDetector()
    # Cartera de 238.000 euros con 100.000 invertidos y un tramo de 6 puntos a 120.000 con 60.000.
    serie = [(120_000.0 + i, 60_000.0) if 40 <= i < 46 else (238_000.0 + i, 100_000.0) for i in range(80)]
    conn = _carteraConSnapshots(tempDb, serie)

    codigo = detector.main([str(tempDb)])

    salida = capsys.readouterr().out
    assert codigo == 1
    assert "1 tramos candidatos (6 puntos)" in salida and "No se ha borrado nada" in salida
    assert conn.execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0] == 80


def testElDetectorNoMarcaLosPuntosBuenosQueUnaZonaDeFalsosRodea(tempDb):
    detector = _cargarDetector()
    # Los falsos (120.000 / 60.000) dominan la zona: por nivel, los buenos parecerian el error.
    serie = [(238_000.0, 100_000.0)] * 10
    serie += [(120_000.0, 60_000.0)] * 3 + [(238_000.0, 100_000.0)] * 5 + [(120_000.0, 60_000.0)] * 9
    serie += [(238_000.0, 100_000.0)] * 10
    conn = _carteraConSnapshots(tempDb, serie)

    tramos = detector.detectarCandidatos(conn)

    assert [(t["puntos"]) for t in tramos] == [3, 9]


def testElDetectorIgnoraUnaDiscrepanciaContinuaPorUnaOperacionRetroactiva(tempDb):
    detector = _cargarDetector()
    # Los snapshots se guardaron antes de apuntar la compra con fecha antigua:
    # discrepan hasta el final sin puntos buenos detras, no es un error de valoracion.
    serie = [(238_000.0, 100_000.0)] * 20 + [(238_000.0, 60_000.0)] * 30
    conn = _carteraConSnapshots(tempDb, serie)

    assert detector.detectarCandidatos(conn) == []


def testElDetectorNoMarcaUnNivelDistintoSiElInvertidoCuadra(tempDb):
    detector = _cargarDetector()
    serie = [(238_000.0, 100_000.0)] * 20 + [(120_000.0, 100_000.0)] * 4 + [(238_000.0, 100_000.0)] * 20
    conn = _carteraConSnapshots(tempDb, serie)

    assert detector.detectarCandidatos(conn) == []


def testElInvertidoReconstruidoCuentaLasFilasSinFechaLegible(tempDb):
    from datetime import date

    detector = _cargarDetector()
    conn = _carteraConSnapshots(tempDb, [(1.0, 1.0)])
    conn.row_factory = __import__("sqlite3").Row
    from stores import asset_store

    asset_store.writeAssetFile("fondo", {
        "name": "fondo", "type": "acciones", "price": "100,00", "currency": "EUR", "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "10",
                  "capitalInvertidoBruto": "1000", "currency": "EUR"},
                 {"fechaOperacion": "texto", "tipoOperacion": "Compra", "participaciones": "5",
                  "capitalInvertidoBruto": "500", "currency": "EUR"}],
    })
    posiciones = detector.posiciones_.cargarPosiciones(conn)
    activos = {f["id"]: f for f in conn.execute("SELECT id, type, currency FROM activos")}
    tipo = detector._tipoDeLaBase(conn)

    # Antes de la primera compra solo existe la fila sin fecha, que el servidor cuenta siempre.
    assert detector.invertidoReconstruido(posiciones, activos, date(2024, 1, 1), tipo) == pytest.approx(500.0)
    assert detector.invertidoReconstruido(posiciones, activos, date(2026, 1, 1), tipo) == pytest.approx(1500.0)


def testElDetectorNoMarcaUnCambioDeNivelQueSeMantiene(tmp_path):
    detector = _cargarDetector()
    puntos = [(1_790_000_000 + i * 300, 100_000.0 if i < 40 else 160_000.0, 1.0) for i in range(80)]

    assert detector.detectar(puntos) == []


# ── Séptima tanda (B-24): el flujo de dinero de cada snapshot ────────────────

def _compra(fecha, participaciones, precio, comisiones="0", **extra):
    return {"fechaOperacion": fecha, "tipoOperacion": "Compra", "participaciones": participaciones,
            "precioParticipacion": precio, "comisiones": comisiones, "currency": "EUR", **extra}


def _tomar(conn):
    from stores import flujos_snapshot

    flujo = flujos_snapshot.tomarFlujo(conn)
    conn.commit()
    return flujo


def testLaMigracion25CreaLaColumnaYLaBase(tempDb):
    from core import db
    from core.db import getDb

    conn = getDb()

    assert db.ESQUEMA_VERSION >= 25
    assert "flujo" in {f[1] for f in conn.execute("PRAGMA table_info(portfolio_snapshots)")}
    assert conn.execute("SELECT COUNT(*) FROM snapshot_flujo_base").fetchone()[0] == 0


def testElPrimerSnapshotFijaLaBaseYLosSiguientesGuardanElFlujo(tempDb):
    from core.db import getDb
    from stores import asset_store
    from stores.ventas_store import writeVentasYear

    conn = getDb()
    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "15", "currency": "EUR",
        "rows": [_compra("01-01-2025", "10", "10", comisiones="2")],
    })

    assert _tomar(conn) is None                      # sin snapshot anterior con el que comparar
    assert _tomar(conn) == 0.0                       # nada ha cambiado

    # Una venta de 4 a 15 con 1 de comisión: se cobran 59 netos (sale de la cartera).
    writeVentasYear("2025", {"year": "2025", "rows": [
        {"id": "v1", "fecha": "02-02-2025", "assetId": "acc", "cantidad": "4", "valorVenta": "15",
         "comisionVenta": "1"}]})
    assert _tomar(conn) == pytest.approx(-59.0)

    # Una compra de 5 a 10 con 1 de comisión: la comisión va dentro del importe, salen 50.
    asset_store.writeAssetFile("acc", {
        "name": "Acc", "type": "acciones", "price": "15", "currency": "EUR",
        "rows": [_compra("01-01-2025", "10", "10", comisiones="2"), _compra("03-03-2025", "5", "10", comisiones="1")],
    })
    assert _tomar(conn) == pytest.approx(50.0)


def testUnaOperacionRetroactivaEntraEnElSiguienteSnapshotYNoReescribeLosAnteriores(tempDb):
    from core.db import getDb
    from stores import asset_store

    conn = getDb()
    ficha = {"name": "Acc", "type": "acciones", "price": "10", "currency": "EUR",
             "rows": [_compra("01-01-2025", "10", "10")]}
    asset_store.writeAssetFile("acc", ficha)
    _tomar(conn)
    anterior = _tomar(conn)

    # Hoy se apunta una compra de 2020: es un flujo de este tramo, no de 2020.
    ficha["rows"].append(_compra("05-05-2020", "3", "10"))
    asset_store.writeAssetFile("acc", ficha)

    assert anterior == 0.0
    assert _tomar(conn) == pytest.approx(30.0)
    assert _tomar(conn) == 0.0


def testUnaOperacionSinTipoDeCambioDejaElFlujoVacioMientrasCambieElConjunto(tempDb):
    from core.db import getDb
    from stores import asset_store

    conn = getDb()
    ficha = {"name": "Acc", "type": "acciones", "price": "10", "currency": "USD",
             "rows": [_compra("01-01-2025", "10", "10", currency="USD", fxRate="")]}
    asset_store.writeAssetFile("acc", ficha)
    _tomar(conn)

    # Sigue sin poderse convertir la misma operación: el conjunto de pendientes no
    # cambia y el resto de movimientos vuelve a ser fiable.
    ficha["rows"].append(_compra("02-01-2025", "1", "10"))
    asset_store.writeAssetFile("acc", ficha)
    assert _tomar(conn) == pytest.approx(10.0)

    # Aparece otra operación sin tipo: este tramo no se puede dar.
    ficha["rows"].append(_compra("03-01-2025", "1", "10", currency="USD", fxRate=""))
    asset_store.writeAssetFile("acc", ficha)
    assert _tomar(conn) is None

    # Le llega el tipo de cambio: cambia otra vez el conjunto, otro tramo sin dato.
    conn.execute("UPDATE activo_rows SET fx_rate = '0.9' WHERE currency = 'USD'")
    conn.commit()
    assert _tomar(conn) is None
    assert _tomar(conn) == 0.0


def testUnImporteIlegibleNoSeInventa(tempDb):
    from core.db import getDb
    from stores import asset_store

    conn = getDb()
    ficha = {"name": "Acc", "type": "acciones", "price": "10", "currency": "EUR",
             "rows": [_compra("01-01-2025", "10", "10")]}
    asset_store.writeAssetFile("acc", ficha)
    _tomar(conn)

    ficha["rows"].append(_compra("02-01-2025", "5", "1.2.3"))
    asset_store.writeAssetFile("acc", ficha)

    assert _tomar(conn) is None


def testElSnapshotGuardaSuFlujoEnLaColumna(tempDb, monkeypatch):
    from core.db import getDb
    from routes.snapshots import guardarSnapshot
    from stores import asset_store

    conn = getDb()
    ficha = {"name": "Acc", "type": "acciones", "price": "10", "currency": "EUR",
             "rows": [_compra("01-01-2025", "10", "10")]}
    asset_store.writeAssetFile("acc", ficha)
    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 60)

    assert guardarSnapshot(100, 100, nowTs=1_000_000) is True
    ficha["rows"].append(_compra("02-01-2025", "5", "10", comisiones="1"))
    asset_store.writeAssetFile("acc", ficha)
    assert guardarSnapshot(151, 150, nowTs=1_000_000 + 600) is True

    flujos = [r[0] for r in conn.execute("SELECT flujo FROM portfolio_snapshots ORDER BY ts")]
    assert flujos[0] is None and flujos[1] == pytest.approx(50.0)


def _serie(*puntos):
    dia = 86400
    base = 1_790_000_000 - 1_790_000_000 % dia + 12 * 3600
    serie = []
    for n, (v, i, f) in enumerate(puntos):
        punto = {"ts": base + n * dia, "v": v, "i": i}
        if f is not None:
            punto["f"] = f
        serie.append(punto)
    return serie


def testUnaVentaConGananciaNoHacePerderRendimientoSiElFlujoEsReal():
    from core import rentabilidad

    # 1.000 -> 1.500 (+50 %); se cobran 750 de los 1.500 (el coste vendido es 500).
    conFlujo = rentabilidad.resumen(_serie((1000, 1000, 0), (1500, 1000, 0), (750, 500, -750)))
    estimado = rentabilidad.resumen(_serie((1000, 1000, None), (1500, 1000, None), (750, 500, None)))

    assert conFlujo["twr"]["total"] == pytest.approx(0.5)
    assert conFlujo["twr"]["estimado"] is False and conFlujo["xirrEstimado"] is False
    assert conFlujo["flujos"]["reales"] == 2 and conFlujo["flujos"]["estimados"] == 0
    # Con la variación del invertido (-500) la ganancia realizada de 250 desaparece del rendimiento.
    assert estimado["twr"]["total"] < conFlujo["twr"]["total"]
    assert estimado["twr"]["estimado"] is True and estimado["xirrEstimado"] is True
    assert estimado["flujos"]["estimados"] == 2


def testUnTramoSinFlujoSeEstimaYElRestoEsReal():
    from core import rentabilidad

    resumen = rentabilidad.resumen(_serie((1000, 1000, 0), (1100, 1100, None), (1200, 1100, 0)))

    assert [t["estimado"] for t in resumen["flujos"]["serie"]] == [True, False]
    assert resumen["flujos"]["serie"][0]["flujo"] == pytest.approx(100.0)


def testLosFlujosDeLosSnapshotsDeUnMismoDiaSeSuman():
    from core import rentabilidad

    dia = 86400
    base = 1_790_000_000 - 1_790_000_000 % dia + 3600
    snaps = [
        {"ts": base, "v": 1000, "i": 1000, "f": 0},
        {"ts": base + dia, "v": 1000, "i": 1000, "f": 100},
        {"ts": base + dia + 3600, "v": 1000, "i": 1000, "f": 50},
    ]

    serie = rentabilidad.serieDiaria(snaps)

    assert serie[-1]["f"] == pytest.approx(150.0)


def testLaApiDeRentabilidadDevuelveLosFlujosPorTramo(clienteAutenticado, tempDb):
    from core.db import getDb
    from routes.snapshots import snapshotsBp

    client, cabeceras, _app = clienteAutenticado(snapshotsBp)
    conn = getDb()
    dia = 86400
    base = 1_790_000_000 - 1_790_000_000 % dia + 12 * 3600
    for n, (v, i, f) in enumerate([(1000, 1000, None), (1500, 1000, 0.0), (750, 500, -750.0)]):
        conn.execute("INSERT INTO portfolio_snapshots (ts, total_value, total_invested, flujo) VALUES (?,?,?,?)",
                     (base + n * dia, v, i, f))
    conn.commit()

    datos = client.get("/api/portfolio/rentabilidad", headers=cabeceras).get_json()
    historia = client.get("/api/portfolio/history?range=ALL", headers=cabeceras).get_json()["data"]

    assert [p["f"] for p in historia] == [None, 0.0, -750.0]
    assert datos["flujos"]["reales"] == 2 and datos["flujos"]["serie"][-1]["flujo"] == -750.0


# ── Octava tanda: un cuerpo JSON que no es un objeto es un 400, no un 500 ────

@pytest.mark.parametrize("metodo,ruta", [
    ("post", "/api/settings"),
    ("post", "/api/settings/apikey"),
    ("delete", "/api/settings/apikey"),
    ("post", "/api/settings/apis-pausadas"),
    ("post", "/api/settings/telegram"),
    ("post", "/api/settings/telegram/avisos"),
])
@pytest.mark.parametrize("cuerpo", [[1, 2], "texto", 5])
def testLasRutasDeAjustesRechazanUnCuerpoQueNoEsUnObjeto(
        clienteAutenticado, datosAislados, tempDb, monkeypatch, metodo, ruta, cuerpo):
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)

    respuesta = getattr(client, metodo)(ruta, json=cuerpo, headers=cabeceras)

    assert respuesta.status_code == 400


@pytest.mark.parametrize("metodo,ruta", [
    ("post", "/api/settings"),
    ("post", "/api/settings/apikey"),
    ("delete", "/api/settings/apikey"),
    ("post", "/api/settings/apis-pausadas"),
    ("post", "/api/settings/telegram"),
    ("post", "/api/settings/telegram/avisos"),
])
def testSinCuerpoOConNullLasRutasDeAjustesDan400(clienteAutenticado, datosAislados, tempDb, monkeypatch, metodo, ruta):
    # El JS manda siempre un cuerpo a estas rutas: sin él (o con null) no hay nada que guardar.
    from routes.ajustes import ajustesBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    monkeypatch.setenv("ESCRITURAS_PESADAS_POR_HORA", "0")
    client, cabeceras, _app = clienteAutenticado(ajustesBp)

    assert getattr(client, metodo)(ruta, headers=cabeceras).status_code == 400
    assert getattr(client, metodo)(ruta, json=None, headers=cabeceras).status_code == 400


# ── Novena tanda 1: la política de reserva cuando falta un precio o un cambio ─

def _activoConPosicion(assetId, precio, participaciones="10", capital="100", moneda="EUR", **extra):
    from stores import asset_store

    asset_store.writeAssetFile(assetId, {
        "name": assetId, "type": "acciones", "price": precio, "currency": moneda, "marketSymbol": "",
        "rows": [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": participaciones,
                  "capitalInvertidoBruto": capital, "currency": moneda, **extra}],
    })


def testUnActivoQueTuvoPrecioSeValoraConElUltimoConocido(tempDb):
    import time

    from core.db import getDb
    from stores import valoracion

    _activoConPosicion("grande", "100,00", participaciones="100", capital="9000")
    _activoConPosicion("caido", "0,00", participaciones="10", capital="100")
    conn = getDb()
    # Hace una hora la posición (10 participaciones) valía 120 €: 12 € cada una.
    conn.execute("INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, 'caido', 120, 100)",
                 (int(time.time()) - 3600,))
    conn.commit()

    resultado = valoracion.valorarPortfolio(refrescarPrecios=False)

    assert resultado["completa"] is True
    assert resultado["fallbacks"] == [{"id": "caido", "motivo": "ultimo_precio_conocido"}]
    assert next(a for a in resultado["assets"] if a["id"] == "caido")["v"] == 120.0
    assert resultado["total_value"] == pytest.approx(10_120.0)


def testUnActivoQueNuncaTuvoPrecioSeValoraASuCoste(tempDb):
    from stores import valoracion

    _activoConPosicion("grande", "100,00", participaciones="100", capital="9000")
    _activoConPosicion("nuevo", "0,00", participaciones="10", capital="100", comisiones="2")

    resultado = valoracion.valorarPortfolio(refrescarPrecios=False)

    assert resultado["completa"] is True
    assert resultado["fallbacks"] == [{"id": "nuevo", "motivo": "sin_precio_valorado_a_coste"}]
    # A su invertido neto (100 - 2 de comisión), no a 0.
    assert next(a for a in resultado["assets"] if a["id"] == "nuevo")["v"] == 98.0


def testSiLoValoradoDeReservaPesaDemasiadoElSnapshotSeOmite(tempDb):
    from stores import valoracion

    _activoConPosicion("pequeno", "10,00", participaciones="10", capital="100")
    _activoConPosicion("nuevo", "0,00", participaciones="10", capital="100")

    resultado = valoracion.valorarPortfolio(refrescarPrecios=False)

    assert resultado["completa"] is False
    assert [f["id"] for f in resultado["fallbacks"]] == ["nuevo"]


def testSinCambioDelProveedorSeUsaElUltimoDeLaCacheYSinNingunoSeOmite(tempDb, monkeypatch):
    from datetime import date

    from core.db import getDb
    from stores import valoracion

    _activoConPosicion("usd", "10,00", participaciones="10", capital="100", moneda="USD")
    monkeypatch.setattr(valoracion, "fetchExchangeRate", lambda origen, destino: (None, "sin red"))

    assert valoracion.valorarPortfolio(refrescarPrecios=False)["completa"] is False

    conn = getDb()
    conn.execute("INSERT INTO fx_rates (par, fecha, rate, origen) VALUES ('USD/EUR', ?, '0.9', 'prueba')",
                 (date.today().isoformat(),))
    conn.commit()
    resultado = valoracion.valorarPortfolio(refrescarPrecios=False)

    assert resultado["completa"] is True
    assert resultado["tiposObsoletos"] == ["USD"]
    assert resultado["total_value"] == pytest.approx(90.0)


def testElAvisoDeFallbackSaleUnaVezTrasMuchasHoras(tempDb, monkeypatch):
    from core import telegram_notifier
    from stores import valoracion

    avisos = []
    monkeypatch.setattr(telegram_notifier, "notificar", lambda categoria, texto, **kw: avisos.append((categoria, kw)))
    fallback = [{"id": "nuevo", "motivo": "sin_precio_valorado_a_coste"}]
    valoracion._guardarEstado({})

    valoracion.registrarFallbacks(fallback, ahora=1_000_000)
    valoracion.registrarFallbacks(fallback, ahora=1_000_000 + 3 * 3600)
    assert avisos == []

    valoracion.registrarFallbacks(fallback, ahora=1_000_000 + 7 * 3600)
    assert len(avisos) == 1
    # La coordinación entre workers y la espera larga evitan que se repita.
    assert avisos[0][1]["compartido"] is True and avisos[0][1]["cooldown"] >= 86400

    # Si el activo se arregla y vuelve a fallar, empieza otra cuenta.
    valoracion.registrarFallbacks([], ahora=1_000_000 + 8 * 3600)
    valoracion.registrarFallbacks(fallback, ahora=1_000_000 + 9 * 3600)
    assert len(avisos) == 1


def testElAvisoDeSnapshotsOmitidosSaleTrasMasDeUnaHora(tempDb, monkeypatch):
    from core import telegram_notifier
    from stores import valoracion

    avisos = []
    monkeypatch.setattr(telegram_notifier, "notificar", lambda categoria, texto, **kw: avisos.append(categoria))
    valoracion._guardarEstado({})

    valoracion.registrarOmision(True, ahora=2_000_000)
    valoracion.registrarOmision(True, ahora=2_000_000 + 1800)
    assert avisos == []

    valoracion.registrarOmision(True, ahora=2_000_000 + 3700)
    assert avisos == ["sistema"]

    valoracion.registrarOmision(False, ahora=2_000_000 + 4000)
    valoracion.registrarOmision(True, ahora=2_000_000 + 4100)
    valoracion.registrarOmision(True, ahora=2_000_000 + 4200)
    assert avisos == ["sistema"]


def testElSnapshotAutomaticoSeGuardaConUnActivoSinPrecioPequeno(tempDb, monkeypatch):
    from admin import snapshot_scheduler
    from core.db import getDb

    monkeypatch.setattr(snapshot_scheduler, "_rutasObjetivo", lambda: [tempDb])
    monkeypatch.setattr("routes.snapshots._intervalSeconds", lambda: 3600)
    _activoConPosicion("grande", "100,00", participaciones="100", capital="9000")
    _activoConPosicion("nuevo", "0,00", participaciones="10", capital="100")

    assert snapshot_scheduler.ejecutarUnaVez(refrescarPrecios=False) == 1
    assert getDb().execute("SELECT total_value FROM portfolio_snapshots").fetchone()[0] == pytest.approx(10_100.0)


# ── Novena tanda 2: la comisión en el flujo, según la convención de cada fuente ─

def testEnLaFichaElCapitalYaIncluyeLaComision(tempDb):
    from core.db import getDb
    from stores import asset_store

    conn = getDb()
    ficha = {"name": "XAU", "type": "comoditis", "price": "40", "currency": "EUR", "rows": []}
    asset_store.writeAssetFile("xau", ficha)
    _tomar(conn)

    # 35 € con 1 € de comisión: el invertido neto es 34 y del bolsillo salen 35.
    ficha["rows"] = [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                      "capitalInvertidoBruto": "35", "comisiones": "1", "currency": "EUR"}]
    asset_store.writeAssetFile("xau", ficha)

    assert _tomar(conn) == pytest.approx(35.0)


def testEnLaFichaDeCriptoTampocoSeSumaLaComisionFiat(tempDb):
    from core.db import getDb
    from stores import asset_store

    conn = getDb()
    ficha = {"name": "BTC", "type": "cripto", "price": "100", "currency": "EUR", "rows": []}
    asset_store.writeAssetFile("btc", ficha)
    _tomar(conn)

    ficha["rows"] = [{"fechaOperacion": "01-01-2025", "tipoOperacion": "Compra", "participaciones": "1",
                      "capitalInvertidoBruto": "100", "comisionesFiat": "2", "currency": "EUR"}]
    asset_store.writeAssetFile("btc", ficha)

    assert _tomar(conn) == pytest.approx(100.0)


def testEnOperacionesLaComisionVaAparteDelPrecio(tempDb):
    from core.db import getDb
    from stores import asset_store, helpers

    conn = getDb()
    asset_store.writeAssetFile("btc", {"name": "BTC", "type": "cripto", "price": "100", "currency": "EUR"})
    _tomar(conn)

    operacion = {"id": "o1", "assetId": "btc", "estado": "Completado", "orden": "Compra", "cantidad": "3",
                 "precioOrden": "10", "precioCurrency": "EUR", "total": "31", "currency": "EUR",
                 "comisionesFiat": "1", "fechaApertura": "01-01-2025"}
    helpers.syncCompletedOperationsIntoAssets([operacion])
    # Precio de la orden por cantidad (30) más la comisión en euros (1).
    assert _tomar(conn) == pytest.approx(31.0)

    venta = {**operacion, "id": "o2", "orden": "Venta", "cantidad": "2", "precioOrden": "12"}
    helpers.syncCompletedOperationsIntoAssets([operacion, venta])
    # Se cobran 2 x 12 menos 1 de comisión.
    assert _tomar(conn) == pytest.approx(-23.0)


def testEnVentasLaComisionRestaDelCobro(tempDb):
    from core.db import getDb
    from stores import asset_store
    from stores.ventas_store import writeVentasYear

    conn = getDb()
    asset_store.writeAssetFile("acc", {"name": "Acc", "type": "acciones", "price": "15", "currency": "EUR"})
    _tomar(conn)

    writeVentasYear("2025", {"year": "2025", "rows": [
        {"id": "v1", "fecha": "02-02-2025", "assetId": "acc", "cantidad": "4", "valorVenta": "15",
         "comisionVenta": "1"}]})

    assert _tomar(conn) == pytest.approx(-59.0)


# ── Décima tanda 2: permutas cripto-cripto y transferencias en la línea fiscal ─

def _criptoConCompra(assetId, cantidad="1", capital="100", fecha="01-01-2025", **extra):
    from stores import asset_store, ventas_fifo

    # La memoización por hilo puede coincidir entre bases de tests distintos.
    ventas_fifo._cacheHilo.clave = None
    asset_store.writeAssetFile(assetId, {
        "name": assetId, "type": "cripto", "price": "100", "currency": "EUR", "marketSymbol": "",
        "rows": [{"fechaOperacion": fecha, "tipoOperacion": "Compra", "participaciones": cantidad,
                  "capitalInvertidoBruto": capital, "currency": "EUR"}],
        **extra,
    })


def _conversion(assetId, idConversion, fecha, tipo, cantidad, valorEur=None):
    from core.db import getDb

    conn = getDb()
    # La columna del valor de mercado es opcional: la crea quien la anota.
    if "valor_eur" not in {f[1] for f in conn.execute("PRAGMA table_info(activo_conversion_rows)")}:
        conn.execute("ALTER TABLE activo_conversion_rows ADD COLUMN valor_eur TEXT NOT NULL DEFAULT ''")
    conn.execute(
        "INSERT INTO activo_conversion_rows (id, asset_id, fecha, par, tipo, cantidad, valor_eur) "
        "VALUES (?, ?, ?, 'BTC/ETH', ?, ?, ?)",
        (idConversion, assetId, fecha, tipo, cantidad, valorEur or ""),
    )
    conn.commit()


def _vender(anio, assetId, cantidad, valorVenta, fecha):
    from stores.ventas_store import writeVentasYear

    writeVentasYear(anio, {"year": anio, "rows": [
        {"id": "v1", "fecha": fecha, "assetId": assetId, "cantidad": cantidad, "valorVenta": valorVenta}]})


def testUnaPermutaConGananciaDeclaraLaDiferenciaConSuTipoPermuta(tempDb):
    from stores import ventas_fifo

    _criptoConCompra("btc")
    _conversion("btc", "c1", "01-06-2025", "BTC convertidos", "1", "150")

    calculo = ventas_fifo.calcularTodo()

    permuta = calculo["permutas"]["2025"][0]
    assert permuta["tipo"] == "permuta" and permuta["incidencia"] == ""
    assert permuta["valorTransmision"] == "150.00" and permuta["costeAdquisicion"] == "100.00"
    assert permuta["dineroDeclarar"] == "50.00"
    assert float(calculo["liquidaciones"]["2025"].ganancias) == 50.0
    # No se mezcla con las ventas a fiat.
    assert calculo["filas"] == {}


def testUnaPermutaConPerdidaDeclaraLaPerdida(tempDb):
    from stores import ventas_fifo

    _criptoConCompra("btc")
    _conversion("btc", "c1", "01-06-2025", "BTC convertidos", "1", "80")

    calculo = ventas_fifo.calcularTodo()

    assert calculo["permutas"]["2025"][0]["dineroDeclarar"] == "-20.00"
    assert float(calculo["liquidaciones"]["2025"].perdidas) == 20.0


def testUnaPermutaSinValorDeMercadoSaleConIncidenciaYNoDeclaraNada(tempDb):
    from stores import ventas_fifo

    _criptoConCompra("btc")
    _conversion("btc", "c1", "01-06-2025", "BTC convertidos", "1")

    calculo = ventas_fifo.calcularTodo()

    permuta = calculo["permutas"]["2025"][0]
    assert permuta["incidencia"] == ventas_fifo.INCIDENCIA_SIN_VALOR
    assert permuta["dineroDeclarar"] == "" and permuta["mensaje"]
    assert float(calculo["liquidaciones"]["2025"].ganancias) == 0.0
    assert float(calculo["liquidaciones"]["2025"].perdidas) == 0.0


def testVenderElActivoRecibidoPorConversionNoDaStockInsuficiente(tempDb):
    from stores import ventas_fifo

    _criptoConCompra("btc")
    # ETH sin ninguna compra: solo llegó por una conversión de 2 ETH valorada en 200 euros.
    _criptoConCompra("eth", cantidad="0.0000001", capital="0.0001", fecha="01-01-2020")
    _conversion("eth", "c2", "01-06-2025", "Convertidos a ETH", "2", "200")
    _vender("2026", "eth", "1", "150", "02-02-2026")

    fila = ventas_fifo.calcularTodo()["filas"][("2026", "v1")]

    assert fila["incidencia"] == ""
    # El lote recibido cuesta 100 euros por ETH (200 de valor entre 2).
    assert fila["costeAdquisicion"] == "100.00" and fila["dineroDeclarar"] == "50.00"


def testUnaTransferenciaEntreWalletsSoloPierdeLaComisionYNoDeclaraNada(tempDb):
    from core.db import getDb
    from stores import ventas_fifo

    _criptoConCompra("btc")
    conn = getDb()
    conn.execute(
        "INSERT INTO transacciones (id, asset_id, fecha_operacion, total, comision_red, wallet_tipo) "
        "VALUES ('t1', 'btc', '01-03-2025', '1', '0.1', 'entre_wallet')"
    )
    conn.commit()
    _vender("2025", "btc", "0.9", "200", "01-04-2025")

    calculo = ventas_fifo.calcularTodo()

    # Se queda sin hecho imponible: ni permutas ni ganancias en el ejercicio por la transferencia.
    assert calculo["permutas"] == {}
    fila = calculo["filas"][("2025", "v1")]
    # Existencias 1 - 0,1 de comisión = 0,9; se venden todas, sin stock insuficiente.
    assert fila["incidencia"] == ""
    assert fila["costeAdquisicion"] == "90.00"
    assert float(calculo["liquidaciones"]["2025"].ganancias) == pytest.approx(90.0)


def testElInformeDeLaRentaListaLasPermutasAparte(tempDb):
    from core import informe_renta
    from stores import ventas_fifo

    _criptoConCompra("btc")
    _conversion("btc", "c1", "01-06-2025", "BTC convertidos", "1", "150")
    _vender("2025", "btc", "0.0000001", "1", "02-06-2025")
    calculo = ventas_fifo.calcularTodo()

    informe = informe_renta.construir(
        "2025", [], ventas_fifo.serializarLiquidacion(calculo["liquidaciones"]["2025"]), calculo["permutas"]["2025"]
    )
    csv = informe_renta.aCsv(informe)

    assert len(informe["permutas"]) == 1
    assert "PERMUTAS DE CRIPTO POR CRIPTO" in csv
    assert "Permutas de cripto por cripto" in informe_renta.aHtml(informe)


# ── Décima tanda 3: el invertido neto es el importe sin comisiones, en todas las fuentes ─

def testElInvertidoNetoDeUnActivoNoCriptoDescuentaLasComisionesDeOperaciones(tempDb):
    from decimal import Decimal

    from stores import asset_store, ventas_fifo

    caso = _casoDePosicion()["acciones"]
    asset_store.writeAssetFile(caso["asset"]["id"], caso["asset"])

    posicion = ventas_fifo.carteraViva()["etf"]

    # Ficha: 1000 con 2 de comisión; Operaciones: 500 más 1,5 en el lote (501,5) y 1,5 que se descuenta.
    assert posicion["cantidad"] == Decimal(caso["cantidadEsperada"])
    assert posicion["coste"] == Decimal(caso["invertidoBrutoEsperado"])
    assert posicion["invertido"] == Decimal(caso["invertidoNetoEsperado"])
