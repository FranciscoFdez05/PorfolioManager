import json
import logging
import re
import shutil
import sqlite3
import threading
import time
import zipfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path

from flask import Blueprint, jsonify, request

from admin.backup_manager import _remove_wal_sidecars, _ruta_bloqueo, check_integrity, problema_de_portfolio
from core import clave_copias, exportables, paths, settings, telegram_notifier, zip_seguro
from core.bloqueo import BloqueoOcupado, exclusivo
from core.copia_sqlite import copiar as copiar_sqlite
from core.errors import mensajeAlmacenamiento, registrarFalloEscritura
from core.escritura import escribirAtomico, limpiarTemporal, rutaTemporal, temporalPara
from core.paths import (
    AJUSTES_JSON as _AJUSTES_SRC,
    BACKUPS_DIR as _BACKUP_DIR,
    DATA_DIR,
    JSON_DIR as _JSON_DIR,
    PORTFOLIOS_DIR as _PORTFOLIOS_DIR,
    PORTFOLIOS_META_FILE as _META_FILE,
)
from routes.ajustes import _RE_SAFE_PREFS_NAME, _read_ajustes

log = logging.getLogger(__name__)

# Serializa crear/restaurar/borrar backups DENTRO de este proceso. Dos
# restores simultáneos (o un restore mientras se crea un backup) se pisaban
# los ficheros .db a medio escribir y dejaban la BD activa corrupta.
#
# No basta por sí solo: gunicorn levanta dos workers —dos procesos de Python,
# cada uno con su propio `_BACKUP_LOCK`— y un restore en uno de ellos no
# bloqueaba nada en el otro. Ahí es donde entra `_bloqueo_cruzado()`, el mismo
# bloqueo de fichero que ya usa la copia automática del scheduler en
# admin.backup_manager para lo mismo.
_BACKUP_LOCK = threading.Lock()

backup_bp = Blueprint("backup", __name__)


@contextmanager
def _bloqueo_cruzado():
    """Bloqueo entre PROCESOS, compartido con la copia automática del scheduler.

    `_BACKUP_LOCK` protege los hilos de este worker; esto protege del otro
    worker de gunicorn, que corre en un proceso aparte y no ve ese Lock.
    Comparte el mismo fichero que `admin.backup_manager._ruta_bloqueo()`
    porque los dos tocan exactamente los mismos .db de data/portfolios.

    Espera unos segundos en vez de rendirse al primer intento: una copia
    automática dura poco, y merece la pena esperarla antes de decirle al
    usuario que lo intente de nuevo.
    """
    with exclusivo(_ruta_bloqueo(), espera=30):
        yield


def _respuesta_bloqueo_ocupado():
    return jsonify({
        "ok": False,
        "error": "Hay otra copia de seguridad en curso en el servidor; inténtalo de nuevo en unos segundos.",
    }), 503


# Las copias automáticas llevan el sufijo `_auto`: mismo formato y misma lista
# que las manuales —se restauran igual—, pero se distinguen a simple vista y el
# scheduler sabe cuál fue la última suya sin contar las que hizo el usuario.
_RE_ZIP = re.compile(r'^backup_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}(_auto)?\.zip$')
_RE_DB  = re.compile(r'^portfolio_\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2}\.db$')
# Nombres de portfolio admisibles al restaurar entradas de un zip
_RE_SAFE_DB_NAME = re.compile(r'^[A-Za-z0-9_-]{1,64}\.db$')
# Mismo alfabeto que exige admin.portfolios_manager para un id de portfolio: de
# ahí sale un nombre de fichero, así que ni barras ni puntos ni mayúsculas.
_RE_SAFE_PORTFOLIO_ID = re.compile(r'^[a-z0-9_-]{1,64}$')


