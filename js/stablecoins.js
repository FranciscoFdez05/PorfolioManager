const STABLECOIN_MOVEMENT_TYPES = ["Compra", "Venta"]

let currentStablecoinsData = { catalog: [], enabledSymbols: [], rows: [] }
let currentStablecoinsOperationsRows = []
let stablecoinsAutosaveTimeout = null
let stablecoinsPersistenceBound = false
let stablecoinsPersistChain = Promise.resolve()

async function loadStablecoinsData() {
    const response = await fetch("/api/stablecoins")

    if (!response.ok) {
        throw new Error("No se pudieron cargar las stablecoins")
    }

    return await response.json()
}

async function saveStablecoinsData(payload, options = {}) {
    const response = await fetch("/api/stablecoins", {
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

    return await response.json()
}

function normalizeStablecoinSymbol(value = "") {
    return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
}

function normalizeStablecoinCatalogEntry(entry = {}) {
    const marketSymbol = String(entry.marketSymbol || entry.symbol || "").trim().toUpperCase()
    const displaySymbol = String(entry.displaySymbol || marketSymbol || entry.symbol || "").trim().toUpperCase()
    let symbol = normalizeStablecoinSymbol(entry.symbol || "")

    if (!symbol && displaySymbol) {
        symbol = normalizeStablecoinSymbol(displaySymbol.split("/")[0].split("_")[0].split("-")[0])
    }

    if (!symbol && marketSymbol) {
        const marketTail = marketSymbol.includes(":") ? marketSymbol.split(":").pop() : marketSymbol
        symbol = normalizeStablecoinSymbol(marketTail.split("/")[0].split("_")[0].split("-")[0])
    }

    if (!symbol) {
        return null
    }

    return {
        symbol,
        marketSymbol: marketSymbol || symbol,
        displaySymbol: displaySymbol || symbol,
        description: String(entry.description || "").trim(),
        provider: String(entry.provider || "FINNHUB").trim().toUpperCase() || "FINNHUB"
    }
}

function normalizeStablecoinMovementRow(row = {}) {
    const stablecoinSymbol = normalizeStablecoinSymbol(row.stablecoinSymbol || "")
    const rawMovementType = String(row.tipo || "").trim()
    const movementType = rawMovementType === "Gasto"
        ? "Venta"
        : (STABLECOIN_MOVEMENT_TYPES.includes(rawMovementType) ? rawMovementType : "Compra")
    const currency = normalizeCurrencyCode(row.currency || "USD")

    return {
        id: String(row.id || `stablecoin-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`),
        stablecoinSymbol,
        fecha: String(row.fecha || ""),
        tipo: movementType,
        cantidad: String(row.cantidad || ""),
        precio: String(row.precio || ""),
        total: String(row.total || ""),
        currency: currency === "EUR" ? "EUR" : "USD",
        nota: String(row.nota || "")
    }
}

function normalizeStablecoinsPayload(payload = {}) {
    const rawCatalog = Array.isArray(payload.catalog)
        ? payload.catalog
        : Array.isArray(payload.availableSymbols)
            ? payload.availableSymbols
            : []
    const normalizedCatalog = []
    const catalogSymbols = new Set()

    rawCatalog.forEach((entry) => {
        const normalizedEntry = normalizeStablecoinCatalogEntry(entry)

        if (!normalizedEntry || catalogSymbols.has(normalizedEntry.symbol)) {
            return
        }

        catalogSymbols.add(normalizedEntry.symbol)
        normalizedCatalog.push(normalizedEntry)
    })

    const enabledSymbols = Array.isArray(payload.enabledSymbols)
        ? payload.enabledSymbols
            .map((symbol) => normalizeStablecoinSymbol(symbol))
            .filter((symbol, index, array) => symbol && array.indexOf(symbol) === index)
        : []
    const fallbackCatalog = normalizedCatalog.length
        ? normalizedCatalog
        : enabledSymbols.map((symbol) => normalizeStablecoinCatalogEntry({ symbol })).filter(Boolean)
    const fallbackCatalogSymbols = new Set(fallbackCatalog.map((entry) => entry.symbol))

    return {
        catalog: fallbackCatalog,
        enabledSymbols: enabledSymbols.filter((symbol) => fallbackCatalogSymbols.has(symbol)),
        rows: Array.isArray(payload.rows)
            ? payload.rows.map((row) => {
                const normalizedRow = normalizeStablecoinMovementRow(row)
                const fallbackSymbol = enabledSymbols[0] || fallbackCatalog[0]?.symbol || normalizedRow.stablecoinSymbol

                return {
                    ...normalizedRow,
                    stablecoinSymbol: normalizedRow.stablecoinSymbol || fallbackSymbol || ""
                }
            })
            : []
    }
}

function getStablecoinCatalog(payload = currentStablecoinsData) {
    return normalizeStablecoinsPayload(payload).catalog
}

function getStablecoinCatalogSymbols(payload = currentStablecoinsData) {
    return getStablecoinCatalog(payload).map((entry) => entry.symbol)
}

function getEnabledStablecoinSymbols(payload = currentStablecoinsData) {
    const normalized = normalizeStablecoinsPayload(payload)
    return normalized.enabledSymbols
}

function getOperationStablecoinSymbol(row = {}) {
    const explicitSymbol = normalizeStablecoinSymbol(row.stablecoinSymbol || "")

    if (explicitSymbol) {
        return explicitSymbol
    }

    const pair = String(row.par || "").trim().toUpperCase()
    const quoteSymbol = pair.includes("/") ? pair.split("/").pop() : ""

    return normalizeStablecoinSymbol(quoteSymbol)
}

function buildStablecoinBalanceSummary(stablecoinsPayload = currentStablecoinsData, operationsRows = currentStablecoinsOperationsRows) {
    const normalizedPayload = normalizeStablecoinsPayload(stablecoinsPayload)
    const summary = {}

    normalizedPayload.catalog.forEach((entry) => {
        const symbol = entry.symbol
        summary[symbol] = {
            symbol,
            enabled: normalizedPayload.enabledSymbols.includes(symbol),
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
        } else if (row.tipo === "Venta") {
            summary[symbol].manualExpenses += amount
        }
    })

    ;(operationsRows || []).forEach((row) => {
        const symbol = getOperationStablecoinSymbol(row)

        if (!symbol || !summary[symbol]) {
            return
        }

        if (String(row.estado || "").trim() !== "Completado") {
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

function createEmptyStablecoinRow() {
    const enabledSymbols = getEnabledStablecoinSymbols(currentStablecoinsData)
    return normalizeStablecoinMovementRow({
        stablecoinSymbol: enabledSymbols[0] || getStablecoinCatalogSymbols(currentStablecoinsData)[0] || ""
    })
}

function getStablecoinRowSymbolOptions(currentSymbol = "") {
    const enabledSymbols = getEnabledStablecoinSymbols(currentStablecoinsData)
    const catalogSymbols = getStablecoinCatalogSymbols(currentStablecoinsData)
    const baseOptions = enabledSymbols.length ? enabledSymbols : catalogSymbols

    if (!baseOptions.length) {
        return currentSymbol ? [currentSymbol] : []
    }

    if (currentSymbol && !baseOptions.includes(currentSymbol)) {
        return [currentSymbol, ...baseOptions]
    }

    return baseOptions
}

async function initStablecoinsLogic() {
    const [stablecoinsPayload, operationsPayload] = await Promise.all([
        loadStablecoinsData(),
        loadOperacionesData()
    ])

    currentStablecoinsData = normalizeStablecoinsPayload(stablecoinsPayload)
    currentStablecoinsOperationsRows = Array.isArray(operationsPayload?.rows) ? operationsPayload.rows : []
    bindStablecoinsPersistenceGuards()
    window.flushPendingPageChanges = flushStablecoinsPendingChanges
    renderStablecoinsEnabledMenu()
    renderStablecoinsSummary()
    renderStablecoinsTable()
    bindStablecoinsEvents()
}

function bindStablecoinsEvents() {
    const body = document.getElementById("stablecoinsBody")
    const addButton = document.getElementById("addStablecoinRowBtn")
    const saveButton = document.getElementById("saveStablecoinsBtn")
    const enabledMenu = document.getElementById("stablecoinsEnabledMenu")
    const summaryContainer = document.getElementById("stablecoinsSummary")
    const openModalButton = document.getElementById("openStablecoinModalBtn")
    const closeModalButton = document.getElementById("closeStablecoinModalBtn")
    const modalOverlay = document.getElementById("stablecoinModalOverlay")
    const searchButton = document.getElementById("stablecoinSearchBtn")
    const searchInput = document.getElementById("stablecoinSearchInput")

    if (body && !body.dataset.bound) {
        body.dataset.bound = "true"
        body.addEventListener("click", handleStablecoinsDeleteClick)
        body.addEventListener("change", handleStablecoinsChange)
        body.addEventListener("input", handleStablecoinsInput)
        body.addEventListener("blur", handleStablecoinsBlur, true)
    }

    if (enabledMenu && !enabledMenu.dataset.bound) {
        enabledMenu.dataset.bound = "true"
        enabledMenu.addEventListener("change", handleStablecoinsEnabledToggle)
    }

    if (summaryContainer && !summaryContainer.dataset.bound) {
        summaryContainer.dataset.bound = "true"
        summaryContainer.addEventListener("click", handleStablecoinSummaryClick)
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            openStablecoinRowModal("")
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistStablecoinsData()
                alert("Datos guardados en data/stablecoins.json")
            } catch (error) {
                console.error(error)
                alert("No se pudieron guardar las stablecoins.")
            }
        })
    }

    if (openModalButton && !openModalButton.dataset.bound) {
        openModalButton.dataset.bound = "true"
        openModalButton.addEventListener("click", openStablecoinModal)
    }

    if (closeModalButton && !closeModalButton.dataset.bound) {
        closeModalButton.dataset.bound = "true"
        closeModalButton.addEventListener("click", closeStablecoinModal)
    }

    if (modalOverlay && !modalOverlay.dataset.bound) {
        modalOverlay.dataset.bound = "true"
        modalOverlay.addEventListener("click", (event) => {
            if (event.target === modalOverlay) {
                closeStablecoinModal()
            }
        })
    }

    if (searchButton && !searchButton.dataset.bound) {
        searchButton.dataset.bound = "true"
        searchButton.addEventListener("click", () => {
            handleStablecoinFinnhubSearch()
        })
    }

    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = "true"
        searchInput.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault()
                handleStablecoinFinnhubSearch()
            }

            if (event.key === "Escape") {
                closeStablecoinModal()
            }
        })
    }
}

