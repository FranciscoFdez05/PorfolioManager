let _hmPeriod = "dia"
let _hmMetric = "cuenta"
let _hmActiveTypes = new Set(["all"])
let _hmData = null
const _hmHistCache = {} // { period: { data: {id: pct}, ts: ms } }
const _HM_HIST_TTL = 4 * 3600 * 1000

// Separación entre baldosas, en píxeles. Antes el hueco lo hacía un PAD que
// solo se restaba a uno de los lados del corte, así que el mapa tenía rayas en
// unos sitios y en otros no.
const HM_GAP = 3

// Etiqueta del periodo para la barra de resumen.
const HM_PERIOD_LABELS = { dia: "Hoy", semana: "Semana", mes: "Mes", anyo: "Año", ytd: "YTD", todo: "Total" }

// Dónde satura el color en cada periodo, en porcentaje. Un día bueno son unas
// décimas y un año bueno un 25 %: con una escala fija el mapa del día salía
// entero en pastel, con el que más sube y el que más baja del mismo color.
// «Todo» es desde la compra, así que va más holgado que el año.
const HM_PERIOD_SCALE = { dia: 3, semana: 6, mes: 10, anyo: 25, ytd: 25, todo: 50 }

function hmEscala() {
    return HM_PERIOD_SCALE[_hmPeriod] || 10
}

async function initHeatmapLogic() {
    _hmPeriod = "dia"
    _hmMetric = "cuenta"
    _hmActiveTypes = new Set(["all"])
    _hmData = null

    const periodsEl = document.getElementById("heatmapPeriods")
    const metricEl = document.getElementById("heatmapMetric")
    const typesEl = document.getElementById("heatmapTypes")

    if (periodsEl) {
        periodsEl.addEventListener("click", async (e) => {
            const btn = e.target.closest(".hmGroupBtn")
            if (!btn || !btn.dataset.period) return
            periodsEl.querySelectorAll(".hmGroupBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _hmPeriod = btn.dataset.period
            if (_hmPeriod !== "dia" && _hmPeriod !== "todo") {
                await hmLoadHistorical(_hmPeriod)
            }
            hmRender()
        })
    }

    if (metricEl) {
        metricEl.addEventListener("click", (e) => {
            const btn = e.target.closest(".hmGroupBtn")
            if (!btn || !btn.dataset.metric) return
            metricEl.querySelectorAll(".hmGroupBtn").forEach((b) => b.classList.remove("active"))
            btn.classList.add("active")
            _hmMetric = btn.dataset.metric
            hmSyncPeriodoTodo()
            hmRender()
        })
    }
    hmSyncPeriodoTodo()

    if (typesEl) {
        typesEl.addEventListener("click", (e) => {
            const btn = e.target.closest(".hmGroupBtn")
            if (!btn || !btn.dataset.type) return
            const type = btn.dataset.type

            if (type === "all") {
                _hmActiveTypes = new Set(["all"])
                typesEl.querySelectorAll(".hmGroupBtn").forEach((b) => b.classList.remove("active"))
                btn.classList.add("active")
            } else {
                // Toggle this type
                _hmActiveTypes.delete("all")
                if (_hmActiveTypes.has(type)) {
                    _hmActiveTypes.delete(type)
                } else {
                    _hmActiveTypes.add(type)
                }
                // If nothing selected, go back to all
                if (_hmActiveTypes.size === 0) {
                    _hmActiveTypes.add("all")
                }
                // Sync button states
                typesEl.querySelectorAll(".hmGroupBtn").forEach((b) => {
                    b.classList.toggle(
                        "active",
                        _hmActiveTypes.has("all") ? b.dataset.type === "all" : _hmActiveTypes.has(b.dataset.type)
                    )
                })
            }
            hmRender()
        })
    }

    await hmLoadData()

    requestAnimationFrame(() =>
        requestAnimationFrame(() => {
            hmRender()

            let _hmRenderTimer = null
            const _hmObserver = new ResizeObserver(() => {
                clearTimeout(_hmRenderTimer)
                _hmRenderTimer = setTimeout(hmRender, 40)
            })
            const container = document.getElementById("heatmapContainer")
            if (container) _hmObserver.observe(container)

            // El gris de las baldosas planas depende del tema, y el tema se
            // cambia desde un panel que se abre encima del mapa sin recargar la
            // página: sin esto se quedarían con el color del tema anterior.
            const _hmThemeObserver = new MutationObserver(hmRender)
            _hmThemeObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] })

            window._hmResizeCleanup = () => {
                _hmObserver.disconnect()
                _hmThemeObserver.disconnect()
                clearTimeout(_hmRenderTimer)
                document.getElementById("hmTooltip")?.remove()
            }
        })
    )
}

