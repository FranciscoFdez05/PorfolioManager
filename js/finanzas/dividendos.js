const DIVIDENDOS_MONTHS = [
    { key: "01", label: "Enero" },
    { key: "02", label: "Febrero" },
    { key: "03", label: "Marzo" },
    { key: "04", label: "Abril" },
    { key: "05", label: "Mayo" },
    { key: "06", label: "Junio" },
    { key: "07", label: "Julio" },
    { key: "08", label: "Agosto" },
    { key: "09", label: "Septiembre" },
    { key: "10", label: "Octubre" },
    { key: "11", label: "Noviembre" },
    { key: "12", label: "Diciembre" }
]

// Las filas con una fecha que no se puede leer no desaparecen: van a su propio
// bloque al final de la vista de año.
const DIVIDENDOS_SIN_FECHA = "sin-fecha"

let _dividendosAssets = []
let dividendosModalKeyHandler = null
let _allDividendosRows = []
let currentDividendosYear = null
// null = año completo; si no, la clave del mes ("01".."12") que se está viendo.
let currentDividendosMonth = null
let _dividendosTotalsToken = 0

// Manda la fecha de cobro: el mes de cada dividendo se deduce de ella, así que
// lo que ya estaba guardado se clasifica igual que lo que se meta a partir de
// ahora y no hay que tocar el fichero de datos. Se aceptan dd-mm-aaaa (lo que
// escribe el modal), mm-aaaa y aaaa-mm-dd por si alguna fila llegó en ISO.
function splitDividendoFecha(fecha) {
    const parts = String(fecha || "")
        .trim()
        .split(/[-/.]/)

    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) {
        return null
    }

    const isoFirst = parts[0].length === 4

    if (parts.length === 3) {
        return isoFirst
            ? { dia: parts[2], mes: parts[1], anio: parts[0] }
            : { dia: parts[0], mes: parts[1], anio: parts[2] }
    }

    return isoFirst ? { dia: "", mes: parts[1], anio: parts[0] } : { dia: "", mes: parts[0], anio: parts[1] }
}

function parseDividendoYear(fecha) {
    return splitDividendoFecha(fecha)?.anio || null
}

function parseDividendoMonth(fecha) {
    const mes = Number(splitDividendoFecha(fecha)?.mes)
    return Number.isInteger(mes) && mes >= 1 && mes <= 12 ? String(mes).padStart(2, "0") : null
}

function parseDividendoDay(fecha) {
    const dia = Number(splitDividendoFecha(fecha)?.dia)
    return Number.isInteger(dia) && dia >= 1 && dia <= 31 ? dia : 0
}

function getDividendosMonthLabel(monthKey) {
    return DIVIDENDOS_MONTHS.find((month) => month.key === monthKey)?.label || "Sin fecha"
}

// Orden natural de la tabla: mes y, dentro del mes, día de cobro.
function compareDividendosByDate(left, right) {
    const mesIzq = parseDividendoMonth(left.r.fecha)
    const mesDer = parseDividendoMonth(right.r.fecha)

    if (mesIzq !== mesDer) {
        if (!mesIzq) return 1
        if (!mesDer) return -1
        return Number(mesIzq) - Number(mesDer)
    }

    return parseDividendoDay(left.r.fecha) - parseDividendoDay(right.r.fecha)
}

function getDividendosYears(rows) {
    const years = new Set()
    rows.forEach((r) => {
        const y = parseDividendoYear(r.fecha)
        if (y) years.add(y)
    })
    return [...years].sort((a, b) => Number(a) - Number(b))
}

function renderDividendosYearBar(years) {
    const list = document.getElementById("dividendosYearList")
    if (!list) return
    list.innerHTML = ""
    years.forEach((year) => {
        const btn = document.createElement("button")
        btn.type = "button"
        btn.className = `interesesYearBtn${year === currentDividendosYear ? " active" : ""}`
        btn.textContent = year
        btn.addEventListener("click", () => {
            currentDividendosYear = year
            currentDividendosMonth = null
            renderFilteredDividendos()
        })
        list.appendChild(btn)
    })
}

function buildDividendosCurrencyOptions(selected, defaultVal = "USD") {
    const currencies = window._fiatCurrencies?.length ? window._fiatCurrencies : ["USD", "EUR", "GBP", "CHF", "JPY"]
    const effective = selected || defaultVal
    const opts = currencies
        .map((c) => `<option value="${c}"${c === effective ? " selected" : ""}>${c}</option>`)
        .join("")
    if (!currencies.includes(effective)) {
        return `<option value="${escapeHtml(effective)}" selected>${escapeHtml(effective)}</option>` + opts
    }
    return opts
}

