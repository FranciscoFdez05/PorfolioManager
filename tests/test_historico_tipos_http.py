"""GET /api/portfolio/history/by-type: evolución del valor por tipo de activo.

Es el endpoint más caro de la aplicación (agrupa todas las filas de
asset_snapshots) y no estaba cubierto. Estas pruebas fijan lo que devuelve
antes de ponerle una caché, y sobre todo que la respuesta sigue los datos:
un snapshot nuevo, un activo que cambia de tipo, uno que se borra o una purga
tienen que verse en la siguiente petición, nunca un gráfico viejo.
"""

import time

import pytest

from core.db import getDb

DIA = 86400


@pytest.fixture
def cliente(clienteAutenticado, tempDb):
    from routes.snapshots import snapshotsBp

    client, _cabeceras, _app = clienteAutenticado(snapshotsBp)
    return client


def _activo(assetId, tipo):
    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, type) VALUES (?, ?, ?)", (assetId, assetId, tipo))
    conn.commit()


def _snapshot(ts, valores):
    conn = getDb()
    conn.executemany(
        "INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, ?, ?, ?)",
        [(ts, assetId, precio, coste) for assetId, (precio, coste) in valores.items()],
    )
    conn.commit()


def _serie(client, rango="ALL"):
    respuesta = client.get(f"/api/portfolio/history/by-type?range={rango}")
    assert respuesta.status_code == 200
    datos = respuesta.get_json()
    assert datos["ok"] is True and datos["range"] == rango
    return datos["data"]


@pytest.fixture
def cartera(cliente):
    _activo("apple", "acciones")
    _activo("msft", "acciones")
    _activo("btc", "cripto")
    _activo("sin-tipo", "")
    ahora = int(time.time())
    _snapshot(ahora - 60 * DIA, {"apple": (100.004, 90), "msft": (50, 40), "btc": (10, 5), "sin-tipo": (7, 7)})
    _snapshot(ahora - 2 * DIA, {"apple": (110, 90), "msft": (55.555, 40), "btc": (12, 5)})
    return cliente, ahora


def testSumaPorTipoConSuCosteYOrdenadoPorFecha(cartera):
    client, ahora = cartera

    serie = _serie(client)

    assert serie == [
        {"ts": ahora - 60 * DIA, "acciones": 150.0, "c_acciones": 130.0, "cripto": 10.0, "c_cripto": 5.0},
        {"ts": ahora - 2 * DIA, "acciones": 165.56, "c_acciones": 130.0, "cripto": 12.0, "c_cripto": 5.0},
    ]


def testElRangoDejaFueraLoAnterior(cartera):
    client, ahora = cartera

    assert [p["ts"] for p in _serie(client, "1M")] == [ahora - 2 * DIA]
    assert [p["ts"] for p in _serie(client, "1W")] == [ahora - 2 * DIA]
    assert _serie(client, "1D") == []


def testUnSnapshotNuevoSaleEnLaSiguientePeticion(cartera):
    client, ahora = cartera
    _serie(client)

    _snapshot(ahora - 60, {"apple": (120, 90), "btc": (13, 5)})

    ultimo = _serie(client)[-1]
    assert ultimo == {"ts": ahora - 60, "acciones": 120.0, "c_acciones": 90.0, "cripto": 13.0, "c_cripto": 5.0}
    assert _serie(client, "1D") == [ultimo]


def testCambiarElTipoDeUnActivoSeRefleja(cartera):
    client, _ahora = cartera
    _serie(client)

    conn = getDb()
    conn.execute("UPDATE activos SET type = 'etfs' WHERE id = 'msft'")
    conn.commit()

    primero = _serie(client)[0]
    assert primero["acciones"] == 100.0
    assert primero["etfs"] == 50.0


def testBorrarUnActivoLoSacaDeLaSerie(cartera):
    client, _ahora = cartera
    _serie(client)

    conn = getDb()
    conn.execute("DELETE FROM activos WHERE id = 'btc'")
    conn.commit()

    assert all("cripto" not in p for p in _serie(client))


def testUnaPurgaQuitaLosPuntosBorrados(cartera):
    client, ahora = cartera
    _serie(client)

    conn = getDb()
    conn.execute("DELETE FROM asset_snapshots WHERE ts < ?", (ahora - 30 * DIA,))
    conn.commit()

    assert [p["ts"] for p in _serie(client)] == [ahora - 2 * DIA]

    conn.execute("DELETE FROM asset_snapshots")
    conn.commit()
    assert _serie(client) == []


def testSinSnapshotsDevuelveUnaSerieVacia(cliente):
    assert _serie(cliente) == []
