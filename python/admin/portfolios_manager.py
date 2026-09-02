import json
import logging
import re
import shutil
from datetime import datetime
from pathlib import Path

from core import settings
from core.escritura import escribirJsonAtomico
from core.paths import (
    DELETED_DIR as _DELETED_DIR,
    LEGACY_DB as _LEGACY_DB,
    PORTFOLIOS_DIR as _PORTFOLIOS_DIR,
    PORTFOLIOS_META_FILE as _META_FILE,
)

log = logging.getLogger(__name__)



def _read_meta():
    if not _META_FILE.exists():
        return None
    try:
        return json.loads(_META_FILE.read_text("utf-8"))
    except Exception:
        return None


def _write_meta(data):
    """Guarda portfolios.json sin poder dejarlo a medias.

    El temporal se llamaba `portfolios.tmp`, el mismo nombre en todos los
    procesos: los dos workers de gunicorn guardan aquí al arrancar (la marca de
    `legacyMigrated`, el portfolio activo) y escribían el mismo fichero a la
    vez. `escribirAtomico` da un nombre único por proceso e hilo y añade el
    fsync que faltaba antes del rename.
    """
    escribirJsonAtomico(_META_FILE, data)


def _safe_id(name: str) -> str:
    return re.sub(r"[^a-z0-9_-]", "_", name.lower().strip())[:40] or "portfolio"


def _set_active(db_path: Path):
    from core.db import set_active_db_path
    set_active_db_path(db_path)


