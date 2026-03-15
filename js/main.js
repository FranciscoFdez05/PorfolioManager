document.addEventListener("DOMContentLoaded", async () => {
    const toggleButton = document.getElementById("togglePanel")
    const sideWrapper = document.getElementById("sideWrapper")
    const navButtons = document.querySelectorAll(".navBtn")
    const contentArea = document.getElementById("dynamicContent")
    const addAssetButton = document.getElementById("addAssetBtn")
    const moveAssetUpButton = document.getElementById("moveAssetUpBtn")
    const moveAssetDownButton = document.getElementById("moveAssetDownBtn")
    const assetModalOverlay = document.getElementById("assetModalOverlay")
    const confirmAssetModalButton = document.getElementById("confirmAssetModalBtn")
    const cancelAssetModalButton = document.getElementById("cancelAssetModalBtn")
    const assetNameInput = document.getElementById("assetNameInput")
    const assetTypeSelect = document.getElementById("assetTypeSelect")
    const confirmModalOverlay = document.getElementById("confirmModalOverlay")
    const confirmModalAcceptButton = document.getElementById("confirmModalAcceptBtn")
    const confirmModalCancelButton = document.getElementById("confirmModalCancelBtn")

    initSidePanel(toggleButton, sideWrapper)
    initNavigation(navButtons, contentArea)
    initAddAssetButton(addAssetButton, assetModalOverlay, assetNameInput, assetTypeSelect)
    initAssetOrderButtons(moveAssetUpButton, moveAssetDownButton)
    initAssetModal(assetModalOverlay, confirmAssetModalButton, cancelAssetModalButton, assetNameInput, assetTypeSelect)
    initConfirmModal(confirmModalOverlay, confirmModalAcceptButton, confirmModalCancelButton)
    await refreshAssetsSidebar()

    loadPage("vistaGeneral")
})

let dividendosAutosaveTimeout = null
let assetAutosaveTimeout = null
let currentAssetId = null
let assetModalState = null
let confirmModalState = null
let draggedAssetId = null

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
    document.querySelectorAll(".navBtn").forEach((button) => {
        button.classList.remove("active")
    })
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
            button.classList.add("active")

            const page = button.dataset.page
            loadPage(page, contentArea)
        })
    })
}

async function loadPage(page, contentArea = document.getElementById("dynamicContent")) {
    if (!contentArea) {
        return
    }

    try {
        const response = await fetch(`./html/${page}.html`)

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
        }
    } catch (error) {
        console.error(error)
        contentArea.innerHTML = `<div class="pageError">Error de carga: no se pudo abrir ${page}.html</div>`
    }
}