function buildDividendosInstrumentoOptions(selectedName) {
    const exists = _dividendosAssets.some((a) => a.name === selectedName)
    const extra =
        !exists && selectedName
            ? `<option value="${escapeHtml(selectedName)}" selected>${escapeHtml(selectedName)}</option>`
            : ""
    const opts = _dividendosAssets
        .map(
            (a) =>
                `<option value="${escapeHtml(a.name)}"${a.name === selectedName ? " selected" : ""}>${escapeHtml(a.name)}</option>`
        )
        .join("")

    return `<option value=""></option>${extra}${opts}`
}

function closeDividendosModal() {
    document.getElementById("dividendosModalOverlay")?.remove()

    if (dividendosModalKeyHandler) {
        document.removeEventListener("keydown", dividendosModalKeyHandler)
        dividendosModalKeyHandler = null
    }
}

function openDividendosModal(globalIndex = -1, defaultFecha = "") {
    closeDividendosModal()

    const isEdit = globalIndex >= 0
    const rowData = isEdit ? { ..._allDividendosRows[globalIndex] } : {}
    if (!isEdit && defaultFecha) rowData.fecha = defaultFecha

    const overlay = document.createElement("div")
    overlay.id = "dividendosModalOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal dividendosCreateModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar dividendo" : "Añadir dividendo"}</h3>
        <label class="assetModalLabel" for="dividendoFechaInput">Fecha</label>
        <input id="dividendoFechaInput" class="assetModalInput" type="text" value="${escapeHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="dividendoInstrumentoInput">Instrumento</label>
        <select id="dividendoInstrumentoInput" class="assetModalSelect">
            ${buildDividendosInstrumentoOptions(rowData.instrumento || "")}
        </select>
        <label class="assetModalLabel" for="dividendoAccionesInput">Acciones</label>
        <input id="dividendoAccionesInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeHtml(rowData.acciones || "")}" placeholder="0">
        <label class="assetModalLabel" for="dividendoMonedaDividendoInput">Moneda dividendo</label>
        <select id="dividendoMonedaDividendoInput" class="assetModalSelect">
            ${buildDividendosCurrencyOptions(rowData.monedaDividendo, "USD")}
        </select>
        <label class="assetModalLabel" for="dividendoPorAccionInput">Dividendos / Acción</label>
        <input id="dividendoPorAccionInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeHtml(rowData.dividendoAccion || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="dividendoMonedaTotalInput">Moneda impuestos / total</label>
        <select id="dividendoMonedaTotalInput" class="assetModalSelect">
            ${buildDividendosCurrencyOptions(rowData.monedaTotal, "EUR")}
        </select>
        <label class="assetModalLabel" for="dividendoImpuestosInput">Impuestos</label>
        <input id="dividendoImpuestosInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeHtml(rowData.impuestos || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="dividendoTotalInput">Total</label>
        <input id="dividendoTotalInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeHtml(rowData.total || "")}" placeholder="0,00">
        <p class="gastosCreateModalFeedback hidden" id="dividendosModalFeedback"></p>
        <div class="assetModalActions dividendosModalActions">
            <button type="button" class="cancelButton" id="dividendosModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="dividendosModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    initSearchableSelect(modal.querySelector("#dividendoInstrumentoInput"))

    const setFeedback = (message = "", isError = false) => {
        const node = modal.querySelector("#dividendosModalFeedback")
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            // closeDividendosModal() // Deshabilitado para evitar cierre accidental
        }
    })

    modal.querySelector("#dividendosModalCancelBtn")?.addEventListener("click", closeDividendosModal)

    modal.querySelector("#dividendosModalSaveBtn")?.addEventListener("click", async () => {
        const fecha = modal.querySelector("#dividendoFechaInput")?.value.trim() || ""
        const instrumento = modal.querySelector("#dividendoInstrumentoInput")?.value.trim() || ""
        const accionesRaw = modal.querySelector("#dividendoAccionesInput")?.value.trim() || ""
        const dividendoAccionRaw = modal.querySelector("#dividendoPorAccionInput")?.value.trim() || ""
        const impuestosRaw = modal.querySelector("#dividendoImpuestosInput")?.value.trim() || ""
        const totalRaw = modal.querySelector("#dividendoTotalInput")?.value.trim() || ""
        const monedaDividendo = modal.querySelector("#dividendoMonedaDividendoInput")?.value || "USD"
        const monedaTotal = modal.querySelector("#dividendoMonedaTotalInput")?.value || "EUR"

        const acciones = accionesRaw ? formatShareQuantity(accionesRaw) : ""
        const dividendoAccion = dividendoAccionRaw ? formatCellMoneyValue(dividendoAccionRaw, monedaDividendo) : ""
        const impuestos = impuestosRaw ? formatCellMoneyValue(impuestosRaw, monedaTotal) : ""
        const total = totalRaw ? formatCellMoneyValue(totalRaw, monedaTotal) : ""

        if (!fecha && !instrumento && !acciones && !dividendoAccion && !impuestos && !total) {
            setFeedback("Introduce al menos un dato.", true)
            return
        }

        const nextRow = {
            fecha,
            instrumento,
            acciones,
            dividendoAccion,
            impuestos,
            total,
            monedaDividendo,
            monedaTotal
        }

        if (isEdit) {
            _allDividendosRows[globalIndex] = nextRow
        } else {
            _allDividendosRows.push(nextRow)
            const newYear = parseDividendoYear(fecha)
            if (newYear) currentDividendosYear = newYear
        }

        // La fila se coloca en el mes de su fecha de cobro. Si se está mirando
        // un mes concreto y no es ese, se salta al mes donde ha caído: si no,
        // parecería que la fila no se ha guardado.
        const newMonth = parseDividendoMonth(fecha)
        if (currentDividendosMonth && newMonth) currentDividendosMonth = newMonth

        try {
            renderFilteredDividendos()
            await saveDividendosDataToServer()
            closeDividendosModal()
        } catch (error) {
            console.error(error)
            setFeedback("No se pudo guardar.", true)
        }
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    dividendosModalKeyHandler = (event) => {
        if (event.key === "Escape") closeDividendosModal()
    }
    document.addEventListener("keydown", dividendosModalKeyHandler)

    modal.querySelector("input, select")?.focus()
}

async function loadDividendosData() {
    try {
        const response = await fetch("/api/dividendos")

        if (!response.ok) {
            throw new Error("No se pudo cargar /api/dividendos")
        }

        return await response.json()
    } catch (error) {
        console.error("Error cargando dividendos desde el backend:", error)
        return { rows: [] }
    }
}

async function renderDividendosTable() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    const [dividendosData, assetsList] = await Promise.all([loadDividendosData(), loadAssetsList().catch(() => [])])
    _dividendosAssets = assetsList.filter((a) => a.type === "acciones" || a.type === "etfs")
    renderDividendosRowsFromData(dividendosData)
}

