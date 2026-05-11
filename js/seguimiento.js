const AV_SEG_TYPE_COLORS = {
    cripto:    "#f7931a",
    acciones:  "#3a7bd5",
    etfs:      "#2ecc71",
    comoditis: "#e0c068"
}
const AV_SEG_TYPE_LABELS = {
    cripto:    "Cripto",
    acciones:  "Acciones",
    etfs:      "ETFs",
    comoditis: "Comoditis"
}

let _segAllItems    = []
let _segFilterType  = "all"
let _segFilterSrc   = "all"
let _segSearch      = ""
let _segViewMode    = localStorage.getItem("whitelistViewMode") || "cards"

function segLoadCustomItems() {
    try { return JSON.parse(localStorage.getItem("seguimientoList") || "[]") }
    catch { return [] }
}
function segSaveCustomItems(items) {
    localStorage.setItem("seguimientoList", JSON.stringify(items))
}

function segFilteredItems() {
    return _segAllItems.filter(item => {
        const matchType = _segFilterType === "all" || item.type === _segFilterType
        const matchSrc  = _segFilterSrc  === "all"
            || (_segFilterSrc === "portfolio" && item._fromPortfolio)
            || (_segFilterSrc === "nuevos"    && !item._fromPortfolio)
        const q = _segSearch.toLowerCase()
        const matchSearch = !q
            || (item.name   || "").toLowerCase().includes(q)
            || (item.symbol || "").toLowerCase().includes(q)
            || (item.ticker || "").toLowerCase().includes(q)
        return matchType && matchSrc && matchSearch
    })
}

function segBuildCard(item) {
    const color     = AV_SEG_TYPE_COLORS[item.type] || "#888"
    const typeLabel = AV_SEG_TYPE_LABELS[item.type] || item.type || ""
    const price     = parseLooseNumber(item.price || "") || 0
    const currency  = item.currency || "EUR"
    const provider  = String(item.marketProvider || "").toUpperCase()
    const ticker    = item.marketSymbol || item.finnhubSymbol || item.ticker || ""

    const changePctStr   = String(item.change || "").trim()
    const changePct      = parseLooseNumber(changePctStr.replace(/%/g, "")) || 0
    const changeAbs      = price > 0 ? Math.abs(price * changePct / 100) : 0
    const changeSign     = changePct < 0 ? "−" : changePct > 0 ? "+" : ""
    const changeClass    = changePct < 0 ? "avNeg" : changePct > 0 ? "avPos" : ""
    const changeMoneyStr = changePctStr ? `${changeSign}${formatMoney(changeAbs, currency)}` : "—"
    const changePctDisp  = changePctStr || "—"

    let lastUpdatedStr = "—"
    if (item.lastUpdated) {
        const d = new Date(item.lastUpdated)
        if (!isNaN(d)) {
            const hh = String(d.getHours()).padStart(2, "0")
            const mm = String(d.getMinutes()).padStart(2, "0")
            const dd = String(d.getDate()).padStart(2, "0")
            const mo = String(d.getMonth() + 1).padStart(2, "0")
            lastUpdatedStr = `${dd}/${mo} ${hh}:${mm}`
        }
    }

    const sid = escapeHtml(item._segId || "")
    const hideOrDeleteBtn = item._fromPortfolio
        ? `<button type="button" class="avActionBtn segHideBtn" data-seg-id="${sid}" title="Ocultar de watchlist"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button>`
        : `<button type="button" class="avActionBtn avDeleteBtn segRemoveBtn" data-seg-id="${sid}" title="Eliminar">✕</button>`
    const actionBtns = `<button type="button" class="avActionBtn avEditBtn segEditBtn" data-seg-id="${sid}" title="Editar">✎</button>${hideOrDeleteBtn}`

    const card = document.createElement("div")
    card.className = "avCard"
    card.dataset.segId = item._segId || item.id || ""

    card.innerHTML = `
        <div class="avCardTop">
            <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${typeLabel}</span>
            <div class="avCardActions">${actionBtns}</div>
        </div>
        <div class="avCardSymbol">${escapeHtml(item.symbol || item.name || "")}</div>
        <div class="avCardName">${escapeHtml(item.name || item.symbol || "Activo")}</div>
        <div class="avCardPrice">${price > 0 ? formatMoney(price, currency) : "—"}</div>
        <div class="avCardTicker">${provider || ticker || (item._fromPortfolio ? "Sin ticker" : "Sin datos en vivo")}</div>
        <div class="avCardMetrics">
            <div class="avMetricItem">
                <span class="avMetricLabel">Cambio día</span>
                <span class="avMetricValue ${changeClass}">${changeMoneyStr}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Cambio %</span>
                <span class="avMetricValue ${changeClass}">${changePctDisp}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Ticker</span>
                <span class="avMetricValue">${escapeHtml(ticker || "—")}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Origen</span>
                <span class="avMetricValue">${item._fromPortfolio ? "Portfolio" : "Nuevo"}</span>
            </div>
        </div>
        <div class="avCardUpdated">Actualizado: ${lastUpdatedStr}</div>
        <div class="avCardBar" style="background:${color}"></div>
    `

    return card
}

