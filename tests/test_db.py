"""Esquema, transacciones y aislamiento de la capa de base de datos."""

import sqlite3

import pytest

from core import db


def testElEsquemaSeCreaCompleto(tempDb):
    conn = db.getDb()
    tablas = {
        row["name"]
        for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    esperadas = {
        "activos", "activo_rows", "operaciones", "gastos_rows", "mensualidades",
        "ingresos_rows", "ingresos_recurrentes", "ventas", "dividendos",
        "portfolio_snapshots", "asset_snapshots", "settings", "trading",
    }
    assert esperadas <= tablas


def testMigracionesSonIdempotentes(tempDb):
    # initDb() dos veces sobre la misma BD no debe fallar por ALTER duplicado.
    db.invalidateAllConnections()
    db.initDb()
    db.invalidateAllConnections()
    db.initDb()
    cols = {row[1] for row in db.getDb().execute("PRAGMA table_info(activos)")}
    assert {"color", "tv_symbol", "hidden"} <= cols


def testForeignKeysActivas(tempDb):
    conn = db.getDb()
    assert conn.execute("PRAGMA foreign_keys").fetchone()[0] == 1

    with pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            "INSERT INTO activo_rows (asset_id, fecha_operacion) VALUES ('inexistente', '2026-01-01')"
        )
        conn.commit()
    conn.rollback()


def testBorradoEnCascada(tempDb):
    conn = db.getDb()
    conn.execute("INSERT INTO activos (id, name) VALUES ('btc', 'Bitcoin')")
    conn.execute("INSERT INTO activo_rows (asset_id, fecha_operacion) VALUES ('btc', '2026-01-01')")
    conn.commit()

    conn.execute("DELETE FROM activos WHERE id = 'btc'")
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM activo_rows").fetchone()[0] == 0


def testTransactionConfirmaAlSalir(tempDb):
    with db.transaction() as conn:
        conn.execute("INSERT INTO activos (id, name) VALUES ('eth', 'Ethereum')")

    assert db.getDb().execute(
        "SELECT name FROM activos WHERE id = 'eth'"
    ).fetchone()["name"] == "Ethereum"


def testTransactionRevierteAnteExcepcion(tempDb):
    with pytest.raises(RuntimeError), db.transaction() as conn:
        conn.execute("INSERT INTO activos (id, name) VALUES ('sol', 'Solana')")
        raise RuntimeError("fallo a mitad")

    assert db.getDb().execute("SELECT COUNT(*) FROM activos WHERE id = 'sol'").fetchone()[0] == 0


def testTransaccionHuerfanaSeRevierteEnElSiguienteGetDb(tempDb):
    # Escenario real: una escritura falló dejando su transacción abierta con
    # DELETEs ya aplicados. El siguiente commit de otra operación la confirmaba
    # y los datos desaparecían en silencio.
    conn = db.getDb()
    conn.execute("INSERT INTO activos (id, name) VALUES ('ada', 'Cardano')")
    conn.commit()

    conn.execute("DELETE FROM activos WHERE id = 'ada'")  # transacción abierta
    assert conn.in_transaction

    conn = db.getDb()  # red de seguridad: rollback preventivo
    assert not conn.in_transaction
    assert conn.execute("SELECT COUNT(*) FROM activos WHERE id = 'ada'").fetchone()[0] == 1


def testTransactionalRevierteLaEscrituraFallida(tempDb):
    @db.transactional
    def escrituraRota():
        conn = db.getDb()
        conn.execute("INSERT INTO activos (id, name) VALUES ('dot', 'Polkadot')")
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError):
        escrituraRota()

    assert db.getDb().execute("SELECT COUNT(*) FROM activos WHERE id = 'dot'").fetchone()[0] == 0


def testCambiarDeBdNoMezclaDatos(tempDb, tmp_path):
    # Ojo: hay que confirmar dentro de la misma transacción. Un
    # `getDb().execute(...)` seguido de `getDb().commit()` pierde el INSERT,
    # porque la segunda llamada detecta la transacción abierta y la revierte.
    with db.transaction() as conn:
        conn.execute("INSERT INTO activos (id, name) VALUES ('btc', 'Bitcoin')")

    otra = tmp_path / "otro_portfolio.db"
    db.setActiveDbPath(otra)
    db.initDb()
    assert db.getDb().execute("SELECT COUNT(*) FROM activos").fetchone()[0] == 0

    db.setActiveDbPath(tempDb)
    assert db.getDb().execute("SELECT COUNT(*) FROM activos").fetchone()[0] == 1


def testInitDbAtPathNoCambiaLaBdActiva(tempDb, tmp_path):
    nueva = tmp_path / "nueva.db"
    db.initDbAtPath(nueva)

    assert nueva.exists()
    assert db.getActiveDbPath() == tempDb


