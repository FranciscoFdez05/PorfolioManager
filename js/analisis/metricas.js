// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasCharts = {}

window._resizeChartsOnSidebarChange = function () {
    Object.values(_metricasCharts).forEach((c) => {
        try {
            c.resize()
        } catch (_) {}
    })
}

// Estos tres nombres existen dos veces a propósito: js/core/app-core.js escribe
// `window._metricasDisplayType` (y compañía) al cargar los ajustes del
// servidor, y aquí se declaran con `let`, lo que crea un binding léxico global
// que NO es la misma casilla que la propiedad de window. El puente lo hace a
// mano mLoadPreferencias(), que copia window.* a estas variables. Se deja como
// está —cambiarlo es tocar el arranque de la pantalla entera— pero conviene
// saberlo antes de tocar cualquiera de los dos lados.
// eslint-disable-next-line no-redeclare, prefer-const -- se reasigna desde otro trozo del módulo
let _metricasDisplayType = "doughnut"
// eslint-disable-next-line no-redeclare, prefer-const -- se reasigna desde otro trozo del módulo
let _metricasDistMetric = "netoActualEur"
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasGastosMonth = getChartPref("metricasGastosMonth", "all")
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasIngresosMonth = getChartPref("metricasIngresosMonth", "all")
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasSaldoMesMonth = getChartPref("metricasSaldoMesMonth", null)
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _mSaldoMesCache = null
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasSaldoMesCuenta = getChartPref("metricasSaldoMesCuenta", "all")
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasPayload = null
// Transferencias entre cuentas: mueven el saldo de la cuenta bancaria sin ser gasto ni ingreso.
let _metricasTransferencias = []
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasSortKey = getChartPref("metricasSortKey", "netoActualEur")
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasSortDir = getChartPref("metricasSortDir", "desc")
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasActivosFilter = new Set(["cripto", "acciones", "etfs", "comoditis", "rentaFija"])
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasGastosTipoFilter = new Set()
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasComparativaExclude = new Set()
// eslint-disable-next-line no-redeclare, prefer-const -- ver la nota de _metricasDisplayType; se reasigna desde otro trozo
let _metricasSectionsCollapsed = new Set()
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _mGastosChartsCache = null

const M_GASTOS_KEYS = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre"
]
const M_GASTOS_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]

const _M_ES_MONTH_MAP = {
    ene: 1,
    feb: 2,
    mar: 3,
    abr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    ago: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dic: 12,
    div: 12,
    enero: 1,
    febrero: 2,
    marzo: 3,
    abril: 4,
    mayo: 5,
    junio: 6,
    julio: 7,
    agosto: 8,
    septiembre: 9,
    octubre: 10,
    noviembre: 11,
    diciembre: 12
}
function mParseEsMonth(s) {
    return _M_ES_MONTH_MAP[String(s || "").toLowerCase()] || 0
}
function mParseShortYear(y) {
    const n = parseInt(y)
    return isNaN(n) ? null : n < 100 ? 2000 + n : n
}

const M_PALETTE = [
    "#3a7bd5",
    "#f7931a",
    "#2ecc71",
    "#e74c3c",
    "#9b59b6",
    "#1abc9c",
    "#e67e22",
    "#00bcd4",
    "#8bc34a",
    "#ff5722",
    "#e91e63",
    "#673ab7",
    "#607d8b",
    "#f39c12",
    "#795548",
    "#26c6da",
    "#66bb6a",
    "#ef5350",
    "#ab47bc",
    "#ffa726"
]

function mPaletteForName(name) {
    let h = 0
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
    return M_PALETTE[h % M_PALETTE.length]
}

const M_TYPE_COLORS = {
    cripto: "#f7931a",
    acciones: "#3a7bd5",
    etfs: "#2ecc71",
    comoditis: "#e0c068",
    rentaFija: "#00bcd4"
}