function segRenderTable(filtered) {
    const tbody = document.getElementById("seguimientoTableBody")
    if (!tbody) return

    tbody.innerHTML = filtered.map(item => {
        const color     = AV_SEG_TYPE_COLORS[item.type] || "#888"
        const typeLabel = AV_SEG_TYPE_LABELS[item.type] || item.type || ""
        const price     = parseLooseNumber(item.price || "") || 0
        const currency  = item.currency || "EUR"
        const provider  = String(item.marketProvider || "").toUpperCase()
        const ticker    = item.marketSymbol || item.finnhubSymbol || item.ticker || "—"

        const changePctStr   = String(item.change || "").trim()
        const changePct      = parseLooseNumber(changePctStr.replace(/%/g, "")) || 0
        const changeAbs      = price > 0 ? Math.abs(price * changePct / 100) : 0
        const changeSign     = changePct < 0 ? "−" : changePct > 0 ? "+" : ""
        const changeClass    = changePct < 0 ? "avNeg" : changePct > 0 ? "avPos" : ""
        const changeMoneyStr = changePctStr ? `${changeSign}${formatMoney(changeAbs, currency)}` : "—"
        const changePctDisp  = changePctStr || "—"
        const srcLabel       = item._fromPortfolio ? "Portfolio" : "Nuevo"
        const tsid       = escapeHtml(item._segId || "")
        const tHideOrDel = item._fromPortfolio
            ? `<button class="avActionBtn segHideBtn" data-seg-id="${tsid}" title="Ocultar de watchlist"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg></button>`
            : `<button class="avActionBtn avDeleteBtn segRemoveBtn" data-seg-id="${tsid}" title="Eliminar">✕</button>`
        const removeCell = `<button class="avActionBtn avEditBtn segEditBtn" data-seg-id="${tsid}" title="Editar">✎</button>${tHideOrDel}`

        return `<tr class="avTableRow" data-seg-id="${escapeHtml(item._segId || "")}">
            <td><span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${typeLabel}</span></td>
            <td class="avTrName">${escapeHtml(item.name || item.symbol || "—")}</td>
            <td class="avTrProvider">${escapeHtml(ticker)}</td>
            <td class="avTrPrice">${price > 0 ? formatMoney(price, currency) : "—"}</td>
            <td class="avTrRend ${changeClass}">${changeMoneyStr}</td>
            <td class="avTrRend ${changeClass}">${changePctDisp}</td>
            <td class="avTrProvider">${provider || "—"}</td>
            <td class="avTrProvider">${srcLabel}</td>
            <td class="avTrActions">${removeCell}</td>
        </tr>`
    }).join("")

    tbody.querySelectorAll(".segHideBtn").forEach(btn => {
        btn.addEventListener("click", () => segHideItem(btn.dataset.segId))
    })
    tbody.querySelectorAll(".segRemoveBtn").forEach(btn => {
        btn.addEventListener("click", () => segRemoveItem(btn.dataset.segId))
    })

    tbody.querySelectorAll(".segEditBtn").forEach(btn => {
        btn.addEventListener("click", () => segOpenEditModal(btn.dataset.segId))
    })

    tbody.querySelectorAll(".avTableRow").forEach(row => {
        row.addEventListener("click", (e) => {
            if (e.target.closest(".avTrActions")) return
            const segId = row.dataset.segId
            const item  = _segAllItems.find(i => i._segId === segId)
            if (!item) return
            const tvSym = typeof buildTVSymbol === "function" ? buildTVSymbol(item) : (item.tvSymbol || item.marketSymbol || item.ticker || "")
            if (tvSym && typeof openTVChartModal === "function") openTVChartModal(tvSym, item.name || item.symbol)
        })
    })
}

