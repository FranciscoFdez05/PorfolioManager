"""Simulador de venta: qué pagarías si vendieras hoy.

Comparte motor con la pantalla de Ventas, así que lo que se prueba aquí es que
la simulación **no** se desvía de él: mismo coste FIFO, misma escala del ahorro
y misma regla de los dos meses. Y que no deja nada escrito, que es lo que
separa una simulación de una venta.
"""

import pytest

from stores import ventas_fifo
from stores.asset_store import writeAssetFile
from stores.ventas_store import (
    readVentasYear,
    sanitizeVentasPayload,
    validarParaGuardar,
    writeVentasYear,
)


def crearActivo(assetId="acme", tipo="accion", filas=()):
    writeAssetFile(assetId, {
        "name": assetId.upper(),
        "symbol": assetId.upper(),
        "type": tipo,
        "rows": list(filas),
    })


def compraFicha(fecha, participaciones, precio, comisiones="0"):
    return {
        "fechaOperacion": fecha,
        "tipoOperacion": "Compra",
        "participaciones": participaciones,
        "precioParticipacion": precio,
        "comisiones": comisiones,
    }


def guardarVenta(year, filas):
    payload, error = sanitizeVentasPayload({"year": year, "rows": filas}, year)
    assert error is None, error
    validarParaGuardar(payload)
    writeVentasYear(year, payload)
    return readVentasYear(year)


# ── Coste y ganancia ─────────────────────────────────────────────────────────

def testElCosteSaleDelFifoNoDelPrecioMedio(tempDb):
    crearActivo(filas=[
        compraFicha("01-01-2023", "10", "10"),   # 100 €
        compraFicha("01-06-2023", "10", "20"),   # 200 €
    ])

    dato, incidencia = ventas_fifo.simularVenta("acme", "01-09-2026", "15", "30")

    assert incidencia == ""
    # FIFO: las 10 primeras a 10 € y 5 de las segundas a 20 € = 200 €.
    # El precio medio (15 €) habría dado 225 €.
    assert dato["costeAdquisicion"] == "200.00"
    assert dato["valorTransmision"] == "450.00"
    assert dato["ganancia"] == "250.00"
    assert dato["disponible"] == "20.00000000"


def testDetallaLosLotesQueConsume(tempDb):
    crearActivo(filas=[
        compraFicha("01-01-2023", "10", "10"),
        compraFicha("01-06-2023", "10", "20"),
    ])

    dato, _ = ventas_fifo.simularVenta("acme", "01-09-2026", "15", "30")

    assert [(lote["fecha"], lote["cantidad"]) for lote in dato["lotes"]] == [
        ("01-01-2023", "10.00000000"),
        ("01-06-2023", "5.00000000"),
    ]


# ── Cuota ────────────────────────────────────────────────────────────────────

def testLaCuotaEsLaDelPrimerTramoCuandoNoHayMasVentas(tempDb):
    crearActivo(filas=[compraFicha("01-01-2023", "10", "100")])

    dato, _ = ventas_fifo.simularVenta("acme", "01-09-2026", "10", "200")

    # 1.000 € de ganancia, todo dentro del tramo del 19 %.
    assert dato["ganancia"] == "1000.00"
    assert dato["cuota"] == "190.00"
    assert dato["tipoEfectivo"] == "19.00"


def testLaCuotaEsIncrementalSobreLoYaVendidoEseAño(tempDb):
    """Con 6.000 € ya declarados, la ganancia nueva entra en el tramo del 21 %."""
    crearActivo(filas=[
        compraFicha("01-01-2023", "100", "10"),
        compraFicha("02-01-2023", "10", "100"),
    ])
    # Venta real de 2026: 6.000 € de ganancia, que agotan el primer tramo.
    guardarVenta("2026", [{
        "id": "v1", "fecha": "01-03-2026", "assetId": "acme",
        "cantidad": "100", "valorVenta": "70", "comisionVenta": "",
    }])

    dato, _ = ventas_fifo.simularVenta("acme", "01-09-2026", "10", "200")

    assert dato["ganancia"] == "1000.00"
    # Si se hubiera calculado aislada habrían salido 190 € (19 %).
    assert dato["cuota"] == "210.00"
    assert dato["tipoEfectivo"] == "21.00"
    assert dato["cuotaEjercicioAntes"] == "1140.00"
    assert dato["cuotaEjercicioDespues"] == "1350.00"


