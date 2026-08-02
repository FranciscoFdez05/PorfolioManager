// ===== EARN =====

let _earnCriptos = []       // [{ id, nombre, rows: [...] }]
let earnCurrentCriptoId = null
let _earnRows = []
let earnCurrentYear = null

function generateEarnId() {
    return "earn-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function getEarnCurrentCripto() {
    return _earnCriptos.find(c => c.id === earnCurrentCriptoId) || null
}

function earnSyncRowsBack() {
    const cripto = getEarnCurrentCripto()
    if (cripto) cripto.rows = _earnRows
}

// ----- Sidebar de criptos -----

function renderEarnCriptosSidebar() {
    const list = document.getElementById("earnCriptosList")
    if (!list) return
    list.innerHTML = ""

    _earnCriptos.forEach(cripto => {
        const item = document.createElement("div")
        item.className = `cuentaItem${cripto.id === earnCurrentCriptoId ? " active" : ""}`
        item.dataset.criptoId = cripto.id
        item.innerHTML = `
            <span class="cuentaItemName" title="${escapeEarnHtml(cripto.nombre)}">${escapeEarnHtml(cripto.nombre)}</span>
            <div class="cuentaItemActions">
                <button type="button" class="cuentaItemRenameBtn" data-id="${cripto.id}" title="Renombrar">✎</button>
                <button type="button" class="cuentaItemDeleteBtn" data-id="${cripto.id}" title="Eliminar">✕</button>
            </div>
        `
        item.addEventListener("click", (e) => {
            if (e.target.closest(".cuentaItemRenameBtn") || e.target.closest(".cuentaItemDeleteBtn")) return
            selectEarnCripto(cripto.id)
        })
        list.appendChild(item)
    })
}

function selectEarnCripto(id) {
    earnCurrentCriptoId = id
    earnCurrentYear = null
    const cripto = getEarnCurrentCripto()
    _earnRows = cripto ? cripto.rows : []
    renderEarnCriptosSidebar()
    const years = getEarnYears(_earnRows)
    if (years.length) earnCurrentYear = years[years.length - 1]
    renderEarnYearBar(years)
    renderFilteredEarn()
}

// ----- Años -----

function parseEarnYear(fecha) {
    const p = String(fecha || "").split("-")
    if (p.length === 3) return p[2]
    if (p.length === 2) return p[1]
    return null
}

function getEarnYears(rows) {
    const years = new Set()
    rows.forEach(r => { const y = parseEarnYear(r.fecha); if (y) years.add(y) })
    return [...years].sort((a, b) => Number(a) - Number(b))
}

function renderEarnYearBar(years) {
    const list = document.getElementById("earnYearList")
    if (!list) return
    list.innerHTML = ""
    years.forEach(year => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `interesesYearBtn${year === earnCurrentYear ? " active" : ""}`
        btn.textContent = year
        btn.addEventListener("click", () => {
            earnCurrentYear = year
            renderFilteredEarn()
        })
        list.appendChild(btn)
    })
}

function escapeEarnHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

// ----- Modal nombre cripto -----

function openEarnNameModal({ title, defaultValue = "", onConfirm }) {
    const existingOverlay = document.getElementById("earnNameModalOverlay")
    if (existingOverlay) existingOverlay.remove()

    const overlay = document.createElement("div")
    overlay.id = "earnNameModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${escapeEarnHtml(title)}</h3>
        <label class="assetModalLabel" for="earnNameInput">Nombre</label>
        <input id="earnNameInput" class="assetModalInput" type="text" value="${escapeEarnHtml(defaultValue)}" placeholder="Ej: ETH, BTC, USDT...">
        <p class="gastosCreateModalFeedback hidden" id="earnNameFeedback"></p>
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="cancelButton" id="earnNameCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="earnNameConfirmBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const close = () => overlay.remove()
    const doConfirm = () => {
        const nombre = modal.querySelector("#earnNameInput")?.value.trim()
        if (!nombre) {
            const fb = modal.querySelector("#earnNameFeedback")
            if (fb) { fb.textContent = "El nombre no puede estar vacío."; fb.classList.remove("hidden") }
            return
        }
        close()
        onConfirm(nombre)
    }

    modal.querySelector("#earnNameCancelBtn").addEventListener("click", close)
    modal.querySelector("#earnNameConfirmBtn").addEventListener("click", doConfirm)
    modal.querySelector("#earnNameInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doConfirm()
        if (e.key === "Escape") close()
    })
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    modal.querySelector("#earnNameInput")?.focus()
    modal.querySelector("#earnNameInput")?.select()
}

