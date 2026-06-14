let _pmCurrentFilter = "all"

const _PM_TIPO_LABELS = {
    pe:              "Private Equity",
    vc:              "Venture Capital",
    credito:         "Crédito Privado",
    inmobiliario:    "Inmobiliario",
    infraestructura: "Infraestructura",
    otros:           "Otros",
}

const _PM_CURRENCY_SYMBOLS_BASE = { EUR: "EUR €", USD: "USD $", GBP: "GBP £", CHF: "CHF ₣", JPY: "JPY ¥" }

function _pmGetCurrencySymbols() {
    const codes = window._fiatCurrencies?.length ? window._fiatCurrencies : Object.keys(_PM_CURRENCY_SYMBOLS_BASE)
    const result = {}
    codes.forEach((c) => { result[c] = _PM_CURRENCY_SYMBOLS_BASE[c] || c })
    return result
}

async function loadPrivateMarketData() {
    const resp = await fetch("/api/privatemarket").then(r => r.json()).catch(() => ({ rows: [] }))
    return { rows: Array.isArray(resp.rows) ? resp.rows : [] }
}

async function savePrivateMarketData() {
    const rows = _pmCollectRows()
    const res = await fetch("/api/privatemarket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows })
    })
    if (!res.ok) throw new Error(`Private Market: HTTP ${res.status}`)
}

function _pmCollectRows() {
    return [...document.querySelectorAll("#pmBody tr")].map((row) => {
        const cells = row.querySelectorAll("td")
        return {
            fecha:        cells[0]?.textContent.trim() || "",
            tipo:         row.dataset.tipo || "pe",
            nombre:       cells[2]?.textContent.trim() || "",
            gestor:       cells[3]?.textContent.trim() || "",
            vintage:      cells[4]?.textContent.trim() || "",
            currency:     row.dataset.currency || "EUR",
            comprometido: cells[6]?.textContent.trim() || "",
            llamado:      cells[7]?.textContent.trim() || "",
            distribuido:  cells[8]?.textContent.trim() || "",
            valorActual:  cells[9]?.textContent.trim() || "",
            nota:         row.dataset.nota || "",
        }
    })
}

function _pmCalcTvpi(llamado, distribuido, valorActual) {
    if (llamado <= 0) return null
    return (distribuido + valorActual) / llamado
}

function _pmBuildRow(rowData, index) {
    const tr = document.createElement("tr")
    tr.dataset.tipo = rowData.tipo || "pe"
    tr.dataset.currency = rowData.currency || "EUR"
    tr.dataset.nota = rowData.nota || ""

    const actionCell = document.createElement("td")
    actionCell.className = "rowActionsCell"
    actionCell.innerHTML = `
        <div class="rowMenu">
            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
            <div class="rowMenuDropdown">
                <button type="button" class="rowMenuItem avActionBtn avEditBtn">Editar</button>
                <hr>
                <button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn">Eliminar</button>
            </div>
        </div>
    `
    actionCell.querySelector(".avEditBtn").addEventListener("click", () => _pmOpenEditModal(index))
    actionCell.querySelector(".avDeleteBtn").addEventListener("click", () => {
        openConfirmModal({
            title: "Eliminar inversión",
            message: "¿Quieres eliminar esta inversión?",
            confirmLabel: "Eliminar",
            onConfirm: async () => {
                const rows = _pmCollectRows()
                rows.splice(index, 1)
                renderPrivateMarketTable({ rows })
                await savePrivateMarketData()
            }
        })
    })

    const llamado     = parseEuroNumber(rowData.llamado || "")
    const distribuido = parseEuroNumber(rowData.distribuido || "")
    const valorActual = parseEuroNumber(rowData.valorActual || "")
    const neto        = distribuido + valorActual - llamado
    const tvpi        = _pmCalcTvpi(llamado, distribuido, valorActual)

    const currency = rowData.currency || "EUR"
    const currLabel = (_pmGetCurrencySymbols()[currency] || currency)
    const tipo = rowData.tipo || "pe"

    const cells = [
        { text: rowData.fecha || "" },
        { html: `<span class="pmTipoPill pmTipoPill--${tipo}">${_PM_TIPO_LABELS[tipo] || tipo}</span>` },
        { text: rowData.nombre || "" },
        { text: rowData.gestor || "" },
        { text: rowData.vintage || "" },
        { text: currLabel },
        { text: rowData.comprometido || "" },
        { text: rowData.llamado || "" },
        { text: rowData.distribuido || "" },
        { text: rowData.valorActual || "" },
        { text: formatEuro(neto), cls: neto >= 0 ? "pmNetoPos" : "pmNetoNeg" },
        { text: tvpi !== null ? tvpi.toFixed(2) + "x" : "—" },
    ]
    cells.forEach(({ text, html, cls }) => {
        const td = document.createElement("td")
        if (html) td.innerHTML = html
        else td.textContent = text
        if (cls) td.classList.add(cls)
        tr.appendChild(td)
    })
    tr.appendChild(actionCell)
    return tr
}

