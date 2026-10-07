// Métricas: rentabilidad y riesgo, rentabilidad por año, tasa de ahorro, resumen anual e ingresos pasivos.
//
// Separado de js/analisis/metricas.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

// ── rentabilidad y riesgo (TWR, XIRR, drawdown, volatilidad) ───────────────

// Las cifras las calcula el servidor (`core/rentabilidad.py`) sobre el
// histórico completo; aquí solo se pintan. TWR y XIRR se enseñan juntas a
// propósito: la primera mide la cartera y la segunda tu dinero, y cuando
// discrepan es porque el momento de las aportaciones ha pesado.

function mFmtPctSigno(valor, decimales = 2) {
    const pct = valor * 100
    return (pct >= 0 ? "+" : "") + pct.toFixed(decimales).replace(".", ",") + " %"
}

function mFechaCorta(ts) {
    if (!ts) return ""
    return new Date(ts * 1000).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "2-digit" })
}

function mSetSub(id, texto, cls = "") {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = texto
    el.className = "mkpiSubValue" + (cls ? " " + cls : "")
}

function mRenderRiesgo(rent) {
    const empty = document.getElementById("mRiesgoEmpty")
    const wrap = document.getElementById("mRiesgoWrap")

    const sinDatos = !rent || rent.twr?.total === null || rent.twr?.total === undefined
    if (empty) empty.classList.toggle("hidden", !sinDatos)
    if (wrap) wrap.classList.toggle("hidden", sinDatos)
    if (sinDatos) {
        mDestroyChart("mChartDrawdown")
        return
    }

    const { twr, xirr, drawdown, volatilidad } = rent
    const signo = (v) => (v >= 0 ? "mPositive" : "mNegative")

    mSetKpi("mkpiTwrTotal", mFmtPctSigno(twr.total), signo(twr.total))
    mSetSub(
        "mkpiTwrAnual",
        twr.anual !== null && twr.anual !== undefined
            ? `${mFmtPctSigno(twr.anual)} anualizada`
            : // Anualizar dos meses de histórico da un número de fantasía; se
              // dice el periodo real en su lugar.
              `en ${twr.dias} ${twr.dias === 1 ? "día" : "días"}`
    )

    if (xirr === null || xirr === undefined) {
        mSetKpi("mkpiXirr", "—")
        mSetSub("mkpiXirrNota", "Sin flujos suficientes")
    } else {
        mSetKpi("mkpiXirr", mFmtPctSigno(xirr), signo(xirr))
        // La comparación solo vale contra la TWR anualizada: enfrentar una TIR
        // anual con un acumulado de cuatro meses diría que las aportaciones
        // acertaron cuando lo único que pasa es que las escalas no coinciden.
        if (twr.anual === null || twr.anual === undefined) {
            mSetSub("mkpiXirrNota", "Anualizada sobre tus flujos")
        } else {
            const brecha = xirr - twr.anual
            mSetSub(
                "mkpiXirrNota",
                Math.abs(brecha) < 0.005
                    ? "En línea con la TWR"
                    : brecha > 0
                      ? "Aportaste antes de subir"
                      : "Aportaste antes de caer"
            )
        }
    }

    if (drawdown.maximo === null || drawdown.maximo === undefined) {
        mSetKpi("mkpiDrawdown", "—")
        mSetSub("mkpiDrawdownFechas", "")
    } else {
        mSetKpi("mkpiDrawdown", mFmtPctSigno(drawdown.maximo), drawdown.maximo < 0 ? "mNegative" : "")
        mSetSub(
            "mkpiDrawdownFechas",
            drawdown.ts_pico ? `${mFechaCorta(drawdown.ts_pico)} → ${mFechaCorta(drawdown.ts_valle)}` : "Sin caídas"
        )
    }

    const actual = drawdown.actual ?? 0
    mSetKpi("mkpiDrawdownActual", mFmtPctSigno(actual), actual < -0.0001 ? "mNegative" : "mPositive")
    mSetSub("mkpiDrawdownActualNota", actual < -0.0001 ? "Por debajo del máximo" : "En máximos históricos")

    if (volatilidad.anual === null || volatilidad.anual === undefined) {
        mSetKpi("mkpiVolatilidad", "—")
        mSetSub(
            "mkpiVolatilidadNota",
            `Solo ${volatilidad.muestras} ${volatilidad.muestras === 1 ? "tramo" : "tramos"}`
        )
    } else {
        mSetKpi("mkpiVolatilidad", (volatilidad.anual * 100).toFixed(1).replace(".", ",") + " %")
        mSetSub("mkpiVolatilidadNota", `${(volatilidad.diaria * 100).toFixed(2).replace(".", ",")} % diaria`)
    }

    mDrawDrawdownChart(rent.indice || [])
}

