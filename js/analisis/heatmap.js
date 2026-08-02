let _hmPeriod = "dia"
let _hmMetric = "cuenta"
let _hmActiveTypes = new Set(["all"])
let _hmData = null
const _hmHistCache = {}   // { period: { data: {id: pct}, ts: ms } }
const _HM_HIST_TTL = 4 * 3600 * 1000

async function initHeatmapLogic() {
    _hmPeriod = "dia"
    _hmMetric = "cuenta"
    _hmActiveTypes = new Set(["all"])
    _hmData = null

    const periodsEl = document.getElementById("heatmapPeriods")
    const metricEl  = document.getElementById("heatmapMetric")
    const typesEl   = document.getElementById("heatmapTypes")

    if (periodsEl) {
        periodsEl.addEventListener("click", async (e) => {
            const btn = e.target.closest(".hmGroupBtn")
            if (!btn || !btn.dataset.period) return
            periodsEl.querySelectorAll(".hmGroupBtn").forEach(b => b.classList.remove("active"))
            btn.classList.add("active")
            _hmPeriod = btn.dataset.period
            if (_hmPeriod !== "dia") {
                await hmLoadHistorical(_hmPeriod)
            }
            hmRender()
        })
    }

    if (metricEl) {
        metricEl.addEventListener("click", (e) => {
            const btn = e.target.closest(".hmGroupBtn")
            if (!btn || !btn.dataset.metric) return
            metricEl.querySelectorAll(".hmGroupBtn").forEach(b => b.classList.remove("active"))
            btn.classList.add("active")
            _hmMetric = btn.dataset.metric
            // Grey out periods group when cuenta is selected
            periodsEl?.classList.toggle("hmGroupDisabled", _hmMetric === "cuenta")
            hmRender()
        })
    }

    if (typesEl) {
        typesEl.addEventListener("click", (e) => {
            const btn = e.target.closest(".hmGroupBtn")
            if (!btn || !btn.dataset.type) return
            const type = btn.dataset.type

            if (type === "all") {
                _hmActiveTypes = new Set(["all"])
                typesEl.querySelectorAll(".hmGroupBtn").forEach(b => b.classList.remove("active"))
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
                typesEl.querySelectorAll(".hmGroupBtn").forEach(b => {
                    b.classList.toggle("active",
                        _hmActiveTypes.has("all")
                            ? b.dataset.type === "all"
                            : _hmActiveTypes.has(b.dataset.type)
                    )
                })
            }
            hmRender()
        })
    }

    // Start with periods disabled since default metric is "cuenta"
    periodsEl?.classList.add("hmGroupDisabled")

    await hmLoadData()

    requestAnimationFrame(() => requestAnimationFrame(() => {
        hmRender()

        let _hmRenderTimer = null
        const _hmObserver = new ResizeObserver(() => {
            clearTimeout(_hmRenderTimer)
            _hmRenderTimer = setTimeout(hmRender, 40)
        })
        const container = document.getElementById("heatmapContainer")
        if (container) _hmObserver.observe(container)

        window._hmResizeCleanup = () => {
            _hmObserver.disconnect()
            clearTimeout(_hmRenderTimer)
            document.getElementById("hmTooltip")?.remove()
        }
    }))
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
        await Promise.all(assets.map(async asset => {
            try {
                const fullRes = await fetch(`/api/activos/${asset.id}`)
                const fullAsset = await fullRes.json()
                const row = await buildOverviewRow(fullAsset)
                const euros = await buildSummaryMetricsInEuros(row)
                asset._hmMetrics = {
                    netoEur:       euros.netoActualEur,
                    invertidoEur:  euros.invertidoBrutoEur,
                    cuentaPct:     euros.invertidoBrutoEur > 0
                        ? (euros.rendimientoEur / euros.invertidoBrutoEur * 100)
                        : 0,
                    hasCuenta:     euros.invertidoBrutoEur > 0,
                }
            } catch (e) {
                asset._hmMetrics = null
            }
        }))

        _hmData = window._hmData = assets.map(asset => {
            const cur = hmNormCur(asset.currency)
            const m   = asset._hmMetrics

            const netoEur      = m ? m.netoEur      : 0
            const invertidoEur = m ? m.invertidoEur : 0
            const cuentaPct    = m ? m.cuentaPct    : 0
            const hasCuenta    = m ? m.hasCuenta    : false

            const rawChange = String(asset.change || "").replace(/%/g, "").replace(",", ".").trim()
            const d1 = rawChange !== "" ? parseFloat(rawChange) : null
            const hasMarket = d1 !== null && !isNaN(d1)

            return {
                id:       asset.id,
                name:     asset.name || asset.symbol || asset.id,
                symbol:   hmExtractSymbol(asset),
                type:     (asset.type || "acciones").toLowerCase(),
                price:    asset.price || "---",
                currency: cur,
                netoEur,
                invertidoEur,
                cuentaPct,
                hasCuenta,
                dia: hasMarket ? d1 : null,
                hasMarket,
            }
        }).filter(d => d.netoEur > 0.01 || d.invertidoEur > 0.01)

    } catch (err) {
        console.error("Heatmap error:", err)
        _hmData = []
    }

    if (loading) loading.style.display = "none"
}

