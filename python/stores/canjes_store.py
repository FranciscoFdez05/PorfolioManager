"""Canjes de valores por fusión: validación y acceso a la tabla `canjes`.

Patrón Repository: este módulo es el único que lee y escribe la tabla. Lo que el
canje significa fiscalmente vive en `core.canjes`, y cómo entra en la línea
temporal de cada activo en `stores.ventas_fifo` (cálculo fiscal) y en
`stores.rendimiento_activo` (posición de la cartera).

Los importes se guardan en texto canónico (`core.dinero.aTexto`) en la divisa
del canje (`moneda`), con el tipo de cambio a euros de ese día en `fx_rate`. El
canje de dos valores estadounidenses se liquida en dólares, y convertirlo a
euros al guardarlo perdería el dato que figura en la comunicación del broker.
"""

import re
import uuid
from datetime import date
from decimal import Decimal

from core import canjes, dinero, fifo
from core.db import getDb, transactional
from core.errors import NotFoundError, ValidationError
from core.validation import asDecimal, asText

_MONEDA = re.compile(r"^[A-Z]{3}$")
_MAX_NOTA = 500
_CERO = Decimal("0")

# (columna, clave de la API). `COLUMNAS` sale siempre de esta constante: lo
# único que viene del cliente son valores, y van parametrizados.
COLUMNAS = (
    ("id", "id"),
    ("fecha", "fecha"),
    ("activo_origen", "activoOrigen"),
    ("activo_destino", "activoDestino"),
    ("cantidad_entregada", "cantidadEntregada"),
    ("cantidad_recibida", "cantidadRecibida"),
    ("regimen", "regimen"),
    ("valor_mercado", "valorMercado"),
    ("compensacion", "compensacion"),
    ("picos_cantidad", "picosCantidad"),
    ("picos_importe", "picosImporte"),
    ("moneda", "moneda"),
    ("fx_rate", "fxRate"),
    ("nota", "nota"),
)
_SELECT = (
    f"SELECT rowid AS seq, {', '.join(columna for columna, _ in COLUMNAS)} FROM canjes"
)


def leerFilas() -> list:
    """Filas crudas de la tabla, en orden de alta (`seq` incluido).

    Returns:
        Lista de `sqlite3.Row`.
    """
    return getDb().execute(f"{_SELECT} ORDER BY rowid").fetchall()


def listar() -> list[dict]:
    """Todos los canjes, en el formato de la API, de más antiguo a más reciente.

    Returns:
        Lista de diccionarios con las claves de `COLUMNAS`.
    """
    filas = [_aApi(fila) for fila in leerFilas()]
    filas.sort(key=lambda fila: (_ordenFecha(fila["fecha"]), fila["seq"]))
    return filas


def leer(canjeId: str) -> dict:
    """Un canje en el formato de la API.

    Raises:
        NotFoundError: si no existe.
    """
    fila = getDb().execute(f"{_SELECT} WHERE id = ?", (str(canjeId),)).fetchone()
    if fila is None:
        raise NotFoundError("Canje no encontrado")
    return _aApi(fila)


@transactional
def guardar(datos: dict, canjeId: str | None = None) -> dict:
    """Valida y guarda un canje nuevo o modifica uno existente.

    Args:
        datos: Cuerpo de la petición, con las claves de la API.
        canjeId: Id del canje a modificar; None para crear uno.

    Returns:
        El canje guardado, en el formato de la API.

    Raises:
        ValidationError: si algún campo no es válido.
        NotFoundError: si se modifica un canje que no existe.
    """
    conn = getDb()
    if canjeId is not None and conn.execute(
        "SELECT 1 FROM canjes WHERE id = ?", (str(canjeId),)
    ).fetchone() is None:
        raise NotFoundError("Canje no encontrado")

    valores = validar(datos, _idsDeActivos(conn))
    valores["id"] = str(canjeId) if canjeId is not None else uuid.uuid4().hex
    columnas = [columna for columna, _ in COLUMNAS]
    parametros = [valores[clave] for _, clave in COLUMNAS]

    if canjeId is None:
        conn.execute(
            f"INSERT INTO canjes ({', '.join(columnas)}) VALUES ({', '.join('?' for _ in columnas)})",
            parametros,
        )
    else:
        asignaciones = ", ".join(f"{columna} = ?" for columna in columnas[1:])
        conn.execute(f"UPDATE canjes SET {asignaciones} WHERE id = ?", [*parametros[1:], valores["id"]])
    conn.commit()
    return leer(valores["id"])


@transactional
def borrar(canjeId: str) -> bool:
    """Borra un canje.

    Returns:
        True si existía.
    """
    conn = getDb()
    borradas = conn.execute("DELETE FROM canjes WHERE id = ?", (str(canjeId),)).rowcount
    conn.commit()
    return borradas > 0


def validarContraLaBase(datos: dict) -> dict:
    """`validar` con los activos que existen ahora en la base.

    Raises:
        ValidationError: con el primer campo que no es válido.
    """
    return validar(datos, _idsDeActivos(getDb()))


