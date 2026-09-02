"""
Backup automático de la base de datos activa.
- Verifica integridad al arrancar (integrity_check + foreign_key_check)
- Si la BD está dañada: intenta reparar; si falla, restaura desde el backup más reciente
- Crea backup diario de TODOS los portfolios (no solo el activo)
- Incluye portfolios.json y JSONs de configuración en el backup diario
- Mantiene los últimos [backups] max_copias backups diarios (config.ini)
"""
import json
import logging
import re
import shutil
import sqlite3
import threading
import time
from datetime import datetime
from pathlib import Path

from core import paths, settings
from core.bloqueo import exclusivo
from core.escritura import escribirJsonAtomico, temporalPara
from core.paths import (
    AUTO_BACKUPS_DIR as _BACKUP_DIR,
    JSON_DIR as _JSON_DIR,
    PORTFOLIOS_DIR as _PORTFOLIOS_DIR,
    PORTFOLIOS_META_FILE as _META_FILE,
)

log = logging.getLogger(__name__)

# El scheduler puede coexistir con una creación durante el arranque. Serializar
# ambos evita que dos copias SQLite escriban el mismo temporal a la vez.
_AUTO_BACKUP_LOCK = threading.Lock()
_scheduler_thread = None
_scheduler_started = False


def _configured_backup_days() -> int:
    """Frecuencia elegida en Ajustes, con 0 como desactivado."""
    try:
        raw = json.loads((_JSON_DIR / "ajustes.json").read_text("utf-8"))
        return max(0, min(365, int(raw.get("autoBackupDays") or 0))) if isinstance(raw, dict) else 0
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return 0


def _last_backup_date():
    """Fecha de la última copia automática válida, de cualquier portfolio."""
    latest = None
    if not _BACKUP_DIR.exists():
        return None
    for path in _BACKUP_DIR.glob("*.db"):
        match = re.match(r"^.+_(\d{4}-\d{2}-\d{2})\.db$", path.name)
        if match:
            try:
                value = datetime.strptime(match.group(1), "%Y-%m-%d").date()
            except ValueError:
                continue
            latest = max(latest, value) if latest else value
    return latest


def _backup_is_due() -> bool:
    days = _configured_backup_days()
    if days <= 0:
        return False
    last = _last_backup_date()
    return last is None or (datetime.now().date() - last).days >= days


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
        conn = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
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
    """Elimina los backups automáticos que sobran, según [backups] max_copias."""
    backups = _dated_backups(db_stem)
    today_name = f"{db_stem}_{datetime.now().strftime('%Y-%m-%d')}.db"
    while len(backups) > settings.maxCopiasBackup():
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
    a un temporal y rename atómico al destino.

    El temporal ya no se llama `<destino>.tmp`: ese nombre es el mismo en todos
    los procesos, y los dos workers de gunicorn hacen esta copia a la vez al
    arrancar y en cada comprobación horaria. Escribían el mismo fichero desde
    dos procesos y renombraban encima la mezcla.
    """
    with temporalPara(backup_path) as tmp:
        src = dst = None
        try:
            src = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
            dst = sqlite3.connect(str(tmp), timeout=settings.backupSqliteTimeout())
            src.backup(dst)
            dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            dst.commit()
            dst.close()
            dst = None
            src.close()
            src = None
            tmp.replace(backup_path)
        finally:
            for conn in (dst, src):
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass


def backup_previo_a_migracion(db_path: Path, desde: int, hasta: int):
    """Copia de seguridad justo antes de subir el esquema. Devuelve la ruta o None.

    Ya existe un backup diario que se hace al arrancar (`run_startup_backup`) y
    que, por el orden en que server.py llama a las cosas, siempre es anterior a
    las migraciones. Lo que no da es un punto de retorno **identificable**: se
    llama `<portfolio>_2026-08-25.db` igual que los otros, así que para volver
    atrás hay que adivinar cuál se hizo antes del salto, y la rotación de
    `[backups] max_copias` acaba borrándolo si el problema tarda unos días en
    aparecer.

    Esta copia se hace solo cuando de verdad va a migrar, lleva el salto en el
    nombre y **queda fuera de la rotación**: `_dated_backups()` solo reconoce el
    patrón `<stem>_AAAA-MM-DD.db`, y este no encaja, así que nunca se elige para
    borrar. Son unos pocos ficheros en la vida del proyecto, uno por cada
    versión del esquema.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return None

    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    marca = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    destino = _BACKUP_DIR / f"{db_path.stem}_pre-esquema-{desde}-a-{hasta}_{marca}.db"

    _checkpoint_and_copy(db_path, destino)
    return destino


