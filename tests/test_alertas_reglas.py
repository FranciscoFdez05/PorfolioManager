"""Reglas de alerta: esquema, validación, cada tipo, cuándo avisan, hilo y HTTP.

Ninguna prueba sale a la red: cotizador, valoración de la cartera, tipo de
cambio y posiciones se inyectan en `reglas_alerta_motor.comprobar`, y Telegram
se sustituye por una lista. El reloj se pasa explícito (`ahora`) para simular
horas de muestras sin esperar.
"""

import json
import time
from decimal import Decimal

import pytest

from core import db, telegram_notifier
from stores import reglas_alerta_motor as motor
from stores import reglas_alerta_store as store
from stores.asset_store import writeAssetFile

hora = 3600
inicio = 1_800_000_000


@pytest.fixture
def enviados(datosAislados, tempDb, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    # «Sin cotización» cuenta como mínimo desde el arranque del proceso.
    monkeypatch.setattr(motor, "arranqueProceso", 0)
    yield mensajes
    telegram_notifier.reiniciarParaPruebas()


def _activo(assetId="bitcoin", **extra):
    writeAssetFile(assetId, {
        "name": assetId.capitalize(), "symbol": assetId[:3].upper(), "marketSymbol": f"{assetId.upper()}-USD",
        "marketProvider": "yahoo", "type": "cripto", "price": "100,00", "currency": "USD",
        **extra,
    })
    return assetId


def _posicion(cantidad="1", coste="100", invertido=None):
    return {"cantidad": Decimal(cantidad), "coste": Decimal(coste), "invertido": Decimal(invertido or coste)}


def _cotizador(precio):
    """Cotizador fijo; `precio=None` simula un proveedor caído."""
    def cotizar(simbolo, proveedor, targetCurrency=None, maxEdadSegundos=None):
        if precio is None:
            return None, "sin red"
        return {"price": str(precio), "currency": targetCurrency or "USD"}, None
    return cotizar


def _paso(precio, ahora, posiciones=None, **extra):
    """Una pasada del motor con un precio para todos los activos vigilados."""
    return motor.comprobar(fetcher=_cotizador(precio), posiciones=posiciones or {}, ahora=ahora, **extra)


def _valorador(total, activos=()):
    def valorar(refrescarPrecios=True):
        return {"total_value": total, "activos": max(1, len(activos)), "completa": True,
                "assets": [{"id": i, "v": v, "c": 0} for i, v in activos]}
    return valorar


# ── Esquema ───────────────────────────────────────────────────────────────────

def testElEsquema30ConvierteLasReglasDeCaida(tempDb):
    activo = _activo()
    conn = db.getDb()
    conn.executescript("""
        CREATE TABLE alertas_caida (id INTEGER PRIMARY KEY, asset_id TEXT, caida TEXT, ventana_min INTEGER,
            enfriamiento_min INTEGER, nota TEXT, activa INTEGER, creada_ts INTEGER);
        CREATE TABLE alertas_caida_avisos (alerta_id INTEGER, asset_id TEXT, avisada_ts INTEGER, caida TEXT,
            precio_max TEXT, precio TEXT);
    """)
    conn.execute("INSERT INTO alertas_caida VALUES (7, ?, '5', 60, 240, 'nota', 1, 123)", (activo,))
    conn.execute("INSERT INTO alertas_caida_avisos VALUES (7, ?, 999, '6.1', '', '')", (activo,))
    conn.execute("PRAGMA user_version = 29")
    conn.commit()

    db._migrate(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    regla = store.listar()[0]
    assert (regla["id"], regla["tipo"], regla["valor"], regla["ventanaMin"]) == (7, "caida", "5", 60)
    assert motor._ultimoAviso(conn, 7, activo) == 999
    tablas = {f[0] for f in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert "alertas_caida" not in tablas and "alertas_caida_avisos" not in tablas


def testBorrarElActivoBorraSusReglasYMuestras(tempDb):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)
    conn = db.getDb()
    motor.registrarMuestra(conn, activo, Decimal("100"), inicio)

    conn.execute("DELETE FROM activos WHERE id = ?", (activo,))
    conn.commit()

    assert store.listar() == []
    assert conn.execute("SELECT COUNT(*) FROM muestras_precio").fetchone()[0] == 0


# ── Validación ────────────────────────────────────────────────────────────────

def testElCatalogoTraeTodosLosTipos():
    claves = [t["clave"] for t in store.catalogo()]

    assert claves == ["caida", "subida", "rentabilidad", "precio_medio", "sin_cotizacion",
                      "cartera_valor", "cartera_caida", "peso"]


def testCrearUsaLosValoresPorDefecto(tempDb):
    regla = store.crear("rentabilidad", None, valor="10,5", enfriamientoMin=60)

    assert (regla["sentido"], regla["unidad"], regla["valor"]) == ("arriba", "%", "10.5")


def testSinCotizacionNoLlevaValor(tempDb):
    regla = store.crear("sin_cotizacion", None, ventanaMin=180, enfriamientoMin=720)

    assert regla["valor"] == "" and regla["unidad"] == ""


@pytest.mark.parametrize("argumentos", [
    {"tipo": "nada", "valor": "5", "enfriamientoMin": 60},
    {"tipo": "caida", "valor": "0", "ventanaMin": 60, "enfriamientoMin": 60},
    {"tipo": "caida", "valor": "100", "ventanaMin": 60, "enfriamientoMin": 60},
    {"tipo": "caida", "valor": "abc", "ventanaMin": 60, "enfriamientoMin": 60},
    {"tipo": "caida", "valor": "5", "ventanaMin": 30, "enfriamientoMin": 60},
    {"tipo": "caida", "valor": "5", "ventanaMin": 60, "enfriamientoMin": 7},
    {"tipo": "rentabilidad", "valor": "5", "sentido": "lado", "enfriamientoMin": 60},
    {"tipo": "rentabilidad", "valor": "5", "unidad": "USD", "enfriamientoMin": 60},
    {"tipo": "rentabilidad", "valor": "100", "sentido": "abajo", "enfriamientoMin": 60},
    {"tipo": "cartera_valor", "valor": "5000", "assetId": "bitcoin", "enfriamientoMin": 60},
])
def testCrearRechazaLoQueNoTieneSentido(tempDb, argumentos):
    _activo()

    with pytest.raises(store.ReglaInvalida):
        store.crear(**argumentos)


def testUnaGananciaEnPorcentajePuedePasarDel100(tempDb):
    assert store.crear("rentabilidad", None, sentido="arriba", valor="250", enfriamientoMin=60)["valor"] == "250"


def testListarDeUnActivoIncluyeLasGeneralesPorActivo(tempDb):
    bitcoin = _activo("bitcoin")
    _activo("ethereum")
    propia = store.crear("caida", bitcoin, valor="5", ventanaMin=60, enfriamientoMin=60)
    general = store.crear("subida", None, valor="5", ventanaMin=60, enfriamientoMin=60)
    store.crear("caida", "ethereum", valor="5", ventanaMin=60, enfriamientoMin=60)
    store.crear("cartera_valor", None, valor="1000", enfriamientoMin=60)

    ids = [r["id"] for r in store.listar(bitcoin, incluirGenerales=True)]

    assert ids == [propia["id"], general["id"]]


# ── Movimiento ────────────────────────────────────────────────────────────────

def testCaidaAvisaDesdeElMaximoDeLaVentana(enviados):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)

    avisos = [_paso(p, inicio + i * 300) for i, p in enumerate(["100", "104", "102", "98"])]

    assert avisos == [0, 0, 0, 1]
    assert enviados[0].startswith("Caída brusca · Bitcoin (BIT)")
    assert "-5,77 %" in enviados[0]


def testSubidaAvisaDesdeElMinimoDeLaVentana(enviados):
    activo = _activo()
    store.crear("subida", activo, valor="10", ventanaMin=15, enfriamientoMin=60)

    avisos = [_paso(p, inicio + i * 300) for i, p in enumerate(["100", "95", "105"])]

    assert avisos == [0, 0, 1]
    assert "+10,53 %" in enviados[0]


def testUnaCaidaMasLentaQueLaVentanaNoAvisa(enviados):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=15, enfriamientoMin=60)

    avisos = [_paso(p, inicio + i * 600) for i, p in enumerate(["100", "99", "98", "97", "96", "95", "94"])]

    assert sum(avisos) == 0


