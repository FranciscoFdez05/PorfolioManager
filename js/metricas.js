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

function mPaletteForName(name) {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return M_PALETTE[h % M_PALETTE.length]
}

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
            color:          asset.color || "",
            netoActualEur:  euros.netoActualEur,
            invertidoEur:   euros.invertidoBrutoEur,
            rendimientoEur: euros.rendimientoEur
        }
    }))

    const [divResp, intResp, bonosResp, rfResp, gastosYearsResp, ingresosYearsResp, tradingResp] = await Promise.all([
        fetch("/api/dividendos"),
        fetch("/api/intereses"),
        fetch("/api/bonos"),
        fetch("/api/rentafija"),
        fetch("/api/gastos").catch(() => null),
        fetch("/api/ingresos").catch(() => null),
        fetch("/api/trading").catch(() => null)
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

    const tradingData = tradingResp ? await tradingResp.json().catch(() => ({ rows: [] })) : { rows: [] }

    return {
        summaries,
        dividendos:      Array.isArray(divData.rows)   ? divData.rows   : [],
        intereses:       Array.isArray(intData.cuentas)
            ? intData.cuentas.flatMap(c => Array.isArray(c.rows) ? c.rows : [])
            : (Array.isArray(intData.rows) ? intData.rows : []),
        cuentasRemuneradas: Array.isArray(intData.cuentas) ? intData.cuentas : [],
        bonos:           Array.isArray(bonosData.rows)  ? bonosData.rows : [],
        rentaFija:       Array.isArray(rfData.rows)     ? rfData.rows    : [],
        gastosYearsList,
        gastosYearData,
        ingresosYearsList,
        ingresosYearData,
        tradingRows: Array.isArray(tradingData.rows) ? tradingData.rows : []
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
    const { summaries, dividendos, intereses, bonos, rentaFija, tradingRows } = payload

    const tRows = Array.isArray(tradingRows) ? tradingRows : []
    if (tRows.length) {
        const tProfits = tRows.filter((r) => r.resultado === "PROFIT").length
        const tLosses  = tRows.filter((r) => r.resultado === "PÉRDIDA").length
        const winRate  = tRows.length > 0 ? (tProfits / tRows.length) * 100 : 0
        const gananciaTotal = tRows.reduce((s, r) => {
            const v = parseFloat(String(r.ganancia || "").replace(",", ".").replace("%", ""))
            return s + (isNaN(v) ? 0 : v)
        }, 0)
        const roiMedio = tRows.reduce((s, r) => {
            const v = parseFloat(String(r.roi || "").replace(",", ".").replace("%", ""))
            return s + (isNaN(v) ? 0 : v)
        }, 0) / (tRows.length || 1)

        mSetKpi("mkpiTradingTotal",    String(tRows.length))
        mSetKpi("mkpiTradingProfits",  String(tProfits), "mPositive")
        mSetKpi("mkpiTradingLosses",   String(tLosses),  "mNegative")
        mSetKpi("mkpiTradingWinRate",  winRate.toFixed(1).replace(".", ",") + "%", winRate >= 50 ? "mPositive" : "mNegative")
        mSetKpi("mkpiTradingGanancia", (gananciaTotal >= 0 ? "+" : "") + gananciaTotal.toFixed(2).replace(".", ",") + "%", gananciaTotal >= 0 ? "mPositive" : "mNegative")
        mSetKpi("mkpiTradingRoiMedio", (roiMedio >= 0 ? "+" : "") + roiMedio.toFixed(1).replace(".", ",") + "%", roiMedio >= 0 ? "mPositive" : "mNegative")
    }

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

    const rfRows = Array.isArray(rentaFija) ? rentaFija : []
    const rfNeto = rfRows.reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)

    mSetKpi("mkpiRentaFija", formatEuro(rfNeto))

    const rfGroup = document.querySelector(".mkpiGroupRf")
    if (rfGroup) rfGroup.classList.toggle("hidden", bonosRows.length === 0 && rfRows.length === 0)

    const ingresosGroup = document.querySelector(".mkpiGroupIngresos")
    if (ingresosGroup) ingresosGroup.classList.toggle("hidden", dividendos.length === 0 && intereses.length === 0)

    const topSet2 = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val }
    topSet2("topTotalDividendos", formatEuro(totalDiv))
    topSet2("topTotalInteres",    formatEuro(totalInt))
    topSet2("topTotalRentaFija",  formatEuro(bonosNeto + rfNeto))
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
        ...summaries.filter((a) => _metricasActivosFilter.has(a.type)).map((a) => ({ name: a.name, _val: mDistAssetVal(a, metric), color: a.color || "" })),
        ...extras
    ].sort((a, b) => b._val - a._val)

    const labels = allItems.map((a) => a.name)
    const rawValues = allItems.map((a) => a._val)
    const colors = allItems.map((item, i) => item.color || M_PALETTE[i % M_PALETTE.length])

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

