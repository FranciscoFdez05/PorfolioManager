function handleCellBlur(event) {
    const cell = event.target

    if (cell.tagName !== "TD") {
        return
    }

    const tableBody = cell.closest('tbody')
    const columnIndex = cell.cellIndex

    if (tableBody?.id === "interesesBody" && (columnIndex === 2 || columnIndex === 3)) {
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
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatShareQuantity(value)
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
        const fieldName = cell.dataset.field || ""
        const assetType = getCurrentAssetType()
        const assetCurrency = getCurrentAssetCurrency()
        const assetPriceCurrency = getCurrentAssetPriceCurrency()
        const rowCurrency = getAssetRowCurrency(cell, assetCurrency)

        if (fieldName === "participaciones") {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatAssetParticipationValue(value)
            }
        }

        if (fieldName === "comisiones" && isCryptoAssetType(assetType)) {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatAssetCommissionValue(value)
            }
        } else if (["precioParticipacion", "capitalInvertidoBruto", "comisiones", "comisionesFiat"].includes(fieldName)) {
            const moneyCurrency = getAssetTableMoneyCurrency(assetType, fieldName || "precioParticipacion", assetCurrency, assetPriceCurrency, rowCurrency)
            const value = moneyCurrency === "EUR"
                ? parseEuroNumber(cell.textContent)
                : parseDollarNumber(cell.textContent)

            if (hasText) {
                cell.textContent = (fieldName === "comisiones" || fieldName === "comisionesFiat")
                    ? formatAssetCommissionValue(value, moneyCurrency)
                    : formatMoney(value, moneyCurrency)
            }
        }

        if (fieldName === "comisionesSatoshis" || fieldName === "comisionesCripto") {
            const value = parseLooseNumber(cell.textContent)

            if (hasText) {
                cell.textContent = formatCellSatoshisValue(value)
            }
        }

        updateAssetTableTotals()
    }
}

// ===== CUENTAS REMUNERADAS =====

let interesesModalKeyHandler = null
let _allCuentas = []         // [{ id, nombre, rows: [...] }]
let currentCuentaId = null
let _allInteresesRows = []   // referencia a la cuenta activa
let currentInteresesYear = null

function generateCuentaId() {
    return "cuenta-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function getCurrentCuenta() {
    return _allCuentas.find(c => c.id === currentCuentaId) || null
}

function syncRowsBackToCuenta() {
    const cuenta = getCurrentCuenta()
    if (cuenta) cuenta.rows = _allInteresesRows
}

// ----- Sidebar de cuentas -----

function renderCuentasSidebar() {
    const list = document.getElementById("cuentasList")
    if (!list) return
    list.innerHTML = ""

    _allCuentas.forEach(cuenta => {
        const item = document.createElement("div")
        item.className = `cuentaItem${cuenta.id === currentCuentaId ? " active" : ""}`
        item.dataset.cuentaId = cuenta.id
        item.innerHTML = `
            <span class="cuentaItemName" title="${escapeInteresesHtml(cuenta.nombre)}">${escapeInteresesHtml(cuenta.nombre)}</span>
            <div class="cuentaItemActions">
                <button type="button" class="cuentaItemRenameBtn" data-id="${cuenta.id}" title="Renombrar">✎</button>
                <button type="button" class="cuentaItemDeleteBtn" data-id="${cuenta.id}" title="Eliminar">✕</button>
            </div>
        `
        item.addEventListener("click", (e) => {
            if (e.target.closest(".cuentaItemRenameBtn") || e.target.closest(".cuentaItemDeleteBtn")) return
            selectCuenta(cuenta.id)
        })
        list.appendChild(item)
    })
}

function selectCuenta(id) {
    currentCuentaId = id
    currentInteresesYear = null
    const cuenta = getCurrentCuenta()
    _allInteresesRows = cuenta ? cuenta.rows : []
    renderCuentasSidebar()
    const years = getInteresesYears(_allInteresesRows)
    if (years.length) currentInteresesYear = years[years.length - 1]
    renderInteresesYearBar(years)
    renderFilteredIntereses()
}