function openStablecoinModal() {
    const modalOverlay = document.getElementById("stablecoinModalOverlay")
    const searchInput = document.getElementById("stablecoinSearchInput")
    const feedback = document.getElementById("stablecoinSearchFeedback")
    const resultsContainer = document.getElementById("stablecoinSearchResults")

    if (!modalOverlay || !searchInput || !feedback || !resultsContainer) {
        return
    }

    searchInput.value = ""
    setAssetSearchFeedback(feedback, "")
    renderMarketSearchResults(resultsContainer, [], () => {})
    modalOverlay.classList.remove("hidden")
    searchInput.focus()
}

function closeStablecoinModal() {
    const modalOverlay = document.getElementById("stablecoinModalOverlay")

    if (!modalOverlay) {
        return
    }

    modalOverlay.classList.add("hidden")
}

function renderStablecoinsEnabledMenu() {
    const menu = document.getElementById("stablecoinsEnabledMenu")

    if (!menu) {
        return
    }

    const enabledSymbols = new Set(getEnabledStablecoinSymbols())
    const catalog = getStablecoinCatalog()
    menu.innerHTML = ""

    if (!catalog.length) {
        menu.classList.add("hidden")
        return
    }

    menu.classList.remove("hidden")

    catalog.forEach((entry) => {
        const symbol = entry.symbol
        const label = document.createElement("label")
        label.className = `overviewFilterOption operationsFilterOption stablecoinToggle${enabledSymbols.has(symbol) ? " active" : ""}`
        label.innerHTML = `
            <input type="checkbox" value="${symbol}" ${enabledSymbols.has(symbol) ? "checked" : ""}>
            <span>${symbol}</span>
        `
        menu.appendChild(label)
    })
}