def _problema_del_indice(crudo: bytes) -> str | None:
    """Motivo por el que no se puede confiar en un `portfolios.json` del zip.

    Devuelve None si el índice es utilizable. Se comprueba lo que después se
    convierte en una ruta: el id del portfolio activo y el de cada uno de los
    listados, porque `admin.portfolios_manager` construye con ellos el nombre
    del fichero `.db` que abrirá.

    No valida el resto del contenido —nombres visibles, claves de más— a
    propósito: lo que hay que impedir es que un id decida qué fichero se abre,
    no imponer un esquema a un fichero que puede crecer con las versiones.
    """
    try:
        meta = json.loads(crudo.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as error:
        return f"no es JSON válido ({error})"

    if not isinstance(meta, dict):
        return "no es un objeto JSON"

    ids = [meta.get("active")]

    listados = meta.get("portfolios")
    if listados is not None:
        if not isinstance(listados, list):
            return "la lista de portfolios no es una lista"
        for entrada in listados:
            if not isinstance(entrada, dict):
                return "hay un portfolio que no es un objeto"
            ids.append(entrada.get("id"))

    for pid in ids:
        # `active` puede faltar: quien lo lee tiene su propio valor por defecto.
        if pid is None:
            continue
        if not isinstance(pid, str) or not _RE_SAFE_PORTFOLIO_ID.match(pid):
            return f"identificador de portfolio no admisible: {pid!r}"

    return None


def _parse_dt(name):
    m = re.search(r'(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})', name)
    if not m:
        return datetime.min
    try:
        return datetime.strptime(m.group(1), "%d-%m-%Y_%H-%M-%S")
    except ValueError:
        return datetime.min


def _is_valid(name):
    return bool(_RE_ZIP.match(name) or _RE_DB.match(name))


def _list_backups():
    if not _BACKUP_DIR.exists():
        return []
    files = [
        f.name for f in _BACKUP_DIR.iterdir()
        if _RE_ZIP.match(f.name) or _RE_DB.match(f.name)
    ]
    return sorted(files, key=_parse_dt, reverse=True)


def _reemplazar_atomico_via_sqlite(origen: Path, destino: Path):
    """Sustituye el contenido de `destino` por el de `origen`, sin dejarlo a medias.

    Si `destino` ya existe se copia **dentro del mismo fichero** con la API de
    backup de SQLite. Esa copia va en una transacción de escritura del destino:
    si se corta (timeout del worker, disco), SQLite la deshace al reabrir y
    queda la base anterior entera. Y, a diferencia de un rename, la ven al
    instante las conexiones que el otro worker de gunicorn tenga abiertas: con
    `tmp.replace(destino)` esas conexiones seguían escribiendo en el inodo ya
    desvinculado hasta notar la generación nueva, y lo que escribiesen en ese
    intervalo se perdía. Es lo mismo que hace ya la importación de un ZIP.

    Solo si SQLite no puede copiar sobre la base en uso (p. ej. tamaños de
    página distintos con el destino en WAL) se cae a la vía anterior: copia a un
    temporal en la misma carpeta y rename atómico.
    """
    if destino.exists():
        try:
            copiar_sqlite(origen, destino)
            return
        except sqlite3.Error as error:
            log.warning("[backup] No se pudo copiar sobre %s (%s); se sustituye el fichero", destino.name, error)

    with temporalPara(destino) as tmp:
        copiar_sqlite(origen, tmp)
        _remove_wal_sidecars(tmp)
        tmp.replace(destino)
    _remove_wal_sidecars(destino)


def _safety_copy_before_restore() -> Path | None:
    """Guarda el estado actual de todos los portfolios antes de sobrescribirlos.

    Sin esto, restaurar el backup equivocado destruía de forma irreversible todo
    lo introducido desde ese backup: /api/restore sobrescribía los .db sin
    conservar ninguna copia del estado previo.
    """
    if not _PORTFOLIOS_DIR.exists():
        return None
    ts = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
    dest_dir = DATA_DIR / "pre_restore" / ts
    try:
        dest_dir.mkdir(parents=True, exist_ok=True)
        for db_file in sorted(_PORTFOLIOS_DIR.glob("*.db")):
            copiar_sqlite(db_file, dest_dir / db_file.name)
        if _META_FILE.exists():
            shutil.copy2(str(_META_FILE), str(dest_dir / "portfolios.json"))
        if _AJUSTES_SRC.exists():
            shutil.copy2(str(_AJUSTES_SRC), str(dest_dir / "ajustes.json"))
        log.info(f"[backup] Copia previa al restore guardada en {dest_dir}")
        return dest_dir
    except Exception as e:
        log.error(f"[backup] No se pudo crear la copia previa al restore: {e}")
        return None


@contextmanager
def bloqueo_restauracion():
    """Los dos cerrojos de /api/restore, para quien sustituya datos fuera de él.

    «Importar ZIP» e «Importar JSON» sobrescriben la cartera activa igual que
    una restauración, pero no tomaban ningún cerrojo: podían cruzarse con una
    copia automática o con un restore del otro worker. Lanza BloqueoOcupado
    si no se consigue a tiempo.
    """
    with _bloqueo_cruzado(), _BACKUP_LOCK:
        yield


def copia_previa_obligatoria() -> tuple[Path | None, bool]:
    """Copia del estado actual antes de sustituirlo: `(carpeta, ok)`.

    `ok` es False solo si había portfolios que proteger y no se pudo copiarlos.
    En ese caso quien llama no debe seguir: lo que viniera después no tendría
    vuelta atrás.
    """
    copia = _safety_copy_before_restore()
    return copia, copia is not None or not _PORTFOLIOS_DIR.exists()


def respuesta_sin_copia_previa():
    return jsonify({
        "ok": False,
        "error": "No se pudo guardar una copia del estado actual, así que no se ha cambiado nada. "
                 "Revisa el espacio libre y los permisos de data/.",
    }), 500


def _tmp_dir(crear=True) -> Path:
    """Carpeta de temporales (core.paths.TMP_DIR), creada a demanda.

    Se lee del módulo `paths` en cada llamada, y no con un `from … import` al
    principio: así sigue siendo la única definición de la ruta y los tests, que
    la reasignan para no tocar el `data/` real, alcanzan también a este módulo.
    """
    destino = paths.TMP_DIR
    if crear:
        destino.mkdir(parents=True, exist_ok=True)
    return destino


@contextmanager
def _copia_temporal(src_path: Path):
    """Copia consistente de un .db en un fichero temporal, ya cerrada.

    El temporal va a data/tmp y no a data/portfolios: allí, un
    `_tmp_bak_x.db` a medio escribir entraba en cualquier `glob("*.db")` —la
    rotación de copias automáticas, el scheduler de snapshots, el listado de
    portfolios— como si fuera un portfolio de verdad. Con el servidor de
    desarrollo (un proceso, un hilo) la ventana era estrecha; con los dos
    workers y cuatro hilos de gunicorn del contenedor, deja de serlo.

    Se devuelve la ruta y no los bytes porque zipfile puede leer del fichero
    directamente: cargar en memoria una BD de decenas de MB por cada portfolio
    era gratis en un PC y no lo es en el servidor doméstico donde corre esto.
    """
    with temporalPara(src_path, directorio=_tmp_dir()) as tmp_path:
        copiar_sqlite(src_path, tmp_path)
        yield tmp_path


def _checkpoint_active_db():
    """Vuelca el WAL de la BD activa antes de copiarla al zip.

    Sustituye al antiguo _snapshot_now(), que importaba
    routes.snapshots._compute_portfolio_totals — una función que no existe en
    ningún módulo. Su ImportError se tragaba el 'except Exception: pass', así
    que el paso previo al backup nunca hizo nada. Los totales solo puede
    calcularlos el frontend (los envía a /api/portfolio/snapshot con precios de
    mercado frescos), de modo que aquí basta con asegurar que lo ya confirmado
    esté en el fichero .db.
    """
    try:
        from core.db import get_db
        conn = get_db()
        conn.commit()
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except Exception as e:
        log.warning(f"[backup] No se pudo hacer checkpoint de la BD activa: {e}")


def _export_snapshots_json(db_path: Path) -> str:
    """Lee todos los snapshots del DB y los devuelve como JSON string."""
    conn = None
    try:
        conn = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            "SELECT ts, total_value, total_invested FROM portfolio_snapshots ORDER BY ts ASC"
        ).fetchall()
        data = [{"ts": r["ts"], "v": r["total_value"], "i": r["total_invested"]} for r in rows]
        return json.dumps(data, ensure_ascii=False)
    except Exception as e:
        log.warning(f"[backup] No se pudieron exportar snapshots de {db_path.name}: {e}")
        return "[]"
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _megas(nombre: str) -> str:
    try:
        return f"{(_BACKUP_DIR / nombre).stat().st_size / 1024 / 1024:.1f} MB".replace(".", ",")
    except OSError:
        return "tamaño desconocido"


