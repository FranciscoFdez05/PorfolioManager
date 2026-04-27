let _metricasCharts = {}

window._resizeChartsOnSidebarChange = function () {
    Object.values(_metricasCharts).forEach((c) => { try { c.resize() } catch (_) {} })
}

let _metricasDisplayType = "doughnut"
let _metricasDistMetric = "netoActualEur"
let _metricasGastosMonth = "all"
let _metricasIngresosMonth = "all"
let _metricasPayload = null
let _metricasSortKey = "netoActualEur"
let _metricasSortDir = "desc"
let _metricasActivosFilter = new Set(["cripto","acciones","etfs","comoditis","bonos","rentaFija"])
let _metricasGastosTipoFilter = new Set()
let _metricasComparativaExclude = new Set()
let _mGastosChartsCache = null

const M_GASTOS_KEYS   = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"]
const M_GASTOS_LABELS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]

const M_PALETTE = [
    "#3a7bd5", "#f7931a", "#2ecc71", "#e74c3c", "#9b59b6",
    "#1abc9c", "#e67e22", "#00bcd4", "#8bc34a", "#ff5722",
    "#e91e63", "#673ab7", "#607d8b", "#f39c12", "#795548",
    "#26c6da", "#66bb6a", "#ef5350", "#ab47bc", "#ffa726"
]

const M_TYPE_COLORS = {
    cripto:    "#f7931a",
    acciones:  "#3a7bd5",
    etfs:      "#2ecc71",
    comoditis: "#e0c068"
}

const M_TYPE_LABELS = {
    cripto:    "Cripto",
    acciones:  "Acciones",
    etfs:      "ETFs",
    comoditis: "Comoditis"
}

const M_CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 400 },
    plugins: {
        legend: {
            labels: { color: "#ccd6f6", font: { size: 12 }, padding: 14, boxWidth: 14 }
        }
    }
}

// ── helpers ────────────────────────────────────────────────────────────────

function mDestroyChart(id) {
    if (_metricasCharts[id]) {
        _metricasCharts[id].destroy()
        delete _metricasCharts[id]
    }
}

function mCreateChart(id, config) {
    const canvas = document.getElementById(id)
    if (!canvas) return
    mDestroyChart(id)
    _metricasCharts[id] = new Chart(canvas, config)
}

function mSetKpi(id, value, cls = "") {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = value
    el.className = "mkpiValue" + (cls ? " " + cls : "")
}

function mGridTooltip(label, raw, total) {
    const pct = total > 0 ? ((raw / total) * 100).toFixed(1) : "0.0"
    return ` ${formatEuro(raw)}  (${pct} %)`
}

function mAxisX() {
    return {
        ticks: { color: "#8899bb" },
        grid:  { color: "rgba(255,255,255,0.06)" }
    }
}
function mAxisY(fontSize = 12) {
    return {
        ticks: { color: "#ccd6f6", font: { size: fontSize } },
        grid:  { display: false }
    }
}

// ── data fetching ──────────────────────────────────────────────────────────

async function buildMetricasPayload() {
    const baseAssets = await loadAssetsList()
    const fullAssets = await Promise.all(baseAssets.map((a) => loadAssetData(a.id)))

    const summaries = await Promise.all(fullAssets.map(async (asset) => {
        const row    = await buildOverviewRow(asset)
        const euros  = await buildSummaryMetricsInEuros(row)
        return {
            name:           asset.name || asset.symbol || "Activo",
            type:           asset.type || "acciones",
            netoActualEur:  euros.netoActualEur,
            invertidoEur:   euros.invertidoNetoEur,
            rendimientoEur: euros.rendimientoEur
        }
    }))

    const [divResp, intResp, bonosResp, rfResp, gastosYearsResp, ingresosYearsResp] = await Promise.all([
        fetch("/api/dividendos"),
        fetch("/api/intereses"),
        fetch("/api/bonos"),
        fetch("/api/rentafija"),
        fetch("/api/gastos").catch(() => null),
        fetch("/api/ingresos").catch(() => null)
    ])
    const divData   = await divResp.json()
    const intData   = await intResp.json()
    const bonosData = await bonosResp.json()
    const rfData    = await rfResp.json()

    const gastosYearsData = gastosYearsResp ? await gastosYearsResp.json().catch(() => ({ years: [] })) : { years: [] }
    const gastosYearsList = Array.isArray(gastosYearsData.years) ? gastosYearsData.years : []
    const latestYear      = gastosYearsList[0] || null
    const gastosYearData  = latestYear
        ? await fetch(`/api/gastos/${latestYear}`).then((r) => r.json()).catch(() => null)
        : null

    const ingresosYearsData = ingresosYearsResp ? await ingresosYearsResp.json().catch(() => ({ years: [] })) : { years: [] }
    const ingresosYearsList = Array.isArray(ingresosYearsData.years) ? ingresosYearsData.years : []
    const latestIngresosYear = ingresosYearsList[0] || null
    const ingresosYearData  = latestIngresosYear
        ? await fetch(`/api/ingresos/${latestIngresosYear}`).then((r) => r.json()).catch(() => null)
        : null

    return {
        summaries,
        dividendos:      Array.isArray(divData.rows)   ? divData.rows   : [],
        intereses:       Array.isArray(intData.rows)    ? intData.rows   : [],
        bonos:           Array.isArray(bonosData.rows)  ? bonosData.rows : [],
        rentaFija:       Array.isArray(rfData.rows)     ? rfData.rows    : [],
        gastosYearsList,
        gastosYearData,
        ingresosYearsList,
        ingresosYearData
    }
}

// ── KPI cards ──────────────────────────────────────────────────────────────

function mSyncTopBar(summaries, rendimiento, invertido, totalCuenta) {
    const topSet = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
    topSet("topTotalCuenta",       formatEuro(totalCuenta))
    topSet("topRendimientoEuros",  formatEuro(rendimiento))
    topSet("topPorcentajeCuenta",  formatPercent(invertido > 0 ? (rendimiento / invertido) * 100 : 0))

    const typeMap = { cripto: "Cripto", acciones: "Acciones", etfs: "Etf", comoditis: "Comoditis" }
    Object.entries(typeMap).forEach(([type, suffix]) => {
        const group = summaries.filter((a) => a.type === type)
        const neto  = group.reduce((s, a) => s + a.netoActualEur, 0)
        const inv   = group.reduce((s, a) => s + a.invertidoEur, 0)
        const rend  = group.reduce((s, a) => s + a.rendimientoEur, 0)
        topSet(`topEuros${suffix}`,      formatEuro(neto))
        topSet(`topPorcentaje${suffix}`, formatPercent(inv > 0 ? (rend / inv) * 100 : 0))
    })
}

function mUpdateKpis(payload) {
    const { summaries, dividendos, intereses, bonos, rentaFija } = payload

    const totalCuenta  = summaries.reduce((s, a) => s + a.netoActualEur,  0)
    const invertido    = summaries.reduce((s, a) => s + a.invertidoEur,   0)
    const rendimiento  = totalCuenta - invertido
    const rendPct      = invertido > 0 ? (rendimiento / invertido) * 100 : 0
    const totalDiv     = dividendos.reduce((s, r) => s + parseEuroNumber(r.total || ""), 0)
    const totalInt     = intereses.reduce((s, r) =>
        s + parseEuroNumber(r.acumulado || "") - parseEuroNumber(r.impuestos || ""), 0)

    mSetKpi("mkpiTotalCuenta", formatEuro(totalCuenta))
    mSetKpi("mkpiInvertido",   formatEuro(invertido))
    mSetKpi("mkpiRendimiento", formatEuro(rendimiento), rendimiento >= 0 ? "mPositive" : "mNegative")
    mSetKpi("mkpiRendPct",     formatPercent(rendPct),  rendPct      >= 0 ? "mPositive" : "mNegative")

    mSyncTopBar(summaries, rendimiento, invertido, totalCuenta)
    const bonosRows   = Array.isArray(bonos) ? bonos : []
    const bonosNeto   = bonosRows.reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const bonosGub    = bonosRows.filter((r) => r.tipo === "gubernamental")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const bonosCorp   = bonosRows.filter((r) => r.tipo === "corporativo")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)

    mSetKpi("mkpiDividendos",  formatEuro(totalDiv))
    mSetKpi("mkpiInteres",     formatEuro(totalInt))
    mSetKpi("mkpiBonos",       formatEuro(bonosNeto))
    mSetKpi("mkpiBonosGub",    formatEuro(bonosGub))
    mSetKpi("mkpiBonosCorp",   formatEuro(bonosCorp))

    const rfRows     = Array.isArray(rentaFija) ? rentaFija : []
    const rfNeto     = rfRows.reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const rfBancario = rfRows.filter((r) => r.tipo === "bancario")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const rfEstatal  = rfRows.filter((r) => r.tipo === "estatal")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)

    mSetKpi("mkpiRentaFija",   formatEuro(rfNeto))
    mSetKpi("mkpiRfBancario",  formatEuro(rfBancario))
    mSetKpi("mkpiRfEstatal",   formatEuro(rfEstatal))

    const topSet2 = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
    topSet2("topTotalDividendos", formatEuro(totalDiv))
    topSet2("topTotalInteres",    formatEuro(totalInt))
    topSet2("topTotalBonos",      formatEuro(bonosNeto))
    topSet2("topTotalRentaFija",  formatEuro(rfNeto))
}

