// ===== CUENTAS REMUNERADAS =====
// Una cuenta remunerada es siempre una cuenta de la ventana «Cuentas»: se elige
// una que ya existe, se llama como ella y sus intereses entran en su saldo.

let interesesModalKeyHandler = null
let _allCuentas = [] // [{ id, nombre, cuenta, rows: [...] }]; `cuenta` = id en «Cuentas»
let currentCuentaId = null
let _allInteresesRows = [] // referencia a la cuenta activa
let currentInteresesYear = null

function generateCuentaId() {
    return "cuenta-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function getCurrentCuenta() {
    return _allCuentas.find((c) => c.id === currentCuentaId) || null
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

    _allCuentas.forEach((cuenta) => {
        const item = document.createElement("div")
        item.className = `cuentaItem${cuenta.id === currentCuentaId ? " active" : ""}`
        item.dataset.cuentaId = cuenta.id
        // Las de antes de que tuvieran que ser una cuenta pueden no tenerla todavía.
        const sinCuenta = !cuenta.cuenta
        const titulo = sinCuenta ? `${cuenta.nombre} · sin cuenta: elígela con ✎` : cuenta.nombre
        item.innerHTML = `
            <span class="cuentaItemName" title="${escapeInteresesHtml(titulo)}">${escapeInteresesHtml(cuenta.nombre)}${sinCuenta ? " ⚠" : ""}</span>
            <div class="cuentaItemActions">
                <button type="button" class="cuentaItemRenameBtn" data-id="${cuenta.id}" title="Cambiar de cuenta">✎</button>
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

    const detail = error instanceof Error ? error.message : error ? String(error) : ""
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
    document.addEventListener("keydown", function handler(e) {
        if (e.key === "Escape" || e.key === "Enter") {
            close()
            document.removeEventListener("keydown", handler)
        }
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
            if (fb) {
                fb.textContent = "El nombre no puede estar vacío."
                fb.classList.remove("hidden")
            }
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

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
    modal.querySelector("#cuentaNameInput")?.focus()
    modal.querySelector("#cuentaNameInput")?.select()
}

// Elegir la cuenta de «Cuentas» que es (o pasa a ser) remunerada. Solo se
// ofrecen las que no lo son ya, más la actual.
async function openCuentaRemuneradaPicker({ title, actual = null, onConfirm }) {
    let cuentas = []
    try {
        const data = await Api.get("/api/cuentas")
        cuentas = Array.isArray(data?.cuentas) ? data.cuentas : []
    } catch (error) {
        openInteresesErrorModal("No se pudieron cargar las cuentas.", error)
        return
    }

    const libres = cuentas.filter((c) => !c.remunerada || c.remunerada === actual?.id)
    const opciones = libres
        .map(
            (c) =>
                `<option value="${escapeInteresesHtml(c.id)}"${c.id === actual?.cuenta ? " selected" : ""}>${escapeInteresesHtml(c.nombre)}</option>`
        )
        .join("")

    openGastosCreateModal({
        title,
        bodyHtml: libres.length
            ? `
            <label class="assetModalLabel" for="cuentaRemuneradaSelect">Cuenta</label>
            <select id="cuentaRemuneradaSelect" class="assetModalSelect">${opciones}</select>
            <p class="cuentasHint">Una de tus cuentas de Finanzas › Cuentas. Sus intereses se suman a su saldo. Para una cuenta nueva, créala antes allí.</p>`
            : `<p class="cuentasHint">Todas tus cuentas son ya remuneradas. Crea otra en Finanzas › Cuentas.</p>`,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const elegida = libres.find((c) => c.id === getValue("cuentaRemuneradaSelect"))
            if (!elegida) {
                setFeedback("Elige una cuenta.", true)
                return false
            }
            try {
                await onConfirm(elegida)
                return true
            } catch (error) {
                setFeedback(error?.message || "No se pudo guardar.", true)
                return false
            }
        }
    })
}

function addCuenta() {
    openCuentaRemuneradaPicker({
        title: "Nueva cuenta remunerada",
        onConfirm: async (elegida) => {
            const newCuenta = { id: generateCuentaId(), nombre: elegida.nombre, cuenta: elegida.id, rows: [] }
            _allCuentas.push(newCuenta)
            try {
                await saveInteresesDataToServer()
            } catch (error) {
                _allCuentas = _allCuentas.filter((c) => c !== newCuenta)
                throw error
            }
            selectCuenta(newCuenta.id)
        }
    })
}

// El nombre es el de la cuenta: «renombrar» es cambiarla por otra (o elegirla,
// si es de las antiguas que no tenían).
function renameCuenta(id) {
    const cuenta = _allCuentas.find((c) => c.id === id)
    if (!cuenta) return
    openCuentaRemuneradaPicker({
        title: `Cuenta de «${cuenta.nombre}»`,
        actual: cuenta,
        onConfirm: async (elegida) => {
            const antes = { nombre: cuenta.nombre, cuenta: cuenta.cuenta }
            cuenta.nombre = elegida.nombre
            cuenta.cuenta = elegida.id
            try {
                await saveInteresesDataToServer()
            } catch (error) {
                Object.assign(cuenta, antes)
                throw error
            }
            renderCuentasSidebar()
        }
    })
}

function deleteCuenta(id) {
    const cuenta = _allCuentas.find((c) => c.id === id)
    if (!cuenta) return

    openConfirmModal({
        title: "Eliminar cuenta",
        message: `Vas a quitar «${cuenta.nombre}» de las cuentas remuneradas y borrar todos sus intereses. La cuenta sigue en Cuentas. Esto no se puede deshacer.`,
        confirmLabel: "Eliminar",
        requireText: cuenta.nombre,
        onConfirm: async () => {
            try {
                _allCuentas = _allCuentas.filter((c) => c.id !== id)
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
        addBtn.addEventListener("click", () => {
            if (typeof closeInteresesMenu === "function") closeInteresesMenu()
            addCuenta()
        })
    }

    const list = document.getElementById("cuentasList")
    if (list && !list.dataset.bound) {
        list.dataset.bound = "true"
        list.addEventListener("click", (e) => {
            const renameBtn = e.target.closest(".cuentaItemRenameBtn")
            if (renameBtn) {
                renameCuenta(renameBtn.dataset.id)
                return
            }

            const deleteBtn = e.target.closest(".cuentaItemDeleteBtn")
            if (deleteBtn) {
                deleteCuenta(deleteBtn.dataset.id)
                return
            }
        })
    }
}

// ----- Años -----

function parseInteresYear(fecha) {
    const p = String(fecha || "").split("-")
    if (p.length === 3) return p[2] // dd-mm-yyyy
    if (p.length === 2) return p[1] // mm-yyyy
    return null
}

function getInteresesYears(rows) {
    const years = new Set()
    rows.forEach((r) => {
        const y = parseInteresYear(r.fecha)
        if (y) years.add(y)
    })
    return [...years].sort((a, b) => Number(a) - Number(b))
}

function renderInteresesYearBar(years) {
    const list = document.getElementById("interesesYearList")
    if (!list) return
    list.innerHTML = ""
    years.forEach((year) => {
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
    // Alias del escapeHtml común (js/core/dom.js). Había una copia por
    // módulo y no todas escapaban las comillas, que es lo que importa en
    // un atributo value="…".
    return escapeHtml(value)
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
    } else if (currentCuentaId && !_allCuentas.find((c) => c.id === currentCuentaId)) {
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
        ? _allInteresesRows
              .map((r, i) => ({ r, i }))
              .filter(({ r }) => parseInteresYear(r.fecha) === currentInteresesYear)
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
            <td data-field="fecha">${escapeHtml(rowData.fecha || "")}</td>
            <td data-field="acumulado">${formatCellEuroValue(rowData.acumulado)}</td>
            <td data-field="impuestos">${formatCellEuroValue(rowData.impuestos)}</td>
            <td class="rowTotal">0,00 €</td>
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem assetRowEditBtn interesesRowEditBtn avActionBtn avEditBtn" data-global-index="${globalIndex}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn interesesRowDeleteBtn avActionBtn avDeleteBtn" data-global-index="${globalIndex}">Eliminar</button>
                    </div>
                </div>
            </td>
        `
        interesesBody.appendChild(rowElement)
    })

    updateTotals()
}

// ----- Guardar -----

async function saveInteresesDataToServer() {
    syncRowsBackToCuenta()
    const response = await fetch("/api/intereses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cuentas: _allCuentas })
    })

    if (!response.ok) {
        const errorText = await response.text()
        let mensaje = `HTTP ${response.status}: ${errorText}`
        try {
            mensaje = JSON.parse(errorText)?.error || mensaje
        } catch {
            // No era JSON: se queda el texto tal cual.
        }
        throw new Error(mensaje)
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
    const isEmpty =
        !row || (!row.fecha && parseEuroNumber(row.acumulado || "") === 0 && parseEuroNumber(row.impuestos || "") === 0)

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
        message: `Vas a eliminar todas las filas del año ${currentInteresesYear}. Esto no se puede deshacer.`,
        confirmLabel: "Eliminar",
        requireText: String(currentInteresesYear),
        onConfirm: async () => {
            try {
                _allInteresesRows = _allInteresesRows.filter((r) => parseInteresYear(r.fecha) !== currentInteresesYear)
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
