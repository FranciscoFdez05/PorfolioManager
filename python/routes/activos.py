from decimal import Decimal

from flask import Blueprint, jsonify, request

from core import dinero, pnl_divisa
from core.db import getActiveDbPath, getDb
from providers.finnhub_client import convertAmount, fetchExchangeRate
from stores import alertas_store, rendimiento_activo, revisiones
from stores.asset_store import (
    deleteAssetFile,
    getAssetFile,
    listAssets,
    readAssetFile,
    updateAssetQuote,
    updateAssetsOrder,
    writeAssetFile,
)
from stores.asset_utils import (
    _MAX_NAME,
    _MAX_TICKER,
    SUPPORTED_ASSET_CURRENCIES,
    _trunc,
    createDefaultAssetPayload,
    inferMarketProviderFromSymbol,
    normalizeMarketProvider,
    sanitizeAssetPayload,
    sanitizeAssetType,
    sanitizeColor,
    slugify,
)
from stores.fx_historico import tipoActualConMemo
from stores.helpers import (
    convertAssetRowsCurrency,  # noqa: F401  (los tests lo sustituyen en el módulo)
    formatDecimal,
    isTemporaryServiceError,
    normalizeCurrencyCode,
    parseLooseNumber,
)
from stores.market_data import edadEnCache, fetchAssetQuote

activosBp = Blueprint("activos", __name__)


@activosBp.route("/api/activos", methods=["GET"])
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


def _descomponerPorDivisa(rows, participacionesVivas, currentPrice, fxActual, operaciones=(), esCripto=False,
                          ventas=(), transacciones=(), conversiones=()):
    """Separa el resultado del activo entre efecto activo y efecto divisa.

    Cada compra aporta su lote con **su** tipo de cambio: aplicar un tipo medio
    a todo el invertido daría un efecto divisa que no corresponde a ninguna
    operación real. El valor actual se reparte entre los lotes en proporción a
    lo invertido en cada uno, que es la única forma de repartirlo sin conocer a
    qué lote pertenece cada participación que queda viva (eso lo sabe el FIFO
    fiscal, y traerlo aquí ataría esta pantalla al módulo de ventas).
    """
    # Solo cuenta el coste de lo que sigue en cartera: lo vendido ya no está en
    # el valor actual, y dejarlo en el invertido falseaba los dos efectos.
    compras = []
    for lote in rendimiento_activo.lotesVivos(
        rows, operaciones, esCripto, ventas, None, transacciones, conversiones
    ):
        if lote["coste"] <= 0:
            continue
        compras.append({
            "invertido": lote["coste"],
            "fxCompra": lote["fx"],
        })

    invertidoTotal = sum((c["invertido"] for c in compras), Decimal("0"))
    valorActual = max(Decimal("0"), participacionesVivas) * currentPrice

    if invertidoTotal <= 0:
        # Sin compras registradas no hay nada que repartir, pero el valor actual
        # (una posición heredada, por ejemplo) sí se convierte a euros.
        return pnl_divisa.descomponer(0, valorActual, fxActual, fxActual)

    for compra in compras:
        compra["valorActual"] = valorActual * compra["invertido"] / invertidoTotal

    return pnl_divisa.descomponerLotes(compras, fxActual)


