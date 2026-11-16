// Bloques de mercado de la ficha lateral (debajo de las tarjetas de posición):
// rendimiento por periodo, estacionales, datos técnicos y estadísticas clave.
//
// Rendimiento, técnicos y estadísticas salen de /api/market/ficha, la misma
// respuesta que pinta la pestaña "Mercado" de la ficha completa (comparten la
// caché `_mkCache` de assets-mercado.js). Los estacionales salen de las velas
// diarias de /api/market/series?periodo=estacional. El ticker es el de
// `buildTVSymbol`: sin ticker con mercado no hay nada que pedir y los bloques
// enseñan "—". Lo que el proveedor no publica se queda en "—": nada se estima.

// La ficha rota sola entre activos cada pocos segundos: con un TTL más largo
// que el de la pestaña Mercado, una vuelta completa no repite peticiones.
const DET_MK_FICHA_TTL = 10 * 60 * 1000
const DET_MK_SERIE_TTL = 30 * 60 * 1000
const DET_MK_ANYOS_ESTACIONALES = 3
const DET_MK_MESES_EJE = [
    { mes: 0, etiqueta: "ene" },
    { mes: 4, etiqueta: "may" },
    { mes: 8, etiqueta: "sept" }
]
const DET_MK_PERIODOS = [
    { clave: "Perf.W", etiqueta: "1S" },
    { clave: "Perf.1M", etiqueta: "1M" },
    { clave: "Perf.3M", etiqueta: "3M" },
    { clave: "Perf.6M", etiqueta: "6M" },
    { clave: "Perf.YTD", etiqueta: "YTD" },
    { clave: "Perf.Y", etiqueta: "1A" }
]

const _detMkSerieCache = new Map() // ticker -> { ts, puntos }
let _detMkTicker = ""
let _detMkPeticion = 0

/**
 * Rellena los bloques de mercado de la ficha lateral para un activo.
 *
 * Si el activo es el mismo que ya se enseña (la ficha se repinta en cada
 * refresco de precios) y hay datos en caché, se repinta sin el estado de
 * carga para que no parpadee. Las respuestas que llegan cuando ya se ha
 * elegido otro activo se descartan.
 *
 * @param {object} asset Activo mostrado en la ficha.
 * @returns {Promise<void>}
 */
async function pintarDetalleMercado(asset) {
    const ticker = detMkTickerDe(asset)
    const peticion = ++_detMkPeticion
    const cambiaActivo = ticker !== _detMkTicker
    _detMkTicker = ticker
    _detMkNombre = String(asset?.name || "")

    if (!ticker) {
        detMkPintarSinDatos("Sin ticker de TradingView con mercado")
        return
    }

    if (cambiaActivo) detMkPintarSinDatos("Cargando…")

    const [ficha, puntos] = await Promise.all([detMkObtenerFicha(ticker), detMkObtenerSerie(ticker)])
    if (peticion !== _detMkPeticion) return

    const stats = ficha?.stats || null
    detMkPintarRendimiento(stats)
    detMkPintarTecnico(stats)
    detMkPintarEstadisticas(ficha, asset)
    detMkPintarEstacionales(puntos)
}

function detMkTickerDe(asset) {
    if (typeof buildTVSymbol !== "function") return ""
    const ticker = String(buildTVSymbol(asset) || "").toUpperCase()
    return ticker.includes(":") ? ticker : ""
}

// ── Datos ───────────────────────────────────────────────────────────────────

async function detMkObtenerFicha(ticker) {
    const guardado = _mkCache.get(ticker)
    if (guardado && Date.now() - guardado.ts < DET_MK_FICHA_TTL) return guardado.data

    try {
        const respuesta = await fetch(`/api/market/ficha?symbol=${encodeURIComponent(ticker)}`)
        const datos = await respuesta.json()
        if (!datos.ok) throw new Error(datos.error || "Respuesta no válida")
        _mkCache.set(ticker, { ts: Date.now(), data: datos })
        return datos
    } catch (error) {
        console.error("Ficha lateral: datos de mercado", error)
        return null
    }
}

async function detMkObtenerSerie(ticker) {
    const guardado = _detMkSerieCache.get(ticker)
    if (guardado && Date.now() - guardado.ts < DET_MK_SERIE_TTL) return guardado.puntos

    try {
        const params = new URLSearchParams({ symbols: ticker, periodo: "estacional" })
        const respuesta = await fetch(`/api/market/series?${params}`)
        const datos = await respuesta.json()
        if (!datos.ok) throw new Error(datos.error || "Respuesta no válida")
        // Un ticker sin velas también se guarda, para no volver a preguntar por él.
        const puntos = datos.series?.[ticker] || null
        _detMkSerieCache.set(ticker, { ts: Date.now(), puntos })
        return puntos
    } catch (error) {
        console.error("Ficha lateral: velas de estacionales", error)
        return null
    }
}

