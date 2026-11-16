"""Acceso a datos de los microcréditos."""

import uuid

from core.centimos import leerImporteCompacto, legadoYCentimos
from core.db import getDb, transactional
from core.errors import ValidationError
from core.microcreditos import sanearListadoMicrocreditos
from core.validation import primerIdDuplicado
from stores.cuentas_store import cuentasValidasParaFilas, normalizarCuentaDeFila


def listarMicrocreditos(conn=None) -> list[dict]:
    """Todos los microcréditos guardados, en orden de alta.

    Args:
        conn: Conexión a usar. Dentro de una transacción abierta hay que pasarla:
            `getDb()` revierte una transacción pendiente.
    """
    filas = (conn or getDb()).execute(
        "SELECT id, nombre, modo, importe, importe_cent, comision, comision_cent, fecha_inicio, fecha_vencimiento, "
        "devuelto, fecha_devolucion, cuotas, tin, nota, cuenta, dia_cobro, categoria "
        "FROM microcreditos ORDER BY rowid"
    ).fetchall()
    return [
        {"id": f["id"], "nombre": f["nombre"], "modo": f["modo"],
         "importe": leerImporteCompacto(f["importe_cent"], f["importe"]),
         "comision": leerImporteCompacto(f["comision_cent"], f["comision"]), "fechaInicio": f["fecha_inicio"],
         "fechaVencimiento": f["fecha_vencimiento"], "devuelto": bool(f["devuelto"]),
         "fechaDevolucion": f["fecha_devolucion"], "cuotas": f["cuotas"], "tin": f["tin"],
         "nota": f["nota"], "cuenta": f["cuenta"], "diaCobro": f["dia_cobro"],
         "categoria": f["categoria"]}
        for f in filas
    ]


def sanearListado(filas) -> list[dict]:
    """Valida el listado completo y asigna id a los microcréditos nuevos.

    Raises:
        ValidationError: si algún campo es inválido o hay ids repetidos.
    """
    saneados = sanearListadoMicrocreditos(filas)
    validas = cuentasValidasParaFilas()
    for microcredito in saneados:
        microcredito["id"] = microcredito["id"] or uuid.uuid4().hex
        microcredito["cuenta"] = normalizarCuentaDeFila(microcredito["cuenta"], validas)
    repetido = primerIdDuplicado(saneados)
    if repetido is not None:
        raise ValidationError(f"Id de microcrédito repetido: {repetido}", field="id")
    return saneados


@transactional
def guardarMicrocreditos(microcreditos: list[dict]) -> None:
    """Sustituye todos los microcréditos por `microcreditos` (ya saneados) en una transacción.

    Regenera en la misma transacción los pagos que cada microcrédito aporta a
    Mensualidades, para que nunca queden desfasados.
    """
    # Importación diferida: el módulo de sincronización lee este para listar.
    from stores.deudas_mensualidades import sincronizarTodo

    conn = getDb()
    conn.execute("DELETE FROM microcreditos")
    conn.executemany(
        "INSERT INTO microcreditos (id, nombre, modo, importe, importe_cent, comision, comision_cent, "
        "fecha_inicio, fecha_vencimiento, devuelto, fecha_devolucion, cuotas, tin, nota, cuenta, dia_cobro, "
        "categoria) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(m["id"], m["nombre"], m["modo"], *legadoYCentimos(m["importe"]), *legadoYCentimos(m["comision"]), m["fechaInicio"],
          m["fechaVencimiento"], int(m["devuelto"]), m["fechaDevolucion"], m["cuotas"],
          m["tin"], m["nota"], m["cuenta"], m["diaCobro"], m["categoria"]) for m in microcreditos],
    )
    sincronizarTodo(conn)
    conn.commit()
