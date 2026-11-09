// Análisis > Métricas: gráficos de ingresos e intereses mensuales.
//
// Trozo de js/analisis/metricas-flujos.js. Comparte con el resto de metricas-flujos-*.js el
// ámbito global y se carga detrás de metricas-flujos.js, en el orden de index.html.

// ── ingresos charts ────────────────────────────────────────────────────────

const M_ING_KEYS = [
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
const M_ING_LABELS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]

function mComputeIngresosMonthly(ingresosYearData) {
    const totals = Object.fromEntries(M_ING_KEYS.map((k) => [k, 0]))
    ;(ingresosYearData?.recurrentes || []).forEach((row) => {
        M_ING_KEYS.forEach((k) => {
            totals[k] += parseEuroNumber(row.meses?.[k] || "")
        })
    })
    M_ING_KEYS.forEach((k) => {
        ;(ingresosYearData?.months?.[k]?.rows || []).forEach((row) => {
            totals[k] += parseEuroNumber(row.cantidad || "")
        })
    })
    return totals
}

function mComputeIngresosTipo(ingresosYearData, monthKey) {
    const totals = {}
    if (monthKey === "all") {
        ;(ingresosYearData?.recurrentes || []).forEach((row) => {
            const nombre = (row.nombre || "Recurrentes").trim()
            const sub = M_ING_KEYS.reduce((s, k) => s + parseEuroNumber(row.meses?.[k] || ""), 0)
            if (sub > 0) totals[nombre] = (totals[nombre] || 0) + sub
        })
        M_ING_KEYS.forEach((k) => {
            ;(ingresosYearData?.months?.[k]?.rows || []).forEach((row) => {
                const tipo = (row.tipo || "Sin tipo").trim()
                const val = parseEuroNumber(row.cantidad || "")
                if (val > 0) totals[tipo] = (totals[tipo] || 0) + val
            })
        })
    } else {
        ;(ingresosYearData?.recurrentes || []).forEach((row) => {
            const nombre = (row.nombre || "Recurrentes").trim()
            const val = parseEuroNumber(row.meses?.[monthKey] || "")
            if (val > 0) totals[nombre] = (totals[nombre] || 0) + val
        })
        ;(ingresosYearData?.months?.[monthKey]?.rows || []).forEach((row) => {
            const tipo = (row.tipo || "Sin tipo").trim()
            const val = parseEuroNumber(row.cantidad || "")
            if (val > 0) totals[tipo] = (totals[tipo] || 0) + val
        })
    }
    return totals
}

