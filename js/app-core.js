document.addEventListener("DOMContentLoaded", async () => {
    const toggleButton = document.getElementById("togglePanel")
    const sideWrapper = document.getElementById("sideWrapper")
    const navButtons = document.querySelectorAll(".navBtn")
    const contentArea = document.getElementById("dynamicContent")
    const addAssetButton = document.getElementById("addAssetBtn")
    const refreshSidebarMarketButton = document.getElementById("refreshSidebarMarketBtn")
    const assetModalOverlay = document.getElementById("assetModalOverlay")
    const confirmAssetModalButton = document.getElementById("confirmAssetModalBtn")
    const cancelAssetModalButton = document.getElementById("cancelAssetModalBtn")
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const assetTickerInput = document.getElementById("assetTickerInput")
    const searchAssetTickerFinnhubButton = document.getElementById("searchAssetTickerFinnhubBtn")
    const searchAssetTickerEodhdButton = document.getElementById("searchAssetTickerEodhdBtn")
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalCancelButton = document.getElementById("confirmModalCancelBtn")

    initSidePanel(toggleButton, sideWrapper)
    initNavigation(navButtons, contentArea)
    initAddAssetButton(addAssetButton, assetModalOverlay, assetNameInput, assetTypeSelect, assetTickerInput)
    initSidebarRefreshButton(refreshSidebarMarketButton)
    initAssetModal(
        assetModalOverlay,
        confirmAssetModalButton,
        cancelAssetModalButton,
        assetNameInput,
        assetTypeSelect,
        assetTickerInput,
        searchAssetTickerFinnhubButton,
        searchAssetTickerEodhdButton
    )
    initConfirmModal(confirmModalOverlay, confirmModalAcceptButton, confirmModalCancelButton)
    await refreshAssetsSidebar()
    await refreshTopDividendosIntereses()

    loadPage("vistaGeneral")
    refreshOverviewMarketData()

    initBackupModal()
})

let dividendosAutosaveTimeout = null
let assetAutosaveTimeout = null
let currentAssetId = null
let assetModalState = null
let confirmModalState = null
let editAssetModalState = null
let draggedAssetId = null
const PAGE_HTML_VERSION = "20260420d"

function initSidePanel(toggleButton, sideWrapper) {
    if (!toggleButton || !sideWrapper) {
        return
    }

    toggleButton.addEventListener("click", () => {
        sideWrapper.classList.toggle("collapsed")
        toggleButton.innerHTML = sideWrapper.classList.contains("collapsed") ? "◀" : "▶"
    })
}

function clearNavSelection() {
    document.querySelectorAll(".navBtn").forEach((button) => button.classList.remove("active"))
    document.querySelectorAll(".navDropdownBtn").forEach((button) => button.classList.remove("active"))
}

function initAssetSelector(assetButtons) {
    if (!assetButtons.length) {
        return
    }

    assetButtons.forEach((button) => {
        button.addEventListener("click", async () => {
            clearNavSelection()
            await selectAsset(button.dataset.assetId || "")
        })
    })
}

function initNavigation(navButtons, contentArea) {
    navButtons.forEach((button) => {
        button.addEventListener("click", () => {
            navButtons.forEach((item) => item.classList.remove("active"))
            document.querySelectorAll(".navDropdownBtn").forEach((b) => b.classList.remove("active"))
            button.classList.add("active")

            const parentMenu = button.closest(".navDropdown")
            if (parentMenu) {
                parentMenu.querySelector(".navDropdownBtn").classList.add("active")
                parentMenu.querySelector(".navDropdownMenu").classList.remove("open")
            }

            const page = button.dataset.page
            loadPage(page, contentArea)
        })
    })

    document.querySelectorAll(".navDropdownBtn").forEach((btn) => {
        btn.addEventListener("click", (e) => {
            e.stopPropagation()
            const menu = btn.nextElementSibling
            const isOpen = menu.classList.contains("open")
            document.querySelectorAll(".navDropdownMenu.open").forEach((m) => m.classList.remove("open"))
            if (!isOpen) menu.classList.add("open")
        })
    })

    document.addEventListener("click", () => {
        document.querySelectorAll(".navDropdownMenu.open").forEach((m) => m.classList.remove("open"))
    })
}