async function hmLoadHistorical(period) {
    const cached = _hmHistCache[period]
    if (cached && Date.now() - cached.ts < _HM_HIST_TTL) return

    const container = document.getElementById("heatmapContainer")
    const loading   = document.getElementById("heatmapLoading")
    if (loading) { loading.textContent = "Cargando datos históricos…"; loading.style.display = "flex" }

    try {
        const res  = await fetch(`/api/historical-changes?period=${period}`)
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
    return String(raw || "EUR").toUpperCase().trim() || "EUR"
}

function hmExtractSymbol(asset) {
    const ms = String(asset.marketSymbol || asset.finnhubSymbol || "").trim().toUpperCase()
    if (ms.includes(":")) return ms.split(":").pop().replace(/USDT$|USD$|USDC$|BUSD$/, "") || asset.name
    if (ms.includes(".")) return ms.split(".")[0]
    return ms || asset.name || asset.id
}

function hmRender() {
    const container = document.getElementById("heatmapContainer")
    if (!container || !_hmData) return

    // Filter by selected types (multi-select)
    const items = _hmData.filter(d =>
        _hmActiveTypes.has("all") || _hmActiveTypes.has(d.type)
    )

    if (!items.length) {
        container.innerHTML = '<div class="heatmapEmpty">No hay activos para mostrar</div>'
        return
    }

    const enriched = items.map(d => {
        let value, valueLabel, hasValue, approx = false

        if (_hmMetric === "cuenta") {
            if (d.hasCuenta) {
                value = d.cuentaPct
                hasValue = true
                valueLabel = hmFormatPct(value)
            } else if (d.hasMarket) {
                value = d.dia
                hasValue = true
                valueLabel = hmFormatPct(value)
            } else {
                value = null; hasValue = false; valueLabel = "—"
            }
        } else {
            // activos: día usa datos reales; resto usa histórico real del API
            if (_hmPeriod === "dia") {
                value = d.dia
                hasValue = d.dia !== null
            } else {
                const histData = _hmHistCache[_hmPeriod]?.data || {}
                value = histData[d.id] ?? null
                hasValue = value !== null
            }
            valueLabel = hasValue ? hmFormatPct(value) : "N/D"
        }

        const size = Math.max(d.netoEur, 0.01)

        // Money movement for tooltip
        let moneyChange = null
        if (_hmMetric === "cuenta" && d.hasCuenta) {
            moneyChange = d.netoEur - d.invertidoEur
        } else if (hasValue && value !== null && d.netoEur > 0) {
            moneyChange = d.netoEur * value / 100
        }

        return { ...d, size, value, valueLabel, hasValue, moneyChange }
    }).sort((a, b) => b.size - a.size)

    const totalSize = enriched.reduce((s, d) => s + d.size, 0)
    if (totalSize === 0) {
        container.innerHTML = '<div class="heatmapEmpty">Sin datos</div>'
        return
    }

    const W = container.clientWidth  || container.offsetWidth  || 800
    const H = container.clientHeight || container.offsetHeight || 500

    const rects = hmSquarify(
        enriched.map(d => ({ ...d, area: (d.size / totalSize) * W * H })),
        0, 0, W, H
    )

    container.innerHTML = ""
    hmEnsureTooltip(container)
    rects.forEach(rect => container.appendChild(hmBuildCell(rect)))
}

function hmEnsureTooltip(container) {
    let tip = document.getElementById("hmTooltip")
    if (!tip) {
        tip = document.createElement("div")
        tip.id = "hmTooltip"
        tip.className = "hmTooltip"
        document.body.appendChild(tip)
    }

    container.addEventListener("mousemove", (e) => {
        const cell = e.target.closest(".heatmapCell")
        if (!cell) { tip.classList.remove("hmTooltipVisible"); return }

        const d = cell._hmData
        if (!d) return

        const pctClass = !d.hasValue || d.value === null ? "" : d.value < 0 ? "hmTipNeg" : d.value > 0 ? "hmTipPos" : ""

        const fmtEur = (v) => v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €"
        const fmtSigned = (v) => (v >= 0 ? "+" : "") + fmtEur(v)

        // Price row
        const priceNum = parseFloat(String(d.price || "").replace(",", "."))
        const priceStr = !isNaN(priceNum) && priceNum > 0
            ? `<span class="hmTipLabel">Precio</span><span class="hmTipVal">${hmFormatPrice(priceNum, d.currency)}</span>`
            : ""

        // Cuenta rows (only when we hold the asset)
        let cuentaRows = ""
        if (d.hasCuenta && d.netoEur > 0) {
            const ganancia = d.netoEur - d.invertidoEur
            const ganClass = ganancia < 0 ? "hmTipNeg" : ganancia > 0 ? "hmTipPos" : ""
            cuentaRows = `
                <span class="hmTipLabel">Invertido</span><span class="hmTipVal">${fmtEur(d.invertidoEur)}</span>
                <span class="hmTipLabel">Valor actual</span><span class="hmTipVal">${fmtEur(d.netoEur)}</span>
                <span class="hmTipLabel">Ganancia</span><span class="hmTipVal ${ganClass}">${fmtSigned(ganancia)}</span>`
        } else if (d.moneyChange !== null) {
            cuentaRows = `<span class="hmTipLabel">Cambio</span><span class="hmTipVal ${pctClass}">${fmtSigned(d.moneyChange)}</span>`
        }

        // Rentabilidad row
        const rentRow = d.hasValue && d.value !== null
            ? `<span class="hmTipLabel">Rentab.</span><span class="hmTipVal ${pctClass}">${d.valueLabel}</span>`
            : ""

        tip.innerHTML = `
            <div class="hmTipName">${d.name}</div>
            <div class="hmTipDivider"></div>
            <div class="hmTipGrid">${priceStr}${cuentaRows}${rentRow}</div>`

        // Position: follow cursor, avoid edges
        const margin = 12
        const tw = 215, th = d.hasCuenta && d.netoEur > 0 ? 148 : 90
        let lx = e.clientX + margin
        let ly = e.clientY + margin
        if (lx + tw > window.innerWidth)  lx = e.clientX - tw - margin
        if (ly + th > window.innerHeight) ly = e.clientY - th - margin
        tip.style.left = lx + "px"
        tip.style.top  = ly + "px"
        tip.classList.add("hmTooltipVisible")
    })

    container.addEventListener("mouseleave", () => tip.classList.remove("hmTooltipVisible"))
}

function hmBuildCell(rect) {
    const { x, y, w, h, symbol, price, currency, value, valueLabel, hasValue } = rect

    const bg = hasValue && value !== null ? hmColorForValue(value) : "#252d3a"

    const el = document.createElement("div")
    el.className = "heatmapCell"
    el.style.cssText = `left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${bg};color:#fff;`
    el._hmData = rect   // attach data for tooltip (no title attribute needed)

    const fontSize = hmFontSize(w, h, symbol.length)
    let inner = `<span class="hmSymbol" style="font-size:${fontSize}px">${symbol}</span>`

    if (h >= 60 && w >= 50) {
        const priceNum = parseFloat(String(price || "").replace(",", "."))
        if (!isNaN(priceNum) && priceNum > 0) {
            inner += `<span class="hmPrice">${hmFormatPrice(priceNum, currency)}</span>`
        }
    }

    if (h >= 44 && w >= 44) {
        const cls = !hasValue || value === null ? "hmNd" : value < 0 ? "hmNeg" : value > 0 ? "hmPos" : ""
        inner += `<span class="hmValue ${cls}">${valueLabel}</span>`
    }

    el.innerHTML = inner
    return el
}

function hmFontSize(w, h, symLen) {
    const base = Math.min(w * 0.35, h * 0.35, 56)
    return Math.max(10, Math.min(base - Math.max(0, symLen - 3) * 3, 52))
}

function hmFormatPct(v) {
    if (v === null || v === undefined) return "N/D"
    const sign = v >= 0 ? "+" : ""
    return sign + v.toFixed(2).replace(".", ",") + " %"
}

function hmFormatPrice(num, currency) {
    if (num >= 1000) return num.toLocaleString("es-ES", { maximumFractionDigits: 0 })
    if (num >= 1)    return num.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    return num.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 4 })
}

