const TRADING_TIPO_OPTIONS = ["SCALP", "SWING"]
const TRADING_DIRECCION_OPTIONS = ["LONG", "SHORT"]
const TRADING_RESULTADO_OPTIONS = ["PROFIT", "PÉRDIDA"]

let currentTradingData = { rows: [] }
let tradingAutosaveTimeout = null
let tradingPersistenceBound = false

let _tFilterTipo = new Set(TRADING_TIPO_OPTIONS)
let _tFilterDireccion = new Set(TRADING_DIRECCION_OPTIONS)
let _tFilterResultado = new Set(TRADING_RESULTADO_OPTIONS)
let _tView = "tabla"
let _tHaciendaYear = null

// ── API ────────────────────────────────────────────────────────────────────

async function loadTradingData() {
    const response = await fetch("/api/trading")
    if (!response.ok) throw new Error("No se pudieron cargar los trades")
    return await response.json()
}

async function saveTradingDataApi(payload, options = {}) {
    const response = await fetch("/api/trading", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: Boolean(options.keepalive)
    })
    if (!response.ok) {
        const text = await response.text()
        throw new Error(`HTTP ${response.status}: ${text}`)
    }
}

// ── Normalize ──────────────────────────────────────────────────────────────

function normalizeTradingRow(row = {}) {
    const tipo = TRADING_TIPO_OPTIONS.includes(String(row.tipo || "").trim().toUpperCase())
        ? String(row.tipo).trim().toUpperCase()
        : "SCALP"
    const direccion = TRADING_DIRECCION_OPTIONS.includes(String(row.direccion || "").trim().toUpperCase())
        ? String(row.direccion).trim().toUpperCase()
        : "LONG"
    const resultado = TRADING_RESULTADO_OPTIONS.includes(String(row.resultado || "").trim().toUpperCase())
        ? String(row.resultado).trim().toUpperCase()
        : "PROFIT"

    return {
        id: String(row.id || `trade-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`).trim(),
        fecha: String(row.fecha || "").trim(),
        tipo,
        moneda: String(row.moneda || "").trim().toUpperCase(),
        direccion,
        resultado,
        capital: String(row.capital || "").trim(),
        capital_currency: String(row.capital_currency || "EUR").trim().toUpperCase() || "EUR",
        roi: String(row.roi || "").trim(),
        ganancia: String(row.ganancia || "").trim(),
        ganancia_neta: String(row.ganancia_neta || "").trim(),
    }
}

async function getTradingCurrencyOptions() {
    const BASE = ["EUR", "USD"]
    try {
        const [scRes, actRes] = await Promise.all([
            fetch("/api/stablecoins").catch(() => null),
            fetch("/api/activos").catch(() => null),
        ])
        const scData  = scRes?.ok  ? await scRes.json()  : {}
        const actData = actRes?.ok ? await actRes.json() : {}

        const stablecoins = (scData.enabledSymbols || [])
            .map((s) => String(s).trim().toUpperCase())
            .filter((s) => s && !BASE.includes(s))

        const cryptos = (actData.activos || [])
            .filter((a) => String(a.type || "").toLowerCase() === "cripto")
            .map((a) => String(a.symbol || "").trim().toUpperCase())
            .filter((s) => s && !BASE.includes(s) && !stablecoins.includes(s))

        const unique = [...new Set([...BASE, ...stablecoins, ...cryptos])]
        return unique
    } catch {
        return BASE
    }
}

// ── Init ───────────────────────────────────────────────────────────────────

async function initTradingJournalLogic() {
    const payload = await loadTradingData()
    currentTradingData = {
        rows: Array.isArray(payload?.rows)
            ? payload.rows.map((r) => normalizeTradingRow(r))
            : []
    }
    _tFilterTipo = new Set(TRADING_TIPO_OPTIONS)
    _tFilterDireccion = new Set(TRADING_DIRECCION_OPTIONS)
    _tFilterResultado = new Set(TRADING_RESULTADO_OPTIONS)
    _tView = "tabla"
    _tHaciendaYear = null

    bindTradingPersistenceGuards()
    window.flushPendingPageChanges = flushTradingPendingChanges
    renderTradingFilters()
    renderTradingView()
    bindTradingEvents()
}

