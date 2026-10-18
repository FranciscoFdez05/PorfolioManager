"""
Backup automático de la base de datos activa.
- Verifica integridad al arrancar (integrity_check + foreign_key_check)
- Si la BD está dañada: intenta reparar; si falla, restaura desde el backup más reciente
- Cuando toca según la frecuencia de Ajustes, crea la misma copia completa que
  «Crear backup ahora» (todos los portfolios, ajustes y preferencias), con
  `_auto` en el nombre, en data/backups/: aparece en la lista de Ajustes y se
  restaura desde ahí. La rotación es la de «Límite de backups».
- data/backups/auto/ queda para las copias previas a una migración de esquema
  (exentas de rotación) y para los `.db` diarios de versiones anteriores, que
  se siguen leyendo como último recurso si la BD activa aparece dañada.
"""
import json
import logging
import re
import shutil
import sqlite3
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path

from core import paths, settings, telegram_notifier
from core.bloqueo import exclusivo
from core.copia_sqlite import copiar as copiarSqlite
from core.escritura import temporalPara
from core.paths import (
    AUTO_BACKUPS_DIR as _BACKUP_DIR,
    JSON_DIR as _JSON_DIR,
)

log = logging.getLogger(__name__)

# El scheduler puede coexistir con una creación durante el arranque. Serializar
# ambos evita que dos copias SQLite escriban el mismo temporal a la vez.
_AUTO_BACKUP_LOCK = threading.Lock()
_schedulerThread = None
_schedulerStarted = False


def _configuredBackupDays() -> int:
    """Frecuencia elegida en Ajustes, con 0 como desactivado."""
    try:
        raw = json.loads((_JSON_DIR / "ajustes.json").read_text("utf-8"))
        return max(0, min(365, int(raw.get("autoBackupDays") or 0))) if isinstance(raw, dict) else 0
    except (OSError, ValueError, TypeError, json.JSONDecodeError):
        return 0


def _lastBackupDate():
    """Fecha de la última copia automática, en cualquiera de sus dos formatos.

    Los zips `backup_<fecha>_auto.zip` de data/backups/ son los actuales; los
    `<portfolio>_AAAA-MM-DD.db` de data/backups/auto/ los hacía la versión
    anterior. Se miran los dos para que, al actualizar, la primera pasada no
    haga una copia de más si ya había una de hoy.
    """
    fechas = []
    for path in paths.BACKUPS_DIR.glob("backup_*_auto.zip"):
        match = re.match(r"^backup_(\d{2}-\d{2}-\d{4})_\d{2}-\d{2}-\d{2}_auto\.zip$", path.name)
        if match:
            try:
                fechas.append(datetime.strptime(match.group(1), "%d-%m-%Y").date())
            except ValueError:
                pass
    if _BACKUP_DIR.exists():
        for path in _BACKUP_DIR.glob("*.db"):
            match = re.match(r"^.+_(\d{4}-\d{2}-\d{2})\.db$", path.name)
            if match:
                try:
                    fechas.append(datetime.strptime(match.group(1), "%Y-%m-%d").date())
                except ValueError:
                    pass
    return max(fechas) if fechas else None


def _backupIsDue() -> bool:
    days = _configuredBackupDays()
    if days <= 0:
        return False
    last = _lastBackupDate()
    return last is None or (datetime.now().date() - last).days >= days


def _datedBackups(dbStem: str):
    """Backups diarios de ESTE portfolio, ordenados de más antiguo a más reciente.

    No se puede usar glob(f"{stem}_*.db"): el patrón de 'principal' también casa
    con 'principal_recovered_2026-07-30.db' y con los volcados
    'principal_CORRUPTED_*.db'. Esa colisión hacía que la rotación borrase el
    backup recién creado del portfolio activo (ordenaba antes que los
    '_recovered_') y que la restauración eligiese la copia de otro portfolio.
    """
    pattern = re.compile(rf"^{re.escape(dbStem)}_(\d{{4}}-\d{{2}}-\d{{2}})\.db$")
    matches = []
    for path in _BACKUP_DIR.glob(f"{dbStem}_*.db"):
        m = pattern.match(path.name)
        if m:
            matches.append((m.group(1), path))
    return [path for _, path in sorted(matches)]


def _removeWalSidecars(dbPath: Path):
    """Elimina ficheros -wal/-shm obsoletos. Imprescindible tras sustituir un .db:
    un WAL viejo se re-aplicaría sobre la BD restaurada y la corrompería."""
    for suffix in ("-wal", "-shm"):
        sidecar = Path(str(dbPath) + suffix)
        try:
            sidecar.unlink(missing_ok=True)
        except Exception as e:
            log.warning(f"[backup] No se pudo eliminar {sidecar.name}: {e}")


