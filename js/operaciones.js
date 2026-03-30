const OPERATION_ORDER_OPTIONS = ["Compra", "Venta"]
const OPERATION_STATUS_OPTIONS = ["Activo", "Cerrado", "Completado"]
const OPERATION_CURRENCY_OPTIONS = ["EUR", "USD"]

let currentOperationsData = { rows: [] }
let operationsAutosaveTimeout = null
let operationsPersistenceBound = false
let currentOperationTypeFilter = new Set(OPERATION_ORDER_OPTIONS)
let currentOperationStatusFilter = new Set(OPERATION_STATUS_OPTIONS)
const OPERATION_QUANTITY_DECIMALS = 8

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

async function initOperacionesLogic() {
    currentOperationsData = await loadOperacionesData()
    currentOperationTypeFilter = new Set(OPERATION_ORDER_OPTIONS)
    currentOperationStatusFilter = new Set(OPERATION_STATUS_OPTIONS)
    bindOperationsPersistenceGuards()
    window.flushPendingPageChanges = flushOperationsPendingChanges
    renderOperationsFilterState()
    renderOperationsTable()
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
    return {
        id: `operacion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        activo: "",
        fechaApertura: "",
        par: "",
        orden: "Compra",
        precioOrden: "",
        precioCurrency: "EUR",
        cantidad: "",
        total: "",
        currency: "EUR",
        estado: "Activo",
        fechaCierre: ""
    }
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
            <td colspan="9" class="operationsEmptyCell">No hay operaciones para los filtros seleccionados.</td>
        `
        operationsBody.appendChild(emptyRow)
        return
    }

    rows.forEach((row) => {
        operationsBody.appendChild(buildOperationRow(row))
    })
}

