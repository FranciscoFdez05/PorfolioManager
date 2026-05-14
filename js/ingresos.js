const INGRESOS_MONTHS = [
    { key: "enero", label: "Enero" },
    { key: "febrero", label: "Febrero" },
    { key: "marzo", label: "Marzo" },
    { key: "abril", label: "Abril" },
    { key: "mayo", label: "Mayo" },
    { key: "junio", label: "Junio" },
    { key: "julio", label: "Julio" },
    { key: "agosto", label: "Agosto" },
    { key: "septiembre", label: "Septiembre" },
    { key: "octubre", label: "Octubre" },
    { key: "noviembre", label: "Noviembre" },
    { key: "diciembre", label: "Diciembre" }
]

let ingresosYears = []
let currentIngresosYear = null
let currentIngresosMonth = "enero"
let currentIngresosData = null
let currentIngresosView = "year"
let ingresosAutosaveTimeout = null
let ingresosPersistenceBound = false
let sharedIngresosTypes = []
let _ingresosDataLoaded = false
let ingresosModalKeyHandler = null

function sanitizeIngresoTypeLabel(value) {
    return String(value || "").trim().replace(/\s+/g, " ")
}

function normalizeComparableIngresoText(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
}

function escapeIngresosHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function ensureIngresosDataShape(data) {
    if (!data || typeof data !== "object") {
        return data
    }

    const mergedTypes = []
    const pushMergedType = (value) => {
        const label = sanitizeIngresoTypeLabel(value)
        if (!label) return
        if (mergedTypes.some((type) => normalizeComparableIngresoText(type) === normalizeComparableIngresoText(label))) return
        mergedTypes.push(label)
    }

    ;(Array.isArray(data.ingresosTipos) ? data.ingresosTipos : []).forEach(pushMergedType)

    Object.values(data.months || {}).forEach((monthData) => {
        ;(monthData?.rows || []).forEach((row) => pushMergedType(row?.tipo || ""))
    })

    data.ingresosTipos = mergedTypes
    return data
}

function getAvailableIngresosTypes() {
    return Array.isArray(sharedIngresosTypes) ? sharedIngresosTypes : []
}

function closeIngresosCreateModal() {
    document.getElementById("ingresosCreateModalOverlay")?.remove()
    if (ingresosModalKeyHandler) {
        document.removeEventListener("keydown", ingresosModalKeyHandler)
        ingresosModalKeyHandler = null
    }
}

