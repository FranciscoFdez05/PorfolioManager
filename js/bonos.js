let _bonosCurrentFilter = "all"
let _bonosAutosaveTimer = null

const _TIPO_LABELS = {
    gubernamental: "Gubernamental",
    corporativo: "Corporativo",
    if: "Interés Fijo",
}

const _CURRENCY_SYMBOLS = { EUR: "EUR €", USD: "USD $", GBP: "GBP £", CHF: "CHF ₣", JPY: "JPY ¥" }

function scheduleBonosAutosave(delay = 600) {
    clearTimeout(_bonosAutosaveTimer)
    _bonosAutosaveTimer = setTimeout(async () => {
        try {
            await saveAllBonosData()
            if (typeof refreshTopDividendosIntereses === "function") refreshTopDividendosIntereses()
        } catch (err) {
            console.error("Bonos autosave error:", err)
        }
    }, delay)
}

async function loadAllBonosData() {
    const [bonosResp, rfResp] = await Promise.all([
        fetch("/api/bonos").then(r => r.json()).catch(() => ({ rows: [] })),
        fetch("/api/rentafija").then(r => r.json()).catch(() => ({ rows: [] }))
    ])
    const bonosRows = Array.isArray(bonosResp.rows) ? bonosResp.rows : []
    const rfRows = (Array.isArray(rfResp.rows) ? rfResp.rows : []).map(r => ({
        fecha:            r.fecha || "",
        tipo:             "if",
        currency:         r.currency || "EUR",
        instrumento:      r.instrumento || "",
        cupon:            r.rentabilidad || "",
        vencimiento:      r.vencimiento || "",
        invertido:        r.invertido || "",
        interesAcumulado: r.interesAcumulado || "",
        impuestos:        r.impuestos || "",
        nota:             "",
    }))
    return { rows: [...bonosRows, ...rfRows] }
}

async function saveAllBonosData() {
    const rows = collectAllDataFromTable()

    const bonosRows = rows.filter(r => ["gubernamental", "corporativo"].includes(r.tipo))
    const rfRows = rows
        .filter(r => r.tipo === "if")
        .map(r => ({
            fecha:            r.fecha,
            tipo:             r.tipo,
            currency:         r.currency,
            instrumento:      r.instrumento,
            rentabilidad:     r.cupon,
            vencimiento:      r.vencimiento,
            invertido:        r.invertido,
            interesAcumulado: r.interesAcumulado,
            impuestos:        r.impuestos,
        }))

    const [res1, res2] = await Promise.all([
        fetch("/api/bonos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: bonosRows })
        }),
        fetch("/api/rentafija", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: rfRows })
        })
    ])
    if (!res1.ok) throw new Error(`Bonos: HTTP ${res1.status}`)
    if (!res2.ok) throw new Error(`RentaFija: HTTP ${res2.status}`)
}

function collectAllDataFromTable() {
    return [...document.querySelectorAll("#bonosBody tr")].map((row) => {
        const cells = row.querySelectorAll("td")
        return {
            fecha:            cells[0]?.textContent.trim() || "",
            tipo:             row.dataset.tipo || "gubernamental",
            currency:         row.dataset.currency || "EUR",
            instrumento:      cells[3]?.textContent.trim() || "",
            cupon:            cells[4]?.textContent.trim() || "",
            vencimiento:      cells[5]?.textContent.trim() || "",
            invertido:        cells[6]?.textContent.trim() || "",
            interesAcumulado: cells[7]?.textContent.trim() || "",
            impuestos:        cells[8]?.textContent.trim() || "",
            nota:             "",
        }
    })
}

function buildBonosRow(rowData, index) {
    const tr = document.createElement("tr")
    tr.dataset.tipo = rowData.tipo || "gubernamental"
    tr.dataset.currency = rowData.currency || "EUR"

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
                const rows = collectAllDataFromTable()
                rows.splice(index, 1)
                renderBonosTable({ rows })
                await saveAllBonosData()
            }
        })
    })

    const currency = rowData.currency || "EUR"
    const cellsData = [
        rowData.fecha || "",
        _TIPO_LABELS[rowData.tipo] || rowData.tipo || "",
        _CURRENCY_SYMBOLS[currency] || currency,
        rowData.instrumento || "",
        rowData.cupon || "",
        rowData.vencimiento || "",
        rowData.invertido || "",
        rowData.interesAcumulado || "",
        rowData.impuestos || "",
        formatEuro(parseEuroNumber(rowData.interesAcumulado || "") - parseEuroNumber(rowData.impuestos || "")),
    ]
    cellsData.forEach((text) => {
        const td = document.createElement("td")
        td.textContent = text
        tr.appendChild(td)
    })
    tr.appendChild(actionCell)
    return tr
}

function renderBonosTable(data) {
    const tbody = document.getElementById("bonosBody")
    if (!tbody) return

    tbody.innerHTML = ""
    const rows = Array.isArray(data?.rows) ? data.rows : []
    rows.forEach((rowData, index) => tbody.appendChild(buildBonosRow(rowData, index)))

    updateBonosTotals()
    applyBonosFilter(_bonosCurrentFilter)
    bindTableSort(tbody.closest("table"))
}

