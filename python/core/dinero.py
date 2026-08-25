"""Frontera única entre el texto que guarda SQLite y la aritmética con Decimal.

El esquema guarda los importes como TEXT y, además, en formato español
(`price TEXT NOT NULL DEFAULT '0,00'`, `participaciones TEXT`, `comisiones
TEXT`). Eso obliga a convertir en cada lectura y en cada escritura, y esa
conversión estaba escrita **cinco veces** con cinco criterios distintos:

    entrada        helpers   validation   fifo      informe_renta   pnl_divisa
    '83,58 EUR'    83.58     83.58        83.58     0               0
    '1.234,56'     1234.56   1234.56      1234.56   0               0
    '12abc34'      1234.0    1234.0       error     0               0
    '1e3'          13.0      13.0         1000      1000            1000

Las dos primeras filas son el formato en el que el propio esquema declara que
se guardan los importes; `informe_renta` (la declaración de la renta) y
`pnl_divisa` (el desglose entre efecto activo y efecto divisa) los convertían
en **cero**. Hoy no se manifiesta porque a esos dos módulos les llegan cifras
ya serializadas en canónico —el motor FIFO por un lado y el backfill de tipos
de cambio, que escribe con f-string de ocho decimales, por el otro—, así que no
es un error que se esté produciendo: es un error que ocurre en cuanto alguien
les pase un importe leído directamente de una columna TEXT, que es de donde
sale todo lo demás en este código.

La fila del '12abc34' es el otro extremo: descartar cualquier carácter que no
sea dígito convierte un dato corrupto en un número plausible. Un importe
ilegible tiene que doler, no redondearse a algo que parece razonable.

Reglas que fija este módulo
---------------------------

**Formato canónico de almacenamiento** (`aTexto`): punto decimal, sin
separador de miles, sin símbolo de divisa y sin notación exponencial. Es lo que
debe entrar en la base de datos. El formato español es de presentación y se
produce con `aTextoEs` al servir la respuesta, nunca al guardar.

**Al leer** (`aDecimal`) se aceptan los dos, porque en las columnas existentes
conviven: lo escrito por versiones anteriores está en español y lo nuevo en
canónico.

**Nunca `float`.** Ni siquiera de paso: `Decimal(str(0.1 + 0.2))` ya arrastra
el error. Este módulo no llama a `float()` en ningún punto, y
`tests/test_frontera_dinero.py` comprueba que los módulos de importes tampoco:
solo se permite al serializar, y únicamente sobre un valor que acabe de salir
de `dinero.redondear()`.

**Estricto por defecto.** Lo que no se entiende levanta `ImporteInvalido`.
Quien tenga un motivo para tolerarlo pasa `defecto=`, y así queda escrito en la
línea de la llamada quién decidió tragarse el dato malo.

Ambigüedad del punto solo
-------------------------
Un punto sin coma se lee como separador decimal: 1.234 es mil doscientos
treinta y cuatro milésimas. Es lo que hacían ya las cinco implementaciones, así
que se conserva —cambiarlo reinterpretaría datos que ya están guardados—, pero
es la razón de que `aTexto` no emita nunca separadores de miles: en cuanto se
emiten, el valor deja de poder releerse sin ambigüedad.
"""

import math
import re
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

__all__ = [
    "CENTIMO",
    "SATOSHI",
    "ImporteInvalido",
    "aDecimal",
    "aDecimalONulo",
    "aTexto",
    "aTextoEs",
    "esCero",
    "redondear",
    "sumar",
]

CENTIMO = Decimal("0.01")

# Ocho decimales: un satoshi. Es la unidad más pequeña que el proyecto necesita
# representar.
SATOSHI = Decimal("0.00000001")

# Lista cerrada a propósito, no "todo lo que no sea un dígito": ver el docstring.
# El símbolo de porcentaje entra porque las rentabilidades se teclean con él;
# convertir a tanto por uno es decisión de quien llama, aquí solo se descarta.
_SIMBOLOS = re.compile(
    r"[€$£¥₿¢₽₩₹%]|(?:EUR|USD|GBP|CHF|JPY|CAD|AUD|BTC|ETH|SATS?)",
    re.IGNORECASE,
)

# Cualquier espacio Unicode: el navegador separa los miles con NBSP (U+00A0) y
# con el espacio fino irrompible (U+202F), que `Decimal` no digiere.
_ESPACIOS = re.compile(r"\s", re.UNICODE)

# Lo que queda tras limpiar tiene que ser un número entero de la cabeza a los
# pies. Sin este ancla, Decimal fallaría con "12abc34" pero no con "1_0", y
# "NaN" o "Infinity" colarían y envenenarían cualquier suma posterior sin
# lanzar nada.
_NUMERO = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$")

_SIN_DEFECTO = object()


class ImporteInvalido(ValueError):
    """Un texto que debería ser un importe y no se puede leer como tal."""


