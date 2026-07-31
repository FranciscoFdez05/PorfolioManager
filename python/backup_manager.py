"""
Backup automático de la base de datos activa.
- Verifica integridad al arrancar (integrity_check + foreign_key_check)
- Si la BD está dañada: intenta reparar; si falla, restaura desde el backup más reciente
- Crea backup diario de TODOS los portfolios (no solo el activo)
- Incluye portfolios.json y JSONs de configuración en el backup diario
- Mantiene los últimos MAX_BACKUPS backups diarios
"""
import json
import re
import sqlite3
import shutil
import logging
from datetime import datetime
from pathlib import Path

_BASE_DIR       = Path(__file__).resolve().parent.parent
_BACKUP_DIR     = _BASE_DIR / "data" / "backups" / "auto"
_PORTFOLIOS_DIR = _BASE_DIR / "data" / "portfolios"
_META_FILE      = _BASE_DIR / "data" / "portfolios.json"
_JSON_DIR       = _BASE_DIR / "data" / "JSON"
MAX_BACKUPS = 14

log = logging.getLogger(__name__)


def _backup_name(db_path: Path) -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    return f"{db_path.stem}_{today}.db"


def _dated_backups(db_stem: str):
    """Backups diarios de ESTE portfolio, ordenados de más antiguo a más reciente.

    No se puede usar glob(f"{stem}_*.db"): el patrón de 'principal' también casa
    con 'principal_recovered_2026-07-30.db' y con los volcados
    'principal_CORRUPTED_*.db'. Esa colisión hacía que la rotación borrase el
    backup recién creado del portfolio activo (ordenaba antes que los
    '_recovered_') y que la restauración eligiese la copia de otro portfolio.
    """
    pattern = re.compile(rf"^{re.escape(db_stem)}_(\d{{4}}-\d{{2}}-\d{{2}})\.db$")
    matches = []
    for path in _BACKUP_DIR.glob(f"{db_stem}_*.db"):
        m = pattern.match(path.name)
        if m:
            matches.append((m.group(1), path))
    return [path for _, path in sorted(matches)]


def _remove_wal_sidecars(db_path: Path):
    """Elimina ficheros -wal/-shm obsoletos. Imprescindible tras sustituir un .db:
    un WAL viejo se re-aplicaría sobre la BD restaurada y la corrompería."""
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(db_path) + suffix)
        try:
            sidecar.unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[backup] No se pudo eliminar {sidecar.name}: {e}")


def check_integrity(db_path: Path) -> bool:
    """Devuelve True si la BD pasa integrity_check y foreign_key_check."""
    conn = None
    try:
        conn = sqlite3.connect(str(db_path), timeout=15)
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if not (result and result[0] == "ok"):
            return False
        fk_errors = conn.execute("PRAGMA foreign_key_check").fetchall()
        return len(fk_errors) == 0
    except Exception as e:
        log.error(f"[backup] Error comprobando integridad de {db_path.name}: {e}")
        return False
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _rotate(db_stem: str):
    """Elimina backups automáticos más antiguos que MAX_BACKUPS."""
    backups = _dated_backups(db_stem)
    today_name = f"{db_stem}_{datetime.now().strftime('%Y-%m-%d')}.db"
    while len(backups) > MAX_BACKUPS:
        oldest = backups.pop(0)
        # Salvaguarda: nunca borrar el backup de hoy, es el único fresco.
        if oldest.name == today_name:
            continue
        try:
            oldest.unlink()
            log.info(f"[backup] Eliminado backup antiguo: {oldest.name}")
        except Exception as e:
            log.warning(f"[backup] No se pudo eliminar {oldest.name}: {e}")


def _checkpoint_and_copy(db_path: Path, backup_path: Path):
    """Copia consistente vía API de backup de SQLite (incluye WAL pendiente)
    a un temporal y rename atómico al destino."""
    tmp = backup_path.with_suffix(".tmp")
    src = dst = None
    try:
        src = sqlite3.connect(str(db_path), timeout=15)
        dst = sqlite3.connect(str(tmp), timeout=15)
        src.backup(dst)
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst.commit()
        dst.close()
        dst = None
        src.close()
        src = None
        tmp.replace(backup_path)
        _remove_wal_sidecars(tmp)
    except Exception:
        if dst is not None:
            try:
                dst.close()
            except Exception:
                pass
        if src is not None:
            try:
                src.close()
            except Exception:
                pass
        tmp.unlink(missing_ok=True)
        _remove_wal_sidecars(tmp)
        raise


