const OPERATION_ORDER_OPTIONS = ["Compra", "Venta"]
const OPERATION_STATUS_OPTIONS = ["Activo", "Cerrado", "Completado"]
const OPERATION_CURRENCY_OPTIONS = ["EUR", "USD"]
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

async function loadOperacionesDependencies() {
    const [operationsResult, assetsResult, stablecoinsResult] = await Promise.allSettled([
        loadOperacionesData(),
        loadOperationAssets(),
        loadStablecoinsData()
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

    return {
        operationsPayload: operationsResult.value,
        assets: assetsResult.status === "fulfilled" ? assetsResult.value : [],
        stablecoinsPayload: stablecoinsResult.status === "fulfilled" ? stablecoinsResult.value : { enabledSymbols: [], rows: [] }
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
            marketSymbol: String(asset.marketSymbol || asset.finnhubSymbol || "").trim().toUpperCase()
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
    const knownQuoteSymbols = getOperationKnownStablecoinSymbols()

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

function getOperationKnownStablecoinSymbols(payload = operationsStablecoinsData) {
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
    const knownSymbols = getOperationKnownStablecoinSymbols()

    if (knownSymbols.includes(explicitSymbol)) {
        return explicitSymbol
    }

    const pair = String(row.par || "").trim().toUpperCase()
    const quoteSymbol = pair.includes("/") ? pair.split("/").pop() : ""

    return knownSymbols.includes(quoteSymbol) ? quoteSymbol : ""
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

    Object.values(summary).forEach((item) => {
        item.available = item.manualBuys - item.manualExpenses - item.operationsBuys + item.operationsSales
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

    if (!asset) {
        return []
    }

    return enabledStablecoins.map((stablecoinSymbol) => `${asset.baseSymbol || asset.symbol}/${stablecoinSymbol}`)
}

function normalizeOperationRow(row = {}, index = 0) {
    const inferredAsset = findOperationAssetByName(row.activo || "")
    const assetId = String(row.assetId || inferredAsset?.id || "").trim()
    const asset = getOperationAssetById(assetId) || inferredAsset
    const stablecoinSymbol = getOperationStablecoinSymbol(row)
    const pairOptions = getOperationPairOptions(asset?.id || assetId)
    const defaultPair = stablecoinSymbol && asset ? `${asset.baseSymbol || asset.symbol}/${stablecoinSymbol}` : (pairOptions[0] || "")
    const pair = String(row.par || defaultPair || "").trim()
    const priceCurrency = OPERATION_CURRENCY_OPTIONS.includes(String(row.precioCurrency || "").toUpperCase())
        ? String(row.precioCurrency).toUpperCase()
        : normalizeCurrencyCode(stablecoinSymbol || row.currency || "USD")
    const currency = OPERATION_CURRENCY_OPTIONS.includes(String(row.currency || "").toUpperCase())
        ? String(row.currency).toUpperCase()
        : normalizeCurrencyCode(stablecoinSymbol || row.precioCurrency || "USD")

    return {
        id: String(row.id || `operacion-${index + 1}`).trim() || `operacion-${index + 1}`,
        assetId: asset?.id || assetId,
        activo: asset?.name || String(row.activo || "").trim(),
        fechaApertura: String(row.fechaApertura || row.fecha || "").trim(),
        par: pair,
        stablecoinSymbol: stablecoinSymbol || (pair.includes("/") ? pair.split("/").pop() : ""),
        orden: OPERATION_ORDER_OPTIONS.includes(String(row.orden || "").trim()) ? String(row.orden).trim() : "Compra",
        precioOrden: String(row.precioOrden || row.precio || "").trim(),
        precioCurrency: priceCurrency,
        cantidad: String(row.cantidad || "").trim(),
        comisionesCripto: String(row.comisionesCripto || row.comisiones || "").trim(),
        total: String(row.total || "").trim(),
        currency,
        estado: OPERATION_STATUS_OPTIONS.includes(String(row.estado || "").trim()) ? String(row.estado).trim() : "Activo",
        fechaCierre: String(row.fechaCierre || "").trim()
    }
}

async function initOperacionesLogic() {
    const { operationsPayload, assets, stablecoinsPayload } = await loadOperacionesDependencies()

    operationsAssets = assets
    operationsStablecoinsData = normalizeOperationsStablecoinsPayload(stablecoinsPayload)
    currentOperationsData = {
        rows: Array.isArray(operationsPayload?.rows)
            ? operationsPayload.rows.map((row, index) => normalizeOperationRow(row, index))
            : []
    }
    currentOperationTypeFilter = new Set(OPERATION_ORDER_OPTIONS)
    currentOperationStatusFilter = new Set(OPERATION_STATUS_OPTIONS)
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
    const exportButton = document.getElementById("exportOperationsBtn")
    const importButton = document.getElementById("importOperationsBtn")
    const filterInputs = document.querySelectorAll(".operationsFilters input[type='checkbox']")

    if (operationsBody && !operationsBody.dataset.bound) {
        operationsBody.dataset.bound = "true"
        operationsBody.addEventListener("click", handleOperationsDeleteClick)
        operationsBody.addEventListener("change", handleOperationsSelectChange)
        operationsBody.addEventListener("input", handleOperationsInput)
        operationsBody.addEventListener("blur", handleOperationsBlur, true)
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            syncOperationsDataFromTable()
            currentOperationsData.rows.push(createEmptyOperationRow())
            renderOperationsTable()
            scheduleOperationsAssetRefresh()
            scheduleOperationsAutosave()
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistOperationsData()
                alert("Datos guardados en data/operaciones.json")
            } catch (error) {
                console.error(error)
                alert("No se pudieron guardar las operaciones.")
            }
        })
    }

    if (exportButton && !exportButton.dataset.bound) {
        exportButton.dataset.bound = "true"
        exportButton.addEventListener("click", exportOperationsJson)
    }

    if (importButton && !importButton.dataset.bound) {
        importButton.dataset.bound = "true"
        importButton.addEventListener("click", importOperationsJson)
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

function createEmptyOperationRow() {
    const firstAsset = operationsAssets[0] || null
    const assetId = firstAsset?.id || ""
    const pairOptions = getOperationPairOptions(assetId)
    const pair = pairOptions[0] || ""
    const stablecoinSymbol = pair ? pair.split("/").pop() : ""
    const moneyCurrency = normalizeCurrencyCode(stablecoinSymbol || "USD")

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
        const typeMatches = currentOperationTypeFilter.size === 0 || currentOperationTypeFilter.has(row.orden)
        const statusMatches = currentOperationStatusFilter.size === 0 || currentOperationStatusFilter.has(row.estado)
        return typeMatches && statusMatches
    })
}

function renderOperationsStablecoinPanel() {
    const panel = document.getElementById("operationsPairsSummary")

    if (!panel) {
        return
    }

    const enabledStablecoins = getOperationsEnabledStablecoinSymbols()

    if (!enabledStablecoins.length) {
        panel.innerHTML = ""
        panel.classList.add("hidden")
        return
    }

    panel.classList.remove("hidden")
    const summary = buildOperationsStablecoinBalanceSummary(operationsStablecoinsData, currentOperationsData.rows || [])
    const items = Object.values(summary)

    panel.innerHTML = `
        <span class="operationsPairsSummaryLabel">Par - saldo</span>
        <div class="operationsPairsSummaryValues">
            ${items.map((item) => `
                <span class="operationsPairsSummaryItem">${item.symbol} - ${formatMoney(item.available, "USD")}</span>
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

    if (!rows.length) {
        const emptyRow = document.createElement("tr")
        emptyRow.innerHTML = `
            <td class="rowDeleteCell"></td>
            <td colspan="10" class="operationsEmptyCell">No hay operaciones para los filtros seleccionados.</td>
        `
        operationsBody.appendChild(emptyRow)
        renderOperationsStablecoinPanel()
        return
    }

    rows.forEach((row) => {
        operationsBody.appendChild(buildOperationRow(row))
    })

    renderOperationsStablecoinPanel()
}

function buildOperationAssetSelect(selectedAssetId) {
    return `
        <select class="operationsSelect" data-field="assetId">
            <option value=""></option>
            ${operationsAssets.map((asset) => `<option value="${asset.id}"${selectedAssetId === asset.id ? " selected" : ""}>${asset.name}</option>`).join("")}
        </select>
    `
}

function buildOperationPairSelect(row) {
    const pairOptions = getOperationPairOptions(row.assetId)
    const selectedPair = pairOptions.includes(row.par) ? row.par : (pairOptions[0] || "")

    if (!pairOptions.length) {
        return `
            <select class="operationsSelect" data-field="par" disabled>
                <option value="">Sin stablecoins activas</option>
            </select>
        `
    }

    return `
        <select class="operationsSelect" data-field="par">
            ${pairOptions.map((pair) => `<option value="${pair}"${pair === selectedPair ? " selected" : ""}>${pair}</option>`).join("")}
        </select>
    `
}

function buildOperationRow(row) {
    const normalizedRow = normalizeOperationRow(row)
    const tr = document.createElement("tr")
    tr.dataset.operationId = normalizedRow.id
    tr.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td>${buildOperationAssetSelect(normalizedRow.assetId)}</td>
        <td contenteditable="true" data-field="fechaApertura">${normalizedRow.fechaApertura || ""}</td>
        <td>${buildOperationPairSelect(normalizedRow)}</td>
        <td>
            <select class="operationsSelect" data-field="orden">
                ${OPERATION_ORDER_OPTIONS.map((option) => `<option value="${option}"${normalizedRow.orden === option ? " selected" : ""}>${option}</option>`).join("")}
            </select>
        </td>
        <td class="operationsPriceCell" data-field="precioOrdenCell">
            <div contenteditable="true" data-field="precioOrden">${formatOperationsMoney(normalizedRow.precioOrden, normalizedRow.precioCurrency || "USD")}</div>
            <select class="operationsSelect operationsCurrencySelectHidden" data-field="precioCurrency" aria-label="Moneda precio orden">
                ${OPERATION_CURRENCY_OPTIONS.map((option) => `<option value="${option}"${(normalizedRow.precioCurrency || "USD") === option ? " selected" : ""}>${option === "EUR" ? "Euros" : "Dólares"}</option>`).join("")}
            </select>
        </td>
        <td contenteditable="true" data-field="cantidad">${formatOperationsQuantity(normalizedRow.cantidad)}</td>
        <td data-field="comisionesCriptoCell">
            <input type="text" class="operationsCryptoCommissionInput" data-field="comisionesCripto" inputmode="decimal" value="${formatOperationsQuantity(normalizedRow.comisionesCripto)}" placeholder="0,00000000">
        </td>
        <td class="rowTotal operationsTotalCell" data-field="totalCell">
            <div class="operationsTotalDisplay" contenteditable="true" data-field="total">${formatOperationsMoney(normalizedRow.total, normalizedRow.currency || "USD")}</div>
            <select class="operationsSelect operationsCurrencySelectHidden" data-field="currency" aria-label="Moneda total">
                ${OPERATION_CURRENCY_OPTIONS.map((option) => `<option value="${option}"${(normalizedRow.currency || "USD") === option ? " selected" : ""}>${option === "EUR" ? "Euros" : "Dólares"}</option>`).join("")}
            </select>
        </td>
        <td>
            <select class="operationsSelect" data-field="estado">
                ${OPERATION_STATUS_OPTIONS.map((option) => `<option value="${option}"${normalizedRow.estado === option ? " selected" : ""}>${option}</option>`).join("")}
            </select>
        </td>
        <td contenteditable="true" data-field="fechaCierre">${normalizedRow.fechaCierre || ""}</td>
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

function maybeAutofillOperationTotal(row) {
    if (!row) {
        return
    }

    const priceCell = row.querySelector('[data-field="precioOrden"]')
    const quantityCell = row.querySelector('[data-field="cantidad"]')
    const totalCell = row.querySelector('[data-field="total"]')
    const currencySelect = row.querySelector('select[data-field="currency"]')
    const pairSelect = row.querySelector('select[data-field="par"]')
    const pair = pairSelect?.value || ""

    if (!priceCell || !quantityCell || !totalCell || !pair.includes("/")) {
        return
    }

    const price = parseLooseNumber(priceCell.textContent)
    const quantity = parseLooseNumber(quantityCell.textContent)
    const currentTotal = parseLooseNumber(totalCell.textContent)

    if (price === null || quantity === null) {
        return
    }

    if (currentTotal !== null && currentTotal !== 0) {
        return
    }

    const nextTotal = price * quantity
    const currency = currencySelect?.value || "USD"
    totalCell.textContent = formatOperationsMoney(nextTotal, currency)
}

function handleOperationsInput(event) {
    const row = event.target.closest("tr[data-operation-id]")

    if (!row) {
        return
    }

    const field = event.target.dataset.field || ""

    if (field === "precioOrden" || field === "cantidad") {
        maybeAutofillOperationTotal(row)
    }

    syncOperationsDataFromTable()
    renderOperationsStablecoinPanel()
    scheduleOperationsAssetRefresh()
    scheduleOperationsAutosave()
}

function handleOperationsBlur(event) {
    const cell = event.target.closest('[contenteditable="true"]')
    const commissionInput = event.target.closest('input[data-field="comisionesCripto"]')

    if (commissionInput) {
        commissionInput.value = formatOperationsQuantity(commissionInput.value)
        syncOperationsDataFromTable()
        renderOperationsStablecoinPanel()
        scheduleOperationsAssetRefresh()
        scheduleOperationsAutosave()
        return
    }

    if (!cell) {
        return
    }

    const row = cell.closest("tr[data-operation-id]")
    const field = cell.dataset.field

    if (field === "cantidad") {
        cell.textContent = formatOperationsQuantity(cell.textContent)
    }

    if (field === "comisionesCripto") {
        cell.textContent = formatOperationsQuantity(cell.textContent)
    }

    if (field === "precioOrden") {
        const currency = row?.querySelector('select[data-field="precioCurrency"]')?.value || "USD"
        cell.textContent = formatOperationsMoney(cell.textContent, currency)
    }

    if (field === "total") {
        const currency = row?.querySelector('select[data-field="currency"]')?.value || "USD"
        cell.textContent = formatOperationsMoney(cell.textContent, currency)
    }

    if (field === "precioOrden" || field === "cantidad") {
        maybeAutofillOperationTotal(row)
    }

    syncOperationsDataFromTable()
    renderOperationsStablecoinPanel()
    scheduleOperationsAssetRefresh()
    scheduleOperationsAutosave()
}

function handleOperationsSelectChange(event) {
    const select = event.target.closest(".operationsSelect")

    if (!select) {
        return
    }

    const row = select.closest("tr[data-operation-id]")

    if (!row) {
        return
    }

    if (select.dataset.field === "assetId") {
        updateOperationRowAssetSelection(row)
    } else if (select.dataset.field === "par") {
        updateOperationRowPairSelection(row)
    } else if (select.dataset.field === "precioCurrency") {
        updateOperationRowPriceDisplay(row)
    } else if (select.dataset.field === "currency") {
        updateOperationRowTotalDisplay(row)
    }

    renderOperationsStablecoinPanel()
    scheduleOperationsAssetRefresh()
    scheduleOperationsAutosave()
}

function updateOperationRowAssetSelection(row) {
    const assetSelect = row.querySelector('select[data-field="assetId"]')
    const selectedAsset = getOperationAssetById(assetSelect?.value || "")
    const pairContainerCell = row.children[3]
    const currentRow = normalizeOperationRow({
        id: row.dataset.operationId,
        assetId: selectedAsset?.id || "",
        activo: selectedAsset?.name || "",
        par: "",
        orden: row.querySelector('select[data-field="orden"]')?.value || "Compra",
        precioOrden: stripCurrencyText(row.querySelector('[data-field="precioOrden"]')?.textContent || "") || "",
        precioCurrency: row.querySelector('select[data-field="precioCurrency"]')?.value || "USD",
        cantidad: row.querySelector('[data-field="cantidad"]')?.textContent.trim() || "",
        comisionesCripto: row.querySelector('input[data-field="comisionesCripto"]')?.value.trim() || "",
        total: stripCurrencyText(row.querySelector('[data-field="total"]')?.textContent || "") || "",
        currency: row.querySelector('select[data-field="currency"]')?.value || "USD",
        estado: row.querySelector('select[data-field="estado"]')?.value || "Activo",
        fechaApertura: row.querySelector('[data-field="fechaApertura"]')?.textContent.trim() || "",
        fechaCierre: row.querySelector('[data-field="fechaCierre"]')?.textContent.trim() || ""
    })

    pairContainerCell.innerHTML = buildOperationPairSelect(currentRow)
    updateOperationRowPairSelection(row)
}

function updateOperationRowPairSelection(row) {
    const pairSelect = row.querySelector('select[data-field="par"]')
    const pair = pairSelect?.value || ""
    const quoteSymbol = pair.includes("/") ? pair.split("/").pop() : ""
    const normalizedCurrency = normalizeCurrencyCode(quoteSymbol || "USD")
    const priceCurrencySelect = row.querySelector('select[data-field="precioCurrency"]')
    const totalCurrencySelect = row.querySelector('select[data-field="currency"]')

    if (priceCurrencySelect) {
        priceCurrencySelect.value = normalizedCurrency
    }

    if (totalCurrencySelect) {
        totalCurrencySelect.value = normalizedCurrency
    }

    updateOperationRowPriceDisplay(row)
    updateOperationRowTotalDisplay(row)
}

function updateOperationRowPriceDisplay(row) {
    if (!row) {
        return
    }

    const priceCell = row.querySelector('[data-field="precioOrden"]')
    const currencySelect = row.querySelector('select[data-field="precioCurrency"]')
    const currency = currencySelect?.value || "USD"

    if (priceCell) {
        priceCell.textContent = formatOperationsMoney(priceCell.textContent, currency)
    }
}

function updateOperationRowTotalDisplay(row) {
    if (!row) {
        return
    }

    const totalCell = row.querySelector(".operationsTotalDisplay")
    const currencySelect = row.querySelector('select[data-field="currency"]')
    const currency = currencySelect?.value || "USD"

    if (totalCell) {
        totalCell.textContent = formatOperationsMoney(totalCell.textContent, currency)
    }
}

function handleOperationsDeleteClick(event) {
    const deleteButton = event.target.closest(".rowDeleteBtn")

    if (!deleteButton) {
        const priceCell = event.target.closest(".operationsPriceCell")
        if (priceCell && !event.target.closest('[data-field="precioOrden"]')) {
            const currencySelect = priceCell.querySelector('select[data-field="precioCurrency"]')
            currencySelect?.focus()
            currencySelect?.click()
            return
        }

        const totalCell = event.target.closest(".operationsTotalCell")
        if (totalCell && !event.target.closest('[data-field="total"]')) {
            const currencySelect = totalCell.querySelector('select[data-field="currency"]')
            currencySelect?.focus()
            currencySelect?.click()
        }

        return
    }

    const row = deleteButton.closest("tr[data-operation-id]")
    const rowId = row?.dataset.operationId

    if (!rowId) {
        return
    }

    currentOperationsData.rows = (currentOperationsData.rows || []).filter((item) => item.id !== rowId)
    renderOperationsTable()
    scheduleOperationsAssetRefresh()
    scheduleOperationsAutosave()
}

function stripMoneySymbolOnFocus(event) {
    const editableMoneyCell = event.target.closest('[contenteditable="true"][data-field="precioOrden"], [contenteditable="true"][data-field="total"]')

    if (!editableMoneyCell) {
        return
    }

    queueMicrotask(() => {
        editableMoneyCell.textContent = stripCurrencyText(editableMoneyCell.textContent || "")
    })
}

document.addEventListener("focusin", stripMoneySymbolOnFocus)

function syncOperationsDataFromTable() {
    const bodyRows = [...document.querySelectorAll("#operationsBody tr[data-operation-id]")]
    const rowsById = new Map((currentOperationsData.rows || []).map((row) => [row.id, row]))

    bodyRows.forEach((rowElement) => {
        const rowId = rowElement.dataset.operationId
        const storedRow = rowsById.get(rowId)

        if (!storedRow) {
            return
        }

        const assetId = rowElement.querySelector('select[data-field="assetId"]')?.value || ""
        const asset = getOperationAssetById(assetId)
        const pair = rowElement.querySelector('select[data-field="par"]')?.value || ""
        const stablecoinSymbol = getOperationStablecoinSymbol({ par: pair })

        rowsById.set(rowId, normalizeOperationRow({
            ...storedRow,
            assetId,
            activo: asset?.name || "",
            fechaApertura: rowElement.querySelector('[data-field="fechaApertura"]')?.textContent.trim() || "",
            par: pair,
            stablecoinSymbol,
            orden: rowElement.querySelector('select[data-field="orden"]')?.value || "Compra",
            precioOrden: stripCurrencyText(rowElement.querySelector('[data-field="precioOrden"]')?.textContent || "") || "",
            precioCurrency: rowElement.querySelector('select[data-field="precioCurrency"]')?.value || "USD",
            cantidad: rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || "",
            comisionesCripto: rowElement.querySelector('input[data-field="comisionesCripto"]')?.value.trim() || "",
            total: stripCurrencyText(rowElement.querySelector('[data-field="total"]')?.textContent || "") || "",
            currency: rowElement.querySelector('select[data-field="currency"]')?.value || "USD",
            estado: rowElement.querySelector('select[data-field="estado"]')?.value || "Activo",
            fechaCierre: rowElement.querySelector('[data-field="fechaCierre"]')?.textContent.trim() || ""
        }))
    })

    currentOperationsData.rows = (currentOperationsData.rows || []).map((row) => rowsById.get(row.id) || row)
}

function scheduleOperationsAutosave(delay = 500) {
    window.clearTimeout(operationsAutosaveTimeout)
    operationsAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistOperationsData()
        } catch (error) {
            console.error("Error en autoguardado de operaciones:", error)
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

function exportOperationsJson() {
    syncOperationsDataFromTable()
    downloadJsonFile("operaciones-spot.json", currentOperationsData)
}

function importOperationsJson() {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json,.json"
    input.addEventListener("change", async () => {
        const file = input.files?.[0]

        if (!file) {
            return
        }

        const text = await file.text()
        const payload = JSON.parse(text)
        const rows = Array.isArray(payload.rows) ? payload.rows : []
        currentOperationsData.rows = rows.map((row, index) => normalizeOperationRow({
            id: String(row.id || `operacion-importada-${index + 1}`),
            assetId: row.assetId || "",
            activo: row.activo || "",
            fechaApertura: row.fechaApertura || row.fecha || "",
            par: row.par || "",
            stablecoinSymbol: row.stablecoinSymbol || "",
            orden: row.orden || "Compra",
            precioOrden: row.precioOrden || row.precio || "",
            precioCurrency: row.precioCurrency || "",
            cantidad: row.cantidad || "",
            comisionesCripto: row.comisionesCripto || row.comisiones || "",
            total: row.total || "",
            currency: row.currency || "",
            estado: row.estado || "Activo",
            fechaCierre: row.fechaCierre || ""
        }, index))
        renderOperationsTable()
        scheduleOperationsAssetRefresh()
        scheduleOperationsAutosave()
    })

    input.click()
}