function segLoadHidden() {
    try { return new Set(JSON.parse(localStorage.getItem("seguimientoHidden") || "[]")) } catch { return new Set() }
}
function segSaveHidden(set) {
    localStorage.setItem("seguimientoHidden", JSON.stringify([...set]))
}

function segHideItem(segId) {
    if (!segId.startsWith("portfolio_")) return
    const hidden = segLoadHidden()
    hidden.add(segId)
    segSaveHidden(hidden)
    segMergeAndRender(window._segPortfolioAssets || [])
    segUpdateHiddenBtn()
}

function segUnhideItem(segId) {
    const hidden = segLoadHidden()
    hidden.delete(segId)
    segSaveHidden(hidden)
    segMergeAndRender(window._segPortfolioAssets || [])
    segUpdateHiddenBtn()
}

function segUpdateHiddenBtn() {
    const btn   = document.getElementById("segHiddenBtn")
    const badge = document.getElementById("segHiddenCount")
    if (!btn) return
    const hidden = segLoadHidden()
    const count  = [...hidden].filter(id => id.startsWith("portfolio_")).length
    if (count > 0) {
        btn.style.display = ""
        if (badge) badge.textContent = count
    } else {
        btn.style.display = "none"
    }
}

function segOpenHiddenModal() {
    const overlay  = document.getElementById("segHiddenModalOverlay")
    const list     = document.getElementById("segHiddenList")
    if (!overlay || !list) return

    const hidden   = segLoadHidden()
    const hiddenIds = [...hidden].filter(id => id.startsWith("portfolio_"))
    const assets   = window._segPortfolioAssets || []

    if (hiddenIds.length === 0) {
        list.innerHTML = `<p style="color:var(--text-secondary);font-size:0.9em;text-align:center;padding:16px 0">No hay activos ocultos.</p>`
    } else {
        list.innerHTML = hiddenIds.map(segId => {
            const assetId = segId.replace("portfolio_", "")
            const asset   = assets.find(a => a.id === assetId)
            const name    = asset?.name || assetId
            const type    = asset?.type || ""
            const color   = AV_SEG_TYPE_COLORS[type] || "#888"
            const label   = AV_SEG_TYPE_LABELS[type] || type
            return `<div class="segHiddenItem" data-seg-id="${escapeHtml(segId)}">
                <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44;font-size:0.75em">${escapeHtml(label)}</span>
                <span class="segHiddenItemName">${escapeHtml(name)}</span>
                <button class="primaryButton segUnhideBtn" data-seg-id="${escapeHtml(segId)}" type="button" style="margin-left:auto;padding:4px 12px;font-size:0.82em">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:4px"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>Mostrar
                </button>
            </div>`
        }).join("")

        list.querySelectorAll(".segUnhideBtn").forEach(btn => {
            btn.addEventListener("click", () => {
                segUnhideItem(btn.dataset.segId)
                segOpenHiddenModal()
            })
        })
    }

    overlay.classList.remove("hidden")
}

function segRemoveItem(segId) {
    if (segId.startsWith("portfolio_")) return

    const item = _segAllItems.find(i => i._segId === segId)
    const itemName = item?.name || item?.symbol || segId

    openConfirmModal({
        title: "Eliminar activo",
        message: `¿Quieres eliminar "${itemName}" de la watchlist?`,
        confirmLabel: "Sí, eliminar",
        confirmSide: "right",
        onConfirm: () => {
            openConfirmModal({
                title: "¿Estás seguro?",
                message: `Esta acción eliminará "${itemName}" de la watchlist de forma definitiva. ¿Confirmas?`,
                confirmLabel: "Sí, estoy seguro",
                confirmSide: "right",
                onConfirm: () => {
                    segOpenDeleteTypeConfirm(segId, itemName)
                }
            })
        }
    })
}

