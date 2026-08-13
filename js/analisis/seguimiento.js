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

function _segPid() {
    return window._activePortfolioId || "default"
}

function segLoadCustomItems() {
    const key    = `seguimientoList_${_segPid()}`
    const legacy = "seguimientoList"
    try {
        const stored = localStorage.getItem(key)
        if (stored !== null) return JSON.parse(stored)
        // Migración desde clave sin namespace
        const old = localStorage.getItem(legacy)
        if (old) {
            localStorage.setItem(key, old)
            localStorage.removeItem(legacy)
            return JSON.parse(old)
        }
        return []
    } catch { return [] }
}
function segSaveCustomItems(items) {
    localStorage.setItem(`seguimientoList_${_segPid()}`, JSON.stringify(items))
}

function segFilteredItems() {
    return _segAllItems.filter(item => {
        const matchType = _segFilterType === "all" || _segFilterType.includes(item.type)
        const matchSrc  = _segFilterSrc === "all"
            || (Array.isArray(_segFilterSrc)
                ? (_segFilterSrc.includes("portfolio") && item._fromPortfolio && !item._isWatchOnly)
                  || (_segFilterSrc.includes("operaciones") && item._fromOperaciones)
                  || (_segFilterSrc.includes("nuevos") && ((!item._fromPortfolio && !item._fromOperaciones) || item._isWatchOnly))
                : (_segFilterSrc === "portfolio" && item._fromPortfolio && !item._isWatchOnly)
                  || (_segFilterSrc === "operaciones" && item._fromOperaciones)
                  || (_segFilterSrc === "nuevos" && ((!item._fromPortfolio && !item._fromOperaciones) || item._isWatchOnly)))
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
    const hideOrDeleteItem = item._isWatchOnly
        ? `<button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segWatchDeleteBtn" data-seg-id="${sid}">Eliminar</button>`
        : (item._fromPortfolio || item._fromOperaciones)
            ? `<button type="button" class="rowMenuItem avActionBtn segHideBtn" data-seg-id="${sid}">Ocultar</button>`
            : `<button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segRemoveBtn" data-seg-id="${sid}">Eliminar</button>`
    const actionBtns = `
        <div class="rowMenu">
            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
            <div class="rowMenuDropdown">
                <button type="button" class="rowMenuItem avActionBtn avEditBtn segEditBtn" data-seg-id="${sid}">Editar</button>
                <hr>
                ${hideOrDeleteItem}
            </div>
        </div>`

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
                <span class="avMetricValue">${item._fromPortfolio && !item._isWatchOnly ? "Portfolio" : "Nuevo"}</span>
            </div>
        </div>
        <div class="avCardUpdated">Actualizado: ${lastUpdatedStr}</div>
        <div class="avCardBar" style="background:${color}"></div>
    `

    return card
}

function segRenderTable(filtered) {
    const tbody = document.getElementById("seguimientoTableBody")
    const tableEmptyEl = document.getElementById("seguimientoTableEmpty")
    const tableWrap = document.getElementById("seguimientoTableWrap")
    if (!tbody) return

    tbody.innerHTML = ""

    if (!filtered.length) {
        if (tableWrap) tableWrap.classList.add("hidden")
        if (tableEmptyEl) tableEmptyEl.classList.remove("hidden")
        return
    }

    if (tableWrap) tableWrap.classList.remove("hidden")
    if (tableEmptyEl) tableEmptyEl.classList.add("hidden")
    function buildTableRow(item) {
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
        const tsid       = escapeHtml(item._segId || "")
        const tHideOrDelItem = item._isWatchOnly
            ? `<button class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segWatchDeleteBtn" data-seg-id="${tsid}">Eliminar</button>`
            : (item._fromPortfolio || item._fromOperaciones)
                ? `<button class="rowMenuItem avActionBtn segHideBtn" data-seg-id="${tsid}">Ocultar</button>`
                : `<button class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn segRemoveBtn" data-seg-id="${tsid}">Eliminar</button>`
        const removeCell = `
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button class="rowMenuItem avActionBtn avEditBtn segEditBtn" data-seg-id="${tsid}">Editar</button>
                    <hr>
                    ${tHideOrDelItem}
                </div>
            </div>`
        return `<tr class="avTableRow" data-seg-id="${escapeHtml(item._segId || "")}">
            <td><span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${typeLabel}</span></td>
            <td class="avTrName">${escapeHtml(item.name || item.symbol || "—")}</td>
            <td class="avTrProvider">${escapeHtml(ticker)}</td>
            <td class="avTrPrice">${price > 0 ? formatMoney(price, currency) : "—"}</td>
            <td class="avTrRend ${changeClass}">${changeMoneyStr}</td>
            <td class="avTrRend ${changeClass}">${changePctDisp}</td>
            <td class="avTrProvider">${provider || "—"}</td>
            <td class="avTrActions">${removeCell}</td>
        </tr>`
    }

    const portfolioGroup = filtered.filter(i => (i._fromPortfolio && !i._isWatchOnly) || i._fromOperaciones)
    const customGroup    = filtered.filter(i => (!i._fromPortfolio && !i._fromOperaciones) || i._isWatchOnly)
    const showSections   = portfolioGroup.length > 0 && customGroup.length > 0

    if (showSections) {
        const colSpan = 8
        tbody.innerHTML =
            `<tr class="segTableSectionRow"><td colspan="${colSpan}" class="segTableSectionHeader">Portfolio &amp; Operaciones</td></tr>` +
            portfolioGroup.map(buildTableRow).join("") +
            `<tr class="segTableSectionRow"><td colspan="${colSpan}" class="segTableSectionHeader">Lista de seguimiento</td></tr>` +
            customGroup.map(buildTableRow).join("")
    } else {
        tbody.innerHTML = filtered.map(buildTableRow).join("")
    }

    tbody.querySelectorAll(".segHideBtn").forEach(btn => {
        btn.addEventListener("click", () => segHideItem(btn.dataset.segId))
    })
    tbody.querySelectorAll(".segRemoveBtn").forEach(btn => {
        btn.addEventListener("click", () => segRemoveItem(btn.dataset.segId))
    })
    tbody.querySelectorAll(".segWatchDeleteBtn").forEach(btn => {
        btn.addEventListener("click", () => segDeleteWatchAsset(btn.dataset.segId))
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
    const t = tbody.closest("table")
    bindTableSort(t, "seguimientoTable")
    if (t._reSort) t._reSort()
}

function segLoadHidden() {
    const key    = `seguimientoHidden_${_segPid()}`
    const legacy = "seguimientoHidden"
    try {
        const stored = localStorage.getItem(key)
        if (stored !== null) return new Set(JSON.parse(stored))
        // Migración desde clave sin namespace
        const old = localStorage.getItem(legacy)
        if (old) {
            localStorage.setItem(key, old)
            localStorage.removeItem(legacy)
            return new Set(JSON.parse(old))
        }
        return new Set()
    } catch { return new Set() }
}
function segSaveHidden(set) {
    localStorage.setItem(`seguimientoHidden_${_segPid()}`, JSON.stringify([...set]))
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
    if (segId.startsWith("portfolio_") || segId.startsWith("operacion_")) return

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

async function segDeleteWatchAsset(segId) {
    const item = _segAllItems.find(i => i._segId === segId)
    const itemName = item?.name || item?.symbol || segId
    const assetId  = segId.startsWith("portfolio_") ? segId.slice("portfolio_".length) : segId

    openConfirmModal({
        title: "Eliminar activo",
        message: `¿Quieres eliminar "${itemName}" del portfolio y la watchlist?`,
        confirmLabel: "Sí, eliminar",
        confirmSide: "right",
        onConfirm: () => {
            openConfirmModal({
                title: "¿Estás seguro?",
                message: `Esta acción eliminará "${itemName}" de forma definitiva. ¿Confirmas?`,
                confirmLabel: "Sí, estoy seguro",
                confirmSide: "right",
                onConfirm: async () => {
                    try {
                        const resp = await fetch(`/api/activos/${encodeURIComponent(assetId)}`, { method: "DELETE" })
                        if (!resp.ok) throw new Error(await resp.text())
                        if (typeof refreshAssetsSidebar === "function") await refreshAssetsSidebar()
                        segMergeAndRender(
                            (window._segPortfolioAssets || []).filter(a => String(a.id) !== String(assetId))
                        )
                    } catch (e) {
                        alert(`Error al eliminar: ${e.message}`)
                    }
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
    const tableEmptyEl = document.getElementById("seguimientoTableEmpty")
    if (tableEmptyEl) tableEmptyEl.classList.add("hidden")
    const gridEmptyEl = document.getElementById("seguimientoGridEmpty")

    grid.innerHTML = ""

    if (filtered.length === 0) {
        if (gridEmptyEl) gridEmptyEl.classList.remove("hidden")
        return
    }

    if (gridEmptyEl) gridEmptyEl.classList.add("hidden")

    function wireCard(card, item) {
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
        card.querySelectorAll(".segWatchDeleteBtn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segDeleteWatchAsset(btn.dataset.segId)
            })
        })
        card.querySelectorAll(".segEditBtn").forEach(btn => {
            btn.addEventListener("click", (e) => {
                e.stopPropagation()
                segOpenEditModal(btn.dataset.segId)
            })
        })
        card.addEventListener("click", (e) => {
            if (e.target.closest(".segRemoveBtn") || e.target.closest(".segEditBtn") || e.target.closest(".rowMenu")) return
            const tvSym = typeof buildTVSymbol === "function" ? buildTVSymbol(item) : (item.tvSymbol || item.marketSymbol || item.ticker || "")
            if (tvSym && typeof openTVChartModal === "function") openTVChartModal(tvSym, item.name || item.symbol)
        })
        return card
    }

    const portfolioGroup = filtered.filter(i => (i._fromPortfolio && !i._isWatchOnly) || i._fromOperaciones)
    const customGroup    = filtered.filter(i => (!i._fromPortfolio && !i._fromOperaciones) || i._isWatchOnly)
    const showSections   = portfolioGroup.length > 0 && customGroup.length > 0

    if (showSections) {
        const hPort = document.createElement("div")
        hPort.className = "segSectionHeader"
        hPort.textContent = "Portfolio & Operaciones"
        grid.appendChild(hPort)
        portfolioGroup.forEach(item => grid.appendChild(wireCard(segBuildCard(item), item)))

        const hCustom = document.createElement("div")
        hCustom.className = "segSectionHeader"
        hCustom.textContent = "Lista de seguimiento"
        grid.appendChild(hCustom)
        customGroup.forEach(item => grid.appendChild(wireCard(segBuildCard(item), item)))
    } else {
        filtered.forEach(item => grid.appendChild(wireCard(segBuildCard(item), item)))
    }
}

function segMergeAndRender(portfolioAssets) {
    window._segPortfolioAssets = portfolioAssets
    const customs = segLoadCustomItems()
    const portfolioKeys = new Set([
        ...portfolioAssets.map(a => (a.name   || "").toLowerCase()).filter(Boolean),
        ...portfolioAssets.map(a => (a.symbol || "").toLowerCase()).filter(Boolean),
    ])
    const portfolioNames = new Set(portfolioAssets.map(a => (a.name || "").toLowerCase()))

    const customItems = customs
        .filter(c => !portfolioKeys.has((c.nombre || "").toLowerCase()) && !portfolioKeys.has((c.ticker || "").toLowerCase()))
        .map(c => ({
            _segId:         c._segId,
            name:           c.nombre,
            symbol:         c.ticker || c.nombre,
            ticker:         c.ticker || "",
            marketSymbol:   c.ticker || "",
            marketProvider: c.marketProvider || "",
            tvSymbol:       c.tvSymbol       || "",
            type:           c.tipo || "acciones",
            notas:          c.notas || "",
            price:          c.price          || "",
            currency:       c.currency       || "EUR",
            change:         c.change         || "",
            lastUpdated:    c.lastUpdated     || null,
            _fromPortfolio: false
        }))

    const hidden    = segLoadHidden()
    const overrides = JSON.parse(localStorage.getItem(`seguimientoOverrides_${_segPid()}`) || localStorage.getItem("seguimientoOverrides") || "{}")

    const portfolioItems = portfolioAssets
        .filter(a => !hidden.has(`portfolio_${a.id}`))
        .map(a => {
            const segId = `portfolio_${a.id}`
            const ov = overrides[segId] || {}
            return {
                ...a,
                _segId:         segId,
                _fromPortfolio: true,
                _isWatchOnly:   !a.hasRows,
                tvSymbol:       ov.tvSymbol       ?? (a.tvSymbol || ""),
                marketProvider: ov.marketProvider  ?? (a.marketProvider || ""),
                marketSymbol:   ov.ticker          ?? (a.marketSymbol || a.finnhubSymbol || "")
            }
        })

    const operacionesItems = (window._segOperacionesItems || [])
        .filter(item => !hidden.has(item._segId))

    _segAllItems = [...portfolioItems, ...operacionesItems, ...customItems]
    segRenderGrid()
    segUpdateHiddenBtn()
}

async function segRefreshCustomPrices() {
    const customs = segLoadCustomItems()
    let updated = false
    for (const item of customs) {
        if (!item.ticker) continue
        try {
            const params = new URLSearchParams({ symbol: item.ticker })
            if (item.marketProvider) params.set("provider", item.marketProvider)
            const resp = await fetch(`/api/market/quote?${params}`)
            if (!resp.ok) continue
            const data = await resp.json()
            if (!data.ok || !data.price) continue
            item.price       = String(data.price)
            item.change      = String(data.change ?? "")
            item.currency    = data.currency || "EUR"
            item.lastUpdated = data.lastUpdated || new Date().toISOString()
            updated = true
        } catch { /* ignore individual failures */ }
    }
    if (updated) {
        segSaveCustomItems(customs)
        segMergeAndRender(window._segPortfolioAssets || [])
    }
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
    const segAlphaVantageBtn = document.getElementById("segSearchAlphaVantageBtn")
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

    // cargar operaciones y construir items únicos por activo
    try {
        const opResp = await fetch("/api/operaciones")
        if (opResp.ok) {
            const opData = await opResp.json()
            const opRows = opData.rows || []
            const seenAssetIds = new Set()
            window._segOperacionesItems = opRows
                .filter(row => {
                    if (!row.assetId || seenAssetIds.has(row.assetId)) return false
                    seenAssetIds.add(row.assetId)
                    return true
                })
                .flatMap(row => {
                    const asset = portfolioAssets.find(a => a.id === row.assetId)
                    if (!asset) return []
                    return [{
                        _segId:          `operacion_${asset.id}`,
                        _fromOperaciones: true,
                        _fromPortfolio:   false,
                        name:            asset.name || asset.symbol || row.activo || "",
                        symbol:          asset.symbol || asset.name || row.activo || "",
                        ticker:          asset.marketSymbol || asset.finnhubSymbol || row.ticker || "",
                        marketSymbol:    asset.marketSymbol || asset.finnhubSymbol || row.ticker || "",
                        marketProvider:  asset.marketProvider || row.marketProvider || "finnhub",
                        tvSymbol:        asset.tvSymbol || row.tvSymbol || "",
                        type:            asset.type || "cripto",
                        price:           String(asset.price || ""),
                        currency:        asset.currency || "EUR",
                        change:          String(asset.change || ""),
                        lastUpdated:     asset.lastUpdated || null
                    }]
                })
        }
    } catch { window._segOperacionesItems = [] }

    // restaurar filtros guardados
    const _pid = _segPid()
    try {
        const st = localStorage.getItem(`seguimientoFilterType_${_pid}`)
        const ss = localStorage.getItem(`seguimientoFilterSrc_${_pid}`)
        if (st) _segFilterType = JSON.parse(st)
        if (ss) _segFilterSrc  = JSON.parse(ss)
    } catch { /* ignorar */ }

    // inicializar vista guardada
    viewToggle?.querySelectorAll(".avViewBtn").forEach(btn => {
        btn.classList.toggle("active", btn.dataset.view === _segViewMode)
    })

    segMergeAndRender(portfolioAssets)
    segRefreshCustomPrices()

    hiddenBtn?.addEventListener("click", segOpenHiddenModal)
    hiddenCloseBtn?.addEventListener("click", () => hiddenModalOverlay?.classList.add("hidden"))
    hiddenModalOverlay?.addEventListener("click", (e) => {
        if (e.target === hiddenModalOverlay) hiddenModalOverlay.classList.add("hidden")
    })

    const updateSegFilterLabel = () => {
        const btn = document.getElementById("seguimientoFilterDropBtn")
        if (!btn) return
        const filtersEl2   = document.getElementById("seguimientoFilters")
        const srcFiltersEl2 = document.getElementById("seguimientoSourceFilters")
        const typeTodos = filtersEl2?.querySelector('[data-type="all"] input')
        const srcTodos  = srcFiltersEl2?.querySelector('[data-source="all"] input')
        const typeParts = typeTodos?.checked ? [] :
            [...(filtersEl2?.querySelectorAll('.activosFilterBtn:not([data-type="all"]) input') || [])]
                .filter(cb => cb.checked).map(cb => cb.closest(".activosFilterBtn").querySelector("span").textContent)
        const srcParts = srcTodos?.checked ? [] :
            [...(srcFiltersEl2?.querySelectorAll('.activosFilterBtn:not([data-source="all"]) input') || [])]
                .filter(cb => cb.checked).map(cb => cb.closest(".activosFilterBtn").querySelector("span").textContent)
        const parts = [...typeParts, ...srcParts]
        btn.textContent = (parts.length ? parts.join(", ") : "Todos") + " ▾"
    }

    // filtros de tipo
    if (filtersEl) {
        const todosTInput = filtersEl.querySelector('[data-type="all"] input')
        const getTypeIndividuals = () => [...filtersEl.querySelectorAll('.activosFilterBtn:not([data-type="all"]) input')]
        const syncTypeState = () => {
            if (todosTInput?.checked) {
                _segFilterType = "all"
            } else {
                const sel = getTypeIndividuals().filter(cb => cb.checked).map(cb => cb.closest(".activosFilterBtn").dataset.type)
                _segFilterType = sel.length ? sel : "all"
                if (!sel.length && todosTInput) todosTInput.checked = true
            }
            localStorage.setItem(`seguimientoFilterType_${_segPid()}`, JSON.stringify(_segFilterType))
            updateSegFilterLabel()
        }
        if (_segFilterType === "all") {
            if (todosTInput) todosTInput.checked = true
            getTypeIndividuals().forEach(cb => { cb.checked = true })
        } else {
            if (todosTInput) todosTInput.checked = false
            getTypeIndividuals().forEach(cb => {
                cb.checked = _segFilterType.includes(cb.closest(".activosFilterBtn").dataset.type)
            })
        }
        if (!filtersEl.dataset.bound) {
            filtersEl.dataset.bound = "true"
            filtersEl.addEventListener("change", (e) => {
                const changed = e.target
                if (changed === todosTInput) {
                    changed.checked = true
                    getTypeIndividuals().forEach(cb => { cb.checked = true })
                } else if (todosTInput?.checked) {
                    todosTInput.checked = false
                    getTypeIndividuals().forEach(cb => { cb.checked = cb === changed })
                    changed.checked = true
                } else {
                    if (todosTInput) todosTInput.checked = getTypeIndividuals().every(cb => cb.checked)
                }
                syncTypeState()
                segRenderGrid()
            })
        }
    }

    // filtros de fuente (todos / portfolio / nuevos)
    if (srcFiltersEl) {
        const todosSInput = srcFiltersEl.querySelector('[data-source="all"] input')
        const getSrcIndividuals = () => [...srcFiltersEl.querySelectorAll('.activosFilterBtn:not([data-source="all"]) input')]
        const syncSrcState = () => {
            if (todosSInput?.checked) {
                _segFilterSrc = "all"
            } else {
                const sel = getSrcIndividuals().filter(cb => cb.checked).map(cb => cb.closest(".activosFilterBtn").dataset.source)
                _segFilterSrc = sel.length ? sel : "all"
                if (!sel.length && todosSInput) todosSInput.checked = true
            }
            localStorage.setItem(`seguimientoFilterSrc_${_segPid()}`, JSON.stringify(_segFilterSrc))
            updateSegFilterLabel()
        }
        if (_segFilterSrc === "all") {
            if (todosSInput) todosSInput.checked = true
            getSrcIndividuals().forEach(cb => { cb.checked = true })
        } else {
            if (todosSInput) todosSInput.checked = false
            getSrcIndividuals().forEach(cb => {
                cb.checked = _segFilterSrc.includes(cb.closest(".activosFilterBtn").dataset.source)
            })
        }
        if (!srcFiltersEl.dataset.bound) {
            srcFiltersEl.dataset.bound = "true"
            srcFiltersEl.addEventListener("change", (e) => {
                const changed = e.target
                if (changed === todosSInput) {
                    changed.checked = true
                    getSrcIndividuals().forEach(cb => { cb.checked = true })
                } else if (todosSInput?.checked) {
                    todosSInput.checked = false
                    getSrcIndividuals().forEach(cb => { cb.checked = cb === changed })
                    changed.checked = true
                } else {
                    if (todosSInput) todosSInput.checked = getSrcIndividuals().every(cb => cb.checked)
                }
                syncSrcState()
                segRenderGrid()
            })
        }
    }

    updateSegFilterLabel()

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
    function segClearSearch() {
        if (segSearchFeedback) segSearchFeedback.classList.add("hidden")
        if (segSearchResults)  { segSearchResults.classList.add("hidden"); segSearchResults.innerHTML = "" }
    }

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

    segAlphaVantageBtn?.addEventListener("click", async () => {
        if (typeof handleAlphaVantageSearch !== "function") return
        const query = nombreInput?.value.trim() || tickerInput?.value.trim() || ""
        await handleAlphaVantageSearch({
            query,
            assetName: nombreInput?.value.trim() || "",
            assetType: typeSelect?.value || "",
            feedbackElement: segSearchFeedback,
            resultsElement: segSearchResults,
            onSelect: (r) => segTickerSelected(r, "Alpha Vantage")
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
            if (editConfirmBtn)    { editConfirmBtn.removeAttribute("style"); editConfirmBtn.classList.remove("hidden") }
            const rawTV = allItem.tvSymbol || ""
            if (editTVInput) editTVInput.value = typeof decodeTVTicker === "function" ? decodeTVTicker(rawTV) : rawTV
        } else {
            const customs = segLoadCustomItems()
            const item = customs.find(c => c._segId === segId)
            if (!item) return
            if (editModalTitle)    editModalTitle.textContent = "Editar activo"
            if (editPortfolioNote) editPortfolioNote.classList.add("hidden")
            if (editCustomForm)    editCustomForm.classList.remove("hidden")
            if (editConfirmBtn)    { editConfirmBtn.removeAttribute("style"); editConfirmBtn.classList.remove("hidden") }

            editNombreInput.value = item.nombre || ""
            if (editTypeSelect) editTypeSelect.value = item.tipo || "acciones"
            editTickerInput.value = item.ticker || ""
            delete editTickerInput.dataset.marketProvider
            if (item.marketProvider) editTickerInput.dataset.marketProvider = item.marketProvider
            const rawTV2 = item.tvSymbol || ""
            if (editTVInput) editTVInput.value = typeof decodeTVTicker === "function" ? decodeTVTicker(rawTV2) : rawTV2
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

        if (allItem?._fromPortfolio) {
            const tvVal = editTVInput?.value.trim() || ""
            const overrides = JSON.parse(localStorage.getItem(`seguimientoOverrides_${_segPid()}`) || localStorage.getItem("seguimientoOverrides") || "{}")
            overrides[_editingSegId] = { ...(overrides[_editingSegId] || {}), tvSymbol: tvVal }
            localStorage.setItem(`seguimientoOverrides_${_segPid()}`, JSON.stringify(overrides))
            _editingSegId = null
            editOverlay?.classList.add("hidden")
            segMergeAndRender(portfolioAssets)
            return
        }

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

    document.getElementById("segEditSearchAlphaVantageBtn")?.addEventListener("click", async () => {
        if (typeof handleAlphaVantageSearch !== "function") return
        await handleAlphaVantageSearch({
            query: editNombreInput?.value.trim() || editTickerInput?.value.trim() || "",
            assetName: editNombreInput?.value.trim() || "",
            assetType: editTypeSelect?.value || "",
            feedbackElement: editFeedback,
            resultsElement: editResults,
            onSelect: (r) => editTickerSelected(r, "Alpha Vantage")
        })
    })
}
