"""La tabla de ventas de punta a punta: BD → línea temporal → liquidación."""

import pytest

from core.errors import ValidationError
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


def guardar(year, filas):
    payload, error = sanitizeVentasPayload({"year": year, "rows": filas}, year)
    assert error is None, error
    validarParaGuardar(payload)
    writeVentasYear(year, payload)
    return readVentasYear(year)


def venta(id_, fecha, cantidad, valor, assetId="acme", comision=""):
    return {
        "id": id_,
        "fecha": fecha,
        "assetId": assetId,
        "cantidad": cantidad,
        "valorVenta": valor,
        "comisionVenta": comision,
    }


class TestCalculo:
    def testCosteFifoYCuotaLosPoneElServidor(self, tempDb):
        crearActivo(filas=[
            compraFicha("01-01-2023", "10", "10"),    # 100 €
            compraFicha("01-06-2023", "10", "20"),    # 200 €
        ])
        datos = guardar("2024", [venta("v1", "01-09-2024", "15", "30")])

        fila = datos["rows"][0]
        # 10 a 10 € + 5 a 20 € = 200 € de coste sobre 15 participaciones.
        assert fila["costeAdquisicion"] == "200.00"
        assert fila["valorCompra"] == "13.33"
        assert fila["dineroDeclarar"] == "250.00"
        assert fila["totalPagar"] == "47.50"          # 250 x 19%
        assert fila["neto"] == "402.50"
        assert fila["incidencia"] == ""

    def testUnaCompraConLaDivisaEnElImporteCuentaIgual(self, tempDb):
        # La ficha guarda a veces el importe ya formateado ("10,00 €"). Antes se
        # leía como 0: el lote entraba con coste cero y la venta declaraba el
        # precio íntegro de esa compra como ganancia.
        crearActivo(filas=[
            compraFicha("01-01-2023", "10", "10,00 €"),
            compraFicha("01-06-2023", "10", "20"),
        ])
        fila = guardar("2024", [venta("v1", "01-09-2024", "15", "30")])["rows"][0]

        assert fila["costeAdquisicion"] == "200.00"
        assert fila["dineroDeclarar"] == "250.00"

    def testLosImportesQueMandaElClienteSeIgnoran(self, tempDb):
        # El POST antes escribía estos campos tal cual. Ahora son derivados.
        crearActivo(filas=[compraFicha("01-01-2023", "10", "10")])
        filaManipulada = venta("v1", "01-09-2024", "10", "30")
        filaManipulada.update({
            "dineroDeclarar": "0", "totalPagar": "0", "valorCompra": "999",
        })
        datos = guardar("2024", [filaManipulada])

        assert datos["rows"][0]["valorCompra"] == "10.00"
        assert datos["rows"][0]["dineroDeclarar"] == "200.00"

    def testLaTrazaDeLotesAcompanaACadaVenta(self, tempDb):
        crearActivo(filas=[
            compraFicha("01-01-2023", "10", "10"),
            compraFicha("01-06-2023", "10", "20"),
        ])
        datos = guardar("2024", [venta("v1", "01-09-2024", "15", "30")])

        lotes = datos["rows"][0]["lotes"]
        assert len(lotes) == 2
        assert lotes[0]["fecha"] == "01-01-2023"
        assert lotes[0]["cantidad"] == "10.00000000"
        assert lotes[1]["coste"] == "100.00"

    def testLaComisionDeVentaMinoraElValorDeTransmision(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "10", "10")])
        datos = guardar("2024", [venta("v1", "01-09-2024", "10", "30", comision="25")])

        assert datos["rows"][0]["valorTransmision"] == "275.00"
        assert datos["rows"][0]["dineroDeclarar"] == "175.00"

    def testUnaVentaAnteriorNoSeRegalaALaSiguiente(self, tempDb):
        # El fallo que arrastraba la versión en el navegador: al abrir 2026 se
        # reconstruían los lotes sin descontar lo vendido en 2025, y las dos
        # ventas usaban el mismo lote barato.
        crearActivo(filas=[
            compraFicha("01-01-2023", "10", "10"),    # 10 €/ud
            compraFicha("01-06-2023", "10", "50"),    # 50 €/ud
        ])
        guardar("2025", [venta("v1", "01-09-2025", "10", "60")])
        datos = guardar("2026", [venta("v2", "01-09-2026", "10", "60")])

        assert datos["rows"][0]["valorCompra"] == "50.00"
        assert datos["rows"][0]["dineroDeclarar"] == "100.00"

    def testLosTramosDeLasFilasSumanLaCuotaDelEjercicio(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "1000", "1")])
        datos = guardar("2024", [
            venta("v1", "01-03-2024", "100", "51"),
            venta("v2", "01-06-2024", "100", "51"),
            venta("v3", "01-09-2024", "100", "51"),
        ])

        from decimal import Decimal
        suma = sum(
            Decimal(fila[f"tramo{n}"]) for fila in datos["rows"] for n in range(1, 6)
        )
        assert suma == Decimal(datos["resumen"]["cuota"])