function segOpenDeleteTypeConfirm(segId, itemName) {
    const overlay    = document.getElementById("segDeleteTypeOverlay")
    const msg        = document.getElementById("segDeleteTypeMsg")
    const input      = document.getElementById("segDeleteTypeInput")
    const cancelBtn  = document.getElementById("segDeleteTypeCancelBtn")
    const okBtn      = document.getElementById("segDeleteTypeOkBtn")
    if (!overlay || !input) return

    const expected = itemName.toUpperCase()
    msg.textContent = `Escribe "${expected}" para confirmar la eliminación.`
    input.value = ""
    input.style.borderColor = ""
    overlay.classList.remove("hidden")
    setTimeout(() => input.focus(), 50)

    function doDelete() {
        if (input.value.trim() !== expected) {
            input.style.borderColor = "var(--danger, #e74c3c)"
            input.focus()
            return
        }
        overlay.classList.add("hidden")
        cleanup()
        let customs = segLoadCustomItems()
        customs = customs.filter(c => c._segId !== segId)
        segSaveCustomItems(customs)
        segMergeAndRender(window._segPortfolioAssets || [])
    }

    function doCancel() {
        overlay.classList.add("hidden")
        cleanup()
    }

    function onKey(e) {
        if (e.key === "Enter") doDelete()
        if (e.key === "Escape") doCancel()
    }

    function cleanup() {
        okBtn.removeEventListener("click", doDelete)
        cancelBtn.removeEventListener("click", doCancel)
        input.removeEventListener("keydown", onKey)
        input.style.borderColor = ""
    }

    okBtn.addEventListener("click", doDelete)
    cancelBtn.addEventListener("click", doCancel)
    input.addEventListener("keydown", onKey)
}

function segRenderGrid() {
    const grid      = document.getElementById("seguimientoGrid")
    const tableWrap = document.getElementById("seguimientoTableWrap")
    const count     = document.getElementById("seguimientoCount")
    if (!grid) return

    const filtered = segFilteredItems()
    if (count) count.textContent = `${filtered.length} activo${filtered.length !== 1 ? "s" : ""}`

    if (_segViewMode === "table") {
        grid.classList.add("hidden")
        tableWrap?.classList.remove("hidden")
        segRenderTable(filtered)
        return
    }

    grid.classList.remove("hidden")
    tableWrap?.classList.add("hidden")

    if (filtered.length === 0) {
        grid.innerHTML = `<div class="seguimientoEmpty">No hay activos en seguimiento.</div>`
        return
    }

    grid.innerHTML = ""
    filtered.forEach(item => {
        const card = segBuildCard(item)
        card.querySelectorAll(".segHideBtn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segHideItem(btn.dataset.segId)
            })
        })
        card.querySelectorAll(".segRemoveBtn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segRemoveItem(btn.dataset.segId)
            })
        })
        card.querySelectorAll(".segEditBtn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segOpenEditModal(btn.dataset.segId)
            })
        })
        card.addEventListener("click", (e) => {
            if (e.target.closest(".segRemoveBtn") || e.target.closest(".segEditBtn")) return
            const tvSym = typeof buildTVSymbol === "function" ? buildTVSymbol(item) : (item.tvSymbol || item.marketSymbol || item.ticker || "")
            if (tvSym && typeof openTVChartModal === "function") openTVChartModal(tvSym, item.name || item.symbol)
        })
        grid.appendChild(card)
    })
}