function openIngresosCreateModal({ title, bodyHtml, onSubmit, submitLabel = "Guardar", modalClass = "" }) {
    closeIngresosCreateModal()

    const overlay = document.createElement("div")
    overlay.id = "ingresosCreateModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = `assetModal ingresosCreateModal${modalClass ? ` ${modalClass}` : ""}`
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.setAttribute("aria-labelledby", "ingresosCreateModalTitle")

    modal.innerHTML = `
        <h3 class="assetModalTitle" id="ingresosCreateModalTitle">${escapeIngresosHtml(title)}</h3>
        <div class="ingresosCreateModalBody">${bodyHtml}</div>
        <p class="ingresosCreateModalFeedback hidden" id="ingresosCreateModalFeedback"></p>
        <div class="assetModalActions ingresosCreateModalActions">
            <button type="button" class="cancelButton" id="ingresosCreateModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="ingresosCreateModalSaveBtn" data-no-autohide="true">${escapeIngresosHtml(submitLabel)}</button>
        </div>
    `

    const setFeedback = (message = "", isError = false) => {
        const feedback = modal.querySelector("#ingresosCreateModalFeedback")
        if (!feedback) return
        feedback.textContent = message
        feedback.classList.toggle("hidden", !message)
        feedback.classList.toggle("error", Boolean(message && isError))
    }

    modal.querySelector("#ingresosCreateModalCancelBtn")?.addEventListener("click", closeIngresosCreateModal)
    modal.querySelector("#ingresosCreateModalSaveBtn")?.addEventListener("click", async () => {
        const getValue = (id) => modal.querySelector(`#${id}`)?.value ?? ""
        try {
            const shouldClose = await onSubmit({ getValue, setFeedback, modal })
            if (shouldClose !== false) closeIngresosCreateModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    ingresosModalKeyHandler = (event) => {
        if (event.key === "Escape") closeIngresosCreateModal()
    }
    document.addEventListener("keydown", ingresosModalKeyHandler)
    modal.querySelector("input, select")?.focus()
}

function openIngresoTypeModal() {
    openIngresosCreateModal({
        title: "Añadir ingreso",
        bodyHtml: `
            <label class="assetModalLabel" for="ingresosTipoModalInput">Nombre del ingreso</label>
            <input id="ingresosTipoModalInput" class="assetModalInput" type="text" placeholder="Ej: Salario o Freelance">
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const label = sanitizeIngresoTypeLabel(getValue("ingresosTipoModalInput"))
            if (!label) {
                setFeedback("Introduce un nombre para el ingreso.", true)
                return false
            }
            syncIngresosDataFromTables()
            sharedIngresosTypes.push(label)
            sharedIngresosTypes = dedupeIngresosTypes(sharedIngresosTypes)
            await persistSharedIngresosTypes()
            renderCurrentIngresosView()
            return true
        }
    })
}

function openRecurrenteModal() {
    const monthsHtml = INGRESOS_MONTHS.map((month) => `
        <div class="ingresosCreateModalField">
            <label class="assetModalLabel" for="ingresosRecurrente-${month.key}">${month.label}</label>
            <input id="ingresosRecurrente-${month.key}" class="assetModalInput" type="text" inputmode="decimal" placeholder="0,00">
        </div>
    `).join("")

    openIngresosCreateModal({
        title: "Añadir recurrente",
        modalClass: "ingresosCreateModalWide",
        bodyHtml: `
            <div class="ingresosCreateModalField">
                <label class="assetModalLabel" for="ingresosRecurrenteNombre">Nombre</label>
                <input id="ingresosRecurrenteNombre" class="assetModalInput" type="text" placeholder="Ej: Salario, Alquiler cobrado">
            </div>
            <div class="ingresosCreateModalGrid ingresosCreateModalGridMonths">
                ${monthsHtml}
            </div>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const nombreRaw = sanitizeIngresoTypeLabel(getValue("ingresosRecurrenteNombre"))
            const nombre = nombreRaw || "Recurrente"
            const meses = Object.fromEntries(
                INGRESOS_MONTHS.map((month) => {
                    const rawValue = String(getValue(`ingresosRecurrente-${month.key}`)).trim()
                    return [month.key, rawValue ? formatCellEuroValue(rawValue) : ""]
                })
            )
            const hasAnyAmount = INGRESOS_MONTHS.some((month) => parseEuroNumber(meses[month.key]) !== 0)
            if (!nombreRaw && !hasAnyAmount) {
                setFeedback("Introduce al menos un dato para el recurrente.", true)
                return false
            }
            syncIngresosDataFromTables()
            currentIngresosData.recurrentes.push({ nombre, meses })
            renderCurrentIngresosView()
            await persistCurrentIngresosData()
            return true
        }
    })
}

function openIngresoMovementModal(rowIndex = -1) {
    const currentRows = currentIngresosData?.months?.[currentIngresosMonth]?.rows || []
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...currentRows[rowIndex] } : {}
    const availableTypes = getAvailableIngresosTypes()
    const typeOptions = availableTypes
        .map((type) => {
            const isSelected = normalizeComparableIngresoText(rowData.tipo || "") === normalizeComparableIngresoText(type)
            return `<option value="${escapeIngresosHtml(type)}"${isSelected ? " selected" : ""}>${escapeIngresosHtml(type)}</option>`
        })
        .join("")

    openIngresosCreateModal({
        title: isEdit ? "Editar ingreso" : "Añadir ingreso",
        bodyHtml: `
            <label class="assetModalLabel" for="ingresosMovimientoFecha">Fecha</label>
            <input id="ingresosMovimientoFecha" class="assetModalInput" type="text" value="${escapeIngresosHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">

            <label class="assetModalLabel" for="ingresosMovimientoNombre">Nombre</label>
            <input id="ingresosMovimientoNombre" class="assetModalInput" type="text" value="${escapeIngresosHtml(rowData.nombre || "")}" placeholder="Ej: Regalo Cumpleaños">

            <label class="assetModalLabel" for="ingresosMovimientoTipo">Tipo</label>
            <select id="ingresosMovimientoTipo" class="assetModalSelect">
                <option value=""></option>
                ${typeOptions}
            </select>

            <label class="assetModalLabel" for="ingresosMovimientoCantidad">Cantidad</label>
            <input id="ingresosMovimientoCantidad" class="assetModalInput" type="text" inputmode="decimal" value="${escapeIngresosHtml(rowData.cantidad || "")}" placeholder="0,00">
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const fecha = String(getValue("ingresosMovimientoFecha")).trim()
            const nombre = String(getValue("ingresosMovimientoNombre")).trim()
            const tipo = normalizeIngresoTipo(getValue("ingresosMovimientoTipo"))
            const cantidadRaw = String(getValue("ingresosMovimientoCantidad")).trim()
            const cantidad = cantidadRaw ? formatCellEuroValue(cantidadRaw) : ""

            if (!fecha && !nombre && !tipo && !cantidad) {
                setFeedback("Introduce al menos un dato para el ingreso.", true)
                return false
            }

            syncIngresosDataFromTables()
            if (!currentIngresosData.months[currentIngresosMonth]) {
                currentIngresosData.months[currentIngresosMonth] = { rows: [] }
            }

            const nextRow = { fecha, nombre, tipo, cantidad }

            if (isEdit && currentIngresosData.months[currentIngresosMonth].rows[rowIndex]) {
                currentIngresosData.months[currentIngresosMonth].rows[rowIndex] = nextRow
            } else {
                currentIngresosData.months[currentIngresosMonth].rows.push(nextRow)
            }

            renderCurrentIngresosView()
            await persistCurrentIngresosData()
            return true
        }
    })
}

async function loadIngresosYears() {
    const response = await fetch("/api/ingresos")
    if (!response.ok) throw new Error("No se pudo cargar la lista de años de ingresos")
    const data = await response.json()
    return Array.isArray(data.years) ? data.years : []
}

async function loadIngresosYear(year) {
    const response = await fetch(`/api/ingresos/${year}`)
    if (!response.ok) throw new Error("No se pudo cargar el año de ingresos")
    return await response.json()
}

async function loadSharedIngresosTypes() {
    const response = await fetch("/api/ingresos-tipos")
    if (!response.ok) throw new Error("No se pudo cargar la lista global de tipos de ingreso")
    const data = await response.json()
    return Array.isArray(data.types) ? data.types : []
}

async function saveSharedIngresosTypes(types) {
    const response = await fetch("/api/ingresos-tipos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ types })
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
    const data = await response.json()
    return Array.isArray(data.types) ? data.types : []
}

async function createIngresosYear(year) {
    const response = await fetch("/api/ingresos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ year })
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
    return await response.json()
}

async function saveIngresosYear(year, payload, options = {}) {
    const response = await fetch(`/api/ingresos/${year}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: Boolean(options.keepalive)
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

async function deleteIngresosYearRequest(year) {
    const response = await fetch(`/api/ingresos/${year}`, { method: "DELETE" })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
    return await response.json()
}

async function initIngresosLogic() {
    ingresosYears = await loadIngresosYears()
    sharedIngresosTypes = await loadSharedIngresosTypes()
    currentIngresosYear = ingresosYears[0] || "2026"
    currentIngresosMonth = "enero"
    currentIngresosView = "year"
    bindIngresosPersistenceGuards()
    window.flushPendingPageChanges = flushIngresosPendingChanges
    await renderIngresosYear(currentIngresosYear)
    bindIngresosEvents()

    const annualBody = document.getElementById("ingresosAnnualBody")
    const movementsBody = document.getElementById("ingresosMovementsBody")

    if (annualBody && !annualBody.dataset.bound) {
        annualBody.dataset.bound = "true"
        annualBody.addEventListener("click", handleIngresosAnnualDeleteClick)
        annualBody.addEventListener("click", handleIngresosAnnualEditClick)
        annualBody.addEventListener("blur", handleIngresosAnnualBlur, true)
    }

    if (movementsBody && !movementsBody.dataset.bound) {
        movementsBody.dataset.bound = "true"
        movementsBody.addEventListener("click", handleIngresosMovementActionClick)
    }

    const ingresosMovementsTable = document.querySelector(".ingresosMovementsTable")
    if (ingresosMovementsTable) bindTableSort(ingresosMovementsTable, "ingresos")
}

function bindIngresosEvents() {
    const addYearButton = document.getElementById("addIngresosYearBtn")
    const deleteYearButton = document.getElementById("deleteIngresosYearBtn")
    const addRowButton = document.getElementById("addIngresoRowBtn")
    const addRecurrenteRowButton = document.getElementById("addRecurrenteRowBtn")
    const addIngresoTypeRowButton = document.getElementById("addIngresoTypeRowBtn")

    if (addYearButton && !addYearButton.dataset.bound) {
        addYearButton.dataset.bound = "true"
        addYearButton.addEventListener("click", async () => {
            const suggestedYear = String(new Date().getFullYear())
            const year = prompt("Escribe el nuevo año (YYYY)", suggestedYear)?.trim()
            if (!year) return
            try {
                await persistCurrentIngresosData()
                await createIngresosYear(year)
                ingresosYears = await loadIngresosYears()
                currentIngresosYear = year
                await renderIngresosYear(year)
            } catch (error) {
                console.error(error)
                alert("No se pudo crear el año.")
            }
        })
    }

    if (deleteYearButton && !deleteYearButton.dataset.bound) {
        deleteYearButton.dataset.bound = "true"
        deleteYearButton.addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar año",
                message: `Vas a eliminar el año ${currentIngresosYear}. ¿Quieres continuar?`,
                confirmLabel: "Eliminar",
                confirmSide: "right",
                onConfirm: async () => {
                    openConfirmModal({
                        title: "Segunda verificación",
                        message: `Esta acción borrará definitivamente el año ${currentIngresosYear}. ¿Confirmas que quieres eliminarlo?`,
                        confirmLabel: "Eliminar",
                        confirmSide: "left",
                        onConfirm: async () => {
                            const response = await deleteIngresosYearRequest(currentIngresosYear)
                            ingresosYears = Array.isArray(response.years) ? response.years : await loadIngresosYears()
                            currentIngresosYear = ingresosYears[0]
                            currentIngresosView = "year"
                            currentIngresosMonth = "enero"
                            await renderIngresosYear(currentIngresosYear)
                        }
                    })
                }
            })
        })
    }

    const sortByDateButton = document.getElementById("sortIngresosByDateBtn")
    if (sortByDateButton && !sortByDateButton.dataset.bound) {
        sortByDateButton.dataset.bound = "true"
        sortByDateButton.addEventListener("click", sortIngresosByDate)
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => openIngresoMovementModal())
    }

    if (addRecurrenteRowButton && !addRecurrenteRowButton.dataset.bound) {
        addRecurrenteRowButton.dataset.bound = "true"
        addRecurrenteRowButton.addEventListener("click", () => openRecurrenteModal())
    }

    if (addIngresoTypeRowButton && !addIngresoTypeRowButton.dataset.bound) {
        addIngresoTypeRowButton.dataset.bound = "true"
        addIngresoTypeRowButton.addEventListener("click", () => openIngresoTypeModal())
    }
}

