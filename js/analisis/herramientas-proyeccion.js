// Análisis > Herramientas: independencia financiera (FIRE), desacumulación,
// Monte Carlo y rentabilidad real.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.
//
// Todo se calcula en el navegador. Lo único que se pide al servidor son datos
// de partida opcionales: el patrimonio neto (/api/patrimonio) y la rentabilidad
// y volatilidad históricas de la cartera (/api/portfolio/rentabilidad). La
// inflación nunca se rellena sola: es una hipótesis del usuario, no un dato.

// Tope de las simulaciones año a año: más allá de un siglo el resultado ya no
// dice nada y un bucle sin fin colgaría la pestaña.
const H_PROY_MAX_ANOS = 100
// Monte Carlo: por encima de esto la pestaña se nota y los percentiles no
// cambian en lo que se ve.
const H_MC_MAX_SIMULACIONES = 10000

// Un gráfico por lienzo: al recalcular se destruye el anterior del mismo panel.
const _hProyGraficos = {}

// ── Utilidades ─────────────────────────────────────────────────────────────

/**
 * Lee un campo numérico; vacío o ilegible da NaN para poder distinguirlo de 0.
 *
 * @param {string} id Id del <input>.
 * @returns {number}
 */
function hProyLeer(id) {
    const texto = document.getElementById(id)?.value ?? ""
    return texto.trim() === "" ? NaN : parseFloat(texto)
}

/**
 * Porcentaje con coma decimal.
 *
 * @param {number} fraccion Tanto por uno.
 * @param {number} [decimales]
 * @returns {string}
 */
function hProyPct(fraccion, decimales = 2) {
    return (
        (fraccion * 100).toLocaleString("es-ES", {
            minimumFractionDigits: decimales,
            maximumFractionDigits: decimales
        }) + " %"
    )
}

/**
 * Texto de una duración en meses: "12 años y 3 meses".
 *
 * @param {number} meses
 * @returns {string}
 */
function hProyDuracion(meses) {
    const anos = Math.floor(meses / 12)
    const resto = meses % 12
    const partes = []
    if (anos) partes.push(`${anos} ${anos === 1 ? "año" : "años"}`)
    if (resto || !anos) partes.push(`${resto} ${resto === 1 ? "mes" : "meses"}`)
    return partes.join(" y ")
}

function hProyMensaje(id, texto, aviso = false) {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = texto
    el.className = "hPrecargaMsg" + (aviso ? " hRatioFuenteWarn" : "")
}

/**
 * Pinta (o repinta) un gráfico de líneas con los colores del tema.
 *
 * @param {string} canvasId Lienzo.
 * @param {string[]} etiquetas Eje X.
 * @param {object[]} series Datasets de Chart.js.
 */
function hProyGrafico(canvasId, etiquetas, series) {
    hProyBorrarGrafico(canvasId)
    const lienzo = document.getElementById(canvasId)
    if (!lienzo || typeof Chart === "undefined") return
    const tema = hChartTheme()
    _hProyGraficos[canvasId] = new Chart(lienzo, {
        type: "line",
        data: { labels: etiquetas, datasets: series },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { labels: { color: tema.text, font: { size: 12 }, padding: 12 } },
                tooltip: { callbacks: { label: (c) => `  ${c.dataset.label}: ${formatEuro(c.raw)}` } }
            },
            scales: {
                x: { ticks: { color: tema.muted, font: { size: 11 } }, grid: { color: tema.grid } },
                y: {
                    ticks: { color: tema.muted, font: { size: 11 }, callback: (v) => formatEuro(v) },
                    grid: { color: tema.grid }
                }
            }
        }
    })
}

function hProyBorrarGrafico(canvasId) {
    if (_hProyGraficos[canvasId]) {
        _hProyGraficos[canvasId].destroy()
        delete _hProyGraficos[canvasId]
    }
}

function hProySerie(etiqueta, datos, color, extra = {}) {
    return {
        label: etiqueta,
        data: datos,
        borderColor: color,
        backgroundColor: color + "20",
        fill: false,
        tension: 0.25,
        pointRadius: 0,
        borderWidth: 2,
        ...extra
    }
}

// ── Independencia financiera (FIRE) ────────────────────────────────────────

