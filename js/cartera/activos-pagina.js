// Página Activos: tarjetas, tabla, filtros y gráfico de TradingView.
//
// Separado de js/cartera/assets.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

// ── Página Activos ─────────────────────────────────────────────────────────

const AV_TYPE_COLORS = {
    cripto: "#f7931a",
    acciones: "#3a7bd5",
    etfs: "#2ecc71",
    comoditis: "#e0c068"
}
const AV_TYPE_LABELS = {
    cripto: "Cripto",
    acciones: "Acciones",
    etfs: "ETFs",
    comoditis: "Comoditis"
}

let _activosAllAssets = []
let _activosFilterType = "all"
let _activosSearch = ""
let _activosViewMode = localStorage.getItem("activosViewMode") || "cards"
let _activosShowHidden = false

function avIsOculto(a) {
    return a.hidden || ((a.invertidoNeto ?? 1) === 0 && (a.rendimiento ?? 0) === 0)
}

function avFilteredAssets() {
    return _activosAllAssets.filter((a) => {
        if (avIsOculto(a) && !_activosShowHidden) return false
        const matchType = _activosFilterType === "all" || _activosFilterType.includes(a.type)
        const q = _activosSearch.toLowerCase()
        const matchSearch = !q || (a.name || "").toLowerCase().includes(q) || (a.symbol || "").toLowerCase().includes(q)
        return matchType && matchSearch
    })
}

async function avToggleAssetHidden(assetId) {
    const asset = _activosAllAssets.find((a) => a.id === assetId)
    if (!asset) return
    asset.hidden = !asset.hidden
    try {
        const full = await loadAssetData(assetId)
        full.hidden = asset.hidden
        await saveAssetDataToServer(full)
    } catch (err) {
        asset.hidden = !asset.hidden
        console.error("Error guardando estado oculto:", err)
        return
    }
    avRender()
    // El sidebar lee el mismo flag: se repinta ya para no arrastrar el activo
    // oculto en la lista ni en la ficha de detalle hasta la siguiente carga.
    await refreshAssetsSidebar()
}

function avBuildCard(asset) {
    const color = AV_TYPE_COLORS[asset.type] || "#888"
    const typeLabel = AV_TYPE_LABELS[asset.type] || asset.type || ""
    const price = parseLooseNumber(asset.price || "") || 0
    const currency = asset.currency || "EUR"
    const provider = String(
        asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "") || ""
    ).toUpperCase()

    const m = asset._metrics
    const hasM = !!m
    const rClass = hasM ? (m.rendimientoEur >= 0 ? "avPos" : "avNeg") : ""
    const rendSign = hasM ? (m.rendimientoEur >= 0 ? "+" : "") : ""
    const avgPriceStr = hasM && m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency || currency) : "—"

    let lastUpdatedStr = "—"
    if (asset.lastUpdated) {
        const d = new Date(asset.lastUpdated)
        if (!isNaN(d)) {
            const hh = String(d.getHours()).padStart(2, "0")
            const mm = String(d.getMinutes()).padStart(2, "0")
            const dd = String(d.getDate()).padStart(2, "0")
            const mo = String(d.getMonth() + 1).padStart(2, "0")
            lastUpdatedStr = `${dd}/${mo} ${hh}:${mm}`
        }
    }

    const card = document.createElement("div")
    card.className = `avCard${avIsOculto(asset) ? " avHidden" : ""}`
    card.dataset.assetId = asset.id
    card.style.setProperty("--av-color", color)
    card.draggable = true

    const assetColor = asset.color || ""
    card.innerHTML = `
        <div class="avCardTop">
            <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${typeLabel}</span>
            <div class="avCardActions">
                ${assetColor ? `<span class="avColorDot" style="background:${assetColor};--dot-color:${assetColor}" title="Color del activo"></span>` : ""}
                <div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">
                        <button type="button" class="rowMenuItem avActionBtn avEditBtn" data-asset-id="${asset.id}">Editar</button>
                        <button type="button" class="rowMenuItem avActionBtn avHideBtn" data-asset-id="${asset.id}">${asset.hidden ? "Mostrar" : "Ocultar"}</button>
                        <hr>
                        <button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn" data-asset-id="${asset.id}">Eliminar</button>
                    </div>
                </div>
            </div>
        </div>
        <div class="avCardSymbol">${escapeHtml(asset.symbol || asset.name)}</div>
        <div class="avCardName">${escapeHtml(asset.name || asset.symbol || "Activo")}</div>
        <div class="avCardPrice">${formatMoney(price, currency)}</div>
        <div class="avCardTicker">${provider || "Sin ticker"}</div>
        <div class="avCardMetrics">
            <div class="avMetricItem">
                <span class="avMetricLabel">Posición</span>
                <span class="avMetricValue">${hasM ? formatShareQuantity(m.participaciones) : "—"}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Valor actual</span>
                <span class="avMetricValue">${hasM ? formatEuro(m.netoActualEur) : "—"}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">P. medio compra</span>
                <span class="avMetricValue">${avgPriceStr}</span>
            </div>
            <div class="avMetricItem">
                <span class="avMetricLabel">Rendimiento</span>
                <span class="avMetricValue ${rClass}">${hasM ? rendSign + formatEuro(m.rendimientoEur) + (m.invertidoEur > 0 ? "<br><small>" + rendSign + ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) + " %</small>" : "") : "—"}</span>
            </div>
        </div>
        <div class="avCardUpdated">Actualizado: ${lastUpdatedStr}</div>
        <div class="avCardBar" style="background:${color}"></div>
    `

    return card
}