async function renderIngresosYear(year) {
    _ingresosDataLoaded = false
    currentIngresosData = ensureIngresosDataShape(await loadIngresosYear(year))
    currentIngresosYear = currentIngresosData.year
    _ingresosDataLoaded = true
    renderIngresosYearButtons()
    renderIngresosMonthTabs()
    renderCurrentIngresosView()
}

function renderIngresosYearButtons() {
    const list = document.getElementById("ingresosYearList")
    if (!list) return
    list.innerHTML = ""
    ingresosYears.forEach((year) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `ingresosYearBtn${year === currentIngresosYear ? " active" : ""}${year === currentIngresosYear && currentIngresosView === "year" ? " yearViewActive" : ""}`
        button.textContent = year
        button.addEventListener("click", async () => {
            await persistCurrentIngresosData()
            currentIngresosYear = year
            currentIngresosView = "year"
            await renderIngresosYear(year)
        })
        list.appendChild(button)
    })
}

function buildMonthlyIncomeTotals() {
    const totals = {}
    const availableTypes = getAvailableIngresosTypes()
    availableTypes.forEach((type) => {
        totals[type] = {}
        INGRESOS_MONTHS.forEach((month) => { totals[type][month.key] = 0 })
    })
    INGRESOS_MONTHS.forEach((month) => {
        const rows = currentIngresosData?.months?.[month.key]?.rows || []
        rows.forEach((row) => {
            const type = String(row.tipo || "").trim()
            if (!availableTypes.includes(type)) return
            totals[type][month.key] += parseEuroNumber(row.cantidad || "")
        })
    })
    return totals
}

