// ===== STAKING =====

let _stakingCriptos = []       // [{ id, nombre, rows: [...] }]
let stakingCurrentCriptoId = null
let _stakingRows = []
let stakingCurrentYear = null

function generateStakingId() {
    return "staking-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function getStakingCurrentCripto() {
    return _stakingCriptos.find(c => c.id === stakingCurrentCriptoId) || null
}

function stakingSyncRowsBack() {
    const cripto = getStakingCurrentCripto()
    if (cripto) cripto.rows = _stakingRows
}

// ----- Sidebar de criptos -----

function renderStakingCriptosSidebar() {
    const list = document.getElementById("stakingCriptosList")
    if (!list) return
    list.innerHTML = ""

    _stakingCriptos.forEach(cripto => {
        const item = document.createElement("div")
        item.className = `cuentaItem${cripto.id === stakingCurrentCriptoId ? " active" : ""}`
        item.dataset.criptoId = cripto.id
        item.innerHTML = `
            <span class="cuentaItemName" title="${escapeStakingHtml(cripto.nombre)}">${escapeStakingHtml(cripto.nombre)}</span>
            <div class="cuentaItemActions">
                <button type="button" class="cuentaItemRenameBtn" data-id="${cripto.id}" title="Renombrar">✎</button>
                <button type="button" class="cuentaItemDeleteBtn" data-id="${cripto.id}" title="Eliminar">✕</button>
            </div>
        `
        item.addEventListener("click", (e) => {
            if (e.target.closest(".cuentaItemRenameBtn") || e.target.closest(".cuentaItemDeleteBtn")) return
            selectStakingCripto(cripto.id)
        })
        list.appendChild(item)
    })
}

function selectStakingCripto(id) {
    stakingCurrentCriptoId = id
    stakingCurrentYear = null
    const cripto = getStakingCurrentCripto()
    _stakingRows = cripto ? cripto.rows : []
    renderStakingCriptosSidebar()
    const years = getStakingYears(_stakingRows)
    if (years.length) stakingCurrentYear = years[years.length - 1]
    renderStakingYearBar(years)
    renderFilteredStaking()
}

// ----- Años -----

function parseStakingYear(fecha) {
    const p = String(fecha || "").split("-")
    if (p.length === 3) return p[2]
    if (p.length === 2) return p[1]
    return null
}

function getStakingYears(rows) {
    const years = new Set()
    rows.forEach(r => { const y = parseStakingYear(r.fecha); if (y) years.add(y) })
    return [...years].sort((a, b) => Number(a) - Number(b))
}

function renderStakingYearBar(years) {
    const list = document.getElementById("stakingYearList")
    if (!list) return
    list.innerHTML = ""
    years.forEach(year => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `interesesYearBtn${year === stakingCurrentYear ? " active" : ""}`
        btn.textContent = year
        btn.addEventListener("click", () => {
            stakingCurrentYear = year
            renderFilteredStaking()
        })
        list.appendChild(btn)
    })
}

function escapeStakingHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

// ----- Modal nombre cripto -----

function openStakingNameModal({ title, defaultValue = "", onConfirm }) {
    const existingOverlay = document.getElementById("stakingNameModalOverlay")
    if (existingOverlay) existingOverlay.remove()

    const overlay = document.createElement("div")
    overlay.id = "stakingNameModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${escapeStakingHtml(title)}</h3>
        <label class="assetModalLabel" for="stakingNameInput">Nombre</label>
        <input id="stakingNameInput" class="assetModalInput" type="text" value="${escapeStakingHtml(defaultValue)}" placeholder="Ej: ETH, SOL, ADA...">
        <p class="gastosCreateModalFeedback hidden" id="stakingNameFeedback"></p>
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="cancelButton" id="stakingNameCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="stakingNameConfirmBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const close = () => overlay.remove()
    const doConfirm = () => {
        const nombre = modal.querySelector("#stakingNameInput")?.value.trim()
        if (!nombre) {
            const fb = modal.querySelector("#stakingNameFeedback")
            if (fb) { fb.textContent = "El nombre no puede estar vacío."; fb.classList.remove("hidden") }
            return
        }
        close()
        onConfirm(nombre)
    }

    modal.querySelector("#stakingNameCancelBtn").addEventListener("click", close)
    modal.querySelector("#stakingNameConfirmBtn").addEventListener("click", doConfirm)
    modal.querySelector("#stakingNameInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doConfirm()
        if (e.key === "Escape") close()
    })
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    modal.querySelector("#stakingNameInput")?.focus()
    modal.querySelector("#stakingNameInput")?.select()
}