/**
 * Cuánto hace falta para vivir de la cartera y cuánto se tarda en llegar.
 *
 * El objetivo es gastos / tasa de retirada (la "regla del 4 %" con la tasa que
 * elija el usuario). La rentabilidad debe ser real, ya descontada la
 * inflación: así el objetivo, en euros de hoy, no hay que actualizarlo.
 *
 * @param {{gastosAnuales: number, tasaRetirada: number, patrimonio: number,
 *     aportacionMensual: number, rentabilidad: number}} datos Tasas en %.
 * @returns {{objetivo: number, falta: number, progreso: number,
 *     meses: number|null, serie: {anio: number, valor: number}[]} | null}
 *     `meses` es null si no se llega en el horizonte máximo; null entero si
 *     algún dato no es válido.
 */
function hFireCalcular({ gastosAnuales, tasaRetirada, patrimonio, aportacionMensual, rentabilidad }) {
    if (!(gastosAnuales > 0) || !(tasaRetirada > 0) || tasaRetirada > 100) return null
    if (!(patrimonio >= 0) || !(aportacionMensual >= 0) || !Number.isFinite(rentabilidad)) return null

    const objetivo = gastosAnuales / (tasaRetirada / 100)
    const tasaMensual = Math.pow(1 + rentabilidad / 100, 1 / 12) - 1
    const serie = [{ anio: 0, valor: patrimonio }]
    let valor = patrimonio
    let meses = valor >= objetivo ? 0 : null

    for (let mes = 1; mes <= H_PROY_MAX_ANOS * 12 && meses === null; mes++) {
        valor = valor * (1 + tasaMensual) + aportacionMensual
        if (mes % 12 === 0) serie.push({ anio: mes / 12, valor })
        if (valor >= objetivo) meses = mes
    }
    // El gráfico acaba en el año en que se llega (redondeado hacia arriba).
    if (meses !== null && meses % 12 !== 0) serie.push({ anio: Math.ceil(meses / 12), valor })

    return {
        objetivo,
        falta: Math.max(0, objetivo - patrimonio),
        progreso: Math.min(1, patrimonio / objetivo),
        meses,
        serie
    }
}