// ── charts ─────────────────────────────────────────────────────────────────

function mDistMetricLabel(metric) {
    if (metric === "rendimientoEur") return "Rendimiento (€)"
    if (metric === "invertidoEur")   return "Invertido (€)"
    return "Valor actual (€)"
}

function mDistAssetVal(a, metric) {
    return metric === "rendimientoEur" ? a.rendimientoEur
         : metric === "invertidoEur"   ? a.invertidoEur
         : a.netoActualEur
}

function mDistBonoVal(r, metric) {
    return metric === "rendimientoEur"
        ? parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || "")
        : parseEuroNumber(r.invertido || "")
}

function mRenderDistTipos(summaries, displayType, bonos = [], rentaFija = [], metric = "netoActualEur") {
    const types  = ["cripto", "acciones", "etfs", "comoditis"]
    const bonosTotal = bonos.reduce((s, r) => s + mDistBonoVal(r, metric), 0)
    const rfTotal    = rentaFija.reduce((s, r) => s + mDistBonoVal(r, metric), 0)
    const labels = [...types.map((t) => M_TYPE_LABELS[t]), "Bonos", "Renta Fija"]
    const rawValues = [
        ...types.map((t) => summaries.filter((a) => a.type === t).reduce((s, a) => s + mDistAssetVal(a, metric), 0)),
        bonosTotal,
        rfTotal
    ]
    const colors = [...types.map((t) => M_TYPE_COLORS[t]), "#9b59b6", "#00bcd4"]

    if (displayType === "doughnut") {
        const values = rawValues.map((v) => Math.max(0, v))
        const total  = values.reduce((a, b) => a + b, 0)
        mCreateChart("mChartTipos", {
            type: "doughnut",
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: colors,
                    borderColor: "#0b1120",
                    borderWidth: 3,
                    hoverOffset: 10
                }]
            },
            options: {
                ...M_CHART_DEFAULTS,
                cutout: "62%",
                plugins: {
                    ...M_CHART_DEFAULTS.plugins,
                    legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                    tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, total) } }
                }
            }
        })
    } else {
        const total = rawValues.reduce((a, b) => a + Math.abs(b), 0)
        mCreateChart("mChartTipos", {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: mDistMetricLabel(metric),
                    data: rawValues,
                    backgroundColor: colors.map((c) => c + "cc"),
                    borderColor: colors,
                    borderWidth: 1,
                    borderRadius: 6
                }]
            },
            options: {
                ...M_CHART_DEFAULTS,
                indexAxis: "y",
                plugins: {
                    ...M_CHART_DEFAULTS.plugins,
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
                },
                scales: { x: mAxisX(), y: mAxisY() }
            }
        })
    }
}

function mRenderDistActivos(summaries, displayType, bonos = [], rentaFija = [], metric = "netoActualEur") {
    const bonosMap = {}
    if (_metricasActivosFilter.has("bonos")) {
        bonos.forEach((r) => {
            const name = r.instrumento || "Bono"
            bonosMap[name] = (bonosMap[name] || 0) + mDistBonoVal(r, metric)
        })
    }
    const rfMap = {}
    if (_metricasActivosFilter.has("rentaFija")) {
        rentaFija.forEach((r) => {
            const name = r.instrumento || "Renta Fija"
            rfMap[name] = (rfMap[name] || 0) + mDistBonoVal(r, metric)
        })
    }
    const extras = [
        ...Object.entries(bonosMap).map(([name, val]) => ({ name, _val: val })),
        ...Object.entries(rfMap).map(([name, val]) => ({ name, _val: val }))
    ]
    const allItems = [
        ...summaries.filter((a) => _metricasActivosFilter.has(a.type)).map((a) => ({ name: a.name, _val: mDistAssetVal(a, metric) })),
        ...extras
    ].sort((a, b) => b._val - a._val)

    const labels = allItems.map((a) => a.name)
    const rawValues = allItems.map((a) => a._val)
    const colors = labels.map((_, i) => M_PALETTE[i % M_PALETTE.length])

    if (displayType === "doughnut") {
        const values = rawValues.map((v) => Math.max(0, v))
        const total  = values.reduce((a, b) => a + b, 0)
        mCreateChart("mChartActivos", {
            type: "doughnut",
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: colors,
                    borderColor: "#0b1120",
                    borderWidth: 2,
                    hoverOffset: 10
                }]
            },
            options: {
                ...M_CHART_DEFAULTS,
                cutout: "55%",
                plugins: {
                    ...M_CHART_DEFAULTS.plugins,
                    legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "right" },
                    tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, total) } }
                }
            }
        })
    } else {
        mCreateChart("mChartActivos", {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: mDistMetricLabel(metric),
                    data: rawValues,
                    backgroundColor: colors.map((c) => c + "bb"),
                    borderColor: colors,
                    borderWidth: 1,
                    borderRadius: 4
                }]
            },
            options: {
                ...M_CHART_DEFAULTS,
                indexAxis: "y",
                plugins: {
                    ...M_CHART_DEFAULTS.plugins,
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
                },
                scales: { x: mAxisX(), y: mAxisY(11) }
            }
        })
    }
}

function mRenderRendTipos(summaries) {
    const types  = ["cripto", "acciones", "etfs", "comoditis"]
    const pairs  = types.map((t) => ({
        label: M_TYPE_LABELS[t],
        value: summaries.filter((a) => a.type === t).reduce((s, a) => s + a.rendimientoEur, 0)
    })).sort((a, b) => b.value - a.value)
    const labels = pairs.map((p) => p.label)
    const values = pairs.map((p) => p.value)
    const colors = values.map((v) => (v >= 0 ? "#2ecc71cc" : "#e74c3ccc"))
    const borders = values.map((v) => (v >= 0 ? "#2ecc71" : "#e74c3c"))

    mCreateChart("mChartRendTipos", {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Rendimiento (€)",
                data: values,
                backgroundColor: colors,
                borderColor: borders,
                borderWidth: 1,
                borderRadius: 6
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: {
                x: { ...mAxisX(), ticks: { ...mAxisX().ticks, callback: (v) => formatEuro(v) } },
                y: mAxisY()
            }
        }
    })
}

function mRenderRendActivos(summaries) {
    const sorted = [...summaries].sort((a, b) => b.rendimientoEur - a.rendimientoEur)
    const labels = sorted.map((a) => a.name)
    const values = sorted.map((a) => a.rendimientoEur)
    const colors = values.map((v) => (v >= 0 ? "#2ecc71cc" : "#e74c3ccc"))
    const borders = values.map((v) => (v >= 0 ? "#2ecc71" : "#e74c3c"))

    const wrap = document.getElementById("mChartRendActivosWrap")
    if (wrap) wrap.style.height = Math.max(200, sorted.length * 32 + 40) + "px"

    mCreateChart("mChartRendActivos", {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Rendimiento (€)",
                data: values,
                backgroundColor: colors,
                borderColor: borders,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: {
                x: { ...mAxisX(), ticks: { ...mAxisX().ticks, callback: (v) => formatEuro(v) } },
                y: mAxisY(11)
            }
        }
    })
}