def _migrate_legacy_gastos(active_db_path: Path):
    """Copia datos de gastos de portfolio.db (legacy) al DB activo si el activo está vacío."""
    if not _LEGACY_DB.exists():
        return
    try:
        import sqlite3
        src = sqlite3.connect(str(_LEGACY_DB), timeout=settings.backupSqliteTimeout())
        src.row_factory = sqlite3.Row

        # Comprobar si el legacy tiene mensualidades con valores o gastos
        try:
            has_mens = src.execute(
                "SELECT 1 FROM mensualidades WHERE enero != '' OR febrero != '' LIMIT 1"
            ).fetchone()
            has_rows = src.execute("SELECT 1 FROM gastos_rows LIMIT 1").fetchone()
        except Exception:
            src.close()
            return

        if not has_mens and not has_rows:
            src.close()
            return

        dst = sqlite3.connect(str(active_db_path), timeout=settings.backupSqliteTimeout())
        try:
            # Solo migrar si el activo NO tiene datos de gastos
            empty_mens = dst.execute(
                "SELECT 1 FROM mensualidades WHERE enero != '' OR febrero != '' LIMIT 1"
            ).fetchone()
            has_dst_rows = dst.execute("SELECT 1 FROM gastos_rows LIMIT 1").fetchone()
            if empty_mens or has_dst_rows:
                dst.close()
                src.close()
                return
        except Exception:
            dst.close()
            src.close()
            return

        # Migrar mensualidades
        dst.execute("DELETE FROM mensualidades")
        src_mens = src.execute(
            "SELECT year, nombre, enero, febrero, marzo, abril, mayo, junio, "
            "julio, agosto, septiembre, octubre, noviembre, diciembre FROM mensualidades"
        ).fetchall()
        dst.executemany(
            "INSERT INTO mensualidades (year, nombre, enero, febrero, marzo, abril, mayo, junio, "
            "julio, agosto, septiembre, octubre, noviembre, diciembre) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(r["year"], r["nombre"], r["enero"], r["febrero"], r["marzo"], r["abril"],
              r["mayo"], r["junio"], r["julio"], r["agosto"], r["septiembre"],
              r["octubre"], r["noviembre"], r["diciembre"]) for r in src_mens]
        )

        # Migrar gastos_rows
        dst.execute("DELETE FROM gastos_rows")
        src_rows = src.execute(
            "SELECT year, month, fecha, nombre, tipo, cantidad FROM gastos_rows"
        ).fetchall()
        dst.executemany(
            "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
            [(r["year"], r["month"], r["fecha"], r["nombre"], r["tipo"], r["cantidad"]) for r in src_rows]
        )

        # Migrar gastos_tipos
        dst.execute("DELETE FROM gastos_tipos")
        src_tipos = src.execute("SELECT label FROM gastos_tipos").fetchall()
        dst.executemany("INSERT OR IGNORE INTO gastos_tipos (label) VALUES (?)", [(r["label"],) for r in src_tipos])

        # Asegurar que gastos_years tiene los años correctos
        years = {r["year"] for r in src.execute("SELECT DISTINCT year FROM mensualidades").fetchall()}
        try:
            years |= {r["year"] for r in src.execute("SELECT DISTINCT year FROM gastos_rows").fetchall()}
        except Exception:
            pass
        for y in years:
            if y:
                dst.execute("INSERT OR IGNORE INTO gastos_years (year) VALUES (?)", (y,))

        # Migrar ingresos si el activo no tiene ninguno
        try:
            has_ing = dst.execute("SELECT 1 FROM ingresos_rows LIMIT 1").fetchone()
            if not has_ing:
                src_ing = src.execute(
                    "SELECT year, month, fecha, nombre, tipo, cantidad FROM ingresos_rows ORDER BY id"
                ).fetchall()
                dst.executemany(
                    "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?,?,?,?,?,?)",
                    [(r["year"], r["month"], r["fecha"], r["nombre"], r["tipo"], r["cantidad"]) for r in src_ing]
                )
                src_rec = src.execute(
                    "SELECT year, nombre, enero, febrero, marzo, abril, mayo, junio, "
                    "julio, agosto, septiembre, octubre, noviembre, diciembre FROM ingresos_recurrentes ORDER BY id"
                ).fetchall()
                dst.executemany(
                    "INSERT OR IGNORE INTO ingresos_recurrentes "
                    "(year,nombre,enero,febrero,marzo,abril,mayo,junio,julio,agosto,septiembre,octubre,noviembre,diciembre) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [tuple(r) for r in src_rec]
                )
                src_tipos_ing = src.execute("SELECT label FROM ingresos_tipos").fetchall()
                dst.executemany("INSERT OR IGNORE INTO ingresos_tipos (label) VALUES (?)", [(r["label"],) for r in src_tipos_ing])
                log.info(f"[gastos migration] Ingresos migrados desde legacy: {len(src_ing)} filas")
        except Exception as e:
            log.warning(f"[gastos migration] No se pudieron migrar ingresos: {e}")

        dst.commit()
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst.commit()
        dst.close()
        src.close()
    except Exception as e:
        log.warning(f"[gastos migration] Aviso: {e}")


