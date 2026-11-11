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
from stores import asset_store, grafico_activo, series_tradingview

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
class TestRangoDelAnio:
    def testEmpiezaElUnoDeEneroDelAnioEnCurso(self):
        crearActivo([compra(date(2025, 12, 1), 1, 10)])
        snapshot(marca(date(2025, 12, 31)), 10, 10)
        snapshot(marca(date(2026, 1, 1), 1), 11, 10)
        snapshot(marca(HOY), 12, 10)

        datos = grafico("YTD")

        assert datos["rango"] == "YTD"
        assert [p["ts"] for p in datos["puntos"]] == [marca(date(2026, 1, 1), 1), marca(HOY)]

    def testCuentaLasOperacionesDelAnioYNoLasAnteriores(self):
        crearActivo([compra(date(2025, 12, 1), 1, 10), compra(HOY, 1, 10)])
        snapshot(marca(date(2025, 12, 1)), 10, 10)
        snapshot(marca(HOY), 24, 20)

        datos = grafico("YTD")

        assert [o["fecha"] for o in datos["operaciones"]] == [fecha(HOY)]
        assert datos["operacionesSinPunto"] == 0


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

    def testSeColocaEnElSnapshotDelDiaConPrecioMasParecido(self):
        # Sin hora, a mediodía quedaría antes de la caída en la que se compró.
        dia = HOY - timedelta(days=2)
        crearActivo([compra(dia, 1, 100)])
        snapshot(marca(dia, 9), 130, 100)
        snapshot(marca(dia, 12), 128, 100)
        snapshot(marca(dia, 17), 101, 100)

        datos = grafico()

        operacion = datos["operaciones"][0]
        assert operacion["precioEur"] == 100
        assert datos["puntos"][operacion["indice"]]["ts"] == marca(dia, 17)

    def testLaLineaPasaPorElSnapshotDeLaOperacionAunqueSuCubetaNoLoConserve(self):
        dia = HOY - timedelta(days=2)
        crearActivo([compra(dia, 1, 100)])
        snapshot(marca(dia, 9), 130, 100)
        snapshot(marca(dia, 11), 101, 100)
        snapshot(marca(dia, 17), 128, 100)

        datos = grafico()

        marcas = [p["ts"] for p in datos["puntos"]]
        assert marcas == sorted(marcas)
        assert len(marcas) == len(set(marcas))
        punto = datos["puntos"][datos["operaciones"][0]["indice"]]
        assert (punto["ts"], punto["precio"]) == (marca(dia, 11), 101)

    def testSinPrecioEnEurosNoAnadePuntosALaLinea(self):
        dia = HOY - timedelta(days=2)
        crearActivo([compra(dia, 1, 100)], currency="GBP")
        snapshot(marca(dia, 9), 101, 100)
        snapshot(marca(dia, 17), 128, 100)

        assert marca(dia, 9) not in [p["ts"] for p in grafico()["puntos"]]

    def testElPuntoDeLaOperacionNoSaleDelRangoPedido(self):
        ayer = HOY - timedelta(days=1)
        crearActivo([compra(ayer, 1, 100)])
        # Las 9 de ayer quedan fuera de las últimas 24 h, aunque coincida el precio.
        snapshot(marca(ayer, 9), 100, 100)
        snapshot(marca(ayer, 20), 120, 100)

        datos = grafico("1D")

        assert [p["ts"] for p in datos["puntos"]] == [marca(ayer, 20)]
        assert datos["operaciones"][0]["indice"] == 0

    def testNoSaleDelDiaAunqueOtroDiaTengaUnPrecioMasParecido(self):
        dia = HOY - timedelta(days=2)
        crearActivo([compra(HOY - timedelta(days=3), 1, 100), compra(dia, 1, 100)])
        snapshot(marca(HOY - timedelta(days=3)), 100, 100)
        snapshot(marca(dia), 300, 200)

        datos = grafico()

        assert datos["puntos"][datos["operaciones"][1]["indice"]]["ts"] == marca(dia)

    def testPrecioEnOtraDivisaUsaElCambioDeHoySiNoHayElDeSuFecha(self):
        dia = HOY - timedelta(days=2)
        crearActivo([compra(dia, 10, 20)], currency="USD")
        snapshot(marca(dia), 100, 100)

        operacion = grafico()["operaciones"][0]

        assert (operacion["precio"], operacion["divisa"], operacion["precioEur"]) == (20, "USD", 10)

    def testPrecioEnOtraDivisaPrefiereElCambioDeSuFecha(self):
        dia = HOY - timedelta(days=2)
        crearActivo([compra(dia, 10, 20)], currency="USD")
        conn = getDb()
        conn.execute(
            "INSERT INTO fx_rates (par, fecha, rate, origen, obtenido_en) VALUES ('USD/EUR', ?, '0.8', 'yahoo', '')",
            (dia.isoformat(),),
        )
        conn.commit()
        snapshot(marca(dia), 100, 100)

        assert grafico()["operaciones"][0]["precioEur"] == 16

    def testSinTipoDeCambioSeColocaPorCercaniaYSinPrecioEnEuros(self):
        dia = HOY - timedelta(days=2)
        crearActivo([compra(dia, 1, 100)], currency="GBP")
        snapshot(marca(dia, 9), 100, 100)
        snapshot(marca(dia, 12), 130, 100)

        datos = grafico()

        operacion = datos["operaciones"][0]
        assert operacion["precioEur"] is None
        assert datos["puntos"][operacion["indice"]]["ts"] == marca(dia, 12)

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


