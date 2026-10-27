let currentTransaccionesData = { rows: [] }
let transaccionesAutosaveTimeout = null
let transaccionesPersistenceBound = false
// Solo se guarda al ocultar o cerrar la pestaña si hubo cambios locales: sin
// esta marca, una pestaña con la lista vieja pisaba lo guardado desde otro sitio.
let transaccionesHasPendingChanges = false
// Revisión que el servidor tenía al cargar o guardar por última vez, y copia de
// las filas de entonces: la base de la fusión si otro sitio guarda antes.
let transaccionesRevision = null
let transaccionesBaseRows = []
let transaccionesCryptoAssets = []
// Criptos visibles en la tabla; null es «Todos».
let transaccionesFilter = null
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
        const error = new Error(`HTTP ${response.status}: ${errorText}`)
        error.status = response.status
        throw error
    }
    return await response.json().catch(() => null)
}

async function initTransaccionesLogic() {
    currentTransaccionesData = await loadTransaccionesData()
    transaccionesRevision = Number.isInteger(currentTransaccionesData?.revision) ? currentTransaccionesData.revision : null
    transaccionesBaseRows = JSON.parse(JSON.stringify(currentTransaccionesData?.rows || []))
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
        .filter(
            (asset) =>
                String(asset?.type || "")
                    .trim()
                    .toLowerCase() === "cripto"
        )
        .sort((firstAsset, secondAsset) => {
            const firstOrder = Number.isFinite(Number(firstAsset?.order))
                ? Number(firstAsset.order)
                : Number.MAX_SAFE_INTEGER
            const secondOrder = Number.isFinite(Number(secondAsset?.order))
                ? Number(secondAsset.order)
                : Number.MAX_SAFE_INTEGER

            if (firstOrder !== secondOrder) {
                return firstOrder - secondOrder
            }

            return String(firstAsset?.name || "").localeCompare(String(secondAsset?.name || ""), "es")
        })

    const stablecoinAssets = []

    if (typeof loadStablecoinsData === "function") {
        try {
            const stablecoinsPayload = await loadStablecoinsData()
            const enabledSymbols = Array.isArray(stablecoinsPayload?.enabledSymbols)
                ? stablecoinsPayload.enabledSymbols
                : []

            enabledSymbols
                .map((symbol) =>
                    String(symbol || "")
                        .trim()
                        .toUpperCase()
                        .replace(/[^A-Z0-9]/g, "")
                )
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

    // Un filtro guardado de una visita anterior puede apuntar a una cripto que
    // ya no existe: se descarta y, si no queda ninguna, se vuelve a «Todos».
    if (transaccionesFilter) {
        const assetIds = new Set(transaccionesCryptoAssets.map((asset) => asset.id))
        transaccionesFilter = new Set([...transaccionesFilter].filter((id) => assetIds.has(id)))
        if (!transaccionesFilter.size) transaccionesFilter = null
    }
}

function bindTransaccionesEvents() {
    const body = document.getElementById("transaccionesBody")
    const addButton = document.getElementById("addTransaccionRowBtn")
    const saveButton = document.getElementById("saveTransaccionesBtn")
    const filtersEl = document.getElementById("transaccionesAssetMenu")
    if (filtersEl && !filtersEl.dataset.bound) {
        filtersEl.dataset.bound = "true"
        filtersEl.addEventListener("change", handleTransaccionesFilterChange)
    }

    if (body && !body.dataset.bound) {
        body.dataset.bound = "true"
        body.addEventListener("click", handleTransaccionesClick)
        body.addEventListener("click", handleTransaccionesDeleteClick)
    }

    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => {
            if (!transaccionesCryptoAssets.length) return
            openTransaccionRowModal("")
        })
    }

    const menuTrigger = document.querySelector("#transaccionesActionsMenu .pageActionsMenuTrigger")
    const menu = document.getElementById("transaccionesActionsDropdown")
    if (menuTrigger && menu && !menu.dataset.bound) {
        menu.dataset.bound = "true"
        menuTrigger.addEventListener("click", (event) => {
            event.stopPropagation()
            menu.classList.toggle("open")
        })
        menu.addEventListener("click", () => menu.classList.remove("open"))
        // Como en Cuentas: el listener del documento se retira solo cuando el
        // menú ya no está en pantalla.
        const cerrar = () => {
            if (!menu.isConnected) {
                document.removeEventListener("click", cerrar)
                return
            }
            menu.classList.remove("open")
        }
        document.addEventListener("click", cerrar)
        document.getElementById("transaccionesGrafoBtn")?.addEventListener("click", abrirGrafoTransacciones)
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
    const defaultAsset = getDefaultTransaccionAsset()

    return {
        id: `transaccion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        assetId: defaultAsset?.id || "",
        assetName: defaultAsset?.name || "",
        fechaOperacion: "",
        total: "",
        comisionRed: "",
        walletTipo: "entre_wallet",
        walletDesde: "",
        walletDestino: "",
        hashTransaccion: "",
        nota: ""
    }
}

function getTransaccionAsset(assetId) {
    return transaccionesCryptoAssets.find((asset) => asset.id === assetId) || null
}

// La cripto que propone «Añadir transacción»: la única filtrada si hay una,
// si no la primera de la lista.
function getDefaultTransaccionAsset() {
    if (transaccionesFilter?.size === 1) return getTransaccionAsset([...transaccionesFilter][0])
    return transaccionesCryptoAssets[0] || null
}

// Color del activo tal y como está en Activos, ajustado para que se lea sobre el
// tema (un activo casi negro desaparecía en el tema oscuro). Las stablecoins no
// tienen ficha de activo y van todas en el mismo rosa que en su página.
function getTransaccionAssetColor(asset) {
    return colorLegibleEnTema(asset?.color || (asset?.type === "stablecoin" ? "#f472b6" : "#8899bb"))
}

function getVisibleTransaccionesRows() {
    const rows = currentTransaccionesData.rows || []
    return transaccionesFilter ? rows.filter((row) => transaccionesFilter.has(row.assetId)) : rows
}

function buildTransaccionesFilterChip(value, text, color, checked) {
    const label = document.createElement("label")
    label.className = "overviewFilterOption transaccionesFilterChip"
    label.style.setProperty("--chipColor", color)
    label.innerHTML = `<input type="checkbox" value="${escapeHtml(value)}"${checked ? " checked" : ""}><span>${escapeHtml(text)}</span>`
    return label
}

function renderTransaccionesAssetMenu() {
    const menu = document.getElementById("transaccionesAssetMenu")
    const addButton = document.getElementById("addTransaccionRowBtn")

    if (!menu || !addButton) {
        return
    }

    menu.innerHTML = ""
    addButton.disabled = !transaccionesCryptoAssets.length

    if (!transaccionesCryptoAssets.length) {
        refrescarTiraPestanas(menu)
        return
    }

    const todosMode = !transaccionesFilter
    menu.appendChild(buildTransaccionesFilterChip("todos", "Todos", "#8899bb", todosMode))
    transaccionesCryptoAssets.forEach((asset, index) => {
        // Separador entre las criptos y las stablecoins, que van al final de la lista.
        const anterior = transaccionesCryptoAssets[index - 1]
        if (asset.type === "stablecoin" && anterior && anterior.type !== "stablecoin") {
            const separador = document.createElement("div")
            separador.className = "filtersDivider"
            menu.appendChild(separador)
        }
        menu.appendChild(
            buildTransaccionesFilterChip(
                asset.id,
                asset.name || asset.symbol || asset.id,
                getTransaccionAssetColor(asset),
                todosMode || transaccionesFilter.has(asset.id)
            )
        )
    })
    refrescarTiraPestanas(menu)
}

// Mismo criterio que el resto de filtros de la app: desde «Todos», pulsar una
// cripto deja solo esa; luego se suman o quitan; sin ninguna (o con todas)
// vuelve a «Todos».
function handleTransaccionesFilterChange(event) {
    const input = event.target.closest("input")
    if (!input) return

    const value = input.value
    if (value === "todos") {
        transaccionesFilter = null
    } else if (!transaccionesFilter) {
        transaccionesFilter = new Set([value])
    } else {
        if (transaccionesFilter.has(value)) transaccionesFilter.delete(value)
        else transaccionesFilter.add(value)
        if (!transaccionesFilter.size || transaccionesFilter.size === transaccionesCryptoAssets.length) {
            transaccionesFilter = null
        }
    }

    renderTransaccionesAssetMenu()
    renderTransaccionesTable()
}

function renderTransaccionesTable() {
    const body = document.getElementById("transaccionesBody")

    if (!body) {
        return
    }

    body.innerHTML = ""

    const tableWrapper = document.getElementById("transaccionesTableWrapper")
    const noAssetEl = document.getElementById("transaccionesNoAssetMsg")
    const transaccionesEmptyEl = document.getElementById("transaccionesEmptyMsg")

    if (!transaccionesCryptoAssets.length) {
        if (tableWrapper) tableWrapper.classList.add("hidden")
        if (noAssetEl) noAssetEl.classList.remove("hidden")
        if (transaccionesEmptyEl) transaccionesEmptyEl.classList.add("hidden")
        return
    }

    if (noAssetEl) noAssetEl.classList.add("hidden")

    const rows = getVisibleTransaccionesRows()

    if (!rows.length) {
        if (tableWrapper) tableWrapper.classList.add("hidden")
        if (transaccionesEmptyEl) transaccionesEmptyEl.classList.remove("hidden")
        return
    }
    if (tableWrapper) tableWrapper.classList.remove("hidden")
    if (transaccionesEmptyEl) transaccionesEmptyEl.classList.add("hidden")

    rows.forEach((row) => {
        body.appendChild(buildTransaccionRow(row))
    })

    bindTableSort(body.closest("table"), "transacciones")
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
    const normalizedValue = String(value || "")
        .trim()
        .toLowerCase()

    if (normalizedValue === "recibida") {
        return "recibida"
    }

    if (normalizedValue === "enviada" || normalizedValue === "no_mia") {
        return "enviada"
    }

    return "entre_wallet"
}

function buildTransaccionRow(row) {
    const tr = document.createElement("tr")
    const hashTransaccion = normalizeHashTransaccionValue(row.hashTransaccion || row.walletOrigen || "")
    const walletLabel =
        TRANSACCION_WALLET_OPTIONS.find((o) => o.value === normalizeTransaccionWalletTipo(row.walletTipo))?.label ||
        row.walletTipo ||
        ""
    const asset = getTransaccionAsset(row.assetId)
    const assetColor = getTransaccionAssetColor(asset)
    const assetName = asset?.name || row.assetName || ""
    tr.dataset.transaccionId = row.id
    tr.innerHTML = `
        <td><span class="mTypeBadge" style="background:${assetColor}22;color:${assetColor};border-color:${assetColor}44">${escapeHtml(assetName)}</span></td>
        <td>${escapeHtml(row.fechaOperacion)}</td>
        <td>${formatTransaccionesNumber(row.total)}</td>
        <td>${formatTransaccionesNumber(row.comisionRed)}</td>
        <td>${walletLabel}</td>
        <td>${escapeHtml(row.walletDesde || "")}</td>
        <td>${escapeHtml(row.walletDestino || "")}</td>
        <td class="transaccionHashCell" data-full-value="${escapeHtml(hashTransaccion)}" title="Haz clic para copiar el hash completo">${escapeHtml(formatHashTransaccionDisplay(hashTransaccion))}</td>
        <td>${escapeHtml(row.nota || "")}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn transaccionRowEditBtn avActionBtn avEditBtn" data-row-id="${escapeHtml(row.id)}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn transaccionRowDeleteBtn avActionBtn avDeleteBtn" data-row-id="${escapeHtml(row.id)}">Eliminar</button>
                </div>
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
        cell.dataset.copyTimeoutId = String(
            window.setTimeout(() => {
                cell.classList.remove("copied")
                cell.title = "Haz clic para copiar el hash completo"
            }, 1200)
        )
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

function syncTransaccionesDataFromTable() {
    // Table is display-only; data is managed directly in currentTransaccionesData.rows via the modal
}

function scheduleTransaccionesAutosave(delay = 500) {
    transaccionesHasPendingChanges = true
    window.clearTimeout(transaccionesAutosaveTimeout)
    transaccionesAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistTransaccionesData()
        } catch (error) {
            showError("No se pudieron guardar las transacciones", error, { persistent: true })
        }
    }, delay)
}

