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
// Copia de lo último que se leyó o se guardó en el servidor. Ante un 409 (el
// año cambió desde otro sitio) es la base de la fusión: ver core/fusion-anual.js.
let ingresosBaseSnapshot = null
let currentIngresosView = "year"
let ingresosAutosaveTimeout = null
let ingresosPersistenceBound = false
let sharedIngresosTypes = []
let _ingresosDataLoaded = false
let ingresosModalKeyHandler = null
let ingresosDetailKeyHandler = null
let recurrentesFilter = "todas"
let recurrentesSearch = ""
// Como en Mensualidades: la vista de recurrentes se ve como tabla o como
// calendario del año, y el día elegido ("mes-día") es lo que detalla el lateral.
let recurrentesTab = "tabla"
let recCalendarSelection = null
// Abierta desde Mi dinero › Ingresos recurrentes la página solo muestra esa
// vista: cambiar de año no debe devolver a la tabla anual de ingresos.
let ingresosSoloRecurrentes = false
// Nombre que toma una paga extra si no se le pone otro.
const PAGA_EXTRA_NOMBRE = "Extra"

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
        // Vacía = cuenta bancaria, como en los ingresos.
        cuenta: String(row.cuenta || ""),
        // Meses que entran en otra cuenta que la habitual: {marzo: "tarjeta"}.
        cuentasCobro: normalizeMensualidadCuentas(row.cuentasCobro),
        pagasExtra: normalizePagasExtra(row.pagasExtra),
        meses
    }
}

/**
 * Pagas extra de un ingreso recurrente, limpias.
 *
 * Una paga extra es un añadido puntual a un mes (la extra de junio de una
 * nómina). Se descartan las que no tienen un mes reconocible o importe.
 *
 * Args:
 *     value: Lista de `{nombre, mes, importe}` tal como llega.
 *
 * Returns:
 *     Lista de pagas con `nombre` (por defecto «Extra»), `mes` e `importe`.
 */
function normalizePagasExtra(value) {
    if (!Array.isArray(value)) {
        return []
    }
    return value
        .filter((paga) => paga && typeof paga === "object")
        .map((paga) => ({
            nombre: String(paga.nombre || "").trim() || PAGA_EXTRA_NOMBRE,
            mes: String(paga.mes || "").trim().toLowerCase(),
            importe: String(paga.importe || "").trim()
        }))
        .filter((paga) => INGRESOS_MONTHS.some((month) => month.key === paga.mes) && parseEuroNumber(paga.importe) !== 0)
}

/**
 * Total de pagas extra por mes.
 *
 * Args:
 *     pagasExtra: Pagas extra normalizadas.
 *
 * Returns:
 *     Objeto `{mes: importe}` con solo los meses que tienen alguna paga.
 */
function getPagasExtraPorMes(pagasExtra) {
    const porMes = {}
    ;(pagasExtra || []).forEach((paga) => {
        porMes[paga.mes] = (porMes[paga.mes] || 0) + parseEuroNumber(paga.importe)
    })
    return porMes
}

/**
 * Parte de cada mes que es cobro normal y parte que es paga extra.
 *
 * Las pagas extra van sumadas en `meses` (es lo que leen cuentas, histórico y
 * métricas), así que aquí se separan. La parte extra nunca pasa del total del
 * mes: si el mes se dejó a cero o se bajó a mano, la paga no aparece de la nada.
 *
 * Args:
 *     row: Recurrente normalizada.
 *
 * Returns:
 *     Objeto `{mes: {base, extra}}` con los doce meses.
 */
function getRecurrenteDesglose(row) {
    const extrasPorMes = getPagasExtraPorMes(row.pagasExtra)
    return Object.fromEntries(
        INGRESOS_MONTHS.map((month) => {
            const total = parseEuroNumber(row.meses?.[month.key] || "")
            const extra = total > 0 ? Math.min(extrasPorMes[month.key] || 0, total) : 0
            return [month.key, { base: total - extra, extra }]
        })
    )
}

/**
 * Meses de cobro normal más las pagas extra, con el formato de las celdas.
 *
 * Args:
 *     baseMeses: Objeto `{mes: texto}` con el cobro normal de cada mes.
 *     pagasExtra: Pagas extra normalizadas.
 *
 * Returns:
 *     Objeto `{mes: texto}` listo para guardar en `meses`.
 */
function sumarPagasExtraAMeses(baseMeses, pagasExtra) {
    const extrasPorMes = getPagasExtraPorMes(pagasExtra)
    return Object.fromEntries(
        INGRESOS_MONTHS.map((month) => {
            // Redondeo a céntimos: sumar decimales en coma flotante deja colas.
            const total =
                Math.round((parseEuroNumber(baseMeses?.[month.key] || "") + (extrasPorMes[month.key] || 0)) * 100) / 100
            return [month.key, total !== 0 ? formatEuro(total) : ""]
        })
    )
}

function getRecurrenteExtraAnual(row) {
    return Object.values(getRecurrenteDesglose(row)).reduce((sum, mes) => sum + mes.extra, 0)
}

function getRecurrentes() {
    return (currentIngresosData?.recurrentes || []).map(normalizeRecurrente)
}

// Reparte el importe por los meses del año según la frecuencia, desde el mes
// `startIndex` (enero por defecto).
function computeRecurrenteMeses(importeRaw, frecuenciaKey, startIndex = 0) {
    const step = getRecurrenteFrecuencia(frecuenciaKey).meses
    const value = String(importeRaw || "").trim() ? formatCellEuroValue(importeRaw) : ""

    return Object.fromEntries(
        INGRESOS_MONTHS.map((month, index) => {
            const isCharged = value && index >= startIndex && (index - startIndex) % step === 0
            return [month.key, isCharged ? value : ""]
        })
    )
}

/**
 * Mes del año siguiente en que vuelve a cobrarse una recurrente.
 *
 * Sigue el ritmo del año de origen: una trimestral cobrada por última vez en
 * noviembre vuelve en febrero. Solo cuentan los meses con cobro normal; una
 * paga extra suelta no marca el ritmo.
 *
 * Args:
 *     row: Recurrente normalizada del año de origen.
 *
 * Returns:
 *     Índice (0-11) del primer mes con cobro; 0 si no tenía cobros.
 */
function getRecurrenteInicioEnOtroAnio(row) {
    const desglose = getRecurrenteDesglose(row)
    const cobrados = INGRESOS_MONTHS.map((month, index) => ({ index, base: desglose[month.key].base })).filter(
        (month) => month.base > 0
    )
    if (!cobrados.length) {
        return 0
    }
    const step = getRecurrenteFrecuencia(row.frecuencia).meses
    return (cobrados[cobrados.length - 1].index + step) % INGRESOS_MONTHS.length
}

/**
 * Copia de una recurrente lista para otro año.
 *
 * Pasan concepto, categoría, importe, frecuencia, día, cuenta, nota, estado y
 * pagas extra (una nómina repite sus extras cada año). Las cuentas por mes no
 * pasan: eran de ese año. Una pausada sigue pausada y sin cobros.
 *
 * Args:
 *     rawRow: Recurrente tal como viene del año de origen.
 *
 * Returns:
 *     Fila con la forma que guarda el formulario de recurrentes.
 */
function copiarRecurrenteParaOtroAnio(rawRow) {
    const row = normalizeRecurrente(rawRow)
    const cobro = getRecurrenteCobro(row)
    const importe = row.importe || (cobro ? formatEuro(cobro) : "")
    const baseMeses = row.activa
        ? computeRecurrenteMeses(importe, row.frecuencia, getRecurrenteInicioEnOtroAnio(row))
        : {}
    return {
        nombre: row.nombre,
        categoria: row.categoria,
        importe: row.importe,
        frecuencia: row.frecuencia,
        diaCobro: row.diaCobro,
        mesInicio: row.mesInicio,
        activa: row.activa,
        nota: row.nota,
        cuenta: row.cuenta,
        cuentasCobro: {},
        pagasExtra: row.pagasExtra,
        meses: row.activa ? sumarPagasExtraAMeses(baseMeses, row.pagasExtra) : sumarPagasExtraAMeses({}, [])
    }
}

/**
 * Recurrentes de otro año que faltan en las de destino.
 *
 * El concepto es único por año en la base de datos: las que ya existen en
 * destino se saltan en vez de duplicarse.
 *
 * Args:
 *     origen: Recurrentes del año del que se copia.
 *     destino: Recurrentes que ya tiene el año al que se copia.
 *
 * Returns:
 *     Objeto con `nuevas` (filas a añadir) y `omitidas` (cuántas ya estaban).
 */
function getRecurrentesParaCopiar(origen, destino) {
    const existentes = new Set((destino || []).map((row) => normalizeComparableIngresoText(row?.nombre || "")))
    const nuevas = []
    let omitidas = 0
    ;(origen || []).forEach((row) => {
        const clave = normalizeComparableIngresoText(row?.nombre || "")
        if (!clave) {
            return
        }
        if (existentes.has(clave)) {
            omitidas += 1
            return
        }
        existentes.add(clave)
        nuevas.push(copiarRecurrenteParaOtroAnio(row))
    })
    return { nuevas, omitidas }
}

// Importe de un cobro. Si no está guardado, se usa el del último mes cobrado,
// que es el que refleja el importe actual cuando la ganancia sube o baja. Las
// pagas extra no cuentan: una extra en diciembre no es el cobro habitual.
function getRecurrenteCobro(row) {
    if (String(row.importe || "").trim()) {
        return parseEuroNumber(row.importe)
    }

    const desglose = getRecurrenteDesglose(row)
    const bases = INGRESOS_MONTHS.map((month) => desglose[month.key].base).filter((base) => base !== 0)
    return bases.length ? bases[bases.length - 1] : 0
}

// Ingreso mensual equivalente: el importe del cobro repartido entre los meses
// que abarca su frecuencia (en una mensual coincide con el importe por cobro).
function getRecurrenteMonthlyAmount(row) {
    return getRecurrenteCobro(row) / getRecurrenteFrecuencia(row.frecuencia).meses
}

