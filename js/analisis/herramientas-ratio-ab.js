// Análisis > Herramientas: ratio entre dos activos cualesquiera.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.
//
// Generaliza Oro/Plata y Oro/Bitcoin: en vez de una herramienta por pareja, se
// elige cualquier par de tickers (de la cartera o escritos a mano) y se compara
// el ratio de hoy con su propia historia. Las velas salen de
// /api/market/historico; no se fija ninguna pareja en el código.

// Periodos que se pueden mirar, en años. 0 = todo el histórico común.
const H_AB_PERIODOS = [1, 3, 5, 10, 0]

let _hAbPuntos = null
let _hAbGrafico = null

function hAbMensaje(texto, aviso = false) {
    const el = document.getElementById("hAbMsg")
    if (!el) return
    el.textContent = texto
    el.className = "hPrecargaMsg" + (aviso ? " hRatioFuenteWarn" : "")
}

function hAbNumero(valor) {
    const decimales = Math.abs(valor) >= 100 ? 2 : Math.abs(valor) >= 1 ? 4 : 6
    return valor.toLocaleString("es-ES", { maximumFractionDigits: decimales })
}

/**
 * Une dos series diarias por día (UTC) y calcula el ratio A/B de cada uno.
 *
 * Solo entran los días con cierre en las dos: un activo que cotiza los fines
 * de semana (cripto) y otro que no (acciones) se comparan en días hábiles.
 *
 * @param {Array<[number, number]>} velasA `[ts, cierre]`, ts en segundos o ms.
 * @param {Array<[number, number]>} velasB
 * @returns {{dia: string, ts: number, a: number, b: number, ratio: number}[]}
 */
function hAbAlinear(velasA, velasB) {
    const porDia = (velas) => {
        const mapa = new Map()
        ;(velas || []).forEach(([ts, cierre]) => {
            if (!Number.isFinite(ts) || !(cierre > 0)) return
            const ms = ts < 1e12 ? ts * 1000 : ts
            mapa.set(new Date(ms).toISOString().slice(0, 10), { ms, cierre })
        })
        return mapa
    }
    const a = porDia(velasA)
    const b = porDia(velasB)
    const puntos = []
    a.forEach((valorA, dia) => {
        const valorB = b.get(dia)
        if (!valorB) return
        puntos.push({ dia, ts: valorA.ms, a: valorA.cierre, b: valorB.cierre, ratio: valorA.cierre / valorB.cierre })
    })
    return puntos.sort((x, y) => x.ts - y.ts)
}

/**
 * Puntos de los últimos `anos` años contados desde el último dato.
 *
 * @param {{ts: number}[]} puntos En orden cronológico.
 * @param {number} anos 0 para todos.
 * @returns {object[]}
 */
function hAbRecortar(puntos, anos) {
    if (!anos || !puntos.length) return puntos
    const limite = new Date(puntos.at(-1).ts)
    limite.setUTCFullYear(limite.getUTCFullYear() - anos)
    return puntos.filter((p) => p.ts >= limite.getTime())
}

/**
 * Dónde está el ratio de hoy respecto a su historia.
 *
 * @param {{ratio: number}[]} puntos Al menos dos, en orden cronológico.
 * @returns {{actual: number, media: number, mediana: number, minimo: number,
 *     maximo: number, p10: number, p90: number, percentil: number,
 *     desviacion: number, z: number|null} | null}
 */
function hAbEstadisticas(puntos) {
    if (!puntos || puntos.length < 2) return null
    const ratios = puntos.map((p) => p.ratio)
    const ordenados = [...ratios].sort((x, y) => x - y)
    const n = ordenados.length
    const percentil = (p) => {
        const pos = (n - 1) * p
        const abajo = Math.floor(pos)
        return ordenados[abajo] + (ordenados[Math.ceil(pos)] - ordenados[abajo]) * (pos - abajo)
    }
    const media = ratios.reduce((s, r) => s + r, 0) / n
    const desviacion = Math.sqrt(ratios.reduce((s, r) => s + (r - media) ** 2, 0) / (n - 1))
    const actual = ratios.at(-1)
    return {
        actual,
        media,
        mediana: percentil(0.5),
        minimo: ordenados[0],
        maximo: ordenados[n - 1],
        p10: percentil(0.1),
        p90: percentil(0.9),
        // Qué parte de la historia estuvo por debajo del ratio de hoy.
        percentil: ordenados.filter((r) => r < actual).length / n,
        desviacion,
        z: desviacion > 0 ? (actual - media) / desviacion : null
    }
}

