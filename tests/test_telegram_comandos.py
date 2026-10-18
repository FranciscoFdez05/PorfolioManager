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
def _limpio(datosAislados, tempDb, monkeypatch):
    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    yield
    telegram_notifier.reiniciarParaPruebas()


def _activo(assetId, nombre, simbolo, precio="100,00", cambio="+1,00%", moneda="EUR"):
    writeAssetFile(assetId, {
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
def testPartir(texto, esperado):
    assert comandos.partir(texto) == esperado


def testUnTextoQueNoEsComandoNoSeContesta():
    assert comandos.responder("hola, ¿qué tal?") is None


def testStartLoContestaElListenerNoEsteModulo():
    assert comandos.responder("/start") is None


def testUnComandoDesconocidoRemiteALaAyuda():
    assert "/ayuda" in comandos.responder("/inventado")


def testLaAyudaListaTodosLosComandosDelMenu():
    ayuda = comandos.responder("/ayuda")

    for nombre, _texto in comandos.COMANDOS:
        assert f"/{nombre}" in ayuda


def testTodoComandoDelMenuTieneManejador():
    for nombre, _texto in comandos.COMANDOS:
        assert nombre in comandos._MANEJADORES, f"/{nombre} está en el menú y no hace nada"


def testUnFalloDentroDeUnComandoSeCuentaNoSePropaga(monkeypatch):
    def _cae(_args):
        raise RuntimeError("se rompió")

    monkeypatch.setitem(comandos._MANEJADORES, "ping", _cae)

    assert "se rompió" in comandos.responder("/ping")


def testPing():
    assert "pong" in comandos.responder("/ping")


# ── Activos ───────────────────────────────────────────────────────────────────

def testActivosListaPrecioYVariacion():
    _activo("apple", "Apple", "AAPL", "190,20", "+1,20%", "USD")

    texto = comandos.responder("/activos")

    assert "Apple" in texto and "190,20 USD" in texto and "+1,20%" in texto


def testActivosVacio():
    assert "No hay activos" in comandos.responder("/activos")


def testBuscarActivoPorTickerIdOTrozoDelNombre():
    _activo("apple", "Apple Inc", "AAPL")
    _activo("tesla", "Tesla", "TSLA")

    assert comandos.buscarActivo("aapl")[0]["id"] == "apple"
    assert comandos.buscarActivo("TESLA")[0]["id"] == "tesla"
    assert comandos.buscarActivo("appl")[0]["id"] == "apple"


def testBuscarActivoAmbiguoNoAdivina():
    _activo("apple-a", "Apple A", "AAA")
    _activo("apple-b", "Apple B", "BBB")

    activo, error = comandos.buscarActivo("apple")

    assert activo is None
    assert "Apple A" in error and "Apple B" in error


def testBuscarActivoInexistente():
    activo, error = comandos.buscarActivo("nada")

    assert activo is None and "nada" in error


def testPrecioPideLaCotizacionEnVivo(monkeypatch):
    _activo("apple", "Apple", "AAPL", "100,00")
    monkeypatch.setattr(
        "stores.market_data.fetchAssetQuote",
        lambda *a, **k: ({"price": "123,45", "currency": "EUR", "change": "+0,50%"}, None),
    )

    texto = comandos.responder("/precio aapl")

    assert "123,45 EUR" in texto and "+0,50%" in texto


def testPrecioSinCotizacionCaeAlUltimoGuardado(monkeypatch):
    _activo("apple", "Apple", "AAPL", "100,00")
    monkeypatch.setattr("stores.market_data.fetchAssetQuote", lambda *a, **k: (None, "sin conexión"))

    texto = comandos.responder("/precio apple")

    assert "100,00 EUR" in texto and "en vivo" in texto


# ── Alertas ───────────────────────────────────────────────────────────────────

def testAlertasListaActivasYCuentaLasSaltadas():
    _activo("bitcoin", "Bitcoin", "BTC")
    alertas_store.crear("bitcoin", "sube_a", "70000")
    saltada = alertas_store.crear("bitcoin", "baja_a", "10")
    alertas_store.evaluarActivo("bitcoin", "5")

    texto = comandos.responder("/alertas")

    assert "Bitcoin" in texto and "70.000,00" in texto
    assert "#" + str(saltada["id"]) not in texto
    assert "1 alerta(s) ya saltaron" in texto


def testAlertasVacioDiceDondeSeCrean():
    assert "ficha" in comandos.responder("/alertas")


def testLasAlertasNoSeCreanNiSeBorranDesdeElChat():
    _activo("bitcoin", "Bitcoin", "BTC")
    alerta = alertas_store.crear("bitcoin", "sube_a", "70000")

    for texto in ("/alerta btc > 10", f"/quitaralerta {alerta['id']}"):
        assert "No conozco" in comandos.responder(texto)
    assert len(alertas_store.listar()) == 1


def testComandosYAyudaDanLaMismaLista():
    assert comandos.responder("/comandos") == comandos.responder("/ayuda")
    assert "/status" in comandos.responder("/comandos")


# ── Copias ────────────────────────────────────────────────────────────────────

@pytest.fixture
def conCopias(datosAislados):
    (datosAislados["portfolios"] / "principal.db").write_bytes(b"")
    return datosAislados


def testBackupHaceLaCopiaYLoCuentaUnaSolaVez(conCopias, monkeypatch):
    from routes import backup

    enviados = []
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: enviados.append(texto))
    monkeypatch.setattr(backup, "_escribirBackup", lambda automatico: "backup_01-01-2026_10-00-00.zip")

    texto = comandos.responder("/backup")

    assert "backup_01-01-2026_10-00-00.zip" in texto
    # La respuesta es el mensaje; el aviso genérico de copia creada se salta.
    assert enviados == []


def testBackupQueFallaLoDice(conCopias, monkeypatch):
    from routes import backup

    def _falla(automatico):
        raise OSError("disco lleno")

    monkeypatch.setattr(backup, "_escribirBackup", _falla)

    texto = comandos.responder("/backup")

    assert "disco lleno" in texto


def testBackupConOtraCopiaEnCurso(conCopias, monkeypatch):
    from core.bloqueo import BloqueoOcupado
    from routes import backup

    def _ocupado(*a, **k):
        raise BloqueoOcupado("otra copia")

    monkeypatch.setattr(backup, "crearBackupManual", _ocupado)

    assert "otra copia en curso" in comandos.responder("/backup")


def testBackupsListaLasUltimas(conCopias):
    (conCopias["backups"] / "backup_01-01-2026_10-00-00.zip").write_bytes(b"x" * 2048)
    (conCopias["backups"] / "backup_02-01-2026_10-00-00_auto.zip").write_bytes(b"x" * 2048)

    texto = comandos.responder("/backups")

    assert "2 en total" in texto
    assert texto.index("02-01-2026") < texto.index("01-01-2026"), "la más reciente primero"


def testBackupsSinCopias(conCopias):
    assert "No hay copias" in comandos.responder("/backups")


# ── Servidor ──────────────────────────────────────────────────────────────────

def testEstadoResumeElServidor(conCopias):
    (conCopias["backups"] / "backup_02-01-2026_10-00-00_auto.zip").write_bytes(b"x")

    texto = comandos.responder("/estado")

    assert "PortfolioManager" in texto
    assert "Base de datos: correcta" in texto
    assert "Disco:" in texto
    assert "02/01/2026 10:00" in texto
    assert "Alertas de precio activas: 0" in texto
    assert "Hilos:" in texto


def testProveedores(monkeypatch):
    monkeypatch.setattr(
        "providers.api_stats.getTodayStats",
        lambda: {"date": "2026-01-01", "counts": {"yahoo": 5, "finnhub": 2}, "total": 7},
    )

    texto = comandos.responder("/proveedores")

    assert "7" in texto and "yahoo: 5" in texto and "finnhub: 2" in texto


def testProveedoresSinLlamadas(monkeypatch):
    monkeypatch.setattr(
        "providers.api_stats.getTodayStats", lambda: {"date": "x", "counts": {}, "total": 0}
    )

    assert "ningún proveedor" in comandos.responder("/proveedores")


def testStatusYEstadoDanLoMismo(conCopias):
    assert comandos.responder("/status") == comandos.responder("/estado")


def testSilenciarYActivarYaNoSonComandos():
    for texto in ("/silenciar 2h", "/activar"):
        assert "No conozco" in comandos.responder(texto)
