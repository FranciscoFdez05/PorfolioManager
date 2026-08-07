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
let recurrentesFilter = "todas"
let recurrentesSearch = ""

// Cada frecuencia indica cada cuántos meses se repite el cobro.
const RECURRENTE_FRECUENCIAS = [
    { key: "mensual", label: "Mensual", short: "Mensual", meses: 1 },
    { key: "bimestral", label: "Bimestral (cada 2 meses)", short: "Bimestral", meses: 2 },
    { key: "trimestral", label: "Trimestral (cada 3 meses)", short: "Trimestral", meses: 3 },
    { key: "cuatrimestral", label: "Cuatrimestral (cada 4 meses)", short: "Cuatrimestral", meses: 4 },
    { key: "semestral", label: "Semestral (cada 6 meses)", short: "Semestral", meses: 6 },
    { key: "anual", label: "Anual", short: "Anual", meses: 12 }
]

function getRecurrenteFrecuencia(key) {
    return RECURRENTE_FRECUENCIAS.find((f) => f.key === key) || RECURRENTE_FRECUENCIAS[0]
}

function normalizeRecurrenteDia(value) {
    const day = parseInt(String(value ?? "").trim(), 10)
    return Number.isInteger(day) && day >= 1 && day <= 31 ? String(day) : ""
}

function normalizeRecurrente(row = {}) {
    const meses = {}
    INGRESOS_MONTHS.forEach((month) => {
        meses[month.key] = String(row.meses?.[month.key] || "")
    })

    return {
        nombre: String(row.nombre || ""),
        categoria: String(row.categoria || ""),
        importe: String(row.importe || ""),
        frecuencia: getRecurrenteFrecuencia(row.frecuencia).key,
        diaCobro: normalizeRecurrenteDia(row.diaCobro),
        mesInicio: INGRESOS_MONTHS.some((month) => month.key === row.mesInicio) ? row.mesInicio : "enero",
        activa: row.activa === undefined ? true : Boolean(row.activa),
        nota: String(row.nota || ""),
        meses
    }
}

function getRecurrentes() {
    return (currentIngresosData?.recurrentes || []).map(normalizeRecurrente)
}

// Reparte el importe por los meses del año según la frecuencia (desde enero).
function computeRecurrenteMeses(importeRaw, frecuenciaKey) {
    const step = getRecurrenteFrecuencia(frecuenciaKey).meses
    const value = String(importeRaw || "").trim() ? formatCellEuroValue(importeRaw) : ""

    return Object.fromEntries(INGRESOS_MONTHS.map((month, index) => {
        const isCharged = value && index % step === 0
        return [month.key, isCharged ? value : ""]
    }))
}

// Importe de un cobro. Si no está guardado, se usa el del último mes cobrado,
// que es el que refleja el importe actual cuando la ganancia sube o baja.
function getRecurrenteCobro(row) {
    if (String(row.importe || "").trim()) {
        return parseEuroNumber(row.importe)
    }

    const charged = getRecurrenteChargedMonths(row)
    return charged.length ? charged[charged.length - 1].amount : 0
}

// Ingreso mensual equivalente: el importe del cobro repartido entre los meses
// que abarca su frecuencia (en una mensual coincide con el importe por cobro).
function getRecurrenteMonthlyAmount(row) {
    return getRecurrenteCobro(row) / getRecurrenteFrecuencia(row.frecuencia).meses
}

function getRecurrenteChargedMonths(row) {
    return INGRESOS_MONTHS
        .map((month, index) => ({ ...month, index, amount: parseEuroNumber(row.meses?.[month.key] || "") }))
        .filter((month) => month.amount !== 0)
}

function getRecurrenteAnnualAmount(row) {
    return INGRESOS_MONTHS.reduce((sum, month) => sum + parseEuroNumber(row.meses?.[month.key] || ""), 0)
}

// Próximo cobro dentro del año mostrado (o el primero del año si ya pasaron todos).
function getRecurrenteNextCharge(row, year = currentIngresosYear) {
    const charged = getRecurrenteChargedMonths(row)
    if (!charged.length) {
        return null
    }

    const yearNumber = Number(year)
    if (!Number.isInteger(yearNumber)) {
        return null
    }

    const day = Number(row.diaCobro || 1) || 1
    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const buildDate = (monthIndex) => {
        const lastDay = new Date(yearNumber, monthIndex + 1, 0).getDate()
        return new Date(yearNumber, monthIndex, Math.min(day, lastDay))
    }

    const upcoming = charged
        .map((month) => buildDate(month.index))
        .find((date) => date >= today)

    const date = upcoming || buildDate(charged[0].index)
    const daysLeft = Math.round((date - today) / 86400000)

    return { date, daysLeft, isPast: !upcoming }
}

