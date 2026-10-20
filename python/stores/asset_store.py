from core.db import getDb, transactional
from stores import rendimiento_activo, revisiones
from stores.asset_utils import slugify


def readAssetFile(assetId):
    conn = getDb()
    safeId = slugify(assetId)

    row = conn.execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, "
        "sort_order, price, currency, change, status, last_updated, color, tv_symbol, hidden, "
        "convert_currency, coste_anual "
        "FROM activos WHERE id = ?",
        (safeId,)
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
        "change": row["change"],
        "status": row["status"],
        "lastUpdated": row["last_updated"],
        "color": row["color"],
        "tvSymbol": row["tv_symbol"],
        "hidden": bool(row["hidden"]),
        "convertCurrency": row["convert_currency"],
        "costeAnual": row["coste_anual"],
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
            "fxRate": r["fx_rate"],
            "fxFecha": r["fx_fecha"],
            "fxOrigen": r["fx_origen"],
        }
        for r in conn.execute(
            "SELECT fecha_operacion, tipo_operacion, exchange, currency, participaciones, "
            "precio_participacion, capital_invertido_bruto, coste_anual, comisiones, "
            "comisiones_fiat, comisiones_cripto, comisiones_satoshis, fx_rate, fx_fecha, fx_origen "
            "FROM activo_rows WHERE asset_id = ? ORDER BY id",
            (safeId,)
        ).fetchall()
    ]

    result["operationRows"] = [
        {
            "id": r["id"],
            "assetId": safeId,
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
            "fxRate": r["fx_rate"],
            "fxFecha": r["fx_fecha"],
            "fxOrigen": r["fx_origen"],
        }
        for r in conn.execute(
            "SELECT id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
            "precio_currency, cantidad, comisiones_cripto, comisiones_fiat, total, currency, estado, "
            "fecha_cierre, fx_rate, fx_fecha, fx_origen "
            "FROM activo_operation_rows WHERE asset_id = ? ORDER BY rowid",
            (safeId,)
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
            (safeId,)
        ).fetchall()
    ]

    return result


@transactional
def updateAssetMarketData(assetId, data):
    """Actualiza solo los campos de mercado de un activo existente. No crea el activo si no existe."""
    conn = getDb()
    safeId = slugify(assetId)
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
            safeId,
        )
    )
    conn.commit()


@transactional
def updateAssetQuote(assetId, quote, divisaLeida, simboloLeido):
    """Guarda una cotización solo si el activo sigue como estaba al pedirla.

    Pedir la cotización al proveedor tarda segundos. Si en ese tiempo se cambió
    la divisa del activo o su ticker, el precio que llega ya no corresponde y
    escribirlo mezclaría monedas. La condición va en el propio UPDATE, así que
    no queda ventana entre comprobar y escribir. Solo toca los campos de la
    cotización; nada de lo demás que se haya editado entretanto.

    Args:
        assetId: Identificador del activo.
        quote: Dict con provider, symbol, price, currency, change, status y lastUpdated.
        divisaLeida: Valor de `currency` tal como se leyó antes de pedir la cotización.
        simboloLeido: Valor de `market_symbol` tal como se leyó antes.

    Returns:
        True si se guardó; False si el activo ya no existe o cambió de divisa o ticker.
    """
    conn = getDb()
    resultado = conn.execute(
        "UPDATE activos SET market_provider=?, market_symbol=?, finnhub_symbol=?, "
        "price=?, currency=?, change=?, status=?, last_updated=? "
        "WHERE id=? AND currency=? AND market_symbol=?",
        (
            quote["provider"], quote["symbol"], quote["symbol"],
            quote["price"], quote["currency"], quote["change"], quote["status"],
            quote["lastUpdated"],
            slugify(assetId), divisaLeida, simboloLeido,
        ),
    )
    conn.commit()
    return resultado.rowcount > 0


def _fxPrevios(conn, tabla, columnaFecha, safeId):
    """Tipos de cambio ya anotados en las filas de un activo, por (fecha, divisa).

    El tipo depende solo de la fecha y de la divisa de la operación, así que es
    la clave con la que una fila reescrita puede heredarlo: si el usuario cambia
    la fecha o la divisa, la fila vuelve a quedar pendiente, que es lo correcto.
    """
    return {
        (r["fecha"], r["currency"]): (r["fx_rate"], r["fx_fecha"], r["fx_origen"])
        for r in conn.execute(
            f"SELECT {columnaFecha} AS fecha, currency, fx_rate, fx_fecha, fx_origen "
            f"FROM {tabla} WHERE asset_id = ? AND fx_rate != ''",
            (safeId,),
        )
    }


