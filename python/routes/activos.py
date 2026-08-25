from decimal import Decimal

from flask import Blueprint, jsonify, request

from core import dinero, pnl_divisa
from core.db import get_db
from providers.alpha_vantage_client import fetch_quote as fetch_av_quote
from providers.eodhd_client import fetch_quote as fetch_eodhd_quote
from providers.finnhub_client import convert_amount, convert_quote_currency, fetch_quote
from providers.yahoo_finance_client import fetch_quote as fetch_yahoo_quote
from stores.app_data import readFinnhubApiKey
from stores.asset_store import (
    deleteAssetFile,
    getAssetFile,
    listAssets,
    readAssetFile,
    updateAssetMarketData,
    updateAssetsOrder,
    writeAssetFile,
)
from stores.asset_utils import (
    _MAX_TICKER,
    _trunc,
    createDefaultAssetPayload,
    inferMarketProviderFromSymbol,
    normalizeMarketProvider,
    sanitize_color,
    sanitizeAssetPayload,
    sanitizeAssetType,
    slugify,
)
from stores.helpers import (
    call_alpha_vantage_with_fallbacks,
    call_eodhd_with_fallbacks,
    convert_asset_rows_currency,
    format_decimal,
    is_temporary_service_error,
    normalize_currency_code,
    parse_loose_number,
)

activos_bp = Blueprint("activos", __name__)

SUPPORTED_ASSET_CURRENCIES = {"EUR", "USD", "GBP", "CHF", "JPY"}


@activos_bp.route("/api/activos", methods=["GET"])
def getActivos():
    return jsonify({"assets": listAssets()})


def _columna(row, nombre, defecto=""):
    """Valor de una columna que puede no existir todavía en la BD.

    `fx_rate` se añade por migración, y una consulta hecha contra una base que
    aún no la tiene lanzaría IndexError. Devolver el defecto deja el desglose
    marcado como incompleto, que es la degradación correcta.
    """
    try:
        valor = row[nombre]
    except (IndexError, KeyError):
        return defecto
    return defecto if valor is None else valor


def _descomponer_por_divisa(rows, participaciones_vivas, current_price, fx_actual):
    """Separa el resultado del activo entre efecto activo y efecto divisa.

    Cada compra aporta su lote con **su** tipo de cambio: aplicar un tipo medio
    a todo el invertido daría un efecto divisa que no corresponde a ninguna
    operación real. El valor actual se reparte entre los lotes en proporción a
    lo invertido en cada uno, que es la única forma de repartirlo sin conocer a
    qué lote pertenece cada participación que queda viva (eso lo sabe el FIFO
    fiscal, y traerlo aquí ataría esta pantalla al módulo de ventas).
    """
    compras = []
    for row in rows:
        if str(row["tipo_operacion"] or "").strip().lower() == "venta":
            continue
        capital = parse_loose_number(row["capital_invertido_bruto"]) or Decimal("0")
        if capital <= 0:
            continue
        compras.append({
            "invertido": capital,
            "fxCompra": _columna(row, "fx_rate"),
        })

    invertido_total = sum((c["invertido"] for c in compras), Decimal("0"))
    valor_actual = max(Decimal("0"), participaciones_vivas) * current_price

    if invertido_total <= 0:
        # Sin compras registradas no hay nada que repartir, pero el valor actual
        # (una posición heredada, por ejemplo) sí se convierte a euros.
        return pnl_divisa.descomponer(0, valor_actual, fx_actual, fx_actual)

    for compra in compras:
        compra["valorActual"] = valor_actual * compra["invertido"] / invertido_total

    return pnl_divisa.descomponer_lotes(compras, fx_actual)