function renderIngresosAnnualTable() {
    const annualBody = document.getElementById("ingresosAnnualBody")
    const yearLabel = document.getElementById("ingresosAnnualYearLabel")
    if (!annualBody || !yearLabel || !currentIngresosData) return

    yearLabel.textContent = currentIngresosData.year
    annualBody.innerHTML = ""

    const incomeTotals = buildMonthlyIncomeTotals()
    const availableTypes = getAvailableIngresosTypes()

    const recurrentesRow = document.createElement("tr")
    recurrentesRow.className = "ingresosSectionRow"
    recurrentesRow.innerHTML = `<td colspan="14">Recurrentes</td>`
    annualBody.appendChild(recurrentesRow)

    currentIngresosData.recurrentes.forEach((row, rowIndex) => {
        const tr = document.createElement("tr")
        tr.innerHTML = `
            <td>${escapeIngresosHtml(row.nombre || "")}</td>
            ${INGRESOS_MONTHS.map((month) => `
                <td>${formatCellEuroValue(row.meses?.[month.key] || "")}</td>
            `).join("")}
            <td class="rowActionsCell">
                <div class="rowActionsBtns">
                    <button type="button" class="assetRowEditBtn ingresosAnnualEditBtn avActionBtn avEditBtn" data-annual-edit-manual="${rowIndex}" title="Editar recurrente">✎</button>
                    <button type="button" class="assetRowDeleteBtn avActionBtn avDeleteBtn" data-ingresos-delete-manual-row="${rowIndex}" title="Eliminar recurrente">🗑️</button>
                </div>
            </td>
        `
        annualBody.appendChild(tr)
    })

    const recurrentesTotalRow = document.createElement("tr")
    recurrentesTotalRow.className = "ingresosTotalRow"
    recurrentesTotalRow.innerHTML = `
        <td>Total</td>
        ${INGRESOS_MONTHS.map((month) => {
            const total = currentIngresosData.recurrentes.reduce((sum, row) => sum + parseEuroNumber(row.meses?.[month.key] || ""), 0)
            return `<td>${formatEuro(total)}</td>`
        }).join("")}
        <td></td>
    `
    annualBody.appendChild(recurrentesTotalRow)

    const ingresosRow = document.createElement("tr")
    ingresosRow.className = "ingresosSectionRow"
    ingresosRow.innerHTML = `<td colspan="14">Ingresos</td>`
    annualBody.appendChild(ingresosRow)

    availableTypes.forEach((type, rowIndex) => {
        const tr = document.createElement("tr")
        tr.innerHTML = `
            <td>${escapeIngresosHtml(type)}</td>
            ${INGRESOS_MONTHS.map((month) => `<td>${incomeTotals[type][month.key] ? formatEuro(incomeTotals[type][month.key]) : "- €"}</td>`).join("")}
            <td class="rowActionsCell">
                <div class="rowActionsBtns">
                    <button type="button" class="assetRowEditBtn ingresosAnnualEditBtn avActionBtn avEditBtn" data-annual-edit-type="${rowIndex}" title="Editar ingreso">✎</button>
                    <button type="button" class="assetRowDeleteBtn avActionBtn avDeleteBtn" data-ingresos-delete-type-row="${rowIndex}" title="Eliminar ingreso">🗑️</button>
                </div>
            </td>
        `
        annualBody.appendChild(tr)
    })

    const ingresosTotalRow = document.createElement("tr")
    ingresosTotalRow.className = "ingresosTotalRow"
    ingresosTotalRow.innerHTML = `
        <td>Total</td>
        ${INGRESOS_MONTHS.map((month) => {
            const total = availableTypes.reduce((sum, type) => sum + incomeTotals[type][month.key], 0)
            return `<td>${total ? formatEuro(total) : "- €"}</td>`
        }).join("")}
        <td></td>
    `
    annualBody.appendChild(ingresosTotalRow)

    const grandTotalRow = document.createElement("tr")
    grandTotalRow.className = "ingresosTotalRow"
    grandTotalRow.innerHTML = `
        <td>TOTAL</td>
        ${INGRESOS_MONTHS.map((month) => {
            const totalRecurrentes = currentIngresosData.recurrentes.reduce((sum, row) => sum + parseEuroNumber(row.meses?.[month.key] || ""), 0)
            const totalIngresos = availableTypes.reduce((sum, type) => sum + incomeTotals[type][month.key], 0)
            return `<td>${formatEuro(totalRecurrentes + totalIngresos)}</td>`
        }).join("")}
        <td></td>
    `
    annualBody.appendChild(grandTotalRow)
}

