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
// Las mensualidades pausadas se ocultan en la tabla anual salvo que se active
// la opción del menú de la categoría (sus importes siguen contando en el total).
let gastosMostrarPausadas = false
let mensualidadesFilter = "todas"
let mensualidadesSearch = ""
// La vista Mensualidades se ve como tabla o como calendario del año. El día
// seleccionado ("mes-día") es lo que detalla el panel lateral del calendario.
let mensualidadesTab = "tabla"
let mensCalendarSelection = null

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
        importe: String(row.importe || ""),
        frecuencia: getMensualidadFrecuencia(row.frecuencia).key,
        diaCobro: normalizeMensualidadDia(row.diaCobro),
        diasCobro: normalizeMensualidadDias(row.diasCobro),
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

// Excepciones al día de renovación, mes a mes. Solo se guardan los meses que se
// salen de la norma: el resto se cobra el día por defecto de la mensualidad, y
// repetirlo doce veces sería inventar un dato que nadie ha escrito.
function normalizeMensualidadDias(value) {
    let source = value

    // La API lo devuelve ya como objeto, pero un export antiguo o una copia
    // pegada a mano pueden traer el JSON crudo de la columna.
    if (typeof source === "string") {
        try {
            source = source.trim() ? JSON.parse(source) : {}
        } catch {
            return {}
        }
    }

    if (!source || typeof source !== "object") {
        return {}
    }

    const dias = {}
    GASTOS_MONTHS.forEach((month) => {
        const day = normalizeMensualidadDia(source[month.key])
        if (day) {
            dias[month.key] = day
        }
    })
    return dias
}

// Día en que se cobra un mes concreto: su excepción si la tiene, y si no el día
// por defecto. Devuelve "" cuando no hay ninguno de los dos.
function getMensualidadDiaMes(row, monthKey) {
    return normalizeMensualidadDia(row.diasCobro?.[monthKey]) || normalizeMensualidadDia(row.diaCobro)
}

// El día se recorta al último del mes: una renovación el 31 se cobra el 28 en
// febrero, no el 3 de marzo.
function buildMensualidadDate(year, monthIndex, day) {
    const lastDay = new Date(year, monthIndex + 1, 0).getDate()
    return new Date(year, monthIndex, Math.min(Math.max(day || 1, 1), lastDay))
}

function getGastosToday() {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today
}

function getMensualidades() {
    return (currentGastosData?.mensualidades || []).map(normalizeMensualidad)
}

// Reparte el importe por los meses del año según la frecuencia, empezando en
// el mes indicado: los anteriores quedan vacíos porque la suscripción aún no
// existía.
function computeMensualidadMeses(importeRaw, frecuenciaKey, startIndex = 0) {
    const step = getMensualidadFrecuencia(frecuenciaKey).meses
    const value = String(importeRaw || "").trim() ? formatCellEuroValue(importeRaw) : ""
    const from = Math.min(Math.max(startIndex, 0), GASTOS_MONTHS.length - 1)

    return Object.fromEntries(
        GASTOS_MONTHS.map((month, index) => {
            const isCharged = value && index >= from && (index - from) % step === 0
            return [month.key, isCharged ? value : ""]
        })
    )
}

