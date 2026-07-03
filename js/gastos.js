const GASTOS_MONTHS = [
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

let gastosYears = []
let currentGastosYear = null
let currentGastosMonth = "enero"
let currentGastosData = null
let currentGastosView = "year"
let gastosAutosaveTimeout = null
let gastosPersistenceBound = false
let sharedGastosTypes = []
let _gastosDataLoaded = false
let _gastosHasPendingChanges = false
let gastosModalKeyHandler = null


function isGastoTipoHidden(type) {
    const hidden = window._gastosHiddenTipos || []
    return hidden.includes(normalizeComparableGastoText(type))
}

async function toggleGastoTipoVisibility(type) {
    const hidden = Array.isArray(window._gastosHiddenTipos) ? [...window._gastosHiddenTipos] : []
    const norm = normalizeComparableGastoText(type)
    const idx = hidden.indexOf(norm)
    if (idx >= 0) {
        hidden.splice(idx, 1)
    } else {
        hidden.push(norm)
    }
    window._gastosHiddenTipos = hidden
    try {
        await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gastosHiddenTipos: hidden })
        })
    } catch (e) {
        console.error("No se pudo guardar visibilidad de gasto:", e)
    }
}

function sanitizeGastoTypeLabel(value) {
    return String(value || "").trim().replace(/\s+/g, " ")
}

function normalizeComparableGastoText(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
}

function escapeGastosHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function ensureGastosDataShape(data) {
    if (!data || typeof data !== "object") {
        return data
    }

    const mergedTypes = []
    const pushMergedType = (value) => {
        const label = sanitizeGastoTypeLabel(value)
        if (!label) {
            return
        }

        if (mergedTypes.some((type) => normalizeComparableGastoText(type) === normalizeComparableGastoText(label))) {
            return
        }

        mergedTypes.push(label)
    }

    ;(Array.isArray(data.gastosTipos) ? data.gastosTipos : []).forEach(pushMergedType)
    ;(Array.isArray(data.customTypes) ? data.customTypes : []).forEach(pushMergedType)

    Object.values(data.months || {}).forEach((monthData) => {
        ;(monthData?.rows || []).forEach((row) => pushMergedType(row?.tipo || ""))
    })

    data.gastosTipos = mergedTypes
    delete data.customTypes

    return data
}

function getAvailableGastosTypes() {
    return Array.isArray(sharedGastosTypes) ? sharedGastosTypes : []
}

function closeGastosCreateModal() {
    document.getElementById("gastosCreateModalOverlay")?.remove()

    if (gastosModalKeyHandler) {
        document.removeEventListener("keydown", gastosModalKeyHandler)
        gastosModalKeyHandler = null
    }
}