function mRenderDividendos(dividendos) {
    const section = document.getElementById("mSectionDividendos")
    if (!dividendos.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const map = {}
    dividendos.forEach((r) => {
        const name = r.instrumento || "Desconocido"
        map[name] = (map[name] || 0) + parseEuroNumber(r.total || "")
    })

    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1])
    const labels = sorted.map(([name]) => name)
    const values = sorted.map(([, v]) => v)
    const colors = labels.map((_, i) => M_PALETTE[i % M_PALETTE.length])

    const wrap = document.getElementById("mChartDivWrap")
    if (wrap) wrap.style.height = Math.max(180, sorted.length * 36 + 40) + "px"

    mCreateChart("mChartDividendos", {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Dividendos (€)",
                data: values,
                backgroundColor: colors.map((c) => c + "bb"),
                borderColor: colors,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: mAxisY(12) }
        }
    })

    const donutTotal = values.reduce((a, b) => a + b, 0)
    mCreateChart("mChartDividendosDonut", {
        type: "doughnut",
        data: { labels, datasets: [{ data: values, backgroundColor: colors, borderColor: "#0b1120", borderWidth: 2, hoverOffset: 10 }] },
        options: {
            ...M_CHART_DEFAULTS, cutout: "55%",
            plugins: { ...M_CHART_DEFAULTS.plugins, legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" }, tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, donutTotal) } } }
        }
    })
}

// ── dividendos mensuales ───────────────────────────────────────────────────

let _metricasDivMensualYear = null

function mRenderDivMensual(dividendos) {
    const section = document.getElementById("mSectionDivMensual")
    const rows = Array.isArray(dividendos) ? dividendos : []
    if (!rows.length) { if (section) section.classList.add("hidden"); return }
    if (section) section.classList.remove("hidden")

    function dYear(fecha) { const p = String(fecha || "").split("-"); return p.length === 3 ? p[2] : null }
    function dMonth(fecha) { const p = String(fecha || "").split("-"); return p.length === 3 ? parseInt(p[1]) - 1 : -1 }

    const years = [...new Set(rows.map(r => dYear(r.fecha)).filter(Boolean))]
        .sort((a, b) => Number(a) - Number(b))

    if (!_metricasDivMensualYear || !years.includes(_metricasDivMensualYear))
        _metricasDivMensualYear = years[years.length - 1] || null

    const yearToggle = document.getElementById("mDivMensualYearToggle")
    if (yearToggle) {
        yearToggle.innerHTML = years.map(y =>
            `<button class="mToggleBtn${y === _metricasDivMensualYear ? " active" : ""}" data-divmy="${y}">${y}</button>`
        ).join("")
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-divmy]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach(b => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDivMensualYear = btn.dataset.divmy
                mDrawDivMensualChart(rows, _metricasDivMensualYear, dYear, dMonth)
            })
        }
    }

    mDrawDivMensualChart(rows, _metricasDivMensualYear, dYear, dMonth)
}

function mDrawDivMensualChart(rows, year, dYear, dMonth) {
    const yearRows = rows.filter(r => dYear(r.fecha) === year)
    const stocks = [...new Set(yearRows.map(r => r.instrumento || "Desconocido"))].sort()

    const monthData = {}
    stocks.forEach(s => { monthData[s] = Array(12).fill(0) })
    yearRows.forEach(r => {
        const m = dMonth(r.fecha)
        if (m < 0 || m > 11) return
        const name = r.instrumento || "Desconocido"
        monthData[name][m] += parseEuroNumber(r.total || "")
    })

    const labels = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    const stockColors = stocks.map((_, i) => M_PALETTE[i % M_PALETTE.length])
    const datasets = stocks.map((s, i) => ({
        label: s,
        data: monthData[s],
        backgroundColor: "transparent",
        borderWidth: 0,
        stack: "div",
        _color: stockColors[i]
    }))

    function drawRoundRect(ctx, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2)
        ctx.beginPath()
        ctx.moveTo(x + r, y)
        ctx.lineTo(x + w - r, y)
        ctx.quadraticCurveTo(x + w, y, x + w, y + r)
        ctx.lineTo(x + w, y + h - r)
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
        ctx.lineTo(x + r, y + h)
        ctx.quadraticCurveTo(x, y + h, x, y + h - r)
        ctx.lineTo(x, y + r)
        ctx.quadraticCurveTo(x, y, x + r, y)
        ctx.closePath()
    }

    const SEG_GAP = 2

    const divLabelPlugin = {
        id: "divMensualLabels",
        afterDatasetsDraw(chart) {
            const ctx = chart.ctx
            ctx.save()

            // Clip to plot area only
            const { top, bottom, left, right } = chart.chartArea
            ctx.beginPath()
            ctx.rect(left, top, right - left, bottom - top)
            ctx.clip()

            chart.data.datasets.forEach((dataset, di) => {
                const meta = chart.getDatasetMeta(di)
                if (meta.hidden) return
                const color = dataset._color || "#888"

                meta.data.forEach((bar, j) => {
                    const val = dataset.data[j]
                    if (!val || val <= 0) return

                    const rawH = Math.abs(bar.height)
                    const barW = bar.width || 40
                    const segTop = Math.min(bar.y, bar.base)
                    const w  = barW - 2
                    const x  = bar.x - barW / 2 + 1
                    const dY = segTop + SEG_GAP
                    const dH = Math.max(rawH - SEG_GAP - 1, 2)

                    ctx.fillStyle = color + "ee"
                    drawRoundRect(ctx, x, dY, w, dH, 5)
                    ctx.fill()

                    if (dH < 14) return
                    const fontSize = dH >= 40 ? 12 : dH >= 26 ? 10 : 8
                    ctx.font = `bold ${fontSize}px sans-serif`
                    ctx.textAlign = "center"
                    ctx.textBaseline = "middle"

                    const maxW = w - 8
                    let txt = dataset.label
                    if (ctx.measureText(txt).width > maxW) {
                        txt = dataset.label.split(/[\s&]+/)[0]
                        if (ctx.measureText(txt).width > maxW) {
                            while (txt.length > 2 && ctx.measureText(txt + "…").width > maxW)
                                txt = txt.slice(0, -1)
                            txt += "…"
                        }
                    }

                    ctx.shadowColor = "rgba(0,0,0,0.8)"
                    ctx.shadowBlur   = 4
                    ctx.fillStyle    = "#ffffff"
                    ctx.fillText(txt, bar.x, dY + dH / 2)
                    ctx.shadowBlur   = 0
                })
            })

            ctx.restore()
        }
    }

    // Register custom tooltip positioner centered on each bar segment
    if (window.Chart && !Chart.Tooltip.positioners.segCenter) {
        Chart.Tooltip.positioners.segCenter = function(elements, eventPos) {
            if (!elements.length) return false
            const el = elements[0].element
            const cx = el.x
            const cy = (el.y + el.base) / 2
            // Place tooltip to the right of the bar, vertically centered
            const barRight = cx + (el.width || 40) / 2
            return { x: barRight, y: cy }
        }
    }

    mCreateChart("mChartDivMensual", {
        type: "bar",
        data: { labels, datasets },
        plugins: [divLabelPlugin],
        options: {
            ...M_CHART_DEFAULTS,
            scales: {
                x: { ...mAxisX(), stacked: true },
                y: {
                    stacked: true,
                    ticks: { color: "#ccd6f6", callback: v => formatEuro(v) },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: {
                    position: "top",
                    labels: {
                        color: "#ffffff", font: { size: 11 }, padding: 12, boxWidth: 12,
                        generateLabels(chart) {
                            return chart.data.datasets.map((ds, i) => ({
                                text: ds.label,
                                fillStyle: (ds._color || "#888") + "ee",
                                strokeStyle: ds._color || "#888",
                                fontColor: "#ffffff",
                                lineWidth: 1,
                                hidden: chart.getDatasetMeta(i).hidden,
                                datasetIndex: i
                            }))
                        }
                    }
                },
                tooltip: {
                    position: "segCenter",
                    xAlign: "left",
                    yAlign: "center",
                    callbacks: {
                        label: (c) => c.raw > 0 ? ` ${c.dataset.label}: ${formatEuro(c.raw)}` : null,
                        labelColor: (c) => ({
                            borderColor: c.dataset._color || "#888",
                            backgroundColor: (c.dataset._color || "#888") + "ee"
                        }),
                        footer: (items) => {
                            const total = items.filter(i => i.raw > 0).reduce((s, i) => s + i.raw, 0)
                            return total > 0 ? [`Total mes: ${formatEuro(total)}`] : []
                        }
                    }
                }
            },
            barPercentage: 0.75,
            categoryPercentage: 0.8
        }
    })
}

// ── bonos charts ───────────────────────────────────────────────────────────

