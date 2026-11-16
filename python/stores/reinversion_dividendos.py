"""Compras de la ficha que salen de dividendos reinvertidos.

El dividendo es la fuente de verdad: guarda cuántas participaciones se compraron
con él y a qué precio. Este módulo vuelca esos datos en `activo_rows` como filas
de tipo `Compra` con `reinvertido = 1`, y así todo lo que ya lee la ficha (el
FIFO fiscal, la posición, los snapshots, el gráfico) las trata como una compra
más sin tener que conocer los dividendos.

Las filas se **regeneran**, no se editan: cada guardado de dividendos o de la
ficha las borra y las vuelve a crear desde la tabla `dividendos`. Por eso la
ficha, que se guarda entera desde el navegador, no puede duplicarlas ni
perderlas aunque trabaje con una copia antigua.
"""

import logging
from datetime import date
from decimal import Decimal

from core import dinero, fifo
from stores import revisiones

log = logging.getLogger(__name__)

TIPO_COMPRA = "Compra"

# Decimales con los que se guarda el capital de la compra: es lo que el usuario
# teclearía en la ficha, y el precio unitario conserva todos los suyos.
_DECIMALES_CAPITAL = 2


def _canonico(valor: Decimal) -> str:
    """Decimal como texto canónico (punto decimal, sin exponente ni ceros de más)."""
    texto = f"{valor:f}"
    if "." in texto:
        texto = texto.rstrip("0").rstrip(".")
    return texto or "0"


def parsearFechaCompleta(texto: str) -> date | None:
    """Fecha completa (dd-mm-aaaa o aaaa-mm-dd) de un dividendo, o None si no lo es.

    Args:
        texto: Fecha tal como la guarda el dividendo.

    Returns:
        La fecha, o None si está vacía, incompleta (mm-aaaa) o no es una fecha.
    """
    try:
        return fifo.parseFecha(texto)
    except fifo.FifoError:
        return None


def _compraDeDividendo(fila, moneda: str) -> tuple | None:
    """Fila de `activo_rows` (sin id ni fx) para un dividendo reinvertido, o None si no es válido.

    Un dividendo marcado como reinvertido pero sin fecha completa o con
    participaciones o precio ilegibles no genera compra: la ruta los rechaza al
    guardar, y esto solo protege de filas antiguas o importadas.
    """
    participaciones = dinero.aDecimalONulo(fila["reinv_participaciones"])
    precio = dinero.aDecimalONulo(fila["reinv_precio"])
    if participaciones is None or precio is None or participaciones <= 0 or precio < 0:
        return None
    if parsearFechaCompleta(fila["fecha"]) is None:
        return None

    capital = dinero.redondear(participaciones * precio, _DECIMALES_CAPITAL)
    return (
        str(fila["fecha"]).strip(), TIPO_COMPRA, moneda,
        _canonico(participaciones), _canonico(precio),
        _canonico(capital) if capital > 0 else "",
    )


def _fxPrevios(conn, assetId: str) -> dict:
    """Tipo de cambio ya anotado en las filas del activo, por (fecha, divisa).

    Regenerar las filas no debe borrar el tipo histórico que ya se resolvió para
    ellas: el FIFO marca incidencia en una compra en divisa sin tipo.
    """
    return {
        (fila["fecha_operacion"], fila["currency"]): (fila["fx_rate"], fila["fx_fecha"], fila["fx_origen"])
        for fila in conn.execute(
            "SELECT fecha_operacion, currency, fx_rate, fx_fecha, fx_origen "
            "FROM activo_rows WHERE asset_id = ? AND fx_rate != ''",
            (assetId,),
        )
    }


def _comprasDeseadasPorActivo(conn, activos: dict) -> dict:
    """`{asset_id: [compra, ...]}` de todos los dividendos reinvertidos, en orden de alta."""
    idPorNombre = {datos["name"].strip(): activoId for activoId, datos in activos.items()}
    deseadas: dict = {}
    for fila in conn.execute(
        "SELECT fecha, instrumento, reinv_participaciones, reinv_precio "
        "FROM dividendos WHERE reinvertido = 1 ORDER BY id"
    ):
        activoId = idPorNombre.get(str(fila["instrumento"]).strip())
        if activoId is None:
            continue
        compra = _compraDeDividendo(fila, activos[activoId]["currency"])
        if compra is not None:
            deseadas.setdefault(activoId, []).append(compra)
    return deseadas