function openRecurrenteEditModal(rowIndex) {
    const row = currentIngresosData?.recurrentes?.[rowIndex]
    if (!row) return

    const monthsHtml = INGRESOS_MONTHS.map((month) => `
        <div class="ingresosCreateModalField">
            <label class="assetModalLabel" for="ingresosRecurrente-${month.key}">${month.label}</label>
            <input id="ingresosRecurrente-${month.key}" class="assetModalInput" type="text" inputmode="decimal" value="${escapeIngresosHtml(row.meses?.[month.key] || "")}" placeholder="0,00">
        </div>
    `).join("")

    openIngresosCreateModal({
        title: "Editar recurrente",
        modalClass: "ingresosCreateModalWide",
        bodyHtml: `
            <div class="ingresosCreateModalField">
                <label class="assetModalLabel" for="ingresosRecurrenteNombre">Nombre</label>
                <input id="ingresosRecurrenteNombre" class="assetModalInput" type="text" value="${escapeIngresosHtml(row.nombre || "")}" placeholder="Ej: Salario">
            </div>
            <div class="ingresosCreateModalGrid ingresosCreateModalGridMonths">
                ${monthsHtml}
            </div>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue }) => {
            const nombreRaw = sanitizeIngresoTypeLabel(getValue("ingresosRecurrenteNombre"))
            const nombre = nombreRaw || row.nombre || "Recurrente"
            const meses = Object.fromEntries(
                INGRESOS_MONTHS.map((month) => {
                    const rawValue = String(getValue(`ingresosRecurrente-${month.key}`)).trim()
                    return [month.key, rawValue ? formatCellEuroValue(rawValue) : ""]
                })
            )
            currentIngresosData.recurrentes[rowIndex] = { nombre, meses }
            renderCurrentIngresosView()
            await persistCurrentIngresosData()
            return true
        }
    })
}

function openIngresoTypeRenameModal(rowIndex) {
    const currentName = sharedIngresosTypes?.[rowIndex]
    if (!currentName) return

    openIngresosCreateModal({
        title: "Renombrar ingreso",
        bodyHtml: `
            <label class="assetModalLabel" for="ingresosTipoModalInput">Nombre del ingreso</label>
            <input id="ingresosTipoModalInput" class="assetModalInput" type="text" value="${escapeIngresosHtml(currentName)}" placeholder="Ej: Salario">
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const label = sanitizeIngresoTypeLabel(getValue("ingresosTipoModalInput"))
            if (!label) {
                setFeedback("Introduce un nombre para el ingreso.", true)
                return false
            }
            const normalizedNew = normalizeComparableIngresoText(label)
            const normalizedCurrent = normalizeComparableIngresoText(currentName)
            const isDuplicate = sharedIngresosTypes.some((type, idx) =>
                idx !== rowIndex && normalizeComparableIngresoText(type) === normalizedNew
            )
            if (isDuplicate) {
                setFeedback("Ya existe un ingreso con ese nombre.", true)
                return false
            }
            if (normalizedNew !== normalizedCurrent) {
                Object.values(currentIngresosData.months || {}).forEach((monthData) => {
                    ;(monthData?.rows || []).forEach((row) => {
                        if (normalizeComparableIngresoText(row?.tipo || "") === normalizedCurrent) {
                            row.tipo = label
                        }
                    })
                })
            }
            sharedIngresosTypes[rowIndex] = label
            if (currentIngresosData) currentIngresosData.ingresosTipos = [...sharedIngresosTypes]
            await persistSharedIngresosTypes()
            renderCurrentIngresosView()
            await persistCurrentIngresosData()
            return true
        }
    })
}