function mRenderDividendos(dividendos, colorMap = {}) {
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
    const colors = labels.map((label) => colorMap[label] || mPaletteForName(label))

    const ROW_H = 36
    const MAX_ROWS = 9
    // Altura del eje X (canvas sticky inferior). Si es muy baja, los ticks se recortan.
    const AXIS_H = 86
    const fullH = Math.max(MAX_ROWS * ROW_H, sorted.length * ROW_H)
    const wrapH = Math.min(fullH, MAX_ROWS * ROW_H) + AXIS_H
    const maxVal = values.length ? Math.max(...values) : 1

    const wrap = document.getElementById("mChartDivWrap")
    const inner = document.getElementById("mChartDivInner")
    const axisWrap = document.getElementById("mChartDivAxisWrap")
    if (wrap) wrap.style.height = wrapH + "px"
    if (inner) inner.style.height = fullH + "px"
    if (axisWrap) axisWrap.style.height = AXIS_H + "px"

    mDestroyChart("mChartDividendosAxis")

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
            animation: { duration: 0 },
            indexAxis: "y",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: {
                x: {
                    ticks: { display: false },
                    grid: { color: "rgba(255,255,255,0.06)" },
                    border: { display: false },
                    max: maxVal * 1.05,
                    afterFit(scale) { scale.height = 0 }
                },
                y: mAxisY(12)
            }
        }
    })

    requestAnimationFrame(() => {
        const mainLeft = _metricasCharts["mChartDividendos"]?.chartArea?.left ?? 0
        const mainRight = _metricasCharts["mChartDividendos"]?.chartArea?.right ?? 0
        const canvasOffsetWidth = _metricasCharts["mChartDividendos"]?.canvas?.offsetWidth ?? 0
        const rightPad = canvasOffsetWidth && mainRight ? Math.max(0, canvasOffsetWidth - mainRight) : 0

        mCreateChart("mChartDividendosAxis", {
            type: "bar",
            data: { labels: [""], datasets: [{ data: [0], backgroundColor: "transparent", borderColor: "transparent", borderWidth: 0 }] },
            options: {
                ...M_CHART_DEFAULTS,
                indexAxis: "y",
                animation: { duration: 0 },
                plugins: {
                    ...M_CHART_DEFAULTS.plugins,
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                layout: { padding: { left: mainLeft, right: rightPad, top: 10, bottom: 18 } },
                scales: {
                    x: {
                        ticks: { color: "#8899bb", maxTicksLimit: 7 },
                        grid: { display: false },
                        border: { display: false },
                        min: 0,
                        max: maxVal * 1.05
                    },
                    y: { display: false }
                }
            }
        })
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

function mRenderDivMensual(dividendos, colorMap = {}) {
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
                mDrawDivMensualChart(rows, _metricasDivMensualYear, dYear, dMonth, colorMap)
                mDrawDivMensualTabla(rows, _metricasDivMensualYear, dYear, dMonth)
            })
        }
    }

    const calBtn = document.getElementById("mDivMensualCalBtn")
    if (calBtn && !calBtn.dataset.bound) {
        calBtn.dataset.bound = "true"
        calBtn.addEventListener("click", () => {
            if (typeof openCalendarioDividendos === "function") openCalendarioDividendos()
        })
    }

    const tablaBtn = document.getElementById("mDivMensualTablaBtn")
    if (tablaBtn && !tablaBtn.dataset.bound) {
        tablaBtn.dataset.bound = "true"
        tablaBtn.addEventListener("click", () => {
            const wrap = document.getElementById("mDivMensualTabla")
            if (!wrap) return
            const visible = !wrap.classList.contains("hidden")
            wrap.classList.toggle("hidden", visible)
            tablaBtn.textContent = visible ? "Ver tabla" : "Ocultar tabla"
            if (!visible) mDrawDivMensualTabla(rows, _metricasDivMensualYear, dYear, dMonth)
        })
    }

    mDrawDivMensualChart(rows, _metricasDivMensualYear, dYear, dMonth, colorMap)
}

function mDrawDivMensualTabla(rows, year, dYear, dMonth) {
    const head = document.getElementById("mDivMensualTableHead")
    const body = document.getElementById("mDivMensualTableBody")
    const foot = document.getElementById("mDivMensualTableFoot")
    if (!head || !body || !foot) return

    const MONTH_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    const yearRows = rows.filter(r => dYear(r.fecha) === year)
    const stocks = [...new Set(yearRows.map(r => r.instrumento || "Desconocido"))].sort()

    const monthData = {}
    stocks.forEach(s => { monthData[s] = Array(12).fill(0) })
    yearRows.forEach(r => {
        const m = dMonth(r.fecha)
        if (m < 0 || m > 11) return
        monthData[r.instrumento || "Desconocido"][m] += parseEuroNumber(r.total || "")
    })

    const monthTotals = Array(12).fill(0)
    stocks.forEach(s => monthData[s].forEach((v, i) => { monthTotals[i] += v }))

    head.innerHTML = `<tr><th>Mes</th>${stocks.map(s => `<th>${escapeMetricasHtml(s)}</th>`).join("")}<th>Total</th></tr>`

    body.innerHTML = MONTH_LABELS.map((label, i) => {
        const rowTotal = stocks.reduce((t, s) => t + monthData[s][i], 0)
        if (rowTotal === 0) return ""
        const cells = stocks.map(s => {
            const v = monthData[s][i]
            return `<td>${v > 0 ? formatEuro(v) : ""}</td>`
        }).join("")
        return `<tr><td class="mDivTabMes">${label}</td>${cells}<td class="mDivTabTotal">${formatEuro(rowTotal)}</td></tr>`
    }).join("")

    const grandTotal = monthTotals.reduce((t, v) => t + v, 0)
    const footCells = stocks.map(s => {
        const t = monthData[s].reduce((a, b) => a + b, 0)
        return `<td class="mDivTabFootCell">${t > 0 ? formatEuro(t) : ""}</td>`
    }).join("")
    foot.innerHTML = `<tr><td class="mDivTabMes mDivTabFootCell">Total</td>${footCells}<td class="mDivTabTotal mDivTabFootCell">${formatEuro(grandTotal)}</td></tr>`
}