async function hFireCargarPatrimonio() {
    hProyMensaje("hFireMsg", "Cargando…")
    try {
        const respuesta = await fetch("/api/patrimonio")
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`)
        const datos = await respuesta.json()
        const neto = Number(datos.neto)
        if (!Number.isFinite(neto)) throw new Error("Sin patrimonio neto")
        document.getElementById("hFirePatrimonio").value = Math.max(0, Math.round(neto))
        hProyMensaje("hFireMsg", `Patrimonio neto: ${formatEuro(neto)} (activos menos deudas).`)
    } catch (error) {
        console.error(error)
        hProyMensaje("hFireMsg", "No se pudo cargar el patrimonio.", true)
    }
}

function hFireCalcularPanel() {
    const r = hFireCalcular({
        gastosAnuales: hProyLeer("hFireGastos"),
        tasaRetirada: hProyLeer("hFireTasa"),
        patrimonio: hProyLeer("hFirePatrimonio"),
        aportacionMensual: hProyLeer("hFireAportacion"),
        rentabilidad: hProyLeer("hFireRent")
    })
    if (!r) {
        hProyMensaje("hFireMsg", "Revisa los datos: gastos y tasa mayores que cero, el resto no negativo.", true)
        return
    }
    hProyMensaje("hFireMsg", "")

    document.getElementById("hFireObjetivo").textContent = formatEuro(r.objetivo)
    document.getElementById("hFireFalta").textContent = formatEuro(r.falta)
    document.getElementById("hFireProgreso").textContent = hProyPct(r.progreso, 1)
    const tiempo = document.getElementById("hFireTiempo")
    const fecha = document.getElementById("hFireFecha")
    if (r.meses === null) {
        tiempo.textContent = `Más de ${H_PROY_MAX_ANOS} años`
        fecha.textContent = "---"
    } else if (r.meses === 0) {
        tiempo.textContent = "Ya lo tienes"
        fecha.textContent = String(new Date().getFullYear())
    } else {
        tiempo.textContent = hProyDuracion(r.meses)
        const llegada = new Date()
        llegada.setMonth(llegada.getMonth() + r.meses)
        fecha.textContent = llegada.toLocaleDateString("es-ES", { month: "long", year: "numeric" })
    }

    document.getElementById("hFireResults").classList.remove("hidden")
    hProyGrafico(
        "hFireChart",
        r.serie.map((p) => `Año ${p.anio}`),
        [
            hProySerie(
                "Patrimonio",
                r.serie.map((p) => p.valor),
                "#2ecc71",
                { fill: true }
            ),
            hProySerie(
                "Objetivo",
                r.serie.map(() => r.objetivo),
                "#e67e22",
                { borderDash: [6, 4] }
            )
        ]
    )
}

// ── Desacumulación ─────────────────────────────────────────────────────────

/**
 * Cuánto dura un capital del que se retira una cantidad que sube con la inflación.
 *
 * La retirada se hace al principio de cada año y el resto rinde durante el
 * año. Rentabilidad e inflación son nominales.
 *
 * @param {{capital: number, retiradaAnual: number, rentabilidad: number,
 *     inflacion: number}} datos Tasas en %.
 * @returns {{anos: number|null, totalRetirado: number, capitalFinal: number,
 *     retiradaSostenible: number|null, serie: {anio: number, valor: number}[]} | null}
 *     `anos` null si no se agota en el horizonte máximo; `retiradaSostenible`
 *     es la retirada inicial que no se come el capital nunca (null si la
 *     rentabilidad no supera la inflación).
 */
function hDesCalcular({ capital, retiradaAnual, rentabilidad, inflacion }) {
    if (!(capital > 0) || !(retiradaAnual > 0)) return null
    if (!Number.isFinite(rentabilidad) || !Number.isFinite(inflacion) || rentabilidad <= -100 || inflacion <= -100) {
        return null
    }

    const r = rentabilidad / 100
    const i = inflacion / 100
    const serie = [{ anio: 0, valor: capital }]
    let valor = capital
    let retirada = retiradaAnual
    let totalRetirado = 0
    let anos = null

    for (let anio = 1; anio <= H_PROY_MAX_ANOS; anio++) {
        const sale = Math.min(retirada, valor)
        totalRetirado += sale
        valor = (valor - sale) * (1 + r)
        serie.push({ anio, valor })
        if (sale < retirada || valor <= 0) {
            // El año en que no llega para la retirada completa es el último.
            anos = sale < retirada ? anio - 1 + sale / retirada : anio
            valor = 0
            break
        }
        retirada *= 1 + i
    }

    // Renta creciente perpetua con pago al inicio: C = W(1+r)/(r-i).
    const retiradaSostenible = r > i ? (capital * (r - i)) / (1 + r) : null
    return { anos, totalRetirado, capitalFinal: valor, retiradaSostenible, serie }
}

function hDesCalcularPanel() {
    const r = hDesCalcular({
        capital: hProyLeer("hDesCapital"),
        retiradaAnual: hProyLeer("hDesRetirada"),
        rentabilidad: hProyLeer("hDesRent"),
        inflacion: hProyLeer("hDesInflacion")
    })
    if (!r) {
        hProyMensaje(
            "hDesMsg",
            "Rellena capital, retirada, rentabilidad e inflación (esta última es tu hipótesis).",
            true
        )
        return
    }
    hProyMensaje("hDesMsg", "")

    document.getElementById("hDesDura").textContent =
        r.anos === null ? `Más de ${H_PROY_MAX_ANOS} años` : hProyDuracion(Math.max(0, Math.round(r.anos * 12)))
    document.getElementById("hDesRetirado").textContent = formatEuro(r.totalRetirado)
    document.getElementById("hDesFinal").textContent = formatEuro(r.capitalFinal)
    document.getElementById("hDesSostenible").textContent =
        r.retiradaSostenible === null ? "---" : formatEuro(r.retiradaSostenible)

    const nota = document.getElementById("hDesNota")
    if (r.retiradaSostenible === null) {
        nota.textContent =
            "Con una rentabilidad que no supera la inflación, cualquier retirada acaba agotando el capital."
        nota.className = "hRatioInterpretacion hRatioInfoNeg"
    } else {
        const ok = hProyLeer("hDesRetirada") <= r.retiradaSostenible
        nota.textContent = ok
            ? "Tu retirada está por debajo de la sostenible: el capital, en euros de hoy, no baja."
            : `Para no tocar el capital en euros de hoy, la retirada inicial tendría que bajar a ${formatEuro(r.retiradaSostenible)}.`
        nota.className = "hRatioInterpretacion " + (ok ? "hRatioInfoPos" : "hRatioInfoNeg")
    }

    document.getElementById("hDesResults").classList.remove("hidden")
    hProyGrafico(
        "hDesChart",
        r.serie.map((p) => `Año ${p.anio}`),
        [
            hProySerie(
                "Capital",
                r.serie.map((p) => p.valor),
                "#3498db",
                { fill: true }
            )
        ]
    )
}

// ── Monte Carlo ────────────────────────────────────────────────────────────

/**
 * Generador pseudoaleatorio con semilla (mulberry32): con la misma semilla da
 * la misma secuencia, así que los tests pueden fijar el resultado.
 *
 * @param {number} semilla Entero.
 * @returns {() => number} Uniforme en [0, 1).
 */
function hMcAleatorio(semilla) {
    let estado = semilla >>> 0
    return () => {
        estado = (estado + 0x6d2b79f5) >>> 0
        let t = estado
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/**
 * Normal estándar por Box-Muller a partir de un generador uniforme.
 *
 * @param {() => number} aleatorio
 * @returns {number}
 */
function hMcNormal(aleatorio) {
    let u = 0
    while (u === 0) u = aleatorio()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * aleatorio())
}

/**
 * Percentil de una lista ya ordenada, con interpolación lineal.
 *
 * @param {Float64Array|number[]} ordenados
 * @param {number} p Entre 0 y 1.
 * @returns {number}
 */
function hMcPercentil(ordenados, p) {
    if (!ordenados.length) return NaN
    const posicion = (ordenados.length - 1) * p
    const abajo = Math.floor(posicion)
    const arriba = Math.ceil(posicion)
    return ordenados[abajo] + (ordenados[arriba] - ordenados[abajo]) * (posicion - abajo)
}

/**
 * Simula la cartera con rendimientos mensuales lognormales.
 *
 * El rendimiento logarítmico mensual tiene media ln(1+r)/12 − s²/2 y
 * desviación s = σ/√12, de modo que el valor esperado crece a la rentabilidad
 * media r y la dispersión anual es σ. Las aportaciones entran a final de mes.
 *
 * @param {{capital: number, aportacionMensual: number, rentabilidad: number,
 *     volatilidad: number, anos: number, simulaciones: number,
 *     semilla?: number}} datos Rentabilidad y volatilidad anuales en %.
 * @returns {{anual: {anio: number, p10: number, p50: number, p90: number}[],
 *     final: {p10: number, p50: number, p90: number, media: number},
 *     totalAportado: number, probPerdida: number} | null}
 */
function hMcSimular({ capital, aportacionMensual, rentabilidad, volatilidad, anos, simulaciones, semilla }) {
    if (!(capital >= 0) || !(aportacionMensual >= 0) || !(capital > 0 || aportacionMensual > 0)) return null
    if (!Number.isFinite(rentabilidad) || rentabilidad <= -100 || !(volatilidad >= 0)) return null
    if (!Number.isInteger(anos) || anos < 1 || anos > H_PROY_MAX_ANOS) return null
    if (!Number.isInteger(simulaciones) || simulaciones < 10 || simulaciones > H_MC_MAX_SIMULACIONES) return null

    const s = volatilidad / 100 / Math.sqrt(12)
    const m = Math.log(1 + rentabilidad / 100) / 12 - (s * s) / 2
    const aleatorio = hMcAleatorio(semilla ?? Date.now())
    // Una fila por año con el valor de cada simulación: así se sacan los
    // percentiles por año sin guardar los 12 meses.
    const porAnio = Array.from({ length: anos }, () => new Float64Array(simulaciones))

    for (let sim = 0; sim < simulaciones; sim++) {
        let valor = capital
        for (let mes = 1; mes <= anos * 12; mes++) {
            valor = valor * Math.exp(m + s * hMcNormal(aleatorio)) + aportacionMensual
            if (mes % 12 === 0) porAnio[mes / 12 - 1][sim] = valor
        }
    }

    const totalAportado = capital + aportacionMensual * 12 * anos
    const anual = [{ anio: 0, p10: capital, p50: capital, p90: capital }]
    porAnio.forEach((valores, indice) => {
        valores.sort()
        anual.push({
            anio: indice + 1,
            p10: hMcPercentil(valores, 0.1),
            p50: hMcPercentil(valores, 0.5),
            p90: hMcPercentil(valores, 0.9)
        })
    })

    const finales = porAnio[anos - 1]
    let suma = 0
    let perdidas = 0
    for (const v of finales) {
        suma += v
        if (v < totalAportado) perdidas++
    }
    const ultimo = anual[anual.length - 1]
    return {
        anual,
        final: { p10: ultimo.p10, p50: ultimo.p50, p90: ultimo.p90, media: suma / simulaciones },
        totalAportado,
        probPerdida: perdidas / simulaciones
    }
}

async function hMcCargarCartera() {
    hProyMensaje("hMcMsg", "Cargando…")
    try {
        const respuesta = await fetch("/api/portfolio/rentabilidad")
        if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`)
        const datos = await respuesta.json()
        const rent = datos.twr?.anual
        const vol = datos.volatilidad?.anual
        if (!Number.isFinite(rent) || !Number.isFinite(vol)) {
            hProyMensaje("hMcMsg", "Aún no hay histórico suficiente de la cartera para estimarlas.", true)
            return
        }
        document.getElementById("hMcRent").value = (rent * 100).toFixed(2)
        document.getElementById("hMcVol").value = (vol * 100).toFixed(2)
        const dias = datos.twr?.dias || 0
        // Con menos de un año, una racha buena o mala se anualiza y engaña.
        hProyMensaje(
            "hMcMsg",
            `Rentabilidad (TWR anualizada) y volatilidad de tu cartera en ${dias} días.` +
                (dias < 365 ? " Con menos de un año de histórico son poco fiables." : ""),
            dias < 365
        )
    } catch (error) {
        console.error(error)
        hProyMensaje("hMcMsg", "No se pudo cargar la rentabilidad de la cartera.", true)
    }
}

