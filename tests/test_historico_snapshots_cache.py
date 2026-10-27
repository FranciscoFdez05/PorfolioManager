"""Caché de `history?range=ALL` y `rentabilidad`: idéntica a no tenerla y bien invalidada."""

import datetime
import shutil

import pytest

from core import db, rentabilidad
from stores import historico_snapshots

DIA = 86400
INICIO = int(datetime.datetime(2025, 1, 1, 12).timestamp())


@pytest.fixture
def cliente(clienteAutenticado, datosAislados, tempDb, monkeypatch):
    from routes.snapshots import snapshotsBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    historico_snapshots.invalidar()
    client, cabeceras, _app = clienteAutenticado(snapshotsBp)
    yield client, cabeceras
    historico_snapshots.invalidar()


def _sembrar(conn, n=40, desplazamiento=0.0):
    for i in range(n):
        flujo = 100.0 if i % 10 == 0 else None
        conn.execute(
            "INSERT INTO portfolio_snapshots (ts, total_value, total_invested, flujo) VALUES (?, ?, ?, ?)",
            (INICIO + i * DIA, 1000 + i * 7.5 + desplazamiento, 900 + (i // 10) * 100, flujo),
        )
    conn.commit()


def _historial(client):
    return client.get("/api/portfolio/history?range=ALL")


def _rentabilidad(client, query=""):
    return client.get(f"/api/portfolio/rentabilidad{query}").get_json()


def _historialSinCache(conn):
    """Lo que devolvía la ruta antes de la caché, calculado aparte."""
    from flask import jsonify

    filas = conn.execute(
        "SELECT ts, total_value, total_invested, flujo FROM portfolio_snapshots ORDER BY ts ASC"
    ).fetchall()
    datos = [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"], "f": r["flujo"]} for r in filas]
    return jsonify({"ok": True, "range": "ALL", "data": datos}).get_data()


def _resumenSinCache(conn):
    filas = conn.execute(
        "SELECT ts, total_value, total_invested, flujo FROM portfolio_snapshots ORDER BY ts ASC"
    ).fetchall()
    snaps = [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"], "f": r["flujo"]} for r in filas]
    return rentabilidad.resumen(snaps)


def testHistorialConCacheEsIdenticoAlCalculadoSinCache(cliente):
    client, _cabeceras = cliente
    conn = db.getDb()
    _sembrar(conn)

    primera = _historial(client)
    segunda = _historial(client)

    assert primera.get_data() == segunda.get_data()
    assert primera.get_data() == _historialSinCacheEnApp(conn)
    assert primera.mimetype == "application/json"


def testHistorialDeOtroRangoNoPasaPorLaCache(cliente):
    client, _cabeceras = cliente
    _sembrar(db.getDb(), n=5)

    datos = client.get("/api/portfolio/history?range=ALL").get_json()["data"]
    mes = client.get("/api/portfolio/history?range=1M").get_json()["data"]

    assert len(datos) == 5
    assert mes == []  # los puntos sembrados son de 2025


def testRentabilidadSinPuntoVivoCoincideConElCalculoDirecto(cliente):
    client, _cabeceras = cliente
    _sembrar(db.getDb())

    primera = _rentabilidad(client)
    segunda = _rentabilidad(client)
    esperado = _resumenSinCache(db.getDb())

    assert primera == segunda
    primera.pop("ok")
    assert primera == _jsonable(esperado)


def _jsonable(valor):
    import json

    return json.loads(json.dumps(valor))


def testRentabilidadConPuntoVivoNoSeCacheaYSigueLosParametros(cliente):
    client, _cabeceras = cliente
    _sembrar(db.getDb())

    base = _rentabilidad(client)
    vivo1 = _rentabilidad(client, "?value=5000&invested=1200")
    vivo2 = _rentabilidad(client, "?value=2000&invested=1200")
    despues = _rentabilidad(client)

    assert vivo1["twr"] != vivo2["twr"]
    assert vivo1 != base
    assert despues == base


def testUnSnapshotNuevoInvalidaAmbasCaches(cliente):
    client, _cabeceras = cliente
    conn = db.getDb()
    _sembrar(conn, n=20)
    antesH = _historial(client).get_json()["data"]
    antesR = _rentabilidad(client)

    conn.execute(
        "INSERT INTO portfolio_snapshots (ts, total_value, total_invested, flujo) VALUES (?, 5000, 1000, NULL)",
        (INICIO + 500 * DIA,),
    )
    conn.commit()

    despuesH = _historial(client).get_json()["data"]
    assert len(despuesH) == len(antesH) + 1
    assert _rentabilidad(client) != antesR
    assert _historial(client).get_data() == _historialSinCacheEnApp(conn)


def _historialSinCacheEnApp(conn):
    from flask import Flask

    with Flask(__name__).app_context():
        return _historialSinCache(conn)


def testCambiarElFlujoDeUnaFilaInvalida(cliente):
    client, _cabeceras = cliente
    conn = db.getDb()
    _sembrar(conn, n=20)
    antes = _historial(client).get_json()["data"]
    antesR = _rentabilidad(client)

    conn.execute("UPDATE portfolio_snapshots SET flujo = 777.0 WHERE ts = ?", (INICIO + 5 * DIA,))
    conn.commit()

    despues = _historial(client).get_json()["data"]
    assert despues != antes
    assert next(p for p in despues if p["ts"] == INICIO + 5 * DIA)["f"] == 777.0
    assert _rentabilidad(client) != antesR


def testBorrarSnapshotsInvalida(cliente):
    client, _cabeceras = cliente
    conn = db.getDb()
    _sembrar(conn, n=20)
    assert len(_historial(client).get_json()["data"]) == 20

    conn.execute("DELETE FROM portfolio_snapshots WHERE ts < ?", (INICIO + 10 * DIA,))
    conn.commit()

    assert len(_historial(client).get_json()["data"]) == 10


def testCambiarDePortfolioNoMezclaCaches(cliente, tmp_path):
    client, _cabeceras = cliente
    conn = db.getDb()
    _sembrar(conn, n=20)
    rutaA = db.getActiveDbPath()
    assert len(_historial(client).get_json()["data"]) == 20
    rentA = _rentabilidad(client)

    rutaB = tmp_path / "otro_portfolio.db"
    db.setActiveDbPath(rutaB)
    db.initDb()
    _sembrar(db.getDb(), n=7, desplazamiento=50.0)
    try:
        assert len(_historial(client).get_json()["data"]) == 7
        assert _rentabilidad(client) != rentA
    finally:
        db.setActiveDbPath(rutaA)
        db.invalidateAllConnections()

    assert len(_historial(client).get_json()["data"]) == 20
    assert _rentabilidad(client) == rentA


def testTrasUnRestoreSeVeElContenidoRestaurado(cliente, tmp_path):
    """Un restore sustituye el fichero y sube la generación de `core.db`."""
    client, _cabeceras = cliente
    ruta = db.getActiveDbPath()
    _sembrar(db.getDb(), n=20)
    antes = _historial(client).get_json()["data"]
    antesR = _rentabilidad(client)

    # Copia con las mismas 20 filas pero otros valores: ni el número de filas ni
    # el último ts cambian, así que solo la huella de valores lo delata.
    otra = tmp_path / "restaurada.db"
    db.setActiveDbPath(otra)
    db.initDb()
    _sembrar(db.getDb(), n=20, desplazamiento=333.0)
    db.resetDb()
    db.setActiveDbPath(ruta)
    db.invalidateAllConnections()
    shutil.copyfile(otra, ruta)
    db._invalidarEsteProceso()

    despues = _historial(client).get_json()["data"]
    assert despues != antes
    assert despues[0]["v"] == antes[0]["v"] + 333.0
    assert _rentabilidad(client) != antesR


def testTablaVaciaDevuelveListaVaciaYRentabilidadVacia(cliente):
    client, _cabeceras = cliente

    assert _historial(client).get_json()["data"] == []
    esperado = _jsonable(rentabilidad.resumen([]))
    resultado = _rentabilidad(client)
    resultado.pop("ok")
    assert resultado == esperado
