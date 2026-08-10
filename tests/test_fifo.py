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
        ref=ref, activo_id="acme", fecha=fifo.parse_fecha(fecha), tipo=ADQUISICION,
        cantidad=Decimal(cantidad), importe=Decimal(importe),
        comision=Decimal(comision), orden=orden, origen="ficha", fiscal=False,
    )


def venta(ref, fecha, cantidad, importe, comision="0", orden=0, fiscal=True):
    return Operacion(
        ref=ref, activo_id="acme", fecha=fifo.parse_fecha(fecha), tipo=TRANSMISION,
        cantidad=Decimal(cantidad), importe=Decimal(importe),
        comision=Decimal(comision), orden=orden, origen="ventas", fiscal=fiscal,
    )


class TestParseo:
    @pytest.mark.parametrize("texto", ["05-03-2024", "05/03/2024", "2024-03-05"])
    def test_formatos_de_fecha_aceptados(self, texto):
        assert fifo.parse_fecha(texto) == date(2024, 3, 5)

    @pytest.mark.parametrize("texto", ["", "5 de marzo", "32-01-2024", "2024-13-01"])
    def test_fecha_ilegible_es_error(self, texto):
        with pytest.raises(fifo.FifoError):
            fifo.parse_fecha(texto)

    def test_numero_en_formato_espanol(self):
        assert fifo.parse_decimal("1.234,56") == Decimal("1234.56")
        assert fifo.parse_decimal("1234.56") == Decimal("1234.56")
        assert fifo.parse_decimal("") == Decimal("0")


class TestReparto:
    def test_consume_el_lote_mas_antiguo_primero(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "100"),   # 10 €/ud
            compra("c2", "01-06-2024", "10", "200"),   # 20 €/ud
            venta("v1", "01-09-2024", "15", "450"),    # 30 €/ud
        ]
        resultados, lotes = fifo.aplicar_fifo(operaciones)

        assert len(resultados) == 1
        resultado = resultados[0]
        # 10 del primer lote (100 €) + 5 del segundo (100 €).
        assert resultado.coste_adquisicion == Decimal("200")
        assert resultado.ganancia == Decimal("250")
        assert [c.lote_ref for c in resultado.lotes] == ["c1", "c2"]
        assert [c.cantidad for c in resultado.lotes] == [Decimal("10"), Decimal("5")]
        assert sum(lote.restante for lote in lotes) == Decimal("5")

    def test_las_comisiones_suman_al_comprar_y_restan_al_vender(self):
        # Valor de adquisición = importe + gastos; valor de transmisión =
        # importe - gastos (art. 35 LIRPF). Una comisión mal signada se come
        # el doble de la ganancia.
        operaciones = [
            compra("c1", "01-01-2024", "10", "100", comision="5"),
            venta("v1", "01-09-2024", "10", "200", comision="7"),
        ]
        resultados, _ = fifo.aplicar_fifo(operaciones)
        assert resultados[0].coste_adquisicion == Decimal("105")
        assert resultados[0].valor_transmision == Decimal("193")
        assert resultados[0].ganancia == Decimal("88")

    def test_las_perdidas_se_conservan_con_su_signo(self):
        # El cálculo anterior hacía Math.max(ganancia, 0) y una minusvalía
        # desaparecía en vez de compensar.
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-09-2024", "10", "600"),
        ]
        resultados, _ = fifo.aplicar_fifo(operaciones)
        assert resultados[0].ganancia == Decimal("-400")

    def test_vender_de_mas_no_consume_nada_y_deja_incidencia(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "100"),
            venta("v1", "01-09-2024", "15", "450"),
            venta("v2", "01-10-2024", "10", "400"),
        ]
        resultados, lotes = fifo.aplicar_fifo(operaciones)

        assert resultados[0].incidencia == fifo.INCIDENCIA_STOCK
        assert resultados[0].coste_adquisicion == Decimal("0")
        # La venta imposible no tocó los lotes, así que la siguiente sí cuadra.
        assert resultados[1].incidencia == ""
        assert resultados[1].coste_adquisicion == Decimal("100")
        assert lotes == []

    def test_venta_sin_ninguna_compra_previa(self):
        resultados, _ = fifo.aplicar_fifo([venta("v1", "01-09-2024", "5", "100")])
        assert resultados[0].incidencia == fifo.INCIDENCIA_SIN_LOTES

    def test_a_igual_fecha_la_compra_entra_antes_que_la_venta(self):
        operaciones = [
            venta("v1", "01-03-2024", "5", "150", orden=1),
            compra("c1", "01-03-2024", "5", "100", orden=2),
        ]
        resultados, _ = fifo.aplicar_fifo(operaciones)
        assert resultados[0].incidencia == ""
        assert resultados[0].ganancia == Decimal("50")

    def test_las_ventas_de_la_ficha_tambien_gastan_lotes(self):
        # Una venta apuntada en la ficha no declara, pero sí reduce lo que
        # queda disponible para la siguiente venta fiscal.
        operaciones = [
            compra("c1", "01-01-2024", "10", "100"),
            venta("f1", "01-02-2024", "6", "120", fiscal=False),
            venta("v1", "01-03-2024", "4", "100"),
        ]
        resultados, lotes = fifo.aplicar_fifo(operaciones)
        assert resultados[1].coste_adquisicion == Decimal("40")
        assert lotes == []


