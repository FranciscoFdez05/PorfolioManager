"""Resumen anual de compras de Métricas.

Cubre las dos piezas: `rendimiento_activo.comprasPorAnio`, que reparte el FIFO
de posición por año de adquisición, y `stores.compras_anuales`, que lo pasa a
euros, lo valora al precio actual y lo sirve en /api/metricas/compras-anuales.
"""

from decimal import Decimal

import pytest

from stores import compras_anuales, rendimiento_activo


def fila(fecha, tipo, participaciones, coste, **extra):
    return {
        "fecha_operacion": fecha, "tipo_operacion": tipo, "participaciones": str(participaciones),
        "capital_invertido_bruto": str(coste), "precio_participacion": "", **extra,
    }


def venta(fecha, cantidad):
    return {"fecha": fecha, "cantidad": str(cantidad)}


# ── comprasPorAnio ───────────────────────────────────────────────────────────

class TestComprasPorAnio:
    def testAgrupaLasComprasPorAnio(self):
        filas = [
            fila("10-03-2024", "Compra", 10, 100),
            fila("10-06-2024", "Compra", 5, 100),
            fila("02-01-2025", "Compra", 4, 80),
        ]

        compras = rendimiento_activo.comprasPorAnio(filas, [], False)

        assert set(compras) == {2024, 2025}
        assert compras[2024].cantidadComprada == Decimal("15")
        assert compras[2024].costeComprado == Decimal("200")
        assert compras[2024].cantidadViva == Decimal("15")
        assert compras[2024].costeVivo == Decimal("200")
        assert compras[2025].costeVivo == Decimal("80")

    def testLaVentaConsumeLosLotesMasAntiguosPrimero(self):
        filas = [
            fila("10-03-2024", "Compra", 10, 100),
            fila("02-01-2025", "Compra", 10, 300),
            fila("01-02-2025", "Venta", 12, 0),
        ]

        compras = rendimiento_activo.comprasPorAnio(filas, [], False)

        # FIFO: se van las 10 de 2024 y 2 de las de 2025.
        assert compras[2024].cantidadViva == Decimal("0")
        assert compras[2024].costeVivo == Decimal("0")
        assert compras[2024].costeComprado == Decimal("100")
        assert compras[2025].cantidadViva == Decimal("8")
        assert compras[2025].costeVivo == Decimal("240")

    def testLasVentasDeLaTablaVentasTambienCuentan(self):
        filas = [fila("10-03-2024", "Compra", 10, 100)]

        compras = rendimiento_activo.comprasPorAnio(filas, [], False, [venta("01-01-2025", 4)])

        assert compras[2024].cantidadViva == Decimal("6")
        assert compras[2024].costeVivo == Decimal("60")

    def testLaSumaDelCosteVivoCuadraConLotesVivos(self):
        filas = [
            fila("10-03-2023", "Compra", 3, 90),
            fila("10-03-2024", "Compra", 10, 100),
            fila("05-05-2024", "Venta", 7, 0),
            fila("02-01-2025", "Compra", 10, 300),
        ]
        ventas = [venta("01-02-2025", 2)]

        compras = rendimiento_activo.comprasPorAnio(filas, [], False, ventas)
        vivos = rendimiento_activo.lotesVivos(filas, [], False, ventas)

        assert sum((c.costeVivo for c in compras.values()), Decimal("0")) == sum(
            (lote["coste"] for lote in vivos), Decimal("0")
        )
        assert sum((c.cantidadViva for c in compras.values()), Decimal("0")) == sum(
            (lote["cantidad"] for lote in vivos), Decimal("0")
        )

    def testLaFechaIlegibleNoTieneAnio(self):
        filas = [fila("sin fecha", "Compra", 1, 7), fila("10-03-2024", "Compra", 2, 20)]

        compras = rendimiento_activo.comprasPorAnio(filas, [], False)

        assert set(compras) == {2024}

    def testSinMovimientosNoHayAnios(self):
        assert rendimiento_activo.comprasPorAnio([], [], False) == {}

    def testLaComisionEnCriptoReduceLoComprado(self):
        filas = [fila("10-03-2024", "Compra", 1, 1000, comisiones_cripto="0.1")]

        compras = rendimiento_activo.comprasPorAnio(filas, [], True)

        assert compras[2024].cantidadComprada == Decimal("0.9")


# ── resumenComprasPorAnio ────────────────────────────────────────────────────

def _insertarActivo(conn, assetId, precio, moneda="EUR", tipo="acciones"):
    conn.execute(
        "INSERT INTO activos (id, name, type, price, currency) VALUES (?, ?, ?, ?, ?)",
        (assetId, assetId.capitalize(), tipo, precio, moneda),
    )


def _insertarFila(conn, assetId, fecha, tipo, participaciones, capital):
    conn.execute(
        "INSERT INTO activo_rows (asset_id, fecha_operacion, tipo_operacion, participaciones, "
        "capital_invertido_bruto) VALUES (?, ?, ?, ?, ?)",
        (assetId, fecha, tipo, participaciones, capital),
    )