function handleIngresosAnnualEditClick(event) {
    const editManualBtn = event.target.closest("[data-annual-edit-manual]")
    if (editManualBtn) {
        openRecurrenteEditModal(Number(editManualBtn.dataset.annualEditManual))
        return
    }
    const editTypeBtn = event.target.closest("[data-annual-edit-type]")
    if (editTypeBtn) openIngresoTypeRenameModal(Number(editTypeBtn.dataset.annualEditType))
}

function handleIngresosAnnualDeleteClick(event) {
    const deleteButton = event.target.closest("[data-ingresos-delete-manual-row]")
    if (deleteButton) {
        const rowIndex = Number(deleteButton.dataset.ingresosDeleteManualRow)
        const rowData = currentIngresosData?.recurrentes?.[rowIndex]
        if (!rowData) return

        const hasContent = Boolean(
            ((rowData.nombre || "").trim() && (rowData.nombre || "").trim().toLowerCase() !== "recurrente") ||
            INGRESOS_MONTHS.some((month) => parseEuroNumber(rowData.meses?.[month.key] || "") !== 0)
        )

        const removeRow = () => {
            currentIngresosData.recurrentes.splice(rowIndex, 1)
            renderCurrentIngresosView()
            scheduleIngresosAutosave()
        }

        if (!hasContent) { removeRow(); return }

        openConfirmModal({
            title: "Eliminar recurrente",
            message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
            confirmLabel: "Eliminar",
            confirmSide: "right",
            onConfirm: async () => removeRow()
        })
        return
    }

    const deleteTypeButton = event.target.closest("[data-ingresos-delete-type-row]")
    if (!deleteTypeButton) return

    const rowIndex = Number(deleteTypeButton.dataset.ingresosDeleteTypeRow)
    const typeLabel = sharedIngresosTypes?.[rowIndex]
    if (!typeLabel) return

    const normalizedType = normalizeComparableIngresoText(typeLabel)
    const typeInUse = Object.values(currentIngresosData.months || {}).some((monthData) =>
        (monthData?.rows || []).some((row) => normalizeComparableIngresoText(row?.tipo || "") === normalizedType)
    )

    if (typeInUse) {
        alert("No puedes eliminar este ingreso porque ya se está usando en movimientos.")
        return
    }

    sharedIngresosTypes.splice(rowIndex, 1)
    if (currentIngresosData) currentIngresosData.ingresosTipos = [...sharedIngresosTypes]
    persistSharedIngresosTypes().then(() => {
        renderCurrentIngresosView()
        scheduleIngresosAutosave()
    }).catch((error) => {
        console.error(error)
        alert("No se pudo guardar la lista global de ingresos.")
    })
}