# ── Versión del esquema (PRAGMA user_version) ────────────────────────────────

def testUnaBdNuevaQuedaMarcadaConLaVersionActual(tempDb):
    from core import db

    assert db.getDb().execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION


def testUnaBdYaAlDiaNoVuelveAMigrar(tempDb, monkeypatch):
    """El motivo de tener contador: saltarse la introspección en cada apertura.

    Antes, cada `getDb()` sobre una base ya migrada ejecutaba igualmente todos
    los `PRAGMA table_info` y `CREATE TABLE IF NOT EXISTS` del paso completo.
    """
    from core import db

    conexion = db.getDb()
    ejecutados = []
    monkeypatch.setattr(db, "_MIGRACIONES", [(1, lambda conn: ejecutados.append(1))])

    db._migrate(conexion)

    assert ejecutados == [], "se volvió a migrar una base que ya estaba al día"


def testUnaBdEnLaVersion0SeMigraYSeMarca(tempDb):
    """El caso de todas las bases existentes la primera vez que ven este código."""
    from core import db

    conexion = db.getDb()
    conexion.execute("PRAGMA user_version = 0")

    db._migrate(conexion)

    assert conexion.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION


def testLosPasosSeAplicanEnOrdenYSoloLosPendientes(tempDb, monkeypatch):
    from core import db

    aplicados = []
    monkeypatch.setattr(db, "_MIGRACIONES", [
        (3, lambda conn: aplicados.append(3)),
        (1, lambda conn: aplicados.append(1)),
        (2, lambda conn: aplicados.append(2)),
    ])
    monkeypatch.setattr(db, "ESQUEMA_VERSION", 3)

    conexion = db.getDb()
    conexion.execute("PRAGMA user_version = 1")
    db._migrate(conexion)

    assert aplicados == [2, 3], "se reaplicó un paso ya hecho o se aplicaron desordenados"
    assert conexion.execute("PRAGMA user_version").fetchone()[0] == 3


def testUnaBdDelFuturoSeAbreSinTocarlaYAvisa(tempDb, monkeypatch, caplog):
    """Restaurar aquí un backup hecho con una versión posterior.

    Un ALTER TABLE a ciegas sobre un esquema desconocido es peor que no hacer
    nada; lo que no puede pasar es que ocurra en silencio.
    """
    import logging

    from core import db

    tocados = []
    monkeypatch.setattr(db, "_MIGRACIONES", [(1, lambda conn: tocados.append(1))])

    conexion = db.getDb()
    conexion.execute(f"PRAGMA user_version = {db.ESQUEMA_VERSION + 5}")

    with caplog.at_level(logging.WARNING):
        db._migrate(conexion)

    assert tocados == []
    assert conexion.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION + 5
    assert "esquema" in caplog.text.lower()


def testUnaBdSinDiasCobroGanaLaColumnaAlMigrar(tempDb):
    """El paso 4, sobre una base con la tabla de mensualidades como estaba.

    Se recrea la tabla sin `dias_cobro` porque `_SCHEMA` ya la crea con ella:
    sin esto la prueba pasaría sin haber migrado nada.
    """
    from core import db

    conexion = db.getDb()
    conexion.execute("DROP TABLE mensualidades")
    conexion.execute("""
        CREATE TABLE mensualidades (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            year       TEXT NOT NULL,
            nombre     TEXT NOT NULL,
            dia_cobro  TEXT NOT NULL DEFAULT '',
            UNIQUE(year, nombre)
        )
    """)
    conexion.execute("INSERT INTO mensualidades (year, nombre, dia_cobro) VALUES ('2026', 'Luz', '5')")

    db._esquema4(conexion)

    fila = conexion.execute("SELECT dia_cobro, dias_cobro FROM mensualidades").fetchone()
    assert fila["dia_cobro"] == "5", "la migración no debe tocar el día que ya había"
    assert fila["dias_cobro"] == ""

    # Idempotente: una base en la versión 0 puede tener ya parte aplicada.
    db._esquema4(conexion)
    assert conexion.execute("SELECT COUNT(*) FROM mensualidades").fetchone()[0] == 1