function mDrawDivMensualChart(rows, year, dYear, dMonth, colorMap = {}) {
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
    const stockColors = stocks.map((s) => colorMap[s] || mPaletteForName(s))
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

    const total = rentaFija.reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)

    mCreateChart("mChartRfTipos", {
        type: "doughnut",
        data: {
            labels: ["Interés Fijo"],
            datasets: [{
                data: [Math.max(0, total)],
                backgroundColor: ["#00bcd4cc"],
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

// Returns false for future months of the current year (mensualidades not yet "active")
function isMensualidadMonthActive(yearData, monthKey) {
    const dataYear = Number(yearData?.year)
    const now = new Date()
    if (dataYear !== now.getFullYear()) return dataYear < now.getFullYear()
    return M_GASTOS_KEYS.indexOf(monthKey) <= now.getMonth()
}

function mComputeGastosData(yearData) {
    const totalMes = Object.fromEntries(M_GASTOS_KEYS.map((k) => [k, 0]))
    const totalTipo = {}
    let totalMensualidades = 0
    let totalMovimientos = 0

    ;(yearData?.mensualidades || []).forEach((m) => {
        M_GASTOS_KEYS.forEach((k) => {
            if (!isMensualidadMonthActive(yearData, k)) return
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
    const gastosKpiRow = document.querySelector(".metricasKpiRow[data-mcat='gastos']")
    if (!yearsList.length || !yearData) {
        if (section) section.classList.add("hidden")
        if (gastosKpiRow) gastosKpiRow.style.display = "none"
        return
    }
    if (section) section.classList.remove("hidden")
    if (gastosKpiRow) gastosKpiRow.style.display = ""

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
        const mensTotal = isMensualidadMonthActive(yearData, _metricasGastosMonth)
            ? (yearData?.mensualidades || []).reduce((s, m) => s + parseEuroNumber(m.meses?.[_metricasGastosMonth] || ""), 0)
            : 0
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
                if (!isMensualidadMonthActive(yearData, mk)) return
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
    if (table) bindTableSort(table, "metricasGt")
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
            <td class="mTdName">${escapeMetricasHtml(a.name)}</td>
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
    const ingresosKpiRow = document.querySelector(".metricasKpiRow[data-mcat='ingresos']")
    if (!ingresosYearsList.length || !ingresosYearData) {
        if (section) section.classList.add("hidden")
        if (ingresosKpiRow) ingresosKpiRow.style.display = "none"
        return
    }
    if (section) section.classList.remove("hidden")
    if (ingresosKpiRow) ingresosKpiRow.style.display = ""

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

const _CUENTA_COLORS = [
    "#3a7bd5", "#2ecc71", "#e67e22", "#9b59b6", "#1abc9c",
    "#e74c3c", "#f39c12", "#00cec9", "#fd79a8", "#6c5ce7"
]

function intYear(fecha) {
    const p = String(fecha || "").split("-")
    return p.length === 3 ? p[2] : p.length === 2 ? p[1] : null
}
function intMonth(fecha) {
    const p = String(fecha || "").split("-")
    return p.length === 3 ? parseInt(p[1]) - 1 : p.length === 2 ? parseInt(p[0]) - 1 : -1
}

function mRenderInteresesSection(interesRows, cuentas) {
    const section = document.getElementById("mSectionIntereses")
    const rows = Array.isArray(interesRows) ? interesRows : []
    if (!rows.length) { if (section) section.classList.add("hidden"); return }
    if (section) section.classList.remove("hidden")

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
                mDrawInteresesChart(cuentas, _metricasInteresesYear)
            })
        }
    }

    mDrawInteresesChart(cuentas, _metricasInteresesYear)
}

function mDrawInteresesChart(cuentas, year) {
    const labels = ["Ene","Feb","Mar","Abr","May","Jun","Jul","Ago","Sep","Oct","Nov","Dic"]
    const cuentasList = Array.isArray(cuentas) && cuentas.length ? cuentas : []

    // Por mes: totales y desglose por cuenta
    const monthAcum = Array(12).fill(0)
    const monthNet  = Array(12).fill(0)
    // desglose[mes] = [{ nombre, acum, neto }]
    const desglose  = Array.from({ length: 12 }, () => [])

    cuentasList.forEach(cuenta => {
        const cuentaRows = Array.isArray(cuenta.rows) ? cuenta.rows : []
        cuentaRows.filter(r => intYear(r.fecha) === year).forEach(r => {
            const m = intMonth(r.fecha)
            if (m < 0 || m > 11) return
            const acum = parseEuroNumber(r.acumulado || "")
            const imp  = parseEuroNumber(r.impuestos || "")
            const neto = acum - imp
            monthAcum[m] += acum
            monthNet[m]  += neto
            const existing = desglose[m].find(d => d.nombre === cuenta.nombre)
            if (existing) { existing.acum += acum; existing.neto += neto }
            else desglose[m].push({ nombre: cuenta.nombre, acum, neto })
        })
    })

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
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}`,
                        afterLabel: (c) => {
                            const mes = c.dataIndex
                            if (!desglose[mes] || !desglose[mes].length) return []
                            const isAcum = c.datasetIndex === 0
                            return desglose[mes].map(d => `  · ${d.nombre}: ${formatEuro(isAcum ? d.acum : d.neto)}`)
                        }
                    }
                }
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
            `<label class="mActivosFilterBtn" data-cmp-tipo="${t}"><input type="checkbox"${_metricasComparativaExclude.has(t) ? "" : " checked"}><span>${t}</span></label>`
        ).join("")
        filtrosEl.onchange = e => {
            const input = e.target
            if (!input.matches('input[type="checkbox"]')) return
            const label = input.closest("[data-cmp-tipo]")
            if (!label) return
            const tipo = label.dataset.cmpTipo
            if (input.checked) {
                _metricasComparativaExclude.delete(tipo)
            } else {
                _metricasComparativaExclude.add(tipo)
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
        if (!_metricasComparativaExclude.has("Mensualidades") && isMensualidadMonthActive(gastosYearData, k)) {
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

    mDrawComparativaLineChart(ingMonthly, gastosMonthly)

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

function mDrawComparativaLineChart(ingMonthly, gastosMonthly) {
    const labels = M_ING_LABELS

    // find max visible month (last month with any data)
    let lastIdx = -1
    for (let i = 0; i < 12; i++) {
        if (ingMonthly[i] > 0 || gastosMonthly[i] > 0) lastIdx = i
    }
    const visibleLabels   = lastIdx >= 0 ? labels.slice(0, lastIdx + 1)         : labels
    const visibleIngresos = lastIdx >= 0 ? ingMonthly.slice(0, lastIdx + 1)     : ingMonthly
    const visibleGastos   = lastIdx >= 0 ? gastosMonthly.slice(0, lastIdx + 1)  : gastosMonthly

    mCreateChart("mChartComparativaLinea", {
        type: "line",
        data: {
            labels: visibleLabels,
            datasets: [
                {
                    label: "Ingresos",
                    data: visibleIngresos,
                    borderColor: "#2ecc71",
                    backgroundColor: "rgba(46,204,113,0.12)",
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: "#2ecc71",
                    tension: 0.35,
                    fill: false
                },
                {
                    label: "Gastos",
                    data: visibleGastos,
                    borderColor: "#e74c3c",
                    backgroundColor: "rgba(231,76,60,0.12)",
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: "#e74c3c",
                    tension: 0.35,
                    fill: false
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            interaction: { mode: "index", intersect: false },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.dataset.label}: ${formatEuro(c.raw)}`,
                        afterBody: (items) => {
                            const ing = items.find(i => i.dataset.label === "Ingresos")?.raw ?? 0
                            const gas = items.find(i => i.dataset.label === "Gastos")?.raw ?? 0
                            const bal = ing - gas
                            return [`Balance: ${formatEuro(bal)}`]
                        }
                    }
                }
            },
            scales: {
                x: mAxisX(),
                y: {
                    ...mAxisY(),
                    ticks: {
                        color: "#8899bb",
                        callback: (v) => formatEuro(v)
                    }
                }
            }
        }
    })
}

