// ── Sentimiento y pulso del mercado ─────────────────────────────────────────
//
// Página de solo lectura sobre el mercado en general, no sobre la cartera del
// usuario: índices principales, sectores del S&P 500, mayores subidas/bajadas
// del día y dos indicadores de sentimiento (Fear & Greed de cripto y amplitud
// de mercado en EE. UU.). Todo sale de `/api/market/pulse`, que ya reparte los
// fallos por sección: una sección sin datos se enseña como tal, nunca con un
// número inventado.

const _smCharts = {}

// Tooltip común a todos los gráficos de la página: mismo fondo, borde y
// tipografía que el resto de la app (valores literales, no `var()`: un
// <canvas> no resuelve custom properties de forma fiable, así que aquí se
// copian los mismos tonos que usan `--bg-header` y `--border-mid`).
const SM_TOOLTIP_BASE = {
    backgroundColor: "#0d1525",
    borderColor: "#273246",
    borderWidth: 1,
    padding: 10,
    cornerRadius: 8,
    titleFont: { size: 12, weight: "600" },
    bodyFont: { size: 12 },
    titleColor: "#e5edf9",
    bodyColor: "#ccd6f6",
    displayColors: false
}

const SM_CHART_DEFAULTS = {
    responsive: true,
    maintainAspectRatio: false,
    animation: { duration: 300 },
    plugins: {
        legend: { display: false },
        tooltip: { ...SM_TOOLTIP_BASE }
    }
}

// A qué bloque regional pertenece cada índice del catálogo que sirve el
// backend (`stores/market_pulse.MAJOR_INDICES`). Es solo una agrupación visual
// de la respuesta, no una lista aparte de tickers.
const SM_INDEX_GROUPS = [
    { label: "EE. UU.", keys: ["sp500", "nasdaq", "dowjones", "vix"] },
    { label: "Europa", keys: ["dax", "ibex", "cac40", "ftse100", "eurostoxx"] },
    { label: "Asia", keys: ["nikkei", "hangseng"] },
    { label: "Divisas", keys: ["dxy"] }
]

function smDestroyChart(id) {
    if (_smCharts[id]) {
        _smCharts[id].destroy()
        delete _smCharts[id]
    }
}

function smCreateChart(id, config) {
    const canvas = document.getElementById(id)
    if (!canvas) return
    smDestroyChart(id)
    _smCharts[id] = new Chart(canvas, config)
}

async function initSentimientoLogic() {
    const refreshBtn = document.getElementById("smRefreshBtn")
    const universeToggle = document.getElementById("smUniverseToggle")
    const indexGroups = document.getElementById("smIndexGroups")

    _smUniverse = "sp500"
    _smUniverseCache = {}
    _smLastSnapshot = null

    refreshBtn?.addEventListener("click", async () => {
        refreshBtn.disabled = true
        await smLoadAndRender()
        refreshBtn.disabled = false
    })

    universeToggle?.addEventListener("click", async (e) => {
        const btn = e.target.closest(".smUniverseBtn")
        if (!btn || btn.dataset.universe === _smUniverse) return
        universeToggle.querySelectorAll(".smUniverseBtn").forEach((b) => b.classList.toggle("active", b === btn))
        _smUniverse = btn.dataset.universe
        await smLoadUniverse(_smUniverse)
    })

    indexGroups?.addEventListener("click", (e) => {
        const card = e.target.closest(".smIndexCard")
        const symbol = card?.dataset.symbol
        if (!symbol || typeof openTVChartModal !== "function") return
        openTVChartModal(symbol, card.dataset.label || symbol)
    })

    await smLoadAndRender()
}