/**
 * «Todo» solo existe en el mapa de la cuenta: es lo que ha hecho cada posición
 * desde que se compró, y en el de los activos no hay una fecha de inicio común.
 * Si estaba elegido al pasar a «Activos», se vuelve a «Día».
 */
function hmSyncPeriodoTodo() {
    const periodsEl = document.getElementById("heatmapPeriods")
    const btnTodo = periodsEl?.querySelector('[data-period="todo"]')
    if (!btnTodo) return

    const disponible = _hmMetric === "cuenta"
    btnTodo.classList.toggle("hidden", !disponible)
    if (!disponible && _hmPeriod === "todo") {
        _hmPeriod = "dia"
        periodsEl
            .querySelectorAll(".hmGroupBtn")
            .forEach((b) => b.classList.toggle("active", b.dataset.period === "dia"))
    }
}

/**
 * El porcentaje que pinta una baldosa en el periodo elegido: el cambio de
 * mercado del día, el histórico que sirve el API o, en «Todo», el rendimiento
 * de la posición desde la compra (valor actual contra invertido bruto).
 */
function hmValorPeriodo(d, periodo, histData = {}) {
    if (periodo === "dia") return d.dia
    if (periodo === "todo") return d.hasCuenta ? d.cuentaPct : null
    return histData[d.id] ?? null
}

async function hmLoadData() {
    const loading = document.getElementById("heatmapLoading")
    if (loading) loading.style.display = "flex"

    try {
        const res = await fetch("/api/activos")
        const data = await res.json()
        const assets = (Array.isArray(data.assets) ? data.assets : []).filter(Boolean)

        // Load full asset data in parallel to get correct per-row metrics
        // (same approach as the Activos page, avoids currency-mismatch in server aggregates)
        await Promise.all(
            assets.map(async (asset) => {
                try {
                    const fullRes = await fetch(`/api/activos/${asset.id}`)
                    const fullAsset = await fullRes.json()
                    const row = await buildOverviewRow(fullAsset)
                    const euros = await buildSummaryMetricsInEuros(row)
                    asset._hmMetrics = {
                        netoEur: euros.netoActualEur,
                        invertidoEur: euros.invertidoBrutoEur,
                        cuentaPct:
                            euros.invertidoBrutoEur > 0 ? (euros.rendimientoEur / euros.invertidoBrutoEur) * 100 : 0,
                        hasCuenta: euros.invertidoBrutoEur > 0
                    }
                } catch {
                    asset._hmMetrics = null
                }
            })
        )

        _hmData = window._hmData = assets
            .map((asset) => {
                const cur = hmNormCur(asset.currency)
                const m = asset._hmMetrics

                const netoEur = m ? m.netoEur : 0
                const invertidoEur = m ? m.invertidoEur : 0
                const cuentaPct = m ? m.cuentaPct : 0
                const hasCuenta = m ? m.hasCuenta : false

                const rawChange = String(asset.change || "")
                    .replace(/%/g, "")
                    .replace(",", ".")
                    .trim()
                const d1 = rawChange !== "" ? parseFloat(rawChange) : null
                const hasMarket = d1 !== null && !isNaN(d1)

                return {
                    id: asset.id,
                    name: asset.name || asset.symbol || asset.id,
                    symbol: hmExtractSymbol(asset),
                    type: (asset.type || "acciones").toLowerCase(),
                    price: asset.price || "---",
                    currency: cur,
                    netoEur,
                    invertidoEur,
                    cuentaPct,
                    hasCuenta,
                    dia: hasMarket ? d1 : null
                }
            })
            .filter((d) => d.netoEur > 0.01 || d.invertidoEur > 0.01)
    } catch (err) {
        console.error("Heatmap error:", err)
        _hmData = []
    }

    if (loading) loading.style.display = "none"
}

