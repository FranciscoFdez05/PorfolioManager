let currentTransaccionesData = { rows: [] }
let transaccionesAutosaveTimeout = null
let transaccionesPersistenceBound = false
let transaccionesCryptoAssets = []
let currentTransaccionAssetId = null

async function loadTransaccionesData() {
    const response = await fetch("/api/transacciones")

    if (!response.ok) {
        throw new Error("No se pudieron cargar las transacciones")
    }

    return await response.json()
}

async function saveTransaccionesData(payload, options = {}) {
    const response = await fetch("/api/transacciones", {
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

async function initTransaccionesLogic() {
    currentTransaccionesData = await loadTransaccionesData()
    await loadTransaccionesCryptoAssets()
    bindTransaccionesPersistenceGuards()
    window.flushPendingPageChanges = flushTransaccionesPendingChanges
    renderTransaccionesAssetMenu()
    renderTransaccionesTable()
    bindTransaccionesEvents()
}

async function loadTransaccionesCryptoAssets() {
    const assets = await loadAssetsList()
    transaccionesCryptoAssets = assets
        .filter((asset) => String(asset?.type || "").trim().toLowerCase() === "cripto")
        .sort((firstAsset, secondAsset) => {
            const firstOrder = Number.isFinite(Number(firstAsset?.order)) ? Number(firstAsset.order) : Number.MAX_SAFE_INTEGER
            const secondOrder = Number.isFinite(Number(secondAsset?.order)) ? Number(secondAsset.order) : Number.MAX_SAFE_INTEGER

            if (firstOrder !== secondOrder) {
                return firstOrder - secondOrder
            }

            return String(firstAsset?.name || "").localeCompare(String(secondAsset?.name || ""), "es")
        })

    const assetIds = new Set(transaccionesCryptoAssets.map((asset) => asset.id))

    if (currentTransaccionAssetId && assetIds.has(currentTransaccionAssetId)) {
        return
    }

    currentTransaccionAssetId = transaccionesCryptoAssets[0]?.id || null
}

function bindTransaccionesEvents() {
    const body = document.getElementById("transaccionesBody")
    const addButton = document.getElementById("addTransaccionRowBtn")
    const saveButton = document.getElementById("saveTransaccionesBtn")
    const exportButton = document.getElementById("exportTransaccionesBtn")
    const importButton = document.getElementById("importTransaccionesBtn")

    if (body && !body.dataset.bound) {
        body.dataset.bound = "true"
        body.addEventListener("click", handleTransaccionesDeleteClick)
        body.addEventListener("input", handleTransaccionesInput)
        body.addEventListener("blur", handleTransaccionesBlur, true)
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            if (!currentTransaccionAssetId) {
                return
            }

            syncTransaccionesDataFromTable()
            currentTransaccionesData.rows.push(createEmptyTransaccionRow())
            renderTransaccionesTable()
            scheduleTransaccionesAutosave()
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistTransaccionesData()
                alert("Datos guardados en data/transacciones.json")
            } catch (error) {
                console.error(error)
                alert("No se pudieron guardar las transacciones.")
            }
        })
    }

    if (exportButton && !exportButton.dataset.bound) {
        exportButton.dataset.bound = "true"
        exportButton.addEventListener("click", exportTransaccionesJson)
    }

    if (importButton && !importButton.dataset.bound) {
        importButton.dataset.bound = "true"
        importButton.addEventListener("click", importTransaccionesJson)
    }
}