def _estadoIntegridad(dbPath: Path) -> str:
    """'ok', 'dañada' u 'ocupada'.

    Distinguir la última importa: «database is locked» no dice nada sobre el
    contenido del fichero, y tratarlo como corrupción hacía que un pico de
    escritura de otro worker disparase una reparación —o una restauración— sobre
    una base perfectamente sana. Se reintenta unas veces y, si sigue ocupada, se
    devuelve 'ocupada' para que quien llama la deje en paz hasta la próxima pasada.
    """
    ultimoError = None
    for intento in range(3):
        conn = None
        try:
            conn = sqlite3.connect(str(dbPath), timeout=settings.backupSqliteTimeout())
            result = conn.execute("PRAGMA integrity_check").fetchone()
            if not (result and result[0] == "ok"):
                return "dañada"
            return "ok" if not conn.execute("PRAGMA foreign_key_check").fetchall() else "dañada"
        except sqlite3.OperationalError as e:
            ultimoError = e
            texto = str(e).lower()
            if "locked" in texto or "busy" in texto:
                time.sleep(1 + intento)
                continue
            log.error(f"[backup] Error comprobando integridad de {dbPath.name}: {e}")
            return "dañada"
        except Exception as e:
            log.error(f"[backup] Error comprobando integridad de {dbPath.name}: {e}")
            return "dañada"
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    log.warning(f"[backup] {dbPath.name} sigue ocupada, no se puede comprobar: {ultimoError}")
    return "ocupada"


def checkIntegrity(dbPath: Path) -> bool:
    """Devuelve True si la BD pasa integrity_check y foreign_key_check."""
    return _estadoIntegridad(dbPath) == "ok"


def problemaDePortfolio(dbPath: Path, exigirActivos: bool = True) -> str | None:
    """Motivo por el que un .db subido no puede ocupar el lugar de un portfolio.

    None si es una base SQLite íntegra con la tabla `activos`. Lo comparten
    «Importar cartera» e «Importar ZIP»: el segundo aceptaba cualquier SQLite
    —incluida una vacía— y con ella sustituía la cartera activa entera.

    `exigir_activos=False` lo usa la restauración de una copia completa: ahí
    cada base sale de una copia de esta misma aplicación y lo que faltaba era
    comprobar que fuese legible entera (antes solo se miraba la cabecera).
    """
    try:
        with open(dbPath, "rb") as f:
            if not f.read(16).startswith(b"SQLite format 3\x00"):
                return "El fichero no es una base de datos SQLite"
    except OSError as e:
        return f"No se pudo leer la base de datos: {e}"

    conn = None
    try:
        conn = sqlite3.connect(str(dbPath), timeout=settings.backupSqliteTimeout())
        # El fichero viene de fuera (una copia, un ZIP de otra persona): que su
        # esquema no pueda ejecutar funciones desde vistas o disparadores
        # mientras se inspecciona.
        conn.execute("PRAGMA trusted_schema=OFF")
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if not result or result[0] != "ok":
            return "La base de datos está corrupta"
        if exigirActivos and not conn.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='activos'"
        ).fetchone():
            return "El fichero no es un portfolio de esta aplicación"
    except sqlite3.DatabaseError as e:
        return f"La base de datos no se puede abrir: {e}"
    finally:
        if conn is not None:
            conn.close()
    return None


def _checkpointAndCopy(dbPath: Path, backupPath: Path):
    """Copia consistente vía API de backup de SQLite (incluye WAL pendiente)
    a un temporal y rename atómico al destino.

    El temporal ya no se llama `<destino>.tmp`: ese nombre es el mismo en todos
    los procesos, y los dos workers de gunicorn hacen esta copia a la vez al
    arrancar y en cada comprobación horaria. Escribían el mismo fichero desde
    dos procesos y renombraban encima la mezcla.
    """
    with temporalPara(backupPath) as tmp:
        copiarSqlite(dbPath, tmp)
        tmp.replace(backupPath)