async function hmLoadHistorical(period) {
    const cached = _hmHistCache[period]
    if (cached && Date.now() - cached.ts < _HM_HIST_TTL) return

    const loading = document.getElementById("heatmapLoading")
    if (loading) {
        loading.textContent = "Cargando datos históricos…"
        loading.style.display = "flex"
    }

    try {
        const res = await fetch(`/api/historical-changes?period=${period}`)
        const json = await res.json()
        if (json.ok) {
            _hmHistCache[period] = { data: json.data, ts: Date.now() }
        }
    } catch (err) {
        console.error("Error cargando histórico:", err)
    }

    if (loading) loading.style.display = "none"
}

function hmNormCur(raw) {
    return (
        String(raw || "EUR")
            .toUpperCase()
            .trim() || "EUR"
    )
}

function hmExtractSymbol(asset) {
    const ms = String(asset.marketSymbol || asset.finnhubSymbol || "")
        .trim()
        .toUpperCase()
    if (ms.includes(":"))
        return (
            ms
                .split(":")
                .pop()
                .replace(/USDT$|USD$|USDC$|BUSD$/, "") || asset.name
        )
    if (ms.includes(".")) return ms.split(".")[0]
    return ms || asset.name || asset.id
}

function hmRender() {
    const container = document.getElementById("heatmapContainer")
    if (!container || !_hmData) return

    // Filter by selected types (multi-select)
    const items = _hmData.filter((d) => _hmActiveTypes.has("all") || _hmActiveTypes.has(d.type))

    if (!items.length) {
        container.innerHTML = '<div class="heatmapEmpty">No hay activos para mostrar</div>'
        hmUpdateSummary([])
        return
    }

    const enriched = items
        .map((d) => {
            // El periodo manda en los dos mapas: hoy con el dato de mercado del
            // día y el resto con el histórico que sirve el API. Lo que cambia
            // entre «Activos» y «Cuenta» no es el plazo, es la pregunta: cómo
            // va el activo o cómo va mi dinero metido en él.
            // En «Todo» el movimiento sale igual a valor − invertido, porque
            // el porcentaje ya es sobre lo invertido.
            const periodo = _hmPeriod
            const value = hmValorPeriodo(d, periodo, _hmHistCache[periodo]?.data)

            const hasValue = value !== null && value !== undefined && !isNaN(value)
            const valueLabel = hasValue ? hmFormatPct(value) : "N/D"
            const size = Math.max(d.netoEur, 0.01)

            return {
                ...d,
                size,
                value,
                valueLabel,
                hasValue,
                moneyChange: hmMovimiento(d.netoEur, hasValue ? value : null)
            }
        })
        .sort((a, b) => b.size - a.size)

    const totalSize = enriched.reduce((s, d) => s + d.size, 0)
    if (totalSize === 0) {
        container.innerHTML = '<div class="heatmapEmpty">Sin datos</div>'
        hmUpdateSummary([])
        return
    }

    enriched.forEach((d) => {
        d.weight = d.size / totalSize
    })

    hmUpdateSummary(enriched)

    const W = container.clientWidth || container.offsetWidth || 800
    const H = container.clientHeight || container.offsetHeight || 500

    const rects = hmSquarify(
        enriched.map((d) => ({ ...d, area: d.weight * W * H })),
        0,
        0,
        W,
        H
    )

    container.innerHTML = ""
    hmBindContainer(container)
    rects.forEach((rect) => container.appendChild(hmBuildCell(rect)))
}

/**
 * Cuánto dinero ha movido la posición en el periodo.
 *
 * No es `valor × porcentaje`: ese porcentaje se calculó sobre el precio de
 * *antes*, así que multiplicarlo por el valor de ahora se pasa. Lo que se
 * mueve es la diferencia con lo que valía al empezar el periodo, o sea
 * `valor − valor / (1 + pct/100)`. Con un +2 % la diferencia entre las dos
 * cuentas es calderilla, pero con los porcentajes de tres cifras que salen en
 * cripto son decenas de euros inventados.
 */
function hmMovimiento(valorEur, pct) {
    if (pct === null || pct === undefined || !valorEur) return null
    const factor = 1 + pct / 100
    if (factor <= 0) return null
    return valorEur - valorEur / factor
}

