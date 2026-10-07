// Métricas: evolución histórica, comparativa con un índice y evolución por tipo de activo.
//
// Separado de js/analisis/metricas.js, que pasaba de 6.000 líneas. Es código
// de nivel superior que comparte el ámbito global con el resto de trozos
// (index.html los carga seguidos y en este orden); no ha cambiado.

// ── Evolución histórica del portfolio ──────────────────────────────────────

let _evolucionRange = getChartPref("evolucionRange", "1D")
let _evolucionMode = getChartPref("evolucionMode", "eur")

async function mRenderEvolucion(range, mode) {
    mode = mode || _evolucionMode
    const empty = document.getElementById("mEvolucionEmpty")
    const wrap = document.getElementById("mEvolucionChartWrap")

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
        const liveValue = summaries.reduce((s, a) => s + a.netoActualEur, 0)
        const liveInvested = summaries.reduce((s, a) => s + a.invertidoEur, 0)
        const nowTs = Math.floor(Date.now() / 1000)
        const lastTs = points.length ? points[points.length - 1].ts : 0
        // Replace last point if it's within 2 minutes, otherwise append
        if (points.length && nowTs - lastTs < 120) {
            points = [...points.slice(0, -1), { ts: nowTs, v: liveValue, i: liveInvested }]
        } else {
            points = [...points, { ts: nowTs, v: liveValue, i: liveInvested }]
        }
    }

    if (points.length < 2) {
        mSetEvolucionEmpty(null)
        mSetEvolucionNota(null)
        if (empty) empty.classList.remove("hidden")
        if (wrap) wrap.classList.add("hidden")
        mDestroyChart("mChartEvolucion")
        const oldTip = document.getElementById("mEvolucionTooltip")
        if (oldTip) oldTip.remove()
        return
    }

    // El modo comparativo tiene poco que ver con los otros dos: no dibuja
    // euros ni el invertido, sino dos series de variación porcentual. Se va por su rama
    // antes de montar todo el andamiaje del gráfico de valor.
    if (mode === "vs") {
        await mDrawEvolucionVsIndice(points)
        return
    }

    mSetEvolucionNota(null)
    if (empty) empty.classList.add("hidden")
    if (wrap) wrap.classList.remove("hidden")

    // Eliminar tooltip anterior si existía
    const oldTip = document.getElementById("mEvolucionTooltip")
    if (oldTip) oldTip.remove()

    const values = points.map((p) => p.v)
    const invested = points.map((p) => p.i)
    const span = points.length > 1 ? points[points.length - 1].ts - points[0].ts : 0
    const isPct = mode === "pct"

    const dispValues = isPct
        ? values.map((v, idx) => {
              const inv = invested[idx] || 1
              return +(((v - inv) / inv) * 100).toFixed(2)
          })
        : values
    const dispInvested = isPct ? values.map(() => 0) : invested

    // Round interval for axis labels so ticks land on clean boundaries
    let roundSec
    if (span <= 86400)
        roundSec = 300 // ≤1D  → cada 5 min
    else if (span <= 31 * 86400)
        roundSec = 21600 // ≤1M  → cada 6h
    else if (span <= 365 * 86400)
        roundSec = 86400 // ≤1A  → cada día
    else roundSec = 7 * 86400 // >1A  → cada semana

    const labels = points.map((p) => {
        const snap = Math.round(p.ts / roundSec) * roundSec
        const d = new Date(snap * 1000)
        if (roundSec >= 86400)
            return d.toLocaleDateString("es-ES", {
                day: "2-digit",
                month: "2-digit",
                ...(roundSec >= 7 * 86400 ? { year: "2-digit" } : {})
            })
        return (
            d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" }) +
            " " +
            d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
        )
    })

    // Color dinámico por punto: verde si valor >= invertido, rojo si no
    function segmentColor(ctx) {
        const i = ctx.p1DataIndex
        return values[i] >= invested[i] ? "#2ecc71" : "#e74c3c"
    }

    function segmentColorPct(ctx) {
        const i = ctx.p1DataIndex
        return dispValues[i] >= dispInvested[i] ? "#2ecc71" : "#e74c3c"
    }

    const tooltipDates = points.map((p) => {
        const d = new Date(p.ts * 1000)
        return d.toLocaleString("es-ES", {
            weekday: "short",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        })
    })

    // Plugin crosshair: línea vertical + horizontal siguiendo el cursor
    let _evolucionMouseY = null
    const crosshairPlugin = {
        id: "evolucionCrosshair",
        afterInit(chart) {
            chart.canvas.addEventListener("mousemove", (e) => {
                const rect = chart.canvas.getBoundingClientRect()
                _evolucionMouseY = e.clientY - rect.top
                chart.draw()
            })
            chart.canvas.addEventListener("mouseleave", () => {
                _evolucionMouseY = null
                chart.draw()
            })
        },
        afterDraw(chart) {
            const { ctx, chartArea, tooltip } = chart
            if (!tooltip || !tooltip._active || !tooltip._active.length) return
            const x = tooltip._active[0].element.x
            ctx.save()
            ctx.lineWidth = 1
            ctx.strokeStyle = "rgba(200,210,255,0.25)"
            ctx.setLineDash([4, 4])
            // Línea vertical
            ctx.beginPath()
            ctx.moveTo(x, chartArea.top)
            ctx.lineTo(x, chartArea.bottom)
            ctx.stroke()
            // Línea horizontal siguiendo el cursor real
            if (
                _evolucionMouseY !== null &&
                _evolucionMouseY >= chartArea.top &&
                _evolucionMouseY <= chartArea.bottom
            ) {
                ctx.beginPath()
                ctx.moveTo(chartArea.left, _evolucionMouseY)
                ctx.lineTo(chartArea.right, _evolucionMouseY)
                ctx.stroke()
            }
            ctx.restore()
        }
    }

    // Tooltip HTML externo para mayor control visual
    function evolucionTooltipHandler(context) {
        const { chart, tooltip } = context
        let el = document.getElementById("mEvolucionTooltip")
        if (!el) {
            el = document.createElement("div")
            el.id = "mEvolucionTooltip"
            el.style.cssText = [
                "position:absolute",
                "pointer-events:none",
                "z-index:99",
                "background:#1a2235",
                "border:1px solid rgba(100,130,200,0.35)",
                "border-radius:8px",
                "padding:10px 14px",
                "min-width:180px",
                "box-shadow:0 4px 24px rgba(0,0,0,0.5)",
                "transition:opacity 0.12s",
                "font-family:inherit",
                "font-size:12px",
                "color:#ccd6f6",
                "line-height:1.6"
            ].join(";")
            chart.canvas.parentElement.style.position = "relative"
            chart.canvas.parentElement.appendChild(el)
        }

        if (tooltip.opacity === 0) {
            el.style.opacity = "0"
            return
        }

        if (!tooltip.dataPoints || !tooltip.dataPoints.length) return
        const dp = tooltip.dataPoints[0]
        const idx = dp.dataIndex
        const val = values[idx]
        const inv = invested[idx]
        const rend = val - inv
        const pct = inv > 0 ? ((rend / inv) * 100).toFixed(2) : "0.00"
        const sign = rend >= 0 ? "+" : ""
        const rendColor = rend >= 0 ? "#2ecc71" : "#e74c3c"
        const dotColor = val >= inv ? "#2ecc71" : "#e74c3c"

        if (isPct) {
            const vPct = dispValues[idx]
            const vSign = vPct >= 0 ? "+" : ""
            el.innerHTML = `
                <div style="color:#8899bb;font-size:11px;margin-bottom:6px;font-weight:500">${tooltipDates[idx] || ""}</div>
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">
                    <span style="width:9px;height:9px;border-radius:50%;background:${dotColor};flex-shrink:0;display:inline-block"></span>
                    <span style="color:#a0b0cc">Valor total</span>
                    <span style="margin-left:auto;font-weight:600;color:${dotColor}">${vSign}${vPct.toFixed(2).replace(".", ",")}%</span>
                </div>
                <div style="border-top:1px solid rgba(100,130,200,0.2);margin-top:6px;padding-top:5px;display:flex;align-items:center;gap:6px">
                    <span style="color:#a0b0cc">Rendimiento</span>
                    <span style="margin-left:auto;font-weight:700;color:${rendColor}">${sign}${formatEuro(rend)} (${sign}${pct.replace(".", ",")}%)</span>
                </div>`
        } else {
            el.innerHTML = `
                <div style="color:#8899bb;font-size:11px;margin-bottom:6px;font-weight:500">${tooltipDates[idx] || ""}</div>
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">
                    <span style="width:9px;height:9px;border-radius:50%;background:${dotColor};flex-shrink:0;display:inline-block"></span>
                    <span style="color:#a0b0cc">Valor total</span>
                    <span style="margin-left:auto;font-weight:600;color:#e8eeff">${formatEuro(val)}</span>
                </div>
                <div style="display:flex;align-items:center;gap:7px;margin-bottom:3px">
                    <span style="width:9px;height:2px;background:rgba(100,130,200,0.7);flex-shrink:0;display:inline-block"></span>
                    <span style="color:#a0b0cc">Invertido</span>
                    <span style="margin-left:auto;font-weight:600;color:#e8eeff">${formatEuro(inv)}</span>
                </div>
                <div style="border-top:1px solid rgba(100,130,200,0.2);margin-top:6px;padding-top:5px;display:flex;align-items:center;gap:6px">
                    <span style="color:#a0b0cc">Rendimiento</span>
                    <span style="margin-left:auto;font-weight:700;color:${rendColor}">${sign}${formatEuro(rend)} (${sign}${pct.replace(".", ",")}%)</span>
                </div>`
        }

        // Posición relativa al área del gráfico, no al canvas: así el
        // tooltip no se sale por el borde cuando hay ejes anchos.
        const xPos = tooltip.caretX
        const elW = 200
        const left = xPos + elW + 10 > chart.chartArea.right ? xPos - elW - 12 : xPos + 12
        el.style.left = left + "px"
        el.style.top = chart.chartArea.top + 8 + "px"
        el.style.opacity = "1"
    }

    const activeSegColor = isPct ? segmentColorPct : segmentColor

    mCreateChart("mChartEvolucion", {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Valor total",
                    data: dispValues,
                    borderColor: activeSegColor,
                    segment: { borderColor: activeSegColor },
                    backgroundColor: "transparent",
                    borderWidth: 2,
                    pointRadius: points.length <= 60 ? 3 : 0,
                    pointHoverRadius: 0,
                    fill: {
                        // En % la referencia es siempre el 0 del eje, así que se
                        // rellena contra el origen y no hace falta la serie plana.
                        target: isPct ? "origin" : 1,
                        above: "rgba(46,204,113,0.12)",
                        below: "rgba(231,76,60,0.12)"
                    },
                    tension: 0.3
                },
                // La línea de invertido solo aporta en €: en % sería una recta en 0.
                ...(isPct
                    ? []
                    : [
                          {
                              label: "Invertido",
                              data: dispInvested,
                              borderColor: "rgba(100,130,200,0.7)",
                              backgroundColor: "transparent",
                              borderWidth: 1.5,
                              borderDash: [5, 4],
                              pointRadius: 0,
                              pointHoverRadius: 0,
                              pointStyle: "line",
                              fill: false,
                              tension: 0.3
                          }
                      ])
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: {
                    labels: {
                        color: "#ccd6f6",
                        font: { size: 12 },
                        padding: 14,
                        usePointStyle: true,
                        generateLabels(chart) {
                            const items = Chart.defaults.plugins.legend.labels.generateLabels(chart)
                            if (items[0]) {
                                const lastColor =
                                    values[values.length - 1] >= invested[values.length - 1] ? "#2ecc71" : "#e74c3c"
                                items[0].strokeStyle = lastColor
                                items[0].fillStyle = lastColor
                                items[0].pointStyle = "line"
                                items[0].lineWidth = 2
                            }
                            return items
                        }
                    }
                },
                tooltip: {
                    enabled: false,
                    external: evolucionTooltipHandler
                }
            },
            scales: {
                x: {
                    ticks: { color: "#8899bb", maxTicksLimit: 8, maxRotation: 0 },
                    grid: { color: "rgba(255,255,255,0.06)" }
                },
                y: {
                    ticks: {
                        color: "#ccd6f6",
                        callback: isPct
                            ? (v) => (v >= 0 ? "+" : "") + v.toFixed(1).replace(".", ",") + "%"
                            : (v) => formatEuro(v)
                    },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            }
        },
        plugins: [crosshairPlugin]
    })
}