function createEmptyTransaccionRow() {
    const selectedAsset = getCurrentTransaccionesAsset()

    return {
        id: `transaccion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        assetId: currentTransaccionAssetId || "",
        assetName: selectedAsset?.name || "",
        fechaOperacion: "",
        walletOrigen: "",
        total: "0,00000000",
        comisionRed: "0,00000000",
        walletDestino: ""
    }
}

function renderTransaccionesAssetMenu() {
    const menu = document.getElementById("transaccionesAssetMenu")
    const hint = document.getElementById("transaccionesAssetHint")
    const addButton = document.getElementById("addTransaccionRowBtn")

    if (!menu || !hint || !addButton) {
        return
    }

    menu.innerHTML = ""

    if (!transaccionesCryptoAssets.length) {
        hint.textContent = "No hay criptos creadas en el menú de activos."
        addButton.disabled = true
        return
    }

    addButton.disabled = false

    transaccionesCryptoAssets.forEach((asset) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `transaccionesAssetBtn${asset.id === currentTransaccionAssetId ? " active" : ""}`
        button.dataset.assetId = asset.id
        button.textContent = asset.name || asset.symbol || asset.id
        button.addEventListener("click", () => {
            if (asset.id === currentTransaccionAssetId) {
                return
            }

            syncTransaccionesDataFromTable()
            currentTransaccionAssetId = asset.id
            renderTransaccionesAssetMenu()
            renderTransaccionesTable()
        })
        menu.appendChild(button)
    })

    const selectedAsset = getCurrentTransaccionesAsset()
    const selectedRowsCount = getCurrentAssetRows().length
    hint.textContent = selectedAsset
        ? `Viendo ${selectedRowsCount} transacción${selectedRowsCount === 1 ? "" : "es"} entre wallets para ${selectedAsset.name}.`
        : "Selecciona una cripto para registrar sus movimientos entre wallets."
}

function renderTransaccionesTable() {
    const body = document.getElementById("transaccionesBody")

    if (!body) {
        return
    }

    body.innerHTML = ""

    if (!currentTransaccionAssetId) {
        const emptyRow = document.createElement("tr")
        emptyRow.innerHTML = `
            <td class="rowDeleteCell"></td>
            <td colspan="5" class="operationsEmptyCell">Crea o selecciona una cripto para registrar transacciones.</td>
        `
        body.appendChild(emptyRow)
        renderTransaccionesAssetMenu()
        return
    }

    const rows = getCurrentAssetRows()

    if (!rows.length) {
        const emptyRow = document.createElement("tr")
        emptyRow.innerHTML = `
            <td class="rowDeleteCell"></td>
            <td colspan="5" class="operationsEmptyCell">Todavía no hay transacciones registradas.</td>
        `
        body.appendChild(emptyRow)
        return
    }

    rows.forEach((row) => {
        body.appendChild(buildTransaccionRow(row))
    })

    renderTransaccionesAssetMenu()
}

function buildTransaccionRow(row) {
    const tr = document.createElement("tr")
    tr.dataset.transaccionId = row.id
    tr.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true" data-field="fechaOperacion">${row.fechaOperacion || ""}</td>
        <td contenteditable="true" data-field="walletOrigen">${row.walletOrigen || ""}</td>
        <td contenteditable="true" data-field="total">${formatTransaccionesNumber(row.total)}</td>
        <td contenteditable="true" data-field="comisionRed">${formatTransaccionesNumber(row.comisionRed)}</td>
        <td contenteditable="true" data-field="walletDestino">${row.walletDestino || ""}</td>
    `
    return tr
}

function formatTransaccionesNumber(value) {
    const parsedValue = parseLooseNumber(value)

    if (parsedValue === null || String(value || "").trim() === "") {
        return ""
    }

    return parsedValue.toLocaleString("es-ES", {
        minimumFractionDigits: 8,
        maximumFractionDigits: 8
    })
}

function handleTransaccionesInput(event) {
    if (!event.target.closest("tr[data-transaccion-id]")) {
        return
    }

    scheduleTransaccionesAutosave()
}

function handleTransaccionesBlur(event) {
    const cell = event.target.closest('[contenteditable="true"]')

    if (!cell) {
        return
    }

    const field = cell.dataset.field

    if (field === "total" || field === "comisionRed") {
        cell.textContent = formatTransaccionesNumber(cell.textContent)
    }

    scheduleTransaccionesAutosave()
}

function handleTransaccionesDeleteClick(event) {
    const deleteButton = event.target.closest(".rowDeleteBtn")

    if (!deleteButton) {
        return
    }

    const row = deleteButton.closest("tr[data-transaccion-id]")
    const rowId = row?.dataset.transaccionId

    if (!rowId) {
        return
    }

    currentTransaccionesData.rows = (currentTransaccionesData.rows || []).filter((item) => item.id !== rowId)
    renderTransaccionesTable()
    scheduleTransaccionesAutosave()
}

function syncTransaccionesDataFromTable() {
    const bodyRows = [...document.querySelectorAll("#transaccionesBody tr[data-transaccion-id]")]
    const selectedAsset = getCurrentTransaccionesAsset()
    const hiddenRows = (currentTransaccionesData.rows || []).filter((row) => row.assetId !== currentTransaccionAssetId)
    const visibleRows = bodyRows.map((rowElement) => ({
        id: rowElement.dataset.transaccionId || `transaccion-${Date.now()}`,
        assetId: currentTransaccionAssetId || "",
        assetName: selectedAsset?.name || "",
        fechaOperacion: rowElement.querySelector('[data-field="fechaOperacion"]')?.textContent.trim() || "",
        walletOrigen: rowElement.querySelector('[data-field="walletOrigen"]')?.textContent.trim() || "",
        total: rowElement.querySelector('[data-field="total"]')?.textContent.trim() || "",
        comisionRed: rowElement.querySelector('[data-field="comisionRed"]')?.textContent.trim() || "",
        walletDestino: rowElement.querySelector('[data-field="walletDestino"]')?.textContent.trim() || ""
    }))

    currentTransaccionesData.rows = [...hiddenRows, ...visibleRows]
}

function scheduleTransaccionesAutosave(delay = 500) {
    window.clearTimeout(transaccionesAutosaveTimeout)
    transaccionesAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistTransaccionesData()
        } catch (error) {
            console.error("Error en autoguardado de transacciones:", error)
        }
    }, delay)
}

