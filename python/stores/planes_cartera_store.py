"""Planes de inversión de la cartera.

Un plan es un nombre y, debajo, los activos que se piensa comprar; cada activo
lleva las operaciones con las que se va a hacer. Las operaciones no viven aquí:
son filas de `operaciones` (Cripto > Operaciones y Finanzas > Operaciones) y el
plan solo guarda sus identificadores. Lo que está realizado y lo que no lo dice
el estado de cada operación, no una marca del plan.

Se lee y se escribe como un documento: cada plan sale con sus activos y cada
activo con su lista de operaciones, y el cliente devuelve la lista entera de
planes al guardar (crear, editar, archivar y borrar son la misma operación
para él). El reparto en tres tablas es solo para que borrar un activo de la
cartera se lleve por delante su línea en los planes (FK con ON DELETE CASCADE)
sin tener que reescribir ningún JSON.

`operacion_id` no lleva clave foránea: `operaciones` se reescribe entera en
cada guardado y un CASCADE vaciaría los planes. Los identificadores que ya no
existen se descartan al escribir, así que un plan nunca guarda una operación
borrada más allá del siguiente guardado.
"""

from core.db import get_db, transactional
from core.errors import ValidationError


def read_planes_cartera():
    conn = get_db()

    planes = [
        {
            "id": fila["id"],
            "nombre": fila["nombre"],
            "archivado": bool(fila["archivado"]),
            "activos": [],
        }
        for fila in conn.execute(
            "SELECT id, nombre, archivado FROM planes_cartera ORDER BY sort_order, rowid"
        )
    ]
    por_id = {plan["id"]: plan for plan in planes}

    activos_por_clave = {}
    for fila in conn.execute(
        "SELECT plan_id, asset_id FROM planes_cartera_activos ORDER BY sort_order, rowid"
    ):
        plan = por_id.get(fila["plan_id"])
        if plan is None:
            continue
        activo = {"assetId": fila["asset_id"], "operaciones": []}
        plan["activos"].append(activo)
        activos_por_clave[(fila["plan_id"], fila["asset_id"])] = activo

    for fila in conn.execute(
        "SELECT plan_id, asset_id, operacion_id FROM planes_cartera_operaciones "
        "ORDER BY sort_order, rowid"
    ):
        activo = activos_por_clave.get((fila["plan_id"], fila["asset_id"]))
        if activo is not None:
            activo["operaciones"].append(fila["operacion_id"])

    return {"rows": planes}


def _comprobar_activos(conn, planes):
    """Rechaza los planes que apunten a un activo que ya no existe.

    Sin esto el aviso lo daría la clave foránea, con un error del motor y un 500
    en la cara: pasa cuando se borra un activo desde otra pestaña y esta guarda
    después la lista que tenía cargada.
    """
    existentes = {fila["id"] for fila in conn.execute("SELECT id FROM activos")}
    huerfanos = sorted({
        activo["assetId"]
        for plan in planes
        for activo in plan.get("activos", [])
        if activo["assetId"] not in existentes
    })

    if huerfanos:
        raise ValidationError(
            f"Estos planes apuntan a un activo que ya no existe: {', '.join(huerfanos)}"
        )


@transactional
def write_planes_cartera(planes):
    """Reemplaza los planes por `planes`, en ese orden.

    Reescritura completa y no un UPDATE por fila porque el cliente maneja la
    lista entera. La transacción la abre `@transactional`: si algo falla a
    medias, las tablas se quedan como estaban en vez de vaciarse.
    """
    conn = get_db()
    _comprobar_activos(conn, planes)

    # Las operaciones que ya no existen se descartan aquí y no en la ruta,
    # porque es el único sitio que sabe qué hay en `operaciones` en el momento
    # exacto de escribir.
    operaciones_existentes = {fila["id"] for fila in conn.execute("SELECT id FROM operaciones")}

    conn.execute("DELETE FROM planes_cartera_operaciones")
    conn.execute("DELETE FROM planes_cartera_activos")
    conn.execute("DELETE FROM planes_cartera")

    for orden_plan, plan in enumerate(planes):
        conn.execute(
            "INSERT INTO planes_cartera (id, nombre, archivado, sort_order) VALUES (?, ?, ?, ?)",
            (plan["id"], plan.get("nombre", ""), 1 if plan.get("archivado") else 0, orden_plan),
        )

        vistos = set()
        for orden_activo, activo in enumerate(plan.get("activos", [])):
            asset_id = activo["assetId"]
            # Un activo repetido dentro del mismo plan no aporta nada y rompería
            # la clave primaria: se queda la primera aparición.
            if asset_id in vistos:
                continue
            vistos.add(asset_id)

            conn.execute(
                "INSERT INTO planes_cartera_activos (plan_id, asset_id, sort_order) VALUES (?, ?, ?)",
                (plan["id"], asset_id, orden_activo),
            )

            vinculadas = set()
            for orden_op, operacion_id in enumerate(activo.get("operaciones", [])):
                if operacion_id in vinculadas or operacion_id not in operaciones_existentes:
                    continue
                vinculadas.add(operacion_id)
                conn.execute(
                    "INSERT INTO planes_cartera_operaciones "
                    "(plan_id, asset_id, operacion_id, sort_order) VALUES (?, ?, ?, ?)",
                    (plan["id"], asset_id, operacion_id, orden_op),
                )

    conn.commit()
