"""Posición por días y caché de lotes vivos (stores/rendimiento_activo.py).

`posicionPorDias` tiene que dar lo mismo que llamar a `lotesVivos` día a día, y la
caché de `lotesVivosCacheados` no puede servir un dato viejo tras ninguna
escritura que cambie la posición: operaciones, ventas, transacciones, ni tampoco
un cambio de tipo de cambio.
"""

import sqlite3
import threading
from datetime import date
from decimal import Decimal

import pytest

from core import db
from core.db import getDb
from stores import asset_store, grafico_activo, rendimiento_activo


def fila(fecha, tipo, participaciones, coste, **extra):
    return {
        "fecha_operacion": fecha, "tipo_operacion": tipo, "participaciones": str(participaciones),
        "capital_invertido_bruto": str(coste), "precio_participacion": "", **extra,
    }


def venta(fecha, cantidad):
    return {"fecha": fecha, "cantidad": str(cantidad)}


def porDiaConLotesVivos(filas, ventas, dias, esCripto=False, transacciones=()):
    resultado = {}
    for dia in dias:
        lotes = rendimiento_activo.lotesVivos(
            filas, [], esCripto, ventas, dia, transacciones, [],
        )
        resultado[dia] = (
            sum((lote["cantidad"] for lote in lotes), Decimal("0")),
            sum((lote["coste"] for lote in lotes), Decimal("0")),
        )
    return resultado


class TestPosicionPorDias:
    FILAS = [
        fila("01-01-2026", "Compra", 10, 100),
        fila("01-02-2026", "Compra", 10, 300),
        fila("01-04-2026", "Compra", 5, 100),
        fila("sin fecha", "Compra", 1, 7),
    ]
    VENTAS = [venta("15-02-2026", 12), venta("10-04-2026", 4)]

    def testCoincideConLotesVivosDiaADia(self):
        dias = [date(2025, 12, 31), date(2026, 1, 1), date(2026, 1, 20), date(2026, 2, 1), date(2026, 2, 15),
                date(2026, 3, 1), date(2026, 4, 1), date(2026, 4, 10), date(2026, 12, 31), None]
        esperado = porDiaConLotesVivos(self.FILAS, self.VENTAS, dias)

        obtenido = rendimiento_activo.posicionPorDias(self.FILAS, [], False, self.VENTAS, dias)

        assert obtenido == esperado

    def testElOrdenDeLosDiasNoCambiaElResultado(self):
        dias = [date(2026, 4, 10), None, date(2026, 1, 1), date(2026, 2, 15)]
        esperado = porDiaConLotesVivos(self.FILAS, self.VENTAS, dias)

        assert rendimiento_activo.posicionPorDias(self.FILAS, [], False, self.VENTAS, dias) == esperado

    def testLaFechaIlegibleSoloCuentaEnLaPosicionCompleta(self):
        sinFecha = rendimiento_activo.posicionPorDias(self.FILAS, [], False, [], [date(2030, 1, 1), None])

        assert sinFecha[date(2030, 1, 1)][0] == Decimal("25")
        assert sinFecha[None][0] == Decimal("26")

    def testAntesDeLaPrimeraOperacionNoHayPosicion(self):
        assert rendimiento_activo.posicionPorDias(self.FILAS, [], False, [], [date(2020, 1, 1)]) == {
            date(2020, 1, 1): (Decimal("0"), Decimal("0"))
        }

    def testSinEventosNiDias(self):
        assert rendimiento_activo.posicionPorDias([], [], False, [], []) == {}
        assert rendimiento_activo.posicionPorDias([], [], False, [], [None]) == {None: (Decimal("0"), Decimal("0"))}

    def testUnaVentaMayorQueLaPosicionSoloSeLlevaLoQueHay(self):
        filas = [fila("01-01-2026", "Compra", 3, 30)]
        resultado = rendimiento_activo.posicionPorDias(filas, [], False, [venta("02-01-2026", 10)], [date(2026, 1, 5)])

        assert resultado[date(2026, 1, 5)] == (Decimal("0"), Decimal("0"))

    def testComisionEnCriptoYTransaccionesComoLotesVivos(self):
        filas = [fila("01-01-2026", "Compra", 10, 100, comisiones_cripto="1")]
        transacciones = [
            {"fecha_operacion": "05-01-2026", "total": "4", "comision_red": "0.1", "wallet_tipo": "recibida"},
            {"fecha_operacion": "06-01-2026", "total": "2", "comision_red": "0.1", "wallet_tipo": "enviada"},
        ]
        dias = [date(2026, 1, 1), date(2026, 1, 5), date(2026, 1, 6), None]

        obtenido = rendimiento_activo.posicionPorDias(filas, [], True, [], dias, transacciones)

        assert obtenido == porDiaConLotesVivos(filas, [], dias, esCripto=True, transacciones=transacciones)


