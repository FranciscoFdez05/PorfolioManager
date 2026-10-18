"""Motor FIFO y normativa española.

Cada test fija uno de los fallos que tenía el cálculo cuando vivía en el
navegador, para que no puedan volver sin que la suite se entere.
"""

from datetime import date
from decimal import Decimal

import pytest

from core import fifo, fiscal_es
from core.fifo import ADQUISICION, TRANSMISION, Operacion


def compra(ref, fecha, cantidad, importe, comision="0", orden=0):
    return Operacion(
        ref=ref, activoId="acme", fecha=fifo.parseFecha(fecha), tipo=ADQUISICION,
        cantidad=Decimal(cantidad), importe=Decimal(importe),
        comision=Decimal(comision), orden=orden, origen="ficha", fiscal=False,
    )


def venta(ref, fecha, cantidad, importe, comision="0", orden=0, fiscal=True):
    return Operacion(
        ref=ref, activoId="acme", fecha=fifo.parseFecha(fecha), tipo=TRANSMISION,
        cantidad=Decimal(cantidad), importe=Decimal(importe),
        comision=Decimal(comision), orden=orden, origen="ventas", fiscal=fiscal,
    )


class TestParseo:
    @pytest.mark.parametrize("texto", ["05-03-2024", "05/03/2024", "2024-03-05"])
    def testFormatosDeFechaAceptados(self, texto):
        assert fifo.parseFecha(texto) == date(2024, 3, 5)

    @pytest.mark.parametrize("texto", ["", "5 de marzo", "32-01-2024", "2024-13-01"])
    def testFechaIlegibleEsError(self, texto):
        with pytest.raises(fifo.FifoError):
            fifo.parseFecha(texto)

    def testNumeroEnFormatoEspanol(self):
        assert fifo.parseDecimal("1.234,56") == Decimal("1234.56")
        assert fifo.parseDecimal("1234.56") == Decimal("1234.56")
        assert fifo.parseDecimal("") == Decimal("0")

    @pytest.mark.parametrize("texto", ["83,58 €", "83,58€", "€83,58", "83,58 EUR"])
    def testElSimboloDeLaDivisaNoInvalidaElImporte(self, texto):
        # La ficha guarda importes ya formateados. Antes reventaban el parseo,
        # el importe caía a cero y el lote entraba con coste de adquisición 0.
        assert fifo.parseDecimal(texto) == Decimal("83.58")

    @pytest.mark.parametrize("texto", ["12abc34", "no es un número"])
    def testUnImporteCorruptoSigueSiendoError(self, texto):
        with pytest.raises(fifo.FifoError):
            fifo.parseDecimal(texto)