class TestAntiaplicacion:
    def test_recompra_dentro_de_dos_meses_bloquea_la_perdida(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),      # pérdida de 400
            compra("c2", "15-06-2024", "10", "600"),     # recompra a 14 días
        ]
        resultados, _ = fiscal_es.calcular_con_normativa(operaciones, "accion")
        resultado = next(r for r in resultados if r.ref == "v1")

        assert resultado.ganancia == Decimal("-400")
        assert resultado.perdida_no_computable == Decimal("400")
        assert resultado.ganancia_computable == Decimal("0")
        assert "33.5" in resultado.nota_antiaplicacion

    def test_la_perdida_bloqueada_se_libera_al_vender_la_recompra(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "15-06-2024", "10", "600"),
            venta("v2", "01-12-2024", "10", "700"),      # ganancia propia de 100
        ]
        resultados, _ = fiscal_es.calcular_con_normativa(operaciones, "accion")
        segunda = next(r for r in resultados if r.ref == "v2")

        assert segunda.ganancia == Decimal("100")
        assert segunda.perdida_diferida_liberada == Decimal("400")
        # Los 400 aplazados se imputan ahora: 100 - 400 = -300.
        assert segunda.ganancia_computable == Decimal("-300")

    def test_recompra_parcial_bloquea_solo_su_proporcion(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "15-06-2024", "4", "240"),
        ]
        resultados, _ = fiscal_es.calcular_con_normativa(operaciones, "accion")
        resultado = next(r for r in resultados if r.ref == "v1")

        assert resultado.perdida_no_computable == Decimal("160")   # 400 x 4/10
        assert resultado.ganancia_computable == Decimal("-240")

    def test_fuera_de_ventana_la_perdida_se_computa_entera(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "01-10-2024", "10", "600"),   # cuatro meses después
        ]
        resultados, _ = fiscal_es.calcular_con_normativa(operaciones, "accion")
        resultado = next(r for r in resultados if r.ref == "v1")
        assert resultado.perdida_no_computable == Decimal("0")

    def test_en_cripto_la_ventana_es_de_un_ano(self):
        operaciones = [
            compra("c1", "01-01-2024", "10", "1000"),
            venta("v1", "01-06-2024", "10", "600"),
            compra("c2", "01-10-2024", "10", "600"),
        ]
        resultados, _ = fiscal_es.calcular_con_normativa(operaciones, "cripto")
        resultado = next(r for r in resultados if r.ref == "v1")
        assert resultado.perdida_no_computable == Decimal("400")

    def test_una_recompra_no_bloquea_dos_perdidas_distintas(self):
        operaciones = [
            compra("c1", "01-01-2024", "20", "2000"),
            venta("v1", "01-06-2024", "10", "600"),    # pérdida 400
            venta("v2", "10-06-2024", "10", "600"),    # pérdida 400
            compra("c2", "15-06-2024", "10", "600"),   # solo cubre una
        ]
        resultados, _ = fiscal_es.calcular_con_normativa(operaciones, "accion")
        bloqueado = sum(r.perdida_no_computable for r in resultados)
        assert bloqueado == Decimal("400")


class TestEscala:
    def test_tramos_del_ejercicio_vigente(self):
        escala = fiscal_es.escala_del_ejercicio(2025)
        tramos = fiscal_es.repartir_en_tramos(Decimal("10000"), escala)
        # 6.000 al 19% + 4.000 al 21%.
        assert tramos["tramo1"] == Decimal("1140")
        assert tramos["tramo2"] == Decimal("840")
        assert sum(tramos.values()) == Decimal("1980")

    def test_un_ejercicio_antiguo_usa_su_propia_escala(self):
        # En 2020 el tipo máximo era el 23%, no el 28%.
        escala = fiscal_es.escala_del_ejercicio(2020)
        tramos = fiscal_es.repartir_en_tramos(Decimal("400000"), escala)
        assert tramos["tramo4"] == Decimal("0")
        assert sum(tramos.values()) == (
            Decimal("6000") * Decimal("0.19")
            + Decimal("44000") * Decimal("0.21")
            + Decimal("350000") * Decimal("0.23")
        )