// ── Pintado ─────────────────────────────────────────────────────────────────

function detMkPintarSinDatos(texto) {
    detMkPintarRendimiento(null)
    detMkPonerHtml("detMkSeason", detMkMensaje(texto))
    detMkPonerHtml("detMkGauge", detMkMensaje(texto))
    detMkPonerHtml("detMkStats", detMkMensaje(texto))
}

function detMkPonerHtml(id, html) {
    const elemento = document.getElementById(id)
    if (elemento) elemento.innerHTML = html
}

function detMkMensaje(texto) {
    return `<p class="detMkEmpty">${escapeHtml(texto)}</p>`
}

function detMkPintarRendimiento(stats) {
    const celdas = DET_MK_PERIODOS.map(({ clave, etiqueta }) => {
        const valor = stats ? fnToNumber(stats[clave]) : null
        // Lo que con dos decimales es cero va sin color.
        const tono = valor === null || Math.abs(valor) < 0.005 ? "" : valor > 0 ? " detMkPerfPos" : " detMkPerfNeg"
        return `
            <div class="detMkPerfCell${tono}" role="listitem">
                <span class="detMkPerfValue">${valor === null ? "—" : fnPercentSigned(valor)}</span>
                <span class="detMkPerfLabel">${etiqueta}</span>
            </div>`
    })
    detMkPonerHtml("detMkPerf", celdas.join(""))
}

/**
 * Pinta el medidor semicircular de la valoración técnica global.
 *
 * `Recommend.All` va de -1 (venta fuerte) a 1 (compra fuerte); la aguja recorre
 * el semicírculo de izquierda a derecha y los tramos coinciden con los cortes
 * de `FN_RATING_TIERS`, para que la etiqueta y la aguja digan lo mismo.
 *
 * @param {object|null} stats Respuesta del scanner para el activo.
 */
function detMkPintarTecnico(stats) {
    const valor = stats ? fnToNumber(stats["Recommend.All"]) : null
    if (valor === null) {
        detMkPonerHtml("detMkGauge", detMkMensaje("Sin datos técnicos"))
        return
    }

    const info = fnRatingInfo(valor)
    const limitado = Math.max(-1, Math.min(1, valor))
    const tramos = [
        [-1, -0.5, "detMkArcStrongSell"],
        [-0.5, -0.1, "detMkArcSell"],
        [-0.1, 0.1, "detMkArcNeutral"],
        [0.1, 0.5, "detMkArcBuy"],
        [0.5, 1, "detMkArcStrongBuy"]
    ]
    // Un pequeño hueco entre tramos, como separador visual.
    const hueco = 0.03
    const arcos = tramos
        .map(([desde, hasta, clase]) => `<path class="${clase}" d="${detMkArco(desde + hueco, hasta - hueco)}" />`)
        .join("")
    const angulo = detMkAngulo(limitado)
    const punta = detMkPunto(angulo, 34)

    detMkPonerHtml(
        "detMkGauge",
        `
        <svg class="detMkGaugeSvg" viewBox="0 0 120 66" role="img" aria-label="Valoración técnica: ${escapeHtml(info.label)}">
            ${arcos}
            <line class="detMkNeedle" x1="60" y1="58" x2="${punta.x.toFixed(2)}" y2="${punta.y.toFixed(2)}" />
            <circle class="detMkNeedleHub" cx="60" cy="58" r="3" />
        </svg>
        <div class="detMkGaugeLabel ${info.cls}">${escapeHtml(info.label)}</div>`
    )
}

// Ángulo en radianes para un valor de -1 a 1: π a la izquierda, 0 a la derecha.
function detMkAngulo(valor) {
    return Math.PI * (1 - (valor + 1) / 2)
}

function detMkPunto(angulo, radio) {
    return { x: 60 + radio * Math.cos(angulo), y: 58 - radio * Math.sin(angulo) }
}

function detMkArco(desde, hasta) {
    const radio = 48
    const inicio = detMkPunto(detMkAngulo(desde), radio)
    const fin = detMkPunto(detMkAngulo(hasta), radio)
    return `M ${inicio.x.toFixed(2)} ${inicio.y.toFixed(2)} A ${radio} ${radio} 0 0 1 ${fin.x.toFixed(2)} ${fin.y.toFixed(2)}`
}

/**
 * Pinta las estadísticas clave: de la moneda y sus derivados en cripto, de
 * capitalización y negociación en el resto, y el rango de 52 semanas en todos.
 *
 * @param {object|null} ficha Respuesta completa de /api/market/ficha.
 * @param {object} asset Activo mostrado, para la divisa de respaldo.
 */