class TestReparto:
    def testConsumeElLoteMasAntiguoPrimero(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "100"),   # 10 €/ud
            compra("c2", "01-06-2024", "10", "200"),   # 20 €/ud
            venta("v1", "01-09-2024", "15", "450"),    # 30 €/ud
        ]
        resultados, lotes = fifo.aplicarFifo(operaciones)

        assert len(resultados) == 1
        resultado = resultados[0]
        # 10 del primer lote (100 €) + 5 del segundo (100 €).
        assert resultado.costeAdquisicion == Decimal("200")
        assert resultado.ganancia == Decimal("250")
        assert [c.loteRef for c in resultado.lotes] == ["c1", "c2"]
        assert [c.cantidad for c in resultado.lotes] == [Decimal("10"), Decimal("5")]
        assert sum(lote.restante for lote in lotes) == Decimal("5")

    def testLasComisionesSumanAlComprarYRestanAlVender(self):
        # Valor de adquisición = importe + gastos; valor de transmisión =
        # importe - gastos (art. 35 LIRPF). Una comisión mal signada se come
        # el doble de la ganancia.
        operaciones = [
            compra("c1", "01-01-2024", "10", "100", comision="5"),
            venta("v1", "01-09-2024", "10", "200", comision="7"),
        ]
        resultados, _ = fifo.aplicarFifo(operaciones)
        assert resultados[0].costeAdquisicion == Decimal("105")
        assert resultados[0].valorTransmision == Decimal("193")
        assert resultados[0].ganancia == Decimal("88")

    def testLasPerdidasSeConservanConSuSigno(self):
        # El cálculo anterior hacía Math.max(ganancia, 0) y una minusvalía
        # desaparecía en vez de compensar.
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-09-2024", "10", "600"),
        ]
        resultados, _ = fifo.aplicarFifo(operaciones)
        assert resultados[0].ganancia == Decimal("-400")

    def testVenderDeMasNoConsumeNadaYDejaIncidencia(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "100"),
            venta("v1", "01-09-2024", "15", "450"),
            venta("v2", "01-10-2024", "10", "400"),
        ]
        resultados, lotes = fifo.aplicarFifo(operaciones)

        assert resultados[0].incidencia == fifo.INCIDENCIA_STOCK
        assert resultados[0].costeAdquisicion == Decimal("0")
        # La venta imposible no tocó los lotes, así que la siguiente sí cuadra.
        assert resultados[1].incidencia == ""
        assert resultados[1].costeAdquisicion == Decimal("100")
        assert lotes == []

    def testVentaSinNingunaCompraPrevia(self):
        resultados, _ = fifo.aplicarFifo([venta("v1", "01-09-2024", "5", "100")])
        assert resultados[0].incidencia == fifo.INCIDENCIA_SIN_LOTES

    def testAIgualFechaLaCompraEntraAntesQueLaVenta(self):
        operaciones = [
            venta("v1", "01-03-2024", "5", "150", orden=1),
            compra("c1", "01-03-2024", "5", "100", orden=2),
        ]
        resultados, _ = fifo.aplicarFifo(operaciones)
        assert resultados[0].incidencia == ""
        assert resultados[0].ganancia == Decimal("50")

    def testLasVentasDeLaFichaTambienGastanLotes(self):
        # Una venta apuntada en la ficha no declara, pero sí reduce lo que
        # queda disponible para la siguiente venta fiscal.
        operaciones = [
            compra("c1", "01-01-2024", "10", "100"),
            venta("f1", "01-02-2024", "6", "120", fiscal=False),
            venta("v1", "01-03-2024", "4", "100"),
        ]
        resultados, lotes = fifo.aplicarFifo(operaciones)
        assert resultados[1].costeAdquisicion == Decimal("40")
        assert lotes == []


