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
    const cryptoAssets = assets
        .filter((asset) => String(asset?.type || "").trim().toLowerCase() === "cripto")
        .sort((firstAsset, secondAsset) => {
            const firstOrder = Number.isFinite(Number(firstAsset?.order)) ? Number(firstAsset.order) : Number.MAX_SAFE_INTEGER
            const secondOrder = Number.isFinite(Number(secondAsset?.order)) ? Number(secondAsset.order) : Number.MAX_SAFE_INTEGER

            if (firstOrder !== secondOrder) {
                return firstOrder - secondOrder
            }

            return String(firstAsset?.name || "").localeCompare(String(secondAsset?.name || ""), "es")
        })

    const stablecoinAssets = []

    if (typeof loadStablecoinsData === "function") {
        try {
            const stablecoinsPayload = await loadStablecoinsData()
            const enabledSymbols = Array.isArray(stablecoinsPayload?.enabledSymbols) ? stablecoinsPayload.enabledSymbols : []

            enabledSymbols
                .map((symbol) => String(symbol || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""))
                .filter(Boolean)
                .forEach((symbol) => {
                    stablecoinAssets.push({
                        id: `stablecoin-${symbol}`,
                        name: symbol,
                        symbol,
                        type: "stablecoin"
                    })
                })
        } catch (error) {
            console.warn("No se pudieron cargar las stablecoins para transacciones.", error)
        }
    }

    transaccionesCryptoAssets = [...cryptoAssets, ...stablecoinAssets]

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
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            if (!currentTransaccionAssetId) return
            openTransaccionRowModal("")
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
    bindTableSort(body.closest("table"))
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
    const walletLabel = TRANSACCION_WALLET_OPTIONS.find((o) => o.value === normalizeTransaccionWalletTipo(row.walletTipo))?.label || row.walletTipo || ""
    tr.dataset.transaccionId = row.id
    tr.innerHTML = `
        <td>${row.fechaOperacion || ""}</td>
        <td>${formatTransaccionesNumber(row.total)}</td>
        <td>${formatTransaccionesNumber(row.comisionRed)}</td>
        <td>${walletLabel}</td>
        <td>${escapeHtml(row.walletDestino || "")}</td>
        <td class="transaccionHashCell" data-full-value="${escapeHtml(hashTransaccion)}" title="Haz clic para copiar el hash completo">${formatHashTransaccionDisplay(hashTransaccion)}</td>
        <td>${escapeHtml(row.nota || "")}</td>
        <td class="rowActionsCell">
            <div class="rowActionsBtns">
                <button type="button" class="assetRowEditBtn transaccionRowEditBtn avActionBtn avEditBtn" data-row-id="${row.id}" title="Editar fila">✎</button>
                <button type="button" class="assetRowDeleteBtn transaccionRowDeleteBtn avActionBtn avDeleteBtn" data-row-id="${row.id}" title="Eliminar fila">🗑️</button>
            </div>
        </td>
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
    const editButton = event.target.closest(".transaccionRowEditBtn")
    if (editButton) {
        openTransaccionRowModal(editButton.dataset.rowId)
        return
    }

    const deleteButton = event.target.closest(".transaccionRowDeleteBtn")
    if (!deleteButton) return

    const rowId = deleteButton.dataset.rowId
    if (!rowId) return

    openConfirmModal({
        title: "Eliminar fila",
        message: "¿Quieres eliminar esta transacción?",
        confirmLabel: "Eliminar",
        onConfirm: () => {
            currentTransaccionesData.rows = (currentTransaccionesData.rows || []).filter((item) => item.id !== rowId)
            renderTransaccionesTable()
            scheduleTransaccionesAutosave()
        }
    })
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
    // Table is display-only; data is managed directly in currentTransaccionesData.rows via the modal
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

function getCurrentTransaccionesAsset() {
    return transaccionesCryptoAssets.find((asset) => asset.id === currentTransaccionAssetId) || null
}

function getCurrentAssetRows() {
    return (currentTransaccionesData.rows || []).filter((row) => row.assetId === currentTransaccionAssetId)
}

function openTransaccionRowModal(rowId) {
    document.getElementById("transaccionRowModalOverlay")?.remove()

    const rowIndex = (currentTransaccionesData.rows || []).findIndex((r) => r.id === rowId)
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...currentTransaccionesData.rows[rowIndex] } : createEmptyTransaccionRow()

    const walletOptions = TRANSACCION_WALLET_OPTIONS.map((opt) =>
        `<option value="${opt.value}"${rowData.walletTipo === opt.value ? " selected" : ""}>${opt.label}</option>`
    ).join("")

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha operación</label>
            <input id="txModalFecha" class="assetRowModalInput" type="text" value="${rowData.fechaOperacion || ""}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Total cripto</label>
            <input id="txModalTotal" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.total || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisión red</label>
            <input id="txModalComision" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.comisionRed || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet</label>
            <select id="txModalWalletTipo" class="assetRowModalSelect">
                ${walletOptions}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet destino</label>
            <input id="txModalWalletDestino" class="assetRowModalInput" type="text" value="${rowData.walletDestino || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Hash transacción</label>
            <input id="txModalHash" class="assetRowModalInput" type="text" value="${rowData.hashTransaccion || ""}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Nota</label>
            <input id="txModalNota" class="assetRowModalInput" type="text" value="${rowData.nota || ""}">
        </div>
    `

    const overlay = document.createElement("div")
    overlay.id = "transaccionRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowId = rowId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const titleEl = document.createElement("h3")
    titleEl.className = "assetModalTitle assetRowModalTitle"
    titleEl.textContent = isEdit ? "Editar transacción" : "Añadir transacción"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = fieldsHtml

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        ${isEdit ? `<button type="button" id="txRowModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
        <button type="button" id="txRowModalCancelBtn" class="cancelButton">Cancelar</button>
        <button type="button" id="txRowModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
    `

    footer.querySelector("#txRowModalSaveBtn").addEventListener("click", saveTransaccionRowFromModal)
    footer.querySelector("#txRowModalCancelBtn").addEventListener("click", closeTransaccionRowModal)

    if (isEdit) {
        footer.querySelector("#txRowModalDeleteBtn").addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar fila",
                message: "¿Quieres eliminar esta transacción?",
                confirmLabel: "Eliminar",
                onConfirm: () => {
                    currentTransaccionesData.rows = (currentTransaccionesData.rows || []).filter((r) => r.id !== rowId)
                    renderTransaccionesTable()
                    scheduleTransaccionesAutosave()
                }
            })
            closeTransaccionRowModal()
        })
    }

    modal.appendChild(titleEl)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