def _avisar_copia_creada(nombre: str, automatica: bool) -> None:
    """Cuenta por Telegram que se ha hecho una copia, con su tamaño y cuántas hay."""
    try:
        portfolios = len(list(_PORTFOLIOS_DIR.glob("*.db"))) if _PORTFOLIOS_DIR.exists() else 0
        telegram_notifier.notificar(
            "backup",
            f"💾 Copia de seguridad {'automática' if automatica else 'manual'} creada\n"
            f"{nombre} · {_megas(nombre)} · {portfolios} portfolio(s)\n"
            f"Copias guardadas: {len(_list_backups())}",
        )
    except Exception as error:
        log.debug("[backup] No se pudo avisar de la copia: %s", error)


def _enviar_copia_a_telegram(nombre: str) -> None:
    """Manda el ZIP de una copia automática al chat de Telegram.

    Si el fichero no sale (sin Telegram, categoría apagada, error de red) se
    cae al aviso de texto de siempre, para que al menos conste que se hizo.
    """
    portfolios = len(list(_PORTFOLIOS_DIR.glob("*.db"))) if _PORTFOLIOS_DIR.exists() else 0
    claves = " · con claves de API" if _incluir_claves() else ""
    pie = (f"💾 Copia de seguridad automática\n{nombre} · {_megas(nombre)} · "
           f"{portfolios} portfolio(s){claves}")
    if not telegram_notifier.notificar_archivo("backupFichero", _BACKUP_DIR / nombre, pie):
        _avisar_copia_creada(nombre, automatica=True)


def _incluir_claves() -> bool:
    return bool(_read_ajustes().get("backupIncluirClaves"))


def _claves_cifradas_para_zip() -> bytes | None:
    """`claves-api.cifradas.json` listo para meter en el ZIP, o None si no procede.

    Procede si el usuario lo ha pedido en Ajustes. Se cifran con la contraseña
    propia de las copias si la hay y, si no, con el hash de la contraseña de
    acceso a la web (con las credenciales por defecto no hay nada con lo que
    cifrar). Falla hacia «sin claves» y lo deja en el log: una copia sin claves
    sirve; una con las claves sin proteger no debe existir nunca.
    """
    if not _incluir_claves():
        return None
    if clave_copias.configurada():
        claves = exportables.clavesEnClaro()
        paquete = clave_copias.cifrar(claves) if claves else None
        return json.dumps(paquete, ensure_ascii=False).encode("utf-8") if paquete else None

    from routes.auth import _load_credentials

    usuario, hash_app = _load_credentials()
    if usuario == "__no_user__":
        log.warning("[backup] Se piden las claves en la copia pero no hay contraseña de acceso: se omiten")
        return None
    claves = exportables.clavesEnClaro()
    if not claves:
        return None
    paquete = exportables.cifrarClavesConHashApp(claves, hash_app)
    return json.dumps(paquete, ensure_ascii=False).encode("utf-8")


def _avisar_copia_fallida(motivo, automatica: bool) -> None:
    telegram_notifier.notificar(
        "backup",
        f"❌ Ha fallado la copia de seguridad {'automática' if automatica else 'manual'}\n"
        f"{str(motivo)[:300]}",
    )


@backup_bp.route("/api/backup", methods=["POST"])
def createBackup():
    try:
        with _bloqueo_cruzado(), _BACKUP_LOCK:
            return _create_backup_locked()
    except BloqueoOcupado:
        return _respuesta_bloqueo_ocupado()