def serieDelDia():
    return grafico_activo.seriesDelDia(ahora=AHORA)


@pytest.mark.usefixtures("tempDb", "sinRed")
class TestSerieDelDia:
    def testElEjeEsElDiaNaturalDeHoy(self):
        datos = serieDelDia()

        assert datos["inicio"] == marca(HOY, 0)
        assert datos["fin"] == marca(HOY + timedelta(days=1), 0)
        assert datos["series"] == {}

    def testLineaDePrecioDesdeMedianocheSinLoDeAyer(self):
        crearActivo([compra(HOY - timedelta(days=5), 10, 10)])
        snapshot(marca(HOY - timedelta(days=1), 23), 90, 100)
        snapshot(marca(HOY, 9), 110, 100)
        snapshot(marca(HOY, 15), 120, 100)

        assert serieDelDia()["series"] == {"acme": [[marca(HOY, 9), 11], [marca(HOY, 15), 12]]}

    def testSinOperacionesUsaElValorDeLaPosicion(self):
        crearActivo()
        snapshot(marca(HOY, 9), 110, 0)
        snapshot(marca(HOY, 15), 120, 0)

        assert serieDelDia()["series"]["acme"] == [[marca(HOY, 9), 110], [marca(HOY, 15), 120]]

    def testCadaCubetaSeQuedaConSuUltimoSnapshot(self):
        crearActivo([compra(HOY - timedelta(days=5), 10, 10)])
        snapshot(marca(HOY, 9), 100, 100)
        snapshot(marca(HOY, 9) + 60, 105, 100)
        snapshot(marca(HOY, 10), 110, 100)

        assert serieDelDia()["series"]["acme"] == [[marca(HOY, 9) + 60, 10.5], [marca(HOY, 10), 11]]

    def testUnActivoQueFallaNoQuitaLaSerieALosDemas(self, monkeypatch):
        crearActivo([compra(HOY - timedelta(days=5), 10, 10)])
        crearActivo([compra(HOY - timedelta(days=5), 10, 10)], assetId="rota")
        for assetId in ("acme", "rota"):
            snapshot(marca(HOY, 9), 110, 100, assetId)
            snapshot(marca(HOY, 15), 120, 100, assetId)
        original = grafico_activo.construirPuntos

        def construirPuntosRoto(filas, tramos, moneda):
            if filas and filas[0]["asset_id"] == "rota":
                raise ValueError("datos corruptos")
            return original(filas, tramos, moneda)

        monkeypatch.setattr(grafico_activo, "construirPuntos", construirPuntosRoto)

        assert list(serieDelDia()["series"]) == ["acme"]

    def testUnSoloPuntoNoDibujaLineaYNoSale(self):
        crearActivo([compra(HOY - timedelta(days=5), 10, 10)])
        snapshot(marca(HOY, 9), 110, 100)

        assert serieDelDia()["series"] == {}

    def testSeparaLosActivosYDescartaLosBorrados(self):
        crearActivo([compra(HOY - timedelta(days=5), 10, 10)])
        crearActivo([compra(HOY - timedelta(days=5), 2, 50)], assetId="beta")
        for assetId, valores in (("acme", (100, 110)), ("beta", (100, 90)), ("borrado", (5, 6))):
            snapshot(marca(HOY, 9), valores[0], 100, assetId)
            snapshot(marca(HOY, 15), valores[1], 100, assetId)

        series = serieDelDia()["series"]

        assert set(series) == {"acme", "beta"}
        assert [precio for _ts, precio in series["beta"]] == [50, 45]