function hMcCalcularPanel() {
    const r = hMcSimular({
        capital: hProyLeer("hMcCapital"),
        aportacionMensual: hProyLeer("hMcAportacion"),
        rentabilidad: hProyLeer("hMcRent"),
        volatilidad: hProyLeer("hMcVol"),
        anos: hProyLeer("hMcAnos"),
        simulaciones: hProyLeer("hMcSims")
    })
    if (!r) {
        hProyMensaje(
            "hMcMsg",
            `Revisa los datos: años entre 1 y ${H_PROY_MAX_ANOS}, simulaciones entre 10 y ${H_MC_MAX_SIMULACIONES}.`,
            true
        )
        return
    }
    hProyMensaje("hMcMsg", "")

    document.getElementById("hMcP50").textContent = formatEuro(r.final.p50)
    document.getElementById("hMcP10").textContent = formatEuro(r.final.p10)
    document.getElementById("hMcP90").textContent = formatEuro(r.final.p90)
    document.getElementById("hMcAportado").textContent = formatEuro(r.totalAportado)
    document.getElementById("hMcProb").textContent = hProyPct(r.probPerdida, 1)

    document.getElementById("hMcResults").classList.remove("hidden")
    const etiquetas = r.anual.map((p) => `Año ${p.anio}`)
    hProyGrafico("hMcChart", etiquetas, [
        hProySerie(
            "Percentil 90",
            r.anual.map((p) => p.p90),
            "#2ecc71"
        ),
        hProySerie(
            "Mediana",
            r.anual.map((p) => p.p50),
            "#3498db",
            { borderWidth: 3 }
        ),
        hProySerie(
            "Percentil 10",
            r.anual.map((p) => p.p10),
            "#e74c3c"
        ),
        hProySerie(
            "Aportado",
            r.anual.map((p) =>
                p.anio === 0 ? r.anual[0].p50 : r.anual[0].p50 + hProyLeer("hMcAportacion") * 12 * p.anio
            ),
            "#95a5a6",
            { borderDash: [6, 4], borderWidth: 1 }
        )
    ])
}

