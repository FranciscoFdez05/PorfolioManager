from db import get_db
from asset_utils import inferMarketProviderFromSymbol, slugify


def readAssetFile(assetId):
    conn = get_db()
    safe_id = slugify(assetId)

    row = conn.execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, "
        "sort_order, price, currency, precio_currency, change, status, last_updated, color, tv_symbol "
        "FROM activos WHERE id = ?",
        (safe_id,)
    ).fetchone()

    if row is None:
        return None

    result = {
        "id": row["id"],
        "name": row["name"],
        "symbol": row["symbol"],
        "marketProvider": row["market_provider"],
        "marketSymbol": row["market_symbol"],
        "finnhubSymbol": row["finnhub_symbol"],
        "type": row["type"],
        "order": row["sort_order"],
        "price": row["price"],
        "currency": row["currency"],
        "precioCurrency": row["precio_currency"],
        "change": row["change"],
        "status": row["status"],
        "lastUpdated": row["last_updated"],
        "color": row["color"],
        "tvSymbol": row["tv_symbol"],
    }

    result["rows"] = [
        {
            "fechaOperacion": r["fecha_operacion"],
            "tipoOperacion": r["tipo_operacion"],
            "exchange": r["exchange"],
            "currency": r["currency"],
            "participaciones": r["participaciones"],
            "precioParticipacion": r["precio_participacion"],
            "capitalInvertidoBruto": r["capital_invertido_bruto"],
            "costeAnual": r["coste_anual"],
            "comisiones": r["comisiones"],
            "comisionesFiat": r["comisiones_fiat"],
            "comisionesCripto": r["comisiones_cripto"],
            "comisionesSatoshis": r["comisiones_satoshis"],
        }
        for r in conn.execute(
            "SELECT fecha_operacion, tipo_operacion, exchange, currency, participaciones, "
            "precio_participacion, capital_invertido_bruto, coste_anual, comisiones, "
            "comisiones_fiat, comisiones_cripto, comisiones_satoshis "
            "FROM activo_rows WHERE asset_id = ? ORDER BY id",
            (safe_id,)
        ).fetchall()
    ]

    result["operationRows"] = [
        {
            "id": r["id"],
            "assetId": safe_id,
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
        for r in conn.execute(
            "SELECT id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
            "precio_currency, cantidad, comisiones_cripto, total, currency, estado, fecha_cierre "
            "FROM activo_operation_rows WHERE asset_id = ? ORDER BY rowid",
            (safe_id,)
        ).fetchall()
    ]

    result["conversionRows"] = [
        {
            "id": r["id"],
            "fecha": r["fecha"],
            "par": r["par"],
            "tipo": r["tipo"],
            "cantidad": r["cantidad"],
        }
        for r in conn.execute(
            "SELECT id, fecha, par, tipo, cantidad FROM activo_conversion_rows "
            "WHERE asset_id = ? ORDER BY rowid",
            (safe_id,)
        ).fetchall()
    ]

    return result


def updateAssetMarketData(assetId, data):
    """Actualiza solo los campos de mercado de un activo existente. No crea el activo si no existe."""
    conn = get_db()
    safe_id = slugify(assetId)
    conn.execute(
        "UPDATE activos SET "
        "market_provider=?, market_symbol=?, finnhub_symbol=?, "
        "price=?, currency=?, change=?, status=?, last_updated=? "
        "WHERE id=?",
        (
            data.get("marketProvider", "finnhub"),
            data.get("marketSymbol", data.get("finnhubSymbol", "")),
            data.get("finnhubSymbol", data.get("marketSymbol", "")),
            data.get("price", "0,00"),
            data.get("currency", "EUR"),
            data.get("change", "+0,00%"),
            data.get("status", "Mercado abierto"),
            data.get("lastUpdated", ""),
            safe_id,
        )
    )
    conn.commit()


def writeAssetFile(assetId, data):
    conn = get_db()
    safe_id = slugify(assetId)

    conn.execute(
        "INSERT INTO activos "
        "(id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, sort_order, "
        "price, currency, precio_currency, change, status, last_updated, color, tv_symbol) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, symbol=excluded.symbol, market_provider=excluded.market_provider, "
        "market_symbol=excluded.market_symbol, finnhub_symbol=excluded.finnhub_symbol, "
        "type=excluded.type, sort_order=excluded.sort_order, price=excluded.price, "
        "currency=excluded.currency, precio_currency=excluded.precio_currency, "
        "change=excluded.change, status=excluded.status, last_updated=excluded.last_updated, "
        "color=excluded.color, tv_symbol=excluded.tv_symbol",
        (
            safe_id,
            data.get("name", ""),
            data.get("symbol", ""),
            data.get("marketProvider", "finnhub"),
            data.get("marketSymbol", data.get("finnhubSymbol", "")),
            data.get("finnhubSymbol", data.get("marketSymbol", "")),
            data.get("type", ""),
            data.get("order", 0),
            data.get("price", "0,00"),
            data.get("currency", "EUR"),
            data.get("precioCurrency", "EUR"),
            data.get("change", "+0,00%"),
            data.get("status", "Mercado abierto"),
            data.get("lastUpdated", ""),
            data.get("color", ""),
            data.get("tvSymbol", ""),
        )
    )

    conn.execute("DELETE FROM activo_rows WHERE asset_id = ?", (safe_id,))
    conn.executemany(
        "INSERT INTO activo_rows "
        "(asset_id, fecha_operacion, tipo_operacion, exchange, currency, participaciones, "
        "precio_participacion, capital_invertido_bruto, coste_anual, comisiones, "
        "comisiones_fiat, comisiones_cripto, comisiones_satoshis) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (safe_id, r.get("fechaOperacion", ""), r.get("tipoOperacion", ""),
             r.get("exchange", ""), r.get("currency", "EUR"), r.get("participaciones", ""),
             r.get("precioParticipacion", ""), r.get("capitalInvertidoBruto", ""),
             r.get("costeAnual", ""), r.get("comisiones", ""), r.get("comisionesFiat", ""),
             r.get("comisionesCripto", ""), r.get("comisionesSatoshis", ""))
            for r in data.get("rows", [])
        ]
    )

    conn.execute("DELETE FROM activo_operation_rows WHERE asset_id = ?", (safe_id,))
    conn.executemany(
        "INSERT INTO activo_operation_rows "
        "(id, asset_id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
        "precio_currency, cantidad, comisiones_cripto, total, currency, estado, fecha_cierre) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), safe_id, r.get("activo", ""), r.get("fechaApertura", ""),
             r.get("par", ""), r.get("stablecoinSymbol", ""), r.get("orden", "Compra"),
             r.get("precioOrden", ""), r.get("precioCurrency", "EUR"), r.get("cantidad", ""),
             r.get("comisionesCripto", ""), r.get("total", ""), r.get("currency", "EUR"),
             r.get("estado", "Activo"), r.get("fechaCierre", ""))
            for r in data.get("operationRows", [])
        ]
    )

    conn.execute("DELETE FROM activo_conversion_rows WHERE asset_id = ?", (safe_id,))
    conn.executemany(
        "INSERT INTO activo_conversion_rows (id, asset_id, fecha, par, tipo, cantidad) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), safe_id, r.get("fecha", ""), r.get("par", ""),
             r.get("tipo", ""), r.get("cantidad", ""))
            for r in data.get("conversionRows", [])
        ]
    )

    conn.commit()


