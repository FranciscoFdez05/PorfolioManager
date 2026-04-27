let _herramientasChart = null
let _hDivChart = null
let _hPrecioMedioCount = 0

async function initHerramientasLogic() {
    window.flushPendingPageChanges = null

    // ── Navegación entre herramientas ──────────────────────────────
    document.querySelectorAll(".herramientaBtn").forEach((btn) => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".herramientaBtn").forEach((b) => b.classList.remove("active"))
            document.querySelectorAll(".herramientaPanel").forEach((p) => {
                p.classList.remove("active")
                p.classList.add("hidden")
            })
            btn.classList.add("active")
            const toolId = "tool" + btn.dataset.tool.charAt(0).toUpperCase() + btn.dataset.tool.slice(1)
            const panel = document.getElementById(toolId)
            if (panel) { panel.classList.remove("hidden"); panel.classList.add("active") }
        })
    })

    // ── Botones Reiniciar ──────────────────────────────────────────
    document.querySelectorAll(".herramientaResetBtn").forEach((btn) => {
        btn.addEventListener("click", () => hResetPanel(btn.dataset.panel))
    })

    // ── Interés Compuesto ──────────────────────────────────────────
    document.getElementById("hIntCalcBtn")?.addEventListener("click", hCalcInteresCompuesto)

    // ── Rentabilidad ───────────────────────────────────────────────
    document.getElementById("hRentCalcBtn")?.addEventListener("click", hCalcRentabilidad)

    // ── CAGR ───────────────────────────────────────────────────────
    document.getElementById("hCagrCalcBtn")?.addEventListener("click", hCalcCagr)

    // ── Regla del 72 ───────────────────────────────────────────────
    document.getElementById("hR72TasaBtn")?.addEventListener("click", () => {
        const tasa = parseFloat(document.getElementById("hR72Tasa").value) || 0
        if (tasa <= 0) return
        document.getElementById("hR72TasaAnos").textContent = (72 / tasa).toFixed(1) + " años"
        document.getElementById("hR72TasaResults").classList.remove("hidden")
    })
    document.getElementById("hR72AnosBtn")?.addEventListener("click", () => {
        const anos = parseFloat(document.getElementById("hR72Anos").value) || 0
        if (anos <= 0) return
        document.getElementById("hR72AnosTasa").textContent = (72 / anos).toFixed(2) + " %"
        document.getElementById("hR72AnosResults").classList.remove("hidden")
    })

    // ── Precio Medio ───────────────────────────────────────────────
    hInitPrecioMedio()
    document.getElementById("hPrecioAddRow")?.addEventListener("click", hAddPrecioMedioRow)
    document.getElementById("hPrecioCalcBtn")?.addEventListener("click", hCalcPrecioMedio)

    // ── Rent. Dividendo ────────────────────────────────────────────
    document.getElementById("hDivLoadBtn")?.addEventListener("click", hLoadDividendos)
    document.getElementById("hYieldCalcBtn")?.addEventListener("click", hCalcYield)

    // ── Ratio Oro / Plata ──────────────────────────────────────────
    document.getElementById("hRatioLoadBtn")?.addEventListener("click", hRatioLoadPrecios)
    document.getElementById("hRatioCalcBtn")?.addEventListener("click", hCalcRatioOroPlata)

    // ── Enter para calcular ────────────────────────────────────────
    document.querySelectorAll(".herramientaPanel input").forEach((input) => {
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                input.closest(".herramientaPanel")?.querySelector(".herramientaCalcBtn")?.click()
            }
        })
    })
}

// ── Reset ──────────────────────────────────────────────────────────────────

function hResetPanel(panelId) {
    const panel = document.getElementById(panelId)
    if (!panel) return
    panel.querySelectorAll("input[type='number']").forEach((inp) => { inp.value = inp.defaultValue })
    panel.querySelectorAll(".herramientaResults").forEach((el) => el.classList.add("hidden"))

    if (panelId === "toolInteres" && _herramientasChart) {
        _herramientasChart.destroy(); _herramientasChart = null
    }
    if (panelId === "toolPrecioMedio") {
        hInitPrecioMedio()
    }
    if (panelId === "toolRentDividendo") {
        if (_hDivChart) { _hDivChart.destroy(); _hDivChart = null }
        const tbody = document.getElementById("hDivTableBody")
        if (tbody) tbody.innerHTML = ""
    }
}