function getRecurrenteChargedMonths(row) {
    return INGRESOS_MONTHS.map((month, index) => ({
        ...month,
        index,
        amount: parseEuroNumber(row.meses?.[month.key] || "")
    })).filter((month) => month.amount !== 0)
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

    const upcoming = charged.map((month) => buildDate(month.index)).find((date) => date >= today)

    const date = upcoming || buildDate(charged[0].index)
    const daysLeft = Math.round((date - today) / 86400000)

    return { date, daysLeft, isPast: !upcoming }
}

/**
 * Cobros del año de una recurrente, con fecha e importe.
 *
 * El cobro normal y cada paga extra van por separado, para que el calendario
 * y el lateral digan cuál es cuál. Sin día de cobro se toma el día 1 y se marca
 * `sinDia`, que el calendario lista aparte en vez de clavarlo en un día.
 *
 * Args:
 *     row: Recurrente normalizada.
 *     year: Año de los cobros.
 *
 * Returns:
 *     Lista de `{monthIndex, monthKey, date, sinDia, amount, esExtra, nombre}`.
 */
function getRecurrenteCobros(row, year = currentIngresosYear) {
    const yearNumber = Number(year)
    if (!Number.isInteger(yearNumber)) {
        return []
    }

    const desglose = getRecurrenteDesglose(row)
    const sinDia = !row.diaCobro
    const day = Number(row.diaCobro || 1)
    const cobros = []

    INGRESOS_MONTHS.forEach((month, monthIndex) => {
        const { base, extra } = desglose[month.key]
        const lastDay = new Date(yearNumber, monthIndex + 1, 0).getDate()
        const date = new Date(yearNumber, monthIndex, Math.min(day, lastDay))
        const comun = { monthIndex, monthKey: month.key, date, sinDia }

        if (base !== 0) {
            cobros.push({ ...comun, amount: base, esExtra: false, nombre: row.nombre })
        }
        if (extra === 0) {
            return
        }

        // La parte extra del mes ya está acotada por el desglose; se reparte
        // entre las pagas de ese mes en su orden, sin pasarse de lo que hay.
        let restante = extra
        row.pagasExtra
            .filter((paga) => paga.mes === month.key)
            .forEach((paga) => {
                const amount = Math.min(parseEuroNumber(paga.importe), restante)
                if (amount <= 0) {
                    return
                }
                restante -= amount
                cobros.push({ ...comun, amount, esExtra: true, nombre: `${row.nombre} · ${paga.nombre}` })
            })
    })

    return cobros
}

function formatRecurrenteDate(date) {
    return `${date.getDate()} ${INGRESOS_MONTHS[date.getMonth()].label.toLowerCase()}`
}

function sanitizeIngresoTypeLabel(value) {
    return String(value || "")
        .trim()
        .replace(/\s+/g, " ")
}

function normalizeComparableIngresoText(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
}

function escapeIngresosHtml(value) {
    // Alias del escapeHtml común (js/core/dom.js). Había una copia por
    // módulo y no todas escapaban las comillas, que es lo que importa en
    // un atributo value="…".
    return escapeHtml(value)
}

