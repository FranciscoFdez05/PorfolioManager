"""Alta de movimientos sueltos (ingreso o gasto) desde el Atajo de iOS.

No hay tabla nueva: un movimiento se guarda en las mismas tablas que usa la web
app —`gastos_rows` o `ingresos_rows`— derivando año y mes de la fecha. Así lo
que se apunta desde el iPhone aparece en la pestaña de Gastos/Ingresos sin
ninguna sincronización extra, y las categorías que se ofrecen en el Atajo son
exactamente las de `gastos_tipos` / `ingresos_tipos`.

Los formatos de `fecha` y `cantidad` son los que escribe el frontend
(`dd-mm-aaaa` y `1.234,56 €`), porque las tablas guardan texto ya formateado y
una fila con otro formato se ordenaría y sumaría mal.
"""

from datetime import date, datetime

from core.db import get_db, transaction
from stores.gastos_store import MONTH_KEYS

TIPOS_VALIDOS = ("ingreso", "gasto")

_MAX_CATEGORIA = 80
_MAX_NOMBRE = 120

# Cada tipo de movimiento escribe en su propio juego de tablas.
_TABLAS_POR_TIPO = {
    "gasto": {"filas": "gastos_rows", "tipos": "gastos_tipos"},
    "ingreso": {"filas": "ingresos_rows", "tipos": "ingresos_tipos"},
}


class DatosMovimientoInvalidos(ValueError):
    """Payload rechazado por validación. La ruta lo traduce a un 400."""


def normalizarTipo(valor):
    tipo = str(valor or "").strip().lower()

    if tipo not in TIPOS_VALIDOS:
        raise DatosMovimientoInvalidos("El campo 'tipo' debe ser 'ingreso' o 'gasto'")

    return tipo


def normalizarImporte(valor):
    """Acepta número o cadena numérica y devuelve un float positivo."""
    if isinstance(valor, bool) or valor is None or valor == "":
        raise DatosMovimientoInvalidos("El campo 'importe' es obligatorio y debe ser numérico")

    if isinstance(valor, (int, float)):
        importe = float(valor)
    else:
        # El Atajo envía el importe como texto; se admite coma decimal.
        texto = str(valor).strip().replace("€", "").replace(" ", "").replace(",", ".")
        try:
            importe = float(texto)
        except ValueError:
            raise DatosMovimientoInvalidos("El campo 'importe' debe ser numérico") from None

    if importe != importe or importe in (float("inf"), float("-inf")):
        raise DatosMovimientoInvalidos("El campo 'importe' debe ser un número finito")

    if importe <= 0:
        raise DatosMovimientoInvalidos("El campo 'importe' debe ser mayor que cero")

    return round(importe, 2)


# ISO primero y luego el formato español. No son ambiguos entre sí: el año de
# cuatro cifras va al principio en uno y al final en el otro, así que ninguna
# fecha válida puede leerse de las dos formas.
_FORMATOS_FECHA = ("%Y-%m-%d", "%d-%m-%Y")


def normalizarFecha(valor):
    """Valida una fecha 'YYYY-MM-DD' o 'DD-MM-YYYY'. Vacío o ausente es hoy.

    Se admite el formato español además del ISO porque es el que usa la web
    (`dd-mm-aaaa` en las tablas) y el que sale por defecto al configurar la
    fecha en el Atajo: rechazarlo obligaba a acordarse de invertirlo, y el
    error solo se veía tres pasos más adelante.
    """
    texto = str(valor or "").strip()

    if not texto:
        return date.today()

    for formato in _FORMATOS_FECHA:
        try:
            return datetime.strptime(texto, formato).date()
        except ValueError:
            continue

    raise DatosMovimientoInvalidos("El campo 'fecha' debe tener formato YYYY-MM-DD o DD-MM-YYYY")


def normalizarTexto(valor, maximo, campo, obligatorio=False):
    texto = str(valor or "").strip()[:maximo].strip()

    if obligatorio and not texto:
        raise DatosMovimientoInvalidos(f"El campo '{campo}' es obligatorio")

    return texto


def formatearImporteEuro(importe):
    """Convierte 1234.5 en '1.234,50 €', el formato que renderiza el frontend."""
    formateado = f"{importe:,.2f}"
    # f-string da formato inglés (1,234.50): se intercambian los separadores.
    return formateado.replace(",", "\x00").replace(".", ",").replace("\x00", ".") + " €"