function openInteresesErrorModal(message, error = null) {
    const existingOverlay = document.getElementById("interesesErrorModalOverlay")
    if (existingOverlay) existingOverlay.remove()

    const detail = error instanceof Error ? error.message : (error ? String(error) : "")
    const overlay = document.createElement("div")
    overlay.id = "interesesErrorModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "alertdialog")
    modal.innerHTML = `
        <h3 class="assetModalTitle" style="color:#f87171">Error</h3>
        <p style="color:#cbd5e1;margin:0 0 8px">${escapeInteresesHtml(message)}</p>
        ${detail ? `<p style="color:#64748b;font-size:11px;margin:0 0 12px;word-break:break-all">${escapeInteresesHtml(detail)}</p>` : ""}
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="primaryButton" id="interesesErrorCloseBtn" data-no-autohide="true">Aceptar</button>
        </div>
    `

    const close = () => overlay.remove()
    modal.querySelector("#interesesErrorCloseBtn").addEventListener("click", close)
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })
    document.addEventListener("keydown", function handler(e) {
        if (e.key === "Escape" || e.key === "Enter") { close(); document.removeEventListener("keydown", handler) }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    modal.querySelector("button")?.focus()
}

function openCuentaNameModal({ title, defaultValue = "", onConfirm }) {
    const existingOverlay = document.getElementById("cuentaNameModalOverlay")
    if (existingOverlay) existingOverlay.remove()

    const overlay = document.createElement("div")
    overlay.id = "cuentaNameModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${escapeInteresesHtml(title)}</h3>
        <label class="assetModalLabel" for="cuentaNameInput">Nombre</label>
        <input id="cuentaNameInput" class="assetModalInput" type="text" value="${escapeInteresesHtml(defaultValue)}" placeholder="Ej: ING, MyInvestor...">
        <p class="gastosCreateModalFeedback hidden" id="cuentaNameFeedback"></p>
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="cancelButton" id="cuentaNameCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="cuentaNameConfirmBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const close = () => overlay.remove()

    const doConfirm = () => {
        const nombre = modal.querySelector("#cuentaNameInput")?.value.trim()
        if (!nombre) {
            const fb = modal.querySelector("#cuentaNameFeedback")
            if (fb) { fb.textContent = "El nombre no puede estar vacío."; fb.classList.remove("hidden") }
            return
        }
        close()
        onConfirm(nombre)
    }

    modal.querySelector("#cuentaNameCancelBtn").addEventListener("click", close)
    modal.querySelector("#cuentaNameConfirmBtn").addEventListener("click", doConfirm)
    modal.querySelector("#cuentaNameInput").addEventListener("keydown", (e) => {
        if (e.key === "Enter") doConfirm()
        if (e.key === "Escape") close()
    })

    overlay.addEventListener("click", (e) => { if (e.target === overlay) close() })
    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    modal.querySelector("#cuentaNameInput")?.focus()
    modal.querySelector("#cuentaNameInput")?.select()
}

function addCuenta() {
    openCuentaNameModal({
        title: "Nueva cuenta remunerada",
        onConfirm: async (nombre) => {
            const newCuenta = { id: generateCuentaId(), nombre, rows: [] }
            _allCuentas.push(newCuenta)
            selectCuenta(newCuenta.id)
            try {
                await saveInteresesDataToServer()
            } catch (error) {
                console.error(error)
                openInteresesErrorModal("No se pudo guardar la nueva cuenta.", error)
            }
        }
    })
}

function renameCuenta(id) {
    const cuenta = _allCuentas.find(c => c.id === id)
    if (!cuenta) return
    openCuentaNameModal({
        title: "Renombrar cuenta",
        defaultValue: cuenta.nombre,
        onConfirm: async (nombre) => {
            if (nombre === cuenta.nombre) return
            cuenta.nombre = nombre
            renderCuentasSidebar()
            try {
                await saveInteresesDataToServer()
            } catch (error) {
                console.error(error)
                openInteresesErrorModal("No se pudo guardar el nombre.", error)
            }
        }
    })
}

function deleteCuenta(id) {
    const cuenta = _allCuentas.find(c => c.id === id)
    if (!cuenta) return

    openConfirmModal({
        title: "Eliminar cuenta",
        message: `¿Eliminar la cuenta "${cuenta.nombre}" y todos sus datos?`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                _allCuentas = _allCuentas.filter(c => c.id !== id)
                if (currentCuentaId === id) {
                    currentCuentaId = _allCuentas.length ? _allCuentas[0].id : null
                }
                const newCuenta = getCurrentCuenta()
                _allInteresesRows = newCuenta ? newCuenta.rows : []
                currentInteresesYear = null
                renderCuentasSidebar()
                const years = getInteresesYears(_allInteresesRows)
                if (years.length) currentInteresesYear = years[years.length - 1]
                renderInteresesYearBar(years)
                renderFilteredIntereses()
                await saveInteresesDataToServer()
            } catch (error) {
                console.error(error)
                openInteresesErrorModal("No se pudo eliminar la cuenta.", error)
            }
        }
    })
}