class TestIncidencias:
    def testVenderMasDeLoDisponibleSeGuardaMarcado(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "5", "10")])
        datos = guardar("2024", [venta("v1", "01-09-2024", "50", "30")])

        fila = datos["rows"][0]
        assert fila["incidencia"] == "stock_insuficiente"
        assert fila["dineroDeclarar"] == ""
        assert "más participaciones de las disponibles" in fila["mensaje"]
        assert datos["incidencias"][0]["id"] == "v1"
        # Y no contamina la liquidación del ejercicio.
        assert datos["resumen"]["cuota"] == "0.00"

    def testUnaFechaIlegibleImpideGuardar(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "10", "10")])
        with pytest.raises(ValidationError) as error:
            guardar("2024", [venta("v1", "el martes", "1", "30")])
        assert error.value.details[0]["codigo"] == ventas_fifo.INCIDENCIA_FECHA

    def testUnaCantidadDeCeroImpideGuardar(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "10", "10")])
        with pytest.raises(ValidationError):
            guardar("2024", [venta("v1", "01-09-2024", "0", "30")])

    def testUnActivoInexistenteImpideGuardar(self, tempDb):
        crearActivo()
        with pytest.raises(ValidationError):
            guardar("2024", [venta("v1", "01-09-2024", "1", "30", assetId="fantasma")])

    def testUnaFechaDeOtroEjercicioImpideGuardar(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "10", "10")])
        with pytest.raises(ValidationError) as error:
            guardar("2024", [venta("v1", "01-09-2025", "1", "30")])
        assert error.value.details[0]["codigo"] == ventas_fifo.INCIDENCIA_ANIO

    def testUnaFilaAMedioRellenarSeGuardaMarcadaSinBloquear(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "10", "10")])
        datos = guardar("2024", [
            venta("v1", "", "", ""),                     # solo el activo elegido
            venta("v2", "01-09-2024", "5", "30"),
        ])
        assert datos["rows"][0]["incidencia"] == ventas_fifo.INCIDENCIA_CANTIDAD
        assert datos["rows"][1]["dineroDeclarar"] == "100.00"

    def testDosFilasConElMismoIdSeRechazan(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "10", "10")])
        payload, error = sanitizeVentasPayload({
            "year": "2024",
            "rows": [venta("v1", "01-09-2024", "1", "30"),
                     venta("v1", "02-09-2024", "1", "30")],
        }, "2024")
        assert payload is None
        assert "mismo identificador" in error


class TestNormativa:
    def testLaRecompraRapidaBloqueaLaMinusvalia(self, tempDb):
        crearActivo(filas=[
            compraFicha("01-01-2023", "10", "100"),
            compraFicha("15-06-2024", "10", "60"),
        ])
        datos = guardar("2024", [venta("v1", "01-06-2024", "10", "60")])

        fila = datos["rows"][0]
        assert fila["dineroDeclarar"] == "0.00"
        assert fila["perdidaNoComputable"] == "400.00"
        assert fila["notaAntiaplicacion"]

    def testElSaldoNegativoDeUnAnoCompensaElSiguiente(self, tempDb):
        crearActivo(filas=[
            compraFicha("01-01-2023", "10", "200"),
            compraFicha("01-02-2023", "10", "100"),
        ])
        guardar("2024", [venta("v1", "01-06-2024", "10", "100")])    # -1000
        datos = guardar("2025", [venta("v2", "01-06-2025", "10", "400")])

        assert datos["resumen"]["compensadoAnteriores"] == "1000.00"
        assert datos["resumen"]["base"] == "2000.00"


class TestCache:
    """`calcularTodo()` memoiza por hilo (ver el docstring en ventas_fifo.py).

    Lo único que de verdad puede fallar con una caché es que se quede con un
    dato viejo, así que lo que importa comprobar es precisamente el caso que
    `refrescarCalculo()` NO cubre: un cambio en la ficha del activo, que es
    la otra fuente de la línea temporal y que nadie invalida a mano.
    """

    def testUnCambioEnLaFichaSeVeSinPasarPorVentasStore(self, tempDb):
        crearActivo(filas=[compraFicha("01-01-2023", "5", "10")])
        datos = guardar("2024", [venta("v1", "01-09-2024", "50", "30")])
        assert datos["rows"][0]["incidencia"] == "stock_insuficiente"

        # Se amplía la ficha del activo directamente, sin pasar por
        # writeVentasYear/refrescarCalculo: ahora sí hay lotes para las 50.
        crearActivo(filas=[compraFicha("01-01-2023", "60", "10")])

        datos = readVentasYear("2024")
        assert datos["rows"][0]["incidencia"] == ""
        assert datos["rows"][0]["costeAdquisicion"] == "500.00"