def backupPrevioAMigracion(dbPath: Path, desde: int, hasta: int):
    """Copia de seguridad justo antes de subir el esquema. Devuelve la ruta o None.

    Ya existe un backup diario que se hace al arrancar (`runStartupBackup`) y
    que, por el orden en que server.py llama a las cosas, siempre es anterior a
    las migraciones. Lo que no da es un punto de retorno **identificable**: se
    llama `<portfolio>_2026-08-25.db` igual que los otros, así que para volver
    atrás hay que adivinar cuál se hizo antes del salto, y la rotación de
    `[backups] max_copias` acaba borrándolo si el problema tarda unos días en
    aparecer.

    Esta copia se hace solo cuando de verdad va a migrar, lleva el salto en el
    nombre y **queda fuera de la rotación**: `_datedBackups()` solo reconoce el
    patrón `<stem>_AAAA-MM-DD.db`, y este no encaja, así que nunca se elige para
    borrar. Son unos pocos ficheros en la vida del proyecto, uno por cada
    versión del esquema.
    """
    dbPath = Path(dbPath)
    if not dbPath.exists():
        return None

    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    marca = datetime.now().strftime("%Y-%m-%d_%H%M%S")
    destino = _BACKUP_DIR / f"{dbPath.stem}_pre-esquema-{desde}-a-{hasta}_{marca}.db"

    _checkpointAndCopy(dbPath, destino)
    return destino


def runStartupBackup(dbPath: Path):
    """Comprueba el DB y crea una copia automática cuando toca.

    La frecuencia de Ajustes se respeta al arrancar y desde el scheduler. Antes
    este método copiaba siempre y server.py añadía otro mecanismo incompatible
    que solo copiaba el portfolio activo.

    1. Verifica integridad del DB activo. Si falla: repara o restaura desde backup.
    2. Cuando corresponde, crea la copia completa (portfolios + configuración)
       en data/backups/, la misma que el botón de Ajustes, y rota según
       «Límite de backups».
    3. Inserta snapshot diario si no existe.
    """
    dbPath = Path(dbPath)
    if not dbPath.exists():
        return

    # Un intento sin espera. Los dos workers de gunicorn llegan aquí a la vez
    # —al importar server.py y en cada comprobación horaria— y hasta ahora los
    # dos verificaban, reparaban, copiaban y rotaban los mismos ficheros en
    # paralelo. Basta con que lo haga uno: el que no consiga el bloqueo se lo
    # salta, porque el trabajo es el mismo y ya se está haciendo.
    with exclusivo(_rutaBloqueo(), obligatorio=False) as conseguido:
        if not conseguido:
            log.info("[backup] Otro proceso está con la copia automática; se omite.")
            return False
        return _runStartupBackupLocked(dbPath)


def _portfoliosAVigilar(dbPath: Path):
    rutas = [dbPath]
    carpeta = getattr(paths, "PORTFOLIOS_DIR", None)
    if carpeta and Path(carpeta).exists():
        rutas += [r for r in sorted(Path(carpeta).glob("*.db")) if r != dbPath]
    return rutas


def _vigilarIntegridad(dbPath: Path):
    estado = _estadoIntegridad(dbPath)
    if estado == "ok":
        log.info(f"[backup] Integridad OK: {dbPath.name}")
        return
    if estado == "ocupada":
        return

    log.error(f"[backup] ¡INTEGRIDAD FALLIDA en {dbPath.name}! Intentando reparación.")
    if _emergencyRepair(dbPath):
        telegram_notifier.notificar(
            "sistema",
            f"🚨 La base de datos {dbPath.name} estaba dañada y se ha reparado sola.\n"
            "La copia dañada se ha guardado por si hace falta. Revisa que los datos estén bien.",
        )
        return

    log.error("[backup] Reparación fallida. Intentando restaurar desde backup automático.")
    restaurada = _restoreFromLatestAutoBackup(dbPath)
    telegram_notifier.notificar(
        "sistema",
        f"🚨 La base de datos {dbPath.name} estaba dañada y no se pudo reparar.\n"
        + ("Se ha restaurado desde la última copia válida: puede faltar lo último que guardaste."
           if restaurada else "No se ha encontrado ninguna copia válida. Hay que intervenir a mano."),
    )


