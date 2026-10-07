// Vista general: desglose por divisa, métricas superiores, lotes y tabla resumen.
//
// Separado de js/cartera/assets.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

let _divisaBatchCache = null

async function fetchDivisaBatch({ forzar = false } = {}) {
    if (_divisaBatchCache && !forzar) {
        return _divisaBatchCache
    }
    try {
        const res = await fetch("/api/activos/rendimiento-batch")
        _divisaBatchCache = res.ok ? await res.json() : {}
    } catch {
        // Un fallo aquí no puede impedir que se vea la ficha: el desglose es
        // información adicional, no el dato principal de la pantalla.
        _divisaBatchCache = {}
    }
    return _divisaBatchCache
}

async function renderAssetDivisaBreakdown(assetId) {
    const contenedor = document.getElementById("assetStatDivisa")
    if (!contenedor) return

    const datos = (await fetchDivisaBatch())[assetId]?.divisa
    // Un activo en euros no tiene efecto divisa que separar: la línea sobra.
    if (!datos || datos.moneda === "EUR") {
        contenedor.classList.add("hidden")
        contenedor.innerHTML = ""
        return
    }

    const activo = Number(datos.efectoActivo)
    const divisa = Number(datos.efectoDivisa)
    const signo = (v) => (v >= 0 ? "+" : "")
    const clase = (v) => (v > 0 ? "assetStatPositive" : v < 0 ? "assetStatNegative" : "")

    // El aviso importa: sin el tipo de cambio del día de cada compra, el
    // reparto entre los dos efectos es una aproximación y presentarlo como
    // exacto sería peor que no darlo.
    const aviso = datos.completo
        ? ""
        : `<span class="assetStatDivisaAviso" title="Faltan tipos de cambio históricos de algunas compras. Complétalos desde Ajustes → Tipos de cambio.">aprox.</span>`

    contenedor.classList.remove("hidden")
    contenedor.innerHTML = `
        <span class="assetStatDivisaItem">
            <span class="assetStatDivisaLabel">Activo</span>
            <span class="${clase(activo)}">${signo(activo)}${formatMoney(activo, "EUR")}</span>
        </span>
        <span class="assetStatDivisaItem">
            <span class="assetStatDivisaLabel">Divisa (${escapeHtml(datos.moneda)})</span>
            <span class="${clase(divisa)}">${signo(divisa)}${formatMoney(divisa, "EUR")}</span>
        </span>
        ${aviso}
    `
}

function calculateYieldPercent(invertidoNeto, rendimiento) {
    if (!invertidoNeto) {
        return 0
    }

    return (rendimiento / invertidoNeto) * 100
}

function createEmptyTopMetrics() {
    return {
        totalCuenta: 0,
        invertido: 0,
        rendimiento: 0,
        tipos: {
            cripto: { netoActual: 0, invertido: 0, rendimiento: 0 },
            acciones: { netoActual: 0, invertido: 0, rendimiento: 0 },
            etfs: { netoActual: 0, invertido: 0, rendimiento: 0 },
            comoditis: { netoActual: 0, invertido: 0, rendimiento: 0 }
        }
    }
}

function updateTopMetricElement(elementId, value, colorize = false) {
    const element = document.getElementById(elementId)
    if (!element) return
    element.textContent = value
    if (colorize) {
        const isNegative = value.trim().startsWith("-")
        const num = parseFloat(value.replace(/[^0-9.,-]/g, "").replace(",", "."))
        const isZero = isNaN(num) || num === 0
        element.classList.toggle("metricPositive", !isNegative && !isZero)
        element.classList.toggle("metricNegative", isNegative)
    } else {
        element.classList.remove("metricPositive", "metricNegative")
    }
}