function detMkPintarEstadisticas(ficha, asset) {
    const stats = ficha?.stats
    if (!stats) {
        detMkPonerHtml("detMkStats", detMkMensaje("Sin estadísticas de mercado"))
        return
    }

    const divisa = String(stats.currency || asset.currency || "EUR").toUpperCase()
    const filas = ficha.isCrypto ? detMkFilasCripto(ficha) : detMkFilasTradicional(stats, divisa)
    filas.push(
        ["Máximo 52 semanas", fnPrice(stats.price_52_week_high, divisa)],
        ["Mínimo 52 semanas", fnPrice(stats.price_52_week_low, divisa)]
    )

    const html = filas
        .filter(([, valor]) => valor !== null)
        .map(([etiqueta, valor]) => `<div class="detMkStatRow"><dt>${etiqueta}</dt><dd>${valor}</dd></div>`)
        .join("")
    detMkPonerHtml("detMkStats", html)
}

function detMkFilasCripto(ficha) {
    const moneda = ficha.coin || {}
    const derivados = ficha.derivatives || {}
    const capitalizacion = fnToNumber(moneda.market_cap_calc)
    const volumen = fnToNumber(moneda["24h_vol_cmc"])
    const circulante = fnToNumber(moneda.circulating_supply)
    const tasa = fnToNumber(derivados.fundingRate)

    return [
        ["Volumen 24 h", mkMoney(volumen, "USD")],
        ["Capitalización de mercado", mkMoney(capitalizacion, "USD")],
        ["Capitalización diluida", mkMoney(fnToNumber(moneda.market_cap_diluted_calc), "USD")],
        ["Volumen / Cap. de mercado", capitalizacion && volumen !== null ? fnRatio(volumen / capitalizacion, 4) : "—"],
        ["Oferta circulante", circulante === null ? "—" : mkCompact(circulante)],
        ["Interés abierto", mkMoney(fnToNumber(derivados.openInterestUsd), "USD")],
        ["Tasa de financiación", tasa === null ? "—" : fnPercentSigned(tasa * 100, 4)]
    ]
}

function detMkFilasTradicional(stats, divisa) {
    const divisaFundamental = stats.fundamental_currency_code || divisa
    const capitalizacion = fnToNumber(stats.market_cap_basic)
    const patrimonio = fnToNumber(stats.aum)
    const volumen = fnToNumber(stats.volume)
    const volumenMedio = fnToNumber(stats.average_volume_30d_calc)

    // Capitalización y patrimonio solo existen en acciones y fondos: sin dato, la fila sobra.
    return [
        ["Capitalización de mercado", capitalizacion === null ? null : mkMoney(capitalizacion, divisaFundamental)],
        ["Patrimonio del fondo", patrimonio === null ? null : mkMoney(patrimonio, divisaFundamental)],
        ["Volumen (último día)", volumen === null ? "—" : mkCompact(volumen)],
        ["Volumen medio (30 d)", volumenMedio === null ? "—" : mkCompact(volumenMedio)]
    ]
}

// ── Estacionales ────────────────────────────────────────────────────────────

/**
 * Agrupa las velas diarias por año natural y pasa cada cierre a variación
 * porcentual sobre el cierre del 31 de diciembre anterior (o, si no hay velas
 * del año anterior, sobre el primer cierre del año).
 *
 * @param {Array<[number, number]>} puntos Velas `[ts en segundos, cierre]` ordenadas.
 * @param {number} cuantos Años a devolver, empezando por el más reciente.
 * @returns {Array<{anyo: number, puntos: Array<{x: number, y: number}>}>}
 *   Del más reciente al más antiguo; `x` es la fracción del año (0 a 1).
 *
 * @example
 * detMkSeriesEstacionales([[1704153600, 100], [1704240000, 110]], 3)
 * // [{ anyo: 2024, puntos: [{ x: 0.0027, y: 0 }, { x: 0.0055, y: 10 }] }]
 */
function detMkSeriesEstacionales(puntos, cuantos) {
    const porAnyo = new Map()
    for (const [ts, cierre] of puntos || []) {
        if (!(cierre > 0)) continue
        const fecha = new Date(ts * 1000)
        const anyo = fecha.getFullYear()
        if (!porAnyo.has(anyo)) porAnyo.set(anyo, [])
        porAnyo.get(anyo).push({ fecha, cierre })
    }

    const anyos = [...porAnyo.keys()].sort((a, b) => b - a).slice(0, cuantos)
    return anyos
        .map((anyo) => {
            const velas = porAnyo.get(anyo)
            const anterior = porAnyo.get(anyo - 1)
            const base = anterior ? anterior[anterior.length - 1].cierre : velas[0].cierre
            const inicio = new Date(anyo, 0, 1).getTime()
            const duracion = new Date(anyo + 1, 0, 1).getTime() - inicio
            return {
                anyo,
                puntos: velas.map(({ fecha, cierre }) => ({
                    x: (fecha.getTime() - inicio) / duracion,
                    y: (cierre / base - 1) * 100
                }))
            }
        })
        .filter((serie) => serie.puntos.length >= 2)
}