function avRenderGrid() {
    const grid = document.getElementById("activosGrid")
    const count = document.getElementById("activosCount")
    if (!grid) return

    const filtered = avFilteredAssets()
    if (count) count.textContent = `${filtered.length} activo${filtered.length !== 1 ? "s" : ""}`

    const activosGridEmpty = document.getElementById("activosGridEmpty")
    grid.innerHTML = ""

    if (!filtered.length) {
        if (activosGridEmpty) activosGridEmpty.classList.remove("hidden")
        return
    }

    if (activosGridEmpty) activosGridEmpty.classList.add("hidden")
    const frag = document.createDocumentFragment()
    filtered.forEach((a) => frag.appendChild(avBuildCard(a)))
    grid.appendChild(frag)
}

function avBuildTableRow(asset, rank) {
    const color = AV_TYPE_COLORS[asset.type] || "#888"
    const typeLabel = AV_TYPE_LABELS[asset.type] || asset.type || ""
    const price = parseLooseNumber(asset.price || "") || 0
    const currency = asset.currency || "EUR"
    const provider = String(
        asset.marketProvider || inferMarketProviderFromSymbol(asset.marketSymbol || asset.finnhubSymbol || "") || ""
    ).toUpperCase()

    const m = asset._metrics
    const hasM = !!m
    const rClass = hasM ? (m.rendimientoEur >= 0 ? "avPos" : "avNeg") : ""
    const rendSign = hasM ? (m.rendimientoEur >= 0 ? "+" : "") : ""
    const avgPriceStr = hasM && m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency || currency) : "—"

    let lastUpdatedStr = "—"
    if (asset.lastUpdated) {
        const d = new Date(asset.lastUpdated)
        if (!isNaN(d)) {
            const hh = String(d.getHours()).padStart(2, "0")
            const mm = String(d.getMinutes()).padStart(2, "0")
            const dd = String(d.getDate()).padStart(2, "0")
            const mo = String(d.getMonth() + 1).padStart(2, "0")
            lastUpdatedStr = `${dd}/${mo} ${hh}:${mm}`
        }
    }

    const rendStr = hasM
        ? m.invertidoEur > 0
            ? rendSign +
              formatEuro(m.rendimientoEur) +
              " <small>" +
              rendSign +
              ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) +
              " %</small>"
            : rendSign + formatEuro(m.rendimientoEur)
        : "—"

    const tr = document.createElement("tr")
    tr.className = `avTableRow${avIsOculto(asset) ? " avHidden" : ""}`
    tr.dataset.assetId = asset.id
    tr.innerHTML = `
        <td class="mTdRank">${rank}</td>
        <td><span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${typeLabel}</span></td>
        <td class="avTrName">${asset.color ? `<span class="avColorDot avTrColorDot" style="background:${asset.color}" title="Color del activo"></span>` : ""}${escapeHtml(asset.name || asset.symbol || "Activo")}</td>
        <td class="avTrPrice">${formatMoney(price, currency)}</td>
        <td class="avTrProvider">${escapeHtml(provider || "—")}</td>
        <td class="avTrPos">${hasM ? formatShareQuantity(m.participaciones) : "—"}</td>
        <td class="avTrValor">${hasM ? formatEuro(m.netoActualEur) : "—"}</td>
        <td class="avTrAvg">${avgPriceStr}</td>
        <td class="avTrRend ${rClass}">${rendStr}</td>
        <td class="avTrUpdated">${lastUpdatedStr}</td>
        <td class="avTrActions">
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem avActionBtn avEditBtn" data-asset-id="${asset.id}">Editar</button>
                    <button type="button" class="rowMenuItem avActionBtn avHideBtn" data-asset-id="${asset.id}">${asset.hidden ? "Mostrar" : "Ocultar"}</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger avActionBtn avDeleteBtn" data-asset-id="${asset.id}">Eliminar</button>
                </div>
            </div>
        </td>
    `
    return tr
}