function applyTopPortfolioMetrics(metrics) {
    updateTopMetricElement("topTotalCuenta", formatEuro(metrics.totalCuenta))
    updateTopMetricElement(
        "topPorcentajeCuenta",
        formatPercent(calculateYieldPercent(metrics.invertido, metrics.rendimiento)),
        true
    )
    updateTopMetricElement("topInvertido", formatEuro(metrics.invertido))
    updateTopMetricElement("topRendimientoEuros", formatEuro(metrics.rendimiento))
    const numActivosEl = document.getElementById("topNumActivos")
    if (numActivosEl && metrics.numActivos !== undefined) numActivosEl.textContent = metrics.numActivos

    updateTopMetricElement(
        "topPorcentajeCripto",
        formatPercent(calculateYieldPercent(metrics.tipos.cripto.invertido, metrics.tipos.cripto.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosCripto", formatEuro(metrics.tipos.cripto.netoActual))
    updateTopMetricElement(
        "topPorcentajeAcciones",
        formatPercent(calculateYieldPercent(metrics.tipos.acciones.invertido, metrics.tipos.acciones.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosAcciones", formatEuro(metrics.tipos.acciones.netoActual))
    updateTopMetricElement(
        "topPorcentajeEtf",
        formatPercent(calculateYieldPercent(metrics.tipos.etfs.invertido, metrics.tipos.etfs.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosEtf", formatEuro(metrics.tipos.etfs.netoActual))
    updateTopMetricElement(
        "topPorcentajeComoditis",
        formatPercent(calculateYieldPercent(metrics.tipos.comoditis.invertido, metrics.tipos.comoditis.rendimiento)),
        true
    )
    updateTopMetricElement("topEurosComoditis", formatEuro(metrics.tipos.comoditis.netoActual))
    if (typeof applyTopMetricsVisibility === "function") applyTopMetricsVisibility()
}

async function refreshTopPortfolioMetrics(assets = null) {
    const baseAssets = Array.isArray(assets) ? assets : await loadAssetsList()

    if (!baseAssets.length) {
        applyTopPortfolioMetrics(createEmptyTopMetrics())
        return
    }

    const metrics = createEmptyTopMetrics()
    const fullAssets = await Promise.all(baseAssets.map((asset) => loadAssetData(asset.id)))
    const metricResults = await Promise.allSettled(
        fullAssets.map(async (asset) => {
            const summary = await buildOverviewRow(asset)
            const euroMetrics = await buildSummaryMetricsInEuros(summary)

            return { summary, euroMetrics, assetId: asset.id }
        })
    )
    metricResults
        .filter((r) => r.status === "rejected")
        .forEach((r) => console.error("Error calculando métricas de activo:", r.reason))
    const metricSummaries = metricResults.filter((r) => r.status === "fulfilled").map((r) => r.value)

    metricSummaries.forEach(({ summary, euroMetrics }) => {
        metrics.totalCuenta += euroMetrics.netoActualEur
        metrics.invertido += euroMetrics.invertidoBrutoEur
        metrics.rendimiento += euroMetrics.rendimientoEur

        if (metrics.tipos[summary.assetType]) {
            metrics.tipos[summary.assetType].netoActual += euroMetrics.netoActualEur
            metrics.tipos[summary.assetType].invertido += euroMetrics.invertidoBrutoEur
            metrics.tipos[summary.assetType].rendimiento += euroMetrics.rendimientoEur
        }
    })

    metrics.numActivos = baseAssets.length
    window._lastPortfolioMetrics = { totalCuenta: metrics.totalCuenta, invertido: metrics.invertido }
    window._assetsSnapshotData = metricSummaries
        .filter((r) => r.euroMetrics.netoActualEur > 0)
        .map((r) => ({
            id: r.assetId,
            netoEur: r.euroMetrics.netoActualEur,
            costEur: r.euroMetrics.invertidoBrutoEur || 0
        }))
    applyTopPortfolioMetrics(metrics)
}

let _ovShowHidden = false

async function initVistaGeneralLogic() {
    const filtersContainer = document.getElementById("overviewFilters")
    const refreshOverviewMarketButton = document.getElementById("refreshOverviewMarketBtn")
    const showHiddenBtn = document.getElementById("overviewShowHiddenBtn")
    const exportOverviewBtn = document.getElementById("downloadOverviewCsvBtn")

    if (showHiddenBtn && !showHiddenBtn.dataset.bound) {
        showHiddenBtn.dataset.bound = "true"
        showHiddenBtn.classList.toggle("active", _ovShowHidden)
        showHiddenBtn.addEventListener("click", () => {
            _ovShowHidden = !_ovShowHidden
            showHiddenBtn.classList.toggle("active", _ovShowHidden)
            renderVistaGeneralTable()
        })
    }

    if (filtersContainer && !filtersContainer.dataset.bound) {
        filtersContainer.dataset.bound = "true"
        filtersContainer.addEventListener("change", (e) => {
            const changed = e.target
            const todosInput = filtersContainer.querySelector('input[value="todos"]')
            const individualInputs = [
                ...filtersContainer.querySelectorAll('input[type="checkbox"]:not([value="todos"])')
            ]

            if (changed.value === "todos") {
                // Todos siempre activa todo (no se puede desmarcar directamente)
                changed.checked = true
                individualInputs.forEach((cb) => {
                    cb.checked = true
                })
            } else if (todosInput?.checked) {
                // Había Todos activo → selección exclusiva del pulsado
                todosInput.checked = false
                individualInputs.forEach((cb) => {
                    cb.checked = cb === changed
                })
                changed.checked = true
            } else {
                // Toggle individual normal; si todos marcados → activar Todos
                if (todosInput) {
                    todosInput.checked = individualInputs.every((cb) => cb.checked)
                }
            }
            renderVistaGeneralTable()
        })
    }

    if (refreshOverviewMarketButton && !refreshOverviewMarketButton.dataset.bound) {
        refreshOverviewMarketButton.dataset.bound = "true"
        refreshOverviewMarketButton.addEventListener("click", async () => {
            await refreshOverviewMarketData(refreshOverviewMarketButton)
        })
    }

    if (exportOverviewBtn && !exportOverviewBtn.dataset.bound) {
        exportOverviewBtn.dataset.bound = "true"
        exportOverviewBtn.addEventListener("click", downloadVistaGeneralCsv)
    }

    await renderVistaGeneralTable()
}

/**
 * Pide cotizaciones nuevas al servidor, activo por activo.
 *
 * `respetarPausa` solo lo activa el refresco automático: es el que tiene que
 * ahorrar cuota mientras los mercados están cerrados. Pulsar «Actualizar
 * cotizaciones» pide precios igualmente —quien pulsa quiere el dato ahora, no
 * una explicación de por qué no—, que es como se comportaba antes de que la
 * pausa existiera.
 */
async function refreshOverviewMarketData(buttonElement = null, { respetarPausa = false } = {}) {
    const originalLabel = buttonElement?.textContent || ""

    if (buttonElement) {
        buttonElement.disabled = true
        buttonElement.textContent = "Actualizando..."
    }

    try {
        const assets = await loadAssetsList()
        const assetsWithTicker = assets.filter((asset) =>
            String(asset.marketSymbol || asset.finnhubSymbol || "").trim()
        )
        const pendientes = respetarPausa
            ? assetsWithTicker.filter((asset) => !tipoEnPausa(asset.type))
            : assetsWithTicker

        for (const asset of pendientes) {
            try {
                await refreshAssetMarketDataOnServer(asset.id)
                _falloApiPorActivo.delete(asset.id)
            } catch (error) {
                // Se guarda para que el sidebar pueda marcarlo con ⚠ y decir de
                // qué se queja el proveedor. Antes solo iba a la consola, donde
                // no lo veía nadie sin abrir las herramientas del navegador.
                _falloApiPorActivo.set(asset.id, _mensajeDeFalloApi(error))
                console.error(`No se pudo actualizar ${asset.name || asset.symbol || asset.id}:`, error)
            }
        }

        await refreshAssetsSidebar(currentAssetId, false)
        await renderVistaGeneralTable()
        if (typeof segRefreshCustomPrices === "function") {
            try {
                await segRefreshCustomPrices()
            } catch {}
        }
        if (typeof refreshOperationsTickerPrices === "function") {
            try {
                await refreshOperationsTickerPrices()
            } catch {}
        }
    } finally {
        if (buttonElement) {
            buttonElement.disabled = false
            buttonElement.textContent = originalLabel
        }
    }
}

function initSidebarFilterBar() {
    const bar = document.getElementById("sidebarFilterBar")
    if (!bar || bar.dataset.bound) return
    bar.dataset.bound = "true"
    bar.addEventListener("click", async (e) => {
        const btn = e.target.closest(".sidebarFilterBtn")
        if (!btn) return
        _sidebarFilter = btn.dataset.filter
        bar.querySelectorAll(".sidebarFilterBtn").forEach((b) => b.classList.toggle("active", b === btn))
        const assets = await loadAssetsList()
        await renderAssetsList(assets)
    })
    bar.style.display = window._viewAllPortfolios ? "none" : ""
}

function getSelectedOverviewTypes() {
    const todosInput = document.querySelector('#overviewFilters input[value="todos"]')
    if (todosInput?.checked) return ["cripto", "acciones", "etfs", "comoditis"]
    return [...document.querySelectorAll('#overviewFilters input[type="checkbox"]:checked')]
        .map((input) => input.value)
        .filter((v) => v !== "todos")
}

function parseParticipationNumber(value) {
    const cleanValue = String(value || "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function getCryptoRowCommissionCrypto(row = {}) {
    return row.comisionesCripto ?? row.comisionesSatoshis ?? row.comisiones ?? ""
}

function getCryptoRowCommissionFiat(row = {}) {
    return row.comisionesFiat ?? ""
}

// Comisión en € de una operación spot (Cripto › Operaciones). Siempre va en
// euros, sea cual sea el par: así la etiqueta el formulario.
function getOperationRowFiatCommission(row = {}) {
    return Math.max(0, parseLooseNumber(row.comisionesFiat || "") || 0)
}

function deriveAssetBaseSymbolFromData(assetOrDataset = {}) {
    const marketSymbol = String(
        assetOrDataset.marketSymbol ||
            assetOrDataset.finnhubSymbol ||
            assetOrDataset.assetMarketSymbol ||
            assetOrDataset.assetFinnhubSymbol ||
            ""
    )
        .trim()
        .toUpperCase()
    const fallbackSymbol = String(
        assetOrDataset.symbol || assetOrDataset.assetSymbol || assetOrDataset.name || assetOrDataset.assetName || ""
    )
        .trim()
        .toUpperCase()

    if (marketSymbol.includes(":")) {
        const symbolPart = marketSymbol.split(":").pop() || ""
        const basePart = symbolPart.split("/")[0].split("-")[0].split("_")[0] || ""
        const stablecoinSuffixes = [
            "USDT",
            "USDC",
            "BUSD",
            "DAI",
            "FDUSD",
            "PYUSD",
            "TUSD",
            "USDE",
            "EURC",
            "USD",
            "EUR"
        ]

        for (const suffix of stablecoinSuffixes) {
            if (basePart.endsWith(suffix)) {
                return basePart.slice(0, -suffix.length) || fallbackSymbol
            }
        }

        return basePart || fallbackSymbol
    }

    if (marketSymbol.includes("/")) {
        return marketSymbol.split("/")[0] || fallbackSymbol
    }

    return fallbackSymbol
}

function getConvertedInOperationLabel(baseSymbol) {
    return `Convertidos a ${baseSymbol}`
}

function getConvertedOutOperationLabel(baseSymbol) {
    return `${baseSymbol} convertidos`
}

function isConvertedOutOperationType(operationType = "") {
    const normalized = String(operationType || "")
        .trim()
        .toLowerCase()
    return normalized.includes(" convertidos") || normalized === "convertidos"
}

function isConvertedInOperationType(operationType = "") {
    const normalized = String(operationType || "")
        .trim()
        .toLowerCase()
    return normalized.includes("convertidos a")
}

function createConversionRowId() {
    return `conversion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function normalizeAssetConversionTypeLabel(value, assetData = {}) {
    const baseSymbol = deriveAssetBaseSymbolFromData(assetData)
    const convertedInLabel = getConvertedInOperationLabel(baseSymbol)
    const convertedOutLabel = getConvertedOutOperationLabel(baseSymbol)
    const normalizedValue = String(value || "")
        .trim()
        .toLowerCase()

    if (normalizedValue === convertedOutLabel.toLowerCase() || isConvertedOutOperationType(normalizedValue)) {
        return convertedOutLabel
    }

    return convertedInLabel
}

function getPrimaryAssetRows(asset = {}) {
    return Array.isArray(asset.rows)
        ? asset.rows.filter((row) => {
              const operationType = String(row?.tipoOperacion || "").trim()
              return !isConvertedInOperationType(operationType) && !isConvertedOutOperationType(operationType)
          })
        : []
}

function getAssetConversionRows(asset = {}) {
    const explicitRows = Array.isArray(asset.conversionRows) ? asset.conversionRows : []
    const legacyRows = Array.isArray(asset.rows)
        ? asset.rows
              .filter((row) => {
                  const operationType = String(row?.tipoOperacion || "").trim()
                  return isConvertedInOperationType(operationType) || isConvertedOutOperationType(operationType)
              })
              .map((row, index) => ({
                  id: createConversionRowId(),
                  fecha: String(row.fechaOperacion || "").trim(),
                  par: String(row.par || "").trim(),
                  tipo: normalizeAssetConversionTypeLabel(row.tipoOperacion || "", asset),
                  cantidad: String(row.participaciones || "").trim(),
                  legacyOrder: index
              }))
        : []

    const mergedRows = [...explicitRows, ...legacyRows]
    const uniqueRows = []
    const seenKeys = new Set()

    mergedRows.forEach((row, index) => {
        const normalizedRow = {
            id: String(row.id || createConversionRowId()).trim() || createConversionRowId(),
            fecha: String(row.fecha || row.fechaOperacion || "").trim(),
            par: String(row.par || "").trim(),
            tipo: normalizeAssetConversionTypeLabel(row.tipo || row.tipoOperacion || "", asset),
            cantidad: String(row.cantidad || row.participaciones || "").trim(),
            sortIndex: index
        }
        const dedupeKey = [normalizedRow.fecha, normalizedRow.par, normalizedRow.tipo, normalizedRow.cantidad].join("|")

        if (seenKeys.has(dedupeKey)) {
            return
        }

        seenKeys.add(dedupeKey)
        uniqueRows.push(normalizedRow)
    })

    uniqueRows.sort((left, right) => {
        const leftDate = parseAssetOperationDate(left.fecha)
        const rightDate = parseAssetOperationDate(right.fecha)

        if (leftDate === rightDate) {
            return (left.sortIndex || 0) - (right.sortIndex || 0)
        }

        return leftDate - rightDate
    })

    return uniqueRows.map(({ sortIndex, ...row }) => row)
}

function parseAssetOperationDate(value) {
    const text = String(value || "").trim()

    if (!text) {
        return Number.POSITIVE_INFINITY
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return new Date(`${text}T00:00:00`).getTime()
    }

    const match = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/)

    if (!match) {
        return Number.POSITIVE_INFINITY
    }

    const [, day, month, year] = match
    return new Date(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00`).getTime()
}

function getRowGrossAmount(row) {
    const capitalInvertidoBruto = parseLooseNumber(row.capitalInvertidoBruto || "")
    return capitalInvertidoBruto || 0
}

function getRowTotalCostForLot(row) {
    const capitalInvertidoBruto = parseLooseNumber(row.capitalInvertidoBruto || "")
    if (capitalInvertidoBruto !== null && capitalInvertidoBruto > 0) {
        return capitalInvertidoBruto
    }
    const participaciones = parseParticipationNumber(row.participaciones)
    if (participaciones > 0) {
        const precioParticipacion = parseLooseNumber(row.precioParticipacion || "")
        if (precioParticipacion !== null && precioParticipacion > 0) {
            return precioParticipacion * participaciones
        }
    }
    return 0
}

async function convertCryptoRowMoneyToAssetCurrency(amount, row, assetCurrency) {
    const numericAmount = Number(amount) || 0
    const sourceCurrency = normalizeAssetRowCurrency(row?.currency, assetCurrency)
    return await convertAmountForDisplay(numericAmount, sourceCurrency, assetCurrency)
}

async function buildRemainingAssetLots(asset, targetCurrency = asset?.currency || "EUR") {
    const rows = [...getPrimaryAssetRows(asset)]
    const conversionRows = getAssetConversionRows(asset)
    const completedOperationsImpact = getCompletedOperationsCryptoImpact(asset)
    const transaccionesImpact = getTransaccionesCryptoImpact(asset)
    const ventasRows = getAssetVentasRows(asset)

    const lots = []
    const timelineEvents = []

    for (const row of rows) {
        timelineEvents.push({
            kind: "assetRow",
            date: parseAssetOperationDate(row.fechaOperacion || ""),
            row
        })
    }

    for (const operationRow of completedOperationsImpact.rows) {
        timelineEvents.push({
            kind: "operacion",
            date: parseAssetOperationDate(
                operationRow.fechaApertura || operationRow.fecha || operationRow.fechaCierre || ""
            ),
            row: operationRow
        })
    }

    for (const ventaRow of ventasRows) {
        timelineEvents.push({
            kind: "ventaExterna",
            date: parseAssetOperationDate(ventaRow.fecha || ""),
            row: ventaRow
        })
    }

    for (const transaccionRow of transaccionesImpact.rows) {
        timelineEvents.push({
            kind: "transaccion",
            date: parseAssetOperationDate(transaccionRow.fechaOperacion || ""),
            row: transaccionRow
        })
    }

    for (const conversionRow of conversionRows) {
        timelineEvents.push({
            kind: "conversion",
            date: parseAssetOperationDate(conversionRow.fecha || ""),
            row: conversionRow
        })
    }

    timelineEvents.sort((left, right) => left.date - right.date)

    for (const event of timelineEvents) {
        if (event.kind === "assetRow") {
            const row = event.row
            const operationType = String(row.tipoOperacion || "")
                .trim()
                .toLowerCase()
            const participaciones = parseParticipationNumber(row.participaciones)
            const cryptoCommission = isCryptoAssetType(asset.type)
                ? Math.max(0, parseLooseNumber(getCryptoRowCommissionCrypto(row)) || 0)
                : 0

            if (participaciones <= 0) {
                continue
            }

            if (operationType.includes("venta")) {
                consumeAssetLots(lots, participaciones + cryptoCommission)
                continue
            }

            const netParticipaciones = Math.max(0, participaciones - cryptoCommission)

            if (netParticipaciones <= 0) {
                continue
            }

            let totalCost = getRowTotalCostForLot(row)

            if (isCryptoAssetType(asset.type)) {
                totalCost = await convertCryptoRowMoneyToAssetCurrency(totalCost, row, targetCurrency)
            }

            lots.push({
                remaining: netParticipaciones,
                priceQuantity: netParticipaciones,
                unitCost: netParticipaciones > 0 ? totalCost / netParticipaciones : 0,
                displayUnitPrice: netParticipaciones > 0 ? totalCost / netParticipaciones : 0,
                totalCost
            })
            continue
        }

        if (event.kind === "operacion") {
            const operationRow = event.row
            const operationType = String(operationRow.orden || "")
                .trim()
                .toLowerCase()
            const quantity = parseLooseNumber(operationRow.cantidad || "") || 0
            const cryptoCommission = Math.max(
                0,
                parseLooseNumber(operationRow.comisionesCripto || operationRow.comisiones || "") || 0
            )

            if (quantity <= 0) {
                continue
            }

            if (operationType === "venta") {
                consumeAssetLots(lots, quantity + cryptoCommission)
                continue
            }

            const netParticipaciones = Math.max(0, quantity - cryptoCommission)

            if (netParticipaciones <= 0) {
                continue
            }

            const executionPrice = await convertAmountForDisplay(
                parseLooseNumber(operationRow.precioOrden || "") || 0,
                normalizeCurrencyCode(operationRow.precioCurrency || operationRow.currency || targetCurrency),
                targetCurrency
            )
            // El "Total" de Operaciones se teclea a mano y unas veces lleva la
            // comisión en € dentro y otras no, así que no sirve de base: el lote
            // vale precio de orden × cantidad más la comisión en €, igual que una
            // compra spot. La comisión se descuenta después para el neto, y el
            // precio medio queda en el precio de ejecución. Sin precio se
            // recurre al Total.
            const fiatCommission = await convertAmountForDisplay(
                getOperationRowFiatCommission(operationRow),
                "EUR",
                targetCurrency
            )
            const operationTotal =
                executionPrice > 0
                    ? 0
                    : await convertAmountForDisplay(
                          parseLooseNumber(operationRow.total || "") || 0,
                          normalizeCurrencyCode(operationRow.currency || operationRow.precioCurrency || targetCurrency),
                          targetCurrency
                      )
            const totalCost = (executionPrice > 0 ? executionPrice * quantity : operationTotal) + fiatCommission

            lots.push({
                remaining: netParticipaciones,
                priceQuantity: quantity,
                unitCost: netParticipaciones > 0 ? totalCost / netParticipaciones : 0,
                displayUnitPrice: executionPrice,
                totalCost
            })
            continue
        }

        if (event.kind === "ventaExterna") {
            const quantity = parseLooseNumber(event.row.cantidad || "") || 0

            if (quantity > 0) {
                consumeAssetLots(lots, quantity)
            }
            continue
        }

        if (event.kind === "transaccion") {
            const transaccionRow = event.row
            const walletType = String(transaccionRow.walletTipo || "")
                .trim()
                .toLowerCase()
            const quantity = parseLooseNumber(transaccionRow.total || "") || 0
            const networkFee = Math.max(0, parseLooseNumber(transaccionRow.comisionRed || "") || 0)

            if (quantity <= 0) {
                continue
            }

            if (walletType === "entre_wallet") {
                if (networkFee > 0) consumeAssetLots(lots, networkFee)
                continue
            }

            if (walletType === "enviada") {
                consumeAssetLots(lots, quantity + networkFee)
                continue
            }

            if (walletType === "recibida") {
                lots.push({
                    remaining: quantity,
                    priceQuantity: quantity,
                    unitCost: 0,
                    displayUnitPrice: 0,
                    totalCost: 0
                })
            }
            continue
        }

        if (event.kind === "conversion") {
            const conversionRow = event.row
            const quantity = parseLooseNumber(conversionRow.cantidad || "") || 0
            const conversionType = String(conversionRow.tipo || "").trim()

            if (quantity <= 0) {
                continue
            }

            if (isConvertedOutOperationType(conversionType)) {
                consumeAssetLots(lots, quantity)
                continue
            }

            lots.push({
                remaining: quantity,
                priceQuantity: quantity,
                unitCost: 0,
                displayUnitPrice: 0,
                totalCost: 0
            })
        }
    }

    return lots
}

function consumeAssetLots(lots, quantityToSell) {
    let remainingToSell = quantityToSell

    for (const lot of lots) {
        if (remainingToSell <= 0) {
            break
        }

        const quantityFromLot = Math.min(lot.remaining, remainingToSell)

        if (quantityFromLot <= 0) {
            continue
        }

        lot.remaining -= quantityFromLot
        if (typeof lot.priceQuantity === "number") {
            lot.priceQuantity = Math.max(0, lot.priceQuantity - quantityFromLot)
        }
        remainingToSell -= quantityFromLot
    }
}

async function buildOverviewRow(asset) {
    const rows = Array.isArray(asset.rows) ? asset.rows : []
    const isCrypto = isCryptoAssetType(asset.type)
    // El activo tiene una sola moneda: precio, invertido y rendimiento van en
    // ella. Las compras anotadas en otra moneda se convierten al agregarlas.
    const assetCurrency = normalizeCurrencyCode(asset.currency || "EUR")
    const remainingLots = await buildRemainingAssetLots(asset, assetCurrency)
    const rawParticipaciones = remainingLots.reduce((total, lot) => total + lot.remaining, 0)
    const completedOperationsImpact = getCompletedOperationsCryptoImpact(asset)
    const transaccionesImpact = getTransaccionesCryptoImpact(asset)
    const participacionesSinTransacciones = Math.max(0, rawParticipaciones)
    const participaciones = participacionesSinTransacciones
    const invertidoBruto = remainingLots.reduce((total, lot) => total + lot.remaining * lot.unitCost, 0)
    const comisionesCripto = isCrypto
        ? rows.reduce((total, row) => total + (parseLooseNumber(getCryptoRowCommissionCrypto(row)) || 0), 0) +
          completedOperationsImpact.commissionTotal +
          transaccionesImpact.commissionTotal
        : 0
    // Las comisiones € de las operaciones spot completadas cuentan como las de
    // cualquier compra: su lote las lleva sumadas al Total en el coste bruto y
    // aquí se descuentan para el neto y el precio medio.
    const comisionesFiatOperaciones = isCrypto
        ? (
              await Promise.all(
                  completedOperationsImpact.rows
                      .filter(
                          (row) =>
                              String(row.orden || "")
                                  .trim()
                                  .toLowerCase() === "compra"
                      )
                      .map((row) => convertAmountForDisplay(getOperationRowFiatCommission(row), "EUR", assetCurrency))
              )
          ).reduce((total, value) => total + value, 0)
        : 0
    const comisionesFiat = isCrypto
        ? (
              await Promise.all(
                  rows.map(async (row) => {
                      const feeAmount = parseLooseNumber(getCryptoRowCommissionFiat(row)) || 0
                      return await convertCryptoRowMoneyToAssetCurrency(feeAmount, row, assetCurrency)
                  })
              )
          ).reduce((total, value) => total + value, 0) + comisionesFiatOperaciones
        : rows.reduce((total, row) => total + (parseLooseNumber(row.comisiones || "") || 0), 0)
    const invertidoNeto = invertidoBruto - comisionesFiat
    const valorActual = parseLooseNumber(asset.price || "") || 0
    const netoActual = participaciones * valorActual
    const promedioCompra = participaciones > 0 ? invertidoNeto / participaciones : 0
    const rendimiento = netoActual - invertidoNeto

    return {
        nombre: asset.name || asset.symbol || "Activo",
        tipo: buildAssetTypeLabel(asset.type),
        assetType: asset.type,
        participacionesSinTransacciones,
        participaciones,
        promedioCompra,
        valorActual,
        currency: assetCurrency,
        invertidoBruto,
        comisiones: comisionesFiat,
        comisionesFiat,
        comisionesCripto,
        invertidoNeto,
        netoActual,
        rendimiento
    }
}

let _ovSortKey = "sidebarOrder"
let _ovSortDir = "asc"
let _ovRows = []

function downloadVistaGeneralCsv() {
    if (!Array.isArray(_ovRows) || !_ovRows.length) {
        alert("No hay activos para exportar.")
        return
    }

    const rows = _ovRows.map((row) => ({
        Nombre: row.nombre || "",
        Tipo: row.tipo || "",
        Posición: row.participaciones ?? "",
        "P. medio": row.promedioCompra ?? "",
        "Valor actual": row.overviewCurrentPrice ?? row.valorActual ?? "",
        "Inv. bruto": row.invertidoBruto ?? "",
        "Comis.": row.comisionesFiat ?? row.comisiones ?? "",
        "Inv. neto": row.invertidoNeto ?? "",
        "Neto actual": row.overviewCurrentValue ?? "",
        "Rend. €": row.overviewYieldValue ?? row.rendimiento ?? "",
        "Rend. %":
            row.invertidoBruto > 0 ? ((row.overviewYieldValue ?? row.rendimiento ?? 0) / row.invertidoBruto) * 100 : ""
    }))

    const filename = `vista-general-${new Date().toISOString().slice(0, 10)}.csv`
    const exported = downloadCsvFile(filename, rows)
    if (!exported) {
        alert("No hay activos para exportar.")
    }
}

function _ovSortRows(rows) {
    return [...rows].sort((a, b) => {
        let va = a[_ovSortKey] ?? 0
        let vb = b[_ovSortKey] ?? 0
        if (typeof va === "string") va = va.toLowerCase()
        if (typeof vb === "string") vb = vb.toLowerCase()
        if (va < vb) return _ovSortDir === "asc" ? -1 : 1
        if (va > vb) return _ovSortDir === "asc" ? 1 : -1
        return 0
    })
}

function _ovUpdateSortArrows() {
    document.querySelectorAll("#overviewTable .mThSort").forEach((th) => {
        const arrow = th.querySelector(".mSortArrow")
        if (!arrow) return
        if (th.dataset.sortkey === _ovSortKey) {
            arrow.textContent = _ovSortDir === "asc" ? " ▲" : " ▼"
            th.classList.add("mThActive")
        } else {
            arrow.textContent = ""
            th.classList.remove("mThActive")
        }
    })
}

function _ovBindSort() {
    document.querySelectorAll("#overviewTable .mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (_ovSortKey === key) {
                _ovSortDir = _ovSortDir === "asc" ? "desc" : "asc"
            } else {
                _ovSortKey = key
                _ovSortDir = key === "sidebarOrder" || key === "nombre" ? "asc" : "desc"
            }
            renderOverviewRows(_ovRows)
        })
    })
}

function renderOverviewRows(rows) {
    _ovRows = rows
    const tableBody = document.getElementById("overviewTableBody")
    const emptyState = document.getElementById("overviewEmptyState")

    if (!tableBody) {
        return
    }

    tableBody.innerHTML = ""

    if (!rows.length) {
        if (emptyState) {
            emptyState.classList.remove("hidden")
        }
        return
    }

    if (emptyState) {
        emptyState.classList.add("hidden")
    }

    const OV_TYPE_COLORS = { cripto: "#f7931a", acciones: "#3a7bd5", etfs: "#2ecc71", comoditis: "#e0c068" }
    const sorted = _ovSortRows(rows)

    sorted.forEach((row, idx) => {
        const tr = document.createElement("tr")
        if (row._isOculto) tr.classList.add("overviewTrHidden")
        const yieldVal = row.overviewYieldValue ?? 0
        const rClass = yieldVal >= 0 ? "mCellPos" : "mCellNeg"
        const sign = yieldVal >= 0 ? "+" : ""
        const overviewCommissions = formatMoney(row.comisionesFiat ?? row.comisiones, row.currency)
        const typeColor = OV_TYPE_COLORS[row.assetType] || "#888"
        const typeBadge = `<span class="mTypeBadge" style="background:${typeColor}22;color:${typeColor};border-color:${typeColor}44">${row.tipo}</span>`
        const yieldEur = formatMoney(yieldVal, row.currency)
        const yieldPct = row.invertidoBruto > 0 ? sign + ((yieldVal / row.invertidoBruto) * 100).toFixed(2) + " %" : "—"

        tr.innerHTML = `
            <td class="mTdRank">${idx + 1}</td>
            <td class="mTdName">${escapeHtml(row.nombre)}</td>
            <td>${typeBadge}</td>
            <td>${formatAssetParticipationValue(row.participaciones, row.assetType)}</td>
            <td>${formatMoney(row.promedioCompra, row.currency)}</td>
            <td><strong>${formatMoney(row.overviewCurrentPrice ?? row.valorActual, row.currency)}</strong></td>
            <td>${formatMoney(row.invertidoBruto, row.currency)}</td>
            <td>${overviewCommissions}</td>
            <td>${formatMoney(row.invertidoNeto, row.currency)}</td>
            <td>${formatMoney(row.overviewCurrentValue, row.currency)}</td>
            <td class="${rClass}">${sign}${yieldEur}</td>
            <td class="${rClass}">${yieldPct}</td>
        `

        if (row.id) {
            tr.style.cursor = "pointer"
            tr.addEventListener("click", async () => {
                clearNavSelection()
                await selectAsset(row.id)
            })
        }

        tableBody.appendChild(tr)
    })

    _ovUpdateSortArrows()
}

async function renderVistaGeneralTable() {
    const tableBody = document.getElementById("overviewTableBody")

    if (!tableBody) {
        return
    }

    _ovSortKey = "sidebarOrder"
    _ovSortDir = "asc"

    try {
        const assets = await loadAssetsList()
        const selectedTypes = new Set(getSelectedOverviewTypes())

        if (!selectedTypes.size) {
            renderOverviewRows([])
            return
        }

        const loadResults = await Promise.allSettled(assets.map((asset) => loadAssetData(asset.id)))
        loadResults
            .filter((r) => r.status === "rejected")
            .forEach((r) => console.error("Error cargando datos de activo:", r.reason))
        const fullAssets = loadResults.filter((r) => r.status === "fulfilled").map((r) => r.value)

        const results = await Promise.allSettled(
            fullAssets.filter((asset) => selectedTypes.has(asset.type)).map((asset) => buildOverviewDisplayRow(asset))
        )
        results
            .filter((r) => r.status === "rejected")
            .forEach((r) => console.error("Error procesando activo en vista general:", r.reason))
        const allRows = results.filter((r) => r.status === "fulfilled").map((r) => r.value)

        const rows = allRows
            .map((r) => ({
                ...r,
                _isOculto: r.hidden || (r.participaciones === 0 && r.invertidoBruto === 0)
            }))
            .filter((r) => _ovShowHidden || !r._isOculto)

        renderOverviewRows(rows)
        _ovBindSort()
    } catch (error) {
        console.error("Error cargando vista general:", error)
        renderOverviewRows([])
    }
}

function _assetSortRows(rows) {
    if (!_assetSortKey) return rows.map((r, i) => ({ ...r, _origIdx: i }))
    return rows
        .map((r, i) => ({ ...r, _origIdx: i }))
        .sort((a, b) => {
            let va = a[_assetSortKey] ?? ""
            let vb = b[_assetSortKey] ?? ""
            const na = parseFloat(String(va).replace(/\./g, "").replace(",", "."))
            const nb = parseFloat(String(vb).replace(/\./g, "").replace(",", "."))
            if (!isNaN(na) && !isNaN(nb)) {
                va = na
                vb = nb
            } else {
                va = String(va).toLowerCase()
                vb = String(vb).toLowerCase()
            }
            if (va < vb) return _assetSortDir === "asc" ? -1 : 1
            if (va > vb) return _assetSortDir === "asc" ? 1 : -1
            return 0
        })
}

function _assetUpdateSortArrows() {
    document.querySelectorAll(".assetOperationsTable .mThSort").forEach((th) => {
        const arrow = th.querySelector(".mSortArrow")
        if (!arrow) return
        if (th.dataset.sortkey === _assetSortKey) {
            arrow.textContent = _assetSortDir === "asc" ? " ▲" : " ▼"
            th.classList.add("mThActive")
        } else {
            arrow.textContent = ""
            th.classList.remove("mThActive")
        }
    })
}

function _assetBindSort(assetId) {
    document.querySelectorAll(".assetOperationsTable .mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (_assetSortKey === key) {
                _assetSortDir = _assetSortDir === "asc" ? "desc" : "asc"
            } else {
                _assetSortKey = key
                _assetSortDir = "asc"
            }
            try {
                localStorage.setItem(`tableSort_${assetId}`, JSON.stringify({ key: _assetSortKey, dir: _assetSortDir }))
            } catch {}
            renderAssetRows(_assetDisplayRows)
        })
    })
}
