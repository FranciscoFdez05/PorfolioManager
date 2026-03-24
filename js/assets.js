const exchangeRateCache = new Map()
let externalVentasRowsCache = []
let externalTransaccionesRowsCache = []

async function fetchExchangeRateOnServer(sourceCurrency, targetCurrency) {
    const source = normalizeCurrencyCode(sourceCurrency)
    const target = normalizeCurrencyCode(targetCurrency)

    if (source === target) {
        return 1
    }

    const cacheKey = `${source}->${target}`

    if (!exchangeRateCache.has(cacheKey)) {
        const requestPromise = (async () => {
            const response = await fetch(`/api/exchange-rate?source=${encodeURIComponent(source)}&target=${encodeURIComponent(target)}`)

            if (!response.ok) {
                const errorText = await response.text()
                throw new Error(`HTTP ${response.status}: ${errorText}`)
            }

            const data = await response.json()
            const rate = Number(data.rate)

            if (!Number.isFinite(rate) || rate <= 0) {
                throw new Error("Tipo de cambio inválido")
            }

            return rate
        })()

        exchangeRateCache.set(cacheKey, requestPromise)
    }

    try {
        return await exchangeRateCache.get(cacheKey)
    } catch (error) {
        exchangeRateCache.delete(cacheKey)
        throw error
    }
}

async function convertAmountForDisplay(amount, sourceCurrency, targetCurrency) {
    const numericAmount = Number(amount) || 0
    const source = normalizeCurrencyCode(sourceCurrency)
    const target = normalizeCurrencyCode(targetCurrency)

    if (source === target) {
        return numericAmount
    }

    const rate = await fetchExchangeRateOnServer(source, target)
    return numericAmount * rate
}

async function getAssetDisplayPriceValue(asset) {
    const rawPrice = parseLooseNumber(asset?.price || "0") || 0
    const sourceCurrency = asset?.currency || "EUR"
    const targetCurrency = asset?.precioCurrency || asset?.currency || "EUR"

    return await convertAmountForDisplay(rawPrice, sourceCurrency, targetCurrency)
}

async function buildOverviewDisplayRow(asset) {
    const row = buildOverviewRow(asset)
    const investedCurrency = row.currency
    const netoActualDisplay = row.netoActual
    const currentPriceDisplay = isCryptoAssetType(row.assetType)
        ? await convertAmountForDisplay(row.valorActual, row.currency, row.precioCurrency || row.currency)
        : row.valorActual
    const rendimientoDisplay = netoActualDisplay - row.invertidoNeto

    return {
        ...row,
        overviewInvestedCurrency: investedCurrency,
        overviewCurrentPrice: currentPriceDisplay,
        overviewCurrentValue: netoActualDisplay,
        overviewYieldValue: rendimientoDisplay
    }
}

async function buildSummaryMetricsInEuros(summary) {
    const invertidoNetoEur = await convertAmountForDisplay(
        summary.invertidoNeto,
        summary.currency,
        "EUR"
    )
    const netoActualEur = await convertAmountForDisplay(summary.netoActual, summary.currency, "EUR")
    const rendimientoEur = netoActualEur - invertidoNetoEur

    return {
        netoActualEur,
        invertidoNetoEur,
        rendimientoEur
    }
}

async function loadAssetsList() {
    const response = await fetch("/api/activos")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de activos")
    }

    const data = await response.json()
    return Array.isArray(data.assets) ? data.assets : []
}

async function loadAssetData(assetId) {
    const response = await fetch(`/api/activos/${assetId}`)

    if (!response.ok) {
        throw new Error("No se pudo cargar el activo")
    }

    return await response.json()
}