// ── main init ──────────────────────────────────────────────────────────────

function mRenderAll(payload) {
    const { summaries, dividendos, bonos, rentaFija, gastosYearsList, gastosYearData, ingresosYearsList, ingresosYearData, tradingRows } = payload
    const b = bonos || [], rf = rentaFija || []
    mRenderDistTipos(summaries, _metricasDisplayType, b, rf, _metricasDistMetric)
    mRenderDistActivos(summaries, _metricasDisplayType, b, rf, _metricasDistMetric)
    mRenderRendTipos(summaries)
    mRenderRendActivos(summaries)
    const colorMap = Object.fromEntries(summaries.map(s => [s.name, s.color]).filter(([, c]) => c))
    mRenderDividendos(dividendos, colorMap)
    mRenderDivMensual(dividendos, colorMap)
    mRenderInteresesSection(payload.intereses, payload.cuentasRemuneradas)
    mRenderBonosTipos(b)
    mRenderBonosInst(b)
    mRenderRentaFijaTipos(rf)
    mRenderRentaFijaInst(rf)
    mRenderGastos(gastosYearsList || [], gastosYearData || null)
    mRenderIngresos(ingresosYearData || null)
    mRenderIngresosSection(ingresosYearsList || [], ingresosYearData || null)
    mRenderComparativa(ingresosYearData || null, gastosYearData || null)
    mRenderTopTable(summaries)
    mRenderTrading(tradingRows || [])

    const gastosEmpty = !gastosYearsList?.length || !gastosYearData
    const ingresosEmpty = !ingresosYearsList?.length || !ingresosYearData
    const gastosIngresosTab = document.querySelector(".mNavTab[data-mcat='gastos,ingresos']")
    if (gastosIngresosTab) gastosIngresosTab.classList.toggle("hidden", gastosEmpty && ingresosEmpty)
    const tradingTab = document.querySelector(".mNavTab[data-mcat='trading']")
    if (tradingTab) tradingTab.classList.toggle("hidden", !(tradingRows && tradingRows.length))
}