function formatRecurrenteDate(date) {
    return `${date.getDate()} ${INGRESOS_MONTHS[date.getMonth()].label.toLowerCase()}`
}

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

function openIngresosCreateModal({ title, bodyHtml, onSubmit, onReady, submitLabel = "Guardar", modalClass = "" }) {
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
    onReady?.(modal)
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
    openRecurrenteFormModal(-1)
}

function buildRecurrenteFormHtml(row) {
    const frecuenciaOptions = RECURRENTE_FRECUENCIAS
        .map((f) => `<option value="${f.key}"${f.key === row.frecuencia ? " selected" : ""}>${f.label}</option>`)
        .join("")

    const diaOptions = Array.from({ length: 31 }, (_, i) => i + 1)
        .map((day) => `<option value="${day}"${String(day) === row.diaCobro ? " selected" : ""}>Día ${day}</option>`)
        .join("")

    const categoriaOptions = getAvailableIngresosTypes()
        .map((type) => `<option value="${escapeIngresosHtml(type)}"></option>`)
        .join("")

    const monthsHtml = INGRESOS_MONTHS.map((month) => `
        <div class="recMonthField">
            <label class="recMonthLabel" for="ingresosRecurrente-${month.key}">${month.label}</label>
            <input id="ingresosRecurrente-${month.key}" class="assetModalInput recMonthInput" data-rec-month="${month.key}"
                   type="text" inputmode="decimal" value="${escapeIngresosHtml(row.meses?.[month.key] || "")}" placeholder="—">
        </div>
    `).join("")

    return `
        <div class="recFormGrid">
            <div class="ingresosCreateModalField recFormFieldWide">
                <label class="assetModalLabel" for="ingresosRecurrenteNombre">Concepto</label>
                <input id="ingresosRecurrenteNombre" class="assetModalInput" type="text"
                       value="${escapeIngresosHtml(row.nombre || "")}" placeholder="Ej: Salario, Alquiler cobrado o Dividendos">
            </div>
            <div class="ingresosCreateModalField">
                <label class="assetModalLabel" for="ingresosRecurrenteCategoria">Categoría</label>
                <input id="ingresosRecurrenteCategoria" class="assetModalInput" type="text" list="ingresosRecurrenteCategoriaList"
                       value="${escapeIngresosHtml(row.categoria || "")}" placeholder="Opcional">
                <datalist id="ingresosRecurrenteCategoriaList">${categoriaOptions}</datalist>
            </div>
            <div class="ingresosCreateModalField">
                <label class="assetModalLabel" for="ingresosRecurrenteImporte">Importe por cobro</label>
                <input id="ingresosRecurrenteImporte" class="assetModalInput" type="text" inputmode="decimal"
                       value="${escapeIngresosHtml(row.importe || "")}" placeholder="0,00 €">
            </div>
            <div class="ingresosCreateModalField">
                <label class="assetModalLabel" for="ingresosRecurrenteFrecuencia">Frecuencia</label>
                <select id="ingresosRecurrenteFrecuencia" class="assetModalSelect">${frecuenciaOptions}</select>
            </div>
            <div class="ingresosCreateModalField">
                <label class="assetModalLabel" for="ingresosRecurrenteDia">Día de cobro</label>
                <select id="ingresosRecurrenteDia" class="assetModalSelect">
                    <option value="">Sin definir</option>
                    ${diaOptions}
                </select>
            </div>
            <div class="ingresosCreateModalField">
                <label class="assetModalLabel" for="ingresosRecurrenteEstado">Estado</label>
                <select id="ingresosRecurrenteEstado" class="assetModalSelect">
                    <option value="activa"${row.activa ? " selected" : ""}>Activa</option>
                    <option value="pausada"${row.activa ? "" : " selected"}>Pausada</option>
                </select>
            </div>
            <div class="ingresosCreateModalField recFormFieldWide">
                <label class="assetModalLabel" for="ingresosRecurrenteNota">Nota</label>
                <input id="ingresosRecurrenteNota" class="assetModalInput" type="text"
                       value="${escapeIngresosHtml(row.nota || "")}" placeholder="Opcional: pagador, cuenta, contrato…">
            </div>
        </div>

        <p class="recFormPreview" id="ingresosRecurrentePreview"></p>

        <div class="recFormMonths">
            <div class="recFormMonthsHead">
                <span class="recFormMonthsTitle">Importes por mes</span>
                <button type="button" class="recGhostBtn" id="ingresosRecurrenteRecalcBtn">Recalcular desde el importe</button>
            </div>
            <p class="recFormMonthsHint">Se rellenan solos con el importe y la frecuencia. Edita un mes para ajustarlo a mano.</p>
            <div class="recMonthsGrid">${monthsHtml}</div>
        </div>
    `
}