function renderPrivateMarketTable(data) {
    const tbody = document.getElementById("pmBody")
    if (!tbody) return

    tbody.innerHTML = ""
    const rows = Array.isArray(data?.rows) ? data.rows : []
    rows.forEach((rowData, index) => tbody.appendChild(_pmBuildRow(rowData, index)))

    _pmUpdateTotals()
    _pmApplyFilter(_pmCurrentFilter)
    if (rows.length) bindTableSort(tbody.closest("table"), "pm")
}

function _pmUpdateTotals() {
    const rows = [...document.querySelectorAll("#pmBody tr")]

    let totalComprometido = 0, totalLlamado = 0, totalDistribuido = 0, totalValorActual = 0

    rows.forEach((row) => {
        const cells = row.querySelectorAll("td")
        totalComprometido += parseEuroNumber(cells[6]?.textContent || "")
        totalLlamado      += parseEuroNumber(cells[7]?.textContent || "")
        totalDistribuido  += parseEuroNumber(cells[8]?.textContent || "")
        totalValorActual  += parseEuroNumber(cells[9]?.textContent || "")
    })

    const totalNeto = totalDistribuido + totalValorActual - totalLlamado
    const tvpi = totalLlamado > 0 ? (totalDistribuido + totalValorActual) / totalLlamado : null
    const dpi  = totalLlamado > 0 ? totalDistribuido / totalLlamado : null
    const rvpi = totalLlamado > 0 ? totalValorActual / totalLlamado : null

    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
    set("pmTotalComprometido", formatEuro(totalComprometido))
    set("pmTotalLlamado",      formatEuro(totalLlamado))
    set("pmTotalDistribuido",  formatEuro(totalDistribuido))
    set("pmTotalValorActual",  formatEuro(totalValorActual))
    set("pmTotalNeto",         formatEuro(totalNeto))
    set("pmTvpi", tvpi !== null ? tvpi.toFixed(2) + "x" : "—")
    set("pmDpi",  dpi  !== null ? dpi.toFixed(2)  + "x" : "—")
    set("pmRvpi", rvpi !== null ? rvpi.toFixed(2) + "x" : "—")

    const emptyEl   = document.getElementById("pmEmptyMsg")
    const wrapperEl = document.getElementById("pmTableWrapper")
    if (emptyEl)   emptyEl.classList.toggle("hidden", rows.length > 0)
    if (wrapperEl) wrapperEl.classList.toggle("hidden", rows.length === 0)
}

function _pmApplyFilter(tipo) {
    _pmCurrentFilter = tipo
    document.querySelectorAll("#pmBody tr").forEach((row) => {
        const rowTipo = row.dataset.tipo || ""
        const visible = tipo === "all" || (Array.isArray(tipo) ? tipo.includes(rowTipo) : rowTipo === tipo)
        row.style.display = visible ? "" : "none"
    })
}