class TestLiquidacion:
    def test_la_escala_se_aplica_una_vez_al_ano_no_por_venta(self):
        # La base del ahorro es anual: tres ventas de 5.000 € suman 15.000 y
        # los últimos 9.000 caen en el tramo del 21%. El cálculo anterior
        # metía cada fila entera en el primer tramo y se quedaba corto.
        operaciones = [compra("c0", "01-01-2023", "300", "0")]
        for indice in range(3):
            operaciones.append(
                venta(f"v{indice}", f"0{indice + 1}-06-2024", "100", "5000", orden=indice)
            )
        resultados, _ = fifo.aplicar_fifo(operaciones)
        liquidaciones = fiscal_es.liquidar_ejercicios({"2024": resultados})
        liquidacion = liquidaciones["2024"]

        assert liquidacion.ganancias == Decimal("15000")
        esperado = Decimal("6000") * Decimal("0.19") + Decimal("9000") * Decimal("0.21")
        assert liquidacion.cuota == esperado

        por_fila = sum(
            (sum(fiscal_es.repartir_en_tramos(
                r.ganancia, fiscal_es.escala_del_ejercicio(2024)).values())
             for r in resultados),
            Decimal("0"),
        )
        assert por_fila == Decimal("2850")
        assert liquidacion.cuota > por_fila

    def test_las_perdidas_del_ano_compensan_las_ganancias(self):
        operaciones = [
            compra("c1", "01-01-2023", "10", "1000"),
            compra("c2", "01-02-2023", "10", "1000"),
            venta("v1", "01-06-2024", "10", "3000", orden=1),    # +2000
            venta("v2", "01-07-2024", "10", "500", orden=2),     # -500
        ]
        resultados, _ = fifo.aplicar_fifo(operaciones)
        liquidacion = fiscal_es.liquidar_ejercicios({"2024": resultados})["2024"]

        assert liquidacion.saldo == Decimal("1500")
        assert liquidacion.base == Decimal("1500")
        assert liquidacion.cuota == Decimal("1500") * Decimal("0.19")

    def test_el_saldo_negativo_se_arrastra_al_ano_siguiente(self):
        perdida = [
            compra("c1", "01-01-2023", "10", "2000"),
            venta("v1", "01-06-2024", "10", "1000"),      # -1000
        ]
        ganancia = [
            compra("c2", "01-01-2023", "10", "1000"),
            venta("v2", "01-06-2025", "10", "4000"),      # +3000
        ]
        r2024, _ = fifo.aplicar_fifo(perdida)
        r2025, _ = fifo.aplicar_fifo(ganancia)
        liquidaciones = fiscal_es.liquidar_ejercicios({"2024": r2024, "2025": r2025})

        assert liquidaciones["2024"].base == Decimal("0")
        assert liquidaciones["2024"].saldo_negativo_generado == Decimal("1000")
        assert liquidaciones["2025"].compensado_anteriores == Decimal("1000")
        assert liquidaciones["2025"].base == Decimal("2000")

    def test_el_saldo_negativo_caduca_a_los_cuatro_ejercicios(self):
        perdida = [
            compra("c1", "01-01-2018", "10", "2000"),
            venta("v1", "01-06-2019", "10", "1000"),
        ]
        ganancia = [
            compra("c2", "01-01-2018", "10", "1000"),
            venta("v2", "01-06-2025", "10", "4000"),
        ]
        r_viejo, _ = fifo.aplicar_fifo(perdida)
        r_nuevo, _ = fifo.aplicar_fifo(ganancia)
        liquidaciones = fiscal_es.liquidar_ejercicios({"2019": r_viejo, "2025": r_nuevo})

        assert liquidaciones["2025"].compensado_anteriores == Decimal("0")
        assert liquidaciones["2025"].base == Decimal("3000")

    def test_el_reparto_por_venta_suma_exactamente_la_cuota_anual(self):
        operaciones = [compra("c0", "01-01-2023", "1000", "0")]
        for indice in range(5):
            operaciones.append(
                venta(f"v{indice}", f"0{indice + 1}-06-2024", "100", "20000", orden=indice)
            )
        resultados, _ = fifo.aplicar_fifo(operaciones)
        liquidacion = fiscal_es.liquidar_ejercicios({"2024": resultados})["2024"]
        reparto = fiscal_es.repartir_cuota_por_venta(
            resultados, liquidacion, fiscal_es.escala_del_ejercicio(2024)
        )

        total = sum(sum(tramos.values()) for tramos in reparto.values())
        assert total == liquidacion.cuota
        # Las primeras ventas ocupan el tramo bajo y las últimas el alto.
        assert reparto["v0"]["tramo1"] > 0
        assert reparto["v4"]["tramo1"] == 0

    def test_una_venta_con_incidencia_no_entra_en_la_liquidacion(self):
        operaciones = [
            compra("c1", "01-01-2023", "10", "1000"),
            venta("v1", "01-06-2024", "10", "3000", orden=1),
            venta("v2", "01-07-2024", "10", "3000", orden=2),   # sin stock
        ]
        resultados, _ = fifo.aplicar_fifo(operaciones)
        liquidacion = fiscal_es.liquidar_ejercicios({"2024": resultados})["2024"]
        assert liquidacion.ganancias == Decimal("2000")