// ----- CRUD criptos -----

function addEarnCripto() {
    openEarnNameModal({
        title: "Nueva cripto/producto earn",
        onConfirm: async (nombre) => {
            const newCripto = { id: generateEarnId(), nombre, rows: [] }
            _earnCriptos.push(newCripto)
            selectEarnCripto(newCripto.id)
            try {
                await saveEarnToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo guardar la nueva cripto.")
            }
        }
    })
}

function renameEarnCripto(id) {
    const cripto = _earnCriptos.find(c => c.id === id)
    if (!cripto) return
    openEarnNameModal({
        title: "Renombrar cripto/producto",
        defaultValue: cripto.nombre,
        onConfirm: async (nombre) => {
            if (nombre === cripto.nombre) return
            cripto.nombre = nombre
            renderEarnCriptosSidebar()
            try {
                await saveEarnToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo guardar el nombre.")
            }
        }
    })
}

function deleteEarnCripto(id) {
    const cripto = _earnCriptos.find(c => c.id === id)
    if (!cripto) return
    openConfirmModal({
        title: "Eliminar cripto/producto",
        message: `¿Eliminar "${cripto.nombre}" y todos sus registros de earn?`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                _earnCriptos = _earnCriptos.filter(c => c.id !== id)
                if (earnCurrentCriptoId === id) {
                    earnCurrentCriptoId = _earnCriptos.length ? _earnCriptos[0].id : null
                }
                const newCripto = getEarnCurrentCripto()
                _earnRows = newCripto ? newCripto.rows : []
                earnCurrentYear = null
                renderEarnCriptosSidebar()
                const years = getEarnYears(_earnRows)
                if (years.length) earnCurrentYear = years[years.length - 1]
                renderEarnYearBar(years)
                renderFilteredEarn()
                await saveEarnToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo eliminar la cripto.")
            }
        }
    })
}

function bindEarnCriptosActions() {
    const addBtn = document.getElementById("addEarnCriptoBtn")
    if (addBtn && !addBtn.dataset.bound) {
        addBtn.dataset.bound = "true"
        addBtn.addEventListener("click", addEarnCripto)
    }

    const list = document.getElementById("earnCriptosList")
    if (list && !list.dataset.bound) {
        list.dataset.bound = "true"
        list.addEventListener("click", (e) => {
            const renameBtn = e.target.closest(".cuentaItemRenameBtn")
            if (renameBtn) { renameEarnCripto(renameBtn.dataset.id); return }
            const deleteBtn = e.target.closest(".cuentaItemDeleteBtn")
            if (deleteBtn) { deleteEarnCripto(deleteBtn.dataset.id); return }
        })
    }
}

// ----- Modal añadir/editar fila -----

function closeEarnModal() {
    document.getElementById("earnModalOverlay")?.remove()
}