/**
 * La barra de resumen de la derecha: cuántos activos se están viendo, cuánto
 * valen y cuánto se han movido en el periodo elegido.
 *
 * El mapa contesta «qué sube y qué baja», pero no «cuánto es eso»: el color de
 * una baldosa pequeña con un +30 % pesa lo mismo a la vista que el de una
 * grande con un +2 %, y en euros no se parecen en nada. El total va aquí para
 * que el mapa se lea junto a su magnitud, y respeta los filtros: si solo está
 * marcado «Cripto», el resumen es el de la cripto.
 */
function hmUpdateSummary(items) {
    const countEl = document.getElementById("hmSumCount")
    const valueEl = document.getElementById("hmSumValue")
    const pnlEl = document.getElementById("hmSumPnl")
    const pnlLabelEl = document.getElementById("hmSumPnlLabel")
    if (!countEl || !valueEl || !pnlEl) return

    countEl.textContent = String(items.length)
    valueEl.textContent = items.length ? hmFormatEur(items.reduce((s, d) => s + d.netoEur, 0)) : "—"

    if (pnlLabelEl) pnlLabelEl.textContent = HM_PERIOD_LABELS[_hmPeriod] || "Movimiento"

    const tope = hmEscala()
    const tickMin = document.getElementById("hmLegendMin")
    const tickMax = document.getElementById("hmLegendMax")
    if (tickMin) tickMin.textContent = `−${tope} %`
    if (tickMax) tickMax.textContent = `+${tope} %`

    let cambio = 0
    let base = 0
    let hayDatos = false

    items.forEach((d) => {
        if (!d.hasValue || d.moneyChange === null) return
        cambio += d.moneyChange
        base += d.netoEur - d.moneyChange
        hayDatos = true
    })

    if (!hayDatos) {
        pnlEl.textContent = "—"
        pnlEl.className = "hmSumVal hmSumMoney"
        return
    }

    const pct = base > 0 ? (cambio / base) * 100 : 0
    pnlEl.textContent = `${hmFormatSignedEur(cambio)} (${hmFormatPct(pct)})`
    pnlEl.className = "hmSumVal hmSumMoney " + (cambio < 0 ? "hmNeg" : cambio > 0 ? "hmPos" : "")
}

/**
 * Engancha el tooltip y el clic al contenedor.
 *
 * Se hace **una vez** por contenedor, no en cada pintada: `hmRender` vacía el
 * contenedor pero no sus escuchadores, así que la versión anterior sumaba un
 * `mousemove` nuevo cada vez que se tocaba un filtro o se redimensionaba la
 * ventana, y todos seguían vivos.
 */
function hmBindContainer(container) {
    if (container.dataset.hmBound === "true") return
    container.dataset.hmBound = "true"

    container.addEventListener("mousemove", (e) => {
        const tip = hmGetTooltip()
        const cell = e.target.closest(".heatmapCell")
        if (!cell || !cell._hmData) {
            tip.classList.remove("hmTooltipVisible")
            return
        }

        tip.innerHTML = hmTooltipHtml(cell._hmData)
        tip.classList.add("hmTooltipVisible")

        // Posición: sigue al cursor y se aparta de los bordes. La medida es la
        // real del tooltip ya montado; antes eran dos números fijos que se
        // quedaban cortos en cuanto cambiaba el contenido.
        const margin = 12
        const rect = tip.getBoundingClientRect()
        let lx = e.clientX + margin
        let ly = e.clientY + margin
        if (lx + rect.width > window.innerWidth - 4) lx = e.clientX - rect.width - margin
        if (ly + rect.height > window.innerHeight - 4) ly = e.clientY - rect.height - margin
        tip.style.left = Math.max(4, lx) + "px"
        tip.style.top = Math.max(4, ly) + "px"
    })

    container.addEventListener("mouseleave", () => hmGetTooltip().classList.remove("hmTooltipVisible"))

    // Una baldosa es el activo: al pulsarla se abre su ficha, igual que al
    // pulsar su fila en la vista general.
    container.addEventListener("click", (e) => {
        const cell = e.target.closest(".heatmapCell")
        const id = cell?._hmData?.id
        if (!id) return
        hmGetTooltip().classList.remove("hmTooltipVisible")
        if (typeof clearNavSelection === "function") clearNavSelection()
        if (typeof selectAsset === "function") {
            Promise.resolve(selectAsset(id)).catch((err) => console.error("No se pudo abrir el activo:", err))
        }
    })
}

