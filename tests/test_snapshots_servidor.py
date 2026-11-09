"""Snapshots guardados por el servidor, sin navegador de por medio.

Cubre las tres piezas nuevas: la posición viva que calcula el FIFO del
servidor, la valoración en euros con cotizaciones frescas, y el reparto de
huecos horarios entre el hilo y el frontend.
"""

import pytest

from core.db import getDb, useDbPath
from routes.snapshots import guardarSnapshot, reservarBucket
from stores import valoracion, ventas_fifo
from stores.asset_store import writeAssetFile
from stores.ventas_store import readVentasYear, sanitizeVentasPayload, writeVentasYear


def crearActivo(assetId="acme", tipo="accion", precio="100,00", currency="EUR", filas=(), simbolo="ACME"):
    writeAssetFile(assetId, {
        "name": assetId.upper(),
        "symbol": assetId.upper(),
        "marketSymbol": simbolo,
        "type": tipo,
        "price": precio,
        "currency": currency,
        "rows": list(filas),
    })


def compra(fecha, participaciones, precio, comisiones="0"):
    return {
        "fechaOperacion": fecha,
        "tipoOperacion": "Compra",
        "participaciones": participaciones,
        "precioParticipacion": precio,
        "comisiones": comisiones,
    }


def guardarVenta(year, fecha, cantidad, valor, assetId="acme"):
    payload, error = sanitizeVentasPayload({"year": year, "rows": [{
        "id": "v1", "fecha": fecha, "assetId": assetId,
        "cantidad": cantidad, "valorVenta": valor,
    }]}, year)
    assert error is None, error
    writeVentasYear(year, payload)
    return readVentasYear(year)


class TestCarteraViva:
    def testSumaComprasYDescuentaVentasPorFifo(self, tempDb):
        crearActivo(filas=[
            compra("01-01-2023", "10", "10"),   # 100 €
            compra("01-06-2023", "10", "20"),   # 200 €
        ])
        guardarVenta("2024", "01-09-2024", "15", "30")

        posicion = ventas_fifo.carteraViva()["acme"]

        # Quedan 5 participaciones, todas del segundo lote (20 €/participación).
        assert float(posicion["cantidad"]) == pytest.approx(5)
        assert float(posicion["coste"]) == pytest.approx(100)

    def testElCosteEsElInvertidoBrutoSinComisiones(self, tempDb):
        # El frontend manda invertidoBruto como total_invested; si el servidor
        # sumara la comisión, el histórico tendría dos definiciones distintas
        # de "invertido" según quién guardara el punto.
        crearActivo(filas=[compra("01-01-2024", "10", "10", comisiones="25")])

        assert float(ventas_fifo.carteraViva()["acme"]["coste"]) == pytest.approx(100)

    def testUnActivoLiquidadoNoAparece(self, tempDb):
        crearActivo(filas=[compra("01-01-2023", "10", "10")])
        guardarVenta("2024", "01-09-2024", "10", "30")

        assert "acme" not in ventas_fifo.carteraViva()