def crear_backup_automatico() -> str:
    """Copia completa hecha por el scheduler. Devuelve el nombre del fichero.

    Es la misma copia que «Crear backup ahora» —todos los portfolios, ajustes,
    preferencias y manifest— con `_auto` en el nombre. Antes el automático
    escribía un `.db` por portfolio en `data/backups/auto/`, que la pantalla de
    Ajustes no listaba y desde la que no se podía restaurar: para el usuario
    era como si no existiera. Lanza la excepción al que llama; el scheduler la
    registra y lo reintenta en la siguiente pasada.
    """
    with _BACKUP_LOCK:
        try:
            nombre = _escribir_backup(automatico=True)
        except Exception as error:
            _avisar_copia_fallida(error, automatica=True)
            raise
    _enviar_copia_a_telegram(nombre)
    return nombre


def crear_backup_manual(avisar=True) -> str:
    """Copia completa a petición, fuera de una petición HTTP (p. ej. `/backup` del bot).

    Toma los mismos dos cerrojos que `POST /api/backup`. Lanza `BloqueoOcupado`
    si otro proceso está copiando, y la excepción original si la copia falla.
    Con `avisar=False` no manda el aviso de Telegram: quien la pide responde él.
    """
    with _bloqueo_cruzado(), _BACKUP_LOCK:
        _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        listo, motivo = _preparar_destino()
        if not listo:
            raise OSError(motivo)
        nombre = _escribir_backup(automatico=False)
    if avisar:
        _avisar_copia_creada(nombre, automatica=False)
    return nombre


def _preparar_destino():
    """Comprueba que se pueda escribir donde va a ir la copia. (ok, mensaje).

    Se hace **antes** de empezar el zip, y creando un fichero de verdad: con el
    volumen de Docker montado de solo lectura o perteneciente a otro usuario, la
    copia fallaba a mitad y el usuario recibía un 500 sin causa.
    """
    for destino in (_BACKUP_DIR, _tmp_dir(crear=False)):
        escribible, motivo = paths.comprobarEscritura(destino)
        if not escribible:
            return False, (
                f"no se puede escribir en {destino}: {motivo}. "
                "Comprueba los permisos del volumen de datos"
            )
    return True, ""


def _limpiar_temporales_huerfanos(antiguedad_segundos=3600):
    """Barre las copias temporales que dejó un proceso muerto a media copia.

    El `finally` de _copia_temporal cubre cualquier excepción, pero no que el
    contenedor se pare —o que Docker mate al worker— justo mientras copia. Sin
    esto, cada uno de esos cortes deja para siempre una copia entera de la base
    de datos ocupando disco.
    """
    limite = time.time() - antiguedad_segundos
    candidatos = []
    # Los temporales de copia se llaman ya `.<destino>.<pid>-<hilo>-<hex>.tmp`
    # (core.escritura.rutaTemporal), más los sidecars -wal/-shm que SQLite deja
    # al lado; `_bak_*` es el nombre de versiones anteriores. El ZIP a medio
    # escribir se queda en la carpeta de copias como `_tmp_backup_*.zip`. Antes
    # solo se buscaba `_bak_*` y nada de lo que se crea hoy se barría nunca.
    for carpeta, patrones in (
        (_tmp_dir(crear=False), ("_bak_*", ".*.tmp", ".*.tmp-wal", ".*.tmp-shm", ".*.tmp-journal")),
        (_BACKUP_DIR, ("_tmp_backup_*.zip",)),
    ):
        for patron in patrones:
            try:
                candidatos.extend(carpeta.glob(patron))
            except OSError:
                continue
    for viejo in candidatos:
        try:
            if viejo.stat().st_mtime < limite:
                viejo.unlink(missing_ok=True)
                log.info("[backup] Temporal huérfano eliminado: %s", viejo.name)
        except OSError:
            pass


def _create_backup_locked():
    try:
        _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        mensaje = registrarFalloEscritura(
            log, "[backup] No se pudo preparar el directorio de copias", e, _BACKUP_DIR
        )
        return jsonify({"ok": False, "error": mensaje}), 500

    listo, motivo = _preparar_destino()
    if not listo:
        log.error("[backup] Destino no escribible: %s", motivo)
        _avisar_copia_fallida(motivo, automatica=False)
        return jsonify({"ok": False, "error": motivo}), 500

    try:
        filename = _escribir_backup(automatico=False)
    except Exception as e:
        # Traza completa al log y, al usuario, la causa real: sin ella el
        # "Error al crear backup" de la pantalla de Ajustes no distinguía entre
        # un volumen sin permisos, un disco lleno y una BD bloqueada.
        mensaje = registrarFalloEscritura(log, "[backup] Error creando backup", e, _BACKUP_DIR)
        _avisar_copia_fallida(mensaje, automatica=False)
        return jsonify({"ok": False, "error": mensaje}), 500

    _avisar_copia_creada(filename, automatica=False)
    return jsonify({"ok": True, "filename": filename, "backups": _list_backups()})