def _runStartupBackupLocked(dbPath: Path):
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)

    # ── 1. Integridad de los portfolios ─────────────────────────────────────
    # Todos, no solo el activo: una copia con un portfolio dañado se rechaza
    # (ver `_escribirBackup`), y si nadie lo arreglaba las copias dejaban de
    # hacerse sin que nadie lo notase.
    for ruta in _portfoliosAVigilar(dbPath):
        _vigilarIntegridad(ruta)

    if not _backupIsDue():
        return False

    # ── 2. Copia completa, la misma que «Crear backup ahora» ────────────────
    # Import local: routes.backup importa de este módulo, y al revés no puede
    # ser al cargar. Es el mismo zip y la misma rotación que el botón; hasta la
    # 2.1.0 el automático dejaba un .db por portfolio en backups/auto/, que
    # la lista de Ajustes no enseñaba y desde la que no se podía restaurar.
    from routes.backup import crearBackupAutomatico

    try:
        nombre = crearBackupAutomatico()
        log.info(f"[backup] Copia automática creada: {nombre}")
    except Exception as e:
        # Se deja sin copia y se vuelve a intentar en la siguiente pasada del
        # scheduler: _lastBackupDate no verá ninguna de hoy.
        log.error(f"[backup] Error al crear la copia automática: {e}")
        return False

    # ── 3. Snapshot diario ──────────────────────────────────────────────────
    _ensureDailySnapshot(dbPath)
    return True


def checkScheduledBackup():
    """Comprueba la frecuencia sin depender de reiniciar el servidor.

    El `threading.Lock` serializa los hilos de este proceso; de los otros
    workers se encarga el bloqueo de fichero de `runStartupBackup`.
    """
    from core.db import getActiveDbPath

    with _AUTO_BACKUP_LOCK:
        try:
            return runStartupBackup(getActiveDbPath())
        except Exception as e:
            # Un fallo de I/O no debe matar el hilo; se reintentará después.
            log.error("[backup] Comprobación automática fallida: %s", e)
            return False


def _rutaBloqueo():
    """Fichero de bloqueo de las copias automáticas, común a todos los workers.

    Se lee de `paths` en cada llamada para que los tests, que redirigen los
    directorios de datos, no acaben coordinándose sobre el `data/` real.
    """
    return paths.TMP_DIR / "backup-automatico.lock"


def _schedulerLoop(intervalSeconds: int):
    while True:
        time.sleep(intervalSeconds)
        checkScheduledBackup()


def startScheduler(intervalSeconds: int = 3600):
    """Inicia una única comprobación horaria de las copias automáticas."""
    global _schedulerStarted, _schedulerThread
    if _schedulerStarted:
        return
    _schedulerStarted = True
    _schedulerThread = threading.Thread(
        target=_schedulerLoop,
        args=(max(60, int(intervalSeconds)),),
        name="backup-scheduler",
        daemon=True,
    )
    _schedulerThread.start()


def _candidatosDeRestauracion(dbStem: str):
    """Copias de `db_stem` de las que se puede recuperar, de más nueva a más vieja.

    Genera pares (nombre, ruta a un .db ya extraído). Primero los zips de
    data/backups/ —automáticos y manuales, que para esto valen igual—, sacando
    de cada uno la entrada `portfolios/<stem>.db` a un temporal; después los
    `.db` diarios de versiones anteriores que sigan en backups/auto/.
    """
    zips = sorted(paths.BACKUPS_DIR.glob("backup_*.zip"), key=_fechaDelZip, reverse=True)
    for rutaZip in zips:
        try:
            with zipfile.ZipFile(str(rutaZip)) as zf:
                entrada = f"portfolios/{dbStem}.db"
                if entrada not in zf.namelist():
                    continue
                with temporalPara(paths.BACKUPS_DIR / f"{dbStem}.db", directorio=paths.TMP_DIR) as tmp:
                    tmp.write_bytes(zf.read(entrada))
                    yield rutaZip.name, tmp
        except (OSError, zipfile.BadZipFile) as e:
            log.warning(f"[backup] {rutaZip.name} no se puede leer: {e}")
    for candidato in reversed(_datedBackups(dbStem)):
        yield candidato.name, candidato


def _fechaDelZip(ruta: Path):
    match = re.search(r"(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})", ruta.name)
    try:
        return datetime.strptime(match.group(1), "%d-%m-%Y_%H-%M-%S") if match else datetime.min
    except ValueError:
        return datetime.min


def _avisarSustitucion() -> None:
    """El .db se acaba de sustituir por otro fichero: que todos los procesos
    reabran sus conexiones (ver core.db.invalidateAllConnections)."""
    from core.db import invalidateAllConnections
    invalidateAllConnections()