const M_TYPE_LABELS = {
    cripto: "Cripto",
    acciones: "Acciones",
    etfs: "ETFs",
    comoditis: "Comoditis",
    rentaFija: "Renta Fija"
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

// Iguala el alto de las dos tarjetas de cada fila de gráficos: si una trae
// una cabecera extra (toggle de meses, filtros de tipo...) que la otra no
// tiene, su canvas queda más bajo sin ningún motivo relacionado con los
// datos. Solo actúa en las filas marcadas con "mChartsGridEqualize" en el
// HTML — las que tienen un gráfico "dinámico" de verdad (crece con el número
// de filas, como Renta Fija/Bonos por instrumento o Rendimiento por activo:
// también usan la clase metricasChartDynamic, pero ahí para el alto mínimo,
// no para marcar que haya que igualar) se quedan fuera a propósito, porque
// estirar la tarjeta corta dejaría un hueco vacío debajo — el motivo del
// align-items:start de .metricasChartsGrid2 en metricas.css.
function mEqualizeChartRowHeights() {
    document.querySelectorAll(".metricasChartsGrid2.mChartsGridEqualize").forEach((grid) => {
        const cards = [...grid.children].filter((c) => c.classList.contains("metricasChartCard"))
        if (cards.length !== 2) return
        if (cards.some((c) => c.offsetParent === null)) return

        const wraps = cards.map((c) => c.querySelector(".metricasChartWrap"))
        if (wraps.some((w) => !w)) return

        // Vuelve a su alto base antes de medir: si no, un ajuste de una
        // renderización anterior (otro año, otro mes, otra leyenda) se queda
        // pegado aunque ya no haga falta.
        wraps.forEach((w) => {
            if (w.dataset.mBaseHeight === undefined) w.dataset.mBaseHeight = w.style.height || ""
            w.style.height = w.dataset.mBaseHeight
        })

        const heights = cards.map((c) => c.getBoundingClientRect().height)
        const diff = Math.round(Math.abs(heights[0] - heights[1]))
        if (diff < 2) return

        const shortIdx = heights[0] < heights[1] ? 0 : 1
        const wrap = wraps[shortIdx]
        const current = wrap.getBoundingClientRect().height
        wrap.style.height = Math.round(current + diff) + "px"

        const canvas = wrap.querySelector("canvas")
        if (canvas?.id && _metricasCharts[canvas.id]) _metricasCharts[canvas.id].resize()
    })
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
        grid: { color: "rgba(255,255,255,0.06)" }
    }
}
function mAxisY(fontSize = 12) {
    return {
        ticks: { color: "#ccd6f6", font: { size: fontSize } },
        grid: { display: false }
    }
}

// ── data fetching ──────────────────────────────────────────────────────────