function avRenderTable() {
    const tbody = document.getElementById("activosTableBody")
    const count = document.getElementById("activosCount")
    if (!tbody) return

    const filtered = avFilteredAssets()
    if (count) count.textContent = `${filtered.length} activo${filtered.length !== 1 ? "s" : ""}`

    const activosTableEmpty = document.getElementById("activosTableEmpty")
    const activosTableWrap = document.getElementById("activosTableWrap")
    tbody.innerHTML = ""

    if (!filtered.length) {
        if (activosTableEmpty) activosTableEmpty.classList.remove("hidden")
        if (activosTableWrap) activosTableWrap.classList.add("hidden")
        return
    }

    if (activosTableEmpty) activosTableEmpty.classList.add("hidden")
    if (activosTableWrap) activosTableWrap.classList.remove("hidden")
    const frag = document.createDocumentFragment()
    filtered.forEach((a, idx) => frag.appendChild(avBuildTableRow(a, idx + 1)))
    tbody.appendChild(frag)
    const t = tbody.closest("table")
    bindTableSort(t, "activosTableOrder")
    if (t._reSort) t._reSort()
}

function avRender() {
    const gridEl = document.getElementById("activosGrid")
    const tableWrap = document.getElementById("activosTableWrap")
    if (_activosViewMode === "table") {
        if (gridEl) gridEl.classList.add("hidden")
        if (tableWrap) tableWrap.classList.remove("hidden")
        avRenderTable()
    } else {
        if (tableWrap) tableWrap.classList.add("hidden")
        const activosTableEmpty = document.getElementById("activosTableEmpty")
        if (activosTableEmpty) activosTableEmpty.classList.add("hidden")
        if (gridEl) gridEl.classList.remove("hidden")
        avRenderGrid()
    }
}

