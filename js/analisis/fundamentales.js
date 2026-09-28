// ── Fundamentales / Estadísticas de mercado ─────────────────────────────────
//
// Screener de solo lectura sobre los activos del portfolio: fundamentales y
// técnico del scanner de TradingView, los mismos campos que alimentan sus
// propias tablas (market_cap_basic, price_earnings_ttm, Recommend.All, RSI...).
//
// El ticker de cada fila es el mismo que ya resuelve `buildTVSymbol` (assets.js)
// para abrir el gráfico de cualquier activo, sea del proveedor que sea: no hay
// ninguna lista de tickers, mercados ni divisas aquí. Un activo sin
// "MERCADO:TICKER" resuelto se enseña sin fundamentales en vez de adivinar uno.

let _fnRows = []
let _fnActiveTypes = new Set(["all"])
let _fnSearch = ""
let _fnExpandedIds = new Set()
let _fnCache = null // { ts, rows }
const _FN_CACHE_TTL = 3 * 60 * 1000

// Umbrales del propio "Technical Rating" de TradingView (documentados en su
// web): de -1 a 1, igual para cualquier instrumento. No es una preferencia
// por ningún activo, es la escala que ya trae el dato `Recommend.All`.
const FN_RATING_TIERS = [
    { min: 0.5, label: "Compra fuerte", cls: "fnRatStrongBuy" },
    { min: 0.1, label: "Compra", cls: "fnRatBuy" },
    { min: -0.1, label: "Neutral", cls: "fnRatNeutral" },
    { min: -0.5, label: "Venta", cls: "fnRatSell" },
    { min: -Infinity, label: "Venta fuerte", cls: "fnRatStrongSell" }
]

const FN_TYPE_LABELS = { acciones: "Acciones", etfs: "ETFs", cripto: "Cripto", comoditis: "Comoditis", rentaFija: "Renta fija" }

async function initFundamentalesLogic() {
    _fnActiveTypes = new Set(["all"])
    _fnSearch = ""
    _fnExpandedIds = new Set()

    const typeFiltersEl = document.getElementById("fnTypeFilters")
    const searchEl = document.getElementById("fnSearch")
    const refreshBtn = document.getElementById("fnRefreshBtn")
    const tbody = document.getElementById("fnTableBody")

    typeFiltersEl?.addEventListener("click", (e) => {
        const label = e.target.closest(".activosFilterBtn")
        if (!label || !label.dataset.type) return
        const type = label.dataset.type

        if (type === "all") {
            _fnActiveTypes = new Set(["all"])
        } else {
            _fnActiveTypes.delete("all")
            if (_fnActiveTypes.has(type)) _fnActiveTypes.delete(type)
            else _fnActiveTypes.add(type)
            if (_fnActiveTypes.size === 0) _fnActiveTypes.add("all")
        }

        typeFiltersEl.querySelectorAll(".activosFilterBtn").forEach((b) => {
            const isActive = _fnActiveTypes.has("all") ? b.dataset.type === "all" : _fnActiveTypes.has(b.dataset.type)
            b.classList.toggle("active", isActive)
            const input = b.querySelector("input")
            if (input) input.checked = isActive
        })
        fnRenderTable()
    })

    searchEl?.addEventListener("input", () => {
        _fnSearch = searchEl.value.trim().toLowerCase()
        fnRenderTable()
    })

    refreshBtn?.addEventListener("click", async () => {
        refreshBtn.disabled = true
        await fnLoadData(true)
        fnRenderTable()
        refreshBtn.disabled = false
    })

    // Delegado: la tabla se regenera enteras al filtrar, así que escuchar en
    // el tbody (que no cambia de nodo) evita reenganchar listeners en cada fila.
    tbody?.addEventListener("click", (e) => {
        const expandBtn = e.target.closest(".fnExpandBtn")
        if (expandBtn) {
            e.stopPropagation()
            fnToggleExpand(expandBtn.closest("tr")?.dataset.id)
            return
        }
        const row = e.target.closest("tr.fnRow")
        if (!row) return
        const data = _fnRows.find((r) => r.id === row.dataset.id)
        if (data?.tvSymbol && typeof openTVChartModal === "function") {
            openTVChartModal(data.tvSymbol, data.name)
        }
    })

    await fnLoadData(false)
    fnRenderTable()
}