// ── Trading metrics ────────────────────────────────────────────────────────

let _mTradingWinLossFilter = "todos"

function mParseTradingPct(value) {
    if (!value && value !== 0) return null
    const n = parseFloat(String(value).replace(",", ".").replace("%", ""))
    return isNaN(n) ? null : n
}

function mFmtTradingPct(value) {
    const n = mParseTradingPct(value)
    if (n === null) return "---"
    return (n >= 0 ? "+" : "") + n.toFixed(2).replace(".", ",") + "%"
}

function mRenderTrading(rows) {
    const tradingSections = ["mSectionTradingDireccion", "mSectionTradingWinLoss", "mSectionTradingRendimiento"]
    const tradingKpiRow   = document.querySelector(".metricasKpiRow[data-mcat='trading']")
    if (!rows.length) {
        tradingSections.forEach(id => { const el = document.getElementById(id); if (el) el.classList.add("hidden") })
        if (tradingKpiRow) tradingKpiRow.style.display = "none"
        return
    }
    tradingSections.forEach(id => { const el = document.getElementById(id); if (el) el.classList.remove("hidden") })
    if (tradingKpiRow) tradingKpiRow.style.display = ""

    mRenderTradingDireccion(rows)
    mRenderTradingWinLoss(rows, _mTradingWinLossFilter)
    mRenderTradingRendimiento(rows)

    const wlFilterEl = document.getElementById("mTradingWinLossFilter")
    if (wlFilterEl && !wlFilterEl.dataset.bound) {
        wlFilterEl.dataset.bound = "true"
        const todosInput = wlFilterEl.querySelector('input[value="todos"]')
        if (todosInput) todosInput.checked = true
        wlFilterEl.addEventListener("change", (e) => {
            const label = e.target.closest(".mActivosFilterBtn")
            if (!label) return
            _mTradingWinLossFilter = label.dataset.wlfilter
            mRenderTradingWinLoss(rows, _mTradingWinLossFilter)
        })
    }
}

