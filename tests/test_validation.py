import pytest

from core.errors import ValidationError
from core.validation import (
    asBool,
    asInt,
    asNumber,
    asRows,
    asText,
    asYear,
    oneOf,
)


class TestAsText:
    def testRecortaYConvierte(self):
        assert asText("  hola  ") == "hola"
        assert asText(42) == "42"
        assert asText(None, default="x") == "x"

    def testRechazaEstructuras(self):
        for value in ({"a": 1}, [1], (1,), {1}):
            with pytest.raises(ValidationError):
                asText(value, "campo")

    def testRechazaBool(self):
        # Sin este caso, True se guardaría literalmente como "True" en la BD.
        with pytest.raises(ValidationError):
            asText(True, "campo")

    def testObligatorio(self):
        with pytest.raises(ValidationError):
            asText("   ", "nombre", required=True)

    def testLimiteDeLongitud(self):
        assert asText("a" * 512) == "a" * 512
        with pytest.raises(ValidationError) as exc:
            asText("a" * 513, "nota")
        assert exc.value.field == "nota"


class TestAsNumber:
    @pytest.mark.parametrize("raw,expected", [
        ("1.234,56", 1234.56),
        ("1234.56", 1234.56),
        ("3,5", 3.5),
        ("-12", -12.0),
        (7, 7.0),
        (2.5, 2.5),
    ])
    def testFormatosAceptados(self, raw, expected):
        assert asNumber(raw) == pytest.approx(expected)

    def testVacioDevuelveDefault(self):
        assert asNumber("", default=0) == 0
        assert asNumber(None) is None

    def testRechazaNoNumerico(self):
        with pytest.raises(ValidationError):
            asNumber("abc", "importe")

    def testRechazaNanEInfinito(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with pytest.raises(ValidationError):
                asNumber(value, "importe")

    def testRango(self):
        assert asNumber("5", minimum=0, maximum=10) == 5
        with pytest.raises(ValidationError):
            asNumber("11", "pct", maximum=10)
        with pytest.raises(ValidationError):
            asNumber("-1", "pct", minimum=0)

    def testAsIntTrunca(self):
        assert asInt("7,9") == 7
        assert asInt(None, default=3) == 3


class TestAsBool:
    @pytest.mark.parametrize("raw", [True, 1, "1", "true", "YES", "on", "sí", "si"])
    def testVerdaderos(self, raw):
        assert asBool(raw) is True

    @pytest.mark.parametrize("raw", [False, 0, "0", "false", "no", ""])
    def testFalsos(self, raw):
        assert asBool(raw) is False

    def testDefault(self):
        assert asBool(None, default=True) is True


class TestOneOf:
    OPCIONES = {"LONG", "SHORT"}

    def testNormalizaAMayusculas(self):
        assert oneOf("long", self.OPCIONES, upper=True) == "LONG"

    def testUsaDefaultSiNoCoincide(self):
        assert oneOf("lateral", self.OPCIONES, default="LONG", upper=True) == "LONG"

    def testErrorSiNoHayDefault(self):
        with pytest.raises(ValidationError) as exc:
            oneOf("lateral", self.OPCIONES, "direccion", upper=True)
        assert exc.value.field == "direccion"


class TestAsRows:
    def testListaDeObjetos(self):
        rows = [{"a": 1}, {"b": 2}]
        assert asRows(rows) == rows
        assert asRows(None) == []

    def testRechazaNoLista(self):
        with pytest.raises(ValidationError):
            asRows({"a": 1})

    def testRechazaElementosNoObjeto(self):
        with pytest.raises(ValidationError):
            asRows([{"a": 1}, "texto"])

    def testTopeDeFilas(self):
        with pytest.raises(ValidationError):
            asRows([{} for _ in range(11)], maxRows=10)


class TestAsYear:
    def testValido(self):
        assert asYear("2026") == "2026"
        assert asYear(2026) == "2026"

    @pytest.mark.parametrize("raw", ["26", "20266", "abcd", "1800", "2300", ""])
    def testInvalido(self, raw):
        with pytest.raises(ValidationError):
            asYear(raw)