function closeTransaccionRowModal() {
    document.getElementById("transaccionRowModalOverlay")?.remove()
}

function saveTransaccionRowFromModal() {
    const overlay = document.getElementById("transaccionRowModalOverlay")
    const rowId = overlay?.dataset.rowId || ""
    const g = (id) => document.getElementById(id)?.value ?? ""
    const selectedAsset = getCurrentTransaccionesAsset()

    const rowData = {
        id: rowId || `transaccion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        assetId: currentTransaccionAssetId || "",
        assetName: selectedAsset?.name || "",
        fechaOperacion: g("txModalFecha"),
        total: g("txModalTotal"),
        comisionRed: g("txModalComision"),
        walletTipo: normalizeTransaccionWalletTipo(g("txModalWalletTipo")),
        walletDestino: g("txModalWalletDestino"),
        hashTransaccion: normalizeHashTransaccionValue(g("txModalHash")),
        nota: g("txModalNota")
    }

    const rowIndex = (currentTransaccionesData.rows || []).findIndex((r) => r.id === rowId)
    if (rowIndex >= 0) {
        currentTransaccionesData.rows[rowIndex] = rowData
    } else {
        currentTransaccionesData.rows.push(rowData)
    }

    renderTransaccionesTable()
    scheduleTransaccionesAutosave()
    closeTransaccionRowModal()
}