@activos_bp.route("/api/activos/rendimiento-batch", methods=["GET"])
def getRendimientoBatch():
    conn = get_db()
    assets = conn.execute(
        "SELECT id, price, currency, type FROM activos"
    ).fetchall()

    result = {}
    # Tipos de cambio actuales, uno por divisa presente en la cartera. Se
    # resuelven fuera del bucle para no repetir la consulta por cada activo.
    fx_actuales = _tipos_actuales({str(a["currency"] or "EUR").upper() for a in assets})

    for asset in assets:
        asset_id = asset["id"]
        asset_type = str(asset["type"] or "").strip().lower()
        is_crypto = asset_type == "cripto"
        current_price = parse_loose_number(asset["price"]) or Decimal("0")

        rows = conn.execute(
            "SELECT tipo_operacion, participaciones, capital_invertido_bruto, "
            "comisiones, comisiones_fiat, fx_rate FROM activo_rows WHERE asset_id = ?",
            (asset_id,)
        ).fetchall()

        op_rows = conn.execute(
            "SELECT orden, cantidad, comisiones_cripto, total FROM activo_operation_rows "
            "WHERE asset_id = ? AND estado = 'Completado'",
            (asset_id,)
        ).fetchall()

        # Decimal y no float: estos tres acumuladores recorren todas las filas
        # de un activo, y en coma flotante el error de cada suma se arrastra
        # hasta el total invertido que se enseña en la tabla principal.
        total_participaciones = Decimal("0")
        total_invertido_bruto = Decimal("0")
        total_comisiones_fiat = Decimal("0")

        for row in rows:
            tipo = str(row["tipo_operacion"] or "").strip().lower()
            partic = parse_loose_number(row["participaciones"]) or Decimal("0")
            capital = parse_loose_number(row["capital_invertido_bruto"]) or Decimal("0")
            comis = parse_loose_number(row["comisiones"]) or Decimal("0")
            comis_fiat = parse_loose_number(row["comisiones_fiat"]) or Decimal("0")

            if tipo == "venta":
                total_participaciones -= partic
            else:
                total_participaciones += partic
                total_invertido_bruto += capital
                total_comisiones_fiat += comis_fiat if is_crypto else comis

        for op in op_rows:
            orden = str(op["orden"] or "").strip().lower()
            cantidad = parse_loose_number(op["cantidad"]) or Decimal("0")
            comis_cripto = parse_loose_number(op["comisiones_cripto"]) or Decimal("0")
            total_fiat = parse_loose_number(op["total"]) or Decimal("0")

            if orden == "venta":
                total_participaciones -= cantidad + comis_cripto
            else:
                total_participaciones += max(Decimal("0"), cantidad - comis_cripto)
                total_invertido_bruto += total_fiat

        inverted_neto = max(Decimal("0"), total_invertido_bruto - total_comisiones_fiat)
        neto_actual = max(Decimal("0"), total_participaciones) * current_price
        rendimiento = neto_actual - inverted_neto
        rendimiento_pct = (rendimiento / inverted_neto * 100) if inverted_neto > 0 else Decimal("0")

        # `float` solo aquí, al serializar: el JSON de esta ruta lleva números
        # y el frontend los espera así. Todo el cálculo de arriba es Decimal, y
        # la conversión se hace una vez sobre el valor ya redondeado.
        result[asset_id] = {
            "rendimiento": float(dinero.redondear(rendimiento)),
            "invertidoNeto": float(dinero.redondear(inverted_neto)),
            "rendimientoPct": float(dinero.redondear(rendimiento_pct)),
            "netoActual": float(dinero.redondear(neto_actual)),
        }

        # Desglose activo/divisa. Las cifras de arriba están en la moneda del
        # activo y se mantienen tal cual —cambiarlas rompería la tabla que ya
        # las pinta—; esto se añade al lado, en euros. Para un activo en euros
        # el efecto divisa sale cero y el desglose no estorba.
        moneda = str(asset["currency"] or "EUR").upper()
        descomposicion = _descomponer_por_divisa(
            rows, total_participaciones, current_price, fx_actuales.get(moneda),
        )
        result[asset_id]["divisa"] = {
            "moneda": moneda,
            **descomposicion.como_dict(),
        }

    return jsonify(result)


def _tipos_actuales(monedas):
    """Tipo de cambio de hoy para cada divisa, sin salir a la red si no hace falta.

    `permitir_descarga=False`: esta ruta la llama la tabla principal en cada
    carga, y una petición a un proveedor por divisa la volvería lenta y
    dependiente de que el proveedor conteste. Si no hay tipo cacheado se usa 1,
    lo que deja el importe en la moneda del activo y marca el desglose como
    incompleto —el frontend lo advierte— en vez de inventarse una conversión.
    """
    from stores.fx_historico import tasa_actual

    tipos = {}
    for moneda in monedas:
        rate, _origen, _fecha = tasa_actual(moneda, permitir_descarga=False)
        tipos[moneda] = rate
    return tipos


