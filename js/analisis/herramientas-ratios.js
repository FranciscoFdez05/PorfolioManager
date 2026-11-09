// Análisis > Herramientas: ratio oro/plata, yield manual y oro/bitcoin.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.

// ── Ratio Oro / Plata ──────────────────────────────────────────────────────

const ORO_KEYWORDS = ["oro", "gold", "xau"]
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

        const oroAsset = assets.find((a) => _ratioMatchesMetal(a, ORO_KEYWORDS))
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

let _ratioHistorico = Number(getChartPref("hRatioHistorico", 60)) || 60

function hRatioAplicarHistoricoLabels() {
    const v = _ratioHistorico
    const label = document.getElementById("hRatioHistLabel")
    const labelResult = document.getElementById("hRatioHistLabelResult")
    const labelJusto = document.getElementById("hRatioHistLabelJusto")
    if (label) label.textContent = v
    if (labelResult) labelResult.textContent = v
    if (labelJusto) labelJusto.textContent = v
}

function hRatioAbrirEditor() {
    document.getElementById("hRatioHistInput").value = _ratioHistorico
    document.getElementById("hRatioEditorOverlay").classList.remove("hidden")
    document.getElementById("hRatioHistInput").focus()
}

function hRatioCerrarEditor() {
    document.getElementById("hRatioEditorOverlay").classList.add("hidden")
}

function hRatioGuardarHistorico() {
    const v = parseFloat(document.getElementById("hRatioHistInput").value)
    if (!v || v <= 0) return
    _ratioHistorico = v
    setChartPref("hRatioHistorico", v)
    hRatioAplicarHistoricoLabels()
    hRatioCerrarEditor()
    hCalcRatioOroPlata()
}

function hCalcRatioOroPlata() {
    const precioOro = parseFloat(document.getElementById("hRatioPrecioOro").value) || 0
    const precioPlata = parseFloat(document.getElementById("hRatioPrecioPlata").value) || 0
    if (precioOro <= 0 || precioPlata <= 0) return

    const ratio = precioOro / precioPlata
    const mediaHist = _ratioHistorico
    const difVsHist = ((ratio - mediaHist) / mediaHist) * 100
    const precioJusto = precioOro / mediaHist
    const plataNecesaria = ratio

    document.getElementById("hRatioValor").textContent = ratio.toFixed(2) + " oz"

    const vsEl = document.getElementById("hRatioVsHistorico")
    vsEl.textContent = (difVsHist >= 0 ? "+" : "") + difVsHist.toFixed(1) + "% vs media"
    vsEl.className = "hResultValue " + (difVsHist > 0 ? "hResultNegative" : "hResultPositive")

    document.getElementById("hRatioPrecioJusto").textContent = formatEuro(precioJusto) + "/oz"

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
    const precio = parseFloat(document.getElementById("hYieldPrecio").value) || 0
    const divAnual = parseFloat(document.getElementById("hYieldDiv").value) || 0
    const acciones = parseFloat(document.getElementById("hYieldAcciones").value) || 0
    const retencion = (parseFloat(document.getElementById("hYieldRetencion").value) || 0) / 100
    if (precio <= 0) return

    const yieldPct = (divAnual / precio) * 100
    const brutoAnual = divAnual * acciones
    const netoAnual = brutoAnual * (1 - retencion)
    const netoMensual = netoAnual / 12

    document.getElementById("hYieldPct").textContent = yieldPct.toFixed(2) + " %"
    document.getElementById("hYieldBruto").textContent = formatEuro(brutoAnual)
    document.getElementById("hYieldNeto").textContent = formatEuro(netoAnual)
    document.getElementById("hYieldMensual").textContent = formatEuro(netoMensual)
    document.getElementById("hYieldResults").classList.remove("hidden")
}

// ── Oro / Bitcoin ──────────────────────────────────────────────────────────

const BTC_KEYWORDS = ["bitcoin", "btc"]

let _oroBtcRef = Number(getChartPref("hOroBtcRef", 20)) || 20

function hOroBtcAplicarRefLabels() {
    const v = _oroBtcRef
    const label = document.getElementById("hOroBtcHistLabel")
    const labelResult = document.getElementById("hOroBtcHistLabelResult")
    const labelJusto = document.getElementById("hOroBtcHistLabelJusto")
    if (label) label.textContent = v
    if (labelResult) labelResult.textContent = v
    if (labelJusto) labelJusto.textContent = v
}

function hOroBtcAbrirEditor() {
    document.getElementById("hOroBtcHistInput").value = _oroBtcRef
    document.getElementById("hOroBtcEditorOverlay").classList.remove("hidden")
    document.getElementById("hOroBtcHistInput").focus()
}

function hOroBtcCerrarEditor() {
    document.getElementById("hOroBtcEditorOverlay").classList.add("hidden")
}

function hOroBtcGuardarRef() {
    const v = parseFloat(document.getElementById("hOroBtcHistInput").value)
    if (!v || v <= 0) return
    _oroBtcRef = v
    setChartPref("hOroBtcRef", v)
    hOroBtcAplicarRefLabels()
    hOroBtcCerrarEditor()
    hCalcOroBtc()
}

