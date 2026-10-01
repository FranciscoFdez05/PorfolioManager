"""Comandos del bot: qué contesta a cada uno y qué hace en el servidor.

Sin red: las cotizaciones y los envíos están sustituidos. El listener decide
quién puede hablar (ver test_telegram_listener.py); aquí se prueba solo qué
se responde una vez autorizado.
"""

import pytest

from admin import telegram_comandos as comandos
from core import telegram_notifier
from stores import alertas_store
from stores.asset_store import writeAssetFile


@pytest.fixture(autouse=True)
def _limpio(datos_aislados, temp_db, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciar_para_pruebas()
    yield
    telegram_notifier.reiniciar_para_pruebas()


def _activo(asset_id, nombre, simbolo, precio="100,00", cambio="+1,00%", moneda="EUR"):
    writeAssetFile(asset_id, {
        "name": nombre, "symbol": simbolo, "marketSymbol": simbolo, "marketProvider": "yahoo",
        "type": "acciones", "price": precio, "currency": moneda, "change": cambio,
    })


# ── Reconocer comandos ────────────────────────────────────────────────────────

@pytest.mark.parametrize("texto,esperado", [
    ("/estado", ("estado", [])),
    ("/ESTADO", ("estado", [])),
    ("/estado@MiBot", ("estado", [])),
    ("/precio btc  usd", ("precio", ["btc", "usd"])),
    ("  /ayuda ", ("ayuda", [])),
    ("hola", (None, [])),
    ("", (None, [])),
])
def test_partir(texto, esperado):
    assert comandos.partir(texto) == esperado


def test_un_texto_que_no_es_comando_no_se_contesta():
    assert comandos.responder("hola, ¿qué tal?") is None


def test_start_lo_contesta_el_listener_no_este_modulo():
    assert comandos.responder("/start") is None


def test_un_comando_desconocido_remite_a_la_ayuda():
    assert "/ayuda" in comandos.responder("/inventado")


def test_la_ayuda_lista_todos_los_comandos_del_menu():
    ayuda = comandos.responder("/ayuda")

    for nombre, _texto in comandos.COMANDOS:
        assert f"/{nombre}" in ayuda


def test_todo_comando_del_menu_tiene_manejador():
    for nombre, _texto in comandos.COMANDOS:
        assert nombre in comandos._MANEJADORES, f"/{nombre} está en el menú y no hace nada"


def test_un_fallo_dentro_de_un_comando_se_cuenta_no_se_propaga(monkeypatch):
    def _cae(_args):
        raise RuntimeError("se rompió")

    monkeypatch.setitem(comandos._MANEJADORES, "ping", _cae)

    assert "se rompió" in comandos.responder("/ping")


def test_ping():
    assert "pong" in comandos.responder("/ping")


# ── Activos ───────────────────────────────────────────────────────────────────

def test_activos_lista_precio_y_variacion():
    _activo("apple", "Apple", "AAPL", "190,20", "+1,20%", "USD")

    texto = comandos.responder("/activos")

    assert "Apple" in texto and "190,20 USD" in texto and "+1,20%" in texto


def test_activos_vacio():
    assert "No hay activos" in comandos.responder("/activos")


def test_buscar_activo_por_ticker_id_o_trozo_del_nombre():
    _activo("apple", "Apple Inc", "AAPL")
    _activo("tesla", "Tesla", "TSLA")

    assert comandos.buscar_activo("aapl")[0]["id"] == "apple"
    assert comandos.buscar_activo("TESLA")[0]["id"] == "tesla"
    assert comandos.buscar_activo("appl")[0]["id"] == "apple"


def test_buscar_activo_ambiguo_no_adivina():
    _activo("apple-a", "Apple A", "AAA")
    _activo("apple-b", "Apple B", "BBB")

    activo, error = comandos.buscar_activo("apple")

    assert activo is None
    assert "Apple A" in error and "Apple B" in error


def test_buscar_activo_inexistente():
    activo, error = comandos.buscar_activo("nada")

    assert activo is None and "nada" in error


def test_precio_pide_la_cotizacion_en_vivo(monkeypatch):
    _activo("apple", "Apple", "AAPL", "100,00")
    monkeypatch.setattr(
        "stores.market_data.fetch_asset_quote",
        lambda *a, **k: ({"price": "123,45", "currency": "EUR", "change": "+0,50%"}, None),
    )

    texto = comandos.responder("/precio aapl")

    assert "123,45 EUR" in texto and "+0,50%" in texto


def test_precio_sin_cotizacion_cae_al_ultimo_guardado(monkeypatch):
    _activo("apple", "Apple", "AAPL", "100,00")
    monkeypatch.setattr("stores.market_data.fetch_asset_quote", lambda *a, **k: (None, "sin conexión"))

    texto = comandos.responder("/precio apple")

    assert "100,00 EUR" in texto and "en vivo" in texto


# ── Alertas ───────────────────────────────────────────────────────────────────

def test_alertas_lista_activas_y_cuenta_las_saltadas():
    _activo("bitcoin", "Bitcoin", "BTC")
    alertas_store.crear("bitcoin", "sube_a", "70000")
    saltada = alertas_store.crear("bitcoin", "baja_a", "10")
    alertas_store.evaluar_activo("bitcoin", "5")

    texto = comandos.responder("/alertas")

    assert "Bitcoin" in texto and "70.000,00" in texto
    assert "#" + str(saltada["id"]) not in texto
    assert "1 alerta(s) ya saltaron" in texto


def test_alertas_vacio_dice_donde_se_crean():
    assert "ficha" in comandos.responder("/alertas")


def test_las_alertas_no_se_crean_ni_se_borran_desde_el_chat():
    _activo("bitcoin", "Bitcoin", "BTC")
    alerta = alertas_store.crear("bitcoin", "sube_a", "70000")

    for texto in ("/alerta btc > 10", f"/quitaralerta {alerta['id']}"):
        assert "No conozco" in comandos.responder(texto)
    assert len(alertas_store.listar()) == 1


def test_comandos_y_ayuda_dan_la_misma_lista():
    assert comandos.responder("/comandos") == comandos.responder("/ayuda")
    assert "/status" in comandos.responder("/comandos")


# ── Copias ────────────────────────────────────────────────────────────────────

@pytest.fixture
def con_copias(datos_aislados):
    (datos_aislados["portfolios"] / "principal.db").write_bytes(b"")
    return datos_aislados


def test_backup_hace_la_copia_y_lo_cuenta_una_sola_vez(con_copias, monkeypatch):
    from routes import backup

    enviados = []
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: enviados.append(texto))
    monkeypatch.setattr(backup, "_escribir_backup", lambda automatico: "backup_01-01-2026_10-00-00.zip")

    texto = comandos.responder("/backup")

    assert "backup_01-01-2026_10-00-00.zip" in texto
    # La respuesta es el mensaje; el aviso genérico de copia creada se salta.
    assert enviados == []


