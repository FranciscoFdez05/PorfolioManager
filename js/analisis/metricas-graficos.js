// Métricas: gráficos de distribución, dividendos mensuales, bonos y renta fija.
//
// Separado de js/analisis/metricas.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

// ── charts ─────────────────────────────────────────────────────────────────

function mDistMetricLabel(metric) {
    if (metric === "rendimientoEur") return "Rendimiento (€)"
    if (metric === "invertidoEur") return "Invertido (€)"
    return "Valor actual (€)"
}

function mDistAssetVal(a, metric) {
    return metric === "rendimientoEur" ? a.rendimientoEur : metric === "invertidoEur" ? a.invertidoEur : a.netoActualEur
}

function mDistBonoVal(r, metric) {
    return metric === "rendimientoEur"
        ? parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || "")
        : parseEuroNumber(r.invertido || "")
}

function mRenderDistTipos(summaries, displayType, bonos = [], rentaFija = [], metric = "netoActualEur") {
    const types = ["cripto", "acciones", "etfs", "comoditis"]
    const rfTotal =
        bonos.reduce((s, r) => s + mDistBonoVal(r, metric), 0) +
        rentaFija.reduce((s, r) => s + mDistBonoVal(r, metric), 0)
    const labels = [...types.map((t) => M_TYPE_LABELS[t]), "Renta Fija"]
    const rawValues = [
        ...types.map((t) => summaries.filter((a) => a.type === t).reduce((s, a) => s + mDistAssetVal(a, metric), 0)),
        rfTotal
    ]
    const colors = [...types.map((t) => M_TYPE_COLORS[t]), "#00bcd4"]

    if (displayType === "doughnut") {
        const values = rawValues.map((v) => Math.max(0, v))
        const total = values.reduce((a, b) => a + b, 0)
        mCreateChart("mChartTipos", {
            type: "doughnut",
            data: {
                labels,
                datasets: [
                    {
                        data: values,
                        backgroundColor: colors,
                        borderColor: "#0b1120",
                        borderWidth: 3,
                        hoverOffset: 10
                    }
                ]
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
                datasets: [
                    {
                        label: mDistMetricLabel(metric),
                        data: rawValues,
                        backgroundColor: colors.map((c) => c + "cc"),
                        borderColor: colors,
                        borderWidth: 1,
                        borderRadius: 6
                    }
                ]
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
    if (_metricasActivosFilter.has("rentaFija")) {
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
        ...summaries
            .filter((a) => _metricasActivosFilter.has(a.type))
            .map((a) => ({ name: a.name, _val: mDistAssetVal(a, metric), color: a.color || "" })),
        ...extras
    ].sort((a, b) => b._val - a._val)

    const labels = allItems.map((a) => a.name)
    const rawValues = allItems.map((a) => a._val)
    const colors = allItems.map((item, i) => item.color || M_PALETTE[i % M_PALETTE.length])

    if (displayType === "doughnut") {
        const values = rawValues.map((v) => Math.max(0, v))
        const total = values.reduce((a, b) => a + b, 0)
        mCreateChart("mChartActivos", {
            type: "doughnut",
            data: {
                labels,
                datasets: [
                    {
                        data: values,
                        backgroundColor: colors,
                        borderColor: "#0b1120",
                        borderWidth: 2,
                        hoverOffset: 10
                    }
                ]
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
                datasets: [
                    {
                        label: mDistMetricLabel(metric),
                        data: rawValues,
                        backgroundColor: colors.map((c) => c + "bb"),
                        borderColor: colors,
                        borderWidth: 1,
                        borderRadius: 4
                    }
                ]
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

    mEqualizeChartRowHeights()
}

function mRenderRendTipos(summaries) {
    const types = ["cripto", "acciones", "etfs", "comoditis"]
    const pairs = types
        .map((t) => ({
            label: M_TYPE_LABELS[t],
            value: summaries.filter((a) => a.type === t).reduce((s, a) => s + a.rendimientoEur, 0)
        }))
        .sort((a, b) => b.value - a.value)
    const labels = pairs.map((p) => p.label)
    const values = pairs.map((p) => p.value)
    const colors = values.map((v) => (v >= 0 ? "#2ecc71cc" : "#e74c3ccc"))
    const borders = values.map((v) => (v >= 0 ? "#2ecc71" : "#e74c3c"))

    mCreateChart("mChartRendTipos", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Rendimiento (€)",
                    data: values,
                    backgroundColor: colors,
                    borderColor: borders,
                    borderWidth: 1,
                    borderRadius: 6
                }
            ]
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
    const sorted = [...summaries]
        .filter((a) => a.invertidoEur !== 0 || a.rendimientoEur !== 0)
        .sort((a, b) => b.rendimientoEur - a.rendimientoEur)
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
            datasets: [
                {
                    label: "Rendimiento (€)",
                    data: values,
                    backgroundColor: colors,
                    borderColor: borders,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
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

let _metricasDivYear = getChartPref("metricasDivYear", null)

function mRenderDividendos(dividendos, colorMap = {}) {
    const section = document.getElementById("mSectionDividendos")
    if (!dividendos.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    function getYear(r) {
        const p = String(r.fecha || "").split("-")
        if (p.length !== 3) return null
        const yr = mParseShortYear(p[2])
        return yr ? String(yr) : null
    }

    const years = [...new Set(dividendos.map(getYear).filter(Boolean))].sort((a, b) => Number(a) - Number(b))
    if (!_metricasDivYear || (!years.includes(_metricasDivYear) && _metricasDivYear !== "total"))
        _metricasDivYear = years[years.length - 1] || "total"

    const toggle = document.getElementById("mDivYearToggle")
    if (toggle) {
        const opts = [...years, "total"]
        toggle.innerHTML = opts
            .map(
                (y) =>
                    `<button class="mToggleBtn${y === _metricasDivYear ? " active" : ""}" data-divy="${y}">${y === "total" ? "Total" : y}</button>`
            )
            .join("")
        if (!toggle.dataset.bound) {
            toggle.dataset.bound = "true"
            toggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-divy]")
                if (!btn) return
                toggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDivYear = btn.dataset.divy
                setChartPref("metricasDivYear", _metricasDivYear)
                mDrawDividendosCharts(dividendos, colorMap, getYear)
            })
        }
    }

    mDrawDividendosCharts(dividendos, colorMap, getYear)
}

function mDrawDividendosCharts(dividendos, colorMap, getYear) {
    const filtered =
        _metricasDivYear === "total" ? dividendos : dividendos.filter((r) => getYear(r) === _metricasDivYear)

    const map = {}
    filtered.forEach((r) => {
        const name = r.instrumento || "Desconocido"
        map[name] = (map[name] || 0) + parseEuroNumber(r.total || "")
    })

    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1])
    const labels = sorted.map(([name]) => name)
    const values = sorted.map(([, v]) => v)
    const colors = labels.map((label) => colorMap[label] || mPaletteForName(label))

    const ROW_H = 36
    const MAX_ROWS = 9
    const AXIS_H = 30
    const fullH = Math.max(MAX_ROWS * ROW_H, sorted.length * ROW_H)
    const wrapH = Math.min(fullH, MAX_ROWS * ROW_H) + AXIS_H
    const maxVal = values.length ? Math.max(...values) : 1

    const wrap = document.getElementById("mChartDivWrap")
    const inner = document.getElementById("mChartDivInner")
    const axisWrap = document.getElementById("mChartDivAxisWrap")
    const donutWrap = document.getElementById("mChartDivDonutWrap")
    if (wrap) wrap.style.height = wrapH + "px"
    if (inner) inner.style.height = fullH + "px"
    if (axisWrap) axisWrap.style.height = AXIS_H + "px"
    if (donutWrap) donutWrap.style.height = wrapH + "px"

    mDestroyChart("mChartDividendosAxis")

    mCreateChart("mChartDividendos", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Dividendos (€)",
                    data: values,
                    backgroundColor: colors.map((c) => c + "bb"),
                    borderColor: colors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
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
                    afterFit(scale) {
                        scale.height = 0
                    }
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
            data: {
                labels: [""],
                datasets: [{ data: [0], backgroundColor: "transparent", borderColor: "transparent", borderWidth: 0 }]
            },
            options: {
                ...M_CHART_DEFAULTS,
                indexAxis: "y",
                animation: { duration: 0 },
                plugins: {
                    ...M_CHART_DEFAULTS.plugins,
                    legend: { display: false },
                    tooltip: { enabled: false }
                },
                layout: { padding: { left: mainLeft, right: rightPad, top: 2, bottom: 4 } },
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
        data: {
            labels,
            datasets: [
                { data: values, backgroundColor: colors, borderColor: "#0b1120", borderWidth: 2, hoverOffset: 10 }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            cutout: "55%",
            layout: { padding: { bottom: 0 } },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, donutTotal) } }
            }
        }
    })
}

// ── dividendos mensuales ───────────────────────────────────────────────────

let _metricasDivMensualYear = getChartPref("metricasDivMensualYear", null)
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasPasivosYear = getChartPref("metricasPasivosYear", null)
// eslint-disable-next-line prefer-const -- se reasigna desde otro trozo del módulo
let _metricasInvertidoYear = getChartPref("metricasInvertidoYear", null)

function mRenderDivMensual(dividendos, colorMap = {}) {
    const section = document.getElementById("mSectionDivMensual")
    const rows = Array.isArray(dividendos) ? dividendos : []
    if (!rows.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    function dYear(fecha) {
        const p = String(fecha || "").split("-")
        if (p.length !== 3) return null
        const yr = mParseShortYear(p[2])
        return yr ? String(yr) : null
    }
    function dMonth(fecha) {
        const p = String(fecha || "").split("-")
        if (p.length !== 3) return -1
        const mon = mParseEsMonth(p[1]) || parseInt(p[1])
        return mon >= 1 && mon <= 12 ? mon - 1 : -1
    }

    const years = [...new Set(rows.map((r) => dYear(r.fecha)).filter(Boolean))].sort((a, b) => Number(a) - Number(b))

    if (!_metricasDivMensualYear || !years.includes(_metricasDivMensualYear))
        _metricasDivMensualYear = years[years.length - 1] || null

    const yearToggle = document.getElementById("mDivMensualYearToggle")
    if (yearToggle) {
        yearToggle.innerHTML = years
            .map(
                (y) =>
                    `<button class="mToggleBtn${y === _metricasDivMensualYear ? " active" : ""}" data-divmy="${y}">${y}</button>`
            )
            .join("")
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-divmy]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasDivMensualYear = btn.dataset.divmy
                setChartPref("metricasDivMensualYear", _metricasDivMensualYear)
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
    const yearRows = rows.filter((r) => dYear(r.fecha) === year)
    const stocks = [...new Set(yearRows.map((r) => r.instrumento || "Desconocido"))].sort()

    const monthData = {}
    stocks.forEach((s) => {
        monthData[s] = Array(12).fill(0)
    })
    yearRows.forEach((r) => {
        const m = dMonth(r.fecha)
        if (m < 0 || m > 11) return
        monthData[r.instrumento || "Desconocido"][m] += parseEuroNumber(r.total || "")
    })

    const monthTotals = Array(12).fill(0)
    stocks.forEach((s) =>
        monthData[s].forEach((v, i) => {
            monthTotals[i] += v
        })
    )

    head.innerHTML = `<tr><th>Mes</th>${stocks.map((s) => `<th>${escapeMetricasHtml(s)}</th>`).join("")}<th>Total</th></tr>`

    body.innerHTML = MONTH_LABELS.map((label, i) => {
        const rowTotal = stocks.reduce((t, s) => t + monthData[s][i], 0)
        if (rowTotal === 0) return ""
        const cells = stocks
            .map((s) => {
                const v = monthData[s][i]
                return `<td>${v > 0 ? formatEuro(v) : ""}</td>`
            })
            .join("")
        return `<tr><td class="mDivTabMes">${label}</td>${cells}<td class="mDivTabTotal">${formatEuro(rowTotal)}</td></tr>`
    }).join("")

    const grandTotal = monthTotals.reduce((t, v) => t + v, 0)
    const footCells = stocks
        .map((s) => {
            const t = monthData[s].reduce((a, b) => a + b, 0)
            return `<td class="mDivTabFootCell">${t > 0 ? formatEuro(t) : ""}</td>`
        })
        .join("")
    foot.innerHTML = `<tr><td class="mDivTabMes mDivTabFootCell">Total</td>${footCells}<td class="mDivTabTotal mDivTabFootCell">${formatEuro(grandTotal)}</td></tr>`
}

function mDrawDivMensualChart(rows, year, dYear, dMonth, colorMap = {}) {
    const yearRows = rows.filter((r) => dYear(r.fecha) === year)
    const stocks = [...new Set(yearRows.map((r) => r.instrumento || "Desconocido"))].sort()

    const monthData = {}
    const monthDetails = {}
    stocks.forEach((s) => {
        monthData[s] = Array(12).fill(0)
        monthDetails[s] = Array.from({ length: 12 }, () => ({ acciones: 0, impuestos: 0, xAccionStr: "" }))
    })
    yearRows.forEach((r) => {
        const m = dMonth(r.fecha)
        if (m < 0 || m > 11) return
        const name = r.instrumento || "Desconocido"
        monthData[name][m] += parseEuroNumber(r.total || "")
        monthDetails[name][m].acciones += parseFloat(String(r.acciones || "").replace(",", ".")) || 0
        monthDetails[name][m].impuestos += parseEuroNumber(r.impuestos || "")
        if (r.dividendoAccion) monthDetails[name][m].xAccionStr = String(r.dividendoAccion).trim()
    })

    const labels = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    const stockColors = stocks.map((s) => colorMap[s] || mPaletteForName(s))
    const datasets = stocks.map((s, i) => ({
        label: s,
        data: monthData[s],
        backgroundColor: "transparent",
        borderWidth: 0,
        stack: "div",
        _color: stockColors[i],
        _details: monthDetails[s]
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
                    const w = barW - 2
                    const x = bar.x - barW / 2 + 1
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
                            while (txt.length > 2 && ctx.measureText(txt + "…").width > maxW) txt = txt.slice(0, -1)
                            txt += "…"
                        }
                    }

                    ctx.shadowColor = "rgba(0,0,0,0.8)"
                    ctx.shadowBlur = 4
                    ctx.fillStyle = "#ffffff"
                    ctx.fillText(txt, bar.x, dY + dH / 2)
                    ctx.shadowBlur = 0
                })
            })

            ctx.restore()
        }
    }

    // Register custom tooltip positioner centered on each bar segment
    if (window.Chart && !Chart.Tooltip.positioners.segCenter) {
        Chart.Tooltip.positioners.segCenter = function (elements, _eventPos) {
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
                    ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: {
                    position: "top",
                    labels: {
                        color: "#ffffff",
                        font: { size: 11 },
                        padding: 12,
                        boxWidth: 12,
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
                        title: (items) => {
                            if (!items.length) return ""
                            const tp = items[0].chart.tooltip.dataPoints || items
                            const total = tp.filter((i) => i.raw > 0).reduce((s, i) => s + i.raw, 0)
                            return `${items[0].label}  ·  Total: ${formatEuro(total)}`
                        },
                        label: (c) => {
                            if (c.raw <= 0) return null
                            const det = c.dataset._details?.[c.dataIndex] || {}
                            const acc = det.acciones || 0
                            const imp = det.impuestos || 0
                            const lines = [` ${c.dataset.label}: ${formatEuro(c.raw)}`]
                            if (acc > 0) lines.push(`   Acciones: ${acc % 1 === 0 ? acc : acc.toFixed(4)}`)
                            if (imp > 0) lines.push(`   Impuestos: ${formatEuro(imp)}`)
                            if (det.xAccionStr) lines.push(`   Total/acción: ${det.xAccionStr}`)
                            return lines
                        },
                        labelColor: (c) => ({
                            borderColor: c.dataset._color || "#888",
                            backgroundColor: (c.dataset._color || "#888") + "ee"
                        })
                    }
                }
            },
            barPercentage: 0.75,
            categoryPercentage: 0.8
        }
    })

    // Tooltip on x-axis month labels
    const chartInst = _metricasCharts["mChartDivMensual"]
    const canvas = chartInst?.canvas
    if (canvas) {
        let _divTip = null
        const getTip = () => {
            if (!_divTip) {
                _divTip = document.createElement("div")
                _divTip.id = "mDivMensualAxisTip"
                _divTip.style.cssText =
                    "position:fixed;z-index:9999;pointer-events:none;background:#0f1724;border:1px solid #273246;border-radius:8px;padding:10px 14px;font-size:12px;color:#e5edf9;min-width:180px;box-shadow:0 4px 20px rgba(0,0,0,0.6);display:none;"
                document.body.appendChild(_divTip)
            }
            return _divTip
        }

        canvas.addEventListener("mousemove", (e) => {
            const chart = _metricasCharts["mChartDivMensual"]
            if (!chart) return
            const ca = chart.chartArea
            const rect = canvas.getBoundingClientRect()
            const mx = e.clientX - rect.left
            const my = e.clientY - rect.top
            const tip = getTip()

            // Only trigger in the x-axis label zone (below chart area)
            if (my < ca.bottom || my > rect.height || mx < ca.left || mx > ca.right) {
                tip.style.display = "none"
                return
            }

            // Find closest month index by x position
            const scale = chart.scales.x
            let bestIdx = -1,
                bestDist = Infinity
            for (let i = 0; i < 12; i++) {
                const px = scale.getPixelForValue(i)
                const d = Math.abs(mx - px)
                if (d < bestDist) {
                    bestDist = d
                    bestIdx = i
                }
            }
            if (bestIdx < 0 || bestDist > (ca.right - ca.left) / 14) {
                tip.style.display = "none"
                return
            }

            const monthTotal = chart.data.datasets.reduce((s, ds) => {
                const meta = chart.getDatasetMeta(chart.data.datasets.indexOf(ds))
                if (meta.hidden) return s
                return s + (ds.data[bestIdx] || 0)
            }, 0)
            if (monthTotal <= 0) {
                tip.style.display = "none"
                return
            }

            const lines = chart.data.datasets
                .map((ds, di) => {
                    const meta = chart.getDatasetMeta(di)
                    if (meta.hidden) return null
                    const v = ds.data[bestIdx] || 0
                    if (v <= 0) return null
                    const pct = ((v / monthTotal) * 100).toFixed(1)
                    const col = (ds._color || "#888") + "ee"
                    return (
                        `<div style="display:flex;align-items:center;gap:7px;margin-top:5px">` +
                        `<span style="width:10px;height:10px;border-radius:3px;background:${col};flex-shrink:0"></span>` +
                        `<span style="flex:1">${escapeHtml(ds.label)}</span>` +
                        `<span style="font-weight:600;margin-left:8px">${formatEuro(v)}</span>` +
                        `<span style="color:#94a3b8;min-width:44px;text-align:right">${pct}%</span>` +
                        `</div>`
                    )
                })
                .filter(Boolean)
                .join("")

            tip.innerHTML =
                `<div style="font-weight:700;font-size:13px;margin-bottom:4px;border-bottom:1px solid #273246;padding-bottom:6px">` +
                `${labels[bestIdx]} · <span style="color:#3b82f6">${formatEuro(monthTotal)}</span></div>${lines}`
            tip.style.display = "block"
            const tw = tip.offsetWidth || 200
            const th = tip.offsetHeight || 100
            const vw = window.innerWidth,
                vh = window.innerHeight
            let tx = e.clientX + 14,
                ty = e.clientY - th / 2
            if (tx + tw > vw - 8) tx = e.clientX - tw - 14
            if (ty < 8) ty = 8
            if (ty + th > vh - 8) ty = vh - th - 8
            tip.style.left = tx + "px"
            tip.style.top = ty + "px"
        })

        canvas.addEventListener("mouseleave", () => {
            const tip = document.getElementById("mDivMensualAxisTip")
            if (tip) tip.style.display = "none"
        })
    }
}