// ── Events ─────────────────────────────────────────────────────────────────

function bindTradingEvents() {
    const body = document.getElementById("tradingBody")
    const addBtn = document.getElementById("addTradingRowBtn")
    const saveBtn = document.getElementById("saveTradingBtn")

    if (body && !body.dataset.bound) {
        body.dataset.bound = "true"
        body.addEventListener("click", handleTradingTableClick)
    }

    if (addBtn && !addBtn.dataset.bound) {
        addBtn.dataset.bound = "true"
        addBtn.addEventListener("click", () => openTradingModal(""))
    }

    if (saveBtn && !saveBtn.dataset.bound) {
        saveBtn.dataset.bound = "true"
        saveBtn.addEventListener("click", async () => {
            try {
                await persistTradingData()
                alert("Trades guardados correctamente")
            } catch (err) {
                console.error(err)
                alert("No se pudieron guardar los trades.")
            }
        })
    }

    document.querySelectorAll(".tradingFilters input[data-tfilter]").forEach((input) => {
        if (input.dataset.bound) return
        input.dataset.bound = "true"
        input.addEventListener("change", () => {
            const group = input.dataset.tfilter
            const value = input.value
            if (group === "tipo") {
                input.checked ? _tFilterTipo.add(value) : _tFilterTipo.delete(value)
            } else if (group === "direccion") {
                input.checked ? _tFilterDireccion.add(value) : _tFilterDireccion.delete(value)
            } else if (group === "resultado") {
                input.checked ? _tFilterResultado.add(value) : _tFilterResultado.delete(value)
            }
            renderTradingView()
        })
    })

    document.querySelectorAll('input[name="tradingView"]').forEach((input) => {
        if (input.dataset.bound) return
        input.dataset.bound = "true"
        input.addEventListener("change", () => {
            _tView = input.value
            renderTradingView()
        })
    })
}

// ── Filters ────────────────────────────────────────────────────────────────

function renderTradingFilters() {
    document.querySelectorAll('.tradingFilters input[data-tfilter="tipo"]').forEach((inp) => {
        inp.checked = _tFilterTipo.has(inp.value)
    })
    document.querySelectorAll('.tradingFilters input[data-tfilter="direccion"]').forEach((inp) => {
        inp.checked = _tFilterDireccion.has(inp.value)
    })
    document.querySelectorAll('.tradingFilters input[data-tfilter="resultado"]').forEach((inp) => {
        inp.checked = _tFilterResultado.has(inp.value)
    })
}