def testElEnfriamientoEvitaRepetirElMovimiento(enviados):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=240)

    _paso("100", inicio)
    _paso("94", inicio + 300)
    _paso("94", inicio + hora)

    assert _paso("89", inicio + hora + 300) == 0
    assert len(enviados) == 1


def testLaMismaCaidaNoSeAvisaDosVecesAlAcabarElEnfriamiento(enviados):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=1440, enfriamientoMin=15)

    _paso("100", inicio)
    _paso("94", inicio + 300)

    assert _paso("94", inicio + hora) == 0


def testLaReglaGeneralSoloVigilaActivosEnCartera(enviados):
    _activo("bitcoin")
    _activo("ethereum")
    store.crear("caida", None, valor="5", ventanaMin=60, enfriamientoMin=60)
    posiciones = {"bitcoin": _posicion()}
    llamadas = []

    def cotizar(simbolo, proveedor, targetCurrency=None, maxEdadSegundos=None):
        llamadas.append(simbolo)
        return {"price": "100", "currency": "USD"}, None

    motor.comprobar(fetcher=cotizar, posiciones=posiciones, ahora=inicio)

    assert llamadas == ["BITCOIN-USD"]


# ── Nivel ─────────────────────────────────────────────────────────────────────

def testRentabilidadEnPorcentajeAvisaUnaVezMientrasSigaDentro(enviados):
    activo = _activo()
    store.crear("rentabilidad", activo, sentido="arriba", valor="20", enfriamientoMin=15)
    posiciones = {activo: _posicion(cantidad="2", coste="200")}

    assert _paso("110", inicio, posiciones) == 0
    assert _paso("125", inicio + hora, posiciones) == 1
    assert _paso("130", inicio + 2 * hora, posiciones) == 0, "sigue dentro: no repite"
    assert "+25,00 %" in enviados[0]


