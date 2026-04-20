let _bonosCurrentFilter = "all"
let _bonosAutosaveTimer = null

function scheduleBonosAutosave(delay = 600) {
    clearTimeout(_bonosAutosaveTimer)
    _bonosAutosaveTimer = setTimeout(async () => {
        try {
            await saveBonosDataToServer()
            if (typeof refreshTopDividendosIntereses === "function") refreshTopDividendosIntereses()
        } catch (err) {
            console.error("Bonos autosave error:", err)
        }
    }, delay)
}

async function loadBonosData() {
    try {
        const response = await fetch("/api/bonos")
        if (!response.ok) throw new Error("No se pudo cargar /api/bonos")
        return await response.json()
    } catch (error) {
        console.error("Error cargando bonos:", error)
        return { rows: [] }
    }
}

async function saveBonosDataToServer() {
    const data = collectBonosDataFromTable()
    const response = await fetch("/api/bonos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

function collectBonosDataFromTable() {
    const rows = [...document.querySelectorAll("#bonosBody tr")]
    return {
        rows: rows.map((row) => {
            const cells = row.querySelectorAll("td")
            const tipoSelect = cells[2]?.querySelector("select")
            return {
                fecha:            cells[1]?.textContent.trim() || "",
                tipo:             tipoSelect?.value || "gubernamental",
                instrumento:      cells[3]?.textContent.trim() || "",
                cupon:            cells[4]?.textContent.trim() || "",
                vencimiento:      cells[5]?.textContent.trim() || "",
                invertido:        cells[6]?.textContent.trim() || "",
                interesAcumulado: cells[7]?.textContent.trim() || "",
                impuestos:        cells[8]?.textContent.trim() || "",
            }
        })
    }
}

function buildBonosRow(rowData = {}) {
    const tipo = rowData.tipo || "gubernamental"
    const tr = document.createElement("tr")
    tr.dataset.tipo = tipo

    tr.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true">${rowData.fecha || ""}</td>
        <td>
            <select class="bonosTipoSelect">
                <option value="gubernamental"${tipo === "gubernamental" ? " selected" : ""}>Gubernamental</option>
                <option value="corporativo"${tipo === "corporativo" ? " selected" : ""}>Corporativo</option>
            </select>
        </td>
        <td contenteditable="true">${rowData.instrumento || ""}</td>
        <td contenteditable="true">${rowData.cupon || ""}</td>
        <td contenteditable="true">${rowData.vencimiento || ""}</td>
        <td contenteditable="true">${rowData.invertido ? formatCellEuroValue(rowData.invertido) : ""}</td>
        <td contenteditable="true">${rowData.interesAcumulado ? formatCellEuroValue(rowData.interesAcumulado) : ""}</td>
        <td contenteditable="true">${rowData.impuestos ? formatCellEuroValue(rowData.impuestos) : ""}</td>
        <td class="bonosTotalCell">0,00 €</td>
    `

    const tipoSelect = tr.querySelector(".bonosTipoSelect")
    tipoSelect.addEventListener("change", () => {
        tr.dataset.tipo = tipoSelect.value
        applyBonosFilter(_bonosCurrentFilter)
        updateBonosTotals()
        scheduleBonosAutosave()
    })

    return tr
}

function renderBonosTable(data) {
    const tbody = document.getElementById("bonosBody")
    if (!tbody) return

    tbody.innerHTML = ""
    const rows = Array.isArray(data?.rows) ? data.rows : []
    rows.forEach((rowData) => {
        tbody.appendChild(buildBonosRow(rowData))
    })

    updateBonosTotals()
    applyBonosFilter(_bonosCurrentFilter)
}

function updateBonosTotals() {
    const rows = [...document.querySelectorAll("#bonosBody tr")]

    let totalInteres = 0, totalImpuestos = 0, totalInvertido = 0
    let gubNeto = 0, corpNeto = 0

    rows.forEach((row) => {
        const cells = row.querySelectorAll("td")
        const interes   = parseEuroNumber(cells[7]?.textContent || "")
        const impuestos = parseEuroNumber(cells[8]?.textContent || "")
        const invertido = parseEuroNumber(cells[6]?.textContent || "")
        const neto = interes - impuestos

        if (cells[9]) cells[9].textContent = formatEuro(neto)

        totalInteres   += interes
        totalImpuestos += impuestos
        totalInvertido += invertido

        const tipo = row.dataset.tipo || cells[2]?.querySelector("select")?.value || "gubernamental"
        if (tipo === "gubernamental") gubNeto += neto
        else corpNeto += neto
    })

    const totalNeto = totalInteres - totalImpuestos

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = formatEuro(val) }
    set("bonosTotalNeto", totalNeto)
    set("bonosTotalInteres", totalInteres)
    set("bonosTotalImpuestos", totalImpuestos)
    set("bonosTotalInvertido", totalInvertido)
    set("bonosTotalGub", gubNeto)
    set("bonosTotalCorp", corpNeto)

    const emptyEl = document.getElementById("bonosEmpty")
    if (emptyEl) emptyEl.classList.toggle("hidden", rows.length > 0)
}

function applyBonosFilter(tipo) {
    _bonosCurrentFilter = tipo
    document.querySelectorAll("#bonosBody tr").forEach((row) => {
        const rowTipo = row.dataset.tipo || ""
        row.style.display = (tipo === "all" || rowTipo === tipo) ? "" : "none"
    })
}

async function initBonosLogic() {
    _bonosCurrentFilter = "all"

    const data = await loadBonosData()
    renderBonosTable(data)

    const tbody = document.getElementById("bonosBody")
    if (tbody) {
        tbody.addEventListener("click", (e) => {
            if (e.target.classList.contains("rowDeleteBtn")) {
                e.target.closest("tr")?.remove()
                updateBonosTotals()
                scheduleBonosAutosave()
            }
        })

        tbody.addEventListener("input", (e) => {
            const cell = e.target
            if (cell.tagName === "TD") {
                updateBonosTotals()
                scheduleBonosAutosave()
            }
        })

        tbody.addEventListener("focus", (e) => {
            const cell = e.target
            if (cell.tagName !== "TD") return
            const col = cell.cellIndex
            if (col === 6 || col === 7 || col === 8) {
                const val = parseEuroNumber(cell.textContent)
                if (cell.textContent.trim() !== "") cell.textContent = normalizeNumberForEdit(val)
            }
        }, true)

        tbody.addEventListener("blur", (e) => {
            const cell = e.target
            if (cell.tagName !== "TD") return
            const col = cell.cellIndex
            if (col === 6 || col === 7 || col === 8) {
                const val = parseEuroNumber(cell.textContent)
                if (cell.textContent.trim() !== "") cell.textContent = formatEuro(val)
                updateBonosTotals()
            }
            scheduleBonosAutosave()
        }, true)
    }

    const addBtn = document.getElementById("bonosAddBtn")
    if (addBtn) {
        addBtn.addEventListener("click", () => {
            const tbody2 = document.getElementById("bonosBody")
            if (!tbody2) return
            const row = buildBonosRow({ tipo: _bonosCurrentFilter === "all" ? "gubernamental" : _bonosCurrentFilter })
            tbody2.appendChild(row)
            updateBonosTotals()
            applyBonosFilter(_bonosCurrentFilter)
            scheduleBonosAutosave()
        })
    }

    const saveBtn = document.getElementById("saveBonosBtn")
    if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
            try {
                await saveBonosDataToServer()
            } catch (err) {
                console.error("Error guardando bonos:", err)
            }
        })
    }

    document.querySelectorAll(".bonosFilterBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".bonosFilterBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            applyBonosFilter(btn.dataset.tipo)
        })
    })
}
