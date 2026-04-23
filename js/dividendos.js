let _dividendosAssets = []
let dividendosModalKeyHandler = null

function escapeDividendosHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}

function buildDividendosInstrumentoSelect(selectedName) {
    const exists = _dividendosAssets.some((a) => a.name === selectedName)
    const extra  = (!exists && selectedName)
        ? `<option value="${selectedName}" selected>${selectedName}</option>`
        : ""
    const opts = _dividendosAssets.map((a) =>
        `<option value="${a.name}"${a.name === selectedName ? " selected" : ""}>${a.name}</option>`
    ).join("")
    return `<select class="bonosTipoSelect">${extra}${opts}</select>`
}

function buildDividendosInstrumentoOptions(selectedName) {
    const exists = _dividendosAssets.some((a) => a.name === selectedName)
    const extra = (!exists && selectedName)
        ? `<option value="${escapeDividendosHtml(selectedName)}" selected>${escapeDividendosHtml(selectedName)}</option>`
        : ""
    const opts = _dividendosAssets.map((a) =>
        `<option value="${escapeDividendosHtml(a.name)}"${a.name === selectedName ? " selected" : ""}>${escapeDividendosHtml(a.name)}</option>`
    ).join("")

    return `<option value=""></option>${extra}${opts}`
}

function closeDividendosModal() {
    document.getElementById("dividendosModalOverlay")?.remove()

    if (dividendosModalKeyHandler) {
        document.removeEventListener("keydown", dividendosModalKeyHandler)
        dividendosModalKeyHandler = null
    }
}