def _sinCambio(desde, hacia):
    return None


class TestResumenComprasPorAnio:
    def testValoraLoVivoAlPrecioActualYOrdenaDelMasReciente(self, tempDb):
        from core.db import getDb

        conn = getDb()
        _insertarActivo(conn, "apple", "150")
        _insertarFila(conn, "apple", "10-03-2024", "Compra", "10", "1000")
        _insertarFila(conn, "apple", "10-03-2025", "Compra", "10", "1200")
        _insertarFila(conn, "apple", "10-06-2025", "Venta", "5", "700")
        conn.commit()

        resumen = compras_anuales.resumenComprasPorAnio(conn, _sinCambio)

        assert [a["anio"] for a in resumen["anios"]] == [2025, 2024]
        anio2024 = resumen["anios"][1]
        # La venta de 2025 se lleva 5 de las 10 de 2024 (FIFO).
        assert anio2024["comprado"] == 1000.0
        assert anio2024["costeVivo"] == 500.0
        assert anio2024["valorActual"] == 750.0
        assert anio2024["rendimiento"] == 250.0
        assert anio2024["rendimientoPct"] == 50.0
        assert anio2024["pctVendido"] == 50.0
        assert anio2024["activos"][0]["pctVendido"] == 50.0
        anio2025 = resumen["anios"][0]
        assert anio2025["costeVivo"] == 1200.0
        assert anio2025["valorActual"] == 1500.0
        assert anio2025["pctVendido"] == 0.0

    def testConvierteAEurosConElCambioDeHoy(self, tempDb):
        from core.db import getDb

        conn = getDb()
        _insertarActivo(conn, "msft", "110", moneda="USD")
        _insertarFila(conn, "msft", "10-03-2024", "Compra", "1", "100")
        conn.commit()

        resumen = compras_anuales.resumenComprasPorAnio(
            conn, lambda desde, hacia: Decimal("0.5") if (desde, hacia) == ("USD", "EUR") else None
        )

        anio = resumen["anios"][0]
        assert anio["comprado"] == 50.0
        assert anio["valorActual"] == 55.0
        assert resumen["sinTipo"] == []

    def testSinCambioConocidoSeAvisaYNoSeConvierte(self, tempDb):
        from core.db import getDb

        conn = getDb()
        _insertarActivo(conn, "msft", "110", moneda="USD")
        _insertarFila(conn, "msft", "10-03-2024", "Compra", "1", "100")
        conn.commit()

        resumen = compras_anuales.resumenComprasPorAnio(conn, _sinCambio)

        assert resumen["sinTipo"] == ["USD"]
        assert resumen["anios"][0]["comprado"] == 100.0

    def testAnioVendidoEnteroNoTienePorcentajeDeRendimiento(self, tempDb):
        from core.db import getDb

        conn = getDb()
        _insertarActivo(conn, "apple", "150")
        _insertarFila(conn, "apple", "10-03-2024", "Compra", "10", "1000")
        _insertarFila(conn, "apple", "10-06-2025", "Venta", "10", "1400")
        conn.commit()

        anio = compras_anuales.resumenComprasPorAnio(conn, _sinCambio)["anios"][0]

        assert anio["anio"] == 2024
        assert anio["costeVivo"] == 0.0
        assert anio["rendimientoPct"] is None
        assert anio["pctVendido"] == 100.0

    def testLosActivosDelAnioVanPorImporteComprado(self, tempDb):
        from core.db import getDb

        conn = getDb()
        _insertarActivo(conn, "apple", "10")
        _insertarActivo(conn, "nvidia", "10")
        _insertarFila(conn, "apple", "10-03-2024", "Compra", "1", "100")
        _insertarFila(conn, "nvidia", "11-03-2024", "Compra", "1", "900")
        conn.commit()

        anio = compras_anuales.resumenComprasPorAnio(conn, _sinCambio)["anios"][0]

        assert anio["numActivos"] == 2
        assert [a["id"] for a in anio["activos"]] == ["nvidia", "apple"]

    def testCarteraVacia(self, tempDb):
        from core.db import getDb

        assert compras_anuales.resumenComprasPorAnio(getDb(), _sinCambio) == {"anios": [], "sinTipo": []}


# ── Ruta ─────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.activos import activosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(activosBp)
    return client, cabeceras


def testLaRutaDevuelveElResumen(cliente):
    from core.db import getDb

    client, _cabeceras = cliente
    conn = getDb()
    _insertarActivo(conn, "apple", "150")
    _insertarFila(conn, "apple", "10-03-2024", "Compra", "10", "1000")
    conn.commit()

    respuesta = client.get("/api/metricas/compras-anuales")

    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True
    assert datos["anios"][0]["anio"] == 2024
    assert datos["anios"][0]["valorActual"] == 1500.0


def testLaRutaPideSesion(crearApp, tempDb):
    from routes.activos import activosBp

    client = crearApp(activosBp).test_client()

    assert client.get("/api/metricas/compras-anuales").status_code == 401
