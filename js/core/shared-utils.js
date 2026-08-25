// Un punto es separador de MILES solo si agrupa de tres en tres ("1.234").
// Si no, es el separador decimal ("1234.56").
//
// Antes se descartaban todos los puntos sin mirar, y eso multiplicaba por cien
// cualquier importe que llegara en el formato canónico que usa el servidor:
// parseEuroNumber("1234.56") devolvía 123456. No saltaba a la vista porque la
// mayoría de columnas se guardan en formato español, pero basta con que un
// endpoint devuelva un número ya serializado (los snapshots, el motor FIFO, un
// tipo de cambio) para que un total salga cien veces mayor.
//
// Cuando hay coma no hay ambigüedad posible: la coma es el decimal y el punto
// solo puede ser de miles, que es lo que se hacía y se conserva.
const MILES_ES = /^-?\d{1,3}(\.\d{3})+$/

function normalizeDecimalSeparators(text) {
    if (text.includes(",")) {
        return text.replaceAll(".", "").replace(",", ".")
    }
    return MILES_ES.test(text) ? text.replaceAll(".", "") : text
}

function parseEuroNumber(value) {
    if (!value) {
        return 0
    }

    const cleanValue = normalizeDecimalSeparators(value.toString().replaceAll("€", "").replaceAll(/\s/g, ""))

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function parseDollarNumber(value) {
    if (!value) {
        return 0
    }

    const cleanValue = normalizeDecimalSeparators(value.toString().replaceAll("$", "").replaceAll(/\s/g, ""))

    const parsedValue = parseFloat(cleanValue)
    return Number.isNaN(parsedValue) ? 0 : parsedValue
}

function _nl() {
    return window._numLocale || "es-ES"
}

function formatEuro(value) {
    return (
        new Intl.NumberFormat(_nl(), {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
        }).format(value) + " €"
    )
}

function normalizeCurrencyCode(currency) {
    const normalized = String(currency || "EUR")
        .trim()
        .toUpperCase()

    if (!normalized) {
        return "EUR"
    }

    if (
        ["USD", "USDT", "USDC", "BUSD", "DAI", "FDUSD", "PYUSD", "TUSD", "USDE"].includes(normalized) ||
        normalized.endsWith("USD")
    ) {
        return "USD"
    }

    if (["EUR", "EURC"].includes(normalized) || normalized.endsWith("EUR")) {
        return "EUR"
    }

    return normalized || "EUR"
}

// Sufijo con el que se muestra cada divisa. Fuera de `formatMoneyWithDecimals`
// para que cualquier formateador con sus propias reglas de decimales pueda
// usarlo sin copiar el mapa: el mapa de calor tiene las suyas (0, 2 o 4
// decimales según la magnitud) y estaba enseñando los precios sin divisa.
const SUFIJO_DIVISA = {
    EUR: "€",
    USD: "$",
    GBP: "GBP",
    CHF: "CHF",
    JPY: "JPY",
    SEK: "SEK"
}

function currencySuffix(currency) {
    const normalized = normalizeCurrencyCode(currency)
    return SUFIJO_DIVISA[normalized] || normalized
}

function formatMoneyWithDecimals(value, currency = "EUR", decimals = 2) {
    const formattedNumber = new Intl.NumberFormat(_nl(), {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
    }).format(value)

    return `${formattedNumber} ${currencySuffix(currency)}`
}

function formatMoney(value, currency = "EUR") {
    return formatMoneyWithDecimals(value, currency, 2)
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

function normalizeAssetRowCurrency(currency, fallback = "EUR") {
    const normalized = String(currency || fallback)
        .trim()
        .toUpperCase()
    return normalized === "USD" ? "USD" : "EUR"
}

function getAssetRowCurrency(rowOrCell, fallback = getCurrentAssetCurrency()) {
    const rowElement = rowOrCell?.closest ? rowOrCell.closest("tr") : null
    const explicitCurrency =
        rowElement?.querySelector('select[data-field="currency"]')?.value ||
        rowElement?.querySelector('td[data-field="currency"]')?.textContent?.trim()
    return normalizeAssetRowCurrency(explicitCurrency, fallback)
}

function formatShareQuantity(value, maxDecimals = 6) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value ?? "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString(_nl(), {
        minimumFractionDigits: 0,
        maximumFractionDigits: maxDecimals
    })
}