function detMkPintarEstacionales(puntos) {
    const series = detMkSeriesEstacionales(puntos, DET_MK_ANYOS_ESTACIONALES)
    if (!series.length) {
        detMkPonerHtml("detMkSeason", detMkMensaje("Sin histórico de precios"))
        return
    }

    const ancho = 300
    const alto = 110
    const todos = series.flatMap((serie) => serie.puntos.map((p) => p.y))
    // El cero siempre dentro: la línea de referencia es la que da sentido a las curvas.
    const minimo = Math.min(0, ...todos)
    const maximo = Math.max(0, ...todos)
    const margen = (maximo - minimo) * 0.08 || 1
    const yMin = minimo - margen
    const yMax = maximo + margen
    const aX = (x) => (x * ancho).toFixed(1)
    const aY = (y) => (((yMax - y) / (yMax - yMin)) * alto).toFixed(1)

    // Se pinta del más antiguo al actual para que el actual quede encima.
    const lineas = series
        .map((serie, indice) => {
            const d = serie.puntos.map((p, i) => `${i ? "L" : "M"}${aX(p.x)} ${aY(p.y)}`).join(" ")
            return `<path class="detMkSeasonLine detMkSeasonY${indice}" d="${d}" />`
        })
        .reverse()
        .join("")
    const guias = DET_MK_MESES_EJE.slice(1)
        .map(({ mes }) => {
            const x = aX(detMkFraccionMes(mes))
            return `<line class="detMkSeasonGuide" x1="${x}" y1="0" x2="${x}" y2="${alto}" />`
        })
        .join("")
    const ultimo = series[0].puntos[series[0].puntos.length - 1]
    const etiquetasEje = DET_MK_MESES_EJE.map(
        ({ mes, etiqueta }) => `<span style="left:${(detMkFraccionMes(mes) * 100).toFixed(2)}%">${etiqueta}</span>`
    ).join("")
    const leyenda = series
        .map(
            (serie, indice) =>
                `<span class="detMkSeasonKey"><i class="detMkSeasonDot detMkSeasonY${indice}"></i>${serie.anyo}</span>`
        )
        .join("")
    const ultimoTexto = `${series[0].anyo}: ${fnPercentSigned(ultimo.y)}`

    detMkPonerHtml(
        "detMkSeason",
        `
        <div class="detMkSeasonPlot">
            <svg class="detMkSeasonSvg" viewBox="0 0 ${ancho} ${alto}" preserveAspectRatio="none" role="img" aria-label="Estacionales. ${escapeHtml(ultimoTexto)}">
                ${guias}
                <line class="detMkSeasonZero" x1="0" y1="${aY(0)}" x2="${ancho}" y2="${aY(0)}" />
                ${lineas}
            </svg>
            <span class="detMkSeasonEnd detMkSeasonY0" style="left:${(ultimo.x * 100).toFixed(2)}%;top:${((Number(aY(ultimo.y)) / alto) * 100).toFixed(2)}%" title="${escapeHtml(ultimoTexto)}"></span>
        </div>
        <div class="detMkSeasonAxis" aria-hidden="true">${etiquetasEje}</div>
        <div class="detMkSeasonLegend">${leyenda}</div>`
    )
}

// Fracción del año en que empieza un mes, con un año no bisiesto de referencia.
function detMkFraccionMes(mes) {
    const inicio = new Date(2025, 0, 1).getTime()
    return (new Date(2025, mes, 1).getTime() - inicio) / (365 * 86400 * 1000)
}

// ── Tabla de rendimiento mensual por años ───────────────────────────────────
//
// Sale de velas mensuales (/api/market/series?periodo=mensual), no de las
// diarias de las curvas: 300 velas de un mes son 25 años de historia en una
// sola petición. Se piden al abrir la tabla, no al pintar la ficha, porque la
// ficha rota sola entre activos y casi nunca se abre.

const DET_MK_MESES_TABLA = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre"
]

const _detMkMensualCache = new Map() // ticker -> { ts, puntos }
let _detMkNombre = ""
let _detMkTablaPeticion = 0