async function saveAssetDataToServer(assetData) {
    const response = await fetch(`/api/activos/${assetData.id}`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(assetData)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function deleteAssetOnServer(assetId) {
    const response = await fetch(`/api/activos/${assetId}`, {
        method: "DELETE"
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function createAssetOnServer(name, type, marketSymbol = "", marketProvider = "finnhub") {
    const response = await fetch("/api/activos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ name, type, marketSymbol, marketProvider, finnhubSymbol: marketSymbol })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function loadVentasRowsForAssets() {
    const response = await fetch("/api/ventas")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de ventas")
    }

    const data = await response.json()
    externalVentasRowsCache = Array.isArray(data?.rows) ? data.rows : []
    return externalVentasRowsCache
}

async function loadTransaccionesRowsForAssets() {
    const response = await fetch("/api/transacciones")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de transacciones")
    }

    const data = await response.json()
    externalTransaccionesRowsCache = Array.isArray(data?.rows) ? data.rows : []
    return externalTransaccionesRowsCache
}

async function refreshAssetMarketDataOnServer(assetId) {
    const response = await fetch(`/api/activos/${assetId}/refresh-market-data`, {
        method: "POST"
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function changeAssetCurrencyOnServer(assetId, currency, scope = "asset") {
    const response = await fetch(`/api/activos/${assetId}/currency`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ currency, scope })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function searchFinnhubSymbolOnServer(query, { assetName = "", assetType = "" } = {}) {
    const params = new URLSearchParams({
        q: query
    })

    if (assetName) {
        params.set("assetName", assetName)
    }

    if (assetType) {
        params.set("assetType", assetType)
    }

    const response = await fetch(`/api/market/search?${params.toString()}`)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function searchEodhdSymbolOnServer(query, { assetName = "", assetType = "" } = {}) {
    const params = new URLSearchParams({
        q: query
    })

    if (assetName) {
        params.set("assetName", assetName)
    }

    if (assetType) {
        params.set("assetType", assetType)
    }

    const response = await fetch(`/api/eodhd/search?${params.toString()}`)

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

function extractApiErrorMessage(error) {
    const rawMessage = String(error?.message || "Error desconocido")
    const jsonStart = rawMessage.indexOf("{")

    if (jsonStart === -1) {
        return rawMessage
    }

    try {
        const payload = JSON.parse(rawMessage.slice(jsonStart))
        return payload.error || rawMessage
    } catch {
        return rawMessage
    }
}

function formatAssetLastUpdated(value) {
    const normalizedValue = String(value || "").trim()

    if (!normalizedValue) {
        return "Sin datos de mercado"
    }

    const date = new Date(normalizedValue)

    if (Number.isNaN(date.getTime())) {
        return "Sin datos de mercado"
    }

    return `Actualizado: ${date.toLocaleString("es-ES", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit"
    })}`
}

async function saveAssetOrderOnServer(orderedAssetIds) {
    const response = await fetch("/api/activos/reorder", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ orderedAssetIds })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function updateAssetDetail(asset) {
    const detSymbol = document.getElementById("detSymbol")
    const detName = document.getElementById("detName")
    const detPrice = document.getElementById("detPrice")
    const detChange = document.getElementById("detChange")
    const detType = document.getElementById("detType")
    const detPosition = document.getElementById("detPosition")
    const detInvested = document.getElementById("detInvested")
    const detPnL = document.getElementById("detPnL")
    const detAvgPrice = document.getElementById("detAvgPrice")
    const detFees = document.getElementById("detFees")
    const detStatus = document.getElementById("detStatus")
    const detFinnhub = document.getElementById("detFinnhub")
    const summary = buildOverviewRow(asset)
    const investedCurrency = summary.currency

    if (detSymbol) {
        detSymbol.textContent = asset.symbol || "---"
    }

    if (detName) {
        detName.textContent = asset.name || "Activo"
    }

    if (detPrice) {
        const displayPrice = await getAssetDisplayPriceValue(asset)
        detPrice.textContent = formatMoney(displayPrice, asset.precioCurrency || asset.currency || "EUR")
    }

    if (detChange) {
        const yieldPercent = calculateYieldPercent(summary.invertidoNeto, summary.rendimiento)
        detChange.textContent = `Rendimiento: ${formatPercent(yieldPercent)}`
        detChange.classList.toggle("negative", yieldPercent < 0)
    }

    if (detType) {
        detType.textContent = buildAssetTypeLabel(asset.type)
    }

    if (detPosition) {
        detPosition.textContent = formatAssetParticipationValue(summary.participaciones, asset.type)
    }

    if (detInvested) {
        detInvested.textContent = formatMoney(summary.invertidoNeto, investedCurrency)
    }

    if (detPnL) {
        detPnL.textContent = formatMoney(summary.rendimiento, summary.currency)
        detPnL.classList.toggle("negative", summary.rendimiento < 0)
    }

    if (detAvgPrice) {
        detAvgPrice.textContent = formatMoney(summary.promedioCompra, summary.precioCurrency || summary.currency)
    }

    if (detFees) {
        detFees.textContent = formatMoney(summary.comisiones, summary.currency)
    }

    if (detStatus) {
        detStatus.textContent = formatAssetLastUpdated(asset.lastUpdated)
    }

    if (detFinnhub) {
        const marketProvider = String(asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "")).toUpperCase()
        const marketSymbol = asset.marketSymbol || asset.finnhubSymbol || "---"
        detFinnhub.textContent = `Ticker mercado: ${marketSymbol} · API: ${marketProvider}`
    }
}

async function renderAssetsList(assets) {
    const assetsList = document.getElementById("assetsList")

    if (!assetsList) {
        return
    }

    assetsList.innerHTML = ""

    for (const asset of assets) {
        const displayPrice = await getAssetDisplayPriceValue(asset)
        const button = document.createElement("button")
        button.className = `assetBtn${asset.id === currentAssetId ? " selected" : ""}`
        button.dataset.assetId = asset.id
        button.dataset.assetOrder = String(asset.order ?? 0)
        button.draggable = true
        button.innerHTML = `
            <span class="assetBtnMain">
                <span class="assetBtnSymbol">${asset.symbol || asset.name}</span>
                <span class="assetBtnName">${asset.name || asset.symbol || "Activo"}</span>
            </span>
            <span class="assetBtnPrice">${formatMoney(displayPrice, asset.precioCurrency || asset.currency || "EUR")}</span>
        `
        assetsList.appendChild(button)
    }

    initAssetSelector([...assetsList.querySelectorAll(".assetBtn")])
    initAssetDragAndDrop(assetsList)
}

async function refreshAssetsSidebar(selectedAssetId = currentAssetId, renderTable = false) {
    try {
        await loadVentasRowsForAssets()
        await loadTransaccionesRowsForAssets()
        const assets = await loadAssetsList()
        await renderAssetsList(assets)
        await refreshTopPortfolioMetrics(assets)
        await refreshOverviewIfVisible()

        if (!assets.length) {
            currentAssetId = null
            const detSymbol = document.getElementById("detSymbol")
            const detName = document.getElementById("detName")
            const detPrice = document.getElementById("detPrice")
            const detChange = document.getElementById("detChange")
            const detType = document.getElementById("detType")
            const detPosition = document.getElementById("detPosition")
            const detInvested = document.getElementById("detInvested")
            const detPnL = document.getElementById("detPnL")
            const detAvgPrice = document.getElementById("detAvgPrice")
            const detFees = document.getElementById("detFees")
            const detStatus = document.getElementById("detStatus")
            const detFinnhub = document.getElementById("detFinnhub")

            if (detSymbol) {
                detSymbol.textContent = "---"
            }

            if (detName) {
                detName.textContent = "Selecciona un activo"
            }

            if (detPrice) {
                detPrice.textContent = "0,00 €"
            }

            if (detChange) {
                detChange.textContent = "---"
                detChange.classList.remove("negative")
            }

            if (detType) {
                detType.textContent = "---"
            }

            if (detPosition) {
                detPosition.textContent = "0"
            }

            if (detInvested) {
                detInvested.textContent = "0,00 €"
            }

            if (detPnL) {
                detPnL.textContent = "0,00 €"
                detPnL.classList.remove("negative")
            }

            if (detAvgPrice) {
                detAvgPrice.textContent = "0,00 €"
            }

            if (detFees) {
                detFees.textContent = "0,00 €"
            }

            if (detStatus) {
                detStatus.textContent = "Sin datos de mercado"
            }

            if (detFinnhub) {
                detFinnhub.textContent = "Ticker mercado: ---"
            }

            return
        }

        const assetIdToSelect = selectedAssetId || assets[0].id
        currentAssetId = assetIdToSelect
        await renderAssetsList(assets)

        const selectedAsset = assets.find((asset) => asset.id === assetIdToSelect) || assets[0]
        const fullAsset = await loadAssetData(selectedAsset.id)
        await updateAssetDetail(fullAsset)

        if (renderTable) {
            renderAssetTablePage(fullAsset)
        }
    } catch (error) {
        console.error("Error refrescando activos:", error)
    }
}

async function selectAsset(assetId) {
    if (!assetId) {
        return
    }

    currentAssetId = assetId
    const assetData = await loadAssetData(assetId)
    await updateAssetDetail(assetData)
    await renderAssetsList(await loadAssetsList())
    renderAssetTablePage(assetData)
}

async function refreshOverviewIfVisible() {
    if (document.getElementById("overviewTableBody")) {
        await renderVistaGeneralTable()
    }
}

function initAssetDragAndDrop(assetsList) {
    const assetButtons = [...assetsList.querySelectorAll(".assetBtn")]

    assetButtons.forEach((button) => {
        button.addEventListener("dragstart", (event) => {
            draggedAssetId = button.dataset.assetId || null
            button.classList.add("dragging")

            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = "move"
                event.dataTransfer.setData("text/plain", draggedAssetId || "")
            }
        })

        button.addEventListener("dragend", () => {
            button.classList.remove("dragging")
            clearAssetDragState()
            draggedAssetId = null
        })

        button.addEventListener("dragover", (event) => {
            if (!draggedAssetId || draggedAssetId === button.dataset.assetId) {
                return
            }

            event.preventDefault()
            button.classList.add("dragOver")
        })

        button.addEventListener("dragleave", () => {
            button.classList.remove("dragOver")
        })

        button.addEventListener("drop", async (event) => {
            event.preventDefault()

            const targetAssetId = button.dataset.assetId || ""

            button.classList.remove("dragOver")

            if (!draggedAssetId || !targetAssetId || draggedAssetId === targetAssetId) {
                return
            }

            try {
                await handleAssetDropReorder(draggedAssetId, targetAssetId, event.clientY)
            } catch (error) {
                console.error(error)
                alert("No se pudo reordenar el activo.")
            } finally {
                clearAssetDragState()
                draggedAssetId = null
            }
        })
    })

    if (!assetsList.dataset.dragBound) {
        assetsList.dataset.dragBound = "true"
        assetsList.addEventListener("dragover", (event) => {
            if (!draggedAssetId) {
                return
            }

            event.preventDefault()
        })
    }
}

function clearAssetDragState() {
    document.querySelectorAll(".assetBtn.dragOver, .assetBtn.dragging").forEach((button) => {
        button.classList.remove("dragOver", "dragging")
    })
}

async function handleAssetDropReorder(sourceAssetId, targetAssetId, pointerY) {
    const assets = await loadAssetsList()
    const orderedIds = assets.map((asset) => asset.id)
    const sourceIndex = orderedIds.indexOf(sourceAssetId)
    const targetIndex = orderedIds.indexOf(targetAssetId)

    if (sourceIndex === -1 || targetIndex === -1) {
        throw new Error("No se encontró el activo para reordenar")
    }

    orderedIds.splice(sourceIndex, 1)

    const targetButton = document.querySelector(`.assetBtn[data-asset-id="${targetAssetId}"]`)
    const targetRect = targetButton?.getBoundingClientRect()
    const insertAfterTarget = Boolean(targetRect && pointerY > targetRect.top + (targetRect.height / 2))
    let insertIndex = targetIndex

    if (insertAfterTarget) {
        insertIndex += 1
    }

    if (sourceIndex < targetIndex) {
        insertIndex -= 1
    }

    orderedIds.splice(Math.max(0, insertIndex), 0, sourceAssetId)
    await saveAssetOrderOnServer(orderedIds)
    await refreshAssetsSidebar(currentAssetId, false)
}

function buildAssetTypeLabel(assetType) {
    const labels = {
        cripto: "Cripto",
        acciones: "Acciones",
        etfs: "ETFs",
        comoditis: "Comoditis"
    }

    return labels[assetType] || assetType
}

function createAssetSymbolFromName(name) {
    return String(name || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 24) || "ACTIVO"
}

function formatPercent(value) {
    return new Intl.NumberFormat("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value) + " %"
}

function formatCellPercentValue(value) {
    const numericValue = parseLooseNumber(value)

    if (numericValue === null) {
        return String(value || "").trim()
    }

    return formatPercent(numericValue)
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
            cripto: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 },
            acciones: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 },
            etfs: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 },
            comoditis: { netoActual: 0, invertidoNeto: 0, rendimiento: 0 }
        }
    }
}

function updateTopMetricElement(elementId, value) {
    const element = document.getElementById(elementId)

    if (element) {
        element.textContent = value
    }
}

function applyTopPortfolioMetrics(metrics) {
    updateTopMetricElement("topTotalCuenta", formatEuro(metrics.totalCuenta))
    updateTopMetricElement("topPorcentajeCuenta", formatPercent(calculateYieldPercent(metrics.invertido, metrics.rendimiento)))
    updateTopMetricElement("topInvertido", formatEuro(metrics.invertido))
    updateTopMetricElement("topRendimientoEuros", formatEuro(metrics.rendimiento))

    updateTopMetricElement("topPorcentajeCripto", formatPercent(calculateYieldPercent(metrics.tipos.cripto.invertidoNeto, metrics.tipos.cripto.rendimiento)))
    updateTopMetricElement("topEurosCripto", formatEuro(metrics.tipos.cripto.invertidoNeto))
    updateTopMetricElement("topPorcentajeAcciones", formatPercent(calculateYieldPercent(metrics.tipos.acciones.invertidoNeto, metrics.tipos.acciones.rendimiento)))
    updateTopMetricElement("topEurosAcciones", formatEuro(metrics.tipos.acciones.invertidoNeto))
    updateTopMetricElement("topPorcentajeEtf", formatPercent(calculateYieldPercent(metrics.tipos.etfs.invertidoNeto, metrics.tipos.etfs.rendimiento)))
    updateTopMetricElement("topEurosEtf", formatEuro(metrics.tipos.etfs.invertidoNeto))
    updateTopMetricElement("topPorcentajeComoditis", formatPercent(calculateYieldPercent(metrics.tipos.comoditis.invertidoNeto, metrics.tipos.comoditis.rendimiento)))
    updateTopMetricElement("topEurosComoditis", formatEuro(metrics.tipos.comoditis.invertidoNeto))
}

async function refreshTopPortfolioMetrics(assets = null) {
    const baseAssets = Array.isArray(assets) ? assets : await loadAssetsList()

    if (!baseAssets.length) {
        applyTopPortfolioMetrics(createEmptyTopMetrics())
        return
    }

    const metrics = createEmptyTopMetrics()
    const fullAssets = await Promise.all(baseAssets.map((asset) => loadAssetData(asset.id)))
    const metricSummaries = await Promise.all(fullAssets.map(async (asset) => {
        const summary = buildOverviewRow(asset)
        const euroMetrics = await buildSummaryMetricsInEuros(summary)

        return { summary, euroMetrics }
    }))

    metricSummaries.forEach(({ summary, euroMetrics }) => {
        metrics.totalCuenta += euroMetrics.netoActualEur
        metrics.invertido += euroMetrics.invertidoNetoEur
        metrics.rendimiento += euroMetrics.rendimientoEur

        if (metrics.tipos[summary.assetType]) {
            metrics.tipos[summary.assetType].netoActual += euroMetrics.netoActualEur
            metrics.tipos[summary.assetType].invertidoNeto += euroMetrics.invertidoNetoEur
            metrics.tipos[summary.assetType].rendimiento += euroMetrics.rendimientoEur
        }
    })

    applyTopPortfolioMetrics(metrics)
}

async function initVistaGeneralLogic() {
    const filtersContainer = document.getElementById("overviewFilters")
    const refreshOverviewMarketButton = document.getElementById("refreshOverviewMarketBtn")

    if (filtersContainer && !filtersContainer.dataset.bound) {
        filtersContainer.dataset.bound = "true"
        filtersContainer.addEventListener("change", () => {
            renderVistaGeneralTable()
        })
    }

    if (refreshOverviewMarketButton && !refreshOverviewMarketButton.dataset.bound) {
        refreshOverviewMarketButton.dataset.bound = "true"
        refreshOverviewMarketButton.addEventListener("click", async () => {
            await refreshOverviewMarketData(refreshOverviewMarketButton)
        })
    }

    await renderVistaGeneralTable()
}

async function refreshOverviewMarketData(buttonElement = null) {
    const originalLabel = buttonElement?.textContent || ""

    if (buttonElement) {
        buttonElement.disabled = true
        buttonElement.textContent = "Actualizando..."
    }

    try {
        const assets = await loadAssetsList()
        const assetsWithTicker = assets.filter((asset) => String(asset.marketSymbol || asset.finnhubSymbol || "").trim())

        for (const asset of assetsWithTicker) {
            try {
                await refreshAssetMarketDataOnServer(asset.id)
            } catch (error) {
                console.error(`No se pudo actualizar ${asset.name || asset.symbol || asset.id}:`, error)
            }
        }

        await refreshAssetsSidebar(currentAssetId, false)
        await renderVistaGeneralTable()
    } finally {
        if (buttonElement) {
            buttonElement.disabled = false
            buttonElement.textContent = originalLabel
        }
    }
}

function initSidebarRefreshButton(buttonElement) {
    if (!buttonElement || buttonElement.dataset.bound) {
        return
    }

    buttonElement.dataset.bound = "true"
    buttonElement.addEventListener("click", async () => {
        await refreshOverviewMarketData(buttonElement)
    })
}

function getSelectedOverviewTypes() {
    return [...document.querySelectorAll('#overviewFilters input[type="checkbox"]:checked')].map((input) => input.value)
}

function parseParticipationNumber(value) {
    const cleanValue = String(value || "")
        .replace(/\s/g, "")
        .replace(/\./g, "")
        .replace(",", ".")

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function getSignedParticipation(row) {
    const participaciones = parseParticipationNumber(row.participaciones)
    const operationType = (row.tipoOperacion || "").trim().toLowerCase()

    if (operationType.includes("venta")) {
        return participaciones * -1
    }

    return participaciones
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

function getAveragePurchasePrice(rows) {
    const totals = rows.reduce((accumulator, row) => {
        const operationType = (row.tipoOperacion || "").trim().toLowerCase()

        if (operationType.includes("venta")) {
            return accumulator
        }

        const participaciones = parseParticipationNumber(row.participaciones)

        if (participaciones <= 0) {
            return accumulator
        }

        const costeFila = getRowGrossAmount(row, "acciones")

        return {
            shares: accumulator.shares + participaciones,
            cost: accumulator.cost + costeFila
        }
    }, { shares: 0, cost: 0 })

    return totals.shares > 0 ? totals.cost / totals.shares : 0
}

function getRowGrossAmount(row, assetType = "") {
    const capitalInvertidoBruto = parseLooseNumber(row.capitalInvertidoBruto || "")
    return capitalInvertidoBruto || 0
}

function getRowSignedCost(row, assetType = "") {
    const operationType = (row.tipoOperacion || "").trim().toLowerCase()
    const costeFila = getRowGrossAmount(row, assetType)

    if (operationType.includes("venta")) {
        return costeFila * -1
    }

    return costeFila
}

function getRowAnnualCostAmount(row, assetType = "") {
    return 0
}

function getRowTotalCostForLot(row, assetType = "") {
    const participaciones = parseParticipationNumber(row.participaciones)
    const capitalInvertidoBruto = parseLooseNumber(row.capitalInvertidoBruto || "")
    const grossBasedCost = capitalInvertidoBruto !== null ? capitalInvertidoBruto : 0

    if (participaciones <= 0) {
        return grossBasedCost
    }

    return grossBasedCost
}

function buildRemainingAssetLots(asset) {
    const rows = Array.isArray(asset.rows) ? [...asset.rows] : []
    rows.sort((left, right) => parseAssetOperationDate(left.fechaOperacion) - parseAssetOperationDate(right.fechaOperacion))

    const lots = []

    rows.forEach((row) => {
        const operationType = String(row.tipoOperacion || "").trim().toLowerCase()
        const participaciones = parseParticipationNumber(row.participaciones)

        if (participaciones <= 0) {
            return
        }

        if (operationType.includes("venta")) {
            consumeAssetLots(lots, participaciones)
            return
        }

        const totalCost = getRowTotalCostForLot(row, asset.type)
        lots.push({
            remaining: participaciones,
            unitCost: participaciones > 0 ? totalCost / participaciones : 0,
            totalCost
        })
    })

    const externalSales = externalVentasRowsCache
        .filter((row) => String(row.assetId || "") === String(asset.id || ""))
        .sort((left, right) => parseAssetOperationDate(left.fecha) - parseAssetOperationDate(right.fecha))

    externalSales.forEach((saleRow) => {
        const soldQuantity = parseParticipationNumber(saleRow.cantidad)

        if (soldQuantity > 0) {
            consumeAssetLots(lots, soldQuantity)
        }
    })

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
        remainingToSell -= quantityFromLot
    }
}

function buildOverviewRow(asset) {
    const rows = Array.isArray(asset.rows) ? asset.rows : []
    const remainingLots = buildRemainingAssetLots(asset)
    const rawParticipaciones = remainingLots.reduce((total, lot) => total + lot.remaining, 0)
    const transaccionesFeeAmount = externalTransaccionesRowsCache
        .filter((row) => String(row.assetId || "") === String(asset.id || ""))
        .reduce((total, row) => total + (parseLooseNumber(row.comisionRed || "") || 0), 0)
    const participaciones = Math.max(0, rawParticipaciones - transaccionesFeeAmount)
    const invertidoBruto = remainingLots.reduce((total, lot) => total + (lot.remaining * lot.unitCost), 0)
    const comisiones = rows.reduce((total, row) => total + (parseLooseNumber(row.comisiones || "") || 0), 0)
    const invertidoNeto = invertidoBruto - comisiones
    const valorActual = parseLooseNumber(asset.price || "") || 0
    const netoActual = participaciones * valorActual
    const promedioCompra = participaciones > 0 ? invertidoBruto / participaciones : 0
    const rendimiento = netoActual - invertidoNeto

    return {
        nombre: asset.name || asset.symbol || "Activo",
        tipo: buildAssetTypeLabel(asset.type),
        assetType: asset.type,
        participaciones,
        promedioCompra,
        valorActual,
        currency: asset.currency || "EUR",
        precioCurrency: asset.precioCurrency || asset.currency || "EUR",
        invertidoBruto,
        comisiones,
        invertidoNeto,
        netoActual,
        rendimiento
    }
}

function renderOverviewRows(rows) {
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

    rows.forEach((row) => {
        const tr = document.createElement("tr")
        const profitClass = row.overviewYieldValue >= 0 ? "overviewProfitPositive" : "overviewProfitNegative"

        tr.innerHTML = `
            <td>${row.nombre}</td>
            <td>${row.tipo}</td>
            <td class="overviewNumericCell">${formatAssetParticipationValue(row.participaciones, row.assetType)}</td>
            <td class="overviewNumericCell">${formatMoney(row.promedioCompra, row.precioCurrency || row.currency)}</td>
            <td class="overviewNumericCell overviewCurrentPriceCell">${formatMoney(row.overviewCurrentPrice ?? row.valorActual, row.precioCurrency || row.currency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.invertidoBruto, row.overviewInvestedCurrency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.comisiones, row.overviewInvestedCurrency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.invertidoNeto, row.overviewInvestedCurrency)}</td>
            <td class="overviewNumericCell">${formatMoney(row.overviewCurrentValue, row.overviewInvestedCurrency)}</td>
            <td class="overviewNumericCell ${profitClass}">${formatMoney(row.overviewYieldValue, row.overviewInvestedCurrency)}</td>
        `

        tableBody.appendChild(tr)
    })
}

async function renderVistaGeneralTable() {
    const tableBody = document.getElementById("overviewTableBody")

    if (!tableBody) {
        return
    }

    try {
        const assets = await loadAssetsList()
        const selectedTypes = new Set(getSelectedOverviewTypes())

        if (!selectedTypes.size) {
            renderOverviewRows([])
            return
        }

        const fullAssets = await Promise.all(assets.map((asset) => loadAssetData(asset.id)))
        const rows = await Promise.all(
            fullAssets
                .filter((asset) => selectedTypes.has(asset.type))
                .map((asset) => buildOverviewDisplayRow(asset))
        )

        renderOverviewRows(rows)
    } catch (error) {
        console.error("Error cargando vista general:", error)
    }
}

function renderAssetTablePage(asset) {
    const contentArea = document.getElementById("dynamicContent")
    const currentCurrency = String(asset.currency || "EUR").trim().toUpperCase()
    const currentPriceCurrency = String(asset.precioCurrency || asset.currency || "EUR").trim().toUpperCase()
    const targetCurrency = currentCurrency === "EUR" ? "USD" : "EUR"
    const targetPriceCurrency = currentPriceCurrency === "EUR" ? "USD" : "EUR"
    const isCrypto = isCryptoAssetType(asset.type)
    const isEtf = String(asset.type || "").trim().toLowerCase() === "etfs"

    if (!contentArea) {
        return
    }

    contentArea.innerHTML = `
        <section class="assetTablePage" data-asset-id="${asset.id}" data-asset-type="${asset.type}" data-asset-name="${asset.name}" data-asset-symbol="${asset.symbol}" data-asset-price="${asset.price || "0,00"}" data-asset-currency="${asset.currency || "EUR"}" data-asset-price-currency="${asset.precioCurrency || asset.currency || "EUR"}" data-asset-change="${asset.change || "+0,00%"}" data-asset-status="${asset.status || "Mercado abierto"}" data-asset-last-updated="${asset.lastUpdated || ""}" data-asset-market-provider="${asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "")}" data-asset-market-symbol="${asset.marketSymbol || asset.finnhubSymbol || ""}" data-asset-finnhub-symbol="${asset.finnhubSymbol || ""}">
            <div class="assetPageHeader">
                <div>
                    <div class="assetTitleRow">
                        <h1 class="assetPageTitle">${asset.name || asset.symbol}</h1>
                        <button id="editAssetNameBtn" class="assetEditNameBtn" type="button" title="Editar nombre del activo" aria-label="Editar nombre del activo">✎</button>
                    </div>
                    <div class="assetPageSubtitle">${asset.name} · ${buildAssetTypeLabel(asset.type)}</div>
                </div>
                ${isCrypto ? `
                    <div class="assetCurrencyPanel assetCurrencyPanelCrypto">
                        <div class="assetCurrencyBlock">
                            <div class="assetCurrencyLabel">Precio participación</div>
                            <div class="assetCurrencyCurrent">Actual: ${currentPriceCurrency}</div>
                            <button id="toggleAssetPriceCurrencyBtn" class="secondaryButton assetCurrencyBtn" type="button" data-target-currency="${targetPriceCurrency}">
                                Pasar a ${targetPriceCurrency}
                            </button>
                        </div>
                        <div class="assetCurrencyBlock">
                            <div class="assetCurrencyLabel">Resto de importes</div>
                            <div class="assetCurrencyCurrent">Actual: ${currentCurrency}</div>
                            <button id="toggleAssetCurrencyBtn" class="secondaryButton assetCurrencyBtn" type="button" data-target-currency="${targetCurrency}">
                                Pasar a ${targetCurrency}
                            </button>
                        </div>
                    </div>
                ` : `
                    <div class="assetCurrencyPanel">
                        <div class="assetCurrencyLabel">Moneda del activo</div>
                        <div class="assetCurrencyCurrent">Actual: ${currentCurrency}</div>
                        <button id="toggleAssetCurrencyBtn" class="secondaryButton assetCurrencyBtn" type="button" data-target-currency="${targetCurrency}">
                            Pasar a ${targetCurrency}
                        </button>
                    </div>
                `}
            </div>

            <div class="assetTableWrapper">
                <table class="assetOperationsTable">
                    <thead>
                        <tr>
                            <th class="rowActionHeader"></th>
                            <th>Fecha operación</th>
                            <th>Tipo de operación</th>
                            <th>Participaciones</th>
                            <th>Precio Participación</th>
                            <th>Capital Invertido bruto</th>
                            ${isEtf ? "<th>Coste Anual</th>" : ""}
                            <th>Comisiones</th>
                            <th>Capital Invertido neto</th>
                        </tr>
                    </thead>
                    <tbody id="assetOperationsBody"></tbody>
                </table>
            </div>

            <div class="assetActions">
                <button id="refreshAssetMarketBtn" class="primaryButton">Actualizar cotización (${String(asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "")).toUpperCase()})</button>
                <button id="addAssetRowBtn" class="primaryButton">Añadir fila</button>
                <button id="saveAssetBtn" class="secondaryButton">Guardar JSON</button>
                <button id="deleteAssetBtn" class="dangerButton">Eliminar activo</button>
            </div>
        </section>
    `

    renderAssetRows(asset.rows || [])
    initAssetTableLogic(asset)
}

function renderAssetRows(rows) {
    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const assetPage = document.querySelector(".assetTablePage")
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const assetPriceCurrency = assetPage?.dataset.assetPriceCurrency || assetCurrency
    const assetType = assetPage?.dataset.assetType || "acciones"
    const isCrypto = isCryptoAssetType(assetType)
    const isEtf = String(assetType || "").trim().toLowerCase() === "etfs"

    if (!assetOperationsBody) {
        return
    }

    assetOperationsBody.innerHTML = ""

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")
        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true" data-field="fechaOperacion">${rowData.fechaOperacion || ""}</td>
            <td contenteditable="true" data-field="tipoOperacion">${rowData.tipoOperacion || "Compra"}</td>
            <td contenteditable="true" data-field="participaciones">${formatAssetParticipationValue(rowData.participaciones, assetType)}</td>
            <td contenteditable="true" data-field="precioParticipacion">${formatCellMoneyValue(rowData.precioParticipacion, getAssetTableMoneyCurrency(assetType, "precioParticipacion", assetCurrency, assetPriceCurrency))}</td>
            <td contenteditable="true" data-field="capitalInvertidoBruto">${formatCellMoneyValue(rowData.capitalInvertidoBruto, getAssetTableMoneyCurrency(assetType, "capitalInvertidoBruto", assetCurrency))}</td>
            ${isEtf ? `<td contenteditable="true" data-field="costeAnual">${formatCellPercentValue(rowData.costeAnual)}</td>` : ""}
            <td contenteditable="true" data-field="comisiones">${isCrypto ? formatAssetCommissionValue(rowData.comisiones, getAssetTableMoneyCurrency(assetType, "comisiones", assetCurrency, assetPriceCurrency)) : formatCellMoneyValue(rowData.comisiones, getAssetTableMoneyCurrency(assetType, "comisiones", assetCurrency, assetPriceCurrency))}</td>
            <td class="rowTotal">${formatMoney(0, assetCurrency)}</td>
        `
        assetOperationsBody.appendChild(rowElement)
    })

    updateAssetTableTotals()
}

function collectAssetRowsFromTable() {
    const rowElements = [...document.querySelectorAll("#assetOperationsBody tr")]
    const assetPage = document.querySelector(".assetTablePage")
    const assetType = assetPage?.dataset.assetType || "acciones"
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"

    return rowElements.map((rowElement) => {
        const getFieldValue = (fieldName) => rowElement.querySelector(`[data-field="${fieldName}"]`)?.textContent.trim() || ""
        const rowData = {
            fechaOperacion: getFieldValue("fechaOperacion"),
            tipoOperacion: getFieldValue("tipoOperacion"),
            participaciones: getFieldValue("participaciones"),
            precioParticipacion: getFieldValue("precioParticipacion"),
            capitalInvertidoBruto: getFieldValue("capitalInvertidoBruto"),
            costeAnual: getFieldValue("costeAnual"),
            comisiones: getFieldValue("comisiones"),
            comisionesSatoshis: getFieldValue("comisionesSatoshis")
        }

        return rowData
    })
}

function isPlaceholderValue(value, placeholders = []) {
    return placeholders.includes((value || "").trim().toLowerCase())
}

function isEmptyInteresesRow(rowElement) {
    const cells = rowElement.querySelectorAll("td")
    const fecha = cells[1]?.textContent.trim() || ""
    const saldoPromedio = parseEuroNumber(cells[2]?.textContent || "")
    const acumulado = parseEuroNumber(cells[3]?.textContent || "")
    const impuestos = parseEuroNumber(cells[4]?.textContent || "")

    return (!fecha || isPlaceholderValue(fecha, ["nuevo-mes"])) &&
        saldoPromedio === 0 &&
        acumulado === 0 &&
        impuestos === 0
}

function isEmptyDividendosRow(rowElement) {
    const cells = rowElement.querySelectorAll("td")
    const fecha = cells[1]?.textContent.trim() || ""
    const instrumento = cells[2]?.textContent.trim() || ""
    const acciones = parseFloat((cells[3]?.textContent || "0").replace(",", ".")) || 0
    const dividendoAccion = parseDollarNumber(cells[4]?.textContent || "")
    const impuestos = parseEuroNumber(cells[5]?.textContent || "")
    const total = parseEuroNumber(cells[6]?.textContent || "")

    return (!fecha || isPlaceholderValue(fecha, ["nueva-fecha"])) &&
        (!instrumento || isPlaceholderValue(instrumento, ["instrumento"])) &&
        acciones === 0 &&
        dividendoAccion === 0 &&
        impuestos === 0 &&
        total === 0
}

function isEmptyAssetRow(rowElement) {
    const fechaOperacion = rowElement.querySelector('[data-field="fechaOperacion"]')?.textContent.trim() || ""
    const tipoOperacion = rowElement.querySelector('[data-field="tipoOperacion"]')?.textContent.trim() || ""
    const participaciones = parseFloat((rowElement.querySelector('[data-field="participaciones"]')?.textContent || "0").replace(",", ".")) || 0
    const precioParticipacion = parseLooseNumber(rowElement.querySelector('[data-field="precioParticipacion"]')?.textContent || "") || 0
    const capitalInvertidoBruto = parseLooseNumber(rowElement.querySelector('[data-field="capitalInvertidoBruto"]')?.textContent || "") || 0
    const costeAnual = parseLooseNumber(rowElement.querySelector('[data-field="costeAnual"]')?.textContent || "") || 0
    const comisiones = parseLooseNumber(rowElement.querySelector('[data-field="comisiones"]')?.textContent || "") || 0
    const comisionesSatoshis = parseLooseNumber(rowElement.querySelector('[data-field="comisionesSatoshis"]')?.textContent || "") || 0

    return !fechaOperacion &&
        (!tipoOperacion || isPlaceholderValue(tipoOperacion, ["compra"])) &&
        participaciones === 0 &&
        precioParticipacion === 0 &&
        capitalInvertidoBruto === 0 &&
        costeAnual === 0 &&
        comisiones === 0 &&
        comisionesSatoshis === 0
}

function handleRowDeleteClick(event) {
    const deleteButton = event.target.closest(".rowDeleteBtn")

    if (!deleteButton) {
        return
    }

    const rowElement = deleteButton.closest("tr")
    const tableBody = rowElement?.closest("tbody")

    if (!rowElement || !tableBody) {
        return
    }

    let isEmptyRow = false

    if (tableBody.id === "interesesBody") {
        isEmptyRow = isEmptyInteresesRow(rowElement)
    } else if (tableBody.id === "dividendosBody") {
        isEmptyRow = isEmptyDividendosRow(rowElement)
    } else if (tableBody.id === "assetOperationsBody") {
        isEmptyRow = isEmptyAssetRow(rowElement)
    }

    const removeRow = () => {
        rowElement.remove()

        if (tableBody.id === "interesesBody") {
            updateTotals()
            return
        }

        if (tableBody.id === "dividendosBody") {
            updateDividendosTotals()
            scheduleDividendosAutosave()
            return
        }

        if (tableBody.id === "assetOperationsBody") {
            updateAssetTableTotals()
            scheduleAssetAutosave()
        }
    }

    if (isEmptyRow) {
        removeRow()
        return
    }

    openConfirmModal({
        title: "Eliminar fila",
        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            removeRow()
        }
    })
}

function buildCurrentAssetPayload() {
    const assetPage = document.querySelector(".assetTablePage")
    const marketSymbol = (assetPage?.dataset.assetMarketSymbol || assetPage?.dataset.assetFinnhubSymbol || "").trim().toUpperCase()
    const marketProvider = inferMarketProviderFromSymbol(
        marketSymbol,
        (assetPage?.dataset.assetMarketProvider || "finnhub").trim().toLowerCase()
    )

    return {
        id: currentAssetId,
        name: assetPage?.dataset.assetName || document.getElementById("detName")?.textContent.trim() || "Activo",
        symbol: assetPage?.dataset.assetSymbol || document.getElementById("detSymbol")?.textContent.trim() || "ACTIVO",
        marketProvider,
        marketSymbol,
        finnhubSymbol: marketSymbol,
        type: assetPage?.dataset.assetType || "cripto",
        price: assetPage?.dataset.assetPrice || "0,00",
        currency: assetPage?.dataset.assetCurrency || "EUR",
        precioCurrency: assetPage?.dataset.assetPriceCurrency || assetPage?.dataset.assetCurrency || "EUR",
        change: assetPage?.dataset.assetChange || "+0,00%",
        status: assetPage?.dataset.assetStatus || "Mercado abierto",
        lastUpdated: assetPage?.dataset.assetLastUpdated || "",
        order: Number(document.querySelector(`.assetBtn[data-asset-id="${currentAssetId}"]`)?.dataset.assetOrder || 0),
        rows: collectAssetRowsFromTable()
    }
}

function updateAssetTableTotals() {
    const rowElements = document.querySelectorAll("#assetOperationsBody tr")
    const assetPage = document.querySelector(".assetTablePage")
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const assetType = assetPage?.dataset.assetType || "acciones"
    const isEtf = String(assetType || "").trim().toLowerCase() === "etfs"

    rowElements.forEach((rowElement) => {
        const rowData = {
            participaciones: rowElement.querySelector('[data-field="participaciones"]')?.textContent || "",
            precioParticipacion: rowElement.querySelector('[data-field="precioParticipacion"]')?.textContent || "",
            capitalInvertidoBruto: rowElement.querySelector('[data-field="capitalInvertidoBruto"]')?.textContent || "",
            costeAnual: rowElement.querySelector('[data-field="costeAnual"]')?.textContent || ""
        }
        const bruto = getRowGrossAmount(rowData, assetType)
        const comisiones = parseLooseNumber(rowElement.querySelector('[data-field="comisiones"]')?.textContent || "") || 0
        const neto = bruto - comisiones
        const rowTotalCell = rowElement.querySelector(".rowTotal")

        if (rowTotalCell) {
            rowTotalCell.textContent = formatMoney(neto, getAssetTableMoneyCurrency(assetType, "capitalInvertidoNeto", assetCurrency))
        }
    })
}

function setAssetSearchFeedback(container, message = "", isError = false) {
    if (!container) {
        return
    }

    if (!message) {
        container.textContent = ""
        container.classList.add("hidden")
        container.classList.remove("assetSearchError")
        return
    }

    container.textContent = message
    container.classList.remove("hidden")
    container.classList.toggle("assetSearchError", isError)
}

function inferMarketProviderFromSymbol(symbol, fallback = "finnhub") {
    const normalizedSymbol = String(symbol || "").trim().toUpperCase()
    const normalizedFallback = String(fallback || "finnhub").trim().toLowerCase()

    if (!normalizedSymbol) {
        return normalizedFallback || "finnhub"
    }

    if (normalizedSymbol.includes(":")) {
        return "finnhub"
    }

    const eodhdExchangeCodes = new Set(["XETRA", "PA", "LSE", "US", "SW", "AS", "MC", "MI", "DU", "BE", "F", "MU", "ST", "VI", "LS"])

    if (normalizedSymbol.includes(".")) {
        const exchangeCode = normalizedSymbol.split(".").pop()

        if (eodhdExchangeCodes.has(exchangeCode)) {
            return "eodhd"
        }
    }

    return normalizedFallback || "finnhub"
}

function renderMarketSearchResults(container, results, onSelect) {
    if (!container) {
        return
    }

    container.innerHTML = ""

    if (!Array.isArray(results) || !results.length) {
        container.classList.add("hidden")
        return
    }

    results.forEach((result) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = "assetSearchResultBtn"
        const changeValue = String(result.change || "").trim()
        const hasQuote = String(result.price || "").trim() !== ""
        const quoteClass = changeValue.startsWith("-") ? "negative" : "positive"
        const displaySymbol = result.displaySymbol || result.symbol
        const providerLabel = String(result.provider || "").trim().toUpperCase()
        const metaLabel = [providerLabel, result.type || "market", result.exchange || ""].filter(Boolean).join(" · ")
        button.innerHTML = `
            <span class="assetSearchResultTitle">${displaySymbol}</span>
            <span class="assetSearchResultSubtitle">${result.description}</span>
            <span class="assetSearchResultMeta">${metaLabel}</span>
            ${hasQuote ? `
                <span class="assetSearchResultQuoteRow">
                    <span class="assetSearchResultPrice">${result.price} ${result.currency || ""}</span>
                    <span class="assetSearchResultChange ${quoteClass}">${changeValue}</span>
                </span>
            ` : `
                <span class="assetSearchResultQuoteEmpty">Sin cotizacion disponible</span>
            `}
        `
        button.addEventListener("click", () => {
            onSelect(result)
        })
        container.appendChild(button)
    })

    container.classList.remove("hidden")
}

async function handleFinnhubSearch({ query, assetName = "", assetType = "", feedbackElement, resultsElement, onSelect }) {
    const normalizedQuery = String(query || "").trim()

    if (!normalizedQuery) {
        setAssetSearchFeedback(feedbackElement, "Escribe el nombre o ticker del activo.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
        return
    }

    setAssetSearchFeedback(feedbackElement, "Buscando ticker en Finnhub...")

    try {
        const response = await searchFinnhubSymbolOnServer(normalizedQuery, { assetName, assetType })
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(feedbackElement, "No se encontraron resultados para esa búsqueda.", true)
            renderMarketSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto de Finnhub.")
        renderMarketSearchResults(resultsElement, results, onSelect)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedbackElement, "No se pudo consultar Finnhub. Revisa la API key.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
    }
}

async function handleEodhdSearch({ query, assetName = "", assetType = "", feedbackElement, resultsElement, onSelect }) {
    const normalizedQuery = String(query || "").trim()

    if (!normalizedQuery) {
        setAssetSearchFeedback(feedbackElement, "Escribe el nombre o ticker del activo.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
        return
    }

    setAssetSearchFeedback(feedbackElement, "Buscando ticker en EODHD...")

    try {
        const response = await searchEodhdSymbolOnServer(normalizedQuery, { assetName, assetType })
        const results = Array.isArray(response.results) ? response.results : []

        if (!results.length) {
            setAssetSearchFeedback(feedbackElement, "No se encontraron resultados en EODHD para esa búsqueda.", true)
            renderMarketSearchResults(resultsElement, [], onSelect)
            return
        }

        setAssetSearchFeedback(feedbackElement, "Selecciona el ticker correcto de EODHD.")
        renderMarketSearchResults(resultsElement, results, onSelect)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedbackElement, "No se pudo consultar EODHD. Revisa la API key.", true)
        renderMarketSearchResults(resultsElement, [], onSelect)
    }
}

async function refreshCurrentAssetMarketData({ feedbackElement = null, successMessage = "" } = {}) {
    if (!currentAssetId) {
        return
    }

    try {
        const payload = buildCurrentAssetPayload()
        await saveAssetDataToServer(payload)
        const response = await refreshAssetMarketDataOnServer(currentAssetId)
        await updateAssetDetail(response.asset)
        renderAssetTablePage(response.asset)
        await refreshAssetsSidebar(currentAssetId, false)

        if (feedbackElement && successMessage) {
            setAssetSearchFeedback(feedbackElement, successMessage)
        }
    } catch (error) {
        console.error(error)
        const errorMessage = extractApiErrorMessage(error)

        if (feedbackElement) {
            setAssetSearchFeedback(feedbackElement, errorMessage, true)
        } else {
            alert(errorMessage)
        }
    }
}

async function renameCurrentAsset() {
    openEditAssetModal()
}

function openEditAssetModal() {
    if (!currentAssetId) {
        return
    }

    const editAssetModalOverlay = document.getElementById("editAssetModalOverlay")
    const editAssetNameInput = document.getElementById("editAssetNameInput")
    const assetPage = document.querySelector(".assetTablePage")
    const currentName = assetPage?.dataset.assetName || document.getElementById("detName")?.textContent.trim() || ""

    if (!editAssetModalOverlay || !editAssetNameInput) {
        return
    }

    editAssetNameInput.value = currentName
    editAssetModalOverlay.classList.remove("hidden")
    editAssetModalState = { isOpen: true }

    requestAnimationFrame(() => {
        editAssetNameInput.focus()
        editAssetNameInput.select()
    })
}

function closeEditAssetModal() {
    const editAssetModalOverlay = document.getElementById("editAssetModalOverlay")

    if (!editAssetModalOverlay) {
        return
    }

    editAssetModalOverlay.classList.add("hidden")
    editAssetModalState = null
}

async function submitEditAssetModal() {
    if (!currentAssetId) {
        return
    }

    const editAssetNameInput = document.getElementById("editAssetNameInput")

    if (!editAssetNameInput) {
        return
    }

    const payload = buildCurrentAssetPayload()
    const currentName = String(payload.name || "").trim()
    const trimmedName = editAssetNameInput.value.trim()

    if (!trimmedName) {
        editAssetNameInput.focus()
        return
    }

    if (trimmedName === currentName) {
        closeEditAssetModal()
        return
    }

    const currentSymbol = String(payload.symbol || "").trim()
    const generatedCurrentSymbol = createAssetSymbolFromName(currentName)

    payload.name = trimmedName

    if (!currentSymbol || currentSymbol === generatedCurrentSymbol) {
        payload.symbol = createAssetSymbolFromName(trimmedName)
    }

    await saveAssetDataToServer(payload)
    closeEditAssetModal()
    const updatedAsset = await loadAssetData(currentAssetId)
    await updateAssetDetail(updatedAsset)
    renderAssetTablePage(updatedAsset)
    await refreshAssetsSidebar(currentAssetId, false)
}

function addNewAssetRow() {
    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const assetPage = document.querySelector(".assetTablePage")
    const assetCurrency = assetPage?.dataset.assetCurrency || "EUR"
    const assetType = assetPage?.dataset.assetType || "acciones"
    const isCrypto = isCryptoAssetType(assetType)
    const isEtf = String(assetType || "").trim().toLowerCase() === "etfs"

    if (!assetOperationsBody) {
        return
    }

    const rowElement = document.createElement("tr")
    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true" data-field="fechaOperacion"></td>
        <td contenteditable="true" data-field="tipoOperacion">Compra</td>
        <td contenteditable="true" data-field="participaciones"></td>
        <td contenteditable="true" data-field="precioParticipacion"></td>
        <td contenteditable="true" data-field="capitalInvertidoBruto"></td>
        ${isEtf ? '<td contenteditable="true" data-field="costeAnual"></td>' : ""}
        <td contenteditable="true" data-field="comisiones">${isCrypto ? '0,000 €' : ''}</td>
        <td class="rowTotal">${formatMoney(0, assetCurrency)}</td>
    `

    assetOperationsBody.appendChild(rowElement)
    updateAssetTableTotals()
}

function scheduleAssetAutosave() {
    clearTimeout(assetAutosaveTimeout)

    assetAutosaveTimeout = setTimeout(async () => {
        if (!currentAssetId || !document.getElementById("assetOperationsBody")) {
            return
        }

        try {
            await saveAssetDataToServer(buildCurrentAssetPayload())
            await refreshAssetsSidebar(currentAssetId, false)
        } catch (error) {
            console.error("Error en autoguardado del activo:", error)
        }
    }, 500)
}

function initAssetTableLogic(asset) {
    currentAssetId = asset.id

    const assetOperationsBody = document.getElementById("assetOperationsBody")
    const addAssetRowButton = document.getElementById("addAssetRowBtn")
    const refreshAssetMarketButton = document.getElementById("refreshAssetMarketBtn")
    const toggleAssetCurrencyButton = document.getElementById("toggleAssetCurrencyBtn")
    const toggleAssetPriceCurrencyButton = document.getElementById("toggleAssetPriceCurrencyBtn")
    const editAssetNameButton = document.getElementById("editAssetNameBtn")
    const saveAssetButton = document.getElementById("saveAssetBtn")
    const deleteAssetButton = document.getElementById("deleteAssetBtn")

    if (assetOperationsBody) {
        assetOperationsBody.addEventListener("input", () => {
            updateAssetTableTotals()
            scheduleAssetAutosave()
        })

        assetOperationsBody.addEventListener("click", handleRowDeleteClick)
        assetOperationsBody.addEventListener("focus", handleCellFocus, true)
        assetOperationsBody.addEventListener("blur", (event) => {
            handleCellBlur(event)
            scheduleAssetAutosave()
        }, true)
    }

    if (addAssetRowButton) {
        addAssetRowButton.addEventListener("click", () => {
            addNewAssetRow()
            scheduleAssetAutosave()
        })
    }

    if (refreshAssetMarketButton) {
        refreshAssetMarketButton.addEventListener("click", async () => {
            await refreshCurrentAssetMarketData()
        })
    }

    if (toggleAssetCurrencyButton) {
        toggleAssetCurrencyButton.addEventListener("click", async () => {
            const targetCurrency = String(toggleAssetCurrencyButton.dataset.targetCurrency || "").trim().toUpperCase()
            const originalLabel = toggleAssetCurrencyButton.textContent

            if (!targetCurrency) {
                return
            }

            toggleAssetCurrencyButton.disabled = true
            toggleAssetCurrencyButton.textContent = `Cambiando a ${targetCurrency}...`

            try {
                await saveAssetDataToServer(buildCurrentAssetPayload())
                const response = await changeAssetCurrencyOnServer(currentAssetId, targetCurrency, "asset")
                await updateAssetDetail(response.asset)
                renderAssetTablePage(response.asset)
                await refreshAssetsSidebar(currentAssetId, false)
            } catch (error) {
                console.error(error)
                alert(extractApiErrorMessage(error))
                toggleAssetCurrencyButton.disabled = false
                toggleAssetCurrencyButton.textContent = originalLabel
            }
        })
    }

    if (toggleAssetPriceCurrencyButton) {
        toggleAssetPriceCurrencyButton.addEventListener("click", async () => {
            const targetCurrency = String(toggleAssetPriceCurrencyButton.dataset.targetCurrency || "").trim().toUpperCase()
            const originalLabel = toggleAssetPriceCurrencyButton.textContent

            if (!targetCurrency) {
                return
            }

            toggleAssetPriceCurrencyButton.disabled = true
            toggleAssetPriceCurrencyButton.textContent = `Cambiando a ${targetCurrency}...`

            try {
                await saveAssetDataToServer(buildCurrentAssetPayload())
                const response = await changeAssetCurrencyOnServer(currentAssetId, targetCurrency, "price")
                await updateAssetDetail(response.asset)
                renderAssetTablePage(response.asset)
                await refreshAssetsSidebar(currentAssetId, false)
            } catch (error) {
                console.error(error)
                alert(extractApiErrorMessage(error))
                toggleAssetPriceCurrencyButton.disabled = false
                toggleAssetPriceCurrencyButton.textContent = originalLabel
            }
        })
    }

    if (editAssetNameButton) {
        editAssetNameButton.addEventListener("click", async () => {
            try {
                await renameCurrentAsset()
            } catch (error) {
                console.error(error)
                alert("No se pudo actualizar el nombre del activo.")
            }
        })
    }

    if (saveAssetButton) {
        saveAssetButton.addEventListener("click", async () => {
            await saveAssetDataToServer(buildCurrentAssetPayload())
            await refreshAssetsSidebar(currentAssetId, false)
            alert("JSON del activo guardado")
        })
    }

    if (deleteAssetButton) {
        deleteAssetButton.addEventListener("click", () => {
            const rows = collectAssetRowsFromTable()
            const hasContent = rows.some((row) => {
                return row.fechaOperacion.trim() !== "" ||
                    !isPlaceholderValue(row.tipoOperacion, ["", "compra"]) ||
                    row.participaciones.trim() !== "" ||
                    parseEuroNumber(row.precioParticipacion) !== 0 ||
                    parseEuroNumber(row.capitalInvertidoBruto) !== 0 ||
                    parseEuroNumber(row.comisiones) !== 0
            })

            openConfirmModal({
                title: "Eliminar activo",
                message: hasContent
                    ? "Este activo tiene contenido guardado. ¿Quieres eliminarlo igualmente?"
                    : "¿Quieres eliminar este activo?",
                confirmLabel: "Eliminar",
                confirmSide: "right",
                onConfirm: async () => {
                    openConfirmModal({
                        title: "Segunda verificación",
                        message: "Esta acción eliminará el activo de forma definitiva. ¿Confirmas que quieres borrarlo?",
                        confirmLabel: "Eliminar",
                        confirmSide: "left",
                        onConfirm: async () => {
                            await deleteAssetOnServer(currentAssetId)
                            currentAssetId = null
                            const contentArea = document.getElementById("dynamicContent")

                            if (contentArea) {
                                contentArea.innerHTML = `<div class="placeholderPage">Activo eliminado.</div>`
                            }

                            await refreshAssetsSidebar(null, false)
                        }
                    })
                }
            })
        })
    }
}

function openAssetModal() {
    const assetModalOverlay = document.getElementById("assetModalOverlay")
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")
    const assetSearchResults = document.getElementById("assetSearchResults")

    if (!assetModalOverlay || !assetNameInput || !assetTypeSelect || !assetTickerInput || !assetSearchFeedback || !assetSearchResults) {
        return
    }

    assetNameInput.value = ""
    assetTypeSelect.value = "cripto"
    assetTickerInput.value = ""
    assetTickerInput.dataset.marketProvider = "finnhub"
    setAssetSearchFeedback(assetSearchFeedback, "")
    renderMarketSearchResults(assetSearchResults, [], () => {})
    assetModalOverlay.classList.remove("hidden")
    assetModalState = { isOpen: true }
    assetNameInput.focus()
}

function closeAssetModal() {
    const assetModalOverlay = document.getElementById("assetModalOverlay")

    if (!assetModalOverlay) {
        return
    }

    assetModalOverlay.classList.add("hidden")
    assetModalState = null
}

function openConfirmModal({ title = "Confirmar acción", message = "¿Seguro que quieres continuar?", confirmLabel = "Confirmar", onConfirm, confirmSide = "left" }) {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalTitle = document.getElementById("confirmModalTitle")
    const confirmModalMessage = document.getElementById("confirmModalMessage")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalActions = document.querySelector(".confirmModalActions")

    if (!confirmModalOverlay || !confirmModalTitle || !confirmModalMessage || !confirmModalAcceptButton || !confirmModalActions) {
        return
    }

    confirmModalTitle.textContent = title
    confirmModalMessage.textContent = message
    confirmModalAcceptButton.textContent = confirmLabel
    confirmModalActions.classList.toggle("confirmPrimaryRight", confirmSide === "right")
    confirmModalOverlay.classList.remove("hidden")
    confirmModalState = { onConfirm }
}

function closeConfirmModal() {
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")

    if (!confirmModalOverlay) {
        return
    }

    confirmModalOverlay.classList.add("hidden")
    document.querySelector(".confirmModalActions")?.classList.remove("confirmPrimaryRight")
    confirmModalState = null
}

function initConfirmModal(confirmModalOverlay, confirmModalAcceptButton, confirmModalCancelButton) {
    if (confirmModalAcceptButton) {
        confirmModalAcceptButton.addEventListener("click", async () => {
            const onConfirm = confirmModalState?.onConfirm
            closeConfirmModal()

            if (onConfirm) {
                await onConfirm()
            }
        })
    }

    if (confirmModalCancelButton) {
        confirmModalCancelButton.addEventListener("click", () => {
            closeConfirmModal()
        })
    }

    if (confirmModalOverlay) {
        confirmModalOverlay.addEventListener("click", (event) => {
            if (event.target === confirmModalOverlay) {
                closeConfirmModal()
            }
        })
    }
}

async function submitAssetModal() {
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")

    if (!assetNameInput || !assetTypeSelect || !assetTickerInput || !assetSearchFeedback) {
        return
    }

    const name = assetNameInput.value.trim()
    const type = assetTypeSelect.value.trim()
    const marketSymbol = assetTickerInput.value.trim().toUpperCase()
    const marketProvider = inferMarketProviderFromSymbol(
        marketSymbol,
        assetTickerInput.dataset.marketProvider || "finnhub"
    )

    if (!name) {
        setAssetSearchFeedback(assetSearchFeedback, "Introduce el nombre del activo.", true)
        assetNameInput.focus()
        return
    }

    if (!type) {
        setAssetSearchFeedback(assetSearchFeedback, "Selecciona el tipo de activo.", true)
        assetTypeSelect.focus()
        return
    }

    if (!marketSymbol) {
        setAssetSearchFeedback(assetSearchFeedback, "Introduce o selecciona el ticker de mercado.", true)
        assetTickerInput.focus()
        return
    }

    try {
        setAssetSearchFeedback(assetSearchFeedback, "")
        const response = await createAssetOnServer(name, type, marketSymbol, marketProvider)
        const createdAsset = response.asset
        closeAssetModal()
        currentAssetId = createdAsset.id
        await refreshAssetsSidebar(createdAsset.id, true)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(assetSearchFeedback, "No se pudo crear el activo.", true)
    }
}

function initEditAssetModal() {
    const editAssetModalOverlay = document.getElementById("editAssetModalOverlay")
    const editAssetNameInput = document.getElementById("editAssetNameInput")
    const confirmEditAssetModalButton = document.getElementById("confirmEditAssetModalBtn")
    const cancelEditAssetModalButton = document.getElementById("cancelEditAssetModalBtn")

    if (confirmEditAssetModalButton) {
        confirmEditAssetModalButton.addEventListener("click", async () => {
            try {
                await submitEditAssetModal()
            } catch (error) {
                console.error(error)
                alert("No se pudo actualizar el nombre del activo.")
            }
        })
    }

    if (cancelEditAssetModalButton) {
        cancelEditAssetModalButton.addEventListener("click", () => {
            closeEditAssetModal()
        })
    }

    if (editAssetNameInput) {
        editAssetNameInput.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()

                try {
                    await submitEditAssetModal()
                } catch (error) {
                    console.error(error)
                    alert("No se pudo actualizar el nombre del activo.")
                }
            }
        })
    }

    if (editAssetModalOverlay) {
        editAssetModalOverlay.addEventListener("click", (event) => {
            if (event.target === editAssetModalOverlay) {
                closeEditAssetModal()
            }
        })
    }
}

function initAddAssetButton(addAssetButton) {
    if (!addAssetButton) {
        return
    }

    addAssetButton.addEventListener("click", () => {
        openAssetModal()
    })
}

function initAssetModal(assetModalOverlay, confirmAssetModalButton, cancelAssetModalButton, assetNameInput, assetTypeSelect, assetTickerInput, searchAssetTickerFinnhubButton, searchAssetTickerEodhdButton) {
    const assetSearchFeedback = document.getElementById("assetSearchFeedback")
    const assetSearchResults = document.getElementById("assetSearchResults")
    initEditAssetModal()

    if (confirmAssetModalButton) {
        confirmAssetModalButton.addEventListener("click", async () => {
            await submitAssetModal()
        })
    }

    if (cancelAssetModalButton) {
        cancelAssetModalButton.addEventListener("click", () => {
            closeAssetModal()
        })
    }

    if (assetNameInput) {
        assetNameInput.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                await submitAssetModal()
            }
        })
    }

    if (assetTypeSelect) {
        assetTypeSelect.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                await submitAssetModal()
            }
        })
    }

    if (assetTickerInput) {
        assetTickerInput.addEventListener("keydown", async (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                await submitAssetModal()
            }
        })
    }

    const runTickerSelection = (result, providerName) => {
        if (assetTickerInput) {
            assetTickerInput.value = result.symbol
            assetTickerInput.dataset.marketProvider = String(result.provider || providerName).trim().toLowerCase()
        }

        if (assetNameInput && !assetNameInput.value.trim()) {
            assetNameInput.value = result.description
        }

        setAssetSearchFeedback(assetSearchFeedback, `Ticker seleccionado (${providerName}): ${result.symbol}`)
        renderMarketSearchResults(assetSearchResults, [], () => {})
    }

    if (searchAssetTickerFinnhubButton) {
        searchAssetTickerFinnhubButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleFinnhubSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "Finnhub")
            })
        })
    }

    if (searchAssetTickerEodhdButton) {
        searchAssetTickerEodhdButton.addEventListener("click", async () => {
            const typedTicker = assetTickerInput?.value.trim() || ""
            const typedName = assetNameInput?.value.trim() || ""
            const searchQuery = typedName || typedTicker

            await handleEodhdSearch({
                query: searchQuery,
                assetName: typedName,
                assetType: assetTypeSelect?.value || "",
                feedbackElement: assetSearchFeedback,
                resultsElement: assetSearchResults,
                onSelect: (result) => runTickerSelection(result, "EODHD")
            })
        })
    }

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && assetModalState?.isOpen) {
            closeAssetModal()
            return
        }

        if (event.key === "Escape" && editAssetModalState?.isOpen) {
            closeEditAssetModal()
            return
        }

        if (event.key === "Escape" && confirmModalState) {
            closeConfirmModal()
        }
    })
}

