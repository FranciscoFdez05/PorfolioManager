"""El informe fiscal en CSV no puede ejecutar fórmulas al abrirlo en Excel.

Regresión: un activo llamado `=HYPERLINK("http://…";"ver")` salía tal cual en
el CSV y la hoja de cálculo lo interpretaba como fórmula.
"""

import pytest

from core.informe_renta import _textoCsv


@pytest.mark.parametrize("texto", ["=1+1", "+34 600", "-cmd", "@SUM(A1)", "\tx", "\rx",
                                   '=HYPERLINK("http://x","v")'])
def testLoQueEmpiezaComoFormulaQuedaComoTexto(texto):
    assert _textoCsv(texto) == "'" + texto


@pytest.mark.parametrize("texto", ["Apple", "10-01-2026", "1,5", "", "Vanguard FTSE All-World"])
def testElTextoNormalNoCambia(texto):
    assert _textoCsv(texto) == texto


def testNoneEsCadenaVacia():
    assert _textoCsv(None) == ""
