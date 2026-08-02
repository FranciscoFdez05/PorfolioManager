const OPERATION_ORDER_OPTIONS = ["Compra", "Venta"]
const OPERATION_STATUS_OPTIONS = ["Activo", "Completado", "Cancelado"]
function getOperationCurrencyOptions() {
    return window._fiatCurrencies?.length ? window._fiatCurrencies : ["EUR", "USD", "GBP", "CHF", "JPY"]
}
const OPERATION_CURRENCY_OPTIONS = new Proxy([], {
    get(_, prop) {
        const arr = getOperationCurrencyOptions()
        if (prop === "length") return arr.length
        if (prop === "map") return arr.map.bind(arr)
        if (prop === "filter") return arr.filter.bind(arr)
        if (prop === "includes") return arr.includes.bind(arr)
        if (prop === Symbol.iterator) return arr[Symbol.iterator].bind(arr)
        if (typeof prop === "string" && !isNaN(prop)) return arr[Number(prop)]
        return arr[prop]
    }
})
const OPERATION_QUANTITY_DECIMALS = 8
const OPERATION_COMMON_QUOTE_SYMBOL_OPTIONS = ["USDC", "USDT", "DAI", "FDUSD", "PYUSD", "TUSD", "USDE", "EURC", "USD", "EUR", "BUSD"]

let currentOperationsData = { rows: [] }
let operationsAutosaveTimeout = null
let operationsAssetRefreshTimeout = null
let operationsPersistenceBound = false
let currentOperationTypeFilter = new Set(OPERATION_ORDER_OPTIONS)
let currentOperationStatusFilter = new Set(OPERATION_STATUS_OPTIONS)
let operationsAssets = []
let operationsStablecoinsData = { catalog: [], enabledSymbols: [], rows: [] }
let operationsTransaccionesRows = []


function showOperationsPopup(title, message, options = {}) {
    const confirmLabel = String(options.confirmLabel || "OK")

    if (typeof openConfirmModal === "function") {
        openConfirmModal({
            title: String(title || "Aviso"),
            message: String(message || ""),
            confirmLabel,
            onConfirm: options.onConfirm
        })
        return
    }

    alert(`${title ? `${title}\n\n` : ""}${message || ""}`)
}

async function loadOperacionesDependencies() {
    const [operationsResult, assetsResult, stablecoinsResult, transaccionesResult] = await Promise.allSettled([
        loadOperacionesData(),
        loadOperationAssets(),
        loadStablecoinsData(),
        (typeof loadTransaccionesData === "function" ? loadTransaccionesData() : Promise.resolve({ rows: [] }))
    ])

    if (operationsResult.status !== "fulfilled") {
        throw operationsResult.reason instanceof Error
            ? operationsResult.reason
            : new Error("No se pudieron cargar las operaciones")
    }

    if (assetsResult.status !== "fulfilled") {
        console.warn("No se pudieron cargar los activos para operaciones. Se mostrara la tabla sin selector de activos.", assetsResult.reason)
    }

    if (stablecoinsResult.status !== "fulfilled") {
        console.warn("No se pudieron cargar las stablecoins para operaciones. Se ocultaran los pares hasta que vuelvan a estar disponibles.", stablecoinsResult.reason)
    }

    if (transaccionesResult.status !== "fulfilled") {
        console.warn("No se pudieron cargar las transacciones para operaciones. El saldo no descontará comisiones de red.", transaccionesResult.reason)
    }

    return {
        operationsPayload: operationsResult.value,
        assets: assetsResult.status === "fulfilled" ? assetsResult.value : [],
        stablecoinsPayload: stablecoinsResult.status === "fulfilled" ? stablecoinsResult.value : { enabledSymbols: [], rows: [] },
        transaccionesPayload: transaccionesResult.status === "fulfilled" ? transaccionesResult.value : { rows: [] }
    }
}

async function loadOperacionesData() {
    const response = await fetch("/api/operaciones")

    if (!response.ok) {
        throw new Error("No se pudieron cargar las operaciones")
    }

    return await response.json()
}