function openGastosCreateModal({ title, bodyHtml, onSubmit, submitLabel = "Guardar", modalClass = "" }) {
    closeGastosCreateModal()

    const overlay = document.createElement("div")
    overlay.id = "gastosCreateModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = `assetModal gastosCreateModal${modalClass ? ` ${modalClass}` : ""}`
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.setAttribute("aria-labelledby", "gastosCreateModalTitle")

    modal.innerHTML = `
        <h3 class="assetModalTitle" id="gastosCreateModalTitle">${escapeGastosHtml(title)}</h3>
        <div class="gastosCreateModalBody">${bodyHtml}</div>
        <p class="gastosCreateModalFeedback hidden" id="gastosCreateModalFeedback"></p>
        <div class="assetModalActions gastosCreateModalActions">
            <button type="button" class="cancelButton" id="gastosCreateModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="gastosCreateModalSaveBtn" data-no-autohide="true">${escapeGastosHtml(submitLabel)}</button>
        </div>
    `

    const setFeedback = (message = "", isError = false) => {
        const feedback = modal.querySelector("#gastosCreateModalFeedback")
        if (!feedback) {
            return
        }

        feedback.textContent = message
        feedback.classList.toggle("hidden", !message)
        feedback.classList.toggle("error", Boolean(message && isError))
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            // closeGastosCreateModal() // Deshabilitado para evitar cierre accidental
        }
    })

    modal.querySelector("#gastosCreateModalCancelBtn")?.addEventListener("click", closeGastosCreateModal)
    modal.querySelector("#gastosCreateModalSaveBtn")?.addEventListener("click", async () => {
        const getValue = (id) => modal.querySelector(`#${id}`)?.value ?? ""

        try {
            const shouldClose = await onSubmit({ getValue, setFeedback, modal })
            if (shouldClose !== false) {
                closeGastosCreateModal()
            }
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    gastosModalKeyHandler = (event) => {
        if (event.key === "Escape") {
            closeGastosCreateModal()
        }
    }
    document.addEventListener("keydown", gastosModalKeyHandler)

    modal.querySelector("input, select")?.focus()
}

function openGastoTypeModal() {
    openGastosCreateModal({
        title: "Añadir gasto",
        bodyHtml: `
            <label class="assetModalLabel" for="gastosTipoModalInput">Nombre del gasto</label>
            <input id="gastosTipoModalInput" class="assetModalInput" type="text" placeholder="Ej: Comidas/Cenas o Transporte">
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const label = sanitizeGastoTypeLabel(getValue("gastosTipoModalInput"))

            if (!label) {
                setFeedback("Introduce un nombre para el gasto.", true)
                return false
            }

            syncGastosDataFromTables()
            sharedGastosTypes.push(label)
            sharedGastosTypes = dedupeGastosTypes(sharedGastosTypes)
            await persistSharedGastosTypes()
            renderCurrentGastosView()
            return true
        }
    })
}

function openMensualidadModal() {
    const monthsHtml = GASTOS_MONTHS.map((month) => `
        <div class="gastosCreateModalField">
            <label class="assetModalLabel" for="gastosMensualidad-${month.key}">${month.label}</label>
            <input id="gastosMensualidad-${month.key}" class="assetModalInput" type="text" inputmode="decimal" placeholder="0,00">
        </div>
    `).join("")

    openGastosCreateModal({
        title: "Añadir mensualidad",
        modalClass: "gastosCreateModalWide",
        bodyHtml: `
            <div class="gastosCreateModalField">
                <label class="assetModalLabel" for="gastosMensualidadNombre">Nombre</label>
                <input id="gastosMensualidadNombre" class="assetModalInput" type="text" placeholder="Ej: Alquiler, Spotify o Gimnasio">
            </div>
            <div class="gastosCreateModalGrid gastosCreateModalGridMonths">
                ${monthsHtml}
            </div>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const nombreRaw = sanitizeGastoTypeLabel(getValue("gastosMensualidadNombre"))
            const nombre = nombreRaw || "Mensualidad"
            const meses = Object.fromEntries(
                GASTOS_MONTHS.map((month) => {
                    const rawValue = String(getValue(`gastosMensualidad-${month.key}`)).trim()
                    return [month.key, rawValue ? formatCellEuroValue(rawValue) : ""]
                })
            )

            const hasAnyAmount = GASTOS_MONTHS.some((month) => parseEuroNumber(meses[month.key]) !== 0)
            if (!nombreRaw && !hasAnyAmount) {
                setFeedback("Introduce al menos un dato para la mensualidad.", true)
                return false
            }

            syncGastosDataFromTables()
            currentGastosData.mensualidades.push({ nombre, meses })
            renderCurrentGastosView()
            await persistCurrentGastosData()
            return true
        }
    })
}

function openGastoMovementModal(rowIndex = -1) {
    const currentRows = currentGastosData?.months?.[currentGastosMonth]?.rows || []
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...currentRows[rowIndex] } : {}
    const availableTypes = getAvailableGastosTypes()
    const typeOptions = availableTypes
        .map((type) => {
            const isSelected = normalizeComparableGastoText(rowData.tipo || "") === normalizeComparableGastoText(type)
            return `<option value="${escapeGastosHtml(type)}"${isSelected ? " selected" : ""}>${escapeGastosHtml(type)}</option>`
        })
        .join("")

    openGastosCreateModal({
        title: isEdit ? "Editar gasto" : "Añadir gasto",
        bodyHtml: `
            <label class="assetModalLabel" for="gastosMovimientoFecha">Fecha</label>
            <input id="gastosMovimientoFecha" class="assetModalInput" type="text" value="${escapeGastosHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">

            <label class="assetModalLabel" for="gastosMovimientoNombre">Nombre</label>
            <input id="gastosMovimientoNombre" class="assetModalInput" type="text" value="${escapeGastosHtml(rowData.nombre || "")}" placeholder="Ej: Cena Mercadona">

            <label class="assetModalLabel" for="gastosMovimientoTipo">Tipo</label>
            <select id="gastosMovimientoTipo" class="assetModalSelect">
                <option value=""></option>
                ${typeOptions}
            </select>

            <label class="assetModalLabel" for="gastosMovimientoCantidad">Cantidad</label>
            <input id="gastosMovimientoCantidad" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(rowData.cantidad || "")}" placeholder="0,00">
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const fecha = String(getValue("gastosMovimientoFecha")).trim()
            const nombre = String(getValue("gastosMovimientoNombre")).trim()
            const tipo = normalizeGastoTipo(getValue("gastosMovimientoTipo"))
            const cantidadRaw = String(getValue("gastosMovimientoCantidad")).trim()
            const cantidad = cantidadRaw ? formatCellEuroValue(cantidadRaw) : ""

            if (!fecha && !nombre && !tipo && !cantidad) {
                setFeedback("Introduce al menos un dato para el gasto.", true)
                return false
            }

            syncGastosDataFromTables()
            if (!currentGastosData.months[currentGastosMonth]) {
                currentGastosData.months[currentGastosMonth] = { rows: [] }
            }

            const nextRow = {
                fecha,
                nombre,
                tipo,
                cantidad
            }

            if (isEdit && currentGastosData.months[currentGastosMonth].rows[rowIndex]) {
                currentGastosData.months[currentGastosMonth].rows[rowIndex] = nextRow
            } else {
                currentGastosData.months[currentGastosMonth].rows.push(nextRow)
            }

            renderCurrentGastosView()
            await persistCurrentGastosData()
            return true
        }
    })
}

async function loadGastosYears() {
    const response = await fetch("/api/gastos")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista de años de gastos")
    }

    const data = await response.json()
    return Array.isArray(data.years) ? data.years : []
}

async function loadGastosYear(year) {
    const response = await fetch(`/api/gastos/${year}`)

    if (!response.ok) {
        throw new Error("No se pudo cargar el año de gastos")
    }

    return await response.json()
}

async function loadSharedGastosTypes() {
    const response = await fetch("/api/gastos-tipos")

    if (!response.ok) {
        throw new Error("No se pudo cargar la lista global de tipos de gasto")
    }

    const data = await response.json()
    return Array.isArray(data.types) ? data.types : []
}

async function saveSharedGastosTypes(types) {
    const response = await fetch("/api/gastos-tipos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ types })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    const data = await response.json()
    return Array.isArray(data.types) ? data.types : []
}

async function createGastosYear(year) {
    const response = await fetch("/api/gastos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify({ year })
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function saveGastosYear(year, payload, options = {}) {
    const response = await fetch(`/api/gastos/${year}`, {
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

async function deleteGastosYearRequest(year) {
    const response = await fetch(`/api/gastos/${year}`, {
        method: "DELETE"
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }

    return await response.json()
}

async function initGastosLogic() {
    gastosYears = await loadGastosYears()
    sharedGastosTypes = await loadSharedGastosTypes()
    currentGastosYear = gastosYears[0] || "2026"
    currentGastosMonth = "enero"
    currentGastosView = "year"
    bindGastosPersistenceGuards()
    window.flushPendingPageChanges = flushGastosPendingChanges
    await renderGastosYear(currentGastosYear)
    bindGastosEvents()

    const annualBody = document.getElementById("gastosAnnualBody")
    const movementsBody = document.getElementById("gastosMovementsBody")

    if (annualBody && !annualBody.dataset.bound) {
        annualBody.dataset.bound = "true"
        annualBody.addEventListener("click", handleGastosAnnualDeleteClick)
        annualBody.addEventListener("click", handleGastosAnnualEditClick)
        annualBody.addEventListener("click", handleGastosEyeClick)
        annualBody.addEventListener("click", handleGastosAnnualMoveClick)
        annualBody.addEventListener("blur", handleGastosAnnualBlur, true)
    }

    if (movementsBody && !movementsBody.dataset.bound) {
        movementsBody.dataset.bound = "true"
        movementsBody.addEventListener("click", handleGastosMovementActionClick)
    }

    const gastosMovementsTable = document.querySelector(".gastosMovementsTable")
    if (gastosMovementsTable) bindTableSort(gastosMovementsTable, "gastos")
}

function bindGastosEvents() {
    const menuTrigger = document.querySelector("#gastosActionsMenu .pageActionsMenuTrigger")
    const menuDropdown = document.getElementById("gastosActionsDropdown")
    if (menuTrigger && menuDropdown && !menuTrigger.dataset.bound) {
        menuTrigger.dataset.bound = "true"
        menuTrigger.addEventListener("click", (e) => {
            e.stopPropagation()
            menuDropdown.classList.toggle("open")
        })
        document.addEventListener("click", () => menuDropdown.classList.remove("open"))
        menuDropdown.addEventListener("click", () => menuDropdown.classList.remove("open"))
    }

    const addYearButton = document.getElementById("addGastosYearBtn")
    const deleteYearButton = document.getElementById("deleteGastosYearBtn")
    const addRowButton = document.getElementById("addGastoRowBtn")
    const addMensualidadRowButton = document.getElementById("addMensualidadRowBtn")
    const addGastoTypeRowButton = document.getElementById("addGastoTypeRowBtn")
    const saveButton = document.getElementById("saveGastosBtn")

    if (addYearButton && !addYearButton.dataset.bound) {
        addYearButton.dataset.bound = "true"
        addYearButton.addEventListener("click", async () => {
            const suggestedYear = String(new Date().getFullYear())
            const year = prompt("Escribe el nuevo año (YYYY)", suggestedYear)?.trim()

            if (!year) {
                return
            }

            try {
                await persistCurrentGastosData()
                await createGastosYear(year)
                gastosYears = await loadGastosYears()
                currentGastosYear = year
                await renderGastosYear(year)
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
                message: `Vas a eliminar el año ${currentGastosYear}. ¿Quieres continuar?`,
                confirmLabel: "Eliminar",
                confirmSide: "right",
                onConfirm: async () => {
                    openConfirmModal({
                        title: "Segunda verificación",
                        message: `Esta acción borrará definitivamente el año ${currentGastosYear}. ¿Confirmas que quieres eliminarlo?`,
                        confirmLabel: "Eliminar",
                        confirmSide: "left",
                        onConfirm: async () => {
                            const response = await deleteGastosYearRequest(currentGastosYear)
                            gastosYears = Array.isArray(response.years) ? response.years : await loadGastosYears()
                            currentGastosYear = gastosYears[0]
                            currentGastosView = "year"
                            currentGastosMonth = "enero"
                            await renderGastosYear(currentGastosYear)
                        }
                    })
                }
            })
        })
    }

    const sortByDateButton = document.getElementById("sortGastosByDateBtn")
    if (sortByDateButton && !sortByDateButton.dataset.bound) {
        sortByDateButton.dataset.bound = "true"
        sortByDateButton.addEventListener("click", sortGastosByDate)
    }

    if (addRowButton && !addRowButton.dataset.bound) {
        addRowButton.dataset.bound = "true"
        addRowButton.addEventListener("click", () => {
            openGastoMovementModal()
        })
    }

    if (addMensualidadRowButton && !addMensualidadRowButton.dataset.bound) {
        addMensualidadRowButton.dataset.bound = "true"
        addMensualidadRowButton.addEventListener("click", () => {
            openMensualidadModal()
        })
    }

    if (addGastoTypeRowButton && !addGastoTypeRowButton.dataset.bound) {
        addGastoTypeRowButton.dataset.bound = "true"
        addGastoTypeRowButton.addEventListener("click", () => {
            openGastoTypeModal()
        })
    }

    if (saveButton && !saveButton.dataset.bound) {
        saveButton.dataset.bound = "true"
        saveButton.addEventListener("click", async () => {
            try {
                await persistCurrentGastosData()
                alert(`Datos guardados en gastos/gastos${currentGastosYear}.json`)
            } catch (error) {
                console.error(error)
                alert("No se pudieron guardar los gastos.")
            }
        })
    }
}

async function renderGastosYear(year) {
    _gastosDataLoaded = false
    _gastosHasPendingChanges = false
    currentGastosData = ensureGastosDataShape(await loadGastosYear(year))
    currentGastosYear = currentGastosData.year
    _gastosDataLoaded = true

    renderGastosYearButtons()
    renderGastosMonthTabs()
    renderCurrentGastosView()
}

function renderGastosYearButtons() {
    const list = document.getElementById("gastosYearList")

    if (!list) {
        return
    }

    list.innerHTML = ""

    gastosYears.forEach((year) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `gastosYearBtn${year === currentGastosYear ? " active" : ""}${year === currentGastosYear && currentGastosView === "year" ? " yearViewActive" : ""}`
        button.textContent = year
        button.addEventListener("click", async () => {
            await persistCurrentGastosData()
            currentGastosYear = year
            currentGastosView = "year"
            await renderGastosYear(year)
        })
        list.appendChild(button)
    })
}

function buildMonthlyExpenseTotals() {
    const totals = {}
    const availableTypes = getAvailableGastosTypes()

    availableTypes.forEach((type) => {
        totals[type] = {}
        GASTOS_MONTHS.forEach((month) => {
            totals[type][month.key] = 0
        })
    })

    GASTOS_MONTHS.forEach((month) => {
        const rows = currentGastosData?.months?.[month.key]?.rows || []
        rows.forEach((row) => {
            const type = String(row.tipo || "").trim()
            if (!availableTypes.includes(type)) {
                return
            }

            totals[type][month.key] += parseEuroNumber(row.cantidad || "")
        })
    })

    return totals
}

function renderGastosAnnualTable() {
    const annualBody = document.getElementById("gastosAnnualBody")
    const yearLabel = document.getElementById("gastosAnnualYearLabel")

    if (!annualBody || !yearLabel || !currentGastosData) {
        return
    }

    yearLabel.textContent = currentGastosData.year
    annualBody.innerHTML = ""

    const expenseTotals = buildMonthlyExpenseTotals()
    const availableTypes = getAvailableGastosTypes()

    const mensualidadesRow = document.createElement("tr")
    mensualidadesRow.className = "gastosSectionRow"
    const mensSectionHidden = isGastoTipoHidden("Mensualidades")
    mensualidadesRow.innerHTML = `
        <td colspan="13">Mensualidades</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem gastosEyeBtn${mensSectionHidden ? "" : " active"}" data-gastos-eye-mens="1">👁 ${mensSectionHidden ? "Mostrar" : "Ocultar"}</button>
                </div>
            </div>
        </td>`
    annualBody.appendChild(mensualidadesRow)

    const totalMensualidades = currentGastosData.mensualidades.length
    currentGastosData.mensualidades.forEach((row, rowIndex) => {
        const tr = document.createElement("tr")
        tr.innerHTML = `
            <td>${escapeGastosHtml(row.nombre || "")}</td>
            ${GASTOS_MONTHS.map((month) => `
                <td>${formatCellEuroValue(row.meses?.[month.key] || "")}</td>
            `).join("")}
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem" data-gastos-move-manual-row="${rowIndex}" data-gastos-move-dir="up" ${rowIndex === 0 ? "disabled" : ""}>▲ Subir</button>
                        <button type="button" class="rowMenuItem" data-gastos-move-manual-row="${rowIndex}" data-gastos-move-dir="down" ${rowIndex === totalMensualidades - 1 ? "disabled" : ""}>▼ Bajar</button>
                        <hr>
                        <button type="button" class="rowMenuItem assetRowEditBtn gastosAnnualEditBtn" data-annual-edit-manual="${rowIndex}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn" data-gastos-delete-manual-row="${rowIndex}">Eliminar</button>
                    </div>
                </div>
            </td>
        `
        annualBody.appendChild(tr)
    })

    const mensualidadesTotalRow = document.createElement("tr")
    mensualidadesTotalRow.className = "gastosTotalRow"
    mensualidadesTotalRow.innerHTML = `
        <td>Total</td>
        ${GASTOS_MONTHS.map((month) => {
            const total = currentGastosData.mensualidades.reduce((sum, row) => sum + parseEuroNumber(row.meses?.[month.key] || ""), 0)
            return `<td>${formatEuro(total)}</td>`
        }).join("")}
        <td></td>
    `
    annualBody.appendChild(mensualidadesTotalRow)

    const gastosRow = document.createElement("tr")
    gastosRow.className = "gastosSectionRow"
    gastosRow.innerHTML = `<td colspan="14">Gastos</td>`
    annualBody.appendChild(gastosRow)

    const typesWithData = availableTypes.filter((type) =>
        GASTOS_MONTHS.some((month) => expenseTotals[type][month.key] > 0)
    )
    const typesEmpty = availableTypes.filter((type) =>
        GASTOS_MONTHS.every((month) => !expenseTotals[type][month.key])
    )

    const totalTypes = availableTypes.length
    const renderTypeRow = (type) => {
        const rowIndex = availableTypes.indexOf(type)
        const isHidden = isGastoTipoHidden(type)
        const isEmpty = GASTOS_MONTHS.every((month) => !expenseTotals[type][month.key])
        const tr = document.createElement("tr")
        if (isEmpty) tr.classList.add("gastosTypeEmpty")
        tr.innerHTML = `
            <td>${escapeGastosHtml(type)}</td>
            ${GASTOS_MONTHS.map((month) => `<td>${expenseTotals[type][month.key] ? formatEuro(expenseTotals[type][month.key]) : "- €"}</td>`).join("")}
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem" data-gastos-move-type-row="${rowIndex}" data-gastos-move-dir="up" ${rowIndex === 0 ? "disabled" : ""}>▲ Subir</button>
                        <button type="button" class="rowMenuItem" data-gastos-move-type-row="${rowIndex}" data-gastos-move-dir="down" ${rowIndex === totalTypes - 1 ? "disabled" : ""}>▼ Bajar</button>
                        <hr>
                        <button type="button" class="rowMenuItem gastosEyeBtn${isHidden ? "" : " active"}" data-gastos-eye-type="${rowIndex}">👁 ${isHidden ? "Mostrar" : "Ocultar"}</button>
                        <button type="button" class="rowMenuItem assetRowEditBtn gastosAnnualEditBtn" data-annual-edit-type="${rowIndex}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn" data-gastos-delete-type-row="${rowIndex}">Eliminar</button>
                    </div>
                </div>
            </td>
        `
        annualBody.appendChild(tr)
    }

    typesWithData.forEach(renderTypeRow)

    if (typesEmpty.length) {
        const sepRow = document.createElement("tr")
        sepRow.className = "gastosTypeEmptySep"
        sepRow.innerHTML = `<td colspan="14"></td>`
        annualBody.appendChild(sepRow)
        typesEmpty.forEach(renderTypeRow)
    }

    const gastosTotalRow = document.createElement("tr")
    gastosTotalRow.className = "gastosTotalRow"
    gastosTotalRow.innerHTML = `
        <td>Total</td>
        ${GASTOS_MONTHS.map((month) => {
            const total = availableTypes.reduce((sum, type) => sum + expenseTotals[type][month.key], 0)
            return `<td>${total ? formatEuro(total) : "- €"}</td>`
        }).join("")}
        <td></td>
    `
    annualBody.appendChild(gastosTotalRow)

    const grandTotalRow = document.createElement("tr")
    grandTotalRow.className = "gastosTotalRow"
    grandTotalRow.innerHTML = `
        <td>TOTAL</td>
        ${GASTOS_MONTHS.map((month) => {
            const totalMensualidades = currentGastosData.mensualidades.reduce((sum, row) => sum + parseEuroNumber(row.meses?.[month.key] || ""), 0)
            const totalGastos = availableTypes.reduce((sum, type) => sum + expenseTotals[type][month.key], 0)
            return `<td>${formatEuro(totalMensualidades + totalGastos)}</td>`
        }).join("")}
        <td></td>
    `
    annualBody.appendChild(grandTotalRow)
}

function openMensualidadEditModal(rowIndex) {
    const row = currentGastosData?.mensualidades?.[rowIndex]
    if (!row) return

    const monthsHtml = GASTOS_MONTHS.map((month) => `
        <div class="gastosCreateModalField">
            <label class="assetModalLabel" for="gastosMensualidad-${month.key}">${month.label}</label>
            <input id="gastosMensualidad-${month.key}" class="assetModalInput" type="text" inputmode="decimal" value="${escapeGastosHtml(row.meses?.[month.key] || "")}" placeholder="0,00">
        </div>
    `).join("")

    openGastosCreateModal({
        title: "Editar mensualidad",
        modalClass: "gastosCreateModalWide",
        bodyHtml: `
            <div class="gastosCreateModalField">
                <label class="assetModalLabel" for="gastosMensualidadNombre">Nombre</label>
                <input id="gastosMensualidadNombre" class="assetModalInput" type="text" value="${escapeGastosHtml(row.nombre || "")}" placeholder="Ej: Alquiler">
            </div>
            <div class="gastosCreateModalGrid gastosCreateModalGridMonths">
                ${monthsHtml}
            </div>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue }) => {
            const nombreRaw = sanitizeGastoTypeLabel(getValue("gastosMensualidadNombre"))
            const nombre = nombreRaw || row.nombre || "Mensualidad"
            const meses = Object.fromEntries(
                GASTOS_MONTHS.map((month) => {
                    const rawValue = String(getValue(`gastosMensualidad-${month.key}`)).trim()
                    return [month.key, rawValue ? formatCellEuroValue(rawValue) : ""]
                })
            )
            currentGastosData.mensualidades[rowIndex] = { nombre, meses }
            renderCurrentGastosView()
            await persistCurrentGastosData()
            return true
        }
    })
}

