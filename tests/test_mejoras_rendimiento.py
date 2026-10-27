"""Pruebas de las mejoras de rendimiento P-01, P-03, P-04, P-05 y P-07.

Cada una cambia cuánto trabajo se hace, no lo que se responde, así que aquí se
fija las dos cosas: que el trabajo ahorrado se ahorra de verdad (llamadas
contadas) y que el resultado sigue los datos cuando estos cambian.
"""

import time
from decimal import Decimal
from types import SimpleNamespace

import pytest

from core.db import getDb

DIA = 86400


# ── P-01: memo del tipo de cambio por petición ───────────────────────────────

def testElMemoResuelveCadaParUnaSolaVez(monkeypatch):
    from stores import fx_historico

    llamadas = []

    def falso(desde, hacia):
        llamadas.append((desde, hacia))
        return Decimal("1.1")

    monkeypatch.setattr(fx_historico, "tipoActualEntre", falso)
    tipo = fx_historico.tipoActualConMemo()

    assert [tipo("USD", "EUR") for _ in range(5)] == [Decimal("1.1")] * 5
    assert tipo("EUR", "USD") == Decimal("1.1")
    assert llamadas == [("USD", "EUR"), ("EUR", "USD")]


def testElMemoGuardaTambienLosDesconocidos(monkeypatch):
    from stores import fx_historico

    llamadas = []
    monkeypatch.setattr(fx_historico, "tipoActualEntre", lambda d, h: llamadas.append((d, h)))
    tipo = fx_historico.tipoActualConMemo()

    assert tipo("XXX", "EUR") is None
    assert tipo("XXX", "EUR") is None
    assert len(llamadas) == 1


def testCadaMemoEsIndependienteDeLosDemas(monkeypatch):
    """Sin caché entre peticiones: un tipo nuevo se ve en la siguiente."""
    from stores import fx_historico

    valores = iter([Decimal("1.1"), Decimal("1.2")])
    monkeypatch.setattr(fx_historico, "tipoActualEntre", lambda d, h: next(valores))

    assert fx_historico.tipoActualConMemo()("USD", "EUR") == Decimal("1.1")
    assert fx_historico.tipoActualConMemo()("USD", "EUR") == Decimal("1.2")


# ── P-03: el hueco ocupado se detecta antes de valorar ───────────────────────

def testTramoOcupadoSegunElUltimoSnapshot(tempDb, monkeypatch):
    from routes import snapshots

    monkeypatch.setattr(snapshots, "_intervalSeconds", lambda: 3600)
    assert snapshots.tramoOcupado(10 * 3600 + 5) is False

    conn = getDb()
    conn.execute("INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, 1, 1)",
                 (10 * 3600 + 5,))
    conn.commit()

    assert snapshots.tramoOcupado(10 * 3600 + 3000) is True
    assert snapshots.tramoOcupado(11 * 3600) is False


def testConElHuecoOcupadoNoSeValoraLaCartera(clienteAutenticado, tempDb, monkeypatch):
    from routes import snapshots
    from routes.snapshots import snapshotsBp
    from stores import valoracion

    monkeypatch.setattr(snapshots, "_intervalSeconds", lambda: 3600)
    client, cabeceras, _app = clienteAutenticado(snapshotsBp)
    conn = getDb()
    conn.execute("INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, 1, 1)",
                 (int(time.time()),))
    conn.commit()

    def noDebeLlamarse(**_kwargs):
        raise AssertionError("se valoró la cartera con el hueco ocupado")

    monkeypatch.setattr(valoracion, "valorarPortfolio", noDebeLlamarse)

    respuesta = client.post("/api/portfolio/snapshot", json={"total_value": 120, "total_invested": 100},
                            headers=cabeceras)

    assert respuesta.get_json() == {"ok": True, "skipped": True, "motivo": "tramo_ocupado"}
    assert getDb().execute("SELECT COUNT(*) FROM portfolio_snapshots").fetchone()[0] == 1


def testGuardarSnapshotSigueComprobandoElHuecoDentroDeLaTransaccion(tempDb, monkeypatch):
    """La lectura previa no sustituye a la definitiva (carrera entre workers)."""
    from routes import snapshots

    monkeypatch.setattr(snapshots, "_intervalSeconds", lambda: 3600)
    assert snapshots.guardarSnapshot(100, 90, nowTs=7200) is True
    assert snapshots.guardarSnapshot(101, 90, nowTs=7300) is False


# ── P-04: cuerpo serializado de by-type ──────────────────────────────────────

@pytest.fixture
def clienteTipos(clienteAutenticado, tempDb):
    from routes.snapshots import snapshotsBp
    from stores import historico_tipos

    historico_tipos.invalidar()
    client, _cabeceras, _app = clienteAutenticado(snapshotsBp)
    conn = getDb()
    conn.execute("INSERT INTO activos (id, name, type) VALUES ('a', 'a', 'acciones')")
    conn.commit()
    return client