function hmGetTooltip() {
    let tip = document.getElementById("hmTooltip")
    if (!tip) {
        tip = document.createElement("div")
        tip.id = "hmTooltip"
        tip.className = "hmTooltip"
        document.body.appendChild(tip)
    }
    return tip
}

function hmTooltipHtml(d) {
    const pctClass = !d.hasValue || d.value === null ? "" : d.value < 0 ? "hmTipNeg" : d.value > 0 ? "hmTipPos" : ""
    const fila = (label, valor, cls = "", dinero = true) =>
        `<span class="hmTipLabel">${label}</span><span class="hmTipVal ${dinero ? "hmTipMoneyVal" : ""} ${cls}">${valor}</span>`

    // Precio
    const priceNum = parseFloat(String(d.price || "").replace(",", "."))
    const priceStr =
        !isNaN(priceNum) && priceNum > 0 ? fila("Precio", hmFormatPrice(priceNum, d.currency), "", false) : ""

    // Lo del periodo elegido, que es lo que pinta el mapa
    const etiquetaPeriodo = HM_PERIOD_LABELS[_hmPeriod] || "Movimiento"
    // En «Todo» el periodo es la posición entera, que ya sale debajo como
    // Rendimiento: se omite para no repetir el mismo número.
    const periodoRows =
        _hmPeriod === "todo" && d.hasCuenta && d.netoEur > 0
            ? ""
            : d.hasValue && d.value !== null
              ? fila(etiquetaPeriodo, d.valueLabel, pctClass, false) +
                (d.moneyChange !== null ? fila("Movimiento", hmFormatSignedEur(d.moneyChange), pctClass) : "")
              : fila(etiquetaPeriodo, "sin dato", "", false)

    // Y la posición, que no depende del periodo
    let cuentaRows = ""
    if (d.hasCuenta && d.netoEur > 0) {
        const ganancia = d.netoEur - d.invertidoEur
        const ganClass = ganancia < 0 ? "hmTipNeg" : ganancia > 0 ? "hmTipPos" : ""
        cuentaRows =
            fila("Invertido", hmFormatEur(d.invertidoEur)) +
            fila("Valor actual", hmFormatEur(d.netoEur)) +
            fila("Rendimiento", `${hmFormatSignedEur(ganancia)} (${hmFormatPct(d.cuentaPct)})`, ganClass)
    }

    // Peso en el mapa: explica el tamaño de la baldosa, que si no hay que
    // adivinarlo comparándola con las de al lado.
    const pesoRow = d.weight > 0 ? fila("Peso", hmFormatPct(d.weight * 100).replace("+", ""), "", false) : ""

    return `
            <div class="hmTipName">${escapeHtml(d.name)}</div>
            <div class="hmTipDivider"></div>
            <div class="hmTipGrid">${priceStr}${periodoRows}${cuentaRows}${pesoRow}</div>`
}