function bindCuentasSidebarActions() {
    const addBtn = document.getElementById("addCuentaBtn")
    if (addBtn && !addBtn.dataset.bound) {
        addBtn.dataset.bound = "true"
        addBtn.addEventListener("click", addCuenta)
    }

    const list = document.getElementById("cuentasList")
    if (list && !list.dataset.bound) {
        list.dataset.bound = "true"
        list.addEventListener("click", (e) => {
            const renameBtn = e.target.closest(".cuentaItemRenameBtn")
            if (renameBtn) { renameCuenta(renameBtn.dataset.id); return }

            const deleteBtn = e.target.closest(".cuentaItemDeleteBtn")
            if (deleteBtn) { deleteCuenta(deleteBtn.dataset.id); return }
        })
    }
}

// ----- Años -----

function parseInteresYear(fecha) {
    const p = String(fecha || "").split("-")
    if (p.length === 3) return p[2]   // dd-mm-yyyy
    if (p.length === 2) return p[1]   // mm-yyyy
    return null
}

function getInteresesYears(rows) {
    const years = new Set()
    rows.forEach(r => { const y = parseInteresYear(r.fecha); if (y) years.add(y) })
    return [...years].sort((a, b) => Number(a) - Number(b))
}

function renderInteresesYearBar(years) {
    const list = document.getElementById("interesesYearList")
    if (!list) return
    list.innerHTML = ""
    years.forEach(year => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `interesesYearBtn${year === currentInteresesYear ? " active" : ""}`
        btn.textContent = year
        btn.addEventListener("click", () => {
            currentInteresesYear = year
            renderFilteredIntereses()
        })
        list.appendChild(btn)
    })
}

function escapeInteresesHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

// ----- Modal añadir/editar fila -----

function closeInteresesModal() {
    document.getElementById("interesesModalOverlay")?.remove()

    if (interesesModalKeyHandler) {
        document.removeEventListener("keydown", interesesModalKeyHandler)
        interesesModalKeyHandler = null
    }
}