def _parse_num(value):
    text = str(value or "").strip().replace(".", "").replace(",", ".")
    try:
        return float(text)
    except (TypeError, ValueError):
        return 0.0


def listAssets():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, "
        "sort_order, price, currency, precio_currency, change, status, last_updated, color, tv_symbol "
        "FROM activos ORDER BY sort_order, symbol"
    ).fetchall()

    asset_rows = conn.execute(
        "SELECT asset_id, tipo_operacion, participaciones, capital_invertido_bruto, "
        "comisiones, comisiones_fiat FROM activo_rows"
    ).fetchall()

    op_rows = conn.execute(
        "SELECT asset_id, orden, cantidad, comisiones_cripto, total "
        "FROM activo_operation_rows WHERE estado = 'Completado'"
    ).fetchall()

    rows_by_asset = {}
    for row in asset_rows:
        rows_by_asset.setdefault(row["asset_id"], []).append(row)

    op_rows_by_asset = {}
    for row in op_rows:
        op_rows_by_asset.setdefault(row["asset_id"], []).append(row)

    result = []
    for r in rows:
        asset_id = r["id"]
        is_crypto = str(r["type"] or "").strip().lower() == "cripto"
        current_price = _parse_num(r["price"])

        total_partic = 0.0
        total_invertido = 0.0
        total_comis = 0.0

        for row in rows_by_asset.get(asset_id, []):
            tipo = str(row["tipo_operacion"] or "").strip().lower()
            partic = _parse_num(row["participaciones"])
            capital = _parse_num(row["capital_invertido_bruto"])
            comis = _parse_num(row["comisiones"])
            comis_fiat = _parse_num(row["comisiones_fiat"])
            if tipo == "venta":
                total_partic -= partic
            else:
                total_partic += partic
                total_invertido += capital
                total_comis += comis_fiat if is_crypto else comis

        for op in op_rows_by_asset.get(asset_id, []):
            orden = str(op["orden"] or "").strip().lower()
            cantidad = _parse_num(op["cantidad"])
            comis_cripto = _parse_num(op["comisiones_cripto"])
            total_fiat = _parse_num(op["total"])
            if orden == "venta":
                total_partic -= cantidad + comis_cripto
            else:
                total_partic += max(0.0, cantidad - comis_cripto)
                total_invertido += total_fiat

        inverted_neto = max(0.0, total_invertido - total_comis)
        neto_actual = max(0.0, total_partic) * current_price
        rdm = neto_actual - inverted_neto
        rdm_pct = (rdm / inverted_neto * 100) if inverted_neto > 0 else 0.0

        result.append({
            "id": asset_id,
            "name": r["name"],
            "symbol": r["symbol"],
            "marketProvider": r["market_provider"],
            "marketSymbol": r["market_symbol"],
            "finnhubSymbol": r["finnhub_symbol"],
            "type": r["type"],
            "order": r["sort_order"],
            "price": r["price"],
            "currency": r["currency"],
            "precioCurrency": r["precio_currency"],
            "change": r["change"],
            "status": r["status"],
            "lastUpdated": r["last_updated"],
            "color": r["color"],
            "tvSymbol": r["tv_symbol"],
            "rendimiento": round(rdm, 2),
            "invertidoNeto": round(inverted_neto, 2),
            "rendimientoPct": round(rdm_pct, 2),
        })

    return result


def updateAssetsOrder(ordered_ids):
    """Recibe una lista de asset IDs en el orden deseado y actualiza sort_order en bloque."""
    conn = get_db()
    conn.executemany(
        "UPDATE activos SET sort_order = ? WHERE id = ?",
        [(index, slugify(asset_id)) for index, asset_id in enumerate(ordered_ids)]
    )
    conn.commit()


def deleteAssetFile(assetId):
    conn = get_db()
    safe_id = slugify(assetId)
    result = conn.execute("DELETE FROM activos WHERE id = ?", (safe_id,))
    conn.commit()
    return result.rowcount > 0


def getAssetFile(assetId):
    """Shim de compatibilidad: devuelve un objeto con .exists() para el código de rutas."""
    class _ExistenceCheck:
        def __init__(self, asset_id):
            self._id = asset_id

        def exists(self):
            return readAssetFile(self._id) is not None

    return _ExistenceCheck(assetId)
