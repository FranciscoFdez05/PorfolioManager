"""Generación de CSV para abrir en Excel: lógica pura, sin acceso a datos.

El formato es el que espera Excel con configuración regional española: separador
`;`, saltos `\\r\\n` y BOM UTF-8 para que los acentos no se rompan. Con coma como
separador, Excel meterá cada fila en una sola celda.

Todo texto que escribió el usuario (nombres, notas, fechas tal cual se
tecleron) se neutraliza si empieza como una fórmula: un activo llamado
`=HYPERLINK(...)` se ejecutaría al abrir el fichero. Los importes se distinguen
por su forma, porque un `-12,50` tiene que seguir siendo un número.
"""

import csv
import io
import re
from collections.abc import Iterable, Sequence

BOM = "﻿"
_INICIO_FORMULA = ("=", "+", "-", "@", "\t", "\r")
# Un importe es dígitos con separadores y, a lo sumo, una divisa detrás. Algo
# como «+34 600» o «-cmd» no lo es y se trata como texto.
_IMPORTE = re.compile(r"^[+-]?\d[\d.,]*\s?(€|[A-Za-z]{3})?$")


def textoSeguro(valor) -> str:
    """Texto de una celda, a salvo de ejecutarse como fórmula en una hoja de cálculo.

    Args:
        valor: Lo que haya en el registro; `None` es la celda vacía.

    Returns:
        El texto tal cual si es un importe o no empieza como fórmula; con un
        apóstrofo delante en caso contrario.
    """
    texto = "" if valor is None else str(valor)
    if texto.startswith(_INICIO_FORMULA) and not _IMPORTE.match(texto):
        return "'" + texto
    return texto


def generarCsv(columnas: Sequence[tuple[str, str]], filas: Iterable[dict]) -> str:
    """CSV completo con cabecera.

    Args:
        columnas: Pares `(clave del registro, título de la columna)`, en el orden
            en que deben salir.
        filas: Registros; una clave ausente sale como celda vacía.

    Returns:
        El texto del CSV, con BOM al principio.
    """
    buffer = io.StringIO(newline="")
    escritor = csv.writer(buffer, delimiter=";", lineterminator="\r\n")
    escritor.writerow([titulo for _clave, titulo in columnas])
    for fila in filas:
        escritor.writerow([textoSeguro(fila.get(clave)) for clave, _titulo in columnas])
    return BOM + buffer.getvalue()
