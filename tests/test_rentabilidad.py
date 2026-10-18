"""TWR, XIRR, drawdown y volatilidad sobre el histórico de snapshots.

Los casos están montados con números redondos y comprobados a mano, porque el
valor de estas métricas está justo en que no se dejen engañar por las
aportaciones y las retiradas.
"""

import datetime
import math

import pytest

from core import rentabilidad

DIA = 86400


def _ts(diaDelAnio, anio=2024, hora=12):
    """Timestamp local del día N de un año, para no pelearse con zonas horarias."""
    fecha = datetime.date(anio, 1, 1) + datetime.timedelta(days=diaDelAnio - 1)
    return int(datetime.datetime(fecha.year, fecha.month, fecha.day, hora).timestamp())


def serie(*puntos):
    """`(dia, valor, invertido)` → los snapshots que espera el módulo."""
    return [{"ts": _ts(d), "v": v, "i": i} for d, v, i in puntos]


class TestSerieDiaria:
    def testSeQuedaConElUltimoPuntoDeCadaDia(self):
        snaps = [
            {"ts": _ts(1, hora=9),  "v": 1000, "i": 1000},
            {"ts": _ts(1, hora=18), "v": 1050, "i": 1000},
            {"ts": _ts(2, hora=10), "v": 1100, "i": 1000},
        ]

        diaria = rentabilidad.serieDiaria(snaps)

        assert [p["v"] for p in diaria] == [1050, 1100]

    def testDescartaPuntosCorruptos(self):
        snaps = [
            {"ts": _ts(1), "v": 1000, "i": 1000},
            {"ts": _ts(2), "v": float("nan"), "i": 1000},
            {"ts": _ts(3), "v": "no es un número", "i": 1000},
        ]

        assert len(rentabilidad.serieDiaria(snaps)) == 1


class TestTwr:
    def testUnaAportacionNoCuentaComoRendimiento(self):
        # 1.000 € que suben a 1.100 (+10 %) y ese mismo día entran 900 € más.
        # El valor pasa de 1.000 a 2.000, pero la cartera solo ha rentado 10 %.
        datos = rentabilidad.twr(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 2000, 1900))
        ))

        assert datos["total"] == pytest.approx(0.10)

    def testUnaRetiradaTampocoCuentaComoPerdida(self):
        # De 1.000 a 1.100 (+10 %) y se sacan 500 €: el valor baja a 600.
        datos = rentabilidad.twr(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 600, 500))
        ))

        assert datos["total"] == pytest.approx(0.10)

    def testEncadenaLosSubperiodos(self):
        # +10 % y luego +10 % con una aportación por medio: 1,1 x 1,1 = 1,21.
        datos = rentabilidad.twr(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 2100, 2000), (3, 2310, 2000))
        ))

        assert datos["total"] == pytest.approx(0.21)

    def testNoAnualizaPeriodosDeMenosDeUnAnio(self):
        # Un +10 % en dos días anualizado son cinco cifras de rentabilidad
        # ficticia; se deja sin anualizar y que lo diga la interfaz.
        datos = rentabilidad.twr(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 1100, 1000))
        ))

        assert datos["anual"] is None

    def testAnualizaAPartirDelAnio(self):
        snaps = [
            {"ts": _ts(1, anio=2022), "v": 1000, "i": 1000},
            {"ts": _ts(1, anio=2024), "v": 1440, "i": 1000},
        ]

        datos = rentabilidad.twr(rentabilidad.serieDiaria(snaps))

        # +44 % en dos años ≈ +20 % anual compuesto.
        assert datos["total"] == pytest.approx(0.44)
        assert datos["anual"] == pytest.approx(0.20, abs=0.005)

    def testSinDatosSuficientesNoInventaUnaCifra(self):
        assert rentabilidad.twr([])["total"] is None
        assert rentabilidad.twr(rentabilidad.serieDiaria(serie((1, 1000, 1000))))["total"] is None

    def testUnaCarteraQueArrancaEnCeroEnganchaAlPrimerValor(self):
        # El primer tramo no tiene base sobre la que medir un porcentaje; el
        # rendimiento empieza a contar cuando ya hay dinero dentro.
        datos = rentabilidad.twr(rentabilidad.serieDiaria(
            serie((1, 0, 0), (2, 1000, 1000), (3, 1200, 1000))
        ))

        assert datos["total"] == pytest.approx(0.20)