async function hAbVelas(ticker) {
    const respuesta = await fetch(`/api/market/historico?${new URLSearchParams({ symbol: ticker })}`)
    const cuerpo = await respuesta.json().catch(() => null)
    if (!respuesta.ok || !cuerpo?.ok) throw new Error(cuerpo?.error || `HTTP ${respuesta.status}`)
    return { velas: cuerpo.data || [], divisa: cuerpo.divisa || null }
}

async function hAbCargarActivos() {
    let activos
    try {
        activos = await hActivos()
    } catch (error) {
        console.error(error)
        return
    }
    const visibles = activos.filter((a) => !a.hidden).sort((a, b) => (a.name || "").localeCompare(b.name || "", "es"))
    ;["hAbActivoA", "hAbActivoB"].forEach((id) => {
        const select = document.getElementById(id)
        if (!select) return
        while (select.options.length > 1) select.remove(1)
        visibles.forEach((activo) => {
            const opcion = document.createElement("option")
            opcion.value = activo.id
            opcion.textContent = `${activo.name}${activo.symbol ? " · " + activo.symbol : ""}`
            select.appendChild(opcion)
        })
        if (!select._hAbEnganchado) {
            select._hAbEnganchado = true
            select.addEventListener("change", () => hAbTickerDeActivo(select))
        }
    })
}

async function hAbTickerDeActivo(select) {
    const destino = document.getElementById(select.id === "hAbActivoA" ? "hAbTickerA" : "hAbTickerB")
    const activo = (await hActivos()).find((a) => a.id === select.value)
    if (!activo || !destino) return
    try {
        destino.value = String(
            (typeof buildTVSymbol === "function" ? buildTVSymbol(activo) : activo.tvSymbol) || ""
        ).trim()
    } catch (error) {
        console.error(error)
    }
}

async function hAbCalcular() {
    const tickerA = document.getElementById("hAbTickerA")?.value.trim().toUpperCase() || ""
    const tickerB = document.getElementById("hAbTickerB")?.value.trim().toUpperCase() || ""
    if (!tickerA || !tickerB) {
        hAbMensaje("Indica los dos tickers (elígelos de tu cartera o escríbelos).", true)
        return
    }
    if (tickerA === tickerB) {
        hAbMensaje("Los dos tickers son el mismo: el ratio sería siempre 1.", true)
        return
    }

    const boton = document.getElementById("hAbCalcBtn")
    if (boton) boton.disabled = true
    hAbMensaje("Cargando históricos…")
    try {
        const [a, b] = await Promise.all([hAbVelas(tickerA), hAbVelas(tickerB)])
        const puntos = hAbAlinear(a.velas, b.velas)
        if (puntos.length < 30) {
            hAbMensaje("No hay suficientes días con cotización de los dos para comparar.", true)
            return
        }
        _hAbPuntos = { puntos, tickerA, tickerB }
        // Un ratio entre precios en divisas distintas mezcla el tipo de cambio:
        // se avisa en vez de convertir con un cambio que no es el de cada día.
        const divisas =
            a.divisa && b.divisa && a.divisa !== b.divisa
                ? ` Cotizan en ${a.divisa} y ${b.divisa}: el ratio incluye el tipo de cambio.`
                : ""
        hAbMensaje(`${puntos.length} días en común, desde ${puntos[0].dia}.${divisas}`, Boolean(divisas))
        hAbPintar()
    } catch (error) {
        console.error(error)
        hAbMensaje("No se pudo cargar alguno de los dos históricos. Revisa los tickers.", true)
    } finally {
        if (boton) boton.disabled = false
    }
}