def testUnaAlertaDeNivelSeRearmaAlSalirDeLaCondicion(enviados):
    activo = _activo()
    store.crear("rentabilidad", activo, sentido="abajo", valor="10", enfriamientoMin=15)
    posiciones = {activo: _posicion()}

    assert _paso("85", inicio, posiciones) == 1
    assert _paso("95", inicio + hora, posiciones) == 0
    assert _paso("85", inicio + 2 * hora, posiciones) == 1


def testUnaAlertaDeNivelRespetaElEnfriamientoAlVolverAEntrar(enviados):
    activo = _activo()
    store.crear("rentabilidad", activo, sentido="abajo", valor="10", enfriamientoMin=240)
    posiciones = {activo: _posicion()}

    _paso("85", inicio, posiciones)
    _paso("95", inicio + 300, posiciones)

    assert _paso("85", inicio + 600, posiciones) == 0
    assert _paso("85", inicio + 5 * hora, posiciones) == 1


def testRentabilidadEnEurosConvierteLaDivisa(enviados):
    activo = _activo()
    store.crear("rentabilidad", activo, sentido="arriba", unidad="EUR", valor="40", enfriamientoMin=60)
    posiciones = {activo: _posicion(cantidad="1", coste="100")}

    # +50 USD a 0,9 = +45 €.
    avisos = _paso("150", inicio, posiciones, cambio=lambda origen, destino: (0.9, None))

    assert avisos == 1
    assert "+45,00 €" in enviados[0]


def testRentabilidadEnEurosSinTipoDeCambioNoAdivina(enviados):
    activo = _activo()
    store.crear("rentabilidad", activo, sentido="arriba", unidad="EUR", valor="1", enfriamientoMin=60)

    avisos = _paso("150", inicio, {activo: _posicion()}, cambio=lambda origen, destino: (None, "caído"))

    assert avisos == 0


def testRentabilidadSinPosicionNoSeEvalua(enviados):
    activo = _activo()
    store.crear("rentabilidad", activo, sentido="abajo", valor="5", enfriamientoMin=60)

    assert _paso("1", inicio, {}) == 0


def testPrecioMedioPorDebajo(enviados):
    activo = _activo()
    store.crear("precio_medio", activo, sentido="abajo", valor="15", enfriamientoMin=60)
    # Precio medio sin comisiones: 180 / 2 = 90.
    posiciones = {activo: _posicion(cantidad="2", coste="200", invertido="180")}

    assert _paso("80", inicio, posiciones) == 0
    assert _paso("76", inicio + hora, posiciones) == 1
    assert "Tu precio medio: 90,00 USD" in enviados[0]


def testSinCotizacionAvisaPasadaLaDuracionYSeRearmaAlVolverElPrecio(enviados):
    activo = _activo()
    regla = store.crear("sin_cotizacion", activo, ventanaMin=60, enfriamientoMin=15)
    db.getDb().execute("UPDATE alertas_reglas SET creada_ts = ? WHERE id = ?", (inicio, regla["id"]))
    db.getDb().commit()

    assert _paso("100", inicio) == 0
    assert _paso(None, inicio + 30 * 60) == 0
    assert _paso(None, inicio + hora + 60) == 1
    assert _paso("100", inicio + 2 * hora) == 0
    assert _paso(None, inicio + 4 * hora) == 1
    assert enviados[0].startswith("Sin cotización · Bitcoin")


