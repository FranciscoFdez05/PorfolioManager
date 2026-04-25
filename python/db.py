import sqlite3
import threading
from pathlib import Path

_BASE_DIR = Path(__file__).resolve().parent.parent
_DB_PATH = _BASE_DIR / "data" / "portfolio.db"
_local = threading.local()

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
    last_updated    TEXT NOT NULL DEFAULT ''
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
    currency         TEXT NOT NULL DEFAULT 'USD',
    nota             TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS gastos_tipos (
    label TEXT PRIMARY KEY
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
    instrumento       TEXT NOT NULL DEFAULT '',
    cupon             TEXT NOT NULL DEFAULT '',
    vencimiento       TEXT NOT NULL DEFAULT '',
    invertido         TEXT NOT NULL DEFAULT '',
    interes_acumulado TEXT NOT NULL DEFAULT '',
    impuestos         TEXT NOT NULL DEFAULT '',
    nota              TEXT NOT NULL DEFAULT ''
);
"""


def get_db() -> sqlite3.Connection:
    if not hasattr(_local, "conn") or _local.conn is None:
        _DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(str(_DB_PATH), check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.executescript(_SCHEMA)
        conn.commit()
        _local.conn = conn
    return _local.conn


def reset_db():
    conn = getattr(_local, "conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
        _local.conn = None


def init_db():
    get_db()