// ── Interés Compuesto ──────────────────────────────────────────────────────

function hCalcInteresCompuesto() {
    const P   = parseFloat(document.getElementById("hIntCapital").value) || 0
    const pmt = parseFloat(document.getElementById("hIntAportacion").value) || 0
    const r   = (parseFloat(document.getElementById("hIntTasa").value) || 0) / 100
    const t   = parseInt(document.getElementById("hIntAnos").value) || 0
    if (t <= 0) return

    const rn = r / 12
    const yearlyData = []
    for (let y = 0; y <= t; y++) {
        const m = y * 12
        const cap   = P * Math.pow(1 + rn, m)
        const aport = rn > 0 ? pmt * (Math.pow(1 + rn, m) - 1) / rn : pmt * m
        yearlyData.push({ year: y, total: cap + aport, aportado: P + pmt * m })
    }

    const final       = yearlyData[t]
    const capitalFinal = final.total
    const totalAport   = final.aportado
    const intereses    = capitalFinal - totalAport
    const mult         = totalAport > 0 ? (capitalFinal / totalAport).toFixed(2) + "x" : "---"

    document.getElementById("hIntCapitalFinal").textContent  = formatEuro(capitalFinal)
    document.getElementById("hIntTotalAportado").textContent = formatEuro(totalAport)
    document.getElementById("hIntIntereses").textContent     = formatEuro(intereses)
    document.getElementById("hIntMultiplicador").textContent = mult
    document.getElementById("hIntResults").classList.remove("hidden")

    if (_herramientasChart) { _herramientasChart.destroy(); _herramientasChart = null }
    const ctx = document.getElementById("hIntChart")
    if (!ctx) return

    _herramientasChart = new Chart(ctx, {
        type: "line",
        data: {
            labels: yearlyData.map((d) => "Año " + d.year),
            datasets: [
                { label: "Capital total",   data: yearlyData.map((d) => d.total),    borderColor: "#2ecc71", backgroundColor: "#2ecc7120", fill: true, tension: 0.3, pointRadius: 2 },
                { label: "Total aportado",  data: yearlyData.map((d) => d.aportado), borderColor: "#3498db", backgroundColor: "#3498db20", fill: true, tension: 0.3, pointRadius: 2 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
            plugins: {
                legend: { labels: { color: "#ccd6f6", font: { size: 12 }, padding: 12 } },
                tooltip: { callbacks: { label: (c) => "  " + formatEuro(c.raw) } }
            },
            scales: {
                x: { ticks: { color: "#7a8fb0", font: { size: 11 } }, grid: { color: "#1a2640" } },
                y: { ticks: { color: "#7a8fb0", font: { size: 11 }, callback: (v) => formatEuro(v) }, grid: { color: "#1a2640" } }
            }
        }
    })
}

// ── Rentabilidad ───────────────────────────────────────────────────────────

function hCalcRentabilidad() {
    const compra     = parseFloat(document.getElementById("hRentCompra").value) || 0
    const venta      = parseFloat(document.getElementById("hRentVenta").value) || 0
    const dividendos = parseFloat(document.getElementById("hRentDividendos").value) || 0
    const comisiones = parseFloat(document.getElementById("hRentComisiones").value) || 0
    const anos       = parseFloat(document.getElementById("hRentAnos").value) || 1
    if (compra <= 0) return

    const pnl       = (venta - compra) + dividendos - comisiones
    const rentTotal = (pnl / compra) * 100
    const rentAnual = (Math.pow(1 + pnl / compra, 1 / anos) - 1) * 100

    const set = (id, val, isEuro = false) => {
        const el = document.getElementById(id)
        el.textContent = isEuro ? formatEuro(val) : val.toFixed(2) + " %"
        el.className = "hResultValue " + (val >= 0 ? "hResultPositive" : "hResultNegative")
    }
    set("hRentPnL", pnl, true)
    set("hRentTotal", rentTotal)
    set("hRentAnualizada", rentAnual)
    document.getElementById("hRentResults").classList.remove("hidden")
}

// ── Precio Medio ───────────────────────────────────────────────────────────

function hInitPrecioMedio() {
    _hPrecioMedioCount = 0
    const tbody = document.getElementById("hPrecioMedioBody")
    if (!tbody) return
    tbody.innerHTML = ""
    hAddPrecioMedioRow()
    hAddPrecioMedioRow()
    hAddPrecioMedioRow()
}

function hAddPrecioMedioRow() {
    const tbody = document.getElementById("hPrecioMedioBody")
    if (!tbody) return
    _hPrecioMedioCount++
    const tr = document.createElement("tr")
    tr.innerHTML = `
        <td class="hPmNum">${_hPrecioMedioCount}</td>
        <td><input type="number" class="hPrecioInput" placeholder="0.00" step="0.01" min="0"></td>
        <td><input type="number" class="hPrecioInput" placeholder="1" step="0.0001" min="0"></td>
        <td class="hPmTotal">---</td>
        <td><button class="hPrecioDeleteBtn" title="Eliminar">✕</button></td>
    `
    tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => hUpdatePmRowTotal(tr)))
    tr.querySelector(".hPrecioDeleteBtn").addEventListener("click", () => {
        tr.remove()
        document.querySelectorAll("#hPrecioMedioBody tr").forEach((r, i) => { r.querySelector(".hPmNum").textContent = i + 1 })
    })
    tbody.appendChild(tr)
}