# ── Cartera ───────────────────────────────────────────────────────────────────

def testValorDeLaCarteraBajaDe(enviados):
    store.crear("cartera_valor", None, sentido="abajo", valor="10000", enfriamientoMin=60)

    assert motor.comprobar(valorador=_valorador(12000), ahora=inicio) == 0
    assert motor.comprobar(valorador=_valorador(9500), ahora=inicio + hora) == 1
    assert enviados[0].startswith("Valor total de la cartera\n")


def testCaidaDeLaCartera(enviados):
    store.crear("cartera_caida", None, valor="3", ventanaMin=60, enfriamientoMin=60)

    assert motor.comprobar(valorador=_valorador(10000), ahora=inicio) == 0
    assert motor.comprobar(valorador=_valorador(9600), ahora=inicio + 600) == 1


def testUnaValoracionIncompletaNoEvalua(enviados):
    store.crear("cartera_valor", None, sentido="abajo", valor="10000", enfriamientoMin=60)

    def incompleta(refrescarPrecios=True):
        return {"total_value": 1, "activos": 1, "completa": False, "assets": []}

    assert motor.comprobar(valorador=incompleta, ahora=inicio) == 0


def testPesoDeUnActivo(enviados):
    _activo("bitcoin")
    _activo("ethereum")
    store.crear("peso", None, valor="40", enfriamientoMin=60)

    avisos = motor.comprobar(valorador=_valorador(1000, [("bitcoin", 600), ("ethereum", 400)]), ahora=inicio)

    assert avisos == 2
    assert any("Bitcoin" in m and "60,00 %" in m for m in enviados)


def testPesoDeUnActivoConcreto(enviados):
    _activo("bitcoin")
    _activo("ethereum")
    store.crear("peso", "ethereum", valor="30", enfriamientoMin=60)

    avisos = motor.comprobar(valorador=_valorador(1000, [("bitcoin", 600), ("ethereum", 400)]), ahora=inicio)

    assert avisos == 1


# ── Robustez ──────────────────────────────────────────────────────────────────

def testUnaReglaEnPausaNoAvisa(enviados):
    activo = _activo()
    regla = store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)
    store.cambiarEstado(regla["id"], False)

    _paso("100", inicio)

    assert _paso("50", inicio + 300) == 0


def testElSegundoWorkerNoRepiteElAviso(enviados):
    activo = _activo()
    regla = store.crear("rentabilidad", activo, sentido="abajo", valor="10", enfriamientoMin=60)
    conn = db.getDb()
    # El otro worker acaba de reclamarlo: la fila ya está «dentro».
    conn.execute("INSERT INTO alertas_reglas_avisos (regla_id, clave, avisada_ts, dentro) VALUES (?, ?, ?, 1)",
                 (regla["id"], activo, inicio))
    conn.commit()

    assert _paso("80", inicio + 10, {activo: _posicion()}) == 0
    assert enviados == []


def testLaCategoriaApagadaApuntaElAvisoPeroNoManda(enviados, datosAislados):
    datosAislados["ajustes"].write_text(json.dumps({"telegramAvisos": {"movimientos": False}}), "utf-8")
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)

    _paso("100", inicio)

    assert _paso("90", inicio + 300) == 1
    assert enviados == []
    assert store.ultimosAvisos()[0]["detalle"].startswith("-10,00 %")


def testUnaCotizacionEnOtraDivisaSeIgnora(enviados):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)

    def enEuros(simbolo, proveedor, targetCurrency=None, maxEdadSegundos=None):
        return {"price": "100", "currency": "EUR"}, None

    motor.comprobar(fetcher=enEuros, ahora=inicio)

    assert db.getDb().execute("SELECT COUNT(*) FROM muestras_precio").fetchone()[0] == 0


def testUnProveedorQueLanzaNoTumbaLaPasada(enviados):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)

    def cae(*_a, **_k):
        raise TimeoutError("sin red")

    assert motor.comprobar(fetcher=cae, ahora=inicio) == 0


def testPurgarBorraLoQueSaleDeLaVentanaMasLarga(tempDb):
    activo = _activo()
    store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)
    conn = db.getDb()
    viejo = inicio - store.ventanaMaximaSegundos - motor.margenPurgaSegundos - 1
    motor.registrarMuestra(conn, activo, Decimal("100"), viejo)
    motor.registrarMuestra(conn, activo, Decimal("100"), inicio - hora)
    motor.registrarMuestraCartera(conn, Decimal("1000"), viejo)

    assert motor.purgarMuestras(conn, inicio, hayReglas=True) == 2