class TestAntiaplicacion:
    def testRecompraDentroDeDosMesesBloqueaLaPerdida(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),      # pérdida de 400
            compra("c2", "15-06-2024", "10", "600"),     # recompra a 14 días
        ]
        resultados, _ = fiscal_es.calcularConNormativa(operaciones, "accion")
        resultado = next(r for r in resultados if r.ref == "v1")

        assert resultado.ganancia == Decimal("-400")
        assert resultado.perdidaNoComputable == Decimal("400")
        assert resultado.gananciaComputable == Decimal("0")
        assert "33.5" in resultado.notaAntiaplicacion

    def testLaPerdidaBloqueadaSeLiberaAlVenderLaRecompra(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "15-06-2024", "10", "600"),
            venta("v2", "01-12-2024", "10", "700"),      # ganancia propia de 100
        ]
        resultados, _ = fiscal_es.calcularConNormativa(operaciones, "accion")
        segunda = next(r for r in resultados if r.ref == "v2")

        assert segunda.ganancia == Decimal("100")
        assert segunda.perdidaDiferidaLiberada == Decimal("400")
        # Los 400 aplazados se imputan ahora: 100 - 400 = -300.
        assert segunda.gananciaComputable == Decimal("-300")

    def testRecompraParcialBloqueaSoloSuProporcion(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "15-06-2024", "4", "240"),
        ]
        resultados, _ = fiscal_es.calcularConNormativa(operaciones, "accion")
        resultado = next(r for r in resultados if r.ref == "v1")

        assert resultado.perdidaNoComputable == Decimal("160")   # 400 x 4/10
        assert resultado.gananciaComputable == Decimal("-240")

    def testFueraDeVentanaLaPerdidaSeComputaEntera(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "01-10-2024", "10", "600"),   # cuatro meses después
        ]
        resultados, _ = fiscal_es.calcularConNormativa(operaciones, "accion")
        resultado = next(r for r in resultados if r.ref == "v1")
        assert resultado.perdidaNoComputable == Decimal("0")

    def testEnCriptoLaVentanaEsDeUnAno(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "01-10-2024", "10", "600"),
        ]
        resultados, _ = fiscal_es.calcularConNormativa(operaciones, "cripto")
        resultado = next(r for r in resultados if r.ref == "v1")
        assert resultado.perdidaNoComputable == Decimal("400")

    def testUnaRecompraNoBloqueaDosPerdidasDistintas(self):
        operaciones = [
            compra("c1", "01-01-2024", "20", "2000"),
            venta("v1", "01-06-2024", "10", "600"),    # pérdida 400
            venta("v2", "10-06-2024", "10", "600"),    # pérdida 400
            compra("c2", "15-06-2024", "10", "600"),   # solo cubre una
        ]
        resultados, _ = fiscal_es.calcularConNormativa(operaciones, "accion")
        bloqueado = sum(r.perdidaNoComputable for r in resultados)
        assert bloqueado == Decimal("400")


class TestEscala:
    def testTramosDelEjercicioVigente(self):
        escala = fiscal_es.escalaDelEjercicio(2025)
        tramos = fiscal_es.repartirEnTramos(Decimal("10000"), escala)
        # 6.000 al 19% + 4.000 al 21%.
        assert tramos["tramo1"] == Decimal("1140")
        assert tramos["tramo2"] == Decimal("840")
        assert sum(tramos.values()) == Decimal("1980")

    def testUnEjercicioAntiguoUsaSuPropiaEscala(self):
        # En 2020 el tipo máximo era el 23%, no el 28%.
        escala = fiscal_es.escalaDelEjercicio(2020)
        tramos = fiscal_es.repartirEnTramos(Decimal("400000"), escala)
        assert tramos["tramo4"] == Decimal("0")
        assert sum(tramos.values()) == (
            Decimal("6000") * Decimal("0.19")
            + Decimal("44000") * Decimal("0.21")
            + Decimal("350000") * Decimal("0.23")
        )