// ── Rentabilidad real ──────────────────────────────────────────────────────

/**
 * Rentabilidad que queda tras impuestos e inflación.
 *
 * Usa la ecuación de Fisher exacta, (1+n)/(1+i) − 1, y no la resta n − i,
 * que se desvía en cuanto los tipos dejan de ser pequeños.
 *
 * @param {{nominal: number, inflacion: number, impuesto: number,
 *     capital: number, anos: number}} datos Tasas en %.
 * @returns {{realBruta: number, nominalNeta: number, realNeta: number,
 *     capitalNominal: number, capitalReal: number} | null}
 */
function hRealCalcular({ nominal, inflacion, impuesto, capital, anos }) {
    if (!Number.isFinite(nominal) || !Number.isFinite(inflacion) || inflacion <= -100) return null
    if (!(impuesto >= 0) || impuesto > 100 || !(capital > 0) || !(anos > 0)) return null

    const n = nominal / 100
    const i = inflacion / 100
    // Una pérdida no paga impuesto: el tipo solo se aplica a lo ganado.
    const nominalNeta = n > 0 ? n * (1 - impuesto / 100) : n
    const realBruta = (1 + n) / (1 + i) - 1
    const realNeta = (1 + nominalNeta) / (1 + i) - 1
    const capitalNominal = capital * Math.pow(1 + nominalNeta, anos)
    return {
        realBruta,
        nominalNeta,
        realNeta,
        capitalNominal,
        capitalReal: capitalNominal / Math.pow(1 + i, anos)
    }
}