def _restoreFromLatestAutoBackup(dbPath: Path):
    """Restaura db_path desde la copia válida más reciente. True si lo consiguió.

    La sustitución es atómica —temporal junto al destino y rename—: un `copy2`
    directo sobre el .db activo, interrumpido a medias, dejaba una base peor que
    la dañada. Y la copia de la dañada es de cortesía: que no se pueda hacer
    (disco justo) no puede impedir la restauración. Lo copiado se vuelve a
    comprobar antes de sustituir; si no pasa, se prueba con la copia anterior.
    """
    corruptedCopy = _BACKUP_DIR / f"{dbPath.stem}_CORRUPTED_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    guardada = False
    for nombre, candidate in _candidatosDeRestauracion(dbPath.stem):
        if not checkIntegrity(candidate):
            log.warning(f"[backup] La copia {nombre} tampoco pasa la integridad; se prueba la anterior.")
            continue
        try:
            if not guardada:
                try:
                    shutil.copy2(str(dbPath), str(corruptedCopy))
                    guardada = True
                except Exception as e:
                    log.warning(f"[backup] No se pudo guardar la copia dañada: {e}")
            with temporalPara(dbPath) as tmp:
                shutil.copy2(str(candidate), str(tmp))
                if not checkIntegrity(tmp):
                    log.error(f"[backup] La copia de {nombre} salió dañada al copiarla.")
                    continue
                _removeWalSidecars(dbPath)
                tmp.replace(dbPath)
            _removeWalSidecars(dbPath)
            _avisarSustitucion()
            log.info(f"[backup] Restaurado desde la copia: {nombre}")
            return True
        except Exception as e:
            log.error(f"[backup] Error restaurando desde {nombre}: {e}")
    log.error(f"[backup] No se encontró ninguna copia válida para {dbPath.name}")
    return False


def _ensureDailySnapshot(dbPath: Path):
    """Si no existe snapshot del día actual, duplica el último con timestamp de hoy."""
    import time
    conn = None
    try:
        conn = sqlite3.connect(str(dbPath), timeout=settings.backupSqliteTimeout())
        conn.row_factory = sqlite3.Row
        nowTs = int(time.time())
        todayStart = nowTs - (nowTs % 86400)
        hasToday = conn.execute(
            "SELECT 1 FROM portfolio_snapshots WHERE ts >= ? LIMIT 1", (todayStart,)
        ).fetchone()
        if not hasToday:
            last = conn.execute(
                "SELECT total_value, total_invested FROM portfolio_snapshots ORDER BY ts DESC LIMIT 1"
            ).fetchone()
            if last:
                conn.execute(
                    "INSERT INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?, ?, ?)",
                    (nowTs, last["total_value"], last["total_invested"])
                )
                conn.commit()
                log.info(f"[backup] Snapshot diario insertado para {dbPath.name}")
    except Exception as e:
        log.warning(f"[backup] No se pudo insertar snapshot diario: {e}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _emergencyRepair(dbPath: Path) -> bool:
    """Dump + restore para recuperar una BD corrupta. Devuelve True si tuvo éxito.

    La base reconstruida se arma en `data/tmp` y no como `<portfolio>.repair.db`
    junto a la original: allí la habría visto como un portfolio más cualquiera de
    los `glob("*.db")` del proyecto, y el nombre era además el mismo para los dos
    workers de gunicorn, que llegan aquí a la vez cuando una base está dañada.
    """
    corruptedBackup = _BACKUP_DIR / f"{dbPath.stem}_CORRUPTED_{datetime.now().strftime('%Y%m%d_%H%M%S')}.db"
    with temporalPara(dbPath, directorio=paths.TMP_DIR) as repairPath:
        return _repararEn(dbPath, repairPath, corruptedBackup)


def _repararEn(dbPath: Path, repairPath: Path, corruptedBackup: Path) -> bool:
    """El trabajo de _emergencyRepair, ya con el temporal reservado."""
    try:
        src = sqlite3.connect(str(dbPath), timeout=settings.backupSqliteTimeout())
        dump = list(src.iterdump())
        src.close()

        if repairPath.exists():
            repairPath.unlink()
        dst = sqlite3.connect(str(repairPath), timeout=settings.backupSqliteTimeout())
        dst.executescript("\n".join(dump))
        dst.close()

        if checkIntegrity(repairPath):
            shutil.copy2(str(dbPath), str(corruptedBackup))
            shutil.move(str(repairPath), str(dbPath))
            _removeWalSidecars(dbPath)
            _avisarSustitucion()
            log.info(f"[backup] Reparación automática OK. Corrupta guardada en {corruptedBackup.name}")
            return True
        else:
            log.error("[backup] La reparación automática no pudo resolver la corrupción.")
            repairPath.unlink(missing_ok=True)
            return False
    except Exception as e:
        log.error(f"[backup] Error en reparación de emergencia: {e}")
        repairPath.unlink(missing_ok=True)
        return False