function mRenderIngresosCharts(ingresosYearData) {
    const totalMes = mComputeIngresosMonthly(ingresosYearData)
    const totalTipo = mComputeIngresosTipo(ingresosYearData, _metricasIngresosMonth)

    const mesWrap = document.getElementById("mChartIngresosMesWrap")
    if (mesWrap) mesWrap.style.height = "280px"

    const mesValues = M_ING_KEYS.map((k) => totalMes[k] || 0)
    const mesColors = M_ING_LABELS.map((_, i) => M_PALETTE[i % M_PALETTE.length])
    mCreateChart("mChartIngresosMes", {
        type: "bar",
        data: {
            labels: M_ING_LABELS,
            datasets: [
                {
                    label: "Ingresos (€)",
                    data: mesValues,
                    backgroundColor: mesColors.map((c) => c + "bb"),
                    borderColor: mesColors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisY(11), y: mAxisX() }
        }
    })

    const tipoEntries = Object.entries(totalTipo).sort((a, b) => b[1] - a[1])
    if (tipoEntries.length) {
        const tipoLabels = tipoEntries.map(([k]) => k)
        const tipoValues = tipoEntries.map(([, v]) => v)
        const tipoColors = tipoLabels.map((_, i) => M_PALETTE[i % M_PALETTE.length])
        const tipoTotal = tipoValues.reduce((a, b) => a + b, 0)
        mCreateChart("mChartIngresosTipo", {
            type: "doughnut",
            data: {
                labels: tipoLabels,
                datasets: [
                    {
                        data: tipoValues,
                        backgroundColor: tipoColors,
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
                    legend: { display: false },
                    tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, tipoTotal) } }
                }
            }
        })
        mRenderDonutLeyenda("mChartIngresosTipo", tipoLabels, tipoColors, tipoValues, tipoTotal)
    } else {
        mDestroyChart("mChartIngresosTipo")
        mRenderDonutLeyenda("mChartIngresosTipo", [], [], [], 0)
    }

    mEqualizeChartRowHeights()
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
        yearToggle.innerHTML = ingresosYearsList
            .map(
                (y) =>
                    `<button class="mToggleBtn${String(y) === String(ingresosYearData.year) ? " active" : ""}" data-ingresosyear="${y}">${y}</button>`
            )
            .join("")
        yearToggle.addEventListener("click", async (e) => {
            const btn = e.target.closest("[data-ingresosyear]")
            if (!btn) return
            yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasIngresosMonth = "all"
            setChartPref("metricasIngresosMonth", _metricasIngresosMonth)
            setChartPref("metricasIngresosYear", btn.dataset.ingresosyear)
            const newData = await fetch(`/api/ingresos/${btn.dataset.ingresosyear}`)
                .then((r) => r.json())
                .catch(() => null)
            if (newData) {
                _metricasPayload.ingresosYearData = newData
                const mt = document.getElementById("mIngresosMonthToggle")
                if (mt) {
                    mt.dataset.bound = ""
                    mt.innerHTML = ""
                }
                mRenderIngresosSection(ingresosYearsList, newData)
                mRenderComparativa(_metricasPayload.ingresosYearData, _metricasPayload.gastosYearData)
            }
        })
    } else if (yearToggle) {
        yearToggle
            .querySelectorAll(".mToggleBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.ingresosyear === String(ingresosYearData.year)))
    }

    const monthToggle = document.getElementById("mIngresosMonthToggle")
    const tipoTitle = document.getElementById("mIngresosTipoTitle")
    if (monthToggle && !monthToggle.dataset.bound) {
        monthToggle.dataset.bound = "true"
        const allBtn = `<button class="mToggleBtn${_metricasIngresosMonth === "all" ? " active" : ""}" data-ingresosmonth="all">Todos</button>`
        const monthBtns = M_ING_KEYS.map(
            (k, i) =>
                `<button class="mToggleBtn${_metricasIngresosMonth === k ? " active" : ""}" data-ingresosmonth="${k}">${M_ING_LABELS[i]}</button>`
        ).join("")
        monthToggle.innerHTML = allBtn + monthBtns
        monthToggle.addEventListener("click", (e) => {
            const btn = e.target.closest("[data-ingresosmonth]")
            if (!btn) return
            monthToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _metricasIngresosMonth = btn.dataset.ingresosmonth
            setChartPref("metricasIngresosMonth", _metricasIngresosMonth)
            if (tipoTitle)
                tipoTitle.textContent =
                    _metricasIngresosMonth === "all"
                        ? "Por tipo (anual)"
                        : `Por tipo — ${M_ING_LABELS[M_ING_KEYS.indexOf(_metricasIngresosMonth)] || _metricasIngresosMonth}`
            mRenderIngresosCharts(ingresosYearData)
        })
    } else if (monthToggle) {
        monthToggle
            .querySelectorAll(".mToggleBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.ingresosmonth === _metricasIngresosMonth))
    }

    if (tipoTitle)
        tipoTitle.textContent =
            _metricasIngresosMonth === "all"
                ? "Por tipo (anual)"
                : `Por tipo — ${M_ING_LABELS[M_ING_KEYS.indexOf(_metricasIngresosMonth)] || _metricasIngresosMonth}`
    mRenderIngresosCharts(ingresosYearData)
}

// ── intereses mensuales ────────────────────────────────────────────────────

let _metricasInteresesYear = getChartPref("metricasInteresesYear", null)

const _CUENTA_COLORS = [
    "#3a7bd5",
    "#2ecc71",
    "#e67e22",
    "#9b59b6",
    "#1abc9c",
    "#e74c3c",
    "#f39c12",
    "#00cec9",
    "#fd79a8",
    "#6c5ce7"
]

function intYear(fecha) {
    const p = String(fecha || "").split("-")
    const raw = p.length === 3 ? p[2] : p.length === 2 ? p[1] : null
    if (!raw) return null
    const yr = mParseShortYear(raw)
    return yr ? String(yr) : null
}
function intMonth(fecha) {
    const p = String(fecha || "").split("-")
    let s
    if (p.length === 3) s = p[1]
    else if (p.length === 2) s = p[0]
    else return -1
    const mon = mParseEsMonth(s) || parseInt(s)
    return mon >= 1 && mon <= 12 ? mon - 1 : -1
}

function mRenderInteresesSection(interesRows, cuentas) {
    const section = document.getElementById("mSectionIntereses")
    const rows = Array.isArray(interesRows) ? interesRows : []
    if (!rows.length) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const years = [...new Set(rows.map((r) => intYear(r.fecha)).filter(Boolean))].sort((a, b) => Number(a) - Number(b))
    if (!_metricasInteresesYear || !years.includes(_metricasInteresesYear))
        _metricasInteresesYear = years[years.length - 1] || null

    const yearToggle = document.getElementById("mInteresesYearToggle")
    if (yearToggle) {
        yearToggle.innerHTML = ordenarAniosRecientesPrimero(years)
            .map(
                (y) =>
                    `<button class="mToggleBtn${y === _metricasInteresesYear ? " active" : ""}" data-intano="${y}">${y}</button>`
            )
            .join("")
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-intano]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasInteresesYear = btn.dataset.intano
                setChartPref("metricasInteresesYear", _metricasInteresesYear)
                mDrawInteresesChart(cuentas, _metricasInteresesYear)
            })
        }
    }

    mDrawInteresesChart(cuentas, _metricasInteresesYear)
}