async function buildMetricasPayload() {
    const baseAssets = await loadAssetsList()
    const fullAssets = await Promise.all(baseAssets.map((a) => loadAssetData(a.id)))

    const summaries = await Promise.all(
        fullAssets.map(async (asset) => {
            const row = await buildOverviewRow(asset)
            const euros = await buildSummaryMetricsInEuros(row)
            return {
                name: asset.name || asset.symbol || "Activo",
                type: asset.type || "acciones",
                color: asset.color || "",
                netoActualEur: euros.netoActualEur,
                invertidoEur: euros.invertidoBrutoEur,
                rendimientoEur: euros.rendimientoEur
            }
        })
    )

    // TWR/XIRR/drawdown los calcula el servidor sobre el histórico completo,
    // pero el último punto guardado puede tener minutos: se le pasa el valor
    // vivo para que las cifras cuadren con las KPIs de arriba.
    const liveValue = summaries.reduce((s, a) => s + a.netoActualEur, 0)
    const liveInvested = summaries.reduce((s, a) => s + a.invertidoEur, 0)
    const rentabilidadUrl =
        `/api/portfolio/rentabilidad?value=${encodeURIComponent(liveValue.toFixed(2))}` +
        `&invested=${encodeURIComponent(liveInvested.toFixed(2))}`

    const [
        divResp,
        intResp,
        bonosResp,
        rfResp,
        gastosYearsResp,
        ingresosYearsResp,
        tradingResp,
        snapshotResp,
        inversionesResp,
        pmResp,
        settingsResp,
        rentResp
    ] = await Promise.all([
        fetch("/api/dividendos"),
        fetch("/api/intereses"),
        fetch("/api/bonos"),
        fetch("/api/rentafija"),
        fetch("/api/gastos").catch(() => null),
        fetch("/api/ingresos").catch(() => null),
        fetch("/api/trading").catch(() => null),
        fetch("/api/portfolio/history?range=ALL").catch(() => null),
        fetch("/api/metricas/inversiones").catch(() => null),
        fetch("/api/privatemarket").catch(() => null),
        fetch("/api/settings").catch(() => null),
        fetch(rentabilidadUrl).catch(() => null)
    ])
    const divData = await divResp.json()
    const intData = await intResp.json()
    const bonosData = await bonosResp.json()
    const rfData = await rfResp.json()

    const transferenciasResp = await fetch("/api/transferencias").catch(() => null)
    const transferenciasData = transferenciasResp ? await transferenciasResp.json().catch(() => null) : null
    _metricasTransferencias = Array.isArray(transferenciasData?.transferencias) ? transferenciasData.transferencias : []

    // Los popups muestran la cuenta de cada movimiento: hace falta su nombre.
    if (!window._cuentasDinero.length) await cargarCuentasDinero()

    const gastosYearsData = gastosYearsResp ? await gastosYearsResp.json().catch(() => ({ years: [] })) : { years: [] }
    const gastosYearsList = Array.isArray(gastosYearsData.years) ? gastosYearsData.years : []
    // Si el usuario dejó seleccionado otro año, se carga ese en vez del último.
    const prefGastosYear = getChartPref("metricasGastosYear", null)
    const gastosYear = gastosYearsList.map(String).includes(String(prefGastosYear))
        ? prefGastosYear
        : gastosYearsList[0] || null
    const gastosYearData = gastosYear
        ? await fetch(`/api/gastos/${gastosYear}`)
              .then((r) => r.json())
              .catch(() => null)
        : null

    const ingresosYearsData = ingresosYearsResp
        ? await ingresosYearsResp.json().catch(() => ({ years: [] }))
        : { years: [] }
    const ingresosYearsList = Array.isArray(ingresosYearsData.years) ? ingresosYearsData.years : []
    const prefIngresosYear = getChartPref("metricasIngresosYear", null)
    const ingresosYear = ingresosYearsList.map(String).includes(String(prefIngresosYear))
        ? prefIngresosYear
        : ingresosYearsList[0] || null
    const ingresosYearData = ingresosYear
        ? await fetch(`/api/ingresos/${ingresosYear}`)
              .then((r) => r.json())
              .catch(() => null)
        : null

    // Resumen anual: hacen falta todos los años, no solo el seleccionado en los
    // toggles. Se reaprovecha el año ya descargado para no pedirlo dos veces.
    const anualYears = [...new Set([...gastosYearsList, ...ingresosYearsList].map(Number))]
        .filter((y) => Number.isFinite(y))
        .sort((a, b) => a - b)
    const anualData = await Promise.all(
        anualYears.map(async (y) => {
            const [gastos, ingresos] = await Promise.all([
                gastosYearsList.map(String).includes(String(y))
                    ? String(y) === String(gastosYear)
                        ? gastosYearData
                        : fetch(`/api/gastos/${y}`)
                              .then((r) => r.json())
                              .catch(() => null)
                    : null,
                ingresosYearsList.map(String).includes(String(y))
                    ? String(y) === String(ingresosYear)
                        ? ingresosYearData
                        : fetch(`/api/ingresos/${y}`)
                              .then((r) => r.json())
                              .catch(() => null)
                    : null
            ])
            return { year: y, gastosData: gastos, ingresosData: ingresos }
        })
    )

    const tradingData = tradingResp ? await tradingResp.json().catch(() => ({ rows: [] })) : { rows: [] }
    const snapshotData = snapshotResp ? await snapshotResp.json().catch(() => ({ data: [] })) : { data: [] }
    const inversionesData = inversionesResp
        ? await inversionesResp.json().catch(() => ({ byMonth: {}, byYear: {} }))
        : { byMonth: {}, byYear: {} }
    const pmData = pmResp ? await pmResp.json().catch(() => ({ rows: [] })) : { rows: [] }
    const settingsData = settingsResp ? await settingsResp.json().catch(() => ({})) : {}
    const rentData = rentResp ? await rentResp.json().catch(() => null) : null
    const ahorroConfig = settingsData.ahorroConfig || { objetivoAhorro: 30, presupuesto: {} }

    return {
        summaries,
        dividendos: Array.isArray(divData.rows) ? divData.rows : [],
        intereses: Array.isArray(intData.cuentas)
            ? intData.cuentas.flatMap((c) => (Array.isArray(c.rows) ? c.rows : []))
            : Array.isArray(intData.rows)
              ? intData.rows
              : [],
        cuentasRemuneradas: Array.isArray(intData.cuentas) ? intData.cuentas : [],
        bonos: Array.isArray(bonosData.rows) ? bonosData.rows : [],
        rentaFija: Array.isArray(rfData.rows) ? rfData.rows : [],
        privateMarket: Array.isArray(pmData.rows) ? pmData.rows : [],
        gastosYearsList,
        gastosYearData,
        ingresosYearsList,
        ingresosYearData,
        anualData,
        tradingRows: Array.isArray(tradingData.rows) ? tradingData.rows : [],
        snapshotHistory: Array.isArray(snapshotData.data) ? snapshotData.data : [],
        rentabilidad: rentData?.ok ? rentData : null,
        inversiones: inversionesData,
        ahorroConfig
    }
}

