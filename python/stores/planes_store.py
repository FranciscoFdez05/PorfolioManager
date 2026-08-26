"""Planes de inversión y planes de aportación periódica (DCA).

Son la única parte de la aplicación que guarda *intención* en vez de hechos: lo
que se piensa hacer con un activo (a qué precio entrar, dónde recoger el
beneficio, dónde cortar la pérdida) y con qué periodicidad aportar. Por eso no
pasan por `asset_store` ni entran en el cálculo de rendimiento ni en el FIFO
fiscal: un plan que no se ha ejecutado no es una operación.

Los importes se guardan como texto, igual que en el resto de tablas: entran tal
y como se teclean —"1.234,56", "0,00021"— y el que los interpreta es
`core.dinero`. Convertirlos aquí a REAL obligaría a decidir el formato en la
capa de almacenamiento y perdería lo que el usuario escribió.
"""

from core.db import get_db, transactional

_PLAN_COLUMNS = (
    ("id",              "id"),
    ("asset_id",        "assetId"),
    ("nombre",          "nombre"),
    ("symbol",          "symbol"),
    ("ticker",          "ticker"),
    ("market_provider", "marketProvider"),
    ("tv_symbol",       "tvSymbol"),
    ("direccion",       "direccion"),
    ("currency",        "currency"),
    ("precio_entrada",  "precioEntrada"),
    ("precio_salida",   "precioSalida"),
    ("stop_loss",       "stopLoss"),
    ("capital",         "capital"),
    ("horizonte",       "horizonte"),
    ("estado",          "estado"),
    ("fecha_objetivo",  "fechaObjetivo"),
    ("notas",           "notas"),
)

_DCA_COLUMNS = (
    ("id",               "id"),
    ("asset_id",         "assetId"),
    ("nombre",           "nombre"),
    ("symbol",           "symbol"),
    ("ticker",           "ticker"),
    ("market_provider",  "marketProvider"),
    ("tv_symbol",        "tvSymbol"),
    ("currency",         "currency"),
    ("importe",          "importe"),
    ("frecuencia",       "frecuencia"),
    ("fecha_inicio",     "fechaInicio"),
    ("fecha_fin",        "fechaFin"),
    ("aportes_objetivo", "aportesObjetivo"),
    ("precio_maximo",    "precioMaximo"),
    ("estado",           "estado"),
    ("notas",            "notas"),
)


# `tabla` y `columnas` salen siempre de las constantes de arriba, nunca de la
# petición: lo que se interpola en el SQL de las funciones que siguen son
# literales de este módulo, y los valores —lo único que viene del cliente— van
# parametrizados.
def _leer(tabla, columnas):
    conn = get_db()
    seleccion = ", ".join(columna for columna, _ in columnas)
    filas = conn.execute(
        f"SELECT {seleccion} FROM {tabla} ORDER BY sort_order, rowid"
    ).fetchall()
    return {"rows": [
        {clave: fila[columna] for columna, clave in columnas}
        for fila in filas
    ]}


def _escribir(tabla, columnas, filas):
    """Reemplaza el contenido de la tabla por `filas`, en ese orden.

    Reescritura completa y no un UPDATE por fila porque el cliente maneja la
    lista entera (crear, editar, borrar y reordenar por arrastre son la misma
    operación desde su punto de vista) y así el orden guardado es siempre el que
    se ve en pantalla. La transacción la abre `@transactional`: si algo falla a
    medias, la tabla se queda como estaba en vez de vaciarse.
    """
    conn = get_db()
    conn.execute(f"DELETE FROM {tabla}")

    nombres = [columna for columna, _ in columnas] + ["sort_order"]
    huecos = ", ".join("?" for _ in nombres)
    conn.executemany(
        f"INSERT INTO {tabla} ({', '.join(nombres)}) VALUES ({huecos})",
        [
            (*(fila.get(clave, "") for _, clave in columnas), indice)
            for indice, fila in enumerate(filas)
        ],
    )
    conn.commit()


def read_planes():
    return _leer("planes_inversion", _PLAN_COLUMNS)


@transactional
def write_planes(rows):
    _escribir("planes_inversion", _PLAN_COLUMNS, rows)


def read_dca():
    return _leer("dca_planes", _DCA_COLUMNS)


@transactional
def write_dca(rows):
    _escribir("dca_planes", _DCA_COLUMNS, rows)