function mRenderBonosTipos(bonos) {
    const section = document.getElementById("mSectionBonos")
    if (!bonos.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const GUB_COLOR  = "#9b59b6"
    const CORP_COLOR = "#c39bd3"

    const gubNeto  = bonos.filter((r) => r.tipo === "gubernamental")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const corpNeto = bonos.filter((r) => r.tipo === "corporativo")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const total = gubNeto + corpNeto

    mCreateChart("mChartBonosTipos", {
        type: "doughnut",
        data: {
            labels: ["Gubernamentales", "Corporativos"],
            datasets: [{
                data: [Math.max(0, gubNeto), Math.max(0, corpNeto)],
                backgroundColor: [GUB_COLOR + "cc", CORP_COLOR + "cc"],
                borderColor: "#0b1120",
                borderWidth: 3,
                hoverOffset: 10
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "60%",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, total) } }
            }
        }
    })
}

function mRenderBonosInst(bonos) {
    if (!bonos.length) return

    const map = {}
    bonos.forEach((r) => {
        const name = r.instrumento || "Sin nombre"
        const neto = parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || "")
        map[name] = (map[name] || 0) + neto
    })

    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1])
    const labels = sorted.map(([name]) => name)
    const values = sorted.map(([, v]) => v)
    const colors = values.map((v) => v >= 0 ? "#9b59b6bb" : "#e74c3cbb")
    const borders = values.map((v) => v >= 0 ? "#9b59b6" : "#e74c3c")

    const wrap = document.getElementById("mChartBonosInstWrap")
    if (wrap) wrap.style.height = Math.max(180, sorted.length * 36 + 40) + "px"

    mCreateChart("mChartBonosInst", {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Interés neto (€)",
                data: values,
                backgroundColor: colors,
                borderColor: borders,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: mAxisY(12) }
        }
    })
}

// ── renta fija charts ──────────────────────────────────────────────────────

function mRenderRentaFijaTipos(rentaFija) {
    const section = document.getElementById("mSectionRentaFija")
    if (!rentaFija.length) { if (section) section.classList.add("hidden"); return }
    if (section) section.classList.remove("hidden")

    const bancarioNeto = rentaFija.filter((r) => r.tipo === "bancario")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const estatalNeto  = rentaFija.filter((r) => r.tipo === "estatal")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const total = bancarioNeto + estatalNeto

    mCreateChart("mChartRfTipos", {
        type: "doughnut",
        data: {
            labels: ["Bancario", "Estatal"],
            datasets: [{
                data: [Math.max(0, bancarioNeto), Math.max(0, estatalNeto)],
                backgroundColor: ["#00bcd4cc", "#8bc34acc"],
                borderColor: "#0b1120",
                borderWidth: 3,
                hoverOffset: 10
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "60%",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, total) } }
            }
        }
    })
}

function mRenderRentaFijaInst(rentaFija) {
    if (!rentaFija.length) return
    const map = {}
    rentaFija.forEach((r) => {
        const name = r.instrumento || "Sin nombre"
        const neto = parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || "")
        map[name] = (map[name] || 0) + neto
    })
    const sorted  = Object.entries(map).sort((a, b) => b[1] - a[1])
    const labels  = sorted.map(([name]) => name)
    const values  = sorted.map(([, v]) => v)
    const colors  = values.map((v) => v >= 0 ? "#00bcd4bb" : "#e74c3cbb")
    const borders = values.map((v) => v >= 0 ? "#00bcd4" : "#e74c3c")

    const wrap = document.getElementById("mChartRfInstWrap")
    if (wrap) wrap.style.height = Math.max(180, sorted.length * 36 + 40) + "px"

    mCreateChart("mChartRfInst", {
        type: "bar",
        data: {
            labels,
            datasets: [{
                label: "Interés neto (€)",
                data: values,
                backgroundColor: colors,
                borderColor: borders,
                borderWidth: 1,
                borderRadius: 4
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: mAxisY(12) }
        }
    })
}

// ── gastos ─────────────────────────────────────────────────────────────────

function mComputeGastosData(yearData) {
    const totalMes = Object.fromEntries(M_GASTOS_KEYS.map((k) => [k, 0]))
    const totalTipo = {}
    let totalMensualidades = 0
    let totalMovimientos = 0

    ;(yearData?.mensualidades || []).forEach((m) => {
        M_GASTOS_KEYS.forEach((k) => {
            const val = parseEuroNumber(m.meses?.[k] || "")
            totalMes[k] += val
            totalMensualidades += val
            if (val > 0) totalTipo["Mensualidades"] = (totalTipo["Mensualidades"] || 0) + val
        })
    })

    Object.entries(yearData?.months || {}).forEach(([monthKey, monthData]) => {
        ;(monthData?.rows || []).forEach((row) => {
            const val = parseEuroNumber(row.cantidad || "")
            totalMes[monthKey] = (totalMes[monthKey] || 0) + val
            totalMovimientos += val
            const tipo = (row.tipo || "Sin tipo").trim()
            totalTipo[tipo] = (totalTipo[tipo] || 0) + val
        })
    })

    return { totalMes, totalTipo, totalMensualidades, totalMovimientos }
}

function mRenderGastos(yearsList, yearData) {
    const section = document.getElementById("mSectionGastos")
    if (!yearsList.length || !yearData) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const { totalMes, totalTipo, totalMensualidades, totalMovimientos } = mComputeGastosData(yearData)
    const totalGeneral = totalMensualidades + totalMovimientos

    mSetKpi("mkpiGastosTotal",         formatEuro(totalGeneral))
    mSetKpi("mkpiGastosMensualidades", formatEuro(totalMensualidades))
    mSetKpi("mkpiGastosMovimientos",   formatEuro(totalMovimientos))

    // Year toggle
    const yearToggle = document.getElementById("mGastosYearToggle")
    if (yearToggle) {
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.innerHTML = yearsList.map((y) =>
                `<button class="mToggleBtn${String(y) === String(yearData.year) ? " active" : ""}" data-gastosyear="${y}">${y}</button>`
            ).join("")
            yearToggle.addEventListener("click", async (e) => {
                const btn = e.target.closest("[data-gastosyear]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasGastosMonth = "all"
                const newData = await fetch(`/api/gastos/${btn.dataset.gastosyear}`).then((r) => r.json()).catch(() => null)
                if (newData) {
                    _metricasPayload.gastosYearData = newData
                    const monthToggle = document.getElementById("mGastosMonthToggle")
                    if (monthToggle) { monthToggle.dataset.bound = ""; monthToggle.innerHTML = "" }
                    mRenderGastos(yearsList, newData)
                    mRenderComparativa(_metricasPayload.ingresosYearData, newData)
                }
            })
        } else {
            yearToggle.querySelectorAll(".mToggleBtn").forEach((b) =>
                b.classList.toggle("active", b.dataset.gastosyear === String(yearData.year))
            )
        }
    }

    // Month toggle
    const monthToggle = document.getElementById("mGastosMonthToggle")
    if (monthToggle && !monthToggle.dataset.bound) {
        monthToggle.dataset.bound = "true"
        const allBtn = `<button class="mToggleBtn${_metricasGastosMonth === "all" ? " active" : ""}" data-gastosmonth="all">Todos</button>`
        const monthBtns = M_GASTOS_KEYS.map((k, i) =>
            `<button class="mToggleBtn${_metricasGastosMonth === k ? " active" : ""}" data-gastosmonth="${k}">${M_GASTOS_LABELS[i]}</button>`
        ).join("")
        monthToggle.innerHTML = allBtn + monthBtns
        monthToggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-gastosmonth]")
            if (!btn) return
            monthToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasGastosMonth = btn.dataset.gastosmonth
            mRenderGastosCharts(yearData, totalMes, totalTipo)
        })
    } else if (monthToggle) {
        monthToggle.querySelectorAll(".mToggleBtn").forEach((b) =>
            b.classList.toggle("active", b.dataset.gastosmonth === _metricasGastosMonth)
        )
    }

    mRenderGastosCharts(yearData, totalMes, totalTipo)
}


