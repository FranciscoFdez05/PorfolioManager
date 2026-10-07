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

from core import dinero
from core.db import get_db, transaction
from stores import revisiones
from stores.cuentas_store import CuentaInvalida, resolver_cuenta
from stores.gastos_store import MONTH_KEYS

TIPOS_VALIDOS = ("ingreso", "gasto")

_MAX_CATEGORIA = 80
_MAX_NOMBRE = 120

# Cada tipo de movimiento escribe en su propio juego de tablas.
_TABLAS_POR_TIPO = {
    "gasto": {"filas": "gastos_rows", "tipos": "gastos_tipos", "revision": "gastos"},
    "ingreso": {"filas": "ingresos_rows", "tipos": "ingresos_tipos", "revision": "ingresos"},
}


class DatosMovimientoInvalidos(ValueError):
    """Payload rechazado por validación. La ruta lo traduce a un 400."""


def normalizarTipo(valor):
    tipo = str(valor or "").strip().lower()

    if tipo not in TIPOS_VALIDOS:
        raise DatosMovimientoInvalidos("El campo 'tipo' debe ser 'ingreso' o 'gasto'")

    return tipo


def normalizarImporte(valor):
    """Acepta número o cadena numérica y devuelve un `Decimal` positivo con dos decimales.

    Usa el lector de `core.dinero`, el mismo que el resto de la aplicación: el
    Atajo manda texto («12,50», «12.50», «1.234,50 €») y antes se convertía con
    un `float` propio que rechazaba el separador de miles.
    """
    if isinstance(valor, bool) or valor is None or valor == "":
        raise DatosMovimientoInvalidos("El campo 'importe' es obligatorio y debe ser numérico")

    importe = dinero.aDecimalONulo(valor)
    if importe is None:
        raise DatosMovimientoInvalidos("El campo 'importe' debe ser numérico")
    if not importe.is_finite():
        raise DatosMovimientoInvalidos("El campo 'importe' debe ser un número finito")

    importe = dinero.redondear(importe)
    if importe <= 0:
        raise DatosMovimientoInvalidos("El campo 'importe' debe ser mayor que cero")

    return importe


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
    """Convierte 1234.5 en '1.234,50 €', el formato que pinta la tabla de Gastos e Ingresos."""
    return dinero.aTextoEs(importe, decimales=2, miles=True) + " €"


def formatearFechaTabla(fecha):
    return fecha.strftime("%d-%m-%Y")


def sanitizarMovimiento(payload, conn=None):
    """Valida el JSON recibido y devuelve el movimiento ya normalizado.

    `conn` es la cartera donde se va a apuntar: la cuenta se busca en ella. Sin
    él se usaba siempre la activa, y una cuenta que solo existe en la cartera de
    destino se rechazaba (o, con el mismo nombre y otro id, se guardaba un id
    que en esa cartera no significa nada).
    """
    if not isinstance(payload, dict):
        raise DatosMovimientoInvalidos("El cuerpo debe ser un objeto JSON")

    tipo = normalizarTipo(payload.get("tipo"))
    fecha = normalizarFecha(payload.get("fecha"))
    categoria = normalizarTexto(payload.get("categoria"), _MAX_CATEGORIA, "categoria")

    # La cuenta es con la que se paga el gasto o en la que se cobra el ingreso:
    # la bancaria si no se dice otra cosa (el vacío), o cualquiera de las demás
    # por su nombre. La categoría es la de siempre. Mover dinero de una cuenta a
    # otra no se apunta aquí: son transferencias, que se hacen desde la web.
    try:
        cuenta = resolver_cuenta(payload.get("cuenta"), conn)
    except CuentaInvalida as error:
        raise DatosMovimientoInvalidos(str(error)) from None

    return {
        "tipo": tipo,
        "categoria": categoria,
        "cuenta": cuenta,
        # El concepto es opcional: un gasto apuntado de prisa desde el móvil vale
        # con la categoría y el importe, y la fila entra con el concepto en blanco.
        "nombre": normalizarTexto(payload.get("nombre"), _MAX_NOMBRE, "nombre"),
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
        f"INSERT INTO {tablas['filas']} (year, month, fecha, nombre, tipo, cantidad, cuenta) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (year, month, fechaTabla, movimiento["nombre"], movimiento["categoria"], cantidad,
         movimiento.get("cuenta", "")),
    )

    # Una categoría nueva escrita desde el Atajo se registra en el catálogo
    # global, igual que hace write_gastos_year al guardar desde la web.
    if movimiento["categoria"]:
        conn.execute(
            f"INSERT OR IGNORE INTO {tablas['tipos']} (label) VALUES (?)",
            (movimiento["categoria"],),
        )

    # Una pestaña con este año abierto tiene ahora una copia sin esta fila: al
    # guardarla recibirá un 409 y fusionará en vez de borrarla.
    revisiones.avanzar(conn, tablas["revision"], year)

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
        # Número en el JSON de respuesta (el Atajo lo enseña): se convierte
        # una sola vez, aquí, sobre el valor ya redondeado.
        "importe": float(dinero.redondear(movimiento["importe"])),
        "fecha": fecha.isoformat(),
        "year": year,
        "month": month,
        "cantidad": cantidad,
        "cuenta": movimiento.get("cuenta", ""),
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
