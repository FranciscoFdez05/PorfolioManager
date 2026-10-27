import functools
import json
import logging
import re
import shutil
import threading
import time
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from core import settings
from core.bloqueo import exclusivo
from core.escritura import escribirJsonAtomico
from core.paths import (
    DELETED_DIR as _DELETED_DIR,
    LEGACY_DB as _LEGACY_DB,
    PORTFOLIOS_DIR as _PORTFOLIOS_DIR,
    PORTFOLIOS_META_FILE as _META_FILE,
)

log = logging.getLogger(__name__)



def _readMeta():
    if not _META_FILE.exists():
        return None
    # Un fallo de lectura puntual (en Windows, mientras otro proceso hace el
    # rename del fichero) no es un índice corrupto: se reintenta antes de rendirse.
    for intento in range(3):
        try:
            return json.loads(_META_FILE.read_text("utf-8"))
        except OSError:
            time.sleep(0.05 * (intento + 1))
        except Exception:
            return None
    return None


def _reconstruirIndice():
    """Índice nuevo a partir de los .db que hay en disco, conservando el roto.

    Si portfolios.json existe pero no se puede leer, arrancar con un índice por
    defecto lo sobrescribía y todos los portfolios menos «principal» dejaban de
    aparecer. El fichero ilegible se aparta y el índice se rehace con lo que hay.
    """
    marca = datetime.now().strftime("%Y%m%d_%H%M%S")
    try:
        shutil.copy2(str(_META_FILE), str(_META_FILE.with_name(f"portfolios.json.ilegible-{marca}")))
    except OSError as error:
        log.error("[portfolios] No se pudo apartar el portfolios.json ilegible: %s", error)
    ids = sorted(
        p.stem for p in _PORTFOLIOS_DIR.glob("*.db") if re.fullmatch(r"[a-z0-9_-]{1,64}", p.stem)
    )
    if not ids:
        return None
    log.error("[portfolios] portfolios.json ilegible; índice reconstruido desde %d bases en disco", len(ids))
    activo = "principal" if "principal" in ids else ids[0]
    return {
        "active": activo,
        "portfolios": [{"id": i, "name": "Principal" if i == "principal" else i} for i in ids],
    }


def _writeMeta(data):
    """Guarda portfolios.json sin poder dejarlo a medias.

    El temporal se llamaba `portfolios.tmp`, el mismo nombre en todos los
    procesos: los dos workers de gunicorn guardan aquí al arrancar (la marca de
    `legacyMigrated`, el portfolio activo) y escribían el mismo fichero a la
    vez. `escribirAtomico` da un nombre único por proceso e hilo y añade el
    fsync que faltaba antes del rename.
    """
    escribirJsonAtomico(_META_FILE, data)


# ── Cerrojo del índice ───────────────────────────────────────────────────────
# Crear, importar, activar, renombrar y borrar leen portfolios.json, lo
# modifican y lo vuelven a escribir. Sin cerrojo, dos altas simultáneas
# elegían el mismo id, la segunda borraba el .db que la primera acababa de
# crear y el índice podía perder una de las dos. El Lock cubre los hilos de
# este proceso; el fichero de bloqueo, el otro worker de gunicorn.
_indiceLock = threading.Lock()


@contextmanager
def bloqueoIndice():
    with _indiceLock, exclusivo(_META_FILE.with_name("portfolios.lock"), espera=10):
        yield


def _conIndiceBloqueado(funcion):
    @functools.wraps(funcion)
    def envoltura(*args, **kwargs):
        with bloqueoIndice():
            return funcion(*args, **kwargs)
    return envoltura


def _idLibre(meta, name: str) -> str:
    """Id derivado del nombre que no use ningún portfolio ni ningún fichero.

    Se mira también el disco: un .db huérfano (de un alta que se cortó a medias)
    no aparece en el índice, y antes se borraba sin más para reutilizar su id.
    """
    baseId = _safeId(name)
    pid = baseId
    existentes = {p["id"] for p in meta["portfolios"]}
    contador = 2
    while pid in existentes or (_PORTFOLIOS_DIR / f"{pid}.db").exists():
        pid = f"{baseId}_{contador}"
        contador += 1
    return pid


class NombreDuplicado(ValueError):
    """Ya hay un portfolio con ese nombre visible. Las rutas responden 409."""


