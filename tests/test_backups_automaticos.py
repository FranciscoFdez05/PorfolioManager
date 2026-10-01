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


def _crear_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE datos (valor TEXT)")
    conn.execute("INSERT INTO datos VALUES ('conservado')")
    conn.commit()
    conn.close()


def _preparar(monkeypatch, tmp_path, dias, datos_aislados):
    from admin import backup_manager

    (datos_aislados["json"] / "ajustes.json").write_text(
        json.dumps({"autoBackupDays": dias, "maxBackups": 50}), encoding="utf-8"
    )
    db_path = datos_aislados["portfolios"] / "principal.db"
    _crear_db(db_path)

    # backups/auto sigue existiendo para las copias previas a migración y los
    # .db diarios antiguos; se aísla aparte del directorio de los zips.
    auto = datos_aislados["backups"] / "auto"
    auto.mkdir()
    monkeypatch.setattr(backup_manager, "_BACKUP_DIR", auto)
    monkeypatch.setattr(backup_manager, "_JSON_DIR", datos_aislados["json"])
    return backup_manager, db_path, datos_aislados["backups"]


def test_auto_backup_desactivado_no_crea_copias(monkeypatch, tmp_path, datos_aislados):
    manager, db_path, backups = _preparar(monkeypatch, tmp_path, 0, datos_aislados)

    assert manager.run_startup_backup(db_path) is False
    assert list(backups.glob("*.zip")) == []


def test_auto_backup_crea_el_mismo_zip_que_el_boton(monkeypatch, tmp_path, datos_aislados):
    """La copia tiene que salir donde la lista de Ajustes la enseña y con todo dentro."""
    from routes.backup import _list_backups

    manager, db_path, backups = _preparar(monkeypatch, tmp_path, 7, datos_aislados)

    assert manager.run_startup_backup(db_path) is True
    copias = list(backups.glob("backup_*_auto.zip"))
    assert len(copias) == 1
    # Es la que ve /api/backups, y por tanto se puede restaurar desde Ajustes.
    assert _list_backups() == [copias[0].name]
    with zipfile.ZipFile(copias[0]) as zf:
        assert "portfolios/principal.db" in zf.namelist()
        assert "ajustes.json" in zf.namelist()
        assert "manifest.json" in zf.namelist()
    # Y no queda nada del formato antiguo.
    assert list((backups / "auto").glob("*.db")) == []

    # La segunda comprobación no crea otra copia hasta cumplir los siete días.
    assert manager.run_startup_backup(db_path) is False
    assert list(backups.glob("backup_*.zip")) == copias


def test_una_copia_manual_no_cuenta_como_automatica(monkeypatch, tmp_path, datos_aislados):
    """Con «cada día», que el usuario haya pulsado el botón no aplaza la del scheduler."""
    manager, db_path, backups = _preparar(monkeypatch, tmp_path, 1, datos_aislados)
    hoy = datetime.now().strftime("%d-%m-%Y")
    (backups / f"backup_{hoy}_09-00-00.zip").write_bytes(b"")

    assert manager.run_startup_backup(db_path) is True
    assert len(list(backups.glob("backup_*_auto.zip"))) == 1


def test_un_db_diario_antiguo_de_hoy_aplaza_la_copia(monkeypatch, tmp_path, datos_aislados):
    """Al actualizar desde la 2.1.0, la primera pasada no debe duplicar la copia de hoy."""
    manager, db_path, backups = _preparar(monkeypatch, tmp_path, 1, datos_aislados)
    hoy = datetime.now().strftime("%Y-%m-%d")
    (backups / "auto" / f"principal_{hoy}.db").write_bytes(b"")

    assert manager.run_startup_backup(db_path) is False
    assert list(backups.glob("backup_*_auto.zip")) == []


def test_una_bd_danada_se_recupera_del_zip_mas_reciente(monkeypatch, tmp_path, datos_aislados):
    """El camino de emergencia del arranque tiene que saber leer el formato nuevo."""
    manager, db_path, backups = _preparar(monkeypatch, tmp_path, 7, datos_aislados)
    assert manager.run_startup_backup(db_path) is True

    # Reparación imposible: que no quede más salida que restaurar.
    monkeypatch.setattr(manager, "_emergency_repair", lambda ruta: False)
    db_path.write_bytes(b"esto no es una base de datos" * 100)
    assert manager.check_integrity(db_path) is False

    manager._restore_from_latest_auto_backup(db_path)

    conn = sqlite3.connect(db_path)
    try:
        assert conn.execute("SELECT valor FROM datos").fetchone()[0] == "conservado"
    finally:
        conn.close()
    assert list((backups / "auto").glob("principal_CORRUPTED_*.db"))