def _escribir_backup(*, automatico: bool) -> str:
    """Escribe el zip, rota las copias sobrantes y devuelve el nombre.

    Se llama con `_BACKUP_LOCK` cogido. Cualquier fallo sale como excepción,
    sin dejar el temporal a medias: quien llama decide si es un 500 o una
    línea de log.
    """
    _BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    _limpiar_temporales_huerfanos()
    if not automatico:
        # Solo en la copia manual. `_checkpoint_active_db` pasa por get_db(),
        # que en su primera llamada aplica el esquema: la copia automática del
        # arranque se hace justo antes de migrar y tiene que quedar sin migrar.
        # No pierde nada por saltárselo: `_copia_temporal` usa la API de backup
        # de SQLite, que ya lleva lo confirmado en el WAL.
        _checkpoint_active_db()

    ts = datetime.now().strftime("%d-%m-%Y_%H-%M-%S")
    filename = f"backup_{ts}{'_auto' if automatico else ''}.zip"
    backup_path = _BACKUP_DIR / filename
    tmp_path = _BACKUP_DIR / f"_tmp_{filename}"

    portfolio_names = []
    try:
        with zipfile.ZipFile(str(tmp_path), "w", zipfile.ZIP_DEFLATED) as zf:
            # Todos los portfolios + snapshots JSON de seguridad
            if _PORTFOLIOS_DIR.exists():
                for db_file in sorted(_PORTFOLIOS_DIR.glob("*.db")):
                    with _copia_temporal(db_file) as copia:
                        # Una copia dañada no entra: sustituiría en la rotación
                        # a otras buenas y no serviría para restaurar nada.
                        if not check_integrity(copia):
                            raise RuntimeError(
                                f"El portfolio {db_file.name} no pasa la comprobación de integridad"
                            )
                        zf.write(str(copia), f"portfolios/{db_file.name}")
                    snap_json = _export_snapshots_json(db_file)
                    zf.writestr(f"snapshots/{db_file.stem}.json", snap_json)
                    portfolio_names.append(db_file.stem)

            # Meta de portfolios
            if _META_FILE.exists():
                zf.write(str(_META_FILE), "portfolios.json")

            # Ajustes globales
            if _AJUSTES_SRC.exists():
                zf.write(str(_AJUSTES_SRC), "ajustes.json")

            # Preferencias por-portfolio
            if _JSON_DIR.exists():
                for prefs_file in sorted(_JSON_DIR.glob("prefs_*.json")):
                    zf.write(str(prefs_file), f"prefs/{prefs_file.name}")

            # Claves de API, cifradas con el hash de la contraseña de la web
            claves = _claves_cifradas_para_zip()
            if claves is not None:
                zf.writestr(exportables.FICHERO_CLAVES_CIFRADAS, claves)

            # Manifest con metadatos del backup
            manifest = {
                "created_at": datetime.now().isoformat(),
                "version": 2,
                "portfolios": portfolio_names,
                "claves": claves is not None,
            }
            zf.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))

        # Validar el zip antes de aceptarlo como definitivo
        with zipfile.ZipFile(str(tmp_path), "r") as zf:
            bad = zf.testzip()
            if bad:
                raise RuntimeError(f"Zip corrupto: {bad}")

        tmp_path.replace(backup_path)

    except Exception:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass
        raise

    all_backups = _list_backups()
    try:
        max_backups = int(_read_ajustes().get("maxBackups") or 0)
    except (TypeError, ValueError):
        max_backups = 0
    if max_backups > 0 and len(all_backups) > max_backups:
        for old in all_backups[max_backups:]:
            # Nunca borrar el que acabamos de crear, pase lo que pase con el orden
            if old == filename:
                continue
            (_BACKUP_DIR / old).unlink(missing_ok=True)

    return filename


@backup_bp.route("/api/backups", methods=["GET"])
def listBackups():
    return jsonify({"backups": _list_backups()})


@backup_bp.route("/api/restore", methods=["POST"])
def restoreBackup():
    try:
        with _bloqueo_cruzado(), _BACKUP_LOCK:
            return _restore_locked()
    except BloqueoOcupado:
        return _respuesta_bloqueo_ocupado()


def es_backup_completo(nombres) -> bool:
    """¿Este zip es una copia de seguridad de todas las carteras?

    Se distingue por la carpeta `portfolios/`, que es donde el backup guarda
    cada `.db`; un export de una sola cartera lo lleva en la raíz. Saberlo
    importa porque el mismo fichero se puede soltar en dos sitios distintos de
    la interfaz, y el «Importar ZIP» de Ajustes se tragaba el backup en
    silencio: no encontraba el `.db` en la raíz, restauraba solo los ajustes y
    respondía que todo había ido bien.
    """
    return any(n.startswith("portfolios/") and n.endswith(".db") for n in nombres)


def restaurar_backup_subido(zip_path: Path):
    """Restaura un backup que llega subido, en vez de estar en data/backups.

    Toma el mismo cerrojo que /api/restore: da igual por dónde entre el
    fichero, dos restauraciones a la vez se pisan los `.db` igual de mal. La
    respuesta es la misma que la de /api/restore —incluidos `safetyCopy` e
    `ignorados`—, que es justo lo que el usuario necesita saber.
    """
    try:
        with _bloqueo_cruzado(), _BACKUP_LOCK:
            return _restaurar_archivo(zip_path, zip_path.name, es_zip=True)
    except BloqueoOcupado:
        return _respuesta_bloqueo_ocupado()


