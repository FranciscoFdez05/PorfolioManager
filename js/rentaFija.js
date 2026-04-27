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
            return {
                fecha:            cells[0]?.textContent.trim() || "",
                tipo:             row.dataset.tipo || "bancario",
                instrumento:      cells[2]?.textContent.trim() || "",
                rentabilidad:     cells[3]?.textContent.trim() || "",
                vencimiento:      cells[4]?.textContent.trim() || "",
                invertido:        cells[5]?.textContent.trim() || "",
                interesAcumulado: cells[6]?.textContent.trim() || "",
                impuestos:        cells[7]?.textContent.trim() || "",
            }
        })
    }
}

function openRentaFijaEditModal(rowIndex = -1) {
    const data = collectRentaFijaDataFromTable()
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? data.rows[rowIndex] : {}

    // Crear overlay y modal
    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"

    const modal = document.createElement("div")
    modal.className = "assetModal"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar renta fija" : "Nueva renta fija"}</h3>

        <label class="assetModalLabel" for="rfFechaInput">Fecha</label>
        <input id="rfFechaInput" class="assetModalInput" type="text" value="${rowData.fecha || ""}" placeholder="dd-mm-aaaa">

        <label class="assetModalLabel" for="rfTipoSelect">Tipo</label>
        <select id="rfTipoSelect" class="assetModalSelect">
            <option value="bancario"${(rowData.tipo || "bancario") === "bancario" ? " selected" : ""}>Bancario</option>
            <option value="estatal"${rowData.tipo === "estatal" ? " selected" : ""}>Estatal</option>
        </select>

        <label class="assetModalLabel" for="rfInstrumentoInput">Instrumento</label>
        <input id="rfInstrumentoInput" class="assetModalInput" type="text" value="${rowData.instrumento || ""}" placeholder="Ej: Depósito bancario">

        <label class="assetModalLabel" for="rfRentabilidadInput">Rentabilidad</label>
        <input id="rfRentabilidadInput" class="assetModalInput" type="text" value="${rowData.rentabilidad || ""}" placeholder="Ej: 2,5%">

        <label class="assetModalLabel" for="rfVencimientoInput">Vencimiento</label>
        <input id="rfVencimientoInput" class="assetModalInput" type="text" value="${rowData.vencimiento || ""}" placeholder="dd-mm-aaaa">

        <label class="assetModalLabel" for="rfInvertidoInput">Invertido</label>
        <input id="rfInvertidoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.invertido ? formatCellEuroValue(rowData.invertido) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="rfInteresInput">Interés acumulado</label>
        <input id="rfInteresInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.interesAcumulado ? formatCellEuroValue(rowData.interesAcumulado) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="rfImpuestosInput">Impuestos</label>
        <input id="rfImpuestosInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.impuestos ? formatCellEuroValue(rowData.impuestos) : ""}" placeholder="0,00">

        <div class="assetModalActions rentaFijaModalActions">
            <button type="button" id="rfModalCancelBtn" class="cancelButton">Cancelar</button>
            <button type="button" id="rfModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
        </div>
    `

    function closeModal() {
        overlay.remove()
    }

    // Event listeners
    overlay.addEventListener("click", (event) => {
        if (event.target === overlay) {
            // closeModal() // Deshabilitado para evitar cierre accidental
        }
    })

    modal.querySelector("#rfModalCancelBtn").addEventListener("click", closeModal)
    modal.querySelector("#rfModalSaveBtn").addEventListener("click", async () => {
        const fecha = modal.querySelector("#rfFechaInput").value.trim()
        const tipo = modal.querySelector("#rfTipoSelect").value
        const instrumento = modal.querySelector("#rfInstrumentoInput").value.trim()
        const rentabilidad = modal.querySelector("#rfRentabilidadInput").value.trim()
        const vencimiento = modal.querySelector("#rfVencimientoInput").value.trim()
        const invertidoRaw = modal.querySelector("#rfInvertidoInput").value.trim()
        const interesRaw = modal.querySelector("#rfInteresInput").value.trim()
        const impuestosRaw = modal.querySelector("#rfImpuestosInput").value.trim()

        const invertido = invertidoRaw ? formatCellEuroValue(invertidoRaw) : ""
        const interesAcumulado = interesRaw ? formatCellEuroValue(interesRaw) : ""
        const impuestos = impuestosRaw ? formatCellEuroValue(impuestosRaw) : ""

        if (isEdit) {
            data.rows[rowIndex] = { fecha, tipo, instrumento, rentabilidad, vencimiento, invertido, interesAcumulado, impuestos }
        } else {
            data.rows.push({ fecha, tipo, instrumento, rentabilidad, vencimiento, invertido, interesAcumulado, impuestos })
        }

        renderRentaFijaTable(data)
        await saveRentaFijaDataToServer()
        closeModal()
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

function buildRentaFijaRow(rowData, index) {
    const tr = document.createElement("tr")
    tr.dataset.tipo = rowData.tipo || "bancario"

    const actionCell = document.createElement("td")
    actionCell.className = "rowActionsCell"
    actionCell.innerHTML = `
        <button type="button" class="assetRowEditBtn rfRowEditBtn" title="Editar fila">✎</button>
        <button type="button" class="assetRowDeleteBtn rfRowDeleteBtn" title="Eliminar fila">✕</button>
    `
    actionCell.querySelector(".rfRowEditBtn").addEventListener("click", () => openRentaFijaEditModal(index))
    actionCell.querySelector(".rfRowDeleteBtn").addEventListener("click", () => {
        openConfirmModal({
            title: "Eliminar fila",
            message: "¿Quieres eliminar esta fila?",
            confirmLabel: "Eliminar",
            onConfirm: async () => {
                const data = collectRentaFijaDataFromTable()
                data.rows.splice(index, 1)
                renderRentaFijaTable(data)
                await saveRentaFijaDataToServer()
            }
        })
    })
    const fechaCell = document.createElement("td")
    fechaCell.textContent = rowData.fecha || ""
    tr.appendChild(fechaCell)

    const tipoCell = document.createElement("td")
    const tipoLabels = { bancario: "Bancario", estatal: "Estatal" }
    tipoCell.textContent = tipoLabels[rowData.tipo] || rowData.tipo || "Bancario"
    tr.appendChild(tipoCell)

    const instrumentoCell = document.createElement("td")
    instrumentoCell.textContent = rowData.instrumento || ""
    tr.appendChild(instrumentoCell)

    const rentabilidadCell = document.createElement("td")
    rentabilidadCell.textContent = rowData.rentabilidad || ""
    tr.appendChild(rentabilidadCell)

    const vencimientoCell = document.createElement("td")
    vencimientoCell.textContent = rowData.vencimiento || ""
    tr.appendChild(vencimientoCell)

    const invertidoCell = document.createElement("td")
    invertidoCell.textContent = rowData.invertido || ""
    tr.appendChild(invertidoCell)

    const interesCell = document.createElement("td")
    interesCell.textContent = rowData.interesAcumulado || ""
    tr.appendChild(interesCell)

    const impuestosCell = document.createElement("td")
    impuestosCell.textContent = rowData.impuestos || ""
    tr.appendChild(impuestosCell)

    const netoCell = document.createElement("td")
    netoCell.textContent = formatEuro(parseEuroNumber(rowData.interesAcumulado || "") - parseEuroNumber(rowData.impuestos || ""))
    tr.appendChild(netoCell)

    tr.appendChild(actionCell)

    return tr
}

function renderRentaFijaTable(data) {
    const tbody = document.getElementById("rentaFijaBody")
    if (!tbody) return
    tbody.innerHTML = ""
    const rows = Array.isArray(data?.rows) ? data.rows : []
    rows.forEach((rowData, index) => tbody.appendChild(buildRentaFijaRow(rowData, index)))
    updateRentaFijaTotals()
    applyRentaFijaFilter(_rfCurrentFilter)
    bindTableSort(tbody.closest("table"))
}

function updateRentaFijaTotals() {
    const rows = [...document.querySelectorAll("#rentaFijaBody tr")]
    let totalInteres = 0, totalImpuestos = 0, totalInvertido = 0
    let bancarioNeto = 0, estatalNeto = 0

    rows.forEach((row) => {
        const cells = row.querySelectorAll("td")
        const interes   = parseEuroNumber(cells[6]?.textContent || "")
        const impuestos = parseEuroNumber(cells[7]?.textContent || "")
        const invertido = parseEuroNumber(cells[5]?.textContent || "")
        const neto = interes - impuestos

        if (cells[8]) cells[8].textContent = formatEuro(neto)

        totalInteres   += interes
        totalImpuestos += impuestos
        totalInvertido += invertido

        const tipo = row.dataset.tipo || cells[1]?.querySelector("select")?.value || "bancario"
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
            // Los botones de editar y eliminar se manejan en buildRentaFijaRow
        })
    }

    const addBtn = document.getElementById("rentaFijaAddBtn")
    if (addBtn) {
        addBtn.addEventListener("click", () => {
            openRentaFijaEditModal()
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
