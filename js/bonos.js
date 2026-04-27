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
            return {
                fecha:            cells[0]?.textContent.trim() || "",
                tipo:             row.dataset.tipo || "gubernamental",
                instrumento:      cells[2]?.textContent.trim() || "",
                cupon:            cells[3]?.textContent.trim() || "",
                vencimiento:      cells[4]?.textContent.trim() || "",
                invertido:        cells[5]?.textContent.trim() || "",
                interesAcumulado: cells[6]?.textContent.trim() || "",
                impuestos:        cells[7]?.textContent.trim() || "",
            }
        })
    }
}

function openBonosEditModal(rowIndex = -1) {
    const data = collectBonosDataFromTable()
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? data.rows[rowIndex] : {}

    // Crear overlay y modal
    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"

    const modal = document.createElement("div")
    modal.className = "assetModal"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar bono" : "Nuevo bono"}</h3>

        <label class="assetModalLabel" for="bonosFechaInput">Fecha</label>
        <input id="bonosFechaInput" class="assetModalInput" type="text" value="${rowData.fecha || ""}" placeholder="dd-mm-aaaa">

        <label class="assetModalLabel" for="bonosTipoSelect">Tipo</label>
        <select id="bonosTipoSelect" class="assetModalSelect">
            <option value="gubernamental"${(rowData.tipo || "gubernamental") === "gubernamental" ? " selected" : ""}>Gubernamental</option>
            <option value="corporativo"${rowData.tipo === "corporativo" ? " selected" : ""}>Corporativo</option>
        </select>

        <label class="assetModalLabel" for="bonosInstrumentoInput">Instrumento</label>
        <input id="bonosInstrumentoInput" class="assetModalInput" type="text" value="${rowData.instrumento || ""}" placeholder="Ej: Bonos del Estado">

        <label class="assetModalLabel" for="bonosCuponInput">Cupón</label>
        <input id="bonosCuponInput" class="assetModalInput" type="text" value="${rowData.cupon || ""}" placeholder="Ej: 3,5%">

        <label class="assetModalLabel" for="bonosVencimientoInput">Vencimiento</label>
        <input id="bonosVencimientoInput" class="assetModalInput" type="text" value="${rowData.vencimiento || ""}" placeholder="dd-mm-aaaa">

        <label class="assetModalLabel" for="bonosInvertidoInput">Invertido</label>
        <input id="bonosInvertidoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.invertido ? formatCellEuroValue(rowData.invertido) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="bonosInteresInput">Interés acumulado</label>
        <input id="bonosInteresInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.interesAcumulado ? formatCellEuroValue(rowData.interesAcumulado) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="bonosImpuestosInput">Impuestos</label>
        <input id="bonosImpuestosInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.impuestos ? formatCellEuroValue(rowData.impuestos) : ""}" placeholder="0,00">

        <div class="assetModalActions bonosModalActions">
            <button type="button" id="bonosModalCancelBtn" class="cancelButton">Cancelar</button>
            <button type="button" id="bonosModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
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

    modal.querySelector("#bonosModalCancelBtn").addEventListener("click", closeModal)
    modal.querySelector("#bonosModalSaveBtn").addEventListener("click", async () => {
        const fecha = modal.querySelector("#bonosFechaInput").value.trim()
        const tipo = modal.querySelector("#bonosTipoSelect").value
        const instrumento = modal.querySelector("#bonosInstrumentoInput").value.trim()
        const cupon = modal.querySelector("#bonosCuponInput").value.trim()
        const vencimiento = modal.querySelector("#bonosVencimientoInput").value.trim()
        const invertidoRaw = modal.querySelector("#bonosInvertidoInput").value.trim()
        const interesRaw = modal.querySelector("#bonosInteresInput").value.trim()
        const impuestosRaw = modal.querySelector("#bonosImpuestosInput").value.trim()

        const invertido = invertidoRaw ? formatCellEuroValue(invertidoRaw) : ""
        const interesAcumulado = interesRaw ? formatCellEuroValue(interesRaw) : ""
        const impuestos = impuestosRaw ? formatCellEuroValue(impuestosRaw) : ""

        if (isEdit) {
            data.rows[rowIndex] = { fecha, tipo, instrumento, cupon, vencimiento, invertido, interesAcumulado, impuestos }
        } else {
            data.rows.push({ fecha, tipo, instrumento, cupon, vencimiento, invertido, interesAcumulado, impuestos })
        }

        renderBonosTable(data)
        await saveBonosDataToServer()
        closeModal()
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

function buildBonosRow(rowData, index) {
    const tr = document.createElement("tr")
    tr.dataset.tipo = rowData.tipo || "gubernamental"

    const actionCell = document.createElement("td")
    actionCell.className = "rowActionsCell"
    actionCell.innerHTML = `
        <button type="button" class="assetRowEditBtn bonosRowEditBtn" title="Editar fila">✎</button>
        <button type="button" class="assetRowDeleteBtn bonosRowDeleteBtn" title="Eliminar fila">✕</button>
    `
    actionCell.querySelector(".bonosRowEditBtn").addEventListener("click", () => openBonosEditModal(index))
    actionCell.querySelector(".bonosRowDeleteBtn").addEventListener("click", () => {
        openConfirmModal({
            title: "Eliminar fila",
            message: "¿Quieres eliminar esta fila?",
            confirmLabel: "Eliminar",
            onConfirm: async () => {
                const data = collectBonosDataFromTable()
                data.rows.splice(index, 1)
                renderBonosTable(data)
                await saveBonosDataToServer()
            }
        })
    })
    const fechaCell = document.createElement("td")
    fechaCell.textContent = rowData.fecha || ""
    tr.appendChild(fechaCell)

    const tipoCell = document.createElement("td")
    const tipoLabels = { gubernamental: "Gubernamental", corporativo: "Corporativo" }
    tipoCell.textContent = tipoLabels[rowData.tipo] || rowData.tipo || "Gubernamental"
    tr.appendChild(tipoCell)

    const instrumentoCell = document.createElement("td")
    instrumentoCell.textContent = rowData.instrumento || ""
    tr.appendChild(instrumentoCell)

    const cuponCell = document.createElement("td")
    cuponCell.textContent = rowData.cupon || ""
    tr.appendChild(cuponCell)

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

function renderBonosTable(data) {
    const tbody = document.getElementById("bonosBody")
    if (!tbody) return

    tbody.innerHTML = ""
    const rows = Array.isArray(data?.rows) ? data.rows : []
    rows.forEach((rowData, index) => {
        tbody.appendChild(buildBonosRow(rowData, index))
    })

    updateBonosTotals()
    applyBonosFilter(_bonosCurrentFilter)
    bindTableSort(tbody.closest("table"))
}

function updateBonosTotals() {
    const rows = [...document.querySelectorAll("#bonosBody tr")]

    let totalInteres = 0, totalImpuestos = 0, totalInvertido = 0
    let gubNeto = 0, corpNeto = 0

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

        const tipo = row.dataset.tipo || cells[1]?.querySelector("select")?.value || "gubernamental"
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
            // Los botones de editar y eliminar se manejan en buildBonosRow
        })
    }

    const addBtn = document.getElementById("bonosAddBtn")
    if (addBtn) {
        addBtn.addEventListener("click", () => {
            openBonosEditModal()
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