def _snapshotTipo(ts, precio):
    conn = getDb()
    conn.execute("INSERT INTO asset_snapshots (ts, asset_id, price_eur, cost_eur) VALUES (?, 'a', ?, 1)",
                 (ts, precio))
    conn.commit()


def testElCuerpoSerializadoSeConstruyeUnaVezPorRango(clienteTipos):
    from stores import historico_tipos

    ahora = int(time.time())
    _snapshotTipo(ahora - DIA, 10)
    llamadas = []
    original = historico_tipos.cuerpoPorTipo

    def espia(rangeParam, desdeTs, construir):
        def contando(data):
            llamadas.append(rangeParam)
            return construir(data)
        return original(rangeParam, desdeTs, contando)

    import routes.snapshots as rutas
    rutas.historico_tipos = type("M", (), {"cuerpoPorTipo": staticmethod(espia)})
    try:
        primera = clienteTipos.get("/api/portfolio/history/by-type?range=ALL")
        segunda = clienteTipos.get("/api/portfolio/history/by-type?range=ALL")
        otro = clienteTipos.get("/api/portfolio/history/by-type?range=1M")
    finally:
        rutas.historico_tipos = historico_tipos

    assert primera.get_data() == segunda.get_data()
    assert primera.mimetype == "application/json"
    assert otro.get_json()["range"] == "1M"
    assert llamadas == ["ALL", "1M"]


def testElCuerpoGuardadoEsIdenticoAlQueDabaLaRespuestaSinCache(clienteTipos):
    from flask import jsonify

    from stores import historico_tipos

    ahora = int(time.time())
    _snapshotTipo(ahora - 3 * DIA, 10.456)
    _snapshotTipo(ahora - DIA, 20)

    for rango in ("ALL", "1W"):
        respuesta = clienteTipos.get(f"/api/portfolio/history/by-type?range={rango}")
        desde = None if rango == "ALL" else ahora - 7 * DIA
        with clienteTipos.application.app_context():
            esperado = jsonify({"ok": True, "range": rango,
                                "data": historico_tipos.seriePorTipo(desde)}).get_data()
        assert respuesta.get_data() == esperado


def testUnSnapshotNuevoInvalidaElCuerpoGuardado(clienteTipos):
    ahora = int(time.time())
    _snapshotTipo(ahora - 2 * DIA, 10)
    antes = clienteTipos.get("/api/portfolio/history/by-type?range=ALL").get_json()["data"]
    assert len(antes) == 1

    _snapshotTipo(ahora - DIA, 20)
    despues = clienteTipos.get("/api/portfolio/history/by-type?range=ALL").get_json()["data"]

    assert [p["acciones"] for p in despues] == [10.0, 20.0]


def testCambiarElTipoInvalidaElCuerpoGuardado(clienteTipos):
    _snapshotTipo(int(time.time()) - DIA, 10)
    assert "acciones" in clienteTipos.get("/api/portfolio/history/by-type?range=ALL").get_json()["data"][0]

    conn = getDb()
    conn.execute("UPDATE activos SET type = 'cripto' WHERE id = 'a'")
    conn.commit()
    punto = clienteTipos.get("/api/portfolio/history/by-type?range=ALL").get_json()["data"][0]

    assert "cripto" in punto and "acciones" not in punto


def testUnRangoRelativoNoSirveUnCuerpoConPuntosFueraDeVentana(clienteTipos, monkeypatch):
    """El inicio de 1D se desliza: con la misma tabla, otro instante da otro cuerpo."""
    from routes import snapshots

    base = 1_000_000_000
    _snapshotTipo(base, 10)
    _snapshotTipo(base + DIA - 100, 20)

    monkeypatch.setattr(snapshots, "time", SimpleNamespace(time=lambda: base + 100))
    primero = clienteTipos.get("/api/portfolio/history/by-type?range=1D").get_json()["data"]
    monkeypatch.setattr(snapshots, "time", SimpleNamespace(time=lambda: base + DIA + 100))
    segundo = clienteTipos.get("/api/portfolio/history/by-type?range=1D").get_json()["data"]

    assert [p["ts"] for p in primero] == [base, base + DIA - 100]
    assert [p["ts"] for p in segundo] == [base + DIA - 100]


def testElNumeroDeCuerposGuardadosTieneTope(clienteTipos):
    from stores import historico_tipos

    _snapshotTipo(int(time.time()) - DIA, 10)
    for i in range(historico_tipos._MAX_CUERPOS + 10):
        assert clienteTipos.get(f"/api/portfolio/history/by-type?range=raro{i}").status_code == 200

    estado = historico_tipos._agregado(getDb())
    assert len(estado["cuerpos"]) <= historico_tipos._MAX_CUERPOS


# ── P-05: _decimal con caché ─────────────────────────────────────────────────