function openEarnModal(globalIndex = -1, defaultFecha = "") {
    closeEarnModal()

    const isEdit = globalIndex >= 0
    const rowData = isEdit ? { ..._earnRows[globalIndex] } : {}
    if (!isEdit && defaultFecha) rowData.fecha = defaultFecha

    const overlay = document.createElement("div")
    overlay.id = "earnModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar recompensa earn" : "Añadir recompensa earn"}</h3>
        <label class="assetModalLabel" for="earnFechaInput">Fecha</label>
        <input id="earnFechaInput" class="assetModalInput" type="text" value="${escapeEarnHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="earnPlataformaInput">Plataforma</label>
        <input id="earnPlataformaInput" class="assetModalInput" type="text" value="${escapeEarnHtml(rowData.plataforma || "")}" placeholder="Ej: Binance, Coinbase, Kraken...">
        <label class="assetModalLabel" for="earnCantidadInput">Cantidad cripto</label>
        <input id="earnCantidadInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeEarnHtml(rowData.cantidad || "")}" placeholder="0,00000000">
        <label class="assetModalLabel" for="earnPrecioInput">Precio unitario (€)</label>
        <input id="earnPrecioInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeEarnHtml(rowData.precio || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="earnNotaInput">Nota</label>
        <input id="earnNotaInput" class="assetModalInput" type="text" value="${escapeEarnHtml(rowData.nota || "")}" placeholder="Opcional">
        <p class="gastosCreateModalFeedback hidden" id="earnModalFeedback"></p>
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="cancelButton" id="earnModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="earnModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const setFeedback = (msg = "", isError = false) => {
        const node = modal.querySelector("#earnModalFeedback")
        if (!node) return
        node.textContent = msg
        node.classList.toggle("hidden", !msg)
        node.classList.toggle("error", Boolean(msg && isError))
    }

    modal.querySelector("#earnModalCancelBtn").addEventListener("click", closeEarnModal)
    modal.querySelector("#earnModalSaveBtn").addEventListener("click", async () => {
        const fecha = modal.querySelector("#earnFechaInput")?.value.trim() || ""
        const plataforma = modal.querySelector("#earnPlataformaInput")?.value.trim() || ""
        const cantidadRaw = modal.querySelector("#earnCantidadInput")?.value.trim() || ""
        const precioRaw = modal.querySelector("#earnPrecioInput")?.value.trim() || ""
        const nota = modal.querySelector("#earnNotaInput")?.value.trim() || ""

        if (!fecha && !cantidadRaw && !precioRaw) {
            setFeedback("Introduce al menos un dato.", true)
            return
        }

        const cantidad = cantidadRaw ? formatEarnCriptoValue(cantidadRaw) : ""
        const precio = precioRaw ? formatCellEuroValue(precioRaw) : ""
        const nextRow = { fecha, plataforma, cantidad, precio, nota }

        if (isEdit) {
            _earnRows[globalIndex] = nextRow
        } else {
            _earnRows.push(nextRow)
            const newYear = parseEarnYear(fecha)
            if (newYear) earnCurrentYear = newYear
        }

        try {
            renderFilteredEarn()
            await saveEarnToServer()
            closeEarnModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    document.addEventListener("keydown", function handler(e) {
        if (e.key === "Escape") { closeEarnModal(); document.removeEventListener("keydown", handler) }
    })

    modal.querySelector("input")?.focus()
}

// ----- Render tabla -----

function renderFilteredEarn() {
    const earnBody = document.getElementById("earnBody")
    const noAssetMsg = document.getElementById("earnNoAssetMsg")
    const emptyMsg = document.getElementById("earnEmptyMsg")
    const tableWrapper = document.getElementById("earnTableWrapper")

    if (!earnBody) return

    if (!earnCurrentCriptoId) {
        if (noAssetMsg) noAssetMsg.classList.remove("hidden")
        if (emptyMsg) emptyMsg.classList.add("hidden")
        if (tableWrapper) tableWrapper.classList.add("hidden")
        earnBody.innerHTML = ""
        updateEarnTotals()
        return
    }

    if (noAssetMsg) noAssetMsg.classList.add("hidden")

    const years = getEarnYears(_earnRows)
    renderEarnYearBar(years)

    const visible = earnCurrentYear
        ? _earnRows.map((r, i) => ({ r, i })).filter(({ r }) => parseEarnYear(r.fecha) === earnCurrentYear)
        : _earnRows.map((r, i) => ({ r, i }))

    earnBody.innerHTML = ""

    if (!visible.length) {
        if (emptyMsg) emptyMsg.classList.remove("hidden")
        if (tableWrapper) tableWrapper.classList.add("hidden")
        updateEarnTotals()
        return
    }

    if (emptyMsg) emptyMsg.classList.add("hidden")
    if (tableWrapper) tableWrapper.classList.remove("hidden")

    visible.forEach(({ r: rowData, i: globalIndex }) => {
        const cantidad = parseLooseNumber(rowData.cantidad || "")
        const precio = parseEuroNumber(rowData.precio || "")
        const total = cantidad * precio

        const rowElement = document.createElement("tr")
        rowElement.innerHTML = `
            <td>${escapeEarnHtml(rowData.fecha || "")}</td>
            <td>${escapeEarnHtml(rowData.plataforma || "")}</td>
            <td>${escapeEarnHtml(rowData.cantidad || "")}</td>
            <td>${formatCellEuroValue(rowData.precio)}</td>
            <td class="rowTotal">${formatEuro(total)}</td>
            <td>${escapeEarnHtml(rowData.nota || "")}</td>
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem assetRowEditBtn avActionBtn avEditBtn" data-global-index="${globalIndex}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn avActionBtn avDeleteBtn" data-global-index="${globalIndex}">Eliminar</button>
                    </div>
                </div>
            </td>
        `
        earnBody.appendChild(rowElement)
    })

    updateEarnTotals()
}

// ----- Totales -----

function updateEarnTotals() {
    const earnBody = document.getElementById("earnBody")
    let totalEur = 0
    let totalCripto = 0

    if (earnBody) {
        earnBody.querySelectorAll("tr").forEach(tr => {
            const cells = tr.querySelectorAll("td")
            const cantidad = parseLooseNumber(cells[2]?.textContent || "")
            const precio = parseEuroNumber(cells[3]?.textContent || "")
            totalCripto += cantidad
            totalEur += cantidad * precio
        })
    }

    const totalEurEl = document.getElementById("earnTotalEur")
    const totalCriptoEl = document.getElementById("earnTotalCripto")
    if (totalEurEl) totalEurEl.textContent = formatEuro(totalEur)
    if (totalCriptoEl) totalCriptoEl.textContent = formatEarnLooseNumber(totalCripto)
}

// ----- Acciones de fila -----

function addEarnRow() {
    if (!earnCurrentCriptoId) {
        showAlert("Primero selecciona o crea una cripto/producto earn.")
        return
    }
    openEarnModal()
}

function handleEarnRowActionClick(event) {
    const editBtn = event.target.closest(".assetRowEditBtn")
    if (editBtn) {
        openEarnModal(Number(editBtn.dataset.globalIndex))
        return
    }

    const deleteBtn = event.target.closest(".assetRowDeleteBtn")
    if (!deleteBtn) return

    const globalIndex = Number(deleteBtn.dataset.globalIndex)
    const row = _earnRows[globalIndex]
    const isEmpty = !row || (!row.fecha && !row.cantidad && !row.precio)

    const removeRow = async () => {
        _earnRows.splice(globalIndex, 1)
        renderFilteredEarn()
        await saveEarnToServer()
    }

    if (isEmpty) {
        removeRow().catch(err => { console.error(err); showAlert("No se pudo eliminar la fila.") })
        return
    }

    openConfirmModal({
        title: "Eliminar fila",
        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try { await removeRow() } catch (err) { console.error(err); showAlert("No se pudo eliminar la fila.") }
        }
    })
}

// ----- Años -----

function addEarnYear() {
    openEarnNameModal({
        title: "Añadir año",
        defaultValue: String(new Date().getFullYear()),
        onConfirm: (yearStr) => {
            if (!/^\d{4}$/.test(yearStr)) {
                showAlert("Año no válido. Introduce 4 dígitos (ej: 2027).")
                return
            }
            openEarnModal(-1, `01-${yearStr}`)
        }
    })
}

function deleteCurrentEarnYear() {
    if (!earnCurrentYear) return
    openConfirmModal({
        title: "Eliminar año",
        message: `¿Eliminar todas las filas del año ${earnCurrentYear}?`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                _earnRows = _earnRows.filter(r => parseEarnYear(r.fecha) !== earnCurrentYear)
                earnSyncRowsBack()
                const remaining = getEarnYears(_earnRows)
                earnCurrentYear = remaining.length ? remaining[remaining.length - 1] : null
                renderEarnYearBar(remaining)
                renderFilteredEarn()
                await saveEarnToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo eliminar el año.")
            }
        }
    })
}