async function initInteresesLogic() {
    await renderInteresesTable()

    const interesesBody = document.getElementById("interesesBody")
    const addRowButton = document.getElementById("addRowBtn")
    const exportJsonButton = document.getElementById("exportJsonBtn")
    const importJsonButton = document.getElementById("importJsonBtn")
    const resetInteresesButton = document.getElementById("resetInteresesBtn")
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

    if (resetInteresesButton) {
        resetInteresesButton.addEventListener("click", async () => {
            const confirmReset = confirm("Esto restablecerá los datos de intereses del archivo del proyecto. ¿Seguro que quieres continuar?")

            if (!confirmReset) {
                return
            }

            await resetInteresesDataOnServer()
            await renderInteresesTable()
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
        if (columnIndex === 1 || columnIndex === 2 || columnIndex === 3) {
            const value = parseEuroNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }
    } else if (tableBody.id === 'dividendosBody') {
        if (columnIndex === 3) {
            const value = parseDollarNumber(cell.textContent)

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
        if (columnIndex === 3 || columnIndex === 4 || columnIndex === 5) {
            const value = parseEuroNumber(cell.textContent)

            if (cell.textContent.trim() !== "") {
                cell.textContent = normalizeNumberForEdit(value)
            }
        }
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

async function createAssetOnServer(name, type) {
    const response = await fetch("/api/activos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ name, type })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function reorderAssetOnServer(assetId, direction) {
    const response = await fetch("/api/activos/reorder", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ assetId, direction })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
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

function updateAssetDetail(asset) {
    const detSymbol = document.getElementById("detSymbol")
    const detName = document.getElementById("detName")

    if (detSymbol) {
        detSymbol.textContent = asset.symbol || "---"
    }

    if (detName) {
        detName.textContent = asset.name || "Activo"
    }
}

function renderAssetsList(assets) {
    const assetsList = document.getElementById("assetsList")

    if (!assetsList) {
        return
    }

    assetsList.innerHTML = ""

    assets.forEach((asset) => {
        const button = document.createElement("button")
        button.className = `assetBtn${asset.id === currentAssetId ? " selected" : ""}`
        button.dataset.assetId = asset.id
        button.dataset.assetOrder = String(asset.order ?? 0)
        button.draggable = true
        button.innerHTML = `
            <span>${asset.symbol || asset.name}</span>
            <span>${asset.price || "0,00"}</span>
        `
        assetsList.appendChild(button)
    })

    initAssetSelector([...assetsList.querySelectorAll(".assetBtn")])
    initAssetDragAndDrop(assetsList)
}

async function refreshAssetsSidebar(selectedAssetId = currentAssetId, renderTable = false) {
    try {
        const assets = await loadAssetsList()
        renderAssetsList(assets)
        await refreshOverviewIfVisible()

        if (!assets.length) {
            currentAssetId = null
            const detSymbol = document.getElementById("detSymbol")
            const detName = document.getElementById("detName")

            if (detSymbol) {
                detSymbol.textContent = "---"
            }

            if (detName) {
                detName.textContent = "Selecciona un activo"
            }

            return
        }

        const assetIdToSelect = selectedAssetId || assets[0].id
        currentAssetId = assetIdToSelect
        renderAssetsList(assets)

        const selectedAsset = assets.find((asset) => asset.id === assetIdToSelect) || assets[0]
        const fullAsset = await loadAssetData(selectedAsset.id)
        updateAssetDetail(fullAsset)

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
    updateAssetDetail(assetData)
    renderAssetsList(await loadAssetsList())
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

async function initVistaGeneralLogic() {
    const filtersContainer = document.getElementById("overviewFilters")

    if (filtersContainer && !filtersContainer.dataset.bound) {
        filtersContainer.dataset.bound = "true"
        filtersContainer.addEventListener("change", () => {
            renderVistaGeneralTable()
        })
    }

    await renderVistaGeneralTable()
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

function buildOverviewRow(asset) {
    const rows = Array.isArray(asset.rows) ? asset.rows : []
    const participaciones = rows.reduce((total, row) => total + getSignedParticipation(row), 0)
    const invertidoBruto = rows.reduce((total, row) => total + parseEuroNumber(row.capitalInvertidoBruto || ""), 0)
    const comisiones = rows.reduce((total, row) => total + parseEuroNumber(row.comisiones || ""), 0)
    const invertidoNeto = invertidoBruto - comisiones
    const valorActual = parseEuroNumber(asset.price || "")
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
        const profitClass = row.rendimiento >= 0 ? "overviewProfitPositive" : "overviewProfitNegative"

        tr.innerHTML = `
            <td>${row.nombre}</td>
            <td>${row.tipo}</td>
            <td class="overviewNumericCell">${normalizeNumberForEdit(row.participaciones.toFixed(6))}</td>
            <td class="overviewNumericCell">${formatEuro(row.promedioCompra)}</td>
            <td class="overviewNumericCell overviewCurrentPriceCell">${formatEuro(row.valorActual)}</td>
            <td class="overviewNumericCell">${formatEuro(row.invertidoBruto)}</td>
            <td class="overviewNumericCell">${formatEuro(row.comisiones)}</td>
            <td class="overviewNumericCell">${formatEuro(row.invertidoNeto)}</td>
            <td class="overviewNumericCell">${formatEuro(row.netoActual)}</td>
            <td class="overviewNumericCell ${profitClass}">${formatEuro(row.rendimiento)}</td>
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
        const rows = fullAssets
            .filter((asset) => selectedTypes.has(asset.type))
            .map((asset) => buildOverviewRow(asset))

        renderOverviewRows(rows)
    } catch (error) {
        console.error("Error cargando vista general:", error)
    }
}

function renderAssetTablePage(asset) {
    const contentArea = document.getElementById("dynamicContent")

    if (!contentArea) {
        return
    }

    contentArea.innerHTML = `
        <section class="assetTablePage" data-asset-id="${asset.id}" data-asset-type="${asset.type}" data-asset-name="${asset.name}" data-asset-symbol="${asset.symbol}" data-asset-price="${asset.price || "0,00"}" data-asset-currency="${asset.currency || "USD"}">
            <div class="assetPageHeader">
                <div>
                    <h1 class="assetPageTitle">${asset.symbol || asset.name}</h1>
                    <div class="assetPageSubtitle">${asset.name} · ${buildAssetTypeLabel(asset.type)}</div>
                </div>
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
                            <th>Comisiones</th>
                            <th>Capital Invertido neto</th>
                        </tr>
                    </thead>
                    <tbody id="assetOperationsBody"></tbody>
                </table>
            </div>

            <div class="assetActions">
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

    if (!assetOperationsBody) {
        return
    }

    assetOperationsBody.innerHTML = ""

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")
        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true">${rowData.fechaOperacion || ""}</td>
            <td contenteditable="true">${rowData.tipoOperacion || "Compra"}</td>
            <td contenteditable="true">${rowData.participaciones || ""}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.precioParticipacion)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.capitalInvertidoBruto)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.comisiones)}</td>
            <td class="rowTotal">0,00 €</td>
        `
        assetOperationsBody.appendChild(rowElement)
    })

    updateAssetTableTotals()
}

function collectAssetRowsFromTable() {
    const rowElements = [...document.querySelectorAll("#assetOperationsBody tr")]

    return rowElements.map((rowElement) => {
        const cells = rowElement.querySelectorAll("td")

        return {
            fechaOperacion: cells[1]?.textContent.trim() || "",
            tipoOperacion: cells[2]?.textContent.trim() || "",
            participaciones: cells[3]?.textContent.trim() || "",
            precioParticipacion: cells[4]?.textContent.trim() || "",
            capitalInvertidoBruto: cells[5]?.textContent.trim() || "",
            comisiones: cells[6]?.textContent.trim() || ""
        }
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
    const cells = rowElement.querySelectorAll("td")
    const fechaOperacion = cells[1]?.textContent.trim() || ""
    const tipoOperacion = cells[2]?.textContent.trim() || ""
    const participaciones = parseFloat((cells[3]?.textContent || "0").replace(",", ".")) || 0
    const precioParticipacion = parseEuroNumber(cells[4]?.textContent || "")
    const capitalInvertidoBruto = parseEuroNumber(cells[5]?.textContent || "")
    const comisiones = parseEuroNumber(cells[6]?.textContent || "")

    return !fechaOperacion &&
        (!tipoOperacion || isPlaceholderValue(tipoOperacion, ["compra"])) &&
        participaciones === 0 &&
        precioParticipacion === 0 &&
        capitalInvertidoBruto === 0 &&
        comisiones === 0
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

    return {
        id: currentAssetId,
        name: assetPage?.dataset.assetName || document.getElementById("detName")?.textContent.trim() || "Activo",
        symbol: assetPage?.dataset.assetSymbol || document.getElementById("detSymbol")?.textContent.trim() || "ACTIVO",
        type: assetPage?.dataset.assetType || "cripto",
        price: assetPage?.dataset.assetPrice || "0,00",
        currency: assetPage?.dataset.assetCurrency || "USD",
        change: "+0,00%",
        status: "Mercado abierto",
        order: Number(document.querySelector(`.assetBtn[data-asset-id="${currentAssetId}"]`)?.dataset.assetOrder || 0),
        rows: collectAssetRowsFromTable()
    }
}

function updateAssetTableTotals() {
    const rowElements = document.querySelectorAll("#assetOperationsBody tr")

    rowElements.forEach((rowElement) => {
        const cells = rowElement.querySelectorAll("td")
        const bruto = parseEuroNumber(cells[5]?.textContent || "")
        const comisiones = parseEuroNumber(cells[6]?.textContent || "")
        const neto = bruto - comisiones

        if (cells[7]) {
            cells[7].textContent = formatEuro(neto)
        }
    })
}

function addNewAssetRow() {
    const assetOperationsBody = document.getElementById("assetOperationsBody")

    if (!assetOperationsBody) {
        return
    }

    const rowElement = document.createElement("tr")
    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true"></td>
        <td contenteditable="true">Compra</td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td class="rowTotal">0,00 €</td>
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

    if (!assetModalOverlay || !assetNameInput || !assetTypeSelect) {
        return
    }

    assetNameInput.value = ""
    assetTypeSelect.value = "cripto"
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

    if (!assetNameInput || !assetTypeSelect) {
        return
    }

    const name = assetNameInput.value.trim()
    const type = assetTypeSelect.value.trim()

    if (!name) {
        assetNameInput.focus()
        return
    }

    try {
        const response = await createAssetOnServer(name, type)
        const createdAsset = response.asset
        closeAssetModal()
        currentAssetId = createdAsset.id
        await refreshAssetsSidebar(createdAsset.id, true)
    } catch (error) {
        console.error(error)
        alert("No se pudo crear el activo.")
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

function initAssetModal(assetModalOverlay, confirmAssetModalButton, cancelAssetModalButton, assetNameInput, assetTypeSelect) {
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

    if (assetModalOverlay) {
        assetModalOverlay.addEventListener("click", (event) => {
            if (event.target === assetModalOverlay) {
                closeAssetModal()
            }
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

    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && assetModalState?.isOpen) {
            closeAssetModal()
            return
        }

        if (event.key === "Escape" && confirmModalState) {
            closeConfirmModal()
        }
    })
}

function initAssetOrderButtons(moveAssetUpButton, moveAssetDownButton) {
    if (moveAssetUpButton) {
        moveAssetUpButton.addEventListener("click", async () => {
            await handleAssetReorder("up")
        })
    }

    if (moveAssetDownButton) {
        moveAssetDownButton.addEventListener("click", async () => {
            await handleAssetReorder("down")
        })
    }
}

async function handleAssetReorder(direction) {
    if (!currentAssetId) {
        return
    }

    try {
        await reorderAssetOnServer(currentAssetId, direction)
        await refreshAssetsSidebar(currentAssetId, false)
    } catch (error) {
        console.error(error)
        alert("No se pudo reordenar el activo.")
    }
}

function handleCellBlur(event) {
    const cell = event.target

    if (cell.tagName !== "TD") {
        return
    }

    const tableBody = cell.closest('tbody')
    const columnIndex = cell.cellIndex

    if (tableBody?.id === "interesesBody" && (columnIndex === 1 || columnIndex === 2 || columnIndex === 3)) {
        const value = parseEuroNumber(cell.textContent)
        const hasText = cell.textContent.trim() !== ""

        if (hasText) {
            cell.textContent = formatEuro(value)
        }

        updateTotals()
        return
    }

    if (tableBody?.id === "dividendosBody") {
        const hasText = cell.textContent.trim() !== ""

        if (columnIndex === 3) {
            const value = parseDollarNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatDollar(value)
            }
        }

        if (columnIndex === 4 || columnIndex === 5) {
            const value = parseEuroNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatEuro(value)
            }
        }

        updateDividendosTotals()
        return
    }

    if (tableBody?.id === "assetOperationsBody") {
        const hasText = cell.textContent.trim() !== ""

        if (columnIndex === 3 || columnIndex === 4 || columnIndex === 5) {
            const value = parseEuroNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatEuro(value)
            }
        }

        updateAssetTableTotals()
    }
}

async function loadInteresesData() {
    try {
        const response = await fetch("/api/intereses")

        if (!response.ok) {
            throw new Error("No se pudo cargar /api/intereses")
        }

        return await response.json()
    } catch (error) {
        console.error("Error cargando intereses desde el backend:", error)
        return { rows: [] }
    }
}

async function renderInteresesTable() {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    const interesesData = await loadInteresesData()
    renderRowsFromData(interesesData)
}

function renderRowsFromData(interesesData) {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    interesesBody.innerHTML = ""

    const rows = Array.isArray(interesesData?.rows) ? interesesData.rows : []

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")

        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true">${rowData.fecha || ""}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.saldoPromedio)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.acumulado)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.impuestos)}</td>
            <td class="rowTotal">0,00 €</td>
        `

        interesesBody.appendChild(rowElement)
    })

    updateTotals()
}

function collectInteresesDataFromTable() {
    const rowElements = [...document.querySelectorAll("#interesesBody tr")]

    const rows = rowElements.map((rowElement) => {
        const cells = rowElement.querySelectorAll("td")

        return {
            fecha: cells[1]?.textContent.trim() || "",
            saldoPromedio: cells[2]?.textContent.trim() || "",
            acumulado: cells[3]?.textContent.trim() || "",
            impuestos: cells[4]?.textContent.trim() || ""
        }
    })

    return { rows }
}

async function saveInteresesDataToServer() {
    const data = collectInteresesDataFromTable()

    const response = await fetch("/api/intereses", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function resetInteresesDataOnServer() {
    const response = await fetch("/api/intereses/reset", {
        method: "POST"
    })

    if (!response.ok) {
        throw new Error("No se pudo restablecer intereses.json")
    }

    return await response.json()
}

function updateTotals() {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    let totalNeto = 0
    let totalImpuestos = 0

    const rowElements = interesesBody.querySelectorAll("tr")

    rowElements.forEach((rowElement) => {
        const cells = rowElement.querySelectorAll("td")
        const acumulado = parseEuroNumber(cells[3]?.textContent || "")
        const impuestos = parseEuroNumber(cells[4]?.textContent || "")
        const rowTotal = acumulado - impuestos

        if (cells[5]) {
            cells[5].textContent = formatEuro(rowTotal)
        }

        totalNeto += rowTotal
        totalImpuestos += impuestos
    })

    const totalResumen = document.getElementById("totalResumen")
    const impuestosResumen = document.getElementById("impuestosResumen")
    const topTotalInteres = document.getElementById("topTotalInteres")

    if (totalResumen) {
        totalResumen.textContent = formatEuro(totalNeto)
    }

    if (impuestosResumen) {
        impuestosResumen.textContent = formatEuro(totalImpuestos)
    }

    if (topTotalInteres) {
        topTotalInteres.textContent = formatEuro(totalNeto)
    }
}

function addNewInteresesRow() {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    const rowElement = document.createElement("tr")

    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true">nuevo-mes</td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td class="rowTotal">0,00 €</td>
    `

    interesesBody.appendChild(rowElement)
    updateTotals()
}

function exportInteresesJson() {
    const data = collectInteresesDataFromTable()
    const dataString = JSON.stringify(data, null, 2)
    const dataBlob = new Blob([dataString], { type: "application/json" })
    const dataUrl = URL.createObjectURL(dataBlob)
    const downloadLink = document.createElement("a")

    downloadLink.href = dataUrl
    downloadLink.download = "intereses.json"
    document.body.appendChild(downloadLink)
    downloadLink.click()
    document.body.removeChild(downloadLink)

    URL.revokeObjectURL(dataUrl)
}

function importInteresesJson() {
    const inputFile = document.createElement("input")
    inputFile.type = "file"
    inputFile.accept = ".json,application/json"

    inputFile.addEventListener("change", async (event) => {
        const file = event.target.files?.[0]

        if (!file) {
            return
        }

        try {
            const fileText = await file.text()
            const parsedData = JSON.parse(fileText)

            if (!parsedData || !Array.isArray(parsedData.rows)) {
                alert("El JSON no tiene el formato esperado. Debe contener { rows: [...] }")
                return
            }

            renderRowsFromData(parsedData)
            await saveInteresesDataToServer()
            alert("JSON importado y guardado en data/intereses.json")
        } catch (error) {
            console.error(error)
            alert("No se pudo importar el JSON.")
        }
    })

    inputFile.click()
}

async function loadDividendosData() {
    try {
        const response = await fetch("/api/dividendos")

        if (!response.ok) {
            throw new Error("No se pudo cargar /api/dividendos")
        }

        return await response.json()
    } catch (error) {
        console.error("Error cargando dividendos desde el backend:", error)
        return { rows: [] }
    }
}

async function renderDividendosTable() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    const dividendosData = await loadDividendosData()
    renderDividendosRowsFromData(dividendosData)
}

function renderDividendosRowsFromData(dividendosData) {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    dividendosBody.innerHTML = ""

    const rows = Array.isArray(dividendosData?.rows) ? dividendosData.rows : []

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")

        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true">${rowData.fecha || ""}</td>
            <td contenteditable="true">${rowData.instrumento || ""}</td>
            <td contenteditable="true">${rowData.acciones || ""}</td>
            <td contenteditable="true">${formatCellDollarValue(rowData.dividendoAccion)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.impuestos)}</td>
            <td contenteditable="true" class="rowTotal">${formatCellEuroValue(rowData.total)}</td>
        `

        dividendosBody.appendChild(rowElement)
    })

    updateDividendosTotals()
}

function collectDividendosDataFromTable() {
    const rowElements = [...document.querySelectorAll("#dividendosBody tr")]

    const rows = rowElements.map((rowElement) => {
        const cells = rowElement.querySelectorAll("td")

        return {
            fecha: cells[1]?.textContent.trim() || "",
            instrumento: cells[2]?.textContent.trim() || "",
            acciones: cells[3]?.textContent.trim() || "",
            dividendoAccion: cells[4]?.textContent.trim() || "",
            impuestos: cells[5]?.textContent.trim() || "",
            total: cells[6]?.textContent.trim() || ""
        }
    })

    return { rows }
}

async function saveDividendosDataToServer() {
    const data = collectDividendosDataFromTable()

    const response = await fetch("/api/dividendos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function resetDividendosDataOnServer() {
    const response = await fetch("/api/dividendos/reset", {
        method: "POST"
    })

    if (!response.ok) {
        throw new Error("No se pudo restablecer dividendos.json")
    }

    return await response.json()
}

function updateDividendosTotals() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    let totalNeto = 0
    let totalImpuestos = 0

    const rowElements = dividendosBody.querySelectorAll("tr")

    rowElements.forEach((rowElement) => {
        const cells = rowElement.querySelectorAll("td")
        const impuestos = parseEuroNumber(cells[5]?.textContent || "")
        const rowTotal = parseEuroNumber(cells[6]?.textContent || "")

        totalNeto += rowTotal
        totalImpuestos += impuestos
    })

    const totalResumen = document.getElementById("totalDividendosResumen")
    const impuestosResumen = document.getElementById("impuestosDividendosResumen")
    const topTotalDividendos = document.getElementById("topTotalDividendos")

    if (totalResumen) {
        totalResumen.textContent = formatEuro(totalNeto)
    }

    if (impuestosResumen) {
        impuestosResumen.textContent = formatEuro(totalImpuestos)
    }

    if (topTotalDividendos) {
        topTotalDividendos.textContent = formatEuro(totalNeto)
    }
}

function addNewDividendosRow() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    const rowElement = document.createElement("tr")

    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true">nueva-fecha</td>
        <td contenteditable="true">instrumento</td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true" class="rowTotal"></td>
    `

    dividendosBody.appendChild(rowElement)
    updateDividendosTotals()
}

function exportDividendosJson() {
    const data = collectDividendosDataFromTable()
    const dataString = JSON.stringify(data, null, 2)
    const dataBlob = new Blob([dataString], { type: "application/json" })
    const dataUrl = URL.createObjectURL(dataBlob)
    const downloadLink = document.createElement("a")

    downloadLink.href = dataUrl
    downloadLink.download = "dividendos.json"
    document.body.appendChild(downloadLink)
    downloadLink.click()
    document.body.removeChild(downloadLink)

    URL.revokeObjectURL(dataUrl)
}

function scheduleDividendosAutosave() {
    clearTimeout(dividendosAutosaveTimeout)

    dividendosAutosaveTimeout = setTimeout(async () => {
        try {
            await saveDividendosDataToServer()
        } catch (error) {
            console.error("Error en autoguardado de dividendos:", error)
        }
    }, 500)
}

function importDividendosJson() {
    const inputFile = document.createElement("input")
    inputFile.type = "file"
    inputFile.accept = ".json,application/json"

    inputFile.addEventListener("change", async (event) => {
        const file = event.target.files?.[0]

        if (!file) {
            return
        }

        try {
            const fileText = await file.text()
            const parsedData = JSON.parse(fileText)

            if (!parsedData || !Array.isArray(parsedData.rows)) {
                alert("El JSON no tiene el formato esperado. Debe contener { rows: [...] }")
                return
            }

            renderDividendosRowsFromData(parsedData)
            await saveDividendosDataToServer()
            alert("JSON importado y guardado en data/dividendos.json")
        } catch (error) {
            console.error(error)
            alert("No se pudo importar el JSON.")
        }
    })

    inputFile.click()
}

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
    const resetDividendosButton = document.getElementById("resetDividendosBtn")
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

    if (resetDividendosButton) {
        resetDividendosButton.addEventListener("click", async () => {
            const confirmReset = confirm("Esto restablecerá los datos de dividendos del archivo del proyecto. ¿Seguro que quieres continuar?")

            if (!confirmReset) {
                return
            }

            await resetDividendosDataOnServer()
            await renderDividendosTable()
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
            const text = String(cell.textContent || "")
            cell.textContent = text.replace(/[€$]/g, "").trim()
        })
        return
    }

    if (!isDividendosPerShareCell(cell)) {
        if (isDividendosActionsCell(cell) || isDividendosEuroCell(cell)) {
            queueMicrotask(() => {
                const text = String(cell.textContent || "")
                cell.textContent = text.replace(/[€$]/g, "").trim()
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
            const text = String(cell.textContent || "")
            cell.textContent = text.replace(/[€$]/g, "").trim()
        })
        return
    }

    if (isAssetCommissionsCell(cell)) {
        queueMicrotask(() => {
            const text = String(cell.textContent || "").trim()
            cell.textContent = formatEuroSafe(text)
        })
        return
    }

    if (!isDividendosPerShareCell(cell)) {
        if (isDividendosActionsCell(cell)) {
            queueMicrotask(() => {
                const text = String(cell.textContent || "")
                cell.textContent = text.replace(/[€$]/g, "").trim()
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