async function fnLoadData(forceRefresh) {
    const loadingEl = document.getElementById("fnLoading")

    if (!forceRefresh && _fnCache && Date.now() - _fnCache.ts < _FN_CACHE_TTL) {
        _fnRows = _fnCache.rows
        fnSetUpdatedLabel(_fnCache.ts)
        return
    }

    if (loadingEl) loadingEl.style.display = "flex"

    try {
        const res = await fetch("/api/activos")
        const data = await res.json()
        const assets = (Array.isArray(data.assets) ? data.assets : []).filter(Boolean)

        const rows = assets.map((asset) => {
            const tvSymbolRaw = typeof buildTVSymbol === "function" ? String(buildTVSymbol(asset) || "") : ""
            const hasTicker = tvSymbolRaw.includes(":")
            return {
                id: asset.id,
                name: asset.name || asset.symbol || asset.id,
                symbol: asset.symbol || asset.name || asset.id,
                type: String(asset.type || "acciones").toLowerCase(),
                price: asset.price ? parseEuroNumber(asset.price) : null,
                currency: String(asset.currency || "EUR").toUpperCase(),
                change: asset.change ? parseEuroNumber(asset.change) : null,
                tvSymbol: hasTicker ? tvSymbolRaw.toUpperCase() : "",
                hasTicker,
                stats: null
            }
        })

        const tickers = [...new Set(rows.filter((r) => r.hasTicker).map((r) => r.tvSymbol))]
        let stats = {}
        if (tickers.length) {
            try {
                const statsRes = await fetch(`/api/tradingview/stats?symbols=${encodeURIComponent(tickers.join(","))}`)
                const statsData = await statsRes.json()
                if (statsData.ok) stats = statsData.data || {}
            } catch {
                /* Sin conexión: la tabla se enseña sin fundamentales, nunca con datos inventados. */
            }
        }

        rows.forEach((row) => {
            row.stats = row.hasTicker ? stats[row.tvSymbol] || null : null
        })

        _fnRows = rows
        _fnCache = { ts: Date.now(), rows }
        fnSetUpdatedLabel(_fnCache.ts)
    } catch (err) {
        console.error("Fundamentales: error cargando datos", err)
        _fnRows = []
    }

    if (loadingEl) loadingEl.style.display = "none"
}