function _pmOpenEditModal(rowIndex = -1) {
    const rows = _pmCollectRows()
    const isEdit = rowIndex >= 0
    const rowData = isEdit ? rows[rowIndex] : {}

    const overlay = document.createElement("div")
    overlay.className = "modalOverlay"
    overlay.style.zIndex = "20000"

    const currencyOptions = Object.entries(_pmGetCurrencySymbols())
        .map(([code, label]) => `<option value="${code}"${(rowData.currency || "EUR") === code ? " selected" : ""}>${label}</option>`)
        .join("")

    const tipoOptions = Object.entries(_PM_TIPO_LABELS)
        .map(([val, label]) => `<option value="${val}"${(rowData.tipo || "pe") === val ? " selected" : ""}>${label}</option>`)
        .join("")

    const modal = document.createElement("div")
    modal.className = "assetModal"
    modal.innerHTML = `
        <h3 class="assetModalTitle">${isEdit ? "Editar inversión" : "Nueva inversión"}</h3>

        <label class="assetModalLabel" for="pmFechaInput">Fecha de entrada</label>
        <input id="pmFechaInput" class="assetModalInput" type="text" value="${rowData.fecha || ""}" placeholder="dd-mm-aaaa">

        <label class="assetModalLabel" for="pmTipoSelect">Tipo</label>
        <select id="pmTipoSelect" class="assetModalSelect">${tipoOptions}</select>

        <label class="assetModalLabel" for="pmNombreInput">Nombre del fondo / inversión</label>
        <input id="pmNombreInput" class="assetModalInput" type="text" value="${rowData.nombre || ""}" placeholder="Ej: Carlyle Partners VII">

        <label class="assetModalLabel" for="pmGestorInput">Gestor / GP</label>
        <input id="pmGestorInput" class="assetModalInput" type="text" value="${rowData.gestor || ""}" placeholder="Ej: The Carlyle Group">

        <label class="assetModalLabel" for="pmVintageInput">Vintage (año)</label>
        <input id="pmVintageInput" class="assetModalInput" type="text" value="${rowData.vintage || ""}" placeholder="Ej: 2023">

        <label class="assetModalLabel" for="pmCurrencySelect">Moneda</label>
        <select id="pmCurrencySelect" class="assetModalSelect">${currencyOptions}</select>

        <label class="assetModalLabel" for="pmComprometidoInput">Capital comprometido</label>
        <input id="pmComprometidoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.comprometido ? formatCellEuroValue(rowData.comprometido) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmLlamadoInput">Capital llamado (invertido)</label>
        <input id="pmLlamadoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.llamado ? formatCellEuroValue(rowData.llamado) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmDistribuidoInput">Distribuido (retornado)</label>
        <input id="pmDistribuidoInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.distribuido ? formatCellEuroValue(rowData.distribuido) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmValorActualInput">Valor actual (NAV)</label>
        <input id="pmValorActualInput" class="assetModalInput" type="text" inputmode="decimal" value="${rowData.valorActual ? formatCellEuroValue(rowData.valorActual) : ""}" placeholder="0,00">

        <label class="assetModalLabel" for="pmNotaInput">Nota</label>
        <input id="pmNotaInput" class="assetModalInput" type="text" value="${rowData.nota || ""}" placeholder="Opcional">

        <div class="assetModalActions">
            <button type="button" id="pmModalCancelBtn" class="cancelButton">Cancelar</button>
            <button type="button" id="pmModalSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
        </div>
    `

    const closeModal = () => overlay.remove()
    modal.querySelector("#pmModalCancelBtn").addEventListener("click", closeModal)
    modal.querySelector("#pmModalSaveBtn").addEventListener("click", async () => {
        const fecha        = modal.querySelector("#pmFechaInput").value.trim()
        const tipo         = modal.querySelector("#pmTipoSelect").value
        const nombre       = modal.querySelector("#pmNombreInput").value.trim()
        const gestor       = modal.querySelector("#pmGestorInput").value.trim()
        const vintage      = modal.querySelector("#pmVintageInput").value.trim()
        const currency     = modal.querySelector("#pmCurrencySelect").value
        const comprometidoRaw = modal.querySelector("#pmComprometidoInput").value.trim()
        const llamadoRaw      = modal.querySelector("#pmLlamadoInput").value.trim()
        const distribuidoRaw  = modal.querySelector("#pmDistribuidoInput").value.trim()
        const valorActualRaw  = modal.querySelector("#pmValorActualInput").value.trim()
        const nota         = modal.querySelector("#pmNotaInput").value.trim()

        const comprometido = comprometidoRaw ? formatCellEuroValue(comprometidoRaw) : ""
        const llamado      = llamadoRaw      ? formatCellEuroValue(llamadoRaw)      : ""
        const distribuido  = distribuidoRaw  ? formatCellEuroValue(distribuidoRaw)  : ""
        const valorActual  = valorActualRaw  ? formatCellEuroValue(valorActualRaw)  : ""

        const newRow = { fecha, tipo, nombre, gestor, vintage, currency, comprometido, llamado, distribuido, valorActual, nota }

        if (isEdit) {
            rows[rowIndex] = newRow
        } else {
            rows.push(newRow)
        }

        renderPrivateMarketTable({ rows })
        await savePrivateMarketData()
        closeModal()
    })

    overlay.appendChild(modal)
    document.body.appendChild(overlay)
}

async function initPrivateMarketLogic() {
    _pmCurrentFilter = "all"

    const data = await loadPrivateMarketData()
    renderPrivateMarketTable(data)

    document.getElementById("pmAddBtn")?.addEventListener("click", () => _pmOpenEditModal())

    document.getElementById("savePmBtn")?.addEventListener("click", async () => {
        try { await savePrivateMarketData() } catch (err) { console.error(err) }
    })

    const filtersEl = document.getElementById("pmFilters")
    if (filtersEl) {
        const todosInput = filtersEl.querySelector('[data-tipo="all"] input')
        const getIndividuals = () => [...filtersEl.querySelectorAll('.pmFilterBtn:not([data-tipo="all"]) input')]
        const syncAndApply = () => {
            if (todosInput?.checked) {
                _pmApplyFilter("all")
            } else {
                const sel = getIndividuals().filter(cb => cb.checked).map(cb => cb.closest(".pmFilterBtn").dataset.tipo)
                if (!sel.length && todosInput) todosInput.checked = true
                _pmApplyFilter(sel.length ? sel : "all")
            }
        }
        if (todosInput) todosInput.checked = true
        getIndividuals().forEach(cb => { cb.checked = true })
        if (!filtersEl.dataset.bound) {
            filtersEl.dataset.bound = "true"
            filtersEl.addEventListener("change", (e) => {
                const changed = e.target
                if (changed === todosInput) {
                    changed.checked = true
                    getIndividuals().forEach(cb => { cb.checked = true })
                } else if (todosInput?.checked) {
                    todosInput.checked = false
                    getIndividuals().forEach(cb => { cb.checked = cb === changed })
                    changed.checked = true
                } else {
                    if (todosInput) todosInput.checked = getIndividuals().every(cb => cb.checked)
                }
                syncAndApply()
            })
        }
    }
}