def run_startup_backup(db_path: Path):
    """Comprueba el DB y crea una copia automática cuando toca.

    La frecuencia de Ajustes se respeta al arrancar y desde el scheduler. Antes
    este método copiaba siempre y server.py añadía otro mecanismo incompatible
    que solo copiaba el portfolio activo.

    1. Verifica integridad del DB activo. Si falla: repara o restaura desde backup.
    2. Cuando corresponde, crea backup de TODOS los portfolios.
    3. Guarda backup de configuración (portfolios.json + ajustes + prefs).
    4. Inserta snapshot diario si no existe.
    5. Rota backups antiguos.
    """
    db_path = Path(db_path)
    if not db_path.exists():
        return

    # Un intento sin espera. Los dos workers de gunicorn llegan aquí a la vez
    # —al importar server.py y en cada comprobación horaria— y hasta ahora los
    # dos verificaban, reparaban, copiaban y rotaban los mismos ficheros en
    # paralelo. Basta con que lo haga uno: el que no consiga el bloqueo se lo
    # salta, porque el trabajo es el mismo y ya se está haciendo.
    with exclusivo(_ruta_bloqueo(), obligatorio=False) as conseguido:
        if not conseguido:
            log.info("[backup] Otro proceso está con la copia automática; se omite.")
            return False
        return _run_startup_backup_locked(db_path)


def _run_startup_backup_locked(db_path: Path):
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

    if not _backup_is_due():
        return False

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
    return True


def check_scheduled_backup():
    """Comprueba la frecuencia sin depender de reiniciar el servidor.

    El `threading.Lock` serializa los hilos de este proceso; de los otros
    workers se encarga el bloqueo de fichero de `run_startup_backup`.
    """
    from core.db import get_active_db_path

    with _AUTO_BACKUP_LOCK:
        try:
            return run_startup_backup(get_active_db_path())
        except Exception as e:
            # Un fallo de I/O no debe matar el hilo; se reintentará después.
            log.error("[backup] Comprobación automática fallida: %s", e)
            return False


def _ruta_bloqueo():
    """Fichero de bloqueo de las copias automáticas, común a todos los workers.

    Se lee de `paths` en cada llamada para que los tests, que redirigen los
    directorios de datos, no acaben coordinándose sobre el `data/` real.
    """
    return paths.TMP_DIR / "backup-automatico.lock"


def _scheduler_loop(interval_seconds: int):
    while True:
        time.sleep(interval_seconds)
        check_scheduled_backup()


def start_scheduler(interval_seconds: int = 3600):
    """Inicia una única comprobación horaria de las copias automáticas."""
    global _scheduler_started, _scheduler_thread
    if _scheduler_started:
        return
    _scheduler_started = True
    _scheduler_thread = threading.Thread(
        target=_scheduler_loop,
        args=(max(60, int(interval_seconds)),),
        name="backup-scheduler",
        daemon=True,
    )
    _scheduler_thread.start()


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

    try:
        escribirJsonAtomico(dest, bundle)
        log.info(f"[backup] Config backup creado: {dest.name}")
    except OSError as e:
        log.error(f"[backup] Error al crear config backup: {e}")

    # Rotar config backups
    config_backups = sorted(_BACKUP_DIR.glob("config_*.json"))
    while len(config_backups) > settings.maxCopiasBackup():
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
        conn = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
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
    """Dump + restore para recuperar una BD corrupta. Devuelve True si tuvo éxito.

    La base reconstruida se arma en `data/tmp` y no como `<portfolio>.repair.db`
    junto a la original: allí la habría visto como un portfolio más cualquiera de
    los `glob("*.db")` del proyecto, y el nombre era además el mismo para los dos
    workers de gunicorn, que llegan aquí a la vez cuando una base está dañada.
    """
    corrupted_backup = _BACKUP_DIR / f"{db_path.stem}_CORRUPTED_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    with temporalPara(db_path, directorio=paths.TMP_DIR) as repair_path:
        return _reparar_en(db_path, repair_path, corrupted_backup)


def _reparar_en(db_path: Path, repair_path: Path, corrupted_backup: Path) -> bool:
    """El trabajo de _emergency_repair, ya con el temporal reservado."""
    try:
        src = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
        dump = list(src.iterdump())
        src.close()

        if repair_path.exists():
            repair_path.unlink()
        dst = sqlite3.connect(str(repair_path), timeout=settings.backupSqliteTimeout())
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