def testDecimalDevuelveLoMismoConCacheYSinElla():
    from core.dinero import aDecimalONulo
    from stores import cuentas_store

    cuentas_store._decimal.cache_clear()
    for texto in ("1.234,56 €", "9,99", "", None, "basura", "-0,5"):
        esperado = aDecimalONulo(texto) or Decimal(0)
        assert cuentas_store._decimal(texto) == esperado
        assert cuentas_store._decimal(texto) == esperado
    assert cuentas_store._decimal.cache_info().hits >= 6


def testDecimalAcotaLaCache():
    from stores import cuentas_store

    assert cuentas_store._decimal.cache_info().maxsize == 8192


# ── P-07: quick_check de /api/health con TTL ─────────────────────────────────

@pytest.fixture
def contadorQuickCheck(tempDb, monkeypatch):
    """Cuenta cuántas veces se ejecuta PRAGMA quick_check de verdad."""
    from routes import salud

    salud._quickCheckVigente = None
    ejecuciones = []

    class ConexionEspia:
        def __init__(self, real):
            self._real = real

        def execute(self, sql, *args):
            if "quick_check" in sql:
                ejecuciones.append(sql)
            return self._real.execute(sql, *args)

    realGetDb = salud.db.getDb
    monkeypatch.setattr(salud.db, "getDb", lambda: ConexionEspia(realGetDb()))
    yield ejecuciones
    salud._quickCheckVigente = None


def testElQuickCheckSeReutilizaDentroDelTtl(clienteAutenticado, contadorQuickCheck, monkeypatch):
    from core import settings
    from routes.salud import saludBp

    monkeypatch.setattr(settings, "healthQuickCheckTtlSegundos", lambda: 30)
    client, _, _ = clienteAutenticado(saludBp)

    for _ in range(4):
        assert client.get("/api/health").status_code == 200

    assert len(contadorQuickCheck) == 1


def testElQuickCheckSeRepiteTrasCaducarElTtl(clienteAutenticado, contadorQuickCheck, monkeypatch):
    from core import settings
    from routes import salud
    from routes.salud import saludBp

    monkeypatch.setattr(settings, "healthQuickCheckTtlSegundos", lambda: 30)
    client, _, _ = clienteAutenticado(saludBp)
    ahora = time.monotonic()

    monkeypatch.setattr(salud, "time", SimpleNamespace(monotonic=lambda: ahora))
    client.get("/api/health")
    monkeypatch.setattr(salud, "time", SimpleNamespace(monotonic=lambda: ahora + 31))
    client.get("/api/health")

    assert len(contadorQuickCheck) == 2


def testConTtlCeroSeEjecutaEnCadaLlamada(clienteAutenticado, contadorQuickCheck, monkeypatch):
    from core import settings
    from routes.salud import saludBp

    monkeypatch.setattr(settings, "healthQuickCheckTtlSegundos", lambda: 0)
    client, _, _ = clienteAutenticado(saludBp)

    client.get("/api/health")
    client.get("/api/health")

    assert len(contadorQuickCheck) == 2


def testSelectUnoSigueEjecutandoseEnCadaLlamada(clienteAutenticado, contadorQuickCheck, monkeypatch):
    """Una BD que cae entre dos llamadas se detecta aunque el quick_check esté vigente."""
    from core import settings
    from routes import salud
    from routes.salud import saludBp

    monkeypatch.setattr(settings, "healthQuickCheckTtlSegundos", lambda: 30)
    client, _, _ = clienteAutenticado(saludBp)
    assert client.get("/api/health").status_code == 200

    def caida():
        raise RuntimeError("disco desaparecido")

    monkeypatch.setattr(salud.db, "getDb", caida)

    assert client.get("/api/health").status_code == 503


def testUnFalloNoSeGuardaEnLaCache(clienteAutenticado, tempDb, monkeypatch):
    from core import settings
    from routes import salud
    from routes.salud import saludBp

    salud._quickCheckVigente = None
    monkeypatch.setattr(settings, "healthQuickCheckTtlSegundos", lambda: 30)
    client, _, _ = clienteAutenticado(saludBp)

    class Corrupta:
        def __init__(self, real):
            self._real = real

        def execute(self, sql, *args):
            if "quick_check" in sql:
                return type("R", (), {"fetchone": lambda self: ("fila corrupta",)})()
            return self._real.execute(sql, *args)

    realGetDb = salud.db.getDb
    monkeypatch.setattr(salud.db, "getDb", lambda: Corrupta(realGetDb()))

    assert client.get("/api/health").status_code == 503
    assert client.get("/api/health").status_code == 503
    assert salud._quickCheckVigente is None


def testCambiarDeBaseInvalidaElQuickCheck(clienteAutenticado, contadorQuickCheck, monkeypatch):
    from core import db, settings
    from routes.salud import saludBp

    monkeypatch.setattr(settings, "healthQuickCheckTtlSegundos", lambda: 30)
    client, _, _ = clienteAutenticado(saludBp)
    client.get("/api/health")

    monkeypatch.setattr(db, "_resetGeneration", db._resetGeneration + 1)
    client.get("/api/health")

    assert len(contadorQuickCheck) == 2