function getFilteredTradingRows() {
    return (currentTradingData.rows || []).filter((row) => {
        return (
            (_tFilterTipo.size === 0 || _tFilterTipo.has(row.tipo)) &&
            (_tFilterDireccion.size === 0 || _tFilterDireccion.has(row.direccion)) &&
            (_tFilterResultado.size === 0 || _tFilterResultado.has(row.resultado))
        )
    })
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderTradingView() {
    const tableView = document.getElementById("tradingTableView")
    const haciendaView = document.getElementById("tradingHaciendaView")

    if (_tView === "hacienda") {
        tableView?.classList.add("hidden")
        haciendaView?.classList.remove("hidden")
        renderTradingHacienda()
    } else {
        tableView?.classList.remove("hidden")
        haciendaView?.classList.add("hidden")
        renderTradingTable()
    }
}

function renderTradingTable() {
    const body = document.getElementById("tradingBody")
    if (!body) return
    body.innerHTML = ""

    const rows = getFilteredTradingRows()
    const tradingTableWrapper = document.getElementById("tradingTableWrapper")
    const tradingEmptyEl = document.getElementById("tradingEmptyMsg")

    if (!rows.length) {
        if (tradingTableWrapper) tradingTableWrapper.classList.add("hidden")
        if (tradingEmptyEl) tradingEmptyEl.classList.remove("hidden")
        return
    }

    if (tradingTableWrapper) tradingTableWrapper.classList.remove("hidden")
    if (tradingEmptyEl) tradingEmptyEl.classList.add("hidden")

    rows.forEach((row, idx) => {
        body.appendChild(buildTradingRow(row, idx + 1))
    })

    if (typeof bindTableSort === "function") {
        bindTableSort(body.closest("table"), "trading")
    }
}

function buildTradingRow(row, num) {
    const tr = document.createElement("tr")
    tr.dataset.tradeId = row.id

    const esProfit = row.resultado === "PROFIT"
    const roiNum = parseTradingPercent(row.roi)
    const gananciaNum = parseTradingPercent(row.ganancia)

    const gNetaNum = parseTradingAmount(row.ganancia_neta)
    const gNetaFmt = gNetaNum !== null
        ? `${gNetaNum >= 0 ? "+" : ""}${gNetaNum.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.capital_currency || ""}`
        : ""

    tr.innerHTML = `
        <td class="tradingNumCell">${num}</td>
        <td>${row.fecha || ""}</td>
        <td><span class="tradingTipoBadge tradingTipo${row.tipo}">${row.tipo}</span></td>
        <td class="tradingMonedaCell">${row.moneda || ""}</td>
        <td><span class="tradingDirBadge tradingDir${row.direccion}">${row.direccion}</span></td>
        <td><span class="tradingResultBadge ${esProfit ? "tradingProfit" : "tradingPerdida"}">${row.resultado}</span></td>
        <td class="${roiNum !== null ? (roiNum >= 0 ? "tradingPos" : "tradingNeg") : ""}">${formatTradingPct(row.roi)}</td>
        <td class="${gananciaNum !== null ? (gananciaNum >= 0 ? "tradingPos" : "tradingNeg") : ""}">${formatTradingPct(row.ganancia)}</td>
        <td class="${gNetaNum !== null ? (gNetaNum >= 0 ? "tradingPos" : "tradingNeg") : ""}">${gNetaFmt}</td>
        <td class="rowActionsCell">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem assetRowEditBtn tradingRowEditBtn avActionBtn avEditBtn" data-trade-id="${row.id}">Editar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger assetRowDeleteBtn tradingRowDeleteBtn avActionBtn avDeleteBtn" data-trade-id="${row.id}">Eliminar</button>
                </div>
            </div>
        </td>
    `
    return tr
}

// ── Hacienda ───────────────────────────────────────────────────────────────

function renderTradingHacienda() {
    const tabsEl = document.getElementById("tradingHaciendaYearTabs")
    const contentEl = document.getElementById("tradingHaciendaContent")
    if (!tabsEl || !contentEl) return

    const rows = getFilteredTradingRows()
    const yearsSet = new Set()
    rows.forEach((r) => {
        const year = extractTradingYear(r.fecha)
        if (year) yearsSet.add(year)
    })
    const years = [...yearsSet].sort((a, b) => b - a)

    if (!years.length) {
        tabsEl.innerHTML = ""
        contentEl.innerHTML = `<p class="overviewEmpty">No hay trades registrados.</p>`
        return
    }

    if (!_tHaciendaYear || !years.includes(_tHaciendaYear)) {
        _tHaciendaYear = years[0]
    }

    tabsEl.innerHTML = years.map((y) =>
        `<button class="tradingYearTab${y === _tHaciendaYear ? " active" : ""}" data-year="${y}">${y}</button>`
    ).join("")

    tabsEl.querySelectorAll(".tradingYearTab").forEach((btn) => {
        btn.addEventListener("click", () => {
            _tHaciendaYear = parseInt(btn.dataset.year, 10)
            renderTradingHacienda()
        })
    })

    const yearRows = rows.filter((r) => extractTradingYear(r.fecha) === _tHaciendaYear)
    contentEl.innerHTML = buildHaciendaYearTable(yearRows, _tHaciendaYear)
}

function buildHaciendaYearTable(rows, year) {
    const profits = rows.filter((r) => r.resultado === "PROFIT")
    const perdidas = rows.filter((r) => r.resultado === "PÉRDIDA")
    const gananciaTotal = rows.reduce((s, r) => s + (parseTradingPercent(r.ganancia) || 0), 0)

    // Ganancia neta en dinero — agrupa por moneda
    const netaByCurrency = {}
    rows.forEach((r) => {
        const val = parseTradingAmount(r.ganancia_neta)
        if (val === null) return
        const cur = r.capital_currency || "EUR"
        netaByCurrency[cur] = (netaByCurrency[cur] || 0) + val
    })
    const netaStr = Object.entries(netaByCurrency)
        .map(([cur, val]) => `${val >= 0 ? "+" : ""}${val.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`)
        .join(" / ") || "—"
    const netaPositive = Object.values(netaByCurrency).every((v) => v >= 0)

    const summary = `
        <div class="tradingHaciendaSummary">
            <div class="tradingHaciendaKpi">
                <span class="tradingHaciendaKpiLabel">Total trades</span>
                <span class="tradingHaciendaKpiVal">${rows.length}</span>
            </div>
            <div class="tradingHaciendaKpi">
                <span class="tradingHaciendaKpiLabel">Ganadoras</span>
                <span class="tradingHaciendaKpiVal tradingPos">${profits.length}</span>
            </div>
            <div class="tradingHaciendaKpi">
                <span class="tradingHaciendaKpiLabel">Perdedoras</span>
                <span class="tradingHaciendaKpiVal tradingNeg">${perdidas.length}</span>
            </div>
            <div class="tradingHaciendaKpi">
                <span class="tradingHaciendaKpiLabel">Ganancia % acumulada</span>
                <span class="tradingHaciendaKpiVal ${gananciaTotal >= 0 ? "tradingPos" : "tradingNeg"}">${gananciaTotal >= 0 ? "+" : ""}${gananciaTotal.toFixed(2).replace(".", ",")}%</span>
            </div>
            <div class="tradingHaciendaKpi">
                <span class="tradingHaciendaKpiLabel">Ganancia neta</span>
                <span class="tradingHaciendaKpiVal ${netaPositive ? "tradingPos" : "tradingNeg"}">${netaStr}</span>
            </div>
        </div>
    `

    if (!rows.length) {
        return summary + `<p class="overviewEmpty">No hay trades en ${year}.</p>`
    }

    const bodyRows = rows.map((row, idx) => {
        const esProfit = row.resultado === "PROFIT"
        const gNetaN = parseTradingAmount(row.ganancia_neta)
        const gNetaF = gNetaN !== null
            ? `${gNetaN >= 0 ? "+" : ""}${gNetaN.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.capital_currency || ""}`
            : ""
        return `
            <tr>
                <td class="tradingNumCell">${idx + 1}</td>
                <td>${row.fecha || ""}</td>
                <td><span class="tradingTipoBadge tradingTipo${row.tipo}">${row.tipo}</span></td>
                <td class="tradingMonedaCell">${row.moneda || ""}</td>
                <td><span class="tradingDirBadge tradingDir${row.direccion}">${row.direccion}</span></td>
                <td><span class="tradingResultBadge ${esProfit ? "tradingProfit" : "tradingPerdida"}">${row.resultado}</span></td>
                <td class="${(parseTradingPercent(row.roi) || 0) >= 0 ? "tradingPos" : "tradingNeg"}">${formatTradingPct(row.roi)}</td>
                <td class="${(parseTradingPercent(row.ganancia) || 0) >= 0 ? "tradingPos" : "tradingNeg"}">${formatTradingPct(row.ganancia)}</td>
                <td class="${gNetaN !== null ? (gNetaN >= 0 ? "tradingPos" : "tradingNeg") : ""}">${gNetaF}</td>
            </tr>
        `
    }).join("")

    return summary + `
        <div class="tradingHaciendaTableWrap">
            <table class="tradingTable tradingHaciendaTable">
                <thead>
                    <tr>
                        <th class="tradingNumCol">#</th>
                        <th>Fecha</th>
                        <th>Tipo</th>
                        <th>Moneda</th>
                        <th>Dirección</th>
                        <th>Resultado</th>
                        <th>ROI</th>
                        <th>Ganancia %</th>
                        <th>Ganancia neta</th>
                    </tr>
                </thead>
                <tbody>${bodyRows}</tbody>
            </table>
        </div>
    `
}

// ── Helpers ────────────────────────────────────────────────────────────────

function parseTradingPercent(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null
    const clean = String(value).trim().replace("%", "").replace(",", ".")
    const num = parseFloat(clean)
    return isNaN(num) ? null : num
}

function parseTradingAmount(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null
    const clean = String(value).trim().replace(",", ".")
    const num = parseFloat(clean)
    return isNaN(num) ? null : num
}

function formatTradingPct(value) {
    const num = parseTradingPercent(value)
    if (num === null) return ""
    return (num >= 0 ? "+" : "") + num.toFixed(2).replace(".", ",") + "%"
}

function extractTradingYear(fecha) {
    if (!fecha) return null
    const parts = String(fecha).split(/[-/]/)
    if (parts.length === 3) {
        const first = parseInt(parts[0], 10)
        const last = parseInt(parts[2], 10)
        if (first > 1900) return first
        if (last > 1900) return last
    }
    return null
}

// ── Table click ────────────────────────────────────────────────────────────

function handleTradingTableClick(event) {
    const editBtn = event.target.closest(".tradingRowEditBtn")
    if (editBtn) {
        openTradingModal(editBtn.dataset.tradeId)
        return
    }

    const deleteBtn = event.target.closest(".tradingRowDeleteBtn")
    if (deleteBtn) {
        const id = deleteBtn.dataset.tradeId
        if (!id) return
        openConfirmModal({
            title: "Eliminar trade",
            message: "¿Quieres eliminar este trade?",
            confirmLabel: "Eliminar",
            onConfirm: () => {
                currentTradingData.rows = currentTradingData.rows.filter((r) => r.id !== id)
                renderTradingView()
                scheduleTradingAutosave()
            }
        })
    }
}

// ── Modal ──────────────────────────────────────────────────────────────────

async function openTradingModal(tradeId) {
    document.getElementById("tradingRowModalOverlay")?.remove()

    const rowIndex = currentTradingData.rows.findIndex((r) => r.id === tradeId)
    const isEdit = rowIndex >= 0
    const rowData = isEdit
        ? normalizeTradingRow({ ...currentTradingData.rows[rowIndex] })
        : normalizeTradingRow({ id: `trade-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` })

    const currencyOptions = await getTradingCurrencyOptions()
    const currencySelect = currencyOptions.map((c) =>
        `<option value="${c}"${rowData.capital_currency === c ? " selected" : ""}>${c}</option>`
    ).join("")

    const overlay = document.createElement("div")
    overlay.id = "tradingRowModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.dataset.tradeId = tradeId || ""

    const modal = document.createElement("div")
    modal.className = "assetModal assetRowModal"

    const title = document.createElement("h3")
    title.className = "assetModalTitle assetRowModalTitle"
    title.textContent = isEdit ? "Editar trade" : "Añadir trade"

    const fields = document.createElement("div")
    fields.className = "assetRowModalFields"
    fields.innerHTML = `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Fecha</label>
            <input id="tmFecha" class="assetRowModalInput" type="text" value="${rowData.fecha}" placeholder="dd-mm-aaaa">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Tipo trade</label>
            <select id="tmTipo" class="assetRowModalSelect">
                ${TRADING_TIPO_OPTIONS.map((o) => `<option value="${o}"${rowData.tipo === o ? " selected" : ""}>${o}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Moneda</label>
            <input id="tmMoneda" class="assetRowModalInput" type="text" value="${rowData.moneda}" placeholder="BTC, ETH...">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Dirección</label>
            <select id="tmDireccion" class="assetRowModalSelect">
                ${TRADING_DIRECCION_OPTIONS.map((o) => `<option value="${o}"${rowData.direccion === o ? " selected" : ""}>${o}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Resultado</label>
            <select id="tmResultado" class="assetRowModalSelect">
                ${TRADING_RESULTADO_OPTIONS.map((o) => `<option value="${o}"${rowData.resultado === o ? " selected" : ""}>${o}</option>`).join("")}
            </select>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Capital</label>
            <div class="tmCapitalRow">
                <select id="tmCapitalCurrency" class="assetRowModalSelect tmCapitalCurrencySelect">${currencySelect}</select>
                <input id="tmCapital" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.capital}" placeholder="500">
            </div>
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">ROI (%)</label>
            <input id="tmRoi" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.roi}" placeholder="22">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Ganancia (%)</label>
            <input id="tmGanancia" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.ganancia}" placeholder="0.44">
        </div>
        <div class="assetRowModalField">
            <label class="assetRowModalLabel">Ganancia neta</label>
            <div class="tmCapitalRow">
                <input id="tmGananciaNeta" class="assetRowModalInput" type="text" inputmode="decimal" value="${rowData.ganancia_neta}" placeholder="110">
                <span class="tmCurrencyLabel">${rowData.capital_currency}</span>
            </div>
        </div>
    `

    const footer = document.createElement("div")
    footer.className = "assetRowModalFooter"
    footer.innerHTML = `
        ${isEdit ? `<button type="button" id="tmDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
        <button type="button" id="tmCancelBtn" class="cancelButton">Cancelar</button>
        <button type="button" id="tmSaveBtn" class="primaryButton" data-no-autohide="true">Guardar</button>
    `

    footer.querySelector("#tmSaveBtn").addEventListener("click", () => saveTradingFromModal(overlay))
    footer.querySelector("#tmCancelBtn").addEventListener("click", () => overlay.remove())

    if (isEdit) {
        footer.querySelector("#tmDeleteBtn").addEventListener("click", () => {
            openConfirmModal({
                title: "Eliminar trade",
                message: "¿Quieres eliminar este trade?",
                confirmLabel: "Eliminar",
                onConfirm: () => {
                    currentTradingData.rows = currentTradingData.rows.filter((r) => r.id !== tradeId)
                    renderTradingView()
                    scheduleTradingAutosave()
                }
            })
            overlay.remove()
        })
    }

    modal.appendChild(title)
    modal.appendChild(fields)
    modal.appendChild(footer)
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    // Sincroniza el label de moneda en "Ganancia neta" con el select de Capital
    const currencySelectEl = document.getElementById("tmCapitalCurrency")
    const currencyLabelEl  = overlay.querySelector(".tmCurrencyLabel")
    if (currencySelectEl && currencyLabelEl) {
        currencySelectEl.addEventListener("change", () => {
            currencyLabelEl.textContent = currencySelectEl.value
        })
    }
}

function saveTradingFromModal(overlay) {
    const g = (id) => document.getElementById(id)?.value ?? ""
    const tradeId = overlay?.dataset.tradeId || ""

    const rowData = normalizeTradingRow({
        id: tradeId || `trade-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        fecha: g("tmFecha"),
        tipo: g("tmTipo"),
        moneda: g("tmMoneda"),
        direccion: g("tmDireccion"),
        resultado: g("tmResultado"),
        capital: g("tmCapital"),
        capital_currency: g("tmCapitalCurrency") || "EUR",
        roi: g("tmRoi"),
        ganancia: g("tmGanancia"),
        ganancia_neta: g("tmGananciaNeta"),
    })

    const idx = currentTradingData.rows.findIndex((r) => r.id === tradeId)
    if (idx >= 0) {
        currentTradingData.rows[idx] = rowData
    } else {
        currentTradingData.rows.push(rowData)
    }

    renderTradingView()
    scheduleTradingAutosave()
    overlay.remove()
}

// ── Persistence ────────────────────────────────────────────────────────────

function scheduleTradingAutosave(delay = 500) {
    window.clearTimeout(tradingAutosaveTimeout)
    tradingAutosaveTimeout = window.setTimeout(async () => {
        try {
            await persistTradingData()
        } catch (err) {
            console.error("Error en autoguardado de trades:", err)
        }
    }, delay)
}

async function persistTradingData(options = {}) {
    window.clearTimeout(tradingAutosaveTimeout)
    await saveTradingDataApi(currentTradingData, options)
}

async function flushTradingPendingChanges() {
    if (!document.getElementById("tradingBody")) return
    await persistTradingData({ keepalive: true })
}

function bindTradingPersistenceGuards() {
    if (tradingPersistenceBound) return
    tradingPersistenceBound = true

    window.addEventListener("beforeunload", () => {
        if (!document.getElementById("tradingBody")) return
        persistTradingData({ keepalive: true }).catch(console.error)
    })

    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState !== "hidden" || !document.getElementById("tradingBody")) return
        persistTradingData({ keepalive: true }).catch(console.error)
    })
}