function getAssetParticipationDecimals(assetType) {
    const normalizedType = String(assetType || "")
        .trim()
        .toLowerCase()

    if (normalizedType === "cripto" || normalizedType === "comoditis") {
        return 8
    }

    if (normalizedType === "acciones" || normalizedType === "etfs") {
        return 6
    }

    return 6
}

function getCurrentAssetType() {
    return document.querySelector(".assetTablePage")?.dataset.assetType || "acciones"
}

function formatAssetParticipationValue(value, assetType = getCurrentAssetType()) {
    return formatShareQuantity(value, getAssetParticipationDecimals(assetType))
}

function formatCellEuroValue(value) {
    const parsedValue = parseEuroNumber(value)

    if (!value || String(value).trim() === "") {
        return ""
    }

    return formatEuro(parsedValue)
}

async function initDividendosLogic() {
    await renderDividendosTable()

    const dividendosBody = document.getElementById("dividendosBody")
    const addRowButton = document.getElementById("addRowDividendoBtn")
    const saveDividendosButton = document.getElementById("saveDividendosBtn")

    if (dividendosBody && !dividendosBody.dataset.bound) {
        dividendosBody.dataset.bound = "true"
        dividendosBody.addEventListener("click", handleDividendosRowActionClick)
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => {
            addNewDividendosRow()
        })
    }

    if (saveDividendosButton && !saveDividendosButton.dataset.bound) {
        saveDividendosButton.dataset.bound = "true"
        saveDividendosButton.addEventListener("click", async () => {
            try {
                await saveDividendosDataToServer()
                alert("Datos guardados en data/dividendos.json")
            } catch (error) {
                alert("Error al guardar: " + error.message)
            }
        })
    }

    initCalendarioDividendosButton()

    const addYearBtn = document.getElementById("addDividendosYearBtn")
    if (addYearBtn && !addYearBtn.dataset.bound) {
        addYearBtn.dataset.bound = "true"
        addYearBtn.addEventListener("click", () => {
            closeDividendosMenu()
            addDividendosYear()
        })
    }

    const deleteYearBtn = document.getElementById("deleteDividendosYearBtn")
    if (deleteYearBtn && !deleteYearBtn.dataset.bound) {
        deleteYearBtn.dataset.bound = "true"
        deleteYearBtn.addEventListener("click", () => {
            closeDividendosMenu()
            deleteCurrentDividendosYear()
        })
    }

    const divMenuBtn = document.getElementById("dividendosMenuBtn")
    const divMenuDrop = document.getElementById("dividendosMenuDropdown")
    if (divMenuBtn && divMenuDrop && !divMenuBtn.dataset.bound) {
        divMenuBtn.dataset.bound = "true"
        divMenuBtn.addEventListener("click", (e) => {
            e.stopPropagation()
            divMenuDrop.classList.toggle("hidden")
        })
    }

    const dividendosTable = document.querySelector(".dividendosTable")
    if (dividendosTable) bindTableSort(dividendosTable, "dividendos")
}

function closeDividendosMenu() {
    const d = document.getElementById("dividendosMenuDropdown")
    if (d) d.classList.add("hidden")
}

document.addEventListener("click", (e) => {
    if (!e.target.closest("#dividendosMenuBtn") && !e.target.closest("#dividendosMenuDropdown")) {
        closeDividendosMenu()
    }
})

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
    return cell?.dataset?.field === "participaciones" || getTableHeaderText(cell) === "participaciones"
}

