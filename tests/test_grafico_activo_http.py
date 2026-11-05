"""Gráfico de la ficha del activo: serie desde los snapshots y compras y ventas.

Lo delicado es el precio por participación: el snapshot guarda el valor de la
posición, y las operaciones solo tienen fecha y a veces se apuntan tarde. Un mal
reparto se ve como una caída de precio justo donde está el punto de compra.
"""

from datetime import date, datetime, time, timedelta
from decimal import Decimal

import pytest

from core.db import getDb
from routes.activos import activosBp
from stores import asset_store, grafico_activo

HOY = date(2026, 6, 30)
AHORA = datetime.combine(HOY, time(18)).timestamp()


def fecha(dia: date) -> str:
    return dia.strftime("%d-%m-%Y")


def marca(dia: date, hora: int = 12) -> int:
    return int(datetime.combine(dia, time(hora)).timestamp())


def compra(dia, cantidad, precio, tipo="Compra"):
    return {
        "fechaOperacion": fecha(dia),
        "tipoOperacion": tipo,
        "participaciones": str(cantidad),
        "precioParticipacion": str(precio),
        "capitalInvertidoBruto": str(cantidad * precio),
    }


def crearActivo(filas=(), assetId="acme", currency="EUR", tipo="acciones"):
    asset_store.writeAssetFile(assetId, {
        "name": assetId.upper(), "symbol": assetId.upper(), "type": tipo,
        "price": "10", "currency": currency, "rows": list(filas),
    })


def snapshot(ts, valor, coste, assetId="acme"):
    conn = getDb()
    conn.execute(
        "INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, ?, ?, ?)",
        (ts, assetId, valor, coste),
    )
    conn.commit()


def grafico(rango="TODO", assetId="acme"):
    return grafico_activo.datosDelGrafico(assetId, rango, ahora=AHORA)


@pytest.fixture
def sinRed(monkeypatch):
    """El tipo de cambio de hoy, sin salir a la red: 1 USD = 0,5 EUR."""
    monkeypatch.setattr(
        grafico_activo, "tipoActualConMemo",
        lambda: lambda desde, hacia: Decimal("0.5") if (desde, hacia) == ("USD", "EUR") else None,
    )