@activosBp.route("/api/activos/rendimiento-batch", methods=["GET"])
def getRendimientoBatch():
    conn = getDb()
    assets = conn.execute(
        "SELECT id, price, currency, type FROM activos"
    ).fetchall()

    result = {}
    # Tipos de cambio actuales, uno por divisa presente en la cartera. Se
    # resuelven fuera del bucle para no repetir la consulta por cada activo.
    fxActuales = _tiposActuales({str(a["currency"] or "EUR").upper() for a in assets})

    # Una carga para toda la cartera, no una por activo: con decenas de activos
    # esto se llamaba en cada carga de la tabla principal.
    posiciones = rendimiento_activo.cargarPosiciones(conn)
    tipoDeCambio = tipoActualConMemo()

    for asset in assets:
        assetId = asset["id"]
        datos = posiciones.get(assetId, {})
        rows = datos.get("filas", [])
        opsDelActivo = datos.get("operaciones", [])
        currentPrice = rendimiento_activo.numero(asset["price"])
        # El cálculo es el de stores/rendimiento_activo, el mismo que usa la
        # lista de activos: antes había una copia aquí y otra allí.
        totales = rendimiento_activo.calcular(
            rows,
            opsDelActivo,
            str(asset["type"] or "").strip().lower() == "cripto",
            asset["price"],
            datos.get("ventas", []),
            datos.get("transacciones", []),
            datos.get("conversiones", []),
            str(asset["currency"] or "EUR").strip().upper() or "EUR",
            tipoDeCambio,
        )
        result[assetId] = totales.paraJson()
        totalParticipaciones = totales.participaciones

        # Desglose activo/divisa. Las cifras de arriba están en la moneda del
        # activo y se mantienen tal cual —cambiarlas rompería la tabla que ya
        # las pinta—; esto se añade al lado, en euros. Para un activo en euros
        # el efecto divisa sale cero y el desglose no estorba.
        moneda = str(asset["currency"] or "EUR").upper()
        descomposicion = _descomponerPorDivisa(
            rows, totalParticipaciones, currentPrice, fxActuales.get(moneda),
            operaciones=opsDelActivo,
            esCripto=str(asset["type"] or "").strip().lower() == "cripto",
            ventas=posiciones.get(assetId, {}).get("ventas", []),
            transacciones=posiciones.get(assetId, {}).get("transacciones", []),
            conversiones=posiciones.get(assetId, {}).get("conversiones", []),
        )
        result[assetId]["divisa"] = {
            "moneda": moneda,
            **descomposicion.comoDict(),
        }

    return jsonify(result)


def _tiposActuales(monedas):
    """Tipo de cambio de hoy para cada divisa, sin salir a la red si no hace falta.

    `permitir_descarga=False`: esta ruta la llama la tabla principal en cada
    carga, y una petición a un proveedor por divisa la volvería lenta y
    dependiente de que el proveedor conteste. Si no hay tipo cacheado se usa 1,
    lo que deja el importe en la moneda del activo y marca el desglose como
    incompleto —el frontend lo advierte— en vez de inventarse una conversión.
    """
    from stores.fx_historico import tasaActual

    tipos = {}
    for moneda in monedas:
        rate, _origen, _fecha = tasaActual(moneda, permitirDescarga=False)
        if rate is None:
            rate = _tipoDelProveedor(moneda)
        tipos[moneda] = rate
    return tipos


def _tipoDelProveedor(moneda):
    """Tipo de hoy de `moneda` a euros pedido al servicio de cambio, o None.

    Sin él, el valor actual de un activo en dólares se sumaba como si fueran
    euros. No hace falta recordarlo aquí: `fetchExchangeRate` ya cachea cada par
    unos minutos para todos los llamadores.
    """
    rate, error = fetchExchangeRate(moneda, "EUR", timeout=5)
    return Decimal(str(rate)) if not error and rate and rate > 0 else None


@activosBp.route("/api/activos", methods=["POST"])
def createActivo():
    requestData = request.get_json(silent=True) or {}
    # Se acota como en saveActivo: sin tope, el slug derivado del nombre podía
    # superar el limit_request_line de gunicorn y dejar el activo imborrable
    # (DELETE/PUT llevan el id en la URL y caían en 400 antes de llegar a Flask).
    assetName = _trunc(requestData.get("name", ""), _MAX_NAME).strip()
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
    payload["color"] = sanitizeColor(requestData.get("color", ""))
    payload["tvSymbol"] = _trunc(str(requestData.get("tvSymbol", "")), _MAX_TICKER).strip()
    if assetType == "etfs":
        payload["costeAnual"] = _trunc(str(requestData.get("costeAnual", "")), _MAX_TICKER).strip()
    writeAssetFile(assetId, payload)

    return jsonify({"ok": True, "asset": payload}), 201


