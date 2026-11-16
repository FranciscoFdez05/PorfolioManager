"""Datos exportables a CSV: qué módulos hay, con qué columnas y de dónde salen.

Cada módulo se describe una vez (`Exportable`) y la ruta no sabe nada de ellos:
añadir uno es añadir una entrada a `EXPORTABLES`. Los datos se leen con los
mismos stores que usa la aplicación, de modo que el CSV es lo que se ve en
pantalla y no una segunda lectura de las tablas.
"""

from collections.abc import Callable
from dataclasses import dataclass

from core import dinero
from core.errors import NotFoundError, ValidationError
from stores.app_data import readDividendosFile, readOperacionesFile
from stores.cuentas_store import listarCuentas, saldos
from stores.gastos_store import MONTH_KEYS, normalizeYear, readGastosYear
from stores.ingresos_store import readIngresosYear

Columnas = tuple[tuple[str, str], ...]


@dataclass(frozen=True)
class Exportable:
    """Descripción de un módulo exportable.

    Attributes:
        nombre: Nombre del módulo en la URL y en el fichero.
        columnas: Pares `(clave, título)` en el orden de salida.
        leer: Función que devuelve las filas; recibe el año (o `None`).
        porAnio: Si el módulo se exporta por ejercicio y exige `anio`.
    """

    nombre: str
    columnas: Columnas
    leer: Callable[[str | None], list[dict]]
    porAnio: bool = False


def _nombresDeCuentas() -> dict[str, str]:
    return {c["id"]: c["nombre"] for c in listarCuentas()}


def _filasDeMeses(datos: dict | None, anio: str) -> list[dict]:
    """Aplana los 12 meses de un año de gastos o ingresos en una sola lista."""
    if datos is None:
        raise NotFoundError(f"No hay datos del año {anio}")
    nombres = _nombresDeCuentas()
    filas = []
    for mes in MONTH_KEYS:
        for fila in datos.get("months", {}).get(mes, {}).get("rows", []):
            filas.append({**fila, "mes": mes, "cuenta": nombres.get(fila.get("cuenta"), fila.get("cuenta", ""))})
    return filas


def _gastos(anio: str | None) -> list[dict]:
    return _filasDeMeses(readGastosYear(anio), anio)


def _ingresos(anio: str | None) -> list[dict]:
    return _filasDeMeses(readIngresosYear(anio), anio)


def _dividendos(_anio: str | None) -> list[dict]:
    nombres = _nombresDeCuentas()
    return [{**f, "cuenta": nombres.get(f["cuenta"], f["cuenta"])} for f in readDividendosFile()["rows"]]


def _operaciones(_anio: str | None) -> list[dict]:
    return readOperacionesFile()["rows"]


def _importeEs(valor) -> str:
    """Importe en formato español, que es el que Excel con configuración regional ES lee como número."""
    numero = dinero.aDecimalONulo(valor)
    return "" if numero is None else dinero.aTextoEs(numero, decimales=2)


def _cuentas(_anio: str | None) -> list[dict]:
    calculados = saldos()
    filas = []
    for cuenta in listarCuentas():
        datos = calculados.get(cuenta["id"], {})
        filas.append({
            "nombre": cuenta["nombre"],
            "tipo": cuenta["tipo"],
            "saldoInicial": _importeEs(cuenta["saldo_inicial"]),
            **{clave: _importeEs(datos.get(clave)) for clave in ("entradas", "salidas", "saldo")},
        })
    return filas


_MOVIMIENTO = (("mes", "Mes"), ("fecha", "Fecha"), ("nombre", "Concepto"), ("tipo", "Tipo"),
               ("cantidad", "Cantidad"), ("cuenta", "Cuenta"), ("nota", "Nota"))

EXPORTABLES: dict[str, Exportable] = {e.nombre: e for e in (
    Exportable("gastos", _MOVIMIENTO, _gastos, porAnio=True),
    Exportable("ingresos", _MOVIMIENTO, _ingresos, porAnio=True),
    Exportable("dividendos", (
        ("fecha", "Fecha"), ("instrumento", "Instrumento"), ("acciones", "Acciones"),
        ("dividendoAccion", "Dividendo por acción"), ("monedaDividendo", "Moneda dividendo"),
        ("impuestos", "Impuestos"), ("total", "Total"), ("monedaTotal", "Moneda total"),
        ("cuenta", "Cuenta")), _dividendos),
    Exportable("operaciones", (
        ("fechaApertura", "Fecha apertura"), ("activo", "Activo"), ("par", "Par"), ("orden", "Orden"),
        ("precioOrden", "Precio"), ("cantidad", "Cantidad"), ("comisionesFiat", "Comisiones"),
        ("total", "Total"), ("currency", "Moneda"), ("estado", "Estado"),
        ("fechaCierre", "Fecha cierre")), _operaciones),
    Exportable("cuentas", (
        ("nombre", "Cuenta"), ("tipo", "Tipo"), ("saldoInicial", "Saldo inicial"),
        ("entradas", "Entradas"), ("salidas", "Salidas"), ("saldo", "Saldo")), _cuentas),
)}


def prepararExportacion(modulo: str, anio: str | None) -> tuple[str, Columnas, list[dict]]:
    """Nombre de fichero, columnas y filas de un módulo.

    Args:
        modulo: Clave de `EXPORTABLES`.
        anio: Ejercicio, obligatorio en los módulos `porAnio`.

    Returns:
        `(nombreDeFichero, columnas, filas)`.

    Raises:
        NotFoundError: si el módulo no existe o no hay datos de ese año.
        ValidationError: si falta el año o no es válido.
    """
    exportable = EXPORTABLES.get(modulo)
    if exportable is None:
        raise NotFoundError("Módulo no exportable")

    normalizado = None
    if exportable.porAnio:
        normalizado = normalizeYear(anio)
        if not normalizado:
            raise ValidationError("Indica un año válido", field="anio")

    sufijo = f"-{normalizado}" if normalizado else ""
    return f"{modulo}{sufijo}.csv", exportable.columnas, exportable.leer(normalizado)
