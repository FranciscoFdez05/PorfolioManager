import os
from pathlib import Path

from db import get_db, init_db

baseDir = Path(__file__).resolve().parent.parent
apiDir = baseDir / "API"
_eodhdKeyRotationIndex = 0
_alphaVantageKeyRotationIndex = 0


def _read_first_api_key(file_path):
    if not file_path.exists():
        return None
    with file_path.open("r", encoding="utf-8") as file:
        for line in file:
            apiKey = line.strip()
            if apiKey and not apiKey.startswith("#"):
                return apiKey
    return None


def ensureDataFile():
    init_db()


# --- Cuentas Remuneradas (ex Intereses) ---

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
            "monedaDividendo": r["moneda_dividendo"] if "moneda_dividendo" in r.keys() else "USD",
            "monedaTotal": r["moneda_total"] if "moneda_total" in r.keys() else "EUR",
        }
        for r in rows
    ]}


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
        "precio_orden, precio_currency, cantidad, comisiones_cripto, total, currency, estado, fecha_cierre "
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
            "total": r["total"],
            "currency": r["currency"],
            "estado": r["estado"],
            "fechaCierre": r["fecha_cierre"],
        }
        for r in rows
    ]}


def writeOperacionesFile(data):
    conn = get_db()
    conn.execute("DELETE FROM operaciones")
    conn.executemany(
        "INSERT INTO operaciones "
        "(id, asset_id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
        "precio_currency, cantidad, comisiones_cripto, total, currency, estado, fecha_cierre) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), r.get("assetId", ""), r.get("activo", ""),
             r.get("fechaApertura", ""), r.get("par", ""), r.get("stablecoinSymbol", ""),
             r.get("orden", "Compra"), r.get("precioOrden", ""), r.get("precioCurrency", "EUR"),
             r.get("cantidad", ""), r.get("comisionesCripto", ""), r.get("total", ""),
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


# --- API keys (siguen leyendo de ficheros / env) ---

def readFinnhubApiKey():
    key = os.environ.get("FINNHUB_API_KEY", "").strip()
    if key:
        return key
    return (
        _read_first_api_key(apiDir / "finnhub.key")
        or _read_first_api_key(apiDir / "twelvedata.key")
    )


def readEodhdApiKey():
    env_keys = os.environ.get("EODHD_API_KEYS", "").strip()
    if env_keys:
        first_key = env_keys.split(",")[0].strip()
        if first_key:
            return first_key
    return _read_first_api_key(apiDir / "eodhd.key")


def readAlphaVantageApiKey():
    env_keys = os.environ.get("ALPHA_VANTAGE_API_KEYS", "").strip()
    if env_keys:
        first_key = env_keys.split(",")[0].strip()
        if first_key:
            return first_key
    return _read_first_api_key(apiDir / "alphavantage.key")


def readAlphaVantageApiKeys():
    env_keys_str = os.environ.get("ALPHA_VANTAGE_API_KEYS", "").strip()
    if env_keys_str:
        return [k.strip() for k in env_keys_str.split(",") if k.strip()]

    keyFile = apiDir / "alphavantage.key"
    if not keyFile.exists():
        return []

    seen = set()
    apiKeys = []
    with keyFile.open("r", encoding="utf-8") as file:
        for line in file:
            apiKey = line.strip()
            if apiKey and not apiKey.startswith("#") and apiKey not in seen:
                apiKeys.append(apiKey)
                seen.add(apiKey)
    return apiKeys


def readRotatedAlphaVantageApiKeys():
    global _alphaVantageKeyRotationIndex
    apiKeys = readAlphaVantageApiKeys()
    if not apiKeys:
        return []
    startIndex = _alphaVantageKeyRotationIndex % len(apiKeys)
    _alphaVantageKeyRotationIndex = (startIndex + 1) % len(apiKeys)
    return apiKeys[startIndex:] + apiKeys[:startIndex]


def readEodhdApiKeys():
    env_keys_str = os.environ.get("EODHD_API_KEYS", "").strip()
    if env_keys_str:
        return [k.strip() for k in env_keys_str.split(",") if k.strip()]

    eodhdKeyFile = apiDir / "eodhd.key"
    if not eodhdKeyFile.exists():
        return []

    seen = set()
    apiKeys = []
    with eodhdKeyFile.open("r", encoding="utf-8") as file:
        for line in file:
            apiKey = line.strip()
            if apiKey and not apiKey.startswith("#") and apiKey not in seen:
                apiKeys.append(apiKey)
                seen.add(apiKey)
    return apiKeys


def readRotatedEodhdApiKeys():
    global _eodhdKeyRotationIndex
    apiKeys = readEodhdApiKeys()
    if not apiKeys:
        return []
    startIndex = _eodhdKeyRotationIndex % len(apiKeys)
    _eodhdKeyRotationIndex = (startIndex + 1) % len(apiKeys)
    return apiKeys[startIndex:] + apiKeys[:startIndex]
