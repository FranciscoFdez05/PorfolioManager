import json
import re
import shutil
from pathlib import Path

_BASE_DIR = Path(__file__).resolve().parent.parent
_META_FILE = _BASE_DIR / "data" / "portfolios.json"
_PORTFOLIOS_DIR = _BASE_DIR / "data" / "portfolios"
_LEGACY_DB = _BASE_DIR / "data" / "portfolio.db"


def _read_meta():
    if not _META_FILE.exists():
        return None
    try:
        return json.loads(_META_FILE.read_text("utf-8"))
    except Exception:
        return None


def _write_meta(data):
    _META_FILE.parent.mkdir(parents=True, exist_ok=True)
    _META_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")


def _safe_id(name: str) -> str:
    return re.sub(r"[^a-z0-9_-]", "_", name.lower().strip())[:40] or "portfolio"


def _set_active(db_path: Path):
    from db import set_active_db_path
    set_active_db_path(db_path)


def _migrate_legacy_gastos(active_db_path: Path):
    """Copia datos de gastos de portfolio.db (legacy) al DB activo si el activo está vacío."""
    if not _LEGACY_DB.exists():
        return
    try:
        import sqlite3
        src = sqlite3.connect(str(_LEGACY_DB))
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

        dst = sqlite3.connect(str(active_db_path))
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

        dst.commit()
        dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        dst.commit()
        dst.close()
        src.close()
    except Exception as e:
        print(f"[gastos migration] Aviso: {e}")


def init_portfolios():
    """Llamado al arrancar el servidor. Migra el DB legacy si es necesario y activa el portfolio."""
    meta = _read_meta()

    if meta is None:
        _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
        default_id = "principal"
        default_db = _PORTFOLIOS_DIR / f"{default_id}.db"

        if _LEGACY_DB.exists() and not default_db.exists():
            shutil.copy2(str(_LEGACY_DB), str(default_db))

        meta = {
            "active": default_id,
            "portfolios": [{"id": default_id, "name": "Principal"}],
        }
        _write_meta(meta)

    _PORTFOLIOS_DIR.mkdir(parents=True, exist_ok=True)
    active_id = meta.get("active", "principal")
    active_db = _PORTFOLIOS_DIR / f"{active_id}.db"
    _migrate_legacy_gastos(active_db)
    _set_active(active_db)
    return meta


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

    from db import init_db_at_path
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

    meta["active"] = pid
    _write_meta(meta)
    _set_active(_PORTFOLIOS_DIR / f"{pid}.db")


def delete_portfolio(pid: str):
    meta = get_portfolios()
    if meta["active"] == pid:
        raise ValueError("No puedes eliminar el portfolio activo")
    if len(meta["portfolios"]) <= 1:
        raise ValueError("Debe existir al menos un portfolio")

    meta["portfolios"] = [p for p in meta["portfolios"] if p["id"] != pid]
    _write_meta(meta)

    db_file = _PORTFOLIOS_DIR / f"{pid}.db"
    if db_file.exists():
        db_file.unlink()


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
