"""Revisión por año de gastos e ingresos: detecta guardados hechos sobre una copia antigua.

La pestaña de Gastos (o Ingresos) carga un año entero y, al guardar, manda el
año entero; el servidor sustituye todas las filas por esas. Entre la carga y el
guardado pueden haber entrado filas por otro camino —el Atajo de iOS, otra
pestaña, otro dispositivo, un renombrado de categoría—, y el guardado las
borraba sin que nadie se enterase.

Cada escritura sobre un año avanza su número de revisión. El GET lo devuelve,
el navegador lo reenvía al guardar y, si no coincide con el actual, el guardado
se rechaza con un 409: el navegador vuelve a pedir el año, fusiona sus cambios
con lo que hay ahora y repite.

La comprobación tiene que hacerse dentro de la misma transacción que la
escritura y con el bloqueo de escritura ya tomado (BEGIN IMMEDIATE): leer la
revisión fuera dejaría colarse a otra escritura entre la lectura y el guardado.
"""

from core.db import get_db

AMBITOS = ("gastos", "ingresos")


class ConflictoRevision(Exception):
    """El año cambió desde que el cliente lo leyó. La ruta responde 409."""

    def __init__(self, actual):
        super().__init__("Este año ha cambiado desde que se abrió")
        self.actual = int(actual)


def _ambito(ambito):
    if ambito not in AMBITOS:
        raise ValueError(f"Ámbito de revisión desconocido: {ambito!r}")
    return ambito


def leer(conn, ambito, year):
    fila = conn.execute(
        "SELECT revision FROM revisiones_anuales WHERE ambito = ? AND year = ?",
        (_ambito(ambito), str(year)),
    ).fetchone()
    return int(fila[0]) if fila else 0


def actual(ambito, year):
    """La revisión del año en la base activa."""
    return leer(get_db(), ambito, year)


def avanzar(conn, ambito, year):
    """Suma uno a la revisión del año y devuelve la nueva."""
    conn.execute(
        "INSERT INTO revisiones_anuales (ambito, year, revision) VALUES (?, ?, 1) "
        "ON CONFLICT(ambito, year) DO UPDATE SET revision = revision + 1",
        (_ambito(ambito), str(year)),
    )
    return leer(conn, ambito, year)


def comprobar(conn, ambito, year, esperada):
    """ConflictoRevision si `esperada` no es la revisión actual. None no comprueba.

    None se admite para no romper a los clientes que no la mandan (scripts,
    importaciones, la versión anterior del frontend cacheada en el navegador):
    para ellos el comportamiento es el de siempre.
    """
    if esperada is None:
        return
    actual = leer(conn, ambito, year)
    if int(esperada) != actual:
        raise ConflictoRevision(actual)


def tomar_bloqueo(conn):
    """Abre la transacción con el bloqueo de escritura ya tomado."""
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")


def revision_de_peticion(datos):
    """La revisión que manda el cliente: None si no la manda; ValueError si no es un entero."""
    valor = datos.get("revision") if isinstance(datos, dict) else None
    if valor is None:
        return None
    if isinstance(valor, bool):
        raise ValueError("revision debe ser un entero")
    try:
        numero = int(valor)
    except (TypeError, ValueError):
        raise ValueError("revision debe ser un entero") from None
    if numero < 0:
        raise ValueError("revision debe ser un entero no negativo")
    return numero