function renderStablecoinsSummary() {
    const summaryContainer = document.getElementById("stablecoinsSummary")
    const headerPanel = document.querySelector(".stablecoinsHeaderPanel")

    if (!summaryContainer || !headerPanel) {
        return
    }

    const enabledSymbols = getEnabledStablecoinSymbols(currentStablecoinsData)
    const summary = buildStablecoinBalanceSummary(currentStablecoinsData, currentStablecoinsOperationsRows)
    summaryContainer.innerHTML = ""

    if (!enabledSymbols.length) {
        summaryContainer.classList.add("hidden")
        headerPanel.classList.add("stablecoinsHeaderPanelCompact")
        return
    }

    summaryContainer.classList.remove("hidden")
    headerPanel.classList.remove("stablecoinsHeaderPanelCompact")

    Object.values(summary).filter((item) => item.enabled).forEach((item) => {
        const card = document.createElement("article")
        card.className = "stablecoinSummaryCard"
        card.innerHTML = `
            <div class="stablecoinSummaryHeader">
                <div class="stablecoinSummaryHeaderCopy">
                    <h4>${item.symbol}</h4>
                    <span>Activo en pares</span>
                </div>
                <button type="button" class="stablecoinSummaryDeleteBtn" data-symbol="${item.symbol}" title="Eliminar stablecoin">×</button>
            </div>
            <div class="stablecoinSummaryMain">${formatMoney(item.available, "USD")}</div>
            <div class="stablecoinSummaryMeta">
                <span>Compras manuales: ${formatMoney(item.manualBuys, "USD")}</span>
                <span>Ventas manuales: ${formatMoney(item.manualExpenses, "USD")}</span>
                <span>Operaciones completadas: ${formatMoney(item.operationsBuys - item.operationsSales, "USD")}</span>
            </div>
        `
        summaryContainer.appendChild(card)
    })
}

