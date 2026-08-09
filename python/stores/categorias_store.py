"""Gestión global del catálogo de categorías de gastos e ingresos.

El panel de categorías de la web permite renombrar y eliminar cualquiera de las
dos listas sin importar en qué pestaña estés, y eso obliga a hacer el trabajo
aquí en vez de en el navegador: el frontend solo tiene en memoria el año que
está mirando, y renombrar tocando únicamente ese año dejaría el resto de años
con la etiqueta vieja. Como `sanitize_gastos_payload` reconstruye el catálogo a
partir de las filas guardadas, la categoría renombrada reaparecería sola en
cuanto se guardase cualquiera de esos años.

Cada tipo toca tres tablas: el catálogo, las filas de movimientos y los cargos
recurrentes (que guardan su categoría en una columna aparte).
"""

from core.db import get_db, transaction

TIPOS_VALIDOS = ("gasto", "ingreso")

# tabla de catálogo, tabla de filas, tabla de recurrentes. Las columnas difieren
# entre sí (label / tipo / categoria), así que van explícitas.
_TABLAS = {
    "gasto": {
        "catalogo": ("gastos_tipos", "label"),
        "filas": ("gastos_rows", "tipo"),
        "recurrentes": ("mensualidades", "categoria"),
    },
    "ingreso": {
        "catalogo": ("ingresos_tipos", "label"),
        "filas": ("ingresos_rows", "tipo"),
        "recurrentes": ("ingresos_recurrentes", "categoria"),
    },
}


class CategoriaInvalida(ValueError):
    """Petición rechazada por validación. La ruta lo traduce a 400."""


class CategoriaEnUso(Exception):
    """Se intenta eliminar una categoría que tiene movimientos asociados."""

    def __init__(self, usos):
        super().__init__(f"La categoría tiene {usos} movimientos asociados")
        self.usos = int(usos)


def normalizarTipo(valor):
    tipo = str(valor or "").strip().lower()

    if tipo not in TIPOS_VALIDOS:
        raise CategoriaInvalida("El campo 'tipo' debe ser 'gasto' o 'ingreso'")

    return tipo


def normalizarEtiqueta(valor, campo):
    etiqueta = str(valor or "").strip()

    if not etiqueta:
        raise CategoriaInvalida(f"El campo '{campo}' es obligatorio")

    return etiqueta[:80].strip()


def contarUsos(tipo, etiqueta, conn=None):
    """Movimientos y recurrentes que usan esa categoría, en todos los años."""
    tablas = _TABLAS[tipo]
    conn = conn or get_db()

    tablaFilas, columnaFilas = tablas["filas"]
    tablaRec, columnaRec = tablas["recurrentes"]

    filas = conn.execute(
        f"SELECT COUNT(*) AS total FROM {tablaFilas} WHERE {columnaFilas} = ?", (etiqueta,)
    ).fetchone()["total"]

    recurrentes = conn.execute(
        f"SELECT COUNT(*) AS total FROM {tablaRec} WHERE {columnaRec} = ?", (etiqueta,)
    ).fetchone()["total"]

    return int(filas) + int(recurrentes)


def leerResumen():
    """Catálogo de cada tipo con el número de usos de cada categoría.

    Se incluyen las etiquetas que solo aparecen en filas y nunca llegaron al
    catálogo: son categorías reales desde el punto de vista del usuario, y si no
    salieran aquí no habría forma de renombrarlas ni de entender por qué
    reaparecen.
    """
    conn = get_db()
    resumen = {}

    for tipo, tablas in _TABLAS.items():
        tablaCatalogo, columnaCatalogo = tablas["catalogo"]
        tablaFilas, columnaFilas = tablas["filas"]

        etiquetas = [
            r["etiqueta"]
            for r in conn.execute(
                f"SELECT {columnaCatalogo} AS etiqueta FROM {tablaCatalogo} ORDER BY rowid"
            ).fetchall()
        ]

        conocidas = set(etiquetas)
        sueltas = [
            r["etiqueta"]
            for r in conn.execute(
                f"SELECT DISTINCT {columnaFilas} AS etiqueta FROM {tablaFilas} "
                f"WHERE {columnaFilas} <> '' ORDER BY {columnaFilas}"
            ).fetchall()
            if r["etiqueta"] not in conocidas
        ]

        resumen[tipo] = [
            {"label": etiqueta, "usos": contarUsos(tipo, etiqueta, conn)}
            for etiqueta in etiquetas + sueltas
        ]

    return resumen


def renombrarCategoria(tipo, origen, destino):
    """Renombra la categoría en el catálogo, en las filas y en los recurrentes.

    Devuelve cuántas filas de movimientos se han actualizado. Todo va en una
    sola transacción: un renombrado a medias dejaría parte de los años con la
    etiqueta vieja, que es justo el estado que este módulo existe para evitar.
    """
    tipo = normalizarTipo(tipo)
    origen = normalizarEtiqueta(origen, "de")
    destino = normalizarEtiqueta(destino, "a")

    if origen == destino:
        return 0

    tablas = _TABLAS[tipo]
    tablaCatalogo, columnaCatalogo = tablas["catalogo"]
    tablaFilas, columnaFilas = tablas["filas"]
    tablaRec, columnaRec = tablas["recurrentes"]

    with transaction() as conn:
        existeDestino = conn.execute(
            f"SELECT 1 FROM {tablaCatalogo} WHERE {columnaCatalogo} = ? LIMIT 1", (destino,)
        ).fetchone()

        # El catálogo tiene la etiqueta como clave primaria, así que un UPDATE
        # hacia un nombre ya existente fallaría. Fusionar las dos es un cambio
        # que el usuario no ha pedido, así que se rechaza.
        if existeDestino:
            raise CategoriaInvalida(f"Ya existe una categoría llamada «{destino}»")

        conn.execute(
            f"UPDATE {tablaCatalogo} SET {columnaCatalogo} = ? WHERE {columnaCatalogo} = ?",
            (destino, origen),
        )
        cursorFilas = conn.execute(
            f"UPDATE {tablaFilas} SET {columnaFilas} = ? WHERE {columnaFilas} = ?",
            (destino, origen),
        )
        conn.execute(
            f"UPDATE {tablaRec} SET {columnaRec} = ? WHERE {columnaRec} = ?",
            (destino, origen),
        )

        # Si la etiqueta solo vivía en las filas, el UPDATE del catálogo no ha
        # tocado nada: se da de alta para que quede en la lista.
        conn.execute(
            f"INSERT OR IGNORE INTO {tablaCatalogo} ({columnaCatalogo}) VALUES (?)", (destino,)
        )

        return cursorFilas.rowcount


def eliminarCategoria(tipo, etiqueta):
    """Borra la categoría del catálogo. Falla si está en uso en algún año."""
    tipo = normalizarTipo(tipo)
    etiqueta = normalizarEtiqueta(etiqueta, "label")

    tablas = _TABLAS[tipo]
    tablaCatalogo, columnaCatalogo = tablas["catalogo"]

    with transaction() as conn:
        usos = contarUsos(tipo, etiqueta, conn)

        if usos:
            raise CategoriaEnUso(usos)

        cursor = conn.execute(
            f"DELETE FROM {tablaCatalogo} WHERE {columnaCatalogo} = ?", (etiqueta,)
        )

        return cursor.rowcount > 0
