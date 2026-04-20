let _rfCurrentFilter = "all"
let _rfAutosaveTimer = null

function scheduleRentaFijaAutosave(delay = 600) {
    clearTimeout(_rfAutosaveTimer)
    _rfAutosaveTimer = setTimeout(async () => {
        try {
            await saveRentaFijaDataToServer()
            if (typeof refreshTopDividendosIntereses === "function") refreshTopDividendosIntereses()
        } catch (err) {
            console.error("RentaFija autosave error:", err)
        }
    }, delay)
}

async function loadRentaFijaData() {
    try {
        const response = await fetch("/api/rentafija")
        if (!response.ok) throw new Error("No se pudo cargar /api/rentafija")
        return await response.json()
    } catch (error) {
        console.error("Error cargando renta fija:", error)
        return { rows: [] }
    }
}

async function saveRentaFijaDataToServer() {
    const data = collectRentaFijaDataFromTable()
    const response = await fetch("/api/rentafija", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
    })
    if (!response.ok) {
        const errorText = await response.text()
        throw new Error(`HTTP ${response.status}: ${errorText}`)
    }
}

function collectRentaFijaDataFromTable() {
    const rows = [...document.querySelectorAll("#rentaFijaBody tr")]
    return {
        rows: rows.map((row) => {
            const cells = row.querySelectorAll("td")
            const tipoSelect = cells[2]?.querySelector("select")
            return {
                fecha:            cells[1]?.textContent.trim() || "",
                tipo:             tipoSelect?.value || "bancario",
                instrumento:      cells[3]?.textContent.trim() || "",
                rentabilidad:     cells[4]?.textContent.trim() || "",
                vencimiento:      cells[5]?.textContent.trim() || "",
                invertido:        cells[6]?.textContent.trim() || "",
                interesAcumulado: cells[7]?.textContent.trim() || "",
                impuestos:        cells[8]?.textContent.trim() || "",
            }
        })
    }
}

function buildRentaFijaRow(rowData = {}) {
    const tipo = rowData.tipo || "bancario"
    const tr = document.createElement("tr")
    tr.dataset.tipo = tipo

    tr.innerHTML = `
        <td class="rowDeleteCell"><button type="button" class="rowDeleteBtn" title="Eliminar fila">X</button></td>
        <td contenteditable="true">${rowData.fecha || ""}</td>
        <td>
            <select class="bonosTipoSelect">
                <option value="bancario"${tipo === "bancario" ? " selected" : ""}>Bancario</option>
                <option value="estatal"${tipo === "estatal" ? " selected" : ""}>Estatal</option>
            </select>
        </td>
        <td contenteditable="true">${rowData.instrumento || ""}</td>
        <td contenteditable="true">${rowData.rentabilidad || ""}</td>
        <td contenteditable="true">${rowData.vencimiento || ""}</td>
        <td contenteditable="true">${rowData.invertido ? formatCellEuroValue(rowData.invertido) : ""}</td>
        <td contenteditable="true">${rowData.interesAcumulado ? formatCellEuroValue(rowData.interesAcumulado) : ""}</td>
        <td contenteditable="true">${rowData.impuestos ? formatCellEuroValue(rowData.impuestos) : ""}</td>
        <td class="bonosTotalCell">0,00 €</td>
    `

    const tipoSelect = tr.querySelector(".bonosTipoSelect")
    tipoSelect.addEventListener("change", () => {
        tr.dataset.tipo = tipoSelect.value
        applyRentaFijaFilter(_rfCurrentFilter)
        updateRentaFijaTotals()
        scheduleRentaFijaAutosave()
    })

    return tr
}

function renderRentaFijaTable(data) {
    const tbody = document.getElementById("rentaFijaBody")
    if (!tbody) return
    tbody.innerHTML = ""
    const rows = Array.isArray(data?.rows) ? data.rows : []
    rows.forEach((rowData) => tbody.appendChild(buildRentaFijaRow(rowData)))
    updateRentaFijaTotals()
    applyRentaFijaFilter(_rfCurrentFilter)
}

function updateRentaFijaTotals() {
    const rows = [...document.querySelectorAll("#rentaFijaBody tr")]
    let totalInteres = 0, totalImpuestos = 0, totalInvertido = 0
    let bancarioNeto = 0, estatalNeto = 0

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

        const tipo = row.dataset.tipo || cells[2]?.querySelector("select")?.value || "bancario"
        if (tipo === "bancario") bancarioNeto += neto
        else estatalNeto += neto
    })

    const totalNeto = totalInteres - totalImpuestos
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = formatEuro(val) }
    set("rfTotalNeto", totalNeto)
    set("rfTotalInteres", totalInteres)
    set("rfTotalImpuestos", totalImpuestos)
    set("rfTotalInvertido", totalInvertido)
    set("rfTotalBancario", bancarioNeto)
    set("rfTotalEstatal", estatalNeto)

    const emptyEl = document.getElementById("rentaFijaEmpty")
    if (emptyEl) emptyEl.classList.toggle("hidden", rows.length > 0)
}

function applyRentaFijaFilter(tipo) {
    _rfCurrentFilter = tipo
    document.querySelectorAll("#rentaFijaBody tr").forEach((row) => {
        row.style.display = (tipo === "all" || row.dataset.tipo === tipo) ? "" : "none"
    })
}

async function initRentaFijaLogic() {
    _rfCurrentFilter = "all"

    const data = await loadRentaFijaData()
    renderRentaFijaTable(data)

    const tbody = document.getElementById("rentaFijaBody")
    if (tbody) {
        tbody.addEventListener("click", (e) => {
            if (e.target.classList.contains("rowDeleteBtn")) {
                e.target.closest("tr")?.remove()
                updateRentaFijaTotals()
                scheduleRentaFijaAutosave()
            }
        })

        tbody.addEventListener("input", (e) => {
            if (e.target.tagName === "TD") {
                updateRentaFijaTotals()
                scheduleRentaFijaAutosave()
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
                updateRentaFijaTotals()
            }
            scheduleRentaFijaAutosave()
        }, true)
    }

    const addBtn = document.getElementById("rentaFijaAddBtn")
    if (addBtn) {
        addBtn.addEventListener("click", () => {
            const tbody2 = document.getElementById("rentaFijaBody")
            if (!tbody2) return
            const row = buildRentaFijaRow({ tipo: _rfCurrentFilter === "all" ? "bancario" : _rfCurrentFilter })
            tbody2.appendChild(row)
            updateRentaFijaTotals()
            applyRentaFijaFilter(_rfCurrentFilter)
            scheduleRentaFijaAutosave()
        })
    }

    const saveBtn = document.getElementById("saveRentaFijaBtn")
    if (saveBtn) {
        saveBtn.addEventListener("click", async () => {
            try {
                await saveRentaFijaDataToServer()
            } catch (err) {
                console.error("Error guardando renta fija:", err)
            }
        })
    }

    document.querySelectorAll(".bonosFilterBtn").forEach((btn) => {
        if (!btn.closest(".rentaFijaPage")) return
        btn.addEventListener("click", () => {
            document.querySelectorAll(".rentaFijaPage .bonosFilterBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            applyRentaFijaFilter(btn.dataset.tipo)
        })
    })
}