// ── comparativa contra un índice ───────────────────────────────────────────

// La cartera se compara con el índice usando su serie TWR en variación %, no su
// valor en euros: si se compara el valor, una aportación de 5.000 € parece un
// +40 % que el índice "no ha conseguido", y la comparación deja de significar
// nada. La TWR quita precisamente eso.

let _benchmarkIndice = getChartPref("evolucionBenchmark", "sp500")

// El cartel de "sin datos" es compartido con los otros dos modos, así que el
// modo comparativo lo cambia y luego lo devuelve a su sitio.
const M_EVOLUCION_EMPTY_DEFECTO =
    "Aún no hay datos históricos. El portfolio se registra automáticamente en cada actualización de precios."

function mSetEvolucionEmpty(texto) {
    const span = document.getElementById("mEvolucionEmpty")?.querySelector("span")
    if (span) span.textContent = texto || M_EVOLUCION_EMPTY_DEFECTO
}

function mDiaIso(ts) {
    const d = new Date(ts * 1000)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

// Un valor por día (el último), que es la granularidad a la que se compara.
function mPorDia(puntos, campo) {
    const mapa = new Map()
    puntos.forEach((p) => mapa.set(mDiaIso(p.ts), p[campo]))
    return mapa
}

// Variación porcentual acumulada desde el día de arranque común, que llega ya
// recortado en `dias`: la serie vale directamente el % (0 el primer día), sin
// pasar por base 100. Si una serie no cotiza ese día concreto (festivo del
// índice) se toma el primero que sí tenga dato: mover la base un día no
// descuadra la comparación, pero dejar la serie entera a null la haría
// desaparecer.
function mVariacionPct(mapa, dias) {
    let base = null
    return dias.map((dia) => {
        const valor = mapa.get(dia)
        if (valor === undefined) return null
        if (base === null) base = valor
        return base > 0 ? +((valor / base - 1) * 100).toFixed(2) : null
    })
}

// El índice no cotiza fines de semana ni festivos, pero la cartera sí tiene
// snapshot: sin arrastrar el último cierre la línea del índice queda con
// huecos y el tooltip de esos días sale vacío.
// `previos` son los cierres anteriores al primer día del rango: si la cartera
// arranca en sábado hay que partir del cierre del viernes, o el índice se
// quedaría sin base y empezaría un par de días más tarde que la cartera.
function mArrastrarCierres(mapa, dias, previos = []) {
    const lleno = new Map()
    let ultimo = previos.length ? mapa.get(previos[previos.length - 1]) : undefined
    dias.forEach((dia) => {
        const valor = mapa.get(dia)
        if (valor !== undefined) ultimo = valor
        if (ultimo !== undefined) lleno.set(dia, ultimo)
    })
    return lleno
}

function mSetEvolucionNota(texto) {
    const el = document.getElementById("mEvolucionNota")
    if (!el) return
    el.textContent = texto || ""
    el.classList.toggle("hidden", !texto)
}

// Los días de estas series son "YYYY-MM-DD", no epoch: se pasa a segundos para
// que los formatee el mFechaCorta de siempre.
function mDiaLegible(dia) {
    const [a, m, j] = dia.split("-").map(Number)
    return mFechaCorta(new Date(a, m - 1, j).getTime() / 1000)
}

async function mDrawEvolucionVsIndice(points) {
    const empty = document.getElementById("mEvolucionEmpty")
    const wrap = document.getElementById("mEvolucionChartWrap")
    // Este modo usa el tooltip normal de Chart.js; el HTML que monta el modo
    // en euros se quedaría flotando encima.
    document.getElementById("mEvolucionTooltip")?.remove()
    const desde = points[0].ts
    const hasta = points[points.length - 1].ts

    const fallar = (motivo) => {
        mSetEvolucionEmpty(motivo)
        mSetEvolucionNota(null)
        if (empty) empty.classList.remove("hidden")
        if (wrap) wrap.classList.add("hidden")
        mDestroyChart("mChartEvolucion")
    }

    // La serie TWR la calcula el servidor sobre todo el histórico; aquí se
    // recorta al rango que se está mirando.
    const indiceCartera = (_metricasPayload?.rentabilidad?.indice || []).filter((p) => p.ts >= desde && p.ts <= hasta)

    let bench = null
    // Se piden unos días de más por delante para tener siempre un cierre
    // anterior con el que arrancar aunque el rango empiece en fin de semana o
    // en festivo; los sobrantes se recortan al alinear las series.
    const desdeBench = desde - 7 * 86400
    try {
        const resp = await fetch(
            `/api/market/benchmark?indice=${encodeURIComponent(_benchmarkIndice)}&from=${desdeBench}&to=${hasta}`
        )
        const data = await resp.json()
        if (data.ok && Array.isArray(data.data) && data.data.length) bench = data
    } catch (_) {
        /* sin índice se dibuja solo la cartera */
    }

    const carteraPorDia = mPorDia(indiceCartera, "idx")
    if (carteraPorDia.size < 2) {
        // Con un solo día de histórico diario no hay nada que encadenar: una
        // cartera recién estrenada cae aquí.
        fallar("Hacen falta al menos dos días de histórico para comparar contra un índice.")
        return
    }

    // Las dos series tienen que arrancar el mismo día o la comparación miente:
    // si el índice empieza más tarde, su origen cae en una fecha distinta y
    // se le regala (o se le quita) todo el tramo intermedio.
    const diasCartera = [...carteraPorDia.keys()].sort()
    let dias = diasCartera
    let benchPorDia = new Map()
    const nombreBench = bench?.nombre || "Índice"

    if (bench) {
        const crudo = mPorDia(bench.data, "close")
        const diasBench = [...crudo.keys()].sort()
        const arranque = diasBench[0] > diasCartera[0] ? diasBench[0] : diasCartera[0]
        dias = diasCartera.filter((d) => d >= arranque)
        benchPorDia = mArrastrarCierres(
            crudo,
            dias,
            diasBench.filter((d) => d < dias[0])
        )
    }

    if (dias.length < 2) {
        fallar(`No hay días solapados suficientes entre la cartera y ${nombreBench} en este rango.`)
        return
    }

    if (empty) empty.classList.add("hidden")
    if (wrap) wrap.classList.remove("hidden")

    const serieCartera = mVariacionPct(carteraPorDia, dias)
    const serieBench = bench ? mVariacionPct(benchPorDia, dias) : []
    const multiAnio = dias[0].slice(0, 4) !== dias[dias.length - 1].slice(0, 4)
    const labels = dias.map((d) => {
        const [a, m, j] = d.split("-")
        if (dias.length > 400) return `${m}/${a.slice(2)}`
        return multiAnio ? `${j}/${m}/${a.slice(2)}` : `${j}/${m}`
    })

    const ultimo = [...serieCartera].reverse().find((v) => v !== null) ?? 0
    const colorCartera = ultimo >= 0 ? "#2ecc71" : "#e74c3c"

    if (!bench) {
        mSetEvolucionNota("No se ha podido cargar el índice de comparación; se muestra solo la cartera.")
    } else {
        const ultimoBench = [...serieBench].reverse().find((v) => v !== null) ?? 0
        // Diferencia porcentual, no en puntos: lo que se responde es "cuánto
        // más (o menos) ha rendido la cartera que el índice", que es comparar
        // los dos multiplicadores, no restar los dos porcentajes.
        const dif = ((1 + ultimo / 100) / (1 + ultimoBench / 100) - 1) * 100
        const signo = dif >= 0 ? "+" : "−"
        mSetEvolucionNota(
            `Variación desde el ${mDiaLegible(dias[0])}. La cartera va ${signo}${Math.abs(dif).toFixed(2).replace(".", ",")} % ` +
                `respecto a ${nombreBench}. Se compara la TWR de la cartera, que ignora aportaciones y retiradas.`
        )
    }

    mCreateChart("mChartEvolucion", {
        type: "line",
        data: {
            labels,
            datasets: [
                {
                    label: "Cartera (TWR)",
                    data: serieCartera,
                    borderColor: colorCartera,
                    backgroundColor: "transparent",
                    borderWidth: 2,
                    // Con pocos días la línea se ve mejor con los puntos
                    // marcados; en un año serían un churro.
                    pointRadius: dias.length <= 20 ? 2.5 : 0,
                    pointHoverRadius: 4,
                    spanGaps: true,
                    tension: 0.25
                },
                ...(bench
                    ? [
                          {
                              label: nombreBench,
                              data: serieBench,
                              borderColor: "#8ea2c6",
                              backgroundColor: "transparent",
                              borderWidth: 1.5,
                              borderDash: [5, 4],
                              pointRadius: dias.length <= 20 ? 2.5 : 0,
                              pointHoverRadius: 4,
                              spanGaps: true,
                              tension: 0.25
                          }
                      ]
                    : [])
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { labels: { color: "#ccd6f6", font: { size: 12 }, padding: 14, usePointStyle: true } },
                tooltip: {
                    callbacks: {
                        // La serie ya viene en %, que es la pregunta real:
                        // quién va por delante y cuánto.
                        label: (c) => {
                            if (c.raw === null) return null
                            return ` ${c.dataset.label}: ${(c.raw >= 0 ? "+" : "") + c.raw.toFixed(2).replace(".", ",")} %`
                        }
                    }
                }
            },
            scales: {
                x: {
                    ...mAxisX(),
                    ticks: { color: "#8899bb", maxTicksLimit: 12, autoSkip: true }
                },
                y: {
                    ticks: {
                        color: "#ccd6f6",
                        maxTicksLimit: 8,
                        // Con rangos estrechos (unos décimos de punto) redondear
                        // a entero repite "+0%" en todas las marcas: los
                        // decimales salen del salto real entre marcas.
                        callback: (v, i, marcas) => {
                            const salto = marcas.length > 1 ? Math.abs(marcas[1].value - marcas[0].value) : 1
                            const dec = salto >= 1 ? 0 : salto >= 0.1 ? 1 : 2
                            return (v >= 0 ? "+" : "") + v.toFixed(dec).replace(".", ",") + "%"
                        }
                    },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            }
        }
    })
}

async function mInitBenchmarkSelect() {
    const sel = document.getElementById("mBenchmarkSelect")
    if (!sel || sel.dataset.listo) return
    sel.dataset.listo = "1"

    let indices = []
    try {
        const data = await fetch("/api/market/benchmarks").then((r) => r.json())
        indices = data.ok ? data.indices : []
    } catch (_) {
        /* sin catálogo, el desplegable se queda vacío y oculto */
    }

    if (!indices.length) return
    sel.innerHTML = indices
        .map((i) => `<option value="${escapeMetricasHtml(i.clave)}">${escapeMetricasHtml(i.nombre)}</option>`)
        .join("")
    if (indices.some((i) => i.clave === _benchmarkIndice)) sel.value = _benchmarkIndice
    else _benchmarkIndice = sel.value

    sel.addEventListener("change", () => {
        _benchmarkIndice = sel.value
        setChartPref("evolucionBenchmark", _benchmarkIndice)
        mRenderEvolucion(_evolucionRange, _evolucionMode)
    })
}

// Basta con marcar el <select>: el envoltorio .csWrapper que le monta encima
// el select personalizado se oculta solo (regla :has en base.css), y así da
// igual si el widget ya se había construido o no cuando se llama a esto.
async function mSyncBenchmarkSelect() {
    const sel = document.getElementById("mBenchmarkSelect")
    if (!sel) return
    if (_evolucionMode !== "vs") {
        sel.classList.add("hidden")
        return
    }
    await mInitBenchmarkSelect()
    sel.classList.toggle("hidden", sel.options.length === 0)
}

// Un solo día no da dos cierres que encadenar, así que el modo comparativo no
// tiene nada que dibujar en 1D: se bloquea el botón y se cae a 1S.
const M_VS_RANGOS_BLOQUEADOS = new Set(["1D"])
const M_VS_RANGO_DEFECTO = "1W"

function mSyncRangosVs() {
    const esVs = _evolucionMode === "vs"
    let cambiado = false
    if (esVs && M_VS_RANGOS_BLOQUEADOS.has(_evolucionRange)) {
        _evolucionRange = M_VS_RANGO_DEFECTO
        setChartPref("evolucionRange", _evolucionRange)
        cambiado = true
    }
    document.querySelectorAll(".mEvolucionRangeBtn").forEach((b) => {
        b.disabled = esVs && M_VS_RANGOS_BLOQUEADOS.has(b.dataset.range)
        b.title = b.disabled ? "Necesita al menos dos días de cierres" : ""
        if (cambiado) b.classList.toggle("active", b.dataset.range === _evolucionRange)
    })
}

function mInitEvolucion() {
    const rangeBtns = document.querySelectorAll(".mEvolucionRangeBtn")
    const modeBtns = document.querySelectorAll(".mEvolucionModeBtn")

    rangeBtns.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.range === _evolucionRange)
        btn.addEventListener("click", () => {
            rangeBtns.forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _evolucionRange = btn.dataset.range
            setChartPref("evolucionRange", _evolucionRange)
            const oldTip = document.getElementById("mEvolucionTooltip")
            if (oldTip) oldTip.remove()
            mRenderEvolucion(_evolucionRange, _evolucionMode)
        })
    })

    modeBtns.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === _evolucionMode)
        btn.addEventListener("click", () => {
            modeBtns.forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _evolucionMode = btn.dataset.mode
            setChartPref("evolucionMode", _evolucionMode)
            const oldTip = document.getElementById("mEvolucionTooltip")
            if (oldTip) oldTip.remove()
            mSyncRangosVs()
            // Se espera al desplegable: si la preferencia guardada ya no
            // existe en el catálogo, hay que corregirla antes de pedir la serie.
            mSyncBenchmarkSelect().then(() => mRenderEvolucion(_evolucionRange, _evolucionMode))
        })
    })

    mSyncRangosVs()
    mSyncBenchmarkSelect().then(() => mRenderEvolucion(_evolucionRange, _evolucionMode))
}