// Gráfico "underwater": distancia al máximo histórico en cada momento. Se
// dibuja sobre el índice TWR y no sobre el valor en euros porque una retirada
// hunde el valor sin que la cartera haya perdido nada.
function mDrawDrawdownChart(indice) {
    if (indice.length < 2) {
        mDestroyChart("mChartDrawdown")
        return
    }

    let pico = indice[0].idx
    const caidas = indice.map((p) => {
        if (p.idx > pico) pico = p.idx
        return +((p.idx / pico - 1) * 100).toFixed(2)
    })
    const labels = indice.map((p) => mFechaCorta(p.ts))

    mCreateChart("mChartDrawdown", {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Caída desde máximos",
                    data: caidas,
                    borderColor: "#e74c3c",
                    backgroundColor: "rgba(231,76,60,0.18)",
                    borderWidth: 1.5,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    fill: "origin",
                    tension: 0.2
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            interaction: { mode: "index", intersect: false },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.raw.toFixed(2).replace(".", ",")} % desde máximos`
                    }
                }
            },
            scales: {
                x: {
                    ...mAxisX(),
                    ticks: { color: "#8899bb", maxTicksLimit: 10, autoSkip: true }
                },
                y: {
                    max: 0,
                    ticks: { color: "#ccd6f6", callback: (v) => v.toFixed(0) + "%" },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            }
        }
    })
}

// ── rentabilidad por año ───────────────────────────────────────────────────

// La rentabilidad del año NO es la variación del valor de la cartera: aportar o
// retirar dinero mueve el valor sin que haya ganado ni perdido nada (con las
// retiradas de 2026 salía un -21 % teniendo la cartera en positivo). Se usa
// Modified Dietz, que descuenta el flujo neto del periodo y le da peso medio:
//
//     r = (Vfin − Vini − Flujo) / (Vini + Flujo/2)
//
// El flujo se deduce del invertido de cada snapshot (sube al comprar y baja al
// vender), que es justo el dinero que entra y sale de la cartera.
// Por debajo de este porcentaje de días registrados, la barra del año se
// dibuja rayada: un 2024 con tres snapshots no mide lo mismo que uno con
// trescientos, y en un gráfico de barras los dos pesan igual.
const M_COBERTURA_MINIMA = 60

// Rayado diagonal para las barras de cobertura pobre. Se genera sobre un
// canvas suelto porque Chart.js acepta un CanvasPattern donde acepta un color.
function mPatronRayado(color) {
    const tile = document.createElement("canvas")
    tile.width = tile.height = 8
    const ctx = tile.getContext("2d")
    if (!ctx) return color
    ctx.fillStyle = "rgba(20,30,50,0.55)"
    ctx.fillRect(0, 0, 8, 8)
    ctx.strokeStyle = color
    ctx.lineWidth = 3
    ctx.beginPath()
    ctx.moveTo(-2, 10)
    ctx.lineTo(10, -2)
    ctx.moveTo(2, 14)
    ctx.lineTo(14, 2)
    ctx.stroke()
    return ctx.createPattern(tile, "repeat") || color
}

function mRenderRentabilidadAnual(snaps, currentValue, currentInvested, cobertura = {}) {
    const emptyEl = document.getElementById("mRentAnualEmpty")
    const wrapEl = document.getElementById("mRentAnualWrap")
    const notaEl = document.getElementById("mRentAnualNota")

    if (!snaps.length) {
        if (emptyEl) emptyEl.classList.remove("hidden")
        if (wrapEl) wrapEl.classList.add("hidden")
        return
    }

    const currentYear = new Date().getFullYear()
    const byYear = {}
    snaps.forEach((p) => {
        const yr = new Date(p.ts * 1000).getFullYear()
        if (!byYear[yr]) byYear[yr] = { first: p, last: p }
        else byYear[yr].last = p
    })

    const years = Object.keys(byYear)
        .map(Number)
        .sort((a, b) => a - b)
    const labels = []
    const values = []
    const detalle = []

    years.forEach((yr) => {
        const prevData = byYear[yr - 1]
        const inicio = prevData ? prevData.last : byYear[yr].first
        const cierre = yr === currentYear ? { v: currentValue, i: currentInvested } : byYear[yr].last

        // Un único snapshot en un año ya cerrado no delimita ningún periodo.
        if (!prevData && byYear[yr].first === byYear[yr].last && yr !== currentYear) return

        const flujo = cierre.i - inicio.i
        const base = inicio.v + flujo / 2
        if (!(base > 0)) return

        const ret = ((cierre.v - inicio.v - flujo) / base) * 100
        if (!Number.isFinite(ret)) return

        const cob = cobertura[yr] || cobertura[String(yr)] || null
        const pobre = cob ? cob.pct < M_COBERTURA_MINIMA : false

        labels.push(String(yr) + (yr === currentYear ? " (YTD)" : "") + (pobre ? " *" : ""))
        values.push(parseFloat(ret.toFixed(2)))
        // parcial: el año no arranca en el cierre del anterior, sino en el
        // primer snapshot que hay guardado, así que mide menos de 12 meses.
        detalle.push({ inicio: inicio.v, cierre: cierre.v, flujo, parcial: !prevData, cobertura: cob, pobre })
    })

    if (labels.length < 1) {
        if (emptyEl) emptyEl.classList.remove("hidden")
        if (wrapEl) wrapEl.classList.add("hidden")
        return
    }
    if (emptyEl) emptyEl.classList.add("hidden")
    if (wrapEl) wrapEl.classList.remove("hidden")

    const colors = values.map((v, i) =>
        detalle[i].pobre ? mPatronRayado(v >= 0 ? "#2ecc71aa" : "#e74c3caa") : v >= 0 ? "#2ecc71cc" : "#e74c3ccc"
    )
    const borders = values.map((v) => (v >= 0 ? "#2ecc71" : "#e74c3c"))

    const pobres = detalle.filter((d) => d.pobre).length
    if (notaEl) {
        notaEl.textContent = pobres
            ? `* Años con menos del ${M_COBERTURA_MINIMA} % de los días registrados: la barra se calcula con muy pocos puntos.`
            : ""
        notaEl.classList.toggle("hidden", !pobres)
    }

    mCreateChart("mChartRentAnual", {
        type: "bar",
        data: {
            labels,
            datasets: [
                {
                    label: "Rentabilidad (%)",
                    data: values,
                    backgroundColor: colors,
                    borderColor: borders,
                    borderWidth: 1,
                    borderRadius: 6,
                    maxBarThickness: 90,
                    categoryPercentage: 0.6,
                    barPercentage: 0.92
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => ` ${c.raw >= 0 ? "+" : ""}${c.raw.toFixed(2).replace(".", ",")}%`,
                        afterBody: (items) => {
                            const d = detalle[items[0]?.dataIndex]
                            if (!d) return []
                            const lineas = [
                                `Valor inicial: ${formatEuro(d.inicio)}`,
                                `Valor final: ${formatEuro(d.cierre)}`,
                                `${d.flujo >= 0 ? "Aportado" : "Retirado"}: ${formatEuro(Math.abs(d.flujo))}`
                            ]
                            if (d.parcial) lineas.push("Periodo parcial (desde el primer registro)")
                            if (d.cobertura) {
                                lineas.push(
                                    `Cobertura: ${d.cobertura.dias} de ${d.cobertura.esperados} días (${String(d.cobertura.pct).replace(".", ",")} %)`
                                )
                                if (d.pobre) lineas.push("⚠ Pocos puntos: la cifra es orientativa")
                            }
                            return lineas
                        }
                    }
                }
            },
            scales: {
                x: mAxisX(),
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

// ── tasa de ahorro mensual ────────────────────────────────────────────────

function mRenderAhorro(ingresosYearData, gastosYearData, ahorroConfig) {
    const section = document.getElementById("mSectionAhorro")
    const kpiGroup = document.getElementById("mkpiGroupAhorro")
    const kpiSep = document.getElementById("mkpiSepAhorro")

    if (!ingresosYearData || !gastosYearData) {
        if (section) section.classList.add("hidden")
        if (kpiGroup) kpiGroup.classList.add("hidden")
        if (kpiSep) kpiSep.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")
    if (kpiGroup) kpiGroup.classList.remove("hidden")
    if (kpiSep) kpiSep.classList.remove("hidden")

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

    const { totalMes: gastosMes } = mComputeGastosData(gastosYearData)
    const gastosMonthly = M_GASTOS_KEYS.map((k) => gastosMes[k] || 0)

    const ahorroMonthly = ingMonthly.map((ing, i) => ing - gastosMonthly[i])
    const tasaMonthly = ingMonthly.map((ing, i) => (ing > 0 ? ((ing - gastosMonthly[i]) / ing) * 100 : null))

    const activeMeses = ingMonthly
        .map((v, i) => ({ ing: v, tasa: tasaMonthly[i] }))
        .filter((m) => m.ing > 0 && m.tasa !== null)
    const avgTasa = activeMeses.length > 0 ? activeMeses.reduce((s, m) => s + m.tasa, 0) / activeMeses.length : 0
    const totalAhorro = ahorroMonthly.reduce((s, v) => s + v, 0)

    const objAhorro = Number(ahorroConfig?.objetivoAhorro) || 30
    mSetKpi("mkpiTasaAhorro", formatPercent(avgTasa), avgTasa >= 0 ? "mPositive" : "mNegative")
    mSetKpi("mkpiAhorroTotal", formatEuro(totalAhorro), totalAhorro >= 0 ? "mPositive" : "mNegative")

    // KPI vs Objetivo — estructura visual separada
    const tasaEl = document.getElementById("mkpiAhorroObjetivoTasa")
    const deltaEl = document.getElementById("mkpiAhorroObjetivoDelta")
    const subEl = document.getElementById("mkpiAhorroObjetivoSub")
    if (tasaEl) {
        const above = avgTasa >= objAhorro
        const diffPp = avgTasa - objAhorro
        tasaEl.textContent = avgTasa.toFixed(1) + "%"
        tasaEl.className = "mkpiValue " + (above ? "mPositive" : "mNegative")
        if (deltaEl) {
            deltaEl.textContent = (above ? "+" : "") + diffPp.toFixed(1) + " pp"
            deltaEl.className = "mkpiAhorroObjDelta " + (above ? "positive" : "negative")
        }
        if (subEl) {
            subEl.textContent = (above ? "sobre" : "bajo") + " objetivo (" + objAhorro + "%)"
        }
    }

    const barColors = ahorroMonthly.map((v) => (v >= 0 ? "#2ecc71aa" : "#e74c3caa"))
    const barBorders = ahorroMonthly.map((v) => (v >= 0 ? "#2ecc71" : "#e74c3c"))
    const lineData = tasaMonthly.map((v) => (v !== null ? parseFloat(v.toFixed(1)) : null))
    const objLine = M_ING_LABELS.map(() => objAhorro)

    mCreateChart("mChartTasaAhorro", {
        type: "bar",
        data: {
            labels: M_ING_LABELS,
            datasets: [
                {
                    label: "Ahorro mensual (€)",
                    data: ahorroMonthly,
                    backgroundColor: barColors,
                    borderColor: barBorders,
                    borderWidth: 1,
                    borderRadius: 4,
                    yAxisID: "yEur"
                },
                {
                    label: "Tasa de ahorro (%)",
                    data: lineData,
                    type: "line",
                    borderColor: "#3a7bd5",
                    backgroundColor: "rgba(58,123,213,0.08)",
                    borderWidth: 2,
                    pointRadius: lineData.map((v) => (v !== null ? 4 : 0)),
                    pointBackgroundColor: "#3a7bd5",
                    tension: 0.35,
                    spanGaps: false,
                    yAxisID: "yPct"
                },
                {
                    label: `Objetivo (${objAhorro}%)`,
                    data: objLine,
                    type: "line",
                    borderColor: "rgba(251,191,36,0.7)",
                    borderWidth: 1.5,
                    borderDash: [5, 4],
                    pointRadius: 0,
                    fill: false,
                    tension: 0,
                    yAxisID: "yPct"
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
                        label: (c) => {
                            if (c.dataset.label?.startsWith("Objetivo")) return ` Objetivo: ${c.raw.toFixed(0)}%`
                            return c.dataset.yAxisID === "yPct"
                                ? ` Tasa: ${c.raw !== null ? c.raw.toFixed(1).replace(".", ",") + "%" : "---"}`
                                : ` Ahorro: ${formatEuro(c.raw)}`
                        }
                    }
                }
            },
            scales: {
                x: mAxisX(),
                yEur: {
                    type: "linear",
                    position: "left",
                    ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) },
                    grid: { color: "rgba(255,255,255,0.06)" }
                },
                yPct: {
                    type: "linear",
                    position: "right",
                    ticks: { color: "#8899bb", callback: (v) => v.toFixed(0) + "%" },
                    grid: { display: false }
                }
            }
        }
    })
}

// ── estadísticas anuales: gastado vs ahorrado ─────────────────────────────

let _metricasAnualMode = getChartPref("metricasAnualMode", "eur")
let _mAnualResumenCache = []

function mComputeResumenAnual(anualData) {
    return (anualData || [])
        .map(({ year, gastosData, ingresosData }) => {
            const { totalMes } = mComputeGastosData(gastosData)
            const gastado = M_GASTOS_KEYS.reduce((s, k) => s + (totalMes[k] || 0), 0)
            const ingMes = mComputeIngresosMonthly(ingresosData)
            const ingresos = M_ING_KEYS.reduce((s, k) => s + (ingMes[k] || 0), 0)
            const ahorrado = ingresos - gastado
            return {
                year,
                ingresos,
                gastado,
                ahorrado,
                tasa: ingresos > 0 ? (ahorrado / ingresos) * 100 : null,
                pctGasto: ingresos > 0 ? (gastado / ingresos) * 100 : null
            }
        })
        .filter((r) => r.ingresos > 0 || r.gastado > 0)
}

function mRenderAnual(anualData) {
    const section = document.getElementById("mSectionAnual")
    const kpiRow = document.getElementById("mkpiRowAnual")

    const resumen = mComputeResumenAnual(anualData)
    _mAnualResumenCache = resumen

    // Se oculta con "hidden" y no con style.display porque el filtro de
    // categorías de la barra superior reescribe el display de estas filas.
    if (!resumen.length) {
        if (section) section.classList.add("hidden")
        if (kpiRow) kpiRow.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")
    if (kpiRow) kpiRow.classList.remove("hidden")

    const totalIngresos = resumen.reduce((s, r) => s + r.ingresos, 0)
    const totalGastado = resumen.reduce((s, r) => s + r.gastado, 0)
    const totalAhorrado = totalIngresos - totalGastado
    const tasaGlobal = totalIngresos > 0 ? (totalAhorrado / totalIngresos) * 100 : 0
    const mediaAhorro = totalAhorrado / resumen.length
    const mejor = resumen.reduce((best, r) => (best === null || r.ahorrado > best.ahorrado ? r : best), null)

    mSetKpi("mkpiAnualGastado", formatEuro(totalGastado))
    mSetKpi("mkpiAnualAhorrado", formatEuro(totalAhorrado), totalAhorrado >= 0 ? "mPositive" : "mNegative")
    mSetKpi("mkpiAnualTasaGlobal", formatPercent(tasaGlobal), tasaGlobal >= 0 ? "mPositive" : "mNegative")
    mSetKpi("mkpiAnualMediaAhorro", formatEuro(mediaAhorro), mediaAhorro >= 0 ? "mPositive" : "mNegative")
    mSetKpi(
        "mkpiAnualMejorAnio",
        mejor ? `${mejor.year} · ${formatEuro(mejor.ahorrado)}` : "---",
        mejor && mejor.ahorrado >= 0 ? "mPositive" : "mNegative"
    )

    // Toggle € / %
    const modeGroup = document.getElementById("mAnualModeGroup")
    if (modeGroup) {
        modeGroup
            .querySelectorAll(".mAnualModeBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.anualmode === _metricasAnualMode))
        if (!modeGroup.dataset.bound) {
            modeGroup.dataset.bound = "true"
            modeGroup.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-anualmode]")
                if (!btn) return
                _metricasAnualMode = btn.dataset.anualmode
                setChartPref("metricasAnualMode", _metricasAnualMode)
                modeGroup
                    .querySelectorAll(".mAnualModeBtn")
                    .forEach((b) => b.classList.toggle("active", b.dataset.anualmode === _metricasAnualMode))
                mDrawAnualBarras(_mAnualResumenCache)
            })
        }
    }

    mDrawAnualBarras(resumen)
    mDrawAnualReparto(totalGastado, totalAhorrado)
    mDrawAnualAcumulado(resumen)
    mRenderAnualTabla(resumen, { totalIngresos, totalGastado, totalAhorrado, tasaGlobal })
}

function mDrawAnualBarras(resumen) {
    const labels = resumen.map((r) => String(r.year))
    const titleEl = document.getElementById("mAnualBarrasTitle")
    const esPct = _metricasAnualMode === "pct"
    if (titleEl) titleEl.textContent = esPct ? "Reparto de los ingresos por año (%)" : "Gastado y ahorrado por año (€)"

    const gastado = resumen.map((r) =>
        esPct ? (r.pctGasto !== null ? parseFloat(r.pctGasto.toFixed(1)) : null) : r.gastado
    )
    const ahorrado = resumen.map((r) => (esPct ? (r.tasa !== null ? parseFloat(r.tasa.toFixed(1)) : null) : r.ahorrado))

    // En % las dos barras se apilan porque juntas son el 100 % de los ingresos.
    // En € van una al lado de otra: apiladas, el ahorro arrancaba a la altura
    // del gasto y no había forma de leer su importe de un vistazo.
    const barraComun = {
        borderWidth: 1,
        borderRadius: 4,
        maxBarThickness: 90,
        // Con un solo año las barras quedarían en los extremos del hueco: se
        // estrecha la categoría para que el par salga junto y centrado.
        categoryPercentage: 0.6,
        barPercentage: 0.92,
        ...(esPct ? { stack: "anual" } : {}),
        yAxisID: esPct ? "y" : "yEur"
    }

    const datasets = [
        {
            ...barraComun,
            label: esPct ? "Gastado (%)" : "Gastado",
            data: gastado,
            backgroundColor: "#e74c3c88",
            borderColor: "#e74c3c"
        },
        {
            ...barraComun,
            label: esPct ? "Ahorrado (%)" : "Ahorrado",
            data: ahorrado,
            backgroundColor: ahorrado.map((v) => ((v ?? 0) >= 0 ? "#2ecc7188" : "#c0392b88")),
            borderColor: ahorrado.map((v) => ((v ?? 0) >= 0 ? "#2ecc71" : "#c0392b"))
        }
    ]

    // La tasa de ahorro vive en el tooltip y como etiqueta sobre la barra de
    // Ahorrado, no en un segundo eje: un gráfico con dos escalas (€ y %)
    // inventa una correlación en la alineación de ambas que no está en los
    // datos.
    const scales = esPct
        ? {
              x: { ...mAxisX(), stacked: true },
              y: {
                  stacked: true,
                  ticks: { color: "#ccd6f6", callback: (v) => v.toFixed(0) + "%" },
                  grid: { color: "rgba(255,255,255,0.06)" }
              }
          }
        : {
              x: mAxisX(),
              yEur: {
                  type: "linear",
                  position: "left",
                  ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) },
                  grid: { color: "rgba(255,255,255,0.06)" }
              }
          }

    // Etiqueta selectiva (una por barra, solo en € — en % ya se lee directo
    // en el eje) con la tasa de ahorro encima de la barra de Ahorrado.
    const tasaLabelPlugin = {
        id: "mAnualTasaLabel",
        afterDatasetsDraw(chart) {
            if (esPct) return
            const meta = chart.getDatasetMeta(1)
            const { ctx } = chart
            ctx.save()
            ctx.font = "600 11px system-ui, -apple-system, sans-serif"
            ctx.fillStyle = "#8899bb"
            ctx.textAlign = "center"
            meta.data.forEach((bar, i) => {
                const r = resumen[i]
                if (!r || r.tasa === null) return
                ctx.textBaseline = r.ahorrado >= 0 ? "bottom" : "top"
                const y = r.ahorrado >= 0 ? bar.y - 6 : bar.y + 6
                ctx.fillText(`${r.tasa.toFixed(0)} %`, bar.x, y)
            })
            ctx.restore()
        }
    }

    mCreateChart("mChartAnualBarras", {
        type: "bar",
        data: { labels, datasets },
        plugins: [tasaLabelPlugin],
        options: {
            ...M_CHART_DEFAULTS,
            interaction: { mode: "index", intersect: false },
            layout: esPct ? {} : { padding: { top: 18 } },
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                tooltip: {
                    // Apiladas, Chart.js lista los items en orden de dataset (gasto
                    // primero) pero el gasto se pinta abajo: se invierte para que el
                    // tooltip se lea igual que la columna, ahorro arriba.
                    ...(esPct ? { itemSort: (a, b) => b.datasetIndex - a.datasetIndex } : {}),
                    callbacks: {
                        label: (c) => {
                            if (c.raw === null) return ` ${c.dataset.label}: ---`
                            if (esPct) return ` ${c.dataset.label}: ${c.raw.toFixed(1).replace(".", ",")}%`
                            return ` ${c.dataset.label}: ${formatEuro(c.raw)}`
                        },
                        afterBody: (items) => {
                            const r = resumen[items[0]?.dataIndex]
                            if (!r) return []
                            const tasa = r.tasa !== null ? `${r.tasa.toFixed(1).replace(".", ",")} %` : "---"
                            return esPct
                                ? [`Ingresos: ${formatEuro(r.ingresos)}`]
                                : [`Ingresos: ${formatEuro(r.ingresos)}`, `Tasa de ahorro: ${tasa}`]
                        }
                    }
                }
            },
            scales
        }
    })
}

function mDrawAnualReparto(totalGastado, totalAhorrado) {
    // Un donut no sabe representar un ahorro negativo, así que en ese caso se
    // enseña la comparación como barras.
    if (totalAhorrado < 0) {
        mCreateChart("mChartAnualReparto", {
            type: "bar",
            data: {
                labels: ["Gastado", "Ahorrado"],
                datasets: [
                    {
                        label: "Acumulado",
                        data: [totalGastado, totalAhorrado],
                        backgroundColor: ["#e74c3c88", "#c0392b88"],
                        borderColor: ["#e74c3c", "#c0392b"],
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
                scales: { x: mAxisX(), y: { ...mAxisY(), ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) } } }
            }
        })
        return
    }

    const total = totalGastado + totalAhorrado
    mCreateChart("mChartAnualReparto", {
        type: "doughnut",
        data: {
            labels: ["Gastado", "Ahorrado"],
            datasets: [
                {
                    data: [totalGastado, totalAhorrado],
                    backgroundColor: ["#e74c3c", "#2ecc71"],
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
                legend: { ...M_CHART_DEFAULTS.plugins.legend, position: "bottom" },
                tooltip: { callbacks: { label: (c) => mGridTooltip(c.label, c.raw, total) } }
            }
        }
    })
}

function mDrawAnualAcumulado(resumen) {
    let acc = 0
    const data = resumen.map((r) => {
        acc += r.ahorrado
        return parseFloat(acc.toFixed(2))
    })

    mCreateChart("mChartAnualAcumulado", {
        type: "line",
        data: {
            labels: resumen.map((r) => String(r.year)),
            datasets: [
                {
                    label: "Ahorro acumulado",
                    data,
                    borderColor: "#2ecc71",
                    backgroundColor: "rgba(46,204,113,0.12)",
                    borderWidth: 2.5,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    pointBackgroundColor: "#2ecc71",
                    tension: 0.35,
                    fill: true
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (c) => ` Acumulado: ${formatEuro(c.raw)}`,
                        afterLabel: (c) => [` Ahorro del año: ${formatEuro(resumen[c.dataIndex].ahorrado)}`]
                    }
                }
            },
            scales: {
                x: mAxisX(),
                y: { ...mAxisY(), ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) } }
            }
        }
    })
}

function mRenderAnualTabla(resumen, totales) {
    const body = document.getElementById("mAnualTableBody")
    const foot = document.getElementById("mAnualTableFoot")
    if (!body) return

    const anioActual = new Date().getFullYear()

    body.innerHTML = resumen
        .map((r) => {
            const cls = r.ahorrado >= 0 ? "mCellPos" : "mCellNeg"
            return `
        <tr>
            <td class="mTdName">${escapeHtml(r.year)}${r.year === anioActual ? " (YTD)" : ""}</td>
            <td>${formatEuro(r.ingresos)}</td>
            <td>${formatEuro(r.gastado)}</td>
            <td class="${cls}">${formatEuro(r.ahorrado)}</td>
            <td>${r.pctGasto !== null ? formatPercent(r.pctGasto) : "---"}</td>
            <td class="${cls}">${r.tasa !== null ? formatPercent(r.tasa) : "---"}</td>
        </tr>`
        })
        .join("")

    if (foot) {
        const cls = totales.totalAhorrado >= 0 ? "mCellPos" : "mCellNeg"
        const pctGasto = totales.totalIngresos > 0 ? (totales.totalGastado / totales.totalIngresos) * 100 : null
        foot.innerHTML = `
        <tr>
            <td class="mTdName">Total</td>
            <td>${formatEuro(totales.totalIngresos)}</td>
            <td>${formatEuro(totales.totalGastado)}</td>
            <td class="${cls}">${formatEuro(totales.totalAhorrado)}</td>
            <td>${pctGasto !== null ? formatPercent(pctGasto) : "---"}</td>
            <td class="${cls}">${formatPercent(totales.tasaGlobal)}</td>
        </tr>`
    }
}

// ── invertido por periodo ──────────────────────────────────────────────────

function mDrawInvertidoMesChart(monthMap, year) {
    const MONTH_ABBR = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    const months = Object.keys(monthMap)
        .filter((k) => k.startsWith(year + "-"))
        .sort()
    const mesLabels = months.map((k) => {
        const mo = k.split("-")[1]
        return MONTH_ABBR[parseInt(mo) - 1]
    })
    const mesValues = months.map((k) => parseFloat((monthMap[k] || 0).toFixed(2)))

    mCreateChart("mChartInvertidoMes", {
        type: "bar",
        data: {
            labels: mesLabels,
            datasets: [
                {
                    label: "Invertido (€)",
                    data: mesValues,
                    backgroundColor: "#3a7bd5aa",
                    borderColor: "#3a7bd5",
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            animation: false,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: { ...mAxisY(), ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) } } }
        }
    })
}

function mRenderInvertidoPeriodo(invData) {
    const section = document.getElementById("mSectionInvertidoPeriodo")
    const monthMap = invData.byMonth || {}
    const yearMap = invData.byYear || {}

    const hasData = Object.keys(monthMap).length > 0
    if (!hasData) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    const years = Object.keys(yearMap).sort()
    if (!_metricasInvertidoYear || !years.includes(_metricasInvertidoYear))
        _metricasInvertidoYear = years[years.length - 1] || null

    const yearToggle = document.getElementById("mInvertidoYearToggle")
    if (yearToggle) {
        yearToggle.innerHTML = years
            .map(
                (y) =>
                    `<button class="mToggleBtn${y === _metricasInvertidoYear ? " active" : ""}" data-invyr="${y}">${y}</button>`
            )
            .join("")
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-invyr]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasInvertidoYear = btn.dataset.invyr
                setChartPref("metricasInvertidoYear", _metricasInvertidoYear)
                mDrawInvertidoMesChart(monthMap, _metricasInvertidoYear)
            })
        }
    }

    if (_metricasInvertidoYear) mDrawInvertidoMesChart(monthMap, _metricasInvertidoYear)

    const anioLabels = years.map((y) => (String(y) === String(new Date().getFullYear()) ? `${y} (YTD)` : y))
    const anioValues = years.map((k) => parseFloat((yearMap[k] || 0).toFixed(2)))

    mCreateChart("mChartInvertidoAnio", {
        type: "bar",
        data: {
            labels: anioLabels,
            datasets: [
                {
                    label: "Invertido (€)",
                    data: anioValues,
                    backgroundColor: "#3a7bd5aa",
                    borderColor: "#3a7bd5",
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
            scales: { x: mAxisX(), y: { ...mAxisY(), ticks: { color: "#ccd6f6", callback: (v) => formatEuro(v) } } }
        }
    })
}

// ── ingresos pasivos histórico ─────────────────────────────────────────────

function mDrawPasivosMesChart(monthMap, year) {
    const MONTH_ABBR = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
    const months = Object.keys(monthMap)
        .filter((k) => k.startsWith(year + "-"))
        .sort()
    const mesLabels = months.map((k) => {
        const mo = k.split("-")[1]
        return MONTH_ABBR[parseInt(mo) - 1]
    })
    const mesValues = months.map((k) => parseFloat((monthMap[k] || 0).toFixed(2)))
    const mesColors = mesValues.map((v) => (v >= 0 ? "#1abc9c" : "#e74c3c"))

    mCreateChart("mChartPasivosMes", {
        type: "bar",
        data: {
            labels: mesLabels,
            datasets: [
                {
                    label: "Ingresos pasivos (€)",
                    data: mesValues,
                    backgroundColor: mesColors.map((c) => c + "aa"),
                    borderColor: mesColors,
                    borderWidth: 1,
                    borderRadius: 4
                }
            ]
        },
        options: {
            ...M_CHART_DEFAULTS,
            animation: false,
            plugins: {
                ...M_CHART_DEFAULTS.plugins,
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => ` ${formatEuro(c.raw)}` } }
            },
            scales: { x: mAxisX(), y: mAxisY() }
        }
    })
}

function mRenderPasivosCharts(dividendos, intereses) {
    const section = document.getElementById("mSectionPasivosEvol")
    const monthMap = {}
    const yearMap = {}

    dividendos.forEach((r) => {
        const p = String(r.fecha || "").split("-")
        if (p.length !== 3) return
        const mon = mParseEsMonth(p[1]) || parseInt(p[1])
        const yr = mParseShortYear(p[2])
        if (!mon || !yr || mon < 1 || mon > 12) return
        const key = `${yr}-${String(mon).padStart(2, "0")}`
        const val = parseEuroNumber(r.total || "")
        monthMap[key] = (monthMap[key] || 0) + val
        yearMap[String(yr)] = (yearMap[String(yr)] || 0) + val
    })

    ;(Array.isArray(intereses) ? intereses : []).forEach((r) => {
        const p = String(r.fecha || "").split("-")
        let mon, yr
        if (p.length === 3) {
            mon = mParseEsMonth(p[1]) || parseInt(p[1])
            yr = mParseShortYear(p[2])
        } else if (p.length === 2) {
            mon = mParseEsMonth(p[0]) || parseInt(p[0])
            yr = mParseShortYear(p[1])
        }
        if (!mon || !yr || mon < 1 || mon > 12) return
        const key = `${yr}-${String(mon).padStart(2, "0")}`
        const val = parseEuroNumber(r.acumulado || "") - parseEuroNumber(r.impuestos || "")
        monthMap[key] = (monthMap[key] || 0) + val
        yearMap[String(yr)] = (yearMap[String(yr)] || 0) + val
    })

    const hasData = Object.keys(monthMap).length > 0 || Object.keys(yearMap).length > 0
    if (!hasData) {
        if (section) section.classList.add("hidden")
        return
    }
    if (section) section.classList.remove("hidden")

    // ── year toggle buttons ──
    const years = Object.keys(yearMap).sort()
    if (!_metricasPasivosYear || !years.includes(_metricasPasivosYear))
        _metricasPasivosYear = years[years.length - 1] || null

    const yearToggle = document.getElementById("mPasivosYearToggle")
    if (yearToggle) {
        yearToggle.innerHTML = years
            .map(
                (y) =>
                    `<button class="mToggleBtn${y === _metricasPasivosYear ? " active" : ""}" data-pasmy="${y}">${y}</button>`
            )
            .join("")
        if (!yearToggle.dataset.bound) {
            yearToggle.dataset.bound = "true"
            yearToggle.addEventListener("click", (e) => {
                const btn = e.target.closest("[data-pasmy]")
                if (!btn) return
                yearToggle.querySelectorAll(".mToggleBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
                _metricasPasivosYear = btn.dataset.pasmy
                setChartPref("metricasPasivosYear", _metricasPasivosYear)
                mDrawPasivosMesChart(monthMap, _metricasPasivosYear)
            })
        }
    }

    // ── chart por mes (año seleccionado) ──
    if (_metricasPasivosYear) mDrawPasivosMesChart(monthMap, _metricasPasivosYear)

    // ── chart por año ──
    const anioLabels = years.map((y) => (String(y) === String(new Date().getFullYear()) ? `${y} (YTD)` : y))
    const anioValues = years.map((k) => parseFloat((yearMap[k] || 0).toFixed(2)))
    const anioColors = anioValues.map((v) => (v >= 0 ? "#1abc9c" : "#e74c3c"))

    mCreateChart("mChartPasivosAnio", {
        type: "bar",
        data: {
            labels: anioLabels,
            datasets: [
                {
                    label: "Ingresos pasivos (€)",
                    data: anioValues,
                    backgroundColor: anioColors.map((c) => c + "aa"),
                    borderColor: anioColors,
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
            scales: { x: mAxisX(), y: mAxisY() }
        }
    })
}
