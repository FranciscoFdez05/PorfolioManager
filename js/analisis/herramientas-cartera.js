// Análisis > Herramientas: tamaño de posición por riesgo, recuperación tras una
// pérdida y aportación periódica (DCA) frente a aportación única.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.
//
// Las tres se calculan en el navegador. El DCA pide las velas diarias del
// ticker a /api/market/historico, el mismo endpoint que usan los estacionales
// de la ficha del activo, y trabaja en la divisa en que cotiza.

// Caídas de referencia de la tabla de recuperación.
const H_REC_CAIDAS = [10, 20, 30, 40, 50, 60, 70, 80, 90]

let _hDcaSerie = null
let _hDcaDivisa = null
let _hDcaGrafico = null

function hCarLeer(id) {
    const texto = document.getElementById(id)?.value ?? ""
    return texto.trim() === "" ? NaN : parseFloat(texto)
}

function hCarMensaje(id, texto, aviso = false) {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = texto
    el.className = "hPrecargaMsg" + (aviso ? " hRatioFuenteWarn" : "")
}

function hCarPct(fraccion, decimales = 2) {
    return (
        (fraccion * 100).toLocaleString("es-ES", {
            minimumFractionDigits: decimales,
            maximumFractionDigits: decimales
        }) + " %"
    )
}

function hCarNumero(valor, decimales = 4) {
    return valor.toLocaleString("es-ES", { maximumFractionDigits: decimales })
}

// ── Tamaño de posición por riesgo ──────────────────────────────────────────

/**
 * Unidades a comprar para que, si salta el stop, se pierda solo lo decidido.
 *
 * Riesgo en euros = capital × riesgo %. Cada unidad pierde |entrada − stop|
 * si salta el stop; la comisión de ida y vuelta se descuenta del riesgo
 * antes de repartirlo. Un stop por encima de la entrada es una posición corta.
 *
 * @param {{capital: number, riesgoPct: number, entrada: number, stop: number,
 *     objetivo?: number, comision?: number}} datos
 * @returns {{riesgo: number, unidades: number, unidadesEnteras: number,
 *     importe: number, peso: number, corto: boolean, ratio: number|null,
 *     perdidaPorUnidad: number} | null}
 */
function hTpCalcular({ capital, riesgoPct, entrada, stop, objetivo = NaN, comision = 0 }) {
    if (!(capital > 0) || !(riesgoPct > 0) || riesgoPct > 100 || !(entrada > 0) || !(stop > 0)) return null
    if (stop === entrada || !(comision >= 0)) return null

    const riesgo = (capital * riesgoPct) / 100
    const disponible = riesgo - comision
    if (disponible <= 0) return null

    const perdidaPorUnidad = Math.abs(entrada - stop)
    const unidades = disponible / perdidaPorUnidad
    const corto = stop > entrada
    // El objetivo solo cuenta si está del lado de la ganancia.
    const objetivoValido = Number.isFinite(objetivo) && (corto ? objetivo < entrada : objetivo > entrada)
    return {
        riesgo,
        unidades,
        unidadesEnteras: Math.floor(unidades),
        importe: unidades * entrada,
        peso: (unidades * entrada) / capital,
        corto,
        ratio: objetivoValido ? Math.abs(objetivo - entrada) / perdidaPorUnidad : null,
        perdidaPorUnidad
    }
}