function openDividendosModal(rowIndex = -1) {
    closeDividendosModal()

    const rows = collectDividendosDataFromTable().rows
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? { ...rows[rowIndex] } : {}

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
        <input id="dividendoFechaInput" class="assetModalInput" type="text" value="${escapeDividendosHtml(rowData.fecha || "")}" placeholder="dd-mm-aaaa">
        <label class="assetModalLabel" for="dividendoInstrumentoInput">Instrumento</label>
        <select id="dividendoInstrumentoInput" class="assetModalSelect">
            ${buildDividendosInstrumentoOptions(rowData.instrumento || "")}
        </select>
        <label class="assetModalLabel" for="dividendoAccionesInput">Acciones</label>
        <input id="dividendoAccionesInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeDividendosHtml(rowData.acciones || "")}" placeholder="0">
        <label class="assetModalLabel" for="dividendoPorAccionInput">Dividendos / Acción</label>
        <input id="dividendoPorAccionInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeDividendosHtml(rowData.dividendoAccion || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="dividendoImpuestosInput">Impuestos</label>
        <input id="dividendoImpuestosInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeDividendosHtml(rowData.impuestos || "")}" placeholder="0,00">
        <label class="assetModalLabel" for="dividendoTotalInput">Total</label>
        <input id="dividendoTotalInput" class="assetModalInput" type="text" inputmode="decimal" value="${escapeDividendosHtml(rowData.total || "")}" placeholder="0,00">
        <p class="gastosCreateModalFeedback hidden" id="dividendosModalFeedback"></p>
        <div class="assetModalActions dividendosModalActions">
            <button type="button" class="secondaryButton" id="dividendosModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="dividendosModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    const setFeedback = (message = "", isError = false) => {
        const node = modal.querySelector("#dividendosModalFeedback")
        if (!node) return
        node.textContent = message
        node.classList.toggle("hidden", !message)
        node.classList.toggle("error", Boolean(message && isError))
    }

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) closeDividendosModal()
    })

    modal.querySelector("#dividendosModalCancelBtn")?.addEventListener("click", closeDividendosModal)
    modal.querySelector("#dividendosModalSaveBtn")?.addEventListener("click", async () => {
        const fecha = modal.querySelector("#dividendoFechaInput")?.value.trim() || ""
        const instrumento = modal.querySelector("#dividendoInstrumentoInput")?.value.trim() || ""
        const accionesRaw = modal.querySelector("#dividendoAccionesInput")?.value.trim() || ""
        const dividendoAccionRaw = modal.querySelector("#dividendoPorAccionInput")?.value.trim() || ""
        const impuestosRaw = modal.querySelector("#dividendoImpuestosInput")?.value.trim() || ""
        const totalRaw = modal.querySelector("#dividendoTotalInput")?.value.trim() || ""

        const acciones = accionesRaw ? formatShareQuantity(accionesRaw) : ""
        const dividendoAccion = dividendoAccionRaw ? formatCellDollarValue(dividendoAccionRaw) : ""
        const impuestos = impuestosRaw ? formatCellEuroValue(impuestosRaw) : ""
        const total = totalRaw ? formatCellEuroValue(totalRaw) : ""

        if (!fecha && !instrumento && !acciones && !dividendoAccion && !impuestos && !total) {
            setFeedback("Introduce al menos un dato.", true)
            return
        }

        const nextRows = [...rows]
        const nextRow = { fecha, instrumento, acciones, dividendoAccion, impuestos, total }

        if (isEdit) {
            nextRows[rowIndex] = nextRow
        } else {
            nextRows.push(nextRow)
        }

        try {
            renderDividendosRowsFromData({ rows: nextRows })
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

    const [dividendosData, assetsList] = await Promise.all([
        loadDividendosData(),
        loadAssetsList().catch(() => [])
    ])
    _dividendosAssets = assetsList.filter((a) => a.type === "acciones" || a.type === "etfs")
    renderDividendosRowsFromData(dividendosData)
}

function renderDividendosRowsFromData(dividendosData) {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    dividendosBody.innerHTML = ""

    const rows = Array.isArray(dividendosData?.rows) ? dividendosData.rows : []

    rows.forEach((rowData, index) => {
        const rowElement = document.createElement("tr")
        rowElement.dataset.rowIndex = String(index)
        rowElement.dataset.fecha = String(rowData.fecha || "")
        rowElement.dataset.instrumento = String(rowData.instrumento || "")
        rowElement.dataset.acciones = String(rowData.acciones || "")
        rowElement.dataset.dividendoAccion = String(rowData.dividendoAccion || "")
        rowElement.dataset.impuestos = String(rowData.impuestos || "")
        rowElement.dataset.total = String(rowData.total || "")

        rowElement.innerHTML = `
            <td data-field="fecha">${rowData.fecha || ""}</td>
            <td data-field="instrumento">${rowData.instrumento || ""}</td>
            <td data-field="acciones">${formatShareQuantity(rowData.acciones)}</td>
            <td data-field="dividendoAccion">${formatCellDollarValue(rowData.dividendoAccion)}</td>
            <td data-field="impuestos">${formatCellEuroValue(rowData.impuestos)}</td>
            <td class="rowTotal">${formatCellEuroValue(rowData.total)}</td>
            <td class="rowActionsCell">
                <button type="button" class="assetRowEditBtn dividendosRowEditBtn" data-row-index="${index}" title="Editar fila">✎</button>
                <button type="button" class="assetRowDeleteBtn dividendosRowDeleteBtn" data-row-index="${index}" title="Eliminar fila">✕</button>
            </td>
        `

        dividendosBody.appendChild(rowElement)
    })

    updateDividendosTotals()
}

function collectDividendosDataFromTable() {
    const rowElements = [...document.querySelectorAll("#dividendosBody tr")]

    const rows = rowElements.map((rowElement) => {
        return {
            fecha: rowElement.dataset.fecha || rowElement.querySelector('[data-field="fecha"]')?.textContent.trim() || "",
            instrumento: rowElement.dataset.instrumento || rowElement.querySelector('[data-field="instrumento"]')?.textContent.trim() || "",
            acciones: rowElement.dataset.acciones || rowElement.querySelector('[data-field="acciones"]')?.textContent.trim() || "",
            dividendoAccion: rowElement.dataset.dividendoAccion || rowElement.querySelector('[data-field="dividendoAccion"]')?.textContent.trim() || "",
            impuestos: rowElement.dataset.impuestos || rowElement.querySelector('[data-field="impuestos"]')?.textContent.trim() || "",
            total: rowElement.dataset.total || rowElement.querySelector(".rowTotal")?.textContent.trim() || ""
        }
    })

    return { rows }
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

function updateDividendosTotals() {
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    let totalNeto = 0
    let totalImpuestos = 0

    const rowElements = dividendosBody.querySelectorAll("tr")

    rowElements.forEach((rowElement) => {
        const cells = rowElement.querySelectorAll("td")
        const impuestos = parseEuroNumber(cells[4]?.textContent || "")
        const rowTotal = parseEuroNumber(cells[5]?.textContent || "")

        totalNeto += rowTotal
        totalImpuestos += impuestos
    })

    const totalResumen = document.getElementById("totalDividendosResumen")
    const impuestosResumen = document.getElementById("impuestosDividendosResumen")
    const topTotalDividendos = document.getElementById("topTotalDividendos")

    if (totalResumen) {
        totalResumen.textContent = formatEuro(totalNeto)
    }

    if (impuestosResumen) {
        impuestosResumen.textContent = formatEuro(totalImpuestos)
    }

    if (topTotalDividendos) {
        topTotalDividendos.textContent = formatEuro(totalNeto)
    }
}

function addNewDividendosRow() {
    openDividendosModal(-1)
}

function handleDividendosRowActionClick(event) {
    const editButton = event.target.closest(".dividendosRowEditBtn")
    if (editButton) {
        openDividendosModal(Number(editButton.dataset.rowIndex))
        return
    }

    const deleteButton = event.target.closest(".dividendosRowDeleteBtn")
    if (!deleteButton) {
        return
    }

    const rowIndex = Number(deleteButton.dataset.rowIndex)
    const rows = collectDividendosDataFromTable().rows
    const row = rows[rowIndex]
    const isEmpty = !row || (!row.fecha && !row.instrumento && parseLooseNumber(row.acciones || "") === 0 && parseDollarNumber(row.dividendoAccion || "") === 0 && parseEuroNumber(row.impuestos || "") === 0 && parseEuroNumber(row.total || "") === 0)

    const removeRow = async () => {
        rows.splice(rowIndex, 1)
        renderDividendosRowsFromData({ rows })
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

function exportDividendosJson() {
    const data = collectDividendosDataFromTable()
    const dataString = JSON.stringify(data, null, 2)
    const dataBlob = new Blob([dataString], { type: "application/json" })
    const dataUrl = URL.createObjectURL(dataBlob)
    const downloadLink = document.createElement("a")

    downloadLink.href = dataUrl
    downloadLink.download = "dividendos.json"
    document.body.appendChild(downloadLink)
    downloadLink.click()
    document.body.removeChild(downloadLink)

    URL.revokeObjectURL(dataUrl)
}

function scheduleDividendosAutosave() {
    clearTimeout(dividendosAutosaveTimeout)

    dividendosAutosaveTimeout = setTimeout(async () => {
        try {
            await saveDividendosDataToServer()
        } catch (error) {
            console.error("Error en autoguardado de dividendos:", error)
        }
    }, 500)
}

function importDividendosJson() {
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

            if (!parsedData || !Array.isArray(parsedData.rows)) {
                alert("El JSON no tiene el formato esperado. Debe contener { rows: [...] }")
                return
            }

            renderDividendosRowsFromData(parsedData)
            await saveDividendosDataToServer()
            alert("JSON importado y guardado en data/dividendos.json")
        } catch (error) {
            console.error(error)
            alert("No se pudo importar el JSON.")
        }
    })

    inputFile.click()
}

// ── Calendario Dividendos ────────────────────────────────────────────────────

const CALENDARIO_MONTHS = [
    ["enero", "abril", "julio", "octubre"],
    ["febrero", "mayo", "agosto", "noviembre"],
    ["marzo", "junio", "septiembre", "diciembre"]
]

const CALENDARIO_MONTH_COLORS = {
    enero: "#3a7bd5", febrero: "#3a7bd5", marzo: "#3a7bd5",
    abril: "#3a7bd5", mayo: "#3a7bd5", junio: "#3a7bd5",
    julio: "#3a7bd5", agosto: "#3a7bd5", septiembre: "#3a7bd5",
    octubre: "#3a7bd5", noviembre: "#3a7bd5", diciembre: "#3a7bd5"
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

    const tagsHtml = names.map((name) => `
        <div class="calTag">
            <span class="calTagName">${name}</span>
            <button type="button" class="calTagRemove" data-month="${month}" data-name="${encodeURIComponent(name)}" title="Quitar">×</button>
        </div>
    `).join("")

    const optionsHtml = assets
        .filter((a) => a.type === "acciones" && !names.includes(a.name))
        .map((a) => `<option value="${a.name}">${a.name}</option>`)
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
        tr.innerHTML = row.map((month) =>
            buildCalendarioCell(month, calendar[month] || [], assets)
        ).join("")
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

    ;[_calendarioData, _calendarioAssets] = await Promise.all([
        loadCalendarioData(),
        loadCalendarioAssets()
    ])

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