def precioSinPosicion(ts, precio, assetId="wl:s1"):
    conn = getDb()
    conn.execute(
        "INSERT INTO asset_price_snapshots (ts, asset_id, price_eur) VALUES (?, ?, ?)", (ts, assetId, precio)
    )
    conn.commit()


@pytest.mark.usefixtures("tempDb", "sinRed")
class TestSerieDelDiaSinPosicion:
    def testUsaLosPreciosGuardadosSinLoDeAyer(self):
        precioSinPosicion(marca(HOY - timedelta(days=1), 23), 9)
        precioSinPosicion(marca(HOY, 9), 10.5)
        precioSinPosicion(marca(HOY, 15), 11)

        assert serieDelDia()["series"] == {"wl:s1": [[marca(HOY, 9), 10.5], [marca(HOY, 15), 11]]}

    def testCadaCubetaSeQuedaConSuUltimoPrecio(self):
        precioSinPosicion(marca(HOY, 9), 10)
        precioSinPosicion(marca(HOY, 9) + 60, 10.2)
        precioSinPosicion(marca(HOY, 10), 11)

        assert serieDelDia()["series"]["wl:s1"] == [[marca(HOY, 9) + 60, 10.2], [marca(HOY, 10), 11]]

    def testUnSoloPrecioNoSale(self):
        precioSinPosicion(marca(HOY, 9), 10)

        assert serieDelDia()["series"] == {}

    def testLaSerieDeLaPosicionMandaSobreLaDePrecios(self):
        # Vendido hoy: tiene snapshots de su posición de la mañana y precios de la tarde.
        crearActivo([compra(HOY - timedelta(days=5), 10, 10)])
        snapshot(marca(HOY, 9), 110, 100)
        snapshot(marca(HOY, 10), 120, 100)
        precioSinPosicion(marca(HOY, 15), 99, "acme")
        precioSinPosicion(marca(HOY, 16), 98, "acme")

        assert serieDelDia()["series"]["acme"] == [[marca(HOY, 9), 11], [marca(HOY, 10), 12]]


def seriePeriodo(periodo):
    return grafico_activo.seriesDelPeriodo(periodo, ahora=AHORA)


@pytest.mark.usefixtures("tempDb", "sinRed")
class TestSeriePeriodo:
    def testLaSemanaVaDeHaceSieteDiasHastaAhora(self):
        datos = seriePeriodo("semana")

        assert datos["periodo"] == "semana"
        assert datos["inicio"] == int(AHORA - 7 * 86400)
        assert datos["fin"] == int(AHORA)
        assert datos["segundosHueco"] == grafico_activo.RANGOS["7D"]["hueco"]

    def testLineaDeVariosDiasSinLoAnteriorAlPeriodo(self):
        crearActivo([compra(HOY - timedelta(days=20), 10, 10)])
        snapshot(marca(HOY - timedelta(days=10)), 80, 100)
        snapshot(marca(HOY - timedelta(days=5)), 110, 100)
        snapshot(marca(HOY - timedelta(days=1)), 120, 100)

        assert seriePeriodo("semana")["series"] == {
            "acme": [[marca(HOY - timedelta(days=5)), 11], [marca(HOY - timedelta(days=1)), 12]]
        }

    def testIncluyeLosActivosSinPosicion(self):
        precioSinPosicion(marca(HOY - timedelta(days=3)), 10)
        precioSinPosicion(marca(HOY - timedelta(days=2)), 11)

        assert seriePeriodo("mes")["series"]["wl:s1"] == [
            [marca(HOY - timedelta(days=3)), 10], [marca(HOY - timedelta(days=2)), 11]
        ]

    def testElYtdEmpiezaElUnoDeEnero(self):
        assert seriePeriodo("ytd")["inicio"] == marca(date(HOY.year, 1, 1), 0)

    def testDiaEsLaSerieDelDia(self):
        assert seriePeriodo("dia") == serieDelDia()

    def testPeriodoInvalido(self):
        with pytest.raises(grafico_activo.RangoInvalido):
            seriePeriodo("siglo")


class VelasFalsas:
    """`series_tradingview.velasDelGrafico` falso: velas fijas y anota cada llamada."""

    def __init__(self, divisa="EUR", velas=None):
        self.respuesta = (divisa, velas or []) if velas else None
        self.llamadas = []

    def __call__(self, simbolo, rango, desdeTs=0, ahoraTs=None):
        self.llamadas.append({"simbolo": simbolo, "rango": rango, "desdeTs": desdeTs})
        return self.respuesta