def init_portfolios():
    """Llamado al arrancar el servidor. Migra el DB legacy si es necesario y activa el portfolio."""
    meta = _read_meta()

    if meta is None:
        _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
        default_id = "principal"
        default_db = _PORTFOLIOS_DIR / f"{default_id}.db"

        if _LEGACY_DB.exists() and not default_db.exists():
            # API de backup de SQLite: incluye el WAL pendiente, cosa que una
            # copia de fichero simple podría perder.
            from admin.backup_manager import _checkpoint_and_copy
            _checkpoint_and_copy(_LEGACY_DB, default_db)

        meta = {
            "active": default_id,
            "portfolios": [{"id": default_id, "name": "Principal"}],
        }
        _write_meta(meta)

    _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
    active_id = meta.get("active", "principal")

    # El id sale de portfolios.json, y ese fichero ya no es necesariamente uno
    # que haya escrito la aplicación: desde que «Importar ZIP» acepta un archivo
    # subido, su contenido puede venir de fuera. Un `active` como
    # "../../../tmp/principal" hacía que la base activa —y con ella todo lo que
    # se escriba después— acabara fuera del volumen de datos, y el valor se
    # persistía, así que el desvío sobrevivía a cada arranque.
    #
    # `_portfolio_db_path` es la comprobación que ya existía para esto mismo en
    # borrar y cambiar de portfolio; lo que faltaba era usarla también aquí.
    try:
        active_db = _portfolio_db_path(active_id)
    except ValueError:
        log.error(
            "[portfolios] El portfolio activo declarado en portfolios.json no es un id "
            "admisible (%r). Se vuelve a 'principal'.", active_id,
        )
        active_id = "principal"
        active_db = _portfolio_db_path(active_id)
        meta["active"] = active_id
        _write_meta(meta)

    # Si el DB activo no existe, intentar recuperarlo desde el backup más reciente
    if not active_db.exists():
        log.warning(f"[portfolios] DB activo no encontrado: {active_db.name}. Intentando recuperar.")
        _recover_missing_db(active_db)

    # La migración del legacy solo tiene sentido una vez, y solo hacia el
    # portfolio que se creó a partir de data/portfolio.db.
    #
    # Antes se ejecutaba en cada arranque contra el portfolio ACTIVO, fuera cual
    # fuera. Como solo copia si el destino está vacío, un portfolio nuevo y
    # recién creado cumplía la condición: bastaba con activarlo y reiniciar para
    # que se le volcaran dentro los gastos, mensualidades, categorías e ingresos
    # del legacy. El usuario veía "mezclados" dos portfolios que nunca había
    # relacionado.
    legacy_id = (meta.get("portfolios") or [{}])[0].get("id")

    if not meta.get("legacyMigrated"):
        if active_id == legacy_id:
            _migrate_legacy_gastos(active_db)
        # Se marca hecha en cualquier caso: es un paso de actualización de una
        # sola vez, no algo que deba reevaluarse en cada arranque.
        meta["legacyMigrated"] = True
        _write_meta(meta)

    from admin.backup_manager import run_startup_backup
    run_startup_backup(active_db)

    _set_active(active_db)
    return meta


def _recover_missing_db(db_path: Path):
    """Intenta recuperar un DB que no existe copiando desde el backup automático más reciente."""
    from admin.backup_manager import _BACKUP_DIR, _dated_backups, _remove_wal_sidecars, check_integrity
    candidates = list(reversed(_dated_backups(db_path.stem))) if _BACKUP_DIR.exists() else []
    for candidate in candidates:
        if check_integrity(candidate):
            try:
                shutil.copy2(str(candidate), str(db_path))
                _remove_wal_sidecars(db_path)
                log.info(f"[portfolios] DB recuperado desde: {candidate.name}")
                return
            except Exception as e:
                log.error(f"[portfolios] Error copiando {candidate.name}: {e}")
    log.warning(f"[portfolios] No se pudo recuperar {db_path.name}. Se creará vacío.")


def get_portfolios():
    meta = _read_meta()
    if meta is None:
        return init_portfolios()
    return meta


def create_portfolio(name: str) -> str:
    name = name.strip()[:50]
    if not name:
        raise ValueError("El nombre no puede estar vacío")

    meta = get_portfolios()
    base_id = _safe_id(name)
    pid = base_id
    existing_ids = {p["id"] for p in meta["portfolios"]}
    counter = 2
    while pid in existing_ids:
        pid = f"{base_id}_{counter}"
        counter += 1

    _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)

    from core.db import init_db_at_path
    new_db = _PORTFOLIOS_DIR / f"{pid}.db"
    new_db.unlink(missing_ok=True)
    init_db_at_path(new_db)

    meta["portfolios"].append({"id": pid, "name": name})
    _write_meta(meta)
    return pid


def switch_portfolio(pid: str):
    meta = get_portfolios()
    ids = {p["id"] for p in meta["portfolios"]}
    if pid not in ids:
        raise ValueError(f"Portfolio '{pid}' no encontrado")

    db_path = _portfolio_db_path(pid)
    meta["active"] = pid
    _write_meta(meta)
    _set_active(db_path)