function hmBuildCell(rect) {
    const { x, y, w, h, symbol, name, value, valueLabel, hasValue, moneyChange } = rect

    const bg = hasValue && value !== null ? hmColorForValue(value) : hmNeutralColor()

    // El hueco se reparte entre las dos baldosas vecinas, así que el mapa
    // queda con una rejilla uniforme y sin perder los bordes exteriores.
    const cw = Math.max(w - HM_GAP, 2)
    const ch = Math.max(h - HM_GAP, 2)

    const el = document.createElement("div")
    el.className = "heatmapCell"
    el.style.cssText = `left:${x + HM_GAP / 2}px;top:${y + HM_GAP / 2}px;width:${cw}px;height:${ch}px;background:${bg};color:#fff;`
    el._hmData = rect // attach data for tooltip (no title attribute needed)

    const fontSize = hmFontSize(cw, ch, symbol.length ? symbol : name)
    let inner = `<span class="hmSymbol" style="font-size:${fontSize}px">${escapeHtml(symbol)}</span>`

    // El nombre, en cuanto hay sitio para una segunda línea: "XAUEUR" no dice
    // lo que dice "Oro".
    if (ch >= 60 && cw >= 72 && name && String(name).toUpperCase() !== String(symbol).toUpperCase()) {
        inner += `<span class="hmName">${escapeHtml(name)}</span>`
    }

    const cls = !hasValue || value === null ? "hmNd" : value < 0 ? "hmNeg" : value > 0 ? "hmPos" : ""

    if (ch >= 42 && cw >= 44) {
        inner += `<span class="hmValue ${cls}">${valueLabel}</span>`
    }

    // La tercera línea es la que distingue los dos mapas: en el de los activos,
    // el precio de mercado; en el de la cuenta, el dinero que ha movido la
    // posición en el periodo —un +0,4 % en la posición grande y un +12 % en la
    // pequeña se parecen mucho más en euros de lo que parecen en color—.
    if (ch >= 76 && cw >= 62) {
        if (_hmMetric === "activos") {
            const priceNum = parseFloat(String(rect.price || "").replace(",", "."))
            if (!isNaN(priceNum) && priceNum > 0) {
                inner += `<span class="hmPrice">${hmFormatPrice(priceNum, rect.currency)}</span>`
            }
        } else if (moneyChange !== null) {
            inner += `<span class="hmMoney hmCellMoney ${cls}">${hmFormatSignedEur(moneyChange)}</span>`
        }
    }

    el.innerHTML = inner
    return el
}
// El cuerpo se elige por lo que ocupa el símbolo de verdad, medido con el tipo
// de letra de la página: "GOOGL" e "IIII" tienen las mismas letras y anchuras
// muy distintas. Antes se descontaba una cantidad fija por letra, así que los
// símbolos largos se pasaban de ancho y salían cortados ("GOOGL" → "GO…").
function hmFontSize(w, h, symbol) {
    const anchoA100 = hmMedirTexto(symbol)
    const porAncho = anchoA100 > 0 ? ((w - 10) / anchoA100) * 100 : w
    const porAlto = h * 0.4
    return Math.max(9, Math.min(porAncho, porAlto, 52))
}

// Ancho del símbolo en negrita a 100px, en un lienzo fuera de pantalla. El
// resultado se cachea: los mismos símbolos se vuelven a medir en cada pintada.
const _hmAnchos = new Map()
let _hmMeasureCtx = null
let _hmMedicionIntentada = false

function hmMedirTexto(texto) {
    const clave = String(texto || "")
    if (_hmAnchos.has(clave)) return _hmAnchos.get(clave)

    if (!_hmMeasureCtx && !_hmMedicionIntentada) {
        _hmMedicionIntentada = true
        try {
            _hmMeasureCtx = document.createElement("canvas").getContext("2d")
            const familia = getComputedStyle(document.body).fontFamily || "sans-serif"
            _hmMeasureCtx.font = `700 100px ${familia}`
        } catch {
            _hmMeasureCtx = null
        }
    }

    // Sin canvas (entorno de pruebas) se vuelve a la estimación por letras.
    const ancho = _hmMeasureCtx ? _hmMeasureCtx.measureText(clave).width : clave.length * 70
    _hmAnchos.set(clave, ancho)
    return ancho
}

