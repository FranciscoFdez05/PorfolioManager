import logging
import os
import re

from core.db import get_db, init_db, transactional
from core.paths import BASE_DIR
from core.secret_store import read_secret_lines

log = logging.getLogger(__name__)

apiDir = BASE_DIR / "API"
_eodhdKeyRotationIndex = 0
_alphaVantageKeyRotationIndex = 0

# Los huecos que trae la documentación —`.env.example` y el README— para que se
# rellenen. Una clave de verdad es un token de veinte o cuarenta caracteres al
# azar: ninguna empieza por «tu_clave» ni se llama «CLAVE1», así que reconocerlos
# no puede tirar una clave buena, y a cambio evita el fallo más caro que tiene
# esta instalación: arrancar con el ejemplo puesto y no entender por qué el
# proveedor rechaza todo.
_EJEMPLO = re.compile(
    r"^(?:tu[_-]?(?:clave|api[_-]?key)\w*"
    r"|clave(?:[_-]?\w+)?"
    r"|your[_-]?api[_-]?key\w*"
    r"|(?:change|cambia)me"
    r"|x{3,})$",
    re.IGNORECASE,
)


def _read_api_keys(file_path):
    """Claves del fichero, sin duplicados. Descifra si está en formato cifrado."""
    seen = set()
    apiKeys = []
    for apiKey in read_secret_lines(file_path):
        if apiKey not in seen:
            apiKeys.append(apiKey)
            seen.add(apiKey)
    return apiKeys


def _read_first_api_key(file_path):
    apiKeys = _read_api_keys(file_path)
    return apiKeys[0] if apiKeys else None


# De dónde puede salir la clave de cada proveedor: (variable de entorno,
# fichero, si la variable admite varias separadas por coma).
API_KEY_SOURCES = {
    "finnhub": ("FINNHUB_API_KEY", "finnhub.key", False),
    "eodhd": ("EODHD_API_KEYS", "eodhd.key", True),
    "alphavantage": ("ALPHA_VANTAGE_API_KEYS", "alphavantage.key", True),
}


def ensureDataFile():
    init_db()


# --- Cuentas Remuneradas (ex Intereses) ---

@transactional
def readInteresesFile():
    conn = get_db()
    cuentas = conn.execute(
        "SELECT id, nombre FROM cuentas_remuneradas ORDER BY sort_order, rowid"
    ).fetchall()

    # Migración: si no hay cuentas_remuneradas pero sí filas antiguas, migrarlas
    if not cuentas:
        old_rows = conn.execute(
            "SELECT fecha, acumulado, impuestos FROM intereses ORDER BY id"
        ).fetchall()
        if old_rows:
            default_id = "cuenta-default"
            conn.execute(
                "INSERT OR IGNORE INTO cuentas_remuneradas (id, nombre, sort_order) VALUES (?, ?, ?)",
                (default_id, "Cuenta principal", 0)
            )
            conn.executemany(
                "INSERT INTO intereses_v2 (cuenta_id, fecha, acumulado, impuestos) VALUES (?, ?, ?, ?)",
                [(default_id, r["fecha"], r["acumulado"], r["impuestos"]) for r in old_rows]
            )
            conn.execute("DELETE FROM intereses")
            conn.commit()
            cuentas = conn.execute(
                "SELECT id, nombre FROM cuentas_remuneradas ORDER BY sort_order, rowid"
            ).fetchall()

    result = []
    for c in cuentas:
        filas = conn.execute(
            "SELECT fecha, acumulado, impuestos FROM intereses_v2 WHERE cuenta_id = ? ORDER BY id",
            (c["id"],)
        ).fetchall()
        result.append({
            "id": c["id"],
            "nombre": c["nombre"],
            "rows": [{"fecha": r["fecha"], "acumulado": r["acumulado"], "impuestos": r["impuestos"]} for r in filas]
        })

    return {"cuentas": result}