class TestValoracion:
    def testValoraConLaCotizacionFresca(self, tempDb, monkeypatch):
        crearActivo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetchAssetQuote",
            lambda symbol, provider=None: ({"price": 150.0, "currency": "EUR"}, None),
        )

        resultado = valoracion.valorarPortfolio()

        assert resultado["total_value"] == pytest.approx(1500)
        assert resultado["total_invested"] == pytest.approx(100)
        assert resultado["precios_frescos"] == 1
        assert resultado["assets"] == [{"id": "acme", "v": pytest.approx(1500), "c": pytest.approx(100)}]

    def testAceptaElPrecioFormateadoQueDevuelvenLosProveedores(self, tempDb, monkeypatch):
        # Los clientes serializan `price` con `formatDecimal` ("1.500,00"), no
        # como número: un float() directo reventaba el snapshot entero.
        crearActivo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetchAssetQuote",
            lambda symbol, provider=None: ({"price": "1.500,00", "currency": "EUR"}, None),
        )

        resultado = valoracion.valorarPortfolio()

        assert resultado["total_value"] == pytest.approx(15000)
        assert resultado["precios_frescos"] == 1

    def testSiFallaLaCotizacionUsaElUltimoPrecio(self, tempDb, monkeypatch):
        # Un hueco en el histórico hace más daño que un punto con el precio de
        # hace unas horas: el snapshot se guarda igual.
        crearActivo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetchAssetQuote",
            lambda symbol, provider=None: (None, "429 Too Many Requests"),
        )

        resultado = valoracion.valorarPortfolio()

        assert resultado["total_value"] == pytest.approx(1000)
        assert resultado["precios_frescos"] == 0

    def testConvierteAEurosLaCotizacionEnOtraDivisa(self, tempDb, monkeypatch):
        crearActivo(precio="100,00", currency="USD", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(
            valoracion, "fetchAssetQuote",
            lambda symbol, provider=None: ({"price": 200.0, "currency": "USD"}, None),
        )
        monkeypatch.setattr(valoracion, "fetchExchangeRate", lambda origen, destino: (0.5, None))

        resultado = valoracion.valorarPortfolio()

        assert resultado["total_value"] == pytest.approx(1000)   # 10 x 200 USD x 0,5
        assert resultado["total_invested"] == pytest.approx(50)  # 100 USD x 0,5

    def testSinPosicionesNoPideCotizaciones(self, tempDb, monkeypatch):
        crearActivo(filas=[])

        def _explotar(*args, **kwargs):
            raise AssertionError("no debería pedir cotizaciones sin posición viva")

        monkeypatch.setattr(valoracion, "fetchAssetQuote", _explotar)

        resultado = valoracion.valorarPortfolio()

        assert resultado["activos"] == 0
        assert resultado["total_value"] == 0


@pytest.fixture
def huecoDeUnaHora(monkeypatch):
    """Intervalo fijo: el real sale de ajustes.json, que es del usuario."""
    import routes.snapshots as snapshots

    monkeypatch.setattr(snapshots, "_intervalSeconds", lambda: 3600)


@pytest.mark.usefixtures("huecoDeUnaHora")
class TestBucket:
    def testSoloSeGuardaUnPuntoPorHueco(self, tempDb):
        assert guardarSnapshot(1000, 900, nowTs=10_000) is True
        # El hilo del servidor y una pestaña abierta pueden coincidir: el
        # segundo punto del mismo bucket se descarta.
        assert guardarSnapshot(1100, 900, nowTs=10_030) is False

        filas = getDb().execute("SELECT total_value FROM portfolio_snapshots").fetchall()
        assert [f["total_value"] for f in filas] == [1000]

    def testElHuecoSiguienteSiSeGuarda(self, tempDb):
        assert guardarSnapshot(1000, 900, nowTs=10_000) is True
        assert guardarSnapshot(1100, 900, nowTs=10_000 + 3600) is True

    def testElBucketSoloLoReclamaUno(self, tempDb):
        assert reservarBucket(nowTs=10_000) is True
        assert reservarBucket(nowTs=10_030) is False
        assert reservarBucket(nowTs=10_000 + 3600) is True

    def testElDesglosePorActivoVaEnLaMismaTransaccion(self, tempDb):
        guardarSnapshot(1000, 900, [{"id": "acme", "v": 600, "c": 500}], nowTs=10_000)

        filas = getDb().execute("SELECT asset_id, price_eur, cost_eur FROM asset_snapshots").fetchall()
        assert [(f["asset_id"], f["price_eur"], f["cost_eur"]) for f in filas] == [("acme", 600, 500)]


@pytest.mark.usefixtures("huecoDeUnaHora")
class TestScheduler:
    def testEsperaAlSiguienteHuecoMasLaGracia(self, monkeypatch):
        from admin import snapshot_scheduler

        monkeypatch.setattr(snapshot_scheduler.settings, "snapshotServidorGracia", lambda: 120)

        # A las 10:00:30, el siguiente hueco es 11:00 y se le suman 2 minutos de
        # gracia para que gane el navegador si hay una pestaña abierta.
        assert snapshot_scheduler._esperaHastaSiguiente(ahora=36_030) == pytest.approx(3690)

    def testLaGraciaNoSeComeElHuecoEntero(self, monkeypatch):
        from admin import snapshot_scheduler

        monkeypatch.setattr(snapshot_scheduler, "_intervalo", lambda: 300)
        monkeypatch.setattr(snapshot_scheduler.settings, "snapshotServidorGracia", lambda: 600)

        # Gracia pedida 600 s sobre un hueco de 300: se limita a un cuarto (75).
        assert snapshot_scheduler._esperaHastaSiguiente(ahora=0) == pytest.approx(375)

    def testAlcanceActivoSoloMiraElPortfolioAbierto(self, tempDb, monkeypatch):
        from admin import snapshot_scheduler

        monkeypatch.setattr(snapshot_scheduler, "_ajustes", lambda: {"snapshotAlcance": "activo"})

        assert snapshot_scheduler._rutasObjetivo() == [tempDb]

    def testEjecutarUnaVezGuardaYRespetaElHueco(self, tempDb, monkeypatch):
        from admin import snapshot_scheduler

        crearActivo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(snapshot_scheduler, "_ajustes", lambda: {"snapshotAlcance": "activo"})
        monkeypatch.setattr(
            valoracion, "fetchAssetQuote",
            lambda symbol, provider=None: ({"price": 120.0, "currency": "EUR"}, None),
        )

        assert snapshot_scheduler.ejecutarUnaVez() == 1
        # Segunda pasada dentro del mismo hueco: ni siquiera vuelve a valorar.
        assert snapshot_scheduler.ejecutarUnaVez() == 0

        fila = getDb().execute("SELECT total_value, total_invested FROM portfolio_snapshots").fetchone()
        assert (fila["total_value"], fila["total_invested"]) == (1200, 100)


@pytest.mark.usefixtures("huecoDeUnaHora")
class TestOverrideDeBaseDeDatos:
    def testUseDbPathNoTocaLaBaseActiva(self, tempDb, tmp_path):
        # El hilo del servidor recorre portfolios; si cambiara la global, le
        # movería la base de datos bajo los pies a la sesión web abierta.
        guardarSnapshot(1000, 900, nowTs=10_000)
        otra = tmp_path / "otro_portfolio.db"

        with useDbPath(otra):
            guardarSnapshot(555, 500, nowTs=10_000)
            assert getDb().execute("SELECT total_value FROM portfolio_snapshots").fetchone()[0] == 555

        assert getDb().execute("SELECT total_value FROM portfolio_snapshots").fetchone()[0] == 1000


def _cotizacionesPorSimbolo(precios):
    """Sustituto de `fetchAssetQuote` que anota qué símbolos se piden."""
    pedidos = []

    def _cotizar(symbol, provider=None):
        pedidos.append(symbol)
        if symbol not in precios:
            return None, "sin cotización"
        precio, moneda = precios[symbol]
        return {"price": precio, "currency": moneda}, None

    return _cotizar, pedidos


class TestPreciosSinPosicion:
    def testCotizaLosActivosSinPosicionYLasEntradasPropiasDeSeguimiento(self, tempDb, monkeypatch):
        crearActivo("acme", filas=[compra("01-01-2024", "10", "10")], simbolo="ACME")
        crearActivo("beta", filas=[], simbolo="BETA")
        cotizar, pedidos = _cotizacionesPorSimbolo({"BETA": (20.0, "EUR"), "SPCX": (100.0, "USD")})
        monkeypatch.setattr(valoracion, "fetchAssetQuote", cotizar)
        monkeypatch.setattr(valoracion, "fetchExchangeRate", lambda origen, destino: (0.5, None))
        lista = [
            {"_segId": "s1", "ticker": "SPCX", "marketProvider": "tradingview", "currency": "USD"},
            # Apunta a un activo del portfolio: sale con él, no como entrada propia.
            {"_segId": "s2", "assetId": "acme", "ticker": "ACME"},
            {"_segId": "s3", "name": "Sin ticker"},
        ]

        precios = valoracion.preciosSinPosicion(lista)

        assert sorted(precios, key=lambda p: p["id"]) == [
            {"id": "beta", "p": pytest.approx(20)},
            {"id": "wl:s1", "p": pytest.approx(50)},
        ]
        assert sorted(pedidos) == ["BETA", "SPCX"]

    def testDescartaLoQueNoTienePrecioNiTipoDeCambio(self, tempDb, monkeypatch):
        crearActivo("beta", filas=[], simbolo="BETA")
        cotizar, _pedidos = _cotizacionesPorSimbolo({"GAMA": (10.0, "XXX")})
        monkeypatch.setattr(valoracion, "fetchAssetQuote", cotizar)
        monkeypatch.setattr(valoracion, "fetchExchangeRate", lambda origen, destino: (None, "caído"))
        monkeypatch.setattr(valoracion.fx_historico, "tasaActual", lambda *a, **k: (None, None, None))

        # BETA no tiene cotización y GAMA no tiene cambio: un 1:1 sería un precio falso.
        assert valoracion.preciosSinPosicion([{"_segId": "g", "ticker": "GAMA", "currency": "XXX"}]) == []

    def testSinNadaFueraDeCarteraNoPideCotizaciones(self, tempDb, monkeypatch):
        crearActivo("acme", filas=[compra("01-01-2024", "10", "10")])

        def _explotar(*args, **kwargs):
            raise AssertionError("no debería pedir cotizaciones")

        monkeypatch.setattr(valoracion, "fetchAssetQuote", _explotar)

        assert valoracion.preciosSinPosicion([]) == []


@pytest.mark.usefixtures("huecoDeUnaHora")
class TestGuardarPrecios:
    def testVanConElPuntoYSePurganLosDeHaceMasDeDosDias(self, tempDb):
        ahora = 10 * 86400
        conn = getDb()
        conn.execute("INSERT INTO asset_price_snapshots (ts, asset_id, price_eur) VALUES (?, 'viejo', 1)",
                     (ahora - 3 * 86400,))
        conn.commit()

        guardarSnapshot(1000, 900, nowTs=ahora, precios=[
            {"id": "wl:s1", "p": 12.5}, {"id": "", "p": 3}, {"id": "cero", "p": 0}, "basura",
        ])

        filas = getDb().execute("SELECT ts, asset_id, price_eur FROM asset_price_snapshots").fetchall()
        assert [(f["ts"], f["asset_id"], f["price_eur"]) for f in filas] == [(ahora, "wl:s1", 12.5)]

    def testSiElHuecoEstaOcupadoNoSeGuardan(self, tempDb):
        guardarSnapshot(1000, 900, nowTs=10_000)
        guardarSnapshot(1000, 900, nowTs=10_030, precios=[{"id": "wl:s1", "p": 12.5}])

        assert getDb().execute("SELECT COUNT(*) FROM asset_price_snapshots").fetchone()[0] == 0


@pytest.mark.usefixtures("huecoDeUnaHora")
class TestSchedulerPreciosSinPosicion:
    def _preparar(self, monkeypatch):
        from admin import snapshot_scheduler

        crearActivo(precio="100,00", filas=[compra("01-01-2024", "10", "10")])
        monkeypatch.setattr(snapshot_scheduler, "_ajustes", lambda: {"snapshotAlcance": "activo"})
        monkeypatch.setattr(
            valoracion, "fetchAssetQuote",
            lambda symbol, provider=None: ({"price": 120.0, "currency": "EUR"}, None),
        )
        return snapshot_scheduler

    def testGuardaLosPreciosConElPunto(self, tempDb, monkeypatch):
        scheduler = self._preparar(monkeypatch)
        monkeypatch.setattr(valoracion, "preciosSinPosicion", lambda: [{"id": "wl:s1", "p": 7.0}])

        assert scheduler.ejecutarUnaVez() == 1

        fila = getDb().execute("SELECT asset_id, price_eur FROM asset_price_snapshots").fetchone()
        assert (fila["asset_id"], fila["price_eur"]) == ("wl:s1", 7.0)

    def testSiFallanLosPreciosElPuntoSeGuardaIgual(self, tempDb, monkeypatch):
        scheduler = self._preparar(monkeypatch)

        def _fallar():
            raise RuntimeError("proveedor caído")

        monkeypatch.setattr(valoracion, "preciosSinPosicion", _fallar)

        assert scheduler.ejecutarUnaVez() == 1
        assert getDb().execute("SELECT COUNT(*) FROM asset_price_snapshots").fetchone()[0] == 0

    def testSinRefrescarPreciosNoLosPide(self, tempDb, monkeypatch):
        scheduler = self._preparar(monkeypatch)

        def _explotar():
            raise AssertionError("sin refresco no debería cotizar lo de fuera de cartera")

        monkeypatch.setattr(valoracion, "preciosSinPosicion", _explotar)

        assert scheduler.ejecutarUnaVez(refrescarPrecios=False) == 1