@pytest.mark.usefixtures("tempDb", "sinRed")
class TestPrecioPorParticipacion:
    def testDivideElValorEntreLaCantidadDeEsaFecha(self):
        ayer = HOY - timedelta(days=1)
        crearActivo([compra(ayer, 10, 10), compra(HOY, 10, 10)])
        snapshot(marca(ayer), 120, 100)
        snapshot(marca(HOY, 15), 260, 200)

        puntos = grafico()["puntos"]

        assert [p["precio"] for p in puntos] == [12, 13]
        assert puntos[1]["valor"] == 260
        assert puntos[1]["coste"] == 200

    def testSnapshotDeAntesDeApuntarLaCompraNoSimulaUnaCaida(self):
        # Compra del día 20 apuntada el 25: entre medias, el valor no la incluía.
        compraTardia = HOY - timedelta(days=10)
        crearActivo([compra(HOY - timedelta(days=30), 10, 10), compra(compraTardia, 10, 10)])
        snapshot(marca(HOY - timedelta(days=8)), 110, 100)
        snapshot(marca(HOY - timedelta(days=2)), 240, 200)

        assert [p["precio"] for p in grafico()["puntos"]] == [11, 12]

    def testCompraDelMismoDiaNoCuentaAntesDeReflejarseEnElCoste(self):
        crearActivo([compra(HOY - timedelta(days=5), 10, 10), compra(HOY, 10, 10)])
        snapshot(marca(HOY, 9), 110, 100)
        snapshot(marca(HOY, 15), 220, 200)

        assert [p["precio"] for p in grafico("30D")["puntos"]] == [11, 11]

    def testRecibirSinCosteSeResuelvePorLaFecha(self):
        crearActivo([compra(HOY - timedelta(days=9), 10, 10)])
        conn = getDb()
        conn.execute(
            "INSERT INTO transacciones (id, asset_id, fecha_operacion, total, comision_red, wallet_tipo) "
            "VALUES ('t1', 'acme', ?, '10', '0', 'recibida')",
            (fecha(HOY - timedelta(days=4)),),
        )
        conn.commit()
        snapshot(marca(HOY - timedelta(days=6)), 110, 100)
        snapshot(marca(HOY - timedelta(days=2)), 240, 100)

        assert [p["precio"] for p in grafico()["puntos"]] == [11, 12]

    def testConvierteElCosteAEurosParaCompararlo(self):
        crearActivo([compra(HOY - timedelta(days=9), 10, 20)], currency="USD")
        # 200 USD de coste a 0,5 son los 100 EUR del snapshot.
        snapshot(marca(HOY - timedelta(days=1)), 150, 100)

        assert grafico()["puntos"][0]["precio"] == 15

    def testSnapshotAntiguoSinCosteUsaLaFecha(self):
        crearActivo([compra(HOY - timedelta(days=9), 10, 10)])
        snapshot(marca(HOY - timedelta(days=1)), 120, 0)

        assert grafico()["puntos"][0]["precio"] == 12

    def testOperacionSinFechaLegibleCuentaEnLaPosicionPorSuCoste(self):
        # `lotesVivos` la cuenta en el total pero no al filtrar por día: dividir
        # entre la cantidad de la fecha multiplicaría el precio.
        crearActivo([compra(HOY - timedelta(days=9), 10, 10)])
        conn = getDb()
        conn.execute(
            "INSERT INTO activo_operation_rows (id, asset_id, fecha_apertura, par, orden, estado, cantidad, "
            "precio_orden, precio_currency, currency, total) "
            "VALUES ('o1', 'acme', 'ACME/EUR', '', 'Compra', 'Completado', '90', '10', 'EUR', 'EUR', '900')"
        )
        conn.commit()
        snapshot(marca(HOY - timedelta(days=1)), 1100, 1000)

        assert grafico()["puntos"][0]["precio"] == 11

    def testCosteQueNoCuadraConNingunaPosicionDejaElPrecioVacio(self):
        # Una cartera sustituida al restaurar: el valor era de otras operaciones.
        crearActivo([compra(HOY - timedelta(days=9), 10, 100)])
        snapshot(marca(HOY - timedelta(days=2)), 80, 57)
        snapshot(marca(HOY - timedelta(days=1)), 1100, 1000)

        puntos = grafico()["puntos"]

        assert [p["precio"] for p in puntos] == [None, 110]
        assert puntos[0]["valor"] == 80

    def testEnOtraDivisaAdmiteLoQueSeHaMovidoElCambio(self):
        crearActivo([compra(HOY - timedelta(days=9), 10, 20)], currency="USD")
        # 200 USD a 0,5 son 100 EUR hoy; cuando se guardó, el cambio daba 115 EUR.
        snapshot(marca(HOY - timedelta(days=1)), 150, 115)

        assert grafico()["puntos"][0]["precio"] == 15

    def testSinOperacionesElPrecioQuedaVacioPeroElValorSigue(self):
        crearActivo()
        snapshot(marca(HOY - timedelta(days=1)), 120, 100)

        punto = grafico()["puntos"][0]

        assert punto["precio"] is None
        assert punto["valor"] == 120


@pytest.mark.usefixtures("tempDb", "sinRed")
class TestRangos:
    def testRecortaAlRangoYConservaElInicioDelHistorico(self):
        crearActivo([compra(HOY - timedelta(days=60), 1, 10)])
        inicio = marca(HOY - timedelta(days=50))
        snapshot(inicio, 10, 10)
        snapshot(marca(HOY - timedelta(days=3)), 11, 10)

        datos = grafico("7D")

        assert len(datos["puntos"]) == 1
        assert datos["inicioHistorico"] == inicio

    def testCadaCubetaSeQuedaConSuUltimoSnapshot(self):
        crearActivo([compra(HOY - timedelta(days=60), 1, 10)])
        dia = HOY - timedelta(days=4)
        for hora, valor in ((10, 10), (11, 11), (12, 12)):
            snapshot(marca(dia, hora), valor, 10)

        puntos = grafico("1A")["puntos"]

        assert [p["valor"] for p in puntos] == [12]

    def testRangoInvalido(self):
        crearActivo()
        with pytest.raises(grafico_activo.RangoInvalido):
            grafico("5X")

    def testActivoInexistente(self):
        with pytest.raises(grafico_activo.ActivoNoEncontrado):
            grafico(assetId="no-existe")