function handleStablecoinSummaryClick(event) {
    const deleteButton = event.target.closest(".stablecoinSummaryDeleteBtn")

    if (!deleteButton) {
        return
    }

    const stablecoinSymbol = normalizeStablecoinSymbol(deleteButton.dataset.symbol || "")

    if (!stablecoinSymbol) {
        return
    }

    requestStablecoinDeletion(stablecoinSymbol)
}

function requestStablecoinDeletion(stablecoinSymbol) {
    const confirmDelete = () => {
        const nextCatalog = getStablecoinCatalog(currentStablecoinsData).filter((entry) => entry.symbol !== stablecoinSymbol)
        const nextEnabledSymbols = getEnabledStablecoinSymbols(currentStablecoinsData).filter((symbol) => symbol !== stablecoinSymbol)
        const nextRows = (currentStablecoinsData.rows || []).filter((row) => row.stablecoinSymbol !== stablecoinSymbol)

        currentStablecoinsData = normalizeStablecoinsPayload({
            ...currentStablecoinsData,
            catalog: nextCatalog,
            enabledSymbols: nextEnabledSymbols,
            rows: nextRows
        })

        renderStablecoinsEnabledMenu()
        renderStablecoinsSummary()
        renderStablecoinsTable()
        scheduleStablecoinsAutosave()
    }

    if (typeof openConfirmModal === "function") {
        openConfirmModal({
            title: "Eliminar stablecoin",
            message: `Vas a eliminar ${stablecoinSymbol} del catálogo y borrar sus movimientos manuales. ¿Quieres continuar?`,
            confirmLabel: "Continuar",
            onConfirm: () => {
                openConfirmModal({
                    title: "Confirmación final",
                    message: `Esta acción eliminará ${stablecoinSymbol} y no se puede deshacer fácilmente. ¿Confirmas el borrado?`,
                    confirmLabel: "Eliminar",
                    onConfirm: confirmDelete,
                    confirmSide: "right"
                })
            }
        })
        return
    }

    if (window.confirm(`Vas a eliminar ${stablecoinSymbol}. ¿Quieres continuar?`) && window.confirm(`Confirma de nuevo que quieres eliminar ${stablecoinSymbol}.`)) {
        confirmDelete()
    }
}

function renderStablecoinsTable() {
    const body = document.getElementById("stablecoinsBody")

    if (!body) {
        return
    }

    body.innerHTML = ""

    if (!(currentStablecoinsData.rows || []).length) {
        const emptyRow = document.createElement("tr")
        emptyRow.innerHTML = `
            <td class="rowDeleteCell"></td>
            <td colspan="8" class="operationsEmptyCell">Todavía no hay movimientos de stablecoins.</td>
        `
        body.appendChild(emptyRow)
        return
    }

    currentStablecoinsData.rows.forEach((row) => {
        body.appendChild(buildStablecoinRow(row))
    })
}