def _fxDeFila(fila, previos, fecha, divisa):
    """El trío fx de la fila: el que trae, o el anotado antes para su fecha y divisa.

    Las filas llegan del navegador sin estas columnas (el formulario no las
    edita): reescribirlas sin heredarlas borraba el tipo histórico en cada
    guardado del activo, y también en cada GET /api/operaciones.
    """
    if str(fila.get("fxRate") or "").strip():
        return (str(fila.get("fxRate")), str(fila.get("fxFecha") or ""), str(fila.get("fxOrigen") or ""))
    return previos.get((fecha, divisa), ("", "", ""))


@transactional
def writeAssetFile(assetId, data, revisionEsperada=None):
    """Sustituye el activo entero. Devuelve la revisión nueva.

    Con `revisionEsperada` lanza ConflictoRevision si el activo se guardó desde
    otro sitio después de que el cliente lo leyera (ver stores/revisiones.py).
    """
    conn = getDb()
    safeId = slugify(assetId)
    revisiones.tomarBloqueo(conn)
    revisiones.comprobar(conn, "activos", safeId, revisionEsperada)
    fxFilas = _fxPrevios(conn, "activo_rows", "fecha_operacion", safeId)
    fxOperaciones = _fxPrevios(conn, "activo_operation_rows", "fecha_apertura", safeId)

    conn.execute(
        "INSERT INTO activos "
        "(id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, sort_order, "
        "price, currency, change, status, last_updated, color, tv_symbol, hidden, convert_currency, coste_anual) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(id) DO UPDATE SET "
        "name=excluded.name, symbol=excluded.symbol, market_provider=excluded.market_provider, "
        "market_symbol=excluded.market_symbol, finnhub_symbol=excluded.finnhub_symbol, "
        "type=excluded.type, sort_order=excluded.sort_order, price=excluded.price, "
        "currency=excluded.currency, "
        "change=excluded.change, status=excluded.status, last_updated=excluded.last_updated, "
        "color=excluded.color, tv_symbol=excluded.tv_symbol, hidden=excluded.hidden, "
        "convert_currency=excluded.convert_currency, coste_anual=excluded.coste_anual",
        (
            safeId,
            data.get("name", ""),
            data.get("symbol", ""),
            data.get("marketProvider", "finnhub"),
            data.get("marketSymbol", data.get("finnhubSymbol", "")),
            data.get("finnhubSymbol", data.get("marketSymbol", "")),
            data.get("type", ""),
            data.get("order", 0),
            data.get("price", "0,00"),
            data.get("currency", "EUR"),
            data.get("change", "+0,00%"),
            data.get("status", "Mercado abierto"),
            data.get("lastUpdated", ""),
            data.get("color", ""),
            data.get("tvSymbol", ""),
            1 if data.get("hidden") else 0,
            data.get("convertCurrency", ""),
            data.get("costeAnual", ""),
        )
    )

    conn.execute("DELETE FROM activo_rows WHERE asset_id = ?", (safeId,))
    conn.executemany(
        "INSERT INTO activo_rows "
        "(asset_id, fecha_operacion, tipo_operacion, exchange, currency, participaciones, "
        "precio_participacion, capital_invertido_bruto, coste_anual, comisiones, "
        "comisiones_fiat, comisiones_cripto, comisiones_satoshis, fx_rate, fx_fecha, fx_origen) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (safeId, r.get("fechaOperacion", ""), r.get("tipoOperacion", ""),
             r.get("exchange", ""), r.get("currency", "EUR"), r.get("participaciones", ""),
             r.get("precioParticipacion", ""), r.get("capitalInvertidoBruto", ""),
             r.get("costeAnual", ""), r.get("comisiones", ""), r.get("comisionesFiat", ""),
             r.get("comisionesCripto", ""), r.get("comisionesSatoshis", ""),
             *_fxDeFila(r, fxFilas, r.get("fechaOperacion", ""), r.get("currency", "EUR")))
            for r in data.get("rows", [])
        ]
    )

    conn.execute("DELETE FROM activo_operation_rows WHERE asset_id = ?", (safeId,))
    conn.executemany(
        "INSERT INTO activo_operation_rows "
        "(id, asset_id, activo, fecha_apertura, par, stablecoin_symbol, orden, precio_orden, "
        "precio_currency, cantidad, comisiones_cripto, comisiones_fiat, total, currency, estado, fecha_cierre, "
        "fx_rate, fx_fecha, fx_origen) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), safeId, r.get("activo", ""), r.get("fechaApertura", ""),
             r.get("par", ""), r.get("stablecoinSymbol", ""), r.get("orden", "Compra"),
             r.get("precioOrden", ""), r.get("precioCurrency", "EUR"), r.get("cantidad", ""),
             r.get("comisionesCripto", ""), r.get("comisionesFiat", ""),
             r.get("total", ""), r.get("currency", "EUR"),
             r.get("estado", "Activo"), r.get("fechaCierre", ""),
             *_fxDeFila(r, fxOperaciones, r.get("fechaApertura", ""), r.get("currency", "EUR")))
            for r in data.get("operationRows", [])
        ]
    )

    conn.execute("DELETE FROM activo_conversion_rows WHERE asset_id = ?", (safeId,))
    conn.executemany(
        "INSERT INTO activo_conversion_rows (id, asset_id, fecha, par, tipo, cantidad) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        [
            (r.get("id", ""), safeId, r.get("fecha", ""), r.get("par", ""),
             r.get("tipo", ""), r.get("cantidad", ""))
            for r in data.get("conversionRows", [])
        ]
    )

    nueva = revisiones.avanzar(conn, "activos", safeId)
    conn.commit()
    return nueva