@activosBp.route("/api/activos/reorder", methods=["POST"])
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


@activosBp.route("/api/activos/<assetId>", methods=["GET"])
def getActivo(assetId):
    data = readAssetFile(assetId)

    if data is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    return jsonify(data)


# Tope de ids por lote: el frontend los parte en trozos de 50, y sin tope una
# URL manipulada podría pedir miles de fichas en una sola petición.
_MAX_IDS_LOTE = 200


@activosBp.route("/api/activos-lote", methods=["GET"])
def getActivosLote():
    """Varias fichas de una vez: `?ids=a,b,c` -> {"assets": {id: ficha}}.

    Cada pantalla que necesita las filas de todos los activos hacía una
    petición por activo (33 al entrar en Vista general, Activos, Métricas...).
    La ficha es la misma que devuelve /api/activos/<id>; los que no existen se
    omiten y el llamador los trata como ese 404. No cuelga de /api/activos/
    para no quitarle a ningún activo el id "lote".
    """
    ids = list(dict.fromkeys(i.strip() for i in request.args.get("ids", "").split(",") if i.strip()))
    if not ids or len(ids) > _MAX_IDS_LOTE:
        return jsonify({"ok": False, "error": f"Indica entre 1 y {_MAX_IDS_LOTE} ids"}), 400

    fichas = {}
    revisionesPorActivo = {}
    for assetId in ids:
        data = readAssetFile(assetId)
        if data is not None:
            fichas[assetId] = data
            revisionesPorActivo[assetId] = revisiones.actual("activos", slugify(assetId))
    # La revisión va aparte y no dentro de cada ficha: la ficha tiene que seguir
    # siendo idéntica a la de /api/activos/<id>. El cliente la reenvía al
    # guardar y, si otra pestaña u otro dispositivo guardó el activo entretanto,
    # el guardado se rechaza con un 409 (ver stores/revisiones.py).
    return jsonify({"assets": fichas, "revisiones": revisionesPorActivo})


def _respuestaConflicto(conflicto):
    """La misma respuesta 409 que gastos e ingresos (ver stores/revisiones.py)."""
    return jsonify({
        "ok": False, "conflicto": True, "revision": conflicto.actual,
        "error": "Este activo ha cambiado desde otro sitio (otra pestaña u otro dispositivo)",
    }), 409


@activosBp.route("/api/activos/<assetId>", methods=["POST"])
def saveActivo(assetId):
    requestData = request.get_json(silent=True) or {}
    payload, error = sanitizeAssetPayload(requestData, slugify(assetId))

    if error:
        return jsonify({"ok": False, "error": error}), 400

    try:
        esperada = revisiones.revisionDePeticion(requestData)
    except ValueError as e:
        return jsonify({"ok": False, "error": str(e)}), 400

    existingAsset = readAssetFile(assetId) or {}

    if not requestData.get("operationRows") and isinstance(existingAsset.get("operationRows"), list):
        payload["operationRows"] = existingAsset.get("operationRows", [])

    # Guardar reescribe el activo entero: lo que no venga en el cuerpo se borra.
    # Una edición de la cabecera —renombrar, cambiar el color o el ticker— no
    # tiene por qué mandar las compras ni las conversiones, y hacerlo se llevaba
    # el historial por delante sin decir nada.
    #
    # Se distingue "no viene la clave" de "viene vacía": mandar [] sigue
    # vaciando, que es como la tabla borra su última fila. La comprobación de
    # `operationRows` de arriba no puede hacer lo mismo —conserva también con
    # [] y así estaba antes de esto—, porque quien las manda las tiene en una
    # variable en memoria que no siempre está poblada.
    for campo in ("rows", "conversionRows"):
        if campo not in requestData and isinstance(existingAsset.get(campo), list):
            payload[campo] = existingAsset[campo]

    # Mismo caso para las preferencias de cabecera: el autoguardado de la ficha
    # no las manda, y sin esto cada edición de una fila apagaba la conversión de
    # divisa y volvía a mostrar un activo oculto.
    for campo in ("convertCurrency", "hidden", "costeAnual"):
        if campo not in requestData and campo in existingAsset:
            payload[campo] = existingAsset[campo]

    # El proveedor ya elegido no se re-infiere del ticker: un ticker con ":" es
    # lo normal en TradingView y la inferencia lo mandaba a finnhub. Solo se
    # cambia si el cuerpo trae un proveedor válido de forma explícita.
    proveedorExistente = existingAsset.get("marketProvider")
    if proveedorExistente and normalizeMarketProvider(requestData.get("marketProvider", ""), fallback="") == "":
        payload["marketProvider"] = proveedorExistente

    try:
        nueva = writeAssetFile(assetId, payload, revisionEsperada=esperada)
    except revisiones.ConflictoRevision as conflicto:
        return _respuestaConflicto(conflicto)
    return jsonify({"ok": True, "revision": nueva})