def validar(datos: dict, activos: set) -> dict:
    """Comprueba un canje y lo deja en formato de almacenamiento.

    Las reglas son las que hacen falta para que el canje pueda colocarse en la
    línea temporal sin inventar nada. Que haya títulos suficientes en el origen
    no se comprueba aquí: depende de todo el histórico, y sale como incidencia
    en el cálculo, como en una venta.

    Args:
        datos: Cuerpo de la petición.
        activos: Ids de los activos existentes.

    Returns:
        Diccionario con las claves de la API y los valores ya normalizados.

    Raises:
        ValidationError: con el primer campo que no es válido.
    """
    if not isinstance(datos, dict):
        raise ValidationError("El canje debe ser un objeto")

    fecha = _fecha(datos.get("fecha"))
    origen = asText(datos.get("activoOrigen"), "activo entregado", required=True, maxLength=200)
    destino = asText(datos.get("activoDestino"), "activo recibido", required=True, maxLength=200)
    if origen not in activos:
        raise ValidationError("El activo entregado no existe", field="activoOrigen")
    if destino not in activos:
        raise ValidationError("El activo recibido no existe", field="activoDestino")
    if origen == destino:
        raise ValidationError("El activo entregado y el recibido deben ser distintos", field="activoDestino")

    regimen = asText(datos.get("regimen"), "régimen", default=canjes.NEUTRAL)
    if regimen not in canjes.REGIMENES:
        raise ValidationError("El régimen debe ser «neutral» o «gravado»", field="regimen")

    entregadas = _cantidad(datos, "cantidadEntregada", "títulos entregados", estricto=True)
    recibidas = _cantidad(datos, "cantidadRecibida", "títulos recibidos")
    picos = _cantidad(datos, "picosCantidad", "fracción liquidada (picos)")
    if recibidas + picos <= 0:
        raise ValidationError(
            "Indica los títulos recibidos o la fracción liquidada en efectivo", field="cantidadRecibida"
        )

    valorMercado = _importe(datos, "valorMercado", "valor de mercado de lo recibido")
    compensacion = _importe(datos, "compensacion", "compensación en dinero")
    picosImporte = _importe(datos, "picosImporte", "efectivo de los picos")
    if regimen == canjes.GRAVADO and valorMercado <= 0:
        raise ValidationError(
            "En el régimen general hace falta el valor de mercado de los títulos recibidos",
            field="valorMercado",
        )

    moneda = asText(datos.get("moneda"), "moneda", default="EUR").upper() or "EUR"
    if not _MONEDA.match(moneda):
        raise ValidationError("La moneda debe ser un código de tres letras (EUR, USD…)", field="moneda")
    fxRate = asDecimal(datos.get("fxRate"), "tipo de cambio", minimum=_CERO)
    hayImportes = any(valor > 0 for valor in (valorMercado, compensacion, picosImporte))
    if moneda != "EUR" and hayImportes and (fxRate is None or fxRate <= 0):
        raise ValidationError(
            f"Falta el tipo de cambio de {moneda} a euros del día del canje", field="fxRate"
        )

    return {
        "fecha": fecha,
        "activoOrigen": origen,
        "activoDestino": destino,
        "cantidadEntregada": dinero.aTexto(entregadas),
        "cantidadRecibida": _texto(recibidas),
        "regimen": regimen,
        "valorMercado": _texto(valorMercado),
        "compensacion": _texto(compensacion),
        "picosCantidad": _texto(picos),
        "picosImporte": _texto(picosImporte),
        "moneda": moneda,
        "fxRate": _texto(fxRate) if moneda != "EUR" else "",
        "nota": asText(datos.get("nota"), "nota", maxLength=_MAX_NOTA),
    }


def _fecha(valor) -> str:
    try:
        return fifo.parseFecha(valor, "fecha del canje").strftime("%d-%m-%Y")
    except fifo.FifoError as error:
        raise ValidationError(str(error), field="fecha") from None


def _cantidad(datos, clave, nombre, *, estricto=False) -> Decimal:
    valor = asDecimal(datos.get(clave), nombre, default=_CERO, minimum=_CERO, required=estricto)
    if estricto and valor <= 0:
        raise ValidationError(f"«{nombre}» debe ser mayor que cero", field=clave)
    return valor


def _importe(datos, clave, nombre) -> Decimal:
    return asDecimal(datos.get(clave), nombre, default=_CERO, minimum=_CERO)


def _texto(valor) -> str:
    """Cero y vacío se guardan como celda vacía, como en el resto de tablas."""
    if valor is None or valor == 0:
        return ""
    return dinero.aTexto(valor)


def _idsDeActivos(conn) -> set:
    return {fila["id"] for fila in conn.execute("SELECT id FROM activos")}


def _aApi(fila) -> dict:
    dato = {clave: fila[columna] for columna, clave in COLUMNAS}
    dato["seq"] = int(fila["seq"])
    return dato


def _ordenFecha(texto):
    try:
        return fifo.parseFecha(texto)
    except fifo.FifoError:
        return date.max