@transactional
def writeInteresesFile(data):
    conn = get_db()
    cuentas = data.get("cuentas", [])

    existing_ids = {r["id"] for r in conn.execute("SELECT id FROM cuentas_remuneradas").fetchall()}
    new_ids = {str(c.get("id", "")).strip() for c in cuentas}

    for old_id in existing_ids - new_ids:
        conn.execute("DELETE FROM cuentas_remuneradas WHERE id = ?", (old_id,))

    for i, cuenta in enumerate(cuentas):
        cid = str(cuenta.get("id", "")).strip()
        nombre = str(cuenta.get("nombre", "")).strip()
        if not cid:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO cuentas_remuneradas (id, nombre, sort_order) VALUES (?, ?, ?)",
            (cid, nombre, i)
        )
        conn.execute("DELETE FROM intereses_v2 WHERE cuenta_id = ?", (cid,))
        rows = cuenta.get("rows", [])
        if rows:
            conn.executemany(
                "INSERT INTO intereses_v2 (cuenta_id, fecha, acumulado, impuestos) VALUES (?, ?, ?, ?)",
                [(cid, r.get("fecha", ""), r.get("acumulado", ""), r.get("impuestos", "")) for r in rows]
            )

    conn.commit()


# --- Dividendos ---

def readDividendosFile():
    conn = get_db()
    rows = conn.execute(
        "SELECT fecha, instrumento, acciones, dividendo_accion, impuestos, total, moneda_dividendo, moneda_total FROM dividendos ORDER BY id"
    ).fetchall()
    return {"rows": [
        {
            "fecha": r["fecha"],
            "instrumento": r["instrumento"],
            "acciones": r["acciones"],
            "dividendoAccion": r["dividendo_accion"],
            "impuestos": r["impuestos"],
            "total": r["total"],
            # Ojo: `r` es un sqlite3.Row, no un dict. `"x" in r` busca entre los
            # VALORES de la fila, así que quitar .keys() cambiaría el significado
            # y devolvería el fallback casi siempre (de ahí el noqa: SIM118).
            "monedaDividendo": r["moneda_dividendo"] if "moneda_dividendo" in r.keys() else "USD",  # noqa: SIM118
            "monedaTotal": r["moneda_total"] if "moneda_total" in r.keys() else "EUR",  # noqa: SIM118
        }
        for r in rows
    ]}


@transactional
def writeDividendosFile(data):
    conn = get_db()
    conn.execute("DELETE FROM dividendos")
    conn.executemany(
        "INSERT INTO dividendos (fecha, instrumento, acciones, dividendo_accion, impuestos, total, moneda_dividendo, moneda_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("fecha", ""), r.get("instrumento", ""), r.get("acciones", ""),
             r.get("dividendoAccion", ""), r.get("impuestos", ""), r.get("total", ""),
             r.get("monedaDividendo", "USD"), r.get("monedaTotal", "EUR"))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- Operaciones ---

def readOperacionesFile():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, asset_id, activo, fecha_apertura, par, stablecoin_symbol, orden, "
        "precio_orden, precio_currency, cantidad, comisiones_cripto, comisiones_fiat, total, currency, estado, fecha_cierre "
        "FROM operaciones ORDER BY rowid"
    ).fetchall()
    return {"rows": [
        {
            "id": r["id"],
            "assetId": r["asset_id"],
            "activo": r["activo"],
            "fechaApertura": r["fecha_apertura"],
            "par": r["par"],
            "stablecoinSymbol": r["stablecoin_symbol"],
            "orden": r["orden"],
            "precioOrden": r["precio_orden"],
            "precioCurrency": r["precio_currency"],
            "cantidad": r["cantidad"],
            "comisionesCripto": r["comisiones_cripto"],
            "comisionesFiat": r["comisiones_fiat"],
            "total": r["total"],
            "currency": r["currency"],
            "estado": r["estado"],
            "fechaCierre": r["fecha_cierre"],
        }
        for r in rows
    ]}