/**
 * Calcula el rendimiento de cada mes y de cada año natural a partir de velas mensuales.
 *
 * El mes es la variación de su cierre sobre el cierre del mes anterior; si ese
 * mes no está (primera vela o un hueco del proveedor) se queda en null en vez
 * de comparar con un mes más antiguo. El año es la variación del último cierre
 * del año sobre el último del año anterior; en el primer año, sobre su primer
 * cierre, que es lo único que hay. Mes y año se leen en UTC: el feed fecha la
 * vela de un mes en su primer día de cotización, a medianoche UTC en cripto, y
 * en hora local de Madrid caería igual, pero no en husos al oeste de UTC.
 *
 * @param {Array<[number, number]>|null} puntos Velas mensuales `[ts en segundos, cierre]`.
 * @returns {{anyos: Array<{anyo: number, meses: Array<number|null>, total: number|null}>,
 *   recuento: Array<{subidas: number, caidas: number}>}}
 *   `anyos` va del más reciente al más antiguo; `recuento` tiene 13 columnas
 *   (los doce meses y el año) con cuántos años subieron y cuántos cayeron.
 *
 * @example
 * detMkTablaMensual([[1704067200, 100], [1706745600, 110]])
 * // { anyos: [{ anyo: 2024, meses: [null, 10, null, ...], total: 10 }], recuento: [...] }
 */
function detMkTablaMensual(puntos) {
    const velas = (puntos || [])
        .filter(([ts, cierre]) => Number.isFinite(ts) && cierre > 0)
        .map(([ts, cierre]) => {
            const fecha = new Date(ts * 1000)
            return { anyo: fecha.getUTCFullYear(), mes: fecha.getUTCMonth(), cierre }
        })
        .sort((a, b) => detMkIndiceMes(a) - detMkIndiceMes(b))

    const porAnyo = new Map()
    velas.forEach((vela, indice) => {
        if (!porAnyo.has(vela.anyo)) {
            porAnyo.set(vela.anyo, { meses: Array(12).fill(null), primero: vela.cierre, cuantas: 0 })
        }
        const fila = porAnyo.get(vela.anyo)
        fila.ultimo = vela.cierre
        fila.cuantas += 1
        const previa = velas[indice - 1]
        if (previa && detMkIndiceMes(previa) === detMkIndiceMes(vela) - 1) {
            fila.meses[vela.mes] = (vela.cierre / previa.cierre - 1) * 100
        }
    })

    const anyos = [...porAnyo.entries()]
        .sort(([a], [b]) => b - a)
        .map(([anyo, fila]) => {
            const anterior = porAnyo.get(anyo - 1)
            let total = null
            if (anterior) total = (fila.ultimo / anterior.ultimo - 1) * 100
            else if (fila.cuantas > 1) total = (fila.ultimo / fila.primero - 1) * 100
            return { anyo, meses: fila.meses, total }
        })

    const recuento = Array.from({ length: 13 }, (_, columna) => {
        const valores = anyos.map((fila) => (columna < 12 ? fila.meses[columna] : fila.total))
        return {
            subidas: valores.filter((v) => v !== null && v > 0).length,
            caidas: valores.filter((v) => v !== null && v < 0).length
        }
    })
    return { anyos, recuento }
}

function detMkIndiceMes({ anyo, mes }) {
    return anyo * 12 + mes
}

async function detMkObtenerMensual(ticker) {
    const guardado = _detMkMensualCache.get(ticker)
    if (guardado && Date.now() - guardado.ts < DET_MK_SERIE_TTL) return guardado.puntos

    try {
        const params = new URLSearchParams({ symbols: ticker, periodo: "mensual" })
        const respuesta = await fetch(`/api/market/series?${params}`)
        const datos = await respuesta.json()
        if (!datos.ok) throw new Error(datos.error || "Respuesta no válida")
        // Un ticker sin velas también se guarda, para no volver a preguntar por él.
        const puntos = datos.series?.[ticker] || null
        _detMkMensualCache.set(ticker, { ts: Date.now(), puntos })
        return puntos
    } catch (error) {
        console.error("Ficha lateral: velas mensuales", error)
        return null
    }
}

/**
 * Construye la tabla de rendimiento mensual por años.
 *
 * @param {Array<[number, number]>|null} puntos Velas mensuales del activo.
 * @returns {string} HTML de la tabla, o un mensaje si no hay ningún mes con variación.
 */