async function saveOperacionesData(payload, options = {}) {
    const response = await fetch("/api/operaciones", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        keepalive: Boolean(options.keepalive)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function loadOperationAssets() {
    const response = await fetch("/api/activos")

    if (!response.ok) {
        throw new Error("No se pudieron cargar los activos para operaciones")
    }

    const payload = await response.json()
    const assets = Array.isArray(payload?.assets) ? payload.assets : []

    return assets
        .map((asset) => ({
            id: String(asset.id || "").trim(),
            name: String(asset.name || asset.symbol || "").trim(),
            symbol: String(asset.symbol || asset.name || "").trim().toUpperCase(),
            marketSymbol: String(asset.marketSymbol || asset.finnhubSymbol || "").trim().toUpperCase(),
            marketProvider: String(asset.marketProvider || "").trim().toLowerCase(),
            price: asset.price ?? null,
            currency: String(asset.currency || "EUR").trim(),
            precioCurrency: String(asset.precioCurrency || asset.currency || "EUR").trim()
        }))
        .map((asset) => ({
            ...asset,
            baseSymbol: deriveOperationAssetBaseSymbol(asset)
        }))
        .filter((asset) => asset.id && asset.name)
        .sort((left, right) => left.name.localeCompare(right.name, "es", { sensitivity: "base" }))
}

function deriveOperationAssetBaseSymbol(asset) {
    const marketSymbol = String(asset?.marketSymbol || "").trim().toUpperCase()
    const normalizedSymbol = String(asset?.symbol || asset?.name || "").trim().toUpperCase()
    const knownQuoteSymbols = getOperationKnownQuoteSymbolsForAssetParsing()

    if (marketSymbol.includes(":")) {
        const symbolPart = marketSymbol.split(":").pop() || ""

        for (const stablecoinSymbol of knownQuoteSymbols) {
            if (symbolPart.endsWith(stablecoinSymbol)) {
                return symbolPart.slice(0, -stablecoinSymbol.length) || normalizedSymbol
            }
        }

        return symbolPart || normalizedSymbol
    }

    if (marketSymbol.includes("/")) {
        return marketSymbol.split("/")[0] || normalizedSymbol
    }

    return normalizedSymbol
}

function normalizeOperationsStablecoinsPayload(payload = {}) {
    const catalog = Array.isArray(payload.catalog)
        ? payload.catalog
            .map((entry) => ({
                symbol: String(entry?.symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""),
                marketSymbol: String(entry?.marketSymbol || entry?.symbol || "").trim().toUpperCase()
            }))
            .filter((entry, index, array) => entry.symbol && array.findIndex((item) => item.symbol === entry.symbol) === index)
        : []
    const enabledSymbols = Array.isArray(payload.enabledSymbols)
        ? payload.enabledSymbols
            .map((symbol) => String(symbol || "").trim().toUpperCase())
            .filter((symbol, index, array) => symbol && array.indexOf(symbol) === index)
        : []
    const fallbackCatalog = catalog.length
        ? catalog
        : enabledSymbols.map((symbol) => ({ symbol, marketSymbol: symbol }))
    const fallbackSymbols = new Set(fallbackCatalog.map((entry) => entry.symbol))

    const rows = Array.isArray(payload.rows) ? payload.rows.map((row, index) => ({
        id: String(row.id || `stablecoin-${index + 1}`),
        stablecoinSymbol: String(row.stablecoinSymbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""),
        tipo: String(row.tipo || "").trim(),
        cantidad: String(row.cantidad || "").trim(),
        total: String(row.total || "").trim()
    })) : []

    return {
        catalog: fallbackCatalog,
        enabledSymbols: enabledSymbols.filter((symbol) => fallbackSymbols.has(symbol)),
        rows
    }
}

function getOperationKnownQuoteSymbolsForAssetParsing(payload = operationsStablecoinsData) {
    const normalized = normalizeOperationsStablecoinsPayload(payload)
    const symbols = [
        ...normalized.catalog.map((entry) => entry.symbol),
        ...normalized.enabledSymbols,
        ...OPERATION_COMMON_QUOTE_SYMBOL_OPTIONS
    ]

    return symbols.filter((symbol, index, array) => symbol && array.indexOf(symbol) === index)
}

function getOperationsEnabledStablecoinSymbols() {
    return normalizeOperationsStablecoinsPayload(operationsStablecoinsData).enabledSymbols
}

function getOperationStablecoinSymbol(row = {}) {
    const explicitSymbol = String(row.stablecoinSymbol || "").trim().toUpperCase()
    const enabledSymbols = getOperationsEnabledStablecoinSymbols()

    if (enabledSymbols.includes(explicitSymbol)) {
        return explicitSymbol
    }

    const pair = String(row.par || "").trim().toUpperCase()
    const quoteSymbol = pair.includes("/") ? pair.split("/").pop() : ""

    return enabledSymbols.includes(quoteSymbol) ? quoteSymbol : ""
}

function getOperationFiatSymbol(row = {}) {
    const pair = String(row.par || "").trim().toUpperCase()
    const quoteSymbol = pair.includes("/") ? pair.split("/").pop() : ""
    return OPERATION_CURRENCY_OPTIONS.map((c) => c.toUpperCase()).includes(quoteSymbol) ? quoteSymbol : ""
}

function getOperationsStablecoinSymbolFromTransaccionRow(row = {}) {
    const assetId = String(row.assetId || "").trim()

    if (!assetId.startsWith("stablecoin-")) {
        return ""
    }

    const symbol = assetId.slice("stablecoin-".length)
    return getOperationsEnabledStablecoinSymbols().includes(symbol) ? symbol : ""
}

function getOperationsNetworkFeesByStablecoinSymbol(transaccionesRows = []) {
    const totals = {}

    ;(transaccionesRows || []).forEach((row) => {
        if (typeof normalizeTransaccionWalletTipo !== "function") {
            return
        }

        const walletType = normalizeTransaccionWalletTipo(row.walletTipo)

        if (walletType !== "enviada" && walletType !== "entre_wallet") {
            return
        }

        const symbol = getOperationsStablecoinSymbolFromTransaccionRow(row)
        if (!symbol) {
            return
        }

        const fee = Math.max(0, parseLooseNumber(row.comisionRed) || 0)
        if (fee <= 0) {
            return
        }

        totals[symbol] = (totals[symbol] || 0) + fee
    })

    return totals
}

function getOperationsLockedStablecoinTotalsFromActiveBuys(operationsRows = [], options = {}) {
    const excludeRowId = String(options.excludeRowId || "").trim()
    const lockedTotals = {}

    ;(operationsRows || []).forEach((row) => {
        if (excludeRowId && String(row.id || "").trim() === excludeRowId) {
            return
        }

        if (String(row.estado || "").trim() !== "Activo") {
            return
        }

        if (String(row.orden || "").trim() !== "Compra") {
            return
        }

        const symbol = getOperationStablecoinSymbol(row)
        if (!symbol) {
            return
        }

        const total = parseLooseNumber(row.total) || 0
        if (total <= 0) {
            return
        }

        lockedTotals[symbol] = (lockedTotals[symbol] || 0) + total
    })

    return lockedTotals
}

function getOperationsLockedFiatTotalsFromActiveBuys(operationsRows = [], options = {}) {
    const excludeRowId = String(options.excludeRowId || "").trim()
    const lockedTotals = {}

    ;(operationsRows || []).forEach((row) => {
        if (excludeRowId && String(row.id || "").trim() === excludeRowId) {
            return
        }

        if (String(row.estado || "").trim() !== "Activo") {
            return
        }

        if (String(row.orden || "").trim() !== "Compra") {
            return
        }

        const symbol = getOperationFiatSymbol(row)
        if (!symbol) {
            return
        }

        const total = parseLooseNumber(row.total) || 0
        if (total <= 0) {
            return
        }

        lockedTotals[symbol] = (lockedTotals[symbol] || 0) + total
    })

    return lockedTotals
}

function buildOperationsStablecoinBalanceSummary(stablecoinsPayload = operationsStablecoinsData, operationsRows = currentOperationsData.rows || []) {
    const normalizedPayload = normalizeOperationsStablecoinsPayload(stablecoinsPayload)
    const summary = {}

    normalizedPayload.enabledSymbols.forEach((symbol) => {
        summary[symbol] = {
            symbol,
            manualBuys: 0,
            manualExpenses: 0,
            operationsBuys: 0,
            operationsSales: 0,
            balance: 0,
            locked: 0,
            available: 0
        }
    })

    normalizedPayload.rows.forEach((row) => {
        const symbol = row.stablecoinSymbol
        const amount = parseLooseNumber(row.cantidad) || 0

        if (!summary[symbol]) {
            return
        }

        if (row.tipo === "Compra") {
            summary[symbol].manualBuys += amount
        } else if (row.tipo === "Venta" || row.tipo === "Gasto") {
            summary[symbol].manualExpenses += amount
        }
    })

    ;(operationsRows || []).forEach((row) => {
        const symbol = getOperationStablecoinSymbol(row)

        if (!summary[symbol] || String(row.estado || "").trim() !== "Completado") {
            return
        }

        const total = parseLooseNumber(row.total) || 0

        if (String(row.orden || "").trim() === "Compra") {
            summary[symbol].operationsBuys += total
        } else if (String(row.orden || "").trim() === "Venta") {
            summary[symbol].operationsSales += total
        }
    })

    const lockedTotals = getOperationsLockedStablecoinTotalsFromActiveBuys(operationsRows || [])
    const networkFeesTotals = getOperationsNetworkFeesByStablecoinSymbol(operationsTransaccionesRows || [])

    Object.values(summary).forEach((item) => {
        item.balance = item.manualBuys - item.manualExpenses - item.operationsBuys + item.operationsSales
        item.balance = item.balance - (networkFeesTotals[item.symbol] || 0)
        item.locked = lockedTotals[item.symbol] || 0
        item.available = Math.max(0, item.balance - item.locked)
    })

    return summary
}

function getOperationAssetById(assetId) {
    return operationsAssets.find((asset) => asset.id === assetId) || null
}

function findOperationAssetByName(name) {
    const normalizedName = String(name || "").trim().toLowerCase()
    return operationsAssets.find((asset) => asset.name.toLowerCase() === normalizedName || asset.symbol.toLowerCase() === normalizedName) || null
}

function getOperationPairOptions(assetId) {
    const asset = getOperationAssetById(assetId)
    const enabledStablecoins = getOperationsEnabledStablecoinSymbols()
    const fiatCurrencies = OPERATION_CURRENCY_OPTIONS
        .map((c) => String(c || "").trim().toUpperCase())
        .filter(Boolean)

    if (!asset) {
        return []
    }

    const quoteSymbols = [...enabledStablecoins, ...fiatCurrencies]
        .map((symbol) => String(symbol || "").trim().toUpperCase())
        .filter((symbol, index, array) => symbol && array.indexOf(symbol) === index)

    return quoteSymbols.map((quoteSymbol) => `${asset.baseSymbol || asset.symbol}/${quoteSymbol}`)
}

function normalizeOperationRow(row = {}, index = 0) {
    const inferredAsset = findOperationAssetByName(row.activo || "")
    const assetId = String(row.assetId || inferredAsset?.id || "").trim()
    const asset = getOperationAssetById(assetId) || inferredAsset
    const stablecoinSymbol = getOperationStablecoinSymbol(row)
    const pairOptions = getOperationPairOptions(asset?.id || assetId)
    const defaultPair = stablecoinSymbol && asset ? `${asset.baseSymbol || asset.symbol}/${stablecoinSymbol}` : (pairOptions[0] || "")
    const pair = String(row.par || defaultPair || "").trim()
    const quoteSymbol = pair.includes("/") ? pair.split("/").pop() : ""
    const inferredCurrency = normalizeCurrencyCode(quoteSymbol || stablecoinSymbol || "USD")

    return {
        id: String(row.id || `operacion-${index + 1}`).trim() || `operacion-${index + 1}`,
        assetId: asset?.id || assetId,
        activo: asset?.name || String(row.activo || "").trim(),
        fechaApertura: String(row.fechaApertura || row.fecha || "").trim(),
        par: pair,
        stablecoinSymbol,
        orden: OPERATION_ORDER_OPTIONS.includes(String(row.orden || "").trim()) ? String(row.orden).trim() : "Compra",
        precioOrden: String(row.precioOrden || row.precio || "").trim(),
        precioCurrency: inferredCurrency,
        cantidad: String(row.cantidad || "").trim(),
        comisionesCripto: String(row.comisionesCripto || row.comisiones || "").trim(),
        total: String(row.total || "").trim(),
        currency: inferredCurrency,
        estado: OPERATION_STATUS_OPTIONS.includes(String(row.estado || "").trim()) ? String(row.estado).trim() : "Activo",
        fechaCierre: String(row.fechaCierre || "").trim()
    }
}

async function refreshOperationsTickerPrices() {
    const operationsBody = document.getElementById("operationsBody")
    if (!operationsBody) return
    try {
        operationsAssets = await loadOperationAssets()
    } catch { /* mantener activos existentes */ }
    operationsBody.querySelectorAll("tr[data-operation-id]").forEach((tr) => refreshOperationsRowPrice(tr))
}

async function initOperacionesLogic() {
    const { operationsPayload, assets, stablecoinsPayload, transaccionesPayload } = await loadOperacionesDependencies()

    operationsAssets = assets
    operationsStablecoinsData = normalizeOperationsStablecoinsPayload(stablecoinsPayload)
    operationsTransaccionesRows = Array.isArray(transaccionesPayload?.rows) ? transaccionesPayload.rows : []
    currentOperationsData = {
        rows: Array.isArray(operationsPayload?.rows)
            ? operationsPayload.rows.map((row, index) => normalizeOperationRow(row, index))
            : []
    }
    currentOperationTypeFilter = loadOperationsFilterState("type", OPERATION_ORDER_OPTIONS)
    currentOperationStatusFilter = loadOperationsFilterState("status", OPERATION_STATUS_OPTIONS)
    bindOperationsPersistenceGuards()
    window.flushPendingPageChanges = flushOperationsPendingChanges
    renderOperationsFilterState()
    renderOperationsStablecoinPanel()
    renderOperationsTable()
    scheduleOperationsAssetRefresh(0)
    bindOperationsEvents()
}

function bindOperationsEvents() {
    const operationsBody = document.getElementById("operationsBody")
    const addButton = document.getElementById("addOperationRowBtn")
    const saveButton = document.getElementById("saveOperationsBtn")
    const filterInputs = document.querySelectorAll(".operationsFilters input[type='checkbox']")

    if (operationsBody && !operationsBody.dataset.bound) {
        operationsBody.dataset.bound = "true"
        operationsBody.addEventListener("click", handleOperationsDeleteClick)
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            openOperacionRowModal("")
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistOperationsData()
                showOperationsPopup("Guardado", "Datos guardados en data/operaciones.json")
            } catch (error) {
                console.error(error)
                showOperationsPopup("Error", "No se pudieron guardar las operaciones.")
            }
        })
    }

    filterInputs.forEach((input) => {
        if (input.dataset.bound) {
            return
        }

        input.dataset.bound = "true"
        input.addEventListener("change", () => {
            syncOperationsDataFromTable()
            const group = input.dataset.filterGroup
            const value = input.value

            if (group === "type") {
                updateOperationsFilterSet(currentOperationTypeFilter, value, input.checked)
            } else if (group === "status") {
                updateOperationsFilterSet(currentOperationStatusFilter, value, input.checked)
            }

            saveOperationsFilterState()
            renderOperationsFilterState()
            renderOperationsTable()
        })
    })
}

