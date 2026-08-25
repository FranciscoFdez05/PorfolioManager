"""Pruebas de la conversión única entre texto e importes.

Todo el dinero del proyecto entra y sale por aquí, así que estas pruebas son la
red que sostiene al resto: si `aDecimal` se equivoca, se equivocan a la vez la
declaración de la renta, el rendimiento por activo y el histórico.

Las tablas de esta suite documentan a la vez las tres decisiones que no son
obvias: qué formatos se aceptan, qué se rechaza en vez de adivinarse, y por qué
el redondeo no es el que trae `Decimal` de fábrica.
"""

from decimal import Decimal

import pytest

from core.dinero import (
    ImporteInvalido,
    aDecimal,
    aDecimalONulo,
    aTexto,
    aTextoEs,
    esCero,
    redondear,
    sumar,
)

# ── Lo que se acepta ──────────────────────────────────────────────────────────

@pytest.mark.parametrize("entrada,esperado", [
    # Formato español, que es como el esquema guarda los importes.
    ("1.234,56", "1234.56"),
    ("0,1", "0.1"),
    ("-1.234,56", "-1234.56"),
    # Canónico, que es como los serializa el motor FIFO.
    ("1234.56", "1234.56"),
    ("-12", "-12"),
    # Con la divisa pegada: la ficha del activo guarda "83,58 €".
    ("83,58 €", "83.58"),
    ("1234.56 USD", "1234.56"),
    ("$1.234,56", "1234.56"),
    # Con el porcentaje pegado: las rentabilidades se teclean con él.
    ("12,5%", "12.5"),
    # Espacios de miles del navegador. Los caracteres raros son deliberados y
    # son justo lo que se prueba: NBSP (U+00A0) y espacio fino irrompible
    # (U+202F), que es lo que inserta `Intl.NumberFormat` y `Decimal` no digiere.
    ("1 234,56", "1234.56"),  # noqa: RUF001
    ("1 234,56", "1234.56"),  # noqa: RUF001
    ("  7,50  ", "7.5"),
    # Tipos nativos.
    (7, "7"),
    (Decimal("3.14"), "3.14"),
])
def test_formatos_aceptados(entrada, esperado):
    assert aDecimal(entrada) == Decimal(esperado)


def test_un_float_no_arrastra_su_cola_binaria():
    """`Decimal(0.1)` da 0.1000000000000000055511151231257827; `repr` da 0.1."""
    assert aDecimal(0.1) == Decimal("0.1")
    assert aDecimal(2.675) == Decimal("2.675")


def test_el_punto_solo_es_separador_decimal():
    """Decisión heredada: cambiarla reinterpretaría datos ya guardados."""
    assert aDecimal("1.234") == Decimal("1.234")


# ── Lo que se rechaza en vez de adivinarse ────────────────────────────────────

@pytest.mark.parametrize("entrada", [
    # El caso que motivó el módulo: descartar los caracteres no numéricos
    # convertía esto en 1234 y lo colaba como un importe legítimo.
    "12abc34",
    "abc",
    "-",
    "--5",
    "1,2,3",
    "1..2",
    # Notación exponencial: dos de los parsers antiguos daban 13 y los otros
    # 1000. Sin acuerdo posible, no se acepta.
    "1e3",
    # NaN e infinito envenenarían cualquier suma posterior sin lanzar nada.
    "NaN",
    "Infinity",
    "-inf",
    float("nan"),
    float("inf"),
    # Un booleano donde se espera un importe es un error de quien llama.
    True,
    False,
])
def test_entradas_rechazadas(entrada):
    with pytest.raises(ImporteInvalido):
        aDecimal(entrada)


@pytest.mark.parametrize("entrada", ["", "   ", None])
def test_el_vacio_tambien_falla_sin_defecto_explicito(entrada):
    """Una columna vacía puede ser legítima, pero decidirlo es de quien llama."""
    with pytest.raises(ImporteInvalido):
        aDecimal(entrada)


def test_el_defecto_convierte_el_fallo_en_un_valor():
    assert aDecimal("", defecto=Decimal("0")) == Decimal("0")
    assert aDecimal("basura", defecto=Decimal("0")) == Decimal("0")
    assert aDecimal(None, defecto=Decimal("1")) == Decimal("1")


