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
// El método y el periodo de los pivotes no se reinician al volver a la página:
// es una preferencia de lectura, no un filtro de la tabla.
let _fnPivotMethod = "Classic"
let _fnPivotPeriod = "M"

// Sufijo de columna de cada periodo: lo explica `PIVOT_PERIODS` en
// tradingview_client.py, que es quien pide estas columnas al scanner.
const FN_PIVOT_PERIODS = {
    M: { label: "Mensual", suffix: "" },
    W: { label: "Semanal", suffix: "|240" },
    Y: { label: "Anual", suffix: "|1W" }
}
const FN_PIVOT_METHODS = {
    Classic: "Clásicos",
    Fibonacci: "Fibonacci",
    Camarilla: "Camarilla",
    Woodie: "Woodie",
    Demark: "DeMark"
}
const FN_PIVOT_LEVELS = ["R3", "R2", "R1", "Middle", "S1", "S2", "S3"]

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

const FN_TYPE_LABELS = {
    acciones: "Acciones",
    etfs: "ETFs",
    cripto: "Cripto",
    comoditis: "Comoditis",
    rentaFija: "Renta fija"
}

async function initFundamentalesLogic() {
    _fnActiveTypes = new Set(["all"])
    _fnSearch = ""
    _fnExpandedIds = new Set()

    const typeFiltersEl = document.getElementById("fnTypeFilters")
    const searchEl = document.getElementById("fnSearch")
    const refreshBtn = document.getElementById("fnRefreshBtn")
    const tbody = document.getElementById("fnTableBody")

    // "change" y no "click": un <label> con <input> dentro dispara el click del
    // label Y el click sintético que el navegador reenvía al checkbox, así que
    // un solo toque del usuario llegaba dos veces al delegado y el toggle se
    // deshacía a sí mismo (por eso los botones parecían no responder).
    typeFiltersEl?.addEventListener("change", (e) => {
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
            // Con "Todos" se encienden todos, como en el resto de filtros de la app.
            const isActive = _fnActiveTypes.has("all") || _fnActiveTypes.has(b.dataset.type)
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
        // La elección de pivotes es una sola para toda la tabla aunque los
        // botones estén en cada panel: así se comparan los mismos niveles.
        const pivotChip = e.target.closest(".fnPivotChip")
        if (pivotChip) {
            const { pivot, value } = pivotChip.dataset
            if (pivot === "method" && FN_PIVOT_METHODS[value]) _fnPivotMethod = value
            if (pivot === "period" && FN_PIVOT_PERIODS[value]) _fnPivotPeriod = value
            fnRenderTable()
            return
        }
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
            const haystack =
                `${row.name} ${row.symbol} ${row.tvSymbol} ${row.stats?.sector || ""} ${row.stats?.industry || ""}`.toLowerCase()
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

    tbody.innerHTML = filtered.map((row, idx) => fnBuildRowHtml(row, idx + 1)).join("")

    if (table && typeof bindTableSort === "function") {
        bindTableSort(table, "fundamentales")
        table._reSort && table._reSort()
    }
}

function fnBuildRowHtml(row, rank) {
    const stats = row.stats || {}
    const expanded = _fnExpandedIds.has(row.id)
    const rating = fnRatingInfo(stats["Recommend.All"])
    const sectorMain = stats.sector || "—"
    const sectorSub = stats.industry ? `<span class="fnSectorSub">${escapeHtml(stats.industry)}</span>` : ""
    const changeCls = row.change > 0 ? "fnPos" : row.change < 0 ? "fnNeg" : ""
    const hasTechnical = row.hasTicker && !!row.stats

    const mainRow = `
        <tr class="fnRow ${row.hasTicker ? "" : "fnRowNd"}" data-id="${escapeHtml(row.id)}">
            <td class="mTdRank">${rank}</td>
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
               <td colspan="18">${fnBuildDetailHtml(row)}</td>
           </tr>`
        : ""

    return mainRow + detailRow
}

function fnBuildDetailHtml(row) {
    const s = row.stats || {}
    const cur = row.currency

    return `
        <div class="fnDetailGrid">
            ${fnDetailMovingAverages(s, cur)}
            ${fnDetailOscillators(s)}
            ${fnDetailPivots(s, cur)}
        </div>
        <div class="fnDetailGrid">
            ${fnDetailPerformance(s)}
            ${fnDetailRange(s, cur)}
            ${fnDetailFundamentals(s, cur)}
        </div>`
}

function fnDetailLine(label, value, extraCls = "") {
    return `<div class="fnDetailLine ${extraCls}"><span>${label}</span><span>${value}</span></div>`
}

// Rating parcial de TradingView (solo medias o solo osciladores) junto al
// título del bloque: misma escala y mismos umbrales que el rating de la tabla.
function fnDetailColHead(title, ratingValue) {
    if (ratingValue === undefined) return `<div class="fnDetailColHead"><h4>${title}</h4></div>`
    const rating = fnRatingInfo(ratingValue)
    return `<div class="fnDetailColHead"><h4>${title}</h4><span class="fnRatingBadge fnRatingMini ${rating.cls}">${rating.label}</span></div>`
}

// Verde si el precio está por encima de la media (tendencia alcista frente a
// ella) y rojo si está por debajo, como la columna "Acción" de TradingView.
function fnMaCell(value, close, cur) {
    const ma = fnToNumber(value)
    const price = fnToNumber(close)
    const cls = ma === null || price === null || price === ma ? "" : price > ma ? "fnPos" : "fnNeg"
    return `<span class="${cls}">${fnPrice(value, cur)}</span>`
}

function fnDetailMovingAverages(s, cur) {
    const ma = (label, sma, ema) =>
        `<div class="fnDetailRow2"><span>${label}</span>${fnMaCell(sma, s.close, cur)}${fnMaCell(ema, s.close, cur)}</div>`

    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Medias móviles", s["Recommend.MA"])}
            <div class="fnDetailRow2 fnDetailHead"><span></span><span>SMA</span><span>EMA</span></div>
            ${ma("20", s.SMA20, s.EMA20)}
            ${ma("50", s.SMA50, s.EMA50)}
            ${ma("100", s.SMA100, s.EMA100)}
            ${ma("200", s.SMA200, s.EMA200)}
            <h5 class="fnDetailSubHead">Otras medias y bandas</h5>
            ${fnDetailLine("Ichimoku (línea base)", fnMaCell(s["Ichimoku.BLine"], s.close, cur))}
            ${fnDetailLine("VWMA (20)", fnMaCell(s.VWMA, s.close, cur))}
            ${fnDetailLine("Hull MA (9)", fnMaCell(s.HullMA9, s.close, cur))}
            ${fnDetailLine("Bollinger superior (20)", fnPrice(s["BB.upper"], cur))}
            ${fnDetailLine("Bollinger inferior (20)", fnPrice(s["BB.lower"], cur))}
        </div>`
}

function fnDetailOscillators(s) {
    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Osciladores", s["Recommend.Other"])}
            ${fnDetailLine("MACD", fnRatio(s["MACD.macd"]))}
            ${fnDetailLine("Señal MACD", fnRatio(s["MACD.signal"]))}
            ${fnDetailLine("ADX", fnRatio(s.ADX))}
            ${fnDetailLine("Estocástico %K", fnRatio(s["Stoch.K"]))}
            ${fnDetailLine("Estocástico %D", fnRatio(s["Stoch.D"]))}
            ${fnDetailLine("Estocástico RSI %K", fnRatio(s["Stoch.RSI.K"]))}
            ${fnDetailLine("CCI (20)", fnRatio(s.CCI20))}
            ${fnDetailLine("Momentum (10)", fnRatio(s.Mom))}
            ${fnDetailLine("Awesome Oscillator", fnRatio(s.AO))}
            ${fnDetailLine("Williams %R (14)", fnRatio(s["W.R"]))}
            ${fnDetailLine("Ultimate Oscillator", fnRatio(s.UO))}
        </div>`
}

// Botones y no <select>: shared-utils convierte cada <select> nuevo en un
// desplegable propio que deja su menú en <body> y dos listeners en document
// sin limpiarlos nunca, y esta tabla se regenera entera a cada tecla del
// buscador con un panel por fila.
function fnPivotChipsHtml(kind, options, selected) {
    const chips = Object.entries(options)
        .map(
            ([value, label]) =>
                `<button type="button" class="fnPivotChip ${value === selected ? "active" : ""}" data-pivot="${kind}" data-value="${value}" aria-pressed="${value === selected}">${label}</button>`
        )
        .join("")
    return `<span class="fnPivotChips" role="group" aria-label="${kind === "method" ? "Método de pivotes" : "Periodo de pivotes"}">${chips}</span>`
}

function fnDetailPivots(s, cur) {
    const suffix = FN_PIVOT_PERIODS[_fnPivotPeriod].suffix
    const periodLabels = Object.fromEntries(Object.entries(FN_PIVOT_PERIODS).map(([k, v]) => [k, v.label]))

    // Solo los niveles que el método publica: DeMark no tiene R2/R3/S2/S3 y
    // pintarlos con "—" haría creer que falta un dato que no existe.
    const lines = FN_PIVOT_LEVELS.map((level) => ({
        level,
        value: s[`Pivot.M.${_fnPivotMethod}.${level}${suffix}`]
    }))
        .filter(({ value }) => fnToNumber(value) !== null)
        .map(({ level, value }) =>
            level === "Middle"
                ? fnDetailLine("P", fnPrice(value, cur), "fnDetailPivotMid")
                : fnDetailLine(level, fnPrice(value, cur))
        )
        .join("")

    return `
        <div class="fnDetailCol">
            <div class="fnDetailColHead">
                <h4>Pivotes</h4>
                ${fnPivotChipsHtml("period", periodLabels, _fnPivotPeriod)}
            </div>
            <div class="fnPivotMethods">${fnPivotChipsHtml("method", FN_PIVOT_METHODS, _fnPivotMethod)}</div>
            ${lines || `<span class="fnNd">Sin pivotes para este activo</span>`}
        </div>`
}

function fnDetailPerformance(s) {
    const perf = (label, value) => {
        const num = fnToNumber(value)
        const cls = num > 0 ? "fnPos" : num < 0 ? "fnNeg" : ""
        return fnDetailLine(label, `<span class="${cls}">${fnPercentSigned(value)}</span>`)
    }

    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Rendimiento")}
            ${perf("1 semana", s["Perf.W"])}
            ${perf("1 mes", s["Perf.1M"])}
            ${perf("3 meses", s["Perf.3M"])}
            ${perf("6 meses", s["Perf.6M"])}
            ${perf("En lo que va de año", s["Perf.YTD"])}
            ${perf("1 año", s["Perf.Y"])}
        </div>`
}

// Distancia del precio a un nivel de referencia: "-28,4 %" bajo un máximo.
function fnDistanceHtml(close, level) {
    const price = fnToNumber(close)
    const ref = fnToNumber(level)
    if (price === null || ref === null || ref === 0) return ""
    return ` <small class="fnDetailSub">${fnPercentSigned((price / ref - 1) * 100, 1)}</small>`
}

function fnDetailRange(s, cur) {
    const level = (value) => fnPrice(value, cur) + fnDistanceHtml(s.close, value)
    const relVol = fnToNumber(s.relative_volume_10d_calc)

    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Rango y volatilidad")}
            ${fnDetailLine("Máximo 52 semanas", level(s.price_52_week_high))}
            ${fnDetailLine("Mínimo 52 semanas", level(s.price_52_week_low))}
            ${fnDetailLine("Máximo histórico", level(s["High.All"]))}
            ${fnDetailLine("ATR (14)", fnPrice(s.ATR, cur))}
            ${fnDetailLine("Volatilidad día / semana / mes", [s["Volatility.D"], s["Volatility.W"], s["Volatility.M"]].map((v) => fnPercentPlain(v)).join(" · "))}
            ${fnDetailLine("Volumen relativo (10 d)", relVol === null ? "—" : `${fnRatio(relVol)} ×`)}
            ${fnDetailLine("Beta (1 año)", fnRatio(s.beta_1_year))}
        </div>`
}

// Solo las líneas con dato: una cripto o una materia prima no tienen márgenes
// ni resultados, y una columna entera de "—" no aporta nada.
function fnDetailFundamentals(s, fallbackCurrency) {
    const fundCur = s.fundamental_currency_code || fallbackCurrency
    const items = [
        ["Margen bruto", s.gross_margin, (v) => fnPercentPlain(v)],
        ["Margen operativo", s.operating_margin, (v) => fnPercentPlain(v)],
        ["Margen neto", s.net_margin, (v) => fnPercentPlain(v)],
        ["Free cash flow (M)", s.free_cash_flow, (v) => fnMarketCap(v, fundCur)],
        ["Valor de empresa (M)", s.enterprise_value_current, (v) => fnMarketCap(v, fundCur)],
        ["EV / EBITDA", s.enterprise_value_ebitda_ttm, (v) => fnRatio(v)],
        ["Próximos resultados", s.earnings_release_next_date, fnUnixDate],
        ["Patrimonio del fondo (M)", s.aum, (v) => fnMarketCap(v, fundCur)],
        ["Gastos corrientes (TER)", s.expense_ratio, (v) => fnPercentPlain(v)]
    ]
    const lines = items
        .filter(([, value]) => fnToNumber(value) !== null)
        .map(([label, value, format]) => fnDetailLine(label, format(value)))
        .join("")

    return `
        <div class="fnDetailCol">
            ${fnDetailColHead("Fundamentales ampliados")}
            ${lines || `<span class="fnNd">Sin datos fundamentales para este tipo de activo</span>`}
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

// Número del scanner o null si no hay dato: `None` en Python llega como null,
// y un 0 legítimo (variación nula) no debe confundirse con "sin dato".
function fnToNumber(value) {
    if (value === null || value === undefined || value === "") return null
    const num = typeof value === "number" ? value : parseFloat(value)
    return isNaN(num) ? null : num
}

// El scanner da las fechas de resultados en segundos Unix.
function fnUnixDate(value) {
    const seconds = fnToNumber(value)
    if (seconds === null) return "—"
    return new Date(seconds * 1000).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" })
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
    return (
        (num / 1e6).toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 0 }) +
        " " +
        currencySuffix(currency)
    )
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
    return (
        sign + num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + " %"
    )
}