@activos_bp.route("/api/activos", methods=["POST"])
def createActivo():
    requestData = request.get_json(silent=True) or {}
    assetName = str(requestData.get("name", "")).strip()
    assetType = sanitizeAssetType(requestData.get("type", ""))
    marketSymbol = str(requestData.get("marketSymbol", requestData.get("finnhubSymbol", ""))).strip().upper()
    marketProvider = normalizeMarketProvider(
        requestData.get("marketProvider", ""),
        fallback=inferMarketProviderFromSymbol(marketSymbol)
    )

    if not assetName:
        return jsonify({"ok": False, "error": "El nombre del activo es obligatorio"}), 400

    if not assetType:
        return jsonify({"ok": False, "error": "Tipo de activo inválido"}), 400

    assetId = slugify(assetName)
    assetFile = getAssetFile(assetId)

    if assetFile.exists():
        return jsonify({"ok": False, "error": "Ya existe un activo con ese nombre"}), 409

    payload = createDefaultAssetPayload(assetName, assetType, assetId)
    payload["marketProvider"] = marketProvider
    payload["marketSymbol"] = marketSymbol
    payload["finnhubSymbol"] = marketSymbol
    payload["order"] = len(listAssets())
    payload["color"] = sanitize_color(requestData.get("color", ""))
    payload["tvSymbol"] = _trunc(str(requestData.get("tvSymbol", "")), _MAX_TICKER).strip()
    writeAssetFile(assetId, payload)

    return jsonify({"ok": True, "asset": payload}), 201


@activos_bp.route("/api/activos/reorder", methods=["POST"])
def reorderActivos():
    requestData = request.get_json(silent=True) or {}
    assets = listAssets()
    orderedAssetIds = requestData.get("orderedAssetIds")

    if isinstance(orderedAssetIds, list):
        normalizedIds = [slugify(assetId) for assetId in orderedAssetIds if str(assetId).strip()]
        currentIds = [asset["id"] for asset in assets]

        if sorted(normalizedIds) != sorted(currentIds):
            return jsonify({"ok": False, "error": "orderedAssetIds no coincide con los activos actuales"}), 400

        assetById = {asset["id"]: asset for asset in assets}
        assets = [assetById[assetId] for assetId in normalizedIds]
    else:
        # Se comprueba el valor crudo, no el slug: slugify("") devuelve
        # "activo", así que `if not assetId` nunca se cumplía y omitir el campo
        # acababa en un 404 "Activo no encontrado" que no dice qué falta.
        assetIdCrudo = str(requestData.get("assetId", "")).strip()
        direction = str(requestData.get("direction", "")).strip().lower()

        if not assetIdCrudo:
            return jsonify({"ok": False, "error": "assetId es obligatorio"}), 400

        assetId = slugify(assetIdCrudo)

        if direction not in {"up", "down"}:
            return jsonify({"ok": False, "error": "direction inválida"}), 400

        currentIndex = next((index for index, asset in enumerate(assets) if asset["id"] == assetId), None)

        if currentIndex is None:
            return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

        swapIndex = currentIndex - 1 if direction == "up" else currentIndex + 1

        if swapIndex < 0 or swapIndex >= len(assets):
            return jsonify({"ok": True, "moved": False})

        assets[currentIndex], assets[swapIndex] = assets[swapIndex], assets[currentIndex]

    updateAssetsOrder([asset["id"] for asset in assets])
    return jsonify({"ok": True, "moved": True})


@activos_bp.route("/api/activos/<assetId>", methods=["GET"])
def getActivo(assetId):
    data = readAssetFile(assetId)

    if data is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    return jsonify(data)


