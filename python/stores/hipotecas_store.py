"""Acceso a datos de las hipotecas.

Una hipoteca es una fila; las revisiones de Euríbor y las amortizaciones
anticipadas son listas cortas que solo tienen sentido dentro de su hipoteca, así
que van como JSON en dos columnas en vez de en tablas aparte. Nunca se consultan
por separado ni se unen con nada.
"""

import json
import logging
import uuid

from core.centimos import leerImporteCompacto, legadoYCentimos
from core.db import getDb, transactional
from core.errors import ValidationError
from core.hipotecas import sanearHipoteca
from core.validation import asRows, primerIdDuplicado
from stores.cuentas_store import cuentasValidasParaFilas, normalizarCuentaDeFila

log = logging.getLogger(__name__)


def _listaJson(texto: str, campo: str) -> list:
    """Lee una columna JSON; una celda dañada se trata como lista vacía."""
    try:
        valor = json.loads(texto or "[]")
    except json.JSONDecodeError:
        log.warning("Columna %s de hipotecas con JSON ilegible; se ignora", campo)
        return []
    return valor if isinstance(valor, list) else []


def listarHipotecas(conn=None) -> list[dict]:
    """Todas las hipotecas guardadas, en orden de alta.

    Args:
        conn: Conexión a usar. Dentro de una transacción abierta hay que pasarla:
            `getDb()` revierte una transacción pendiente.
    """
    filas = (conn or getDb()).execute(
        "SELECT id, alias, tipo, capital, capital_cent, fecha_inicio, plazo_meses, tin, diferencial, "
        "revision_meses, euribor, amortizaciones, nota, cuenta, dia_cobro, categoria "
        "FROM hipotecas ORDER BY rowid"
    ).fetchall()
    return [
        {
            "id": f["id"], "alias": f["alias"], "tipo": f["tipo"], "capital": leerImporteCompacto(f["capital_cent"], f["capital"]),
            "fechaInicio": f["fecha_inicio"], "plazoMeses": f["plazo_meses"], "tin": f["tin"],
            "diferencial": f["diferencial"], "revisionMeses": f["revision_meses"],
            "euribor": _listaJson(f["euribor"], "euribor"),
            "amortizaciones": _listaJson(f["amortizaciones"], "amortizaciones"),
            "nota": f["nota"], "cuenta": f["cuenta"], "diaCobro": f["dia_cobro"],
            "categoria": f["categoria"],
        }
        for f in filas
    ]


def sanearListado(filas) -> list[dict]:
    """Valida el listado completo y asigna id a las hipotecas nuevas.

    Raises:
        ValidationError: si algún campo es inválido o hay ids repetidos.
    """
    saneadas = [sanearHipoteca(f) for f in asRows(filas, "rows", maxRows=100)]
    validas = cuentasValidasParaFilas()
    for hipoteca in saneadas:
        hipoteca["id"] = hipoteca["id"] or uuid.uuid4().hex
        hipoteca["cuenta"] = normalizarCuentaDeFila(hipoteca["cuenta"], validas)
    repetido = primerIdDuplicado(saneadas)
    if repetido is not None:
        raise ValidationError(f"Id de hipoteca repetido: {repetido}", field="id")
    return saneadas


@transactional
def guardarHipotecas(hipotecas: list[dict]) -> None:
    """Sustituye todas las hipotecas por `hipotecas` (ya saneadas) en una transacción.

    Regenera en la misma transacción las cuotas que cada hipoteca aporta a
    Mensualidades, para que nunca queden desfasadas de la hipoteca.
    """
    # Importación diferida: el módulo de sincronización lee este para listar.
    from stores.deudas_mensualidades import sincronizarTodo

    conn = getDb()
    conn.execute("DELETE FROM hipotecas")
    conn.executemany(
        "INSERT INTO hipotecas (id, alias, tipo, capital, capital_cent, fecha_inicio, plazo_meses, tin, "
        "diferencial, revision_meses, euribor, amortizaciones, nota, cuenta, dia_cobro, categoria) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (h["id"], h["alias"], h["tipo"], *legadoYCentimos(h["capital"]), h["fechaInicio"], h["plazoMeses"],
             h["tin"], h["diferencial"], h["revisionMeses"],
             json.dumps(h["euribor"]), json.dumps(h["amortizaciones"]), h["nota"],
             h["cuenta"], h["diaCobro"], h["categoria"])
            for h in hipotecas
        ],
    )
    sincronizarTodo(conn)
    conn.commit()