def testSinReglasActivasSeBorraTodoElHistorial(tempDb):
    activo = _activo()
    conn = db.getDb()
    motor.registrarMuestra(conn, activo, Decimal("100"), inicio)

    motor.comprobar(ahora=inicio)

    assert conn.execute("SELECT COUNT(*) FROM muestras_precio").fetchone()[0] == 0


# ── Hilo ──────────────────────────────────────────────────────────────────────

def testElHiloRecorreTodosLosPortfolios(enviados, datosAislados, monkeypatch):
    from admin import avisos_scheduler
    from core.db import useDbPath

    otra = datosAislados["portfolios"] / "segunda.db"
    with useDbPath(otra):
        activo = _activo("bitcoin")
        store.crear("caida", activo, valor="5", ventanaMin=60, enfriamientoMin=60)
        motor.registrarMuestra(db.getDb(), activo, Decimal("100"), int(time.time()) - 60)

    monkeypatch.setattr(avisos_scheduler, "rutasDePortfolios", lambda: [("segunda", "Segunda", otra)])
    monkeypatch.setattr(
        "stores.market_data.fetchAssetQuote",
        lambda *a, **k: ({"price": "90", "currency": "USD"}, None),
    )
    monkeypatch.setenv("AVISOS_REGLAS_MINUTOS", "5")

    assert avisos_scheduler._pasadaReglas() == 1
    assert "Cartera: segunda" in enviados[0]


def testConElIntervaloACeroNoSeVigila(datosAislados, monkeypatch):
    from admin import avisos_scheduler

    monkeypatch.setenv("AVISOS_REGLAS_MINUTOS", "0")
    monkeypatch.setattr(avisos_scheduler, "rutasDePortfolios", lambda: pytest.fail("no debía mirar"))

    assert avisos_scheduler._pasadaReglas() == 0


# ── HTTP ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(clienteAutenticado, tempDb, monkeypatch):
    from routes.alertas_reglas import alertasReglasBp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = clienteAutenticado(alertasReglasBp)
    return client, cabeceras


def testHttpCrearListarPausarYBorrar(cliente):
    client, cabeceras = cliente
    activo = _activo()

    creada = client.post("/api/alertas-reglas", headers=cabeceras, json={
        "tipo": "caida", "assetId": "", "valor": "5", "ventanaMin": 60, "enfriamientoMin": 240})
    assert creada.status_code == 201
    reglaId = creada.get_json()["regla"]["id"]

    listado = client.get("/api/alertas-reglas").get_json()
    assert [r["id"] for r in listado["reglas"]] == [reglaId]
    assert listado["reglas"][0]["assetId"] is None
    assert {t["clave"] for t in listado["tipos"]} >= {"caida", "peso"}
    assert [a["id"] for a in client.get("/api/alertas/activos").get_json()["activos"]] == [activo]
    assert [r["id"] for r in client.get(f"/api/alertas-reglas?assetId={activo}").get_json()["reglas"]] == [reglaId]

    assert client.post(f"/api/alertas-reglas/{reglaId}/estado", json={"activa": False},
                       headers=cabeceras).status_code == 200
    assert client.get("/api/alertas-reglas").get_json()["reglas"][0]["activa"] is False

    assert client.delete(f"/api/alertas-reglas/{reglaId}", headers=cabeceras).status_code == 200
    assert client.get("/api/alertas-reglas").get_json()["reglas"] == []


def testHttpCrearInvalidaEs400(cliente):
    client, cabeceras = cliente

    respuesta = client.post("/api/alertas-reglas", headers=cabeceras,
                            json={"tipo": "caida", "valor": "5", "ventanaMin": 7, "enfriamientoMin": 60})

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def testHttpReglaInexistenteEs404(cliente):
    client, cabeceras = cliente

    assert client.delete("/api/alertas-reglas/999", headers=cabeceras).status_code == 404
    assert client.post("/api/alertas-reglas/999/estado", json={"activa": True},
                       headers=cabeceras).status_code == 404


def testHttpSinSesionEs401(crearApp, tempDb):
    from routes.alertas_reglas import alertasReglasBp

    client = crearApp(alertasReglasBp).test_client()

    assert client.get("/api/alertas-reglas").status_code == 401