@activosBp.route("/api/activos/<assetId>/refresh-market-data", methods=["POST"])
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

    # La divisa del activo es también la de lo invertido: el rendimiento se
    # calcula como precio por participaciones menos invertido sin convertir, así
    # que el precio se guarda siempre en esa divisa, venga el ticker en la que
    # venga. El interruptor "Convertir la cotización" del modal no se lee aquí:
    # lo que hace es cambiar la divisa del activo (precio y compras a la vez,
    # con `/currency`), y así nunca hay dos divisas distintas en juego.
    targetCurrency = normalizeCurrencyCode(assetData.get("currency", ""), fallback="EUR")
    # Por defecto se pide un precio nuevo al proveedor (botón «Actualizar
    # cotizaciones»). La carga y el refresco automáticos mandan `usarCache: true`
    # en el cuerpo para aceptar el del servidor dentro de su TTL; el automático manda
    # además `maxEdadSegundos` (su intervalo) para no recibir uno más viejo.
    opciones = request.get_json(silent=True)
    if not isinstance(opciones, dict):
        opciones = {}
    usarCache = opciones.get("usarCache") is True
    maxEdadSegundos = opciones.get("maxEdadSegundos")
    if isinstance(maxEdadSegundos, bool) or not isinstance(maxEdadSegundos, int):
        maxEdadSegundos = None
    opcionesCache = {}
    edadCache = None
    if usarCache:
        edadCache = edadEnCache(marketSymbol, marketProvider, targetCurrency, maxEdadSegundos)
        if maxEdadSegundos is not None:
            opcionesCache["maxEdadSegundos"] = maxEdadSegundos
    quote, error = fetchAssetQuote(
        marketSymbol, marketProvider, useCache=usarCache, targetCurrency=targetCurrency, **opcionesCache
    )

    if error:
        statusCode = 503 if "API key" in error or isTemporaryServiceError(error) else 400
        return jsonify({"ok": False, "error": error}), statusCode

    # `fetchAssetQuote` devuelve la cotización sin convertir si falla el tipo
    # de cambio. Aquí eso no sirve: se guardaría un precio en dólares con la
    # etiqueta de euros. Mejor no tocar el precio y decirlo.
    if normalizeCurrencyCode(quote.get("currency", ""), fallback="") != targetCurrency:
        return jsonify({
            "ok": False,
            "error": f"No se pudo convertir la cotización de {quote.get('currency')} a {targetCurrency}; "
                     "se mantiene el último precio",
        }), 503

    # Solo se escriben los campos de la cotización, y solo si el activo sigue
    # con la misma divisa y ticker con los que se pidió: la consulta al
    # proveedor tarda, y un cambio de divisa hecho mientras tanto dejaría un
    # precio en la moneda vieja con la etiqueta de la nueva.
    guardada = updateAssetQuote(
        assetId,
        {
            "provider": marketProvider, "symbol": quote["symbol"], "price": quote["price"],
            "currency": targetCurrency, "change": quote["change"], "status": quote["status"],
            "lastUpdated": quote["lastUpdated"],
        },
        divisaLeida=assetData.get("currency"),
        simboloLeido=assetData.get("marketSymbol"),
    )
    if not guardada:
        return jsonify({
            "ok": False,
            "error": "El activo cambió (divisa, ticker o borrado) mientras se consultaba la "
                     "cotización; no se ha guardado el precio. Vuelve a actualizar.",
        }), 409

    assetData = readAssetFile(assetId)

    # Un precio nuevo puede cumplir una alerta: se evalúa aquí, además de en el
    # hilo de fondo, para que refrescar a mano (o el refresco automático de la
    # web) no tenga que esperar a la siguiente pasada.
    alertas = alertas_store.evaluarActivo(
        slugify(assetId), quote["price"], alertas_store.cambioDesdeTexto(quote["change"]),
        cartera=getActiveDbPath().stem,
    )

    return jsonify({
        "ok": True, "asset": assetData, "marketData": quote["marketData"],
        "alertasSaltadas": len(alertas),
        # De cuándo es el precio lo dice `asset.lastUpdated`; esto solo indica si
        # salió de la caché del servidor y con cuántos segundos de antigüedad.
        "desdeCache": edadCache is not None,
        "edadCacheSegundos": round(edadCache) if edadCache is not None else None,
    })