function segMergeAndRender(portfolioAssets) {
    window._segPortfolioAssets = portfolioAssets
    const customs = segLoadCustomItems()
    const portfolioNames = new Set(portfolioAssets.map(a => (a.name || "").toLowerCase()))

    const customItems = customs
        .filter(c => !portfolioNames.has((c.nombre || "").toLowerCase()))
        .map(c => ({
            _segId:         c._segId,
            name:           c.nombre,
            symbol:         c.ticker || c.nombre,
            ticker:         c.ticker || "",
            type:           c.tipo || "acciones",
            notas:          c.notas || "",
            price:          "",
            currency:       "EUR",
            change:         "",
            _fromPortfolio: false
        }))

    const hidden    = segLoadHidden()
    const overrides = JSON.parse(localStorage.getItem("seguimientoOverrides") || "{}")

    const portfolioItems = portfolioAssets
        .filter(a => !hidden.has(`portfolio_${a.id}`))
        .map(a => {
            const segId = `portfolio_${a.id}`
            const ov = overrides[segId] || {}
            return {
                ...a,
                _segId:         segId,
                _fromPortfolio: true,
                tvSymbol:       ov.tvSymbol       ?? (a.tvSymbol || ""),
                marketProvider: ov.marketProvider  ?? (a.marketProvider || ""),
                marketSymbol:   ov.ticker          ?? (a.marketSymbol || a.finnhubSymbol || "")
            }
        })

    _segAllItems = [...portfolioItems, ...customItems]
    segRenderGrid()
    segUpdateHiddenBtn()
}

