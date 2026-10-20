"""Persistencia de la tabla de ventas.

Cambio de reparto de responsabilidades respecto a la versión anterior: el
cliente solo manda **datos de hecho** (fecha, activo, cantidad, precio y
comisión de la venta). Todo lo fiscal —coste FIFO, ganancia, tramos, cuota— lo
calcula el servidor con `stores.ventas_fifo` y se guarda como copia derivada,
para que los backups y las exportaciones lleven el número, pero sin que sea
nunca la fuente de verdad. Antes el POST aceptaba esos importes tal cual venían
del navegador y los escribía sin mirarlos.
"""

from core.db import getDb, transactional
from core.errors import ValidationError
from stores import revisiones, ventas_fifo
from stores.gastos_store import normalizeYear

_MAX_SHORT = 30
_MAX_NAME = 120
_MAX_FILAS = 500


def createDefaultVentasYear(year):
    return {"year": normalizeYear(year), "rows": []}


def sanitizeVentasRows(rows):
    if not isinstance(rows, list):
        return []
    if len(rows) > _MAX_FILAS:
        rows = rows[:_MAX_FILAS]
    sanitized = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        sanitized.append({
            "id": str(row.get("id", f"venta-{index + 1}"))[:_MAX_SHORT].strip() or f"venta-{index + 1}",
            "fecha": str(row.get("fecha", ""))[:_MAX_SHORT].strip(),
            "assetId": str(row.get("assetId", ""))[:_MAX_SHORT].strip(),
            "activo": str(row.get("activo", ""))[:_MAX_NAME].strip(),
            "cantidad": str(row.get("cantidad", ""))[:_MAX_SHORT].strip(),
            "valorVenta": str(row.get("valorVenta", row.get("precioVenta", row.get("valor_venta", ""))))[:_MAX_SHORT].strip(),
            "comisionVenta": str(row.get("comisionVenta", row.get("comision_venta", "")))[:_MAX_SHORT].strip(),
        })
    return sanitized


def sanitizeVentasPayload(payload, fallbackYear=None):
    year = normalizeYear(payload.get("year") or fallbackYear)
    if not year:
        return None, "Año inválido"

    rows = sanitizeVentasRows(payload.get("rows", []))

    vistos = set()
    for row in rows:
        if row["id"] in vistos:
            # Dos filas con el mismo id colisionarían en la clave primaria y
            # una desaparecería en silencio al guardar.
            return None, f"Hay dos ventas con el mismo identificador ({row['id']})"
        vistos.add(row["id"])

    return {"year": year, "rows": rows}, None


def listVentasYears():
    # La unión con `ventas` recoge los años de datos antiguos que tengan filas
    # sin su entrada en ventas_years, sin escribir nada: antes lo arreglaba un
    # INSERT en cada GET.
    conn = getDb()
    return [
        r["year"] for r in conn.execute(
            "SELECT year FROM ventas_years UNION SELECT year FROM ventas ORDER BY year"
        ).fetchall()
    ]


def _filaBase(r):
    return {
        "id": r["id"],
        "fecha": r["fecha"],
        "assetId": r["asset_id"],
        "activo": r["activo"],
        "cantidad": r["cantidad"],
        "valorVenta": r["valor_venta"],
        "comisionVenta": r["comision_venta"],
    }


_SELECT_BASE = (
    "SELECT id, year, fecha, asset_id, activo, cantidad, valor_venta, comision_venta "
    "FROM ventas"
)


def readVentasYear(year, calculo=None):
    """Ventas de un ejercicio con su liquidación fiscal ya aplicada."""
    normalized = normalizeYear(year)
    if not normalized:
        return None

    conn = getDb()
    if normalized not in listVentasYears():
        return None

    filas = conn.execute(
        f"{_SELECT_BASE} WHERE year = ? ORDER BY rowid", (normalized,)
    ).fetchall()

    calculo = calculo or ventas_fifo.calcularTodo()
    liquidacion = calculo["liquidaciones"].get(normalized)

    return {
        "year": normalized,
        "rows": [_combinar(r, calculo) for r in filas],
        "resumen": (
            ventas_fifo.serializarLiquidacion(liquidacion) if liquidacion else None
        ),
        "incidencias": [
            i for i in calculo["incidencias"] if str(i["year"]) == normalized
        ],
        "revision": revisiones.leer(conn, "ventas", normalized),
    }