async function persistTransaccionesData(options = {}) {
    syncTransaccionesDataFromTable()
    window.clearTimeout(transaccionesAutosaveTimeout)
    await saveTransaccionesData(currentTransaccionesData, options)

    if (!options.keepalive) {
        await refreshAssetsSidebar(currentAssetId, false)
    }
}

async function flushTransaccionesPendingChanges() {
    if (!document.getElementById("transaccionesBody")) {
        return
    }

    await persistTransaccionesData({ keepalive: true })
}

function bindTransaccionesPersistenceGuards() {
    if (transaccionesPersistenceBound) {
        return
    }

    transaccionesPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!document.getElementById("transaccionesBody")) {
            return
        }

        persistTransaccionesData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar transacciones al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || !document.getElementById("transaccionesBody")) {
            return
        }

        persistTransaccionesData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar transacciones al cambiar de ventana:", error)
        })
    })
}

function exportTransaccionesJson() {
    syncTransaccionesDataFromTable()
    downloadJsonFile("transacciones.json", currentTransaccionesData)
}

function importTransaccionesJson() {
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
        currentTransaccionesData.rows = rows.map((row, index) => ({
            id: String(row.id || `transaccion-importada-${index + 1}`),
            assetId: String(row.assetId || ""),
            assetName: String(row.assetName || ""),
            fechaOperacion: String(row.fechaOperacion || ""),
            walletOrigen: String(row.walletOrigen || ""),
            total: String(row.total || ""),
            comisionRed: String(row.comisionRed || ""),
            walletDestino: String(row.walletDestino || "")
        }))

        const importedAssetIds = new Set(currentTransaccionesData.rows.map((row) => row.assetId).filter(Boolean))

        if (!currentTransaccionAssetId || !importedAssetIds.has(currentTransaccionAssetId)) {
            currentTransaccionAssetId = transaccionesCryptoAssets.find((asset) => importedAssetIds.has(asset.id))?.id || transaccionesCryptoAssets[0]?.id || null
        }

        renderTransaccionesAssetMenu()
        renderTransaccionesTable()
        scheduleTransaccionesAutosave()
    })

    input.click()
}

function getCurrentTransaccionesAsset() {
    return transaccionesCryptoAssets.find((asset) => asset.id === currentTransaccionAssetId) || null
}

function getCurrentAssetRows() {
    return (currentTransaccionesData.rows || []).filter((row) => row.assetId === currentTransaccionAssetId)
}