def formatearFechaTabla(fecha):
    return fecha.strftime("%d-%m-%Y")


def sanitizarMovimiento(payload):
    """Valida el JSON recibido y devuelve el movimiento ya normalizado."""
    if not isinstance(payload, dict):
        raise DatosMovimientoInvalidos("El cuerpo debe ser un objeto JSON")

    tipo = normalizarTipo(payload.get("tipo"))
    fecha = normalizarFecha(payload.get("fecha"))

    return {
        "tipo": tipo,
        "categoria": normalizarTexto(payload.get("categoria"), _MAX_CATEGORIA, "categoria"),
        "nombre": normalizarTexto(payload.get("nombre"), _MAX_NOMBRE, "nombre", obligatorio=True),
        "importe": normalizarImporte(payload.get("importe")),
        "fecha": fecha,
    }


def _insertarMovimiento(conn, movimiento, tablas, year, month, fechaTabla, cantidad):
    # gastos_years es la lista maestra de años de la pestaña de Gastos: sin
    # esta fila, read_gastos_year() devuelve None y el movimiento no se ve.
    # Ingresos deriva sus años de las propias filas, así que no lo necesita.
    if movimiento["tipo"] == "gasto":
        conn.execute("INSERT OR IGNORE INTO gastos_years (year) VALUES (?)", (year,))

    cursor = conn.execute(
        f"INSERT INTO {tablas['filas']} (year, month, fecha, nombre, tipo, cantidad) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (year, month, fechaTabla, movimiento["nombre"], movimiento["categoria"], cantidad),
    )

    # Una categoría nueva escrita desde el Atajo se registra en el catálogo
    # global, igual que hace write_gastos_year al guardar desde la web.
    if movimiento["categoria"]:
        conn.execute(
            f"INSERT OR IGNORE INTO {tablas['tipos']} (label) VALUES (?)",
            (movimiento["categoria"],),
        )

    return cursor.lastrowid


def crearMovimiento(movimiento, conn=None):
    """Inserta el movimiento en la tabla que le corresponde y lo devuelve.

    `conn` permite escribir en un portfolio concreto (lo abre la ruta con
    core.db.open_db_at). Sin él se usa la base de datos activa del proceso.

    Todo va en una sola transacción para que no pueda quedar la fila insertada
    sin su año registrado (lo que dejaría el gasto invisible en la web app).
    """
    tablas = _TABLAS_POR_TIPO[movimiento["tipo"]]
    fecha = movimiento["fecha"]
    year = f"{fecha.year:04d}"
    month = MONTH_KEYS[fecha.month - 1]
    cantidad = formatearImporteEuro(movimiento["importe"])
    fechaTabla = formatearFechaTabla(fecha)
    argumentos = (tablas, year, month, fechaTabla, cantidad)

    if conn is not None:
        # open_db_at ya envuelve la llamada en su propia transacción.
        idCreado = _insertarMovimiento(conn, movimiento, *argumentos)
    else:
        with transaction() as conexionActiva:
            idCreado = _insertarMovimiento(conexionActiva, movimiento, *argumentos)

    return {
        "id": idCreado,
        "tipo": movimiento["tipo"],
        "categoria": movimiento["categoria"],
        "nombre": movimiento["nombre"],
        "importe": movimiento["importe"],
        "fecha": fecha.isoformat(),
        "year": year,
        "month": month,
        "cantidad": cantidad,
    }


def leerCategorias(conn=None):
    """Categorías disponibles por tipo, ordenadas alfabéticamente.

    Se unen las etiquetas del catálogo con las que ya aparecen en filas
    guardadas: una categoría escrita a mano en la web puede existir en una fila
    sin haber llegado nunca a la tabla de tipos, y desde el Atajo debe poder
    reutilizarse igualmente.

    `conn` apunta a un portfolio concreto; sin él se lee el activo.
    """
    conn = conn or get_db()
    categorias = {}

    for tipo, tablas in _TABLAS_POR_TIPO.items():
        filas = conn.execute(
            f"SELECT label AS categoria FROM {tablas['tipos']} "
            f"UNION SELECT DISTINCT tipo AS categoria FROM {tablas['filas']}"
        ).fetchall()

        etiquetas = {str(fila["categoria"] or "").strip() for fila in filas}
        categorias[tipo] = sorted(
            (etiqueta for etiqueta in etiquetas if etiqueta),
            key=lambda texto: texto.lower(),
        )

    return categorias