// ----- Carga y guardado -----

async function loadEarnData() {
    try {
        const response = await fetch("/api/earn")
        if (!response.ok) throw new Error("No se pudo cargar /api/earn")
        return await response.json()
    } catch (error) {
        console.error("Error cargando earn:", error)
        return { criptos: [] }
    }
}

function loadEarnFromData(data) {
    _earnCriptos = Array.isArray(data?.criptos) ? data.criptos : []

    if (!earnCurrentCriptoId && _earnCriptos.length) {
        earnCurrentCriptoId = _earnCriptos[0].id
    } else if (earnCurrentCriptoId && !_earnCriptos.find(c => c.id === earnCurrentCriptoId)) {
        earnCurrentCriptoId = _earnCriptos.length ? _earnCriptos[0].id : null
    }

    const cripto = getEarnCurrentCripto()
    _earnRows = cripto ? cripto.rows : []

    renderEarnCriptosSidebar()

    const years = getEarnYears(_earnRows)
    if (!earnCurrentYear && years.length) earnCurrentYear = years[years.length - 1]
    renderEarnYearBar(years)
    renderFilteredEarn()
}

async function saveEarnToServer() {
    earnSyncRowsBack()
    const response = await fetch("/api/earn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criptos: _earnCriptos })
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

// ----- Helpers de formato -----

function formatEarnCriptoValue(raw) {
    const n = parseLooseNumber(String(raw || ""))
    if (isNaN(n)) return ""
    return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
}

function formatEarnLooseNumber(n) {
    if (isNaN(n)) return "0,00"
    return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
}

// ----- Init -----

async function initEarnLogic() {
    earnCurrentCriptoId = null
    earnCurrentYear = null

    const data = await loadEarnData()
    loadEarnFromData(data)

    const earnBody = document.getElementById("earnBody")
    if (earnBody && !earnBody.dataset.bound) {
        earnBody.dataset.bound = "true"
        earnBody.addEventListener("click", handleEarnRowActionClick)
    }

    const addRowBtn = document.getElementById("addEarnRowBtn")
    if (addRowBtn && !addRowBtn.dataset.bound) {
        addRowBtn.dataset.bound = "true"
        addRowBtn.addEventListener("click", addEarnRow)
    }

    const addYearBtn = document.getElementById("addEarnYearBtn")
    if (addYearBtn && !addYearBtn.dataset.bound) {
        addYearBtn.dataset.bound = "true"
        addYearBtn.addEventListener("click", addEarnYear)
    }

    const deleteYearBtn = document.getElementById("deleteEarnYearBtn")
    if (deleteYearBtn && !deleteYearBtn.dataset.bound) {
        deleteYearBtn.dataset.bound = "true"
        deleteYearBtn.addEventListener("click", deleteCurrentEarnYear)
    }

    bindEarnCriptosActions()

    const earnTable = document.querySelector(".earnLayout .interesesTable")
    if (earnTable) bindTableSort(earnTable, "earn")
}