function buildStablecoinRow(row) {
    const symbolOptions = getStablecoinRowSymbolOptions(row.stablecoinSymbol)
    const tr = document.createElement("tr")
    tr.dataset.stablecoinRowId = row.id
    tr.innerHTML = `
        <td>
            <select class="operationsSelect" data-field="stablecoinSymbol">
                ${symbolOptions.map((symbol) => `<option value="${symbol}"${row.stablecoinSymbol === symbol ? " selected" : ""}>${symbol}</option>`).join("")}
            </select>
        </td>
        <td contenteditable="true" data-field="fecha">${row.fecha || ""}</td>
        <td>
            <select class="operationsSelect" data-field="tipo">
                ${STABLECOIN_MOVEMENT_TYPES.map((option) => `<option value="${option}"${row.tipo === option ? " selected" : ""}>${option}</option>`).join("")}
            </select>
        </td>
        <td>
            <select class="operationsSelect" data-field="currency">
                ${OPERATION_CURRENCY_OPTIONS.map((option) => `<option value="${option}"${(row.currency || "USD") === option ? " selected" : ""}>${option}</option>`).join("")}
            </select>
        </td>
        <td contenteditable="true" data-field="cantidad">${formatStablecoinQuantity(row.cantidad)}</td>
        <td class="operationsPriceCell"><div contenteditable="true" data-field="precio">${formatOperationsMoney(row.precio, row.currency || "USD")}</div></td>
        <td class="operationsTotalCell"><div class="operationsTotalDisplay" contenteditable="true" data-field="total">${formatOperationsMoney(row.total, row.currency || "USD")}</div></td>
        <td contenteditable="true" data-field="nota">${row.nota || ""}</td>
        <td class="rowActionsCell">
            <button type="button" class="assetRowEditBtn stablecoinRowEditBtn" data-row-id="${row.id}" title="Editar fila">✎</button>
            <button type="button" class="assetRowDeleteBtn stablecoinRowDeleteBtn" data-row-id="${row.id}" title="Eliminar fila">✕</button>
        </td>
    `
    return tr
}

function formatStablecoinQuantity(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 8
    })
}

function handleStablecoinsInput(event) {
    const row = event.target.closest("tr[data-stablecoin-row-id]")

    if (!row) {
        return
    }

    const field = event.target.dataset.field || ""

    if (field === "precio" || field === "cantidad") {
        maybeAutofillStablecoinTotal(row)
    }

    syncStablecoinsDataFromTable()
    renderStablecoinsSummary()
    scheduleStablecoinsAutosave()
}

function handleStablecoinsBlur(event) {
    const cell = event.target.closest('[contenteditable="true"]')

    if (!cell) {
        return
    }

    const row = cell.closest("tr[data-stablecoin-row-id]")
    const currency = row?.querySelector('select[data-field="currency"]')?.value || "USD"

    if (cell.dataset.field === "cantidad") {
        cell.textContent = formatStablecoinQuantity(cell.textContent)
    }

    if (cell.dataset.field === "precio" || cell.dataset.field === "total") {
        cell.textContent = formatOperationsMoney(cell.textContent, currency)
    }

    if (cell.dataset.field === "precio" || cell.dataset.field === "cantidad") {
        maybeAutofillStablecoinTotal(row)
    }

    syncStablecoinsDataFromTable()
    renderStablecoinsSummary()
    scheduleStablecoinsAutosave()
}

function maybeAutofillStablecoinTotal(row) {
    if (!row) {
        return
    }

    const quantity = parseLooseNumber(row.querySelector('[data-field="cantidad"]')?.textContent || "")
    const price = parseLooseNumber(row.querySelector('[data-field="precio"]')?.textContent || "")
    const totalCell = row.querySelector('[data-field="total"]')
    const currency = row.querySelector('select[data-field="currency"]')?.value || "USD"

    if (!totalCell || quantity === null || price === null) {
        return
    }

    totalCell.textContent = formatOperationsMoney(price * quantity, currency)
}

function handleStablecoinsChange(event) {
    const select = event.target.closest(".operationsSelect")

    if (!select) {
        return
    }

    const row = select.closest("tr[data-stablecoin-row-id]")

    if (select.dataset.field === "currency" && row) {
        const priceCell = row.querySelector('[data-field="precio"]')
        const totalCell = row.querySelector('[data-field="total"]')
        const currency = select.value || "USD"

        if (priceCell) {
            priceCell.textContent = formatOperationsMoney(priceCell.textContent, currency)
        }

        if (totalCell) {
            totalCell.textContent = formatOperationsMoney(totalCell.textContent, currency)
        }
    }

    syncStablecoinsDataFromTable()
    renderStablecoinsSummary()
    scheduleStablecoinsAutosave()
}