function hmColorForValue(pct) {
    if (pct === null || pct === undefined) return "#252d3a"
    if (Math.abs(pct) < 0.04) return "#252d3a"
    // t: 0 = barely different from 0%, 1 = extreme move
    const t = Math.min(Math.abs(pct) / 10, 1)
    if (pct > 0) return hmBlend("#a5d6a7", "#43a047", "#1b5e20", t)   // verde: pastel → oscuro
    else         return hmBlend("#ef9a9a", "#e53935", "#b71c1c", t)   // rojo:  pastel → oscuro
}

function hmBlend(low, mid, high, t) {
    const a = hmHex(t < 0.4 ? low : mid)
    const b = hmHex(t < 0.4 ? mid : high)
    const tt = t < 0.4 ? t / 0.4 : (t - 0.4) / 0.6
    return `rgb(${Math.round(a.r+(b.r-a.r)*tt)},${Math.round(a.g+(b.g-a.g)*tt)},${Math.round(a.b+(b.b-a.b)*tt)})`
}

function hmHex(hex) {
    return { r: parseInt(hex.slice(1,3),16), g: parseInt(hex.slice(3,5),16), b: parseInt(hex.slice(5,7),16) }
}

// Binary space partition treemap
function hmSquarify(items, x, y, w, h) {
    if (!items.length) return []
    if (items.length === 1) return [{ ...items[0], x, y, w, h }]

    const total = items.reduce((s, i) => s + i.area, 0)
    if (total <= 0) return []

    let cum = 0, splitIdx = 1
    const half = total / 2
    for (let i = 0; i < items.length - 1; i++) {
        cum += items[i].area
        if (cum >= half) { splitIdx = i + 1; break }
    }

    const a = items.slice(0, splitIdx)
    const b = items.slice(splitIdx)
    const r = a.reduce((s, i) => s + i.area, 0) / total
    const PAD = 1

    if (w >= h) {
        const sw = Math.max(1, w * r)
        return [...hmSquarify(a, x, y, sw - PAD, h), ...hmSquarify(b, x + sw, y, w - sw, h)]
    } else {
        const sh = Math.max(1, h * r)
        return [...hmSquarify(a, x, y, w, sh - PAD), ...hmSquarify(b, x, y + sh, w, h - sh)]
    }
}