function isAssetCommissionsCell(cell) {
    return (
        cell?.dataset?.field === "comisiones" ||
        cell?.dataset?.field === "comisionesFiat" ||
        getTableHeaderText(cell) === "comisiones" ||
        getTableHeaderText(cell) === "comisiones fiat"
    )
}

function isAssetCryptoCommissionsCell(cell) {
    return (
        cell?.dataset?.field === "comisionesSatoshis" ||
        cell?.dataset?.field === "comisionesCripto" ||
        getTableHeaderText(cell) === "comisiones cripto"
    )
}

function isCryptoAssetType(assetType) {
    return (
        String(assetType || "")
            .trim()
            .toLowerCase() === "cripto"
    )
}

function getAssetTableMoneyCurrency(assetType, fieldName, assetCurrency = "EUR", rowCurrency = "") {
    if (
        isCryptoAssetType(assetType) &&
        [
            "precioParticipacion",
            "capitalInvertidoBruto",
            "comisiones",
            "comisionesFiat",
            "capitalInvertidoNeto"
        ].includes(fieldName)
    ) {
        return normalizeAssetRowCurrency(rowCurrency, assetCurrency)
    }

    return assetCurrency
}

function formatSatoshis(value) {
    const parsed = parseLooseNumber(value)

    if (parsed === null) {
        return ""
    }

    return parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 8,
        maximumFractionDigits: 8
    })
}

function formatCellSatoshisValue(value) {
    const parsed = parseLooseNumber(value)

    if (parsed === null || String(value ?? "").trim() === "") {
        return (0).toLocaleString(_nl(), { minimumFractionDigits: 8, maximumFractionDigits: 8 })
    }

    return formatSatoshis(parsed)
}

// Sin parámetro de divisa: los dos llamadores formatean comisiones en cripto,
// que se muestran como cantidad y sin símbolo. El argumento estaba declarado y
// no lo usaba ni la función ni ninguna llamada.
function formatAssetCommissionValue(value) {
    const parsed = parseLooseNumber(value)

    if (parsed === null || String(value ?? "").trim() === "") {
        return (0).toLocaleString(_nl(), { minimumFractionDigits: 8, maximumFractionDigits: 8 })
    }

    return parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 8,
        maximumFractionDigits: 12
    })
}

function parseLooseNumber(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null
    }

    const text = String(value ?? "")
        .replace(/[^\d,.-]/g, "")
        .trim()
    if (!text) {
        return null
    }

    // El mismo criterio que parseEuroNumber: los dos parsers leen las mismas
    // columnas y discrepaban entre ellos ("1234.56" daba 1234,56 aquí y
    // 123.456 allí), así que el resultado dependía de cuál tocara esa pantalla.
    const parsed = Number(normalizeDecimalSeparators(text))
    return Number.isFinite(parsed) ? parsed : null
}

function formatDollarSafe(value) {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return `${parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} $`
}

function formatEuroSafe(value) {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return `${parsed.toLocaleString(_nl(), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    })} €`
}