def testLaTablaDePlanesDcaSeBorraAlMigrar(tempDb):
    """El paso 5, sobre una base que todavía tiene la tabla del DCA retirado.

    Se recrea porque `_SCHEMA` ya no la crea: sin esto la prueba pasaría sin
    haber migrado nada. Los pasos 2 y 3 sí la siguen creando, que es el caso real
    de una base antigua.
    """
    from core import db

    conexion = db.getDb()
    conexion.execute("CREATE TABLE dca_planes (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL)")
    conexion.execute("INSERT INTO dca_planes (id, asset_id) VALUES ('dca-1', 'bitcoin')")

    db._esquema5(conexion)

    tablas = {f[0] for f in conexion.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "dca_planes" not in tablas

    # Idempotente: una base que ya no la tiene pasa por aquí sin quejarse.
    db._esquema5(conexion)


def testLaNotaSeAnadeAGastosEIngresosSinTocarLasFilas(tempDb):
    """El paso 6, sobre una base cuyas filas de gastos e ingresos no tenían nota."""
    from core import db

    conexion = db.getDb()
    for tabla in ("gastos_rows", "ingresos_rows"):
        conexion.execute(f"DROP TABLE {tabla}")
        conexion.execute(f"""
            CREATE TABLE {tabla} (
                id       INTEGER PRIMARY KEY AUTOINCREMENT,
                year     TEXT NOT NULL,
                month    TEXT NOT NULL,
                fecha    TEXT NOT NULL DEFAULT '',
                nombre   TEXT NOT NULL DEFAULT '',
                tipo     TEXT NOT NULL DEFAULT '',
                cantidad TEXT NOT NULL DEFAULT ''
            )
        """)
        conexion.execute(
            f"INSERT INTO {tabla} (year, month, fecha, nombre, tipo, cantidad) "
            "VALUES ('2026', 'enero', '03-01-2026', 'Cobuco', 'Gasoil', '20,00 €')"
        )

    db._esquema6(conexion)

    for tabla in ("gastos_rows", "ingresos_rows"):
        fila = conexion.execute(f"SELECT nombre, cantidad, nota FROM {tabla}").fetchone()
        assert fila["nombre"] == "Cobuco" and fila["cantidad"] == "20,00 €"
        assert fila["nota"] == "", "la fila antigua queda con la nota en blanco"

    # Idempotente: una base en la versión 0 puede tener ya la columna.
    db._esquema6(conexion)
    assert conexion.execute("SELECT COUNT(*) FROM gastos_rows").fetchone()[0] == 1


def testUnaBdAlDiaNoTieneLaTablaDelDca(tempDb):
    """Una base nueva no llega a tenerla: el paso 2 la crea y el 5 la borra."""
    from core import db

    tablas = {f[0] for f in db.getDb().execute("SELECT name FROM sqlite_master WHERE type = 'table'")}

    assert "dca_planes" not in tablas
    assert "planes_inversion" in tablas, "los planes de inversión sí se quedan"


def testElNumeroDeVersionCubreTodosLosPasosRegistrados():
    """Subir un paso y olvidar ESQUEMA_VERSION dejaría la migración sin aplicarse."""
    from core import db

    assert max(numero for numero, _ in db._MIGRACIONES) == db.ESQUEMA_VERSION


def testElPasoBaseEsIdempotente(tempDb):
    """Se ejecuta dos veces seguidas sobre la misma base sin error ni duplicados."""
    from core import db

    conexion = db.getDb()
    db._esquema1(conexion)
    db._esquema1(conexion)

    columnas = {fila[1] for fila in conexion.execute("PRAGMA table_info(activos)")}
    assert "color" in columnas and "tv_symbol" in columnas
    assert "precio_currency" not in columnas


def testUnaBdYaEnLa18RecibeLasColumnasDeCuentaQueLeFaltan(tempDb):
    """Una base que arrancó con el paso 18 original no tenía `ingresos_recurrentes.cuenta`
    ni `mensualidades.cuentas_cobro`: ampliar un paso ya aplicado no las habría creado."""
    from core import db

    conexion = db.getDb()
    conexion.execute("ALTER TABLE ingresos_recurrentes DROP COLUMN cuenta")
    conexion.execute("ALTER TABLE mensualidades DROP COLUMN cuentas_cobro")
    conexion.execute("PRAGMA user_version = 18")

    db._migrate(conexion)

    assert conexion.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    for tabla, columna in (("ingresos_recurrentes", "cuenta"), ("mensualidades", "cuentas_cobro")):
        assert columna in {f[1] for f in conexion.execute(f"PRAGMA table_info({tabla})")}


def testUnaBdYaEnLa19RecibeLaCuentaPorMesDeLosIngresosRecurrentes(tempDb):
    from core import db

    conexion = db.getDb()
    conexion.execute("ALTER TABLE ingresos_recurrentes DROP COLUMN cuentas_cobro")
    conexion.execute("PRAGMA user_version = 19")

    db._migrate(conexion)

    assert conexion.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    assert "cuentas_cobro" in {f[1] for f in conexion.execute("PRAGMA table_info(ingresos_recurrentes)")}
