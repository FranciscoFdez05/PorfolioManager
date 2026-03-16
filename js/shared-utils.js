function parseEuroNumber(value) {
    if (!value) {
        return 0
    }

    const cleanValue = value
        .toString()
        .replaceAll("€", "")
        .replaceAll(/\s/g, "")
        .replaceAll(".", "")
        .replace(",", ".")

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function parseDollarNumber(value) {
    if (!value) {
        return 0
    }

    const cleanValue = value
        .toString()
        .replaceAll("$", "")
        .replaceAll(/\s/g, "")
        .replaceAll(".", "")
        .replace(",", ".")

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function formatEuro(value) {
    return new Intl.NumberFormat("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value) + " €"
}

function formatDollar(value) {
    return new Intl.NumberFormat("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value) + " $"
}

function normalizeCurrencyCode(currency) {
    const normalized = String(currency || "EUR").trim().toUpperCase()

    if (["USD", "USDT", "USDC", "BUSD"].includes(normalized)) {
        return "USD"
    }

    return normalized || "EUR"
}

function formatMoney(value, currency = "EUR") {
    const normalizedCurrency = normalizeCurrencyCode(currency)
    const formattedNumber = new Intl.NumberFormat("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value)

    const suffixByCurrency = {
        EUR: "€",
        USD: "$",
        GBP: "GBP",
        CHF: "CHF",
        JPY: "JPY",
        SEK: "SEK"
    }

    return `${formattedNumber} ${suffixByCurrency[normalizedCurrency] || normalizedCurrency}`
}

function formatCellMoneyValue(value, currency = "EUR") {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value).trim() === "") {
        return ""
    }

    return formatMoney(parsedValue, currency)
}

function stripCurrencyText(value) {
    return String(value ?? "")
        .replace(/[€$]/g, "")
        .replace(/\b(?:USD|EUR|GBP|CHF|JPY|SEK|USDT|USDC|BUSD)\b/gi, "")
        .trim()
}

function getCurrentAssetCurrency() {
    return document.querySelector(".assetTablePage")?.dataset.assetCurrency || "EUR"
}

function formatMoneySafe(value, currency = "EUR") {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return formatMoney(parsed, currency)
}

function normalizeNumberForEdit(value) {
    return String(value).replace(".", ",")
}

function formatCellEuroValue(value) {
    const parsedValue = parseEuroNumber(value)

    if (!value || String(value).trim() === "") {
        return ""
    }

    return formatEuro(parsedValue)
}

function formatCellDollarValue(value) {
    const parsedValue = parseDollarNumber(value)

    if (!value || String(value).trim() === "") {
        return ""
    }

    return formatDollar(parsedValue)
}

async function initDividendosLogic() {
    await renderDividendosTable()

    const dividendosBody = document.getElementById("dividendosBody")
    const addRowButton = document.getElementById("addRowDividendoBtn")
    const exportJsonButton = document.getElementById("exportDividendosJsonBtn")
    const importJsonButton = document.getElementById("importDividendosJsonBtn")
    const saveDividendosButton = document.getElementById("saveDividendosBtn")

    if (dividendosBody) {
        dividendosBody.addEventListener("input", () => {
            updateDividendosTotals()
            scheduleDividendosAutosave()
        })

        dividendosBody.addEventListener("click", handleRowDeleteClick)
        dividendosBody.addEventListener("focus", handleCellFocus, true)
        dividendosBody.addEventListener("blur", (event) => {
            handleCellBlur(event)
            scheduleDividendosAutosave()
        }, true)
    }

    if (addRowButton) {
        addRowButton.addEventListener("click", () => {
            addNewDividendosRow()
            scheduleDividendosAutosave()
        })
    }

    if (exportJsonButton) {
        exportJsonButton.addEventListener("click", () => {
            exportDividendosJson()
        })
    }

    if (importJsonButton) {
        importJsonButton.addEventListener("click", () => {
            importDividendosJson()
        })
    }

    if (saveDividendosButton) {
        saveDividendosButton.addEventListener("click", async () => {
            try {
                await saveDividendosDataToServer()
                alert("Datos guardados en data/dividendos.json")
            } catch (error) {
                alert("Error al guardar: " + error.message)
            }
        })
    }

}

document.addEventListener("keydown", (event) => {
    const editableCell = event.target.closest('td[contenteditable="true"]')
    if (!editableCell || event.key !== "Enter") {
        return
    }

    event.preventDefault()
    editableCell.blur()
})

function isDividendosPerShareCell(cell) {
    if (!cell) {
        return false
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    const headerText = (headerCell?.textContent || "").trim().toLowerCase()
    return headerText === "dividendos / acción"
}

function isDividendosActionsCell(cell) {
    if (!cell) {
        return false
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    const headerText = (headerCell?.textContent || "").trim().toLowerCase()
    return headerText === "acciones"
}

function isDividendosEuroCell(cell) {
    if (!cell) {
        return false
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    const headerText = (headerCell?.textContent || "").trim().toLowerCase()
    return headerText === "impuestos" || headerText === "total"
}

function getTableHeaderText(cell) {
    if (!cell) {
        return ""
    }

    const row = cell.parentElement
    const table = cell.closest("table")
    const headerRow = table ? table.querySelector("thead tr") : null
    const columnIndex = row ? Array.from(row.children).indexOf(cell) : -1
    const headerCell = headerRow && columnIndex >= 0 ? headerRow.children[columnIndex] : null
    return (headerCell?.textContent || "").trim().toLowerCase()
}

function isAssetParticipationsCell(cell) {
    return getTableHeaderText(cell) === "participaciones"
}

function isAssetCommissionsCell(cell) {
    return getTableHeaderText(cell) === "comisiones"
}

function parseLooseNumber(value) {
    const text = String(value ?? "").replace(/[^\d,.\-]/g, "").trim()
    if (!text) {
        return null
    }

    let normalized = text
    if (text.includes(",") && text.includes(".")) {
        normalized = text.replace(/\./g, "").replace(",", ".")
    } else {
        normalized = text.replace(",", ".")
    }

    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
}

function formatDollarSafe(value) {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return `${parsed.toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} $`
}

function formatEuroSafe(value) {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return `${parsed.toLocaleString("es-ES", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} €`
}

document.addEventListener("focusin", (event) => {
    const cell = event.target.closest('td[contenteditable="true"]')
    if (isAssetParticipationsCell(cell) || isAssetCommissionsCell(cell)) {
        queueMicrotask(() => {
            cell.textContent = stripCurrencyText(cell.textContent || "")
        })
        return
    }

    if (!isDividendosPerShareCell(cell)) {
        if (isDividendosActionsCell(cell) || isDividendosEuroCell(cell)) {
            queueMicrotask(() => {
                cell.textContent = stripCurrencyText(cell.textContent || "")
            })
        }
        return
    }

    queueMicrotask(() => {
        const parsed = parseLooseNumber(cell.textContent)
        cell.textContent = parsed === null ? "" : String(parsed).replace(".", ",")
    })
})

document.addEventListener("focusout", (event) => {
    const cell = event.target.closest('td[contenteditable="true"]')
    if (isAssetParticipationsCell(cell)) {
        queueMicrotask(() => {
            cell.textContent = stripCurrencyText(cell.textContent || "")
        })
        return
    }

    if (isAssetCommissionsCell(cell)) {
        queueMicrotask(() => {
            const text = String(cell.textContent || "").trim()
            cell.textContent = formatMoneySafe(text, getCurrentAssetCurrency())
        })
        return
    }

    if (!isDividendosPerShareCell(cell)) {
        if (isDividendosActionsCell(cell)) {
            queueMicrotask(() => {
                cell.textContent = stripCurrencyText(cell.textContent || "")
            })
        } else if (isDividendosEuroCell(cell)) {
            queueMicrotask(() => {
                const text = String(cell.textContent || "").trim()
                cell.textContent = formatEuroSafe(text)
            })
        }
        return
    }

    queueMicrotask(() => {
        const text = String(cell.textContent || "").trim()
        cell.textContent = formatDollarSafe(text)
    })
})

let interesesAutosaveTimer = null
let suppressAutosaveAlert = false

const originalWindowAlert = window.alert.bind(window)
window.alert = (message) => {
    const text = String(message || "")
    if (suppressAutosaveAlert && text.toLowerCase().includes("datos guardados en data/intereses.json")) {
        suppressAutosaveAlert = false
        return
    }

    originalWindowAlert(message)
}

function runWithoutAlerts(callback) {
    suppressAutosaveAlert = true
    try {
        callback()
    } finally {
        window.setTimeout(() => {
            suppressAutosaveAlert = false
        }, 1500)
    }
}

function hideAutoSaveButtons() {
    document.querySelectorAll("button").forEach((button) => {
        if (button.textContent.trim().toLowerCase() === "guardar") {
            button.style.display = "none"
        }
    })
}

function isInteresesTableCell(element) {
    const cell = element?.closest?.("td")
    const table = cell?.closest?.("table")
    const headerText = (table?.querySelector?.("thead")?.textContent || "").toLowerCase()
    return headerText.includes("saldo promedio") && headerText.includes("acumulado")
}

function triggerInteresesAutosave() {
    const saveButton = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent.trim().toLowerCase() === "guardar"
    )

    if (saveButton) {
        runWithoutAlerts(() => {
            saveButton.click()
        })
    }
}

function scheduleInteresesAutosave(delay = 500) {
    window.clearTimeout(interesesAutosaveTimer)
    interesesAutosaveTimer = window.setTimeout(() => {
        triggerInteresesAutosave()
    }, delay)
}

document.addEventListener("focusout", (event) => {
    if (isInteresesTableCell(event.target)) {
        scheduleInteresesAutosave(300)
    }
})

document.addEventListener("DOMContentLoaded", () => {
    requestAnimationFrame(hideAutoSaveButtons)
})

new MutationObserver(() => {
    hideAutoSaveButtons()
}).observe(document.body, { childList: true, subtree: true })
function getVisibleAssetTable() {
    return Array.from(document.querySelectorAll("table")).find((table) => {
        const headerText = (table.querySelector("thead")?.textContent || "").toLowerCase()
        return headerText.includes("fecha operación") && headerText.includes("participaciones")
    }) || null
}

function getAssetActionRow() {
    return Array.from(document.querySelectorAll("button"))
        .find((button) => button.textContent.trim().toLowerCase() === "guardar json")
        ?.parentElement || null
}

function buildAssetRowsFromTable(table) {
    const headerCells = Array.from(table.querySelectorAll("thead th"))
    const headers = headerCells.map((cell) => (cell.textContent || "").trim()).filter(Boolean)
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((row) => {
        const cells = Array.from(row.children).slice(-headers.length)
        const rowData = {}
        headers.forEach((header, index) => {
            rowData[header] = (cells[index]?.textContent || "").trim()
        })
        return rowData
    })

    return { headers, rows }
}

function downloadJsonFile(filename, payload) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    link.click()
    URL.revokeObjectURL(url)
}

function exportCurrentAssetJson() {
    const table = getVisibleAssetTable()
    if (!table) {
        return
    }

    const title = document.querySelector("h1, h2")?.textContent?.trim() || "activo"
    const payload = {
        nombre: title,
        ...buildAssetRowsFromTable(table)
    }

    downloadJsonFile(`${title.toLowerCase().replace(/\s+/g, "-") || "activo"}.json`, payload)
}

function importCurrentAssetJson() {
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
        const table = getVisibleAssetTable()
        if (!table || !Array.isArray(payload.rows)) {
            return
        }

        const tbody = table.querySelector("tbody")
        const headers = Array.from(table.querySelectorAll("thead th"))
            .map((cell) => (cell.textContent || "").trim())
            .filter(Boolean)

        tbody.innerHTML = ""
        payload.rows.forEach((rowData) => {
            const row = document.createElement("tr")
            const deleteCell = document.createElement("td")
            deleteCell.innerHTML = '<button type="button" class="row-delete-btn">X</button>'
            row.appendChild(deleteCell)

            headers.forEach((header) => {
                const cell = document.createElement("td")
                cell.contentEditable = "true"
                cell.textContent = rowData[header] || ""
                row.appendChild(cell)
            })

            tbody.appendChild(row)
        })

        const hiddenSaveButton = Array.from(document.querySelectorAll("button")).find(
            (button) => button.dataset.assetHiddenSave === "true"
        )
        hiddenSaveButton?.click()
    })

    input.click()
}

function enhanceAssetJsonActions() {
    const actionRow = getAssetActionRow()
    if (!actionRow) {
        return
    }

    const saveButton = Array.from(actionRow.querySelectorAll("button")).find(
        (button) => button.textContent.trim().toLowerCase() === "guardar json"
    )

    if (!saveButton) {
        return
    }

    saveButton.style.display = "none"
    saveButton.dataset.assetHiddenSave = "true"

    if (!actionRow.querySelector('[data-asset-export="true"]')) {
        const exportButton = document.createElement("button")
        exportButton.type = "button"
        exportButton.className = saveButton.className
        exportButton.textContent = "Exportar JSON"
        exportButton.dataset.assetExport = "true"
        exportButton.addEventListener("click", exportCurrentAssetJson)
        actionRow.insertBefore(exportButton, saveButton.nextSibling)

        const importButton = document.createElement("button")
        importButton.type = "button"
        importButton.className = saveButton.className
        importButton.textContent = "Importar JSON"
        importButton.dataset.assetImport = "true"
        importButton.addEventListener("click", importCurrentAssetJson)
        actionRow.insertBefore(importButton, exportButton.nextSibling)
    }
}

new MutationObserver(() => {
    enhanceAssetJsonActions()
}).observe(document.body, { childList: true, subtree: true })

document.addEventListener("DOMContentLoaded", () => {
    enhanceAssetJsonActions()
})
