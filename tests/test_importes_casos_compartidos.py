"""`dinero.aDecimal` y el parser del navegador leen igual la misma tabla de entradas.

La tabla es `tests-js/importes-casos.json`; el otro extremo es
`tests-js/importes-compartidos.test.js`, que comprueba `parseDecimalStrict` de
`js/core/shared-utils.js` contra los mismos valores esperados. Si una mitad
cambia su criterio y la otra no, falla una de las dos.
"""

import json
from decimal import Decimal
from pathlib import Path

import pytest

from core import dinero

TABLA = Path(__file__).resolve().parent.parent / "tests-js" / "importes-casos.json"
CASOS = json.loads(TABLA.read_text("utf-8"))["casos"]


@pytest.mark.parametrize("caso", CASOS, ids=[repr(c["entrada"]) for c in CASOS])
def testElServidorLeeLaEntradaComoDiceLaTabla(caso):
    esperado = caso["esperado"]

    if esperado is None:
        with pytest.raises(dinero.ImporteInvalido):
            dinero.aDecimal(caso["entrada"])
    else:
        assert dinero.aDecimal(caso["entrada"]) == Decimal(esperado)