function detMkHtmlTablaMensual(puntos) {
    const { anyos, recuento } = detMkTablaMensual(puntos)
    if (!anyos.some((fila) => fila.total !== null)) return detMkMensaje("Sin histórico mensual de precios")

    const celda = (valor, clase = "") => {
        if (valor === null) return `<td class="detMkTablaCelda${clase}">—</td>`
        // Lo que con dos decimales es cero va sin color, como en Rendimiento.
        const tono = Math.abs(valor) < 0.005 ? "" : valor > 0 ? " detMkTablaPos" : " detMkTablaNeg"
        return `<td class="detMkTablaCelda${tono}${clase}">${fnPercentSigned(valor)}</td>`
    }
    const cabecera = [...DET_MK_MESES_TABLA, "Año"]
        .map((texto, i) => `<th scope="col"${i === 12 ? ' class="detMkTablaAnyo"' : ""}>${texto}</th>`)
        .join("")
    const filas = anyos
        .map(
            ({ anyo, meses, total }) =>
                `<tr><th scope="row">${anyo}</th>${meses.map((v) => celda(v)).join("")}${celda(total, " detMkTablaAnyo")}</tr>`
        )
        .join("")
    const pie = recuento
        .map(
            ({ subidas, caidas }) =>
                `<td><span class="detMkTablaSube" title="Subidas">▲${subidas}</span> <span class="detMkTablaBaja" title="Caídas">▼${caidas}</span></td>`
        )
        .join("")

    return `
        <div class="detMkTablaScroll">
            <table class="detMkTabla">
                <thead><tr><th scope="col">Fecha</th>${cabecera}</tr></thead>
                <tbody>${filas}</tbody>
                <tfoot><tr><th scope="row">Subidas y caídas</th>${pie}</tr></tfoot>
            </table>
        </div>`
}

// ── Popup de estacionales: gráfico de todos los años y tabla mensual ────────
//
// Se abre desde el bloque «Estacionales» de la ficha: el minigráfico abre la
// vista de gráfico y el botón «Tabla», la tabla; dentro se alterna entre ambas.
// El gráfico usa las velas diarias de todo el histórico del feed
// (periodo=historico, las mismas que los estacionales de la pestaña «Gráfico»)
// y reutiliza su cálculo por años y su elección de años, que vale para todos
// los activos.

const _detMkHistoricoCache = new Map() // ticker -> { ts, puntos }
// Activo y vista del popup. El ticker se fija al abrir: la ficha sigue rotando
// por debajo y el popup no debe cambiar de activo con ella.
const _detMkEst = { ticker: "", nombre: "", vista: "grafico", puntos: null }
let _detMkEstChart = null

async function detMkObtenerHistorico(ticker) {
    const guardado = _detMkHistoricoCache.get(ticker)
    if (guardado && Date.now() - guardado.ts < DET_MK_SERIE_TTL) return guardado.puntos

    try {
        const params = new URLSearchParams({ symbols: ticker, periodo: "historico" })
        const respuesta = await fetch(`/api/market/series?${params}`)
        const datos = await respuesta.json()
        if (!datos.ok) throw new Error(datos.error || "Respuesta no válida")
        // Un ticker sin velas también se guarda, para no volver a preguntar por él.
        const puntos = datos.series?.[ticker] || null
        _detMkHistoricoCache.set(ticker, { ts: Date.now(), puntos })
        return puntos
    } catch (error) {
        console.error("Popup de estacionales: velas diarias del histórico", error)
        return null
    }
}

/**
 * Datos de los botones de año del popup: color, si se ve y la variación del año.
 *
 * @param {{anio: number, ultimo: number, parcial: boolean}[]} series Años con datos,
 *     del más antiguo al más reciente (salida de assetGraficoSeriesEstacionales).
 * @param {number[]} seleccionados Años que se ven.
 * @param {(anio: number) => string} colorDe Color de cada año.
 * @returns {{anio: number, activo: boolean, color: string, etiqueta: string, valor: string, positivo: boolean}[]}
 *     Del más reciente al más antiguo, como la tabla.
 *
 * @example
 * detMkEstBotonesAnios([{ anio: 2025, ultimo: 12.5, parcial: false }], [2025], () => "#fff")
 * // [{ anio: 2025, activo: true, color: "#fff", etiqueta: "2025", valor: "+12,50 %", positivo: true }]
 */
function detMkEstBotonesAnios(series, seleccionados, colorDe) {
    return [...series].reverse().map((serie) => ({
        anio: serie.anio,
        activo: seleccionados.includes(serie.anio),
        color: colorDe(serie.anio),
        etiqueta: `${serie.anio}${serie.parcial ? " *" : ""}`,
        valor: fnPercentSigned(serie.ultimo),
        positivo: serie.ultimo >= 0
    }))
}

function detMkEstDestruirChart() {
    _detMkEstChart?.destroy()
    _detMkEstChart = null
}

