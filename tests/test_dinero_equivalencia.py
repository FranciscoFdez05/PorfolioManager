"""El camino rápido de `aDecimal` para cadenas canónicas no cambia ningún resultado.

`_aDecimalPrevio` es la rama de texto de la implementación anterior (limpiar y
validar siempre). Se compara con la actual sobre un conjunto amplio de entradas:
canónicas, en formato español, con espacios, signos, exponentes, símbolos y
basura. Tanto el valor como la escala (`'1.50'` no es `'1.5'`) y el error deben
coincidir.
"""

from decimal import Decimal, InvalidOperation

import pytest

from core import dinero
from core.dinero import ImporteInvalido, aDecimal


def _aDecimalPrevio(valor):
    """Rama de texto previa: devuelve `Decimal` o la cadena 'ERROR' / 'VACIO'."""
    texto = str(valor).strip()
    if not texto:
        return "VACIO"
    limpio = dinero._limpiar(texto)
    if not dinero._NUMERO.match(limpio):
        return "ERROR"
    try:
        return Decimal(limpio)
    except InvalidOperation:
        return "ERROR"


ENTRADAS = [
    # Canónicas
    "0", "1", "-1", "+1", "0.5", ".5", "-.5", "5.", "-5.", "+.5", "1.50", "100", "1234.56",
    "-1234.56", "0.00000001", "00012.3400", "1" + "0" * 40, "0." + "0" * 40 + "1", "-0", "-0.00",
    # Espacios alrededor y en medio, incluidos los Unicode
    " 1.5 ", "\t1.5\n", "1.5\n", "\n1.5", "1 234.5", "1 234.5", " 12.5 ", "1 2", " ",  # noqa: RUF001
    # Formato español
    "1,5", "1.234,56", "-1.234,56", "83,58", "0,00", ",5", "5,", "1.234.567,89", "1,234.56", "1,2,3",
    # Un punto solo es decimal (decisión B-01)
    "1.234", "1.234.567", "1..2",
    # Símbolos y divisas
    "83,58 EUR", "$12.5", "12.5%", "1.000,00 €", "EUR", "USD 5", "5 sats", "BTC0.1",
    # Exponentes y valores especiales: se rechazan o se limpian como antes
    "1e3", "1E3", "1e-3", "NaN", "nan", "Infinity", "-inf", "sNaN",
    # Basura
    "", "abc", "12abc34", "1_0", "--1", "+-1", "1-", "1.2.3", "٣", "١٢٣.٤", "１２３",  # noqa: RUF001
]


@pytest.mark.parametrize("entrada", ENTRADAS)
def testCoincideConLaImplementacionPrevia(entrada):
    esperado = _aDecimalPrevio(entrada)

    if esperado in ("ERROR", "VACIO"):
        with pytest.raises(ImporteInvalido):
            aDecimal(entrada)
        return

    obtenido = aDecimal(entrada)
    assert obtenido == esperado
    # La escala cuenta: aTexto y los redondeos dependen del exponente.
    assert obtenido.as_tuple() == esperado.as_tuple()


@pytest.mark.parametrize("entrada", ENTRADAS)
def testConDefectoDevuelveElDefectoEnLosMismosCasos(entrada):
    esperado = _aDecimalPrevio(entrada)
    obtenido = aDecimal(entrada, defecto=Decimal("-7"))

    assert obtenido == (Decimal("-7") if esperado in ("ERROR", "VACIO") else esperado)


def testUnaSubclaseDeStrNoTomaElCaminoRapido():
    class Texto(str):
        def strip(self, *args):
            return "999"

    # str(valor) devuelve la cadena original; el camino rápido llamaría a strip().
    assert aDecimal(Texto("5")) == Decimal("5")


def testLosTiposNoTextualesNoCambian():
    assert aDecimal(3) == Decimal(3)
    assert aDecimal(0.1) == Decimal("0.1")
    assert aDecimal(Decimal("2.50")) == Decimal("2.50")
    with pytest.raises(ImporteInvalido):
        aDecimal(True)
    with pytest.raises(ImporteInvalido):
        aDecimal(None)