def _limpiar(texto: str) -> str:
    """Deja el texto en la forma que `Decimal` entiende, o en algo que no casará."""
    texto = _ESPACIOS.sub("", texto)
    texto = _SIMBOLOS.sub("", texto)

    if "," in texto:
        # Formato español: la coma es el separador decimal, así que el punto
        # solo puede ser separador de miles.
        texto = texto.replace(".", "").replace(",", ".")

    return texto


def _fallar(valor, campo, defecto, vacio=False):
    if defecto is not _SIN_DEFECTO:
        return defecto if isinstance(defecto, Decimal) else aDecimal(defecto, campo)
    if vacio:
        raise ImporteInvalido(f"«{campo}» está vacío")
    raise ImporteInvalido(f"«{campo}» no es un número válido: {valor!r}")


def aDecimal(valor, campo="importe", *, defecto=_SIN_DEFECTO) -> Decimal:
    """Lee un importe a `Decimal` aceptando canónico y formato español.

    Sin `defecto`, un valor ilegible levanta `ImporteInvalido`. Con `defecto`,
    se devuelve ese valor: sirve para las columnas que legítimamente pueden
    estar vacías, y deja constancia en la llamada de que ahí se tolera.
    """
    if isinstance(valor, Decimal):
        return valor
    if isinstance(valor, bool):
        # `True` vale 1 para Python, y un booleano donde se espera un importe es
        # siempre un error de quien llama, no un 1 legítimo.
        return _fallar(valor, campo, defecto)
    if isinstance(valor, int):
        return Decimal(valor)
    if valor is None:
        return _fallar(valor, campo, defecto, vacio=True)

    if isinstance(valor, float):
        # No se rechaza —hay proveedores que devuelven float— pero se convierte
        # por `repr`, que da la representación decimal más corta que reproduce
        # ese float exactamente, en vez de arrastrar los 17 dígitos de basura.
        if not math.isfinite(valor):
            return _fallar(valor, campo, defecto)
        return Decimal(repr(valor))

    texto = str(valor).strip()
    if not texto:
        return _fallar(valor, campo, defecto, vacio=True)

    limpio = _limpiar(texto)
    if not _NUMERO.match(limpio):
        return _fallar(valor, campo, defecto)

    try:
        return Decimal(limpio)
    except InvalidOperation:
        return _fallar(valor, campo, defecto)


def aDecimalONulo(valor, campo="importe"):
    """`aDecimal` que devuelve `None` en vez de fallar. Para filtrar filas."""
    try:
        return aDecimal(valor, campo)
    except ImporteInvalido:
        return None


def redondear(valor, decimales=2) -> Decimal:
    """Cuantiza con ROUND_HALF_UP, que es como redondea la gente.

    El modo por defecto de `Decimal` es ROUND_HALF_EVEN, que deja 2,675 en
    2,67. En un importe eso se lee como un céntimo perdido.
    """
    return aDecimal(valor).quantize(Decimal(1).scaleb(-decimales), rounding=ROUND_HALF_UP)


def _recortar(numero: Decimal) -> Decimal:
    """Quita ceros por la derecha sin dejar exponente positivo.

    `Decimal("100").normalize()` da `1E+2`; esto deja `100`.
    """
    normalizado = numero.normalize()
    _signo, _digitos, exponente = normalizado.as_tuple()
    if isinstance(exponente, int) and exponente > 0:
        return normalizado.quantize(Decimal(1))
    return normalizado


def aTexto(valor, campo="importe", *, decimales=None) -> str:
    """Formato canónico de almacenamiento: punto decimal y nada más.

    Sin `decimales` se conserva el valor recortando los ceros sobrantes por la
    derecha. Con `decimales` se cuantiza a esa escala, que es lo que se quiere
    al guardar un importe monetario (2) o una cantidad de cripto (8).
    """
    numero = aDecimal(valor, campo)
    numero = redondear(numero, decimales) if decimales is not None else _recortar(numero)

    # El formato `f` y no `str`: str(Decimal("1E+3")) da "1E+3", que ni se relee
    # bien ni se parece a lo que hay en el resto de la columna.
    return f"{numero:f}"


def aTextoEs(valor, campo="importe", *, decimales=2, miles=True) -> str:
    """Formato de presentación español (1.234,56). **Nunca para guardar.**"""
    numero = redondear(aDecimal(valor, campo), decimales)
    negativo = numero < 0

    entero, _punto, fraccion = f"{abs(numero):.{decimales}f}".partition(".")

    if miles:
        grupos = []
        while len(entero) > 3:
            grupos.insert(0, entero[-3:])
            entero = entero[:-3]
        grupos.insert(0, entero)
        entero = ".".join(grupos)

    salida = entero + ("," + fraccion if fraccion else "")
    return ("-" + salida) if negativo else salida


def sumar(valores, campo="importe") -> Decimal:
    """Suma en Decimal desde cero. `sum()` a secas arranca en el `int` 0."""
    total = Decimal("0")
    for valor in valores:
        total += aDecimal(valor, campo)
    return total


def esCero(valor, campo="importe") -> bool:
    """Cero de verdad, incluyendo '0,00', la cadena vacía y None."""
    return aDecimal(valor, campo, defecto=Decimal("0")) == 0