function renderIngresosMonthTabs() {
    const tabsContainer = document.getElementById("ingresosMonthTabs")
    if (!tabsContainer) return
    tabsContainer.innerHTML = ""
    INGRESOS_MONTHS.forEach((month) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `ingresosMonthTab${month.key === currentIngresosMonth && currentIngresosView === "month" ? " active" : ""}`
        button.textContent = month.label
        button.addEventListener("click", async () => {
            await persistCurrentIngresosData()
            currentIngresosMonth = month.key
            currentIngresosView = "month"
            renderIngresosMonthTabs()
            renderIngresosYearButtons()
            renderCurrentIngresosView()
        })
        tabsContainer.appendChild(button)
    })
}

function renderCurrentIngresosView() {
    const annualWrapper = document.getElementById("ingresosAnnualWrapper")
    const movementsWrapper = document.getElementById("ingresosMovementsWrapper")
    const monthHeader = document.getElementById("ingresosMonthHeader")
    const actions = document.getElementById("ingresosActions")
    if (!annualWrapper || !movementsWrapper || !monthHeader || !actions) return

    const sortBtn = document.getElementById("sortIngresosByDateBtn")
    if (currentIngresosView === "year") {
        renderIngresosAnnualTable()
        annualWrapper.classList.remove("hidden")
        movementsWrapper.classList.add("hidden")
        monthHeader.classList.add("hidden")
        actions.classList.add("hidden")
        if (sortBtn) sortBtn.classList.add("hidden")
    } else {
        renderIngresosMonthTable()
        annualWrapper.classList.add("hidden")
        movementsWrapper.classList.remove("hidden")
        monthHeader.classList.remove("hidden")
        actions.classList.remove("hidden")
        if (sortBtn) sortBtn.classList.remove("hidden")
    }
}

function renderIngresosMonthTable() {
    const body = document.getElementById("ingresosMovementsBody")
    if (!body || !currentIngresosData) return
    body.innerHTML = ""
    const rows = [...(currentIngresosData.months?.[currentIngresosMonth]?.rows || [])]
        .sort((a, b) => ingresoParseDate(a.fecha) - ingresoParseDate(b.fecha))
    rows.forEach((row, index) => body.appendChild(buildIngresoMovementRow(row, index)))

    const total = rows.reduce((sum, row) => sum + parseEuroNumber(row.cantidad || ""), 0)
    const totalTr = document.createElement("tr")
    totalTr.className = "ingresosTotalRow"
    totalTr.dataset.isTotal = "true"
    totalTr.innerHTML = `<td colspan="3">Total</td><td>${formatEuro(total)}</td><td class="rowActionsCell"></td>`
    body.appendChild(totalTr)
}

function sortIngresosByDate() {
    const body = document.getElementById("ingresosMovementsBody")
    if (!body) return
    const rows = [...body.querySelectorAll("tr")]
    rows.sort((a, b) => {
        const da = ingresoParseDate(a.querySelector('[data-field="fecha"]')?.textContent.trim())
        const db = ingresoParseDate(b.querySelector('[data-field="fecha"]')?.textContent.trim())
        return da - db
    })
    rows.forEach((tr) => body.appendChild(tr))
    syncIngresosDataFromTables()
    renderCurrentIngresosView()
    scheduleIngresosAutosave()
}

function ingresoParseDate(str) {
    if (!str) return Infinity
    const p = str.split("-")
    if (p.length === 3) return new Date(p[2], p[1] - 1, p[0]).getTime()
    return Infinity
}

function buildIngresoMovementRow(row = {}, rowIndex = -1) {
    const tr = document.createElement("tr")
    tr.dataset.rowIndex = String(rowIndex)
    tr.dataset.fecha = String(row.fecha || "")
    tr.dataset.nombre = String(row.nombre || "")
    tr.dataset.tipo = String(normalizeIngresoTipo(row.tipo || ""))
    tr.dataset.cantidad = String(row.cantidad || "")

    tr.innerHTML = `
        <td data-field="fecha">${row.fecha || ""}</td>
        <td data-field="nombre">${row.nombre || ""}</td>
        <td data-field="tipo">${normalizeIngresoTipo(row.tipo || "")}</td>
        <td data-field="cantidad">${formatCellEuroValue(row.cantidad || "")}</td>
        <td class="rowActionsCell">
            <div class="rowActionsBtns">
                <button type="button" class="assetRowEditBtn ingresosRowEditBtn avActionBtn avEditBtn" data-row-index="${rowIndex}" title="Editar fila">✎</button>
                <button type="button" class="assetRowDeleteBtn ingresosRowDeleteBtn avActionBtn avDeleteBtn" data-row-index="${rowIndex}" title="Eliminar fila">🗑️</button>
            </div>
        </td>
    `
    return tr
}