async function avHandleCardClick(event) {
    const deleteBtn = event.target.closest(".avDeleteBtn")
    if (deleteBtn) {
        const id = deleteBtn.dataset.assetId
        const asset = _activosAllAssets.find((a) => a.id === id)
        const assetName = asset?.name || id
        openConfirmModal({
            title: "Eliminar activo",
            message: `Vas a eliminar "${assetName}": sus compras, operaciones y planes se borran con él. Esto no se puede deshacer.`,
            confirmLabel: "Eliminar",
            confirmSide: "right",
            requireText: assetName,
            onConfirm: async () => {
                await deleteAssetOnServer(id)
                _activosAllAssets = _activosAllAssets.filter((a) => a.id !== id)
                avRender()
                await refreshAssetsSidebar()
            }
        })
        return
    }

    const hideBtn = event.target.closest(".avHideBtn")
    if (hideBtn) {
        await avToggleAssetHidden(hideBtn.dataset.assetId)
        return
    }

    const editBtn = event.target.closest(".avEditBtn")
    if (editBtn) {
        const id = editBtn.dataset.assetId
        currentAssetId = id
        const fullAsset = await loadAssetData(id)
        openEditAssetModal(fullAsset)
        return
    }

    if (event.target.closest(".rowMenu")) return

    const card = event.target.closest(".avCard")
    if (card) {
        const asset = _activosAllAssets.find((a) => a.id === card.dataset.assetId)
        if (asset) openTVChartModal(buildTVSymbol(asset), asset.symbol || asset.name)
        return
    }

    const tableRow = event.target.closest(".avTableRow")
    if (tableRow && !event.target.closest(".avTrActions")) {
        const asset = _activosAllAssets.find((a) => a.id === tableRow.dataset.assetId)
        if (asset) openTVChartModal(buildTVSymbol(asset), asset.symbol || asset.name)
    }
}

function decodeTVTicker(raw) {
    const s = (raw || "").trim()
    if (!s) return ""
    try {
        return decodeURIComponent(s)
    } catch {
        return s
    }
}

function buildTVSymbol(asset) {
    if (asset.tvSymbol && String(asset.tvSymbol).trim()) return decodeTVTicker(String(asset.tvSymbol).trim())

    const mSym = String(asset.marketSymbol || asset.finnhubSymbol || "").trim()
    const uSym = String(asset.symbol || asset.name || "")
        .trim()
        .toUpperCase()
    const provider = String(asset.marketProvider || inferMarketProviderFromSymbol(mSym)).toLowerCase()
    const upper = mSym.toUpperCase()

    if (provider === "yahoo") {
        // Futuros de Yahoo → TradingView
        const yFutures = {
            "GC=F": "COMEX:GC1!",
            "SI=F": "COMEX:SI1!",
            "CL=F": "NYMEX:CL1!",
            "NG=F": "NYMEX:NG1!",
            "HG=F": "COMEX:HG1!",
            "PL=F": "NYMEX:PL1!",
            "PA=F": "NYMEX:PA1!",
            "ZC=F": "CBOT:ZC1!",
            "ZW=F": "CBOT:ZW1!",
            "ES=F": "CME:ES1!",
            "NQ=F": "CME:NQ1!",
            "YM=F": "CBOT:YM1!"
        }
        if (yFutures[upper]) return yFutures[upper]
        // Crypto Yahoo: BTC-USD → BTCUSD
        if (upper.endsWith("-USD")) return upper.replace("-USD", "USD")
        if (upper.endsWith("-EUR")) return upper.replace("-EUR", "EUR")
        if (upper.endsWith("-USDT")) return upper.replace("-USDT", "USDT")
        return mSym || uSym
    }

    if (provider === "eodhd" && mSym.includes(".")) {
        const parts = mSym.split(".")
        const sym = parts[0]
        const exchange = parts[parts.length - 1].toUpperCase()
        // Crypto EODHD: BTC-USD.CC → BTCUSD
        if (exchange === "CC") return sym.replace(/-USD$/, "USD").replace(/-EUR$/, "EUR").replace(/-/, "")
        const tvEx = {
            US: "",
            XETRA: "XETRA",
            PA: "EURONEXT",
            LSE: "LSE",
            SW: "SIX",
            AS: "EURONEXT",
            MC: "BME",
            MI: "MIL",
            F: "FWB",
            DU: "XETRA",
            BE: "XETRA"
        }
        const ex = tvEx[exchange]
        if (ex === "") return sym
        if (ex) return `${ex}:${sym}`
        return sym
    }

    if (provider === "finnhub") {
        // Finnhub ya usa formato EXCHANGE:SYMBOL o solo SYMBOL
        if (mSym.includes(":")) return mSym
        return mSym || uSym
    }

    if (provider === "tradingview") {
        // El ticker de mercado YA es sintaxis de TradingView (MERCADO:SYMBOL):
        // no hace falta traducir nada, es justo lo que pide este gráfico.
        return mSym || uSym
    }

    return uSym
}