def test_el_mensaje_de_error_nombra_el_campo():
    """Para que un 400 diga cuál de los quince campos del formulario falla."""
    with pytest.raises(ImporteInvalido, match="comisiones"):
        aDecimal("basura", "comisiones")


def test_a_decimal_o_nulo_no_levanta():
    assert aDecimalONulo("basura") is None
    assert aDecimalONulo("") is None
    assert aDecimalONulo("1,5") == Decimal("1.5")


# ── Formato de almacenamiento ─────────────────────────────────────────────────

@pytest.mark.parametrize("entrada,esperado", [
    ("1.234,56", "1234.56"),
    ("83,58 €", "83.58"),
    ("0,10", "0.1"),
    (Decimal("100"), "100"),
    # Sin exponentes: `str(Decimal("1E+3"))` da "1E+3", que no se relee igual.
    (Decimal("1E+3"), "1000"),
    (Decimal("0E-8"), "0"),
    ("-0,50", "-0.5"),
])
def test_a_texto_es_canonico(entrada, esperado):
    assert aTexto(entrada) == esperado


def test_a_texto_con_escala_fija():
    assert aTexto("7", decimales=2) == "7.00"
    assert aTexto("1,005", decimales=2) == "1.01"


@pytest.mark.parametrize("entrada", ["1.234,56", "83,58 €", "0,001", "-99,99", "1234.56"])
def test_ida_y_vuelta(entrada):
    """Lo que escribe `aTexto` lo tiene que volver a leer `aDecimal` igual.

    Es la propiedad que hace utilizable el formato canónico: sin ella, guardar
    y releer un importe lo cambiaría poco a poco.
    """
    assert aDecimal(aTexto(entrada)) == aDecimal(entrada)


def test_a_texto_no_emite_separador_de_miles():
    """Emitirlo haría el valor ambiguo al releerlo (ver el docstring del módulo)."""
    assert aTexto("1234567,89") == "1234567.89"


# ── Formato de presentación ───────────────────────────────────────────────────

@pytest.mark.parametrize("entrada,esperado", [
    ("1234567.891", "1.234.567,89"),
    ("0", "0,00"),
    ("-1234.5", "-1.234,50"),
    ("999", "999,00"),
    ("1000", "1.000,00"),
])
def test_a_texto_es_espaniol(entrada, esperado):
    assert aTextoEs(entrada) == esperado


def test_a_texto_es_sin_miles():
    """La forma que usa `helpers.format_decimal`, que acaba en columnas TEXT."""
    assert aTextoEs("1234567.891", miles=False) == "1234567,89"


# ── Redondeo ──────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("entrada,esperado", [
    # ROUND_HALF_UP, no el ROUND_HALF_EVEN que trae Decimal de fábrica: con el
    # de fábrica esto da 2,67 y se lee como un céntimo perdido.
    ("2,675", "2.68"),
    ("2,665", "2.67"),
    ("0,005", "0.01"),
    ("-2,675", "-2.68"),
    ("1,004", "1.00"),
])
def test_redondeo_half_up(entrada, esperado):
    assert redondear(entrada) == Decimal(esperado)


def test_redondear_a_otra_escala():
    assert redondear("1,123456789", 8) == Decimal("1.12345679")
    assert redondear("1,5", 0) == Decimal("2")


# ── Sumas ─────────────────────────────────────────────────────────────────────

def test_sumar_es_exacto_donde_float_no_lo_es():
    """El motivo de todo el módulo, en una línea.

    En coma flotante, 0,1 + 0,2 no es 0,3. Sobre las cientos de filas que
    recorre el cálculo del invertido, ese error se acumula.
    """
    assert sumar(["0,1", "0,2"]) == Decimal("0.3")
    assert sumar(["0,1"] * 10) == Decimal("1.0")


def test_sumar_lista_vacia():
    assert sumar([]) == Decimal("0")


def test_sumar_propaga_el_dato_corrupto():
    """Un total no puede salir bien si una de sus filas es ilegible."""
    with pytest.raises(ImporteInvalido):
        sumar(["1,00", "basura"])


# ── Utilidades ────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("entrada", ["0", "0,00", "0.000", "", None, 0, Decimal("0E-10")])
def test_es_cero(entrada):
    assert esCero(entrada)


@pytest.mark.parametrize("entrada", ["0,01", "-0,01", "1"])
def test_no_es_cero(entrada):
    assert not esCero(entrada)