// ── bonos charts ───────────────────────────────────────────────────────────

function mRenderBonosTipos(bonos) {
    const section = document.getElementById("mSectionBonos")
    if (!bonos.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const GUB_COLOR = "#9b59b6"
    const CORP_COLOR = "#c39bd3"

    const gubNeto = bonos
        .filter((r) => r.tipo === "gubernamental")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const corpNeto = bonos
        .filter((r) => r.tipo === "corporativo")
        .reduce((s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""), 0)
    const total = gubNeto + corpNeto

    mCreateChart("mChartBonosTipos", {
        type: "doughnut",
        data: {
            labels: ["Gubernamentales", "Corporativos"],
            datasets: [
                {
                    data: [Math.max(0, gubNeto), Math.max(0, corpNeto)],
                    backgroundColor: [GUB_COLOR + "cc", CORP_COLOR + "cc"],
                    borderColor: "#0b1120",
                    borderWidth: 3,
                    hoverOffset: 10
                }
            ]
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
    const colors = values.map((v) => (v >= 0 ? "#9b59b6bb" : "#e74c3cbb"))
    const borders = values.map((v) => (v >= 0 ? "#9b59b6" : "#e74c3c"))

    const wrap = document.getElementById("mChartBonosInstWrap")
    if (wrap) wrap.style.height = Math.max(180, sorted.length * 36 + 40) + "px"

    mCreateChart("mChartBonosInst", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Interés neto (€)",
                    data: values,
                    backgroundColor: colors,
                    borderColor: borders,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
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
    if (!rentaFija.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const total = rentaFija.reduce(
        (s, r) => s + parseEuroNumber(r.interesAcumulado || "") - parseEuroNumber(r.impuestos || ""),
        0
    )

    mCreateChart("mChartRfTipos", {
        type: "doughnut",
        data: {
            labels: ["Interés Fijo"],
            datasets: [
                {
                    data: [Math.max(0, total)],
                    backgroundColor: ["#00bcd4cc"],
                    borderColor: "#0b1120",
                    borderWidth: 3,
                    hoverOffset: 10
                }
            ]
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
    const sorted = Object.entries(map).sort((a, b) => b[1] - a[1])
    const labels = sorted.map(([name]) => name)
    const values = sorted.map(([, v]) => v)
    const colors = values.map((v) => (v >= 0 ? "#00bcd4bb" : "#e74c3cbb"))
    const borders = values.map((v) => (v >= 0 ? "#00bcd4" : "#e74c3c"))

    const wrap = document.getElementById("mChartRfInstWrap")
    if (wrap) wrap.style.height = Math.max(180, sorted.length * 36 + 40) + "px"

    mCreateChart("mChartRfInst", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Interés neto (€)",
                    data: values,
                    backgroundColor: colors,
                    borderColor: borders,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
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