def run_startup_backup(db_path: Path):
    """
    Llamar desde portfolios_manager.init_portfolios() después de activar el DB.
    1. Verifica integridad del DB activo. Si falla: repara o restaura desde backup.
    2. Crea backup diario de TODOS los portfolios si no existe uno de hoy.
    3. Guarda backup de configuración (portfolios.json + ajustes + prefs).
    4. Inserta snapshot diario si no existe.
    5. Rota backups antiguos.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return

    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. Integridad del DB activo ─────────────────────────────────────────
    if not check_integrity(db_path):
        log.error(f"[backup] ¡INTEGRIDAD FALLIDA en {db_path.name}! Intentando reparación.")
        repaired = _emergency_repair(db_path)
        if not repaired:
            log.error("[backup] Reparación fallida. Intentando restaurar desde backup automático.")
            _restore_from_latest_auto_backup(db_path)
    else:
        log.info(f"[backup] Integridad OK: {db_path.name}")

    # ── 2. Backup diario de TODOS los portfolios ────────────────────────────
    if _PORTFOLIOS_DIR.exists():
        for db_file in sorted(_PORTFOLIOS_DIR.glob("*.db")):
            backup_path = _BACKUP_DIR / _backup_name(db_file)
            if not backup_path.exists():
                try:
                    _checkpoint_and_copy(db_file, backup_path)
                    log.info(f"[backup] Backup creado: {backup_path.name}")
                except Exception as e:
                    log.error(f"[backup] Error al crear backup de {db_file.name}: {e}")
            _rotate(db_file.stem)

    # ── 3. Backup de configuración ──────────────────────────────────────────
    today = datetime.now().strftime("%Y-%m-%d")
    config_backup = _BACKUP_DIR / f"config_{today}.json"
    if not config_backup.exists():
        _backup_config(config_backup)

    # ── 4. Snapshot diario ──────────────────────────────────────────────────
    _ensure_daily_snapshot(db_path)


def _backup_config(dest: Path):
    """Guarda portfolios.json + ajustes.json + prefs en un único JSON."""
    bundle = {}
    try:
        if _META_FILE.exists():
            bundle["portfolios_meta"] = json.loads(_META_FILE.read_text("utf-8"))
    except Exception:
        pass
    try:
        ajustes_path = _JSON_DIR / "ajustes.json"
        if ajustes_path.exists():
            bundle["ajustes"] = json.loads(ajustes_path.read_text("utf-8"))
    except Exception:
        pass
    try:
        prefs = {}
        for prefs_file in sorted(_JSON_DIR.glob("prefs_*.json")):
            try:
                prefs[prefs_file.stem] = json.loads(prefs_file.read_text("utf-8"))
            except Exception:
                pass
        if prefs:
            bundle["prefs"] = prefs
    except Exception:
        pass

    if not bundle:
        return

    tmp = dest.with_suffix(".tmp")
    try:
        tmp.write_text(json.dumps(bundle, indent=2, ensure_ascii=False), encoding="utf-8")
        tmp.replace(dest)
        log.info(f"[backup] Config backup creado: {dest.name}")
    except Exception as e:
        tmp.unlink(missing_ok=True)
        log.error(f"[backup] Error al crear config backup: {e}")

    # Rotar config backups
    config_backups = sorted(_BACKUP_DIR.glob("config_*.json"))
    while len(config_backups) > MAX_BACKUPS:
        oldest = config_backups.pop(0)
        try:
            oldest.unlink()
        except Exception:
            pass


def _restore_from_latest_auto_backup(db_path: Path):
    """Restaura db_path desde el backup automático válido más reciente."""
    candidates = list(reversed(_dated_backups(db_path.stem)))
    for candidate in candidates:
        if check_integrity(candidate):
            try:
                corrupted_copy = _BACKUP_DIR / f"{db_path.stem}_CORRUPTED_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
                shutil.copy2(str(db_path), str(corrupted_copy))
                shutil.copy2(str(candidate), str(db_path))
                _remove_wal_sidecars(db_path)
                log.info(f"[backup] Restaurado desde backup automático: {candidate.name}")
                return
            except Exception as e:
                log.error(f"[backup] Error restaurando desde {candidate.name}: {e}")
    log.error(f"[backup] No se encontró ningún backup automático válido para {db_path.name}")


def _ensure_daily_snapshot(db_path: Path):
    """Si no existe snapshot del día actual, duplica el último con timestamp de hoy."""
    import time
    conn = None
    try:
        conn = sqlite3.connect(str(db_path), timeout=15)
        conn.row_factory = sqlite3.Row
        now_ts = int(time.time())
        today_start = now_ts - (now_ts % 86400)
        has_today = conn.execute(
            "SELECT 1 FROM portfolio_snapshots WHERE ts >= ? LIMIT 1", (today_start,)
        ).fetchone()
        if not has_today:
            last = conn.execute(
                "SELECT total_value, total_invested FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1"
            ).fetchone()
            if last:
                conn.execute(
                    "INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
                    (now_ts, last["total_value"], last["total_invested"])
                )
                conn.commit()
                log.info(f"[backup] Snapshot diario insertado para {db_path.name}")
    except Exception as e:
        log.warning(f"[backup] No se pudo insertar snapshot diario: {e}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _emergency_repair(db_path: Path) -> bool:
    """Dump + restore para recuperar una BD corrupta. Devuelve True si tuvo éxito."""
    repair_path = db_path.with_suffix(".repair.db")
    corrupted_backup = _BACKUP_DIR / f"{db_path.stem}_CORRUPTED_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    try:
        src = sqlite3.connect(str(db_path), timeout=15)
        dump = list(src.iterdump())
        src.close()

        if repair_path.exists():
            repair_path.unlink()
        dst = sqlite3.connect(str(repair_path), timeout=15)
        dst.executescript("\n".join(dump))
        dst.close()

        if check_integrity(repair_path):
            shutil.copy2(str(db_path), str(corrupted_backup))
            shutil.move(str(repair_path), str(db_path))
            _remove_wal_sidecars(db_path)
            log.info(f"[backup] Reparación automática OK. Corrupta guardada en {corrupted_backup.name}")
            return True
        else:
            log.error("[backup] La reparación automática no pudo resolver la corrupción.")
            repair_path.unlink(missing_ok=True)
            return False
    except Exception as e:
        log.error(f"[backup] Error en reparación de emergencia: {e}")
        repair_path.unlink(missing_ok=True)
        return False