// Mes en el que empieza a cobrarse una mensualidad nueva: si el año mostrado es
// el actual, el mes en curso (no se cobró antes de darla de alta); en cualquier
// otro año, enero.
function getMensualidadDefaultStartIndex(year = currentGastosYear) {
    const today = new Date()
    return Number(year) === today.getFullYear() ? today.getMonth() : 0
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
//
// Una pausada cuesta cero. Lo que no se va a cobrar no puede seguir sumando en
// el total de la tabla ni en la media del año: era justo lo que hacía parecer
// que se gastaban 100 € al mes en suscripciones cuando dos estaban paradas.
function getMensualidadMonthlyCost(row) {
    if (!row.activa) {
        return 0
    }

    return getMensualidadCargo(row) / getMensualidadFrecuencia(row.frecuencia).meses
}

// Importe del cargo tal y como se escribe en una celda, para rellenar meses.
function getMensualidadImporteTexto(row) {
    if (String(row.importe || "").trim()) {
        return formatCellEuroValue(row.importe)
    }

    const charged = getMensualidadChargedMonths(row)
    return charged.length ? formatCellEuroValue(row.meses[charged[charged.length - 1].key]) : ""
}

function getMensualidadChargedMonths(row) {
    return GASTOS_MONTHS.map((month, index) => ({
        ...month,
        index,
        amount: parseEuroNumber(row.meses?.[month.key] || "")
    })).filter((month) => month.amount !== 0)
}

function getMensualidadAnnualCost(row) {
    return GASTOS_MONTHS.reduce((sum, month) => sum + parseEuroNumber(row.meses?.[month.key] || ""), 0)
}

// Los cargos del año, uno por mes con importe: cuándo se cobra cada uno y
// cuánto. De aquí salen el próximo cobro y el calendario, así que el día por mes
// se resuelve en un único sitio.
function getMensualidadCargos(row, year = currentGastosYear) {
    const yearNumber = Number(year)
    if (!Number.isInteger(yearNumber)) {
        return []
    }

    return getMensualidadChargedMonths(row).map((month) => {
        const dia = getMensualidadDiaMes(row, month.key)
        return {
            ...month,
            dia,
            // Sin día definido el cargo se ordena como si fuera el 1, pero el
            // calendario lo saca aparte en vez de fingir una fecha exacta.
            sinDia: !dia,
            date: buildMensualidadDate(yearNumber, month.index, Number(dia || 1))
        }
    })
}

// Próxima renovación dentro del año mostrado (o el primer cargo si el año no es el actual).
function getMensualidadNextCharge(row, year = currentGastosYear) {
    const cargos = getMensualidadCargos(row, year)
    if (!cargos.length) {
        return null
    }

    const today = getGastosToday()
    const upcoming = cargos.find((cargo) => cargo.date >= today)
    const date = (upcoming || cargos[0]).date
    const daysLeft = Math.round((date - today) / 86400000)

    return { date, daysLeft, isPast: !upcoming }
}

// Mes a partir del cual una pausa deja de contar. En el año en curso es el mes
// actual, salvo que su cargo ya se haya pasado por el banco: lo que ya se pagó
// no se borra. En un año pasado no queda nada por delante; en uno futuro, todo.
function getMensualidadPauseIndex(row, year = currentGastosYear) {
    const today = getGastosToday()
    const yearNumber = Number(year)

    if (!Number.isInteger(yearNumber) || yearNumber > today.getFullYear()) {
        return 0
    }

    if (yearNumber < today.getFullYear()) {
        return GASTOS_MONTHS.length
    }

    const monthIndex = today.getMonth()
    const dia = Number(getMensualidadDiaMes(row, GASTOS_MONTHS[monthIndex].key) || 0)
    const yaCobrado = dia > 0 && buildMensualidadDate(yearNumber, monthIndex, dia) <= today

    return yaCobrado ? monthIndex + 1 : monthIndex
}

// Pausar no es solo una etiqueta: se vacían los importes de los meses que ya no
// se van a cobrar. Esos importes son lo que leen la tabla anual, Métricas y
// Ahorro, así que dejarlos puestos seguiría contando un gasto que no existe.
function pauseMensualidad(row) {
    const from = getMensualidadPauseIndex(row)
    const meses = { ...row.meses }

    GASTOS_MONTHS.forEach((month, index) => {
        if (index >= from) {
            meses[month.key] = ""
        }
    })

    return { ...row, activa: false, meses }
}

// Reactivar devuelve los cargos desde el mes en curso. La fase se cuenta desde
// el primer cargo que quedó en el año para que una trimestral no se descoloque
// al volver.
function resumeMensualidad(row) {
    const from = getMensualidadPauseIndex(row)
    const value = getMensualidadImporteTexto(row)
    const step = getMensualidadFrecuencia(row.frecuencia).meses
    const charged = getMensualidadChargedMonths(row)
    const phase = charged.length ? charged[0].index : from
    const meses = { ...row.meses }

    if (value) {
        GASTOS_MONTHS.forEach((month, index) => {
            if (index >= from && index >= phase && (index - phase) % step === 0) {
                meses[month.key] = value
            }
        })
    }

    return { ...row, activa: true, meses }
}

function formatMensualidadDate(date) {
    return `${date.getDate()} ${GASTOS_MONTHS[date.getMonth()].label.toLowerCase()}`
}

// DD-MM-AAAA, el mismo formato con el que se escriben las fechas de los
// movimientos de gastos, para que un CSV de cargos se pegue al lado sin traducir.
function formatGastoCargoDate(date) {
    const day = String(date.getDate()).padStart(2, "0")
    const month = String(date.getMonth() + 1).padStart(2, "0")
    return `${day}-${month}-${date.getFullYear()}`
}

// Las mensualidades se agrupan en la tabla anual y en Métricas bajo esta categoría.
const MENSUALIDADES_CATEGORIA = "Mensualidades"
const MENSUALIDADES_CATEGORIA_NORM = "mensualidades"

// Total del mes para la categoría: las mensualidades más, si existiera, los
// movimientos sueltos etiquetados como "Mensualidades".
function getMensualidadesCategoryTotal(monthKey, expenseTotals) {
    const fromMensualidades = (currentGastosData?.mensualidades || []).reduce(
        (sum, row) => sum + parseEuroNumber(row.meses?.[monthKey] || ""),
        0
    )

    const taggedType = getAvailableGastosTypes().find(
        (type) => normalizeComparableGastoText(type) === MENSUALIDADES_CATEGORIA_NORM
    )

    return fromMensualidades + (taggedType ? expenseTotals?.[taggedType]?.[monthKey] || 0 : 0)
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

async function persistGastosMostrarPausadas(mostrar) {
    window._gastosMostrarPausadas = mostrar
    try {
        await fetch("/api/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gastosMostrarPausadas: mostrar })
        })
    } catch (e) {
        console.error("No se pudo guardar la visibilidad de mensualidades pausadas:", e)
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
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
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
    const frecuenciaOptions = MENSUALIDAD_FRECUENCIAS.map(
        (f) => `<option value="${f.key}"${f.key === row.frecuencia ? " selected" : ""}>${f.label}</option>`
    ).join("")

    const diaOptions = Array.from({ length: 31 }, (_, i) => i + 1)
        .map((day) => `<option value="${day}"${String(day) === row.diaCobro ? " selected" : ""}>Día ${day}</option>`)
        .join("")

    const diaPlaceholder = row.diaCobro ? `Día ${row.diaCobro}` : "Día"

    const monthsHtml = GASTOS_MONTHS.map(
        (month) => `
        <div class="mensMonthField">
            <label class="mensMonthLabel" for="gastosMensualidad-${month.key}">${month.label}</label>
            <input id="gastosMensualidad-${month.key}" class="assetModalInput mensMonthInput" data-mens-month="${month.key}"
                   type="text" inputmode="decimal" value="${escapeGastosHtml(row.meses?.[month.key] || "")}" placeholder="—">
            <input class="assetModalInput mensMonthDayInput" data-mens-day="${month.key}" type="text"
                   inputmode="numeric" maxlength="2" aria-label="Día de cobro de ${month.label}"
                   value="${escapeGastosHtml(row.diasCobro?.[month.key] || "")}" placeholder="${escapeGastosHtml(diaPlaceholder)}">
        </div>
    `
    ).join("")

    return `
        <div class="mensFormGrid">
            <div class="gastosCreateModalField mensFormFieldWide">
                <label class="assetModalLabel" for="gastosMensualidadNombre">Nombre del servicio</label>
                <input id="gastosMensualidadNombre" class="assetModalInput" type="text"
                       value="${escapeGastosHtml(row.nombre || "")}" placeholder="Ej: Alquiler, Spotify o Gimnasio">
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
            <p class="mensFormMonthsHint">Se rellenan solos con el importe y la frecuencia. Edita un mes para ajustarlo a mano. El recuadro pequeño es el día de cobro de ese mes: déjalo vacío y se usa el día de renovación.</p>
            <div class="mensMonthsGrid mensMonthsGridDays">${monthsHtml}</div>
        </div>
    `
}

function bindMensualidadFormModal(modal, { autoFill, startIndex }) {
    const importeInput = modal.querySelector("#gastosMensualidadImporte")
    const frecuenciaSelect = modal.querySelector("#gastosMensualidadFrecuencia")
    const diaSelect = modal.querySelector("#gastosMensualidadDia")
    const estadoSelect = modal.querySelector("#gastosMensualidadEstado")
    const preview = modal.querySelector("#gastosMensualidadPreview")
    const monthInputs = [...modal.querySelectorAll("[data-mens-month]")]
    const dayInputs = [...modal.querySelectorAll("[data-mens-day]")]

    const readMeses = () => Object.fromEntries(monthInputs.map((input) => [input.dataset.mensMonth, input.value]))
    const readDias = () =>
        normalizeMensualidadDias(Object.fromEntries(dayInputs.map((input) => [input.dataset.mensDay, input.value])))

    // Fila a medio escribir, para lo que necesita saber cuándo cae el cargo de
    // un mes sin esperar a que se guarde.
    const readFormRow = () => ({
        importe: importeInput.value,
        frecuencia: frecuenciaSelect.value,
        diaCobro: normalizeMensualidadDia(diaSelect.value),
        diasCobro: readDias(),
        meses: readMeses()
    })

    const updatePreview = () => {
        const meses = readMeses()
        const total = GASTOS_MONTHS.reduce((sum, month) => sum + parseEuroNumber(meses[month.key] || ""), 0)
        const cargos = GASTOS_MONTHS.filter((month) => parseEuroNumber(meses[month.key] || "") !== 0).length

        if (!cargos) {
            preview.textContent =
                estadoSelect.value === "pausada"
                    ? "Pausada: no queda ningún cargo por cobrar este año."
                    : "Sin cargos configurados este año."
            return
        }

        const dia = normalizeMensualidadDia(diaSelect.value)
        const diaText = dia ? ` · se renueva el día ${dia}` : ""
        const excepciones = Object.keys(readDias()).length
        const excepcionesText = excepciones ? ` · ${excepciones} mes${excepciones === 1 ? "" : "es"} con otro día` : ""
        preview.textContent = `${cargos} ${cargos === 1 ? "cargo" : "cargos"} en ${currentGastosYear} · ${formatEuro(total)} al año · ${formatEuro(total / 12)} al mes de media${diaText}${excepcionesText}`
    }

    // El día por defecto se ve como marca de agua en cada mes, así que se
    // refresca al cambiarlo: es lo que se cobra donde no hay excepción.
    const updateDayPlaceholders = () => {
        const dia = normalizeMensualidadDia(diaSelect.value)
        dayInputs.forEach((input) => {
            input.placeholder = dia ? `Día ${dia}` : "Día"
        })
    }

    const refillMonths = ({ force = false, from = 0 } = {}) => {
        const computed = computeMensualidadMeses(importeInput.value, frecuenciaSelect.value, startIndex)
        monthInputs.forEach((input, index) => {
            if (index < from || (!force && input.dataset.mensDirty === "true")) {
                return
            }
            input.value = computed[input.dataset.mensMonth]
            delete input.dataset.mensDirty
        })
        updatePreview()
    }

    // Pausar desde el formulario hace lo mismo que pausar desde la tabla: vacía
    // los cargos que ya no se van a cobrar, a la vista y sin sorpresas.
    const applyEstado = () => {
        const from = getMensualidadPauseIndex(readFormRow())

        if (estadoSelect.value === "pausada") {
            monthInputs.forEach((input, index) => {
                if (index >= from) {
                    input.value = ""
                    delete input.dataset.mensDirty
                }
            })
            updatePreview()
            return
        }

        refillMonths({ force: true, from })
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

    dayInputs.forEach((input) => {
        input.addEventListener("input", () => {
            input.value = input.value.replace(/[^0-9]/g, "").slice(0, 2)
            updatePreview()
        })
        input.addEventListener("blur", () => {
            input.value = normalizeMensualidadDia(input.value)
            updatePreview()
        })
    })

    importeInput.addEventListener("input", () => refillMonths())
    frecuenciaSelect.addEventListener("change", () => refillMonths())
    diaSelect.addEventListener("change", () => {
        updateDayPlaceholders()
        updatePreview()
    })
    estadoSelect.addEventListener("change", applyEstado)
    modal.querySelector("#gastosMensualidadRecalcBtn")?.addEventListener("click", () => refillMonths({ force: true }))

    updateDayPlaceholders()

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
    // Al editar se respeta el mes en el que ya empezaban los cargos, para que
    // "Recalcular desde el importe" no invente cobros anteriores al alta.
    const charged = getMensualidadChargedMonths(row)
    const startIndex = charged.length ? charged[0].index : getMensualidadDefaultStartIndex()

    openGastosCreateModal({
        title: isEdit ? "Editar mensualidad" : "Nueva mensualidad",
        modalClass: "gastosCreateModalWide mensFormModal",
        bodyHtml: buildMensualidadFormHtml(row),
        submitLabel: isEdit ? "Guardar cambios" : "Añadir mensualidad",
        onReady: (modal) => bindMensualidadFormModal(modal, { autoFill: !isEdit, startIndex }),
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
            const isDuplicate = (currentGastosData?.mensualidades || []).some(
                (item, index) =>
                    index !== rowIndex &&
                    normalizeComparableGastoText(item?.nombre || "") === normalizeComparableGastoText(nombre)
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
            const diaCobro = normalizeMensualidadDia(getValue("gastosMensualidadDia"))
            // Solo se guardan los meses que se salen del día por defecto:
            // repetirlo en los otros once sería un dato que nadie ha escrito y
            // que dejaría de seguir al día general si se cambia.
            const diasCobro = Object.fromEntries(
                Object.entries(
                    normalizeMensualidadDias(
                        Object.fromEntries(
                            [...modal.querySelectorAll("[data-mens-day]")].map((input) => [
                                input.dataset.mensDay,
                                input.value
                            ])
                        )
                    )
                ).filter(([, dia]) => dia !== diaCobro)
            )
            const nextRow = {
                nombre,
                importe: importeRaw ? formatCellEuroValue(importeRaw) : "",
                frecuencia: getMensualidadFrecuencia(getValue("gastosMensualidadFrecuencia")).key,
                diaCobro,
                diasCobro,
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

// Acceso a la API vía Api.* (js/api.js): timeout, reintento de las lecturas,
// redirección al login si la sesión ha caducado y mensaje de error real del
// servidor en lugar de "HTTP 500: <html>…".

async function loadGastosYears() {
    const data = await Api.get("/api/gastos")
    return Array.isArray(data?.years) ? data.years : []
}

async function loadGastosYear(year) {
    return await Api.get(`/api/gastos/${encodeURIComponent(year)}`)
}

async function loadSharedGastosTypes() {
    const data = await Api.get("/api/gastos-tipos")
    return Array.isArray(data?.types) ? data.types : []
}

async function saveSharedGastosTypes(types) {
    const data = await Api.post("/api/gastos-tipos", { types })
    return Array.isArray(data?.types) ? data.types : []
}

async function createGastosYear(year) {
    return await Api.post("/api/gastos", { year })
}

async function saveGastosYear(year, payload, options = {}) {
    // keepalive: el guardado al cerrar la pestaña debe sobrevivir a la
    // descarga de la página, así que va por fetch directo (Api usa
    // AbortController, incompatible con keepalive en ese escenario).
    if (options.keepalive) {
        const response = await fetch(`/api/gastos/${encodeURIComponent(year)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
            keepalive: true
        })
        if (!response.ok) {
            throw new Error(`No se pudo guardar el año de gastos (HTTP ${response.status})`)
        }
        return
    }

    await Api.post(`/api/gastos/${encodeURIComponent(year)}`, payload)
}

async function deleteGastosYearRequest(year) {
    return await Api.del(`/api/gastos/${encodeURIComponent(year)}`)
}

async function initGastosLogic() {
    gastosYears = await loadGastosYears()
    sharedGastosTypes = await loadSharedGastosTypes()
    currentGastosYear = gastosYears[0] || "2026"
    currentGastosMonth = "enero"
    currentGastosView = "year"
    mensualidadesFilter = "todas"
    mensualidadesSearch = ""
    mensualidadesTab = "tabla"
    mensCalendarSelection = null
    gastosMensualidadesCollapsed = (window._gastosHiddenMensualidades || []).includes("Mensualidades")
    gastosMostrarPausadas = Boolean(window._gastosMostrarPausadas)
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
        const monthRows = [...(currentGastosData.months?.[currentGastosMonth]?.rows || [])].sort(
            (a, b) => gastoParseDate(a.fecha) - gastoParseDate(b.fecha)
        )

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
        // Desde el calendario se baja un cargo por línea, con su fecha: es lo
        // que se está mirando, y lo que sirve para cuadrar con el banco.
        if (mensualidadesTab === "calendario") {
            getMensualidadesCargosDelAno().forEach((cargo) => {
                rows.push({
                    Fecha: cargo.sinDia ? "" : formatGastoCargoDate(cargo.date),
                    Mes: GASTOS_MONTHS[cargo.monthIndex].label,
                    Servicio: cargo.nombre,
                    Importe: cargo.amount,
                    Estado: cargo.activa ? "Activa" : "Pausada"
                })
            })

            downloadCsvFile(`cargos-mensualidades-${currentGastosYear}.csv`, rows)
            return
        }

        getMensualidades().forEach((row) => {
            const anual = getMensualidadAnnualCost(row)
            rows.push({
                Nombre: row.nombre,
                Importe: getMensualidadCargo(row),
                Frecuencia: getMensualidadFrecuencia(row.frecuencia).short,
                "Día de renovación": row.diaCobro,
                "Días por mes": GASTOS_MONTHS.filter((month) => row.diasCobro?.[month.key])
                    .map((month) => `${month.label}: ${row.diasCobro[month.key]}`)
                    .join(" · "),
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
    const visibleTypes = getAvailableGastosTypes().filter(
        (type) => normalizeComparableGastoText(type) !== MENSUALIDADES_CATEGORIA_NORM
    )

    const mensualidadesMonthTotals = Object.fromEntries(
        GASTOS_MONTHS.map((month) => [month.key, getMensualidadesCategoryTotal(month.key, expenseTotals)])
    )

    const pausadasCount = currentGastosData.mensualidades.filter(
        (rawRow) => !normalizeMensualidad(rawRow).activa
    ).length

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
                    <button type="button" class="rowMenuItem" data-gastos-toggle-pausadas="1"${pausadasCount ? "" : " disabled"}>${gastosMostrarPausadas ? "🚫" : "⏸"} ${gastosMostrarPausadas ? "Ocultar" : "Mostrar"} pausadas${pausadasCount ? ` (${pausadasCount})` : ""}</button>
                </div>
            </div>
        </td>`
    annualBody.appendChild(mensualidadesRow)

    if (!gastosMensualidadesCollapsed) {
        const totalMensualidades = currentGastosData.mensualidades.length
        currentGastosData.mensualidades.forEach((rawRow, rowIndex) => {
            const row = normalizeMensualidad(rawRow)
            if (!row.activa && !gastosMostrarPausadas) {
                return
            }
            const meta = [getMensualidadFrecuencia(row.frecuencia).short, row.diaCobro ? `día ${row.diaCobro}` : ""]
                .filter(Boolean)
                .join(" · ")
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
                ${GASTOS_MONTHS.map(
                    (month) => `
                    <td>${formatEuro(parseEuroNumber(row.meses?.[month.key] || ""))}</td>
                `
                ).join("")}
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

    // La cabecera "Gastos" va debajo del bloque de mensualidades y encima de los tipos.
    const gastosRow = document.createElement("tr")
    gastosRow.className = "gastosSectionRow"
    gastosRow.innerHTML = `<td colspan="14">Gastos</td>`
    annualBody.appendChild(gastosRow)

    const typesWithData = visibleTypes.filter((type) =>
        GASTOS_MONTHS.some((month) => expenseTotals[type][month.key] > 0)
    )
    const typesEmpty = visibleTypes.filter((type) => GASTOS_MONTHS.every((month) => !expenseTotals[type][month.key]))

    // Los índices de las acciones apuntan a la lista completa de tipos guardados.
    const storedTypes = getAvailableGastosTypes()
    const totalTypes = storedTypes.length
    const renderTypeRow = (type, posicion) => {
        const rowIndex = storedTypes.indexOf(type)
        const isHidden = isGastoTipoHidden(type)
        const isEmpty = GASTOS_MONTHS.every((month) => !expenseTotals[type][month.key])
        const tr = document.createElement("tr")
        if (isEmpty) tr.classList.add("gastosTypeEmpty")
        // La primera categoría vacía marca el corte con las que sí tienen datos.
        // Es un borde y no una fila separadora: la tabla fuerza 42px de alto a
        // todas sus filas, así que una fila vacía se vería como un hueco roto.
        if (isEmpty && posicion === 0) tr.classList.add("gastosTypeEmptyFirst")
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

    typesEmpty.forEach(renderTypeRow)

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
            const isDuplicate = sharedGastosTypes.some(
                (type, idx) => idx !== rowIndex && normalizeComparableGastoText(type) === normalizedNew
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
    if (event.target.closest("[data-gastos-toggle-pausadas]")) {
        gastosMostrarPausadas = !gastosMostrarPausadas
        persistGastosMostrarPausadas(gastosMostrarPausadas)
        renderGastosAnnualTable()
        return
    }
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
    persistSharedGastosTypes()
        .then(() => {
            renderCurrentGastosView()
            scheduleGastosAutosave()
        })
        .catch((error) => {
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
        ;[sharedGastosTypes[rowIndex - 1], sharedGastosTypes[rowIndex]] = [
            sharedGastosTypes[rowIndex],
            sharedGastosTypes[rowIndex - 1]
        ]
    } else if (dir === "down" && rowIndex < sharedGastosTypes.length - 1) {
        ;[sharedGastosTypes[rowIndex], sharedGastosTypes[rowIndex + 1]] = [
            sharedGastosTypes[rowIndex + 1],
            sharedGastosTypes[rowIndex]
        ]
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

    document
        .getElementById("gastosMensualidadesTabBtn")
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
    renderMensualidadesList()
}

// Tabla y calendario miran los mismos datos con los mismos filtros: solo cambia
// la forma. Un único sitio decide cuál se ve para que el buscador y los chips
// no tengan que saberlo.
function renderMensualidadesList() {
    const table = document.getElementById("mensTableWrapper")
    const calendar = document.getElementById("mensCalendar")
    const isCalendar = mensualidadesTab === "calendario"

    table?.classList.toggle("hidden", isCalendar)
    calendar?.classList.toggle("hidden", !isCalendar)

    if (isCalendar) {
        renderMensualidadesCalendar()
        return
    }

    renderMensualidadesTable()
}

function renderMensualidadesSummary() {
    const container = document.getElementById("mensSummary")

    if (!container) {
        return
    }

    const rows = getMensualidades()
    const activas = rows.filter((row) => row.activa)
    // Dos números distintos y los dos ciertos: lo que se paga ahora (una pausada
    // cuesta cero) y lo que ha costado el año (una pausada sí cobró antes de
    // pararse). Mezclarlos era lo que inflaba el coste mensual.
    const mensualActual = rows.reduce((sum, row) => sum + getMensualidadMonthlyCost(row), 0)
    const totalAnual = rows.reduce((sum, row) => sum + getMensualidadAnnualCost(row), 0)

    const nextCharges = activas
        .map((row) => ({ row, next: getMensualidadNextCharge(row) }))
        .filter((item) => item.next && !item.next.isPast)
        .sort((a, b) => a.next.date - b.next.date)

    const nextItem = nextCharges[0]
    const nextValue = nextItem ? formatMensualidadDate(nextItem.next.date) : "—"
    const nextHint = nextItem
        ? `${nextItem.row.nombre} · ${nextItem.next.daysLeft === 0 ? "hoy" : `en ${nextItem.next.daysLeft} día${nextItem.next.daysLeft === 1 ? "" : "s"}`}`
        : "Sin cargos pendientes"

    const pausadas = rows.length - activas.length
    const cards = [
        {
            label: "Coste mensual",
            value: formatEuro(mensualActual),
            hint: pausadas ? `Solo lo activo · ${pausadas} sin contar` : "Lo que se cobra cada mes"
        },
        {
            label: "Coste del año",
            value: formatEuro(totalAnual),
            hint: `Cargos de ${currentGastosYear} · ${formatEuro(totalAnual / 12)} al mes de media`
        },
        {
            label: "Suscripciones activas",
            value: String(activas.length),
            hint: `${pausadas} pausada${pausadas === 1 ? "" : "s"}`
        },
        { label: "Próxima renovación", value: nextValue, hint: nextHint }
    ]

    container.innerHTML = cards
        .map(
            (card) => `
        <article class="mensCard">
            <p class="mensCardLabel">${escapeGastosHtml(card.label)}</p>
            <p class="mensCardValue">${escapeGastosHtml(card.value)}</p>
            <p class="mensCardHint">${escapeGastosHtml(card.hint)}</p>
        </article>
    `
        )
        .join("")
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

            return normalizeComparableGastoText(row.nombre).includes(search)
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

    body.innerHTML = items
        .map(({ row, index }, position) => {
            // Se intercambia con el vecino VISIBLE, no con el contiguo del array:
            // con un filtro activo, mover contra una fila oculta parecería que el
            // botón no hace nada.
            const prevIndex = position > 0 ? items[position - 1].index : null
            const nextIndex = position < items.length - 1 ? items[position + 1].index : null
            const anual = getMensualidadAnnualCost(row)
            const frecuencia = getMensualidadFrecuencia(row.frecuencia)
            const next = getMensualidadNextCharge(row)
            const nextText = next && !next.isPast ? formatMensualidadDate(next.date) : "—"
            const nextHint = next && !next.isPast ? (next.daysLeft === 0 ? "hoy" : `en ${next.daysLeft} d`) : ""
            const cargo = getMensualidadCargo(row)
            // Los meses con un día distinto se resumen aquí: la columna dice el
            // día habitual y avisa de cuántas veces no se cumple.
            const diasDistintos = GASTOS_MONTHS.filter((month) => row.diasCobro?.[month.key])
            const renovacionText = row.diaCobro ? `Día ${escapeGastosHtml(row.diaCobro)}` : "—"
            const excepciones = diasDistintos.length
                ? `${diasDistintos.length} mes${diasDistintos.length === 1 ? "" : "es"} aparte`
                : ""
            const excepcionesTitle = diasDistintos
                .map((month) => `${month.label}: día ${row.diasCobro[month.key]}`)
                .join(" · ")

            return `
            <tr class="${row.activa ? "" : "mensRowPaused"}">
                <td class="mensColName">
                    <span class="mensNameMain">${escapeGastosHtml(row.nombre)}</span>
                    ${row.nota ? `<span class="mensNameNote" title="${escapeGastosHtml(row.nota)}">${escapeGastosHtml(row.nota)}</span>` : ""}
                </td>
                <td>${cargo ? formatEuro(cargo) : "—"}</td>
                <td><span class="mensBadge mensBadge-${frecuencia.key}">${frecuencia.short}</span></td>
                <td>${renovacionText}${excepciones ? `<span class="mensNextHint" title="${escapeGastosHtml(excepcionesTitle)}">${excepciones}</span>` : ""}</td>
                <td>${escapeGastosHtml(nextText)}${nextHint ? `<span class="mensNextHint">${nextHint}</span>` : ""}</td>
                <td>${row.activa ? formatEuro(getMensualidadMonthlyCost(row)) : "—"}</td>
                <td>${formatEuro(anual)}</td>
                <td><span class="mensState ${row.activa ? "mensStateActive" : "mensStatePaused"}">${row.activa ? "Activa" : "Pausada"}</span></td>
                <td class="rowActionsCell">
                    <div class="rowMenu">
                        <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                        <div class="rowMenuDropdown">
                            <button type="button" class="rowMenuItem" data-mens-edit="${index}">Editar</button>
                            <button type="button" class="rowMenuItem" data-mens-move="${index}" data-mens-swap="${prevIndex ?? ""}" ${prevIndex === null ? "disabled" : ""}>▲ Subir</button>
                            <button type="button" class="rowMenuItem" data-mens-move="${index}" data-mens-swap="${nextIndex ?? ""}" ${nextIndex === null ? "disabled" : ""}>▼ Bajar</button>
                            <button type="button" class="rowMenuItem" data-mens-toggle="${index}">${row.activa ? "Pausar" : "Reactivar"}</button>
                            <button type="button" class="rowMenuItem" data-mens-duplicate="${index}">Duplicar</button>
                            <hr>
                            <button type="button" class="rowMenuItem rowMenuItemDanger" data-mens-delete="${index}">Eliminar</button>
                        </div>
                    </div>
                </td>
            </tr>
        `
        })
        .join("")

    const visibleAnual = items.reduce((sum, { row }) => sum + getMensualidadAnnualCost(row), 0)
    // El coste mensual de una pausada es cero, así que el total ya solo suma lo
    // que se sigue cobrando. El anual sí cuenta lo pausado: es dinero que salió.
    const visibleMensual = items.reduce((sum, { row }) => sum + getMensualidadMonthlyCost(row), 0)
    const pausadas = items.filter(({ row }) => !row.activa).length
    foot.innerHTML = `
        <tr class="mensFootRow">
            <td colspan="5">Total (${items.length} ${items.length === 1 ? "mensualidad" : "mensualidades"})${pausadas ? `<span class="mensFootHint">${pausadas} pausada${pausadas === 1 ? "" : "s"}, fuera del coste mensual</span>` : ""}</td>
            <td class="numCell">${formatEuro(visibleMensual)}</td>
            <td class="numCell">${formatEuro(visibleAnual)}</td>
            <td colspan="2"></td>
        </tr>
    `
}

// ── Calendario del año ──────────────────────────────────────────────────────

// La semana empieza en lunes, como los calendarios de aquí.
const MENS_CAL_WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"]

// Todos los cargos del año que pasan el filtro, con su fecha y su importe.
// Es la lista que se pinta y de la que salen los totales de cada mes.
function getMensualidadesCargosDelAno() {
    const cargos = []

    getFilteredMensualidades().forEach(({ row, index }) => {
        getMensualidadCargos(row).forEach((cargo) => {
            cargos.push({
                index,
                nombre: row.nombre,
                activa: row.activa,
                frecuencia: row.frecuencia,
                monthIndex: cargo.index,
                monthKey: cargo.key,
                dia: cargo.dia,
                sinDia: cargo.sinDia,
                date: cargo.date,
                amount: cargo.amount
            })
        })
    })

    return cargos.sort((a, b) => a.date - b.date || a.nombre.localeCompare(b.nombre))
}

function mensCalDayKey(monthIndex, day) {
    return `${monthIndex}-${day}`
}

function buildMensCalMonth(monthIndex, cargosDelMes, today, yearNumber) {
    const month = GASTOS_MONTHS[monthIndex]
    const conDia = cargosDelMes.filter((cargo) => !cargo.sinDia)
    const sinDia = cargosDelMes.filter((cargo) => cargo.sinDia)
    const total = cargosDelMes.reduce((sum, cargo) => sum + cargo.amount, 0)

    const porDia = new Map()
    conDia.forEach((cargo) => {
        const day = cargo.date.getDate()
        porDia.set(day, [...(porDia.get(day) || []), cargo])
    })

    const diasDelMes = new Date(yearNumber, monthIndex + 1, 0).getDate()
    // getDay() cuenta desde el domingo; aquí la semana empieza en lunes.
    const hueco = (new Date(yearNumber, monthIndex, 1).getDay() + 6) % 7

    const celdas = Array.from({ length: hueco }, () => '<span class="mensCalDay mensCalDayBlank"></span>')

    for (let day = 1; day <= diasDelMes; day += 1) {
        const delDia = porDia.get(day) || []
        const fecha = new Date(yearNumber, monthIndex, day)
        const esHoy = fecha.getTime() === today.getTime()
        const classes = ["mensCalDay"]

        if (esHoy) {
            classes.push("mensCalDayToday")
        }

        if (!delDia.length) {
            celdas.push(
                `<span class="${classes.join(" ")} mensCalDayEmpty"><span class="mensCalDayNum">${day}</span></span>`
            )
            continue
        }

        const key = mensCalDayKey(monthIndex, day)
        const importe = delDia.reduce((sum, cargo) => sum + cargo.amount, 0)
        classes.push("mensCalDayCharged")
        classes.push(fecha <= today ? "mensCalDayPast" : "mensCalDayNext")

        if (mensCalendarSelection === key) {
            classes.push("mensCalDaySelected")
        }

        const detalle = delDia.map((cargo) => `${cargo.nombre}: ${formatEuro(cargo.amount)}`).join(" · ")

        celdas.push(`
            <button type="button" class="${classes.join(" ")}" data-mens-cal-day="${key}"
                    title="${escapeGastosHtml(`${day} de ${month.label.toLowerCase()} · ${detalle}`)}">
                <span class="mensCalDayNum">${day}</span>
                <span class="mensCalDayAmount">${formatEuro(importe)}</span>
                ${delDia.length > 1 ? `<span class="mensCalDayCount">${delDia.length}</span>` : ""}
            </button>
        `)
    }

    return `
        <article class="mensCalMonth${cargosDelMes.length ? "" : " mensCalMonthEmpty"}">
            <header class="mensCalMonthHead">
                <span class="mensCalMonthName">${month.label}</span>
                <span class="mensCalMonthTotal">${cargosDelMes.length ? formatEuro(total) : "—"}</span>
            </header>
            <div class="mensCalWeekdays">${MENS_CAL_WEEKDAYS.map((d) => `<span>${d}</span>`).join("")}</div>
            <div class="mensCalDays">${celdas.join("")}</div>
            ${
                sinDia.length
                    ? `<p class="mensCalNoDay">Sin día: ${escapeGastosHtml(sinDia.map((cargo) => cargo.nombre).join(", "))}</p>`
                    : ""
            }
        </article>
    `
}

function buildMensCalDetalle(cargos, today) {
    if (mensCalendarSelection) {
        const [monthIndex, day] = mensCalendarSelection.split("-").map(Number)
        const delDia = cargos.filter(
            (cargo) => !cargo.sinDia && cargo.monthIndex === monthIndex && cargo.date.getDate() === day
        )

        if (delDia.length) {
            const total = delDia.reduce((sum, cargo) => sum + cargo.amount, 0)
            const fecha = delDia[0].date
            const cobrado = fecha <= today

            return `
                <p class="mensCalSideLabel">${cobrado ? "Cobrado" : "Previsto"}</p>
                <p class="mensCalSideTitle">${day} de ${GASTOS_MONTHS[monthIndex].label.toLowerCase()}</p>
                <ul class="mensCalSideList">
                    ${delDia
                        .map(
                            (cargo) => `
                        <li class="mensCalSideItem${cargo.activa ? "" : " mensCalSideItemPaused"}">
                            <span class="mensCalSideName">${escapeGastosHtml(cargo.nombre)}</span>
                            <span class="mensCalSideAmount">${formatEuro(cargo.amount)}</span>
                        </li>
                    `
                        )
                        .join("")}
                </ul>
                <p class="mensCalSideTotal"><span>Total del día</span><span>${formatEuro(total)}</span></p>
            `
        }
    }

    // Sin día elegido, el panel cuenta el año: lo ya cobrado y lo que viene.
    const cobrados = cargos.filter((cargo) => cargo.date <= today)
    const pendientes = cargos.filter((cargo) => cargo.date > today)
    const totalCobrado = cobrados.reduce((sum, cargo) => sum + cargo.amount, 0)
    const totalPendiente = pendientes.reduce((sum, cargo) => sum + cargo.amount, 0)

    return `
        <p class="mensCalSideLabel">Histórico de ${currentGastosYear}</p>
        <p class="mensCalSideTitle">${cargos.length} ${cargos.length === 1 ? "cargo" : "cargos"}</p>
        <p class="mensCalSideTotal"><span>Cobrado</span><span>${formatEuro(totalCobrado)}</span></p>
        <p class="mensCalSideTotal"><span>Por cobrar</span><span>${formatEuro(totalPendiente)}</span></p>
        <p class="mensCalSideLabel mensCalSideLabelSpaced">Lo que viene</p>
        ${
            pendientes.length
                ? `<ul class="mensCalSideList">
                        ${pendientes
                            .slice(0, 6)
                            .map(
                                (cargo) => `
                            <li class="mensCalSideItem">
                                <span class="mensCalSideName">${escapeGastosHtml(cargo.nombre)}</span>
                                <span class="mensCalSideDate">${cargo.sinDia ? GASTOS_MONTHS[cargo.monthIndex].label.toLowerCase() : formatMensualidadDate(cargo.date)}</span>
                                <span class="mensCalSideAmount">${formatEuro(cargo.amount)}</span>
                            </li>
                        `
                            )
                            .join("")}
                   </ul>`
                : '<p class="mensCalSideEmpty">No queda ningún cargo este año.</p>'
        }
        <p class="mensCalSideHint">Pulsa un día para ver qué se cobró.</p>
    `
}

function renderMensualidadesCalendar() {
    const container = document.getElementById("mensCalendar")

    if (!container) {
        return
    }

    const yearNumber = Number(currentGastosYear)
    const cargos = Number.isInteger(yearNumber) ? getMensualidadesCargosDelAno() : []

    if (!cargos.length) {
        const totalRows = (currentGastosData?.mensualidades || []).length
        container.innerHTML = `<p class="mensCalEmpty">${
            totalRows
                ? "Ninguna mensualidad con cargos coincide con el filtro."
                : "Aún no hay mensualidades. Añade la primera para ver el calendario de cobros."
        }</p>`
        return
    }

    const today = getGastosToday()
    const porMes = GASTOS_MONTHS.map((month, index) => cargos.filter((cargo) => cargo.monthIndex === index))

    container.innerHTML = `
        <div class="mensCalGrid">
            ${GASTOS_MONTHS.map((month, index) => buildMensCalMonth(index, porMes[index], today, yearNumber)).join("")}
        </div>
        <aside class="mensCalSide">${buildMensCalDetalle(cargos, today)}</aside>
    `
}

function handleMensualidadesActionClick(event) {
    const editBtn = event.target.closest("[data-mens-edit]")
    if (editBtn) {
        openMensualidadFormModal(Number(editBtn.dataset.mensEdit))
        return
    }

    const moveBtn = event.target.closest("[data-mens-move]")
    if (moveBtn) {
        const from = Number(moveBtn.dataset.mensMove)
        const to = Number(moveBtn.dataset.mensSwap)
        const rows = currentGastosData?.mensualidades

        // dataset.mensSwap va vacío en los extremos de la lista visible.
        if (!Array.isArray(rows) || !Number.isInteger(to) || !rows[from] || !rows[to]) {
            return
        }

        ;[rows[from], rows[to]] = [rows[to], rows[from]]
        renderCurrentGastosView()
        scheduleGastosAutosave()
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
        currentGastosData.mensualidades[index] = normalized.activa
            ? pauseMensualidad(normalized)
            : resumeMensualidad(normalized)
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
        const taken = (currentGastosData.mensualidades || []).map((item) =>
            normalizeComparableGastoText(item?.nombre || "")
        )
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
            renderMensualidadesList()
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
            renderMensualidadesList()
        })
    }

    const viewGroup = document.getElementById("mensViewGroup")
    if (viewGroup && !viewGroup.dataset.bound) {
        viewGroup.dataset.bound = "true"
        viewGroup.addEventListener("click", (event) => {
            const chip = event.target.closest("[data-mens-view]")
            if (!chip) {
                return
            }

            mensualidadesTab = chip.dataset.mensView
            viewGroup.querySelectorAll("[data-mens-view]").forEach((item) => {
                item.classList.toggle("active", item === chip)
            })
            renderMensualidadesList()
        })
    }

    const calendar = document.getElementById("mensCalendar")
    if (calendar && !calendar.dataset.bound) {
        calendar.dataset.bound = "true"
        calendar.addEventListener("click", (event) => {
            const dayButton = event.target.closest("[data-mens-cal-day]")
            if (!dayButton) {
                return
            }

            // Volver a pulsar el día abierto lo cierra: el panel vuelve al
            // resumen del año, que es lo que se ve al entrar.
            const key = dayButton.dataset.mensCalDay
            mensCalendarSelection = mensCalendarSelection === key ? null : key
            renderMensualidadesCalendar()
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

    const rows = [...(currentGastosData.months?.[currentGastosMonth]?.rows || [])].sort(
        (a, b) => gastoParseDate(a.fecha) - gastoParseDate(b.fecha)
    )

    rows.forEach((row, index) => {
        body.appendChild(buildGastoMovementRow(row, index))
    })

    const total = rows.reduce((sum, row) => sum + parseEuroNumber(row.cantidad || ""), 0)
    const totalTr = document.createElement("tr")
    totalTr.className = "gastosTotalRow"
    totalTr.dataset.isTotal = "true"
    totalTr.innerHTML = `<td colspan="3">Total</td><td class="numCell">${formatEuro(total)}</td><td class="rowActionsCell"></td>`
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
        <td data-field="fecha">${escapeGastosHtml(row.fecha || "")}</td>
        <td data-field="nombre">${escapeGastosHtml(row.nombre || "")}</td>
        <td data-field="tipo">${escapeGastosHtml(normalizeGastoTipo(row.tipo || ""))}</td>
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
                    fecha:
                        rowElement.dataset.fecha ||
                        rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() ||
                        "",
                    nombre:
                        rowElement.dataset.nombre ||
                        rowElement.querySelector('[data-field="nombre"]')?.textContent.trim() ||
                        "",
                    tipo: normalizeGastoTipo(
                        rowElement.dataset.tipo ||
                            rowElement.querySelector('[data-field="tipo"]')?.textContent.trim() ||
                            ""
                    ),
                    cantidad:
                        rowElement.dataset.cantidad ||
                        rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() ||
                        ""
                }
            })
            .filter((row) => row.fecha || row.nombre || row.tipo || parseEuroNumber(row.cantidad) !== 0)
    }
}

function normalizeGastoTipo(value) {
    const label = sanitizeGastoTypeLabel(value)
    const normalized = normalizeComparableGastoText(label)
    const found = getAvailableGastosTypes().find((type) => normalizeComparableGastoText(type) === normalized)
    return found || label
}

function dedupeGastosTypes(values) {
    return values.filter(
        (type, index, array) =>
            array.findIndex((item) => normalizeComparableGastoText(item) === normalizeComparableGastoText(type)) ===
            index
    )
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
            // Antes solo se registraba en consola: el usuario seguía editando
            // creyendo que sus cambios estaban guardados.
            showError("No se pudieron guardar los gastos", error)
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
        if (
            !_gastosHasPendingChanges ||
            document.visibilityState !== "hidden" ||
            !currentGastosYear ||
            !currentGastosData ||
            !_gastosDataLoaded
        ) {
            return
        }

        syncGastosDataFromTables()
        saveGastosYear(currentGastosYear, currentGastosData, { keepalive: true }).catch((error) => {
            console.error("Error al guardar gastos al cambiar de ventana:", error)
        })
    })
}