// ── KPI cards ──────────────────────────────────────────────────────────────

function mSyncTopBar(summaries, rendimiento, invertido, totalCuenta) {
    const topSet = (id, val) => {
        const el = document.getElementById(id)
        if (el) el.textContent = val
    }
    topSet("topTotalCuenta", formatEuro(totalCuenta))
    topSet("topRendimientoEuros", formatEuro(rendimiento))
    topSet("topPorcentajeCuenta", formatPercent(invertido > 0 ? (rendimiento / invertido) * 100 : 0))

    const typeMap = { cripto: "Cripto", acciones: "Acciones", etfs: "Etf", comoditis: "Comoditis" }
    Object.entries(typeMap).forEach(([type, suffix]) => {
        const group = summaries.filter((a) => a.type === type)
        const neto = group.reduce((s, a) => s + a.netoActualEur, 0)
        const inv = group.reduce((s, a) => s + a.invertidoEur, 0)
        const rend = group.reduce((s, a) => s + a.rendimientoEur, 0)
        topSet(`topEuros${suffix}`, formatEuro(neto))
        topSet(`topPorcentaje${suffix}`, formatPercent(inv > 0 ? (rend / inv) * 100 : 0))
    })
}

function mUpdateKpis(payload) {
    const { summaries, dividendos, intereses, bonos, rentaFija, privateMarket, tradingRows } = payload

    const tRows = Array.isArray(tradingRows) ? tradingRows : []
    if (tRows.length) {
        const tProfits = tRows.filter((r) => r.resultado === "PROFIT").length
        const tLosses = tRows.filter((r) => r.resultado === "PÉRDIDA").length
        const winRate = tRows.length > 0 ? (tProfits / tRows.length) * 100 : 0
        const gananciaTotal = tRows.reduce((s, r) => {
            const v = parseFloat(
                String(r.ganancia || "")
                    .replace(",", ".")
                    .replace("%", "")
            )
            return s + (isNaN(v) ? 0 : v)
        }, 0)
        const roiMedio =
            tRows.reduce((s, r) => {
                const v = parseFloat(
                    String(r.roi || "")
                        .replace(",", ".")
                        .replace("%", "")
                )
                return s + (isNaN(v) ? 0 : v)
            }, 0) / (tRows.length || 1)

        mSetKpi("mkpiTradingTotal", String(tRows.length))
        mSetKpi("mkpiTradingProfits", String(tProfits), "mPositive")
        mSetKpi("mkpiTradingLosses", String(tLosses), "mNegative")
        mSetKpi(
            "mkpiTradingWinRate",
            winRate.toFixed(1).replace(".", ",") + "%",
            winRate >= 50 ? "mPositive" : "mNegative"
        )
        mSetKpi(
            "mkpiTradingGanancia",
            (gananciaTotal >= 0 ? "+" : "") + gananciaTotal.toFixed(2).replace(".", ",") + "%",
            gananciaTotal >= 0 ? "mPositive" : "mNegative"
        )
        mSetKpi(
            "mkpiTradingRoiMedio",
            (roiMedio >= 0 ? "+" : "") + roiMedio.toFixed(1).replace(".", ",") + "%",
            roiMedio >= 0 ? "mPositive" : "mNegative"
        )
    }

    const totalCuenta = summaries.reduce((s, a) => s + a.netoActualEur, 0)
    const invertido = summaries.reduce((s, a) => s + a.invertidoEur, 0)
    const rendimiento = totalCuenta - invertido
    const rendPct = invertido > 0 ? (rendimiento / invertido) * 100 : 0
    const totalDiv = dividendos.reduce((s, r) => s + parseEuroNumber(r.total || ""), 0)
    const totalInt = intereses.reduce(
        (s, r) => s + parseEuroNumber(r.acumulado || "") - parseEuroNumber(r.impuestos || ""),
        0
    )

    mSetKpi("mkpiTotalCuenta", formatEuro(totalCuenta))
    mSetKpi("mkpiInvertido", formatEuro(invertido))
    mSetKpi("mkpiRendimiento", formatEuro(rendimiento), rendimiento >= 0 ? "mPositive" : "mNegative")
    mSetKpi("mkpiRendPct", formatPercent(rendPct), rendPct >= 0 ? "mPositive" : "mNegative")

    // ── Rendimiento por tipo de activo ───────────────────────────────
    const activosRendContainer = document.getElementById("mkpiActivosRendCards")
    if (activosRendContainer) {
        const TYPE_ORDER = ["acciones", "etfs", "comoditis", "cripto"]
        activosRendContainer.innerHTML = TYPE_ORDER.map((type) => {
            const group = summaries.filter((s) => s.type === type)
            if (!group.length) return ""
            const inv = group.reduce((s, a) => s + a.invertidoEur, 0)
            const rend = group.reduce((s, a) => s + a.rendimientoEur, 0)
            const pct = inv > 0 ? (rend / inv) * 100 : 0
            const cls = pct >= 0 ? "mPositive" : "mNegative"
            const color = M_TYPE_COLORS[type]
            const label = M_TYPE_LABELS[type] || type
            const pctStr = (pct >= 0 ? "+" : "") + pct.toFixed(2).replace(".", ",") + "%"
            const eurStr = (rend >= 0 ? "+" : "") + formatEuro(rend)
            return `<div class="metricasKpiCard mkpiCardActivo" style="border-top-color:${color}" data-kpi="${eurStr}">
                <div class="mkpiLabel mkpiLabelActivo">${label}</div>
                <div class="mkpiValue ${cls}">${pctStr}</div>
            </div>`
        }).join("")
    }

    mSyncTopBar(summaries, rendimiento, invertido, totalCuenta)
    const bonosRows = Array.isArray(bonos) ? bonos : []
    const bonosNeto = bonosRows.reduce(
        (s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""),
        0
    )
    const bonosGub = bonosRows
        .filter((r) => r.tipo === "gubernamental")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const bonosCorp = bonosRows
        .filter((r) => r.tipo === "corporativo")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)

    mSetKpi("mkpiDividendos", formatEuro(totalDiv))
    mSetKpi("mkpiInteres", formatEuro(totalInt))
    mSetKpi("mkpiBonos", formatEuro(bonosNeto))
    mSetKpi("mkpiBonosGub", formatEuro(bonosGub))
    mSetKpi("mkpiBonosCorp", formatEuro(bonosCorp))

    const rfRows = Array.isArray(rentaFija) ? rentaFija : []
    const rfNeto = rfRows.reduce(
        (s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""),
        0
    )

    mSetKpi("mkpiRentaFija", formatEuro(rfNeto))

    const rfGroup = document.querySelector(".mkpiGroupRf")
    if (rfGroup) rfGroup.classList.toggle("hidden", bonosRows.length === 0 && rfRows.length === 0)

    // ── Mercado Privado ───────────────────────────────────────────────
    const pmRows = Array.isArray(privateMarket) ? privateMarket : []
    const pmLlamado = pmRows.reduce((s, r) => s + parseEuroNumber(r.llamado || ""), 0)
    const pmDistribuido = pmRows.reduce((s, r) => s + parseEuroNumber(r.distribuido || ""), 0)
    const pmValorActual = pmRows.reduce((s, r) => s + parseEuroNumber(r.valorActual || ""), 0)
    const pmNeto = pmDistribuido + pmValorActual - pmLlamado
    const pmTvpi = pmLlamado > 0 ? (pmDistribuido + pmValorActual) / pmLlamado : null
    const pmDpi = pmLlamado > 0 ? pmDistribuido / pmLlamado : null
    const pmRvpi = pmLlamado > 0 ? pmValorActual / pmLlamado : null
    const fmtX = (v) => (v !== null ? v.toFixed(2) + "x" : "—")
    mSetKpi("mkpiPmLlamado", formatEuro(pmLlamado))
    mSetKpi("mkpiPmDistribuido", formatEuro(pmDistribuido))
    mSetKpi("mkpiPmValorActual", formatEuro(pmValorActual))
    mSetKpi("mkpiPmNeto", formatEuro(pmNeto), pmNeto >= 0 ? "mPositive" : "mNegative")
    mSetKpi(
        "mkpiPmTvpi",
        fmtX(pmTvpi),
        pmTvpi !== null && pmTvpi >= 1 ? "mPositive" : pmTvpi !== null ? "mNegative" : ""
    )
    mSetKpi("mkpiPmDpi", fmtX(pmDpi))
    mSetKpi("mkpiPmRvpi", fmtX(pmRvpi))
    const pmGroup = document.getElementById("mkpiGroupPm")
    if (pmGroup) pmGroup.classList.toggle("hidden", pmRows.length === 0)

    const ingresosGroup = document.querySelector(".mkpiGroupIngresos")
    if (ingresosGroup) ingresosGroup.classList.toggle("hidden", dividendos.length === 0 && intereses.length === 0)

    // ── Ingresos pasivos totales ───────────────────────────────
    const totalPasivos = totalDiv + totalInt + bonosNeto + rfNeto
    const pasivosYield = totalCuenta > 0 ? (totalPasivos / totalCuenta) * 100 : 0
    mSetKpi("mkpiPasivosTotal", formatEuro(totalPasivos), totalPasivos >= 0 ? "mPositive" : "mNegative")

    // Media mensual y proyección anual — basadas en el rango temporal de dividendos
    const divDates = dividendos
        .map((r) => {
            const p = String(r.fecha || "").split("-")
            if (p.length !== 3) return null
            const mon = mParseEsMonth(p[1]) || parseInt(p[1])
            const yr = mParseShortYear(p[2])
            if (!mon || !yr || mon < 1 || mon > 12) return null
            return new Date(yr, mon - 1, parseInt(p[0]) || 1)
        })
        .filter(Boolean)
        .sort((a, b) => a - b)
    let pasivosPerMes = 0,
        pasivosPerAnio = 0
    if (divDates.length > 0) {
        const now = new Date()
        const meses = Math.max(
            1,
            (now.getFullYear() - divDates[0].getFullYear()) * 12 + (now.getMonth() - divDates[0].getMonth()) + 1
        )
        pasivosPerMes = totalPasivos / meses
        pasivosPerAnio = pasivosPerMes * 12
    } else if (totalPasivos > 0) {
        pasivosPerMes = totalPasivos / 12
        pasivosPerAnio = totalPasivos
    }
    mSetKpi("mkpiPasivosPerMes", formatEuro(pasivosPerMes), pasivosPerMes >= 0 ? "mPositive" : "mNegative")
    mSetKpi("mkpiPasivosPerAnio", formatEuro(pasivosPerAnio), pasivosPerAnio >= 0 ? "mPositive" : "mNegative")

    mSetKpi("mkpiPasivosYield", formatPercent(pasivosYield), pasivosYield > 0 ? "mPositive" : "")
    const pasivosGroup = document.getElementById("mkpiGroupPasivos")
    if (pasivosGroup)
        pasivosGroup.classList.toggle(
            "hidden",
            dividendos.length === 0 && intereses.length === 0 && bonosRows.length === 0 && rfRows.length === 0
        )

    // ── Concentración top 5 ───────────────────────────────────
    const topSet2 = (id, val) => {
        const el = document.getElementById(id)
        if (el) el.textContent = val
    }
    topSet2("topTotalDividendos", formatEuro(totalDiv))
    topSet2("topTotalInteres", formatEuro(totalInt))
    topSet2("topTotalRentaFija", formatEuro(bonosNeto + rfNeto))
}