def listAssets():
    conn = getDb()
    rows = conn.execute(
        "SELECT id, name, symbol, market_provider, market_symbol, finnhub_symbol, type, "
        "sort_order, price, currency, change, status, last_updated, color, tv_symbol, hidden, "
        "convert_currency, coste_anual "
        "FROM activos ORDER BY sort_order, symbol"
    ).fetchall()

    assetRows = conn.execute(
        "SELECT asset_id, tipo_operacion, participaciones, capital_invertido_bruto, "
        "comisiones, comisiones_fiat FROM activo_rows"
    ).fetchall()

    opRows = conn.execute(
        "SELECT asset_id, orden, cantidad, comisiones_cripto, total "
        "FROM activo_operation_rows WHERE estado = 'Completado'"
    ).fetchall()

    rowsByAsset = {}
    for row in assetRows:
        rowsByAsset.setdefault(row["asset_id"], []).append(row)

    opRowsByAsset = {}
    for row in opRows:
        opRowsByAsset.setdefault(row["asset_id"], []).append(row)

    assetsWithRows = set()
    for assetId, assetR in rowsByAsset.items():
        if any(r["participaciones"] or r["capital_invertido_bruto"] for r in assetR):
            assetsWithRows.add(assetId)
    for assetId, opR in opRowsByAsset.items():
        if any(r["cantidad"] or r["total"] for r in opR):
            assetsWithRows.add(assetId)

    result = []
    for r in rows:
        assetId = r["id"]
        # El mismo cálculo que la tabla principal (rendimiento-batch): en Decimal
        # y con el mismo lector de importes. Antes eran dos copias, esta en float.
        totales = rendimiento_activo.calcular(
            rowsByAsset.get(assetId, []),
            opRowsByAsset.get(assetId, []),
            str(r["type"] or "").strip().lower() == "cripto",
            r["price"],
        ).paraJson()

        result.append({
            "id": assetId,
            "name": r["name"],
            "symbol": r["symbol"],
            "marketProvider": r["market_provider"],
            "marketSymbol": r["market_symbol"],
            "finnhubSymbol": r["finnhub_symbol"],
            "type": r["type"],
            "order": r["sort_order"],
            "price": r["price"],
            "currency": r["currency"],
            "change": r["change"],
            "status": r["status"],
            "lastUpdated": r["last_updated"],
            "color": r["color"],
            "tvSymbol": r["tv_symbol"],
            "hidden": bool(r["hidden"]),
            "convertCurrency": r["convert_currency"],
            "costeAnual": r["coste_anual"],
            "rendimiento": totales["rendimiento"],
            "invertidoNeto": totales["invertidoNeto"],
            "rendimientoPct": totales["rendimientoPct"],
            "hasRows": assetId in assetsWithRows,
        })

    return result


@transactional
def updateAssetsOrder(orderedIds):
    """Recibe una lista de asset IDs en el orden deseado y actualiza sort_order en bloque."""
    conn = getDb()
    conn.executemany(
        "UPDATE activos SET sort_order = ? WHERE id = ?",
        [(index, slugify(assetId)) for index, assetId in enumerate(orderedIds)]
    )
    conn.commit()


@transactional
def deleteAssetFile(assetId):
    conn = getDb()
    safeId = slugify(assetId)
    result = conn.execute("DELETE FROM activos WHERE id = ?", (safeId,))
    if result.rowcount > 0:
        # Una pestaña que aún tenga el activo abierto no debe poder resucitarlo
        # al guardar con la revisión de antes del borrado.
        revisiones.avanzar(conn, "activos", safeId)
    conn.commit()
    return result.rowcount > 0


def getAssetFile(assetId):
    """Shim de compatibilidad: devuelve un objeto con .exists() para el código de rutas."""
    class _ExistenceCheck:
        def __init__(self, assetId):
            self._id = assetId

        def exists(self):
            return readAssetFile(self._id) is not None

    return _ExistenceCheck(assetId)