function buildTVIframeUrl(tvSymbol) {
    const isLight = document.documentElement.getAttribute("data-theme") === "light"
    const theme = isLight ? "light" : "dark"
    const toolbarbg = isLight ? "f1f5f9" : "111827"
    const p = new URLSearchParams({
        symbol: tvSymbol,
        interval: "D",
        theme,
        style: "1",
        locale: "es",
        hidesidetoolbar: "0",
        symboledit: "1",
        saveimage: "1",
        range: "12M",
        toolbarbg
    })
    return `https://www.tradingview.com/widgetembed/?${p.toString()}`
}

function openTVChartModal(tvSymbol, displayName) {
    const existing = document.getElementById("tvChartOverlay")
    if (existing) existing.remove()

    const overlay = document.createElement("div")
    overlay.id = "tvChartOverlay"
    overlay.className = "tvChartOverlay"

    overlay.innerHTML = `
        <div class="tvChartModal">
            <div class="tvChartModalHeader">
                <span class="tvChartModalTitle">${escapeHtml(displayName || tvSymbol)}</span>
                <span class="tvChartModalSym">${escapeHtml(tvSymbol)}</span>
                <div class="tvChartHeaderSpacer"></div>
                <button type="button" class="tvChartCloseBtn" title="Cerrar">✕</button>
            </div>
            <div class="tvChartIframeWrap">
                <iframe src="${escapeAttr(buildTVIframeUrl(tvSymbol))}" frameborder="0" allowtransparency="true" scrolling="no" allowfullscreen
                    sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
                    referrerpolicy="no-referrer"></iframe>
            </div>
        </div>
    `

    overlay.addEventListener("click", (e) => {
        if (e.target.closest(".tvChartCloseBtn")) overlay.remove()
    })

    document.addEventListener("keydown", function onEsc(e) {
        if (e.key === "Escape") {
            overlay.remove()
            document.removeEventListener("keydown", onEsc)
        }
    })

    document.body.appendChild(overlay)
}