@transactional
def writeOperacionesFile(data):
    conn = get_db()
    conn.execute("DELETE FROM operaciones")
    conn.executemany(
        "INSERT INTO operaciones "
        "(id, asset_id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
        "precio_currency, cantidad, comisiones_cripto, comisiones_fiat, total, currency, estado, fecha_cierre) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), r.get("assetId", ""), r.get("activo", ""),
             r.get("fechaApertura", ""), r.get("par", ""), r.get("stablecoinSymbol", ""),
             r.get("orden", "Compra"), r.get("precioOrden", ""), r.get("precioCurrency", "EUR"),
             r.get("cantidad", ""), r.get("comisionesCripto", ""), r.get("comisionesFiat", ""),
             r.get("total", ""),
             r.get("currency", "EUR"), r.get("estado", "Activo"), r.get("fechaCierre", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- Trading Journal ---

def readTradingFile():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, fecha, tipo, moneda, direccion, resultado, capital, capital_currency, roi, ganancia, ganancia_neta FROM trading ORDER BY rowid"
    ).fetchall()
    return {"rows": [
        {
            "id": r["id"],
            "fecha": r["fecha"],
            "tipo": r["tipo"],
            "moneda": r["moneda"],
            "direccion": r["direccion"],
            "resultado": r["resultado"],
            "capital": r["capital"],
            "capital_currency": r["capital_currency"],
            "roi": r["roi"],
            "ganancia": r["ganancia"],
            "ganancia_neta": r["ganancia_neta"],
        }
        for r in rows
    ]}


@transactional
def writeTradingFile(data):
    conn = get_db()
    conn.execute("DELETE FROM trading")
    conn.executemany(
        "INSERT INTO trading (id, fecha, tipo, moneda, direccion, resultado, capital, capital_currency, roi, ganancia, ganancia_neta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), r.get("fecha", ""), r.get("tipo", "SCALP"),
             r.get("moneda", ""), r.get("direccion", "LONG"), r.get("resultado", "PROFIT"),
             r.get("capital", ""), r.get("capital_currency", "EUR"), r.get("roi", ""), r.get("ganancia", ""),
             r.get("ganancia_neta", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- Transacciones ---

def readTransaccionesFile():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, asset_id, asset_name, fecha_operacion, total, comision_red, "
        "wallet_tipo, wallet_destino, hash_transaccion, nota FROM transacciones ORDER BY rowid"
    ).fetchall()
    return {"rows": [
        {
            "id": r["id"],
            "assetId": r["asset_id"],
            "assetName": r["asset_name"],
            "fechaOperacion": r["fecha_operacion"],
            "total": r["total"],
            "comisionRed": r["comision_red"],
            "walletTipo": r["wallet_tipo"],
            "walletDestino": r["wallet_destino"],
            "hashTransaccion": r["hash_transaccion"],
            "nota": r["nota"],
        }
        for r in rows
    ]}


@transactional
def writeTransaccionesFile(data):
    conn = get_db()
    conn.execute("DELETE FROM transacciones")
    conn.executemany(
        "INSERT INTO transacciones "
        "(id, asset_id, asset_name, fecha_operacion, total, comision_red, "
        "wallet_tipo, wallet_destino, hash_transaccion, nota) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), r.get("assetId", ""), r.get("assetName", ""),
             r.get("fechaOperacion", ""), r.get("total", ""), r.get("comisionRed", ""),
             r.get("walletTipo", "entre_wallet"), r.get("walletDestino", ""),
             r.get("hashTransaccion", ""), r.get("nota", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- Dividendo Calendar ---

CALENDAR_MONTHS = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"
]


def readDividendoCalendar():
    conn = get_db()
    rows = conn.execute(
        "SELECT month, asset_name FROM dividendo_calendar ORDER BY month, sort_order, asset_name"
    ).fetchall()
    calendar = {m: [] for m in CALENDAR_MONTHS}
    for r in rows:
        month = r["month"]
        if month in calendar:
            calendar[month].append(r["asset_name"])
    return {"calendar": calendar}


@transactional
def writeDividendoCalendar(data):
    conn = get_db()
    calendar = data.get("calendar", {})
    conn.execute("DELETE FROM dividendo_calendar")
    rows_to_insert = []
    for month in CALENDAR_MONTHS:
        for order, asset_name in enumerate(calendar.get(month, [])):
            name = str(asset_name).strip()[:120]
            if name:
                rows_to_insert.append((month, name, order))
    conn.executemany(
        "INSERT OR IGNORE INTO dividendo_calendar (month, asset_name, sort_order) VALUES (?, ?, ?)",
        rows_to_insert
    )
    conn.commit()


# --- Stablecoins ---

def readStablecoinsFile():
    conn = get_db()
    catalog = [
        {
            "symbol": r["symbol"],
            "marketSymbol": r["market_symbol"],
            "displaySymbol": r["display_symbol"],
            "description": r["description"],
            "provider": r["provider"],
        }
        for r in conn.execute(
            "SELECT symbol, market_symbol, display_symbol, description, provider "
            "FROM stablecoins_catalog ORDER BY rowid"
        ).fetchall()
    ]
    enabled = [
        r["symbol"]
        for r in conn.execute("SELECT symbol FROM stablecoins_enabled ORDER BY rowid").fetchall()
    ]
    rows = [
        {
            "id": r["id"],
            "stablecoinSymbol": r["stablecoin_symbol"],
            "fecha": r["fecha"],
            "tipo": r["tipo"],
            "cantidad": r["cantidad"],
            "precio": r["precio"],
            "total": r["total"],
            "comisiones": r["comisiones"],
            "currency": r["currency"],
            "nota": r["nota"],
        }
        for r in conn.execute(
            "SELECT id, stablecoin_symbol, fecha, tipo, cantidad, precio, total, comisiones, currency, nota "
            "FROM stablecoins_rows ORDER BY rowid"
        ).fetchall()
    ]
    return {"catalog": catalog, "enabledSymbols": enabled, "rows": rows}


@transactional
def writeStablecoinsFile(data):
    conn = get_db()
    conn.execute("DELETE FROM stablecoins_catalog")
    conn.execute("DELETE FROM stablecoins_enabled")
    conn.execute("DELETE FROM stablecoins_rows")
    conn.executemany(
        "INSERT INTO stablecoins_catalog (symbol, market_symbol, display_symbol, description, provider) "
        "VALUES (?, ?, ?, ?, ?)",
        [
            (e.get("symbol", ""), e.get("marketSymbol", ""), e.get("displaySymbol", ""),
             e.get("description", ""), e.get("provider", "FINNHUB"))
            for e in data.get("catalog", [])
        ]
    )
    conn.executemany(
        "INSERT INTO stablecoins_enabled (symbol) VALUES (?)",
        [(s,) for s in data.get("enabledSymbols", [])]
    )
    conn.executemany(
        "INSERT INTO stablecoins_rows "
        "(id, stablecoin_symbol, fecha, tipo, cantidad, precio, total, comisiones, currency, nota) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), r.get("stablecoinSymbol", ""), r.get("fecha", ""),
             r.get("tipo", "Compra"), r.get("cantidad", ""), r.get("precio", ""),
             r.get("total", ""), r.get("comisiones", ""), r.get("currency", "USD"), r.get("nota", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- Renta Fija ---

def readRentaFijaFile():
    conn = get_db()
    rows = conn.execute(
        "SELECT fecha, tipo, currency, instrumento, rentabilidad, vencimiento, invertido, interes_acumulado, impuestos "
        "FROM renta_fija ORDER BY id"
    ).fetchall()
    return {"rows": [
        {
            "fecha": r["fecha"],
            "tipo": r["tipo"],
            "currency": r["currency"],
            "instrumento": r["instrumento"],
            "rentabilidad": r["rentabilidad"],
            "vencimiento": r["vencimiento"],
            "invertido": r["invertido"],
            "interesAcumulado": r["interes_acumulado"],
            "impuestos": r["impuestos"],
        }
        for r in rows
    ]}


@transactional
def writeRentaFijaFile(data):
    conn = get_db()
    conn.execute("DELETE FROM renta_fija")
    conn.executemany(
        "INSERT INTO renta_fija (fecha, tipo, currency, instrumento, rentabilidad, vencimiento, invertido, interes_acumulado, impuestos) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("fecha", ""), r.get("tipo", "bancario"), r.get("currency", "EUR"),
             r.get("instrumento", ""), r.get("rentabilidad", ""), r.get("vencimiento", ""),
             r.get("invertido", ""), r.get("interesAcumulado", ""), r.get("impuestos", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- Bonos ---

def readBonosFile():
    conn = get_db()
    rows = conn.execute(
        "SELECT fecha, tipo, currency, instrumento, cupon, vencimiento, invertido, interes_acumulado, impuestos, nota "
        "FROM bonos ORDER BY id"
    ).fetchall()
    return {"rows": [
        {
            "fecha": r["fecha"],
            "tipo": r["tipo"],
            "currency": r["currency"],
            "instrumento": r["instrumento"],
            "cupon": r["cupon"],
            "vencimiento": r["vencimiento"],
            "invertido": r["invertido"],
            "interesAcumulado": r["interes_acumulado"],
            "impuestos": r["impuestos"],
            "nota": r["nota"],
        }
        for r in rows
    ]}


@transactional
def writeBonosFile(data):
    conn = get_db()
    conn.execute("DELETE FROM bonos")
    conn.executemany(
        "INSERT INTO bonos (fecha, tipo, currency, instrumento, cupon, vencimiento, invertido, interes_acumulado, impuestos, nota) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("fecha", ""), r.get("tipo", "gubernamental"), r.get("currency", "EUR"),
             r.get("instrumento", ""), r.get("cupon", ""), r.get("vencimiento", ""),
             r.get("invertido", ""), r.get("interesAcumulado", ""), r.get("impuestos", ""), r.get("nota", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- Staking ---

def readStakingFile():
    conn = get_db()
    criptos = conn.execute(
        "SELECT id, nombre FROM staking_criptos ORDER BY sort_order, rowid"
    ).fetchall()
    result = []
    for c in criptos:
        filas = conn.execute(
            "SELECT fecha, cantidad, precio, nota FROM staking_rows WHERE cripto_id = ? ORDER BY id",
            (c["id"],)
        ).fetchall()
        result.append({
            "id": c["id"],
            "nombre": c["nombre"],
            "rows": [{"fecha": r["fecha"], "cantidad": r["cantidad"], "precio": r["precio"], "nota": r["nota"]} for r in filas]
        })
    return {"criptos": result}


@transactional
def writeStakingFile(data):
    conn = get_db()
    criptos = data.get("criptos", [])
    existing_ids = {r["id"] for r in conn.execute("SELECT id FROM staking_criptos").fetchall()}
    new_ids = {str(c.get("id", "")).strip() for c in criptos}
    for old_id in existing_ids - new_ids:
        conn.execute("DELETE FROM staking_criptos WHERE id = ?", (old_id,))
    for i, cripto in enumerate(criptos):
        cid = str(cripto.get("id", "")).strip()
        nombre = str(cripto.get("nombre", "")).strip()
        if not cid:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO staking_criptos (id, nombre, sort_order) VALUES (?, ?, ?)",
            (cid, nombre, i)
        )
        conn.execute("DELETE FROM staking_rows WHERE cripto_id = ?", (cid,))
        for row in cripto.get("rows", []):
            conn.execute(
                "INSERT INTO staking_rows (cripto_id, fecha, cantidad, precio, nota) VALUES (?, ?, ?, ?, ?)",
                (cid, str(row.get("fecha", "")), str(row.get("cantidad", "")),
                 str(row.get("precio", "")), str(row.get("nota", "")))
            )
    conn.commit()


# --- Earn ---

def readEarnFile():
    conn = get_db()
    criptos = conn.execute(
        "SELECT id, nombre FROM earn_criptos ORDER BY sort_order, rowid"
    ).fetchall()
    result = []
    for c in criptos:
        filas = conn.execute(
            "SELECT fecha, plataforma, cantidad, precio, nota FROM earn_rows WHERE cripto_id = ? ORDER BY id",
            (c["id"],)
        ).fetchall()
        result.append({
            "id": c["id"],
            "nombre": c["nombre"],
            "rows": [{"fecha": r["fecha"], "plataforma": r["plataforma"], "cantidad": r["cantidad"], "precio": r["precio"], "nota": r["nota"]} for r in filas]
        })
    return {"criptos": result}


@transactional
def writeEarnFile(data):
    conn = get_db()
    criptos = data.get("criptos", [])
    existing_ids = {r["id"] for r in conn.execute("SELECT id FROM earn_criptos").fetchall()}
    new_ids = {str(c.get("id", "")).strip() for c in criptos}
    for old_id in existing_ids - new_ids:
        conn.execute("DELETE FROM earn_criptos WHERE id = ?", (old_id,))
    for i, cripto in enumerate(criptos):
        cid = str(cripto.get("id", "")).strip()
        nombre = str(cripto.get("nombre", "")).strip()
        if not cid:
            continue
        conn.execute(
            "INSERT OR REPLACE INTO earn_criptos (id, nombre, sort_order) VALUES (?, ?, ?)",
            (cid, nombre, i)
        )
        conn.execute("DELETE FROM earn_rows WHERE cripto_id = ?", (cid,))
        for row in cripto.get("rows", []):
            conn.execute(
                "INSERT INTO earn_rows (cripto_id, fecha, plataforma, cantidad, precio, nota) VALUES (?, ?, ?, ?, ?, ?)",
                (cid, str(row.get("fecha", "")), str(row.get("plataforma", "")),
                 str(row.get("cantidad", "")), str(row.get("precio", "")), str(row.get("nota", "")))
            )
    conn.commit()


# --- Private Market ---

def readPrivateMarketFile():
    conn = get_db()
    rows = conn.execute(
        "SELECT fecha, tipo, nombre, gestor, vintage, currency, comprometido, llamado, distribuido, valor_actual, nota "
        "FROM private_market ORDER BY id"
    ).fetchall()
    return {"rows": [
        {
            "fecha":        r["fecha"],
            "tipo":         r["tipo"],
            "nombre":       r["nombre"],
            "gestor":       r["gestor"],
            "vintage":      r["vintage"],
            "currency":     r["currency"],
            "comprometido": r["comprometido"],
            "llamado":      r["llamado"],
            "distribuido":  r["distribuido"],
            "valorActual":  r["valor_actual"],
            "nota":         r["nota"],
        }
        for r in rows
    ]}


@transactional
def writePrivateMarketFile(data):
    conn = get_db()
    conn.execute("DELETE FROM private_market")
    conn.executemany(
        "INSERT INTO private_market (fecha, tipo, nombre, gestor, vintage, currency, comprometido, llamado, distribuido, valor_actual, nota) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("fecha", ""), r.get("tipo", "pe"), r.get("nombre", ""),
             r.get("gestor", ""), r.get("vintage", ""), r.get("currency", "EUR"),
             r.get("comprometido", ""), r.get("llamado", ""), r.get("distribuido", ""),
             r.get("valorActual", ""), r.get("nota", ""))
            for r in data.get("rows", [])
        ]
    )
    conn.commit()


# --- API keys ---------------------------------------------------------------
#
# Una clave puede venir de dos sitios: el fichero `API/<proveedor>.key`, que es
# lo que gestiona Ajustes, o una variable de entorno del `.env`. **Manda el
# fichero.** Antes mandaba la variable, y esa precedencia —invisible desde la
# interfaz— se comía instalaciones enteras: `.env.example` traía
# `FINNHUB_API_KEY=tu_clave_finnhub` y `EODHD_API_KEYS=tu_clave_EODHD1,...`, así
# que quien copiaba el ejemplo y luego ponía sus claves de verdad desde Ajustes
# se quedaba con los dos proveedores en «clave rechazada» para siempre: podía
# añadir claves, borrarlas, darse de alta en otra cuenta, y la aplicación seguía
# mandando `tu_clave_finnhub`.
#
# Ahora el orden es el que se puede ver y arreglar desde la pantalla: si el
# fichero tiene claves, se usan las del fichero. La variable de entorno sigue
# valiendo —hay despliegues que se configuran solo así, sin volumen para API/—
# pero como respaldo, no como sustituto silencioso.
#
# Y en los dos sitios se descartan los valores de ejemplo de la documentación.
# No son claves: su único efecto posible es romper el proveedor.


def _es_valor_de_ejemplo(clave):
    """¿Es un hueco de la documentación en vez de una clave?

    La lista es deliberadamente estrecha —los valores que aparecen en
    `.env.example` y en el README— y cada descarte queda en el log. Una clave de
    verdad es un token de veinte o cuarenta caracteres: ninguna empieza por
    «tu_clave» ni se llama «CLAVE1».
    """
    return bool(_EJEMPLO.match(str(clave or "").strip()))


def _sin_ejemplos(claves, procedencia):
    utiles = []
    for clave in claves:
        if _es_valor_de_ejemplo(clave):
            log.warning(
                "Se ignora %s: es el valor de ejemplo de la documentación, no una clave.",
                procedencia,
            )
            continue
        utiles.append(clave)
    return utiles


def _clavesDeEntorno(variable, admiteVarias):
    crudo = os.environ.get(variable, "").strip()
    if not crudo:
        return []
    partes = [c.strip() for c in crudo.split(",") if c.strip()] if admiteVarias else [crudo]
    return _sin_ejemplos(partes, f"el valor de {variable}")


def readApiKeysConOrigen(proveedor):
    """Las claves que se usan de verdad, y de dónde salen.

    Es el único sitio que decide la precedencia, y de aquí la leen tanto los
    proveedores como la pantalla de Ajustes. Que fueran dos caminos distintos
    era justo lo que permitía que la lista de claves y las claves realmente
    usadas no tuvieran nada que ver.
    """
    variable, fichero, admiteVarias = API_KEY_SOURCES[proveedor]
    delFichero = _sin_ejemplos(_read_api_keys(apiDir / fichero), f"una clave de {fichero}")

    # Compatibilidad: la clave de Finnhub se aceptaba en twelvedata.key, y ese
    # fichero sigue leyéndose cuando finnhub.key está vacío.
    if proveedor == "finnhub" and not delFichero:
        delFichero = _sin_ejemplos(_read_api_keys(apiDir / "twelvedata.key"), "una clave de twelvedata.key")

    delEntorno = _clavesDeEntorno(variable, admiteVarias)

    if delFichero:
        return {
            "claves": delFichero,
            "origen": "fichero",
            "variable": variable,
            # Las del entorno que quedan sin usar. Ya no rompen nada, pero
            # conviene decirlo: explica por qué esa variable no hace efecto.
            "ignoradas": len(delEntorno),
        }

    return {
        "claves": delEntorno,
        "origen": "entorno" if delEntorno else "ninguno",
        "variable": variable,
        "ignoradas": 0,
    }


def _claves_efectivas(proveedor):
    return readApiKeysConOrigen(proveedor)["claves"]


def readFinnhubApiKeys():
    return _claves_efectivas("finnhub")


def readFinnhubApiKey():
    claves = readFinnhubApiKeys()
    return claves[0] if claves else None


def readEodhdApiKey():
    claves = _claves_efectivas("eodhd")
    return claves[0] if claves else None


def readEodhdApiKeys():
    return _claves_efectivas("eodhd")


def readAlphaVantageApiKey():
    claves = _claves_efectivas("alphavantage")
    return claves[0] if claves else None


def readAlphaVantageApiKeys():
    return _claves_efectivas("alphavantage")


def _rotar(apiKeys, indice):
    inicio = indice % len(apiKeys)
    return apiKeys[inicio:] + apiKeys[:inicio], (inicio + 1) % len(apiKeys)


def readRotatedAlphaVantageApiKeys():
    global _alphaVantageKeyRotationIndex
    apiKeys = readAlphaVantageApiKeys()
    if not apiKeys:
        return []
    rotadas, _alphaVantageKeyRotationIndex = _rotar(apiKeys, _alphaVantageKeyRotationIndex)
    return rotadas


def readRotatedEodhdApiKeys():
    global _eodhdKeyRotationIndex
    apiKeys = readEodhdApiKeys()
    if not apiKeys:
        return []
    rotadas, _eodhdKeyRotationIndex = _rotar(apiKeys, _eodhdKeyRotationIndex)
    return rotadas