// ----- CRUD criptos -----

function addStakingCripto() {
    openStakingNameModal({
        title: "Nueva cripto de staking",
        onConfirm: async (nombre) => {
            const newCripto = { id: generateStakingId(), nombre, rows: [] }
            _stakingCriptos.push(newCripto)
            selectStakingCripto(newCripto.id)
            try {
                await saveStakingToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo guardar la nueva cripto.")
            }
        }
    })
}

function renameStakingCripto(id) {
    const cripto = _stakingCriptos.find(c => c.id === id)
    if (!cripto) return
    openStakingNameModal({
        title: "Renombrar cripto",
        defaultValue: cripto.nombre,
        onConfirm: async (nombre) => {
            if (nombre === cripto.nombre) return
            cripto.nombre = nombre
            renderStakingCriptosSidebar()
            try {
                await saveStakingToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo guardar el nombre.")
            }
        }
    })
}

function deleteStakingCripto(id) {
    const cripto = _stakingCriptos.find(c => c.id === id)
    if (!cripto) return
    openConfirmModal({
        title: "Eliminar cripto",
        message: `¿Eliminar "${cripto.nombre}" y todos sus registros de staking?`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                _stakingCriptos = _stakingCriptos.filter(c => c.id !== id)
                if (stakingCurrentCriptoId === id) {
                    stakingCurrentCriptoId = _stakingCriptos.length ? _stakingCriptos[0].id : null
                }
                const newCripto = getStakingCurrentCripto()
                _stakingRows = newCripto ? newCripto.rows : []
                stakingCurrentYear = null
                renderStakingCriptosSidebar()
                const years = getStakingYears(_stakingRows)
                if (years.length) stakingCurrentYear = years[years.length - 1]
                renderStakingYearBar(years)
                renderFilteredStaking()
                await saveStakingToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo eliminar la cripto.")
            }
        }
    })
}

function bindStakingCriptosActions() {
    const addBtn = document.getElementById("addStakingCriptoBtn")
    if (addBtn && !addBtn.dataset.bound) {
        addBtn.dataset.bound = "true"
        addBtn.addEventListener("click", addStakingCripto)
    }

    const list = document.getElementById("stakingCriptosList")
    if (list && !list.dataset.bound) {
        list.dataset.bound = "true"
        list.addEventListener("click", (e) => {
            const renameBtn = e.target.closest(".cuentaItemRenameBtn")
            if (renameBtn) { renameStakingCripto(renameBtn.dataset.id); return }
            const deleteBtn = e.target.closest(".cuentaItemDeleteBtn")
            if (deleteBtn) { deleteStakingCripto(deleteBtn.dataset.id); return }
        })
    }
}

// ----- Modal añadir/editar fila -----

function closeStakingModal() {
    document.getElementById("stakingModalOverlay")?.remove()
}