// ── Evolución por tipo de activo ───────────────────────────────────────────

let _evolucionTiposRange = getChartPref("evolucionTiposRange", "1D")
// El modo vivía en su propia clave de localStorage; se migra a las preferencias
// de gráficos para no perder la elección de quien ya la tenía guardada.
let _evolucionTiposMode = getChartPref("evolucionTiposMode", localStorage.getItem("evolucionTiposMode") || "eur")

async function mRenderEvolucionTipos(range, mode) {
    const empty = document.getElementById("mEvolucionTiposEmpty")
    const wrap = document.getElementById("mEvolucionTiposChartWrap")

    let resp, data
    try {
        resp = await fetch(`/api/portfolio/history/by-type?range=${range}`)
        data = await resp.json()
    } catch (_) {
        return
    }

    let points = Array.isArray(data.data) ? data.data : []

    // Añadir punto en vivo con valores y coste actual por tipo
    if (_metricasPayload) {
        const { summaries } = _metricasPayload
        const liveByType = {}
        const liveCostByType = {}
        summaries.forEach((a) => {
            if (a.type) {
                liveByType[a.type] = (liveByType[a.type] || 0) + (a.netoActualEur || 0)
                liveCostByType[a.type] = (liveCostByType[a.type] || 0) + (a.invertidoEur || 0)
            }
        })
        if (Object.keys(liveByType).length) {
            const nowTs = Math.floor(Date.now() / 1000)
            const lastTs = points.length ? points[points.length - 1].ts : 0
            const livePoint = { ts: nowTs, ...liveByType }
            Object.keys(liveCostByType).forEach((t) => {
                livePoint[`c_${t}`] = liveCostByType[t]
            })
            if (points.length && nowTs - lastTs < 120) {
                points = [...points.slice(0, -1), livePoint]
            } else {
                points = [...points, livePoint]
            }
        }
    }

    const typeSet = new Set()
    points.forEach((p) => {
        Object.keys(p).forEach((k) => {
            if (k !== "ts" && !k.startsWith("c_")) typeSet.add(k)
        })
    })
    const types = [...typeSet]

    // Coste de fallback para snapshots antiguos sin cost_eur
    const fallbackCost = {}
    if (_metricasPayload) {
        _metricasPayload.summaries.forEach((a) => {
            if (a.type) fallbackCost[a.type] = (fallbackCost[a.type] || 0) + (a.invertidoEur || 0)
        })
    }
    const pointCost = (p, t) => {
        const c = p[`c_${t}`]
        return c && c > 0 ? c : fallbackCost[t] || 0
    }

    if (types.length === 0) {
        if (empty) empty.classList.remove("hidden")
        if (wrap) wrap.classList.add("hidden")
        mDestroyChart("mChartEvolucionTipos")
        const oldTip = document.getElementById("mEvolucionTiposTooltip")
        if (oldTip) oldTip.remove()
        return
    }

    // Si solo hay 1 punto (live), añadir un punto sintético al inicio del rango para mostrar línea plana
    if (points.length === 1) {
        const rangeMap = {
            "1D": 86400,
            "1W": 7 * 86400,
            "1M": 30 * 86400,
            "3M": 90 * 86400,
            "6M": 180 * 86400,
            "1Y": 365 * 86400,
            ALL: 365 * 86400,
            YTD: 365 * 86400
        }
        const rangeSpan = rangeMap[range] || 86400
        const startTs = points[0].ts - rangeSpan
        const { ts: _ts, ...typeVals } = points[0]
        points = [{ ts: startTs, ...typeVals }, ...points]
    }

    if (empty) empty.classList.add("hidden")
    if (wrap) wrap.classList.remove("hidden")

    const span = points.length > 1 ? points[points.length - 1].ts - points[0].ts : 0
    let roundSec
    if (span <= 86400) roundSec = 300
    else if (span <= 31 * 86400) roundSec = 21600
    else if (span <= 365 * 86400) roundSec = 86400
    else roundSec = 7 * 86400

    const labels = points.map((p) => {
        const snap = Math.round(p.ts / roundSec) * roundSec
        const d = new Date(snap * 1000)
        if (roundSec >= 86400)
            return d.toLocaleDateString("es-ES", {
                day: "2-digit",
                month: "2-digit",
                ...(roundSec >= 7 * 86400 ? { year: "2-digit" } : {})
            })
        return (
            d.toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit" }) +
            " " +
            d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })
        )
    })

    const tooltipDates = points.map((p) => {
        const d = new Date(p.ts * 1000)
        return d.toLocaleString("es-ES", {
            weekday: "short",
            day: "2-digit",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
        })
    })

    const isPct = mode === "pct"

    // Sort types by last-point value descending so legend and tooltip match ranking
    const lastPoint = points[points.length - 1]
    types.sort((a, b) => {
        const rawA = lastPoint?.[a] ?? null
        const rawB = lastPoint?.[b] ?? null
        if (rawA === null) return 1
        if (rawB === null) return -1
        if (isPct) {
            const costA = pointCost(lastPoint, a) || 1
            const costB = pointCost(lastPoint, b) || 1
            const valA = ((rawA - costA) / costA) * 100
            const valB = ((rawB - costB) / costB) * 100
            return valB - valA
        }
        return rawB - rawA
    })

    const datasets = types.map((type) => {
        const color = M_TYPE_COLORS[type] || mPaletteForName(type)
        const label = M_TYPE_LABELS[type] || type

        const values = points.map((p) => {
            const v = p[type] ?? null
            if (v === null) return null
            if (isPct) {
                const cost = pointCost(p, type)
                if (cost === 0) return null
                return +(((v - cost) / cost) * 100).toFixed(2)
            }
            return v
        })

        return {
            label,
            data: values,
            borderColor: color,
            backgroundColor: "transparent",
            borderWidth: 2,
            pointRadius: points.length <= 60 ? 2 : 0,
            pointHoverRadius: 0,
            tension: 0.3,
            spanGaps: true
        }
    })

    let _tiposMouseY = null
    const crosshairPlugin = {
        id: "tiposCrosshair",
        afterInit(chart) {
            chart.canvas.addEventListener("mousemove", (e) => {
                const rect = chart.canvas.getBoundingClientRect()
                _tiposMouseY = e.clientY - rect.top
                chart.draw()
            })
            chart.canvas.addEventListener("mouseleave", () => {
                _tiposMouseY = null
                chart.draw()
            })
        },
        afterDraw(chart) {
            const { ctx, chartArea, tooltip } = chart
            if (!tooltip || !tooltip._active || !tooltip._active.length) return
            const x = tooltip._active[0].element.x
            ctx.save()
            ctx.lineWidth = 1
            ctx.strokeStyle = "rgba(200,210,255,0.25)"
            ctx.setLineDash([4, 4])
            ctx.beginPath()
            ctx.moveTo(x, chartArea.top)
            ctx.lineTo(x, chartArea.bottom)
            ctx.stroke()
            if (_tiposMouseY !== null && _tiposMouseY >= chartArea.top && _tiposMouseY <= chartArea.bottom) {
                ctx.beginPath()
                ctx.moveTo(chartArea.left, _tiposMouseY)
                ctx.lineTo(chartArea.right, _tiposMouseY)
                ctx.stroke()
            }
            ctx.restore()
        }
    }

    function tiposTooltipHandler(context) {
        const { chart, tooltip } = context
        let el = document.getElementById("mEvolucionTiposTooltip")
        if (!el) {
            el = document.createElement("div")
            el.id = "mEvolucionTiposTooltip"
            el.style.cssText = [
                "position:absolute",
                "pointer-events:none",
                "z-index:99",
                "background:#1a2235",
                "border:1px solid rgba(100,130,200,0.35)",
                "border-radius:8px",
                "padding:10px 14px",
                "min-width:180px",
                "box-shadow:0 4px 24px rgba(0,0,0,0.5)",
                "transition:opacity 0.12s",
                "font-family:inherit",
                "font-size:12px",
                "color:#ccd6f6",
                "line-height:1.6"
            ].join(";")
            chart.canvas.parentElement.style.position = "relative"
            chart.canvas.parentElement.appendChild(el)
        }

        if (tooltip.opacity === 0) {
            el.style.opacity = "0"
            return
        }
        if (!tooltip.dataPoints || !tooltip.dataPoints.length) return

        const idx = tooltip.dataPoints[0].dataIndex
        const date = tooltipDates[idx]

        let html = `<div style="font-size:11px;color:#8899bb;margin-bottom:6px">${date}</div>`
        const tooltipTypes = [...types].sort((a, b) => {
            const rawA = points[idx][a] ?? null
            const rawB = points[idx][b] ?? null
            if (rawA === null) return 1
            if (rawB === null) return -1
            if (isPct) {
                const costA = pointCost(points[idx], a) || 1
                const costB = pointCost(points[idx], b) || 1
                return (rawB - costB) / costB - (rawA - costA) / costA
            }
            return rawB - rawA
        })
        tooltipTypes.forEach((type) => {
            const v = points[idx][type] ?? null
            if (v === null) return
            const color = M_TYPE_COLORS[type] || mPaletteForName(type)
            const lbl = M_TYPE_LABELS[type] || type
            let valStr
            if (isPct) {
                const cost = pointCost(points[idx], type)
                if (cost === 0) return
                const pctVal = ((v - cost) / cost) * 100
                const sign = pctVal >= 0 ? "+" : ""
                const clr = pctVal >= 0 ? "#2ecc71" : "#e74c3c"
                valStr = `<span style="color:${clr}">${sign}${pctVal.toFixed(2).replace(".", ",")}%</span>`
            } else {
                valStr = `<span style="color:#e8eeff">${formatEuro(v)}</span>`
            }
            html += `<div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
                <span style="width:10px;height:2px;background:${color};flex-shrink:0;display:inline-block;border-radius:1px"></span>
                <span style="color:#a0b0cc">${lbl}</span>
                <span style="margin-left:auto">${valStr}</span>
            </div>`
        })

        el.innerHTML = html

        const elW = 210
        const xPos = tooltip.caretX
        const left = xPos + elW + 10 > chart.chartArea.right ? xPos - elW - 12 : xPos + 12
        el.style.left = left + "px"
        el.style.top = chart.chartArea.top + 8 + "px"
        el.style.opacity = "1"
    }

    mCreateChart("mChartEvolucionTipos", {
        type: "line",
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: {
                    labels: {
                        color: "#ccd6f6",
                        font: { size: 12 },
                        padding: 14,
                        usePointStyle: true,
                        pointStyle: "line"
                    }
                },
                tooltip: { enabled: false, external: tiposTooltipHandler }
            },
            scales: {
                x: {
                    ticks: { color: "#8899bb", maxTicksLimit: 8, maxRotation: 0 },
                    grid: { color: "rgba(255,255,255,0.06)" }
                },
                y: {
                    ticks: {
                        color: "#ccd6f6",
                        callback: isPct
                            ? (v) => (v >= 0 ? "+" : "") + v.toFixed(1).replace(".", ",") + "%"
                            : (v) => formatEuro(v)
                    },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            }
        },
        plugins: [crosshairPlugin]
    })
}

function mInitEvolucionTipos() {
    const rangeBtns = document.querySelectorAll(".mEvolucionTiposRangeBtn")
    const modeBtns = document.querySelectorAll(".mEvolucionTiposModeBtn")

    rangeBtns.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.range === _evolucionTiposRange)
        btn.addEventListener("click", () => {
            rangeBtns.forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _evolucionTiposRange = btn.dataset.range
            setChartPref("evolucionTiposRange", _evolucionTiposRange)
            const oldTip = document.getElementById("mEvolucionTiposTooltip")
            if (oldTip) oldTip.remove()
            mRenderEvolucionTipos(_evolucionTiposRange, _evolucionTiposMode)
        })
    })

    modeBtns.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === _evolucionTiposMode)
        btn.addEventListener("click", () => {
            modeBtns.forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _evolucionTiposMode = btn.dataset.mode
            setChartPref("evolucionTiposMode", _evolucionTiposMode)
            const oldTip = document.getElementById("mEvolucionTiposTooltip")
            if (oldTip) oldTip.remove()
            mRenderEvolucionTipos(_evolucionTiposRange, _evolucionTiposMode)
        })
    })

    mRenderEvolucionTipos(_evolucionTiposRange, _evolucionTiposMode)
}