function hUpdatePmRowTotal(tr) {
    const [pInp, qInp] = tr.querySelectorAll("input")
    const p = parseFloat(pInp.value) || 0
    const q = parseFloat(qInp.value) || 0
    tr.querySelector(".hPmTotal").textContent = (p > 0 && q > 0) ? formatEuro(p * q) : "---"
}

function hCalcPrecioMedio() {
    let totalInv = 0, totalUnd = 0
    document.querySelectorAll("#hPrecioMedioBody tr").forEach((tr) => {
        const [pInp, qInp] = tr.querySelectorAll("input")
        totalInv += (parseFloat(pInp.value) || 0) * (parseFloat(qInp.value) || 0)
        totalUnd += parseFloat(qInp.value) || 0
    })
    const pm = totalUnd > 0 ? totalInv / totalUnd : 0
    document.getElementById("hPrecioMedioResult").textContent   = formatEuro(pm)
    document.getElementById("hPrecioTotalInv").textContent      = formatEuro(totalInv)
    document.getElementById("hPrecioTotalUnidades").textContent = totalUnd.toLocaleString("es-ES", { maximumFractionDigits: 8 })
    document.getElementById("hPrecioResults").classList.remove("hidden")
}

// ── CAGR ───────────────────────────────────────────────────────────────────

function hCalcCagr() {
    const vi = parseFloat(document.getElementById("hCagrInicial").value) || 0
    const vf = parseFloat(document.getElementById("hCagrFinal").value) || 0
    const t  = parseFloat(document.getElementById("hCagrAnos").value) || 1
    if (vi <= 0 || t <= 0) return

    const cagr      = (Math.pow(vf / vi, 1 / t) - 1) * 100
    const crecTotal = ((vf - vi) / vi) * 100

    const setResult = (id, val) => {
        const el = document.getElementById(id)
        el.textContent = val.toFixed(2) + " %"
        el.className = "hResultValue " + (val >= 0 ? "hResultPositive" : "hResultNegative")
    }
    setResult("hCagrResult", cagr)
    setResult("hCagrCrecimiento", crecTotal)
    document.getElementById("hCagrResults").classList.remove("hidden")
}

// ── Rentabilidad Dividendo ─────────────────────────────────────────────────