def _tipoDeConversion(origen, destino):
    """Cuántas unidades de `destino` vale una de `origen`, o `(None, error)`.

    Si una de las dos es el euro, el tipo sale del cambio de la otra a euros (y su
    inverso exacto en el otro sentido); las demás parejas, directas.
    """
    if origen != "EUR" and destino != "EUR":
        tipo, error = convertAmount(Decimal("1"), origen, destino)
        return tipo, error
    otra = destino if origen == "EUR" else origen
    tipo, error = convertAmount(Decimal("1"), otra, "EUR")
    if error or tipo is None or tipo <= 0:
        return None, error or "Tipo de cambio no disponible"
    return (tipo if destino == "EUR" else Decimal("1") / tipo), None


_CAMPOS_DE_IMPORTE = ("precioParticipacion", "capitalInvertidoBruto", "comisiones")


def _importeConvertido(valor, tipo):
    """Importe por el tipo, en texto canónico con hasta ocho decimales.

    No se redondea a céntimos: hacerlo en cada conversión perdía céntimos en una
    ida y vuelta (1.000 pasaba a 999,99). Lo que queda a menos de una millonésima
    de un valor de céntimos se ajusta a él, para que el resultado sea 1000 y no
    999,99999999.
    """
    numero = parseLooseNumber(valor)
    if numero is None:
        return valor
    convertido = dinero.redondear(numero * tipo, 8)
    centimos = dinero.redondear(convertido, 2)
    if abs(convertido - centimos) < Decimal("0.000001"):
        convertido = centimos
    return dinero.aTexto(convertido)


def _convertirFila(fila, tipo):
    convertida = dict(fila)
    for campo in _CAMPOS_DE_IMPORTE:
        if campo in convertida:
            convertida[campo] = _importeConvertido(convertida[campo], tipo)
    return convertida