def _nombreEnUso(meta, name: str, salvoId=None) -> bool:
    buscado = name.strip().casefold()
    return any(
        str(p.get("name", "")).strip().casefold() == buscado and p.get("id") != salvoId
        for p in meta["portfolios"]
    )


def _nombreLibre(meta, name: str) -> str:
    """`name`, o `name (2)`, `name (3)`… el primero que no use ningún portfolio."""
    candidato, contador = name, 2
    while _nombreEnUso(meta, candidato):
        sufijo = f" ({contador})"
        candidato = f"{name[:50 - len(sufijo)]}{sufijo}"
        contador += 1
    return candidato


def registrarPortfolio(name: str, colocar, renombrarSiExiste=False) -> str:
    """Da de alta un portfolio de forma atómica respecto a las demás altas.

    `colocar(destino)` deja el .db en su sitio (crearlo vacío, mover uno
    importado). Elegir el id, colocar el fichero y apuntarlo en el índice van
    bajo el mismo cerrojo.

    El nombre visible no se puede repetir: el Atajo de iOS elige la cartera por
    su nombre, y con dos «Carrera» escribía en la primera que encontrase. Diez
    altas simultáneas con el mismo nombre creaban diez. Un alta normal falla con
    NombreDuplicado; una importación (`renombrar_si_existe`) se queda con
    «nombre (2)», porque restaurar una copia no debería fallar por eso.
    """
    with bloqueoIndice():
        meta = getPortfolios()
        if _nombreEnUso(meta, name):
            if not renombrarSiExiste:
                raise NombreDuplicado(f"Ya existe un portfolio llamado «{name}»")
            name = _nombreLibre(meta, name)
        pid = _idLibre(meta, name)
        _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
        colocar(_PORTFOLIOS_DIR / f"{pid}.db")
        meta["portfolios"].append({"id": pid, "name": name})
        _writeMeta(meta)
    return pid


def _safeId(name: str) -> str:
    return re.sub(r"[^a-z0-9_-]", "_", name.lower().strip())[:40] or "portfolio"


def _setActive(dbPath: Path):
    global _firmaVista
    from core.db import registrarResolutorActivo, setActiveDbPath
    setActiveDbPath(dbPath)
    # Lo que hay ahora en portfolios.json es justo lo que se acaba de fijar:
    # solo un cambio posterior (de otro proceso) obliga a releerlo.
    _firmaVista = _firmaMeta()
    registrarResolutorActivo(_activoSegunMeta)


# Firma de portfolios.json la última vez que este proceso lo leyó para saber
# cuál es el activo. Mientras no cambie, no hay nada que releer: el coste por
# llamada es un stat().
_firmaVista = None
_firmaLock = threading.Lock()


def _firmaMeta():
    try:
        st = _META_FILE.stat()
    except OSError:
        return None
    return (st.st_mtime_ns, st.st_size, st.st_ino)


def _activoSegunMeta(actual: Path):
    """Ruta del portfolio activo si otro proceso la ha cambiado, o None.

    Cada worker de gunicorn guarda su propia copia de la BD activa
    (core/db.py). El cambio de portfolio se escribe en portfolios.json, que sí
    es común, así que basta con releerlo cuando su firma cambia.
    """
    global _firmaVista
    firma = _firmaMeta()
    if firma is None or firma == _firmaVista:
        return None

    with _firmaLock:
        if firma == _firmaVista:
            return None
        meta = _readMeta()
        if meta is None:
            return None
        _firmaVista = firma
        try:
            destino = _portfolioDbPath(str(meta.get("active") or ""))
        except ValueError:
            return None
        if destino == Path(actual) or not destino.exists():
            return None
        return destino