async function initActivosPageLogic() {
    _activosAllAssets = await loadAssetsList()
    _activosFilterType = "all"
    _activosSearch = ""
    _activosShowHidden = false

    const showHiddenBtn = document.getElementById("activosShowHiddenBtn")
    if (showHiddenBtn) {
        showHiddenBtn.classList.toggle("active", _activosShowHidden)
        showHiddenBtn.addEventListener("click", () => {
            _activosShowHidden = !_activosShowHidden
            showHiddenBtn.classList.toggle("active", _activosShowHidden)
            avRender()
        })
    }

    const viewToggle = document.getElementById("avViewToggle")
    if (viewToggle) {
        viewToggle.querySelectorAll(".avViewBtn").forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.view === _activosViewMode)
        })
        viewToggle.addEventListener("click", (e) => {
            const btn = e.target.closest(".avViewBtn")
            if (!btn) return
            _activosViewMode = btn.dataset.view
            localStorage.setItem("activosViewMode", _activosViewMode)
            viewToggle.querySelectorAll(".avViewBtn").forEach((b) => b.classList.toggle("active", b === btn))
            avRender()
        })
    }

    avRender()

    const grid = document.getElementById("activosGrid")
    if (grid) grid.addEventListener("click", avHandleCardClick)

    const tableWrap = document.getElementById("activosTableWrap")
    if (tableWrap) tableWrap.addEventListener("click", avHandleCardClick)

    const filters = document.getElementById("activosFilters")
    if (filters) {
        const todosInput = filters.querySelector('[data-type="all"] input')
        const getIndividuals = () => [...filters.querySelectorAll('.activosFilterBtn:not([data-type="all"]) input')]
        const updateFilterLabel = () => {
            const btn = document.getElementById("activosFilterDropBtn")
            if (!btn) return
            if (todosInput?.checked) {
                btn.textContent = "Todos ▾"
            } else {
                const sel = getIndividuals()
                    .filter((cb) => cb.checked)
                    .map((cb) => cb.closest(".activosFilterBtn").querySelector("span").textContent)
                btn.textContent = (sel.join(", ") || "Todos") + " ▾"
            }
        }
        const syncFilterState = () => {
            if (todosInput?.checked) {
                _activosFilterType = "all"
            } else {
                const sel = getIndividuals()
                    .filter((cb) => cb.checked)
                    .map((cb) => cb.closest(".activosFilterBtn").dataset.type)
                _activosFilterType = sel.length ? sel : "all"
                if (!sel.length && todosInput) todosInput.checked = true
            }
            updateFilterLabel()
        }
        // reset to Todos on each init
        if (todosInput) todosInput.checked = true
        getIndividuals().forEach((cb) => {
            cb.checked = true
        })
        updateFilterLabel()
        if (!filters.dataset.bound) {
            filters.dataset.bound = "true"
            filters.addEventListener("change", (e) => {
                const changed = e.target
                if (changed === todosInput) {
                    changed.checked = true
                    getIndividuals().forEach((cb) => {
                        cb.checked = true
                    })
                } else if (todosInput?.checked) {
                    todosInput.checked = false
                    getIndividuals().forEach((cb) => {
                        cb.checked = cb === changed
                    })
                    changed.checked = true
                } else {
                    if (todosInput) todosInput.checked = getIndividuals().every((cb) => cb.checked)
                }
                syncFilterState()
                avRender()
            })
        }
    }

    const search = document.getElementById("activosSearch")
    if (search) {
        search.addEventListener("input", () => {
            _activosSearch = search.value.trim()
            avRender()
        })
    }

    avLoadMetrics()

    const addBtn = document.getElementById("activosAddBtn")
    if (addBtn) addBtn.addEventListener("click", () => openAssetModal())

    avInitDragDrop()
}

function avInitDragDrop() {
    const grid = document.getElementById("activosGrid")
    if (!grid || grid.dataset.dragBound === "true") return
    grid.dataset.dragBound = "true"

    let avDraggedId = null
    let avDropped = false

    grid.addEventListener("dragstart", (e) => {
        const card = e.target.closest(".avCard")
        if (!card || !card.dataset.assetId) return
        avDraggedId = card.dataset.assetId
        draggedAssetId = avDraggedId
        avDropped = false
        if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = "move"
            e.dataTransfer.setData("text/plain", avDraggedId)
        }
        // El estilo de hueco se aplica tras generar la imagen de arrastre
        requestAnimationFrame(() => card.classList.add("avDragging"))
    })

    grid.addEventListener("dragend", (e) => {
        const card = e.target.closest(".avCard")
        if (card) card.classList.remove("avDragging")
        avDraggedId = null
        draggedAssetId = null
        // Arrastre cancelado: se restaura el orden real
        if (!avDropped) avRenderGrid()
        avDropped = false
    })

    grid.addEventListener("dragover", (e) => {
        const dragged = grid.querySelector(".avCard.avDragging")
        if (!avDraggedId || !dragged) return
        e.preventDefault()
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move"
        moveDraggedAssetPreview(grid, dragged, avFindDropReference(grid, dragged, e.clientX, e.clientY))
    })

    grid.addEventListener("drop", async (e) => {
        const dragged = grid.querySelector(".avCard.avDragging")
        if (!avDraggedId || !dragged) return
        e.preventDefault()
        avDropped = true
        const movedAssetId = avDraggedId
        try {
            await commitAssetOrderFromDom(grid, ".avCard", movedAssetId)
            const metricsById = new Map(_activosAllAssets.map((a) => [a.id, a._metrics]))
            _activosAllAssets = await loadAssetsList()
            _activosAllAssets.forEach((a) => {
                const metrics = metricsById.get(a.id)
                if (metrics) a._metrics = metrics
            })
            avRender()
            avLoadMetrics()
        } catch (err) {
            console.error("avDrop error", err)
            avRenderGrid()
        }
    })
}