function updateBonosTotals() {
    const rows = [...document.querySelectorAll("#bonosBody tr")]

    let totalInteres = 0, totalImpuestos = 0, totalInvertido = 0
    let ifNeto = 0, corpNeto = 0, gubNeto = 0

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

        const tipo = row.dataset.tipo || "gubernamental"
        if (tipo === "if") ifNeto += neto
        else if (tipo === "corporativo") corpNeto += neto
        else gubNeto += neto
    })

    const totalNeto = totalInteres - totalImpuestos
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = formatEuro(val) }
    set("bonosTotalNeto",      totalNeto)
    set("bonosTotalInteres",   totalInteres)
    set("bonosTotalImpuestos", totalImpuestos)
    set("bonosTotalInvertido", totalInvertido)
    set("bonosTotalIf",        ifNeto)
    set("bonosTotalCorp",      corpNeto)
    set("bonosTotalGub",       gubNeto)

    const emptyEl = document.getElementById("bonosEmpty")
    if (emptyEl) emptyEl.classList.toggle("hidden", rows.length > 0)
}

function applyBonosFilter(tipo) {
    _bonosCurrentFilter = tipo
    document.querySelectorAll("#bonosBody tr").forEach((row) => {
        const rowTipo = row.dataset.tipo || ""
        let visible = false
        if (tipo === "all") visible = true
        else if (tipo === "if") visible = rowTipo === "if"
        else visible = rowTipo === tipo
        row.style.display = visible ? "" : "none"
    })
}

function openBonosEditModal(rowIndex = -1) {
    const rows = collectAllDataFromTable()
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? rows[rowIndex] : {}

    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"

    const modal = document.createElement("div")
    modal.className = "assetModal"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar registro" : "Nuevo registro"}</h3>

        <label class="assetModalLabel" for="bonosFechaInput">Fecha</label>
        <input id="bonosFechaInput" class="assetModalInput" type="text" value="${rowData.fecha || ""}" placeholder="dd-mm-aaaa">

        <label class="assetModalLabel" for="bonosTipoSelect">Tipo</label>
        <select id="bonosTipoSelect" class="assetModalSelect">
            <option value="gubernamental"${(rowData.tipo || "gubernamental") === "gubernamental" ? " selected" : ""}>Bono Gubernamental</option>
            <option value="corporativo"${rowData.tipo === "corporativo" ? " selected" : ""}>Bono Corporativo</option>
            <option value="if"${rowData.tipo === "if" ? " selected" : ""}>Interés Fijo</option>
        </select>

        <label class="assetModalLabel" for="bonosCurrencySelect">Moneda</label>
        <select id="bonosCurrencySelect" class="assetModalSelect">
            <option value="EUR"${(rowData.currency || "EUR") === "EUR" ? " selected" : ""}>EUR €</option>
            <option value="USD"${rowData.currency === "USD" ? " selected" : ""}>USD $</option>
            <option value="GBP"${rowData.currency === "GBP" ? " selected" : ""}>GBP £</option>
            <option value="CHF"${rowData.currency === "CHF" ? " selected" : ""}>CHF ₣</option>
            <option value="JPY"${rowData.currency === "JPY" ? " selected" : ""}>JPY ¥</option>
        </select>

        <label class="assetModalLabel" for="bonosInstrumentoInput">Instrumento</label>
        <input id="bonosInstrumentoInput" class="assetModalInput" type="text" value="${rowData.instrumento || ""}" placeholder="Ej: Bonos del Estado">

        <label class="assetModalLabel" for="bonosCuponInput">Cupón / Rentabilidad</label>
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

    const closeModal = () => overlay.remove()
    modal.querySelector("#bonosModalCancelBtn").addEventListener("click", closeModal)
    modal.querySelector("#bonosModalSaveBtn").addEventListener("click", async () => {
        const fecha           = modal.querySelector("#bonosFechaInput").value.trim()
        const tipo            = modal.querySelector("#bonosTipoSelect").value
        const currency        = modal.querySelector("#bonosCurrencySelect").value
        const instrumento     = modal.querySelector("#bonosInstrumentoInput").value.trim()
        const cupon           = modal.querySelector("#bonosCuponInput").value.trim()
        const vencimiento     = modal.querySelector("#bonosVencimientoInput").value.trim()
        const invertidoRaw    = modal.querySelector("#bonosInvertidoInput").value.trim()
        const interesRaw      = modal.querySelector("#bonosInteresInput").value.trim()
        const impuestosRaw    = modal.querySelector("#bonosImpuestosInput").value.trim()

        const invertido        = invertidoRaw ? formatCellEuroValue(invertidoRaw) : ""
        const interesAcumulado = interesRaw   ? formatCellEuroValue(interesRaw)   : ""
        const impuestos        = impuestosRaw ? formatCellEuroValue(impuestosRaw) : ""

        const newRow = { fecha, tipo, currency, instrumento, cupon, vencimiento, invertido, interesAcumulado, impuestos, nota: "" }

        if (isEdit) {
            rows[rowIndex] = newRow
        } else {
            rows.push(newRow)
        }

        renderBonosTable({ rows })
        await saveAllBonosData()
        closeModal()
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

async function initBonosLogic() {
    _bonosCurrentFilter = "all"

    const allData = await loadAllBonosData()
    renderBonosTable(allData)

    document.getElementById("bonosAddBtn")?.addEventListener("click", () => openBonosEditModal())

    document.getElementById("saveBonosBtn")?.addEventListener("click", async () => {
        try { await saveAllBonosData() } catch (err) { console.error(err) }
    })

    document.querySelectorAll("#bonosFilters .bonosFilterBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll("#bonosFilters .bonosFilterBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            applyBonosFilter(btn.dataset.tipo)
        })
    })
}