function handleIngresosMovementActionClick(event) {
    const editButton = event.target.closest(".ingresosRowEditBtn")
    if (editButton) {
        openIngresoMovementModal(Number(editButton.dataset.rowIndex))
        return
    }

    const deleteButton = event.target.closest(".ingresosRowDeleteBtn")
    if (!deleteButton) return

    const rowIndex = Number(deleteButton.dataset.rowIndex)
    const monthRows = currentIngresosData?.months?.[currentIngresosMonth]?.rows || []
    const row = monthRows[rowIndex]
    const isEmpty = !row || (!row.fecha && !row.nombre && !row.tipo && parseEuroNumber(row.cantidad || "") === 0)

    const removeRow = () => {
        monthRows.splice(rowIndex, 1)
        renderCurrentIngresosView()
        scheduleIngresosAutosave()
    }

    if (isEmpty) { removeRow(); return }

    openConfirmModal({
        title: "Eliminar fila",
        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => removeRow()
    })
}

function handleIngresosAnnualBlur(event) {
    const cell = event.target.closest('td[contenteditable="true"]')
    if (!cell) return
    if (cell.dataset.ingresosManualMonth) {
        const value = parseEuroNumber(cell.textContent)
        cell.textContent = cell.textContent.trim() === "" ? "" : formatEuro(value)
    }
    syncIngresosDataFromTables()
    renderIngresosAnnualTable()
    scheduleIngresosAutosave()
}

function syncIngresosDataFromTables() {
    if (!currentIngresosData || !_ingresosDataLoaded) return
    if (!document.querySelector(".ingresosPage")) return

    if (currentIngresosView === "month") {
        const bodyRows = [...document.querySelectorAll("#ingresosMovementsBody tr")]
        if (!currentIngresosData.months[currentIngresosMonth]) {
            currentIngresosData.months[currentIngresosMonth] = { rows: [] }
        }
        currentIngresosData.months[currentIngresosMonth].rows = bodyRows
        .filter((tr) => !tr.dataset.isTotal)
        .map((rowElement) => ({
            fecha: rowElement.dataset.fecha || rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
            nombre: rowElement.dataset.nombre || rowElement.querySelector('[data-field="nombre"]')?.textContent.trim() || "",
            tipo: normalizeIngresoTipo(rowElement.dataset.tipo || rowElement.querySelector('[data-field="tipo"]')?.textContent.trim() || ""),
            cantidad: rowElement.dataset.cantidad || rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || ""
        })).filter((row) => row.fecha || row.nombre || row.tipo || parseEuroNumber(row.cantidad) !== 0)
    }
}

function normalizeIngresoTipo(value) {
    const label = sanitizeIngresoTypeLabel(value)
    const normalized = normalizeComparableIngresoText(label)
    const found = getAvailableIngresosTypes().find((type) => normalizeComparableIngresoText(type) === normalized)
    return found || label
}

function dedupeIngresosTypes(values) {
    return values.filter((type, index, array) =>
        array.findIndex((item) => normalizeComparableIngresoText(item) === normalizeComparableIngresoText(type)) === index
    )
}

async function persistSharedIngresosTypes() {
    sharedIngresosTypes = await saveSharedIngresosTypes(dedupeIngresosTypes(sharedIngresosTypes))
}

function scheduleIngresosAutosave(delay = 500) {
    window.clearTimeout(ingresosAutosaveTimeout)
    ingresosAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistCurrentIngresosData()
        } catch (error) {
            console.error("Error en autoguardado de ingresos:", error)
        }
    }, delay)
}

async function persistCurrentIngresosData(options = {}) {
    if (!currentIngresosYear || !currentIngresosData || !_ingresosDataLoaded) return
    syncIngresosDataFromTables()
    currentIngresosData.ingresosTipos = [...sharedIngresosTypes]
    window.clearTimeout(ingresosAutosaveTimeout)
    await persistSharedIngresosTypes()
    await saveIngresosYear(currentIngresosYear, currentIngresosData, options)
}

async function flushIngresosPendingChanges() {
    if (!document.getElementById("ingresosAnnualBody") && !document.getElementById("ingresosMovementsBody")) return
    await persistCurrentIngresosData({ keepalive: true })
}

function bindIngresosPersistenceGuards() {
    if (ingresosPersistenceBound) return
    ingresosPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!currentIngresosYear || !currentIngresosData || !_ingresosDataLoaded) return
        syncIngresosDataFromTables()
        saveIngresosYear(currentIngresosYear, currentIngresosData, { keepalive: true }).catch((error) => {
            console.error("Error al guardar ingresos al cerrar:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || !currentIngresosYear || !currentIngresosData || !_ingresosDataLoaded) return
        syncIngresosDataFromTables()
        saveIngresosYear(currentIngresosYear, currentIngresosData, { keepalive: true }).catch((error) => {
            console.error("Error al guardar ingresos al cambiar de ventana:", error)
        })
    })
}