function bindRecurrenteFormModal(modal, { autoFill }) {
    const importeInput = modal.querySelector("#ingresosRecurrenteImporte")
    const frecuenciaSelect = modal.querySelector("#ingresosRecurrenteFrecuencia")
    const diaSelect = modal.querySelector("#ingresosRecurrenteDia")
    const preview = modal.querySelector("#ingresosRecurrentePreview")
    const monthInputs = [...modal.querySelectorAll("[data-rec-month]")]

    const readMeses = () => Object.fromEntries(monthInputs.map((input) => [input.dataset.recMonth, input.value]))

    const updatePreview = () => {
        const meses = readMeses()
        const total = INGRESOS_MONTHS.reduce((sum, month) => sum + parseEuroNumber(meses[month.key] || ""), 0)
        const cobros = INGRESOS_MONTHS.filter((month) => parseEuroNumber(meses[month.key] || "") !== 0).length

        if (!cobros) {
            preview.textContent = "Sin cobros configurados este año."
            return
        }

        const dia = normalizeRecurrenteDia(diaSelect.value)
        const diaText = dia ? ` · se cobra el día ${dia}` : ""
        preview.textContent = `${cobros} ${cobros === 1 ? "cobro" : "cobros"} en ${currentIngresosYear} · ${formatEuro(total)} al año · ${formatEuro(total / 12)} al mes de media${diaText}`
    }

    const refillMonths = ({ force = false } = {}) => {
        const computed = computeRecurrenteMeses(importeInput.value, frecuenciaSelect.value)
        monthInputs.forEach((input) => {
            if (!force && input.dataset.recDirty === "true") {
                return
            }
            input.value = computed[input.dataset.recMonth]
            delete input.dataset.recDirty
        })
        updatePreview()
    }

    monthInputs.forEach((input) => {
        if (!autoFill && input.value.trim()) {
            input.dataset.recDirty = "true"
        }
        input.addEventListener("input", () => {
            input.dataset.recDirty = "true"
            updatePreview()
        })
        input.addEventListener("blur", () => {
            input.value = input.value.trim() ? formatCellEuroValue(input.value) : ""
            updatePreview()
        })
    })

    importeInput.addEventListener("input", () => refillMonths())
    frecuenciaSelect.addEventListener("change", () => refillMonths())
    diaSelect.addEventListener("change", updatePreview)
    modal.querySelector("#ingresosRecurrenteRecalcBtn")?.addEventListener("click", () => refillMonths({ force: true }))

    if (autoFill) {
        refillMonths()
    } else {
        updatePreview()
    }
}

