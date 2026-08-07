import functools
import logging
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

from core.paths import BASE_DIR

log = logging.getLogger(__name__)

_DB_PATH = BASE_DIR / "data" / "portfolio.db"  # overridden by portfolios_manager on startup
_local = threading.local()
_reset_generation = 0
_initialized_paths: set = set()  # DB paths that have already had schema + migration applied
_init_lock = threading.Lock()


def set_active_db_path(path) -> None:
    global _DB_PATH
    _DB_PATH = Path(path)
    invalidate_all_connections()


def get_active_db_path() -> Path:
    return _DB_PATH

_SCHEMA = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS activos (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL DEFAULT '',
    symbol          TEXT NOT NULL DEFAULT '',
    market_provider TEXT NOT NULL DEFAULT 'finnhub',
    market_symbol   TEXT NOT NULL DEFAULT '',
    finnhub_symbol  TEXT NOT NULL DEFAULT '',
    type            TEXT NOT NULL DEFAULT '',
    sort_order      INTEGER NOT NULL DEFAULT 0,
    price           TEXT NOT NULL DEFAULT '0,00',
    currency        TEXT NOT NULL DEFAULT 'EUR',
    precio_currency TEXT NOT NULL DEFAULT 'EUR',
    change          TEXT NOT NULL DEFAULT '+0,00%',
    status          TEXT NOT NULL DEFAULT 'Mercado abierto',
    last_updated    TEXT NOT NULL DEFAULT '',
    color           TEXT NOT NULL DEFAULT '',
    tv_symbol       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS activo_rows (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id               TEXT NOT NULL REFERENCES activos(id) ON DELETE CASCADE,
    fecha_operacion        TEXT NOT NULL DEFAULT '',
    tipo_operacion         TEXT NOT NULL DEFAULT 'Compra',
    exchange               TEXT NOT NULL DEFAULT '',
    currency               TEXT NOT NULL DEFAULT 'EUR',
    participaciones        TEXT NOT NULL DEFAULT '',
    precio_participacion   TEXT NOT NULL DEFAULT '',
    capital_invertido_bruto TEXT NOT NULL DEFAULT '',
    coste_anual            TEXT NOT NULL DEFAULT '',
    comisiones             TEXT NOT NULL DEFAULT '',
    comisiones_fiat        TEXT NOT NULL DEFAULT '',
    comisiones_cripto      TEXT NOT NULL DEFAULT '',
    comisiones_satoshis    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS activo_operation_rows (
    id               TEXT NOT NULL,
    asset_id         TEXT NOT NULL REFERENCES activos(id) ON DELETE CASCADE,
    activo           TEXT NOT NULL DEFAULT '',
    fecha_apertura   TEXT NOT NULL DEFAULT '',
    par              TEXT NOT NULL DEFAULT '',
    stablecoin_symbol TEXT NOT NULL DEFAULT '',
    orden            TEXT NOT NULL DEFAULT 'Compra',
    precio_orden     TEXT NOT NULL DEFAULT '',
    precio_currency  TEXT NOT NULL DEFAULT 'EUR',
    cantidad         TEXT NOT NULL DEFAULT '',
    comisiones_cripto TEXT NOT NULL DEFAULT '',
    comisiones_fiat  TEXT NOT NULL DEFAULT '',
    total            TEXT NOT NULL DEFAULT '',
    currency         TEXT NOT NULL DEFAULT 'EUR',
    estado           TEXT NOT NULL DEFAULT 'Activo',
    fecha_cierre     TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (id, asset_id)
);

CREATE TABLE IF NOT EXISTS activo_conversion_rows (
    id       TEXT NOT NULL,
    asset_id TEXT NOT NULL REFERENCES activos(id) ON DELETE CASCADE,
    fecha    TEXT NOT NULL DEFAULT '',
    par      TEXT NOT NULL DEFAULT '',
    tipo     TEXT NOT NULL DEFAULT '',
    cantidad TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (id, asset_id)
);

CREATE TABLE IF NOT EXISTS operaciones (
    id               TEXT PRIMARY KEY,
    asset_id         TEXT NOT NULL DEFAULT '',
    activo           TEXT NOT NULL DEFAULT '',
    fecha_apertura   TEXT NOT NULL DEFAULT '',
    par              TEXT NOT NULL DEFAULT '',
    stablecoin_symbol TEXT NOT NULL DEFAULT '',
    orden            TEXT NOT NULL DEFAULT 'Compra',
    precio_orden     TEXT NOT NULL DEFAULT '',
    precio_currency  TEXT NOT NULL DEFAULT 'EUR',
    cantidad         TEXT NOT NULL DEFAULT '',
    comisiones_cripto TEXT NOT NULL DEFAULT '',
    comisiones_fiat  TEXT NOT NULL DEFAULT '',
    total            TEXT NOT NULL DEFAULT '',
    currency         TEXT NOT NULL DEFAULT 'EUR',
    estado           TEXT NOT NULL DEFAULT 'Activo',
    fecha_cierre     TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS intereses (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha     TEXT NOT NULL DEFAULT '',
    acumulado TEXT NOT NULL DEFAULT '',
    impuestos TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS cuentas_remuneradas (
    id         TEXT PRIMARY KEY,
    nombre     TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS intereses_v2 (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    cuenta_id TEXT NOT NULL REFERENCES cuentas_remuneradas(id) ON DELETE CASCADE,
    fecha     TEXT NOT NULL DEFAULT '',
    acumulado TEXT NOT NULL DEFAULT '',
    impuestos TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS dividendos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha            TEXT NOT NULL DEFAULT '',
    instrumento      TEXT NOT NULL DEFAULT '',
    acciones         TEXT NOT NULL DEFAULT '',
    dividendo_accion TEXT NOT NULL DEFAULT '',
    impuestos        TEXT NOT NULL DEFAULT '',
    total            TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS transacciones (
    id               TEXT PRIMARY KEY,
    asset_id         TEXT NOT NULL DEFAULT '',
    asset_name       TEXT NOT NULL DEFAULT '',
    fecha_operacion  TEXT NOT NULL DEFAULT '',
    total            TEXT NOT NULL DEFAULT '',
    comision_red     TEXT NOT NULL DEFAULT '',
    wallet_tipo      TEXT NOT NULL DEFAULT 'entre_wallet',
    wallet_destino   TEXT NOT NULL DEFAULT '',
    hash_transaccion TEXT NOT NULL DEFAULT '',
    nota             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS stablecoins_catalog (
    symbol         TEXT PRIMARY KEY,
    market_symbol  TEXT NOT NULL DEFAULT '',
    display_symbol TEXT NOT NULL DEFAULT '',
    description    TEXT NOT NULL DEFAULT '',
    provider       TEXT NOT NULL DEFAULT 'FINNHUB'
);

CREATE TABLE IF NOT EXISTS stablecoins_enabled (
    symbol TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS stablecoins_rows (
    id               TEXT PRIMARY KEY,
    stablecoin_symbol TEXT NOT NULL DEFAULT '',
    fecha            TEXT NOT NULL DEFAULT '',
    tipo             TEXT NOT NULL DEFAULT 'Compra',
    cantidad         TEXT NOT NULL DEFAULT '',
    precio           TEXT NOT NULL DEFAULT '',
    total            TEXT NOT NULL DEFAULT '',
    comisiones       TEXT NOT NULL DEFAULT '',
    currency         TEXT NOT NULL DEFAULT 'USD',
    nota             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS gastos_tipos (
    label TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS gastos_years (
    year TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS gastos_rows (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    year     TEXT NOT NULL,
    month    TEXT NOT NULL,
    fecha    TEXT NOT NULL DEFAULT '',
    nombre   TEXT NOT NULL DEFAULT '',
    tipo     TEXT NOT NULL DEFAULT '',
    cantidad TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS mensualidades (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    year        TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    enero       TEXT NOT NULL DEFAULT '',
    febrero     TEXT NOT NULL DEFAULT '',
    marzo       TEXT NOT NULL DEFAULT '',
    abril       TEXT NOT NULL DEFAULT '',
    mayo        TEXT NOT NULL DEFAULT '',
    junio       TEXT NOT NULL DEFAULT '',
    julio       TEXT NOT NULL DEFAULT '',
    agosto      TEXT NOT NULL DEFAULT '',
    septiembre  TEXT NOT NULL DEFAULT '',
    octubre     TEXT NOT NULL DEFAULT '',
    noviembre   TEXT NOT NULL DEFAULT '',
    diciembre   TEXT NOT NULL DEFAULT '',
    categoria   TEXT NOT NULL DEFAULT '',
    importe     TEXT NOT NULL DEFAULT '',
    frecuencia  TEXT NOT NULL DEFAULT 'mensual',
    dia_cobro   TEXT NOT NULL DEFAULT '',
    mes_inicio  TEXT NOT NULL DEFAULT 'enero',
    activa      INTEGER NOT NULL DEFAULT 1,
    nota        TEXT NOT NULL DEFAULT '',
    UNIQUE(year, nombre)
);

CREATE TABLE IF NOT EXISTS ingresos_tipos (
    label TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS ingresos_rows (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    year     TEXT NOT NULL,
    month    TEXT NOT NULL,
    fecha    TEXT NOT NULL DEFAULT '',
    nombre   TEXT NOT NULL DEFAULT '',
    tipo     TEXT NOT NULL DEFAULT '',
    cantidad TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS ingresos_recurrentes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    year        TEXT NOT NULL,
    nombre      TEXT NOT NULL,
    enero       TEXT NOT NULL DEFAULT '',
    febrero     TEXT NOT NULL DEFAULT '',
    marzo       TEXT NOT NULL DEFAULT '',
    abril       TEXT NOT NULL DEFAULT '',
    mayo        TEXT NOT NULL DEFAULT '',
    junio       TEXT NOT NULL DEFAULT '',
    julio       TEXT NOT NULL DEFAULT '',
    agosto      TEXT NOT NULL DEFAULT '',
    septiembre  TEXT NOT NULL DEFAULT '',
    octubre     TEXT NOT NULL DEFAULT '',
    noviembre   TEXT NOT NULL DEFAULT '',
    diciembre   TEXT NOT NULL DEFAULT '',
    categoria   TEXT NOT NULL DEFAULT '',
    importe     TEXT NOT NULL DEFAULT '',
    frecuencia  TEXT NOT NULL DEFAULT 'mensual',
    dia_cobro   TEXT NOT NULL DEFAULT '',
    mes_inicio  TEXT NOT NULL DEFAULT 'enero',
    activa      INTEGER NOT NULL DEFAULT 1,
    nota        TEXT NOT NULL DEFAULT '',
    UNIQUE(year, nombre)
);

CREATE INDEX IF NOT EXISTS idx_ingresos_rows_year_month ON ingresos_rows(year, month);
CREATE INDEX IF NOT EXISTS idx_ingresos_recurrentes_year ON ingresos_recurrentes(year);

CREATE TABLE IF NOT EXISTS ventas_years (
    year TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS ventas (
    id             TEXT NOT NULL,
    year           TEXT NOT NULL,
    fecha          TEXT NOT NULL DEFAULT '',
    asset_id       TEXT NOT NULL DEFAULT '',
    activo         TEXT NOT NULL DEFAULT '',
    cantidad       TEXT NOT NULL DEFAULT '',
    valor_compra   TEXT NOT NULL DEFAULT '',
    valor_venta    TEXT NOT NULL DEFAULT '',
    dinero_declarar TEXT NOT NULL DEFAULT '',
    tramo1         TEXT NOT NULL DEFAULT '',
    tramo2         TEXT NOT NULL DEFAULT '',
    tramo3         TEXT NOT NULL DEFAULT '',
    tramo4         TEXT NOT NULL DEFAULT '',
    tramo5         TEXT NOT NULL DEFAULT '',
    total_pagar    TEXT NOT NULL DEFAULT '',
    bruto          TEXT NOT NULL DEFAULT '',
    neto           TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (id, year)
);

CREATE INDEX IF NOT EXISTS idx_activo_rows_asset_id ON activo_rows(asset_id);
CREATE INDEX IF NOT EXISTS idx_activo_operation_rows_asset_id ON activo_operation_rows(asset_id);
CREATE INDEX IF NOT EXISTS idx_activo_conversion_rows_asset_id ON activo_conversion_rows(asset_id);
CREATE INDEX IF NOT EXISTS idx_gastos_rows_year_month ON gastos_rows(year, month);
CREATE INDEX IF NOT EXISTS idx_mensualidades_year ON mensualidades(year);
CREATE INDEX IF NOT EXISTS idx_ventas_year ON ventas(year);

CREATE TABLE IF NOT EXISTS dividendo_calendar (
    month      TEXT NOT NULL,
    asset_name TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (month, asset_name)
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS renta_fija (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha             TEXT NOT NULL DEFAULT '',
    tipo              TEXT NOT NULL DEFAULT 'bancario',
    currency          TEXT NOT NULL DEFAULT 'EUR',
    instrumento       TEXT NOT NULL DEFAULT '',
    rentabilidad      TEXT NOT NULL DEFAULT '',
    vencimiento       TEXT NOT NULL DEFAULT '',
    invertido         TEXT NOT NULL DEFAULT '',
    interes_acumulado TEXT NOT NULL DEFAULT '',
    impuestos         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS bonos (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha             TEXT NOT NULL DEFAULT '',
    tipo              TEXT NOT NULL DEFAULT 'gubernamental',
    currency          TEXT NOT NULL DEFAULT 'EUR',
    instrumento       TEXT NOT NULL DEFAULT '',
    cupon             TEXT NOT NULL DEFAULT '',
    vencimiento       TEXT NOT NULL DEFAULT '',
    invertido         TEXT NOT NULL DEFAULT '',
    interes_acumulado TEXT NOT NULL DEFAULT '',
    impuestos         TEXT NOT NULL DEFAULT '',
    nota              TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS trading (
    id               TEXT PRIMARY KEY,
    fecha            TEXT NOT NULL DEFAULT '',
    tipo             TEXT NOT NULL DEFAULT 'SCALP',
    moneda           TEXT NOT NULL DEFAULT '',
    direccion        TEXT NOT NULL DEFAULT 'LONG',
    resultado        TEXT NOT NULL DEFAULT 'PROFIT',
    capital          TEXT NOT NULL DEFAULT '',
    capital_currency TEXT NOT NULL DEFAULT 'EUR',
    roi              TEXT NOT NULL DEFAULT '',
    ganancia         TEXT NOT NULL DEFAULT '',
    ganancia_neta    TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS staking_criptos (
    id         TEXT PRIMARY KEY,
    nombre     TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS staking_rows (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    cripto_id TEXT NOT NULL REFERENCES staking_criptos(id) ON DELETE CASCADE,
    fecha     TEXT NOT NULL DEFAULT '',
    cantidad  TEXT NOT NULL DEFAULT '',
    precio    TEXT NOT NULL DEFAULT '',
    nota      TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS earn_criptos (
    id         TEXT PRIMARY KEY,
    nombre     TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS earn_rows (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    cripto_id  TEXT NOT NULL REFERENCES earn_criptos(id) ON DELETE CASCADE,
    fecha      TEXT NOT NULL DEFAULT '',
    plataforma TEXT NOT NULL DEFAULT '',
    cantidad   TEXT NOT NULL DEFAULT '',
    precio     TEXT NOT NULL DEFAULT '',
    nota       TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS private_market (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha        TEXT NOT NULL DEFAULT '',
    tipo         TEXT NOT NULL DEFAULT 'pe',
    nombre       TEXT NOT NULL DEFAULT '',
    gestor       TEXT NOT NULL DEFAULT '',
    vintage      TEXT NOT NULL DEFAULT '',
    currency     TEXT NOT NULL DEFAULT 'EUR',
    comprometido TEXT NOT NULL DEFAULT '',
    llamado      TEXT NOT NULL DEFAULT '',
    distribuido  TEXT NOT NULL DEFAULT '',
    valor_actual TEXT NOT NULL DEFAULT '',
    nota         TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS portfolio_snapshots (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    ts             INTEGER NOT NULL,
    total_value    REAL NOT NULL DEFAULT 0,
    total_invested REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_ts ON portfolio_snapshots(ts);

CREATE TABLE IF NOT EXISTS asset_snapshots (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        INTEGER NOT NULL,
    asset_id  TEXT NOT NULL,
    price_eur REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_asset_snapshots_ts ON asset_snapshots(ts);
CREATE INDEX IF NOT EXISTS idx_asset_snapshots_asset_id_ts ON asset_snapshots(asset_id, ts);
"""


def _migrate(conn):
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS trading (
            id               TEXT PRIMARY KEY,
            fecha            TEXT NOT NULL DEFAULT '',
            tipo             TEXT NOT NULL DEFAULT 'SCALP',
            moneda           TEXT NOT NULL DEFAULT '',
            direccion        TEXT NOT NULL DEFAULT 'LONG',
            resultado        TEXT NOT NULL DEFAULT 'PROFIT',
            capital          TEXT NOT NULL DEFAULT '',
            capital_currency TEXT NOT NULL DEFAULT 'EUR',
            roi              TEXT NOT NULL DEFAULT '',
            ganancia         TEXT NOT NULL DEFAULT ''
        );
    """)
    trading_cols = {row[1] for row in conn.execute("PRAGMA table_info(trading)")}
    if "capital" not in trading_cols:
        conn.execute("ALTER TABLE trading ADD COLUMN capital TEXT NOT NULL DEFAULT ''")
    if "capital_currency" not in trading_cols:
        conn.execute("ALTER TABLE trading ADD COLUMN capital_currency TEXT NOT NULL DEFAULT 'EUR'")
    if "ganancia_neta" not in trading_cols:
        conn.execute("ALTER TABLE trading ADD COLUMN ganancia_neta TEXT NOT NULL DEFAULT ''")

    activos_cols = {row[1] for row in conn.execute("PRAGMA table_info(activos)")}
    if "color" not in activos_cols:
        conn.execute("ALTER TABLE activos ADD COLUMN color TEXT NOT NULL DEFAULT ''")
    if "tv_symbol" not in activos_cols:
        conn.execute("ALTER TABLE activos ADD COLUMN tv_symbol TEXT NOT NULL DEFAULT ''")
    if "hidden" not in activos_cols:
        conn.execute("ALTER TABLE activos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0")

    asset_snap_cols = {row[1] for row in conn.execute("PRAGMA table_info(asset_snapshots)")}
    if "cost_eur" not in asset_snap_cols:
        conn.execute("ALTER TABLE asset_snapshots ADD COLUMN cost_eur REAL NOT NULL DEFAULT 0")

    bonos_cols = {row[1] for row in conn.execute("PRAGMA table_info(bonos)")}
    if "currency" not in bonos_cols:
        conn.execute("ALTER TABLE bonos ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR'")

    rf_cols = {row[1] for row in conn.execute("PRAGMA table_info(renta_fija)")}
    if "currency" not in rf_cols:
        conn.execute("ALTER TABLE renta_fija ADD COLUMN currency TEXT NOT NULL DEFAULT 'EUR'")

    for table in ("operaciones", "activo_operation_rows"):
        operation_cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        if "comisiones_fiat" not in operation_cols:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN comisiones_fiat TEXT NOT NULL DEFAULT ''")

    sc_rows_cols = {row[1] for row in conn.execute("PRAGMA table_info(stablecoins_rows)")}
    if "comisiones" not in sc_rows_cols:
        conn.execute("ALTER TABLE stablecoins_rows ADD COLUMN comisiones TEXT NOT NULL DEFAULT ''")

    # Mensualidades (gastos) e ingresos recurrentes comparten los mismos campos.
    _RECURRENTE_COLS = (
        ("categoria",  "TEXT NOT NULL DEFAULT ''"),
        ("importe",    "TEXT NOT NULL DEFAULT ''"),
        ("frecuencia", "TEXT NOT NULL DEFAULT 'mensual'"),
        ("dia_cobro",  "TEXT NOT NULL DEFAULT ''"),
        ("mes_inicio", "TEXT NOT NULL DEFAULT 'enero'"),
        ("activa",     "INTEGER NOT NULL DEFAULT 1"),
        ("nota",       "TEXT NOT NULL DEFAULT ''"),
    )
    for table in ("mensualidades", "ingresos_recurrentes"):
        existing_cols = {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}
        for column, definition in _RECURRENTE_COLS:
            if column not in existing_cols:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")

    div_cols = {row[1] for row in conn.execute("PRAGMA table_info(dividendos)")}
    if "moneda_dividendo" not in div_cols:
        conn.execute("ALTER TABLE dividendos ADD COLUMN moneda_dividendo TEXT NOT NULL DEFAULT 'USD'")
    if "moneda_total" not in div_cols:
        conn.execute("ALTER TABLE dividendos ADD COLUMN moneda_total TEXT NOT NULL DEFAULT 'EUR'")

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS portfolio_snapshots (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            ts             INTEGER NOT NULL,
            total_value    REAL NOT NULL DEFAULT 0,
            total_invested REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_portfolio_snapshots_ts ON portfolio_snapshots(ts);

        CREATE TABLE IF NOT EXISTS asset_snapshots (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        INTEGER NOT NULL,
            asset_id  TEXT NOT NULL,
            price_eur REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_asset_snapshots_ts ON asset_snapshots(ts);
        CREATE INDEX IF NOT EXISTS idx_asset_snapshots_asset_id_ts ON asset_snapshots(asset_id, ts);
    """)

    conn.executescript("""
        CREATE TABLE IF NOT EXISTS private_market (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            fecha        TEXT NOT NULL DEFAULT '',
            tipo         TEXT NOT NULL DEFAULT 'pe',
            nombre       TEXT NOT NULL DEFAULT '',
            gestor       TEXT NOT NULL DEFAULT '',
            vintage      TEXT NOT NULL DEFAULT '',
            currency     TEXT NOT NULL DEFAULT 'EUR',
            comprometido TEXT NOT NULL DEFAULT '',
            llamado      TEXT NOT NULL DEFAULT '',
            distribuido  TEXT NOT NULL DEFAULT '',
            valor_actual TEXT NOT NULL DEFAULT '',
            nota         TEXT NOT NULL DEFAULT ''
        );
    """)

    # Backfill gastos_years from existing data in older DBs
    conn.executescript("""
        INSERT OR IGNORE INTO gastos_years (year)
        SELECT DISTINCT year FROM gastos_rows
        UNION
        SELECT DISTINCT year FROM mensualidades;
    """)


def get_db() -> sqlite3.Connection:
    stale = (
        not hasattr(_local, "conn")
        or _local.conn is None
        or getattr(_local, "_conn_gen", -1) < _reset_generation
    )
    if stale:
        old = getattr(_local, "conn", None)
        if old is not None:
            try:
                old.close()
            except Exception:
                pass
        _local.conn = None
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False, timeout=10)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA busy_timeout=5000")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA cache_size=-8000")
            db_key = str(_DB_PATH)
            # Schema + migración solo una vez por BD y bajo lock: evita que dos
            # hilos ejecuten ALTER TABLE a la vez sobre el mismo fichero.
            with _init_lock:
                if db_key not in _initialized_paths:
                    conn.executescript(_SCHEMA)
                    _migrate(conn)
                    conn.commit()
                    _initialized_paths.add(db_key)
                else:
                    conn.execute("PRAGMA foreign_keys=ON")
        except Exception:
            conn.close()
            raise
        _local.conn = conn
        _local._conn_gen = _reset_generation

    conn = _local.conn
    # Red de seguridad: si una escritura anterior falló a medio camino, su
    # transacción (con DELETEs ya aplicados) sigue abierta. Sin este rollback,
    # el siguiente commit() de cualquier otra operación la confirmaría y se
    # perderían datos de forma silenciosa.
    if conn.in_transaction:
        log.warning("[db] Transacción huérfana detectada; ejecutando rollback preventivo")
        try:
            conn.rollback()
        except Exception:
            pass
    return conn


@contextmanager
def transaction():
    """Contexto transaccional: commit al salir con éxito, rollback si hay excepción."""
    conn = get_db()
    try:
        yield conn
        conn.commit()
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        raise


def transactional(func):
    """Garantiza rollback si la función de escritura falla a medio camino."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except Exception:
            conn = getattr(_local, "conn", None)
            if conn is not None and conn.in_transaction:
                try:
                    conn.rollback()
                except Exception:
                    pass
            raise
    return wrapper


def reset_db():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
        _local.conn = None


def invalidate_all_connections():
    """Force every thread to re-open a fresh connection on their next get_db() call."""
    global _reset_generation
    _reset_generation += 1
    # El contenido del fichero puede haber cambiado (restore/switch), así que
    # la próxima conexión debe volver a aplicar schema + migraciones.
    with _init_lock:
        _initialized_paths.clear()
    reset_db()


def init_db():
    get_db()


def init_db_at_path(path) -> None:
    """Create and initialize an empty DB at the given path without changing the active DB."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(p), check_same_thread=False, timeout=15)
    try:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()