function mRenderGastosCharts(yearData, totalMes, totalTipo) {
    _mGastosChartsCache = { yearData, totalMes, totalTipo }
    const mesTitle  = document.getElementById("mGastosMesTitle")
    const tipoTitle = document.getElementById("mGastosTipoTitle")
    const mesWrap   = document.getElementById("mChartGastosMesWrap")

    // Left chart: always annual monthly totals, fixed label
    if (mesTitle)  mesTitle.textContent = "Tabla Gastos"
    if (mesWrap)   mesWrap.style.height = "300px"

    const mesValues = M_GASTOS_KEYS.map((k) => totalMes[k] || 0)
    const mesColors = M_GASTOS_LABELS.map((_, i) => M_PALETTE[i % M_PALETTE.length])
    mCreateChart("mChartGastosMes", {
        type: "bar",
        data: {
            labels: M_GASTOS_LABELS,
            datasets: [{ label: "Gastos (€)", data: mesValues, backgroundColor: mesColors.map((c) => c + "bb"), borderColor: mesColors, borderWidth: 1, borderRadius: 4 }]
        },
        options: {
            ...M_CHART_DEFAULTS, indexAxis: "y",
            plugins: { ...M_CHART_DEFAULTS.plugins, legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } } },
            scales: { x: mAxisX(), y: mAxisY(11) }
        }
    })

    mRenderGastosTiposKpi(totalTipo)

    // Right chart: by month selection
    if (_metricasGastosMonth === "all") {
        if (tipoTitle) tipoTitle.textContent = "Por tipo (anual)"
        mRenderGastosTipoChart(totalTipo)
    } else {
        const monthIdx  = M_GASTOS_KEYS.indexOf(_metricasGastosMonth)
        const monthName = M_GASTOS_LABELS[monthIdx] || _metricasGastosMonth
        if (tipoTitle) tipoTitle.textContent = `Por tipo — ${monthName}`

        const monthTipo = {}
        ;(yearData?.months?.[_metricasGastosMonth]?.rows || []).forEach((r) => {
            const val  = parseEuroNumber(r.cantidad || "")
            const tipo = (r.tipo || "Sin tipo").trim()
            if (val > 0) monthTipo[tipo] = (monthTipo[tipo] || 0) + val
        })
        const mensTotal = (yearData?.mensualidades || []).reduce((s, m) => s + parseEuroNumber(m.meses?.[_metricasGastosMonth] || ""), 0)
        if (mensTotal > 0) monthTipo["Mensualidades"] = (monthTipo["Mensualidades"] || 0) + mensTotal

        mRenderGastosTipoChart(monthTipo)
    }
}

const M_GASTOS_TIPO_PALETTE = [
    "#e74c3c",  // rojo
    "#3498db",  // azul claro
    "#2ecc71",  // verde
    "#f1c40f",  // amarillo
    "#9b59b6",  // morado
    "#ff6b35",  // naranja
    "#1abc9c",  // turquesa
    "#e91e63",  // rosa/magenta
    "#00bcd4",  // cyan
    "#8bc34a",  // verde lima
    "#1a5276",  // azul oscuro
    "#a04000",  // marrón naranja
]

const M_GASTOS_TIPO_FIXED = {
    "compras":        "#00bcd4",
    "mensualidades":  "#3498db",
    "comidas/cenas":  "#2ecc71",
    "comidas":        "#2ecc71",
    "gasoil":         "#ff6b35",
    "otros":          "#9b59b6",
    "cafe":           "#795548",
    "café":           "#795548",
}

function mGastosTipoColor(label) {
    const key = String(label).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    if (M_GASTOS_TIPO_FIXED[key]) return M_GASTOS_TIPO_FIXED[key]
    let hash = 0
    for (let i = 0; i < label.length; i++) hash = (hash * 31 + label.charCodeAt(i)) & 0xfffff
    return M_GASTOS_TIPO_PALETTE[hash % M_GASTOS_TIPO_PALETTE.length]
}

function mNormTipo(s) {
    return String(s || "").trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
}

function mRenderGastosTiposKpi(totalTipo) {
    const container = document.getElementById("mkpiGastosTiposCards")
    const group = document.getElementById("mkpiGroupGastosTipos")
    if (!container || !group) return

    const hidden = window._gastosHiddenTipos || []
    const entries = Object.entries(totalTipo || {})
        .filter(([tipo, v]) => v > 0 && !hidden.includes(mNormTipo(tipo)))
        .sort((a, b) => b[1] - a[1])

    if (!entries.length) { group.classList.add("hidden"); return }
    group.classList.remove("hidden")
    container.innerHTML = entries.map(([tipo, val]) =>
        `<div class="metricasKpiCard"><div class="mkpiLabel">${escapeMetricasHtml(tipo)}</div><div class="mkpiValue">${formatEuro(val)}</div></div>`
    ).join("")
}

function escapeMetricasHtml(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
}