def _reescribir(conn, assetId: str, compras: list, fxExtra: dict | None = None) -> bool:
    """Deja en la ficha del activo exactamente `compras` como filas reinvertidas.

    Returns:
        True si las filas cambiaron (había que reescribirlas), False si ya estaban igual.
    """
    actuales = [
        (fila["fecha_operacion"], fila["tipo_operacion"], fila["currency"], fila["participaciones"],
         fila["precio_participacion"], fila["capital_invertido_bruto"])
        for fila in conn.execute(
            "SELECT fecha_operacion, tipo_operacion, currency, participaciones, precio_participacion, "
            "capital_invertido_bruto FROM activo_rows WHERE asset_id = ? AND reinvertido = 1 ORDER BY id",
            (assetId,),
        )
    ]
    if actuales == compras:
        return False

    previos = {**_fxPrevios(conn, assetId), **(fxExtra or {})}
    conn.execute("DELETE FROM activo_rows WHERE asset_id = ? AND reinvertido = 1", (assetId,))
    conn.executemany(
        "INSERT INTO activo_rows (asset_id, fecha_operacion, tipo_operacion, currency, participaciones, "
        "precio_participacion, capital_invertido_bruto, fx_rate, fx_fecha, fx_origen, reinvertido) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)",
        [(assetId, *compra, *previos.get((compra[0], compra[2]), ("", "", ""))) for compra in compras],
    )
    return True


def renombrarInstrumento(conn, nombreViejo: str, nombreNuevo: str) -> None:
    """Pasa los dividendos de un activo a su nombre nuevo.

    Los dividendos se casan con el activo por nombre. Sin esto, renombrar el
    activo dejaba sus dividendos reinvertidos huérfanos y sus compras
    desaparecían de la ficha y del FIFO en el siguiente guardado.

    Args:
        conn: Conexión a la base del portfolio activo.
        nombreViejo: Nombre que tenía el activo.
        nombreNuevo: Nombre que tiene ahora.
    """
    viejo, nuevo = nombreViejo.strip(), nombreNuevo.strip()
    if viejo and nuevo and viejo != nuevo:
        conn.execute("UPDATE dividendos SET instrumento = ? WHERE trim(instrumento) = ?", (nuevo, viejo))


def convertirPrecios(conn, nombre: str, factor: Decimal) -> None:
    """Multiplica por `factor` el precio de compra de los dividendos reinvertidos de un activo.

    Cuando el activo cambia de divisa, el precio de sus compras se convierte; el
    de las reinversiones tiene que seguirlo, o la compra regenerada saldría con
    el precio de la divisa anterior.

    Args:
        conn: Conexión a la base del portfolio activo.
        nombre: Nombre del activo.
        factor: Cuántas unidades de la divisa nueva vale una de la anterior.
    """
    filas = conn.execute(
        "SELECT id, reinv_precio FROM dividendos WHERE reinvertido = 1 AND trim(instrumento) = ?",
        (nombre.strip(),),
    ).fetchall()
    for fila in filas:
        precio = dinero.aDecimalONulo(fila["reinv_precio"])
        if precio is not None:
            conn.execute(
                "UPDATE dividendos SET reinv_precio = ? WHERE id = ?", (_canonico(precio * factor), fila["id"])
            )


def sincronizar(conn, assetId: str | None = None, avanzarRevision: bool = True, fxExtra: dict | None = None) -> list:
    """Regenera las compras reinvertidas de la ficha a partir de los dividendos.

    No confirma la transacción: lo hace quien llama, junto con lo que guardó.

    Args:
        conn: Conexión a la base del portfolio activo.
        assetId: Si se indica, solo ese activo; si no, todos los que tienen o
            deben tener compras reinvertidas.
        avanzarRevision: Si debe avanzar la revisión de los activos que cambian,
            para que una ficha abierta en otra pestaña detecte el cambio. La
            desactiva quien ya va a avanzarla (el guardado de la propia ficha).
        fxExtra: Tipos de cambio `{(fecha, divisa): (tipo, fecha, origen)}` que
            mandan sobre los anotados en la base. Los aporta el cambio de divisa
            del activo, que reescala el tipo de cada fila.

    Returns:
        Los ids de los activos cuyas filas cambiaron.
    """
    activos = {
        fila["id"]: {"name": fila["name"], "currency": str(fila["currency"] or "EUR").strip().upper() or "EUR"}
        for fila in conn.execute("SELECT id, name, currency FROM activos")
    }
    deseadas = _comprasDeseadasPorActivo(conn, activos)

    if assetId is not None:
        afectados = {assetId} & set(activos)
    else:
        # Los que ya tenían filas reinvertidas también cuentan: si el dividendo
        # se ha borrado o desmarcado, hay que quitárselas.
        conFilas = {
            fila["asset_id"] for fila in conn.execute("SELECT DISTINCT asset_id FROM activo_rows WHERE reinvertido = 1")
        }
        afectados = (set(deseadas) | conFilas) & set(activos)

    cambiados = []
    for activo in sorted(afectados):
        if _reescribir(conn, activo, deseadas.get(activo, []), fxExtra):
            cambiados.append(activo)
            if avanzarRevision:
                revisiones.avanzar(conn, "activos", activo)

    if cambiados:
        log.info("Compras reinvertidas regeneradas en %s", ", ".join(cambiados))
    return cambiados
