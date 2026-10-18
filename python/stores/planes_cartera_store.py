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

from core.db import getDb, transactional
from core.errors import ValidationError


def readPlanesCartera():
    conn = getDb()

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
    porId = {plan["id"]: plan for plan in planes}

    activosPorClave = {}
    for fila in conn.execute(
        "SELECT plan_id, asset_id FROM planes_cartera_activos ORDER BY sort_order, rowid"
    ):
        plan = porId.get(fila["plan_id"])
        if plan is None:
            continue
        activo = {"assetId": fila["asset_id"], "operaciones": []}
        plan["activos"].append(activo)
        activosPorClave[(fila["plan_id"], fila["asset_id"])] = activo

    for fila in conn.execute(
        "SELECT plan_id, asset_id, operacion_id FROM planes_cartera_operaciones "
        "ORDER BY sort_order, rowid"
    ):
        activo = activosPorClave.get((fila["plan_id"], fila["asset_id"]))
        if activo is not None:
            activo["operaciones"].append(fila["operacion_id"])

    return {"rows": planes}


def _comprobarActivos(conn, planes):
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
def writePlanesCartera(planes):
    """Reemplaza los planes por `planes`, en ese orden.

    Reescritura completa y no un UPDATE por fila porque el cliente maneja la
    lista entera. La transacción la abre `@transactional`: si algo falla a
    medias, las tablas se quedan como estaban en vez de vaciarse.
    """
    conn = getDb()
    _comprobarActivos(conn, planes)

    # Las operaciones que ya no existen se descartan aquí y no en la ruta,
    # porque es el único sitio que sabe qué hay en `operaciones` en el momento
    # exacto de escribir.
    operacionesExistentes = {fila["id"] for fila in conn.execute("SELECT id FROM operaciones")}

    conn.execute("DELETE FROM planes_cartera_operaciones")
    conn.execute("DELETE FROM planes_cartera_activos")
    conn.execute("DELETE FROM planes_cartera")

    for ordenPlan, plan in enumerate(planes):
        conn.execute(
            "INSERT INTO planes_cartera (id, nombre, archivado, sort_order) VALUES (?, ?, ?, ?)",
            (plan["id"], plan.get("nombre", ""), 1 if plan.get("archivado") else 0, ordenPlan),
        )

        vistos = set()
        for ordenActivo, activo in enumerate(plan.get("activos", [])):
            assetId = activo["assetId"]
            # Un activo repetido dentro del mismo plan no aporta nada y rompería
            # la clave primaria: se queda la primera aparición.
            if assetId in vistos:
                continue
            vistos.add(assetId)

            conn.execute(
                "INSERT INTO planes_cartera_activos (plan_id, asset_id, sort_order) VALUES (?, ?, ?)",
                (plan["id"], assetId, ordenActivo),
            )

            vinculadas = set()
            for ordenOp, operacionId in enumerate(activo.get("operaciones", [])):
                if operacionId in vinculadas or operacionId not in operacionesExistentes:
                    continue
                vinculadas.add(operacionId)
                conn.execute(
                    "INSERT INTO planes_cartera_operaciones "
                    "(plan_id, asset_id, operacion_id, sort_order) VALUES (?, ?, ?, ?)",
                    (plan["id"], assetId, operacionId, ordenOp),
                )

    conn.commit()