function openRecurrenteFormModal(rowIndex = -1) {
    const isEdit = rowIndex >= 0
    const existing = isEdit ? currentIngresosData?.recurrentes?.[rowIndex] : null

    if (isEdit && !existing) {
        return
    }

    const row = normalizeRecurrente(existing || {})

    openIngresosCreateModal({
        title: isEdit ? "Editar ganancia recurrente" : "Nueva ganancia recurrente",
        modalClass: "ingresosCreateModalWide recFormModal",
        bodyHtml: buildRecurrenteFormHtml(row),
        submitLabel: isEdit ? "Guardar cambios" : "Añadir ganancia",
        onReady: (modal) => bindRecurrenteFormModal(modal, { autoFill: !isEdit }),
        onSubmit: async ({ getValue, setFeedback, modal }) => {
            const nombre = sanitizeIngresoTypeLabel(getValue("ingresosRecurrenteNombre"))
            const meses = Object.fromEntries(
                [...modal.querySelectorAll("[data-rec-month]")].map((input) => {
                    const rawValue = String(input.value).trim()
                    return [input.dataset.recMonth, rawValue ? formatCellEuroValue(rawValue) : ""]
                })
            )
            const hasAnyAmount = INGRESOS_MONTHS.some((month) => parseEuroNumber(meses[month.key]) !== 0)

            if (!nombre) {
                setFeedback("Introduce el concepto de la ganancia.", true)
                return false
            }

            // El nombre identifica la ganancia en la base de datos: no puede repetirse.
            const isDuplicate = (currentIngresosData?.recurrentes || []).some((item, index) =>
                index !== rowIndex && normalizeComparableIngresoText(item?.nombre || "") === normalizeComparableIngresoText(nombre)
            )

            if (isDuplicate) {
                setFeedback("Ya existe una ganancia recurrente con ese nombre.", true)
                return false
            }

            if (!hasAnyAmount) {
                setFeedback("Introduce un importe o rellena al menos un mes.", true)
                return false
            }

            const importeRaw = String(getValue("ingresosRecurrenteImporte")).trim()
            const nextRow = {
                nombre,
                categoria: sanitizeIngresoTypeLabel(getValue("ingresosRecurrenteCategoria")),
                importe: importeRaw ? formatCellEuroValue(importeRaw) : "",
                frecuencia: getRecurrenteFrecuencia(getValue("ingresosRecurrenteFrecuencia")).key,
                diaCobro: normalizeRecurrenteDia(getValue("ingresosRecurrenteDia")),
                activa: getValue("ingresosRecurrenteEstado") !== "pausada",
                nota: String(getValue("ingresosRecurrenteNota")).trim(),
                meses
            }

            syncIngresosDataFromTables()

            if (isEdit) {
                currentIngresosData.recurrentes[rowIndex] = nextRow
            } else {
                currentIngresosData.recurrentes.push(nextRow)
            }

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
    recurrentesFilter = "todas"
    recurrentesSearch = ""
    bindIngresosPersistenceGuards()
    window.flushPendingPageChanges = flushIngresosPendingChanges
    await renderIngresosYear(currentIngresosYear)
    bindIngresosEvents()
    bindRecurrentesViewEvents()

    const annualBody = document.getElementById("ingresosAnnualBody")
    const movementsBody = document.getElementById("ingresosMovementsBody")

    if (annualBody && !annualBody.dataset.bound) {
        annualBody.dataset.bound = "true"
        annualBody.addEventListener("click", handleIngresosAnnualDeleteClick)
        annualBody.addEventListener("click", handleIngresosAnnualEditClick)
        annualBody.addEventListener("click", handleIngresosAnnualMoveClick)
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
    const menuTrigger = document.querySelector("#ingresosActionsMenu .pageActionsMenuTrigger")
    const menuDropdown = document.getElementById("ingresosActionsDropdown")
    if (menuTrigger && menuDropdown && !menuTrigger.dataset.bound) {
        menuTrigger.dataset.bound = "true"
        menuTrigger.addEventListener("click", (e) => {
            e.stopPropagation()
            menuDropdown.classList.toggle("open")
        })
        document.addEventListener("click", () => menuDropdown.classList.remove("open"))
        menuDropdown.addEventListener("click", () => menuDropdown.classList.remove("open"))
    }

    const addYearButton = document.getElementById("addIngresosYearBtn")
    const deleteYearButton = document.getElementById("deleteIngresosYearBtn")
    const addRowButton = document.getElementById("addIngresoRowBtn")
    const addRecurrenteRowButton = document.getElementById("addRecurrenteRowBtn")
    const addIngresoTypeRowButton = document.getElementById("addIngresoTypeRowBtn")
    const exportButton = document.getElementById("downloadIngresosCsvBtn")

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

    if (exportButton && !exportButton.dataset.bound) {
        exportButton.dataset.bound = "true"
        exportButton.addEventListener("click", downloadIngresosCsv)
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

function downloadIngresosCsv() {
    if (!currentIngresosData) {
        alert("No hay datos de ingresos para exportar.")
        return
    }

    const rows = []
    const incomeTotals = buildMonthlyIncomeTotals()
    const availableTypes = getAvailableIngresosTypes()

    if (currentIngresosView === "month") {
        const monthRows = [...(currentIngresosData.months?.[currentIngresosMonth]?.rows || [])]
            .sort((a, b) => ingresoParseDate(a.fecha) - ingresoParseDate(b.fecha))

        monthRows.forEach((row) => {
            rows.push({
                Fecha: row.fecha || "",
                Nombre: row.nombre || "",
                Tipo: normalizeIngresoTipo(row.tipo || ""),
                Cantidad: parseEuroNumber(row.cantidad || "")
            })
        })

        const filename = `ingresos-${currentIngresosYear}-${currentIngresosMonth}.csv`
        downloadCsvFile(filename, rows)
        return
    }

    if (currentIngresosView === "recurrentes") {
        getRecurrentes().forEach((row) => {
            const anual = getRecurrenteAnnualAmount(row)
            rows.push({
                Concepto: row.nombre,
                Categoría: row.categoria,
                Importe: getRecurrenteCobro(row),
                Frecuencia: getRecurrenteFrecuencia(row.frecuencia).short,
                "Día de cobro": row.diaCobro,
                "Ingreso mensual": getRecurrenteMonthlyAmount(row),
                "Ingreso anual": anual,
                Estado: row.activa ? "Activa" : "Pausada",
                Nota: row.nota
            })
        })

        downloadCsvFile(`recurrentes-${currentIngresosYear}.csv`, rows)
        return
    }

    currentIngresosData.recurrentes.forEach((row) => {
        const monthlyData = { Sección: "Recurrentes", Nombre: row.nombre || "" }
        INGRESOS_MONTHS.forEach((month) => {
            monthlyData[month.label] = parseEuroNumber(row.meses?.[month.key] || "")
        })
        rows.push(monthlyData)
    })

    availableTypes.forEach((type) => {
        const monthlyData = { Sección: "Ingresos", Tipo: type }
        INGRESOS_MONTHS.forEach((month) => {
            monthlyData[month.label] = incomeTotals[type]?.[month.key] || 0
        })
        rows.push(monthlyData)
    })

    const filename = `ingresos-${currentIngresosYear}.csv`
    downloadCsvFile(filename, rows)
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

    const totalRecurrentes = currentIngresosData.recurrentes.length
    currentIngresosData.recurrentes.forEach((rawRow, rowIndex) => {
        const row = normalizeRecurrente(rawRow)
        const meta = [
            getRecurrenteFrecuencia(row.frecuencia).short,
            row.diaCobro ? `día ${row.diaCobro}` : ""
        ].filter(Boolean).join(" · ")
        const tr = document.createElement("tr")
        if (!row.activa) {
            tr.classList.add("ingresosRecurrentePaused")
        }
        tr.innerHTML = `
            <td class="recNameCell">
                <span class="recNameMain">${escapeIngresosHtml(row.nombre || "")}</span>
                <span class="recNameMeta">${escapeIngresosHtml(meta)}${row.activa ? "" : " · pausada"}</span>
            </td>
            ${INGRESOS_MONTHS.map((month) => `
                <td>${formatCellEuroValue(row.meses?.[month.key] || "")}</td>
            `).join("")}
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem" data-ingresos-move-manual-row="${rowIndex}" data-ingresos-move-dir="up" ${rowIndex === 0 ? "disabled" : ""}>▲ Subir</button>
                        <button type="button" class="rowMenuItem" data-ingresos-move-manual-row="${rowIndex}" data-ingresos-move-dir="down" ${rowIndex === totalRecurrentes - 1 ? "disabled" : ""}>▼ Bajar</button>
                        <hr>
                        <button type="button" class="rowMenuItem assetRowEditBtn ingresosAnnualEditBtn" data-annual-edit-manual="${rowIndex}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn" data-ingresos-delete-manual-row="${rowIndex}">Eliminar</button>
                    </div>
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

    const totalIngresosTypes = availableTypes.length
    availableTypes.forEach((type, rowIndex) => {
        const tr = document.createElement("tr")
        tr.innerHTML = `
            <td>${escapeIngresosHtml(type)}</td>
            ${INGRESOS_MONTHS.map((month) => `<td>${incomeTotals[type][month.key] ? formatEuro(incomeTotals[type][month.key]) : "- €"}</td>`).join("")}
            <td class="rowActionsCell">
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem" data-ingresos-move-type-row="${rowIndex}" data-ingresos-move-dir="up" ${rowIndex === 0 ? "disabled" : ""}>▲ Subir</button>
                        <button type="button" class="rowMenuItem" data-ingresos-move-type-row="${rowIndex}" data-ingresos-move-dir="down" ${rowIndex === totalIngresosTypes - 1 ? "disabled" : ""}>▼ Bajar</button>
                        <hr>
                        <button type="button" class="rowMenuItem assetRowEditBtn ingresosAnnualEditBtn" data-annual-edit-type="${rowIndex}">Editar</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn" data-ingresos-delete-type-row="${rowIndex}">Eliminar</button>
                    </div>
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
    openRecurrenteFormModal(rowIndex)
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

function handleIngresosAnnualMoveClick(event) {
    const moveManualBtn = event.target.closest("[data-ingresos-move-manual-row]")
    if (moveManualBtn) {
        const rowIndex = Number(moveManualBtn.dataset.ingresosMoveManualRow)
        const dir = moveManualBtn.dataset.ingresosMoveDir
        const arr = currentIngresosData.recurrentes
        if (dir === "up" && rowIndex > 0) {
            ;[arr[rowIndex - 1], arr[rowIndex]] = [arr[rowIndex], arr[rowIndex - 1]]
        } else if (dir === "down" && rowIndex < arr.length - 1) {
            ;[arr[rowIndex], arr[rowIndex + 1]] = [arr[rowIndex + 1], arr[rowIndex]]
        } else {
            return
        }
        renderCurrentIngresosView()
        scheduleIngresosAutosave()
        return
    }

    const moveTypeBtn = event.target.closest("[data-ingresos-move-type-row]")
    if (!moveTypeBtn) return
    const rowIndex = Number(moveTypeBtn.dataset.ingresosMoveTypeRow)
    const dir = moveTypeBtn.dataset.ingresosMoveDir
    if (dir === "up" && rowIndex > 0) {
        ;[sharedIngresosTypes[rowIndex - 1], sharedIngresosTypes[rowIndex]] = [sharedIngresosTypes[rowIndex], sharedIngresosTypes[rowIndex - 1]]
    } else if (dir === "down" && rowIndex < sharedIngresosTypes.length - 1) {
        ;[sharedIngresosTypes[rowIndex], sharedIngresosTypes[rowIndex + 1]] = [sharedIngresosTypes[rowIndex + 1], sharedIngresosTypes[rowIndex]]
    } else {
        return
    }
    if (currentIngresosData) currentIngresosData.ingresosTipos = [...sharedIngresosTypes]
    persistSharedIngresosTypes().then(() => {
        renderCurrentIngresosView()
        scheduleIngresosAutosave()
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

    document.getElementById("ingresosRecurrentesTabBtn")
        ?.classList.toggle("active", currentIngresosView === "recurrentes")
}

function renderCurrentIngresosView() {
    const annualWrapper = document.getElementById("ingresosAnnualWrapper")
    const movementsWrapper = document.getElementById("ingresosMovementsWrapper")
    const recurrentesWrapper = document.getElementById("ingresosRecurrentesWrapper")
    const monthHeader = document.getElementById("ingresosMonthHeader")
    const actions = document.getElementById("ingresosActions")
    if (!annualWrapper || !movementsWrapper || !monthHeader || !actions) return

    const showView = (view) => {
        annualWrapper.classList.toggle("hidden", view !== "year")
        movementsWrapper.classList.toggle("hidden", view !== "month")
        recurrentesWrapper?.classList.toggle("hidden", view !== "recurrentes")
        monthHeader.classList.toggle("hidden", view !== "month")
        actions.classList.toggle("hidden", view !== "month")
    }

    if (currentIngresosView === "recurrentes") {
        renderRecurrentesView()
        showView("recurrentes")
        return
    }

    if (currentIngresosView === "year") {
        renderIngresosAnnualTable()
        renderIngresosKpiStrip()
        showView("year")
        return
    }

    renderIngresosMonthTable()
    showView("month")
}

// ── Vista Ganancias recurrentes ─────────────────────────────────────────────

function renderRecurrentesView() {
    renderRecurrentesSummary()
    renderRecurrentesTable()
}

function renderRecurrentesSummary() {
    const container = document.getElementById("recSummary")
    if (!container) return

    const rows = getRecurrentes()
    const activas = rows.filter((row) => row.activa)
    const totalAnual = activas.reduce((sum, row) => sum + getRecurrenteAnnualAmount(row), 0)

    const nextCharges = activas
        .map((row) => ({ row, next: getRecurrenteNextCharge(row) }))
        .filter((item) => item.next && !item.next.isPast)
        .sort((a, b) => a.next.date - b.next.date)

    const nextItem = nextCharges[0]
    const nextValue = nextItem ? formatRecurrenteDate(nextItem.next.date) : "—"
    const nextHint = nextItem
        ? `${nextItem.row.nombre} · ${nextItem.next.daysLeft === 0 ? "hoy" : `en ${nextItem.next.daysLeft} día${nextItem.next.daysLeft === 1 ? "" : "s"}`}`
        : "Sin cobros pendientes"

    const pausadas = rows.length - activas.length
    const cards = [
        { label: "Ingreso mensual medio", value: formatEuro(totalAnual / 12), hint: `Media de ${currentIngresosYear}, con cambios de importe` },
        { label: "Ingreso anual", value: formatEuro(totalAnual), hint: "Solo ganancias activas" },
        { label: "Ganancias activas", value: String(activas.length), hint: `${pausadas} pausada${pausadas === 1 ? "" : "s"}` },
        { label: "Próximo cobro", value: nextValue, hint: nextHint }
    ]

    container.innerHTML = cards.map((card) => `
        <article class="recCard">
            <p class="recCardLabel">${escapeIngresosHtml(card.label)}</p>
            <p class="recCardValue">${escapeIngresosHtml(card.value)}</p>
            <p class="recCardHint">${escapeIngresosHtml(card.hint)}</p>
        </article>
    `).join("")
}

function getFilteredRecurrentes() {
    const search = normalizeComparableIngresoText(recurrentesSearch)

    return getRecurrentes()
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => {
            if (recurrentesFilter === "activas" && !row.activa) return false
            if (recurrentesFilter === "pausadas" && row.activa) return false
            if (!search) return true
            return normalizeComparableIngresoText(`${row.nombre} ${row.categoria}`).includes(search)
        })
}

function renderRecurrentesTable() {
    const body = document.getElementById("recTableBody")
    const foot = document.getElementById("recTableFoot")
    if (!body || !foot) return

    const items = getFilteredRecurrentes()
    const totalRows = (currentIngresosData?.recurrentes || []).length

    if (!items.length) {
        const message = totalRows
            ? "Ninguna ganancia recurrente coincide con el filtro."
            : "Aún no hay ganancias recurrentes. Añade la primera para llevar el control de tus ingresos fijos."
        body.innerHTML = `<tr class="recEmptyRow"><td colspan="9">${message}</td></tr>`
        foot.innerHTML = ""
        return
    }

    body.innerHTML = items.map(({ row, index }) => {
        const anual = getRecurrenteAnnualAmount(row)
        const frecuencia = getRecurrenteFrecuencia(row.frecuencia)
        const next = getRecurrenteNextCharge(row)
        const nextText = next && !next.isPast ? formatRecurrenteDate(next.date) : "—"
        const nextHint = next && !next.isPast
            ? (next.daysLeft === 0 ? "hoy" : `en ${next.daysLeft} d`)
            : ""
        const cobro = getRecurrenteCobro(row)

        return `
            <tr class="${row.activa ? "" : "recRowPaused"}">
                <td class="recColName">
                    <span class="recNameMain">${escapeIngresosHtml(row.nombre)}</span>
                    ${row.categoria ? `<span class="recNameMeta">${escapeIngresosHtml(row.categoria)}</span>` : ""}
                    ${row.nota ? `<span class="recNameNote" title="${escapeIngresosHtml(row.nota)}">${escapeIngresosHtml(row.nota)}</span>` : ""}
                </td>
                <td>${cobro ? formatEuro(cobro) : "—"}</td>
                <td><span class="recBadge recBadge-${frecuencia.key}">${frecuencia.short}</span></td>
                <td>${row.diaCobro ? `Día ${escapeIngresosHtml(row.diaCobro)}` : "—"}</td>
                <td>${escapeIngresosHtml(nextText)}${nextHint ? `<span class="recNextHint">${nextHint}</span>` : ""}</td>
                <td>${formatEuro(getRecurrenteMonthlyAmount(row))}</td>
                <td>${formatEuro(anual)}</td>
                <td><span class="recState ${row.activa ? "recStateActive" : "recStatePaused"}">${row.activa ? "Activa" : "Pausada"}</span></td>
                <td class="rowActionsCell">
                    <div class="rowMenu">
                        <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                        <div class="rowMenuDropdown">
                            <button type="button" class="rowMenuItem" data-rec-edit="${index}">Editar</button>
                            <button type="button" class="rowMenuItem" data-rec-toggle="${index}">${row.activa ? "Pausar" : "Reactivar"}</button>
                            <button type="button" class="rowMenuItem" data-rec-duplicate="${index}">Duplicar</button>
                            <hr>
                            <button type="button" class="rowMenuItem rowMenuItemDanger" data-rec-delete="${index}">Eliminar</button>
                        </div>
                    </div>
                </td>
            </tr>
        `
    }).join("")

    const visibleAnual = items.reduce((sum, { row }) => sum + getRecurrenteAnnualAmount(row), 0)
    const visibleMensual = items.reduce((sum, { row }) => sum + getRecurrenteMonthlyAmount(row), 0)
    foot.innerHTML = `
        <tr class="recFootRow">
            <td colspan="5">Total (${items.length} ${items.length === 1 ? "ganancia" : "ganancias"})</td>
            <td>${formatEuro(visibleMensual)}</td>
            <td>${formatEuro(visibleAnual)}</td>
            <td colspan="2"></td>
        </tr>
    `
}

function handleRecurrentesActionClick(event) {
    const editBtn = event.target.closest("[data-rec-edit]")
    if (editBtn) {
        openRecurrenteFormModal(Number(editBtn.dataset.recEdit))
        return
    }

    const toggleBtn = event.target.closest("[data-rec-toggle]")
    if (toggleBtn) {
        const index = Number(toggleBtn.dataset.recToggle)
        const row = currentIngresosData?.recurrentes?.[index]
        if (!row) return

        const normalized = normalizeRecurrente(row)
        currentIngresosData.recurrentes[index] = { ...normalized, activa: !normalized.activa }
        renderCurrentIngresosView()
        scheduleIngresosAutosave()
        return
    }

    const duplicateBtn = event.target.closest("[data-rec-duplicate]")
    if (duplicateBtn) {
        const index = Number(duplicateBtn.dataset.recDuplicate)
        const row = currentIngresosData?.recurrentes?.[index]
        if (!row) return

        const copy = normalizeRecurrente(row)
        const taken = (currentIngresosData.recurrentes || []).map((item) => normalizeComparableIngresoText(item?.nombre || ""))
        let candidate = `${copy.nombre} (copia)`
        let counter = 2
        while (taken.includes(normalizeComparableIngresoText(candidate))) {
            candidate = `${copy.nombre} (copia ${counter})`
            counter += 1
        }
        copy.nombre = candidate
        currentIngresosData.recurrentes.splice(index + 1, 0, copy)
        renderCurrentIngresosView()
        scheduleIngresosAutosave()
        return
    }

    const deleteBtn = event.target.closest("[data-rec-delete]")
    if (!deleteBtn) return

    const index = Number(deleteBtn.dataset.recDelete)
    const row = currentIngresosData?.recurrentes?.[index]
    if (!row) return

    openConfirmModal({
        title: "Eliminar ganancia recurrente",
        message: `Vas a eliminar "${normalizeRecurrente(row).nombre}". ¿Quieres continuar?`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        onConfirm: async () => {
            currentIngresosData.recurrentes.splice(index, 1)
            renderCurrentIngresosView()
            scheduleIngresosAutosave()
        }
    })
}

function bindRecurrentesViewEvents() {
    const tabButton = document.getElementById("ingresosRecurrentesTabBtn")
    if (tabButton && !tabButton.dataset.bound) {
        tabButton.dataset.bound = "true"
        tabButton.addEventListener("click", async () => {
            await persistCurrentIngresosData()
            currentIngresosView = "recurrentes"
            renderIngresosMonthTabs()
            renderIngresosYearButtons()
            renderCurrentIngresosView()
        })
    }

    const addButton = document.getElementById("recAddBtn")
    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => openRecurrenteFormModal(-1))
    }

    const searchInput = document.getElementById("recSearchInput")
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = "true"
        searchInput.addEventListener("input", () => {
            recurrentesSearch = searchInput.value
            renderRecurrentesTable()
        })
    }

    const filterGroup = document.getElementById("recFilterGroup")
    if (filterGroup && !filterGroup.dataset.bound) {
        filterGroup.dataset.bound = "true"
        filterGroup.addEventListener("click", (event) => {
            const chip = event.target.closest("[data-rec-filter]")
            if (!chip) return

            recurrentesFilter = chip.dataset.recFilter
            filterGroup.querySelectorAll("[data-rec-filter]").forEach((item) => {
                item.classList.toggle("active", item === chip)
            })
            renderRecurrentesTable()
        })
    }

    const tableBody = document.getElementById("recTableBody")
    if (tableBody && !tableBody.dataset.bound) {
        tableBody.dataset.bound = "true"
        tableBody.addEventListener("click", handleRecurrentesActionClick)
    }
}

function renderIngresosKpiStrip() {
    const strip = document.getElementById("ingresosKpiStrip")
    if (!strip || !currentIngresosData) return

    const incomeTotals = buildMonthlyIncomeTotals()
    const availableTypes = getAvailableIngresosTypes()

    const monthTotals = INGRESOS_MONTHS.map((m) => {
        const recTotal = (currentIngresosData.recurrentes || [])
            .reduce((s, r) => s + parseEuroNumber(r.meses?.[m.key] || ""), 0)
        const typesTotal = availableTypes.reduce((s, t) => s + (incomeTotals[t]?.[m.key] || 0), 0)
        return { key: m.key, label: m.label, total: recTotal + typesTotal }
    })

    const totalAnio = monthTotals.reduce((s, m) => s + m.total, 0)
    const nonZeroMonths = monthTotals.filter((m) => m.total > 0)
    const promedio = nonZeroMonths.length > 0 ? totalAnio / nonZeroMonths.length : 0

    const best = monthTotals.reduce((best, m) => m.total > best.total ? m : best, monthTotals[0])

    const currentMonthKey = INGRESOS_MONTHS[new Date().getMonth()].key
    const currentMonthLabel = INGRESOS_MONTHS[new Date().getMonth()].label
    const mesActualData = monthTotals.find((m) => m.key === currentMonthKey)
    const mesActual = mesActualData ? mesActualData.total : 0

    const setKpi = (valId, val, subId, subText) => {
        const el = document.getElementById(valId)
        if (el) el.textContent = val
        const sub = subId && document.getElementById(subId)
        if (sub) sub.textContent = subText || ""
    }

    setKpi("ingresosKpiTotalAnio", formatEuro(totalAnio))
    setKpi("ingresosKpiPromedio", formatEuro(promedio), null, "")
    setKpi("ingresosKpiMejorMes", formatEuro(best.total), "ingresosKpiMejorMesLabel", best.label)
    setKpi("ingresosKpiMesActual", formatEuro(mesActual), "ingresosKpiMesActualLabel", currentMonthLabel)

    strip.classList.remove("hidden")
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
    totalTr.innerHTML = `<td colspan="3">Total</td><td class="numCell">${formatEuro(total)}</td><td class="rowActionsCell"></td>`
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
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn ingresosRowEditBtn" data-row-index="${rowIndex}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn ingresosRowDeleteBtn" data-row-index="${rowIndex}">Eliminar</button>
                </div>
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
            showError("No se pudieron guardar los ingresos", error)
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