function hRealCalcularPanel() {
    const r = hRealCalcular({
        nominal: hProyLeer("hRealNominal"),
        inflacion: hProyLeer("hRealInflacion"),
        impuesto: hProyLeer("hRealImpuesto"),
        capital: hProyLeer("hRealCapital"),
        anos: hProyLeer("hRealAnos")
    })
    if (!r) {
        hProyMensaje(
            "hRealMsg",
            "Rellena la rentabilidad y la inflación (tu hipótesis); capital y años mayores que cero.",
            true
        )
        return
    }
    hProyMensaje("hRealMsg", "")

    const real = document.getElementById("hRealNeta")
    real.textContent = hProyPct(r.realNeta)
    real.className = "hResultValue " + (r.realNeta >= 0 ? "hResultPositive" : "hResultNegative")
    document.getElementById("hRealBruta").textContent = hProyPct(r.realBruta)
    document.getElementById("hRealNominalNeta").textContent = hProyPct(r.nominalNeta)
    document.getElementById("hRealCapNominal").textContent = formatEuro(r.capitalNominal)
    document.getElementById("hRealCapReal").textContent = formatEuro(r.capitalReal)

    const nota = document.getElementById("hRealNota")
    nota.textContent =
        r.realNeta >= 0
            ? "Después de impuestos e inflación tu dinero sigue ganando poder de compra."
            : "Después de impuestos e inflación tu dinero pierde poder de compra, aunque el saldo suba."
    nota.className = "hRatioInterpretacion " + (r.realNeta >= 0 ? "hRatioInfoPos" : "hRatioInfoNeg")
    document.getElementById("hRealResults").classList.remove("hidden")
}

// ── Arranque y reinicio ────────────────────────────────────────────────────

function hProyIniciar() {
    document.getElementById("hFireCargarBtn")?.addEventListener("click", hFireCargarPatrimonio)
    document.getElementById("hFireCalcBtn")?.addEventListener("click", hFireCalcularPanel)
    document.getElementById("hDesCalcBtn")?.addEventListener("click", hDesCalcularPanel)
    document.getElementById("hMcCargarBtn")?.addEventListener("click", hMcCargarCartera)
    document.getElementById("hMcCalcBtn")?.addEventListener("click", hMcCalcularPanel)
    document.getElementById("hRealCalcBtn")?.addEventListener("click", hRealCalcularPanel)
}

const H_PROY_PANELES = {
    toolFire: { mensaje: "hFireMsg", grafico: "hFireChart" },
    toolDesacumulacion: { mensaje: "hDesMsg", grafico: "hDesChart" },
    toolMontecarlo: { mensaje: "hMcMsg", grafico: "hMcChart" },
    toolRentabilidadReal: { mensaje: "hRealMsg", grafico: null }
}

function hProyReiniciar(panelId) {
    const panel = H_PROY_PANELES[panelId]
    if (!panel) return
    hProyMensaje(panel.mensaje, "")
    if (panel.grafico) hProyBorrarGrafico(panel.grafico)
}
