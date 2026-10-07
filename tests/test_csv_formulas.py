"""El informe fiscal en CSV no puede ejecutar fórmulas al abrirlo en Excel.

Regresión: un activo llamado `=HYPERLINK("http://…";"ver")` salía tal cual en
el CSV y la hoja de cálculo lo interpretaba como fórmula.
"""

import pytest

from core.informe_renta import _texto_csv


@pytest.mark.parametrize("texto", ["=1+1", "+34 600", "-cmd", "@SUM(A1)", "\tx", "\rx",
                                   '=HYPERLINK("http://x","v")'])
def test_lo_que_empieza_como_formula_queda_como_texto(texto):
    assert _texto_csv(texto) == "'" + texto


@pytest.mark.parametrize("texto", ["Apple", "10-01-2026", "1,5", "", "Vanguard FTSE All-World"])
def test_el_texto_normal_no_cambia(texto):
    assert _texto_csv(texto) == texto


def test_none_es_cadena_vacia():
    assert _texto_csv(None) == ""