function openInteresesModal(globalIndex = -1, defaultFecha = "") {
    closeInteresesModal()

    const isEdit = globalIndex >= 0
    const rowData = isEdit ? { ..._allInteresesRows[globalIndex] } : {}
    if (!isEdit && defaultFecha) rowData.fecha = defaultFecha

    const overlay = document.createElement("div")
    overlay.id = "interesesModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal interesesCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar interés" : "Añadir interés"}</h3>
        <label class="assetModalLabel" for="interesFechaInput">Fecha</label>
        <input id="interesFechaInput" class="assetModalInput" type="text" value="${escapeInteresesHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="interesAcumuladoInput">Acumulado</label>
        <input id="interesAcumuladoInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeInteresesHtml(rowData.acumulado || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="interesImpuestosInput">Impuestos</label>
        <input id="interesImpuestosInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeInteresesHtml(rowData.impuestos || "")}" placeholder="0,00">
        <p class="gastosCreateModalFeedback hidden" id="interesesModalFeedback"></p>
        <div class="assetModalActions interesesModalActions">
            <button type="button" class="cancelButton" id="interesesModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="interesesModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const setFeedback = (message = "", isError = false) => {
        const node = modal.querySelector("#interesesModalFeedback")
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            // cerrar deshabilitado para evitar pérdida accidental
        }
    })

    modal.querySelector("#interesesModalCancelBtn")?.addEventListener("click", closeInteresesModal)
    modal.querySelector("#interesesModalSaveBtn")?.addEventListener("click", async () => {
        const fecha = modal.querySelector("#interesFechaInput")?.value.trim() || ""
        const acumuladoRaw = modal.querySelector("#interesAcumuladoInput")?.value.trim() || ""
        const impuestosRaw = modal.querySelector("#interesImpuestosInput")?.value.trim() || ""
        const acumulado = acumuladoRaw ? formatCellEuroValue(acumuladoRaw) : ""
        const impuestos = impuestosRaw ? formatCellEuroValue(impuestosRaw) : ""

        if (!fecha && !acumulado && !impuestos) {
            setFeedback("Introduce al menos un dato.", true)
            return
        }

        const nextRow = { fecha, acumulado, impuestos }

        if (isEdit) {
            _allInteresesRows[globalIndex] = nextRow
        } else {
            _allInteresesRows.push(nextRow)
            const newYear = parseInteresYear(fecha)
            if (newYear) currentInteresesYear = newYear
        }

        try {
            renderFilteredIntereses()
            await saveInteresesDataToServer()
            closeInteresesModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    interesesModalKeyHandler = (event) => {
        if (event.key === "Escape") closeInteresesModal()
    }
    document.addEventListener("keydown", interesesModalKeyHandler)

    modal.querySelector("input")?.focus()
}

// ----- Carga y render -----

async function loadInteresesData() {
    try {
        const response = await fetch("/api/intereses")

        if (!response.ok) {
            throw new Error("No se pudo cargar /api/intereses")
        }

        return await response.json()
    } catch (error) {
        console.error("Error cargando cuentas remuneradas desde el backend:", error)
        return { cuentas: [] }
    }
}

async function renderInteresesTable() {
    const interesesBody = document.getElementById("interesesBody")

    if (!interesesBody) {
        return
    }

    const data = await loadInteresesData()
    loadCuentasFromData(data)
}

function loadCuentasFromData(data) {
    _allCuentas = Array.isArray(data?.cuentas) ? data.cuentas : []

    if (!currentCuentaId && _allCuentas.length) {
        currentCuentaId = _allCuentas[0].id
    } else if (currentCuentaId && !_allCuentas.find(c => c.id === currentCuentaId)) {
        currentCuentaId = _allCuentas.length ? _allCuentas[0].id : null
    }

    const cuenta = getCurrentCuenta()
    _allInteresesRows = cuenta ? cuenta.rows : []

    renderCuentasSidebar()

    const years = getInteresesYears(_allInteresesRows)
    if (!currentInteresesYear && years.length) currentInteresesYear = years[years.length - 1]
    renderInteresesYearBar(years)
    renderFilteredIntereses()
}

// Compatibilidad con código existente que llama renderRowsFromData
function renderRowsFromData(interesesData) {
    if (interesesData?.cuentas) {
        loadCuentasFromData(interesesData)
        return
    }
    // Datos legacy { rows: [...] } — asignar a cuenta actual
    const rows = Array.isArray(interesesData?.rows) ? interesesData.rows : []
    _allInteresesRows = rows
    const cuenta = getCurrentCuenta()
    if (cuenta) cuenta.rows = rows

    const years = getInteresesYears(_allInteresesRows)
    if (!currentInteresesYear && years.length) currentInteresesYear = years[years.length - 1]
    renderInteresesYearBar(years)
    renderFilteredIntereses()
}

function renderFilteredIntereses() {
    const interesesBody = document.getElementById("interesesBody")
    if (!interesesBody) return

    const years = getInteresesYears(_allInteresesRows)
    renderInteresesYearBar(years)

    const visible = currentInteresesYear
        ? _allInteresesRows.map((r, i) => ({ r, i })).filter(({ r }) => parseInteresYear(r.fecha) === currentInteresesYear)
        : _allInteresesRows.map((r, i) => ({ r, i }))

    interesesBody.innerHTML = ""
    const interesesEmptyEl = document.getElementById("interesesEmptyMsg")
    const interesesTableWrapper = document.querySelector(".interesesTableWrapper")

    if (!visible.length) {
        if (interesesEmptyEl) interesesEmptyEl.classList.remove("hidden")
        if (interesesTableWrapper) interesesTableWrapper.classList.add("hidden")
        updateTotals()
        return
    }

    if (interesesEmptyEl) interesesEmptyEl.classList.add("hidden")
    if (interesesTableWrapper) interesesTableWrapper.classList.remove("hidden")

    visible.forEach(({ r: rowData, i: globalIndex }) => {
        const rowElement = document.createElement("tr")
        rowElement.innerHTML = `
            <td data-field="fecha">${rowData.fecha || ""}</td>
            <td data-field="acumulado">${formatCellEuroValue(rowData.acumulado)}</td>
            <td data-field="impuestos">${formatCellEuroValue(rowData.impuestos)}</td>
            <td class="rowTotal">0,00 €</td>
            <td class="rowActionsCell">
                <div class="rowActionsBtns">
                    <button type="button" class="assetRowEditBtn interesesRowEditBtn avActionBtn avEditBtn" data-global-index="${globalIndex}" title="Editar fila">✎</button>
                    <button type="button" class="assetRowDeleteBtn interesesRowDeleteBtn avActionBtn avDeleteBtn" data-global-index="${globalIndex}" title="Eliminar fila">🗑️</button>
                </div>
            </td>
        `
        interesesBody.appendChild(rowElement)
    })

    updateTotals()
}

// ----- Guardar -----

function collectInteresesDataFromTable() {
    syncRowsBackToCuenta()
    return { cuentas: _allCuentas }
}

async function saveInteresesDataToServer() {
    syncRowsBackToCuenta()
    const response = await fetch("/api/intereses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cuentas: _allCuentas })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

// ----- Totales -----

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
        const acumulado = parseEuroNumber(cells[1]?.textContent || "")
        const impuestos = parseEuroNumber(cells[2]?.textContent || "")
        const rowTotal = acumulado - impuestos

        if (cells[3]) {
            cells[3].textContent = formatEuro(rowTotal)
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

// ----- Acciones de fila -----

function addNewInteresesRow() {
    if (!currentCuentaId) {
        openInteresesErrorModal("Primero selecciona o crea una cuenta remunerada.")
        return
    }
    openInteresesModal()
}

function handleInteresesRowActionClick(event) {
    const editButton = event.target.closest(".interesesRowEditBtn")
    if (editButton) {
        openInteresesModal(Number(editButton.dataset.globalIndex))
        return
    }

    const deleteButton = event.target.closest(".interesesRowDeleteBtn")
    if (!deleteButton) return

    const globalIndex = Number(deleteButton.dataset.globalIndex)
    const row = _allInteresesRows[globalIndex]
    const isEmpty = !row || (!row.fecha && parseEuroNumber(row.acumulado || "") === 0 && parseEuroNumber(row.impuestos || "") === 0)

    const removeRow = async () => {
        _allInteresesRows.splice(globalIndex, 1)
        renderFilteredIntereses()
        await saveInteresesDataToServer()
    }

    if (isEmpty) {
        removeRow().catch((error) => {
            console.error(error)
            alert("No se pudo eliminar la fila.")
        })
        return
    }

    openConfirmModal({
        title: "Eliminar fila",
        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                await removeRow()
            } catch (error) {
                console.error(error)
                alert("No se pudo eliminar la fila.")
            }
        }
    })
}

function addInteresesYear() {
    openCuentaNameModal({
        title: "Añadir año",
        defaultValue: String(new Date().getFullYear()),
        onConfirm: (yearStr) => {
            if (!/^\d{4}$/.test(yearStr)) {
                openInteresesErrorModal("Año no válido. Introduce 4 dígitos (ej: 2027).")
                return
            }
            openInteresesModal(-1, `01-${yearStr}`)
        }
    })
}

function deleteCurrentInteresesYear() {
    if (!currentInteresesYear) return

    openConfirmModal({
        title: "Eliminar año",
        message: `¿Eliminar todas las filas del año ${currentInteresesYear}?`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                _allInteresesRows = _allInteresesRows.filter(r => parseInteresYear(r.fecha) !== currentInteresesYear)
                syncRowsBackToCuenta()
                const remaining = getInteresesYears(_allInteresesRows)
                currentInteresesYear = remaining.length ? remaining[remaining.length - 1] : null
                renderInteresesYearBar(remaining)
                renderFilteredIntereses()
                await saveInteresesDataToServer()
            } catch (error) {
                console.error(error)
                openInteresesErrorModal("No se pudo eliminar el año.", error)
            }
        }
    })
}

// ----- Import / Export -----

function exportInteresesJson() {
    const data = collectInteresesDataFromTable()
    const dataString = JSON.stringify(data, null, 2)
    const dataBlob = new Blob([dataString], { type: "application/json" })
    const dataUrl = URL.createObjectURL(dataBlob)
    const downloadLink = document.createElement("a")

    downloadLink.href = dataUrl
    downloadLink.download = "cuentas-remuneradas.json"
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

            if (!parsedData || !Array.isArray(parsedData.cuentas)) {
                openInteresesErrorModal('El JSON no tiene el formato esperado. Debe contener { cuentas: [...] }')
                return
            }

            loadCuentasFromData(parsedData)
            await saveInteresesDataToServer()
        } catch (error) {
            console.error(error)
            openInteresesErrorModal("No se pudo importar el JSON.", error)
        }
    })

    inputFile.click()
}