function fnSetUpdatedLabel(ts) {
    const el = document.getElementById("fnUpdated")
    if (!el) return
    const fecha = new Date(ts)
    el.textContent = `Actualizado ${fecha.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
}

function fnRenderTable() {
    const tbody = document.getElementById("fnTableBody")
    const tableWrap = document.getElementById("fnTableWrap")
    const emptyEl = document.getElementById("fnEmpty")
    const countEl = document.getElementById("fnCount")
    const table = document.getElementById("fnTable")
    if (!tbody) return

    const filtered = _fnRows.filter((row) => {
        if (!_fnActiveTypes.has("all") && !_fnActiveTypes.has(row.type)) return false
        if (_fnSearch) {
            const haystack = `${row.name} ${row.symbol} ${row.tvSymbol} ${row.stats?.sector || ""} ${row.stats?.industry || ""}`.toLowerCase()
            if (!haystack.includes(_fnSearch)) return false
        }
        return true
    })

    if (countEl) countEl.textContent = `${filtered.length} activo${filtered.length === 1 ? "" : "s"}`

    if (!filtered.length) {
        tbody.innerHTML = ""
        tableWrap?.classList.add("hidden")
        emptyEl?.classList.remove("hidden")
        return
    }

    emptyEl?.classList.add("hidden")
    tableWrap?.classList.remove("hidden")

    tbody.innerHTML = filtered.map((row) => fnBuildRowHtml(row)).join("")

    if (table && typeof bindTableSort === "function") {
        bindTableSort(table, "fundamentales")
        table._reSort && table._reSort()
    }
}

function fnBuildRowHtml(row) {
    const stats = row.stats || {}
    const expanded = _fnExpandedIds.has(row.id)
    const rating = fnRatingInfo(stats["Recommend.All"])
    const sectorMain = stats.sector || "—"
    const sectorSub = stats.industry ? `<span class="fnSectorSub">${escapeHtml(stats.industry)}</span>` : ""
    const changeCls = row.change > 0 ? "fnPos" : row.change < 0 ? "fnNeg" : ""
    const hasTechnical = row.hasTicker && !!row.stats

    const mainRow = `
        <tr class="fnRow ${row.hasTicker ? "" : "fnRowNd"}" data-id="${escapeHtml(row.id)}">
            <td class="fnCellAsset">
                <span class="fnAssetName">${escapeHtml(row.name)}</span>
                <span class="fnAssetTicker">${escapeHtml(row.tvSymbol || row.symbol)}</span>
            </td>
            <td><span class="fnTypeBadge" data-type="${escapeHtml(row.type)}">${escapeHtml(fnTypeLabel(row.type))}</span></td>
            <td class="fnCellSector" title="${escapeHtml(stats.country || "")}">
                <span class="fnSectorMain">${escapeHtml(sectorMain)}</span>
                ${sectorSub}
            </td>
            <td class="fnColNum">${fnPrice(row.price, row.currency)}</td>
            <td class="fnColNum ${changeCls}">${fnPercentSigned(row.change)}</td>
            <td>${
                row.hasTicker
                    ? `<span class="fnRatingBadge ${rating.cls}">${rating.label}</span>`
                    : `<span class="fnNd">Sin ticker TradingView</span>`
            }</td>
            <td class="fnColNum">${fnMarketCap(stats.market_cap_basic, row.currency)}</td>
            <td class="fnColNum">${fnRatio(stats.price_earnings_ttm)}</td>
            <td class="fnColNum">${fnRatio(stats.price_book_ratio)}</td>
            <td class="fnColNum">${fnRatio(stats.price_sales_ratio)}</td>
            <td class="fnColNum" title="${escapeHtml(fnGrowthTooltip(stats.earnings_per_share_diluted_yoy_growth_ttm))}">${fnMoneyFull(stats.earnings_per_share_basic_ttm, row.currency, 2)}</td>
            <td class="fnColNum">${fnPercentPlain(stats.dividend_yield_recent)}</td>
            <td class="fnColNum">${fnPercentPlain(stats.return_on_equity)}</td>
            <td class="fnColNum">${fnPercentPlain(stats.return_on_assets)}</td>
            <td class="fnColNum">${fnRatio(stats.debt_to_equity)}</td>
            <td class="fnColNum">${fnRatio(stats.RSI)}</td>
            <td class="fnColExpand">${
                hasTechnical
                    ? `<button type="button" class="fnExpandBtn ${expanded ? "fnExpandOpen" : ""}" title="Ver técnico completo">▾</button>`
                    : ""
            }</td>
        </tr>`

    const detailRow = hasTechnical
        ? `<tr class="fnDetailRow ${expanded ? "" : "hidden"}" data-detail-for="${escapeHtml(row.id)}">
               <td colspan="17">${fnBuildDetailHtml(row)}</td>
           </tr>`
        : ""

    return mainRow + detailRow
}

function fnBuildDetailHtml(row) {
    const s = row.stats || {}
    const cur = row.currency
    const ma = (label, sma, ema) =>
        `<div class="fnDetailRow2"><span>${label}</span><span>${fnPrice(sma, cur)}</span><span>${fnPrice(ema, cur)}</span></div>`
    const line = (label, value) => `<div class="fnDetailLine"><span>${label}</span><span>${value}</span></div>`

    return `
        <div class="fnDetailGrid">
            <div class="fnDetailCol">
                <h4>Medias móviles</h4>
                <div class="fnDetailRow2 fnDetailHead"><span></span><span>SMA</span><span>EMA</span></div>
                ${ma("20", s.SMA20, s.EMA20)}
                ${ma("50", s.SMA50, s.EMA50)}
                ${ma("100", s.SMA100, s.EMA100)}
                ${ma("200", s.SMA200, s.EMA200)}
            </div>
            <div class="fnDetailCol">
                <h4>Osciladores</h4>
                ${line("MACD", fnRatio(s["MACD.macd"]))}
                ${line("Señal MACD", fnRatio(s["MACD.signal"]))}
                ${line("ADX", fnRatio(s.ADX))}
                ${line("Estocástico %K", fnRatio(s["Stoch.K"]))}
                ${line("Estocástico %D", fnRatio(s["Stoch.D"]))}
            </div>
            <div class="fnDetailCol">
                <h4>Pivotes clásicos (mensual)</h4>
                ${line("R3", fnPrice(s["Pivot.M.Classic.R3"], cur))}
                ${line("R2", fnPrice(s["Pivot.M.Classic.R2"], cur))}
                ${line("R1", fnPrice(s["Pivot.M.Classic.R1"], cur))}
                <div class="fnDetailLine fnDetailPivotMid"><span>P</span><span>${fnPrice(s["Pivot.M.Classic.Middle"], cur)}</span></div>
                ${line("S1", fnPrice(s["Pivot.M.Classic.S1"], cur))}
                ${line("S2", fnPrice(s["Pivot.M.Classic.S2"], cur))}
                ${line("S3", fnPrice(s["Pivot.M.Classic.S3"], cur))}
            </div>
        </div>`
}

function fnToggleExpand(id) {
    if (!id) return
    if (_fnExpandedIds.has(id)) _fnExpandedIds.delete(id)
    else _fnExpandedIds.add(id)

    const open = _fnExpandedIds.has(id)
    const safeId = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(id) : id
    document.querySelector(`tr.fnDetailRow[data-detail-for="${safeId}"]`)?.classList.toggle("hidden", !open)
    document.querySelector(`tr.fnRow[data-id="${safeId}"] .fnExpandBtn`)?.classList.toggle("fnExpandOpen", open)
}

// ── Formato ──────────────────────────────────────────────────────────────

function fnTypeLabel(type) {
    return FN_TYPE_LABELS[type] || (type ? type[0].toUpperCase() + type.slice(1) : "—")
}

function fnRatingInfo(value) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return { label: "Sin datos", cls: "fnRatNd" }
    return FN_RATING_TIERS.find((tier) => num >= tier.min)
}

function fnPrice(value, currency) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    const decimals = Math.abs(num) >= 1000 ? 0 : Math.abs(num) >= 1 ? 2 : 4
    return (
        num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) +
        " " +
        currencySuffix(currency)
    )
}

// Siempre en millones, con la misma unidad para todas las filas. El screener
// de TradingView compacta cada fila a la unidad que le queda mejor (T/B/M),
// pero eso rompería el orden de esta columna: `bindTableSort` compara el
// texto de la celda quitando los puntos de millar, así que "3,70 T" y
// "913,00 B" se leerían como 3,70 y 913 sin que la letra cuente para nada.
function fnMarketCap(value, currency) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    return (num / 1e6).toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) + " " + currencySuffix(currency)
}

function fnMoneyFull(value, currency, decimals = 0) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    return (
        num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) +
        " " +
        currencySuffix(currency)
    )
}

function fnRatio(value, decimals = 2) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    return num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function fnPercentPlain(value, decimals = 2) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    return num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + " %"
}

// Se enseña como tooltip del BPA en vez de una segunda línea: una segunda
// línea visible se metería en el `textContent` que usa `bindTableSort` para
// ordenar esa columna, y el BPA dejaría de ordenar por su valor real.
function fnGrowthTooltip(value) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return ""
    const sign = num > 0 ? "+" : ""
    return `Crecimiento del BPA interanual: ${sign}${num.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`
}

function fnPercentSigned(value, decimals = 2) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    const sign = num > 0 ? "+" : ""
    return sign + num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + " %"
}