async function smLoadAndRender() {
    const loadingEl = document.getElementById("smLoading")
    const contentEl = document.getElementById("smContent")
    if (loadingEl) loadingEl.style.display = "flex"

    // Un refresco manual no debe servir el universo (S&P 500/Cripto/Nasdaq
    // 100) que quedó en la memoria de la sesión: se pide de nuevo, igual que
    // el resto de la página.
    _smUniverseCache = {}

    let data = null
    try {
        const res = await fetch("/api/market/pulse")
        data = await res.json()
    } catch (err) {
        console.error("Sentimiento: error cargando /api/market/pulse", err)
    }

    if (loadingEl) loadingEl.style.display = "none"
    contentEl?.classList.remove("hidden")

    if (!data || !data.ok) {
        smRenderFearGreed(null, "No se pudo contactar con el servidor")
        smRenderFearGreedHistory(null, "No se pudo contactar con el servidor")
        smRenderBreadth(null, "No se pudo contactar con el servidor")
        smRenderIndices(null)
        smRenderMovers(null)
        smRenderRsi(null)
        smRenderUnusualVolume(null)
        _smLastSnapshot = null
        await smLoadUniverse(_smUniverse)
        return
    }

    smRenderFearGreed(data.fearGreed, data.fearGreedError)
    smRenderFearGreedHistory(data.fearGreedHistory, data.fearGreedHistoryError)
    smRenderBreadth(data.breadth, data.breadthError)
    smRenderIndices(data.snapshot)
    smRenderMovers(data.movers)
    smRenderRsi(data.rsi)
    smRenderUnusualVolume(data.unusualVolume)

    _smLastSnapshot = data.snapshot
    await smLoadUniverse(_smUniverse)

    const updatedEl = document.getElementById("smUpdated")
    if (updatedEl) {
        updatedEl.textContent = `Actualizado ${new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
    }
}

// ── Fear & Greed (cripto) ───────────────────────────────────────────────────

function smRenderFearGreed(datos, error) {
    const wrap = document.getElementById("smFgWrap")
    const emptyEl = document.getElementById("smFgEmpty")
    const needle = document.getElementById("smFgNeedle")
    const valueEl = document.getElementById("smFgValue")
    const labelEl = document.getElementById("smFgLabel")

    if (!datos || error) {
        wrap?.classList.add("hidden")
        emptyEl?.classList.remove("hidden")
        return
    }

    wrap?.classList.remove("hidden")
    emptyEl?.classList.add("hidden")

    const valor = Math.max(0, Math.min(100, Number(datos.valor)))
    // La aguja recorre 180° (-90° a +90°) según el valor de 0 a 100. El giro
    // se hace por CSS (no por el atributo `transform` del SVG): mezclar un
    // `transform` de atributo con el `transform-origin` de CSS deja el pivote
    // de giro a merced de cada navegador, y la aguja giraba sobre un punto
    // que no era el centro del arco.
    const angulo = -90 + (valor / 100) * 180
    if (needle) needle.style.transform = `rotate(${angulo}deg)`

    if (valueEl) {
        valueEl.textContent = String(valor)
        const color = smFgZoneColor(valor)
        valueEl.style.color = color
        valueEl.style.textShadow = `0 0 22px ${color}77`
    }
    if (labelEl) labelEl.textContent = smFearGreedLabel(datos.clasificacion)
}

const SM_FEARGREED_LABELS = {
    "Extreme Fear": "Miedo extremo",
    Fear: "Miedo",
    Neutral: "Neutral",
    Greed: "Codicia",
    "Extreme Greed": "Codicia extrema"
}

function smFearGreedLabel(clasificacion) {
    return SM_FEARGREED_LABELS[clasificacion] || clasificacion || "—"
}

// Los mismos cinco tramos del arco del medidor, pero por clasificación (para
// las píldoras del histórico, que ya traen la clasificación de la fuente en
// vez de un valor suelto que haya que encasillar).
const SM_FEARGREED_TIER_COLORS = {
    "Extreme Fear": "#e74c3c",
    Fear: "#e8720e",
    Neutral: "#94a3b8",
    Greed: "#8bc98a",
    "Extreme Greed": "#2ecc71"
}

function smFgTierColor(clasificacion) {
    return SM_FEARGREED_TIER_COLORS[clasificacion] || "#94a3b8"
}

// Igual que arriba, pero por valor numérico: para colorear cada tramo de la
// línea del histórico según por dónde pasa, no solo el último punto.
function smFgZoneColor(valor) {
    if (valor <= 24) return "#e74c3c"
    if (valor <= 44) return "#e8720e"
    if (valor <= 55) return "#94a3b8"
    if (valor <= 75) return "#8bc98a"
    return "#2ecc71"
}

function smFgDateLabel(timestamp) {
    const fecha = new Date(Number(timestamp) * 1000)
    return fecha.toLocaleDateString("es-ES", { day: "2-digit", month: "short" })
}

// Pinta las cinco bandas de fondo (miedo extremo → codicia extrema) detrás de
// la línea, igual que las franjas del medidor: da contexto sin que haya que
// leer el eje para saber si un valor es alto o bajo.
const SM_FG_ZONES_PLUGIN = {
    id: "smFgZones",
    beforeDraw(chart) {
        const { ctx, chartArea, scales } = chart
        if (!chartArea || !scales.y) return
        const bandas = [
            [0, 25, "rgba(231, 76, 60, 0.08)"],
            [25, 45, "rgba(232, 114, 14, 0.07)"],
            [45, 55, "rgba(148, 163, 184, 0.06)"],
            [55, 75, "rgba(139, 201, 138, 0.07)"],
            [75, 100, "rgba(46, 204, 113, 0.09)"]
        ]
        ctx.save()
        bandas.forEach(([desde, hasta, color]) => {
            const yArriba = scales.y.getPixelForValue(hasta)
            const yAbajo = scales.y.getPixelForValue(desde)
            ctx.fillStyle = color
            ctx.fillRect(chartArea.left, yArriba, chartArea.right - chartArea.left, yAbajo - yArriba)
        })
        ctx.restore()
    }
}

function smFgAreaGradient(zoneColor) {
    return (context) => {
        const { chart } = context
        if (!chart.chartArea) return "transparent"
        const gradient = chart.ctx.createLinearGradient(0, chart.chartArea.top, 0, chart.chartArea.bottom)
        gradient.addColorStop(0, `${zoneColor}44`)
        gradient.addColorStop(1, `${zoneColor}00`)
        return gradient
    }
}

function smFgStatsStripHtml(historia) {
    // La fuente sirve el más reciente primero: índice 0 = hoy, 1 = ayer,
    // 7 = hace una semana, 29 = hace un mes.
    const items = [
        { label: "Hoy", punto: historia[0] },
        { label: "Ayer", punto: historia[1] },
        { label: "Hace 1 semana", punto: historia[7] },
        { label: "Hace 1 mes", punto: historia[29] },
        { label: "Máximo · 12 meses", punto: historia.reduce((max, p) => (p.valor > max.valor ? p : max), historia[0]) },
        { label: "Mínimo · 12 meses", punto: historia.reduce((min, p) => (p.valor < min.valor ? p : min), historia[0]) }
    ].filter((item) => item.punto)

    return items
        .map((item) => {
            const color = smFgTierColor(item.punto.clasificacion)
            return `
                <div class="smFgStatItem">
                    <span class="smFgStatLabel">${escapeHtml(item.label)}</span>
                    <span class="smFgStatPill" style="background:${color}22;color:${color}">${escapeHtml(smFearGreedLabel(item.punto.clasificacion))} · ${item.punto.valor}</span>
                </div>`
        })
        .join("")
}

function smRenderFearGreedHistory(historia, error) {
    const wrap = document.getElementById("smFgHistWrap")
    const emptyEl = document.getElementById("smFgHistEmpty")
    const stripEl = document.getElementById("smFgStatsStrip")

    if (!Array.isArray(historia) || !historia.length || error) {
        wrap?.classList.add("hidden")
        emptyEl?.classList.remove("hidden")
        smDestroyChart("smFgHistChart")
        return
    }

    wrap?.classList.remove("hidden")
    emptyEl?.classList.add("hidden")

    if (stripEl) stripEl.innerHTML = smFgStatsStripHtml(historia)

    // La fuente sirve el más reciente primero; el gráfico quiere orden
    // cronológico, de más antiguo a más reciente.
    const cronologica = [...historia].reverse()
    const valores = cronologica.map((p) => p.valor)
    const actual = valores[valores.length - 1]

    smCreateChart("smFgHistChart", {
        type: "line",
        data: {
            labels: cronologica.map((p) => smFgDateLabel(p.timestamp)),
            datasets: [
                {
                    data: valores,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBackgroundColor: "#162235",
                    tension: 0.25,
                    fill: true,
                    backgroundColor: smFgAreaGradient(smFgZoneColor(actual)),
                    segment: {
                        borderColor: (ctx) => smFgZoneColor((ctx.p0.parsed.y + ctx.p1.parsed.y) / 2)
                    }
                }
            ]
        },
        plugins: [SM_FG_ZONES_PLUGIN],
        options: {
            ...SM_CHART_DEFAULTS,
            interaction: { mode: "index", intersect: false },
            scales: {
                x: {
                    ticks: { color: "#8899bb", autoSkip: true, maxTicksLimit: 8 },
                    grid: { display: false }
                },
                y: {
                    min: 0,
                    max: 100,
                    ticks: { color: "#8899bb", stepSize: 25 },
                    grid: { color: "rgba(255,255,255,0.06)" }
                }
            },
            plugins: {
                ...SM_CHART_DEFAULTS.plugins,
                tooltip: {
                    ...SM_TOOLTIP_BASE,
                    callbacks: {
                        title: (items) => cronologica[items[0].dataIndex] && smFgDateLabel(cronologica[items[0].dataIndex].timestamp),
                        label: (ctx) => ` ${ctx.raw} · ${smFearGreedLabel(cronologica[ctx.dataIndex].clasificacion)}`
                    }
                }
            }
        }
    })
}

// ── Amplitud de mercado ─────────────────────────────────────────────────────

// Degradado radial por segmento (claro en el borde interior, saturado en el
// exterior): un relleno plano se veía como un adhesivo pegado encima de la
// tarjeta, sin ningún volumen.
const SM_DONUT_COLOR_PAIRS = [
    ["#1e9e56", "#4ade80"], // suben
    ["#c0392b", "#f87171"], // bajan
    ["#334155", "#94a3b8"] // planas
]

function smDonutSegmentGradient(context) {
    const { chart, dataIndex } = context
    if (!chart.chartArea) return SM_DONUT_COLOR_PAIRS[dataIndex]?.[0] || "#334155"

    const { left, right, top, bottom } = chart.chartArea
    const centerX = (left + right) / 2
    const centerY = (top + bottom) / 2
    const radius = Math.min(right - left, bottom - top) / 2
    const gradient = chart.ctx.createRadialGradient(centerX, centerY, radius * 0.45, centerX, centerY, radius)
    const [dark, light] = SM_DONUT_COLOR_PAIRS[dataIndex] || SM_DONUT_COLOR_PAIRS[2]
    gradient.addColorStop(0, light)
    gradient.addColorStop(1, dark)
    return gradient
}

function smRenderBreadth(datos, error) {
    const wrap = document.getElementById("smBrWrap")
    const emptyEl = document.getElementById("smBrEmpty")
    const labelEl = document.getElementById("smBrLabel")
    const legendEl = document.getElementById("smBreadthLegend")
    const centerValueEl = document.getElementById("smBrCenterValue")

    if (!datos || error || !datos.total) {
        wrap?.classList.add("hidden")
        emptyEl?.classList.remove("hidden")
        smDestroyChart("smBreadthChart")
        return
    }

    wrap?.classList.remove("hidden")
    emptyEl?.classList.add("hidden")

    const { subidas, bajadas, planas, total } = datos
    const pctSubidas = (subidas / total) * 100

    if (labelEl) labelEl.textContent = smBreadthLabel(subidas, bajadas, total)
    if (centerValueEl) {
        centerValueEl.textContent = `${Math.round(pctSubidas)}%`
        const color = pctSubidas >= 60 ? "#4ade80" : pctSubidas <= 40 ? "#f87171" : "#cbd5e1"
        centerValueEl.style.color = color
        centerValueEl.style.textShadow = `0 0 20px ${color}55`
    }

    if (legendEl) {
        legendEl.innerHTML = [
            { label: "Suben", value: subidas, cls: "smLegendPos" },
            { label: "Bajan", value: bajadas, cls: "smLegendNeg" },
            { label: "Planas", value: planas, cls: "smLegendNd" }
        ]
            .map(
                (item) =>
                    `<div class="smLegendRow"><span class="smLegendDot ${item.cls}"></span><span>${item.label}</span><span class="smLegendCount">${item.value}</span></div>`
            )
            .join("")
    }

    smCreateChart("smBreadthChart", {
        type: "doughnut",
        data: {
            labels: ["Suben", "Bajan", "Planas"],
            datasets: [
                {
                    data: [subidas, bajadas, planas],
                    backgroundColor: smDonutSegmentGradient,
                    borderColor: "#162235",
                    borderWidth: 2,
                    borderRadius: 6,
                    spacing: 3,
                    hoverOffset: 10,
                    hoverBorderColor: "#162235"
                }
            ]
        },
        options: {
            ...SM_CHART_DEFAULTS,
            cutout: "72%",
            plugins: {
                ...SM_CHART_DEFAULTS.plugins,
                tooltip: {
                    ...SM_TOOLTIP_BASE,
                    callbacks: {
                        label: (ctx) => ` ${ctx.label}: ${ctx.raw} (${((ctx.raw / total) * 100).toFixed(1)} %)`
                    }
                }
            }
        }
    })
}

// Lenguaje descriptivo de lo que dice la propia amplitud (cuántas suben contra
// cuántas bajan), no un índice recalculado: los umbrales son solo para poner
// esa proporción en palabras.
function smBreadthLabel(subidas, bajadas, total) {
    if (!total) return "Sin datos"
    const pct = (subidas / total) * 100
    if (pct >= 60) return "Predominan las subidas"
    if (pct <= 40) return "Predominan las bajadas"
    return "Mercado mixto"
}

// ── Índices principales ─────────────────────────────────────────────────────

function smRenderIndices(snapshot) {
    const container = document.getElementById("smIndexGroups")
    if (!container) return

    if (!snapshot || !Array.isArray(snapshot.indices)) {
        container.innerHTML = '<p class="overviewEmpty">Sin datos de índices ahora mismo.</p>'
        return
    }

    const porClave = new Map(snapshot.indices.map((item) => [item.key, item]))

    container.innerHTML = SM_INDEX_GROUPS.map((grupo) => {
        const cards = grupo.keys
            .map((key) => porClave.get(key))
            .filter(Boolean)
            .map((item) => smIndexCardHtml(item))
            .join("")
        if (!cards) return ""
        return `
            <div class="smIndexGroup">
                <span class="smIndexGroupLabel">${escapeHtml(grupo.label)}</span>
                <div class="smIndexCards">${cards}</div>
            </div>`
    }).join("")
}

function smIndexCardHtml(item) {
    const hasData = item.price !== null && item.price !== undefined
    const trend = !hasData ? "nd" : item.change > 0 ? "pos" : item.change < 0 ? "neg" : "flat"
    const changeCls = trend === "pos" ? "smPos" : trend === "neg" ? "smNeg" : ""
    const arrow = trend === "pos" ? "▲ " : trend === "neg" ? "▼ " : ""
    return `
        <div class="smIndexCard" data-trend="${trend}" data-symbol="${escapeHtml(item.ticker)}" data-label="${escapeHtml(item.label)}" title="Ver gráfico de ${escapeHtml(item.label)}">
            <div class="smIndexLabel">${escapeHtml(item.label)}</div>
            <div class="smIndexPrice">${hasData ? smIndexValue(item.price, item.currency) : "—"}</div>
            <div class="smIndexChange ${changeCls}">${hasData ? arrow + smPercentSigned(item.change) : "Sin cotización"}</div>
        </div>`
}

function smIndexValue(value, currency) {
    const decimals = Math.abs(value) >= 1000 ? 0 : 2
    const formatted = value.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    if (!currency) return formatted
    return `${formatted}<span class="smIndexCurrency">${escapeHtml(currencySuffix(currency))}</span>`
}

function smPercentSigned(value, decimals = 2) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    const sign = num > 0 ? "+" : ""
    return sign + num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + " %"
}

// ── Distribución del mercado (treemap: S&P 500 / Cripto / Nasdaq 100) ──────
//
// Mismo mosaico que el mapa de calor de Activos, con tres universos que se
// cambian sin recargar la página. El "S&P 500" reutiliza el snapshot que ya
// trajo la sección de índices (mismo AUM por sector, nada de una tabla de
// "peso en el S&P 500" fijada a mano); "Cripto" y "Nasdaq 100" se piden a
// `/api/market/pulse/universe` la primera vez que se eligen y se quedan en
// memoria mientras dure la visita a la página.

const SM_TREEMAP_GAP = 3

// Dónde satura el color, en % de variación: una acción de gran capitalización
// no se mueve como una cripto, así que con la misma escala el mosaico de
// cripto saldría todo en el verde/rojo más oscuro.
const SM_UNIVERSE_SCALE = { sp500: 3, nasdaq100: 4, cripto: 8 }

const SM_UNIVERSE_NOTES = {
    sp500: "El tamaño es el patrimonio del ETF que sigue ese sector (AUM); el color, la variación de hoy.",
    cripto: "El tamaño es la capitalización de mercado; el color, la variación de hoy. Una fila por moneda, aunque cotice en varios exchanges.",
    nasdaq100: "El tamaño es la capitalización de mercado; el color, la variación de hoy. Pertenencia al Nasdaq 100 según TradingView."
}

let _smUniverse = "sp500"
let _smUniverseCache = {}
let _smLastSnapshot = null
let _smSectorRows = []
let _smSectorResizeObserver = null

function smSectoresToUniverseRows(sectores) {
    return (sectores || [])
        .filter((s) => s.change !== null && s.change !== undefined && s.aum)
        .map((s) => ({
            symbol: s.ticker,
            primary: s.label,
            secondary: "",
            change: s.change,
            size: s.aum,
            sizeLabel: "Patrimonio del ETF (AUM)",
            price: s.price,
            currency: s.currency
        }))
}

async function smLoadUniverse(clave) {
    const notaEl = document.getElementById("smSectorNota")
    if (notaEl) notaEl.textContent = SM_UNIVERSE_NOTES[clave] || ""

    if (_smUniverseCache[clave]) {
        smSetSectorRows(_smUniverseCache[clave])
        return
    }

    if (clave === "sp500") {
        const filas = smSectoresToUniverseRows(_smLastSnapshot?.sectores)
        _smUniverseCache.sp500 = filas
        smSetSectorRows(filas)
        return
    }

    // Cripto y Nasdaq 100 piden un screener de cientos de filas (para
    // deduplicar cripto por moneda o filtrar el Nasdaq 100 real): tarda algo
    // más que el snapshot de índices, así que hay que enseñar que se está
    // cargando en vez de dejar el mosaico vacío sin explicación mientras llega.
    smSetSectorRows(null, "Cargando…")

    try {
        const res = await fetch(`/api/market/pulse/universe?type=${encodeURIComponent(clave)}`)
        const data = await res.json()
        if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
        _smUniverseCache[clave] = data.items
        smSetSectorRows(data.items)
    } catch (err) {
        console.error("Sentimiento: error cargando universo", clave, err)
        smSetSectorRows(null, `No se pudo cargar: ${err.message}`)
    }
}

function smSetSectorRows(filas, mensajeVacio = "Sin datos ahora mismo.") {
    const container = document.getElementById("smSectorTreemap")
    const chartWrap = document.getElementById("smSectorChartWrap")
    const emptyEl = document.getElementById("smSectorEmpty")
    if (!container) return

    if (!filas || !filas.length) {
        if (emptyEl) emptyEl.textContent = mensajeVacio
        chartWrap?.classList.add("hidden")
        emptyEl?.classList.remove("hidden")
        container.innerHTML = ""
        _smSectorRows = []
        return
    }

    chartWrap?.classList.remove("hidden")
    emptyEl?.classList.add("hidden")

    _smSectorRows = filas
    smDrawSectorTreemap()

    if (!_smSectorResizeObserver) {
        _smSectorResizeObserver = new ResizeObserver(() => smDrawSectorTreemap())
        _smSectorResizeObserver.observe(container)

        // Igual que el mapa de calor de Activos: `app-core.js` llama a esto
        // antes de cargar otra página, para no dejar el observer ni el
        // tooltip flotante colgando de un contenedor que ya no existe.
        window._smResizeCleanup = () => {
            _smSectorResizeObserver?.disconnect()
            _smSectorResizeObserver = null
            document.getElementById("smSectorTooltip")?.remove()
        }
    }
}

function smDrawSectorTreemap() {
    const container = document.getElementById("smSectorTreemap")
    if (!container || !_smSectorRows.length) return

    const W = Math.floor(container.clientWidth || 800)
    const H = Math.floor(container.clientHeight || 320)
    if (W <= 0 || H <= 0) return

    const conArea = _smSectorRows.map((s) => ({ ...s, area: Math.max(s.size || 0, 1) }))
    const total = conArea.reduce((sum, s) => sum + s.area, 0)
    // El peso es sobre el área real (antes de inflar las diminutas para que se
    // lean): si no, una baldoseta subida al mínimo diría pesar más de lo que
    // pesa de verdad.
    const conPeso = conArea.map((s) => ({ ...s, weight: s.area / total }))
    const escalados = smMinimoVisible(
        conPeso.map((s) => ({ ...s, area: s.weight * W * H })),
        W,
        H
    )

    container.innerHTML = ""
    smSquarify(escalados, 0, 0, W, H).forEach((rect) => container.appendChild(smBuildSectorCell(rect)))
    smBindSectorTreemap(container)
}

// Con muchas filas (Cripto/Nasdaq 100 llegan a 24) la que menos pesa puede
// salir con un área de un par de píxeles: sube al mínimo las baldosas
// diminutas y descuenta lo prestado de las grandes a prorrata, igual que en
// el mapa de calor de Activos, para que ninguna quede ilegible.
const SM_TREEMAP_AREA_MINIMA = 28 * 28

function smMinimoVisible(items, w, h) {
    const lienzo = w * h
    if (!items.length || lienzo <= 0) return items

    const minima = Math.min(SM_TREEMAP_AREA_MINIMA, lienzo / (items.length * 3))
    const pequenas = items.filter((d) => d.area < minima)
    if (!pequenas.length) return items

    const prestado = pequenas.reduce((s, d) => s + (minima - d.area), 0)
    const areaGrandes = items.reduce((s, d) => s + (d.area >= minima ? d.area : 0), 0)
    if (areaGrandes <= prestado) return items

    const factor = (areaGrandes - prestado) / areaGrandes
    return items.map((d) => (d.area < minima ? { ...d, area: minima } : { ...d, area: d.area * factor }))
}

function smBuildSectorCell(rect) {
    const { x, y, w, h, primary, secondary, change } = rect
    const cw = Math.max(Math.round(w) - SM_TREEMAP_GAP, 2)
    const ch = Math.max(Math.round(h) - SM_TREEMAP_GAP, 2)
    const escala = SM_UNIVERSE_SCALE[_smUniverse] || 3

    const el = document.createElement("div")
    el.className = "smSectorCell"
    el.style.cssText = `left:${Math.round(x) + SM_TREEMAP_GAP / 2}px;top:${Math.round(y) + SM_TREEMAP_GAP / 2}px;width:${cw}px;height:${ch}px;background:${smSectorColor(change, escala)};`
    // Los datos del tooltip van en el propio nodo (como el mapa de calor de
    // Activos): un único mousemove delegado en el contenedor los lee de aquí
    // en vez de escuchar en cada una de las hasta 24 baldosas.
    el._smData = rect

    // Por debajo de esto ni el ticker cabe: mejor una baldosa de color suelta
    // que un texto reventando el recuadro.
    let inner = ""
    if (cw >= 24 && ch >= 18) {
        const fontSize = smSectorCellFontSize(cw, ch, primary)
        inner += `<span class="smSectorCellLabel" style="font-size:${fontSize}px">${escapeHtml(primary)}</span>`
        if (ch >= 58 && cw >= 74 && secondary) inner += `<span class="smSectorCellName">${escapeHtml(secondary)}</span>`
        if (ch >= 40 && cw >= 54) inner += `<span class="smSectorCellChange">${smPercentSigned(change)}</span>`
    }
    el.innerHTML = inner

    return el
}

// Enganchado una sola vez por contenedor (igual que el mapa de calor de
// Activos): `smDrawSectorTreemap` vacía y rellena el contenedor en cada
// redibujado, pero el contenedor en sí no cambia de nodo.
function smBindSectorTreemap(container) {
    if (container.dataset.smBound === "true") return
    container.dataset.smBound = "true"

    container.addEventListener("mousemove", (e) => {
        const tip = smGetSectorTooltip()
        const cell = e.target.closest(".smSectorCell")
        if (!cell || !cell._smData) {
            tip.classList.remove("hmTooltipVisible")
            return
        }

        tip.innerHTML = smSectorTooltipHtml(cell._smData)
        tip.classList.add("hmTooltipVisible")

        const margin = 12
        const rect = tip.getBoundingClientRect()
        let lx = e.clientX + margin
        let ly = e.clientY + margin
        if (lx + rect.width > window.innerWidth - 4) lx = e.clientX - rect.width - margin
        if (ly + rect.height > window.innerHeight - 4) ly = e.clientY - rect.height - margin
        tip.style.left = Math.max(4, lx) + "px"
        tip.style.top = Math.max(4, ly) + "px"
    })

    container.addEventListener("mouseleave", () => smGetSectorTooltip().classList.remove("hmTooltipVisible"))

    container.addEventListener("click", (e) => {
        const cell = e.target.closest(".smSectorCell")
        const d = cell?._smData
        if (!d) return
        smGetSectorTooltip().classList.remove("hmTooltipVisible")
        if (typeof openTVChartModal === "function") openTVChartModal(d.symbol, d.primary)
    })
}

// El tooltip reutiliza las clases `.hmTip*` del mapa de calor de Activos (ya
// cargadas de forma global): mismo aspecto en las dos pantallas sin duplicar
// una hoja de estilos entera por una tarjeta flotante.
function smGetSectorTooltip() {
    let tip = document.getElementById("smSectorTooltip")
    if (!tip) {
        tip = document.createElement("div")
        tip.id = "smSectorTooltip"
        tip.className = "hmTooltip"
        document.body.appendChild(tip)
    }
    return tip
}

function smSectorTooltipHtml(d) {
    const pctClass = d.change > 0 ? "hmTipPos" : d.change < 0 ? "hmTipNeg" : ""
    const fila = (label, valor, cls = "") => `<span class="hmTipLabel">${label}</span><span class="hmTipVal ${cls}">${valor}</span>`

    const priceRow = d.price !== null && d.price !== undefined ? fila("Precio", smIndexValue(d.price, d.currency)) : ""
    const changeRow = fila("Variación hoy", smPercentSigned(d.change), pctClass)
    const sizeRow = d.size ? fila(d.sizeLabel || "Tamaño", smMoneyMillones(d.size, d.currency)) : ""
    const weightRow = d.weight > 0 ? fila("Peso en el mosaico", `${(d.weight * 100).toFixed(1)} %`) : ""

    const titulo = d.secondary && d.secondary !== d.primary ? `${d.primary} — ${d.secondary}` : d.primary

    return `
        <div class="hmTipName">${escapeHtml(titulo)}</div>
        <div class="hmTipDivider"></div>
        <div class="hmTipGrid">${priceRow}${changeRow}${sizeRow}${weightRow}</div>`
}

function smMoneyMillones(value, currency) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    return (num / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 0 }) + " M " + currencySuffix(currency || "USD")
}

// El cuerpo del ticker se calcula por lo que ocupa de verdad medido con la
// tipografía de la página, no por una cantidad fija por letra: "MU" y
// "GOOGL" tienen anchuras muy distintas con el mismo número de huecos libres.
const _smAnchosTexto = new Map()
let _smMedirCtx = null
let _smMedicionIntentada = false

function smMedirTexto(texto) {
    const clave = String(texto || "")
    if (_smAnchosTexto.has(clave)) return _smAnchosTexto.get(clave)

    if (!_smMedirCtx && !_smMedicionIntentada) {
        _smMedicionIntentada = true
        try {
            _smMedirCtx = document.createElement("canvas").getContext("2d")
            const familia = getComputedStyle(document.body).fontFamily || "sans-serif"
            _smMedirCtx.font = `700 100px ${familia}`
        } catch {
            _smMedirCtx = null
        }
    }

    const ancho = _smMedirCtx ? _smMedirCtx.measureText(clave).width : clave.length * 70
    _smAnchosTexto.set(clave, ancho)
    return ancho
}

function smSectorCellFontSize(w, h, texto) {
    const anchoA100 = smMedirTexto(texto)
    const porAncho = anchoA100 > 0 ? ((w - 10) / anchoA100) * 100 : w
    const porAlto = h * 0.4
    return Math.max(9, Math.min(porAncho, porAlto, 24))
}

function smSectorColor(pct, escala) {
    if (pct === null || pct === undefined || Math.abs(pct) < escala / 250) return "#334155"
    const t = Math.min(Math.abs(pct) / escala, 1)
    return pct > 0 ? smBlend("#a5d6a7", "#43a047", "#1b5e20", t) : smBlend("#ef9a9a", "#e53935", "#b71c1c", t)
}

function smBlend(low, mid, high, t) {
    const a = smHexToRgb(t < 0.4 ? low : mid)
    const b = smHexToRgb(t < 0.4 ? mid : high)
    const tt = t < 0.4 ? t / 0.4 : (t - 0.4) / 0.6
    return `rgb(${Math.round(a.r + (b.r - a.r) * tt)}, ${Math.round(a.g + (b.g - a.g) * tt)}, ${Math.round(a.b + (b.b - a.b) * tt)})`
}

function smHexToRgb(hex) {
    return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }
}

// Treemap «squarified» (Bruls, Huizing y Van Wijk): igual algoritmo que el
// mapa de calor de Activos (`hmSquarify`), copiado en vez de compartido para
// no tocar ese módulo ya probado por una pantalla nueva.
function smSquarify(items, x, y, w, h) {
    const out = []
    let pendientes = items.filter((d) => d.area > 0)
    let rx = x
    let ry = y
    let rw = w
    let rh = h

    while (pendientes.length && rw > 0.5 && rh > 0.5) {
        const lado = Math.min(rw, rh)
        const fila = []
        let areaFila = 0
        let i = 0

        while (i < pendientes.length) {
            const siguiente = areaFila + pendientes[i].area
            if (fila.length && smWorstRatio(fila, areaFila, lado) <= smWorstRatio([...fila, pendientes[i]], siguiente, lado)) {
                break
            }
            fila.push(pendientes[i])
            areaFila = siguiente
            i++
        }

        const horizontal = lado === rw
        const grosor = Math.min(areaFila / lado, horizontal ? rh : rw)
        let pos = 0

        fila.forEach((item, idx) => {
            const largo = idx === fila.length - 1 ? lado - pos : (item.area / areaFila) * lado
            if (horizontal) {
                out.push({ ...item, x: rx + pos, y: ry, w: Math.max(largo, 1), h: Math.max(grosor, 1) })
            } else {
                out.push({ ...item, x: rx, y: ry + pos, w: Math.max(grosor, 1), h: Math.max(largo, 1) })
            }
            pos += largo
        })

        if (horizontal) {
            ry += grosor
            rh -= grosor
        } else {
            rx += grosor
            rw -= grosor
        }

        pendientes = pendientes.slice(i)
    }

    return out
}

function smWorstRatio(fila, areaFila, lado) {
    if (!fila.length || areaFila <= 0 || lado <= 0) return Infinity
    let max = -Infinity
    let min = Infinity
    for (const item of fila) {
        if (item.area > max) max = item.area
        if (item.area < min) min = item.area
    }
    if (min <= 0) return Infinity
    const s2 = areaFila * areaFila
    const l2 = lado * lado
    return Math.max((l2 * max) / s2, s2 / (l2 * min))
}

// ── Mayores subidas / bajadas ───────────────────────────────────────────────

function smRenderMovers(movers) {
    const gainersEl = document.getElementById("smGainersList")
    const losersEl = document.getElementById("smLosersList")
    if (!gainersEl || !losersEl) return

    if (!movers) {
        gainersEl.innerHTML = '<p class="overviewEmpty">Sin datos ahora mismo.</p>'
        losersEl.innerHTML = '<p class="overviewEmpty">Sin datos ahora mismo.</p>'
        return
    }

    gainersEl.innerHTML = (movers.subidas || []).map((row, idx) => smMoverRowHtml(row, idx)).join("") || '<p class="overviewEmpty">Sin datos.</p>'
    losersEl.innerHTML = (movers.bajadas || []).map((row, idx) => smMoverRowHtml(row, idx)).join("") || '<p class="overviewEmpty">Sin datos.</p>'
}

function smMoverRowHtml(row, idx) {
    const changeCls = row.change > 0 ? "smPos" : row.change < 0 ? "smNeg" : ""
    return `
        <div class="smMoverRow">
            <span class="smMoverRank">${idx + 1}</span>
            <div class="smMoverInfo">
                <span class="smMoverName">${escapeHtml(row.name || row.ticker)}</span>
                <span class="smMoverSector">${escapeHtml(row.ticker)}${row.sector ? " · " + escapeHtml(row.sector) : ""}</span>
            </div>
            <span class="smMoverPrice">${smIndexValue(Number(row.price) || 0, "USD")}</span>
            <span class="smMoverChange ${changeCls}">${smPercentSigned(row.change)}</span>
        </div>`
}

// ── RSI extremos ─────────────────────────────────────────────────────────

function smRenderRsi(rsi) {
    const overEl = document.getElementById("smRsiOverboughtList")
    const underEl = document.getElementById("smRsiOversoldList")
    if (!overEl || !underEl) return

    if (!rsi) {
        overEl.innerHTML = '<p class="overviewEmpty">Sin datos ahora mismo.</p>'
        underEl.innerHTML = '<p class="overviewEmpty">Sin datos ahora mismo.</p>'
        return
    }

    overEl.innerHTML = (rsi.sobrecompra || []).map((row, idx) => smRsiRowHtml(row, idx)).join("") || '<p class="overviewEmpty">Sin datos.</p>'
    underEl.innerHTML = (rsi.sobreventa || []).map((row, idx) => smRsiRowHtml(row, idx)).join("") || '<p class="overviewEmpty">Sin datos.</p>'
}

function smRsiRowHtml(row, idx) {
    const rsi = typeof row.rsi === "number" ? row.rsi : parseFloat(row.rsi)
    // >=70/<=30 es el umbral de sobrecompra/sobreventa que ya publica
    // TradingView para este mismo indicador, no un corte inventado aquí.
    const cls = rsi >= 70 ? "smRsiHot" : rsi <= 30 ? "smRsiCold" : ""
    return `
        <div class="smMoverRow">
            <span class="smMoverRank">${idx + 1}</span>
            <div class="smMoverInfo">
                <span class="smMoverName">${escapeHtml(row.name || row.ticker)}</span>
                <span class="smMoverSector">${escapeHtml(row.ticker)}${row.sector ? " · " + escapeHtml(row.sector) : ""}</span>
            </div>
            <span class="smMoverPrice">${smIndexValue(Number(row.price) || 0, "USD")}</span>
            <span class="smRsiBadge ${cls}">${smRatioText(rsi)}</span>
        </div>`
}

// ── Volumen inusual ──────────────────────────────────────────────────────

function smRenderUnusualVolume(rows) {
    const el = document.getElementById("smVolumeList")
    if (!el) return

    if (!rows) {
        el.innerHTML = '<p class="overviewEmpty">Sin datos ahora mismo.</p>'
        return
    }

    el.innerHTML = rows.map((row, idx) => smVolumeRowHtml(row, idx)).join("") || '<p class="overviewEmpty">Sin datos.</p>'
}

function smVolumeRowHtml(row, idx) {
    const changeCls = row.change > 0 ? "smPos" : row.change < 0 ? "smNeg" : ""
    return `
        <div class="smMoverRow">
            <span class="smMoverRank">${idx + 1}</span>
            <div class="smMoverInfo">
                <span class="smMoverName">${escapeHtml(row.name || row.ticker)}</span>
                <span class="smMoverSector">${escapeHtml(row.ticker)}${row.sector ? " · " + escapeHtml(row.sector) : ""}</span>
            </div>
            <span class="smMoverPrice">${smIndexValue(Number(row.price) || 0, "USD")}</span>
            <span class="smMoverChange ${changeCls}">${smPercentSigned(row.change)}</span>
            <span class="smVolumeBadge">${smRatioText(row.relativeVolume)}×</span>
        </div>`
}

function smRatioText(value, decimals = 1) {
    const num = typeof value === "number" ? value : parseFloat(value)
    if (value === null || value === undefined || isNaN(num)) return "—"
    return num.toLocaleString("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