def _migrateLegacyGastos(activeDbPath: Path):
    """Copia datos de gastos de portfolio.db (legacy) al DB activo si el activo está vacío."""
    if not _LEGACY_DB.exists():
        return
    try:
        import sqlite3
        src = sqlite3.connect(str(_LEGACY_DB), timeout=settings.backupSqliteTimeout())
        src.row_factory = sqlite3.Row

        # Comprobar si el legacy tiene mensualidades con valores o gastos
        try:
            hasMens = src.execute(
                "SELECT 1 FROM mensualidades WHERE enero != '' OR febrero != '' LIMIT 1"
            ).fetchone()
            hasRows = src.execute("SELECT 1 FROM gastos_rows LIMIT 1").fetchone()
        except Exception:
            src.close()
            return

        if not hasMens and not hasRows:
            src.close()
            return

        dst = sqlite3.connect(str(activeDbPath), timeout=settings.backupSqliteTimeout())
        try:
            # Solo migrar si el activo NO tiene datos de gastos
            emptyMens = dst.execute(
                "SELECT 1 FROM mensualidades WHERE enero != '' OR febrero != '' LIMIT 1"
            ).fetchone()
            hasDstRows = dst.execute("SELECT 1 FROM gastos_rows LIMIT 1").fetchone()
            if emptyMens or hasDstRows:
                dst.close()
                src.close()
                return
        except Exception:
            dst.close()
            src.close()
            return

        # Migrar mensualidades
        dst.execute("DELETE FROM mensualidades")
        srcMens = src.execute(
            "SELECT year, nombre, enero, febrero, marzo, abril, mayo, junio, "
            "julio, agosto, septiembre, octubre, noviembre, diciembre FROM mensualidades"
        ).fetchall()
        dst.executemany(
            "INSERT INTO mensualidades (year, nombre, enero, febrero, marzo, abril, mayo, junio, "
            "julio, agosto, septiembre, octubre, noviembre, diciembre) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [(r["year"], r["nombre"], r["enero"], r["febrero"], r["marzo"], r["abril"],
              r["mayo"], r["junio"], r["julio"], r["agosto"], r["septiembre"],
              r["octubre"], r["noviembre"], r["diciembre"]) for r in srcMens]
        )

        # Migrar gastos_rows
        dst.execute("DELETE FROM gastos_rows")
        srcRows = src.execute(
            "SELECT year, month, fecha, nombre, tipo, cantidad FROM gastos_rows"
        ).fetchall()
        dst.executemany(
            "INSERT INTO gastos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?, ?, ?, ?, ?, ?)",
            [(r["year"], r["month"], r["fecha"], r["nombre"], r["tipo"], r["cantidad"]) for r in srcRows]
        )

        # Migrar gastos_tipos
        dst.execute("DELETE FROM gastos_tipos")
        srcTipos = src.execute("SELECT label FROM gastos_tipos").fetchall()
        dst.executemany("INSERT OR IGNORE INTO gastos_tipos (label) VALUES (?)", [(r["label"],) for r in srcTipos])

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
            hasIng = dst.execute("SELECT 1 FROM ingresos_rows LIMIT 1").fetchone()
            if not hasIng:
                srcIng = src.execute(
                    "SELECT year, month, fecha, nombre, tipo, cantidad FROM ingresos_rows ORDER BY id"
                ).fetchall()
                dst.executemany(
                    "INSERT INTO ingresos_rows (year, month, fecha, nombre, tipo, cantidad) VALUES (?,?,?,?,?,?)",
                    [(r["year"], r["month"], r["fecha"], r["nombre"], r["tipo"], r["cantidad"]) for r in srcIng]
                )
                srcRec = src.execute(
                    "SELECT year, nombre, enero, febrero, marzo, abril, mayo, junio, "
                    "julio, agosto, septiembre, octubre, noviembre, diciembre FROM ingresos_recurrentes ORDER BY id"
                ).fetchall()
                dst.executemany(
                    "INSERT OR IGNORE INTO ingresos_recurrentes "
                    "(year,nombre,enero,febrero,marzo,abril,mayo,junio,julio,agosto,septiembre,octubre,noviembre,diciembre) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [tuple(r) for r in srcRec]
                )
                srcTiposIng = src.execute("SELECT label FROM ingresos_tipos").fetchall()
                dst.executemany("INSERT OR IGNORE INTO ingresos_tipos (label) VALUES (?)", [(r["label"],) for r in srcTiposIng])
                log.info(f"[gastos migration] Ingresos migrados desde legacy: {len(srcIng)} filas")
        except Exception as e:
            log.warning(f"[gastos migration] No se pudieron migrar ingresos: {e}")

        dst.commit()
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst.commit()
        dst.close()
        src.close()
    except Exception as e:
        log.warning(f"[gastos migration] Aviso: {e}")