function mRenderGastosTipoChart(tipoData) {
    const tipoEntries = Object.entries(tipoData).filter(([k, v]) => v > 0 && !_metricasGastosTipoFilter.has(k)).sort((a, b) => b[1] - a[1])
    if (!tipoEntries.length) { mDestroyChart("mChartGastosTipo"); return }
    const tipoLabels = tipoEntries.map(([k]) => k)
    const tipoValues = tipoEntries.map(([, v]) => v)
    const tipoColors = tipoLabels.map((label) => mGastosTipoColor(label))
    const tipoTotal  = tipoValues.reduce((a, b) => a + b, 0)
    mCreateChart("mChartGastosTipo", {
        type: "doughnut",
        data: { labels: tipoLabels, datasets: [{ data: tipoValues, backgroundColor: tipoColors, borderColor: "#0b1120", borderWidth: 2, hoverOffset: 10 }] },
        options: {
            ...M_CHART_DEFAULTS, cutout: "55%",
            onClick: (_e, elements) => {
                if (!elements.length) return
                openGastosTipoPopup(tipoLabels[elements[0].index])
            },
            plugins: { ...M_CHART_DEFAULTS.plugins, legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" }, tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, tipoTotal) } } }
        }
    })
    const canvas = document.getElementById("mChartGastosTipo")
    if (canvas) canvas.style.cursor = "pointer"
}

function openGastosTipoPopup(tipoLabel) {
    const cache = _mGastosChartsCache
    if (!cache) return
    const { yearData } = cache
    const monthScope = _metricasGastosMonth === "all" ? M_GASTOS_KEYS : [_metricasGastosMonth]

    const rows = []
    if (tipoLabel === "Mensualidades") {
        ;(yearData?.mensualidades || []).forEach((m) => {
            monthScope.forEach((mk) => {
                const val = parseEuroNumber(m.meses?.[mk] || "")
                if (val > 0) rows.push({ fecha: "—", mes: M_GASTOS_LABELS[M_GASTOS_KEYS.indexOf(mk)] || mk, nombre: m.nombre || "—", cantidad: val })
            })
        })
    } else {
        monthScope.forEach((mk) => {
            ;(yearData?.months?.[mk]?.rows || []).forEach((r) => {
                if ((r.tipo || "Sin tipo").trim() === tipoLabel) {
                    rows.push({ fecha: r.fecha || "—", mes: M_GASTOS_LABELS[M_GASTOS_KEYS.indexOf(mk)] || mk, nombre: r.nombre || "—", cantidad: parseEuroNumber(r.cantidad || "") })
                }
            })
        })
    }

    document.getElementById("gastosTipoPopup")?.remove()

    const mainContent = document.querySelector(".mainContent")
    if (!mainContent) return
    const rect = mainContent.getBoundingClientRect()
    const total = rows.reduce((s, r) => s + r.cantidad, 0)

    const tableRows = rows.map((r) => `
        <tr>
            <td>${r.fecha}</td>
            <td>${r.mes}</td>
            <td>${r.nombre}</td>
            <td style="text-align:right">${formatEuro(r.cantidad)}</td>
        </tr>`).join("")

    const popupW = Math.round(rect.width  * 0.78)
    const popupH = Math.round(rect.height * 0.65)
    const popupL = rect.left + Math.round((rect.width  - popupW) / 2)
    const popupT = rect.top  + Math.round((rect.height - popupH) / 2)

    const backdrop = document.createElement("div")
    backdrop.id = "gastosTipoBackdrop"
    backdrop.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:899;`
    backdrop.style.pointerEvents = "none"

    const popup = document.createElement("div")
    popup.id = "gastosTipoPopup"
    popup.className = "gtPopup"
    popup.style.cssText = `position:fixed;top:${popupT}px;left:${popupL}px;width:${popupW}px;height:${popupH}px;z-index:900;border-radius:12px;box-shadow:0 8px 40px rgba(0,0,0,0.6);`
    popup.innerHTML = `
        <div class="gtPopupHeader">
            <span class="gtPopupTitle">Gastos · ${tipoLabel}</span>
            <span class="gtPopupTotal">Total: ${formatEuro(total)} · ${rows.length} movimientos</span>
            <button class="gtPopupClose" id="gtPopupCloseBtn">✕</button>
        </div>
        <div class="gtPopupBody">
            <table class="overviewTable gtPopupTable" id="gtPopupTable">
                <thead>
                    <tr>
                        <th class="mThSort" data-sortkey="0">Fecha <span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="1">Mes <span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="2">Concepto <span class="mSortArrow"></span></th>
                        <th class="mThSort" data-sortkey="3" style="text-align:right">Importe <span class="mSortArrow"></span></th>
                    </tr>
                </thead>
                <tbody>${tableRows}
                    <tr class="gtTotalRow">
                        <td colspan="3"><strong>Total</strong></td>
                        <td style="text-align:right"><strong>${formatEuro(total)}</strong></td>
                    </tr>
                </tbody>
            </table>
        </div>`

    document.body.appendChild(backdrop)
    document.body.appendChild(popup)
    document.getElementById("gtPopupCloseBtn")?.addEventListener("click", () => { backdrop.remove(); popup.remove() })
    const table = document.getElementById("gtPopupTable")
    if (table) bindTableSort(table)
}

// ── top-positions table ────────────────────────────────────────────────────

function mSortSummaries(summaries) {
    const totalCuenta = summaries.reduce((s, a) => s + Math.max(0, a.netoActualEur), 0)

    const withDerived = summaries.map((a) => ({
        ...a,
        rendPct: a.invertidoEur > 0 ? (a.rendimientoEur / a.invertidoEur) * 100 : 0,
        cartPct: totalCuenta > 0    ? (Math.max(0, a.netoActualEur) / totalCuenta) * 100 : 0
    }))

    const key = _metricasSortKey
    const dir = _metricasSortDir === "asc" ? 1 : -1

    withDerived.sort((a, b) => {
        const isStr = key === "name" || key === "type"
        const va = isStr ? (a[key] || "").toLowerCase() : (a[key] ?? 0)
        const vb = isStr ? (b[key] || "").toLowerCase() : (b[key] ?? 0)
        if (va < vb) return -dir
        if (va > vb) return  dir
        return 0
    })

    return withDerived
}

function mUpdateSortArrows() {
    document.querySelectorAll(".mThSort").forEach((th) => {
        const arrow = th.querySelector(".mSortArrow")
        if (!arrow) return
        if (th.dataset.sortkey === _metricasSortKey) {
            arrow.textContent = _metricasSortDir === "asc" ? " ▲" : " ▼"
            th.classList.add("mThActive")
        } else {
            arrow.textContent = ""
            th.classList.remove("mThActive")
        }
    })
}

function mRenderTopTable(summaries) {
    const tbody = document.getElementById("metricasTopBody")
    if (!tbody) return

    const rows = mSortSummaries(summaries)

    tbody.innerHTML = rows.map((a, idx) => {
        const rClass    = a.rendimientoEur >= 0 ? "mCellPos" : "mCellNeg"
        const typeLabel = M_TYPE_LABELS[a.type] || a.type
        const typeColor = M_TYPE_COLORS[a.type] || "#888"

        return `
        <tr>
            <td class="mTdRank">${idx + 1}</td>
            <td class="mTdName">${a.name}</td>
            <td><span class="mTypeBadge" style="background:${typeColor}22;color:${typeColor};border-color:${typeColor}44">${typeLabel}</span></td>
            <td>${formatEuro(a.netoActualEur)}</td>
            <td>${formatEuro(a.invertidoEur)}</td>
            <td class="${rClass}">${formatEuro(a.rendimientoEur)}</td>
            <td class="${rClass}">${formatPercent(a.rendPct)}</td>
            <td>
                <div class="mCartBar">
                    <div class="mCartBarFill" style="width:${Math.min(100, a.cartPct).toFixed(1)}%"></div>
                    <span>${a.cartPct.toFixed(1)} %</span>
                </div>
            </td>
        </tr>`
    }).join("")

    mUpdateSortArrows()
}

function mBindTableSort(summaries) {
    document.querySelectorAll(".mThSort").forEach((th) => {
        th.addEventListener("click", () => {
            const key = th.dataset.sortkey
            if (_metricasSortKey === key) {
                _metricasSortDir = _metricasSortDir === "asc" ? "desc" : "asc"
            } else {
                _metricasSortKey = key
                _metricasSortDir = "desc"
            }
            mRenderTopTable(summaries)
        })
    })
}

function mRenderIngresos(ingresosYearData) {
    const group = document.querySelector(".mkpiGroupIngresosPersonales")
    if (!group) return

    if (!ingresosYearData) {
        mSetKpi("mkpiIngresosTotal",      "---")
        mSetKpi("mkpiIngresosRecurrentes","---")
        mSetKpi("mkpiIngresosMovimientos","---")
        return
    }

    const M_ING_KEYS = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"]

    const totalRecurrentes = (ingresosYearData.recurrentes || []).reduce((s, row) =>
        s + M_ING_KEYS.reduce((ms, k) => ms + parseEuroNumber(row.meses?.[k] || ""), 0), 0)

    const totalMovimientos = Object.values(ingresosYearData.months || {}).reduce((s, monthData) =>
        s + (monthData?.rows || []).reduce((ms, row) => ms + parseEuroNumber(row.cantidad || ""), 0), 0)

    mSetKpi("mkpiIngresosTotal",       formatEuro(totalRecurrentes + totalMovimientos))
    mSetKpi("mkpiIngresosRecurrentes", formatEuro(totalRecurrentes))
    mSetKpi("mkpiIngresosMovimientos", formatEuro(totalMovimientos))
}

// ── ingresos charts ────────────────────────────────────────────────────────

const M_ING_KEYS   = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"]
const M_ING_LABELS = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]

function mComputeIngresosMonthly(ingresosYearData) {
    const totals = Object.fromEntries(M_ING_KEYS.map(k => [k, 0]))
    ;(ingresosYearData?.recurrentes || []).forEach(row => {
        M_ING_KEYS.forEach(k => { totals[k] += parseEuroNumber(row.meses?.[k] || "") })
    })
    M_ING_KEYS.forEach(k => {
        ;(ingresosYearData?.months?.[k]?.rows || []).forEach(row => {
            totals[k] += parseEuroNumber(row.cantidad || "")
        })
    })
    return totals
}

function mComputeIngresosTipo(ingresosYearData, monthKey) {
    const totals = {}
    if (monthKey === "all") {
        ;(ingresosYearData?.recurrentes || []).forEach(row => {
            const nombre = (row.nombre || "Recurrentes").trim()
            const sub = M_ING_KEYS.reduce((s, k) => s + parseEuroNumber(row.meses?.[k] || ""), 0)
            if (sub > 0) totals[nombre] = (totals[nombre] || 0) + sub
        })
        M_ING_KEYS.forEach(k => {
            ;(ingresosYearData?.months?.[k]?.rows || []).forEach(row => {
                const tipo = (row.tipo || "Sin tipo").trim()
                const val = parseEuroNumber(row.cantidad || "")
                if (val > 0) totals[tipo] = (totals[tipo] || 0) + val
            })
        })
    } else {
        ;(ingresosYearData?.recurrentes || []).forEach(row => {
            const nombre = (row.nombre || "Recurrentes").trim()
            const val = parseEuroNumber(row.meses?.[monthKey] || "")
            if (val > 0) totals[nombre] = (totals[nombre] || 0) + val
        })
        ;(ingresosYearData?.months?.[monthKey]?.rows || []).forEach(row => {
            const tipo = (row.tipo || "Sin tipo").trim()
            const val = parseEuroNumber(row.cantidad || "")
            if (val > 0) totals[tipo] = (totals[tipo] || 0) + val
        })
    }
    return totals
}

function mRenderIngresosCharts(ingresosYearData) {
    const totalMes  = mComputeIngresosMonthly(ingresosYearData)
    const totalTipo = mComputeIngresosTipo(ingresosYearData, _metricasIngresosMonth)

    const mesWrap = document.getElementById("mChartIngresosMesWrap")
    if (mesWrap) mesWrap.style.height = "280px"

    const mesValues = M_ING_KEYS.map(k => totalMes[k] || 0)
    const mesColors = M_ING_LABELS.map((_, i) => M_PALETTE[i % M_PALETTE.length])
    mCreateChart("mChartIngresosMes", {
        type: "bar",
        data: { labels: M_ING_LABELS, datasets: [{ label: "Ingresos (€)", data: mesValues, backgroundColor: mesColors.map(c => c + "bb"), borderColor: mesColors, borderWidth: 1, borderRadius: 4 }] },
        options: {
            ...M_CHART_DEFAULTS, indexAxis: "y",
            plugins: { ...M_CHART_DEFAULTS.plugins, legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } } },
            scales: { x: mAxisX(), y: mAxisY(11) }
        }
    })

    const tipoEntries = Object.entries(totalTipo).sort((a, b) => b[1] - a[1])
    if (tipoEntries.length) {
        const tipoLabels = tipoEntries.map(([k]) => k)
        const tipoValues = tipoEntries.map(([, v]) => v)
        const tipoColors = tipoLabels.map((_, i) => M_PALETTE[i % M_PALETTE.length])
        const tipoTotal  = tipoValues.reduce((a, b) => a + b, 0)
        mCreateChart("mChartIngresosTipo", {
            type: "doughnut",
            data: { labels: tipoLabels, datasets: [{ data: tipoValues, backgroundColor: tipoColors, borderColor: "#0b1120", borderWidth: 2, hoverOffset: 10 }] },
            options: {
                ...M_CHART_DEFAULTS, cutout: "55%",
                plugins: { ...M_CHART_DEFAULTS.plugins, legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" }, tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, tipoTotal) } } }
            }
        })
    } else {
        mDestroyChart("mChartIngresosTipo")
    }
}

function mRenderIngresosSection(ingresosYearsList, ingresosYearData) {
    const section = document.getElementById("mSectionIngresos")
    if (!ingresosYearsList.length || !ingresosYearData) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const yearToggle = document.getElementById("mIngresosYearToggle")
    if (yearToggle && !yearToggle.dataset.bound) {
        yearToggle.dataset.bound = "true"
        yearToggle.innerHTML = ingresosYearsList.map(y =>
            `<button class="mToggleBtn${String(y) === String(ingresosYearData.year) ? " active" : ""}" data-ingresosyear="${y}">${y}</button>`
        ).join("")
        yearToggle.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-ingresosyear]")
            if (!btn) return
            yearToggle.querySelectorAll(".mToggleBtn").forEach(b => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasIngresosMonth = "all"
            const newData = await fetch(`/api/ingresos/${btn.dataset.ingresosyear}`).then(r => r.json()).catch(() => null)
            if (newData) {
                _metricasPayload.ingresosYearData = newData
                const mt = document.getElementById("mIngresosMonthToggle")
                if (mt) { mt.dataset.bound = ""; mt.innerHTML = "" }
                mRenderIngresosSection(ingresosYearsList, newData)
                mRenderComparativa(_metricasPayload.ingresosYearData, _metricasPayload.gastosYearData)
            }
        })
    } else if (yearToggle) {
        yearToggle.querySelectorAll(".mToggleBtn").forEach(b =>
            b.classList.toggle("active", b.dataset.ingresosyear === String(ingresosYearData.year))
        )
    }

    const monthToggle = document.getElementById("mIngresosMonthToggle")
    const tipoTitle   = document.getElementById("mIngresosTipoTitle")
    if (monthToggle && !monthToggle.dataset.bound) {
        monthToggle.dataset.bound = "true"
        const allBtn   = `<button class="mToggleBtn${_metricasIngresosMonth === "all" ? " active" : ""}" data-ingresosmonth="all">Todos</button>`
        const monthBtns = M_ING_KEYS.map((k, i) =>
            `<button class="mToggleBtn${_metricasIngresosMonth === k ? " active" : ""}" data-ingresosmonth="${k}">${M_ING_LABELS[i]}</button>`
        ).join("")
        monthToggle.innerHTML = allBtn + monthBtns
        monthToggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-ingresosmonth]")
            if (!btn) return
            monthToggle.querySelectorAll(".mToggleBtn").forEach(b => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasIngresosMonth = btn.dataset.ingresosmonth
            if (tipoTitle) tipoTitle.textContent = _metricasIngresosMonth === "all" ? "Por tipo (anual)" : `Por tipo — ${M_ING_LABELS[M_ING_KEYS.indexOf(_metricasIngresosMonth)] || _metricasIngresosMonth}`
            mRenderIngresosCharts(ingresosYearData)
        })
    } else if (monthToggle) {
        monthToggle.querySelectorAll(".mToggleBtn").forEach(b =>
            b.classList.toggle("active", b.dataset.ingresosmonth === _metricasIngresosMonth)
        )
    }

    if (tipoTitle) tipoTitle.textContent = _metricasIngresosMonth === "all" ? "Por tipo (anual)" : `Por tipo — ${M_ING_LABELS[M_ING_KEYS.indexOf(_metricasIngresosMonth)] || _metricasIngresosMonth}`
    mRenderIngresosCharts(ingresosYearData)
}

// ── intereses mensuales ────────────────────────────────────────────────────

let _metricasInteresesYear = null

function mRenderInteresesSection(interesRows) {
    const section = document.getElementById("mSectionIntereses")
    const rows = Array.isArray(interesRows) ? interesRows : []
    if (!rows.length) { if (section) section.classList.add("hidden"); return }
    if (section) section.classList.remove("hidden")

    function intYear(fecha) {
        const p = String(fecha || "").split("-")
        return p.length === 3 ? p[2] : p.length === 2 ? p[1] : null
    }
    function intMonth(fecha) {
        const p = String(fecha || "").split("-")
        return p.length === 3 ? parseInt(p[1]) - 1 : p.length === 2 ? parseInt(p[0]) - 1 : -1
    }

    const years = [...new Set(rows.map(r => intYear(r.fecha)).filter(Boolean))].sort((a, b) => Number(a) - Number(b))
    if (!_metricasInteresesYear || !years.includes(_metricasInteresesYear)) _metricasInteresesYear = years[years.length - 1] || null

    const yearToggle = document.getElementById("mInteresesYearToggle")
    if (yearToggle) {
        yearToggle.innerHTML = years.map(y =>
            `<button class="mToggleBtn${y === _metricasInteresesYear ? " active" : ""}" data-intano="${y}">${y}</button>`
        ).join("")
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-intano]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach(b => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasInteresesYear = btn.dataset.intano
                mDrawInteresesChart(rows, _metricasInteresesYear, intYear, intMonth)
            })
        }
    }

    mDrawInteresesChart(rows, _metricasInteresesYear, intYear, intMonth)
}

function mDrawInteresesChart(rows, year, intYear, intMonth) {
    const monthNet  = Array(12).fill(0)
    const monthAcum = Array(12).fill(0)

    rows.filter(r => intYear(r.fecha) === year).forEach(r => {
        const m = intMonth(r.fecha)
        if (m < 0 || m > 11) return
        const acum = parseEuroNumber(r.acumulado || "")
        const imp  = parseEuroNumber(r.impuestos || "")
        monthAcum[m] += acum
        monthNet[m]  += acum - imp
    })

    const labels = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]
    const netColors = monthNet.map(v => v >= 0 ? "#2ecc71" : "#e74c3c")

    mCreateChart("mChartIntereses", {
        type: "bar",
        data: {
            labels,
            datasets: [
                { label: "Acumulado", data: monthAcum, backgroundColor: "#3a7bd544", borderColor: "#3a7bd5", borderWidth: 1, borderRadius: 4 },
                { label: "Neto",      data: monthNet,  backgroundColor: netColors.map(c => c + "bb"), borderColor: netColors, borderWidth: 1, borderRadius: 4 }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: { callbacks: { label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: mAxisY() }
        }
    })
}

// ── comparativa ingresos vs gastos ─────────────────────────────────────────

function mRenderComparativa(ingresosYearData, gastosYearData) {
    const section = document.getElementById("mSectionComparativa")
    if (!ingresosYearData && !gastosYearData) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    // Collect all tipos de gastos (movimientos rows)
    const tiposSet = new Set()
    Object.values(gastosYearData?.months || {}).forEach(monthData => {
        ;(monthData?.rows || []).forEach(row => {
            tiposSet.add((row.tipo || "Sin tipo").trim())
        })
    })
    const hasMensualidades = (gastosYearData?.mensualidades || []).length > 0
    if (hasMensualidades) tiposSet.add("Mensualidades")
    const allTipos = [...tiposSet].sort()

    // Render filter buttons — always rebuild so listener always sees current year data
    const filtrosEl = document.getElementById("mComparativaFiltros")
    if (filtrosEl) {
        filtrosEl.innerHTML = allTipos.map(t =>
            `<button class="mActivosFilterBtn${_metricasComparativaExclude.has(t) ? "" : " active"}" data-cmp-tipo="${t}">${t}</button>`
        ).join("")
        filtrosEl.onclick = e => {
            const btn = e.target.closest("[data-cmp-tipo]")
            if (!btn) return
            const tipo = btn.dataset.cmpTipo
            if (_metricasComparativaExclude.has(tipo)) {
                _metricasComparativaExclude.delete(tipo)
                btn.classList.add("active")
            } else {
                _metricasComparativaExclude.add(tipo)
                btn.classList.remove("active")
            }
            mDrawComparativaChart(_metricasPayload.ingresosYearData, _metricasPayload.gastosYearData)
            fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ comparativaExcluded: [..._metricasComparativaExclude] })
            }).catch(() => {})
        }
    }

    mDrawComparativaChart(ingresosYearData, gastosYearData)
}

function mDrawComparativaChart(ingresosYearData, gastosYearData) {
    const ingMonthly = M_ING_KEYS.map(k => {
        let t = 0
        ;(ingresosYearData?.recurrentes || []).forEach(r => { t += parseEuroNumber(r.meses?.[k] || "") })
        ;(ingresosYearData?.months?.[k]?.rows || []).forEach(r => { t += parseEuroNumber(r.cantidad || "") })
        return t
    })

    const gastosDetalle = M_GASTOS_KEYS.map(k => {
        const detalle = {}
        if (!_metricasComparativaExclude.has("Mensualidades")) {
            const mens = (gastosYearData?.mensualidades || []).reduce((s, r) => s + parseEuroNumber(r.meses?.[k] || ""), 0)
            if (mens > 0) detalle["Mensualidades"] = mens
        }
        ;(gastosYearData?.months?.[k]?.rows || []).forEach(row => {
            const tipo = (row.tipo || "Sin tipo").trim()
            if (!_metricasComparativaExclude.has(tipo)) {
                const val = parseEuroNumber(row.cantidad || "")
                if (val > 0) detalle[tipo] = (detalle[tipo] || 0) + val
            }
        })
        return detalle
    })

    const gastosMonthly = gastosDetalle.map(d => Object.values(d).reduce((s, v) => s + v, 0))

    const balance = ingMonthly.map((ing, i) => ing - gastosMonthly[i])

    mCreateChart("mChartComparativa", {
        type: "bar",
        data: {
            labels: M_ING_LABELS,
            datasets: [
                { label: "Ingresos", data: ingMonthly,   backgroundColor: "#2ecc7188", borderColor: "#2ecc71", borderWidth: 1, borderRadius: 4 },
                { label: "Gastos",   data: gastosMonthly, backgroundColor: "#e74c3c88", borderColor: "#e74c3c", borderWidth: 1, borderRadius: 4 },
                { label: "Balance",  data: balance, backgroundColor: balance.map(v => v >= 0 ? "#3a7bd577" : "#e74c3c44"), borderColor: balance.map(v => v >= 0 ? "#3a7bd5" : "#e74c3c"), borderWidth: 1, borderRadius: 4 }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}`,
                        afterLabel: (c) => {
                            if (c.dataset.label !== "Gastos") return []
                            return Object.entries(gastosDetalle[c.dataIndex])
                                .sort((a, b) => b[1] - a[1])
                                .map(([tipo, val]) => `  · ${tipo}: ${formatEuro(val)}`)
                        }
                    }
                }
            },
            scales: { x: mAxisX(), y: mAxisY() }
        }
    })
}