function hmFormatEur(v) {
    return (v || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"
}

function hmFormatSignedEur(v) {
    return (v >= 0 ? "+" : "") + hmFormatEur(v)
}

function hmFormatPct(v) {
    if (v === null || v === undefined) return "N/D"
    const sign = v >= 0 ? "+" : ""
    return sign + v.toFixed(2).replace(".", ",") + " %"
}

// Los decimales dependen de la magnitud: en una baldosa del mapa no cabe un
// precio de cuatro cifras con céntimos, y una cripto de 0,0012 sin decimales
// se vería como 0.
//
// La divisa se añade al final. Las dos llamadas ya la pasaban, pero la función
// la ignoraba, así que un activo en dólares mostraba el mismo "1.234,56" que
// uno en euros y no había forma de distinguirlos en el mapa ni en el tooltip.
function hmFormatPrice(num, currency) {
    const decimales =
        num >= 1000
            ? { maximumFractionDigits: 0 }
            : num >= 1
              ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
              : { minimumFractionDigits: 2, maximumFractionDigits: 4 }

    return `${num.toLocaleString("es-ES", decimales)} ${currencySuffix(currency)}`
}

// Gris de "ni sube ni baja" (y de los que no tienen dato). En el tema claro el
// azul oscuro de siempre cantaba como un agujero negro entre las baldosas de
// color, así que ahí se usa un gris medio que aguanta el texto en blanco.
function hmNeutralColor() {
    return document.documentElement.getAttribute("data-theme") === "light" ? "#64748b" : "#252d3a"
}

function hmColorForValue(pct) {
    if (pct === null || pct === undefined) return hmNeutralColor()
    if (Math.abs(pct) < hmEscala() / 250) return hmNeutralColor()
    // t: 0 = barely different from 0%, 1 = extreme move
    const t = Math.min(Math.abs(pct) / hmEscala(), 1)
    if (pct > 0)
        return hmBlend("#a5d6a7", "#43a047", "#1b5e20", t) // verde: pastel → oscuro
    else return hmBlend("#ef9a9a", "#e53935", "#b71c1c", t) // rojo:  pastel → oscuro
}

function hmBlend(low, mid, high, t) {
    const a = hmHex(t < 0.4 ? low : mid)
    const b = hmHex(t < 0.4 ? mid : high)
    const tt = t < 0.4 ? t / 0.4 : (t - 0.4) / 0.6
    return `rgb(${Math.round(a.r + (b.r - a.r) * tt)},${Math.round(a.g + (b.g - a.g) * tt)},${Math.round(a.b + (b.b - a.b) * tt)})`
}

function hmHex(hex) {
    return { r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16) }
}

/**
 * Treemap «squarified» (Bruls, Huizing y Van Wijk).
 *
 * El reparto anterior partía la lista ordenada en dos mitades de área parecida
 * y recurría. Es más corto, pero no mira la forma que le está saliendo a cada
 * baldosa: en cuanto un activo pesa mucho más que sus vecinos, los pequeños se
 * quedan con tiras verticales de treinta píxeles de ancho donde no cabe ni el
 * símbolo. Este va llenando filas y solo cierra la fila cuando añadir un activo
 * más empeoraría la peor proporción de la fila, que es justo lo que mantiene
 * las baldosas cerca del cuadrado.
 */
function hmSquarify(items, x, y, w, h) {
    const out = []
    let pendientes = hmMinimoVisible(
        items.filter((d) => d.area > 0),
        w,
        h
    )
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
            if (
                fila.length &&
                hmWorstRatio(fila, areaFila, lado) <= hmWorstRatio([...fila, pendientes[i]], siguiente, lado)
            ) {
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

// Área mínima por baldosa: unos 26x26 px, lo justo para que se vea que hay algo
// y se pueda pasar el ratón por encima.
const HM_AREA_MINIMA = 26 * 26

/**
 * Sube al mínimo las baldosas diminutas y descuenta lo prestado del resto.
 *
 * Una posición de dos euros junto a una de dos mil sale con un área de
 * fracciones de píxel: el reparto se quedaba sin rectángulo antes de llegar a
 * ella y el activo desaparecía del mapa sin decir nada. Es peor que verlo
 * pequeño, porque el mapa dice «esto es toda tu cartera».
 *
 * El préstamo lo pagan las baldosas grandes a prorrata, así que el orden y las
 * proporciones entre ellas no cambian. Si no hubiera de dónde sacarlo se deja
 * el reparto tal cual: antes un mapa exacto que uno inventado.
 */
function hmMinimoVisible(items, w, h) {
    if (!items.length) return items

    const lienzo = w * h
    if (lienzo <= 0) return items

    // Entre todas las baldosas infladas no se pueden comer más de un cuarto del
    // mapa, o una cartera de cien posiciones minúsculas lo aplanaría todo.
    const minima = Math.min(HM_AREA_MINIMA, lienzo / (items.length * 4))
    const pequenas = items.filter((d) => d.area < minima)
    if (!pequenas.length) return items

    const prestado = pequenas.reduce((s, d) => s + (minima - d.area), 0)
    const areaGrandes = items.reduce((s, d) => s + (d.area >= minima ? d.area : 0), 0)
    if (areaGrandes <= prestado) return items

    const factor = (areaGrandes - prestado) / areaGrandes
    return items.map((d) => (d.area < minima ? { ...d, area: minima } : { ...d, area: d.area * factor }))
}

// Peor proporción (largo/ancho) de una fila si se cierra con estas áreas.
function hmWorstRatio(fila, areaFila, lado) {
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