// Devuelve la tarjeta delante de la cual debe colocarse la arrastrada (null = al final)
function avFindDropReference(grid, dragged, pointerX, pointerY) {
    const cards = [...grid.querySelectorAll(".avCard")].filter((card) => card !== dragged && card.dataset.assetId)

    for (const card of cards) {
        const rect = card.getBoundingClientRect()

        if (pointerY > rect.bottom) continue
        if (pointerY < rect.top || pointerX < rect.left + rect.width / 2) return card
    }

    return null
}

async function avLoadMetrics() {
    const baseAssets = _activosAllAssets
    if (!baseAssets.length) return

    await Promise.all(
        baseAssets.map(async (asset) => {
            try {
                const full = await loadAssetData(asset.id)
                const row = await buildOverviewRow(full)
                const euros = await buildSummaryMetricsInEuros(row)

                const m = {
                    participaciones: row.participaciones,
                    promedioCompra: row.promedioCompra,
                    currency: row.currency,
                    netoActualEur: euros.netoActualEur,
                    invertidoEur: euros.invertidoBrutoEur,
                    rendimientoEur: euros.rendimientoEur
                }
                asset._metrics = m

                const rClass = m.rendimientoEur >= 0 ? "avPos" : "avNeg"
                const sign = m.rendimientoEur >= 0 ? "+" : ""
                const rendStr =
                    m.invertidoEur > 0
                        ? sign +
                          formatEuro(m.rendimientoEur) +
                          "<br><small>" +
                          sign +
                          ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) +
                          " %</small>"
                        : sign + formatEuro(m.rendimientoEur)

                const cardEl = document.querySelector(`.avCard[data-asset-id="${asset.id}"]`)
                if (cardEl) {
                    const vals = cardEl.querySelectorAll(".avMetricValue")
                    if (vals.length >= 4) {
                        vals[0].textContent = formatShareQuantity(m.participaciones)
                        vals[1].textContent = formatEuro(m.netoActualEur)
                        vals[2].textContent = m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency) : "—"
                        vals[3].innerHTML = rendStr
                        vals[3].className = "avMetricValue " + rClass
                    }
                }

                const trEl = document.querySelector(`.avTableRow[data-asset-id="${asset.id}"]`)
                if (trEl) {
                    const rendTrStr =
                        m.invertidoEur > 0
                            ? sign +
                              formatEuro(m.rendimientoEur) +
                              " <small>" +
                              sign +
                              ((m.rendimientoEur / m.invertidoEur) * 100).toFixed(2) +
                              " %</small>"
                            : sign + formatEuro(m.rendimientoEur)
                    const avgStr = m.promedioCompra > 0 ? formatMoney(m.promedioCompra, m.currency) : "—"
                    const posEl = trEl.querySelector(".avTrPos")
                    const valEl = trEl.querySelector(".avTrValor")
                    const avgEl = trEl.querySelector(".avTrAvg")
                    const rendEl = trEl.querySelector(".avTrRend")
                    if (posEl) posEl.textContent = formatShareQuantity(m.participaciones)
                    if (valEl) valEl.textContent = formatEuro(m.netoActualEur)
                    if (avgEl) avgEl.textContent = avgStr
                    if (rendEl) {
                        rendEl.innerHTML = rendTrStr
                        rendEl.className = "avTrRend " + rClass
                    }
                }
            } catch (e) {
                console.error("avLoadMetrics error", asset.id, e)
            }
        })
    )
}