def _combinar(fila, calculo):
    base = _filaBase(fila)
    calculado = calculo["filas"].get((fila["year"], fila["id"]))
    base.update(calculado or ventas_fifo.filaVacia())
    return base


@transactional
def writeVentasYear(year, data, revisionEsperada=None):
    """Guarda las filas del ejercicio y recalcula la fiscalidad de todos.

    Con `revisionEsperada` lanza ConflictoRevision si el ejercicio se guardó
    desde otro sitio después de que el cliente lo leyera (ver
    stores/revisiones.py).

    El recálculo abarca todos los ejercicios, no solo el que se guarda: añadir
    una venta en 2025 cambia qué lotes quedan vivos para 2026, y dejar 2026 con
    los números viejos era exactamente el descuadre que arrastraba la versión
    anterior.
    """
    normalized = normalizeYear(year)
    if not normalized:
        return

    conn = getDb()
    revisiones.tomarBloqueo(conn)
    revisiones.comprobar(conn, "ventas", normalized, revisionEsperada)
    # El nombre del activo se guarda resuelto desde `activos`: es solo una
    # etiqueta para que un backup o una exportación se lean sin la otra tabla,
    # y depender de lo que mande el cliente la dejaba vacía o desfasada.
    nombres = {r["id"]: r["name"] for r in conn.execute("SELECT id, name FROM activos")}

    # El tipo de cambio de cada venta lo rellena fx_historico y el formulario no
    # lo manda: reescribir el ejercicio sin heredarlo lo borraba en cada guardado.
    # Depende de la fecha y de la divisa, que en una venta es la de su activo.
    fxPrevios = {
        (r["fecha"], r["asset_id"]): (r["fx_rate"], r["fx_fecha"], r["fx_origen"])
        for r in conn.execute(
            "SELECT fecha, asset_id, fx_rate, fx_fecha, fx_origen FROM ventas "
            "WHERE year = ? AND fx_rate != ''",
            (normalized,),
        )
    }

    conn.execute("INSERT OR IGNORE INTO ventas_years (year) VALUES (?)", (normalized,))
    conn.execute("DELETE FROM ventas WHERE year = ?", (normalized,))
    conn.executemany(
        "INSERT INTO ventas (id, year, fecha, asset_id, activo, cantidad, valor_venta, comision_venta, "
        "fx_rate, fx_fecha, fx_origen) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), normalized, r.get("fecha", ""), r.get("assetId", ""),
             nombres.get(r.get("assetId", ""), r.get("activo", "")),
             r.get("cantidad", ""), r.get("valorVenta", ""),
             r.get("comisionVenta", ""),
             *fxPrevios.get((r.get("fecha", ""), r.get("assetId", "")), ("", "", "")))
            for r in data.get("rows", [])
        ]
    )
    revisiones.avanzar(conn, "ventas", normalized)
    conn.commit()

    return refrescarCalculo()


@transactional
def refrescarCalculo():
    """Recalcula el FIFO completo y vuelca los importes derivados a la tabla.

    La copia en base de datos existe para que un backup o una exportación
    lleven los importes ya calculados; la fuente de verdad sigue siendo el
    cálculo, que se rehace en cada lectura.
    """
    calculo = ventas_fifo.calcularTodo()
    conn = getDb()

    conn.executemany(
        "UPDATE ventas SET valor_compra = ?, dinero_declarar = ?, "
        "tramo1 = ?, tramo2 = ?, tramo3 = ?, tramo4 = ?, tramo5 = ?, "
        "total_pagar = ?, bruto = ?, neto = ? WHERE year = ? AND id = ?",
        [
            (
                fila.get("valorCompra", ""), fila.get("dineroDeclarar", ""),
                fila.get("tramo1", ""), fila.get("tramo2", ""), fila.get("tramo3", ""),
                fila.get("tramo4", ""), fila.get("tramo5", ""),
                fila.get("totalPagar", ""), fila.get("bruto", ""), fila.get("neto", ""),
                anio, ventaId,
            )
            for (anio, ventaId), fila in calculo["filas"].items()
        ]
    )
    conn.commit()
    return calculo


