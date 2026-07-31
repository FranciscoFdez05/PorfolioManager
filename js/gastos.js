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
let gastosMensualidadesCollapsed = false
let mensualidadesFilter = "todas"
let mensualidadesSearch = ""

// Cada frecuencia indica cada cuántos meses se repite el cargo.
const MENSUALIDAD_FRECUENCIAS = [
    { key: "mensual", label: "Mensual", short: "Mensual", meses: 1 },
    { key: "bimestral", label: "Bimestral (cada 2 meses)", short: "Bimestral", meses: 2 },
    { key: "trimestral", label: "Trimestral (cada 3 meses)", short: "Trimestral", meses: 3 },
    { key: "cuatrimestral", label: "Cuatrimestral (cada 4 meses)", short: "Cuatrimestral", meses: 4 },
    { key: "semestral", label: "Semestral (cada 6 meses)", short: "Semestral", meses: 6 },
    { key: "anual", label: "Anual", short: "Anual", meses: 12 }
]

function getMensualidadFrecuencia(key) {
    return MENSUALIDAD_FRECUENCIAS.find((f) => f.key === key) || MENSUALIDAD_FRECUENCIAS[0]
}

function normalizeMensualidad(row = {}) {
    const meses = {}
    GASTOS_MONTHS.forEach((month) => {
        meses[month.key] = String(row.meses?.[month.key] || "")
    })

    return {
        nombre: String(row.nombre || ""),
        categoria: String(row.categoria || ""),
        importe: String(row.importe || ""),
        frecuencia: getMensualidadFrecuencia(row.frecuencia).key,
        diaCobro: normalizeMensualidadDia(row.diaCobro),
        mesInicio: GASTOS_MONTHS.some((month) => month.key === row.mesInicio) ? row.mesInicio : "enero",
        activa: row.activa === undefined ? true : Boolean(row.activa),
        nota: String(row.nota || ""),
        meses
    }
}

function normalizeMensualidadDia(value) {
    const day = parseInt(String(value ?? "").trim(), 10)
    return Number.isInteger(day) && day >= 1 && day <= 31 ? String(day) : ""
}

function getMensualidades() {
    return (currentGastosData?.mensualidades || []).map(normalizeMensualidad)
}

// Reparte el importe por los meses del año según la frecuencia (desde enero).
function computeMensualidadMeses(importeRaw, frecuenciaKey) {
    const step = getMensualidadFrecuencia(frecuenciaKey).meses
    const value = String(importeRaw || "").trim() ? formatCellEuroValue(importeRaw) : ""

    return Object.fromEntries(GASTOS_MONTHS.map((month, index) => {
        const isCharged = value && index % step === 0
        return [month.key, isCharged ? value : ""]
    }))
}

// Importe de un cargo. Si no está guardado, se usa el del último mes cobrado,
// que es el que refleja el precio actual cuando la suscripción sube o baja.
function getMensualidadCargo(row) {
    if (String(row.importe || "").trim()) {
        return parseEuroNumber(row.importe)
    }

    const charged = getMensualidadChargedMonths(row)
    return charged.length ? charged[charged.length - 1].amount : 0
}

// Coste mensual equivalente: el importe del cargo repartido entre los meses
// que abarca su frecuencia (en una mensual coincide con el importe por cargo).
function getMensualidadMonthlyCost(row) {
    return getMensualidadCargo(row) / getMensualidadFrecuencia(row.frecuencia).meses
}

function getMensualidadChargedMonths(row) {
    return GASTOS_MONTHS
        .map((month, index) => ({ ...month, index, amount: parseEuroNumber(row.meses?.[month.key] || "") }))
        .filter((month) => month.amount !== 0)
}

function getMensualidadAnnualCost(row) {
    return GASTOS_MONTHS.reduce((sum, month) => sum + parseEuroNumber(row.meses?.[month.key] || ""), 0)
}