// ── main init ──────────────────────────────────────────────────────────────

function mRenderAll(payload) {
    const { summaries, dividendos, bonos, rentaFija, gastosYearsList, gastosYearData, ingresosYearsList, ingresosYearData } = payload
    const b = bonos || [], rf = rentaFija || []
    mRenderDistTipos(summaries, _metricasDisplayType, b, rf, _metricasDistMetric)
    mRenderDistActivos(summaries, _metricasDisplayType, b, rf, _metricasDistMetric)
    mRenderRendTipos(summaries)
    mRenderRendActivos(summaries)
    mRenderDividendos(dividendos)
    mRenderDivMensual(dividendos)
    mRenderInteresesSection(payload.intereses)
    mRenderBonosTipos(b)
    mRenderBonosInst(b)
    mRenderRentaFijaTipos(rf)
    mRenderRentaFijaInst(rf)
    mRenderGastos(gastosYearsList || [], gastosYearData || null)
    mRenderIngresos(ingresosYearData || null)
    mRenderIngresosSection(ingresosYearsList || [], ingresosYearData || null)
    mRenderComparativa(ingresosYearData || null, gastosYearData || null)
    mRenderTopTable(summaries)
}

async function initMetricasLogic() {
    Object.values(_metricasCharts).forEach((c) => c?.destroy())
    _metricasCharts = {}
    _metricasDisplayType  = window._metricasDisplayType ?? "doughnut"
    _metricasDistMetric   = window._metricasDistMetric  ?? "netoActualEur"
    _metricasGastosMonth  = "all"
    _metricasIngresosMonth = "all"
    _metricasInteresesYear = null
    _metricasDivMensualYear = null
    _metricasActivosFilter = new Set(["cripto","acciones","etfs","comoditis","bonos","rentaFija"])
    _metricasGastosTipoFilter = new Set()
    _metricasComparativaExclude = new Set(window._metricasComparativaExcluded || [])
    _mGastosChartsCache = null
    _metricasPayload = null

    const loading = document.getElementById("metricasLoading")

    try {
        _metricasPayload = await buildMetricasPayload()
        if (loading) loading.classList.add("hidden")

        mUpdateKpis(_metricasPayload)
        mRenderAll(_metricasPayload)
        mBindTableSort(_metricasPayload.summaries)

        document.querySelectorAll(".mActivosFilterBtn").forEach((btn) => {
            btn.addEventListener("click", () => {
                const tipo = btn.dataset.atype
                if (_metricasActivosFilter.has(tipo)) {
                    _metricasActivosFilter.delete(tipo)
                    btn.classList.remove("active")
                } else {
                    _metricasActivosFilter.add(tipo)
                    btn.classList.add("active")
                }
                mRenderDistActivos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [], _metricasDistMetric)
            })
        })

        const toggleBtns = document.querySelectorAll(".mToggleBtn[data-charttype]")
        toggleBtns.forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.charttype === _metricasDisplayType)
            btn.addEventListener("click", () => {
                toggleBtns.forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDisplayType = btn.dataset.charttype
                window._metricasDisplayType = _metricasDisplayType
                fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metricasDisplayType: _metricasDisplayType }) })
                mRenderDistTipos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [], _metricasDistMetric)
                mRenderDistActivos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [], _metricasDistMetric)
            })
        })

        const metricBtns = document.querySelectorAll(".mDistMetricBtn")
        metricBtns.forEach((btn) => {
            btn.classList.toggle("active", btn.dataset.metric === _metricasDistMetric)
            btn.addEventListener("click", () => {
                metricBtns.forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDistMetric = btn.dataset.metric
                window._metricasDistMetric = _metricasDistMetric
                fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metricasDistMetric: _metricasDistMetric }) })
                mRenderDistTipos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [], _metricasDistMetric)
                mRenderDistActivos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [], _metricasDistMetric)
            })
        })

        // ── nav tabs (multi-select) ───────────────────────────────────────
        const navTabs   = document.querySelectorAll(".mNavTab")
        const navSearch = document.getElementById("mNavSearch")
        const todoTab   = document.querySelector(".mNavTab[data-mcat='todo']")
        let _mActiveCats = new Set()

        function mApplyNavFilter() {
            const q = (navSearch?.value || "").toLowerCase().trim()
            document.querySelectorAll(".metricasSection[data-mcat], .metricasKpiGroup[data-mcat]").forEach(el => {
                const elCat      = el.dataset.mcat
                const catMatch   = _mActiveCats.size === 0 || [..._mActiveCats].some(c => elCat === c)
                const titleEl    = el.querySelector(".metricasSectionTitle,.metricasKpiGroupLabel")
                const searchMatch = !q || (titleEl?.textContent || "").toLowerCase().includes(q)
                el.style.display = catMatch && searchMatch ? "" : "none"
            })
            if (todoTab) todoTab.classList.toggle("active", _mActiveCats.size === 0)
        }

        navTabs.forEach(btn => {
            btn.addEventListener("click", () => {
                const mcat = btn.dataset.mcat
                if (mcat === "todo") {
                    _mActiveCats.clear()
                    navTabs.forEach(b => b.classList.remove("active"))
                    btn.classList.add("active")
                } else {
                    const cats = mcat.split(",").map(s => s.trim())
                    const wasActive = cats.every(c => _mActiveCats.has(c))
                    if (wasActive) {
                        cats.forEach(c => _mActiveCats.delete(c))
                    } else {
                        cats.forEach(c => _mActiveCats.add(c))
                    }
                    btn.classList.toggle("active", !wasActive)
                }
                mApplyNavFilter()
            })
        })

        if (navSearch) navSearch.addEventListener("input", mApplyNavFilter)

    } catch (err) {
        console.error("Error cargando métricas:", err)
        if (loading) loading.textContent = "Error al cargar los datos."
    }
}