class TestXirr:
    def testUnaInversionSimpleDaSuRentabilidadAnual(self):
        # 1.000 € que valen 1.100 justo un año después.
        flujos = [
            {"ts": _ts(1, anio=2023), "importe": -1000},
            {"ts": _ts(1, anio=2024), "importe": 1100},
        ]

        assert rentabilidad.xirr(flujos) == pytest.approx(0.10, abs=0.002)

    def testPonderaElMomentoDeLasAportaciones(self):
        # Dos años, 1.000 € al principio y 1.000 € al final, valor 2.200.
        # La ganancia (200 €) la ha generado casi solo el primer millar, así
        # que la TIR queda muy por encima del 200/2000 = 10 % ingenuo.
        flujos = [
            {"ts": _ts(1, anio=2022), "importe": -1000},
            {"ts": _ts(1, anio=2024), "importe": -1000},
            {"ts": _ts(2, anio=2024), "importe": 2200},
        ]

        tasa = rentabilidad.xirr(flujos)

        assert tasa == pytest.approx(0.0954, abs=0.005)

    def testLaXirrYLaTwrDiscrepanCuandoSeAportaAntesDeSubir(self):
        # Tramo 1: 1.000 → 1.000 (plano). Se aportan 9.000 €.
        # Tramo 2: 10.000 → 12.000 (+20 %).
        # La TWR es +20 % (la cartera), la XIRR es mucho mayor porque el
        # grueso del dinero estuvo dentro justo en la subida.
        snaps = serie((1, 1000, 1000), (200, 10000, 10000), (365, 12000, 10000))
        diaria = rentabilidad.serieDiaria(snaps)

        twr = rentabilidad.twr(diaria)["total"]
        tasa = rentabilidad.xirr(rentabilidad.flujosDeCaja(diaria))

        assert twr == pytest.approx(0.20)
        assert tasa > twr

    def testSinCambioDeSignoDevuelveNada(self):
        flujos = [
            {"ts": _ts(1), "importe": -1000},
            {"ts": _ts(2), "importe": -1000},
        ]

        assert rentabilidad.xirr(flujos) is None

    def testLosFlujosSalenDelInvertido(self):
        flujos = rentabilidad.flujosDeCaja(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 2100, 2000), (3, 1500, 1400))
        ))

        # Cartera inicial (-1.000), aportación de 1.000 (-1.000), venta de 600
        # (+600) y el valor vivo del final (+1.500).
        assert [f["importe"] for f in flujos] == [-1000, -1000, 600, 1500]


class TestDrawdown:
    def testMideLaCaidaDesdeElMaximo(self):
        # 100 → 120 → 90 → 110. La peor caída es 120 → 90, un -25 %.
        indice = rentabilidad.indiceTwr(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 1200, 1000), (3, 900, 1000), (4, 1100, 1000))
        ))

        datos = rentabilidad.drawdown(indice)

        assert datos["maximo"] == pytest.approx(-0.25)
        assert datos["ts_pico"] == _ts(2)
        assert datos["ts_valle"] == _ts(3)
        # Sigue por debajo del máximo: 110 sobre 120.
        assert datos["actual"] == pytest.approx(-1 / 12)

    def testUnaRetiradaNoEsUnDrawdown(self):
        # La cartera sube un 10 % y se sacan 900 €: el valor cae de 1.100 a
        # 200, pero no se ha perdido nada.
        indice = rentabilidad.indiceTwr(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 200, 100))
        ))

        assert rentabilidad.drawdown(indice)["maximo"] == pytest.approx(0.0)

    def testEnMaximosElDrawdownActualEsCero(self):
        indice = rentabilidad.indiceTwr(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 900, 1000), (3, 1500, 1000))
        ))

        assert rentabilidad.drawdown(indice)["actual"] == pytest.approx(0.0)