def testUnaPerdidaAnteriorCompensaYBajaElTipo(tempDb):
    crearActivo(filas=[
        compraFicha("01-01-2023", "10", "100"),   # 1.000 €
        compraFicha("02-01-2023", "10", "100"),
    ])
    # 2024 cierra con 500 € de pérdida.
    guardarVenta("2024", [{
        "id": "v1", "fecha": "01-03-2024", "assetId": "acme",
        "cantidad": "10", "valorVenta": "50", "comisionVenta": "",
    }])

    dato, _ = ventas_fifo.simularVenta("acme", "01-09-2026", "10", "200")

    assert dato["ganancia"] == "1000.00"
    assert dato["compensadoAnteriores"] == "500.00"
    # Solo tributan los 500 € que quedan después de compensar.
    assert dato["cuota"] == "95.00"


# ── Normativa y avisos ───────────────────────────────────────────────────────

def testLaPerdidaRecompradaNoComputa(tempDb):
    """Regla de los dos meses: recomprar bloquea la minusvalía (art. 33.5)."""
    crearActivo(filas=[
        compraFicha("01-01-2023", "10", "100"),
        compraFicha("15-09-2026", "10", "50"),   # recompra dentro de la ventana
    ])

    dato, _ = ventas_fifo.simularVenta("acme", "01-09-2026", "10", "50")

    assert dato["ganancia"] == "0.00"
    assert dato["perdidaNoComputable"] == "500.00"
    assert dato["notaAntiaplicacion"]


def testVenderMasDeLoQueHayAvisaSinRomper(tempDb):
    crearActivo(filas=[compraFicha("01-01-2023", "10", "100")])

    dato, incidencia = ventas_fifo.simularVenta("acme", "01-09-2026", "50", "200")

    assert incidencia == ""
    assert dato["incidencia"]
    assert "más participaciones de las disponibles" in dato["mensaje"]
    assert dato["disponible"] == "10.00000000"


def testCriptoUsaLaVentanaDeUnAño(tempDb):
    """Para los no cotizados la recompra bloquea durante un año, no dos meses."""
    crearActivo("btc", tipo="cripto", filas=[
        compraFicha("01-01-2023", "1", "40000"),
        compraFicha("01-03-2027", "1", "20000"),   # seis meses después
    ])

    dato, _ = ventas_fifo.simularVenta("btc", "01-09-2026", "1", "20000")

    assert dato["perdidaNoComputable"] == "20000.00"


# ── Entradas inválidas ───────────────────────────────────────────────────────

@pytest.mark.parametrize("args, esperado", [
    (("no-existe", "01-09-2026", "1", "10"), ventas_fifo.INCIDENCIA_ACTIVO),
    (("acme", "32-13-2026", "1", "10"), ventas_fifo.INCIDENCIA_FECHA),
    (("acme", "01-09-2026", "0", "10"), ventas_fifo.INCIDENCIA_CANTIDAD),
    (("acme", "01-09-2026", "1", "-5"), ventas_fifo.INCIDENCIA_PRECIO),
])
def testEntradasInvalidas(tempDb, args, esperado):
    crearActivo(filas=[compraFicha("01-01-2023", "10", "100")])

    dato, incidencia = ventas_fifo.simularVenta(*args)

    assert dato is None
    assert incidencia == esperado


def testSimularNoGuardaNada(tempDb):
    crearActivo(filas=[compraFicha("01-01-2023", "10", "100")])
    antes = ventas_fifo.carteraViva()["acme"]["cantidad"]

    ventas_fifo.simularVenta("acme", "01-09-2026", "5", "200")

    assert ventas_fifo.carteraViva()["acme"]["cantidad"] == antes