def _portfolio_db_path(pid: str) -> Path:
    """Ruta del .db de un portfolio, verificando que no se escape del directorio.

    delete_portfolio construía _PORTFOLIOS_DIR / f"{pid}.db" con un pid sin
    validar; un pid como '../portfolio' apuntaba a data/portfolio.db y lo movía
    a data/deleted/.
    """
    if not re.fullmatch(r"[a-z0-9_-]{1,64}", pid or ""):
        raise ValueError(f"Portfolio '{pid}' no encontrado")
    path = (_PORTFOLIOS_DIR / f"{pid}.db").resolve()
    if path.parent != _PORTFOLIOS_DIR.resolve():
        raise ValueError(f"Portfolio '{pid}' no encontrado")
    return path


def get_active_portfolio_id():
    """Id del portfolio activo, o None si el fichero de metadatos aún no existe."""
    meta = get_portfolios()
    return (meta or {}).get("active")


def find_portfolio_id(valor: str):
    """Id de un portfolio a partir de su id o de su nombre visible.

    Aceptar el nombre le ahorra al Atajo de iOS dos acciones y una traducción
    id↔nombre que era la parte más frágil de montar: puede enseñar la lista de
    nombres y mandar directamente el que elija el usuario.

    Devuelve None si no coincide con ninguno.
    """
    texto = str(valor or "").strip()

    if not texto:
        return None

    portfolios = (get_portfolios() or {}).get("portfolios", [])

    # El id manda: si alguien llamara "test2" a un portfolio cuyo id es otro, la
    # coincidencia exacta de id sigue ganando.
    for portfolio in portfolios:
        if portfolio.get("id") == texto:
            return portfolio["id"]

    objetivo = texto.casefold()
    for portfolio in portfolios:
        if str(portfolio.get("name", "")).strip().casefold() == objetivo:
            return portfolio["id"]

    return None


def get_portfolio_db_path(pid: str) -> Path:
    """Ruta del .db de un portfolio existente.

    Lo usan los endpoints del Atajo para escribir en el portfolio que elija el
    usuario sin cambiar el activo del proceso. Se comprueba contra los
    metadatos, no solo contra el sistema de ficheros, para que un pid válido de
    formato pero inexistente no acabe creando una base de datos vacía.
    """
    meta = get_portfolios()

    if pid not in {p["id"] for p in (meta or {}).get("portfolios", [])}:
        raise ValueError(f"Portfolio '{pid}' no encontrado")

    return _portfolio_db_path(pid)


def delete_portfolio(pid: str):
    meta = get_portfolios()
    if pid not in {p["id"] for p in meta["portfolios"]}:
        raise ValueError(f"Portfolio '{pid}' no encontrado")
    if meta["active"] == pid:
        raise ValueError("No puedes eliminar el portfolio activo")
    if len(meta["portfolios"]) <= 1:
        raise ValueError("Debe existir al menos un portfolio")

    db_file = _portfolio_db_path(pid)

    meta["portfolios"] = [p for p in meta["portfolios"] if p["id"] != pid]
    _write_meta(meta)

    if db_file.exists():
        _DELETED_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        # Mover en lugar de borrar: el .db queda recuperable en data/deleted/
        shutil.move(str(db_file), str(_DELETED_DIR / f"{pid}_{ts}.db"))
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(db_file) + suffix)
            if sidecar.exists():
                shutil.move(str(sidecar), str(_DELETED_DIR / f"{pid}_{ts}.db{suffix}"))


def rename_portfolio(pid: str, new_name: str):
    new_name = new_name.strip()[:50]
    if not new_name:
        raise ValueError("El nombre no puede estar vacío")

    meta = get_portfolios()
    for p in meta["portfolios"]:
        if p["id"] == pid:
            p["name"] = new_name
            _write_meta(meta)
            return

    raise ValueError(f"Portfolio '{pid}' no encontrado")