function handleStablecoinsEnabledToggle(event) {
    const input = event.target.closest('input[type="checkbox"]')

    if (!input) {
        return
    }

    const enabledSymbols = new Set(getEnabledStablecoinSymbols())

    if (input.checked) {
        enabledSymbols.add(input.value)
    } else {
        enabledSymbols.delete(input.value)
    }

    const availableSymbols = new Set(getStablecoinCatalogSymbols(currentStablecoinsData))
    currentStablecoinsData.enabledSymbols = [...enabledSymbols].filter((symbol) => availableSymbols.has(symbol))

    renderStablecoinsEnabledMenu()
    renderStablecoinsSummary()
    renderStablecoinsTable()
    scheduleStablecoinsAutosave()
}

function handleStablecoinsDeleteClick(event) {
    const editButton = event.target.closest(".stablecoinRowEditBtn")
    if (editButton) {
        openStablecoinRowModal(editButton.dataset.rowId)
        return
    }

    const deleteButton = event.target.closest(".stablecoinRowDeleteBtn")
    if (!deleteButton) return

    const rowId = deleteButton.dataset.rowId
    if (!rowId) return

    currentStablecoinsData.rows = (currentStablecoinsData.rows || []).filter((item) => item.id !== rowId)
    renderStablecoinsTable()
    renderStablecoinsSummary()
    scheduleStablecoinsAutosave()
}

function syncStablecoinsDataFromTable() {
    const rowElements = [...document.querySelectorAll("#stablecoinsBody tr[data-stablecoin-row-id]")]
    const rowsById = new Map((currentStablecoinsData.rows || []).map((row) => [row.id, row]))

    rowElements.forEach((rowElement) => {
        const rowId = rowElement.dataset.stablecoinRowId
        const storedRow = rowsById.get(rowId)

        if (!storedRow) {
            return
        }

        const currency = rowElement.querySelector('select[data-field="currency"]')?.value || "USD"
        rowsById.set(rowId, normalizeStablecoinMovementRow({
            ...storedRow,
            stablecoinSymbol: rowElement.querySelector('select[data-field="stablecoinSymbol"]')?.value || getEnabledStablecoinSymbols(currentStablecoinsData)[0] || getStablecoinCatalogSymbols(currentStablecoinsData)[0] || "",
            fecha: rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
            tipo: rowElement.querySelector('select[data-field="tipo"]')?.value || "Compra",
            cantidad: rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || "",
            precio: stripCurrencyText(rowElement.querySelector('[data-field="precio"]')?.textContent || "") || "",
            total: stripCurrencyText(rowElement.querySelector('[data-field="total"]')?.textContent || "") || "",
            currency,
            nota: rowElement.querySelector('[data-field="nota"]')?.textContent.trim() || ""
        }))
    })

    currentStablecoinsData.rows = (currentStablecoinsData.rows || []).map((row) => rowsById.get(row.id) || row)
    currentStablecoinsData.enabledSymbols = getEnabledStablecoinSymbols(currentStablecoinsData)
    currentStablecoinsData.catalog = getStablecoinCatalog(currentStablecoinsData)
}

function buildStablecoinsPayloadSnapshot() {
    syncStablecoinsDataFromTable()

    return normalizeStablecoinsPayload({
        catalog: getStablecoinCatalog(currentStablecoinsData),
        enabledSymbols: getEnabledStablecoinSymbols(currentStablecoinsData),
        rows: (currentStablecoinsData.rows || []).map((row) => ({ ...row }))
    })
}

function buildStablecoinSearchEntry(result = {}, query = "") {
    const normalizedQuerySymbol = /^[A-Za-z0-9]{2,10}$/.test(String(query || "").trim())
        ? normalizeStablecoinSymbol(query)
        : ""

    return normalizeStablecoinCatalogEntry({
        symbol: normalizedQuerySymbol,
        marketSymbol: result.symbol || "",
        displaySymbol: result.displaySymbol || result.symbol || "",
        description: result.description || "",
        provider: result.provider || "FINNHUB"
    }) || normalizeStablecoinCatalogEntry({
        marketSymbol: result.symbol || "",
        displaySymbol: result.displaySymbol || result.symbol || "",
        description: result.description || "",
        provider: result.provider || "FINNHUB"
    })
}