function renderDividendosRowsFromData(dividendosData) {
    _allDividendosRows = Array.isArray(dividendosData?.rows) ? dividendosData.rows : []

    const years = getDividendosYears(_allDividendosRows)
    if (!currentDividendosYear && years.length) currentDividendosYear = years[years.length - 1]
    renderDividendosYearBar(years)
    renderFilteredDividendos()
}

// Filas del año activo ordenadas por fecha, cada una con su índice real dentro
// de _allDividendosRows: es el que usan editar y eliminar.
function getDividendosRowsOfYear() {
    return _allDividendosRows
        .map((r, i) => ({ r, i }))
        .filter(({ r }) => !currentDividendosYear || parseDividendoYear(r.fecha) === currentDividendosYear)
        .sort(compareDividendosByDate)
}

function groupDividendosByMonth(entries) {
    const groups = new Map()

    entries.forEach((entry) => {
        const key = parseDividendoMonth(entry.r.fecha) || DIVIDENDOS_SIN_FECHA
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(entry)
    })

    return groups
}

function getDividendosMonthCounts() {
    const counts = {}

    getDividendosRowsOfYear().forEach(({ r }) => {
        const key = parseDividendoMonth(r.fecha)
        if (key) counts[key] = (counts[key] || 0) + 1
    })

    return counts
}