function ensureIngresosDataShape(data) {
    if (!data || typeof data !== "object") {
        return data
    }

    const mergedTypes = []
    const pushMergedType = (value) => {
        const label = sanitizeIngresoTypeLabel(value)
        if (!label) return
        if (mergedTypes.some((type) => normalizeComparableIngresoText(type) === normalizeComparableIngresoText(label)))
            return
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
    let guardando = false
    modal.querySelector("#ingresosCreateModalSaveBtn")?.addEventListener("click", async () => {
        // Un segundo clic mientras se guarda crearía otra fila igual.
        if (guardando) return
        guardando = true
        const getValue = (id) => modal.querySelector(`#${id}`)?.value ?? ""
        try {
            const shouldClose = await onSubmit({ getValue, setFeedback, modal })
            if (shouldClose !== false) closeIngresosCreateModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        } finally {
            guardando = false
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

function openIngresosAddYearModal() {
    const suggestedYear = getIngresosAnioSugerido()

    openIngresosCreateModal({
        title: "Añadir año",
        submitLabel: "Crear año",
        bodyHtml: `
            <label class="assetModalLabel" for="ingresosNuevoAnioInput">Año</label>
            <input id="ingresosNuevoAnioInput" class="assetModalInput" type="text" inputmode="numeric" maxlength="4" autocomplete="off" value="${suggestedYear}">
        `,
        onReady: (modal) => {
            const input = modal.querySelector("#ingresosNuevoAnioInput")
            input?.addEventListener("keydown", (event) => {
                if (event.key === "Enter") modal.querySelector("#ingresosCreateModalSaveBtn")?.click()
            })
            input?.select()
        },
        onSubmit: async ({ getValue, setFeedback }) => {
            const year = String(getValue("ingresosNuevoAnioInput")).trim()
            if (!/^\d{4}$/.test(year)) {
                setFeedback("Escribe un año de 4 cifras, por ejemplo 2027.", true)
                return false
            }
            if (ingresosYears.map(String).includes(year)) {
                setFeedback(`${year} ya existe.`, true)
                return false
            }

            // Las recurrentes se viven como globales, igual que las
            // mensualidades: el año nuevo hereda las del más cercano.
            const origen = getAnioOrigenMensualidades(year, ingresosYears)

            try {
                await persistCurrentIngresosData()
                await createIngresosYear(year)
                ingresosYears = await loadIngresosYears()
                currentIngresosYear = year
                await renderIngresosYear(year)
            } catch (error) {
                console.error(error)
                setFeedback("No se pudo crear el año.", true)
                return false
            }

            // El año ya existe aunque falle la copia: se cierra el popup y se
            // avisa, para no invitar a crearlo otra vez.
            if (origen) {
                try {
                    const resultado = await copiarRecurrentesAlAnioActual(origen)
                    if (resultado.nuevas.length) avisarRecurrentesCopiadas(resultado, origen)
                } catch (error) {
                    console.error(error)
                    showToast(`${year} se ha creado, pero no se pudieron copiar los ingresos recurrentes.`, {
                        type: "error"
                    })
                }
            }
            return true
        }
    })
}

function openRecurrenteModal() {
    openRecurrenteFormModal(-1)
}

function buildRecurrenteFormHtml(row) {
    const frecuenciaOptions = RECURRENTE_FRECUENCIAS.map(
        (f) => `<option value="${f.key}"${f.key === row.frecuencia ? " selected" : ""}>${f.label}</option>`
    ).join("")

    const diaOptions = Array.from({ length: 31 }, (_, i) => i + 1)
        .map((day) => `<option value="${day}"${String(day) === row.diaCobro ? " selected" : ""}>Día ${day}</option>`)
        .join("")

    const categoriaOptions = getAvailableIngresosTypes()
        .map((type) => `<option value="${escapeIngresosHtml(type)}"></option>`)
        .join("")

    // Los meses del formulario son el cobro normal: las pagas extra se editan
    // en su sección y se vuelven a sumar al guardar.
    const desglose = getRecurrenteDesglose(row)
    const monthsHtml = INGRESOS_MONTHS.map(
        (month) => `
        <div class="recMonthField">
            <label class="recMonthLabel" for="ingresosRecurrente-${month.key}">${month.label}</label>
            <input id="ingresosRecurrente-${month.key}" class="assetModalInput recMonthInput" data-rec-month="${month.key}"
                   type="text" inputmode="decimal" value="${desglose[month.key].base ? escapeIngresosHtml(formatEuro(desglose[month.key].base)) : ""}" placeholder="—">
            ${buildMensualidadMesCuentaSelect(month, row.cuentasCobro?.[month.key] || "", row.cuenta || "")}
        </div>
    `
    ).join("")

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
                <label class="assetModalLabel" for="ingresosRecurrenteCuenta">Se cobra en</label>
                ${construirSelectorCuenta("ingresosRecurrenteCuenta", row.cuenta || "")}
            </div>
            <div class="ingresosCreateModalField recFormFieldWide">
                <label class="assetModalLabel" for="ingresosRecurrenteNota">Nota</label>
                <input id="ingresosRecurrenteNota" class="assetModalInput" type="text"
                       value="${escapeIngresosHtml(row.nota || "")}" placeholder="Opcional: pagador, contrato…">
            </div>
        </div>

        <p class="recFormPreview" id="ingresosRecurrentePreview"></p>

        <div class="recFormMonths">
            <div class="recFormMonthsHead">
                <span class="recFormMonthsTitle">Importes por mes</span>
                <button type="button" class="recGhostBtn" id="ingresosRecurrenteRecalcBtn">Recalcular desde el importe</button>
            </div>
            <p class="recFormMonthsHint">Se rellenan solos con el importe y la frecuencia. Edita un mes para ajustarlo a mano. El selector de debajo es la cuenta en la que entra ese mes (por defecto, la cuenta base).</p>
            <div class="recMonthsGrid mensMonthsGridDays">${monthsHtml}</div>
        </div>

        <div class="recFormMonths recPagasExtra">
            <div class="recFormMonthsHead">
                <span class="recFormMonthsTitle">Pagas extra</span>
                <button type="button" class="recGhostBtn" id="ingresosRecurrenteAddPagaBtn">+ Añadir paga extra</button>
            </div>
            <p class="recFormMonthsHint">Un añadido puntual en un mes, como la extra de verano o de Navidad. Se suma al cobro de ese mes.</p>
            <div class="recPagasList" id="ingresosRecurrentePagas">${row.pagasExtra.map(buildPagaExtraRowHtml).join("")}</div>
        </div>
    `
}

/**
 * Fila editable de una paga extra en el formulario.
 *
 * Args:
 *     paga: Paga extra (`nombre`, `mes`, `importe`); vacía para una nueva.
 *
 * Returns:
 *     HTML de la fila.
 */
function buildPagaExtraRowHtml(paga = {}) {
    const mesOptions = INGRESOS_MONTHS.map(
        (month) => `<option value="${month.key}"${month.key === paga.mes ? " selected" : ""}>${month.label}</option>`
    ).join("")

    return `
        <div class="recPagaRow" data-paga-row>
            <input class="assetModalInput recPagaNombre" data-paga-nombre type="text" aria-label="Nombre de la paga extra"
                   value="${escapeIngresosHtml(paga.nombre || PAGA_EXTRA_NOMBRE)}" placeholder="${PAGA_EXTRA_NOMBRE}">
            <select class="assetModalSelect recPagaMes" data-paga-mes aria-label="Mes de la paga extra">${mesOptions}</select>
            <input class="assetModalInput recPagaImporte" data-paga-importe type="text" inputmode="decimal" aria-label="Importe de la paga extra"
                   value="${escapeIngresosHtml(paga.importe || "")}" placeholder="0,00 €">
            <button type="button" class="recPagaQuitar" data-paga-quitar aria-label="Quitar paga extra" title="Quitar">×</button>
        </div>
    `
}

/**
 * Mes que se propone para una paga extra nueva: junio la primera, diciembre la
 * segunda (lo habitual en una nómina de 14 pagas) y, después, el primer mes que
 * aún no tenga ninguna.
 *
 * Args:
 *     usados: Meses que ya tienen paga extra en el formulario.
 *
 * Returns:
 *     Clave del mes.
 */
function getMesSugeridoPagaExtra(usados) {
    const preferidos = ["junio", "diciembre", ...INGRESOS_MONTHS.map((month) => month.key)]
    return preferidos.find((mes) => !usados.includes(mes)) || "junio"
}

function readPagasExtraDelFormulario(modal) {
    return normalizePagasExtra(
        [...modal.querySelectorAll("[data-paga-row]")].map((fila) => {
            const importe = String(fila.querySelector("[data-paga-importe]")?.value || "").trim()
            return {
                nombre: fila.querySelector("[data-paga-nombre]")?.value,
                mes: fila.querySelector("[data-paga-mes]")?.value,
                importe: importe ? formatCellEuroValue(importe) : ""
            }
        })
    )
}

function bindRecurrenteFormModal(modal, { autoFill }) {
    const importeInput = modal.querySelector("#ingresosRecurrenteImporte")
    const frecuenciaSelect = modal.querySelector("#ingresosRecurrenteFrecuencia")
    const diaSelect = modal.querySelector("#ingresosRecurrenteDia")
    const preview = modal.querySelector("#ingresosRecurrentePreview")
    const monthInputs = [...modal.querySelectorAll("[data-rec-month]")]

    // La etiqueta «Base · X» de cada mes sigue a la cuenta base del formulario.
    modal.querySelector("#ingresosRecurrenteCuenta")?.addEventListener("change", (event) => {
        const nombre = escapeIngresosHtml(nombreDeCuenta(event.target.value))
        modal.querySelectorAll("[data-mens-base-option]").forEach((option) => {
            option.innerHTML = `Base · ${nombre}`
        })
    })

    const readMeses = () => Object.fromEntries(monthInputs.map((input) => [input.dataset.recMonth, input.value]))

    const updatePreview = () => {
        const meses = readMeses()
        const pagas = readPagasExtraDelFormulario(modal)
        const totalExtra = pagas.reduce((sum, paga) => sum + parseEuroNumber(paga.importe), 0)
        const total =
            INGRESOS_MONTHS.reduce((sum, month) => sum + parseEuroNumber(meses[month.key] || ""), 0) + totalExtra
        const cobros = INGRESOS_MONTHS.filter((month) => parseEuroNumber(meses[month.key] || "") !== 0).length

        if (!cobros && !pagas.length) {
            preview.textContent = "Sin cobros configurados este año."
            return
        }

        const dia = normalizeRecurrenteDia(diaSelect.value)
        const diaText = dia ? ` · se cobra el día ${dia}` : ""
        const extraText = pagas.length
            ? ` (${pagas.length} ${pagas.length === 1 ? "paga extra" : "pagas extra"}: ${formatEuro(totalExtra)})`
            : ""
        preview.textContent = `${cobros} ${cobros === 1 ? "cobro" : "cobros"} en ${currentIngresosYear} · ${formatEuro(total)} al año${extraText} · ${formatEuro(total / 12)} al mes de media${diaText}`
    }

    const pagasList = modal.querySelector("#ingresosRecurrentePagas")
    modal.querySelector("#ingresosRecurrenteAddPagaBtn")?.addEventListener("click", () => {
        const usados = readPagasExtraDelFormulario(modal).map((paga) => paga.mes)
        // Lo normal es que la extra sea una paga más: se propone el importe del cobro.
        const importe = importeInput.value.trim() ? formatCellEuroValue(importeInput.value) : ""
        pagasList.insertAdjacentHTML(
            "beforeend",
            buildPagaExtraRowHtml({ nombre: PAGA_EXTRA_NOMBRE, mes: getMesSugeridoPagaExtra(usados), importe })
        )
        pagasList.lastElementChild?.querySelector("[data-paga-importe]")?.focus()
        updatePreview()
    })
    pagasList?.addEventListener("click", (event) => {
        const quitar = event.target.closest("[data-paga-quitar]")
        if (!quitar) return
        quitar.closest("[data-paga-row]")?.remove()
        updatePreview()
    })
    pagasList?.addEventListener("input", updatePreview)
    pagasList?.addEventListener("change", updatePreview)
    pagasList?.addEventListener(
        "blur",
        (event) => {
            const input = event.target.closest("[data-paga-importe]")
            if (!input) return
            input.value = input.value.trim() ? formatCellEuroValue(input.value) : ""
            updatePreview()
        },
        true
    )

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
            const baseMeses = Object.fromEntries(
                [...modal.querySelectorAll("[data-rec-month]")].map((input) => {
                    const rawValue = String(input.value).trim()
                    return [input.dataset.recMonth, rawValue ? formatCellEuroValue(rawValue) : ""]
                })
            )
            const filasPaga = modal.querySelectorAll("[data-paga-row]").length
            const pagasExtra = readPagasExtraDelFormulario(modal)
            // Una fila de paga sin importe no se guarda: mejor avisar que perderla.
            if (pagasExtra.length !== filasPaga) {
                setFeedback("Pon un importe en cada paga extra o quita las que sobren.", true)
                return false
            }
            const meses = sumarPagasExtraAMeses(baseMeses, pagasExtra)
            const hasAnyAmount = INGRESOS_MONTHS.some((month) => parseEuroNumber(meses[month.key]) !== 0)

            if (!nombre) {
                setFeedback("Introduce el concepto de la ganancia.", true)
                return false
            }

            // El nombre identifica la ganancia en la base de datos: no puede repetirse.
            const isDuplicate = (currentIngresosData?.recurrentes || []).some(
                (item, index) =>
                    index !== rowIndex &&
                    normalizeComparableIngresoText(item?.nombre || "") === normalizeComparableIngresoText(nombre)
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
            // Solo los meses que se salen de la cuenta base. La bancaria es el
            // vacío en la base y «banco» en un mes.
            const cuentaBase = String(getValue("ingresosRecurrenteCuenta") || "").trim()
            const cuentasCobro = normalizeMensualidadCuentas(
                Object.fromEntries(
                    [...modal.querySelectorAll("[data-mens-account]")].map((select) => [
                        select.dataset.mensAccount,
                        select.value
                    ])
                )
            )
            Object.keys(cuentasCobro).forEach((month) => {
                if (cuentasCobro[month] === (cuentaBase || "banco")) {
                    delete cuentasCobro[month]
                }
            })
            const nextRow = {
                nombre,
                categoria: sanitizeIngresoTypeLabel(getValue("ingresosRecurrenteCategoria")),
                importe: importeRaw ? formatCellEuroValue(importeRaw) : "",
                frecuencia: getRecurrenteFrecuencia(getValue("ingresosRecurrenteFrecuencia")).key,
                diaCobro: normalizeRecurrenteDia(getValue("ingresosRecurrenteDia")),
                activa: getValue("ingresosRecurrenteEstado") !== "pausada",
                nota: String(getValue("ingresosRecurrenteNota")).trim(),
                // La cuenta bancaria es el vacío; las demás, su identificador.
                cuenta: cuentaBase,
                cuentasCobro,
                pagasExtra,
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

function closeIngresoDetailModal() {
    document.getElementById("ingresosDetailModalOverlay")?.remove()
    if (ingresosDetailKeyHandler) {
        document.removeEventListener("keydown", ingresosDetailKeyHandler)
        ingresosDetailKeyHandler = null
    }
}

// Detalle de un ingreso del mes. Lee de la propia fila (dataset) y no del
// índice: la tabla se pinta ordenada por fecha y el índice puede no coincidir
// con el orden de los datos hasta que se sincronizan.
function openIngresoDetailModal(rowElement) {
    closeIngresosCreateModal()
    closeIngresoDetailModal()

    const rowIndex = Number(rowElement.dataset.rowIndex)
    const nota = String(rowElement.dataset.nota || "").trim()
    const cantidad = rowElement.dataset.cantidad ? formatCellEuroValue(rowElement.dataset.cantidad) : ""

    const overlay = document.createElement("div")
    overlay.id = "ingresosDetailModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal movDetailModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.setAttribute("aria-labelledby", "ingresosDetailModalTitle")
    modal.innerHTML = `
        <h3 class="assetModalTitle" id="ingresosDetailModalTitle">Detalle del ingreso</h3>
        <dl class="movDetailList">
            <div class="movDetailItem"><dt>Fecha</dt><dd>${escapeIngresosHtml(rowElement.dataset.fecha || "—")}</dd></div>
            <div class="movDetailItem"><dt>Concepto</dt><dd>${escapeIngresosHtml(rowElement.dataset.nombre || "—")}</dd></div>
            <div class="movDetailItem"><dt>Tipo</dt><dd>${escapeIngresosHtml(rowElement.dataset.tipo || "—")}</dd></div>
            <div class="movDetailItem"><dt>Cobrado en</dt><dd>${escapeIngresosHtml(nombreDeCuenta(rowElement.dataset.cuenta || ""))}</dd></div>
            <div class="movDetailItem"><dt>Cantidad</dt><dd class="movDetailAmount movDetailAmountPos">${escapeIngresosHtml(cantidad || "—")}</dd></div>
        </dl>
        <div class="movDetailNote${nota ? "" : " movDetailNoteEmpty"}">
            <span class="movDetailNoteLabel">Nota</span>
            <p class="movDetailNoteText">${nota ? escapeIngresosHtml(nota) : "Sin nota"}</p>
        </div>
        <div class="assetModalActions">
            <button type="button" class="cancelButton" id="ingresosDetailCloseBtn">Cerrar</button>
            <button type="button" class="primaryButton" id="ingresosDetailEditBtn">Editar</button>
        </div>
    `

    modal.querySelector("#ingresosDetailCloseBtn")?.addEventListener("click", closeIngresoDetailModal)
    modal.querySelector("#ingresosDetailEditBtn")?.addEventListener("click", () => {
        closeIngresoDetailModal()
        openIngresoMovementModal(rowIndex)
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    ingresosDetailKeyHandler = (event) => {
        if (event.key === "Escape") closeIngresoDetailModal()
    }
    document.addEventListener("keydown", ingresosDetailKeyHandler)
    modal.querySelector("#ingresosDetailCloseBtn")?.focus()
}

/**
 * Lista de los cobros del año de una recurrente para su popup de detalle.
 *
 * El cobro normal y cada paga extra van en líneas separadas, con la cuenta en
 * la que entra ese mes. Lo ya cobrado se apaga y el próximo se resalta.
 *
 * Args:
 *     row: Recurrente normalizada.
 *
 * Returns:
 *     HTML del bloque «Cobros de <año>».
 */
function buildRecurrenteDetailCobrosHtml(row) {
    const cobros = getRecurrenteCobros(row)
    const today = getIngresosToday()
    const nextCobro = cobros.find((cobro) => cobro.date >= today)

    const itemsHtml = cobros
        .map((cobro) => {
            const classes = ["movDetailCharge"]
            if (cobro === nextCobro) {
                classes.push("movDetailChargeNext")
            } else if (cobro.date < today) {
                classes.push("movDetailChargeDone")
            }
            const fecha = cobro.sinDia ? INGRESOS_MONTHS[cobro.monthIndex].label : formatRecurrenteDate(cobro.date)
            const cuenta = nombreDeCuenta(row.cuentasCobro?.[cobro.monthKey] || row.cuenta)
            const extraHtml = cobro.esExtra
                ? ` <span class="recPagasBadge recPagasBadgeMini">${escapeIngresosHtml(cobro.nombre.slice(row.nombre.length + 3) || PAGA_EXTRA_NOMBRE)}</span>`
                : ""
            return `
                <li class="${classes.join(" ")}">
                    <span class="movDetailChargeDate">${escapeIngresosHtml(fecha)}${extraHtml}</span>
                    <span class="movDetailChargeAccount">${escapeIngresosHtml(cuenta)}</span>
                    <span class="movDetailChargeAmount">${formatEuro(cobro.amount)}</span>
                </li>
            `
        })
        .join("")

    return `
        <div class="movDetailCharges">
            <span class="movDetailNoteLabel">Cobros de ${escapeIngresosHtml(currentIngresosYear)} (${cobros.length})</span>
            ${
                cobros.length
                    ? `<ul class="movDetailChargesList">${itemsHtml}</ul>`
                    : '<p class="movDetailChargesEmpty">Sin cobros este año.</p>'
            }
        </div>
    `
}

/**
 * Abre el popup con el detalle de una ganancia recurrente al pulsar su fila.
 *
 * Args:
 *     index: Posición de la recurrente en `currentIngresosData.recurrentes`.
 */
function openRecurrenteDetailModal(index) {
    const rawRow = currentIngresosData?.recurrentes?.[index]
    if (!rawRow) return

    closeIngresosCreateModal()
    closeIngresoDetailModal()

    const row = normalizeRecurrente(rawRow)
    const frecuencia = getRecurrenteFrecuencia(row.frecuencia)
    const cobro = getRecurrenteCobro(row)
    const extraAnual = getRecurrenteExtraAnual(row)
    const next = getRecurrenteNextCharge(row)
    const nextText = next && !next.isPast
        ? `${formatRecurrenteDate(next.date)} (${next.daysLeft === 0 ? "hoy" : `en ${next.daysLeft} d`})`
        : "—"
    const nota = row.nota.trim()

    const overlay = document.createElement("div")
    overlay.id = "ingresosDetailModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal movDetailModal movDetailModalWide"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.setAttribute("aria-labelledby", "ingresosDetailModalTitle")
    modal.innerHTML = `
        <h3 class="assetModalTitle" id="ingresosDetailModalTitle">${escapeIngresosHtml(row.nombre || "Ganancia recurrente")}</h3>
        <dl class="movDetailList">
            <div class="movDetailItem"><dt>Categoría</dt><dd>${escapeIngresosHtml(row.categoria || "—")}</dd></div>
            <div class="movDetailItem"><dt>Cuenta</dt><dd>${escapeIngresosHtml(nombreDeCuenta(row.cuenta))}</dd></div>
            <div class="movDetailItem"><dt>Importe</dt><dd class="movDetailAmount movDetailAmountPos">${cobro ? formatEuro(cobro) : "—"}</dd></div>
            <div class="movDetailItem"><dt>Frecuencia</dt><dd>${escapeIngresosHtml(frecuencia.short)}</dd></div>
            <div class="movDetailItem"><dt>Día de cobro</dt><dd>${row.diaCobro ? `Día ${escapeIngresosHtml(row.diaCobro)}` : "—"}</dd></div>
            <div class="movDetailItem"><dt>Próximo cobro</dt><dd>${escapeIngresosHtml(nextText)}</dd></div>
            <div class="movDetailItem"><dt>Estado</dt><dd>${row.activa ? "Activa" : "Pausada"}</dd></div>
            <div class="movDetailItem"><dt>Ingreso mensual</dt><dd>${formatEuro(getRecurrenteMonthlyAmount(row))}</dd></div>
            <div class="movDetailItem"><dt>Total ${escapeIngresosHtml(currentIngresosYear)}</dt><dd>${formatEuro(getRecurrenteAnnualAmount(row))}</dd></div>
            ${extraAnual ? `<div class="movDetailItem"><dt>Pagas extra</dt><dd>${row.pagasExtra.length} · ${formatEuro(extraAnual)}</dd></div>` : ""}
        </dl>
        ${buildRecurrenteDetailCobrosHtml(row)}
        <div class="movDetailNote${nota ? "" : " movDetailNoteEmpty"}">
            <span class="movDetailNoteLabel">Nota</span>
            <p class="movDetailNoteText">${nota ? escapeIngresosHtml(nota) : "Sin nota"}</p>
        </div>
        <div class="assetModalActions">
            <button type="button" class="cancelButton" id="ingresosDetailCloseBtn">Cerrar</button>
            <button type="button" class="primaryButton" id="ingresosDetailEditBtn">Editar</button>
        </div>
    `

    modal.querySelector("#ingresosDetailCloseBtn")?.addEventListener("click", closeIngresoDetailModal)
    modal.querySelector("#ingresosDetailEditBtn")?.addEventListener("click", () => {
        closeIngresoDetailModal()
        openRecurrenteFormModal(index)
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    ingresosDetailKeyHandler = (event) => {
        if (event.key === "Escape") closeIngresoDetailModal()
    }
    document.addEventListener("keydown", ingresosDetailKeyHandler)
    modal.querySelector("#ingresosDetailCloseBtn")?.focus()
}

function openIngresoMovementModal(rowIndex = -1) {
    const currentRows = currentIngresosData?.months?.[currentIngresosMonth]?.rows || []
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...currentRows[rowIndex] } : {}
    const availableTypes = getAvailableIngresosTypes()
    const typeOptions = availableTypes
        .map((type) => {
            const isSelected =
                normalizeComparableIngresoText(rowData.tipo || "") === normalizeComparableIngresoText(type)
            return `<option value="${escapeIngresosHtml(type)}"${isSelected ? " selected" : ""}>${escapeIngresosHtml(type)}</option>`
        })
        .join("")

    openIngresosCreateModal({
        title: isEdit ? "Editar ingreso" : "Añadir ingreso",
        bodyHtml: `
            <label class="assetModalLabel" for="ingresosMovimientoFecha">Fecha</label>
            <input id="ingresosMovimientoFecha" class="assetModalInput" type="text" value="${escapeIngresosHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">

            <label class="assetModalLabel" for="ingresosMovimientoNombre">Concepto</label>
            <input id="ingresosMovimientoNombre" class="assetModalInput" type="text" value="${escapeIngresosHtml(rowData.nombre || "")}" placeholder="Ej: Regalo Cumpleaños">

            <label class="assetModalLabel" for="ingresosMovimientoTipo">Tipo</label>
            <select id="ingresosMovimientoTipo" class="assetModalSelect">
                <option value=""></option>
                ${typeOptions}
            </select>

            <label class="assetModalLabel" for="ingresosMovimientoCuenta">Cobrado en</label>
            ${construirSelectorCuenta("ingresosMovimientoCuenta", rowData.cuenta || "")}

            <label class="assetModalLabel" for="ingresosMovimientoCantidad">Cantidad</label>
            <input id="ingresosMovimientoCantidad" class="assetModalInput" type="text" inputmode="decimal" value="${escapeIngresosHtml(rowData.cantidad || "")}" placeholder="0,00">

            <label class="assetModalLabel" for="ingresosMovimientoNota">Nota <span class="assetModalLabelHint">opcional</span></label>
            <textarea id="ingresosMovimientoNota" class="assetModalInput movNotaInput" rows="3" maxlength="300" placeholder="Solo se ve al pulsar el ingreso en la tabla">${escapeIngresosHtml(rowData.nota || "")}</textarea>
        `,
        submitLabel: "Guardar",
        onSubmit: async ({ getValue, setFeedback }) => {
            const fecha = String(getValue("ingresosMovimientoFecha")).trim()
            const nombre = String(getValue("ingresosMovimientoNombre")).trim()
            const tipo = normalizeIngresoTipo(getValue("ingresosMovimientoTipo"))
            // La cuenta bancaria es el vacío; las demás, su identificador.
            const cuenta = String(getValue("ingresosMovimientoCuenta") || "")
            const cantidadRaw = String(getValue("ingresosMovimientoCantidad")).trim()
            const cantidad = cantidadRaw ? formatCellEuroValue(cantidadRaw) : ""
            const nota = String(getValue("ingresosMovimientoNota")).trim().slice(0, 300)

            if (!fecha && !nombre && !tipo && !cantidad) {
                setFeedback("Introduce al menos un dato para el ingreso.", true)
                return false
            }

            // La sincronización reconstruye las filas en el orden de la tabla (que puede
            // estar ordenada) y descarta las vacías: el índice de antes ya no vale.
            // Se localiza la fila editada por su contenido original.
            const original = isEdit ? currentRows[rowIndex] : null
            syncIngresosDataFromTables()
            if (!currentIngresosData.months[currentIngresosMonth]) {
                currentIngresosData.months[currentIngresosMonth] = { rows: [] }
            }

            const nextRow = { fecha, nombre, tipo, cantidad, nota, cuenta }

            const rowsNow = currentIngresosData.months[currentIngresosMonth].rows
            const editIndex = original
                ? rowsNow.findIndex(
                      (r) =>
                          (r.fecha || "") === (original.fecha || "") &&
                          (r.nombre || "") === (original.nombre || "") &&
                          normalizeIngresoTipo(r.tipo || "") === normalizeIngresoTipo(original.tipo || "") &&
                          (r.cantidad || "") === (original.cantidad || "") &&
                          (r.nota || "") === (original.nota || "") &&
                          (r.cuenta || "") === (original.cuenta || "")
                  )
                : -1

            if (editIndex >= 0) {
                rowsNow[editIndex] = nextRow
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
    return Array.isArray(data.years) ? ordenarAniosRecientesPrimero(data.years) : []
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
        const error = new Error(`HTTP ${response.status}: ${errorText}`)
        error.status = response.status
        throw error
    }
    return await response.json().catch(() => null)
}

// Tras un guardado correcto: la revisión nueva y la base para la próxima fusión
// son las de lo que se acaba de mandar, no las de lo que haya ahora en pantalla.
function anotarGuardadoIngresos(enviado, respuesta) {
    if (!Number.isInteger(respuesta?.revision)) {
        return
    }
    enviado.revision = respuesta.revision
    ingresosBaseSnapshot = enviado
    if (currentIngresosData && currentIngresosData.year === enviado.year) {
        currentIngresosData.revision = respuesta.revision
    }
}

async function guardarIngresosConRevision(options = {}) {
    const year = currentIngresosYear
    const enviado = clonarDatosAnuales(currentIngresosData)

    try {
        anotarGuardadoIngresos(enviado, await saveIngresosYear(year, enviado, options))
    } catch (error) {
        // Con keepalive la página puede estar cerrándose: no hay tiempo de
        // fusionar. La revisión no avanza, así que el próximo guardado volverá a
        // chocar y fusionará entonces; en el servidor no se ha borrado nada.
        if (error?.status !== 409 || options.keepalive) {
            throw error
        }

        const servidor = ensureIngresosDataShape(await loadIngresosYear(year))
        const sigueAbierto = currentIngresosData?.year === year
        if (sigueAbierto) syncIngresosDataFromTables()
        const local = sigueAbierto ? currentIngresosData : enviado
        const fusionado = fusionarAnioTresVias(ingresosBaseSnapshot, local, servidor, "recurrentes", "ingresosTipos")
        ingresosBaseSnapshot = clonarDatosAnuales(servidor)
        if (sigueAbierto) currentIngresosData = fusionado

        const aEnviar = clonarDatosAnuales(fusionado)
        anotarGuardadoIngresos(aEnviar, await saveIngresosYear(year, aEnviar))
        if (sigueAbierto) renderCurrentIngresosView()
        showToast("Este año había cambiado desde otro sitio (el Atajo, otra pestaña…). Se han combinado los cambios.", {
            type: "warning"
        })
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

/**
 * Arranca la página de Ingresos.
 *
 * Args:
 *     options.soloRecurrentes: true al abrirla desde Mi dinero › Ingresos
 *         recurrentes; la página se queda en esa vista.
 */
async function initIngresosLogic({ soloRecurrentes = false } = {}) {
    ingresosSoloRecurrentes = soloRecurrentes
    ingresosYears = await loadIngresosYears()
    sharedIngresosTypes = await loadSharedIngresosTypes()
    // Para el selector «Cobrado en» del popup y la columna «Cuenta».
    await cargarCuentasDinero()
    currentIngresosYear = ingresosYears[0] || "2026"
    currentIngresosMonth = "enero"
    currentIngresosView = getIngresosVistaPorDefecto()
    document.getElementById("ingresosRecurrentesTabBtn")?.classList.toggle("hidden", soloRecurrentes)
    recurrentesFilter = "todas"
    recurrentesSearch = ""
    recurrentesTab = "tabla"
    recCalendarSelection = null
    // Ingresos e Ingresos recurrentes comparten fragmento: los chips y el
    // buscador pueden venir con el estado de la otra entrada.
    document.querySelectorAll("[data-rec-filter]").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.recFilter === recurrentesFilter)
    })
    document.querySelectorAll("[data-rec-view]").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.recView === recurrentesTab)
    })
    const recSearchInput = document.getElementById("recSearchInput")
    if (recSearchInput) recSearchInput.value = ""
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

/**
 * Vista a la que vuelve la página al abrirse o al cambiar de año.
 *
 * Returns:
 *     "recurrentes" si se abrió desde su entrada del menú; "year" en Ingresos.
 */
function getIngresosVistaPorDefecto() {
    return ingresosSoloRecurrentes ? "recurrentes" : "year"
}

// El año que lo normal es crear: el actual si aún no existe y, si ya está, el
// siguiente al más reciente.
function getIngresosAnioSugerido() {
    const actual = String(new Date().getFullYear())
    const years = ingresosYears.map(String)
    if (!years.includes(actual)) {
        return actual
    }
    return String(Math.max(...years.map(Number).filter(Number.isInteger)) + 1)
}

/**
 * Añade al año abierto las recurrentes de otro año que le falten y guarda.
 *
 * Args:
 *     origen: Año del que se copian.
 *
 * Returns:
 *     Lo que devuelve getRecurrentesParaCopiar: filas añadidas y omitidas.
 */
async function copiarRecurrentesAlAnioActual(origen) {
    const datosOrigen = await loadIngresosYear(origen)
    syncIngresosDataFromTables()
    const resultado = getRecurrentesParaCopiar(datosOrigen?.recurrentes, currentIngresosData.recurrentes)
    if (resultado.nuevas.length) {
        currentIngresosData.recurrentes.push(...resultado.nuevas)
        renderCurrentIngresosView()
        await persistCurrentIngresosData()
        // Un año de ingresos solo existe en el servidor cuando tiene algo
        // guardado: recién creado no salía en la lista hasta recargar.
        if (!ingresosYears.map(String).includes(String(currentIngresosYear))) {
            ingresosYears = await loadIngresosYears()
            renderIngresosYearButtons()
        }
    }
    return resultado
}

function avisarRecurrentesCopiadas({ nuevas, omitidas }, origen) {
    if (!nuevas.length) {
        showToast(
            omitidas ? `Las recurrentes de ${origen} ya estaban en este año.` : `${origen} no tiene ingresos recurrentes.`,
            { type: "warning" }
        )
        return
    }
    const copiadas = nuevas.length === 1 ? "1 ingreso recurrente" : `${nuevas.length} ingresos recurrentes`
    const yaEstaban = omitidas ? ` (${omitidas} ya estaban)` : ""
    showToast(`Copiados ${copiadas} de ${origen}${yaEstaban}.`, { type: "success" })
}

function openCopiarRecurrentesModal() {
    const otros = ingresosYears.map(String).filter((year) => year !== String(currentIngresosYear))
    if (!otros.length) {
        showToast("No hay otro año del que copiar ingresos recurrentes.", { type: "warning" })
        return
    }
    const origen = getAnioOrigenMensualidades(currentIngresosYear, ingresosYears)
    const opciones = otros
        .map(
            (year) =>
                `<option value="${escapeIngresosHtml(year)}"${year === origen ? " selected" : ""}>${escapeIngresosHtml(year)}</option>`
        )
        .join("")

    openIngresosCreateModal({
        title: `Copiar recurrentes a ${currentIngresosYear}`,
        submitLabel: "Copiar",
        bodyHtml: `
            <label class="assetModalLabel" for="ingresosCopiarOrigen">Desde el año</label>
            <select id="ingresosCopiarOrigen" class="assetModalSelect">${opciones}</select>
            <p class="cuentasHint">Se añaden las que falten en ${escapeIngresosHtml(currentIngresosYear)}, con sus pagas extra; las que ya tiene, con el mismo concepto, no se tocan.</p>
        `,
        onSubmit: async ({ getValue }) => {
            const elegido = String(getValue("ingresosCopiarOrigen"))
            avisarRecurrentesCopiadas(await copiarRecurrentesAlAnioActual(elegido), elegido)
            return true
        }
    })
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
        addYearButton.addEventListener("click", openIngresosAddYearModal)
    }

    const copyRecurrentesButton = document.getElementById("copyRecurrentesBtn")
    if (copyRecurrentesButton && !copyRecurrentesButton.dataset.bound) {
        copyRecurrentesButton.dataset.bound = "true"
        copyRecurrentesButton.addEventListener("click", openCopiarRecurrentesModal)
    }

    if (deleteYearButton && !deleteYearButton.dataset.bound) {
        deleteYearButton.dataset.bound = "true"
        deleteYearButton.addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar año",
                message: `Vas a eliminar el año ${currentIngresosYear} con todos sus ingresos. Esto no se puede deshacer.`,
                confirmLabel: "Eliminar",
                confirmSide: "right",
                requireText: String(currentIngresosYear),
                onConfirm: async () => {
                    const response = await deleteIngresosYearRequest(currentIngresosYear)
                    ingresosYears = Array.isArray(response.years)
                        ? ordenarAniosRecientesPrimero(response.years)
                        : await loadIngresosYears()
                    currentIngresosYear = ingresosYears[0]
                    currentIngresosView = getIngresosVistaPorDefecto()
                    currentIngresosMonth = "enero"
                    await renderIngresosYear(currentIngresosYear)
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

    const informeButton = document.getElementById("ingresosInformeBtn")
    if (informeButton && !informeButton.dataset.bound) {
        informeButton.dataset.bound = "true"
        informeButton.addEventListener("click", () => descargarInformeFinanzas(currentIngresosYear, informeButton))
    }
}

async function renderIngresosYear(year) {
    _ingresosDataLoaded = false
    currentIngresosData = ensureIngresosDataShape(await loadIngresosYear(year))
    ingresosBaseSnapshot = clonarDatosAnuales(currentIngresosData)
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
            currentIngresosView = getIngresosVistaPorDefecto()
            recCalendarSelection = null
            await renderIngresosYear(year)
        })
        list.appendChild(button)
    })

    activarArrastreHorizontal(list)
    list.querySelector(".ingresosYearBtn.active")?.scrollIntoView({ block: "nearest", inline: "nearest" })
}

function buildMonthlyIncomeTotals() {
    const totals = {}
    const availableTypes = getAvailableIngresosTypes()
    availableTypes.forEach((type) => {
        totals[type] = {}
        INGRESOS_MONTHS.forEach((month) => {
            totals[type][month.key] = 0
        })
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
        const monthRows = [...(currentIngresosData.months?.[currentIngresosMonth]?.rows || [])].sort(
            (a, b) => ingresoParseDate(a.fecha) - ingresoParseDate(b.fecha)
        )

        monthRows.forEach((row) => {
            rows.push({
                Fecha: row.fecha || "",
                Concepto: row.nombre || "",
                Tipo: normalizeIngresoTipo(row.tipo || ""),
                Cantidad: parseEuroNumber(row.cantidad || ""),
                Nota: row.nota || ""
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
        const meta = [getRecurrenteFrecuencia(row.frecuencia).short, row.diaCobro ? `día ${row.diaCobro}` : ""]
            .filter(Boolean)
            .join(" · ")
        const tr = document.createElement("tr")
        if (!row.activa) {
            tr.classList.add("ingresosRecurrentePaused")
        }
        tr.innerHTML = `
            <td class="recNameCell">
                <span class="recNameMain">${escapeIngresosHtml(row.nombre || "")}</span>
                <span class="recNameMeta">${escapeIngresosHtml(meta)}${row.activa ? "" : " · pausada"}</span>
            </td>
            ${INGRESOS_MONTHS.map(
                (month) => `
                <td>${formatCellEuroValue(row.meses?.[month.key] || "")}</td>
            `
            ).join("")}
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
            const total = currentIngresosData.recurrentes.reduce(
                (sum, row) => sum + parseEuroNumber(row.meses?.[month.key] || ""),
                0
            )
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
            const totalRecurrentes = currentIngresosData.recurrentes.reduce(
                (sum, row) => sum + parseEuroNumber(row.meses?.[month.key] || ""),
                0
            )
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
            const isDuplicate = sharedIngresosTypes.some(
                (type, idx) => idx !== rowIndex && normalizeComparableIngresoText(type) === normalizedNew
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

        if (!hasContent) {
            removeRow()
            return
        }

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
    persistSharedIngresosTypes()
        .then(() => {
            renderCurrentIngresosView()
            scheduleIngresosAutosave()
        })
        .catch((error) => {
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
        ;[sharedIngresosTypes[rowIndex - 1], sharedIngresosTypes[rowIndex]] = [
            sharedIngresosTypes[rowIndex],
            sharedIngresosTypes[rowIndex - 1]
        ]
    } else if (dir === "down" && rowIndex < sharedIngresosTypes.length - 1) {
        ;[sharedIngresosTypes[rowIndex], sharedIngresosTypes[rowIndex + 1]] = [
            sharedIngresosTypes[rowIndex + 1],
            sharedIngresosTypes[rowIndex]
        ]
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

    document
        .getElementById("ingresosRecurrentesTabBtn")
        ?.classList.toggle("active", currentIngresosView === "recurrentes")
}

function renderCurrentIngresosView() {
    const annualWrapper = document.getElementById("ingresosAnnualWrapper")
    const movementsWrapper = document.getElementById("ingresosMovementsWrapper")
    const recurrentesWrapper = document.getElementById("ingresosRecurrentesWrapper")
    const monthHeader = document.getElementById("ingresosMonthHeader")
    const actions = document.getElementById("ingresosActions")
    // Los KPI resumen el año entero: en un mes o en recurrentes no aportan.
    const kpiStrip = document.getElementById("ingresosKpiStrip")
    if (!annualWrapper || !movementsWrapper || !monthHeader || !actions) return

    const monthBar = document.getElementById("ingresosMonthBar")

    const showView = (view) => {
        kpiStrip?.classList.toggle("hidden", view !== "year")
        // En recurrentes solo queda el selector de año: los meses no pintan nada ahí.
        monthBar?.classList.toggle("hidden", view === "recurrentes")
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
    renderRecurrentesList()
}

// Tabla y calendario miran los mismos datos con los mismos filtros: solo cambia
// la forma. Un único sitio decide cuál se ve.
function renderRecurrentesList() {
    const table = document.getElementById("recTableWrapper")
    const calendar = document.getElementById("recCalendar")
    const isCalendar = recurrentesTab === "calendario"

    table?.classList.toggle("hidden", isCalendar)
    calendar?.classList.toggle("hidden", !isCalendar)

    if (isCalendar) {
        renderRecurrentesCalendar()
        return
    }

    renderRecurrentesTable()
}

function renderRecurrentesSummary() {
    const container = document.getElementById("recSummary")
    if (!container) return

    const rows = getRecurrentes()
    const activas = rows.filter((row) => row.activa)
    const totalAnual = activas.reduce((sum, row) => sum + getRecurrenteAnnualAmount(row), 0)
    const mensualActual = activas.reduce((sum, row) => sum + getRecurrenteMonthlyAmount(row), 0)
    const totalExtra = activas.reduce((sum, row) => sum + getRecurrenteExtraAnual(row), 0)
    const numPagasExtra = activas.reduce((sum, row) => sum + row.pagasExtra.length, 0)

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
    // Lo que entra un mes normal y lo que entra en el año son números distintos:
    // el anual suma las pagas extra, que no llegan todos los meses.
    const cards = [
        {
            label: "Ingreso mensual",
            value: formatEuro(mensualActual),
            hint: `Sin pagas extra · ${activas.length} activa${activas.length === 1 ? "" : "s"}, ${pausadas} pausada${pausadas === 1 ? "" : "s"}`
        },
        {
            label: "Ingreso del año",
            value: formatEuro(totalAnual),
            hint: `${currentIngresosYear} · ${formatEuro(totalAnual / 12)} al mes de media`
        },
        {
            label: "Pagas extra",
            value: formatEuro(totalExtra),
            hint: numPagasExtra
                ? `${numPagasExtra} ${numPagasExtra === 1 ? "paga" : "pagas"} en ${currentIngresosYear}`
                : "Ninguna este año"
        },
        { label: "Próximo cobro", value: nextValue, hint: nextHint }
    ]

    container.innerHTML = cards
        .map(
            (card) => `
        <article class="recCard">
            <p class="recCardLabel">${escapeIngresosHtml(card.label)}</p>
            <p class="recCardValue">${escapeIngresosHtml(card.value)}</p>
            <p class="recCardHint">${escapeIngresosHtml(card.hint)}</p>
        </article>
    `
        )
        .join("")
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
        // Un año sin recurrentes: el atajo para traer las de otro año va aquí mismo.
        const origen = totalRows ? null : getAnioOrigenMensualidades(currentIngresosYear, ingresosYears)
        const copiarHtml = origen
            ? `<div class="mensEmptyActions"><button type="button" class="primaryButton" data-rec-copiar data-no-autohide="true">Copiar las de ${escapeIngresosHtml(origen)}</button></div>`
            : ""
        body.innerHTML = `<tr class="recEmptyRow"><td colspan="10">${message}${copiarHtml}</td></tr>`
        body.querySelector("[data-rec-copiar]")?.addEventListener("click", async (event) => {
            event.currentTarget.disabled = true
            try {
                avisarRecurrentesCopiadas(await copiarRecurrentesAlAnioActual(origen), origen)
            } catch (error) {
                console.error(error)
                showToast("No se pudieron copiar los ingresos recurrentes.", { type: "error" })
                renderRecurrentesTable()
            }
        })
        foot.innerHTML = ""
        return
    }

    body.innerHTML = items
        .map(({ row, index }) => {
            const anual = getRecurrenteAnnualAmount(row)
            const frecuencia = getRecurrenteFrecuencia(row.frecuencia)
            const next = getRecurrenteNextCharge(row)
            const mesesConOtraCuenta = INGRESOS_MONTHS.filter((month) => row.cuentasCobro?.[month.key])
            const cuentasAparte = mesesConOtraCuenta.length
            const cuentasTitle = mesesConOtraCuenta
                .map((month) => `${month.label}: ${nombreDeCuenta(row.cuentasCobro[month.key])}`)
                .join(" · ")
            const nextText = next && !next.isPast ? formatRecurrenteDate(next.date) : "—"
            const nextHint = next && !next.isPast ? (next.daysLeft === 0 ? "hoy" : `en ${next.daysLeft} d`) : ""
            const cobro = getRecurrenteCobro(row)

            return `
            <tr class="movDetailRow${row.activa ? "" : " recRowPaused"}" data-rec-index="${index}">
                <td class="recColName">
                    <span class="recNameMain">${escapeIngresosHtml(row.nombre)}</span>
                    ${row.categoria ? `<span class="recNameMeta">${escapeIngresosHtml(row.categoria)}</span>` : ""}
                    ${row.nota ? `<span class="recNameNote" title="${escapeIngresosHtml(row.nota)}">${escapeIngresosHtml(row.nota)}</span>` : ""}
                </td>
                <td title="${escapeIngresosHtml(cuentasTitle)}">${escapeIngresosHtml(nombreDeCuenta(row.cuenta))}${cuentasAparte ? `<span class="recNextHint">${cuentasAparte} mes${cuentasAparte === 1 ? "" : "es"} aparte</span>` : ""}</td>
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
        })
        .join("")

    const visibleAnual = items.reduce((sum, { row }) => sum + getRecurrenteAnnualAmount(row), 0)
    const visibleMensual = items.reduce((sum, { row }) => sum + getRecurrenteMonthlyAmount(row), 0)
    foot.innerHTML = `
        <tr class="recFootRow">
            <td colspan="6">Total (${items.length} ${items.length === 1 ? "ganancia" : "ganancias"})</td>
            <td class="numCell">${formatEuro(visibleMensual)}</td>
            <td class="numCell">${formatEuro(visibleAnual)}</td>
            <td colspan="2"></td>
        </tr>
    `
}

// ── Calendario de cobros ────────────────────────────────────────────────────
// Usa las clases del calendario de Mensualidades (gastos.css) para que las dos
// vistas se lean igual; solo cambia que aquí el dinero entra y que las pagas
// extra se marcan aparte.

const REC_CAL_WEEKDAYS = ["L", "M", "X", "J", "V", "S", "D"]

function getIngresosToday() {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    return today
}

// Todos los cobros del año que pasan el filtro, ordenados por fecha.
function getRecurrentesCobrosDelAno() {
    const cobros = []
    getFilteredRecurrentes().forEach(({ row, index }) => {
        getRecurrenteCobros(row).forEach((cobro) => cobros.push({ ...cobro, index, activa: row.activa }))
    })
    return cobros.sort((a, b) => a.date - b.date || a.nombre.localeCompare(b.nombre))
}

function recCalDayKey(monthIndex, day) {
    return `${monthIndex}-${day}`
}

/**
 * Importe abreviado para la celda de un día del calendario.
 *
 * Una nómina no cabe entera en una celda de 30 px («1500,00 €» se cortaba en
 * «15…»); el importe exacto sigue en el título de la celda y en el lateral.
 *
 * Args:
 *     amount: Importe en euros.
 *
 * Returns:
 *     Texto corto: "1,5k" a partir de mil, el entero redondeado por debajo.
 *
 * Example:
 *     formatRecCalImporte(1500)  // "1,5k"
 *     formatRecCalImporte(900)   // "900"
 */
function formatRecCalImporte(amount) {
    if (Math.abs(amount) >= 1000) {
        return `${(amount / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 })}k`
    }
    return String(Math.round(amount))
}

function buildRecCalMonth(monthIndex, cobrosDelMes, today, yearNumber) {
    const month = INGRESOS_MONTHS[monthIndex]
    const conDia = cobrosDelMes.filter((cobro) => !cobro.sinDia)
    const sinDia = cobrosDelMes.filter((cobro) => cobro.sinDia)
    const total = cobrosDelMes.reduce((sum, cobro) => sum + cobro.amount, 0)
    const extraDelMes = cobrosDelMes.some((cobro) => cobro.esExtra)

    const porDia = new Map()
    conDia.forEach((cobro) => {
        const day = cobro.date.getDate()
        porDia.set(day, [...(porDia.get(day) || []), cobro])
    })

    const diasDelMes = new Date(yearNumber, monthIndex + 1, 0).getDate()
    // getDay() cuenta desde el domingo; aquí la semana empieza en lunes.
    const hueco = (new Date(yearNumber, monthIndex, 1).getDay() + 6) % 7
    const celdas = Array.from({ length: hueco }, () => '<span class="mensCalDay mensCalDayBlank"></span>')

    for (let day = 1; day <= diasDelMes; day += 1) {
        const delDia = porDia.get(day) || []
        const fecha = new Date(yearNumber, monthIndex, day)
        const classes = ["mensCalDay"]
        if (fecha.getTime() === today.getTime()) classes.push("mensCalDayToday")

        if (!delDia.length) {
            celdas.push(`<span class="${classes.join(" ")} mensCalDayEmpty"><span class="mensCalDayNum">${day}</span></span>`)
            continue
        }

        const key = recCalDayKey(monthIndex, day)
        const importe = delDia.reduce((sum, cobro) => sum + cobro.amount, 0)
        classes.push("mensCalDayCharged", fecha <= today ? "mensCalDayPast" : "mensCalDayNext")
        if (delDia.some((cobro) => cobro.esExtra)) classes.push("recCalDayExtra")
        if (recCalendarSelection === key) classes.push("mensCalDaySelected")

        const detalle = delDia.map((cobro) => `${cobro.nombre}: ${formatEuro(cobro.amount)}`).join(" · ")
        celdas.push(`
            <button type="button" class="${classes.join(" ")}" data-rec-cal-day="${key}"
                    title="${escapeIngresosHtml(`${day} de ${month.label.toLowerCase()} · ${detalle}`)}">
                <span class="mensCalDayNum">${day}</span>
                <span class="mensCalDayAmount">${formatRecCalImporte(importe)}</span>
                ${delDia.length > 1 ? `<span class="mensCalDayCount">${delDia.length}</span>` : ""}
            </button>
        `)
    }

    return `
        <article class="mensCalMonth${cobrosDelMes.length ? "" : " mensCalMonthEmpty"}">
            <header class="mensCalMonthHead">
                <span class="mensCalMonthName">${month.label}${extraDelMes ? '<span class="recPagasBadge recPagasBadgeMini">extra</span>' : ""}</span>
                <span class="mensCalMonthTotal">${cobrosDelMes.length ? formatEuro(total) : "—"}</span>
            </header>
            <div class="mensCalWeekdays">${REC_CAL_WEEKDAYS.map((d) => `<span>${d}</span>`).join("")}</div>
            <div class="mensCalDays">${celdas.join("")}</div>
            ${
                sinDia.length
                    ? `<p class="mensCalNoDay">Sin día: ${escapeIngresosHtml(sinDia.map((cobro) => cobro.nombre).join(", "))}</p>`
                    : ""
            }
        </article>
    `
}

function buildRecCalSideItem(cobro, conFecha) {
    const fecha = conFecha
        ? `<span class="mensCalSideDate">${cobro.sinDia ? INGRESOS_MONTHS[cobro.monthIndex].label.toLowerCase() : formatRecurrenteDate(cobro.date)}</span>`
        : ""
    return `
        <li class="mensCalSideItem${cobro.activa ? "" : " mensCalSideItemPaused"}${cobro.esExtra ? " recCalSideItemExtra" : ""}">
            <span class="mensCalSideName">${escapeIngresosHtml(cobro.nombre)}</span>
            ${fecha}
            <span class="mensCalSideAmount">${formatEuro(cobro.amount)}</span>
        </li>
    `
}

function buildRecCalDetalle(cobros, today) {
    if (recCalendarSelection) {
        const [monthIndex, day] = recCalendarSelection.split("-").map(Number)
        const delDia = cobros.filter(
            (cobro) => !cobro.sinDia && cobro.monthIndex === monthIndex && cobro.date.getDate() === day
        )

        if (delDia.length) {
            const total = delDia.reduce((sum, cobro) => sum + cobro.amount, 0)
            return `
                <p class="mensCalSideLabel">${delDia[0].date <= today ? "Cobrado" : "Previsto"}</p>
                <p class="mensCalSideTitle">${day} de ${INGRESOS_MONTHS[monthIndex].label.toLowerCase()}</p>
                <ul class="mensCalSideList">${delDia.map((cobro) => buildRecCalSideItem(cobro, false)).join("")}</ul>
                <p class="mensCalSideTotal"><span>Total del día</span><span>${formatEuro(total)}</span></p>
            `
        }
    }

    // Sin día elegido, el panel cuenta el año: lo ya cobrado y lo que viene.
    const cobrados = cobros.filter((cobro) => cobro.date <= today)
    const pendientes = cobros.filter((cobro) => cobro.date > today)
    const sumar = (lista) => lista.reduce((sum, cobro) => sum + cobro.amount, 0)
    const extras = cobros.filter((cobro) => cobro.esExtra)

    return `
        <p class="mensCalSideLabel">Ingresos de ${currentIngresosYear}</p>
        <p class="mensCalSideTitle">${cobros.length} ${cobros.length === 1 ? "cobro" : "cobros"}</p>
        <p class="mensCalSideTotal"><span>Cobrado</span><span>${formatEuro(sumar(cobrados))}</span></p>
        <p class="mensCalSideTotal"><span>Por cobrar</span><span>${formatEuro(sumar(pendientes))}</span></p>
        ${extras.length ? `<p class="mensCalSideTotal"><span>Pagas extra</span><span>${formatEuro(sumar(extras))}</span></p>` : ""}
        <p class="mensCalSideLabel mensCalSideLabelSpaced">Lo que viene</p>
        ${
            pendientes.length
                ? `<ul class="mensCalSideList">${pendientes
                      .slice(0, 6)
                      .map((cobro) => buildRecCalSideItem(cobro, true))
                      .join("")}</ul>`
                : '<p class="mensCalSideEmpty">No queda ningún cobro este año.</p>'
        }
        <p class="mensCalSideHint">Pulsa un día para ver qué se cobró.</p>
    `
}

function renderRecurrentesCalendar() {
    const container = document.getElementById("recCalendar")
    if (!container) return

    const yearNumber = Number(currentIngresosYear)
    const cobros = Number.isInteger(yearNumber) ? getRecurrentesCobrosDelAno() : []

    if (!cobros.length) {
        const totalRows = (currentIngresosData?.recurrentes || []).length
        container.innerHTML = `<p class="mensCalEmpty">${
            totalRows
                ? "Ninguna ganancia recurrente con cobros coincide con el filtro."
                : "Aún no hay ganancias recurrentes. Añade la primera para ver el calendario de cobros."
        }</p>`
        return
    }

    const today = getIngresosToday()
    const porMes = INGRESOS_MONTHS.map((month, index) => cobros.filter((cobro) => cobro.monthIndex === index))

    container.innerHTML = `
        <div class="mensCalGrid">
            ${INGRESOS_MONTHS.map((month, index) => buildRecCalMonth(index, porMes[index], today, yearNumber)).join("")}
        </div>
        <aside class="mensCalSide">${buildRecCalDetalle(cobros, today)}</aside>
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
        const taken = (currentIngresosData.recurrentes || []).map((item) =>
            normalizeComparableIngresoText(item?.nombre || "")
        )
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
    if (!deleteBtn) {
        // Pulsar la fila (fuera del menú de acciones) abre su detalle.
        if (event.target.closest(".rowActionsCell")) return
        const rowElement = event.target.closest("tr[data-rec-index]")
        if (rowElement) openRecurrenteDetailModal(Number(rowElement.dataset.recIndex))
        return
    }

    const index = Number(deleteBtn.dataset.recDelete)
    const row = currentIngresosData?.recurrentes?.[index]
    if (!row) return

    openConfirmModal({
        title: "Eliminar ganancia recurrente",
        message: `Vas a eliminar "${normalizeRecurrente(row).nombre}" y su historial. Esto no se puede deshacer.`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        requireText: normalizeRecurrente(row).nombre,
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
            renderRecurrentesList()
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
            renderRecurrentesList()
        })
    }

    const viewGroup = document.getElementById("recViewGroup")
    if (viewGroup && !viewGroup.dataset.bound) {
        viewGroup.dataset.bound = "true"
        viewGroup.addEventListener("click", (event) => {
            const chip = event.target.closest("[data-rec-view]")
            if (!chip) return

            recurrentesTab = chip.dataset.recView
            viewGroup.querySelectorAll("[data-rec-view]").forEach((item) => {
                item.classList.toggle("active", item === chip)
            })
            renderRecurrentesList()
        })
    }

    const calendar = document.getElementById("recCalendar")
    if (calendar && !calendar.dataset.bound) {
        calendar.dataset.bound = "true"
        calendar.addEventListener("click", (event) => {
            const dayButton = event.target.closest("[data-rec-cal-day]")
            if (!dayButton) return

            // Pulsar el día ya elegido vuelve al resumen del año.
            const key = dayButton.dataset.recCalDay
            recCalendarSelection = recCalendarSelection === key ? null : key
            renderRecurrentesCalendar()
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
        const recTotal = (currentIngresosData.recurrentes || []).reduce(
            (s, r) => s + parseEuroNumber(r.meses?.[m.key] || ""),
            0
        )
        const typesTotal = availableTypes.reduce((s, t) => s + (incomeTotals[t]?.[m.key] || 0), 0)
        return { key: m.key, label: m.label, total: recTotal + typesTotal }
    })

    const totalAnio = monthTotals.reduce((s, m) => s + m.total, 0)
    const nonZeroMonths = monthTotals.filter((m) => m.total > 0)
    const promedio = nonZeroMonths.length > 0 ? totalAnio / nonZeroMonths.length : 0

    const best = monthTotals.reduce((best, m) => (m.total > best.total ? m : best), monthTotals[0])

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
    // El índice de cada fila es el de los datos sin ordenar: Editar y Eliminar
    // lo usan sobre currentIngresosData, no sobre el orden en que se pinta.
    const indexed = (currentIngresosData.months?.[currentIngresosMonth]?.rows || [])
        .map((row, index) => ({ row, index }))
        .sort((a, b) => ingresoParseDate(a.row.fecha) - ingresoParseDate(b.row.fecha))
    const rows = indexed.map(({ row }) => row)
    indexed.forEach(({ row, index }) => body.appendChild(buildIngresoMovementRow(row, index)))

    const total = rows.reduce((sum, row) => sum + parseEuroNumber(row.cantidad || ""), 0)
    const totalTr = document.createElement("tr")
    totalTr.className = "ingresosTotalRow"
    totalTr.dataset.isTotal = "true"
    totalTr.innerHTML = `<td colspan="4">Total</td><td class="numCell">${formatEuro(total)}</td><td class="rowActionsCell"></td>`
    body.appendChild(totalTr)

    renderIngresosMonthSide(rows)
}

// Al lado de la tabla del mes: de qué tipo han sido los ingresos y en qué cuenta han entrado.
function renderIngresosMonthSide(rows) {
    const lado = document.getElementById("ingresosResumenLado")
    if (!lado) return
    const mes = INGRESOS_MONTHS.find((m) => m.key === currentIngresosMonth)?.label || ""
    lado.innerHTML =
        buildDistribucionHtml(
            `Ingresos por tipo · ${mes}`,
            agruparImportes(rows, (row) => row.tipo)
        ) +
        buildDistribucionHtml(
            "Ingresos por cuenta",
            agruparImportes(rows, (row) => nombreDeCuenta(row.cuenta))
        )
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
    tr.className = "movDetailRow"
    tr.dataset.rowIndex = String(rowIndex)
    tr.dataset.fecha = String(row.fecha || "")
    tr.dataset.nombre = String(row.nombre || "")
    tr.dataset.tipo = String(normalizeIngresoTipo(row.tipo || ""))
    tr.dataset.cantidad = String(row.cantidad || "")
    // La nota no tiene columna: se guarda en la fila y se enseña en el detalle.
    tr.dataset.nota = String(row.nota || "")
    // Vacía = cuenta bancaria. Se conserva al guardar: la fila se reconstruye de aquí.
    tr.dataset.cuenta = String(row.cuenta || "")

    tr.innerHTML = `
        <td data-field="fecha">${escapeIngresosHtml(row.fecha || "")}</td>
        <td data-field="cuenta">${escapeIngresosHtml(nombreDeCuenta(row.cuenta))}</td>
        <td data-field="nombre">${escapeIngresosHtml(row.nombre || "")}</td>
        <td data-field="tipo">${escapeIngresosHtml(normalizeIngresoTipo(row.tipo || ""))}</td>
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
    if (!deleteButton) {
        // Pulsar la fila (fuera del menú de acciones) abre el detalle con la nota.
        if (event.target.closest(".rowActionsCell")) return
        const row = event.target.closest("tr.movDetailRow")
        if (row) openIngresoDetailModal(row)
        return
    }

    const rowIndex = Number(deleteButton.dataset.rowIndex)
    const monthRows = currentIngresosData?.months?.[currentIngresosMonth]?.rows || []
    const row = monthRows[rowIndex]
    const isEmpty = !row || (!row.fecha && !row.nombre && !row.tipo && parseEuroNumber(row.cantidad || "") === 0)

    const removeRow = () => {
        monthRows.splice(rowIndex, 1)
        renderCurrentIngresosView()
        scheduleIngresosAutosave()
    }

    if (isEmpty) {
        removeRow()
        return
    }

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
                fecha:
                    rowElement.dataset.fecha ||
                    rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() ||
                    "",
                nombre:
                    rowElement.dataset.nombre ||
                    rowElement.querySelector('[data-field="nombre"]')?.textContent.trim() ||
                    "",
                tipo: normalizeIngresoTipo(
                    rowElement.dataset.tipo || rowElement.querySelector('[data-field="tipo"]')?.textContent.trim() || ""
                ),
                cantidad:
                    rowElement.dataset.cantidad ||
                    rowElement.querySelector('[data-field="cantidad"]')?.textContent.trim() ||
                    "",
                nota: rowElement.dataset.nota || "",
                cuenta: rowElement.dataset.cuenta || ""
            }))
            .filter((row) => row.fecha || row.nombre || row.tipo || parseEuroNumber(row.cantidad) !== 0)
    }
}

function normalizeIngresoTipo(value) {
    const label = sanitizeIngresoTypeLabel(value)
    const normalized = normalizeComparableIngresoText(label)
    const found = getAvailableIngresosTypes().find((type) => normalizeComparableIngresoText(type) === normalized)
    return found || label
}

function dedupeIngresosTypes(values) {
    return values.filter(
        (type, index, array) =>
            array.findIndex((item) => normalizeComparableIngresoText(item) === normalizeComparableIngresoText(type)) ===
            index
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
    await guardarIngresosConRevision(options)
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
        guardarIngresosConRevision({ keepalive: true }).catch((error) => {
            console.error("Error al guardar ingresos al cerrar:", error)
        })
    })

    document.addEventListener("visibilitychange", () => {
        if (
            document.visibilityState !== "hidden" ||
            !currentIngresosYear ||
            !currentIngresosData ||
            !_ingresosDataLoaded
        )
            return
        syncIngresosDataFromTables()
        guardarIngresosConRevision({ keepalive: true }).catch((error) => {
            console.error("Error al guardar ingresos al cambiar de ventana:", error)
        })
    })
}