function detMkEstMostrarVista(vista) {
    _detMkEst.vista = vista
    document.querySelectorAll("#detMkEstOverlay [data-det-mk-vista]").forEach((boton) => {
        const activo = boton.dataset.detMkVista === vista
        boton.classList.toggle("active", activo)
        boton.setAttribute("aria-pressed", String(activo))
    })
    document.querySelector("#detMkEstOverlay .detMkEstModal")?.classList.toggle("detMkEstModalTabla", vista === "tabla")
    document.getElementById("detMkEstGrafico")?.classList.toggle("hidden", vista !== "grafico")
    document.getElementById("detMkTablaCuerpo")?.classList.toggle("hidden", vista !== "tabla")
}

function detMkEstMensajeGrafico(texto) {
    detMkEstDestruirChart()
    document.getElementById("detMkEstLienzo")?.classList.add("hidden")
    document.getElementById("detMkEstAnios")?.replaceChildren()
    detMkPonerHtml("detMkEstNota", "")
    const vacio = document.getElementById("detMkEstVacio")
    if (vacio) {
        vacio.textContent = texto
        vacio.classList.remove("hidden")
    }
}

// Los botones se montan con el DOM y no con innerHTML para poner el color de cada
// año sin atributos de estilo en el texto, como en la pestaña «Gráfico».
function detMkEstPintarBotonesAnios(botones) {
    const contenedor = document.getElementById("detMkEstAnios")
    if (!contenedor) return
    contenedor.replaceChildren(
        ...botones.map(({ anio, activo, color, etiqueta, valor: texto, positivo }) => {
            const boton = document.createElement("button")
            boton.type = "button"
            boton.className = `mToggleBtn${activo ? " active" : ""}`
            boton.dataset.detMkAnio = String(anio)
            boton.setAttribute("aria-pressed", String(activo))
            const punto = document.createElement("span")
            punto.className = "assetGraficoPunto"
            punto.style.background = color
            const valor = document.createElement("span")
            valor.className = positivo ? "detMkTablaSube" : "detMkTablaBaja"
            valor.textContent = texto
            boton.append(punto, ` ${etiqueta} `, valor)
            return boton
        })
    )
}

function detMkEstPintarGrafico() {
    // El cálculo por años vive en assets-grafico-modos.js: sin él no hay gráfico.
    if (typeof Chart === "undefined" || typeof assetGraficoSeriesEstacionales !== "function") {
        detMkEstMensajeGrafico("El gráfico no está disponible.")
        return
    }
    const puntos = (_detMkEst.puntos || []).map(([ts, cierre]) => ({ ts, precio: cierre }))
    const todas = assetGraficoSeriesEstacionales(puntos)
    if (!todas.length) {
        detMkEstMensajeGrafico("Sin histórico de precios")
        return
    }

    const disponibles = todas.map((serie) => serie.anio)
    const seleccionados = assetGraficoAniosSeleccionados(disponibles, getChartPref("assetGraficoAniosElegidos", null))
    const overlay = document.getElementById("detMkEstOverlay")
    const estilos = getComputedStyle(overlay)
    const color = (variable) => estilos.getPropertyValue(variable).trim()
    // Mismo criterio de color que la pestaña: por distancia al último año con datos.
    const ultimoDisponible = disponibles[disponibles.length - 1]
    const colorDe = (anio) => assetGraficoColorAnio(ultimoDisponible - anio, color("--accent"))

    detMkEstPintarBotonesAnios(detMkEstBotonesAnios(todas, seleccionados, colorDe))
    const series = todas.filter((serie) => seleccionados.includes(serie.anio))
    detMkEstDestruirChart()
    if (!series.length) {
        document.getElementById("detMkEstLienzo")?.classList.add("hidden")
        const vacio = document.getElementById("detMkEstVacio")
        if (vacio) {
            vacio.textContent = "Elige al menos un año."
            vacio.classList.remove("hidden")
        }
        return
    }

    document.getElementById("detMkEstVacio")?.classList.add("hidden")
    document.getElementById("detMkEstLienzo")?.classList.remove("hidden")
    const parcial = series.some((serie) => serie.parcial)
    detMkPonerHtml(
        "detMkEstNota",
        escapeHtml(
            `Cada línea es un año natural: variación del precio desde el cierre del año anterior (0 %), en la divisa de cotización. Pulsa un año para ocultarlo o mostrarlo.${
                parcial ? " * El año arranca en el primer precio disponible, no en el cierre del anterior." : ""
            }`
        )
    )
    _detMkEstChart = new Chart(
        document.getElementById("detMkEstCanvas"),
        assetGraficoConfigEstacional(
            series,
            series.map((serie) => colorDe(serie.anio)),
            { texto: color("--text-muted"), rejilla: color("--border-soft") }
        )
    )
}