function updateOperationsFilterSet(targetSet, value, checked) {
    if (checked) {
        targetSet.add(value)
    } else {
        targetSet.delete(value)
    }
}

function loadOperationsFilterState(group, defaults) {
    try {
        const raw = localStorage.getItem(`operationsFilter_${group}`)
        if (raw) {
            const parsed = JSON.parse(raw)
            if (Array.isArray(parsed)) return new Set(parsed)
        }
    } catch { /* ignorar */ }
    return new Set(defaults)
}

function saveOperationsFilterState() {
    try {
        localStorage.setItem("operationsFilter_type", JSON.stringify([...currentOperationTypeFilter]))
        localStorage.setItem("operationsFilter_status", JSON.stringify([...currentOperationStatusFilter]))
    } catch { /* ignorar */ }
}

function createEmptyOperationRow() {
    const firstAsset = operationsAssets[0] || null
    const assetId = firstAsset?.id || ""
    const pairOptions = getOperationPairOptions(assetId)
    const pair = pairOptions[0] || ""
    const quoteSymbol = pair ? pair.split("/").pop() : ""
    const stablecoinSymbol = getOperationStablecoinSymbol({ par: pair })
    const moneyCurrency = normalizeCurrencyCode(quoteSymbol || stablecoinSymbol || "USD")

    return normalizeOperationRow({
        id: `operacion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        assetId,
        activo: firstAsset?.name || "",
        fechaApertura: "",
        par: pair,
        stablecoinSymbol,
        orden: "Compra",
        precioOrden: "",
        precioCurrency: moneyCurrency,
        cantidad: "",
        comisionesCripto: "",
        total: "",
        currency: moneyCurrency,
        estado: "Activo",
        fechaCierre: ""
    })
}

function renderOperationsFilterState() {
    document.querySelectorAll('.operationsFilters input[data-filter-group="type"]').forEach((input) => {
        input.checked = currentOperationTypeFilter.has(input.value)
    })

    document.querySelectorAll('.operationsFilters input[data-filter-group="status"]').forEach((input) => {
        input.checked = currentOperationStatusFilter.has(input.value)
    })
}

function getFilteredOperationsRows() {
    return (currentOperationsData.rows || []).filter((row) => {
        const typeMatches = currentOperationTypeFilter.has(row.orden)
        const statusMatches = currentOperationStatusFilter.has(row.estado)
        return typeMatches && statusMatches
    })
}

function renderOperationsStablecoinPanel() {
    const panel = document.getElementById("operationsPairsSummary")

    if (!panel) {
        return
    }

    const enabledStablecoins = getOperationsEnabledStablecoinSymbols()

    const fiatLocked = getOperationsLockedFiatTotalsFromActiveBuys(currentOperationsData.rows || [])
    const fiatItems = Object.entries(fiatLocked)
        .filter(([, locked]) => locked > 0)
        .map(([symbol, locked]) => ({ symbol, locked }))

    if (!enabledStablecoins.length && !fiatItems.length) {
        panel.innerHTML = ""
        panel.classList.add("hidden")
        return
    }

    panel.classList.remove("hidden")
    const summary = buildOperationsStablecoinBalanceSummary(operationsStablecoinsData, currentOperationsData.rows || [])
    const stablecoinItems = Object.values(summary)

    panel.innerHTML = `
        <span class="operationsPairsSummaryLabel">Par - saldo disponible</span>
        <div class="operationsPairsSummaryValues">
            ${stablecoinItems.map((item) => `
                <span class="operationsPairsSummaryItem">
                    ${item.symbol} ${formatMoney(item.available, "USD")}
                    <span class="operationsPairsSummaryHint">(bloqueado ${formatMoney(item.locked, "USD")})</span>
                </span>
            `).join("")}
            ${fiatItems.map((item) => `
                <span class="operationsPairsSummaryItem">
                    ${item.symbol}
                    <span class="operationsPairsSummaryHint">(bloqueado ${formatMoney(item.locked, item.symbol)})</span>
                </span>
            `).join("")}
        </div>
    `
}

function renderOperationsTable() {
    const operationsBody = document.getElementById("operationsBody")

    if (!operationsBody) {
        return
    }

    operationsBody.innerHTML = ""

    const rows = getFilteredOperationsRows()

    const operacionesEmptyEl = document.getElementById("operacionesEmptyMsg")
    const operationsTableWrapper = document.querySelector(".operationsTableWrapper")
    if (!rows.length) {
        if (operacionesEmptyEl) operacionesEmptyEl.classList.remove("hidden")
        if (operationsTableWrapper) operationsTableWrapper.classList.add("hidden")
        renderOperationsStablecoinPanel()
        return
    }
    if (operacionesEmptyEl) operacionesEmptyEl.classList.add("hidden")
    if (operationsTableWrapper) operationsTableWrapper.classList.remove("hidden")

    rows.forEach((row) => {
        operationsBody.appendChild(buildOperationRow(row))
    })

    rows.forEach((row) => {
        const tr = operationsBody.querySelector(`tr[data-operation-id="${row.id}"]`)
        if (tr) refreshOperationsRowPrice(tr)
    })

    renderOperationsStablecoinPanel()
    bindTableSort(operationsBody.closest("table"), "operaciones")
}

function refreshOperationsRowPrice(tr) {
    const priceEl = tr.querySelector(".operationsTickerPrice")
    if (!priceEl) return
    const rowId = tr.dataset.operationId
    const rowData = (currentOperationsData.rows || []).find((r) => r.id === rowId)
    if (!rowData) { priceEl.textContent = ""; return }
    const asset = getOperationAssetById(rowData.assetId)
    const price = parseLooseNumber(asset?.price)
    if (!asset || price === null || price <= 0) {
        priceEl.textContent = ""
        priceEl.className = "operationsTickerPrice"
        return
    }
    priceEl.textContent = formatMoney(price, asset.precioCurrency || asset.currency || "EUR")
    priceEl.className = "operationsTickerPrice"
}

function buildOperationRow(row) {
    const normalizedRow = normalizeOperationRow(row)
    const tr = document.createElement("tr")
    tr.dataset.operationId = normalizedRow.id
    tr.innerHTML = `
        <td>${normalizedRow.activo || ""}</td>
        <td>${normalizedRow.fechaApertura || ""}</td>
        <td>${normalizedRow.par || ""}</td>
        <td class="operationsTickerCell">
            <span class="operationsTickerPrice"></span>
        </td>
        <td>${normalizedRow.orden || ""}</td>
        <td>${formatOperationsMoney(normalizedRow.precioOrden, normalizedRow.precioCurrency || "USD")}</td>
        <td>${formatOperationsQuantity(normalizedRow.cantidad)}</td>
        <td>${formatOperationsQuantity(normalizedRow.comisionesCripto)}</td>
        <td>${formatOperationsMoney(normalizedRow.total, normalizedRow.currency || "USD")}</td>
        <td>${normalizedRow.estado || ""}</td>
        <td>${normalizedRow.fechaCierre || ""}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn operacionRowEditBtn avActionBtn avEditBtn" data-row-id="${normalizedRow.id}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn operacionRowDeleteBtn avActionBtn avDeleteBtn" data-row-id="${normalizedRow.id}">Eliminar</button>
                </div>
            </div>
        </td>
    `
    return tr
}

function scheduleOperationsAssetRefresh(delay = 250) {
    if (typeof setExternalOperacionesRowsForAssets === "function") {
        setExternalOperacionesRowsForAssets(currentOperationsData.rows || [])
    }

    if (typeof refreshSelectedAssetFromExternalData !== "function") {
        return
    }

    window.clearTimeout(operationsAssetRefreshTimeout)
    operationsAssetRefreshTimeout = window.setTimeout(() => {
        refreshSelectedAssetFromExternalData().catch((error) => {
            console.error("Error refrescando el panel del activo desde operaciones:", error)
        })
    }, delay)
}

function formatOperationsQuantity(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString("es-ES", {
        minimumFractionDigits: OPERATION_QUANTITY_DECIMALS,
        maximumFractionDigits: OPERATION_QUANTITY_DECIMALS
    })
}

function formatOperationsMoney(value, currency = "EUR") {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return formatMoney(0, currency)
    }

    return formatMoney(parsedValue, currency)
}

function handleOperationsDeleteClick(event) {
    const editButton = event.target.closest(".operacionRowEditBtn")
    if (editButton) {
        syncOperationsDataFromTable()
        openOperacionRowModal(editButton.dataset.rowId)
        return
    }

    const deleteButton = event.target.closest(".operacionRowDeleteBtn")
    if (deleteButton) {
        const rowId = deleteButton.dataset.rowId
        if (!rowId) return
        openConfirmModal({
            title: "Eliminar fila",
            message: "¿Quieres eliminar esta operación? Pasará al estado Cancelado.",
            confirmLabel: "Eliminar",
            onConfirm: () => {
                const rows = currentOperationsData.rows || []
                const targetIndex = rows.findIndex((item) => item.id === rowId)
                if (targetIndex >= 0) {
                    rows[targetIndex] = normalizeOperationRow({ ...rows[targetIndex], estado: "Cancelado" })
                }
                renderOperationsTable()
                scheduleOperationsAssetRefresh()
                scheduleOperationsAutosave()
            }
        })
    }
}


function syncOperationsDataFromTable() {
    // Table is display-only; data is managed directly in currentOperationsData.rows via the modal
}

function scheduleOperationsAutosave(delay = 500) {
    window.clearTimeout(operationsAutosaveTimeout)
    operationsAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistOperationsData()
        } catch (error) {
            showError("No se pudieron guardar las operaciones", error)
        }
    }, delay)
}

async function persistOperationsData(options = {}) {
    syncOperationsDataFromTable()
    window.clearTimeout(operationsAutosaveTimeout)
    window.clearTimeout(operationsAssetRefreshTimeout)
    if (typeof setExternalOperacionesRowsForAssets === "function") {
        setExternalOperacionesRowsForAssets(currentOperationsData.rows || [])
    }
    await saveOperacionesData(currentOperationsData, options)
    if (typeof refreshSelectedAssetFromExternalData === "function") {
        await refreshSelectedAssetFromExternalData()
    }
}

async function flushOperationsPendingChanges() {
    if (!document.getElementById("operationsBody")) {
        return
    }

    await persistOperationsData({ keepalive: true })
}

function bindOperationsPersistenceGuards() {
    if (operationsPersistenceBound) {
        return
    }

    operationsPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!document.getElementById("operationsBody")) {
            return
        }

        persistOperationsData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar operaciones al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || !document.getElementById("operationsBody")) {
            return
        }

        persistOperationsData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar operaciones al cambiar de ventana:", error)
        })
    })
}

function openOperacionRowModal(rowId) {
    document.getElementById("operacionRowModalOverlay")?.remove()

    const rowIndex = (currentOperationsData.rows || []).findIndex((r) => r.id === rowId)
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? normalizeOperationRow({ ...currentOperationsData.rows[rowIndex] }) : createEmptyOperationRow()

    const assetOptions = operationsAssets.map((a) => `<option value="${a.id}"${rowData.assetId === a.id ? " selected" : ""}>${a.name}</option>`).join("")
    const pairOptions = getOperationPairOptions(rowData.assetId)
    const selectedPair = pairOptions.includes(rowData.par) ? rowData.par : (pairOptions[0] || "")
    const pairOptionsHtml = pairOptions.length
        ? pairOptions.map((p) => `<option value="${p}"${p === selectedPair ? " selected" : ""}>${p}</option>`).join("")
        : `<option value="${rowData.par || ""}">${rowData.par || "Sin pares"}</option>`

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Activo</label>
            <select id="opModalAsset" class="assetRowModalSelect">
                <option value=""></option>
                ${assetOptions}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha apertura</label>
            <input id="opModalFecha" class="assetRowModalInput" type="text" value="${rowData.fechaApertura || ""}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Par</label>
            <select id="opModalPar" class="assetRowModalSelect">
                ${pairOptionsHtml}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Orden</label>
            <select id="opModalOrden" class="assetRowModalSelect">
                ${OPERATION_ORDER_OPTIONS.map((o) => `<option value="${o}"${rowData.orden === o ? " selected" : ""}>${o}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Precio orden</label>
            <input id="opModalPrecio" class="assetRowModalInput" type="text" inputmode="decimal" value="${stripCurrencyText(rowData.precioOrden || "")}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Cantidad</label>
            <input id="opModalCantidad" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.cantidad || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisiones cripto</label>
            <input id="opModalComisiones" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.comisionesCripto || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Total</label>
            <input id="opModalTotal" class="assetRowModalInput" type="text" inputmode="decimal" value="${stripCurrencyText(rowData.total || "")}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Estado</label>
            <select id="opModalEstado" class="assetRowModalSelect">
                ${OPERATION_STATUS_OPTIONS.map((s) => `<option value="${s}"${rowData.estado === s ? " selected" : ""}>${s}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha cierre</label>
            <input id="opModalFechaCierre" class="assetRowModalInput" type="text" value="${rowData.fechaCierre || ""}" placeholder="dd-mm-aaaa">
        </div>
    `

    const overlay = document.createElement("div")
    overlay.id = "operacionRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowId = rowId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const titleEl = document.createElement("h3")
    titleEl.className = "assetModalTitle assetRowModalTitle"
    titleEl.textContent = isEdit ? "Editar operación" : "Añadir operación"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = fieldsHtml

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        ${isEdit ? `<button type="button" id="opRowModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
        <button type="button" id="opRowModalCancelBtn" class="cancelButton">Cancelar</button>
        <button type="button" id="opRowModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
    `

    fields.querySelector("#opModalAsset").addEventListener("change", () => {
        const assetId = fields.querySelector("#opModalAsset").value
        const pairs = getOperationPairOptions(assetId)
        const parSelect = fields.querySelector("#opModalPar")
        parSelect.innerHTML = pairs.length
            ? pairs.map((p) => `<option value="${p}">${p}</option>`).join("")
            : `<option value="">Sin pares</option>`
    })


    footer.querySelector("#opRowModalSaveBtn").addEventListener("click", saveOperacionRowFromModal)
    footer.querySelector("#opRowModalCancelBtn").addEventListener("click", closeOperacionRowModal)

    if (isEdit) {
        footer.querySelector("#opRowModalDeleteBtn").addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar fila",
                message: "¿Quieres eliminar esta operación? Pasará al estado Cancelado.",
                confirmLabel: "Eliminar",
                onConfirm: () => {
                    const rows = currentOperationsData.rows || []
                    const targetIndex = rows.findIndex((r) => r.id === rowId)
                    if (targetIndex >= 0) {
                        rows[targetIndex] = normalizeOperationRow({ ...rows[targetIndex], estado: "Cancelado" })
                    }
                    renderOperationsTable()
                    renderOperationsStablecoinPanel()
                    scheduleOperationsAssetRefresh()
                    scheduleOperationsAutosave()
                }
            })
            closeOperacionRowModal()
        })
    }

    modal.appendChild(titleEl)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

function closeOperacionRowModal() {
    document.getElementById("operacionRowModalOverlay")?.remove()
}

function saveOperacionRowFromModal() {
    const overlay = document.getElementById("operacionRowModalOverlay")
    const rowId = overlay?.dataset.rowId || ""
    const g = (id) => document.getElementById(id)?.value ?? ""

    const rowData = normalizeOperationRow({
        id: rowId || `operacion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        assetId: g("opModalAsset"),
        fechaApertura: g("opModalFecha"),
        par: g("opModalPar"),
        orden: g("opModalOrden"),
        precioOrden: g("opModalPrecio"),
        cantidad: g("opModalCantidad"),
        comisionesCripto: g("opModalComisiones"),
        total: g("opModalTotal"),
        estado: g("opModalEstado"),
        fechaCierre: g("opModalFechaCierre")
    })

    if (rowData.estado === "Activo" && rowData.orden === "Compra") {
        const symbol = getOperationStablecoinSymbol(rowData)
        const required = parseLooseNumber(rowData.total) || 0

        if (symbol && required > 0) {
            const operationsRowsWithoutCurrent = (currentOperationsData.rows || []).filter((r) => r.id !== rowId)
            const summary = buildOperationsStablecoinBalanceSummary(operationsStablecoinsData, operationsRowsWithoutCurrent)
            const available = summary[symbol]?.available ?? 0

            if (required > available) {
                showOperationsPopup(
                    "Saldo insuficiente",
                    `Saldo insuficiente en ${symbol}. Disponible: ${formatMoney(available, "USD")} | Requerido: ${formatMoney(required, "USD")}`
                )
                return
            }
        }
    }

    const rowIndex = (currentOperationsData.rows || []).findIndex((r) => r.id === rowId)
    if (rowIndex >= 0) {
        currentOperationsData.rows[rowIndex] = rowData
    } else {
        currentOperationsData.rows.push(rowData)
    }

    renderOperationsTable()
    renderOperationsStablecoinPanel()
    scheduleOperationsAssetRefresh()
    scheduleOperationsAutosave()
    closeOperacionRowModal()
}
