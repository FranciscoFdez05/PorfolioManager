let _metricasCharts = {}
let _metricasDisplayType = "doughnut"
let _metricasPayload = null
let _metricasSortKey = "netoActualEur"
let _metricasSortDir = "desc"

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

    const [divResp, intResp, bonosResp, rfResp] = await Promise.all([
        fetch("/api/dividendos"),
        fetch("/api/intereses"),
        fetch("/api/bonos"),
        fetch("/api/rentafija")
    ])
    const divData   = await divResp.json()
    const intData   = await intResp.json()
    const bonosData = await bonosResp.json()
    const rfData    = await rfResp.json()

    return {
        summaries,
        dividendos: Array.isArray(divData.rows)   ? divData.rows   : [],
        intereses:  Array.isArray(intData.rows)    ? intData.rows   : [],
        bonos:      Array.isArray(bonosData.rows)  ? bonosData.rows : [],
        rentaFija:  Array.isArray(rfData.rows)     ? rfData.rows    : []
    }
}

// ── KPI cards ──────────────────────────────────────────────────────────────

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
}

// ── charts ─────────────────────────────────────────────────────────────────

function mRenderDistTipos(summaries, displayType, bonos = [], rentaFija = []) {
    const types  = ["cripto", "acciones", "etfs", "comoditis"]
    const bonosTotal = bonos.reduce((s, r) => s + Math.max(0, parseEuroNumber(r.invertido || "")), 0)
    const rfTotal    = rentaFija.reduce((s, r) => s + Math.max(0, parseEuroNumber(r.invertido || "")), 0)
    const labels = [...types.map((t) => M_TYPE_LABELS[t]), "Bonos", "Renta Fija"]
    const values = [
        ...types.map((t) => summaries.filter((a) => a.type === t).reduce((s, a) => s + Math.max(0, a.netoActualEur), 0)),
        bonosTotal,
        rfTotal
    ]
    const colors = [...types.map((t) => M_TYPE_COLORS[t]), "#9b59b6", "#00bcd4"]
    const total  = values.reduce((a, b) => a + b, 0)

    if (displayType === "doughnut") {
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
        mCreateChart("mChartTipos", {
            type: "bar",
            data: {
                labels,
                datasets: [{
                    label: "Valor actual (€)",
                    data: values,
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

function mRenderDistActivos(summaries, displayType, bonos = [], rentaFija = []) {
    const bonosMap = {}
    bonos.forEach((r) => {
        const name = r.instrumento || "Bono"
        bonosMap[name] = (bonosMap[name] || 0) + Math.max(0, parseEuroNumber(r.invertido || ""))
    })
    const rfMap = {}
    rentaFija.forEach((r) => {
        const name = r.instrumento || "Renta Fija"
        rfMap[name] = (rfMap[name] || 0) + Math.max(0, parseEuroNumber(r.invertido || ""))
    })
    const extras = [
        ...Object.entries(bonosMap).map(([name, val]) => ({ name, netoActualEur: val })),
        ...Object.entries(rfMap).map(([name, val]) => ({ name, netoActualEur: val }))
    ]
    const sorted = [...summaries, ...extras].sort((a, b) => b.netoActualEur - a.netoActualEur)
    const labels = sorted.map((a) => a.name)
    const values = sorted.map((a) => Math.max(0, a.netoActualEur))
    const colors = labels.map((_, i) => M_PALETTE[i % M_PALETTE.length])
    const total  = values.reduce((a, b) => a + b, 0)

    if (displayType === "doughnut") {
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
                    label: "Valor actual (€)",
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
                scales: { x: mAxisX(), y: mAxisY(11) }
            }
        })
    }
}

function mRenderRendTipos(summaries) {
    const types  = ["cripto", "acciones", "etfs", "comoditis"]
    const labels = types.map((t) => M_TYPE_LABELS[t])
    const values = types.map((t) =>
        summaries.filter((a) => a.type === t).reduce((s, a) => s + a.rendimientoEur, 0)
    )
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

// ── main init ──────────────────────────────────────────────────────────────

function mRenderAll(payload) {
    const { summaries, dividendos, bonos, rentaFija } = payload
    const b = bonos || [], rf = rentaFija || []
    mRenderDistTipos(summaries, _metricasDisplayType, b, rf)
    mRenderDistActivos(summaries, _metricasDisplayType, b, rf)
    mRenderRendTipos(summaries)
    mRenderRendActivos(summaries)
    mRenderDividendos(dividendos)
    mRenderBonosTipos(b)
    mRenderBonosInst(b)
    mRenderRentaFijaTipos(rf)
    mRenderRentaFijaInst(rf)
    mRenderTopTable(summaries)
}

async function initMetricasLogic() {
    Object.values(_metricasCharts).forEach((c) => c?.destroy())
    _metricasCharts = {}
    _metricasDisplayType = "doughnut"
    _metricasPayload = null

    const loading = document.getElementById("metricasLoading")

    try {
        _metricasPayload = await buildMetricasPayload()
        if (loading) loading.classList.add("hidden")

        mUpdateKpis(_metricasPayload)
        mRenderAll(_metricasPayload)
        mBindTableSort(_metricasPayload.summaries)

        const toggleBtns = document.querySelectorAll(".mToggleBtn")
        toggleBtns.forEach((btn) => {
            btn.addEventListener("click", () => {
                toggleBtns.forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDisplayType = btn.dataset.charttype
                mRenderDistTipos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [])
                mRenderDistActivos(_metricasPayload.summaries, _metricasDisplayType, _metricasPayload.bonos || [], _metricasPayload.rentaFija || [])
            })
        })
    } catch (err) {
        console.error("Error cargando métricas:", err)
        if (loading) loading.textContent = "Error al cargar los datos."
    }
}