function normalizeStablecoinSearchResults(results = [], query = "") {
    const seenSymbols = new Set()

    return (results || []).map((result) => {
        const entry = buildStablecoinSearchEntry(result, query)

        if (!entry || seenSymbols.has(entry.symbol)) {
            return null
        }

        seenSymbols.add(entry.symbol)

        return {
            ...result,
            stablecoinSymbol: entry.symbol,
            marketSymbol: entry.marketSymbol,
            displaySymbol: `${entry.symbol}${entry.displaySymbol && entry.displaySymbol !== entry.symbol ? ` · ${entry.displaySymbol}` : ""}`,
            description: entry.description || result.description || "",
            provider: entry.provider || result.provider || "FINNHUB"
        }
    }).filter(Boolean)
}

function addStablecoinFromSearchResult(result = {}) {
    const entry = normalizeStablecoinCatalogEntry({
        symbol: result.stablecoinSymbol || "",
        marketSymbol: result.marketSymbol || result.symbol || "",
        displaySymbol: result.displaySymbol || result.symbol || "",
        description: result.description || "",
        provider: result.provider || "FINNHUB"
    })

    if (!entry) {
        return
    }

    const catalog = [...getStablecoinCatalog(currentStablecoinsData)]

    if (!catalog.some((item) => item.symbol === entry.symbol)) {
        catalog.push(entry)
    }

    currentStablecoinsData = normalizeStablecoinsPayload({
        ...currentStablecoinsData,
        catalog,
        enabledSymbols: [...new Set([...getEnabledStablecoinSymbols(currentStablecoinsData), entry.symbol])]
    })

    renderStablecoinsEnabledMenu()
    renderStablecoinsSummary()
    renderStablecoinsTable()

    const feedback = document.getElementById("stablecoinSearchFeedback")
    const resultsContainer = document.getElementById("stablecoinSearchResults")
    setAssetSearchFeedback(feedback, `Stablecoin añadida: ${entry.symbol}`)
    renderMarketSearchResults(resultsContainer, [], () => {})
    closeStablecoinModal()
    scheduleStablecoinsAutosave()
}

async function handleStablecoinFinnhubSearch() {
    const input = document.getElementById("stablecoinSearchInput")
    const feedback = document.getElementById("stablecoinSearchFeedback")
    const resultsContainer = document.getElementById("stablecoinSearchResults")
    const query = String(input?.value || "").trim()

    if (!query) {
        setAssetSearchFeedback(feedback, "Escribe el nombre o ticker de la stablecoin.", true)
        renderMarketSearchResults(resultsContainer, [], () => {})
        return
    }

    setAssetSearchFeedback(feedback, "Buscando stablecoin en Finnhub...")

    try {
        const response = await searchFinnhubSymbolOnServer(query, { assetType: "cripto" })
        const results = normalizeStablecoinSearchResults(response.results, query)

        if (!results.length) {
            setAssetSearchFeedback(feedback, "No se encontraron resultados útiles para esa stablecoin.", true)
            renderMarketSearchResults(resultsContainer, [], () => {})
            return
        }

        setAssetSearchFeedback(feedback, "Selecciona la stablecoin correcta de Finnhub.")
        renderMarketSearchResults(resultsContainer, results, addStablecoinFromSearchResult)
    } catch (error) {
        console.error(error)
        setAssetSearchFeedback(feedback, "No se pudo consultar Finnhub. Revisa la API key.", true)
        renderMarketSearchResults(resultsContainer, [], () => {})
    }
}

function scheduleStablecoinsAutosave(delay = 500) {
    window.clearTimeout(stablecoinsAutosaveTimeout)
    stablecoinsAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistStablecoinsData()
        } catch (error) {
            console.error("Error en autoguardado de stablecoins:", error)
        }
    }, delay)
}

async function persistStablecoinsData(options = {}) {
    window.clearTimeout(stablecoinsAutosaveTimeout)
    const payloadSnapshot = buildStablecoinsPayloadSnapshot()
    currentStablecoinsData = payloadSnapshot

    stablecoinsPersistChain = stablecoinsPersistChain
        .catch(() => {})
        .then(() => saveStablecoinsData(payloadSnapshot, options))

    await stablecoinsPersistChain
}

async function flushStablecoinsPendingChanges() {
    if (!document.getElementById("stablecoinsBody")) {
        return
    }

    await persistStablecoinsData({ keepalive: true })
}

function bindStablecoinsPersistenceGuards() {
    if (stablecoinsPersistenceBound) {
        return
    }

    stablecoinsPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!document.getElementById("stablecoinsBody")) {
            return
        }

        persistStablecoinsData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar stablecoins al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || !document.getElementById("stablecoinsBody")) {
            return
        }

        persistStablecoinsData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar stablecoins al cambiar de ventana:", error)
        })
    })
}