// Próxima renovación dentro del año mostrado (o el primer cargo si el año no es el actual).
function getMensualidadNextCharge(row, year = currentGastosYear) {
    const charged = getMensualidadChargedMonths(row)
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

function formatMensualidadDate(date) {
    return `${date.getDate()} ${GASTOS_MONTHS[date.getMonth()].label.toLowerCase()}`
}


// Las mensualidades se agrupan en la tabla anual y en Métricas bajo esta categoría.
const MENSUALIDADES_CATEGORIA = "Mensualidades"
const MENSUALIDADES_CATEGORIA_NORM = "mensualidades"

// Total del mes para la categoría: las mensualidades más, si existiera, los
// movimientos sueltos etiquetados como "Mensualidades".
function getMensualidadesCategoryTotal(monthKey, expenseTotals) {
    const fromMensualidades = (currentGastosData?.mensualidades || [])
        .reduce((sum, row) => sum + parseEuroNumber(row.meses?.[monthKey] || ""), 0)

    const taggedType = getAvailableGastosTypes()
        .find((type) => normalizeComparableGastoText(type) === MENSUALIDADES_CATEGORIA_NORM)

    return fromMensualidades + (taggedType ? (expenseTotals?.[taggedType]?.[monthKey] || 0) : 0)
}

function isGastoTipoHidden(type) {
    const hidden = window._gastosHiddenTipos || []
    return hidden.includes(normalizeComparableGastoText(type))
}

async function persistGastosMensualidadesCollapsed(collapsed) {
    const hidden = collapsed ? ["Mensualidades"] : []
    window._gastosHiddenMensualidades = hidden
    try {
        await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gastosHiddenMensualidades: hidden })
        })
    } catch (e) {
        console.error("No se pudo guardar el estado de mensualidades:", e)
    }
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

function openGastosCreateModal({ title, bodyHtml, onSubmit, onReady, submitLabel = "Guardar", modalClass = "" }) {
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

    onReady?.(modal)

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
    openMensualidadFormModal(-1)
}

function buildMensualidadFormHtml(row) {
    const frecuenciaOptions = MENSUALIDAD_FRECUENCIAS
        .map((f) => `<option value="${f.key}"${f.key === row.frecuencia ? " selected" : ""}>${f.label}</option>`)
        .join("")

    const diaOptions = Array.from({ length: 31 }, (_, i) => i + 1)
        .map((day) => `<option value="${day}"${String(day) === row.diaCobro ? " selected" : ""}>Día ${day}</option>`)
        .join("")

    const categoriaOptions = getAvailableGastosTypes()
        .map((type) => `<option value="${escapeGastosHtml(type)}"></option>`)
        .join("")

    const monthsHtml = GASTOS_MONTHS.map((month) => `
        <div class="mensMonthField">
            <label class="mensMonthLabel" for="gastosMensualidad-${month.key}">${month.label}</label>
            <input id="gastosMensualidad-${month.key}" class="assetModalInput mensMonthInput" data-mens-month="${month.key}"
                   type="text" inputmode="decimal" value="${escapeGastosHtml(row.meses?.[month.key] || "")}" placeholder="—">
        </div>
    `).join("")

    return `
        <div class="mensFormGrid">
            <div class="gastosCreateModalField mensFormFieldWide">
                <label class="assetModalLabel" for="gastosMensualidadNombre">Nombre del servicio</label>
                <input id="gastosMensualidadNombre" class="assetModalInput" type="text"
                       value="${escapeGastosHtml(row.nombre || "")}" placeholder="Ej: Alquiler, Spotify o Gimnasio">
            </div>
            <div class="gastosCreateModalField">
                <label class="assetModalLabel" for="gastosMensualidadCategoria">Categoría</label>
                <input id="gastosMensualidadCategoria" class="assetModalInput" type="text" list="gastosMensualidadCategoriaList"
                       value="${escapeGastosHtml(row.categoria || "")}" placeholder="Opcional">
                <datalist id="gastosMensualidadCategoriaList">${categoriaOptions}</datalist>
            </div>
            <div class="gastosCreateModalField">
                <label class="assetModalLabel" for="gastosMensualidadImporte">Importe por cargo</label>
                <input id="gastosMensualidadImporte" class="assetModalInput" type="text" inputmode="decimal"
                       value="${escapeGastosHtml(row.importe || "")}" placeholder="0,00 €">
            </div>
            <div class="gastosCreateModalField">
                <label class="assetModalLabel" for="gastosMensualidadFrecuencia">Frecuencia</label>
                <select id="gastosMensualidadFrecuencia" class="assetModalSelect">${frecuenciaOptions}</select>
            </div>
            <div class="gastosCreateModalField">
                <label class="assetModalLabel" for="gastosMensualidadDia">Día de renovación</label>
                <select id="gastosMensualidadDia" class="assetModalSelect">
                    <option value="">Sin definir</option>
                    ${diaOptions}
                </select>
            </div>
            <div class="gastosCreateModalField">
                <label class="assetModalLabel" for="gastosMensualidadEstado">Estado</label>
                <select id="gastosMensualidadEstado" class="assetModalSelect">
                    <option value="activa"${row.activa ? " selected" : ""}>Activa</option>
                    <option value="pausada"${row.activa ? "" : " selected"}>Pausada</option>
                </select>
            </div>
            <div class="gastosCreateModalField mensFormFieldWide">
                <label class="assetModalLabel" for="gastosMensualidadNota">Nota</label>
                <input id="gastosMensualidadNota" class="assetModalInput" type="text"
                       value="${escapeGastosHtml(row.nota || "")}" placeholder="Opcional: plan, cuenta, forma de pago…">
            </div>
        </div>

        <p class="mensFormPreview" id="gastosMensualidadPreview"></p>

        <div class="mensFormMonths">
            <div class="mensFormMonthsHead">
                <span class="mensFormMonthsTitle">Importes por mes</span>
                <button type="button" class="mensGhostBtn" id="gastosMensualidadRecalcBtn">Recalcular desde el importe</button>
            </div>
            <p class="mensFormMonthsHint">Se rellenan solos con el importe y la frecuencia. Edita un mes para ajustarlo a mano.</p>
            <div class="mensMonthsGrid">${monthsHtml}</div>
        </div>
    `
}