@pytest.mark.usefixtures("tempDb", "sinRed")
class TestOperaciones:
    def testComprasYVentasDeTodasLasFuentes(self):
        compraFicha = HOY - timedelta(days=9)
        ventaFicha = HOY - timedelta(days=7)
        compraOrden = HOY - timedelta(days=5)
        ventaRegistrada = HOY - timedelta(days=3)
        crearActivo([compra(compraFicha, 10, 10), compra(ventaFicha, 2, 15, "Venta")])
        conn = getDb()
        conn.execute(
            "INSERT INTO activo_operation_rows (id, asset_id, fecha_apertura, orden, estado, cantidad, precio_orden, "
            "precio_currency, currency, total) VALUES ('o1', 'acme', ?, 'Compra', 'Completado', '4', '12', 'USD', 'USD', '48')",
            (fecha(compraOrden),),
        )
        conn.execute(
            "INSERT INTO ventas (id, year, fecha, asset_id, cantidad, valor_venta, currency) "
            "VALUES ('v1', '2026', ?, 'acme', '1', '20', 'EUR')",
            (fecha(ventaRegistrada),),
        )
        conn.commit()
        for dias in range(10, 0, -1):
            snapshot(marca(HOY - timedelta(days=dias)), 100, 100)

        operaciones = grafico()["operaciones"]

        assert [(o["tipo"], o["fecha"], o["cantidad"], o["precio"], o["divisa"]) for o in operaciones] == [
            ("compra", fecha(compraFicha), 10, 10, "EUR"),
            ("venta", fecha(ventaFicha), 2, 15, "EUR"),
            ("compra", fecha(compraOrden), 4, 12, "USD"),
            ("venta", fecha(ventaRegistrada), 1, 20, "EUR"),
        ]
        # Cada operación cae en el snapshot de su día.
        puntos = grafico()["puntos"]
        assert all(date.fromtimestamp(puntos[o["indice"]]["ts"]).strftime("%d-%m-%Y") == o["fecha"]
                   for o in operaciones)

    def testOperacionConAperturaIlegibleSeColocaPorSuCierre(self):
        cierre = HOY - timedelta(days=3)
        crearActivo()
        conn = getDb()
        conn.execute(
            "INSERT INTO activo_operation_rows (id, asset_id, fecha_apertura, fecha_cierre, orden, estado, cantidad, "
            "precio_orden, precio_currency, currency, total) "
            "VALUES ('o1', 'acme', 'ACME/EUR', ?, 'Compra', 'Completado', '1', '10', 'EUR', 'EUR', '10')",
            (fecha(cierre),),
        )
        conn.commit()
        snapshot(marca(cierre), 10, 10)

        assert grafico()["operaciones"][0]["fecha"] == fecha(cierre)

    def testIgnoraConversionesYFechasIlegibles(self):
        crearActivo([
            compra(HOY - timedelta(days=9), 1, 10, "BTC convertidos"),
            {**compra(HOY, 1, 10), "fechaOperacion": "sin fecha"},
        ])
        snapshot(marca(HOY - timedelta(days=2)), 10, 10)

        assert grafico()["operaciones"] == []

    def testOperacionAnteriorAlHistoricoSeCuentaSinPunto(self):
        crearActivo([compra(HOY - timedelta(days=200), 1, 10), compra(HOY - timedelta(days=2), 1, 10)])
        snapshot(marca(HOY - timedelta(days=2)), 10, 10)

        datos = grafico()

        assert len(datos["operaciones"]) == 1
        assert datos["operacionesSinPunto"] == 1

    def testOperacionFueraDelRangoNiSeColocaNiSeCuenta(self):
        crearActivo([compra(HOY - timedelta(days=20), 1, 10)])
        snapshot(marca(HOY - timedelta(days=2)), 10, 10)

        datos = grafico("7D")

        assert datos["operaciones"] == []
        assert datos["operacionesSinPunto"] == 0

    def testSinSnapshotsNadaSePuedeColocar(self):
        crearActivo([compra(HOY - timedelta(days=2), 1, 10)])

        datos = grafico()

        assert datos["puntos"] == []
        assert datos["inicioHistorico"] is None
        assert datos["operacionesSinPunto"] == 1


class TestRuta:
    @pytest.fixture
    def cliente(self, clienteAutenticado, tempDb, sinRed):
        client, _cabeceras, _app = clienteAutenticado(activosBp)
        return client

    def testDevuelveLaSerie(self, cliente):
        crearActivo([compra(date.today() - timedelta(days=2), 1, 10)])
        snapshot(int(datetime.now().timestamp()) - 3600, 10, 10)

        respuesta = cliente.get("/api/activos/acme/grafico?rango=7d")

        assert respuesta.status_code == 200
        cuerpo = respuesta.get_json()
        assert cuerpo["ok"] is True
        assert cuerpo["rango"] == "7D"
        assert len(cuerpo["puntos"]) == 1
        assert cuerpo["operaciones"][0]["tipo"] == "compra"

    def testRangoInvalidoEs400(self, cliente):
        crearActivo()
        assert cliente.get("/api/activos/acme/grafico?rango=99").status_code == 400

    def testActivoInexistenteEs404(self, cliente):
        assert cliente.get("/api/activos/nada/grafico").status_code == 404
