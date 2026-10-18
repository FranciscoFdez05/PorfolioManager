import pytest

from providers.text import compactSymbol, formatDecimal, formatPercent, normalizeText, safeFloat


class TestSafeFloat:
    @pytest.mark.parametrize("raw,expected", [
        ("12.3", 12.3),
        ("1.234,56", 1234.56),
        ("3,5%", 3.5),
        (7, 7.0),
        (2.5, 2.5),
    ])
    def testValoresValidos(self, raw, expected):
        assert safeFloat(raw) == pytest.approx(expected)

    @pytest.mark.parametrize("raw", ["", None, "N/A", "NA", "-", "--", "null", "texto"])
    def testSinDatoUsaFallback(self, raw):
        assert safeFloat(raw) == 0.0
        assert safeFloat(raw, fallback=None) is None

    def testNanEInfinitoSonSinDato(self):
        # Un NaN de un proveedor propagado a los totales daba importes "NaN €".
        assert safeFloat(float("nan")) == 0.0
        assert safeFloat(float("inf")) == 0.0

    def testBoolNoEsNumero(self):
        assert safeFloat(True, fallback=-1) == -1


class TestFormatDecimal:
    def testComaDecimal(self):
        assert formatDecimal(1234.5) == "1234,50"
        assert formatDecimal(3.14159, 4) == "3,1416"

    def testAceptaCadenas(self):
        # EODHD devuelve precios como texto: la versión anterior lanzaba
        # TypeError al hacer f"{'12.3':.2f}".
        assert formatDecimal("12.3") == "12,30"
        assert formatDecimal("1.234,56") == "1234,56"

    def testValorInvalidoNoRevienta(self):
        assert formatDecimal(None) == "0,00"
        assert formatDecimal("N/A") == "0,00"


class TestFormatPercent:
    def testSigno(self):
        assert formatPercent(2.5) == "+2,50%"
        assert formatPercent(-2.5) == "-2,50%"
        assert formatPercent(0) == "+0,00%"

    def testValorInvalido(self):
        assert formatPercent(None) == "+0,00%"


def testNormalizeText():
    assert normalizeText("Apple Inc.") == "appleinc"
    assert normalizeText(None) == ""


def testCompactSymbol():
    assert compactSymbol("btc-usd") == "BTCUSD"
    assert compactSymbol("EUR/USD") == "EURUSD"
    assert compactSymbol(None) == ""