async function hLoadDividendos() {
    const btn = document.getElementById("hDivLoadBtn")
    if (btn) btn.textContent = "Cargando..."

    try {
        const resp = await fetch("/api/dividendos")
        if (!resp.ok) throw new Error()
        const rows = await resp.json()

        const byInst = {}
        rows.forEach((r) => {
            const name = (r.instrumento || "Sin nombre").trim()
            if (!byInst[name]) byInst[name] = { count: 0, bruto: 0, retencion: 0, neto: 0 }
            byInst[name].count++
            byInst[name].bruto     += parseEuroNumber(String(r.total || r.dividendo || "0"))
            byInst[name].retencion += parseEuroNumber(String(r.retencion || "0"))
            byInst[name].neto      += parseEuroNumber(String(r.neto || "0"))
        })

        const sorted = Object.entries(byInst).sort((a, b) => b[1].neto - a[1].neto)

        // Tabla
        const tbody = document.getElementById("hDivTableBody")
        tbody.innerHTML = ""
        sorted.forEach(([name, d]) => {
            const tr = document.createElement("tr")
            tr.innerHTML = `
                <td class="hDivName">${name}</td>
                <td class="hDivNum">${d.count}</td>
                <td class="hDivNum">${formatEuro(d.bruto)}</td>
                <td class="hDivNum hDivNeg">${formatEuro(d.retencion)}</td>
                <td class="hDivNum hDivPos">${formatEuro(d.neto)}</td>
            `
            tbody.appendChild(tr)
        })

        // Gráfico
        if (_hDivChart) { _hDivChart.destroy(); _hDivChart = null }
        const ctx = document.getElementById("hDivChart")
        if (ctx && sorted.length) {
            const labels = sorted.map(([n]) => n)
            const brutos = sorted.map(([, d]) => d.bruto)
            const netos  = sorted.map(([, d]) => d.neto)
            const chartH = Math.max(200, sorted.length * 36)
            ctx.parentElement.style.height = chartH + "px"

            _hDivChart = new Chart(ctx, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        { label: "Bruto", data: brutos, backgroundColor: "#3498db88", borderColor: "#3498db", borderWidth: 1, borderRadius: 3 },
                        { label: "Neto",  data: netos,  backgroundColor: "#2ecc7188", borderColor: "#2ecc71", borderWidth: 1, borderRadius: 3 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, indexAxis: "y",
                    plugins: {
                        legend: { labels: { color: "#ccd6f6", font: { size: 12 }, padding: 12 } },
                        tooltip: { callbacks: { label: (c) => "  " + formatEuro(c.raw) } }
                    },
                    scales: {
                        x: { ticks: { color: "#7a8fb0", font: { size: 11 }, callback: (v) => formatEuro(v) }, grid: { color: "#1a2640" } },
                        y: { ticks: { color: "#ccd6f6", font: { size: 12 } }, grid: { color: "#1a2640" } }
                    }
                }
            })
        }

        document.getElementById("hDivHistResults").classList.remove("hidden")
    } catch {
        if (btn) btn.textContent = "Error al cargar"
        return
    }

    if (btn) btn.textContent = "Actualizar"
}

// ── Ratio Oro / Plata ──────────────────────────────────────────────────────

const ORO_KEYWORDS   = ["oro", "gold", "xau"]
const PLATA_KEYWORDS = ["plata", "silver", "xag"]

function _ratioMatchesMetal(asset, keywords) {
    const haystack = ((asset.name || "") + " " + (asset.symbol || "")).toLowerCase()
    return keywords.some((k) => haystack.includes(k))
}