async function persistTransaccionesData(options = {}) {
    syncTransaccionesDataFromTable()
    window.clearTimeout(transaccionesAutosaveTimeout)
    const snapshot = {
        rows: (currentTransaccionesData.rows || []).map((row) => ({ ...row }))
    }

    transaccionesHasPendingChanges = false
    transaccionesPersistChain = transaccionesPersistChain
        .catch(() => {})
        .then(() =>
            saveTransaccionesData(
                { ...snapshot, ...(Number.isInteger(transaccionesRevision) ? { revision: transaccionesRevision } : {}) },
                options
            )
        )

    try {
        let respuesta
        try {
            respuesta = await transaccionesPersistChain
        } catch (error) {
            // Con keepalive la página puede estar cerrándose: no hay tiempo de
            // fusionar, y en el servidor no se ha borrado nada.
            if (error?.status !== 409 || options.keepalive) throw error
            respuesta = await fusionarTransaccionesTrasConflicto(snapshot)
        }
        if (Number.isInteger(respuesta?.revision)) transaccionesRevision = respuesta.revision
        transaccionesBaseRows = JSON.parse(JSON.stringify(currentTransaccionesData.rows || []))
    } catch (error) {
        transaccionesHasPendingChanges = true
        throw error
    }

    if (!options.keepalive) {
        await refreshAssetsSidebar(currentAssetId, false)
    }
}

