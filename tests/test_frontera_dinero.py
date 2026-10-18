"""Vigila que el dinero no vuelva a pasar por `float`.

El proyecto tenía cinco conversiones distintas de texto a número y dos
aritméticas conviviendo: `Decimal` en el motor FIFO y la fiscalidad, `float` en
la valoración de la cartera, en el rendimiento por activo y en los snapshots.
`core.dinero` unificó la conversión, pero eso solo se sostiene si nadie vuelve
a escribir `float(...)` en medio de un cálculo de importes: es una sola línea,
se lee como algo inocente, y el síntoma —un céntimo de diferencia -- aparece
meses después y en otra pantalla.

La regla que se comprueba aquí es la misma que se aplicó al arreglarlo:

* En los **módulos de cálculo puro** no puede aparecer `float()` en absoluto.
  Ahí no hay nada que serializar; si hace falta un float es que se está
  calculando con él.

* En los **módulos frontera** —los que devuelven JSON o escriben en una columna
  REAL— sí se permite, pero solo envolviendo una llamada a `dinero.…`. Es decir
  `float(dinero.redondear(total))` y no `float(total)`: la conversión ocurre una
  vez, sobre un valor ya redondeado en Decimal, y en el punto exacto donde el
  dato deja de ser dinero y pasa a ser un número de un JSON.

Lo que este test **no** dice es que `float` esté prohibido en el proyecto.
`core.rentabilidad` calcula TWR, volatilidad y drawdown: son ratios y medias
geométricas sobre columnas REAL, no importes, y ahí la coma flotante es la
herramienta correcta. Por eso no está en ninguna de las dos listas.
"""

import ast
from pathlib import Path

import pytest

PYTHON_DIR = Path(__file__).resolve().parent.parent / "python"

# Cálculo puro: cero llamadas a float().
MODULOS_PUROS = [
    "core/dinero.py",
    "core/fifo.py",
    "core/fiscal_es.py",
    "core/informe_renta.py",
    "core/pnl_divisa.py",
    "stores/ventas_fifo.py",
]

# Frontera: float() permitido solo sobre una llamada a `dinero.…`.
MODULOS_FRONTERA = [
    "routes/activos.py",
    "routes/snapshots.py",
    "stores/valoracion.py",
    "stores/asset_store.py",
    "stores/movimientos_store.py",
    "stores/rendimiento_activo.py",
]


def _llamadasAFloat(ruta):
    """[(línea, código_fuente_de_la_llamada)] de cada `float(...)` del módulo."""
    fuente = ruta.read_text("utf-8")
    arbol = ast.parse(fuente, filename=str(ruta))

    encontradas = []
    for nodo in ast.walk(arbol):
        if isinstance(nodo, ast.Call) and isinstance(nodo.func, ast.Name) and nodo.func.id == "float":
            encontradas.append((nodo.lineno, nodo))
    return fuente, encontradas


def _envuelveADinero(nodo):
    """True si es `float(dinero.algo(...))`, la única forma permitida."""
    if len(nodo.args) != 1:
        return False
    argumento = nodo.args[0]
    if not isinstance(argumento, ast.Call):
        return False
    funcion = argumento.func
    return (
        isinstance(funcion, ast.Attribute)
        and isinstance(funcion.value, ast.Name)
        and funcion.value.id == "dinero"
    )


@pytest.mark.parametrize("modulo", MODULOS_PUROS)
def testLosModulosDeCalculoNoLlamanAFloat(modulo):
    ruta = PYTHON_DIR / modulo
    _fuente, llamadas = _llamadasAFloat(ruta)

    assert not llamadas, (
        f"{modulo} llama a float() en la(s) línea(s) "
        f"{[linea for linea, _ in llamadas]}. Es un módulo de cálculo puro: "
        f"usa Decimal, y si necesitas leer un texto pasa por core.dinero."
    )


@pytest.mark.parametrize("modulo", MODULOS_FRONTERA)
def testEnLaFronteraFloatSoloEnvuelveADinero(modulo):
    ruta = PYTHON_DIR / modulo
    fuente, llamadas = _llamadasAFloat(ruta)
    lineas = fuente.splitlines()

    infractoras = [
        (linea, lineas[linea - 1].strip())
        for linea, nodo in llamadas
        if not _envuelveADinero(nodo)
    ]

    assert not infractoras, (
        f"{modulo} convierte a float sin pasar por core.dinero:\n"
        + "\n".join(f"  línea {linea}: {codigo}" for linea, codigo in infractoras)
        + "\n\nEn estos módulos float() solo vale para serializar, y sobre un "
          "valor ya redondeado: float(dinero.redondear(x))."
    )


def testLasListasApuntanAFicherosQueExisten():
    """Renombrar un módulo y dejarlo fuera de la lista desactivaría la regla."""
    for modulo in MODULOS_PUROS + MODULOS_FRONTERA:
        assert (PYTHON_DIR / modulo).is_file(), f"{modulo} ya no existe; actualiza la lista"


def _construyeDecimalDesdeStr(ruta):
    """Líneas con un `Decimal(str(...))` **de código**, no de comentario.

    La comprobación va sobre el AST justamente porque los docstrings de estos
    módulos citan ese patrón para explicar por qué se quitó.
    """
    arbol = ast.parse(ruta.read_text("utf-8"), filename=str(ruta))

    lineas = []
    for nodo in ast.walk(arbol):
        if not (isinstance(nodo, ast.Call) and isinstance(nodo.func, ast.Name)):
            continue
        if nodo.func.id != "Decimal" or len(nodo.args) != 1:
            continue
        argumento = nodo.args[0]
        if (
            isinstance(argumento, ast.Call)
            and isinstance(argumento.func, ast.Name)
            and argumento.func.id == "str"
        ):
            lineas.append(nodo.lineno)
    return lineas


@pytest.mark.parametrize("modulo", ["core/fifo.py", "core/informe_renta.py", "core/pnl_divisa.py"])
def testNoQuedanConversionesDeImportesPropias(modulo):
    """Cada `_dec` privado que reaparezca es la sexta implementación en camino.

    Los tres módulos que tenían la suya delegan ahora en `core.dinero`; lo que
    se comprueba es que sigan delegando y no hayan vuelto a construir un
    `Decimal(str(...))` por su cuenta, que es la forma exacta en la que dos de
    ellos convertían en cero cualquier importe en formato español.
    """
    ruta = PYTHON_DIR / modulo

    lineas = _construyeDecimalDesdeStr(ruta)
    assert not lineas, (
        f"{modulo} vuelve a construir Decimal desde str en la(s) línea(s) {lineas}. "
        f"Usa dinero.aDecimal, que entiende también el formato español en el que "
        f"el esquema guarda los importes."
    )

    assert "dinero." in ruta.read_text("utf-8"), f"{modulo} ya no usa core.dinero"