async function initSeguimientoLogic() {
    const addBtn             = document.getElementById("seguimientoAddBtn")
    const searchInput        = document.getElementById("seguimientoSearch")
    const modalOverlay       = document.getElementById("seguimientoModalOverlay")
    const confirmBtn         = document.getElementById("seguimientoConfirmBtn")
    const cancelBtn          = document.getElementById("seguimientoCancelBtn")
    const nombreInput        = document.getElementById("seguimientoNombreInput")
    const typeSelect         = document.getElementById("seguimientoTypeSelect")
    const tickerInput        = document.getElementById("seguimientoTickerInput")
    const tvTickerInput      = document.getElementById("seguimientoTVTickerInput")
    const hiddenBtn          = document.getElementById("segHiddenBtn")
    const hiddenModalOverlay = document.getElementById("segHiddenModalOverlay")
    const hiddenCloseBtn     = document.getElementById("segHiddenCloseBtn")

    const filtersEl          = document.getElementById("seguimientoFilters")
    const srcFiltersEl       = document.getElementById("seguimientoSourceFilters")
    const viewToggle         = document.getElementById("seguimientoViewToggle")
    const segFinnhubBtn      = document.getElementById("segSearchFinnhubBtn")
    const segEodhdBtn        = document.getElementById("segSearchEodhdBtn")
    const segYahooBtn        = document.getElementById("segSearchYahooBtn")
    const segSearchFeedback  = document.getElementById("segSearchFeedback")
    const segSearchResults   = document.getElementById("segSearchResults")

    // cargar activos del portfolio
    let portfolioAssets = []
    try {
        const resp = await fetch("/api/activos")
        if (resp.ok) {
            const data = await resp.json()
            portfolioAssets = data.assets || data || []
        }
    } catch { /* sin conexión */ }

    // inicializar vista guardada
    viewToggle?.querySelectorAll(".avViewBtn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === _segViewMode)
    })

    segMergeAndRender(portfolioAssets)

    hiddenBtn?.addEventListener("click", segOpenHiddenModal)
    hiddenCloseBtn?.addEventListener("click", () => hiddenModalOverlay?.classList.add("hidden"))
    hiddenModalOverlay?.addEventListener("click", (e) => {
        if (e.target === hiddenModalOverlay) hiddenModalOverlay.classList.add("hidden")
    })

    // filtros de tipo
    filtersEl?.addEventListener("click", (e) => {
        const btn = e.target.closest(".activosFilterBtn")
        if (!btn) return
        filtersEl.querySelectorAll(".activosFilterBtn").forEach(b => b.classList.remove("active"))
        btn.classList.add("active")
        _segFilterType = btn.dataset.type || "all"
        segRenderGrid()
    })

    // filtros de fuente (todos / portfolio / nuevos)
    srcFiltersEl?.addEventListener("click", (e) => {
        const btn = e.target.closest(".activosFilterBtn")
        if (!btn) return
        srcFiltersEl.querySelectorAll(".activosFilterBtn").forEach(b => b.classList.remove("active"))
        btn.classList.add("active")
        _segFilterSrc = btn.dataset.source || "all"
        segRenderGrid()
    })

    // toggle vista cards / tabla
    viewToggle?.addEventListener("click", (e) => {
        const btn = e.target.closest(".avViewBtn")
        if (!btn) return
        viewToggle.querySelectorAll(".avViewBtn").forEach(b => b.classList.remove("active"))
        btn.classList.add("active")
        _segViewMode = btn.dataset.view
        localStorage.setItem("whitelistViewMode", _segViewMode)
        segRenderGrid()
    })

    // búsqueda
    searchInput?.addEventListener("input", () => {
        _segSearch = searchInput.value
        segRenderGrid()
    })

    // autocomplete
    const suggestionsBox = document.getElementById("seguimientoNombreSuggestions")
    let _activeSugIdx = -1

    function segShowSuggestions(query) {
        if (!suggestionsBox) return
        const q = query.toLowerCase().trim()
        if (!q) { suggestionsBox.classList.add("hidden"); suggestionsBox.innerHTML = ""; return }

        const matches = portfolioAssets
            .filter(a => {
                const name   = (a.name   || "").toLowerCase()
                const symbol = (a.symbol || "").toLowerCase()
                const ticker = (a.ticker || a.marketSymbol || a.finnhubSymbol || "").toLowerCase()
                return name.includes(q) || symbol.includes(q) || ticker.includes(q)
            })
            .slice(0, 8)

        if (matches.length === 0) { suggestionsBox.classList.add("hidden"); suggestionsBox.innerHTML = ""; return }

        suggestionsBox.innerHTML = matches.map((a, i) => {
            const ticker = a.marketSymbol || a.finnhubSymbol || a.ticker || ""
            const tipo   = AV_SEG_TYPE_LABELS[a.type] || a.type || ""
            const color  = AV_SEG_TYPE_COLORS[a.type] || "#888"
            return `<div class="segSuggestionItem" data-idx="${i}" data-name="${escapeHtml(a.name || a.symbol || "")}" data-ticker="${escapeHtml(ticker)}" data-tipo="${escapeHtml(a.type || "acciones")}">
                <span class="segSuggBadge" style="background:${color}22;color:${color};border-color:${color}44">${tipo}</span>
                <span class="segSuggName">${escapeHtml(a.name || a.symbol || "")}</span>
                ${ticker ? `<span class="segSuggTicker">${escapeHtml(ticker)}</span>` : ""}
            </div>`
        }).join("")

        _activeSugIdx = -1
        suggestionsBox.classList.remove("hidden")

        suggestionsBox.querySelectorAll(".segSuggestionItem").forEach(el => {
            el.addEventListener("mousedown", (e) => {
                e.preventDefault()
                segApplySuggestion(el)
            })
        })
    }

    function segApplySuggestion(el) {
        if (!el) return
        nombreInput.value  = el.dataset.name  || ""
        tickerInput.value  = el.dataset.ticker || ""
        if (typeSelect && el.dataset.tipo) typeSelect.value = el.dataset.tipo
        suggestionsBox.classList.add("hidden")
        suggestionsBox.innerHTML = ""
        tickerInput.focus()
    }

    function segHideSuggestions() {
        suggestionsBox?.classList.add("hidden")
        suggestionsBox && (suggestionsBox.innerHTML = "")
        _activeSugIdx = -1
    }

    nombreInput?.addEventListener("input", () => segShowSuggestions(nombreInput.value))
    nombreInput?.addEventListener("keydown", (e) => {
        const items = suggestionsBox?.querySelectorAll(".segSuggestionItem")
        if (!items || items.length === 0) {
            if (e.key === "Enter") confirmBtn?.click()
            if (e.key === "Escape") closeModal()
            return
        }
        if (e.key === "ArrowDown") {
            e.preventDefault()
            _activeSugIdx = Math.min(_activeSugIdx + 1, items.length - 1)
            items.forEach((el, i) => el.classList.toggle("active", i === _activeSugIdx))
        } else if (e.key === "ArrowUp") {
            e.preventDefault()
            _activeSugIdx = Math.max(_activeSugIdx - 1, -1)
            items.forEach((el, i) => el.classList.toggle("active", i === _activeSugIdx))
        } else if (e.key === "Enter") {
            e.preventDefault()
            if (_activeSugIdx >= 0 && items[_activeSugIdx]) segApplySuggestion(items[_activeSugIdx])
            else if (suggestionsBox?.classList.contains("hidden")) confirmBtn?.click()
            else segHideSuggestions()
        } else if (e.key === "Escape") {
            if (!suggestionsBox?.classList.contains("hidden")) segHideSuggestions()
            else closeModal()
        }
    })
    nombreInput?.addEventListener("blur", () => setTimeout(segHideSuggestions, 150))

    // modal
    function openModal() {
        if (!modalOverlay) return
        nombreInput.value  = ""
        tickerInput.value  = ""
        if (tvTickerInput) tvTickerInput.value = ""
        delete tickerInput?.dataset.marketProvider
        segHideSuggestions()
        segClearSearch()
        modalOverlay.classList.remove("hidden")
        nombreInput.focus()
    }
    function closeModal() {
        segHideSuggestions()
        segClearSearch()
        modalOverlay?.classList.add("hidden")
    }

    addBtn?.addEventListener("click", openModal)
    cancelBtn?.addEventListener("click", closeModal)
    tickerInput?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") confirmBtn?.click()
        if (e.key === "Escape") closeModal()
    })

    // búsqueda de ticker en proveedores externos
    const segTickerSelected = (result, providerName) => {
        if (tickerInput) {
            tickerInput.value = result.symbol
            tickerInput.dataset.marketProvider = String(result.provider || providerName).trim().toLowerCase()
        }
        if (nombreInput && !nombreInput.value.trim()) nombreInput.value = result.description || ""
        if (typeof setAssetSearchFeedback === "function")
            setAssetSearchFeedback(segSearchFeedback, `Ticker seleccionado (${providerName}): ${result.symbol}`)
        if (typeof renderMarketSearchResults === "function")
            renderMarketSearchResults(segSearchResults, [], () => {})
    }

    segFinnhubBtn?.addEventListener("click", async () => {
        if (typeof handleFinnhubSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleFinnhubSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "Finnhub")
        })
    })

    segEodhdBtn?.addEventListener("click", async () => {
        if (typeof handleEodhdSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleEodhdSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "EODHD")
        })
    })

    segYahooBtn?.addEventListener("click", async () => {
        if (typeof handleYahooSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleYahooSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "Yahoo Finance")
        })
    })

    confirmBtn?.addEventListener("click", () => {
        const nombre = nombreInput?.value.trim()
        if (!nombre) { nombreInput?.focus(); return }
        const customs = segLoadCustomItems()
        customs.push({
            _segId:         `custom_${Date.now()}`,
            nombre,
            ticker:         tickerInput?.value.trim() || "",
            marketProvider: tickerInput?.dataset.marketProvider || "",
            tvSymbol:       tvTickerInput?.value.trim() || "",
            tipo:           typeSelect?.value || "acciones",
            notas:          ""
        })
        segSaveCustomItems(customs)
        closeModal()
        segMergeAndRender(portfolioAssets)
    })

    // ── Modal de edición ─────────────────────────────────────────────────────
    const editOverlay     = document.getElementById("segEditModalOverlay")
    const editNombreInput = document.getElementById("segEditNombreInput")
    const editTypeSelect  = document.getElementById("segEditTypeSelect")
    const editTickerInput = document.getElementById("segEditTickerInput")
    const editTVInput     = document.getElementById("segEditTVTickerInput")
    const editFeedback    = document.getElementById("segEditSearchFeedback")
    const editResults     = document.getElementById("segEditSearchResults")
    const editCancelBtn   = document.getElementById("segEditCancelBtn")
    const editConfirmBtn  = document.getElementById("segEditConfirmBtn")
    let _editingSegId     = null

    function segClearEditSearch() {
        if (editFeedback) editFeedback.classList.add("hidden")
        if (editResults)  { editResults.classList.add("hidden"); editResults.innerHTML = "" }
    }

    const editModalTitle    = document.getElementById("segEditModalTitle")
    const editPortfolioNote = document.getElementById("segEditPortfolioNotice")
    const editCustomForm    = document.getElementById("segEditCustomForm")

    window.segOpenEditModal = function(segId) {
        if (!editOverlay) return
        const allItem = _segAllItems.find(i => i._segId === segId)
        if (!allItem) return
        _editingSegId = segId

        segClearEditSearch()

        if (allItem._fromPortfolio) {
            if (editModalTitle)    editModalTitle.textContent = allItem.name || allItem.symbol || "Activo del portfolio"
            if (editPortfolioNote) editPortfolioNote.classList.remove("hidden")
            if (editCustomForm)    editCustomForm.classList.add("hidden")
            if (editConfirmBtn)    editConfirmBtn.style.display = "none"
        } else {
            const customs = segLoadCustomItems()
            const item = customs.find(c => c._segId === segId)
            if (!item) return
            if (editModalTitle)    editModalTitle.textContent = "Editar activo"
            if (editPortfolioNote) editPortfolioNote.classList.add("hidden")
            if (editCustomForm)    editCustomForm.classList.remove("hidden")
            if (editConfirmBtn)    editConfirmBtn.style.display = ""

            editNombreInput.value = item.nombre || ""
            if (editTypeSelect) editTypeSelect.value = item.tipo || "acciones"
            editTickerInput.value = item.ticker || ""
            delete editTickerInput.dataset.marketProvider
            if (item.marketProvider) editTickerInput.dataset.marketProvider = item.marketProvider
            if (editTVInput) editTVInput.value = item.tvSymbol || ""
        }

        editOverlay.classList.remove("hidden")
        if (!allItem._fromPortfolio) editNombreInput.focus()
    }

    editCancelBtn?.addEventListener("click", () => {
        _editingSegId = null
        segClearEditSearch()
        editOverlay?.classList.add("hidden")
    })

    editConfirmBtn?.addEventListener("click", () => {
        if (!_editingSegId) return
        const allItem = _segAllItems.find(i => i._segId === _editingSegId)
        if (allItem?._fromPortfolio) return

        const nombre = editNombreInput?.value.trim()
        if (!nombre) { editNombreInput?.focus(); return }

        const customs = segLoadCustomItems()
        const idx = customs.findIndex(c => c._segId === _editingSegId)
        if (idx < 0) return
        customs[idx] = {
            ...customs[idx],
            nombre,
            ticker:         editTickerInput?.value.trim() || "",
            marketProvider: editTickerInput?.dataset.marketProvider || customs[idx].marketProvider || "",
            tvSymbol:       editTVInput?.value.trim() || "",
            tipo:           editTypeSelect?.value || "acciones"
        }
        segSaveCustomItems(customs)

        _editingSegId = null
        segClearEditSearch()
        editOverlay?.classList.add("hidden")
        segMergeAndRender(portfolioAssets)
    })

    const editTickerSelected = (result, providerName) => {
        if (editTickerInput) {
            editTickerInput.value = result.symbol
            editTickerInput.dataset.marketProvider = String(result.provider || providerName).trim().toLowerCase()
        }
        if (editNombreInput && !editNombreInput.value.trim()) editNombreInput.value = result.description || ""
        if (typeof setAssetSearchFeedback === "function")
            setAssetSearchFeedback(editFeedback, `Ticker seleccionado (${providerName}): ${result.symbol}`)
        if (typeof renderMarketSearchResults === "function")
            renderMarketSearchResults(editResults, [], () => {})
    }

    document.getElementById("segEditSearchFinnhubBtn")?.addEventListener("click", async () => {
        if (typeof handleFinnhubSearch !== "function") return
        await handleFinnhubSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "Finnhub")
        })
    })

    document.getElementById("segEditSearchEodhdBtn")?.addEventListener("click", async () => {
        if (typeof handleEodhdSearch !== "function") return
        await handleEodhdSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "EODHD")
        })
    })

    document.getElementById("segEditSearchYahooBtn")?.addEventListener("click", async () => {
        if (typeof handleYahooSearch !== "function") return
        await handleYahooSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "Yahoo Finance")
        })
    })
}
