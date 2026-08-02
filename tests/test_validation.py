import pytest

from core.errors import ValidationError
from core.validation import (
    as_bool,
    as_int,
    as_number,
    as_rows,
    as_text,
    as_year,
    one_of,
)


class TestAsText:
    def test_recorta_y_convierte(self):
        assert as_text("  hola  ") == "hola"
        assert as_text(42) == "42"
        assert as_text(None, default="x") == "x"

    def test_rechaza_estructuras(self):
        for value in ({"a": 1}, [1], (1,), {1}):
            with pytest.raises(ValidationError):
                as_text(value, "campo")

    def test_rechaza_bool(self):
        # Sin este caso, True se guardaría literalmente como "True" en la BD.
        with pytest.raises(ValidationError):
            as_text(True, "campo")

    def test_obligatorio(self):
        with pytest.raises(ValidationError):
            as_text("   ", "nombre", required=True)

    def test_limite_de_longitud(self):
        assert as_text("a" * 512) == "a" * 512
        with pytest.raises(ValidationError) as exc:
            as_text("a" * 513, "nota")
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
    def test_formatos_aceptados(self, raw, expected):
        assert as_number(raw) == pytest.approx(expected)

    def test_vacio_devuelve_default(self):
        assert as_number("", default=0) == 0
        assert as_number(None) is None

    def test_rechaza_no_numerico(self):
        with pytest.raises(ValidationError):
            as_number("abc", "importe")

    def test_rechaza_nan_e_infinito(self):
        for value in (float("nan"), float("inf"), float("-inf")):
            with pytest.raises(ValidationError):
                as_number(value, "importe")

    def test_rango(self):
        assert as_number("5", minimum=0, maximum=10) == 5
        with pytest.raises(ValidationError):
            as_number("11", "pct", maximum=10)
        with pytest.raises(ValidationError):
            as_number("-1", "pct", minimum=0)

    def test_as_int_trunca(self):
        assert as_int("7,9") == 7
        assert as_int(None, default=3) == 3


class TestAsBool:
    @pytest.mark.parametrize("raw", [True, 1, "1", "true", "YES", "on", "sí", "si"])
    def test_verdaderos(self, raw):
        assert as_bool(raw) is True

    @pytest.mark.parametrize("raw", [False, 0, "0", "false", "no", ""])
    def test_falsos(self, raw):
        assert as_bool(raw) is False

    def test_default(self):
        assert as_bool(None, default=True) is True


class TestOneOf:
    OPCIONES = {"LONG", "SHORT"}

    def test_normaliza_a_mayusculas(self):
        assert one_of("long", self.OPCIONES, upper=True) == "LONG"

    def test_usa_default_si_no_coincide(self):
        assert one_of("lateral", self.OPCIONES, default="LONG", upper=True) == "LONG"

    def test_error_si_no_hay_default(self):
        with pytest.raises(ValidationError) as exc:
            one_of("lateral", self.OPCIONES, "direccion", upper=True)
        assert exc.value.field == "direccion"


class TestAsRows:
    def test_lista_de_objetos(self):
        rows = [{"a": 1}, {"b": 2}]
        assert as_rows(rows) == rows
        assert as_rows(None) == []

    def test_rechaza_no_lista(self):
        with pytest.raises(ValidationError):
            as_rows({"a": 1})

    def test_rechaza_elementos_no_objeto(self):
        with pytest.raises(ValidationError):
            as_rows([{"a": 1}, "texto"])

    def test_tope_de_filas(self):
        with pytest.raises(ValidationError):
            as_rows([{} for _ in range(11)], max_rows=10)


class TestAsYear:
    def test_valido(self):
        assert as_year("2026") == "2026"
        assert as_year(2026) == "2026"

    @pytest.mark.parametrize("raw", ["26", "20266", "abcd", "1800", "2300", ""])
    def test_invalido(self, raw):
        with pytest.raises(ValidationError):
            as_year(raw)
