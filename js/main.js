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

    initSidePanel(toggleButton, sideWrapper)
    initNavigation(navButtons, contentArea)
    initAddAssetButton(addAssetButton, assetModalOverlay, assetNameInput, assetTypeSelect)
    initAssetOrderButtons(moveAssetUpButton, moveAssetDownButton)
    initAssetModal(assetModalOverlay, confirmAssetModalButton, cancelAssetModalButton, assetNameInput, assetTypeSelect)
    await refreshAssetsSidebar()

    loadPage("intereses")
})

let dividendosAutosaveTimeout = null
let assetAutosaveTimeout = null
let currentAssetId = null
let assetModalState = null

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

        if (page === "intereses") {
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
        button.innerHTML = `
            <span>${asset.symbol || asset.name}</span>
            <span>${asset.price || "0,00"}</span>
        `
        assetsList.appendChild(button)
    })

    initAssetSelector([...assetsList.querySelectorAll(".assetBtn")])
}

async function refreshAssetsSidebar(selectedAssetId = currentAssetId, renderTable = false) {
    try {
        const assets = await loadAssetsList()
        renderAssetsList(assets)

        if (!assets.length) {
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

function buildAssetTypeLabel(assetType) {
    const labels = {
        cripto: "Cripto",
        acciones: "Acciones",
        etfs: "ETFs",
        comoditis: "Comoditis"
    }

    return labels[assetType] || assetType
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
            fechaOperacion: cells[0]?.textContent.trim() || "",
            tipoOperacion: cells[1]?.textContent.trim() || "",
            participaciones: cells[2]?.textContent.trim() || "",
            precioParticipacion: cells[3]?.textContent.trim() || "",
            capitalInvertidoBruto: cells[4]?.textContent.trim() || "",
            comisiones: cells[5]?.textContent.trim() || ""
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
        const bruto = parseEuroNumber(cells[4]?.textContent || "")
        const comisiones = parseEuroNumber(cells[5]?.textContent || "")
        const neto = bruto - comisiones

        if (cells[6]) {
            cells[6].textContent = formatEuro(neto)
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

    if (assetOperationsBody) {
        assetOperationsBody.addEventListener("input", () => {
            updateAssetTableTotals()
            scheduleAssetAutosave()
        })

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
            fecha: cells[0]?.textContent.trim() || "",
            saldoPromedio: cells[1]?.textContent.trim() || "",
            acumulado: cells[2]?.textContent.trim() || "",
            impuestos: cells[3]?.textContent.trim() || ""
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
        const acumulado = parseEuroNumber(cells[2]?.textContent || "")
        const impuestos = parseEuroNumber(cells[3]?.textContent || "")
        const rowTotal = acumulado - impuestos

        if (cells[4]) {
            cells[4].textContent = formatEuro(rowTotal)
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
            fecha: cells[0]?.textContent.trim() || "",
            instrumento: cells[1]?.textContent.trim() || "",
            acciones: cells[2]?.textContent.trim() || "",
            dividendoAccion: cells[3]?.textContent.trim() || "",
            impuestos: cells[4]?.textContent.trim() || "",
            total: cells[5]?.textContent.trim() || ""
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
        const impuestos = parseEuroNumber(cells[4]?.textContent || "")
        const rowTotal = parseEuroNumber(cells[5]?.textContent || "")

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