function renderDividendosMonthTabs() {
    const container = document.getElementById("dividendosMonthTabs")

    if (!container) {
        return
    }

    const counts = getDividendosMonthCounts()
    container.innerHTML = ""

    DIVIDENDOS_MONTHS.forEach((month) => {
        const count = counts[month.key] || 0
        const button = document.createElement("button")
        button.type = "button"
        button.className = `dividendosMonthTab${month.key === currentDividendosMonth ? " active" : ""}${
            count ? "" : " dividendosMonthTabEmpty"
        }`
        button.textContent = month.label
        button.title = count
            ? `${count} ${count === 1 ? "cobro" : "cobros"} en ${month.label}`
            : `Sin dividendos en ${month.label}`
        button.addEventListener("click", () => {
            // Volver a pulsar el mes abierto devuelve a la vista del año.
            currentDividendosMonth = currentDividendosMonth === month.key ? null : month.key
            renderFilteredDividendos()
        })
        container.appendChild(button)
    })
}

function renderDividendosMonthHeader(count) {
    const header = document.getElementById("dividendosMonthHeader")

    if (!header) {
        return
    }

    if (!currentDividendosMonth) {
        header.innerHTML = ""
        header.classList.add("hidden")
        return
    }

    const titulo = `${getDividendosMonthLabel(currentDividendosMonth)}${currentDividendosYear ? ` ${currentDividendosYear}` : ""}`
    header.innerHTML = `
        <span class="dividendosMonthHeaderTitle">${escapeHtml(titulo)}</span>
        <span class="dividendosMonthHeaderMeta">${count} ${count === 1 ? "cobro" : "cobros"}</span>
    `
    header.classList.remove("hidden")
}

// Los importes del lateral son los de lo que se está viendo, así que conviene
// que se lea a qué periodo corresponden.
function renderDividendosScope() {
    const scope = document.getElementById("dividendosSummaryScope")

    if (!scope) {
        return
    }

    const anio = currentDividendosYear ? ` ${currentDividendosYear}` : ""
    scope.textContent = currentDividendosMonth
        ? `${getDividendosMonthLabel(currentDividendosMonth)}${anio}`
        : `Año completo${anio}`
}

function buildDividendosMonthGroupRow(monthKey, count) {
    const columnCount = document.querySelector(".dividendosTable thead tr")?.cells.length || 7
    const tr = document.createElement("tr")
    tr.className = "tableGroupRow dividendosMonthRow"
    tr.innerHTML = `
        <td class="dividendosGroupHeader" colspan="${columnCount}">
            <span class="dividendosGroupName">${escapeHtml(getDividendosMonthLabel(monthKey))}</span>
            <span class="dividendosGroupMeta">${count} ${count === 1 ? "cobro" : "cobros"}</span>
            <span class="dividendosGroupTotal" data-mes="${escapeHtml(monthKey)}"></span>
        </td>
    `
    return tr
}

function buildDividendosRow(rowData, globalIndex) {
    const rowElement = document.createElement("tr")
    rowElement.dataset.globalIndex = String(globalIndex)

    const mdiv = rowData.monedaDividendo || "USD"
    const mtot = rowData.monedaTotal || "EUR"
    rowElement.dataset.monedaDividendo = mdiv
    rowElement.dataset.monedaTotal = mtot
    rowElement.dataset.mes = parseDividendoMonth(rowData.fecha) || DIVIDENDOS_SIN_FECHA
    rowElement.innerHTML = `
        <td data-field="fecha">${escapeHtml(rowData.fecha || "")}</td>
        <td data-field="instrumento">${escapeHtml(rowData.instrumento || "")}</td>
        <td data-field="acciones">${formatShareQuantity(rowData.acciones)}</td>
        <td data-field="dividendoAccion">${formatCellMoneyValue(rowData.dividendoAccion, mdiv)}</td>
        <td data-field="impuestos">${formatCellMoneyValue(rowData.impuestos, mtot)}</td>
        <td class="rowTotal" data-moneda="${escapeHtml(mtot)}">${formatCellMoneyValue(rowData.total, mtot)}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn dividendosRowEditBtn avActionBtn avEditBtn" data-global-index="${globalIndex}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn dividendosRowDeleteBtn avActionBtn avDeleteBtn" data-global-index="${globalIndex}">Eliminar</button>
                </div>
            </div>
        </td>
    `
    return rowElement
}