def initPortfolios():
    """Llamado al arrancar el servidor. Migra el DB legacy si es necesario y activa el portfolio."""
    meta = _readMeta()

    if meta is None and _META_FILE.exists():
        _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
        meta = _reconstruirIndice()
        if meta is not None:
            _writeMeta(meta)

    if meta is None:
        _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
        defaultId = "principal"
        defaultDb = _PORTFOLIOS_DIR / f"{defaultId}.db"

        if _LEGACY_DB.exists() and not defaultDb.exists():
            # API de backup de SQLite: incluye el WAL pendiente, cosa que una
            # copia de fichero simple podría perder.
            from admin.backup_manager import _checkpointAndCopy
            _checkpointAndCopy(_LEGACY_DB, defaultDb)

        meta = {
            "active": defaultId,
            "portfolios": [{"id": defaultId, "name": "Principal"}],
        }
        _writeMeta(meta)

    _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
    activeId = meta.get("active", "principal")

    # El id sale de portfolios.json, y ese fichero ya no es necesariamente uno
    # que haya escrito la aplicación: desde que «Importar ZIP» acepta un archivo
    # subido, su contenido puede venir de fuera. Un `active` como
    # "../../../tmp/principal" hacía que la base activa —y con ella todo lo que
    # se escriba después— acabara fuera del volumen de datos, y el valor se
    # persistía, así que el desvío sobrevivía a cada arranque.
    #
    # `_portfolioDbPath` es la comprobación que ya existía para esto mismo en
    # borrar y cambiar de portfolio; lo que faltaba era usarla también aquí.
    try:
        activeDb = _portfolioDbPath(activeId)
    except ValueError:
        log.error(
            "[portfolios] El portfolio activo declarado en portfolios.json no es un id "
            "admisible (%r). Se vuelve a 'principal'.", activeId,
        )
        activeId = "principal"
        activeDb = _portfolioDbPath(activeId)
        meta["active"] = activeId
        _writeMeta(meta)

    # Si el DB activo no existe, intentar recuperarlo desde el backup más reciente
    if not activeDb.exists():
        log.warning(f"[portfolios] DB activo no encontrado: {activeDb.name}. Intentando recuperar.")
        _recoverMissingDb(activeDb)

    # La migración del legacy solo tiene sentido una vez, y solo hacia el
    # portfolio que se creó a partir de data/portfolio.db.
    #
    # Antes se ejecutaba en cada arranque contra el portfolio ACTIVO, fuera cual
    # fuera. Como solo copia si el destino está vacío, un portfolio nuevo y
    # recién creado cumplía la condición: bastaba con activarlo y reiniciar para
    # que se le volcaran dentro los gastos, mensualidades, categorías e ingresos
    # del legacy. El usuario veía "mezclados" dos portfolios que nunca había
    # relacionado.
    legacyId = (meta.get("portfolios") or [{}])[0].get("id")

    if not meta.get("legacyMigrated"):
        if activeId == legacyId:
            _migrateLegacyGastos(activeDb)
        # Se marca hecha en cualquier caso: es un paso de actualización de una
        # sola vez, no algo que deba reevaluarse en cada arranque.
        meta["legacyMigrated"] = True
        _writeMeta(meta)

    from admin.backup_manager import runStartupBackup
    runStartupBackup(activeDb)

    _setActive(activeDb)
    return meta


def _recoverMissingDb(dbPath: Path):
    """Intenta recuperar un DB que no existe copiando desde el backup automático más reciente."""
    from admin.backup_manager import _BACKUP_DIR, _datedBackups, _removeWalSidecars, checkIntegrity
    candidates = list(reversed(_datedBackups(dbPath.stem))) if _BACKUP_DIR.exists() else []
    for candidate in candidates:
        if checkIntegrity(candidate):
            try:
                shutil.copy2(str(candidate), str(dbPath))
                _removeWalSidecars(dbPath)
                log.info(f"[portfolios] DB recuperado desde: {candidate.name}")
                return
            except Exception as e:
                log.error(f"[portfolios] Error copiando {candidate.name}: {e}")
    log.warning(f"[portfolios] No se pudo recuperar {dbPath.name}. Se creará vacío.")


def getPortfolios():
    meta = _readMeta()
    if meta is None:
        return initPortfolios()
    return meta


def createPortfolio(name: str) -> str:
    name = name.strip()[:50]
    if not name:
        raise ValueError("El nombre no puede estar vacío")

    from core.db import initDbAtPath
    return registrarPortfolio(name, initDbAtPath)


