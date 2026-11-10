"""Pagas extra de los ingresos recurrentes: limpieza, guardado y migración."""

from stores.ingresos_store import normalizePagasExtra, serializePagasExtra


def testUnaPagaSinNombreSeLlamaExtra():
    pagas = normalizePagasExtra([{"mes": "junio", "importe": "1.000,00 €"}])

    assert pagas == [{"nombre": "Extra", "mes": "junio", "importe": "1.000,00 €"}]


def testSeDescartanLasPagasSinMesValidoOSinImporte():
    pagas = normalizePagasExtra([
        {"nombre": "Verano", "mes": "Junio", "importe": "500"},
        {"nombre": "Mes inventado", "mes": "junember", "importe": "500"},
        {"nombre": "Sin importe", "mes": "diciembre", "importe": "  "},
        "no es un objeto",
    ])

    assert pagas == [{"nombre": "Verano", "mes": "junio", "importe": "500"}]


def testUnJsonRotoOUnTipoInesperadoDanListaVacia():
    assert normalizePagasExtra("{no es json") == []
    assert normalizePagasExtra("") == []
    assert normalizePagasExtra({"mes": "junio"}) == []
    assert normalizePagasExtra(None) == []


def testSinPagasSeGuardaTextoVacio():
    assert serializePagasExtra([]) == ""
    assert serializePagasExtra([{"mes": "nada", "importe": "1"}]) == ""


def testElNumeroDePagasEstaAcotado():
    pagas = normalizePagasExtra([{"mes": "junio", "importe": "1"}] * 100)

    assert len(pagas) == 24


def testLasPagasExtraSeGuardanYSeLeen(tempDb):
    from stores.ingresos_store import readIngresosYear, sanitizeIngresosPayload, writeIngresosYear

    payload, error = sanitizeIngresosPayload({"year": "2026", "recurrentes": [
        {
            "nombre": "Trabajo",
            "importe": "1.500,00 €",
            "pagasExtra": [{"nombre": "Extra verano", "mes": "junio", "importe": "1.000,00 €"}],
            "meses": {"enero": "1.500,00 €", "junio": "2.500,00 €"},
        },
        {"nombre": "Alquiler", "meses": {"enero": "600,00 €"}},
    ]})
    assert error is None
    writeIngresosYear("2026", payload)

    leidas = {r["nombre"]: r for r in readIngresosYear("2026")["recurrentes"]}
    assert leidas["Trabajo"]["pagasExtra"] == [
        {"nombre": "Extra verano", "mes": "junio", "importe": "1.000,00 €"}
    ]
    assert leidas["Trabajo"]["meses"]["junio"] == "2.500,00 €"
    assert leidas["Alquiler"]["pagasExtra"] == []


def testLaMigracion31AnadeLaColumnaSinTocarLoQueHabia(tempDb):
    """Se recrea la tabla sin `pagas_extra` porque `_SCHEMA` ya la crea con ella:
    sin esto la prueba pasaría sin haber migrado nada."""
    from core import db

    conexion = db.getDb()
    conexion.execute("DROP TABLE ingresos_recurrentes")
    conexion.execute("""
        CREATE TABLE ingresos_recurrentes (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            year    TEXT NOT NULL,
            nombre  TEXT NOT NULL,
            enero   TEXT NOT NULL DEFAULT '',
            UNIQUE(year, nombre)
        )
    """)
    conexion.execute("INSERT INTO ingresos_recurrentes (year, nombre, enero) VALUES ('2026', 'Nómina', '1.000,00')")

    db._esquema31(conexion)

    fila = conexion.execute("SELECT enero, pagas_extra FROM ingresos_recurrentes").fetchone()
    assert fila["enero"] == "1.000,00"
    assert fila["pagas_extra"] == ""

    # Idempotente: volver a aplicarlo no falla por columna duplicada.
    db._esquema31(conexion)
    assert conexion.execute("SELECT COUNT(*) FROM ingresos_recurrentes").fetchone()[0] == 1
