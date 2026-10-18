"""Comportamiento de las copias automáticas configuradas desde Ajustes.

Desde la 2.1.1 la copia automática es el mismo zip que «Crear backup ahora»,
en `data/backups/` y con `_auto` en el nombre: aparece en la lista de Ajustes y
se restaura desde ahí. Antes iba a `data/backups/auto/` como un `.db` por
portfolio, y nadie la veía.
"""

import json
import sqlite3
import zipfile
from datetime import datetime


def _crearDb(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE datos (valor TEXT)")
    conn.execute("INSERT INTO datos VALUES ('conservado')")
    conn.commit()
    conn.close()


def _preparar(monkeypatch, tmp_path, dias, datosAislados):
    from admin import backup_manager

    (datosAislados["json"] / "ajustes.json").write_text(
        json.dumps({"autoBackupDays": dias, "maxBackups": 50}), encoding="utf-8"
    )
    dbPath = datosAislados["portfolios"] / "principal.db"
    _crearDb(dbPath)

    # backups/auto sigue existiendo para las copias previas a migración y los
    # .db diarios antiguos; se aísla aparte del directorio de los zips.
    auto = datosAislados["backups"] / "auto"
    auto.mkdir()
    monkeypatch.setattr(backup_manager, "_BACKUP_DIR", auto)
    monkeypatch.setattr(backup_manager, "_JSON_DIR", datosAislados["json"])
    return backup_manager, dbPath, datosAislados["backups"]


def testAutoBackupDesactivadoNoCreaCopias(monkeypatch, tmp_path, datosAislados):
    manager, dbPath, backups = _preparar(monkeypatch, tmp_path, 0, datosAislados)

    assert manager.runStartupBackup(dbPath) is False
    assert list(backups.glob("*.zip")) == []


def testAutoBackupCreaElMismoZipQueElBoton(monkeypatch, tmp_path, datosAislados):
    """La copia tiene que salir donde la lista de Ajustes la enseña y con todo dentro."""
    from routes.backup import _listBackups

    manager, dbPath, backups = _preparar(monkeypatch, tmp_path, 7, datosAislados)

    assert manager.runStartupBackup(dbPath) is True
    copias = list(backups.glob("backup_*_auto.zip"))
    assert len(copias) == 1
    # Es la que ve /api/backups, y por tanto se puede restaurar desde Ajustes.
    assert _listBackups() == [copias[0].name]
    with zipfile.ZipFile(copias[0]) as zf:
        assert "portfolios/principal.db" in zf.namelist()
        assert "ajustes.json" in zf.namelist()
        assert "manifest.json" in zf.namelist()
    # Y no queda nada del formato antiguo.
    assert list((backups / "auto").glob("*.db")) == []

    # La segunda comprobación no crea otra copia hasta cumplir los siete días.
    assert manager.runStartupBackup(dbPath) is False
    assert list(backups.glob("backup_*.zip")) == copias


def testUnaCopiaManualNoCuentaComoAutomatica(monkeypatch, tmp_path, datosAislados):
    """Con «cada día», que el usuario haya pulsado el botón no aplaza la del scheduler."""
    manager, dbPath, backups = _preparar(monkeypatch, tmp_path, 1, datosAislados)
    hoy = datetime.now().strftime("%d-%m-%Y")
    (backups / f"backup_{hoy}_09-00-00.zip").write_bytes(b"")

    assert manager.runStartupBackup(dbPath) is True
    assert len(list(backups.glob("backup_*_auto.zip"))) == 1


def testUnDbDiarioAntiguoDeHoyAplazaLaCopia(monkeypatch, tmp_path, datosAislados):
    """Al actualizar desde la 2.1.0, la primera pasada no debe duplicar la copia de hoy."""
    manager, dbPath, backups = _preparar(monkeypatch, tmp_path, 1, datosAislados)
    hoy = datetime.now().strftime("%Y-%m-%d")
    (backups / "auto" / f"principal_{hoy}.db").write_bytes(b"")

    assert manager.runStartupBackup(dbPath) is False
    assert list(backups.glob("backup_*_auto.zip")) == []


def testUnaBdDanadaSeRecuperaDelZipMasReciente(monkeypatch, tmp_path, datosAislados):
    """El camino de emergencia del arranque tiene que saber leer el formato nuevo."""
    manager, dbPath, backups = _preparar(monkeypatch, tmp_path, 7, datosAislados)
    assert manager.runStartupBackup(dbPath) is True

    # Reparación imposible: que no quede más salida que restaurar.
    monkeypatch.setattr(manager, "_emergencyRepair", lambda ruta: False)
    dbPath.write_bytes(b"esto no es una base de datos" * 100)
    assert manager.checkIntegrity(dbPath) is False

    manager._restoreFromLatestAutoBackup(dbPath)

    conn = sqlite3.connect(dbPath)
    try:
        assert conn.execute("SELECT valor FROM datos").fetchone()[0] == "conservado"
    finally:
        conn.close()
    assert list((backups / "auto").glob("principal_CORRUPTED_*.db"))


def _conTelegram(monkeypatch):
    from core import telegram_notifier

    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciarParaPruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    return mensajes


def testUnaBdDanadaQueSeRestauraSeCuentaPorTelegram(monkeypatch, tmp_path, datosAislados):
    manager, dbPath, _backups = _preparar(monkeypatch, tmp_path, 7, datosAislados)
    assert manager.runStartupBackup(dbPath) is True
    mensajes = _conTelegram(monkeypatch)

    monkeypatch.setattr(manager, "_emergencyRepair", lambda ruta: False)
    dbPath.write_bytes(b"esto no es una base de datos" * 100)
    manager.runStartupBackup(dbPath)

    assert len(mensajes) == 1
    assert "no se pudo reparar" in mensajes[0] and "restaurado" in mensajes[0]


def testUnaBdDanadaSinNingunaCopiaLoDice(monkeypatch, tmp_path, datosAislados):
    manager, dbPath, _backups = _preparar(monkeypatch, tmp_path, 0, datosAislados)
    mensajes = _conTelegram(monkeypatch)

    monkeypatch.setattr(manager, "_emergencyRepair", lambda ruta: False)
    dbPath.write_bytes(b"esto no es una base de datos" * 100)
    manager.runStartupBackup(dbPath)

    assert len(mensajes) == 1 and "intervenir a mano" in mensajes[0]


def testUnaBdReparadaSeCuentaPorTelegram(monkeypatch, tmp_path, datosAislados):
    manager, dbPath, _backups = _preparar(monkeypatch, tmp_path, 0, datosAislados)
    mensajes = _conTelegram(monkeypatch)

    monkeypatch.setattr(manager, "_estadoIntegridad", lambda ruta: "dañada")
    monkeypatch.setattr(manager, "_emergencyRepair", lambda ruta: True)
    manager.runStartupBackup(dbPath)

    assert len(mensajes) == 1 and "reparado sola" in mensajes[0]


def testUnaBdSanaNoMandaNada(monkeypatch, tmp_path, datosAislados):
    manager, dbPath, _backups = _preparar(monkeypatch, tmp_path, 0, datosAislados)
    mensajes = _conTelegram(monkeypatch)

    manager.runStartupBackup(dbPath)

    assert mensajes == []


def testUnaBdOcupadaNoSeTomaPorDañada(monkeypatch, tmp_path, datosAislados):
    manager, dbPath, _backups = _preparar(monkeypatch, tmp_path, 0, datosAislados)
    mensajes = _conTelegram(monkeypatch)
    llamadas = []

    monkeypatch.setattr(manager, "_estadoIntegridad", lambda ruta: "ocupada")
    monkeypatch.setattr(manager, "_emergencyRepair", lambda ruta: llamadas.append(ruta) or True)
    monkeypatch.setattr(manager, "_restoreFromLatestAutoBackup", lambda ruta: llamadas.append(ruta) or True)
    manager.runStartupBackup(dbPath)

    assert llamadas == [] and mensajes == []


def testLaRestauracionSaltaCopiasDañadas(monkeypatch, tmp_path, datosAislados):
    manager, dbPath, _backups = _preparar(monkeypatch, tmp_path, 0, datosAislados)
    import shutil
    buena = tmp_path / "buena.db"
    shutil.copy2(str(dbPath), str(buena))
    mala = tmp_path / "mala.db"
    mala.write_bytes(b"basura" * 200)
    dbPath.write_bytes(b"roto" * 200)

    monkeypatch.setattr(manager, "_candidatosDeRestauracion", lambda stem: iter([("mala", mala), ("buena", buena)]))

    assert manager._restoreFromLatestAutoBackup(dbPath) is True
    assert manager.checkIntegrity(dbPath) is True