function renderFilteredDividendos() {
    const dividendosBody = document.getElementById("dividendosBody")
    if (!dividendosBody) return

    const years = getDividendosYears(_allDividendosRows)
    renderDividendosYearBar(years)
    renderDividendosMonthTabs()

    const entriesOfYear = getDividendosRowsOfYear()
    const visible = currentDividendosMonth
        ? entriesOfYear.filter(({ r }) => parseDividendoMonth(r.fecha) === currentDividendosMonth)
        : entriesOfYear

    renderDividendosMonthHeader(visible.length)
    renderDividendosScope()

    dividendosBody.innerHTML = ""
    const dividendosEmptyEl = document.getElementById("dividendosEmptyMsg")
    const dividendosTableWrapper = document.querySelector(".dividendosTableWrapper")

    if (!visible.length) {
        if (dividendosEmptyEl) {
            dividendosEmptyEl.textContent = currentDividendosMonth
                ? `No hay dividendos en ${getDividendosMonthLabel(currentDividendosMonth).toLowerCase()}${
                      currentDividendosYear ? ` de ${currentDividendosYear}` : ""
                  }.`
                : "No hay dividendos registrados."
            dividendosEmptyEl.classList.remove("hidden")
        }
        if (dividendosTableWrapper) dividendosTableWrapper.classList.add("hidden")
        updateDividendosTotals()
        return
    }

    if (dividendosEmptyEl) dividendosEmptyEl.classList.add("hidden")
    if (dividendosTableWrapper) dividendosTableWrapper.classList.remove("hidden")

    if (currentDividendosMonth) {
        visible.forEach(({ r, i }) => dividendosBody.appendChild(buildDividendosRow(r, i)))
    } else {
        // Vista del año: cada mes abre su bloque, para leer la tabla por meses
        // en vez de como una lista corrida.
        groupDividendosByMonth(visible).forEach((entries, monthKey) => {
            dividendosBody.appendChild(buildDividendosMonthGroupRow(monthKey, entries.length))
            entries.forEach(({ r, i }) => dividendosBody.appendChild(buildDividendosRow(r, i)))
        })
    }

    // Si había una ordenación elegida en las cabeceras, se reaplica dentro de
    // cada bloque de mes (bindTableSort respeta las filas .tableGroupRow).
    document.querySelector(".dividendosTable")?._reSort?.()

    updateDividendosTotals()
}

function collectDividendosDataFromTable() {
    return { rows: _allDividendosRows }
}

