"""Acceso a datos de las compras financiadas."""

import json
import logging
import uuid

from core.centimos import leerImporteCompacto, legadoYCentimos
from core.db import getDb, transactional
from core.errors import ValidationError
from core.financiaciones import sanearListadoFinanciaciones
from core.validation import primerIdDuplicado
from stores.cuentas_store import cuentasValidasParaFilas, normalizarCuentaDeFila

log = logging.getLogger(__name__)


def _listaJson(texto: str) -> list:
    """Lista guardada como JSON; ilegible o de otro tipo se trata como vacía."""
    try:
        valor = json.loads(texto or "[]")
    except json.JSONDecodeError:
        log.warning("Columna amortizaciones de financiaciones con JSON ilegible; se ignora")
        return []
    return valor if isinstance(valor, list) else []


def listarFinanciaciones(conn=None) -> list[dict]:
    """Todas las compras financiadas, en orden de alta.

    Args:
        conn: Conexión a usar. Dentro de una transacción abierta hay que pasarla:
            `getDb()` revierte una transacción pendiente.
    """
    filas = (conn or getDb()).execute(
        "SELECT id, articulo, precio, precio_cent, entrada, entrada_cent, cuotas, tin, fecha_inicio, nota, "
        "cuenta, dia_cobro, categoria, amortizaciones FROM financiaciones ORDER BY rowid"
    ).fetchall()
    return [
        {"id": f["id"], "articulo": f["articulo"], "precio": leerImporteCompacto(f["precio_cent"], f["precio"]),
         "entrada": leerImporteCompacto(f["entrada_cent"], f["entrada"]),
         "cuotas": f["cuotas"], "tin": f["tin"], "fechaInicio": f["fecha_inicio"], "nota": f["nota"],
         "cuenta": f["cuenta"], "diaCobro": f["dia_cobro"], "categoria": f["categoria"],
         "amortizaciones": _listaJson(f["amortizaciones"])}
        for f in filas
    ]


def sanearListado(filas) -> list[dict]:
    """Valida el listado completo y asigna id a las compras nuevas.

    Raises:
        ValidationError: si algún campo es inválido o hay ids repetidos.
    """
    saneadas = sanearListadoFinanciaciones(filas)
    validas = cuentasValidasParaFilas()
    for compra in saneadas:
        compra["id"] = compra["id"] or uuid.uuid4().hex
        compra["cuenta"] = normalizarCuentaDeFila(compra["cuenta"], validas)
    repetido = primerIdDuplicado(saneadas)
    if repetido is not None:
        raise ValidationError(f"Id de compra repetido: {repetido}", field="id")
    return saneadas


@transactional
def guardarFinanciaciones(compras: list[dict]) -> None:
    """Sustituye todas las compras por `compras` (ya saneadas) en una transacción.

    Regenera en la misma transacción las cuotas que cada compra aporta a
    Mensualidades, para que nunca queden desfasadas de la compra.
    """
    # Importación diferida: el módulo de sincronización lee este para listar.
    from stores.deudas_mensualidades import sincronizarTodo

    conn = getDb()
    conn.execute("DELETE FROM financiaciones")
    conn.executemany(
        "INSERT INTO financiaciones (id, articulo, precio, precio_cent, entrada, entrada_cent, cuotas, tin, "
        "fecha_inicio, nota, cuenta, dia_cobro, categoria, amortizaciones) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(c["id"], c["articulo"], *legadoYCentimos(c["precio"]), *legadoYCentimos(c["entrada"]), c["cuotas"], c["tin"],
          c["fechaInicio"], c["nota"], c["cuenta"], c["diaCobro"], c["categoria"],
          json.dumps(c["amortizaciones"])) for c in compras],
    )
    sincronizarTodo(conn)
    conn.commit()