def velasDiarias(desde: date, hasta: date, cierre=lambda dia: 10.0, amplitud=0.05):
    """Una vela por día a las 15:30, como las de una bolsa europea, con máximo y mínimo a ±`amplitud`."""
    velas = []
    for i in range((hasta - desde).days + 1):
        valor = cierre(desde + timedelta(days=i))
        velas.append([marca(desde + timedelta(days=i), 15) + 1800, valor, valor * (1 + amplitud), valor * (1 - amplitud)])
    return velas


def graficoConVelas(velas, rango="1A"):
    return grafico_activo.datosDelGrafico("acme", rango, ahora=AHORA, simboloTv="XETR:ACME", velas=velas)


@pytest.mark.usefixtures("tempDb", "sinRed")
class TestVelasDeTradingview:
    def testLaCompraAnteriorAlHistoricoTienePuntoYLaLineaPasaPorEl(self):
        diaCompra = HOY - timedelta(days=60)
        crearActivo([compra(diaCompra, 10, 10)])
        snapshot(marca(HOY - timedelta(days=1)), 160, 100)
        velas = VelasFalsas(velas=velasDiarias(HOY - timedelta(days=90), HOY - timedelta(days=1), lambda dia: 10.2))

        datos = graficoConVelas(velas)

        assert datos["conVelas"] is True
        assert datos["operacionesSinPunto"] == 0
        operacion = datos["operaciones"][0]
        punto = datos["puntos"][operacion["indice"]]
        # 10 € está dentro del día (9,69-10,71): la línea pasa por lo pagado.
        assert punto["fuente"] == "operacion"
        assert (punto["ts"], punto["precio"]) == (operacion["ts"], 10)
        assert (punto["valor"], punto["coste"]) == (100, 100)
        assert velas.llamadas == [{"simbolo": "XETR:ACME", "rango": "1A", "desdeTs": int(AHORA - 365 * 86400)}]

    def testConVelasLaLineaNoUsaLosSnapshots(self):
        crearActivo([compra(HOY - timedelta(days=60), 10, 10)])
        # Snapshots con un precio por participación de 15 y 16: no deben aparecer.
        snapshot(marca(HOY - timedelta(days=5)), 150, 100)
        snapshot(marca(HOY - timedelta(days=1)), 160, 100)
        velas = VelasFalsas(velas=velasDiarias(HOY - timedelta(days=20), HOY - timedelta(days=1)))

        puntos = graficoConVelas(velas)["puntos"]

        assert len(puntos) == 20
        assert {p["fuente"] for p in puntos} == {"tradingview"}
        assert {p["precio"] for p in puntos} == {10}

    def testPrecioFueraDelRangoDelDiaNoDoblaLaLinea(self):
        diaCompra = HOY - timedelta(days=10)
        crearActivo([compra(diaCompra, 1, 20)])
        velas = VelasFalsas(velas=velasDiarias(HOY - timedelta(days=20), HOY - timedelta(days=1)))

        datos = graficoConVelas(velas)

        assert {p["fuente"] for p in datos["puntos"]} == {"tradingview"}
        punto = datos["puntos"][datos["operaciones"][0]["indice"]]
        assert date.fromtimestamp(punto["ts"]) == diaCompra

    def testUnaSolaVelaNoBastaYUsaLosSnapshots(self):
        crearActivo([compra(HOY - timedelta(days=60), 10, 10)])
        snapshot(marca(HOY - timedelta(days=1)), 160, 100)
        velas = VelasFalsas(velas=velasDiarias(HOY - timedelta(days=2), HOY - timedelta(days=2)))

        datos = graficoConVelas(velas)

        assert datos["conVelas"] is False
        assert [p["precio"] for p in datos["puntos"]] == [16]

    def testConvierteLasVelasAEurosYReconstruyeLaPosicion(self):
        diaCompra = HOY - timedelta(days=60)
        crearActivo([compra(diaCompra, 4, 30)], currency="USD")
        velas = VelasFalsas(
            divisa="USD",
            velas=velasDiarias(diaCompra - timedelta(days=1), diaCompra, cierre=lambda dia: 40.0),
        )

        antes, delDia = graficoConVelas(velas)["puntos"]

        # Sin cambio histórico en caché, el de hoy (sinRed): 1 USD = 0,5 EUR.
        assert antes["precio"] == delDia["precio"] == 20
        assert (antes["valor"], antes["coste"]) == (0, 0)
        # 4 participaciones × 20 €; el coste, 120 USD al cambio de hoy.
        assert (delDia["valor"], delDia["coste"]) == (80, 60)

    def testSinVelasQuedaComoAntes(self):
        crearActivo([compra(HOY - timedelta(days=60), 10, 10)])
        snapshot(marca(HOY - timedelta(days=1)), 160, 100)

        datos = graficoConVelas(VelasFalsas())

        assert datos["conVelas"] is False
        assert datos["operacionesSinPunto"] == 1
        assert len(datos["puntos"]) == 1

    def testSinTickerNoPideVelas(self):
        crearActivo([compra(HOY - timedelta(days=60), 10, 10)])
        velas = VelasFalsas(velas=velasDiarias(HOY - timedelta(days=90), HOY))

        datos = grafico_activo.datosDelGrafico("acme", "1A", ahora=AHORA, velas=velas)

        assert velas.llamadas == []
        assert datos["conVelas"] is False

    def testDescartaLasVelasFueraDelRango(self):
        crearActivo([compra(HOY - timedelta(days=3), 1, 10)])
        velas = VelasFalsas(velas=velasDiarias(HOY - timedelta(days=12), HOY - timedelta(days=1)))

        puntos = graficoConVelas(velas, rango="7D")["puntos"]

        assert min(p["ts"] for p in puntos) >= AHORA - 7 * 86400

    def testEnTodoPideDesdeElPrimerMovimiento(self):
        diaCompra = HOY - timedelta(days=400)
        crearActivo([compra(diaCompra, 1, 10), compra(HOY - timedelta(days=10), 1, 10)])
        velas = VelasFalsas()

        graficoConVelas(velas, rango="TODO")

        assert velas.llamadas[0]["desdeTs"] == int(datetime.combine(diaCompra, time.min).timestamp())