function mRenderTradingDireccion(rows) {
    const longs  = rows.filter((r) => r.direccion === "LONG")
    const shorts = rows.filter((r) => r.direccion === "SHORT")

    mCreateChart("mChartTradingDireccion", {
        type: "doughnut",
        data: {
            labels: ["LONG", "SHORT"],
            datasets: [{
                data: [longs.length, shorts.length],
                backgroundColor: ["#2ecc71", "#e74c3c"],
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
                tooltip: { callbacks: { label: (c) => ` ${c.raw} trades (${rows.length > 0 ? ((c.raw / rows.length) * 100).toFixed(1) : 0}%)` } }
            }
        }
    })

    const statsEl = document.getElementById("mTradingDireccionStats")
    if (!statsEl) return

    function dirStats(subset, label, color) {
        const profits = subset.filter((r) => r.resultado === "PROFIT")
        const wr = subset.length > 0 ? (profits.length / subset.length * 100).toFixed(1) : "0.0"
        const ganMedia = subset.length > 0
            ? (subset.reduce((s, r) => s + (mParseTradingPct(r.ganancia) || 0), 0) / subset.length).toFixed(2)
            : "0.00"
        const roiMedia = subset.length > 0
            ? (subset.reduce((s, r) => s + (mParseTradingPct(r.roi) || 0), 0) / subset.length).toFixed(1)
            : "0.0"
        return `
            <tr>
                <td><span class="tradingDirBadge tradingDir${label}" style="font-size:12px">${label}</span></td>
                <td>${subset.length}</td>
                <td class="${parseFloat(wr) >= 50 ? "tradingPos" : "tradingNeg"}">${wr}%</td>
                <td class="${parseFloat(ganMedia) >= 0 ? "tradingPos" : "tradingNeg"}">${mFmtTradingPct(ganMedia)}</td>
                <td class="${parseFloat(roiMedia) >= 0 ? "tradingPos" : "tradingNeg"}">${parseFloat(roiMedia) >= 0 ? "+" : ""}${roiMedia.replace(".", ",")}%</td>
            </tr>
        `
    }

    statsEl.innerHTML = `
        <table class="mTradingTable">
            <thead>
                <tr>
                    <th>Dirección</th>
                    <th>Trades</th>
                    <th>Win Rate</th>
                    <th>Gan. media</th>
                    <th>ROI medio</th>
                </tr>
            </thead>
            <tbody>
                ${dirStats(longs, "LONG", "#2ecc71")}
                ${dirStats(shorts, "SHORT", "#e74c3c")}
            </tbody>
        </table>
    `
}

function mRenderTradingWinLoss(rows, filter = "todos") {
    const filtered = filter === "LONG" ? rows.filter((r) => r.direccion === "LONG")
                   : filter === "SHORT" ? rows.filter((r) => r.direccion === "SHORT")
                   : rows

    const profits  = filtered.filter((r) => r.resultado === "PROFIT").length
    const perdidas = filtered.filter((r) => r.resultado === "PÉRDIDA").length

    mCreateChart("mChartTradingWinLoss", {
        type: "doughnut",
        data: {
            labels: ["Aciertos", "Fallos"],
            datasets: [{
                data: [profits, perdidas],
                backgroundColor: ["#2ecc71cc", "#e74c3ccc"],
                borderColor: ["#2ecc71", "#e74c3c"],
                borderWidth: 2,
                hoverOffset: 10
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "58%",
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => ` ${c.raw} (${filtered.length > 0 ? ((c.raw / filtered.length) * 100).toFixed(1) : 0}%)` } }
            }
        }
    })

    const mediaEl = document.getElementById("mTradingMediaTable")
    if (!mediaEl) return

    const profitRows  = filtered.filter((r) => r.resultado === "PROFIT")
    const perdidaRows = filtered.filter((r) => r.resultado === "PÉRDIDA")

    const avgGanProfit  = profitRows.length ? profitRows.reduce((s, r) => s + (mParseTradingPct(r.ganancia) || 0), 0) / profitRows.length : 0
    const avgGanLoss    = perdidaRows.length ? perdidaRows.reduce((s, r) => s + (mParseTradingPct(r.ganancia) || 0), 0) / perdidaRows.length : 0
    const avgRoiProfit  = profitRows.length ? profitRows.reduce((s, r) => s + (mParseTradingPct(r.roi) || 0), 0) / profitRows.length : 0
    const avgRoiLoss    = perdidaRows.length ? perdidaRows.reduce((s, r) => s + (mParseTradingPct(r.roi) || 0), 0) / perdidaRows.length : 0

    mediaEl.innerHTML = `
        <table class="mTradingTable">
            <thead>
                <tr>
                    <th>Resultado</th>
                    <th>Trades</th>
                    <th>Gan. media</th>
                    <th>ROI medio</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td><span class="tradingResultBadge tradingProfit" style="font-size:12px">PROFIT</span></td>
                    <td>${profitRows.length}</td>
                    <td class="tradingPos">${mFmtTradingPct(avgGanProfit)}</td>
                    <td class="tradingPos">${avgRoiProfit >= 0 ? "+" : ""}${avgRoiProfit.toFixed(1).replace(".", ",")}%</td>
                </tr>
                <tr>
                    <td><span class="tradingResultBadge tradingPerdida" style="font-size:12px">PÉRDIDA</span></td>
                    <td>${perdidaRows.length}</td>
                    <td class="tradingNeg">${mFmtTradingPct(avgGanLoss)}</td>
                    <td class="tradingNeg">${avgRoiLoss >= 0 ? "+" : ""}${avgRoiLoss.toFixed(1).replace(".", ",")}%</td>
                </tr>
            </tbody>
        </table>
    `
}