async function hOroBtcLoadPrecios() {
    const btn = document.getElementById("hOroBtcLoadBtn")
    const msgEl = document.getElementById("hOroBtcFuenteMsg")
    btn.textContent = "Cargando..."
    btn.disabled = true
    msgEl.textContent = ""
    msgEl.className = "hRatioFuenteMsg"

    try {
        const [activosRes] = await Promise.all([fetch("/api/activos")])
        if (!activosRes.ok) throw new Error()
        const { assets } = await activosRes.json()

        const oroAsset = assets.find((a) => _ratioMatchesMetal(a, ORO_KEYWORDS))
        const btcAsset = assets.find((a) => _ratioMatchesMetal(a, BTC_KEYWORDS))

        if (!oroAsset && !btcAsset) {
            msgEl.textContent = "No se encontraron activos de oro o Bitcoin en la cartera."
            msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
            btn.textContent = "Cargar precios guardados"
            btn.disabled = false
            return
        }

        const monedaBase = window._monedaBase || "EUR"
        const msgs = []
        let precioOroFinal = 0
        let precioBtcFinal = 0

        // Precio oro → convertir a monedaBase si es necesario
        if (oroAsset) {
            let p = parseEuroNumber(oroAsset.price)
            const oroCurrency = (oroAsset.currency || "EUR").toUpperCase()
            if (p > 0) {
                if (oroCurrency !== monedaBase) {
                    const rateRes = await fetch(`/api/exchange-rate?from=${oroCurrency}&to=${monedaBase}`)
                    const rateData = await rateRes.json()
                    if (rateData.ok) p = p * rateData.rate
                }
                precioOroFinal = p
                document.getElementById("hOroBtcPrecioOro").value = p.toFixed(2)
                msgs.push(`Oro: ${oroAsset.name} → ${p.toFixed(2)} ${monedaBase} (original ${oroCurrency})`)
            }
        }

        // Precio BTC → convertir a monedaBase si es necesario
        if (btcAsset) {
            let p = parseEuroNumber(btcAsset.price)
            const btcCurrency = (btcAsset.currency || "USD").toUpperCase()
            if (p > 0) {
                if (btcCurrency !== monedaBase) {
                    const rateRes = await fetch(`/api/exchange-rate?from=${btcCurrency}&to=${monedaBase}`)
                    const rateData = await rateRes.json()
                    if (rateData.ok) p = p * rateData.rate
                }
                precioBtcFinal = p
                document.getElementById("hOroBtcPrecioBtc").value = p.toFixed(2)
                msgs.push(`Bitcoin: ${btcAsset.name} → ${p.toFixed(2)} ${monedaBase} (original ${btcCurrency})`)
            }
        }

        if (msgs.length === 0) {
            msgEl.textContent = "No se pudieron obtener los precios."
            msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
        } else {
            msgEl.textContent = msgs.join("  ·  ")
            msgEl.className = "hRatioFuenteMsg hRatioFuenteOk"
            if (precioOroFinal > 0 && precioBtcFinal > 0) hCalcOroBtc()
        }
    } catch {
        msgEl.textContent = "Error al cargar los activos."
        msgEl.className = "hRatioFuenteMsg hRatioFuenteWarn"
    }

    btn.textContent = "Cargar precios guardados"
    btn.disabled = false
}

function hCalcOroBtc() {
    const precioOro = parseFloat(document.getElementById("hOroBtcPrecioOro").value) || 0
    const precioBtc = parseFloat(document.getElementById("hOroBtcPrecioBtc").value) || 0
    if (precioOro <= 0 || precioBtc <= 0) return

    const monedaBase = window._monedaBase || "EUR"
    const simbolo = monedaBase === "USD" ? "$" : "€"
    const fmt = (v) => simbolo + v.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })

    const ratio = precioBtc / precioOro
    const ref = _oroBtcRef
    const difVsRef = ((ratio - ref) / ref) * 100
    const precioJusto = precioOro * ref
    const btcPorOz = precioOro / precioBtc

    document.getElementById("hOroBtcValor").textContent = ratio.toFixed(2) + " oz"

    const vsEl = document.getElementById("hOroBtcVsRef")
    vsEl.textContent = (difVsRef >= 0 ? "+" : "") + difVsRef.toFixed(1) + "% vs referencia"
    vsEl.className = "hResultValue " + (difVsRef > 0 ? "hResultNegative" : "hResultPositive")

    document.getElementById("hOroBtcPrecioJusto").textContent = fmt(precioJusto) + "/" + monedaBase

    document.getElementById("hOroBtcEquiv").textContent = btcPorOz.toFixed(6) + " BTC (" + fmt(precioOro) + ")"

    const interp = document.getElementById("hOroBtcInterpretacion")
    if (ratio > ref) {
        interp.textContent = `Bitcoin cotiza por encima de la referencia (${ratio.toFixed(1)} oz vs ${ref} oz de oro). Bitcoin está relativamente caro frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoNeg"
    } else {
        interp.textContent = `Bitcoin cotiza por debajo de la referencia (${ratio.toFixed(1)} oz vs ${ref} oz de oro). Bitcoin está relativamente barato frente al oro.`
        interp.className = "hRatioInterpretacion hRatioInfoPos"
    }

    document.getElementById("hOroBtcResults").classList.remove("hidden")
}