function hAbPintar() {
    if (!_hAbPuntos) return
    const anos = parseInt(document.getElementById("hAbPeriodo")?.value ?? "0", 10) || 0
    const puntos = hAbRecortar(_hAbPuntos.puntos, anos)
    const e = hAbEstadisticas(puntos)
    if (!e) {
        hAbMensaje("En ese periodo no hay datos suficientes.", true)
        return
    }

    const { tickerA, tickerB } = _hAbPuntos
    document.getElementById("hAbTitulo").textContent = `${tickerA} / ${tickerB}`
    document.getElementById("hAbActual").textContent = hAbNumero(e.actual)
    document.getElementById("hAbMedia").textContent = hAbNumero(e.media)
    document.getElementById("hAbRango").textContent = `${hAbNumero(e.minimo)} – ${hAbNumero(e.maximo)}`
    document.getElementById("hAbPercentil").textContent = `${Math.round(e.percentil * 100)} %`
    document.getElementById("hAbZ").textContent =
        e.z === null ? "---" : e.z.toLocaleString("es-ES", { maximumFractionDigits: 2, signDisplay: "always" })

    const nota = document.getElementById("hAbNota")
    const desvio = (e.actual / e.media - 1) * 100
    const texto = desvio.toLocaleString("es-ES", { maximumFractionDigits: 1, signDisplay: "always" })
    if (e.actual >= e.p90) {
        nota.textContent = `El ratio está en la parte alta de su historia (${texto} % respecto a la media): ${tickerA} está caro frente a ${tickerB}.`
        nota.className = "hRatioInterpretacion hRatioInfoNeg"
    } else if (e.actual <= e.p10) {
        nota.textContent = `El ratio está en la parte baja de su historia (${texto} % respecto a la media): ${tickerA} está barato frente a ${tickerB}.`
        nota.className = "hRatioInterpretacion hRatioInfoPos"
    } else {
        nota.textContent = `El ratio está dentro de su rango habitual (${texto} % respecto a la media).`
        nota.className = "hRatioInterpretacion"
    }

    document.getElementById("hAbResults").classList.remove("hidden")
    hAbGrafico(puntos, e)
}

function hAbGrafico(puntos, e) {
    if (_hAbGrafico) {
        _hAbGrafico.destroy()
        _hAbGrafico = null
    }
    const lienzo = document.getElementById("hAbChart")
    if (!lienzo || typeof Chart === "undefined") return
    const tema = hChartTheme()
    const linea = (etiqueta, valor, color) => ({
        label: etiqueta,
        data: puntos.map(() => valor),
        borderColor: color,
        borderDash: [6, 4],
        borderWidth: 1,
        pointRadius: 0,
        fill: false
    })
    _hAbGrafico = new Chart(lienzo, {
        type: "line",
        data: {
            labels: puntos.map((p) => p.dia),
            datasets: [
                {
                    label: "Ratio",
                    data: puntos.map((p) => p.ratio),
                    borderColor: "#3498db",
                    backgroundColor: "#3498db20",
                    borderWidth: 1.5,
                    pointRadius: 0,
                    tension: 0.1,
                    fill: false
                },
                linea("Media", e.media, "#e67e22"),
                linea("Percentil 90", e.p90, "#e74c3c"),
                linea("Percentil 10", e.p10, "#2ecc71")
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { labels: { color: tema.text, font: { size: 12 }, padding: 12 } },
                tooltip: { callbacks: { label: (c) => `  ${c.dataset.label}: ${hAbNumero(c.raw)}` } }
            },
            scales: {
                x: { ticks: { color: tema.muted, font: { size: 11 }, maxTicksLimit: 10 }, grid: { color: tema.grid } },
                y: { ticks: { color: tema.muted, font: { size: 11 } }, grid: { color: tema.grid } }
            }
        }
    })
}

function hAbIniciar() {
    const periodo = document.getElementById("hAbPeriodo")
    if (periodo && !periodo.options.length) {
        H_AB_PERIODOS.forEach((anos) => {
            const opcion = document.createElement("option")
            opcion.value = String(anos)
            opcion.textContent = anos ? `${anos} ${anos === 1 ? "año" : "años"}` : "Todo"
            periodo.appendChild(opcion)
        })
        periodo.value = "0"
    }
    periodo?.addEventListener("change", hAbPintar)
    document.getElementById("hAbCalcBtn")?.addEventListener("click", hAbCalcular)
    hAbCargarActivos()
}

function hAbReiniciar(panelId) {
    if (panelId !== "toolRatioAB") return
    _hAbPuntos = null
    hAbMensaje("")
    if (_hAbGrafico) {
        _hAbGrafico.destroy()
        _hAbGrafico = null
    }
}