async function loadPage(page, contentArea = document.getElementById("dynamicContent")) {
    if (!contentArea) {
        return
    }

    try {
        if (typeof window.flushPendingPageChanges === "function") {
            try {
                await window.flushPendingPageChanges()
            } catch (flushError) {
                console.error("No se pudieron guardar los cambios pendientes antes de cambiar de página:", flushError)
            } finally {
                window.flushPendingPageChanges = null
            }
        }

        const response = await fetch(`./html/${page}.html?v=${PAGE_HTML_VERSION}`, {
            cache: "no-store"
        })

        if (!response.ok) {
            throw new Error(`No se pudo cargar ${page}.html`)
        }

        const htmlContent = await response.text()
        contentArea.innerHTML = htmlContent

        if (page === "vistaGeneral") {
            await initVistaGeneralLogic()
        } else if (page === "intereses") {
            await initInteresesLogic()
        } else if (page === "dividendos") {
            await initDividendosLogic()
        } else if (page === "gastos") {
            await initGastosLogic()
        } else if (page === "ventas") {
            await initVentasLogic()
        } else if (page === "stablecoins") {
            await initStablecoinsLogic()
        } else if (page === "transacciones") {
            await initTransaccionesLogic()
        } else if (page === "operaciones") {
            await initOperacionesLogic()
        } else if (page === "conversiones") {
            await initConversionesLogic()
        } else if (page === "herramientas") {
            await initHerramientasLogic()
        } else if (page === "bonos") {
            await initBonosLogic()
        } else if (page === "rentaFija") {
            await initRentaFijaLogic()
        } else if (page === "metricas") {
            await initMetricasLogic()
        } else if (page === "activos") {
            await initActivosPageLogic()
        }
    } catch (error) {
        console.error(error)
        const details = error instanceof Error ? error.message : "Error desconocido"
        contentArea.innerHTML = `<div class="pageError">Error de carga: no se pudo abrir ${page}.html<br><small>${details}</small></div>`
    }
}

async function initInteresesLogic() {
    await renderInteresesTable()

    const interesesBody = document.getElementById("interesesBody")
    const addRowButton = document.getElementById("addRowBtn")
    const exportJsonButton = document.getElementById("exportJsonBtn")
    const importJsonButton = document.getElementById("importJsonBtn")
    const saveInteresesButton = document.getElementById("saveInteresesBtn")

    if (interesesBody) {
        interesesBody.addEventListener("input", () => {
            updateTotals()
        })

        interesesBody.addEventListener("click", handleRowDeleteClick)
        interesesBody.addEventListener("focus", handleCellFocus, true)
        interesesBody.addEventListener("blur", handleCellBlur, true)
    }

    if (addRowButton) {
        addRowButton.addEventListener("click", () => {
            addNewInteresesRow()
        })
    }

    if (exportJsonButton) {
        exportJsonButton.addEventListener("click", () => {
            exportInteresesJson()
        })
    }

    if (importJsonButton) {
        importJsonButton.addEventListener("click", () => {
            importInteresesJson()
        })
    }

    if (saveInteresesButton) {
        saveInteresesButton.addEventListener("click", async () => {
            try {
                await saveInteresesDataToServer()
                alert("Datos guardados en data/intereses.json")
            } catch (error) {
                alert("Error al guardar: " + error.message)
            }
        })
    }

}




function handleCellFocus(event) {
    const cell = event.target

    if (cell.tagName !== "TD") {
        return
    }

    const tableBody = cell.closest('tbody')
    const columnIndex = cell.cellIndex

    if (tableBody.id === 'interesesBody') {
        if (columnIndex === 2 || columnIndex === 3 || columnIndex === 4) {
            const value = parseEuroNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }
    } else if (tableBody.id === 'dividendosBody') {
        if (columnIndex === 3) {
            const value = parseLooseNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }

        if (columnIndex === 4 || columnIndex === 5) {
            const value = parseEuroNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }
    } else if (tableBody.id === 'assetOperationsBody') {
        const fieldName = cell.dataset.field || ""
        const assetType = getCurrentAssetType()
        const assetCurrency = getCurrentAssetCurrency()
        const assetPriceCurrency = getCurrentAssetPriceCurrency()
        const rowCurrency = getAssetRowCurrency(cell, assetCurrency)

        if (fieldName === "participaciones") {
            const value = parseLooseNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value ?? 0)
            }
        }

        if (fieldName === "comisiones" && isCryptoAssetType(assetType)) {
            const value = parseLooseNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value ?? 0)
            }
        } else if (["precioParticipacion", "capitalInvertidoBruto", "comisiones", "comisionesFiat"].includes(fieldName)) {
            const moneyCurrency = getAssetTableMoneyCurrency(assetType, fieldName || "precioParticipacion", assetCurrency, assetPriceCurrency, rowCurrency)
            const value = moneyCurrency === "EUR"
                ? parseEuroNumber(cell.textContent)
                : parseDollarNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }

        if (fieldName === "comisionesSatoshis" || fieldName === "comisionesCripto") {
            const value = parseLooseNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value ?? 0)
            }
        }
    }
}

