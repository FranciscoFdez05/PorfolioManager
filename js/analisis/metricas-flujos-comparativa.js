// Análisis > Métricas: comparativa de ingresos y gastos.
//
// Trozo de js/analisis/metricas-flujos.js. Comparte con el resto de metricas-flujos-*.js el
// ámbito global y se carga detrás de metricas-flujos.js, en el orden de index.html.

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
    Object.values(gastosYearData?.months || {}).forEach((monthData) => {
        ;(monthData?.rows || []).forEach((row) => {
            tiposSet.add((row.tipo || "Sin tipo").trim())
        })
    })
    const hasMensualidades = (gastosYearData?.mensualidades || []).length > 0
    if (hasMensualidades) tiposSet.add("Mensualidades")
    const allTipos = [...tiposSet].sort()

    // Render filter buttons — always rebuild so listener always sees current year data
    const filtrosEl = document.getElementById("mComparativaFiltros")
    if (filtrosEl) {
        filtrosEl.innerHTML = allTipos
            .map(
                (t) =>
                    `<label class="mActivosFilterBtn" data-cmp-tipo="${t}"><input type="checkbox"${_metricasComparativaExclude.has(t) ? "" : " checked"}><span>${t}</span></label>`
            )
            .join("")
        filtrosEl.onchange = (e) => {
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
    const ingMonthly = M_ING_KEYS.map((k) => {
        let t = 0
        ;(ingresosYearData?.recurrentes || []).forEach((r) => {
            t += parseEuroNumber(r.meses?.[k] || "")
        })
        ;(ingresosYearData?.months?.[k]?.rows || []).forEach((r) => {
            t += parseEuroNumber(r.cantidad || "")
        })
        return t
    })

    const gastosDetalle = M_GASTOS_KEYS.map((k) => {
        const detalle = {}
        if (!_metricasComparativaExclude.has("Mensualidades") && isMensualidadMonthActive(gastosYearData, k)) {
            const mens = (gastosYearData?.mensualidades || []).reduce(
                (s, r) => s + parseEuroNumber(r.meses?.[k] || ""),
                0
            )
            if (mens > 0) detalle["Mensualidades"] = mens
        }
        ;(gastosYearData?.months?.[k]?.rows || []).forEach((row) => {
            const tipo = (row.tipo || "Sin tipo").trim()
            if (!_metricasComparativaExclude.has(tipo)) {
                const val = parseEuroNumber(row.cantidad || "")
                if (val > 0) detalle[tipo] = (detalle[tipo] || 0) + val
            }
        })
        return detalle
    })

    const gastosMonthly = gastosDetalle.map((d) => Object.values(d).reduce((s, v) => s + v, 0))

    const balance = ingMonthly.map((ing, i) => ing - gastosMonthly[i])

    mDrawComparativaLineChart(ingMonthly, gastosMonthly)

    mCreateChart("mChartComparativa", {
        type: "bar",
        data: {
            labels: M_ING_LABELS,
            datasets: [
                {
                    label: "Ingresos",
                    data: ingMonthly,
                    backgroundColor: "#2ecc7188",
                    borderColor: "#2ecc71",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Gastos",
                    data: gastosMonthly,
                    backgroundColor: "#e74c3c88",
                    borderColor: "#e74c3c",
                    borderWidth: 1,
                    borderRadius: 4
                },
                {
                    label: "Balance",
                    data: balance,
                    backgroundColor: balance.map((v) => (v >= 0 ? "#3a7bd577" : "#e74c3c44")),
                    borderColor: balance.map((v) => (v >= 0 ? "#3a7bd5" : "#e74c3c")),
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
    const visibleLabels = lastIdx >= 0 ? labels.slice(0, lastIdx + 1) : labels
    const visibleIngresos = lastIdx >= 0 ? ingMonthly.slice(0, lastIdx + 1) : ingMonthly
    const visibleGastos = lastIdx >= 0 ? gastosMonthly.slice(0, lastIdx + 1) : gastosMonthly

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
                            const ing = items.find((i) => i.dataset.label === "Ingresos")?.raw ?? 0
                            const gas = items.find((i) => i.dataset.label === "Gastos")?.raw ?? 0
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
