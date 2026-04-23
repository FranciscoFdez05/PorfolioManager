let currentTransaccionesData = { rows: [] }
let transaccionesAutosaveTimeout = null
let transaccionesPersistenceBound = false
let transaccionesCryptoAssets = []
let currentTransaccionAssetId = null
let transaccionesPersistChain = Promise.resolve()
const TRANSACCION_WALLET_OPTIONS = [
    { value: "entre_wallet", label: "Entre wallet" },
    { value: "recibida", label: "Recibida" },
    { value: "enviada", label: "Enviada" }
]

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
    if (body && !body.dataset.bound) {
        body.dataset.bound = "true"
        body.addEventListener("click", handleTransaccionesClick)
        body.addEventListener("click", handleTransaccionesDeleteClick)
        body.addEventListener("change", handleTransaccionesChange)
        body.addEventListener("input", handleTransaccionesInput)
        body.addEventListener("focus", handleTransaccionesFocus, true)
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

}

function createEmptyTransaccionRow() {
    const selectedAsset = getCurrentTransaccionesAsset()

    return {
        id: `transaccion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        assetId: currentTransaccionAssetId || "",
        assetName: selectedAsset?.name || "",
        fechaOperacion: "",
        total: "0,00000000",
        comisionRed: "0,00000000",
        walletTipo: "entre_wallet",
        walletDestino: "",
        hashTransaccion: "",
        nota: ""
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
            <td colspan="7" class="operationsEmptyCell">Crea o selecciona una cripto para registrar transacciones.</td>
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
            <td colspan="7" class="operationsEmptyCell">Todavía no hay transacciones registradas.</td>
        `
        body.appendChild(emptyRow)
        return
    }

    rows.forEach((row) => {
        body.appendChild(buildTransaccionRow(row))
    })

    renderTransaccionesAssetMenu()
}

function normalizeHashTransaccionValue(value) {
    return String(value || "").trim()
}

function formatHashTransaccionDisplay(value) {
    const normalizedValue = normalizeHashTransaccionValue(value)

    if (!normalizedValue) {
        return ""
    }

    if (normalizedValue.length <= 14) {
        return normalizedValue
    }

    return `${normalizedValue.slice(0, 6)}...${normalizedValue.slice(-6)}`
}

function normalizeTransaccionWalletTipo(value) {
    const normalizedValue = String(value || "").trim().toLowerCase()

    if (normalizedValue === "recibida") {
        return "recibida"
    }

    if (normalizedValue === "enviada" || normalizedValue === "no_mia") {
        return "enviada"
    }

    return "entre_wallet"
}

function buildTransaccionWalletSelect(value) {
    const normalizedValue = normalizeTransaccionWalletTipo(value)

    return `
        <select class="operationsSelect transaccionWalletSelect" data-field="walletTipo">
            ${TRANSACCION_WALLET_OPTIONS.map((option) => `<option value="${option.value}"${option.value === normalizedValue ? " selected" : ""}>${option.label}</option>`).join("")}
        </select>
    `
}

function buildTransaccionRow(row) {
    const tr = document.createElement("tr")
    const hashTransaccion = normalizeHashTransaccionValue(row.hashTransaccion || row.walletOrigen || "")
    tr.dataset.transaccionId = row.id
    tr.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true" data-field="fechaOperacion">${row.fechaOperacion || ""}</td>
        <td contenteditable="true" data-field="total">${formatTransaccionesNumber(row.total)}</td>
        <td contenteditable="true" data-field="comisionRed">${formatTransaccionesNumber(row.comisionRed)}</td>
        <td>${buildTransaccionWalletSelect(row.walletTipo)}</td>
        <td contenteditable="true" data-field="walletDestino">${row.walletDestino || ""}</td>
        <td contenteditable="true" class="transaccionHashCell" data-field="hashTransaccion" data-full-value="${hashTransaccion}" title="Haz clic para copiar el hash completo">${formatHashTransaccionDisplay(hashTransaccion)}</td>
        <td contenteditable="true" data-field="nota">${row.nota || ""}</td>
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
    const row = event.target.closest("tr[data-transaccion-id]")

    if (!row) {
        return
    }

    const hashCell = event.target.closest('.transaccionHashCell[data-field="hashTransaccion"]')

    if (hashCell) {
        hashCell.dataset.fullValue = normalizeHashTransaccionValue(hashCell.textContent)
    }

    scheduleTransaccionesAutosave()
}

function handleTransaccionesChange(event) {
    if (!event.target.closest("tr[data-transaccion-id]")) {
        return
    }

    if (event.target.matches('select[data-field="walletTipo"]')) {
        scheduleTransaccionesAutosave()
    }
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

    if (field === "hashTransaccion") {
        const normalizedHash = normalizeHashTransaccionValue(cell.textContent)
        cell.dataset.fullValue = normalizedHash
        cell.textContent = formatHashTransaccionDisplay(normalizedHash)
    }

    scheduleTransaccionesAutosave()
}

async function copyHashTransaccionToClipboard(cell) {
    const fullHash = normalizeHashTransaccionValue(cell?.dataset?.fullValue || cell?.textContent || "")

    if (!fullHash) {
        return
    }

    try {
        await navigator.clipboard.writeText(fullHash)
        cell.classList.add("copied")
        cell.title = "Hash copiado"
        window.clearTimeout(Number(cell.dataset.copyTimeoutId || 0))
        cell.dataset.copyTimeoutId = String(window.setTimeout(() => {
            cell.classList.remove("copied")
            cell.title = "Haz clic para copiar el hash completo"
        }, 1200))
    } catch (error) {
        console.error("No se pudo copiar el hash:", error)
    }
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

function handleTransaccionesClick(event) {
    const hashCell = event.target.closest('.transaccionHashCell[data-field="hashTransaccion"]')

    if (!hashCell) {
        return
    }

    copyHashTransaccionToClipboard(hashCell)
}

function handleTransaccionesFocus(event) {
    const hashCell = event.target.closest('.transaccionHashCell[data-field="hashTransaccion"]')

    if (!hashCell) {
        return
    }

    hashCell.textContent = normalizeHashTransaccionValue(hashCell.dataset.fullValue || hashCell.textContent || "")
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
        total: rowElement.querySelector('[data-field="total"]')?.textContent.trim() || "",
        comisionRed: rowElement.querySelector('[data-field="comisionRed"]')?.textContent.trim() || "",
        walletTipo: normalizeTransaccionWalletTipo(rowElement.querySelector('select[data-field="walletTipo"]')?.value || "entre_wallet"),
        walletDestino: rowElement.querySelector('[data-field="walletDestino"]')?.textContent.trim() || "",
        hashTransaccion: normalizeHashTransaccionValue(rowElement.querySelector('[data-field="hashTransaccion"]')?.dataset.fullValue || rowElement.querySelector('[data-field="hashTransaccion"]')?.textContent || ""),
        nota: rowElement.querySelector('[data-field="nota"]')?.textContent.trim() || ""
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
    const snapshot = {
        rows: (currentTransaccionesData.rows || []).map((row) => ({ ...row }))
    }

    transaccionesPersistChain = transaccionesPersistChain
        .catch(() => {})
        .then(() => saveTransaccionesData(snapshot, options))

    await transaccionesPersistChain

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
            total: String(row.total || ""),
            comisionRed: String(row.comisionRed || ""),
            walletTipo: normalizeTransaccionWalletTipo(row.walletTipo || "entre_wallet"),
            walletDestino: String(row.walletDestino || ""),
            hashTransaccion: String(row.hashTransaccion || row.walletOrigen || ""),
            nota: String(row.nota || "")
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