@_conIndiceBloqueado
def switchPortfolio(pid: str):
    meta = getPortfolios()
    ids = {p["id"] for p in meta["portfolios"]}
    if pid not in ids:
        raise ValueError(f"Portfolio '{pid}' no encontrado")

    dbPath = _portfolioDbPath(pid)
    meta["active"] = pid
    _writeMeta(meta)
    _setActive(dbPath)


def _portfolioDbPath(pid: str) -> Path:
    """Ruta del .db de un portfolio, verificando que no se escape del directorio.

    deletePortfolio construía _PORTFOLIOS_DIR / f"{pid}.db" con un pid sin
    validar; un pid como '../portfolio' apuntaba a data/portfolio.db y lo movía
    a data/deleted/.
    """
    if not re.fullmatch(r"[a-z0-9_-]{1,64}", pid or ""):
        raise ValueError(f"Portfolio '{pid}' no encontrado")
    path = (_PORTFOLIOS_DIR / f"{pid}.db").resolve()
    if path.parent != _PORTFOLIOS_DIR.resolve():
        raise ValueError(f"Portfolio '{pid}' no encontrado")
    return path


def getActivePortfolioId():
    """Id del portfolio activo, o None si el fichero de metadatos aún no existe."""
    meta = getPortfolios()
    return (meta or {}).get("active")


def findPortfolioId(valor: str):
    """Id de un portfolio a partir de su id o de su nombre visible.

    Aceptar el nombre le ahorra al Atajo de iOS dos acciones y una traducción
    id↔nombre que era la parte más frágil de montar: puede enseñar la lista de
    nombres y mandar directamente el que elija el usuario.

    Devuelve None si no coincide con ninguno.
    """
    texto = str(valor or "").strip()

    if not texto:
        return None

    portfolios = (getPortfolios() or {}).get("portfolios", [])

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


def getPortfolioDbPath(pid: str) -> Path:
    """Ruta del .db de un portfolio existente.

    Lo usan los endpoints del Atajo para escribir en el portfolio que elija el
    usuario sin cambiar el activo del proceso. Se comprueba contra los
    metadatos, no solo contra el sistema de ficheros, para que un pid válido de
    formato pero inexistente no acabe creando una base de datos vacía.
    """
    meta = getPortfolios()

    if pid not in {p["id"] for p in (meta or {}).get("portfolios", [])}:
        raise ValueError(f"Portfolio '{pid}' no encontrado")

    return _portfolioDbPath(pid)


@_conIndiceBloqueado
def deletePortfolio(pid: str):
    meta = getPortfolios()
    if pid not in {p["id"] for p in meta["portfolios"]}:
        raise ValueError(f"Portfolio '{pid}' no encontrado")
    if meta["active"] == pid:
        raise ValueError("No puedes eliminar el portfolio activo")
    if len(meta["portfolios"]) <= 1:
        raise ValueError("Debe existir al menos un portfolio")

    dbFile = _portfolioDbPath(pid)

    # Primero se mueve el fichero y después se actualiza el índice: si el move
    # falla (en Windows, con el .db abierto), el portfolio sigue listado y se
    # puede reintentar; al revés quedaba un .db huérfano fuera del índice.
    if dbFile.exists():
        _DELETED_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        # Mover en lugar de borrar: el .db queda recuperable en data/deleted/
        shutil.move(str(dbFile), str(_DELETED_DIR / f"{pid}_{ts}.db"))
        for suffix in ("-wal", "-shm"):
            sidecar = Path(str(dbFile) + suffix)
            if sidecar.exists():
                shutil.move(str(sidecar), str(_DELETED_DIR / f"{pid}_{ts}.db{suffix}"))

    meta["portfolios"] = [p for p in meta["portfolios"] if p["id"] != pid]
    _writeMeta(meta)


@_conIndiceBloqueado
def renamePortfolio(pid: str, newName: str):
    """Cambia el nombre visible, bajo el cerrojo del índice como las altas.

    El cerrojo no es reentrante: no se puede llamar desde otra función que ya lo
    tenga tomado.
    """
    newName = newName.strip()[:50]
    if not newName:
        raise ValueError("El nombre no puede estar vacío")

    meta = getPortfolios()
    if _nombreEnUso(meta, newName, salvoId=pid):
        raise NombreDuplicado(f"Ya existe un portfolio llamado «{newName}»")
    for p in meta["portfolios"]:
        if p["id"] == pid:
            p["name"] = newName
            _writeMeta(meta)
            return

    raise ValueError(f"Portfolio '{pid}' no encontrado")