async function hRatioLoadPrecios() {
    const btn = document.getElementById("hRatioLoadBtn")
    const msgEl = document.getElementById("hRatioFuenteMsg")
    btn.textContent = "Cargando..."
    btn.disabled = true
    msgEl.textContent = ""
    msgEl.className = "hRatioFuenteMsg"

    try {
        const res = await fetch("/api/activos")
        if (!res.ok) throw new Error()
        const { assets } = await res.json()

        const oroAsset   = assets.find((a) => _ratioMatchesMetal(a, ORO_KEYWORDS))
        const plataAsset = assets.find((a) => _ratioMatchesMetal(a, PLATA_KEYWORDS))

        const msgs = []
        if (oroAsset) {
            const p = parseEuroNumber(oroAsset.price)
            if (p > 0) {
                document.getElementById("hRatioPrecioOro").value = p
                msgs.push(`Oro: ${oroAsset.name} → ${formatEuro(p)}`)
            }
        }
        if (plataAsset) {
            const p = parseEuroNumber(plataAsset.price)
            if (p > 0) {
                document.getElementById("hRatioPrecioPlata").value = p
                msgs.push(`Plata: ${plataAsset.name} → ${formatEuro(p)}`)
            }
        }

        if (msgs.length === 0) {
            msgEl.textContent = "No se encontraron activos de oro o plata en la cartera."
            msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
        } else {
            msgEl.textContent = msgs.join("  ·  ")
            msgEl.className = "hRatioFuenteMsg hRatioFuenteOk"
            if (msgs.length === 2) hCalcRatioOroPlata()
        }
    } catch {
        msgEl.textContent = "Error al cargar los activos."
        msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
    }

    btn.textContent = "Cargar precios guardados"
    btn.disabled = false
}

function hCalcRatioOroPlata() {
    const precioOro   = parseFloat(document.getElementById("hRatioPrecioOro").value) || 0
    const precioPlata = parseFloat(document.getElementById("hRatioPrecioPlata").value) || 0
    if (precioOro <= 0 || precioPlata <= 0) return

    const ratio        = precioOro / precioPlata
    const mediaHist    = 50
    const difVsHist    = ((ratio - mediaHist) / mediaHist) * 100
    const precioJusto  = precioOro / mediaHist
    const plataNecesaria = ratio

    document.getElementById("hRatioValor").textContent =
        ratio.toFixed(2) + " oz"

    const vsEl = document.getElementById("hRatioVsHistorico")
    vsEl.textContent = (difVsHist >= 0 ? "+" : "") + difVsHist.toFixed(1) + "% vs media"
    vsEl.className = "hResultValue " + (difVsHist > 0 ? "hResultNegative" : "hResultPositive")

    document.getElementById("hRatioPrecioJusto").textContent =
        formatEuro(precioJusto) + "/oz"

    document.getElementById("hRatioPlataParaOro").textContent =
        plataNecesaria.toFixed(2) + " oz (" + formatEuro(plataNecesaria * precioPlata) + ")"

    const interp = document.getElementById("hRatioInterpretacion")
    if (ratio > mediaHist) {
        interp.textContent = `El ratio está por encima de la media histórica (${ratio.toFixed(0)} vs ${mediaHist}). La plata está relativamente barata frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoPos"
    } else {
        interp.textContent = `El ratio está por debajo de la media histórica (${ratio.toFixed(0)} vs ${mediaHist}). La plata está relativamente cara frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoNeg"
    }

    document.getElementById("hRatioResults").classList.remove("hidden")
}

// ── Yield Manual ───────────────────────────────────────────────────────────

function hCalcYield() {
    const precio    = parseFloat(document.getElementById("hYieldPrecio").value) || 0
    const divAnual  = parseFloat(document.getElementById("hYieldDiv").value) || 0
    const acciones  = parseFloat(document.getElementById("hYieldAcciones").value) || 0
    const retencion = (parseFloat(document.getElementById("hYieldRetencion").value) || 0) / 100
    if (precio <= 0) return

    const yieldPct   = (divAnual / precio) * 100
    const brutoAnual = divAnual * acciones
    const netoAnual  = brutoAnual * (1 - retencion)
    const netoMensual = netoAnual / 12

    document.getElementById("hYieldPct").textContent     = yieldPct.toFixed(2) + " %"
    document.getElementById("hYieldBruto").textContent   = formatEuro(brutoAnual)
    document.getElementById("hYieldNeto").textContent    = formatEuro(netoAnual)
    document.getElementById("hYieldMensual").textContent = formatEuro(netoMensual)
    document.getElementById("hYieldResults").classList.remove("hidden")
}