function bindMensualidadFormModal(modal, { autoFill }) {
    const importeInput = modal.querySelector("#gastosMensualidadImporte")
    const frecuenciaSelect = modal.querySelector("#gastosMensualidadFrecuencia")
    const diaSelect = modal.querySelector("#gastosMensualidadDia")
    const preview = modal.querySelector("#gastosMensualidadPreview")
    const monthInputs = [...modal.querySelectorAll("[data-mens-month]")]

    const readMeses = () => Object.fromEntries(monthInputs.map((input) => [input.dataset.mensMonth, input.value]))

    const updatePreview = () => {
        const meses = readMeses()
        const total = GASTOS_MONTHS.reduce((sum, month) => sum + parseEuroNumber(meses[month.key] || ""), 0)
        const cargos = GASTOS_MONTHS.filter((month) => parseEuroNumber(meses[month.key] || "") !== 0).length

        if (!cargos) {
            preview.textContent = "Sin cargos configurados este año."
            return
        }

        const dia = normalizeMensualidadDia(diaSelect.value)
        const diaText = dia ? ` · se renueva el día ${dia}` : ""
        preview.textContent = `${cargos} ${cargos === 1 ? "cargo" : "cargos"} en ${currentGastosYear} · ${formatEuro(total)} al año · ${formatEuro(total / 12)} al mes de media${diaText}`
    }

    const refillMonths = ({ force = false } = {}) => {
        const computed = computeMensualidadMeses(importeInput.value, frecuenciaSelect.value)
        monthInputs.forEach((input) => {
            if (!force && input.dataset.mensDirty === "true") {
                return
            }
            input.value = computed[input.dataset.mensMonth]
            delete input.dataset.mensDirty
        })
        updatePreview()
    }

    monthInputs.forEach((input) => {
        if (!autoFill && input.value.trim()) {
            input.dataset.mensDirty = "true"
        }
        input.addEventListener("input", () => {
            input.dataset.mensDirty = "true"
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
    modal.querySelector("#gastosMensualidadRecalcBtn")?.addEventListener("click", () => refillMonths({ force: true }))

    if (autoFill) {
        refillMonths()
    } else {
        updatePreview()
    }
}

function openMensualidadFormModal(rowIndex = -1) {
    const isEdit = rowIndex >= 0
    const existing = isEdit ? currentGastosData?.mensualidades?.[rowIndex] : null

    if (isEdit && !existing) {
        return
    }

    const row = normalizeMensualidad(existing || {})

    openGastosCreateModal({
        title: isEdit ? "Editar mensualidad" : "Nueva mensualidad",
        modalClass: "gastosCreateModalWide mensFormModal",
        bodyHtml: buildMensualidadFormHtml(row),
        submitLabel: isEdit ? "Guardar cambios" : "Añadir mensualidad",
        onReady: (modal) => bindMensualidadFormModal(modal, { autoFill: !isEdit }),
        onSubmit: async ({ getValue, setFeedback, modal }) => {
            const nombre = sanitizeGastoTypeLabel(getValue("gastosMensualidadNombre"))
            const meses = Object.fromEntries(
                [...modal.querySelectorAll("[data-mens-month]")].map((input) => {
                    const rawValue = String(input.value).trim()
                    return [input.dataset.mensMonth, rawValue ? formatCellEuroValue(rawValue) : ""]
                })
            )
            const hasAnyAmount = GASTOS_MONTHS.some((month) => parseEuroNumber(meses[month.key]) !== 0)

            if (!nombre) {
                setFeedback("Introduce el nombre del servicio.", true)
                return false
            }

            // El nombre identifica la mensualidad en la base de datos: no puede repetirse.
            const isDuplicate = (currentGastosData?.mensualidades || []).some((item, index) =>
                index !== rowIndex && normalizeComparableGastoText(item?.nombre || "") === normalizeComparableGastoText(nombre)
            )

            if (isDuplicate) {
                setFeedback("Ya existe una mensualidad con ese nombre.", true)
                return false
            }

            if (!hasAnyAmount) {
                setFeedback("Introduce un importe o rellena al menos un mes.", true)
                return false
            }

            const importeRaw = String(getValue("gastosMensualidadImporte")).trim()
            const nextRow = {
                nombre,
                categoria: sanitizeGastoTypeLabel(getValue("gastosMensualidadCategoria")),
                importe: importeRaw ? formatCellEuroValue(importeRaw) : "",
                frecuencia: getMensualidadFrecuencia(getValue("gastosMensualidadFrecuencia")).key,
                diaCobro: normalizeMensualidadDia(getValue("gastosMensualidadDia")),
                activa: getValue("gastosMensualidadEstado") !== "pausada",
                nota: String(getValue("gastosMensualidadNota")).trim(),
                meses
            }

            syncGastosDataFromTables()

            if (isEdit) {
                currentGastosData.mensualidades[rowIndex] = nextRow
            } else {
                currentGastosData.mensualidades.push(nextRow)
            }

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
    mensualidadesFilter = "todas"
    mensualidadesSearch = ""
    gastosMensualidadesCollapsed = (window._gastosHiddenMensualidades || []).includes("Mensualidades")
    bindGastosPersistenceGuards()
    window.flushPendingPageChanges = flushGastosPendingChanges
    await renderGastosYear(currentGastosYear)
    bindGastosEvents()
    bindMensualidadesViewEvents()

    const annualBody = document.getElementById("gastosAnnualBody")
    const movementsBody = document.getElementById("gastosMovementsBody")

    if (annualBody && !annualBody.dataset.bound) {
        annualBody.dataset.bound = "true"
        annualBody.addEventListener("click", handleGastosAnnualDeleteClick)
        annualBody.addEventListener("click", handleGastosAnnualEditClick)
        annualBody.addEventListener("click", handleGastosEyeClick)
        annualBody.addEventListener("click", handleGastosMensualidadesToggleClick)
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
    const exportButton = document.getElementById("downloadGastosCsvBtn")

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

    if (exportButton && !exportButton.dataset.bound) {
        exportButton.dataset.bound = "true"
        exportButton.addEventListener("click", downloadGastosCsv)
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

function downloadGastosCsv() {
    if (!currentGastosData) {
        alert("No hay datos de gastos para exportar.")
        return
    }

    const rows = []
    const expenseTotals = buildMonthlyExpenseTotals()
    const availableTypes = getAvailableGastosTypes()

    if (currentGastosView === "month") {
        const monthRows = [...(currentGastosData.months?.[currentGastosMonth]?.rows || [])]
            .sort((a, b) => gastoParseDate(a.fecha) - gastoParseDate(b.fecha))

        monthRows.forEach((row) => {
            rows.push({
                Fecha: row.fecha || "",
                Nombre: row.nombre || "",
                Tipo: normalizeGastoTipo(row.tipo || ""),
                Cantidad: parseEuroNumber(row.cantidad || "")
            })
        })

        const filename = `gastos-${currentGastosYear}-${currentGastosMonth}.csv`
        downloadCsvFile(filename, rows)
        return
    }

    if (currentGastosView === "mensualidades") {
        getMensualidades().forEach((row) => {
            const anual = getMensualidadAnnualCost(row)
            rows.push({
                Nombre: row.nombre,
                Categoría: row.categoria,
                Importe: getMensualidadCargo(row),
                Frecuencia: getMensualidadFrecuencia(row.frecuencia).short,
                "Día de renovación": row.diaCobro,
                "Coste mensual": getMensualidadMonthlyCost(row),
                "Coste anual": anual,
                Estado: row.activa ? "Activa" : "Pausada",
                Nota: row.nota
            })
        })

        downloadCsvFile(`mensualidades-${currentGastosYear}.csv`, rows)
        return
    }

    currentGastosData.mensualidades.forEach((row) => {
        const monthlyData = { Sección: "Mensualidades", Nombre: row.nombre || "" }
        GASTOS_MONTHS.forEach((month) => {
            monthlyData[month.label] = parseEuroNumber(row.meses?.[month.key] || "")
        })
        rows.push(monthlyData)
    })

    availableTypes.forEach((type) => {
        const monthlyData = { Sección: "Gastos", Tipo: type }
        GASTOS_MONTHS.forEach((month) => {
            monthlyData[month.label] = expenseTotals[type]?.[month.key] || 0
        })
        rows.push(monthlyData)
    })

    const filename = `gastos-${currentGastosYear}.csv`
    downloadCsvFile(filename, rows)
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
    // "Mensualidades" es una categoría propia: si además existe como tipo de
    // gasto suelto, sus movimientos se suman a esa categoría en vez de duplicar fila.
    const visibleTypes = getAvailableGastosTypes()
        .filter((type) => normalizeComparableGastoText(type) !== MENSUALIDADES_CATEGORIA_NORM)

    const mensualidadesMonthTotals = Object.fromEntries(GASTOS_MONTHS.map((month) => [
        month.key,
        getMensualidadesCategoryTotal(month.key, expenseTotals)
    ]))

    const gastosRow = document.createElement("tr")
    gastosRow.className = "gastosSectionRow"
    gastosRow.innerHTML = `<td colspan="14">Gastos</td>`
    annualBody.appendChild(gastosRow)

    const mensualidadesRow = document.createElement("tr")
    mensualidadesRow.className = "gastosCategoryRow"
    const mensSectionHidden = isGastoTipoHidden(MENSUALIDADES_CATEGORIA)
    mensualidadesRow.innerHTML = `
        <td class="gastosSectionToggle" data-gastos-toggle-mens="1">${gastosMensualidadesCollapsed ? "▸" : "▾"} ${MENSUALIDADES_CATEGORIA}</td>
        ${GASTOS_MONTHS.map((month) => `<td>${mensualidadesMonthTotals[month.key] ? formatEuro(mensualidadesMonthTotals[month.key]) : "- €"}</td>`).join("")}
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem gastosEyeBtn${mensSectionHidden ? "" : " active"}" data-gastos-eye-mens="1">👁 ${mensSectionHidden ? "Mostrar" : "Ocultar"}</button>
                </div>
            </div>
        </td>`
    annualBody.appendChild(mensualidadesRow)

    if (!gastosMensualidadesCollapsed) {
        const totalMensualidades = currentGastosData.mensualidades.length
        currentGastosData.mensualidades.forEach((rawRow, rowIndex) => {
            const row = normalizeMensualidad(rawRow)
            const meta = [
                getMensualidadFrecuencia(row.frecuencia).short,
                row.diaCobro ? `día ${row.diaCobro}` : ""
            ].filter(Boolean).join(" · ")
            const tr = document.createElement("tr")
            tr.classList.add("gastosMensualidadDetail")
            if (!row.activa) {
                tr.classList.add("gastosMensualidadPaused")
            }
            tr.innerHTML = `
                <td class="mensNameCell">
                    <span class="mensNameMain">${escapeGastosHtml(row.nombre || "")}</span>
                    <span class="mensNameMeta">${escapeGastosHtml(meta)}${row.activa ? "" : " · pausada"}</span>
                </td>
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
    }

    const typesWithData = visibleTypes.filter((type) =>
        GASTOS_MONTHS.some((month) => expenseTotals[type][month.key] > 0)
    )
    const typesEmpty = visibleTypes.filter((type) =>
        GASTOS_MONTHS.every((month) => !expenseTotals[type][month.key])
    )

    // Los índices de las acciones apuntan a la lista completa de tipos guardados.
    const storedTypes = getAvailableGastosTypes()
    const totalTypes = storedTypes.length
    const renderTypeRow = (type) => {
        const rowIndex = storedTypes.indexOf(type)
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

    // Las mensualidades son una categoría más, así que el total del año ya las incluye.
    const grandTotalRow = document.createElement("tr")
    grandTotalRow.className = "gastosTotalRow"
    grandTotalRow.innerHTML = `
        <td>TOTAL</td>
        ${GASTOS_MONTHS.map((month) => {
            const totalGastos = visibleTypes.reduce((sum, type) => sum + expenseTotals[type][month.key], 0)
            return `<td>${formatEuro(mensualidadesMonthTotals[month.key] + totalGastos)}</td>`
        }).join("")}
        <td></td>
    `
    annualBody.appendChild(grandTotalRow)
}

function openMensualidadEditModal(rowIndex) {
    openMensualidadFormModal(rowIndex)
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

function handleGastosMensualidadesToggleClick(event) {
    if (!event.target.closest("[data-gastos-toggle-mens]")) return
    gastosMensualidadesCollapsed = !gastosMensualidadesCollapsed
    persistGastosMensualidadesCollapsed(gastosMensualidadesCollapsed)
    renderGastosAnnualTable()
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

    document.getElementById("gastosMensualidadesTabBtn")
        ?.classList.toggle("active", currentGastosView === "mensualidades")
}

function renderCurrentGastosView() {
    const annualWrapper = document.getElementById("gastosAnnualWrapper")
    const movementsWrapper = document.getElementById("gastosMovementsWrapper")
    const mensualidadesWrapper = document.getElementById("gastosMensualidadesWrapper")
    const monthHeader = document.getElementById("gastosMonthHeader")
    const actions = document.getElementById("gastosActions")

    if (!annualWrapper || !movementsWrapper || !monthHeader || !actions) {
        return
    }

    const showView = (view) => {
        annualWrapper.classList.toggle("hidden", view !== "year")
        movementsWrapper.classList.toggle("hidden", view !== "month")
        mensualidadesWrapper?.classList.toggle("hidden", view !== "mensualidades")
        monthHeader.classList.toggle("hidden", view !== "month")
        actions.classList.toggle("hidden", view !== "month")
    }

    if (currentGastosView === "mensualidades") {
        renderMensualidadesView()
        showView("mensualidades")
        return
    }

    if (currentGastosView === "year") {
        renderGastosAnnualTable()
        showView("year")
        return
    }

    renderGastosMonthTable()
    showView("month")
}

// ── Vista Mensualidades ─────────────────────────────────────────────────────

function renderMensualidadesView() {
    renderMensualidadesSummary()
    renderMensualidadesTable()
}

function renderMensualidadesSummary() {
    const container = document.getElementById("mensSummary")

    if (!container) {
        return
    }

    const rows = getMensualidades()
    const activas = rows.filter((row) => row.activa)
    const totalAnual = activas.reduce((sum, row) => sum + getMensualidadAnnualCost(row), 0)

    const nextCharges = activas
        .map((row) => ({ row, next: getMensualidadNextCharge(row) }))
        .filter((item) => item.next && !item.next.isPast)
        .sort((a, b) => a.next.date - b.next.date)

    const nextItem = nextCharges[0]
    const nextValue = nextItem ? formatMensualidadDate(nextItem.next.date) : "—"
    const nextHint = nextItem
        ? `${nextItem.row.nombre} · ${nextItem.next.daysLeft === 0 ? "hoy" : `en ${nextItem.next.daysLeft} día${nextItem.next.daysLeft === 1 ? "" : "s"}`}`
        : "Sin cargos pendientes"

    const cards = [
        { label: "Coste mensual medio", value: formatEuro(totalAnual / 12), hint: `Media de ${currentGastosYear}, con cambios de precio` },
        { label: "Coste anual", value: formatEuro(totalAnual), hint: "Solo mensualidades activas" },
        { label: "Suscripciones activas", value: String(activas.length), hint: `${rows.length - activas.length} pausada${rows.length - activas.length === 1 ? "" : "s"}` },
        { label: "Próxima renovación", value: nextValue, hint: nextHint }
    ]

    container.innerHTML = cards.map((card) => `
        <article class="mensCard">
            <p class="mensCardLabel">${escapeGastosHtml(card.label)}</p>
            <p class="mensCardValue">${escapeGastosHtml(card.value)}</p>
            <p class="mensCardHint">${escapeGastosHtml(card.hint)}</p>
        </article>
    `).join("")
}

function getFilteredMensualidades() {
    const search = normalizeComparableGastoText(mensualidadesSearch)

    return getMensualidades()
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => {
            if (mensualidadesFilter === "activas" && !row.activa) {
                return false
            }

            if (mensualidadesFilter === "pausadas" && row.activa) {
                return false
            }

            if (!search) {
                return true
            }

            return normalizeComparableGastoText(`${row.nombre} ${row.categoria}`).includes(search)
        })
}

function renderMensualidadesTable() {
    const body = document.getElementById("mensTableBody")
    const foot = document.getElementById("mensTableFoot")

    if (!body || !foot) {
        return
    }

    const items = getFilteredMensualidades()
    const totalRows = (currentGastosData?.mensualidades || []).length

    if (!items.length) {
        const message = totalRows
            ? "Ninguna mensualidad coincide con el filtro."
            : "Aún no hay mensualidades. Añade la primera para llevar el control de tus suscripciones."
        body.innerHTML = `<tr class="mensEmptyRow"><td colspan="9">${message}</td></tr>`
        foot.innerHTML = ""
        return
    }

    body.innerHTML = items.map(({ row, index }) => {
        const anual = getMensualidadAnnualCost(row)
        const frecuencia = getMensualidadFrecuencia(row.frecuencia)
        const next = getMensualidadNextCharge(row)
        const nextText = next && !next.isPast ? formatMensualidadDate(next.date) : "—"
        const nextHint = next && !next.isPast
            ? (next.daysLeft === 0 ? "hoy" : `en ${next.daysLeft} d`)
            : ""
        const cargo = getMensualidadCargo(row)

        return `
            <tr class="${row.activa ? "" : "mensRowPaused"}">
                <td class="mensColName">
                    <span class="mensNameMain">${escapeGastosHtml(row.nombre)}</span>
                    ${row.categoria ? `<span class="mensNameMeta">${escapeGastosHtml(row.categoria)}</span>` : ""}
                    ${row.nota ? `<span class="mensNameNote" title="${escapeGastosHtml(row.nota)}">${escapeGastosHtml(row.nota)}</span>` : ""}
                </td>
                <td>${cargo ? formatEuro(cargo) : "—"}</td>
                <td><span class="mensBadge mensBadge-${frecuencia.key}">${frecuencia.short}</span></td>
                <td>${row.diaCobro ? `Día ${escapeGastosHtml(row.diaCobro)}` : "—"}</td>
                <td>${escapeGastosHtml(nextText)}${nextHint ? `<span class="mensNextHint">${nextHint}</span>` : ""}</td>
                <td>${formatEuro(getMensualidadMonthlyCost(row))}</td>
                <td>${formatEuro(anual)}</td>
                <td><span class="mensState ${row.activa ? "mensStateActive" : "mensStatePaused"}">${row.activa ? "Activa" : "Pausada"}</span></td>
                <td class="rowActionsCell">
                    <div class="rowMenu">
                        <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                        <div class="rowMenuDropdown">
                            <button type="button" class="rowMenuItem" data-mens-edit="${index}">Editar</button>
                            <button type="button" class="rowMenuItem" data-mens-toggle="${index}">${row.activa ? "Pausar" : "Reactivar"}</button>
                            <button type="button" class="rowMenuItem" data-mens-duplicate="${index}">Duplicar</button>
                            <hr>
                            <button type="button" class="rowMenuItem rowMenuItemDanger" data-mens-delete="${index}">Eliminar</button>
                        </div>
                    </div>
                </td>
            </tr>
        `
    }).join("")

    const visibleAnual = items.reduce((sum, { row }) => sum + getMensualidadAnnualCost(row), 0)
    const visibleMensual = items.reduce((sum, { row }) => sum + getMensualidadMonthlyCost(row), 0)
    foot.innerHTML = `
        <tr class="mensFootRow">
            <td colspan="5">Total (${items.length} ${items.length === 1 ? "mensualidad" : "mensualidades"})</td>
            <td>${formatEuro(visibleMensual)}</td>
            <td>${formatEuro(visibleAnual)}</td>
            <td colspan="2"></td>
        </tr>
    `
}

function handleMensualidadesActionClick(event) {
    const editBtn = event.target.closest("[data-mens-edit]")
    if (editBtn) {
        openMensualidadFormModal(Number(editBtn.dataset.mensEdit))
        return
    }

    const toggleBtn = event.target.closest("[data-mens-toggle]")
    if (toggleBtn) {
        const index = Number(toggleBtn.dataset.mensToggle)
        const row = currentGastosData?.mensualidades?.[index]
        if (!row) {
            return
        }

        const normalized = normalizeMensualidad(row)
        currentGastosData.mensualidades[index] = { ...normalized, activa: !normalized.activa }
        renderCurrentGastosView()
        scheduleGastosAutosave()
        return
    }

    const duplicateBtn = event.target.closest("[data-mens-duplicate]")
    if (duplicateBtn) {
        const index = Number(duplicateBtn.dataset.mensDuplicate)
        const row = currentGastosData?.mensualidades?.[index]
        if (!row) {
            return
        }

        const copy = normalizeMensualidad(row)
        const taken = (currentGastosData.mensualidades || []).map((item) => normalizeComparableGastoText(item?.nombre || ""))
        let candidate = `${copy.nombre} (copia)`
        let counter = 2
        while (taken.includes(normalizeComparableGastoText(candidate))) {
            candidate = `${copy.nombre} (copia ${counter})`
            counter += 1
        }
        copy.nombre = candidate
        currentGastosData.mensualidades.splice(index + 1, 0, copy)
        renderCurrentGastosView()
        scheduleGastosAutosave()
        return
    }

    const deleteBtn = event.target.closest("[data-mens-delete]")
    if (!deleteBtn) {
        return
    }

    const index = Number(deleteBtn.dataset.mensDelete)
    const row = currentGastosData?.mensualidades?.[index]

    if (!row) {
        return
    }

    openConfirmModal({
        title: "Eliminar mensualidad",
        message: `Vas a eliminar "${normalizeMensualidad(row).nombre}". ¿Quieres continuar?`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        onConfirm: async () => {
            currentGastosData.mensualidades.splice(index, 1)
            renderCurrentGastosView()
            scheduleGastosAutosave()
        }
    })
}

function bindMensualidadesViewEvents() {
    const tabButton = document.getElementById("gastosMensualidadesTabBtn")
    if (tabButton && !tabButton.dataset.bound) {
        tabButton.dataset.bound = "true"
        tabButton.addEventListener("click", async () => {
            await persistCurrentGastosData()
            currentGastosView = "mensualidades"
            renderGastosMonthTabs()
            renderGastosYearButtons()
            renderCurrentGastosView()
        })
    }

    const addButton = document.getElementById("mensAddBtn")
    if (addButton && !addButton.dataset.bound) {
        addButton.dataset.bound = "true"
        addButton.addEventListener("click", () => openMensualidadFormModal(-1))
    }

    const searchInput = document.getElementById("mensSearchInput")
    if (searchInput && !searchInput.dataset.bound) {
        searchInput.dataset.bound = "true"
        searchInput.addEventListener("input", () => {
            mensualidadesSearch = searchInput.value
            renderMensualidadesTable()
        })
    }

    const filterGroup = document.getElementById("mensFilterGroup")
    if (filterGroup && !filterGroup.dataset.bound) {
        filterGroup.dataset.bound = "true"
        filterGroup.addEventListener("click", (event) => {
            const chip = event.target.closest("[data-mens-filter]")
            if (!chip) {
                return
            }

            mensualidadesFilter = chip.dataset.mensFilter
            filterGroup.querySelectorAll("[data-mens-filter]").forEach((item) => {
                item.classList.toggle("active", item === chip)
            })
            renderMensualidadesTable()
        })
    }

    const tableBody = document.getElementById("mensTableBody")
    if (tableBody && !tableBody.dataset.bound) {
        tableBody.dataset.bound = "true"
        tableBody.addEventListener("click", handleMensualidadesActionClick)
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
