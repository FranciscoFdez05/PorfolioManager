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
def enviados(datos_aislados, temp_db, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciar_para_pruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    yield mensajes
    telegram_notifier.reiniciar_para_pruebas()


def _activo(asset_id="bitcoin", **extra):
    writeAssetFile(asset_id, {
        "name": asset_id.capitalize(), "symbol": "BTC", "marketSymbol": "BTC-USD",
        "marketProvider": "yahoo", "type": "cripto", "price": "60000,00", "currency": "USD",
        **extra,
    })
    return asset_id


# ── Esquema ───────────────────────────────────────────────────────────────────

def test_el_esquema_9_crea_la_tabla_en_una_base_de_la_version_8(temp_db):
    conn = db.get_db()
    conn.execute("DROP TABLE alertas_precio")
    conn.execute("PRAGMA user_version = 8")

    db._migrate(conn)

    assert conn.execute("PRAGMA user_version").fetchone()[0] == db.ESQUEMA_VERSION
    assert conn.execute("SELECT COUNT(*) FROM alertas_precio").fetchone()[0] == 0


def test_borrar_el_activo_borra_sus_alertas(temp_db):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    conn = db.get_db()
    conn.execute("DELETE FROM activos WHERE id = ?", (activo,))
    conn.commit()

    assert alertas_store.listar() == []


def test_guardar_el_activo_de_nuevo_conserva_sus_alertas(temp_db):
    """`writeAssetFile` reescribe la ficha en cada autoguardado."""
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    _activo(activo, price="61000,00")

    assert len(alertas_store.listar(activo)) == 1


# ── Crear ─────────────────────────────────────────────────────────────────────

def test_crear_guarda_el_valor_con_punto_decimal(temp_db):
    activo = _activo()

    alerta = alertas_store.crear(activo, "baja_a", "1.234,50", "comprar más")

    assert alerta["valor"] == "1234.5"
    assert alerta["nota"] == "comprar más"
    assert alerta["activa"] is True
    assert alerta["disparada"] is None


@pytest.mark.parametrize("condicion,valor", [
    ("desconocida", "10"), ("sube_a", "abc"), ("sube_a", "0"), ("sube_a", "-5"), ("sube_a", ""),
])
def test_crear_rechaza_lo_que_no_tiene_sentido(temp_db, condicion, valor):
    activo = _activo()

    with pytest.raises(alertas_store.AlertaInvalida):
        alertas_store.crear(activo, condicion, valor)


def test_crear_sobre_un_activo_que_no_existe(temp_db):
    with pytest.raises(alertas_store.AlertaInvalida, match="Activo"):
        alertas_store.crear("fantasma", "sube_a", "10")


# ── Evaluar ───────────────────────────────────────────────────────────────────

def test_sube_a_salta_al_alcanzar_el_umbral(enviados):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    assert alertas_store.evaluar_activo(activo, "69999,99") == []
    saltadas = alertas_store.evaluar_activo(activo, "70000,00", cartera="principal")

    assert len(saltadas) == 1
    assert len(enviados) == 1
    assert "Bitcoin" in enviados[0] and "70.000,00" in enviados[0] and "principal" in enviados[0]


def test_baja_a_salta_por_debajo(enviados):
    activo = _activo()
    alertas_store.crear(activo, "baja_a", "50000")

    assert alertas_store.evaluar_activo(activo, "50001") == []
    assert len(alertas_store.evaluar_activo(activo, "49000")) == 1
    assert "ha bajado" in enviados[0]


def test_var_dia_usa_el_valor_absoluto_de_la_variacion(enviados):
    activo = _activo()
    alertas_store.crear(activo, "var_dia", "5")

    assert alertas_store.evaluar_activo(activo, "60000", cambio=alertas_store.cambio_desde_texto("+2,10%")) == []
    assert len(alertas_store.evaluar_activo(activo, "60000", cambio=alertas_store.cambio_desde_texto("-6,3%"))) == 1
    assert "6,30 %" in enviados[0]


def test_var_dia_sin_variacion_conocida_no_salta(enviados):
    activo = _activo()
    alertas_store.crear(activo, "var_dia", "1")

    assert alertas_store.evaluar_activo(activo, "60000", cambio=None) == []


def test_salta_una_sola_vez(enviados):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    alertas_store.evaluar_activo(activo, "71000")
    alertas_store.evaluar_activo(activo, "72000")
    alertas_store.evaluar_activo(activo, "69000")
    alertas_store.evaluar_activo(activo, "71000")

    assert len(enviados) == 1
    alerta = alertas_store.listar(activo)[0]
    assert alerta["activa"] is False
    assert alerta["disparada"] is not None
    assert alerta["precioDisparo"] == "71000"


def test_reactivar_borra_la_marca_y_vuelve_a_vigilar(enviados):
    activo = _activo()
    alerta = alertas_store.crear(activo, "sube_a", "70000")
    alertas_store.evaluar_activo(activo, "71000")

    assert alertas_store.cambiar_estado(alerta["id"], True) is True
    reactivada = alertas_store.listar(activo)[0]
    assert reactivada["activa"] is True and reactivada["disparada"] is None

    alertas_store.evaluar_activo(activo, "72000")
    assert len(enviados) == 2


def test_una_alerta_en_pausa_no_salta(enviados):
    activo = _activo()
    alerta = alertas_store.crear(activo, "sube_a", "70000")
    alertas_store.cambiar_estado(alerta["id"], False)

    assert alertas_store.evaluar_activo(activo, "99999") == []
    assert enviados == []


def test_el_segundo_worker_no_repite_el_aviso(enviados, monkeypatch):
    """Los dos workers leen la alerta como activa; solo uno puede reclamarla."""
    activo = _activo()
    alerta = alertas_store.crear(activo, "sube_a", "70000")

    # El otro worker gana la carrera: entre el SELECT y el UPDATE, la marca.
    original = alertas_store.get_db().execute
    conn = alertas_store.get_db()

    class _Conexion:
        def __getattr__(self, nombre):
            return getattr(conn, nombre)

        def execute(self, consulta, *args):
            if consulta.startswith("UPDATE alertas_precio SET activa = 0"):
                original("UPDATE alertas_precio SET activa = 0 WHERE id = ?", (alerta["id"],))
            return original(consulta, *args)

    monkeypatch.setattr(alertas_store, "get_db", lambda: _Conexion())

    assert alertas_store.evaluar_activo(activo, "71000") == []
    assert enviados == []


def test_una_categoria_de_precios_apagada_marca_la_alerta_pero_no_avisa(enviados, datos_aislados):
    import json

    datos_aislados["ajustes"].write_text(json.dumps({"telegramAvisos": {"precios": False}}), "utf-8")
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    assert len(alertas_store.evaluar_activo(activo, "71000")) == 1
    assert enviados == []
    assert alertas_store.listar(activo)[0]["activa"] is False


def test_un_precio_ilegible_no_lanza(temp_db):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    assert alertas_store.evaluar_activo(activo, "no es un número") == []
    assert alertas_store.evaluar_activo(activo, None) == []
    assert alertas_store.evaluar_activo(activo, "0") == []


def test_cambio_desde_texto():
    assert str(alertas_store.cambio_desde_texto("+1,23%")) == "1.23"
    assert str(alertas_store.cambio_desde_texto("-0,50 %")) == "-0.50"
    assert alertas_store.cambio_desde_texto("") is None
    assert alertas_store.cambio_desde_texto("n/d") is None


# ── Vigilancia en segundo plano ───────────────────────────────────────────────

def test_comprobar_activas_solo_pide_los_activos_con_alerta(enviados, monkeypatch):
    con_alerta = _activo("bitcoin")
    _activo("ethereum", marketSymbol="ETH-USD")
    alertas_store.crear(con_alerta, "sube_a", "70000")

    pedidos = []

    def _cotizacion(simbolo, proveedor=None, use_cache=True, target_currency=None):
        pedidos.append(simbolo)
        return {"price": "71000,00", "currency": "USD", "change": "+1,00%"}, None

    monkeypatch.setattr("stores.market_data.fetch_asset_quote", _cotizacion)

    assert alertas_store.comprobar_activas(cartera="principal") == 1
    assert pedidos == ["BTC-USD"]
    assert len(enviados) == 1


def test_comprobar_activas_ignora_una_cotizacion_en_otra_divisa(enviados, monkeypatch):
    """Comparar dólares con un umbral en euros haría saltar alertas falsas."""
    activo = _activo("bitcoin", currency="EUR")
    alertas_store.crear(activo, "sube_a", "70000")

    monkeypatch.setattr(
        "stores.market_data.fetch_asset_quote",
        lambda *a, **k: ({"price": "99999,00", "currency": "USD", "change": ""}, None),
    )

    assert alertas_store.comprobar_activas() == 0
    assert enviados == []


def test_comprobar_activas_sobrevive_a_un_proveedor_caido(enviados, monkeypatch):
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    def _cae(*a, **k):
        raise TimeoutError("sin red")

    monkeypatch.setattr("stores.market_data.fetch_asset_quote", _cae)

    assert alertas_store.comprobar_activas() == 0
    assert alertas_store.listar(activo)[0]["activa"] is True


def test_el_hilo_recorre_todos_los_portfolios(enviados, datos_aislados, monkeypatch):
    """Las alertas de un portfolio que no está activo también tienen que saltar."""
    from admin import avisos_scheduler
    from core.db import use_db_path

    otra = datos_aislados["portfolios"] / "segunda.db"
    with use_db_path(otra):
        activo = _activo("bitcoin")
        alertas_store.crear(activo, "sube_a", "70000")

    monkeypatch.setattr(
        avisos_scheduler, "rutas_de_portfolios", lambda: [("segunda", "Segunda", otra)]
    )
    monkeypatch.setattr(
        "stores.market_data.fetch_asset_quote",
        lambda *a, **k: ({"price": "71000,00", "currency": "USD", "change": ""}, None),
    )
    monkeypatch.setenv("AVISOS_ALERTAS_MINUTOS", "5")

    assert avisos_scheduler._pasada_alertas() == 1
    assert "Segunda" not in enviados[0] and "segunda" in enviados[0]


def test_el_hilo_no_pasa_dos_veces_seguidas(enviados, datos_aislados, monkeypatch):
    from admin import avisos_scheduler

    monkeypatch.setattr(avisos_scheduler, "rutas_de_portfolios", lambda: [])
    monkeypatch.setenv("AVISOS_ALERTAS_MINUTOS", "5")

    llamadas = []
    monkeypatch.setattr(avisos_scheduler, "rutas_de_portfolios", lambda: llamadas.append(1) or [])

    avisos_scheduler._pasada_alertas()
    avisos_scheduler._pasada_alertas()

    assert len(llamadas) == 1, "la segunda pasada debía cederla el reclamo compartido"


def test_con_el_intervalo_a_cero_no_se_vigila(datos_aislados, monkeypatch):
    from admin import avisos_scheduler

    monkeypatch.setenv("AVISOS_ALERTAS_MINUTOS", "0")
    monkeypatch.setattr(avisos_scheduler, "rutas_de_portfolios", lambda: pytest.fail("no debía mirar"))

    assert avisos_scheduler._pasada_alertas() == 0


# ── HTTP ──────────────────────────────────────────────────────────────────────

@pytest.fixture
def cliente(cliente_autenticado, temp_db, monkeypatch):
    from routes.alertas import alertas_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(alertas_bp)
    return client, cabeceras


def test_http_crear_listar_pausar_y_borrar(cliente):
    client, cabeceras = cliente
    activo = _activo()

    creada = client.post("/api/alertas", json={"assetId": activo, "condicion": "sube_a", "valor": "70000"},
                         headers=cabeceras)
    assert creada.status_code == 201
    alerta_id = creada.get_json()["alerta"]["id"]

    listado = client.get(f"/api/alertas?assetId={activo}").get_json()
    assert [a["id"] for a in listado["alertas"]] == [alerta_id]
    assert "sube_a" in listado["condiciones"]

    assert client.post(f"/api/alertas/{alerta_id}/estado", json={"activa": False}, headers=cabeceras).status_code == 200
    assert client.get("/api/alertas").get_json()["alertas"][0]["activa"] is False

    assert client.delete(f"/api/alertas/{alerta_id}", headers=cabeceras).status_code == 200
    assert client.get("/api/alertas").get_json()["alertas"] == []


def test_http_crear_invalida_es_400(cliente):
    client, cabeceras = cliente
    activo = _activo()

    respuesta = client.post("/api/alertas", json={"assetId": activo, "condicion": "sube_a", "valor": "abc"},
                            headers=cabeceras)

    assert respuesta.status_code == 400
    assert respuesta.get_json()["ok"] is False


def test_http_alerta_inexistente_es_404(cliente):
    client, cabeceras = cliente

    assert client.delete("/api/alertas/999", headers=cabeceras).status_code == 404
    assert client.post("/api/alertas/999/estado", json={"activa": True}, headers=cabeceras).status_code == 404


def test_http_sin_sesion_es_401(crear_app, temp_db):
    from routes.alertas import alertas_bp

    client = crear_app(alertas_bp).test_client()

    assert client.get("/api/alertas").status_code == 401


def test_refrescar_un_precio_evalua_las_alertas(cliente_autenticado, enviados, monkeypatch):
    from routes.activos import activos_bp

    monkeypatch.setenv("ESCRITURAS_POR_MINUTO", "0")
    client, cabeceras, _app = cliente_autenticado(activos_bp)
    activo = _activo()
    alertas_store.crear(activo, "sube_a", "70000")

    monkeypatch.setattr(
        "routes.activos.fetch_asset_quote",
        lambda *a, **k: ({
            "symbol": "BTC-USD", "price": "71000,00", "currency": "USD", "change": "+2,00%",
            "status": "Mercado abierto", "lastUpdated": "ahora", "marketData": {},
        }, None),
    )

    respuesta = client.post(f"/api/activos/{activo}/refresh-market-data", headers=cabeceras)

    assert respuesta.status_code == 200
    assert respuesta.get_json()["alertasSaltadas"] == 1
    assert len(enviados) == 1