@activos_bp.route("/api/activos/<assetId>", methods=["POST"])
def saveActivo(assetId):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitizeAssetPayload(requestData, slugify(assetId))

    if error:
        return jsonify({"ok": False, "error": error}), 400

    existing_asset = readAssetFile(assetId) or {}

    if not requestData.get("operationRows") and isinstance(existing_asset.get("operationRows"), list):
        payload["operationRows"] = existing_asset.get("operationRows", [])

    writeAssetFile(assetId, payload)
    return jsonify({"ok": True})


@activos_bp.route("/api/activos/<assetId>/refresh-market-data", methods=["POST"])
def refreshActivoMarketData(assetId):
    assetData = readAssetFile(assetId)

    if assetData is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    marketSymbol = str(assetData.get("marketSymbol", assetData.get("finnhubSymbol", ""))).strip().upper()
    marketProvider = normalizeMarketProvider(
        assetData.get("marketProvider", ""),
        fallback=inferMarketProviderFromSymbol(marketSymbol)
    )

    if not marketSymbol:
        return jsonify({"ok": False, "error": "El activo no tiene ticker de mercado configurado"}), 400

    if marketProvider == "eodhd":
        quote, error = call_eodhd_with_fallbacks(lambda apiKey: fetch_eodhd_quote(marketSymbol, apiKey))
    elif marketProvider == "yahoo":
        quote, error = fetch_yahoo_quote(marketSymbol)
    elif marketProvider == "alphavantage":
        quote, error = call_alpha_vantage_with_fallbacks(lambda apiKey: fetch_av_quote(marketSymbol, apiKey))
    else:
        apiKey = readFinnhubApiKey()
        quote, error = fetch_quote(marketSymbol, apiKey)

    if error:
        statusCode = 503 if "API key" in error or is_temporary_service_error(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    asset_currency = normalize_currency_code(assetData.get("currency") or "", fallback="")
    if asset_currency and asset_currency != normalize_currency_code(quote.get("currency", ""), fallback=""):
        converted, conv_error = convert_quote_currency(quote, asset_currency)
        if not conv_error and converted:
            quote = converted

    assetData["marketProvider"] = marketProvider
    assetData["marketSymbol"] = quote["symbol"]
    assetData["finnhubSymbol"] = quote["symbol"]
    assetData["price"] = quote["price"]
    assetData["currency"] = asset_currency or quote["currency"]
    assetData["change"] = quote["change"]
    assetData["status"] = quote["status"]
    assetData["lastUpdated"] = quote["lastUpdated"]
    updateAssetMarketData(assetId, assetData)

    return jsonify({"ok": True, "asset": assetData, "marketData": quote["marketData"]})


@activos_bp.route("/api/activos/<assetId>/currency", methods=["POST"])
def changeActivoCurrency(assetId):
    """Cambia la única moneda del activo: convierte precio y capital invertido.

    Un activo tiene una sola moneda, así que el cambio arrastra todo lo que
    está denominado en ella; si no, quedarían cifras de monedas distintas
    mezcladas en la misma fila.
    """
    assetData = readAssetFile(assetId)

    if assetData is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    requestData = request.get_json(silent=True) or {}
    is_crypto = str(assetData.get("type", "")).strip().lower() == "cripto"
    current_currency = normalize_currency_code(assetData.get("currency", ""), fallback="EUR")
    target_currency = normalize_currency_code(requestData.get("currency", ""), fallback=current_currency)

    if target_currency not in SUPPORTED_ASSET_CURRENCIES:
        return jsonify({
            "ok": False,
            "error": f"Moneda no soportada. Opciones: {', '.join(sorted(SUPPORTED_ASSET_CURRENCIES))}"
        }), 400

    if current_currency == target_currency:
        return jsonify({"ok": True, "asset": assetData, "converted": False})

    converted_price = parse_loose_number(assetData.get("price", ""))

    if converted_price is not None:
        converted_price, error = convert_amount(converted_price, current_currency, target_currency)

        if error:
            statusCode = 503 if is_temporary_service_error(error) else 400
            return jsonify({"ok": False, "error": error}), statusCode

        assetData["price"] = format_decimal(converted_price)

    # Las filas de cripto llevan su propia moneda por compra (se compró en EUR o
    # en USD y así queda registrado); las demás están todas en la del activo.
    if not is_crypto:
        converted_rows, error = convert_asset_rows_currency(
            assetData.get("rows", []),
            current_currency,
            target_currency,
            assetData.get("type", ""),
            fields=None
        )

        if error:
            statusCode = 503 if is_temporary_service_error(error) else 400
            return jsonify({"ok": False, "error": error}), statusCode

        assetData["rows"] = converted_rows

    assetData["currency"] = target_currency
    assetData["status"] = f"Activo convertido de {current_currency} a {target_currency}"
    writeAssetFile(assetId, assetData)

    return jsonify({"ok": True, "asset": assetData, "converted": True})

@activos_bp.route("/api/activos/<assetId>", methods=["DELETE"])
def deleteActivo(assetId):
    if not deleteAssetFile(assetId):
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    return jsonify({"ok": True})


# ── Tipos de cambio históricos ────────────────────────────────────────────────
# Separar el efecto divisa exige el tipo de cambio del día de cada operación, y
# ese dato no estaba: las operaciones anteriores a esta versión lo tienen vacío.
# Estas dos rutas permiten ver cuántas faltan y reconstruirlas por lotes.


@activos_bp.route("/api/fx/pendientes", methods=["GET"])
def getFxPendientes():
    from stores.fx_historico import contar_pendientes

    return jsonify({"ok": True, "pendientes": contar_pendientes()})


@activos_bp.route("/api/fx/rellenar", methods=["POST"])
def rellenarFx():
    """Completa un lote de tipos de cambio históricos.

    Por lotes y no de una vez: una cartera con años de operaciones son cientos
    de peticiones al proveedor, y hacerlas todas dentro de una petición HTTP
    acabaría en timeout del navegador. Se llama repetidamente hasta que
    `pendientes` llega a cero.
    """
    from stores.fx_historico import rellenar_pendientes

    requestData = request.get_json(silent=True) or {}
    try:
        # Tope generoso pero acotado: sin límite superior, un cliente podría
        # pedir un lote que tarde minutos y bloquee un worker.
        limite = max(1, min(1000, int(requestData.get("limite", 200))))
    except (TypeError, ValueError):
        limite = 200

    return jsonify({"ok": True, **rellenar_pendientes(limite=limite)})


@activos_bp.route("/api/metricas/inversiones", methods=["GET"])
def getMetricasInversiones():
    conn = get_db()

    spot_rows = conn.execute(
        "SELECT fecha_operacion, tipo_operacion, capital_invertido_bruto FROM activo_rows"
    ).fetchall()

    op_rows = conn.execute(
        "SELECT fecha_apertura, orden, total FROM activo_operation_rows WHERE estado = 'Completado'"
    ).fetchall()

    by_month = {}
    by_year = {}

    for row in spot_rows:
        tipo = str(row["tipo_operacion"] or "").strip().lower()
        if tipo == "venta":
            continue
        parts = str(row["fecha_operacion"] or "").strip().split("-")
        if len(parts) != 3:
            continue
        capital = parse_loose_number(row["capital_invertido_bruto"]) or Decimal("0")
        month, year = parts[1].zfill(2), parts[2]
        key = f"{year}-{month}"
        by_month[key] = by_month.get(key, Decimal("0")) + capital
        by_year[year] = by_year.get(year, Decimal("0")) + capital

    for row in op_rows:
        if str(row["orden"] or "").strip().lower() == "venta":
            continue
        parts = str(row["fecha_apertura"] or "").strip().split("-")
        if len(parts) != 3:
            continue
        total = parse_loose_number(row["total"]) or Decimal("0")
        month, year = parts[1].zfill(2), parts[2]
        key = f"{year}-{month}"
        by_month[key] = by_month.get(key, Decimal("0")) + total
        by_year[year] = by_year.get(year, Decimal("0")) + total

    # De Decimal a float una sola vez, al serializar. Redondeado a dos
    # decimales: son importes en euros y antes salían con la cola binaria de
    # las sumas en coma flotante (12.340000000000002).
    return jsonify({
        "byMonth": {k: float(dinero.redondear(v)) for k, v in by_month.items()},
        "byYear": {k: float(dinero.redondear(v)) for k, v in by_year.items()},
    })