async function hTpCargarCapital() {
    hCarMensaje("hTpMsg", "Cargando…")
    try {
        const respuesta = await fetch("/api/patrimonio")
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`)
        const datos = await respuesta.json()
        const inversiones = (datos.activos?.grupos || []).find((g) => g.grupo === "inversiones")
        const total = Number(inversiones?.total)
        if (!(total > 0)) {
            hCarMensaje("hTpMsg", "No hay inversiones valoradas en la cartera.", true)
            return
        }
        document.getElementById("hTpCapital").value = Math.round(total)
        hCarMensaje("hTpMsg", `Valor de tus inversiones: ${formatEuro(total)}.`)
    } catch (error) {
        console.error(error)
        hCarMensaje("hTpMsg", "No se pudo cargar el valor de la cartera.", true)
    }
}

function hTpCalcularPanel() {
    const r = hTpCalcular({
        capital: hCarLeer("hTpCapital"),
        riesgoPct: hCarLeer("hTpRiesgo"),
        entrada: hCarLeer("hTpEntrada"),
        stop: hCarLeer("hTpStop"),
        objetivo: hCarLeer("hTpObjetivo"),
        comision: hCarLeer("hTpComision") || 0
    })
    if (!r) {
        hCarMensaje(
            "hTpMsg",
            "Revisa los datos: entrada y stop distintos y mayores que cero, y un riesgo que cubra la comisión.",
            true
        )
        return
    }
    hCarMensaje("hTpMsg", "")

    document.getElementById("hTpUnidades").textContent = hCarNumero(r.unidadesEnteras, 0)
    document.getElementById("hTpUnidadesExactas").textContent = hCarNumero(r.unidades)
    document.getElementById("hTpRiesgoEur").textContent = formatEuro(r.riesgo)
    document.getElementById("hTpImporte").textContent = formatEuro(r.importe)
    document.getElementById("hTpPeso").textContent = hCarPct(r.peso, 1)
    document.getElementById("hTpRatio").textContent =
        r.ratio === null ? "---" : `${r.ratio.toLocaleString("es-ES", { maximumFractionDigits: 2 })} : 1`

    const nota = document.getElementById("hTpNota")
    const textos = []
    if (r.corto) textos.push("El stop está por encima de la entrada: es una posición corta.")
    if (r.peso > 1) {
        textos.push(
            `La posición (${formatEuro(r.importe)}) supera tu capital: con ese stop tan cercano necesitarías apalancamiento. Aleja el stop o baja el riesgo.`
        )
    }
    if (r.ratio !== null && r.ratio < 1)
        textos.push("El objetivo está más cerca que el stop: arriesgas más de lo que buscas ganar.")
    nota.textContent = textos.join(" ")
    nota.className = "hRatioInterpretacion hRatioInfoNeg" + (textos.length ? "" : " hidden")

    document.getElementById("hTpResults").classList.remove("hidden")
}

// ── Recuperación tras una pérdida ──────────────────────────────────────────

/**
 * Subida necesaria para recuperar una caída, y años que lleva a una rentabilidad.
 *
 * Tras caer un d %, hay que subir 1/(1−d) − 1: un −50 % pide un +100 %. La
 * comisión (de venta, o de ida y vuelta si se cambia de producto) se aplica
 * sobre el valor recuperado, así que también hay que ganarla.
 *
 * @param {{caida: number, comision?: number, rentabilidad?: number}} datos En %.
 * @returns {{subida: number, anos: number|null} | null} `anos` null sin
 *     rentabilidad positiva.
 */
function hRecCalcular({ caida, comision = 0, rentabilidad = NaN }) {
    if (!(caida >= 0) || caida >= 100 || !(comision >= 0) || comision >= 100) return null
    const factor = 1 / ((1 - caida / 100) * (1 - comision / 100))
    const anos = rentabilidad > 0 ? Math.log(factor) / Math.log(1 + rentabilidad / 100) : null
    return { subida: factor - 1, anos }
}

function hRecCalcularPanel() {
    const comision = hCarLeer("hRecComision") || 0
    const rentabilidad = hCarLeer("hRecRent")
    const r = hRecCalcular({ caida: hCarLeer("hRecCaida"), comision, rentabilidad })
    if (!r) {
        hCarMensaje("hRecMsg", "La caída y la comisión deben estar entre 0 y 100 %.", true)
        return
    }
    hCarMensaje("hRecMsg", "")

    document.getElementById("hRecSubida").textContent = hCarPct(r.subida)
    document.getElementById("hRecAnos").textContent =
        r.anos === null ? "---" : `${r.anos.toLocaleString("es-ES", { maximumFractionDigits: 1 })} años`

    const cuerpo = document.getElementById("hRecTabla")
    cuerpo.innerHTML = ""
    H_REC_CAIDAS.forEach((caida) => {
        const fila = hRecCalcular({ caida, comision, rentabilidad })
        const tr = document.createElement("tr")
        ;[
            `−${caida} %`,
            hCarPct(fila.subida, 1),
            fila.anos === null ? "---" : fila.anos.toLocaleString("es-ES", { maximumFractionDigits: 1 })
        ].forEach((texto) => {
            const td = document.createElement("td")
            td.textContent = texto
            tr.appendChild(td)
        })
        cuerpo.appendChild(tr)
    })

    document.getElementById("hRecResults").classList.remove("hidden")
}

// ── DCA frente a aportación única ──────────────────────────────────────────

/**
 * Pasa velas diarias a un precio por mes: el primer cierre de cada mes.
 *
 * @param {Array<[number, number]>} velas `[ts en segundos o milisegundos, cierre]`.
 * @returns {{mes: string, ts: number, precio: number}[]} En orden cronológico.
 */
function hDcaMensual(velas) {
    const porMes = new Map()
    ;[...(velas || [])]
        .filter(([ts, cierre]) => Number.isFinite(ts) && cierre > 0)
        .sort((a, b) => a[0] - b[0])
        .forEach(([ts, cierre]) => {
            // TradingView da segundos; un timestamp en milisegundos ya es enorme.
            const ms = ts < 1e12 ? ts * 1000 : ts
            const fecha = new Date(ms)
            const mes = `${fecha.getUTCFullYear()}-${String(fecha.getUTCMonth() + 1).padStart(2, "0")}`
            if (!porMes.has(mes)) porMes.set(mes, { mes, ts: ms, precio: cierre })
        })
    return [...porMes.values()]
}

/**
 * Valor de las dos estrategias mes a mes desde un inicio dado.
 *
 * Aportación única: todo el importe en el mes de inicio. DCA: el importe en
 * partes iguales durante `meses` meses seguidos, empezando el mismo mes.
 *
 * @param {{mes: string, precio: number}[]} serie Precios mensuales.
 * @param {{importe: number, meses: number, inicio: number}} datos `inicio` es
 *     el índice del mes de arranque.
 * @returns {{mes: string, unico: number, dca: number, aportado: number}[] | null}
 *     Desde el inicio hasta el último mes; null si no caben las aportaciones.
 */
function hDcaSimular(serie, { importe, meses, inicio }) {
    if (!(importe > 0) || !Number.isInteger(meses) || meses < 1) return null
    if (!Number.isInteger(inicio) || inicio < 0 || inicio + meses > serie.length) return null

    const unidadesUnico = importe / serie[inicio].precio
    const cuota = importe / meses
    let unidadesDca = 0
    const resultado = []
    for (let i = inicio; i < serie.length; i++) {
        const paso = i - inicio
        if (paso < meses) unidadesDca += cuota / serie[i].precio
        resultado.push({
            mes: serie[i].mes,
            unico: unidadesUnico * serie[i].precio,
            dca: unidadesDca * serie[i].precio,
            aportado: cuota * Math.min(paso + 1, meses)
        })
    }
    return resultado
}

/**
 * Todas las ventanas posibles: en cuántas gana la aportación única.
 *
 * Cada ventana empieza en un mes y se valora al terminar las aportaciones del
 * DCA, que es cuando las dos estrategias tienen el mismo dinero dentro.
 *
 * @param {{mes: string, precio: number}[]} serie
 * @param {number} meses Meses de aportación.
 * @returns {{ventanas: number, ganaUnico: number, diferenciaMedia: number} | null}
 *     `diferenciaMedia` es (único − DCA) / importe, en tanto por uno.
 */
function hDcaVentanas(serie, meses) {
    if (!Number.isInteger(meses) || meses < 2 || serie.length < meses) return null
    let ventanas = 0
    let ganaUnico = 0
    let suma = 0
    for (let inicio = 0; inicio + meses <= serie.length; inicio++) {
        const fin = inicio + meses - 1
        let unidadesDca = 0
        for (let i = inicio; i <= fin; i++) unidadesDca += 1 / meses / serie[i].precio
        const unico = serie[fin].precio / serie[inicio].precio
        const dca = unidadesDca * serie[fin].precio
        ventanas++
        if (unico > dca) ganaUnico++
        suma += unico - dca
    }
    return { ventanas, ganaUnico, diferenciaMedia: suma / ventanas }
}

function hDcaPrepararSelector() {
    const select = document.getElementById("hDcaActivo")
    if (!select || select._hDcaEnganchado) return
    select._hDcaEnganchado = true
    select.addEventListener("change", async () => {
        const activo = (await hActivos()).find((a) => a.id === select.value)
        if (!activo) return
        let ticker = ""
        try {
            ticker = typeof buildTVSymbol === "function" ? buildTVSymbol(activo) : activo.tvSymbol || ""
        } catch (error) {
            console.error(error)
        }
        document.getElementById("hDcaTicker").value = String(ticker || "").trim()
    })
}

async function hDcaCargarActivos() {
    const select = document.getElementById("hDcaActivo")
    if (!select) return
    let activos
    try {
        activos = await hActivos()
    } catch (error) {
        console.error(error)
        return
    }
    while (select.options.length > 1) select.remove(1)
    activos
        .filter((a) => !a.hidden)
        .sort((a, b) => (a.name || "").localeCompare(b.name || "", "es"))
        .forEach((activo) => {
            const opcion = document.createElement("option")
            opcion.value = activo.id
            opcion.textContent = `${activo.name}${activo.symbol ? " · " + activo.symbol : ""}`
            select.appendChild(opcion)
        })
}

async function hDcaCargarHistorico() {
    const ticker = document.getElementById("hDcaTicker")?.value.trim() || ""
    if (!ticker) {
        hCarMensaje("hDcaMsg", "Elige un activo o escribe un ticker de TradingView (p. ej. NASDAQ:AAPL).", true)
        return
    }
    const boton = document.getElementById("hDcaCargarBtn")
    if (boton) boton.disabled = true
    hCarMensaje("hDcaMsg", "Cargando histórico…")
    try {
        const respuesta = await fetch(`/api/market/historico?${new URLSearchParams({ symbol: ticker })}`)
        const cuerpo = await respuesta.json().catch(() => null)
        if (!respuesta.ok || !cuerpo?.ok) throw new Error(cuerpo?.error || `HTTP ${respuesta.status}`)
        const serie = hDcaMensual(cuerpo.data)
        if (serie.length < 3) {
            hCarMensaje("hDcaMsg", "Ese ticker no tiene histórico suficiente.", true)
            return
        }
        _hDcaSerie = serie
        _hDcaDivisa = cuerpo.divisa || null
        const unidad = document.getElementById("hDcaMoneda")
        if (unidad) unidad.textContent = !_hDcaDivisa || _hDcaDivisa === "EUR" ? "€" : _hDcaDivisa
        hDcaRellenarInicios(serie)
        hCarMensaje(
            "hDcaMsg",
            `${serie.length} meses de histórico (${serie[0].mes} a ${serie.at(-1).mes})` +
                (_hDcaDivisa ? `, en ${_hDcaDivisa}.` : ".")
        )
    } catch (error) {
        console.error(error)
        hCarMensaje("hDcaMsg", "No se pudo cargar el histórico de ese ticker.", true)
    } finally {
        if (boton) boton.disabled = false
    }
}

function hDcaRellenarInicios(serie) {
    const select = document.getElementById("hDcaInicio")
    if (!select) return
    select.innerHTML = ""
    serie.forEach((punto, indice) => {
        const opcion = document.createElement("option")
        opcion.value = String(indice)
        opcion.textContent = punto.mes
        select.appendChild(opcion)
    })
    // Por defecto, hace cinco años (o el primer mes si hay menos).
    select.value = String(Math.max(0, serie.length - 1 - 60))
    select.dispatchEvent(new Event("change"))
}

function hDcaImporte(valor) {
    const texto = formatEuro(valor)
    return _hDcaDivisa && _hDcaDivisa !== "EUR" ? texto.replace("€", _hDcaDivisa) : texto
}

function hDcaCalcularPanel() {
    if (!_hDcaSerie) {
        hCarMensaje("hDcaMsg", "Carga antes el histórico del activo.", true)
        return
    }
    const meses = hCarLeer("hDcaMeses")
    const simulacion = hDcaSimular(_hDcaSerie, {
        importe: hCarLeer("hDcaImporte"),
        meses,
        inicio: parseInt(document.getElementById("hDcaInicio")?.value ?? "", 10)
    })
    if (!simulacion) {
        hCarMensaje(
            "hDcaMsg",
            "Con ese inicio no caben todas las aportaciones: elige un mes anterior o menos meses.",
            true
        )
        return
    }
    hCarMensaje("hDcaMsg", "")

    const final = simulacion.at(-1)
    const unico = document.getElementById("hDcaUnico")
    const dca = document.getElementById("hDcaDca")
    unico.textContent = hDcaImporte(final.unico)
    dca.textContent = hDcaImporte(final.dca)
    unico.className = "hResultValue" + (final.unico >= final.dca ? " hResultPositive" : "")
    dca.className = "hResultValue" + (final.dca > final.unico ? " hResultPositive" : "")
    document.getElementById("hDcaAportado").textContent = hDcaImporte(final.aportado)

    const ventanas = hDcaVentanas(_hDcaSerie, meses)
    const nota = document.getElementById("hDcaNota")
    if (ventanas) {
        document.getElementById("hDcaHistorico").textContent = hCarPct(ventanas.ganaUnico / ventanas.ventanas, 0)
        nota.textContent =
            `En ${ventanas.ganaUnico} de ${ventanas.ventanas} ventanas de ${meses} meses de la historia de este activo, ` +
            `invertir todo de golpe acabó mejor que repartirlo, con una diferencia media del ${hCarPct(ventanas.diferenciaMedia, 1)} ` +
            "del importe al terminar las aportaciones. Repartir reduce el riesgo de entrar justo antes de una caída."
        nota.className = "hRatioInterpretacion"
    } else {
        document.getElementById("hDcaHistorico").textContent = "---"
        nota.textContent = ""
        nota.className = "hRatioInterpretacion hidden"
    }

    document.getElementById("hDcaResults").classList.remove("hidden")
    hDcaPintarGrafico(simulacion)
}

function hDcaPintarGrafico(simulacion) {
    if (_hDcaGrafico) {
        _hDcaGrafico.destroy()
        _hDcaGrafico = null
    }
    const lienzo = document.getElementById("hDcaChart")
    if (!lienzo || typeof Chart === "undefined") return
    const tema = hChartTheme()
    const serie = (etiqueta, clave, color, extra = {}) => ({
        label: etiqueta,
        data: simulacion.map((p) => p[clave]),
        borderColor: color,
        backgroundColor: color + "20",
        tension: 0.2,
        pointRadius: 0,
        borderWidth: 2,
        ...extra
    })
    _hDcaGrafico = new Chart(lienzo, {
        type: "line",
        data: {
            labels: simulacion.map((p) => p.mes),
            datasets: [
                serie("Aportación única", "unico", "#3498db"),
                serie("DCA", "dca", "#2ecc71"),
                serie("Aportado (DCA)", "aportado", "#95a5a6", { borderDash: [6, 4], borderWidth: 1 })
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { labels: { color: tema.text, font: { size: 12 }, padding: 12 } },
                tooltip: { callbacks: { label: (c) => `  ${c.dataset.label}: ${hDcaImporte(c.raw)}` } }
            },
            scales: {
                x: { ticks: { color: tema.muted, font: { size: 11 }, maxTicksLimit: 12 }, grid: { color: tema.grid } },
                y: {
                    ticks: { color: tema.muted, font: { size: 11 }, callback: (v) => hDcaImporte(v) },
                    grid: { color: tema.grid }
                }
            }
        }
    })
}

// ── Arranque y reinicio ────────────────────────────────────────────────────

function hCarIniciar() {
    document.getElementById("hTpCargarBtn")?.addEventListener("click", hTpCargarCapital)
    document.getElementById("hTpCalcBtn")?.addEventListener("click", hTpCalcularPanel)
    document.getElementById("hRecCalcBtn")?.addEventListener("click", hRecCalcularPanel)
    document.getElementById("hDcaCargarBtn")?.addEventListener("click", hDcaCargarHistorico)
    document.getElementById("hDcaCalcBtn")?.addEventListener("click", hDcaCalcularPanel)
    hDcaPrepararSelector()
    // En segundo plano, como los otros selectores de activos de la página.
    hDcaCargarActivos()
}

function hCarReiniciar(panelId) {
    if (panelId === "toolTamanoPosicion") hCarMensaje("hTpMsg", "")
    if (panelId === "toolRecuperacion") hCarMensaje("hRecMsg", "")
    if (panelId === "toolDcaVsUnico") {
        hCarMensaje("hDcaMsg", "")
        if (_hDcaGrafico) {
            _hDcaGrafico.destroy()
            _hDcaGrafico = null
        }
    }
}