@pytest.mark.usefixtures("tempDb")
class TestConstruirTramos:
    def testLosTramosCoincidenConLotesVivosPorDia(self):
        datos = {
            "filas": TestPosicionPorDias.FILAS, "operaciones": [], "ventas": TestPosicionPorDias.VENTAS,
            "transacciones": [], "conversiones": [],
        }
        tipo = lambda desde, hacia: Decimal("2")  # noqa: E731

        tramos = grafico_activo.construirTramos(datos, False, "USD", tipo)

        dias = [t.dia for t in tramos]
        assert dias[-1] == date.max
        esperado = porDiaConLotesVivos(TestPosicionPorDias.FILAS, TestPosicionPorDias.VENTAS,
                                       [d if d != date.max else None for d in dias])
        for tramo in tramos:
            cantidad, coste = esperado[None if tramo.dia == date.max else tramo.dia]
            assert tramo.cantidad == cantidad
            assert tramo.costeEur == coste * Decimal("2")


def crearActivo(assetId="acme", moneda="EUR", tipo="acciones", filas=None):
    asset_store.writeAssetFile(assetId, {
        "name": assetId.upper(), "symbol": assetId.upper(), "type": tipo, "price": "10", "currency": moneda,
        "rows": filas if filas is not None else [{
            "fechaOperacion": "01-01-2026", "tipoOperacion": "Compra", "participaciones": "10",
            "capitalInvertidoBruto": "100",
        }],
    })


def invertidoNeto(assetId="acme"):
    return next(a for a in asset_store.listAssets() if a["id"] == assetId)["invertidoNeto"]


def contarCalculos(monkeypatch):
    llamadas = []
    original = rendimiento_activo.lotesVivos

    def contador(*args, **kwargs):
        llamadas.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(rendimiento_activo, "lotesVivos", contador)
    return llamadas