def validarParaGuardar(data):
    """Rechaza lo que no puede entrar en la línea temporal.

    Distingue dos niveles a propósito. Un dato formalmente imposible (fecha
    ilegible, cantidad cero, activo inexistente) se rechaza: guardarlo dejaría
    una fila que no se puede ni ordenar. Una incoherencia de saldo —vender más
    de lo que hay— sí se guarda, marcada, porque a menudo se arregla
    registrando la compra que faltaba, y bloquear el guardado dejaría al
    usuario sin poder avanzar.
    """
    conn = getDb()
    activos = {r["id"] for r in conn.execute("SELECT id FROM activos")}
    errores = []

    for indice, row in enumerate(data.get("rows", []), start=1):
        # Una fila donde solo se ha elegido el activo sigue siendo un borrador:
        # se guarda para no perder lo tecleado y aparece marcada al leerla,
        # pero no puede bloquear el guardado de las demás.
        if not any(row.get(campo) for campo in ("fecha", "cantidad", "valorVenta")):
            continue

        fila = {
            "asset_id": row.get("assetId", ""),
            "cantidad": row.get("cantidad", ""),
            "valor_venta": row.get("valorVenta", ""),
            "fecha": row.get("fecha", ""),
            "year": data.get("year", ""),
        }
        _, incidencia = ventas_fifo.validarVenta(
            fila, {a: {} for a in activos}
        )
        if incidencia in ventas_fifo.BLOQUEANTES:
            errores.append({
                "fila": indice,
                "id": row.get("id", ""),
                "codigo": incidencia,
                "mensaje": ventas_fifo.mensajeIncidencia(incidencia),
            })

    if errores:
        raise ValidationError(
            f"{len(errores)} venta(s) con datos inválidos",
            details=errores,
        )


@transactional
def deleteVentasYear(year):
    normalized = normalizeYear(year)
    if not normalized:
        return False

    conn = getDb()
    conn.execute("DELETE FROM ventas WHERE year = ?", (normalized,))
    result = conn.execute("DELETE FROM ventas_years WHERE year = ?", (normalized,))
    # Una pestaña que aún tenga el ejercicio abierto no debe poder resucitarlo
    # al guardar con la revisión de antes del borrado.
    revisiones.avanzar(conn, "ventas", normalized)
    conn.commit()

    if result.rowcount > 0:
        # Borrar un ejercicio devuelve lotes a la cartera: los años siguientes
        # tienen que recalcularse o quedarían con un coste FIFO que ya no
        # corresponde a ninguna compra.
        refrescarCalculo()

    return result.rowcount > 0


@transactional
def migrateLegacyVentasIfNeeded(defaultYear):
    """En la versión SQLite no hay ficheros legacy que migrar.
    Si no hay ningún año crea uno vacío con el año por defecto.
    También migra años existentes en la tabla ventas que no estén en ventas_years."""
    conn = getDb()
    conn.execute("INSERT OR IGNORE INTO ventas_years (year) SELECT DISTINCT year FROM ventas")
    conn.commit()
    years = listVentasYears()
    if years:
        return years
    writeVentasYear(defaultYear, createDefaultVentasYear(defaultYear))
    return [defaultYear]


def readAllVentasRows(calculo=None):
    conn = getDb()
    filas = conn.execute(f"{_SELECT_BASE} ORDER BY year, rowid").fetchall()
    calculo = calculo or ventas_fifo.calcularTodo()
    return [_combinar(r, calculo) for r in filas]