async function saveDividendosDataToServer() {
    const data = collectDividendosDataFromTable()

    const response = await fetch("/api/dividendos", {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(data)
    })

    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

const _divRateCache = new Map()

async function _getDivExchangeRate(from, to) {
    if (from === to) return 1
    const key = `${from}->${to}`
    if (!_divRateCache.has(key)) {
        _divRateCache.set(
            key,
            (async () => {
                try {
                    const res = await fetch(
                        `/api/exchange-rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
                    )
                    const d = await res.json()
                    return d.ok && d.rate ? Number(d.rate) : 1
                } catch {
                    return 1
                }
            })()
        )
    }
    return _divRateCache.get(key)
}

async function updateDividendosTotals() {
    if (!document.getElementById("dividendosBody")) return

    const token = ++_dividendosTotalsToken
    const base = (window._monedaBase || "EUR").toUpperCase()

    const amounts = await Promise.all(
        getDividendosRowsOfYear().map(async ({ r }) => {
            const monedaTotal = (r.monedaTotal || "EUR").toUpperCase()
            const rate = await _getDivExchangeRate(monedaTotal, base)
            return {
                mes: parseDividendoMonth(r.fecha) || DIVIDENDOS_SIN_FECHA,
                total: (parseLooseNumber(r.total || "") ?? 0) * rate,
                impuestos: (parseLooseNumber(r.impuestos || "") ?? 0) * rate
            }
        })
    )

    // Los cambios de divisa llegan tarde: si mientras tanto se ha cambiado de
    // mes o de año, este resultado ya no es el de lo que se está mirando.
    if (token !== _dividendosTotalsToken) return

    const seleccion = currentDividendosMonth ? amounts.filter((x) => x.mes === currentDividendosMonth) : amounts
    const sumar = (list, campo) => list.reduce((acc, x) => acc + x[campo], 0)
    const fmt = (v) => formatMoney(v, base)

    const totalResumen = document.getElementById("totalDividendosResumen")
    const impuestosResumen = document.getElementById("impuestosDividendosResumen")
    const topTotalDividendos = document.getElementById("topTotalDividendos")

    if (totalResumen) totalResumen.textContent = fmt(sumar(seleccion, "total"))
    if (impuestosResumen) impuestosResumen.textContent = fmt(sumar(seleccion, "impuestos"))
    // La métrica de cabecera es del año entero: abrir un mes no la cambia.
    if (topTotalDividendos) topTotalDividendos.textContent = fmt(sumar(amounts, "total"))

    document.querySelectorAll(".dividendosGroupTotal").forEach((node) => {
        const mes = node.dataset.mes
        node.textContent = fmt(
            sumar(
                amounts.filter((x) => x.mes === mes),
                "total"
            )
        )
    })
}

function addNewDividendosRow() {
    // Desde un mes abierto la fecha viene puesta con ese mes: lo normal es que
    // la fila que se está apuntando sea de él.
    const fechaPorDefecto =
        currentDividendosMonth && currentDividendosYear ? `01-${currentDividendosMonth}-${currentDividendosYear}` : ""
    openDividendosModal(-1, fechaPorDefecto)
}

function addDividendosYear() {
    const yearStr = prompt("Introduce el año (ej: 2027):")?.trim()
    if (!yearStr || !/^\d{4}$/.test(yearStr)) return
    openDividendosModal(-1, `01-01-${yearStr}`)
}

function deleteCurrentDividendosYear() {
    if (!currentDividendosYear) return

    openConfirmModal({
        title: "Eliminar año",
        message: `¿Eliminar todas las filas del año ${currentDividendosYear}?`,
        confirmLabel: "Eliminar",
        onConfirm: async () => {
            try {
                _allDividendosRows = _allDividendosRows.filter(
                    (r) => parseDividendoYear(r.fecha) !== currentDividendosYear
                )
                const remaining = getDividendosYears(_allDividendosRows)
                currentDividendosYear = remaining.length ? remaining[remaining.length - 1] : null
                currentDividendosMonth = null
                renderFilteredDividendos()
                await saveDividendosDataToServer()
            } catch (error) {
                console.error(error)
                alert("No se pudo eliminar el año.")
            }
        }
    })
}

function handleDividendosRowActionClick(event) {
    const editButton = event.target.closest(".dividendosRowEditBtn")
    if (editButton) {
        openDividendosModal(Number(editButton.dataset.globalIndex))
        return
    }

    const deleteButton = event.target.closest(".dividendosRowDeleteBtn")
    if (!deleteButton) return

    const globalIndex = Number(deleteButton.dataset.globalIndex)
    const row = _allDividendosRows[globalIndex]
    const isEmpty =
        !row ||
        (!row.fecha &&
            !row.instrumento &&
            parseLooseNumber(row.acciones || "") === 0 &&
            parseDollarNumber(row.dividendoAccion || "") === 0 &&
            parseEuroNumber(row.impuestos || "") === 0 &&
            parseEuroNumber(row.total || "") === 0)

    const removeRow = async () => {
        _allDividendosRows.splice(globalIndex, 1)
        renderFilteredDividendos()
        await saveDividendosDataToServer()
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

// ── Calendario Dividendos ────────────────────────────────────────────────────

const CALENDARIO_MONTHS = [
    ["enero", "abril", "julio", "octubre"],
    ["febrero", "mayo", "agosto", "noviembre"],
    ["marzo", "junio", "septiembre", "diciembre"]
]

const CALENDARIO_MONTH_COLORS = {
    enero: "#3a7bd5",
    febrero: "#3a7bd5",
    marzo: "#3a7bd5",
    abril: "#3a7bd5",
    mayo: "#3a7bd5",
    junio: "#3a7bd5",
    julio: "#3a7bd5",
    agosto: "#3a7bd5",
    septiembre: "#3a7bd5",
    octubre: "#3a7bd5",
    noviembre: "#3a7bd5",
    diciembre: "#3a7bd5"
}

let _calendarioData = {}
let _calendarioAssets = []

async function loadCalendarioData() {
    try {
        const response = await fetch("/api/dividendos/calendar")
        if (!response.ok) throw new Error()
        const data = await response.json()
        return data.calendar || {}
    } catch {
        return {}
    }
}

async function saveCalendarioData(calendar) {
    await fetch("/api/dividendos/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ calendar })
    })
}

async function loadCalendarioAssets() {
    try {
        const response = await fetch("/api/activos")
        if (!response.ok) throw new Error()
        const data = await response.json()
        return Array.isArray(data.assets) ? data.assets : []
    } catch {
        return []
    }
}

function buildCalendarioCell(month, names, assets) {
    const color = CALENDARIO_MONTH_COLORS[month] || "#444"
    const monthLabel = month.charAt(0).toUpperCase() + month.slice(1)

    const tagsHtml = names
        .map(
            (name) => `
        <div class="calTag">
            <span class="calTagName">${escapeHtml(name)}</span>
            <button type="button" class="calTagRemove" data-month="${month}" data-name="${encodeURIComponent(name)}" title="Quitar">×</button>
        </div>
    `
        )
        .join("")

    const optionsHtml = assets
        .filter((a) => a.type === "acciones" && !names.includes(a.name))
        .map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}</option>`)
        .join("")

    return `
        <td class="calCell" data-month="${month}">
            <div class="calMonthLabel" style="background:${color}">${monthLabel}</div>
            <div class="calTags" id="calTags-${month}">${tagsHtml}</div>
            <div class="calAddRow">
                <select class="calSelect" id="calSelect-${month}">
                    <option value="">Añadir acción...</option>
                    ${optionsHtml}
                </select>
                <button type="button" class="calAddBtn" data-month="${month}">+</button>
            </div>
        </td>
    `
}

function renderCalendarioBody(calendar, assets) {
    const tbody = document.getElementById("calendarioBody")
    if (!tbody) return

    tbody.innerHTML = ""

    CALENDARIO_MONTHS.forEach((row) => {
        const tr = document.createElement("tr")
        tr.innerHTML = row.map((month) => buildCalendarioCell(month, calendar[month] || [], assets)).join("")
        tbody.appendChild(tr)
    })

    tbody.addEventListener("click", handleCalendarioClick)
}

async function handleCalendarioClick(event) {
    const addBtn = event.target.closest(".calAddBtn")
    if (addBtn) {
        const month = addBtn.dataset.month
        const select = document.getElementById(`calSelect-${month}`)
        const name = select?.value
        if (!name) return

        if (!_calendarioData[month]) _calendarioData[month] = []
        if (!_calendarioData[month].includes(name)) {
            _calendarioData[month].push(name)
            await saveCalendarioData(_calendarioData)
            renderCalendarioBody(_calendarioData, _calendarioAssets)
        }
        return
    }

    const removeBtn = event.target.closest(".calTagRemove")
    if (removeBtn) {
        const month = removeBtn.dataset.month
        const name = decodeURIComponent(removeBtn.dataset.name)
        if (_calendarioData[month]) {
            _calendarioData[month] = _calendarioData[month].filter((n) => n !== name)
            await saveCalendarioData(_calendarioData)
            renderCalendarioBody(_calendarioData, _calendarioAssets)
        }
    }
}

async function openCalendarioDividendos() {
    const overlay = document.getElementById("calendarioDividendosOverlay")
    if (!overlay) return

    const closeBtn = document.getElementById("closeCalendarioDividendosBtn")
    if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.dataset.bound = "true"
        closeBtn.addEventListener("click", () => overlay.classList.add("hidden"))
    }

    ;[_calendarioData, _calendarioAssets] = await Promise.all([loadCalendarioData(), loadCalendarioAssets()])

    renderCalendarioBody(_calendarioData, _calendarioAssets)
    overlay.classList.remove("hidden")
}

function initCalendarioDividendosButton() {
    const openBtn = document.getElementById("openCalendarioDividendosBtn")
    if (openBtn && !openBtn.dataset.bound) {
        openBtn.dataset.bound = "true"
        openBtn.addEventListener("click", openCalendarioDividendos)
    }

    const closeBtn = document.getElementById("closeCalendarioDividendosBtn")
    if (closeBtn && !closeBtn.dataset.bound) {
        closeBtn.dataset.bound = "true"
        closeBtn.addEventListener("click", () => {
            document.getElementById("calendarioDividendosOverlay")?.classList.add("hidden")
        })
    }
}

async function renameCalendarioAsset(oldName, newName) {
    const calendar = await loadCalendarioData()
    let changed = false

    for (const month of Object.keys(calendar)) {
        const idx = calendar[month].indexOf(oldName)
        if (idx !== -1) {
            calendar[month][idx] = newName
            changed = true
        }
    }

    if (changed) {
        await saveCalendarioData(calendar)
    }
}