function openStakingModal(globalIndex = -1, defaultFecha = "") {
    closeStakingModal()

    const isEdit = globalIndex >= 0
    const rowData = isEdit ? { ..._stakingRows[globalIndex] } : {}
    if (!isEdit && defaultFecha) rowData.fecha = defaultFecha

    const overlay = document.createElement("div")
    overlay.id = "stakingModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar recompensa" : "Añadir recompensa"}</h3>
        <label class="assetModalLabel" for="stakingFechaInput">Fecha</label>
        <input id="stakingFechaInput" class="assetModalInput" type="text" value="${escapeStakingHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="stakingCantidadInput">Cantidad cripto</label>
        <input id="stakingCantidadInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeStakingHtml(rowData.cantidad || "")}" placeholder="0,00000000">
        <label class="assetModalLabel" for="stakingPrecioInput">Precio unitario (€)</label>
        <input id="stakingPrecioInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeStakingHtml(rowData.precio || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="stakingNotaInput">Nota</label>
        <input id="stakingNotaInput" class="assetModalInput" type="text" value="${escapeStakingHtml(rowData.nota || "")}" placeholder="Opcional">
        <p class="gastosCreateModalFeedback hidden" id="stakingModalFeedback"></p>
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="cancelButton" id="stakingModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="stakingModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const setFeedback = (msg = "", isError = false) => {
        const node = modal.querySelector("#stakingModalFeedback")
        if (!node) return
        node.textContent = msg
        node.classList.toggle("hidden", !msg)
        node.classList.toggle("error", Boolean(msg && isError))
    }

    modal.querySelector("#stakingModalCancelBtn").addEventListener("click", closeStakingModal)
    modal.querySelector("#stakingModalSaveBtn").addEventListener("click", async () => {
        const fecha = modal.querySelector("#stakingFechaInput")?.value.trim() || ""
        const cantidadRaw = modal.querySelector("#stakingCantidadInput")?.value.trim() || ""
        const precioRaw = modal.querySelector("#stakingPrecioInput")?.value.trim() || ""
        const nota = modal.querySelector("#stakingNotaInput")?.value.trim() || ""

        if (!fecha && !cantidadRaw && !precioRaw) {
            setFeedback("Introduce al menos un dato.", true)
            return
        }

        const cantidad = cantidadRaw ? formatCellCriptoValue(cantidadRaw) : ""
        const precio = precioRaw ? formatCellEuroValue(precioRaw) : ""
        const nextRow = { fecha, cantidad, precio, nota }

        if (isEdit) {
            _stakingRows[globalIndex] = nextRow
        } else {
            _stakingRows.push(nextRow)
            const newYear = parseStakingYear(fecha)
            if (newYear) stakingCurrentYear = newYear
        }

        try {
            renderFilteredStaking()
            await saveStakingToServer()
            closeStakingModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    document.addEventListener("keydown", function handler(e) {
        if (e.key === "Escape") { closeStakingModal(); document.removeEventListener("keydown", handler) }
    })

    modal.querySelector("input")?.focus()
}

// ----- Render tabla -----

function renderFilteredStaking() {
    const stakingBody = document.getElementById("stakingBody")
    const noAssetMsg = document.getElementById("stakingNoAssetMsg")
    const emptyMsg = document.getElementById("stakingEmptyMsg")
    const tableWrapper = document.getElementById("stakingTableWrapper")

    if (!stakingBody) return

    if (!stakingCurrentCriptoId) {
        if (noAssetMsg) noAssetMsg.classList.remove("hidden")
        if (emptyMsg) emptyMsg.classList.add("hidden")
        if (tableWrapper) tableWrapper.classList.add("hidden")
        stakingBody.innerHTML = ""
        updateStakingTotals()
        return
    }

    if (noAssetMsg) noAssetMsg.classList.add("hidden")

    const years = getStakingYears(_stakingRows)
    renderStakingYearBar(years)

    const visible = stakingCurrentYear
        ? _stakingRows.map((r, i) => ({ r, i })).filter(({ r }) => parseStakingYear(r.fecha) === stakingCurrentYear)
        : _stakingRows.map((r, i) => ({ r, i }))

    stakingBody.innerHTML = ""

    if (!visible.length) {
        if (emptyMsg) emptyMsg.classList.remove("hidden")
        if (tableWrapper) tableWrapper.classList.add("hidden")
        updateStakingTotals()
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
            <td>${escapeStakingHtml(rowData.fecha || "")}</td>
            <td>${escapeStakingHtml(rowData.cantidad || "")}</td>
            <td>${formatCellEuroValue(rowData.precio)}</td>
            <td class="rowTotal">${formatEuro(total)}</td>
            <td>${escapeStakingHtml(rowData.nota || "")}</td>
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
        stakingBody.appendChild(rowElement)
    })

    updateStakingTotals()
}

// ----- Totales -----

function updateStakingTotals() {
    const stakingBody = document.getElementById("stakingBody")
    let totalEur = 0
    let totalCripto = 0

    if (stakingBody) {
        stakingBody.querySelectorAll("tr").forEach(tr => {
            const cells = tr.querySelectorAll("td")
            const cantidad = parseLooseNumber(cells[1]?.textContent || "")
            const precio = parseEuroNumber(cells[2]?.textContent || "")
            totalCripto += cantidad
            totalEur += cantidad * precio
        })
    }

    const totalEurEl = document.getElementById("stakingTotalEur")
    const totalCriptoEl = document.getElementById("stakingTotalCripto")
    if (totalEurEl) totalEurEl.textContent = formatEuro(totalEur)
    if (totalCriptoEl) totalCriptoEl.textContent = formatLooseNumber(totalCripto)
}

// ----- Acciones de fila -----

function addStakingRow() {
    if (!stakingCurrentCriptoId) {
        showAlert("Primero selecciona o crea una cripto de staking.")
        return
    }
    openStakingModal()
}

function handleStakingRowActionClick(event) {
    const editBtn = event.target.closest(".assetRowEditBtn")
    if (editBtn) {
        openStakingModal(Number(editBtn.dataset.globalIndex))
        return
    }

    const deleteBtn = event.target.closest(".assetRowDeleteBtn")
    if (!deleteBtn) return

    const globalIndex = Number(deleteBtn.dataset.globalIndex)
    const row = _stakingRows[globalIndex]
    const isEmpty = !row || (!row.fecha && !row.cantidad && !row.precio)

    const removeRow = async () => {
        _stakingRows.splice(globalIndex, 1)
        renderFilteredStaking()
        await saveStakingToServer()
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

function addStakingYear() {
    openStakingNameModal({
        title: "Añadir año",
        defaultValue: String(new Date().getFullYear()),
        onConfirm: (yearStr) => {
            if (!/^\d{4}$/.test(yearStr)) {
                showAlert("Año no válido. Introduce 4 dígitos (ej: 2027).")
                return
            }
            openStakingModal(-1, `01-${yearStr}`)
        }
    })
}

function deleteCurrentStakingYear() {
    if (!stakingCurrentYear) return
    openConfirmModal({
        title: "Eliminar año",
        message: `¿Eliminar todas las filas del año ${stakingCurrentYear}?`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                _stakingRows = _stakingRows.filter(r => parseStakingYear(r.fecha) !== stakingCurrentYear)
                stakingSyncRowsBack()
                const remaining = getStakingYears(_stakingRows)
                stakingCurrentYear = remaining.length ? remaining[remaining.length - 1] : null
                renderStakingYearBar(remaining)
                renderFilteredStaking()
                await saveStakingToServer()
            } catch (error) {
                console.error(error)
                showAlert("No se pudo eliminar el año.")
            }
        }
    })
}

// ----- Carga y guardado -----

async function loadStakingData() {
    try {
        const response = await fetch("/api/staking")
        if (!response.ok) throw new Error("No se pudo cargar /api/staking")
        return await response.json()
    } catch (error) {
        console.error("Error cargando staking:", error)
        return { criptos: [] }
    }
}

function loadStakingFromData(data) {
    _stakingCriptos = Array.isArray(data?.criptos) ? data.criptos : []

    if (!stakingCurrentCriptoId && _stakingCriptos.length) {
        stakingCurrentCriptoId = _stakingCriptos[0].id
    } else if (stakingCurrentCriptoId && !_stakingCriptos.find(c => c.id === stakingCurrentCriptoId)) {
        stakingCurrentCriptoId = _stakingCriptos.length ? _stakingCriptos[0].id : null
    }

    const cripto = getStakingCurrentCripto()
    _stakingRows = cripto ? cripto.rows : []

    renderStakingCriptosSidebar()

    const years = getStakingYears(_stakingRows)
    if (!stakingCurrentYear && years.length) stakingCurrentYear = years[years.length - 1]
    renderStakingYearBar(years)
    renderFilteredStaking()
}

async function saveStakingToServer() {
    stakingSyncRowsBack()
    const response = await fetch("/api/staking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ criptos: _stakingCriptos })
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

// ----- Helpers de formato -----

function formatCellCriptoValue(raw) {
    const n = parseLooseNumber(String(raw || ""))
    if (isNaN(n)) return ""
    return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
}

function formatLooseNumber(n) {
    if (isNaN(n)) return "0,00"
    return n.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 8 })
}

// ----- Init -----

async function initStakingLogic() {
    stakingCurrentCriptoId = null
    stakingCurrentYear = null

    const data = await loadStakingData()
    loadStakingFromData(data)

    const stakingBody = document.getElementById("stakingBody")
    if (stakingBody && !stakingBody.dataset.bound) {
        stakingBody.dataset.bound = "true"
        stakingBody.addEventListener("click", handleStakingRowActionClick)
    }

    const addRowBtn = document.getElementById("addStakingRowBtn")
    if (addRowBtn && !addRowBtn.dataset.bound) {
        addRowBtn.dataset.bound = "true"
        addRowBtn.addEventListener("click", addStakingRow)
    }

    const addYearBtn = document.getElementById("addStakingYearBtn")
    if (addYearBtn && !addYearBtn.dataset.bound) {
        addYearBtn.dataset.bound = "true"
        addYearBtn.addEventListener("click", addStakingYear)
    }

    const deleteYearBtn = document.getElementById("deleteStakingYearBtn")
    if (deleteYearBtn && !deleteYearBtn.dataset.bound) {
        deleteYearBtn.dataset.bound = "true"
        deleteYearBtn.addEventListener("click", deleteCurrentStakingYear)
    }

    bindStakingCriptosActions()

    const stakingTable = document.querySelector(".stakingLayout .interesesTable")
    if (stakingTable) bindTableSort(stakingTable, "staking")
}