def _restore_locked():
    data = request.get_json(silent=True) or {}
    filename = str(data.get("filename", "")).strip()

    if not _is_valid(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    return _restaurar_archivo(backup_path, filename, es_zip=bool(_RE_ZIP.match(filename)))


def _validar_zip_de_copia(backup_path: Path):
    """Respuesta de error si el ZIP no se puede restaurar, o None.

    Se valida ANTES de tocar nada: si está corrupto se abortaba a mitad de la
    restauración, con parte de los portfolios ya sobrescritos.
    """
    try:
        with zipfile.ZipFile(str(backup_path), "r") as zf:
            # Antes que testzip(), que descomprime todo para validar el CRC.
            zip_seguro.comprobar(zf)
            bad = zf.testzip()
            if bad:
                return jsonify({"ok": False, "error": f"Backup corrupto: {bad}"}), 400
    except zipfile.BadZipFile:
        return jsonify({"ok": False, "error": "El backup no es un ZIP válido"}), 400
    except zip_seguro.ZipNoAdmitido as error:
        return jsonify({"ok": False, "error": str(error)}), 400
    return None


def _restaurar_una_base(zf, name: str, ignorados: list) -> None:
    # Path(...).name descarta cualquier ../ del nombre de entrada
    db_name = Path(name).name
    if not _RE_SAFE_DB_NAME.match(db_name):
        log.warning(f"[backup] Entrada de zip ignorada por nombre inseguro: {name}")
        ignorados.append(f"{name}: nombre no admisible")
        return
    dst_path = _PORTFOLIOS_DIR / db_name
    # El temporal va a data/tmp: `_restore_tmp_<x>.db` en data/portfolios
    # entraba en los `glob("*.db")` como un portfolio más mientras duraba la
    # restauración. Se extrae a disco, no a memoria (ver core/zip_seguro.py).
    tmp_path = rutaTemporal(dst_path, directorio=_tmp_dir())
    try:
        zip_seguro.extraer(zf, name, tmp_path)
        # La misma validación que «Importar cartera» e «Importar ZIP»: la
        # cabecera sola (16 bytes) no dice si el resto del fichero es legible ni
        # si es un portfolio, y una base dañada sustituía a una buena.
        problema = problema_de_portfolio(tmp_path, exigir_activos=False)
        if problema:
            log.warning(f"[backup] Entrada {name} ignorada: {problema}")
            ignorados.append(f"{name}: {problema}")
            return
        _reemplazar_atomico_via_sqlite(tmp_path, dst_path)
    except Exception as e:
        # La cabecera "SQLite format 3" son 16 bytes: acertarla no garantiza que
        # el resto del fichero sea legible. Antes, una sola entrada así abortaba
        # la restauración completa y dejaba los portfolios ya procesados
        # mezclados con los que aún no se habían tocado. Ahora se salta y se
        # informa de cuál falló.
        log.error(f"[backup] No se pudo restaurar {name}: {e}")
        ignorados.append(f"{name}: {e}")
    finally:
        limpiarTemporal(tmp_path)


def _restaurar_indice(zf, names, ignorados: list) -> None:
    """portfolios.json, con escritura atómica.

    Es el único contenido del zip que se usa como ruta: de aquí sale el id del
    portfolio activo, y con él el fichero .db que la aplicación abrirá al
    arrancar. Los .db y los prefs ya se filtran por nombre; esto es lo mismo
    para el índice, y hace falta desde que se puede importar un zip que no ha
    generado esta instalación. Un índice que no pase se ignora y se dice: mejor
    quedarse con el que ya había que restaurar uno que apunta fuera del
    directorio de datos.
    """
    if "portfolios.json" not in names:
        return
    meta_cruda = zf.read("portfolios.json")
    problema = _problema_del_indice(meta_cruda)
    if problema:
        log.warning("[backup] portfolios.json ignorado: %s", problema)
        ignorados.append(f"portfolios.json: {problema}")
    else:
        escribirAtomico(_META_FILE, meta_cruda)


def _restaurar_prefs(zf, names, ignorados: list) -> None:
    for name in names:
        if not (name.startswith("prefs/") and name.endswith(".json")):
            continue
        prefs_name = Path(name).name
        if not _RE_SAFE_PREFS_NAME.match(prefs_name):
            log.warning(f"[backup] Entrada de prefs ignorada por nombre inseguro: {name}")
            ignorados.append(f"{name}: nombre no admisible")
            continue
        escribirAtomico(_JSON_DIR / prefs_name, zf.read(name))


def _restaurar_snapshots_de(zf, name: str) -> None:
    """Snapshots desde el JSON de seguridad, solo si la base restaurada no tiene."""
    db_path = _PORTFOLIOS_DIR / f"{Path(name).stem}.db"
    if not db_path.exists():
        return
    conn = None
    try:
        snap_data = json.loads(zf.read(name).decode("utf-8"))
        if not isinstance(snap_data, list) or not snap_data:
            return
        conn = sqlite3.connect(str(db_path), timeout=settings.backupSqliteTimeout())
        if conn.execute("SELECT 1 FROM portfolio_snapshots LIMIT 1").fetchone():
            return
        conn.executemany(
            "INSERT OR IGNORE INTO portfolio_snapshots (ts, total_value, total_invested) VALUES (?,?,?)",
            [(r["ts"], r["v"], r["i"]) for r in snap_data if isinstance(r, dict) and "ts" in r],
        )
        conn.commit()
    except Exception as e:
        log.warning(f"[backup] No se pudieron restaurar snapshots de {name}: {e}")
    finally:
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


def _restaurar_desde_zip(backup_path: Path, claves, ignorados: list) -> list:
    """Todo lo que trae una copia completa. Devuelve las claves restauradas."""
    claves_restauradas = []
    with zipfile.ZipFile(str(backup_path), "r") as zf:
        names = zf.namelist()

        _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
        for name in names:
            if name.startswith("portfolios/") and name.endswith(".db"):
                _restaurar_una_base(zf, name, ignorados)

        _restaurar_indice(zf, names, ignorados)
        if "ajustes.json" in names:
            escribirAtomico(_AJUSTES_SRC, zf.read("ajustes.json"))
        # Claves de API: entran en claro y salen cifradas con la SECRET_KEY de
        # esta instalación.
        if claves:
            claves_restauradas = exportables.restaurarClaves(claves)
        _restaurar_prefs(zf, names, ignorados)
        for name in names:
            if name.startswith("snapshots/") and name.endswith(".json"):
                _restaurar_snapshots_de(zf, name)

    # Re-activar el portfolio que estaba activo en el backup
    try:
        from admin.portfolios_manager import init_portfolios
        init_portfolios()
    except Exception:
        pass
    return claves_restauradas


def _restaurar_db_suelto(backup_path: Path, filename: str) -> None:
    """Formato legacy .db: restaura solo el portfolio activo."""
    from core.db import get_active_db_path

    _reemplazar_atomico_via_sqlite(backup_path, get_active_db_path())
    ts_m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
    if ts_m:
        ajustes_bak = _BACKUP_DIR / f"ajustes_{ts_m.group(1)}.json"
        if ajustes_bak.exists():
            _AJUSTES_SRC.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(ajustes_bak, _AJUSTES_SRC)


def _restaurar_archivo(backup_path: Path, filename: str, *, es_zip: bool):
    """El restore propiamente dicho, ya con el fichero localizado.

    Separado de la vista porque hay dos caminos hasta aquí: restaurar una copia
    de la lista de Ajustes y subir ese mismo zip por «Importar ZIP». Antes cada
    uno tenía su propia idea de qué hacer con el fichero.
    """
    if es_zip:
        rechazo = _validar_zip_de_copia(backup_path)
        if rechazo is not None:
            return rechazo

    # Las claves se abren ANTES de tocar nada, por lo mismo que se valida el zip:
    # si hace falta una contraseña que no llega, se pide y no se ha cambiado nada.
    claves, rechazo = _claves_del_zip(backup_path) if es_zip else (None, None)
    if rechazo is not None:
        return rechazo

    # Sin copia previa no se sigue: antes se continuaba igualmente y un restore
    # equivocado ya no tenía vuelta atrás.
    safety_dir, copia_ok = copia_previa_obligatoria()
    if not copia_ok:
        return respuesta_sin_copia_previa()
    copia = str(safety_dir) if safety_dir else None

    # Entradas del zip que no se han podido restaurar. Se acumulan en vez de
    # abortar: si el backup trae cinco portfolios y uno está dañado, interesa
    # recuperar los otros cuatro y saber cuál falta, no perderlo todo.
    ignorados: list[str] = []
    claves_restauradas: list[str] = []

    from core.db import invalidate_all_connections
    invalidate_all_connections()
    try:
        if es_zip:
            claves_restauradas = _restaurar_desde_zip(backup_path, claves, ignorados)
        else:
            _restaurar_db_suelto(backup_path, filename)
    except Exception as e:
        mensaje = registrarFalloEscritura(
            log, f"[backup] Error en restore de {filename}", e, _PORTFOLIOS_DIR
        )
        telegram_notifier.notificar("backup", f"❌ Ha fallado la restauración de {filename}\n{mensaje[:300]}")
        return jsonify({"ok": False, "error": mensaje, "safetyCopy": copia, "ignorados": ignorados}), 500
    finally:
        # Los .db han cambiado bajo los pies de las conexiones cacheadas
        invalidate_all_connections()

    if ignorados:
        log.warning("[backup] Restauración parcial: %d entradas ignoradas", len(ignorados))
    telegram_notifier.notificar(
        "backup",
        f"♻️ Copia restaurada: {filename}"
        + (f"\n⚠️ Restauración parcial: {len(ignorados)} entrada(s) ignorada(s)" if ignorados else "")
        + (f"\nEl estado anterior quedó en {safety_dir}" if safety_dir else ""),
    )
    return jsonify({
        "ok": True,
        "safetyCopy": copia,
        # El frontend debe avisar si la restauración fue parcial: un "ok" a
        # secas después de perder un portfolio sería el peor resultado posible.
        "ignorados": ignorados,
        "claves": claves_restauradas,
    })


def _claves_del_zip(zip_path: Path):
    """(claves, None) si el ZIP las trae y se han podido abrir; (None, None) si no
    hay que restaurarlas; (None, respuesta) si hay que parar y pedir la contraseña.

    Se prueba primero con el hash actual de la contraseña de la web, así que una
    copia hecha con la contraseña de hoy se restaura sin preguntar nada. Si la
    contraseña ha cambiado desde entonces, el navegador la pide y reenvía.
    """
    cuerpo = request.get_json(silent=True) or {}
    contrasena = str(request.form.get("contrasena") or cuerpo.get("contrasena") or "")
    sin_claves = str(request.form.get("sinClaves") or cuerpo.get("sinClaves") or "") in {"1", "true", "True"}
    if sin_claves:
        return None, None

    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            if exportables.FICHERO_CLAVES_CIFRADAS not in zf.namelist():
                return None, None
            paquete = json.loads(zf.read(exportables.FICHERO_CLAVES_CIFRADAS).decode("utf-8"))
    except (OSError, ValueError, zipfile.BadZipFile):
        return None, (jsonify({"ok": False, "error": "No se pueden leer las claves del backup"}), 400)

    if isinstance(paquete, dict) and paquete.get("formato") == clave_copias.FORMATO:
        return _abrir_claves_con_contrasena_de_copias(paquete, contrasena)

    if not exportables.esPaqueteDeHashApp(paquete):
        return None, None

    from routes.auth import _load_credentials

    try:
        return exportables.descifrarClavesConHashApp(
            paquete, hash_app=_load_credentials()[1], contrasena=contrasena[:exportables.MAX_LARGO_CONTRASENA]
        ), None
    except exportables.ContrasenaIncorrecta:
        return None, (jsonify({
            "ok": False,
            "necesitaContrasena": True,
            "error": "Contraseña incorrecta" if contrasena else
                     "El backup lleva las claves de API protegidas con la contraseña de la web",
        }), 400)


def _abrir_claves_con_contrasena_de_copias(paquete, contrasena: str):
    """(claves, None) o (None, respuesta) para un ZIP con la contraseña propia de las copias.

    Si la sal es la de este servidor se abre sin preguntar; si no (otro servidor, o
    la contraseña se cambió después), hace falta la contraseña de entonces.
    """
    claves = clave_copias.abrir_sin_contrasena(paquete)
    if claves is not None:
        return claves, None
    try:
        return exportables.descifrarClaves(paquete, contrasena[:exportables.MAX_LARGO_CONTRASENA]), None
    except exportables.ContrasenaIncorrecta:
        return None, (jsonify({
            "ok": False,
            "necesitaContrasena": True,
            "error": "Contraseña incorrecta" if contrasena else
                     "El backup lleva las claves de API protegidas con la contraseña de las copias",
        }), 400)


@backup_bp.route("/api/backup/contrasena", methods=["POST"])
def fijarContrasenaCopias():
    cuerpo = request.get_json(silent=True) or {}
    contrasena = cuerpo.get("contrasena")
    problema = clave_copias.validar(contrasena)
    if problema:
        return jsonify({"ok": False, "error": problema}), 400
    try:
        clave_copias.fijar(contrasena)
    except clave_copias.SinSecretKey:
        return jsonify({
            "ok": False,
            "error": "Define SECRET_KEY en el servidor: sin ella la contraseña no se puede guardar protegida",
        }), 400
    except OSError as e:
        return jsonify({"ok": False, "error": mensajeAlmacenamiento(e, DATA_DIR)}), 500
    return jsonify({"ok": True, "configurada": True})


@backup_bp.route("/api/backup/contrasena/ver", methods=["POST"])
def verContrasenaCopias():
    """La contraseña de las copias, tras confirmar la contraseña de acceso a la web.

    Comparte el contador de intentos con /login: es otro sitio donde probarla.
    """
    from werkzeug.security import check_password_hash

    from routes import auth

    bloqueado = auth._rechazar_si_bloqueado()
    if bloqueado:
        return bloqueado
    actual = auth._texto(auth._cuerpo_dict().get("currentPassword"))
    _usuario, hash_app = auth._load_credentials()
    if not check_password_hash(hash_app, actual):
        auth._record_failure(auth._client_ip())
        auth._avisar_si_se_bloquea(auth._client_ip())
        return jsonify({"ok": False, "error": "Contraseña de acceso incorrecta"}), 400
    auth._clear_failures(auth._client_ip())

    contrasena = clave_copias.contrasena_guardada()
    if contrasena is None:
        return jsonify({
            "ok": False,
            "error": "No hay contraseña guardada que mostrar: vuelve a fijarla",
        }), 404
    respuesta = jsonify({"ok": True, "contrasena": contrasena})
    respuesta.headers["Cache-Control"] = "no-store"
    return respuesta


@backup_bp.route("/api/backup/contrasena", methods=["DELETE"])
def quitarContrasenaCopias():
    try:
        clave_copias.quitar()
    except OSError as e:
        return jsonify({"ok": False, "error": mensajeAlmacenamiento(e, DATA_DIR)}), 500
    return jsonify({"ok": True, "configurada": False})


@backup_bp.route("/api/backups/<filename>", methods=["DELETE"])
def deleteBackup(filename):
    filename = filename.strip()
    if not _is_valid(filename):
        return jsonify({"ok": False, "error": "Nombre de fichero inválido"}), 400

    backup_path = _BACKUP_DIR / filename
    if not backup_path.exists():
        return jsonify({"ok": False, "error": "Backup no encontrado"}), 404

    try:
        with _bloqueo_cruzado(), _BACKUP_LOCK:
            # No dejar al usuario sin ningún backup: el último es la única red de
            # seguridad frente a una corrupción o un borrado accidental.
            if len(_list_backups()) <= 1:
                return jsonify({
                    "ok": False,
                    "error": "No se puede eliminar el único backup existente",
                }), 400
            try:
                backup_path.unlink(missing_ok=True)
            except OSError as e:
                log.exception("[backup] No se pudo eliminar %s", filename)
                return jsonify({
                    "ok": False,
                    "error": mensajeAlmacenamiento(e, backup_path),
                }), 500
    except BloqueoOcupado:
        return _respuesta_bloqueo_ocupado()

    telegram_notifier.notificar("backup", f"🗑 Copia eliminada: {filename}")

    # Borrar ajustes snapshot legacy si existe
    ts_m = re.search(r'portfolio_(\d{2}-\d{2}-\d{4}_\d{2}-\d{2}-\d{2})\.db', filename)
    if ts_m:
        ajustes_snap = _BACKUP_DIR / f"ajustes_{ts_m.group(1)}.json"
        if ajustes_snap.exists():
            ajustes_snap.unlink()

    return jsonify({"ok": True, "backups": _list_backups()})