function mRenderTradingRendimiento(rows) {
    const sorted = [...rows].sort((a, b) => {
        const da = String(a.fecha || "").split(/[-/]/).reverse().join("")
        const db = String(b.fecha || "").split(/[-/]/).reverse().join("")
        return da.localeCompare(db)
    })

    let acumulado = 0
    const labels = []
    const data = []

    sorted.forEach((r, i) => {
        const val = mParseTradingPct(r.ganancia) || 0
        acumulado += val
        labels.push(r.fecha || `#${i + 1}`)
        data.push(parseFloat(acumulado.toFixed(4)))
    })

    const positiveColor = "#2ecc71"
    const negativeColor = "#e74c3c"

    mCreateChart("mChartTradingRendimiento", {
        type: "line",
        data: {
            labels,
            datasets: [{
                label: "Rendimiento neto acumulado (%)",
                data,
                borderColor: positiveColor,
                backgroundColor: "rgba(46,204,113,0.08)",
                borderWidth: 2,
                pointRadius: data.length > 50 ? 0 : 3,
                pointHoverRadius: 5,
                tension: 0.35,
                fill: true,
                segment: {
                    borderColor: (ctx) => ctx.p1.parsed.y >= 0 ? positiveColor : negativeColor
                }
            }]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.raw >= 0 ? "+" : ""}${c.raw.toFixed(2).replace(".", ",")}%`
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: "#8899bb", maxTicksLimit: 12, maxRotation: 45 },
                    grid:  { color: "rgba(255,255,255,0.06)" }
                },
                y: {
                    ticks: {
                        color: "#ccd6f6",
                        callback: (v) => (v >= 0 ? "+" : "") + v.toFixed(1) + "%"
                    },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            }
        }
    })
}

// ──────────────────────────────────────────────────────────────────────────

async function initMetricasLogic() {
    Object.values(_metricasCharts).forEach((c) => c?.destroy())
    _metricasCharts = {}
    _metricasDisplayType  = window._metricasDisplayType ?? "doughnut"
    _metricasDistMetric   = window._metricasDistMetric  ?? "netoActualEur"
    _metricasGastosMonth  = "all"
    _metricasIngresosMonth = "all"
    _metricasInteresesYear = null
    _metricasDivMensualYear = null
    const _allActivosTypes = ["cripto","acciones","etfs","comoditis","bonos","rentaFija"]
    const _savedHidden = window._metricasActivosHidden || []
    _metricasActivosFilter = new Set(_allActivosTypes.filter(t => !_savedHidden.includes(t)))
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
        mInitEvolucion()

        const _allTypes = ["cripto","acciones","etfs","comoditis","bonos","rentaFija"]
        const _todosBtn = document.querySelector(".mActivosFilterBtn[data-atype='todos']")
        const _specificBtns = [...document.querySelectorAll(".mActivosFilterBtn[data-atype]:not([data-atype='todos'])")]

        function _mIsTodosMode() {
            return _allTypes.every(t => _metricasActivosFilter.has(t))
        }

        function _mActivosApplyVisual() {
            const todosMode = _mIsTodosMode()
            const todosInput = _todosBtn?.querySelector("input")
            if (todosInput) todosInput.checked = todosMode
            _specificBtns.forEach(b => {
                const inp = b.querySelector("input")
                if (inp) inp.checked = !todosMode && _metricasActivosFilter.has(b.dataset.atype)
            })
        }

        function _mActivosSave() {
            const hidden = _allTypes.filter(t => !_metricasActivosFilter.has(t))
            window._metricasActivosHidden = hidden
            fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metricasActivosHidden: hidden }) }).catch(() => {})
        }

        function _mActivosRender() {
            mRenderDistActivos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [], _metricasDistMetric)
        }

        _mActivosApplyVisual()

        if (_todosBtn) {
            const todosInput = _todosBtn.querySelector("input")
            if (todosInput) {
                todosInput.addEventListener("change", () => {
                    _allTypes.forEach(t => _metricasActivosFilter.add(t))
                    _mActivosApplyVisual()
                    _mActivosSave()
                    _mActivosRender()
                })
            }
        }

        _specificBtns.forEach(btn => {
            const inp = btn.querySelector("input")
            if (inp) {
                inp.addEventListener("change", () => {
                    const tipo = btn.dataset.atype
                    if (_mIsTodosMode()) {
                        _metricasActivosFilter.clear()
                        _metricasActivosFilter.add(tipo)
                    } else if (!inp.checked) {
                        _metricasActivosFilter.delete(tipo)
                        if (_metricasActivosFilter.size === 0) _allTypes.forEach(t => _metricasActivosFilter.add(t))
                    } else {
                        _metricasActivosFilter.add(tipo)
                    }
                    _mActivosApplyVisual()
                    _mActivosSave()
                    _mActivosRender()
                })
            }
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

        // ── nav tabs (single-select) ─────────────────────────────────────
        const navTabsContainer = document.querySelector(".mNavTabs")
        const todoInput = navTabsContainer?.querySelector('.mNavTab[data-mcat="todo"] input')
        let _mActiveCats = new Set()

        function mApplyNavFilter() {
            document.querySelectorAll(".metricasSection[data-mcat], .metricasKpiRow[data-mcat]").forEach(el => {
                const elCat    = el.dataset.mcat
                const catMatch = _mActiveCats.size === 0 || [..._mActiveCats].some(c => elCat === c)
                el.style.display = catMatch ? "" : "none"
            })
        }

        navTabsContainer?.addEventListener("change", (e) => {
            const input = e.target
            if (!input.matches('input[type="checkbox"]')) return
            const tab = input.closest(".mNavTab")
            if (!tab) return
            const mcat = tab.dataset.mcat
            const allInputs = navTabsContainer.querySelectorAll(".mNavTab input")
            if (mcat === "todo") {
                if (!input.checked) input.checked = true
                _mActiveCats.clear()
                allInputs.forEach(i => { if (i !== input) i.checked = false })
                mApplyNavFilter()
            } else if (input.checked) {
                allInputs.forEach(i => { if (i !== input) i.checked = false })
                _mActiveCats = new Set(mcat.split(",").map(s => s.trim()))
                mApplyNavFilter()
                // scroll to first visible KPI row of this category
                const firstCat = mcat.split(",")[0].trim()
                const target   = document.querySelector(`.metricasKpiRow[data-mcat="${mcat}"]`)
                              || document.querySelector(`.metricasKpiRow[data-mcat="${firstCat}"]`)
                const scrollEl = document.querySelector(".mainContent")
                if (target && scrollEl) {
                    const navH = document.querySelector(".mNavBar")?.offsetHeight || 60
                    const top  = target.getBoundingClientRect().top
                               - scrollEl.getBoundingClientRect().top
                               + scrollEl.scrollTop - navH - 8
                    scrollEl.scrollTo({ top, behavior: "smooth" })
                }
            } else {
                if (todoInput) todoInput.checked = true
                _mActiveCats.clear()
                mApplyNavFilter()
            }
        })

    } catch (err) {
        console.error("Error cargando métricas:", err)
        if (loading) loading.textContent = "Error al cargar los datos."
    }
}

// ── Evolución histórica del portfolio ──────────────────────────────────────

let _evolucionRange = "1D"

async function mRenderEvolucion(range) {
    const empty = document.getElementById("mEvolucionEmpty")
    const wrap  = document.getElementById("mEvolucionChartWrap")

    let resp, data
    try {
        resp = await fetch(`/api/portfolio/history?range=${range}`)
        data = await resp.json()
    } catch (_) {
        return
    }

    let points = Array.isArray(data.data) ? data.data : []

    // Append live current values as the final point so the chart always ends
    // matching the KPI cards (snapshots are saved periodically and may be stale).
    if (_metricasPayload) {
        const { summaries } = _metricasPayload
        const liveValue    = summaries.reduce((s, a) => s + a.netoActualEur, 0)
        const liveInvested = summaries.reduce((s, a) => s + a.invertidoEur, 0)
        const nowTs = Math.floor(Date.now() / 1000)
        const lastTs = points.length ? points[points.length - 1].ts : 0
        // Replace last point if it's within 2 minutes, otherwise append
        if (points.length && (nowTs - lastTs) < 120) {
            points = [...points.slice(0, -1), { ts: nowTs, v: liveValue, i: liveInvested }]
        } else {
            points = [...points, { ts: nowTs, v: liveValue, i: liveInvested }]
        }
    }

    if (points.length < 2) {
        if (empty) empty.classList.remove("hidden")
        if (wrap)  wrap.classList.add("hidden")
        mDestroyChart("mChartEvolucion")
        return
    }

    if (empty) empty.classList.add("hidden")
    if (wrap)  wrap.classList.remove("hidden")

    const values   = points.map(p => p.v)
    const invested = points.map(p => p.i)
    const span     = points.length > 1 ? (points[points.length - 1].ts - points[0].ts) : 0
    const isLong   = span > 7 * 86400

    // Round interval for axis labels so ticks land on clean boundaries
    let roundSec
    if      (span <= 86400)           roundSec = 300        // ≤1D  → cada 5 min
    else if (span <= 31 * 86400)      roundSec = 21600      // ≤1M  → cada 6h
    else if (span <= 365 * 86400)     roundSec = 86400      // ≤1A  → cada día
    else                              roundSec = 7 * 86400  // >1A  → cada semana

    const labels = points.map(p => {
        const snap = Math.round(p.ts / roundSec) * roundSec
        const d    = new Date(snap * 1000)
        if (roundSec >= 86400)
            return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", ...(roundSec >= 7 * 86400 ? { year: "2-digit" } : {}) })
        return d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" })
               + " " + d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
    })

    const first = values[0]
    const last  = values[values.length - 1]
    const isUp  = last >= first
    const lineColor = isUp ? "#2ecc71" : "#e74c3c"
    const fillColor = isUp ? "rgba(46,204,113,0.10)" : "rgba(231,76,60,0.10)"

    const tooltipDates = points.map(p => {
        const d = new Date(p.ts * 1000)
        return d.toLocaleString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    })

    mCreateChart("mChartEvolucion", {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Valor total",
                    data: values,
                    borderColor: lineColor,
                    backgroundColor: fillColor,
                    borderWidth: 2,
                    pointRadius: points.length <= 60 ? 3 : 0,
                    pointHoverRadius: 5,
                    fill: true,
                    tension: 0.3
                },
                {
                    label: "Invertido",
                    data: invested,
                    borderColor: "rgba(100,130,200,0.7)",
                    backgroundColor: "transparent",
                    borderWidth: 1.5,
                    borderDash: [5, 4],
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointStyle: "line",
                    fill: false,
                    tension: 0.3
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: {
                    labels: { color: "#ccd6f6", font: { size: 12 }, padding: 14, boxWidth: 30, usePointStyle: true }
                },
                tooltip: {
                    callbacks: {
                        title(items) {
                            return tooltipDates[items[0].dataIndex] || ""
                        },
                        label(item) {
                            return ` ${item.dataset.label}: ${formatEuro(item.parsed.y)}`
                        },
                        afterBody(items) {
                            if (items.length < 2) return []
                            const val  = items[0].parsed.y
                            const inv  = items[1].parsed.y
                            const rend = val - inv
                            const pct  = inv > 0 ? ((rend / inv) * 100).toFixed(2) : "0,00"
                            const sign = rend >= 0 ? "+" : ""
                            return [` Rendimiento: ${sign}${formatEuro(rend)} (${sign}${pct.replace(".", ",")}%)`]
                        }
                    }
                }
            },
            scales: {
                x: {
                    ticks: { color: "#8899bb", maxTicksLimit: 8, maxRotation: 0 },
                    grid:  { color: "rgba(255,255,255,0.06)" }
                },
                y: {
                    ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) },
                    grid:  { color: "rgba(255,255,255,0.06)" }
                }
            }
        }
    })
}

function mInitEvolucion() {
    const rangeBtns = document.querySelectorAll(".mEvolucionRangeBtn")
    rangeBtns.forEach(btn => {
        btn.classList.toggle("active", btn.dataset.range === _evolucionRange)
        btn.addEventListener("click", () => {
            rangeBtns.forEach(b => b.classList.remove("active"))
            btn.classList.add("active")
            _evolucionRange = btn.dataset.range
            mRenderEvolucion(_evolucionRange)
        })
    })
    mRenderEvolucion(_evolucionRange)
}