function openStablecoinRowModal(rowId) {
    document.getElementById("stablecoinRowModalOverlay")?.remove()

    const rowIndex = (currentStablecoinsData.rows || []).findIndex((r) => r.id === rowId)
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...currentStablecoinsData.rows[rowIndex] } : createEmptyStablecoinRow()
    const symbolOptions = getStablecoinRowSymbolOptions(rowData.stablecoinSymbol)

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Stablecoin</label>
            <select id="scModalSymbol" class="assetRowModalSelect">
                ${symbolOptions.map((s) => `<option value="${s}"${rowData.stablecoinSymbol === s ? " selected" : ""}>${s}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha</label>
            <input id="scModalFecha" class="assetRowModalInput" type="text" value="${rowData.fecha || ""}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Tipo</label>
            <select id="scModalTipo" class="assetRowModalSelect">
                ${STABLECOIN_MOVEMENT_TYPES.map((t) => `<option value="${t}"${rowData.tipo === t ? " selected" : ""}>${t}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Divisa fiat</label>
            <select id="scModalCurrency" class="assetRowModalSelect">
                ${OPERATION_CURRENCY_OPTIONS.map((c) => `<option value="${c}"${(rowData.currency || "USD") === c ? " selected" : ""}>${c}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Cantidad</label>
            <input id="scModalCantidad" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.cantidad || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Precio unitario</label>
            <input id="scModalPrecio" class="assetRowModalInput" type="text" inputmode="decimal" value="${stripCurrencyText(rowData.precio || "")}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Total fiat</label>
            <input id="scModalTotal" class="assetRowModalInput" type="text" inputmode="decimal" value="${stripCurrencyText(rowData.total || "")}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Nota</label>
            <input id="scModalNota" class="assetRowModalInput" type="text" value="${rowData.nota || ""}">
        </div>
    `

    const overlay = document.createElement("div")
    overlay.id = "stablecoinRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowId = rowId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const title = document.createElement("h3")
    title.className = "assetModalTitle assetRowModalTitle"
    title.textContent = isEdit ? "Editar movimiento" : "Añadir movimiento"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = fieldsHtml

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        ${isEdit ? `<button type="button" id="scRowModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
        <button type="button" id="scRowModalCancelBtn" class="cancelButton">Cancelar</button>
        <button type="button" id="scRowModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
    `

    footer.querySelector("#scRowModalSaveBtn").addEventListener("click", saveStablecoinRowFromModal)
    footer.querySelector("#scRowModalCancelBtn").addEventListener("click", closeStablecoinRowModal)

    if (isEdit) {
        footer.querySelector("#scRowModalDeleteBtn").addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar fila",
                message: "¿Quieres eliminar este movimiento?",
                confirmLabel: "Eliminar",
                onConfirm: () => {
                    currentStablecoinsData.rows = (currentStablecoinsData.rows || []).filter((r) => r.id !== rowId)
                    renderStablecoinsTable()
                    renderStablecoinsSummary()
                    scheduleStablecoinsAutosave()
                }
            })
            closeStablecoinRowModal()
        })
    }

    modal.appendChild(title)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

function closeStablecoinRowModal() {
    document.getElementById("stablecoinRowModalOverlay")?.remove()
}

function saveStablecoinRowFromModal() {
    const overlay = document.getElementById("stablecoinRowModalOverlay")
    const rowId = overlay?.dataset.rowId || ""
    const g = (id) => document.getElementById(id)?.value ?? ""

    const rowData = normalizeStablecoinMovementRow({
        id: rowId || `stablecoin-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        stablecoinSymbol: g("scModalSymbol"),
        fecha: g("scModalFecha"),
        tipo: g("scModalTipo"),
        currency: g("scModalCurrency"),
        cantidad: g("scModalCantidad"),
        precio: g("scModalPrecio"),
        total: g("scModalTotal"),
        nota: g("scModalNota")
    })

    const rowIndex = (currentStablecoinsData.rows || []).findIndex((r) => r.id === rowId)
    if (rowIndex >= 0) {
        currentStablecoinsData.rows[rowIndex] = rowData
    } else {
        currentStablecoinsData.rows.push(rowData)
    }

    renderStablecoinsTable()
    renderStablecoinsSummary()
    scheduleStablecoinsAutosave()
    closeStablecoinRowModal()
}
