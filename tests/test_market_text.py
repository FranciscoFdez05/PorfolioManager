import pytest

from providers.text import compact_symbol, format_decimal, format_percent, normalize_text, safe_float


class TestSafeFloat:
    @pytest.mark.parametrize("raw,expected", [
        ("12.3", 12.3),
        ("1.234,56", 1234.56),
        ("3,5%", 3.5),
        (7, 7.0),
        (2.5, 2.5),
    ])
    def test_valores_validos(self, raw, expected):
        assert safe_float(raw) == pytest.approx(expected)

    @pytest.mark.parametrize("raw", ["", None, "N/A", "NA", "-", "--", "null", "texto"])
    def test_sin_dato_usa_fallback(self, raw):
        assert safe_float(raw) == 0.0
        assert safe_float(raw, fallback=None) is None

    def test_nan_e_infinito_son_sin_dato(self):
        # Un NaN de un proveedor propagado a los totales daba importes "NaN €".
        assert safe_float(float("nan")) == 0.0
        assert safe_float(float("inf")) == 0.0

    def test_bool_no_es_numero(self):
        assert safe_float(True, fallback=-1) == -1


class TestFormatDecimal:
    def test_coma_decimal(self):
        assert format_decimal(1234.5) == "1234,50"
        assert format_decimal(3.14159, 4) == "3,1416"

    def test_acepta_cadenas(self):
        # EODHD devuelve precios como texto: la versión anterior lanzaba
        # TypeError al hacer f"{'12.3':.2f}".
        assert format_decimal("12.3") == "12,30"
        assert format_decimal("1.234,56") == "1234,56"

    def test_valor_invalido_no_revienta(self):
        assert format_decimal(None) == "0,00"
        assert format_decimal("N/A") == "0,00"


class TestFormatPercent:
    def test_signo(self):
        assert format_percent(2.5) == "+2,50%"
        assert format_percent(-2.5) == "-2,50%"
        assert format_percent(0) == "+0,00%"

    def test_valor_invalido(self):
        assert format_percent(None) == "+0,00%"


def test_normalize_text():
    assert normalize_text("Apple Inc.") == "appleinc"
    assert normalize_text(None) == ""


def test_compact_symbol():
    assert compact_symbol("btc-usd") == "BTCUSD"
    assert compact_symbol("EUR/USD") == "EURUSD"
    assert compact_symbol(None) == ""