class TestVolatilidad:
    def testUnaSeriePlanaNoTieneVolatilidad(self):
        datos = rentabilidad.volatilidad(rentabilidad.serieDiaria(
            serie(*[(d, 1000, 1000) for d in range(1, 12)])
        ))

        assert datos["anual"] == pytest.approx(0.0)

    def testPocasMuestrasNoDanUnaCifra(self):
        datos = rentabilidad.volatilidad(rentabilidad.serieDiaria(
            serie((1, 1000, 1000), (2, 1100, 1000))
        ))

        assert datos["anual"] is None
        assert datos["muestras"] == 1

    def testAnualizaConLaRaizDelTiempo(self):
        # Sube y baja un 1 % en días alternos: la desviación típica diaria es
        # ~1 % y la anual, 1 % x √365 ≈ 19 %.
        valores = [1000 * (1.01 if d % 2 else 0.99) ** 1 for d in range(1, 21)]
        snaps = serie(*[(d + 1, v, 1000) for d, v in enumerate(valores)])

        datos = rentabilidad.volatilidad(rentabilidad.serieDiaria(snaps))

        assert datos["anual"] == pytest.approx(0.01 * 2 * math.sqrt(365), rel=0.15)

    def testUnHuecoEnElHistoricoNoInflaLaCifra(self):
        # Mismo rendimiento acumulado, pero uno registrado día a día y otro de
        # un tirón tras un mes sin snapshots: normalizar por √días evita que
        # el segundo salga con una volatilidad disparada.
        seguido  = serie(*[(d, 1000 * 1.01 ** (d - 1), 1000) for d in range(1, 13)])
        conHueco = serie(*[(1 + 30 * (d - 1), 1000 * 1.01 ** (d - 1), 1000) for d in range(1, 13)])

        volSeguido  = rentabilidad.volatilidad(rentabilidad.serieDiaria(seguido))["anual"]
        volHueco    = rentabilidad.volatilidad(rentabilidad.serieDiaria(conHueco))["anual"]

        assert volHueco == pytest.approx(volSeguido, abs=0.02)


class TestCoberturaAnual:
    def testCuentaDiasConDatosFrenteALosDelAnio(self):
        snaps = [
            {"ts": _ts(1, anio=2023), "v": 1000, "i": 1000},
            {"ts": _ts(1, anio=2023, hora=20), "v": 1010, "i": 1000},
            {"ts": _ts(200, anio=2023), "v": 1100, "i": 1000},
        ]

        cobertura = rentabilidad.coberturaAnual(snaps, hoy=datetime.date(2024, 6, 1))

        assert cobertura[2023] == {"dias": 2, "esperados": 365, "snapshots": 3, "pct": 0.5}

    def testElAnioEnCursoSoloEsperaLosDiasTranscurridos(self):
        snaps = [{"ts": _ts(d, anio=2024), "v": 1000, "i": 1000} for d in range(1, 11)]

        cobertura = rentabilidad.coberturaAnual(snaps, hoy=datetime.date(2024, 1, 10))

        assert cobertura[2024]["esperados"] == 10
        assert cobertura[2024]["pct"] == pytest.approx(100.0)


class TestResumen:
    def testDevuelveTodasLasMetricasJuntas(self):
        snaps = serie(*[(d, 1000 * 1.001 ** d, 1000) for d in range(1, 40)])

        datos = rentabilidad.resumen(snaps, hoy=datetime.date(2024, 6, 1))

        assert datos["twr"]["total"] > 0
        assert datos["xirr"] is not None
        assert datos["drawdown"]["maximo"] == pytest.approx(0.0)
        assert datos["volatilidad"]["anual"] is not None
        assert datos["dias"] == 39
        assert len(datos["indice"]) == 39

    def testUnHistoricoVacioNoRevienta(self):
        datos = rentabilidad.resumen([])

        assert datos["twr"]["total"] is None
        assert datos["xirr"] is None
        assert datos["indice"] == []
