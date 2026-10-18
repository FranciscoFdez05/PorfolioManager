"""Alertas de precio: crear, evaluar, avisar una sola vez y rutas HTTP.

Ninguna prueba sale a la red: la cotización se sustituye por una función de
prueba y Telegram por una lista. Lo que importa aquí es la regla —salta cuando
toca, una sola vez, y no salta cuando no toca— y que dos workers no puedan
avisar de la misma alerta.
"""

import pytest

from core import db, telegram_notifier
from stores import alertas_store
from stores.asset_store import writeAssetFile


@pytest.fixture
def enviados(datosAislados, tempDb, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    yield mensajes
    telegram_notifier.reiniciarParaPruebas()


def _activo(assetId="bitcoin", **extra):
    writeAssetFile(assetId, {
        "name": assetId.capitalize(), "symbol": "BTC", "marketSymbol": "BTC-USD",
        "marketProvider": "yahoo", "type": "cripto", "price": "60000,00", "currency": "USD",
        **extra,
    })
    return assetId


# ── Esquema ───────────────────────────────────────────────────────────────────

def testElEsquema9CreaLaTablaEnUnaBaseDeLaVersion8(tempDb):
    conn = db.getDb()
    conn.execute("DROP TABLE alertas_precio")
    conn.execute("PRAGMA user_version = 8")

    db._migrate(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    assert conn.execute("SELECT COUNT(*) FROM alertas_precio").fetchone()[0] == 0


def testBorrarElActivoBorraSusAlertas(tempDb):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    conn = db.getDb()
    conn.execute("DELETE FROM activos WHERE id = ?", (activo,))
    conn.commit()

    assert alertas_store.listar() == []


def testGuardarElActivoDeNuevoConservaSusAlertas(tempDb):
    """`writeAssetFile` reescribe la ficha en cada autoguardado."""
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    _activo(activo, price="61000,00")

    assert len(alertas_store.listar(activo)) == 1


# ── Crear ─────────────────────────────────────────────────────────────────────

def testCrearGuardaElValorConPuntoDecimal(tempDb):
    activo = _activo()

    alerta = alertas_store.crear(activo, "baja_a", "1.234,50", "comprar más")

    assert alerta["valor"] == "1234.5"
    assert alerta["nota"] == "comprar más"
    assert alerta["activa"] is True
    assert alerta["disparada"] is None


@pytest.mark.parametrize("condicion,valor", [
    ("desconocida", "10"), ("sube_a", "abc"), ("sube_a", "0"), ("sube_a", "-5"), ("sube_a", ""),
])
def testCrearRechazaLoQueNoTieneSentido(tempDb, condicion, valor):
    activo = _activo()

    with pytest.raises(alertas_store.AlertaInvalida):
        alertas_store.crear(activo, condicion, valor)


def testCrearSobreUnActivoQueNoExiste(tempDb):
    with pytest.raises(alertas_store.AlertaInvalida, match="Activo"):
        alertas_store.crear("fantasma", "sube_a", "10")


# ── Evaluar ───────────────────────────────────────────────────────────────────

def testSubeASaltaAlAlcanzarElUmbral(enviados):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    assert alertas_store.evaluarActivo(activo, "69999,99") == []
    saltadas = alertas_store.evaluarActivo(activo, "70000,00", cartera="principal")

    assert len(saltadas) == 1
    assert len(enviados) == 1
    assert "Bitcoin" in enviados[0] and "70.000,00" in enviados[0] and "principal" in enviados[0]


def testBajaASaltaPorDebajo(enviados):
    activo = _activo()
    alertas_store.crear(activo, "baja_a", "50000")

    assert alertas_store.evaluarActivo(activo, "50001") == []
    assert len(alertas_store.evaluarActivo(activo, "49000")) == 1
    assert "ha bajado" in enviados[0]


def testVarDiaUsaElValorAbsolutoDeLaVariacion(enviados):
    activo = _activo()
    alertas_store.crear(activo, "var_dia", "5")

    assert alertas_store.evaluarActivo(activo, "60000", cambio=alertas_store.cambioDesdeTexto("+2,10%")) == []
    assert len(alertas_store.evaluarActivo(activo, "60000", cambio=alertas_store.cambioDesdeTexto("-6,3%"))) == 1
    assert "6,30 %" in enviados[0]


def testVarDiaSinVariacionConocidaNoSalta(enviados):
    activo = _activo()
    alertas_store.crear(activo, "var_dia", "1")

    assert alertas_store.evaluarActivo(activo, "60000", cambio=None) == []


def testSaltaUnaSolaVez(enviados):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    alertas_store.evaluarActivo(activo, "71000")
    alertas_store.evaluarActivo(activo, "72000")
    alertas_store.evaluarActivo(activo, "69000")
    alertas_store.evaluarActivo(activo, "71000")

    assert len(enviados) == 1
    alerta = alertas_store.listar(activo)[0]
    assert alerta["activa"] is False
    assert alerta["disparada"] is not None
    assert alerta["precioDisparo"] == "71000"


def testReactivarBorraLaMarcaYVuelveAVigilar(enviados):
    activo = _activo()
    alerta = alertas_store.crear(activo, "sube_a", "70000")
    alertas_store.evaluarActivo(activo, "71000")

    assert alertas_store.cambiarEstado(alerta["id"], True) is True
    reactivada = alertas_store.listar(activo)[0]
    assert reactivada["activa"] is True and reactivada["disparada"] is None

    alertas_store.evaluarActivo(activo, "72000")
    assert len(enviados) == 2


def testUnaAlertaEnPausaNoSalta(enviados):
    activo = _activo()
    alerta = alertas_store.crear(activo, "sube_a", "70000")
    alertas_store.cambiarEstado(alerta["id"], False)

    assert alertas_store.evaluarActivo(activo, "99999") == []
    assert enviados == []


def testElSegundoWorkerNoRepiteElAviso(enviados, monkeypatch):
    """Los dos workers leen la alerta como activa; solo uno puede reclamarla."""
    activo = _activo()
    alerta = alertas_store.crear(activo, "sube_a", "70000")

    # El otro worker gana la carrera: entre el SELECT y el UPDATE, la marca.
    original = alertas_store.getDb().execute
    conn = alertas_store.getDb()

    class _Conexion:
        def __getattr__(self, nombre):
            return getattr(conn, nombre)

        def execute(self, consulta, *args):
            if consulta.startswith("UPDATE alertas_precio SET activa = 0"):
                original("UPDATE alertas_precio SET activa = 0 WHERE id = ?", (alerta["id"],))
            return original(consulta, *args)

    monkeypatch.setattr(alertas_store, "getDb", lambda: _Conexion())

    assert alertas_store.evaluarActivo(activo, "71000") == []
    assert enviados == []


def testUnaCategoriaDePreciosApagadaMarcaLaAlertaPeroNoAvisa(enviados, datosAislados):
    import json

    datosAislados["ajustes"].write_text(json.dumps({"telegramAvisos": {"precios": False}}), "utf-8")
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    assert len(alertas_store.evaluarActivo(activo, "71000")) == 1
    assert enviados == []
    assert alertas_store.listar(activo)[0]["activa"] is False


def testUnPrecioIlegibleNoLanza(tempDb):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    assert alertas_store.evaluarActivo(activo, "no es un número") == []
    assert alertas_store.evaluarActivo(activo, None) == []
    assert alertas_store.evaluarActivo(activo, "0") == []


def testCambioDesdeTexto():
    assert str(alertas_store.cambioDesdeTexto("+1,23%")) == "1.23"
    assert str(alertas_store.cambioDesdeTexto("-0,50 %")) == "-0.50"
    assert alertas_store.cambioDesdeTexto("") is None
    assert alertas_store.cambioDesdeTexto("n/d") is None


# ── Vigilancia en segundo plano ───────────────────────────────────────────────

def testComprobarActivasSoloPideLosActivosConAlerta(enviados, monkeypatch):
    conAlerta = _activo("bitcoin")
    _activo("ethereum", marketSymbol="ETH-USD")
    alertas_store.crear(conAlerta, "sube_a", "70000")

    pedidos = []

    def _cotizacion(simbolo, proveedor=None, useCache=True, targetCurrency=None):
        pedidos.append(simbolo)
        return {"price": "71000,00", "currency": "USD", "change": "+1,00%"}, None

    monkeypatch.setattr("stores.market_data.fetchAssetQuote", _cotizacion)

    assert alertas_store.comprobarActivas(cartera="principal") == 1
    assert pedidos == ["BTC-USD"]
    assert len(enviados) == 1


def testComprobarActivasIgnoraUnaCotizacionEnOtraDivisa(enviados, monkeypatch):
    """Comparar dólares con un umbral en euros haría saltar alertas falsas."""
    activo = _activo("bitcoin", currency="EUR")
    alertas_store.crear(activo, "sube_a", "70000")

    monkeypatch.setattr(
        "stores.market_data.fetchAssetQuote",
        lambda *a, **k: ({"price": "99999,00", "currency": "USD", "change": ""}, None),
    )

    assert alertas_store.comprobarActivas() == 0
    assert enviados == []


def testComprobarActivasSobreviveAUnProveedorCaido(enviados, monkeypatch):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    def _cae(*a, **k):
        raise TimeoutError("sin red")

    monkeypatch.setattr("stores.market_data.fetchAssetQuote", _cae)

    assert alertas_store.comprobarActivas() == 0
    assert alertas_store.listar(activo)[0]["activa"] is True


def testElHiloRecorreTodosLosPortfolios(enviados, datosAislados, monkeypatch):
    """Las alertas de un portfolio que no está activo también tienen que saltar."""
    from admin import avisos_scheduler
    from core.db import useDbPath

    otra = datosAislados["portfolios"] / "segunda.db"
    with useDbPath(otra):
        activo = _activo("bitcoin")
        alertas_store.crear(activo, "sube_a", "70000")

    monkeypatch.setattr(
        avisos_scheduler, "rutasDePortfolios", lambda: [("segunda", "Segunda", otra)]
    )
    monkeypatch.setattr(
        "stores.market_data.fetchAssetQuote",
        lambda *a, **k: ({"price": "71000,00", "currency": "USD", "change": ""}, None),
    )
    monkeypatch.setenv("AVISOS_ALERTAS_MINUTOS", "5")

    assert avisos_scheduler._pasadaAlertas() == 1
    assert "Segunda" not in enviados[0] and "segunda" in enviados[0]


def testElHiloNoPasaDosVecesSeguidas(enviados, datosAislados, monkeypatch):
    from admin import avisos_scheduler

    monkeypatch.setattr(avisos_scheduler, "rutasDePortfolios", lambda: [])
    monkeypatch.setenv("AVISOS_ALERTAS_MINUTOS", "5")

    llamadas = []
    monkeypatch.setattr(avisos_scheduler, "rutasDePortfolios", lambda: llamadas.append(1) or [])

    avisos_scheduler._pasadaAlertas()
    avisos_scheduler._pasadaAlertas()

    assert len(llamadas) == 1, "la segunda pasada debía cederla el reclamo compartido"


def testConElIntervaloACeroNoSeVigila(datosAislados, monkeypatch):
    from admin import avisos_scheduler

    monkeypatch.setenv("AVISOS_ALERTAS_MINUTOS", "0")
    monkeypatch.setattr(avisos_scheduler, "rutasDePortfolios", lambda: pytest.fail("no debía mirar"))

    assert avisos_scheduler._pasadaAlertas() == 0


# ── HTTP ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.alertas import alertasBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(alertasBp)
    return client, cabeceras


def testHttpCrearListarPausarYBorrar(cliente):
    client, cabeceras = cliente
    activo = _activo()

    creada = client.post("/api/alertas", json={"assetId": activo, "condicion": "sube_a", "valor": "70000"},
                         headers=cabeceras)
    assert creada.status_code == 201
    alertaId = creada.get_json()["alerta"]["id"]

    listado = client.get(f"/api/alertas?assetId={activo}").get_json()
    assert [a["id"] for a in listado["alertas"]] == [alertaId]
    assert "sube_a" in listado["condiciones"]

    assert client.post(f"/api/alertas/{alertaId}/estado", json={"activa": False}, headers=cabeceras).status_code == 200
    assert client.get("/api/alertas").get_json()["alertas"][0]["activa"] is False

    assert client.delete(f"/api/alertas/{alertaId}", headers=cabeceras).status_code == 200
    assert client.get("/api/alertas").get_json()["alertas"] == []


def testHttpCrearInvalidaEs400(cliente):
    client, cabeceras = cliente
    activo = _activo()

    respuesta = client.post("/api/alertas", json={"assetId": activo, "condicion": "sube_a", "valor": "abc"},
                            headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testHttpAlertaInexistenteEs404(cliente):
    client, cabeceras = cliente

    assert client.delete("/api/alertas/999", headers=cabeceras).status_code == 404
    assert client.post("/api/alertas/999/estado", json={"activa": True}, headers=cabeceras).status_code == 404


def testHttpSinSesionEs401(crearApp, tempDb):
    from routes.alertas import alertasBp

    client = crearApp(alertasBp).test_client()

    assert client.get("/api/alertas").status_code == 401


def testRefrescarUnPrecioEvaluaLasAlertas(clienteAutenticado, enviados, monkeypatch):
    from routes.activos import activosBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(activosBp)
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    monkeypatch.setattr(
        "routes.activos.fetchAssetQuote",
        lambda *a, **k: ({
            "symbol": "BTC-USD", "price": "71000,00", "currency": "USD", "change": "+2,00%",
            "status": "Mercado abierto", "lastUpdated": "ahora", "marketData": {},
        }, None),
    )

    respuesta = client.post(f"/api/activos/{activo}/refresh-market-data", headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["alertasSaltadas"] == 1
    assert len(enviados) == 1
