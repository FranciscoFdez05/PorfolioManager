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

function _nl() { return window._numLocale || "es-ES" }

function formatEuro(value) {
    return new Intl.NumberFormat(_nl(), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value) + " €"
}

function formatDollar(value) {
    return new Intl.NumberFormat(_nl(), {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(value) + " $"
}

function normalizeCurrencyCode(currency) {
    const normalized = String(currency || "EUR").trim().toUpperCase()

    if (!normalized) {
        return "EUR"
    }

    if (["USD", "USDT", "USDC", "BUSD", "DAI", "FDUSD", "PYUSD", "TUSD", "USDE"].includes(normalized) || normalized.endsWith("USD")) {
        return "USD"
    }

    if (["EUR", "EURC"].includes(normalized) || normalized.endsWith("EUR")) {
        return "EUR"
    }

    return normalized || "EUR"
}

function formatMoneyWithDecimals(value, currency = "EUR", decimals = 2) {
    const normalizedCurrency = normalizeCurrencyCode(currency)
    const formattedNumber = new Intl.NumberFormat(_nl(), {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
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

function selectEditableCellContent(cell) {
    if (!cell) {
        return
    }

    const selection = window.getSelection()

    if (!selection) {
        return
    }

    const range = document.createRange()
    range.selectNodeContents(cell)
    selection.removeAllRanges()
    selection.addRange(range)
}

function getCurrentAssetCurrency() {
    return document.querySelector(".assetTablePage")?.dataset.assetCurrency || "EUR"
}

function getCurrentAssetPriceCurrency() {
    const assetPage = document.querySelector(".assetTablePage")
    return assetPage?.dataset.assetPriceCurrency || assetPage?.dataset.assetCurrency || "EUR"
}

function normalizeAssetRowCurrency(currency, fallback = "EUR") {
    const normalized = String(currency || fallback).trim().toUpperCase()
    return normalized === "USD" ? "USD" : "EUR"
}

function getAssetRowCurrency(rowOrCell, fallback = getCurrentAssetCurrency()) {
    const rowElement = rowOrCell?.closest ? rowOrCell.closest("tr") : null
    const explicitCurrency = rowElement?.querySelector('select[data-field="currency"]')?.value
        || rowElement?.querySelector('td[data-field="currency"]')?.textContent?.trim()
    return normalizeAssetRowCurrency(explicitCurrency, fallback)
}

function formatMoneySafe(value, currency = "EUR") {
    const parsed = parseLooseNumber(value)
    if (parsed === null) {
        return ""
    }

    return formatMoney(parsed, currency)
}

function normalizeNumberForEdit(value) {
    const parsedValue = Number(value)

    if (!Number.isFinite(parsedValue)) {
        return String(value ?? "").replace(".", ",")
    }

    return parsedValue.toLocaleString("es-ES", {
        useGrouping: false,
        minimumFractionDigits: 0,
        maximumFractionDigits: 12
    })
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
    const normalizedType = String(assetType || "").trim().toLowerCase()

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
        addYearBtn.addEventListener("click", () => { closeDividendosMenu(); addDividendosYear() })
    }

    const deleteYearBtn = document.getElementById("deleteDividendosYearBtn")
    if (deleteYearBtn && !deleteYearBtn.dataset.bound) {
        deleteYearBtn.dataset.bound = "true"
        deleteYearBtn.addEventListener("click", () => { closeDividendosMenu(); deleteCurrentDividendosYear() })
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
    return cell?.dataset?.field === "comisiones" ||
        cell?.dataset?.field === "comisionesFiat" ||
        getTableHeaderText(cell) === "comisiones" ||
        getTableHeaderText(cell) === "comisiones fiat"
}

function isAssetCryptoCommissionsCell(cell) {
    return cell?.dataset?.field === "comisionesSatoshis" ||
        cell?.dataset?.field === "comisionesCripto" ||
        getTableHeaderText(cell) === "comisiones cripto"
}

function isCryptoAssetType(assetType) {
    return String(assetType || "").trim().toLowerCase() === "cripto"
}

function getAssetTableMoneyCurrency(assetType, fieldName, assetCurrency = "EUR", priceCurrency = assetCurrency, rowCurrency = "") {
    if (isCryptoAssetType(assetType) && ["precioParticipacion", "capitalInvertidoBruto", "comisiones", "comisionesFiat", "capitalInvertidoNeto"].includes(fieldName)) {
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

function formatAssetCommissionValue(value, currency = "EUR") {
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

function fmtDate(date) {
    const d = date instanceof Date ? date : new Date(date)
    if (isNaN(d)) return ""
    const dd   = String(d.getDate()).padStart(2, "0")
    const mm   = String(d.getMonth() + 1).padStart(2, "0")
    const yyyy = d.getFullYear()
    const fmt  = window._dateFormat || "DD/MM/YYYY"
    if (fmt === "MM/DD/YYYY") return `${mm}/${dd}/${yyyy}`
    if (fmt === "YYYY-MM-DD") return `${yyyy}-${mm}-${dd}`
    return `${dd}/${mm}/${yyyy}`
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
            cell.textContent = currentCurrency === "EUR"
                ? formatEuroSafe(text)
                : formatDollarSafe(text)
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
function getVisibleAssetTable() {
    return Array.from(document.querySelectorAll("table")).find((table) => {
        const headerText = (table.querySelector("thead")?.textContent || "").toLowerCase()
        return headerText.includes("fecha operación") && headerText.includes("participaciones")
    }) || null
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

// ── Generic table sort ──────────────────────────────────────────────────────

function bindTableSort(table, storageKey) {
    if (!table || table._sortBound) return
    table._sortBound = true

    const lsKey = storageKey ? `tableSort_${storageKey}` : null
    let saved = null
    if (lsKey) {
        try { saved = JSON.parse(localStorage.getItem(lsKey)) } catch {}
    }

    let currentKey = saved?.key ?? null
    let currentDir = saved?.dir ?? "desc"

    function persist() {
        if (!lsKey) return
        try { localStorage.setItem(lsKey, JSON.stringify({ key: currentKey, dir: currentDir })) } catch {}
    }

    function cellText(row, colIdx) {
        const cell = row.cells[colIdx]
        if (!cell) return ""
        const sel = cell.querySelector("select")
        if (sel) return sel.value
        return cell.textContent.trim()
    }

    function toComparable(text) {
        const dm = text.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})$/)
        if (dm) {
            const y = dm[3].length === 2 ? 2000 + +dm[3] : +dm[3]
            return new Date(y, +dm[2] - 1, +dm[1]).getTime()
        }
        const n = parseFloat(text.replace(/\./g, "").replace(",", ".").replace(/[^\d.-]/g, ""))
        if (!isNaN(n)) return n
        return text.toLowerCase()
    }

    function doSort() {
        if (currentKey === null) return
        const tbody = table.querySelector("tbody")
        if (!tbody) return
        const colIdx = Number(currentKey)
        const rows = [...tbody.querySelectorAll("tr")]
        rows.sort((a, b) => {
            const av = toComparable(cellText(a, colIdx))
            const bv = toComparable(cellText(b, colIdx))
            if (av < bv) return currentDir === "asc" ? -1 : 1
            if (av > bv) return currentDir === "asc" ? 1 : -1
            return 0
        })
        rows.forEach((r) => tbody.appendChild(r))
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

    function positionMenu() {
        const rect   = trigger.getBoundingClientRect()
        const left   = Math.round(rect.left)
        const width  = Math.round(rect.width)
        const bottom = Math.round(rect.bottom)
        const top    = Math.round(rect.top)

        menu.style.position = "fixed"
        menu.style.left  = left + "px"
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
            menu.style.top = (top - menuH) + "px"
        } else {
            menu.style.top = bottom + "px"
        }
    }

    function closeMenu() {
        menu.classList.remove("csOpen")
        menu.style.display = "none"
        trigger.classList.remove("csOpen")
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
                select.value = opt.value
                select.dispatchEvent(new Event("change", { bubbles: true }))
                syncLabel()
                syncOptions()
                closeMenu()
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

    document.addEventListener("click", closeMenu)
    document.addEventListener("scroll", (e) => {
        if (!menu.contains(e.target)) closeMenu()
    }, true)

    select.addEventListener("change", () => {
        syncLabel()
        syncOptions()
    })

    new MutationObserver(() => {
        syncOptions()
        syncLabel()
    }).observe(select, { childList: true })
}

new MutationObserver((mutations) => {
    for (const m of mutations) {
        for (const node of m.addedNodes) {
            if (node.nodeType !== 1) continue
            if (node.tagName === "SELECT" && !node.hasAttribute("data-no-custom")) _buildCustomSelect(node)
            node.querySelectorAll?.("select:not([data-no-custom])").forEach(_buildCustomSelect)
        }
    }
}).observe(document.body, { childList: true, subtree: true })

document.querySelectorAll("select:not([data-no-custom])").forEach(_buildCustomSelect)