// Otra pestaña u otro dispositivo guardó las transacciones entretanto: se
// aplican los cambios de esta pestaña (respecto a lo que cargó) sobre lo que hay.
async function fusionarTransaccionesTrasConflicto(snapshot) {
    const servidor = await loadTransaccionesData()
    const filasServidor = servidor.rows || []
    const { filas, descartadas } = resolverConflictosPorId(
        fusionarListaTresVias(transaccionesBaseRows, snapshot.rows, filasServidor, claveEstableAnual),
        filasServidor
    )
    currentTransaccionesData = { ...currentTransaccionesData, rows: filas }
    let respuesta
    try {
        respuesta = await saveTransaccionesData({ rows: filas, revision: servidor.revision })
    } catch (error) {
        // No se ha podido guardar: la pestaña vuelve a lo que hay en el servidor
        // para no enseñar como guardado lo que no lo está.
        currentTransaccionesData = { ...currentTransaccionesData, rows: filasServidor }
        transaccionesRevision = Number.isInteger(servidor.revision) ? servidor.revision : null
        transaccionesBaseRows = JSON.parse(JSON.stringify(filasServidor))
        renderTransaccionesTable()
        error.message = `No se han guardado tus cambios en las transacciones; se han recargado las del servidor. (${error.message})`
        throw error
    }
    renderTransaccionesTable()
    avisarFusion("las transacciones", descartadas.length)
    return respuesta
}