def _con_telegram(monkeypatch):
    from core import telegram_notifier

    monkeypatch.setenv("SECRET_KEY", "clave-de-pruebas-0123456789abcdef0123456789abcdef")
    telegram_notifier.reiniciar_para_pruebas()
    telegram_notifier.escribirConfig("123456:ABC-token", "987654321")
    mensajes = []
    monkeypatch.setattr(telegram_notifier, "_enviar", lambda token, chat, texto: mensajes.append(texto))
    return mensajes


def test_una_bd_danada_que_se_restaura_se_cuenta_por_telegram(monkeypatch, tmp_path, datos_aislados):
    manager, db_path, _backups = _preparar(monkeypatch, tmp_path, 7, datos_aislados)
    assert manager.run_startup_backup(db_path) is True
    mensajes = _con_telegram(monkeypatch)

    monkeypatch.setattr(manager, "_emergency_repair", lambda ruta: False)
    db_path.write_bytes(b"esto no es una base de datos" * 100)
    manager.run_startup_backup(db_path)

    assert len(mensajes) == 1
    assert "no se pudo reparar" in mensajes[0] and "restaurado" in mensajes[0]


def test_una_bd_danada_sin_ninguna_copia_lo_dice(monkeypatch, tmp_path, datos_aislados):
    manager, db_path, _backups = _preparar(monkeypatch, tmp_path, 0, datos_aislados)
    mensajes = _con_telegram(monkeypatch)

    monkeypatch.setattr(manager, "_emergency_repair", lambda ruta: False)
    db_path.write_bytes(b"esto no es una base de datos" * 100)
    manager.run_startup_backup(db_path)

    assert len(mensajes) == 1 and "intervenir a mano" in mensajes[0]


def test_una_bd_reparada_se_cuenta_por_telegram(monkeypatch, tmp_path, datos_aislados):
    manager, db_path, _backups = _preparar(monkeypatch, tmp_path, 0, datos_aislados)
    mensajes = _con_telegram(monkeypatch)

    monkeypatch.setattr(manager, "_estado_integridad", lambda ruta: "dañada")
    monkeypatch.setattr(manager, "_emergency_repair", lambda ruta: True)
    manager.run_startup_backup(db_path)

    assert len(mensajes) == 1 and "reparado sola" in mensajes[0]


def test_una_bd_sana_no_manda_nada(monkeypatch, tmp_path, datos_aislados):
    manager, db_path, _backups = _preparar(monkeypatch, tmp_path, 0, datos_aislados)
    mensajes = _con_telegram(monkeypatch)

    manager.run_startup_backup(db_path)

    assert mensajes == []


def test_una_bd_ocupada_no_se_toma_por_dañada(monkeypatch, tmp_path, datos_aislados):
    manager, db_path, _backups = _preparar(monkeypatch, tmp_path, 0, datos_aislados)
    mensajes = _con_telegram(monkeypatch)
    llamadas = []

    monkeypatch.setattr(manager, "_estado_integridad", lambda ruta: "ocupada")
    monkeypatch.setattr(manager, "_emergency_repair", lambda ruta: llamadas.append(ruta) or True)
    monkeypatch.setattr(manager, "_restore_from_latest_auto_backup", lambda ruta: llamadas.append(ruta) or True)
    manager.run_startup_backup(db_path)

    assert llamadas == [] and mensajes == []


def test_la_restauracion_salta_copias_dañadas(monkeypatch, tmp_path, datos_aislados):
    manager, db_path, _backups = _preparar(monkeypatch, tmp_path, 0, datos_aislados)
    import shutil
    buena = tmp_path / "buena.db"
    shutil.copy2(str(db_path), str(buena))
    mala = tmp_path / "mala.db"
    mala.write_bytes(b"basura" * 200)
    db_path.write_bytes(b"roto" * 200)

    monkeypatch.setattr(manager, "_candidatos_de_restauracion", lambda stem: iter([("mala", mala), ("buena", buena)]))

    assert manager._restore_from_latest_auto_backup(db_path) is True
    assert manager.check_integrity(db_path) is True
