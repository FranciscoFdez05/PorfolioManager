let _dividendosAssets = []

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

    rows.forEach((rowData) => {
        const rowElement = document.createElement("tr")

        rowElement.innerHTML = `
            <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
            <td contenteditable="true">${rowData.fecha || ""}</td>
            <td>${buildDividendosInstrumentoSelect(rowData.instrumento || "")}</td>
            <td contenteditable="true">${formatShareQuantity(rowData.acciones)}</td>
            <td contenteditable="true">${formatCellDollarValue(rowData.dividendoAccion)}</td>
            <td contenteditable="true">${formatCellEuroValue(rowData.impuestos)}</td>
            <td contenteditable="true" class="rowTotal">${formatCellEuroValue(rowData.total)}</td>
        `

        dividendosBody.appendChild(rowElement)
    })

    updateDividendosTotals()
}

function collectDividendosDataFromTable() {
    const rowElements = [...document.querySelectorAll("#dividendosBody tr")]

    const rows = rowElements.map((rowElement) => {
        const cells = rowElement.querySelectorAll("td")

        return {
            fecha: cells[1]?.textContent.trim() || "",
            instrumento: cells[2]?.querySelector("select")?.value || cells[2]?.textContent.trim() || "",
            acciones: cells[3]?.textContent.trim() || "",
            dividendoAccion: cells[4]?.textContent.trim() || "",
            impuestos: cells[5]?.textContent.trim() || "",
            total: cells[6]?.textContent.trim() || ""
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
        const impuestos = parseEuroNumber(cells[5]?.textContent || "")
        const rowTotal = parseEuroNumber(cells[6]?.textContent || "")

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
    const dividendosBody = document.getElementById("dividendosBody")

    if (!dividendosBody) {
        return
    }

    const rowElement = document.createElement("tr")

    rowElement.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true"></td>
        <td>${buildDividendosInstrumentoSelect("")}</td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true"></td>
        <td contenteditable="true" class="rowTotal"></td>
    `

    dividendosBody.appendChild(rowElement)
    updateDividendosTotals()
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

