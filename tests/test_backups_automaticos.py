"""Comportamiento de las copias automáticas configuradas desde Ajustes."""

import json
import sqlite3


def _crear_db(path):
    conn = sqlite3.connect(path)
    conn.execute("CREATE TABLE datos (valor TEXT)")
    conn.execute("INSERT INTO datos VALUES ('conservado')")
    conn.commit()
    conn.close()


def _preparar(monkeypatch, tmp_path, dias):
    from admin import backup_manager
    from core import paths

    portfolios = tmp_path / "portfolios"
    backups = tmp_path / "backups" / "auto"
    json_dir = tmp_path / "JSON"
    portfolios.mkdir(parents=True)
    backups.mkdir(parents=True)
    json_dir.mkdir()
    (json_dir / "ajustes.json").write_text(json.dumps({"autoBackupDays": dias}), encoding="utf-8")
    db_path = portfolios / "principal.db"
    _crear_db(db_path)

    monkeypatch.setattr(backup_manager, "_PORTFOLIOS_DIR", portfolios)
    monkeypatch.setattr(backup_manager, "_BACKUP_DIR", backups)
    monkeypatch.setattr(backup_manager, "_JSON_DIR", json_dir)
    monkeypatch.setattr(backup_manager, "_META_FILE", tmp_path / "portfolios.json")
    # El bloqueo entre workers vive en data/tmp: sin redirigirlo, la suite
    # dejaría su fichero en el data/ real del usuario.
    monkeypatch.setattr(paths, "TMP_DIR", tmp_path / "tmp", raising=False)
    return backup_manager, db_path, backups


def test_auto_backup_desactivado_no_crea_copias(monkeypatch, tmp_path):
    manager, db_path, backups = _preparar(monkeypatch, tmp_path, dias=0)

    assert manager.run_startup_backup(db_path) is False
    assert list(backups.glob("principal_*.db")) == []


def test_auto_backup_crea_una_copia_y_respeta_la_frecuencia(monkeypatch, tmp_path):
    manager, db_path, backups = _preparar(monkeypatch, tmp_path, dias=7)

    assert manager.run_startup_backup(db_path) is True
    copias = list(backups.glob("principal_*.db"))
    assert len(copias) == 1

    # La segunda comprobación no crea otra copia hasta cumplir los siete días.
    assert manager.run_startup_backup(db_path) is False
    assert list(backups.glob("principal_*.db")) == copias