document.addEventListener("focusin", (event) => {
    const cell = event.target.closest('td[contenteditable="true"]')
    if (isAssetParticipationsCell(cell) || isAssetCommissionsCell(cell)) {
        queueMicrotask(() => {
            const strippedText = stripCurrencyText(cell.textContent || "")
            cell.textContent = strippedText
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
            const text = String(cell.textContent || "").trim()
            cell.textContent = formatAssetParticipationValue(text)
        })
        return
    }

    if (isAssetCryptoCommissionsCell(cell)) {
        queueMicrotask(() => {
            const text = String(cell.textContent || "").trim()
            cell.textContent = formatCellSatoshisValue(text)
        })
        return
    }

    if (isAssetCommissionsCell(cell)) {
        queueMicrotask(() => {
            const text = String(cell.textContent || "").trim()
            const currentCurrency = getAssetRowCurrency(cell, getCurrentAssetCurrency())
            cell.textContent = currentCurrency === "EUR" ? formatEuroSafe(text) : formatDollarSafe(text)
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
        if (button.textContent.trim().toLowerCase() === "guardar" && !button.dataset.noAutohide) {
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

function downloadCsvFile(filename, rows, headers = null) {
    if (!Array.isArray(rows) || !rows.length) {
        return false
    }

    const csvHeaders = Array.isArray(headers) && headers.length ? headers : Object.keys(rows[0] || {})

    const escapeCsvCell = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`
    const normalizeRowValue = (value) => {
        if (typeof value === "number") {
            return Number.isFinite(value) ? value.toFixed(2) : String(value)
        }
        return value ?? ""
    }

    const csvBody = rows.map((row) =>
        csvHeaders.map((header) => escapeCsvCell(normalizeRowValue(row[header]))).join(",")
    )
    const csv = [csvHeaders.map((header) => escapeCsvCell(header)).join(","), ...csvBody].join("\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = filename
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
    return true
}

// ── Generic table sort ──────────────────────────────────────────────────────

function bindTableSort(table, storageKey) {
    if (!table || table._sortBound) return
    table._sortBound = true

    const lsKey = storageKey ? `tableSort_${storageKey}` : null
    let saved = null
    if (lsKey) {
        try {
            saved = JSON.parse(localStorage.getItem(lsKey))
        } catch {}
    }

    let currentKey = saved?.key ?? null
    let currentDir = saved?.dir ?? "desc"

    function persist() {
        if (!lsKey) return
        try {
            localStorage.setItem(lsKey, JSON.stringify({ key: currentKey, dir: currentDir }))
        } catch {}
    }

    function cellText(row, colIdx) {
        const cell = row.cells[colIdx]
        if (!cell) return ""
        const sel = cell.querySelector("select")
        if (sel) return sel.value
        return cell.textContent.trim()
    }

    function toComparable(text) {
        const dm = text.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/)
        if (dm) {
            const y = dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]
            return new Date(y, +dm[2] - 1, +dm[1]).getTime()
        }
        const n = parseFloat(
            text
                .replace(/\./g, "")
                .replace(",", ".")
                .replace(/[^\d.-]/g, "")
        )
        if (!isNaN(n)) return n
        return text.toLowerCase()
    }

    // Las tablas que se dividen en secciones (por año, por ejemplo) meten filas
    // de cabecera con .tableGroupRow. Cada cabecera abre un grupo y la
    // ordenación se aplica dentro de él, para que ordenar no desmonte la
    // división. Sin cabeceras hay un único grupo: la tabla entera.
    function groupRows(tbody) {
        const groups = [{ header: null, rows: [] }]

        for (const row of tbody.querySelectorAll("tr")) {
            if (row.classList.contains("tableGroupRow")) {
                groups.push({ header: row, rows: [] })
            } else {
                groups[groups.length - 1].rows.push(row)
            }
        }

        return groups
    }

    function doSort() {
        if (currentKey === null) return
        const tbody = table.querySelector("tbody")
        if (!tbody) return
        const colIdx = Number(currentKey)
        const compare = (a, b) => {
            const av = toComparable(cellText(a, colIdx))
            const bv = toComparable(cellText(b, colIdx))
            if (av < bv) return currentDir === "asc" ? -1 : 1
            if (av > bv) return currentDir === "asc" ? 1 : -1
            return 0
        }

        groupRows(tbody).forEach((group) => {
            group.rows.sort(compare)
            if (group.header) tbody.appendChild(group.header)
            group.rows.forEach((row) => tbody.appendChild(row))
        })

        syncArrows()
    }

    function syncArrows() {
        table.querySelectorAll("th.mThSort").forEach((th) => {
            const arrow = th.querySelector(".mSortArrow")
            if (!arrow) return
            if (th.dataset.sortkey === String(currentKey)) {
                arrow.textContent = currentDir === "asc" ? " ▲" : " ▼"
                th.classList.add("mThActive")
            } else {
                arrow.textContent = ""
                th.classList.remove("mThActive")
            }
        })
    }

    table.querySelectorAll("th.mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (currentKey === key) {
                currentDir = currentDir === "asc" ? "desc" : "asc"
            } else {
                currentKey = key
                currentDir = "desc"
            }
            persist()
            doSort()
        })
    })

    table._reSort = doSort
    if (currentKey !== null) doSort()
}

// ── Alineación automática de columnas de dinero / numéricas ─────────────────

// Importes ("1.234,56 €"), porcentajes ("+4,01 %") y cantidades ("0,00466667",
// "0,00010000 BTC"). Las fechas ("05-08-2026") no encajan a propósito.
const NUMERIC_TABLE_CELL_PATTERN =
    /^[\u2248~]?\s*[-+]?\s*[\u20ac$]?\s*\d[\d.\u00a0\u202f ]*(?:,\d+)?\s*(?:%|\u20ac|\$|[A-Z]{2,6})?$/

function getNumericTableCellText(cell) {
    const field = cell.querySelector("input, textarea")

    if (field) {
        return String(field.value || "").trim()
    }

    if (cell.querySelector("select, button, a")) {
        return ""
    }

    // Celdas con varias líneas (importe + detalle): decide la primera.
    return (cell.firstElementChild || cell).textContent.trim()
}

function refreshTableNumericAlignment(table) {
    if (!table) {
        return
    }

    const headerRows = table.tHead ? Array.from(table.tHead.rows) : []
    const headerRow = headerRows[headerRows.length - 1] || null
    const headerCells = headerRow ? Array.from(headerRow.cells) : []
    const headerUsable = headerCells.length > 0 && !headerCells.some((cell) => cell.colSpan > 1)
    const bodyRows = Array.from(table.tBodies).flatMap((tbody) => Array.from(tbody.rows))
    // La fila de totales del pie es una fila de datos más: sin ella, un tfoot
    // con las mismas columnas que el cuerpo se quedaba alineado a la izquierda.
    const footRows = table.tFoot ? Array.from(table.tFoot.rows) : []
    const columnCount = headerUsable ? headerCells.length : (bodyRows[0] || footRows[0])?.cells.length || 0

    if (!columnCount) {
        return
    }

    const dataRows = [...bodyRows, ...footRows].filter(
        (row) => row.cells.length === columnCount && !Array.from(row.cells).some((cell) => cell.colSpan > 1)
    )

    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        let filledCells = 0
        let numericCells = 0

        dataRows.forEach((row) => {
            const text = getNumericTableCellText(row.cells[columnIndex])

            if (!text) {
                return
            }

            filledCells += 1

            if (NUMERIC_TABLE_CELL_PATTERN.test(text)) {
                numericCells += 1
            }
        })

        const isNumericColumn = numericCells > 0 && numericCells >= filledCells * 0.6

        if (headerUsable) {
            headerCells[columnIndex].classList.toggle("numCol", isNumericColumn)
        }

        dataRows.forEach((row) => {
            row.cells[columnIndex].classList.toggle("numCell", isNumericColumn)
        })
    }
}

function refreshNumericTableAlignment(root = document) {
    root.querySelectorAll?.("table").forEach(refreshTableNumericAlignment)
}

let numericAlignmentScheduled = false

function scheduleNumericTableAlignment() {
    if (numericAlignmentScheduled) {
        return
    }

    numericAlignmentScheduled = true
    requestAnimationFrame(() => {
        numericAlignmentScheduled = false
        refreshNumericTableAlignment()
    })
}

// Solo observamos childList: las clases que añadimos son mutaciones de
// atributo, así que el observer no se dispara a sí mismo.
new MutationObserver((mutations) => {
    const touchesTable = mutations.some(
        (mutation) =>
            mutation.target.closest?.("table") ||
            Array.from(mutation.addedNodes).some(
                (node) =>
                    node.nodeType === 1 &&
                    (node.matches?.("table, thead, tbody, tr, td, th") || node.querySelector?.("table"))
            )
    )

    if (touchesTable) {
        scheduleNumericTableAlignment()
    }
}).observe(document.body, { childList: true, subtree: true })

document.addEventListener("DOMContentLoaded", scheduleNumericTableAlignment)
scheduleNumericTableAlignment()

// ── Custom select dropdown ──────────────────────────────────────────────────

function _buildCustomSelect(select) {
    if (select._csInit) return
    select._csInit = true

    const wrapper = document.createElement("div")
    wrapper.className = "csWrapper"

    const trigger = document.createElement("div")
    trigger.className = "csTrigger"

    const label = document.createElement("span")
    label.className = "csLabel"

    const arrow = document.createElement("span")
    arrow.className = "csArrow"
    arrow.textContent = "▾"

    trigger.appendChild(label)
    trigger.appendChild(arrow)

    const menu = document.createElement("div")
    menu.className = "csMenu csBodyMenu"
    menu.style.zIndex = "100000"
    menu.style.display = "none"

    menu.style.position = "fixed"
    document.body.appendChild(menu)

    select.parentNode.insertBefore(wrapper, select)
    wrapper.appendChild(select)
    wrapper.appendChild(trigger)
    select.style.display = "none"
    trigger.tabIndex = 0

    function positionMenu() {
        const rect = trigger.getBoundingClientRect()
        const left = Math.round(rect.left)
        const width = Math.round(rect.width)
        const bottom = Math.round(rect.bottom)
        const top = Math.round(rect.top)

        menu.style.position = "fixed"
        menu.style.left = left + "px"
        menu.style.width = Math.max(width, 150) + "px"

        const previousVisibility = menu.style.visibility
        const previousDisplay = menu.style.display

        menu.style.visibility = "hidden"
        menu.style.display = "flex"
        const menuH = Math.min(menu.scrollHeight, 220)
        menu.style.visibility = previousVisibility
        menu.style.display = previousDisplay

        const spaceBelow = window.innerHeight - bottom - 8
        if (spaceBelow < menuH && top >= menuH) {
            menu.style.top = top - menuH + "px"
        } else {
            menu.style.top = bottom + "px"
        }
    }

    function closeMenu() {
        menu.classList.remove("csOpen")
        menu.style.display = "none"
        trigger.classList.remove("csOpen")
        menu.querySelectorAll(".csOption.csActive").forEach((o) => o.classList.remove("csActive"))
    }

    function chooseOption(opt) {
        select.value = opt.value
        select.dispatchEvent(new Event("change", { bubbles: true }))
        syncLabel()
        syncOptions()
        closeMenu()
    }

    function syncOptions() {
        menu.innerHTML = ""
        Array.from(select.options).forEach((opt) => {
            if (!opt.value && !opt.text.trim()) return
            const item = document.createElement("div")
            item.className = "csOption" + (opt.selected ? " csSelected" : "")
            item.dataset.val = opt.value
            item.textContent = opt.text
            item.addEventListener("mousedown", (e) => {
                e.preventDefault()
                chooseOption(opt)
            })
            menu.appendChild(item)
        })
    }

    function syncLabel() {
        const sel = select.options[select.selectedIndex]
        label.textContent = sel ? sel.text : ""
    }

    syncOptions()
    syncLabel()

    trigger.addEventListener("click", (e) => {
        e.stopPropagation()
        const isOpen = menu.classList.contains("csOpen")
        document.querySelectorAll(".csMenu.csOpen").forEach((m) => {
            m.classList.remove("csOpen")
            m.style.display = "none"
            m._csTrigger?.classList.remove("csOpen")
        })
        if (!isOpen) {
            syncOptions()
            positionMenu()
            menu.classList.add("csOpen")
            menu.style.display = "flex"
            trigger.classList.add("csOpen")
        }
    })

    menu._csTrigger = trigger

    let searchBuffer = ""
    let searchTimer = null

    function clearActive() {
        menu.querySelectorAll(".csOption.csActive").forEach((o) => o.classList.remove("csActive"))
    }

    function jumpToSearch() {
        if (!searchBuffer) return
        const options = Array.from(menu.querySelectorAll(".csOption"))
        const match = options.find((o) => o.textContent.trim().toLowerCase().startsWith(searchBuffer))
        if (!match) return
        clearActive()
        match.classList.add("csActive")
        match.scrollIntoView({ block: "nearest" })
    }

    trigger.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault()
            if (!menu.classList.contains("csOpen")) {
                trigger.click()
                return
            }
            const active = menu.querySelector(".csOption.csActive")
            if (active) {
                const opt = Array.from(select.options).find((o) => o.value === active.dataset.val)
                if (opt) chooseOption(opt)
            }
            return
        }
        if (e.key === "Escape") {
            closeMenu()
            return
        }
        if (e.key.length === 1 && /[a-z0-9]/i.test(e.key)) {
            e.preventDefault()
            if (!menu.classList.contains("csOpen")) {
                trigger.click()
            }
            clearTimeout(searchTimer)
            searchBuffer += e.key.toLowerCase()
            jumpToSearch()
            searchTimer = setTimeout(() => {
                searchBuffer = ""
            }, 800)
        }
    })

    document.addEventListener("click", closeMenu)
    document.addEventListener(
        "scroll",
        (e) => {
            if (!menu.contains(e.target)) closeMenu()
        },
        true
    )

    select.addEventListener("change", () => {
        syncLabel()
        syncOptions()
    })

    new MutationObserver(() => {
        syncOptions()
        syncLabel()
    }).observe(select, { childList: true })
}

// Las fechas se teclean a mano en formato dd-mm-aaaa en todos los popups. Para
// no escribir la de hoy una y otra vez, cada campo de fecha recibe un botón
// "Hoy" que la rellena. Se detectan por el placeholder, común a todos ellos.
const _DATE_INPUT_PLACEHOLDER = /^dd[-/]mm[-/](aaaa|yyyy)$/i

function todayDateString() {
    const now = new Date()
    const day = String(now.getDate()).padStart(2, "0")
    const month = String(now.getMonth() + 1).padStart(2, "0")
    return `${day}-${month}-${now.getFullYear()}`
}

function _buildDateTodayButton(input) {
    if (input.dataset.todayBtn === "1") return
    if (!_DATE_INPUT_PLACEHOLDER.test((input.getAttribute("placeholder") || "").trim())) return
    if (!input.parentNode) return

    input.dataset.todayBtn = "1"

    const wrap = document.createElement("div")
    wrap.className = "dateFieldWrap"
    input.parentNode.insertBefore(wrap, input)
    wrap.appendChild(input)

    const button = document.createElement("button")
    button.type = "button"
    button.className = "dateTodayBtn"
    button.textContent = "Hoy"
    button.title = "Poner la fecha de hoy"
    button.tabIndex = -1
    button.addEventListener("click", () => {
        input.value = todayDateString()
        input.dispatchEvent(new Event("input", { bubbles: true }))
        input.dispatchEvent(new Event("change", { bubbles: true }))
        input.focus()
    })

    wrap.appendChild(button)
}

new MutationObserver((mutations) => {
    for (const m of mutations) {
        for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue
            if (node.tagName === "SELECT" && !node.hasAttribute("data-no-custom")) _buildCustomSelect(node)
            node.querySelectorAll?.("select:not([data-no-custom])").forEach(_buildCustomSelect)
            if (node.tagName === "INPUT") _buildDateTodayButton(node)
            node.querySelectorAll?.("input[placeholder]").forEach(_buildDateTodayButton)
        }
    }
}).observe(document.body, { childList: true, subtree: true })

document.querySelectorAll("select:not([data-no-custom])").forEach(_buildCustomSelect)
document.querySelectorAll("input[placeholder]").forEach(_buildDateTodayButton)