class TestLiquidacion:
    def testLaEscalaSeAplicaUnaVezAlAnoNoPorVenta(self):
        # La base del ahorro es anual: tres ventas de 5.000 € suman 15.000 y
        # los últimos 9.000 caen en el tramo del 21%. El cálculo anterior
        # metía cada fila entera en el primer tramo y se quedaba corto.
        operaciones = [compra("c0", "01-01-2023", "300", "0")]
        for indice in range(3):
            operaciones.append(
                venta(f"v{indice}", f"0{indice + 1}-06-2024", "100", "5000", orden=indice)
            )
        resultados, _ = fifo.aplicarFifo(operaciones)
        liquidaciones = fiscal_es.liquidarEjercicios({"2024": resultados})
        liquidacion = liquidaciones["2024"]

        assert liquidacion.ganancias == Decimal("15000")
        esperado = Decimal("6000") * Decimal("0.19") + Decimal("9000") * Decimal("0.21")
        assert liquidacion.cuota == esperado

        porFila = sum(
            (sum(fiscal_es.repartirEnTramos(
                r.ganancia, fiscal_es.escalaDelEjercicio(2024)).values())
             for r in resultados),
            Decimal("0"),
        )
        assert porFila == Decimal("2850")
        assert liquidacion.cuota > porFila

    def testLasPerdidasDelAnoCompensanLasGanancias(self):
        operaciones = [
            compra("c1", "01-01-2023", "10", "1000"),
            compra("c2", "01-02-2023", "10", "1000"),
            venta("v1", "01-06-2024", "10", "3000", orden=1),    # +2000
            venta("v2", "01-07-2024", "10", "500", orden=2),     # -500
        ]
        resultados, _ = fifo.aplicarFifo(operaciones)
        liquidacion = fiscal_es.liquidarEjercicios({"2024": resultados})["2024"]

        assert liquidacion.saldo == Decimal("1500")
        assert liquidacion.base == Decimal("1500")
        assert liquidacion.cuota == Decimal("1500") * Decimal("0.19")

    def testElSaldoNegativoSeArrastraAlAnoSiguiente(self):
        perdida = [
            compra("c1", "01-01-2023", "10", "2000"),
            venta("v1", "01-06-2024", "10", "1000"),      # -1000
        ]
        ganancia = [
            compra("c2", "01-01-2023", "10", "1000"),
            venta("v2", "01-06-2025", "10", "4000"),      # +3000
        ]
        r2024, _ = fifo.aplicarFifo(perdida)
        r2025, _ = fifo.aplicarFifo(ganancia)
        liquidaciones = fiscal_es.liquidarEjercicios({"2024": r2024, "2025": r2025})

        assert liquidaciones["2024"].base == Decimal("0")
        assert liquidaciones["2024"].saldoNegativoGenerado == Decimal("1000")
        assert liquidaciones["2025"].compensadoAnteriores == Decimal("1000")
        assert liquidaciones["2025"].base == Decimal("2000")

    def testElSaldoNegativoCaducaALosCuatroEjercicios(self):
        perdida = [
            compra("c1", "01-01-2018", "10", "2000"),
            venta("v1", "01-06-2019", "10", "1000"),
        ]
        ganancia = [
            compra("c2", "01-01-2018", "10", "1000"),
            venta("v2", "01-06-2025", "10", "4000"),
        ]
        rViejo, _ = fifo.aplicarFifo(perdida)
        rNuevo, _ = fifo.aplicarFifo(ganancia)
        liquidaciones = fiscal_es.liquidarEjercicios({"2019": rViejo, "2025": rNuevo})

        assert liquidaciones["2025"].compensadoAnteriores == Decimal("0")
        assert liquidaciones["2025"].base == Decimal("3000")

    def testElRepartoPorVentaSumaExactamenteLaCuotaAnual(self):
        operaciones = [compra("c0", "01-01-2023", "1000", "0")]
        for indice in range(5):
            operaciones.append(
                venta(f"v{indice}", f"0{indice + 1}-06-2024", "100", "20000", orden=indice)
            )
        resultados, _ = fifo.aplicarFifo(operaciones)
        liquidacion = fiscal_es.liquidarEjercicios({"2024": resultados})["2024"]
        reparto = fiscal_es.repartirCuotaPorVenta(
            resultados, liquidacion, fiscal_es.escalaDelEjercicio(2024)
        )

        total = sum(sum(tramos.values()) for tramos in reparto.values())
        assert total == liquidacion.cuota
        # Las primeras ventas ocupan el tramo bajo y las últimas el alto.
        assert reparto["v0"]["tramo1"] > 0
        assert reparto["v4"]["tramo1"] == 0

    def testUnaVentaConIncidenciaNoEntraEnLaLiquidacion(self):
        operaciones = [
            compra("c1", "01-01-2023", "10", "1000"),
            venta("v1", "01-06-2024", "10", "3000", orden=1),
            venta("v2", "01-07-2024", "10", "3000", orden=2),   # sin stock
        ]
        resultados, _ = fifo.aplicarFifo(operaciones)
        liquidacion = fiscal_es.liquidarEjercicios({"2024": resultados})["2024"]
        assert liquidacion.ganancias == Decimal("2000")
