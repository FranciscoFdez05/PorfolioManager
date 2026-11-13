"""`_leerSnapshotsDesde` debe dar lo mismo que el GROUP BY original.

La consulta se reescribió por rendimiento (búsquedas por índice en lugar de
agrupar por `ts / cubeta`): aquí se compara contra la consulta antigua con
datos que cubren los casos límite (cubeta partida por el inicio de la ventana,
snapshots sin precio, varios activos, huecos, tabla vacía).
"""

import random
import sqlite3

import pytest

from stores import grafico_activo

CONSULTA_ORIGINAL = (
    "SELECT asset_id, MAX(ts) AS ts, price_eur, cost_eur FROM asset_snapshots "
    "WHERE ts >= ? AND ts < ? AND price_eur > 0 GROUP BY asset_id, ts / ? ORDER BY asset_id, ts"
)


@pytest.fixture
def conexion():
    conn = sqlite3.connect(":memory:")
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        CREATE TABLE asset_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts INTEGER NOT NULL,
            asset_id TEXT NOT NULL,
            price_eur REAL NOT NULL DEFAULT 0,
            cost_eur REAL
        );
        CREATE INDEX idx_asset_snapshots_ts ON asset_snapshots(ts);
        CREATE INDEX idx_asset_snapshots_asset_id_ts ON asset_snapshots(asset_id, ts);
        """
    )
    yield conn
    conn.close()


def rellenar(conn, semilla=7):
    azar = random.Random(semilla)
    for assetId, paso in (("a", 60), ("b", 300), ("c", 7200)):
        for ts in range(1_000_000, 1_000_000 + 40 * 86400, paso):
            # Un 10 % sin precio (se descartan) y un hueco largo en mitad de la serie.
            if 1_000_000 + 10 * 86400 < ts < 1_000_000 + 13 * 86400:
                continue
            precio = 0 if azar.random() < 0.1 else round(azar.uniform(1, 500), 4)
            conn.execute(
                "INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, ?, ?, ?)",
                (ts, assetId, precio, round(azar.uniform(1, 500), 4)),
            )
    conn.commit()


def comoTuplas(filas):
    return [tuple(fila) for fila in filas]


@pytest.mark.parametrize("desde, hasta, cubeta", [
    (1_000_000, 1_000_000 + 40 * 86400, 86400),
    (1_000_000 + 5 * 86400 + 777, 1_000_000 + 30 * 86400 + 5, 86400),
    (1_000_000 + 20 * 86400 + 123, 1_000_000 + 21 * 86400, 600),
    (1_000_000 + 2 * 86400 + 1, 1_000_000 + 9 * 86400 + 1, 1800),
    (1_000_000, 1_000_000 + 40 * 86400, 14400),
])
def testDaLoMismoQueElGroupByOriginal(conexion, desde, hasta, cubeta):
    rellenar(conexion)

    esperado = conexion.execute(CONSULTA_ORIGINAL, (desde, hasta, cubeta)).fetchall()
    obtenido = grafico_activo._leerSnapshotsDesde(conexion, desde, hasta, cubeta)

    assert esperado
    plano = [tuple(fila) for filas in obtenido.values() for fila in filas]
    assert plano == comoTuplas(esperado)
    assert list(obtenido) == sorted(obtenido)


def testNoDevuelveFilasFueraDeLaVentanaNiSinPrecio(conexion):
    rellenar(conexion)
    desde, hasta = 1_000_000 + 3 * 86400 + 10, 1_000_000 + 8 * 86400

    obtenido = grafico_activo._leerSnapshotsDesde(conexion, desde, hasta, 86400)

    for filas in obtenido.values():
        for fila in filas:
            assert desde <= fila["ts"] < hasta
            assert fila["price_eur"] > 0


def testElLimiteSuperiorEsExcluyente(conexion):
    conexion.execute("INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (100, 'a', 5, 5)")
    conexion.execute("INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (200, 'a', 6, 6)")

    obtenido = grafico_activo._leerSnapshotsDesde(conexion, 100, 200, 600)

    assert [fila["ts"] for fila in obtenido["a"]] == [100]


def testTablaVaciaODeUnSoloActivoSinFilasEnLaVentana(conexion):
    assert grafico_activo._leerSnapshotsDesde(conexion, 0, 10_000, 600) == {}

    conexion.execute("INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (50000, 'a', 5, 5)")
    assert grafico_activo._leerSnapshotsDesde(conexion, 0, 10_000, 600) == {}


def testAceptaLimitesFlotantes(conexion):
    rellenar(conexion)
    desde, hasta, cubeta = 1_000_000 + 86400, 1_000_000 + 9 * 86400, 86400

    esperado = conexion.execute(CONSULTA_ORIGINAL, (desde, hasta, cubeta)).fetchall()
    obtenido = grafico_activo._leerSnapshotsDesde(conexion, float(desde), float(hasta), cubeta)

    assert [tuple(f) for filas in obtenido.values() for f in filas] == comoTuplas(esperado)