class TestRuta:
    @pytest.fixture
    def cliente(self, clienteAutenticado, tempDb, sinRed):
        client, _cabeceras, _app = clienteAutenticado(activosBp)
        return client

    def testSerieDelDiaDeTodosLosActivos(self, cliente):
        crearActivo([compra(date.today() - timedelta(days=2), 1, 10)])
        inicioHoy = int(datetime.combine(date.today(), time.min).timestamp())
        snapshot(inicioHoy + 60, 10, 10)
        snapshot(inicioHoy + 1800, 11, 10)

        respuesta = cliente.get("/api/activos-serie-dia")

        assert respuesta.status_code == 200
        cuerpo = respuesta.get_json()
        assert cuerpo["ok"] is True
        assert cuerpo["inicio"] == inicioHoy
        assert [precio for _ts, precio in cuerpo["series"]["acme"]] == [10, 11]

    def testSerieDeLaSemana(self, cliente):
        crearActivo([compra(date.today() - timedelta(days=10), 1, 10)])
        ahora = int(datetime.now().timestamp())
        snapshot(ahora - 3 * 86400, 10, 10)
        snapshot(ahora - 86400, 12, 10)

        respuesta = cliente.get("/api/activos-serie-dia?periodo=semana")

        assert respuesta.status_code == 200
        cuerpo = respuesta.get_json()
        assert cuerpo["periodo"] == "semana"
        assert [precio for _ts, precio in cuerpo["series"]["acme"]] == [10, 12]

    def testPeriodoInvalidoEs400(self, cliente):
        assert cliente.get("/api/activos-serie-dia?periodo=siglo").status_code == 400

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

    def testPasaElTickerNormalizado(self, cliente, monkeypatch):
        crearActivo()
        pedidos = []
        monkeypatch.setattr(
            series_tradingview, "velasDelGrafico",
            lambda simbolo, rango, **kwargs: pedidos.append((simbolo, rango)),
        )

        respuesta = cliente.get("/api/activos/acme/grafico?rango=1a&tv=xetr:sap")

        assert respuesta.status_code == 200
        assert respuesta.get_json()["conVelas"] is False
        assert pedidos == [("XETR:SAP", "1A")]

    def testTickerNoValidoSeIgnora(self, cliente, monkeypatch):
        crearActivo()
        pedidos = []
        monkeypatch.setattr(series_tradingview, "velasDelGrafico", lambda *args, **kwargs: pedidos.append(args))

        respuesta = cliente.get("/api/activos/acme/grafico?rango=1A&tv=%3Cscript%3E")

        assert respuesta.status_code == 200
        assert pedidos == []
