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
    initResizeHandles()
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
    await loadGlobalSettings()
    await refreshAssetsSidebar()
    await refreshTopDividendosIntereses()

    initMoneyToggle()
    loadPage("vistaGeneral")
    refreshOverviewMarketData()
})

async function loadGlobalSettings() {
    try {
        const res  = await fetch("/api/settings")
        const data = await res.json()
        if (data.ok) {
            window._settingsStaleHours      = data.staleHours ?? 24
            window._hiddenAssets            = new Set(data.hiddenAssets || [])
            window._metricasDisplayType     = data.metricasDisplayType ?? "doughnut"
            window._metricasDistMetric      = data.metricasDistMetric  ?? "netoActualEur"
            window._metricasComparativaExcluded = data.comparativaExcluded ?? []
            window._gastosHiddenTipos           = data.gastosHiddenTipos ?? []
            window._gastosHiddenMensualidades   = data.gastosHiddenMensualidades ?? []
            window._metricasActivosHidden       = data.metricasActivosHidden ?? []
        }
    } catch {
        window._settingsStaleHours      = 24
        window._hiddenAssets            = new Set()
        window._metricasDisplayType     = "doughnut"
        window._metricasDistMetric      = "netoActualEur"
        window._metricasComparativaExcluded = []
        window._gastosHiddenTipos           = []
        window._gastosHiddenMensualidades   = []
        window._metricasActivosHidden       = []
    }
}

let dividendosAutosaveTimeout = null
let assetAutosaveTimeout = null
let currentAssetId = null
let assetModalState = null
let confirmModalState = null
let editAssetModalState = null
let draggedAssetId = null
const PAGE_HTML_VERSION = "20260426a"

function initSidePanel(toggleButton, sideWrapper) {
    if (!toggleButton || !sideWrapper) {
        return
    }

    toggleButton.addEventListener("click", () => {
        sideWrapper.classList.toggle("collapsed")
        toggleButton.innerHTML = sideWrapper.classList.contains("collapsed") ? "◀" : "▶"
    })

    sideWrapper.addEventListener("transitionend", (e) => {
        if (e.propertyName === "width" && typeof window._resizeChartsOnSidebarChange === "function") {
            window._resizeChartsOnSidebarChange()
        }
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
            document.querySelectorAll(".csMenu.csOpen").forEach((m) => {
                m.classList.remove("csOpen")
                m._csTrigger?.classList.remove("csOpen")
            })
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
        document.querySelectorAll(".csBodyMenu").forEach(m => m.remove())
        contentArea.innerHTML = htmlContent

        if (page === "vistaGeneral") {
            await initVistaGeneralLogic()
        } else if (page === "intereses") {
            await initInteresesLogic()
        } else if (page === "dividendos") {
            await initDividendosLogic()
        } else if (page === "gastos") {
            await initGastosLogic()
        } else if (page === "ingresos") {
            await initIngresosLogic()
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
        } else if (page === "metricas") {
            await initMetricasLogic()
        } else if (page === "activos") {
            await initActivosPageLogic()
        } else if (page === "ajustes") {
            await initAjustesLogic()
        }
    } catch (error) {
        console.error(error)
        const details = error instanceof Error ? error.message : "Error desconocido"
        contentArea.innerHTML = `<div class="pageError">Error de carga: no se pudo abrir ${page}.html<br><small>${details}</small></div>`
    }
}

async function initInteresesLogic() {
    currentInteresesYear = null
    await renderInteresesTable()

    const interesesBody = document.getElementById("interesesBody")
    const addRowButton = document.getElementById("addRowBtn")
    const addYearButton = document.getElementById("addInteresesYearBtn")
    const deleteYearButton = document.getElementById("deleteInteresesYearBtn")

    if (interesesBody && !interesesBody.dataset.bound) {
        interesesBody.dataset.bound = "true"
        interesesBody.addEventListener("click", handleInteresesRowActionClick)
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => addNewInteresesRow())
    }

    if (addYearButton && !addYearButton.dataset.bound) {
        addYearButton.dataset.bound = "true"
        addYearButton.addEventListener("click", addInteresesYear)
    }

    if (deleteYearButton && !deleteYearButton.dataset.bound) {
        deleteYearButton.dataset.bound = "true"
        deleteYearButton.addEventListener("click", deleteCurrentInteresesYear)
    }

    const interesesTable = document.querySelector(".interesesTable")
    if (interesesTable) bindTableSort(interesesTable)
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
        set("topTotalRentaFija", totalBonos + totalRentaFija)
    } catch (error) {
        console.error("Error actualizando métricas de dividendos/intereses:", error)
    }
}

function initResizeHandles() {
    const SIDE_MIN = 220
    const SIDE_MAX = 600
    const DETAIL_MIN = 80
    const DETAIL_MAX = 520

    const sideWrapper    = document.getElementById("sideWrapper")
    const sideHandle     = document.getElementById("sideResizeHandle")
    const detailView     = document.getElementById("assetDetailView")
    const detailHandle   = document.getElementById("detailResizeHandle")
    const sidePanel      = document.getElementById("sidePanel")

    if (sideWrapper && sideHandle) {
        let startX, startW

        sideHandle.addEventListener("mousedown", (e) => {
            e.preventDefault()
            startX = e.clientX
            startW = sideWrapper.getBoundingClientRect().width
            sideHandle.classList.add("dragging")
            document.body.style.cursor = "col-resize"
            document.body.style.userSelect = "none"

            function onMove(e) {
                const delta = startX - e.clientX
                const newW  = Math.min(SIDE_MAX, Math.max(SIDE_MIN, startW + delta))
                sideWrapper.style.width    = newW + "px"
                sideWrapper.style.minWidth = newW + "px"
                document.documentElement.style.setProperty("--sidebar-width", newW + "px")
            }

            function onUp() {
                sideHandle.classList.remove("dragging")
                document.body.style.cursor = ""
                document.body.style.userSelect = ""
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
            }

            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })
    }

    if (detailView && detailHandle && sidePanel) {
        let startY, startH

        detailHandle.addEventListener("mousedown", (e) => {
            e.preventDefault()
            startY = e.clientY
            startH = detailView.getBoundingClientRect().height
            detailHandle.classList.add("dragging")
            document.body.style.cursor = "row-resize"
            document.body.style.userSelect = "none"

            function onMove(e) {
                const delta = startY - e.clientY
                const newH  = Math.min(DETAIL_MAX, Math.max(DETAIL_MIN, startH + delta))
                detailView.style.flex = `0 0 ${newH}px`
            }

            function onUp() {
                detailHandle.classList.remove("dragging")
                document.body.style.cursor = ""
                document.body.style.userSelect = ""
                document.removeEventListener("mousemove", onMove)
                document.removeEventListener("mouseup", onUp)
            }

            document.addEventListener("mousemove", onMove)
            document.addEventListener("mouseup", onUp)
        })
    }
}

function initMoneyToggle() {
    const btn = document.getElementById("toggleMoneyBtn")
    if (!btn) return
    const hidden = localStorage.getItem("moneyHidden") === "1"
    if (hidden) {
        document.body.classList.add("money-hidden")
        btn.classList.add("money-hidden-active")
        btn.title = "Mostrar valores"
        btn.textContent = "🙈"
    }
    btn.addEventListener("click", () => {
        const isHidden = document.body.classList.toggle("money-hidden")
        btn.classList.toggle("money-hidden-active", isHidden)
        btn.title = isHidden ? "Mostrar valores" : "Ocultar valores"
        btn.textContent = isHidden ? "🙈" : "👁"
        localStorage.setItem("moneyHidden", isHidden ? "1" : "0")
    })
}