async function flushTransaccionesPendingChanges() {
    if (!document.getElementById("transaccionesBody") || !transaccionesHasPendingChanges) {
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
        if (!document.getElementById("transaccionesBody") || !transaccionesHasPendingChanges) {
            return
        }

        persistTransaccionesData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar transacciones al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (
            document.visibilityState !== "hidden" ||
            !document.getElementById("transaccionesBody") ||
            !transaccionesHasPendingChanges
        ) {
            return
        }

        persistTransaccionesData({ keepalive: true }).catch((error) => {
            console.error("Error al guardar transacciones al cambiar de ventana:", error)
        })
    })
}

function openTransaccionRowModal(rowId) {
    document.getElementById("transaccionRowModalOverlay")?.remove()

    const rowIndex = (currentTransaccionesData.rows || []).findIndex((r) => r.id === rowId)
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...currentTransaccionesData.rows[rowIndex] } : createEmptyTransaccionRow()

    const walletOptions = TRANSACCION_WALLET_OPTIONS.map(
        (opt) =>
            `<option value="${escapeHtml(opt.value)}"${rowData.walletTipo === opt.value ? " selected" : ""}>${escapeHtml(opt.label)}</option>`
    ).join("")

    const assetOptions = transaccionesCryptoAssets
        .map(
            (asset) =>
                `<option value="${escapeHtml(asset.id)}"${asset.id === rowData.assetId ? " selected" : ""}>${escapeHtml(asset.name || asset.symbol || asset.id)}</option>`
        )
        .join("")

    const fieldsHtml = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Cripto</label>
            <select id="txModalAsset" class="assetRowModalSelect">
                ${assetOptions}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha operación</label>
            <input id="txModalFecha" class="assetRowModalInput" type="text" value="${escapeHtml(rowData.fechaOperacion)}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Total cripto</label>
            <input id="txModalTotal" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0,05" value="${escapeHtml(rowData.total)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Comisión red</label>
            <input id="txModalComision" class="assetRowModalInput" type="text" inputmode="decimal" placeholder="0,0001" value="${escapeHtml(rowData.comisionRed)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet</label>
            <select id="txModalWalletTipo" class="assetRowModalSelect">
                ${walletOptions}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet origen</label>
            <input id="txModalWalletDesde" class="assetRowModalInput" type="text" value="${escapeHtml(rowData.walletDesde || "")}" placeholder="Ej: Binance">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Wallet destino</label>
            <input id="txModalWalletDestino" class="assetRowModalInput" type="text" placeholder="Ej: Ledger" value="${escapeHtml(rowData.walletDestino)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Hash transacción</label>
            <input id="txModalHash" class="assetRowModalInput" type="text" placeholder="Ej: 0x3f5e…a91c" value="${escapeHtml(rowData.hashTransaccion)}">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Nota</label>
            <input id="txModalNota" class="assetRowModalInput" type="text" placeholder="Opcional: motivo del envío…" value="${escapeHtml(rowData.nota)}">
        </div>
    `

    const overlay = document.createElement("div")
    overlay.id = "transaccionRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.rowId = rowId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal modalDosColumnas"

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

// Gráfico de la moneda seleccionada: no se mezclan monedas porque las cantidades
// van en unidades, así que hace falta tener una sola cripto en el filtro. Sin
// wallet indicada, lo recibido viene de «Externa» y lo enviado va a «Externa»;
// el resto queda como «Sin indicar».
function abrirGrafoTransacciones() {
    const asset = transaccionesFilter?.size === 1 ? getTransaccionAsset([...transaccionesFilter][0]) : null
    if (!asset) {
        openConfirmModal({
            title: "Ver movimientos en gráfico",
            message: "Deja seleccionada una sola cripto en los filtros para ver el gráfico de sus movimientos.",
            confirmLabel: "OK"
        })
        return
    }
    const simbolo = String(asset.symbol || asset.name || "").trim()
    const filas = getVisibleTransaccionesRows()
    const sinOrigen = filas.some(
        (row) => !String(row.walletDesde || "").trim() && normalizeTransaccionWalletTipo(row.walletTipo) !== "recibida"
    )
    const movimientos = filas.map((row) => {
        const tipo = normalizeTransaccionWalletTipo(row.walletTipo)
        const origen = String(row.walletDesde || "").trim() || (tipo === "recibida" ? "Externa" : "Sin indicar")
        const destino = String(row.walletDestino || "").trim() || (tipo === "enviada" ? "Externa" : "Sin indicar")
        return { origen, destino, cantidad: parseLooseNumber(row.total) ?? 0 }
    })
    abrirGrafoFlujos({
        titulo: `Movimientos de ${asset.name || simbolo}`,
        subtitulo: sinOrigen
            ? "Hay transacciones sin wallet de origen: salen de «Sin indicar». Edítalas para que salgan de su wallet."
            : `${filas.length} transacción${filas.length === 1 ? "" : "es"}`,
        movimientos,
        formato: (n) =>
            `${n.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 8 })} ${simbolo}`.trim(),
        vacio: `No hay transacciones de ${asset.name || simbolo} entre dos wallets distintas.`
    })
}

function closeTransaccionRowModal() {
    document.getElementById("transaccionRowModalOverlay")?.remove()
}

function saveTransaccionRowFromModal() {
    const overlay = document.getElementById("transaccionRowModalOverlay")
    const rowId = overlay?.dataset.rowId || ""
    const g = (id) => document.getElementById(id)?.value ?? ""
    const selectedAsset = getTransaccionAsset(g("txModalAsset"))

    const rowData = {
        id: rowId || `transaccion-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        assetId: selectedAsset?.id || "",
        assetName: selectedAsset?.name || "",
        fechaOperacion: g("txModalFecha"),
        total: g("txModalTotal"),
        comisionRed: g("txModalComision"),
        walletTipo: normalizeTransaccionWalletTipo(g("txModalWalletTipo")),
        walletDesde: g("txModalWalletDesde").trim(),
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

    renderTransaccionesAssetMenu()
    renderTransaccionesTable()
    scheduleTransaccionesAutosave()
    closeTransaccionRowModal()
}