async function refreshTopDividendosIntereses() {
    try {
        const [interesesData, dividendosData, bonosResp, rfResp] = await Promise.all([
            loadInteresesData(),
            loadDividendosData(),
            fetch("/api/bonos").then((r) => r.json()).catch(() => ({ rows: [] })),
            fetch("/api/rentafija").then((r) => r.json()).catch(() => ({ rows: [] }))
        ])

        const totalInteres = (Array.isArray(interesesData?.rows) ? interesesData.rows : [])
            .reduce((sum, row) => sum + (parseEuroNumber(row.acumulado) - parseEuroNumber(row.impuestos)), 0)

        const totalDividendos = (Array.isArray(dividendosData?.rows) ? dividendosData.rows : [])
            .reduce((sum, row) => sum + parseEuroNumber(row.total), 0)

        const totalBonos = (Array.isArray(bonosResp?.rows) ? bonosResp.rows : [])
            .reduce((sum, r) => sum + parseEuroNumber(r.interesAcumulado) - parseEuroNumber(r.impuestos), 0)

        const totalRentaFija = (Array.isArray(rfResp?.rows) ? rfResp.rows : [])
            .reduce((sum, r) => sum + parseEuroNumber(r.interesAcumulado) - parseEuroNumber(r.impuestos), 0)

        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = formatEuro(val) }
        set("topTotalInteres", totalInteres)
        set("topTotalDividendos", totalDividendos)
        set("topTotalBonos", totalBonos)
        set("topTotalRentaFija", totalRentaFija)
    } catch (error) {
        console.error("Error actualizando métricas de dividendos/intereses:", error)
    }
}

// --- Backup / Restore ---

function initBackupModal() {
    const openBtn = document.getElementById("openBackupModalBtn")
    const overlay = document.getElementById("backupModalOverlay")
    const closeBtn = document.getElementById("closeBackupModalBtn")
    const createBtn = document.getElementById("createBackupBtn")
    const statusMsg = document.getElementById("backupStatusMsg")
    const backupList = document.getElementById("backupList")

    if (!openBtn || !overlay) return

    openBtn.addEventListener("click", () => {
        overlay.classList.remove("hidden")
        statusMsg.textContent = ""
        statusMsg.className = "backupStatusMsg"
        loadBackupList()
    })

    closeBtn.addEventListener("click", () => overlay.classList.add("hidden"))
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.add("hidden") })

    createBtn.addEventListener("click", async () => {
        createBtn.disabled = true
        statusMsg.textContent = "Creando backup..."
        statusMsg.className = "backupStatusMsg"
        try {
            const res = await fetch("/api/backup", { method: "POST" })
            const data = await res.json()
            if (data.ok) {
                statusMsg.textContent = `Backup creado: ${data.filename}`
                renderBackupList(data.backups)
            } else {
                statusMsg.textContent = "Error al crear backup"
                statusMsg.className = "backupStatusMsg error"
            }
        } catch {
            statusMsg.textContent = "Error de red"
            statusMsg.className = "backupStatusMsg error"
        } finally {
            createBtn.disabled = false
        }
    })

    async function loadBackupList() {
        backupList.innerHTML = '<span class="backupEmpty">Cargando...</span>'
        try {
            const res = await fetch("/api/backups")
            const data = await res.json()
            renderBackupList(data.backups || [])
        } catch {
            backupList.innerHTML = '<span class="backupEmpty">Error al cargar</span>'
        }
    }

    function renderBackupList(backups) {
        if (!backups.length) {
            backupList.innerHTML = '<span class="backupEmpty">No hay backups disponibles</span>'
            return
        }
        backupList.innerHTML = ""
        backups.forEach((filename) => {
            const item = document.createElement("div")
            item.className = "backupItem"
            const label = document.createElement("span")
            label.className = "backupItemName"
            label.textContent = filename.replace("portfolio_", "").replace(".db", "").replace(/_/g, " ")
            const btn = document.createElement("button")
            btn.className = "backupRestoreBtn"
            btn.textContent = "Restaurar"
            btn.addEventListener("click", () => restoreBackup(filename, btn, statusMsg))
            item.appendChild(label)
            item.appendChild(btn)
            backupList.appendChild(item)
        })
    }

    async function restoreBackup(filename, btn, statusMsg) {
        if (!confirm(`¿Restaurar backup ${filename}? Se sobreescribirán todos los datos actuales.`)) return
        btn.disabled = true
        statusMsg.textContent = "Restaurando..."
        statusMsg.className = "backupStatusMsg"
        try {
            const res = await fetch("/api/restore", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ filename })
            })
            const data = await res.json()
            if (data.ok) {
                statusMsg.textContent = "Restaurado. Recargando página..."
                setTimeout(() => window.location.reload(), 1500)
            } else {
                statusMsg.textContent = data.error || "Error al restaurar"
                statusMsg.className = "backupStatusMsg error"
                btn.disabled = false
            }
        } catch {
            statusMsg.textContent = "Error de red"
            statusMsg.className = "backupStatusMsg error"
            btn.disabled = false
        }
    }
}