@pytest.mark.usefixtures("tempDb")
class TestCacheDeLotes:
    def testSegundaPeticionSinCambiosNoRecalcula(self, monkeypatch):
        crearActivo()
        assert invertidoNeto() == 100.0
        llamadas = contarCalculos(monkeypatch)

        assert invertidoNeto() == 100.0
        assert llamadas == []

    def testEscribirOperacionesInvalida(self):
        crearActivo()
        assert invertidoNeto() == 100.0

        crearActivo(filas=[
            {"fechaOperacion": "01-01-2026", "tipoOperacion": "Compra", "participaciones": "10",
             "capitalInvertidoBruto": "100"},
            {"fechaOperacion": "02-01-2026", "tipoOperacion": "Compra", "participaciones": "5",
             "capitalInvertidoBruto": "50"},
        ])

        assert invertidoNeto() == 150.0

    def testRegistrarUnaVentaInvalida(self):
        crearActivo()
        assert invertidoNeto() == 100.0

        conn = getDb()
        conn.execute("INSERT OR IGNORE INTO ventas_years(year) VALUES ('2026')")
        conn.execute(
            "INSERT INTO ventas(id, year, fecha, asset_id, cantidad, valor_venta, currency) "
            "VALUES ('v1', '2026', '02-02-2026', 'acme', '5', '60', 'EUR')"
        )
        conn.commit()

        assert invertidoNeto() == 50.0

    def testRegistrarUnaTransaccionInvalida(self):
        crearActivo(tipo="cripto")
        assert invertidoNeto() == 100.0
        lotesAntes = rendimiento_activo.lotesVivosCacheados(getDb(), "acme", [], [], True)

        conn = getDb()
        conn.execute(
            "INSERT INTO transacciones (id, asset_id, fecha_operacion, total, comision_red, wallet_tipo) "
            "VALUES ('t1', 'acme', '05-01-2026', '4', '0', 'recibida')"
        )
        conn.commit()
        datos = rendimiento_activo.cargarPosiciones(conn)["acme"]
        lotes = rendimiento_activo.lotesVivosCacheados(
            conn, "acme", datos["filas"], datos["operaciones"], True, datos["ventas"], datos["transacciones"],
            datos["conversiones"],
        )

        assert lotesAntes == []
        assert sum((lote["cantidad"] for lote in lotes), Decimal("0")) == Decimal("14")

    def testUnaEscrituraDeOtraConexionInvalida(self):
        crearActivo()
        assert invertidoNeto() == 100.0
        ruta = str(db.getActiveDbPath())

        def escribirDesdeOtroHilo():
            otra = sqlite3.connect(ruta)
            otra.execute(
                "INSERT INTO activo_rows (asset_id, fecha_operacion, tipo_operacion, participaciones, "
                "capital_invertido_bruto) VALUES ('acme', '03-01-2026', 'Compra', '1', '25')"
            )
            otra.commit()
            otra.close()

        hilo = threading.Thread(target=escribirDesdeOtroHilo)
        hilo.start()
        hilo.join()

        assert invertidoNeto() == 125.0

    def testElCambioDeTipoDeCambioInvalida(self, monkeypatch):
        crearActivo(moneda="USD", tipo="cripto", filas=[{
            "fechaOperacion": "01-01-2026", "tipoOperacion": "Compra", "participaciones": "10",
            "capitalInvertidoBruto": "100", "currency": "EUR",
        }])
        tipos = {"valor": Decimal("2")}

        def tipoFactoria():
            return lambda desde, hacia: tipos["valor"] if desde != hacia else Decimal("1")

        monkeypatch.setattr(asset_store, "tipoActualConMemo", tipoFactoria)
        primero = invertidoNeto()
        tipos["valor"] = Decimal("4")
        segundo = invertidoNeto()

        # La compra va en euros y el activo en dólares: el coste cambia con el tipo.
        assert segundo == primero * 2

    def testElMismoTipoDeCambioReutilizaLaCache(self, monkeypatch):
        crearActivo(moneda="USD", tipo="cripto", filas=[{
            "fechaOperacion": "01-01-2026", "tipoOperacion": "Compra", "participaciones": "10",
            "capitalInvertidoBruto": "100", "currency": "EUR",
        }])
        monkeypatch.setattr(asset_store, "tipoActualConMemo", lambda: lambda desde, hacia: Decimal("2"))
        invertidoNeto()
        llamadas = contarCalculos(monkeypatch)

        invertidoNeto()

        assert llamadas == []

    def testCambiarDeBaseInvalida(self, tmp_path):
        crearActivo()
        assert invertidoNeto() == 100.0

        db.setActiveDbPath(tmp_path / "otra.db")
        db.initDb()
        crearActivo(filas=[{
            "fechaOperacion": "01-01-2026", "tipoOperacion": "Compra", "participaciones": "10",
            "capitalInvertidoBruto": "700",
        }])

        assert invertidoNeto() == 700.0

    def testLosLotesDevueltosSonCopias(self):
        crearActivo()
        conn = getDb()
        datos = rendimiento_activo.cargarPosiciones(conn)["acme"]
        args = (conn, "acme", datos["filas"], datos["operaciones"], False)
        primeros = rendimiento_activo.lotesVivosCacheados(*args)
        primeros[0]["cantidad"] = Decimal("999")

        assert rendimiento_activo.lotesVivosCacheados(*args)[0]["cantidad"] == Decimal("10")