function mDrawInteresesChart(cuentas, year) {
    const labels = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    const cuentasList = Array.isArray(cuentas) && cuentas.length ? cuentas : []

    // Por mes: totales y desglose por cuenta
    const monthAcum = Array(12).fill(0)
    const monthNet = Array(12).fill(0)
    // desglose[mes] = [{ nombre, acum, neto }]
    const desglose = Array.from({ length: 12 }, () => [])

    cuentasList.forEach((cuenta) => {
        const cuentaRows = Array.isArray(cuenta.rows) ? cuenta.rows : []
        cuentaRows
            .filter((r) => intYear(r.fecha) === year)
            .forEach((r) => {
                const m = intMonth(r.fecha)
                if (m < 0 || m > 11) return
                const acum = parseEuroNumber(r.acumulado || "")
                const imp = parseEuroNumber(r.impuestos || "")
                const neto = acum - imp
                monthAcum[m] += acum
                monthNet[m] += neto
                const existing = desglose[m].find((d) => d.nombre === cuenta.nombre)
                if (existing) {
                    existing.acum += acum
                    existing.neto += neto
                } else desglose[m].push({ nombre: cuenta.nombre, acum, neto })
            })
    })

    const netColors = monthNet.map((v) => (v >= 0 ? "#2ecc71" : "#e74c3c"))

    mCreateChart("mChartIntereses", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Acumulado",
                    data: monthAcum,
                    backgroundColor: "#3a7bd544",
                    borderColor: "#3a7bd5",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Neto",
                    data: monthNet,
                    backgroundColor: netColors.map((c) => c + "bb"),
                    borderColor: netColors,
                    borderWidth: 1,
                    borderRadius: 4
                }
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
                            return desglose[mes].map((d) => `  · ${d.nombre}: ${formatEuro(isAcum ? d.acum : d.neto)}`)
                        }
                    }
                }
            },
            scales: { x: mAxisX(), y: mAxisY() }
        }
    })
}