@activosBp.route("/api/activos/<assetId>/currency", methods=["POST"])
def changeActivoCurrency(assetId):
    """Cambia la única moneda del activo: convierte precio y capital invertido.

    Un activo tiene una sola moneda, así que el cambio arrastra todo lo que
    está denominado en ella; si no, quedarían cifras de monedas distintas
    mezcladas en la misma fila.
    """
    # La revisión se lee ANTES que el activo: si se guardara entre medias, la
    # revisión leída después ya incluiría ese guardado y la escritura lo pisaría.
    revisionLeida = revisiones.actual("activos", slugify(assetId))
    assetData = readAssetFile(assetId)

    if assetData is None:
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    requestData = request.get_json(silent=True) or {}
    isCrypto = str(assetData.get("type", "")).strip().lower() == "cripto"
    currentCurrency = normalizeCurrencyCode(assetData.get("currency", ""), fallback="EUR")
    targetCurrency = normalizeCurrencyCode(requestData.get("currency", ""), fallback=currentCurrency)

    if targetCurrency not in SUPPORTED_ASSET_CURRENCIES:
        return jsonify({
            "ok": False,
            "error": f"Moneda no soportada. Opciones: {', '.join(sorted(SUPPORTED_ASSET_CURRENCIES))}"
        }), 400

    if currentCurrency == targetCurrency:
        return jsonify({"ok": True, "asset": assetData, "converted": False})

    # Un único tipo para todo (precio y filas), y siempre pasando por el cambio a
    # euros: así volver a la divisa de partida deshace la conversión exacta, en
    # vez de multiplicar por dos tipos que no son el inverso uno del otro.
    rate, errorRate = _tipoDeConversion(currentCurrency, targetCurrency)
    if errorRate or rate is None or rate <= 0:
        statusCode = 503 if isTemporaryServiceError(errorRate or "") else 400
        return jsonify({"ok": False, "error": errorRate or "Tipo de cambio no disponible"}), statusCode

    convertedPrice = parseLooseNumber(assetData.get("price", ""))

    if convertedPrice is not None:
        assetData["price"] = formatDecimal(convertedPrice * rate)

    # Las filas de cripto llevan su propia moneda por compra (se compró en EUR o
    # en USD y así queda registrado); las demás están todas en la del activo.
    if not isCrypto:
        convertedRows = [_convertirFila(fila, rate) for fila in assetData.get("rows", [])]

        # Cambiar la divisa del activo es un cambio de visualización: no puede
        # alterar el resultado fiscal de las ventas ya hechas. Los importes de
        # las filas se convierten con el tipo de hoy (`rate`), así que el tipo
        # de cambio de cada fila se reescala con el mismo `rate` para que
        # importe x tipo siga valiendo en euros lo que costó de verdad en su
        # fecha. Si la fila no tenía tipo no hay nada que conservar y queda como
        # una fila nueva en la divisa nueva (1 en euros, pendiente en otra).
        for fila, original in zip(convertedRows, assetData.get("rows", []), strict=True):
            tipoAnterior = parseLooseNumber(original.get("fxRate", ""))
            if tipoAnterior is None and str(original.get("currency") or "EUR").upper() == "EUR":
                tipoAnterior = Decimal("1")
            fila["currency"] = targetCurrency
            if tipoAnterior is not None and tipoAnterior > 0:
                fila["fxRate"] = f"{tipoAnterior / rate:.12f}"
                fila["fxOrigen"] = "conversion"
            else:
                fila["fxRate"] = "1.00000000" if targetCurrency == "EUR" else ""
                fila["fxFecha"] = ""
                fila["fxOrigen"] = "base" if targetCurrency == "EUR" else ""

        assetData["rows"] = convertedRows

    assetData["currency"] = targetCurrency
    # Si el activo fija la divisa de la cotización, tiene que seguir siendo la
    # del activo: la siguiente cotización llegaría en la vieja y el refresco la
    # rechazaría por no coincidir.
    if assetData.get("convertCurrency"):
        assetData["convertCurrency"] = targetCurrency
    assetData["status"] = f"Activo convertido de {currentCurrency} a {targetCurrency}"
    # La conversión consulta el tipo de cambio por red y tarda: si mientras tanto
    # se guardó el activo desde otro sitio, escribirlo entero con lo leído antes
    # borraría esos cambios. Con la revisión de entonces, el guardado se rechaza.
    try:
        assetData["revision"] = writeAssetFile(
            assetId, assetData, revisionEsperada=revisionLeida
        )
    except revisiones.ConflictoRevision as conflicto:
        return _respuestaConflicto(conflicto)

    return jsonify({"ok": True, "asset": assetData, "converted": True})