def test_backup_que_falla_lo_dice(con_copias, monkeypatch):
    from routes import backup

    def _falla(automatico):
        raise OSError("disco lleno")

    monkeypatch.setattr(backup, "_escribir_backup", _falla)

    texto = comandos.responder("/backup")

    assert "disco lleno" in texto


def test_backup_con_otra_copia_en_curso(con_copias, monkeypatch):
    from core.bloqueo import BloqueoOcupado
    from routes import backup

    def _ocupado(*a, **k):
        raise BloqueoOcupado("otra copia")

    monkeypatch.setattr(backup, "crear_backup_manual", _ocupado)

    assert "otra copia en curso" in comandos.responder("/backup")


def test_backups_lista_las_ultimas(con_copias):
    (con_copias["backups"] / "backup_01-01-2026_10-00-00.zip").write_bytes(b"x" * 2048)
    (con_copias["backups"] / "backup_02-01-2026_10-00-00_auto.zip").write_bytes(b"x" * 2048)

    texto = comandos.responder("/backups")

    assert "2 en total" in texto
    assert texto.index("02-01-2026") < texto.index("01-01-2026"), "la más reciente primero"


def test_backups_sin_copias(con_copias):
    assert "No hay copias" in comandos.responder("/backups")


# ── Servidor ──────────────────────────────────────────────────────────────────

def test_estado_resume_el_servidor(con_copias):
    (con_copias["backups"] / "backup_02-01-2026_10-00-00_auto.zip").write_bytes(b"x")

    texto = comandos.responder("/estado")

    assert "PortfolioManager" in texto
    assert "Base de datos: correcta" in texto
    assert "Disco:" in texto
    assert "02/01/2026 10:00" in texto
    assert "Alertas de precio activas: 0" in texto
    assert "Hilos:" in texto


def test_proveedores(monkeypatch):
    monkeypatch.setattr(
        "providers.api_stats.get_today_stats",
        lambda: {"date": "2026-01-01", "counts": {"yahoo": 5, "finnhub": 2}, "total": 7},
    )

    texto = comandos.responder("/proveedores")

    assert "7" in texto and "yahoo: 5" in texto and "finnhub: 2" in texto


def test_proveedores_sin_llamadas(monkeypatch):
    monkeypatch.setattr(
        "providers.api_stats.get_today_stats", lambda: {"date": "x", "counts": {}, "total": 0}
    )

    assert "ningún proveedor" in comandos.responder("/proveedores")


def test_status_y_estado_dan_lo_mismo(con_copias):
    assert comandos.responder("/status") == comandos.responder("/estado")


def test_silenciar_y_activar_ya_no_son_comandos():
    for texto in ("/silenciar 2h", "/activar"):
        assert "No conozco" in comandos.responder(texto)