function buildOperationRow(row) {
    const tr = document.createElement("tr")
    tr.dataset.operationId = row.id
    tr.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true" data-field="activo">${row.activo || ""}</td>
        <td contenteditable="true" data-field="fechaApertura">${row.fechaApertura || ""}</td>
        <td contenteditable="true" data-field="par">${row.par || ""}</td>
        <td>
            <select class="operationsSelect" data-field="orden">
                ${OPERATION_ORDER_OPTIONS.map((option) => `<option value="${option}"${row.orden === option ? " selected" : ""}>${option}</option>`).join("")}
            </select>
        </td>
        <td class="operationsPriceCell" data-field="precioOrdenCell">
            <div contenteditable="true" data-field="precioOrden">${formatOperationsMoney(row.precioOrden, row.precioCurrency || "EUR")}</div>
            <select class="operationsSelect operationsCurrencySelectHidden" data-field="precioCurrency" aria-label="Moneda precio orden">
                ${OPERATION_CURRENCY_OPTIONS.map((option) => `<option value="${option}"${(row.precioCurrency || "EUR") === option ? " selected" : ""}>${option === "EUR" ? "Euros" : "Dólares"}</option>`).join("")}
            </select>
        </td>
        <td contenteditable="true" data-field="cantidad">${formatOperationsQuantity(row.cantidad)}</td>
        <td class="rowTotal operationsTotalCell" data-field="totalCell">
            <div class="operationsTotalDisplay" contenteditable="true" data-field="total">${formatOperationsMoney(row.total, row.currency || "EUR")}</div>
            <select class="operationsSelect operationsCurrencySelectHidden" data-field="currency" aria-label="Moneda total">
                ${OPERATION_CURRENCY_OPTIONS.map((option) => `<option value="${option}"${(row.currency || "EUR") === option ? " selected" : ""}>${option === "EUR" ? "Euros" : "Dólares"}</option>`).join("")}
            </select>
        </td>
        <td>
            <select class="operationsSelect" data-field="estado">
                ${OPERATION_STATUS_OPTIONS.map((option) => `<option value="${option}"${row.estado === option ? " selected" : ""}>${option}</option>`).join("")}
            </select>
        </td>
        <td contenteditable="true" data-field="fechaCierre">${row.fechaCierre || ""}</td>
    `
    return tr
}

function formatOperationsNumber(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 8
    })
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

function handleOperationsInput(event) {
    if (!event.target.closest("tr[data-operation-id]")) {
        return
    }

    scheduleOperationsAutosave()
}

function handleOperationsBlur(event) {
    const cell = event.target.closest('[contenteditable="true"]')

    if (!cell) {
        return
    }

    const field = cell.dataset.field

    if (field === "cantidad") {
        cell.textContent = formatOperationsQuantity(cell.textContent)
    }

    if (field === "precioOrden") {
        const row = cell.closest("tr")
        const currency = row?.querySelector('select[data-field="precioCurrency"]')?.value || "EUR"
        cell.textContent = formatOperationsMoney(cell.textContent, currency)
    }

    if (field === "total") {
        const row = cell.closest("tr")
        const currency = row?.querySelector('select[data-field="currency"]')?.value || "EUR"
        cell.textContent = formatOperationsMoney(cell.textContent, currency)
    }

    scheduleOperationsAutosave()
}

function handleOperationsSelectChange(event) {
    const select = event.target.closest(".operationsSelect")

    if (!select) {
        return
    }

    const row = select.closest("tr[data-operation-id]")

    if (select.dataset.field === "precioCurrency") {
        updateOperationRowPriceDisplay(row)
    } else if (select.dataset.field === "currency") {
        updateOperationRowTotalDisplay(row)
    }

    scheduleOperationsAutosave()
}

function updateOperationRowPriceDisplay(row) {
    if (!row) {
        return
    }

    const priceCell = row.querySelector('[data-field="precioOrden"]')
    const currencySelect = row.querySelector('select[data-field="precioCurrency"]')
    const currency = currencySelect?.value || "EUR"

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
    const currency = currencySelect?.value || "EUR"
    const totalValue = totalCell?.textContent || ""

    if (totalCell) {
        totalCell.textContent = formatOperationsMoney(totalValue, currency)
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
            return
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

        const totalCell = rowElement.querySelector(".operationsTotalDisplay")
        const nextRow = {
            ...storedRow,
            activo: rowElement.querySelector('[data-field="activo"]')?.textContent.trim() || "",
            fechaApertura: rowElement.querySelector('[data-field="fechaApertura"]')?.textContent.trim() || "",
            par: rowElement.querySelector('[data-field="par"]')?.textContent.trim() || "",
            orden: rowElement.querySelector('select[data-field="orden"]')?.value || "Compra",
            precioOrden: stripCurrencyText(rowElement.querySelector('[data-field="precioOrden"]')?.textContent || "") || "",
            precioCurrency: rowElement.querySelector('select[data-field="precioCurrency"]')?.value || "EUR",
            cantidad: rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || "",
            total: stripCurrencyText(totalCell?.textContent || "") || "",
            currency: rowElement.querySelector('select[data-field="currency"]')?.value || "EUR",
            estado: rowElement.querySelector('select[data-field="estado"]')?.value || "Activo",
            fechaCierre: rowElement.querySelector('[data-field="fechaCierre"]')?.textContent.trim() || ""
        }

        rowsById.set(rowId, nextRow)
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
    await saveOperacionesData(currentOperationsData, options)
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
        currentOperationsData.rows = rows.map((row, index) => ({
            id: String(row.id || `operacion-importada-${index + 1}`),
            activo: String(row.activo || ""),
            fechaApertura: String(row.fechaApertura || row.fecha || ""),
            par: String(row.par || ""),
            orden: OPERATION_ORDER_OPTIONS.includes(row.orden) ? row.orden : "Compra",
            precioOrden: String(row.precioOrden || row.precio || ""),
            precioCurrency: OPERATION_CURRENCY_OPTIONS.includes(String(row.precioCurrency || "").toUpperCase()) ? String(row.precioCurrency).toUpperCase() : "EUR",
            cantidad: String(row.cantidad || ""),
            total: String(row.total || ""),
            currency: OPERATION_CURRENCY_OPTIONS.includes(String(row.currency || "").toUpperCase()) ? String(row.currency).toUpperCase() : "EUR",
            estado: OPERATION_STATUS_OPTIONS.includes(row.estado) ? row.estado : "Activo",
            fechaCierre: String(row.fechaCierre || "")
        }))
        renderOperationsTable()
        scheduleOperationsAutosave()
    })

    input.click()
}