@activosBp.route("/api/activos/<assetId>", methods=["DELETE"])
def deleteActivo(assetId):
    if not deleteAssetFile(assetId):
        return jsonify({"ok": False, "error": "Activo no encontrado"}), 404

    return jsonify({"ok": True})


# ── Tipos de cambio históricos ────────────────────────────────────────────────
# Separar el efecto divisa exige el tipo de cambio del día de cada operación, y
# ese dato no estaba: las operaciones anteriores a esta versión lo tienen vacío.
# Estas dos rutas permiten ver cuántas faltan y reconstruirlas por lotes.


@activosBp.route("/api/fx/pendientes", methods=["GET"])
def getFxPendientes():
    from stores.fx_historico import contarPendientes

    return jsonify({"ok": True, "pendientes": contarPendientes()})


@activosBp.route("/api/fx/rellenar", methods=["POST"])
def rellenarFx():
    """Completa un lote de tipos de cambio históricos.

    Por lotes y no de una vez: una cartera con años de operaciones son cientos
    de peticiones al proveedor, y hacerlas todas dentro de una petición HTTP
    acabaría en timeout del navegador. Se llama repetidamente hasta que
    `pendientes` llega a cero.
    """
    from stores.fx_historico import rellenarPendientes

    requestData = request.get_json(silent=True) or {}
    try:
        # Tope generoso pero acotado: sin límite superior, un cliente podría
        # pedir un lote que tarde minutos y bloquee un worker.
        limite = max(1, min(1000, int(requestData.get("limite", 200))))
    except (TypeError, ValueError):
        limite = 200

    return jsonify({"ok": True, **rellenarPendientes(limite=limite)})


@activosBp.route("/api/metricas/inversiones", methods=["GET"])
def getMetricasInversiones():
    conn = getDb()

    spotRows = conn.execute(
        "SELECT fecha_operacion, tipo_operacion, capital_invertido_bruto FROM activo_rows"
    ).fetchall()

    opRows = conn.execute(
        "SELECT fecha_apertura, fecha_cierre, orden, total "
        "FROM activo_operation_rows WHERE estado = 'Completado'"
    ).fetchall()

    byMonth = {}
    byYear = {}

    for row in spotRows:
        tipo = str(row["tipo_operacion"] or "").strip().lower()
        if tipo == "venta":
            continue
        parts = str(row["fecha_operacion"] or "").strip().split("-")
        if len(parts) != 3:
            continue
        capital = parseLooseNumber(row["capital_invertido_bruto"]) or Decimal("0")
        month, year = parts[1].zfill(2), parts[2]
        key = f"{year}-{month}"
        byMonth[key] = byMonth.get(key, Decimal("0")) + capital
        byYear[year] = byYear.get(year, Decimal("0")) + capital

    for row in opRows:
        if str(row["orden"] or "").strip().lower() == "venta":
            continue
        # La inversión cuenta el mes en que la orden se ejecutó, no aquel en el
        # que se dejó puesta: una compra abierta en enero y completada en mayo
        # es dinero invertido en mayo. Si la fila no trae fecha de cierre
        # utilizable se cae a la de apertura.
        parts = str(row["fecha_cierre"] or "").strip().split("-")
        if len(parts) != 3:
            parts = str(row["fecha_apertura"] or "").strip().split("-")
        if len(parts) != 3:
            continue
        total = parseLooseNumber(row["total"]) or Decimal("0")
        month, year = parts[1].zfill(2), parts[2]
        key = f"{year}-{month}"
        byMonth[key] = byMonth.get(key, Decimal("0")) + total
        byYear[year] = byYear.get(year, Decimal("0")) + total

    # De Decimal a float una sola vez, al serializar. Redondeado a dos
    # decimales: son importes en euros y antes salían con la cola binaria de
    # las sumas en coma flotante (12.340000000000002).
    return jsonify({
        "byMonth": {k: float(dinero.redondear(v)) for k, v in byMonth.items()},
        "byYear": {k: float(dinero.redondear(v)) for k, v in byYear.items()},
    })