/**
 * Marca o desmarca un año del gráfico del popup. La elección es la misma que la
 * de los estacionales de la pestaña «Gráfico».
 *
 * @param {HTMLElement} boton Botón del año (`data-det-mk-anio`).
 */
function detMkEstAlternarAnio(boton) {
    const anio = Number(boton.dataset.detMkAnio)
    const puntos = (_detMkEst.puntos || []).map(([ts, cierre]) => ({ ts, precio: cierre }))
    const disponibles = assetGraficoSeriesEstacionales(puntos).map((serie) => serie.anio)
    if (!disponibles.includes(anio)) return
    const actuales = assetGraficoAniosSeleccionados(disponibles, getChartPref("assetGraficoAniosElegidos", null))
    const siguientes = actuales.includes(anio)
        ? actuales.filter((elegido) => elegido !== anio)
        : [...actuales, anio].sort((a, b) => a - b)
    // Cadena vacía y no null: «ninguno» es una elección, no la ausencia de ella.
    setChartPref("assetGraficoAniosElegidos", siguientes.join(","))
    detMkEstPintarGrafico()
}

/**
 * Abre el popup de estacionales del activo de la ficha y carga sus datos.
 *
 * El gráfico y la tabla se piden a la vez: así alternar entre vistas es inmediato.
 *
 * @param {"grafico"|"tabla"} vista Vista con la que se abre.
 * @returns {Promise<void>}
 */
async function detMkAbrirEstacionales(vista) {
    const overlay = document.getElementById("detMkEstOverlay")
    if (!overlay) return
    const ticker = _detMkTicker
    const peticion = ++_detMkTablaPeticion
    Object.assign(_detMkEst, { ticker, nombre: _detMkNombre, puntos: null })

    const titulo = document.getElementById("detMkEstModalTitulo")
    if (titulo) titulo.textContent = `${_detMkNombre || ticker || "Activo"} · Estacionales`
    detMkEstMostrarVista(vista)
    overlay.classList.remove("hidden")

    if (!ticker) {
        detMkEstMensajeGrafico("Sin ticker de TradingView con mercado")
        detMkPonerHtml("detMkTablaCuerpo", detMkMensaje("Sin ticker de TradingView con mercado"))
        return
    }
    detMkEstMensajeGrafico("Cargando…")
    detMkPonerHtml("detMkTablaCuerpo", detMkMensaje("Cargando…"))

    // Si entretanto se cerró el popup o se abrió para otro activo, la respuesta sobra.
    const vigente = () => peticion === _detMkTablaPeticion && !overlay.classList.contains("hidden")
    await Promise.all([
        detMkObtenerHistorico(ticker).then((puntos) => {
            if (!vigente()) return
            _detMkEst.puntos = puntos
            detMkEstPintarGrafico()
        }),
        detMkObtenerMensual(ticker).then((puntos) => {
            if (vigente()) detMkPonerHtml("detMkTablaCuerpo", detMkHtmlTablaMensual(puntos))
        })
    ])
}

function detMkCerrarEstacionales() {
    document.getElementById("detMkEstOverlay")?.classList.add("hidden")
    detMkEstDestruirChart()
}

// Delegado en document: así no hay que volver a enganchar nada si la ficha se
// repinta, y el clic fuera del cuadro (sobre el fondo) también cierra.
document.addEventListener("click", (event) => {
    const objetivo = event.target
    if (objetivo.closest?.("#detMkEstTablaBtn")) {
        detMkAbrirEstacionales("tabla")
    } else if (objetivo.closest?.("#detMkSeason")) {
        detMkAbrirEstacionales("grafico")
    } else if (objetivo.closest?.("#detMkEstOverlay [data-det-mk-vista]")) {
        detMkEstMostrarVista(objetivo.closest("[data-det-mk-vista]").dataset.detMkVista)
    } else if (objetivo.closest?.("#detMkEstOverlay [data-det-mk-anio]")) {
        detMkEstAlternarAnio(objetivo.closest("[data-det-mk-anio]"))
    } else if (objetivo.closest?.("#detMkEstCerrarBtn") || objetivo.id === "detMkEstOverlay") {
        detMkCerrarEstacionales()
    }
})

document.addEventListener("keydown", (event) => {
    // El minigráfico hace de botón: Intro o espacio también lo abren.
    if ((event.key === "Enter" || event.key === " ") && event.target.id === "detMkSeason") {
        event.preventDefault()
        detMkAbrirEstacionales("grafico")
        return
    }
    if (event.key !== "Escape") return
    const overlay = document.getElementById("detMkEstOverlay")
    if (overlay && !overlay.classList.contains("hidden")) detMkCerrarEstacionales()
})