function openGastoTypeRenameModal(rowIndex) {
    const currentName = sharedGastosTypes?.[rowIndex]
    if (!currentName) return

    openGastosCreateModal({
        title: "Renombrar gasto",
        bodyHtml: `
            <label class="assetModalLabel" for="gastosTipoModalInput">Nombre del gasto</label>
            <input id="gastosTipoModalInput" class="assetModalInput" type="text" value="${escapeGastosHtml(currentName)}" placeholder="Ej: Comidas/Cenas">
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const label = sanitizeGastoTypeLabel(getValue("gastosTipoModalInput"))
            if (!label) {
                setFeedback("Introduce un nombre para el gasto.", true)
                return false
            }
            const normalizedNew = normalizeComparableGastoText(label)
            const normalizedCurrent = normalizeComparableGastoText(currentName)
            const isDuplicate = sharedGastosTypes.some((type, idx) =>
                idx !== rowIndex && normalizeComparableGastoText(type) === normalizedNew
            )
            if (isDuplicate) {
                setFeedback("Ya existe un gasto con ese nombre.", true)
                return false
            }
            if (normalizedNew !== normalizedCurrent) {
                Object.values(currentGastosData.months || {}).forEach((monthData) => {
                    ;(monthData?.rows || []).forEach((row) => {
                        if (normalizeComparableGastoText(row?.tipo || "") === normalizedCurrent) {
                            row.tipo = label
                        }
                    })
                })
            }
            sharedGastosTypes[rowIndex] = label
            if (currentGastosData) currentGastosData.gastosTipos = [...sharedGastosTypes]
            await persistSharedGastosTypes()
            renderCurrentGastosView()
            await persistCurrentGastosData()
            return true
        }
    })
}

function handleGastosEyeClick(event) {
    if (event.target.closest("[data-gastos-eye-mens]")) {
        toggleGastoTipoVisibility("Mensualidades").then(() => renderGastosAnnualTable())
        return
    }
    const eyeBtn = event.target.closest("[data-gastos-eye-type]")
    if (!eyeBtn) return
    const rowIndex = Number(eyeBtn.dataset.gastosEyeType)
    const type = sharedGastosTypes?.[rowIndex]
    if (!type) return
    toggleGastoTipoVisibility(type).then(() => renderGastosAnnualTable())
}

function handleGastosAnnualEditClick(event) {
    const editManualBtn = event.target.closest("[data-annual-edit-manual]")
    if (editManualBtn) {
        openMensualidadEditModal(Number(editManualBtn.dataset.annualEditManual))
        return
    }
    const editTypeBtn = event.target.closest("[data-annual-edit-type]")
    if (editTypeBtn) {
        openGastoTypeRenameModal(Number(editTypeBtn.dataset.annualEditType))
    }
}

function handleGastosAnnualDeleteClick(event) {
    const deleteButton = event.target.closest("[data-gastos-delete-manual-row]")

    if (deleteButton) {
        const rowIndex = Number(deleteButton.dataset.gastosDeleteManualRow)
        const rowData = currentGastosData?.mensualidades?.[rowIndex]

        if (!rowData) {
            return
        }

        const hasContent = Boolean(
            ((rowData.nombre || "").trim() && (rowData.nombre || "").trim().toLowerCase() !== "mensualidad") ||
            GASTOS_MONTHS.some((month) => parseEuroNumber(rowData.meses?.[month.key] || "") !== 0)
        )

        const removeRow = () => {
            currentGastosData.mensualidades.splice(rowIndex, 1)
            renderCurrentGastosView()
            scheduleGastosAutosave()
        }

        if (!hasContent) {
            removeRow()
            return
        }

        openConfirmModal({
            title: "Eliminar mensualidad",
            message: "Esta fila de mensualidades tiene contenido. ¿Quieres eliminarla?",
            confirmLabel: "Eliminar",
            confirmSide: "right",
            onConfirm: async () => {
                removeRow()
            }
        })
        return
    }

    const deleteTypeButton = event.target.closest("[data-gastos-delete-type-row]")
    if (!deleteTypeButton) {
        return
    }

    const rowIndex = Number(deleteTypeButton.dataset.gastosDeleteTypeRow)
    const typeLabel = sharedGastosTypes?.[rowIndex]

    if (!typeLabel) {
        return
    }

    const normalizedType = normalizeComparableGastoText(typeLabel)
    const typeInUse = Object.values(currentGastosData.months || {}).some((monthData) =>
        (monthData?.rows || []).some((row) => normalizeComparableGastoText(row?.tipo || "") === normalizedType)
    )

    if (typeInUse) {
        alert("No puedes eliminar este gasto porque ya se esta usando en movimientos.")
        return
    }

    sharedGastosTypes.splice(rowIndex, 1)
    if (currentGastosData) currentGastosData.gastosTipos = [...sharedGastosTypes]
    persistSharedGastosTypes().then(() => {
        renderCurrentGastosView()
        scheduleGastosAutosave()
    }).catch((error) => {
        console.error(error)
        alert("No se pudo guardar la lista global de gastos.")
    })
}

function handleGastosAnnualMoveClick(event) {
    const moveManualBtn = event.target.closest("[data-gastos-move-manual-row]")
    if (moveManualBtn) {
        const rowIndex = Number(moveManualBtn.dataset.gastosMoveManualRow)
        const dir = moveManualBtn.dataset.gastosMoveDir
        const arr = currentGastosData.mensualidades
        if (dir === "up" && rowIndex > 0) {
            ;[arr[rowIndex - 1], arr[rowIndex]] = [arr[rowIndex], arr[rowIndex - 1]]
        } else if (dir === "down" && rowIndex < arr.length - 1) {
            ;[arr[rowIndex], arr[rowIndex + 1]] = [arr[rowIndex + 1], arr[rowIndex]]
        } else {
            return
        }
        renderCurrentGastosView()
        scheduleGastosAutosave()
        return
    }

    const moveTypeBtn = event.target.closest("[data-gastos-move-type-row]")
    if (!moveTypeBtn) return
    const rowIndex = Number(moveTypeBtn.dataset.gastosMoveTypeRow)
    const dir = moveTypeBtn.dataset.gastosMoveDir
    if (dir === "up" && rowIndex > 0) {
        ;[sharedGastosTypes[rowIndex - 1], sharedGastosTypes[rowIndex]] = [sharedGastosTypes[rowIndex], sharedGastosTypes[rowIndex - 1]]
    } else if (dir === "down" && rowIndex < sharedGastosTypes.length - 1) {
        ;[sharedGastosTypes[rowIndex], sharedGastosTypes[rowIndex + 1]] = [sharedGastosTypes[rowIndex + 1], sharedGastosTypes[rowIndex]]
    } else {
        return
    }
    if (currentGastosData) currentGastosData.gastosTipos = [...sharedGastosTypes]
    persistSharedGastosTypes().then(() => {
        renderCurrentGastosView()
        scheduleGastosAutosave()
    })
}

function renderGastosMonthTabs() {
    const tabsContainer = document.getElementById("gastosMonthTabs")

    if (!tabsContainer) {
        return
    }

    tabsContainer.innerHTML = ""

    GASTOS_MONTHS.forEach((month) => {
        const button = document.createElement("button")
        button.type = "button"
        button.className = `gastosMonthTab${month.key === currentGastosMonth && currentGastosView === "month" ? " active" : ""}`
        button.textContent = month.label
        button.addEventListener("click", async () => {
            await persistCurrentGastosData()
            currentGastosMonth = month.key
            currentGastosView = "month"
            renderGastosMonthTabs()
            renderGastosYearButtons()
            renderCurrentGastosView()
        })
        tabsContainer.appendChild(button)
    })
}

function renderCurrentGastosView() {
    const annualWrapper = document.getElementById("gastosAnnualWrapper")
    const movementsWrapper = document.getElementById("gastosMovementsWrapper")
    const monthHeader = document.getElementById("gastosMonthHeader")
    const actions = document.getElementById("gastosActions")

    if (!annualWrapper || !movementsWrapper || !monthHeader || !actions) {
        return
    }

    if (currentGastosView === "year") {
        renderGastosAnnualTable()
        annualWrapper.classList.remove("hidden")
        movementsWrapper.classList.add("hidden")
        monthHeader.classList.add("hidden")
        actions.classList.add("hidden")
    } else {
        renderGastosMonthTable()
        annualWrapper.classList.add("hidden")
        movementsWrapper.classList.remove("hidden")
        monthHeader.classList.remove("hidden")
        actions.classList.remove("hidden")
    }
}

function renderGastosMonthTable() {
    const body = document.getElementById("gastosMovementsBody")

    if (!body || !currentGastosData) {
        return
    }

    body.innerHTML = ""

    const rows = [...(currentGastosData.months?.[currentGastosMonth]?.rows || [])]
        .sort((a, b) => gastoParseDate(a.fecha) - gastoParseDate(b.fecha))

    rows.forEach((row, index) => {
        body.appendChild(buildGastoMovementRow(row, index))
    })

    const total = rows.reduce((sum, row) => sum + parseEuroNumber(row.cantidad || ""), 0)
    const totalTr = document.createElement("tr")
    totalTr.className = "gastosTotalRow"
    totalTr.dataset.isTotal = "true"
    totalTr.innerHTML = `<td colspan="3">Total</td><td>${formatEuro(total)}</td><td class="rowActionsCell"></td>`
    body.appendChild(totalTr)
}

function sortGastosByDate() {
    const body = document.getElementById("gastosMovementsBody")
    if (!body) return
    const rows = [...body.querySelectorAll("tr")]
    rows.sort((a, b) => {
        const da = gastoParseDate(a.querySelector('[data-field="fecha"]')?.textContent.trim())
        const db = gastoParseDate(b.querySelector('[data-field="fecha"]')?.textContent.trim())
        return da - db
    })
    rows.forEach((tr) => body.appendChild(tr))
    syncGastosDataFromTables()
    renderCurrentGastosView()
    scheduleGastosAutosave()
}

function gastoParseDate(str) {
    if (!str) return Infinity
    const p = str.split("-")
    if (p.length === 3) return new Date(p[2], p[1] - 1, p[0]).getTime()
    return Infinity
}

function buildGastoMovementRow(row = {}, rowIndex = -1) {
    const tr = document.createElement("tr")
    tr.dataset.rowIndex = String(rowIndex)
    tr.dataset.fecha = String(row.fecha || "")
    tr.dataset.nombre = String(row.nombre || "")
    tr.dataset.tipo = String(normalizeGastoTipo(row.tipo || ""))
    tr.dataset.cantidad = String(row.cantidad || "")

    tr.innerHTML = `
        <td data-field="fecha">${row.fecha || ""}</td>
        <td data-field="nombre">${row.nombre || ""}</td>
        <td data-field="tipo">${normalizeGastoTipo(row.tipo || "")}</td>
        <td data-field="cantidad">${formatCellEuroValue(row.cantidad || "")}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn gastosRowEditBtn" data-row-index="${rowIndex}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn gastosRowDeleteBtn" data-row-index="${rowIndex}">Eliminar</button>
                </div>
            </div>
        </td>
    `
    return tr
}

function addNewGastoMovementRow() {
    const body = document.getElementById("gastosMovementsBody")
    if (!body) {
        return
    }

    body.appendChild(buildGastoMovementRow({}))
}

function handleGastosMovementActionClick(event) {
    const editButton = event.target.closest(".gastosRowEditBtn")
    if (editButton) {
        const rowIndex = Number(editButton.dataset.rowIndex)
        openGastoMovementModal(rowIndex)
        return
    }

    const deleteButton = event.target.closest(".gastosRowDeleteBtn")
    if (!deleteButton) {
        return
    }

    const rowIndex = Number(deleteButton.dataset.rowIndex)
    const monthRows = currentGastosData?.months?.[currentGastosMonth]?.rows || []
    const row = monthRows[rowIndex]
    const isEmpty = !row || (!row.fecha && !row.nombre && !row.tipo && parseEuroNumber(row.cantidad || "") === 0)

    const removeRow = () => {
        monthRows.splice(rowIndex, 1)
        renderCurrentGastosView()
        scheduleGastosAutosave()
    }

    if (isEmpty) {
        removeRow()
        return
    }

    openConfirmModal({
        title: "Eliminar fila",
        message: "Esta fila tiene contenido. ¿Quieres eliminarla?",
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            removeRow()
        }
    })
}

function handleGastosAnnualBlur(event) {
    const cell = event.target.closest('td[contenteditable="true"]')
    if (!cell) {
        return
    }

    if (cell.dataset.gastosManualMonth) {
        const value = parseEuroNumber(cell.textContent)
        cell.textContent = cell.textContent.trim() === "" ? "" : formatEuro(value)
    }

    syncGastosDataFromTables()
    renderGastosAnnualTable()
    scheduleGastosAutosave()
}

function syncGastosDataFromTables() {
    if (!currentGastosData || !_gastosDataLoaded) {
        return
    }

    if (!document.querySelector(".gastosPage")) {
        return
    }

    if (currentGastosView === "month") {
        const bodyRows = [...document.querySelectorAll("#gastosMovementsBody tr")]
        if (!currentGastosData.months[currentGastosMonth]) {
            currentGastosData.months[currentGastosMonth] = { rows: [] }
        }
        currentGastosData.months[currentGastosMonth].rows = bodyRows
        .filter((tr) => !tr.dataset.isTotal)
        .map((rowElement) => {
            return {
                fecha: rowElement.dataset.fecha || rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
                nombre: rowElement.dataset.nombre || rowElement.querySelector('[data-field="nombre"]')?.textContent.trim() || "",
                tipo: normalizeGastoTipo(rowElement.dataset.tipo || rowElement.querySelector('[data-field="tipo"]')?.textContent.trim() || ""),
                cantidad: rowElement.dataset.cantidad || rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() || ""
            }
        }).filter((row) => row.fecha || row.nombre || row.tipo || parseEuroNumber(row.cantidad) !== 0)
    }
}

function normalizeGastoTipo(value) {
    const label = sanitizeGastoTypeLabel(value)
    const normalized = normalizeComparableGastoText(label)
    const found = getAvailableGastosTypes().find((type) => normalizeComparableGastoText(type) === normalized)
    return found || label
}

function dedupeGastosTypes(values) {
    return values.filter((type, index, array) => array.findIndex((item) => normalizeComparableGastoText(item) === normalizeComparableGastoText(type)) === index)
}

async function persistSharedGastosTypes() {
    sharedGastosTypes = await saveSharedGastosTypes(dedupeGastosTypes(sharedGastosTypes))
}

function scheduleGastosAutosave(delay = 500) {
    _gastosHasPendingChanges = true
    window.clearTimeout(gastosAutosaveTimeout)
    gastosAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistCurrentGastosData()
        } catch (error) {
            console.error("Error en autoguardado de gastos:", error)
        }
    }, delay)
}

async function persistCurrentGastosData(options = {}) {
    if (!currentGastosYear || !currentGastosData || !_gastosDataLoaded) {
        return
    }

    syncGastosDataFromTables()
    currentGastosData.gastosTipos = [...sharedGastosTypes]
    window.clearTimeout(gastosAutosaveTimeout)
    gastosAutosaveTimeout = null
    _gastosHasPendingChanges = false
    await persistSharedGastosTypes()
    await saveGastosYear(currentGastosYear, currentGastosData, options)
}

async function flushGastosPendingChanges() {
    if (!_gastosHasPendingChanges) {
        return
    }
    if (!document.getElementById("gastosAnnualBody") && !document.getElementById("gastosMovementsBody")) {
        return
    }

    await persistCurrentGastosData({ keepalive: true })
}

function resetGastosStateForPortfolioSwitch() {
    _gastosDataLoaded = false
    _gastosHasPendingChanges = false
    currentGastosData = null
}

function bindGastosPersistenceGuards() {
    if (gastosPersistenceBound) {
        return
    }

    gastosPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!_gastosHasPendingChanges || !currentGastosYear || !currentGastosData || !_gastosDataLoaded) {
            return
        }

        syncGastosDataFromTables()
        saveGastosYear(currentGastosYear, currentGastosData, { keepalive: true }).catch((error) => {
            console.error("Error al guardar gastos al cerrar la ventana:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (!_gastosHasPendingChanges || document.visibilityState !== "hidden" || !currentGastosYear || !currentGastosData || !_gastosDataLoaded) {
            return
        }

        syncGastosDataFromTables()
        saveGastosYear(currentGastosYear, currentGastosData, { keepalive: true }).catch((error) => {
            console.error("Error al guardar gastos al cambiar de ventana:", error)
        })
    })
}
