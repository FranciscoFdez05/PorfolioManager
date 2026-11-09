// ===== CUENTAS · GRÁFICAS =====
// Saldo de cada cuenta, y del total de todas, en el tiempo.
//
// La serie llega de /api/cuentas/historico: un punto por cada día con
// movimientos, más el de partida y el de hoy. Entre dos puntos el saldo no
// cambia, por eso la línea se dibuja en escalones y no en diagonal: una diagonal
// enseñaría dinero a medio llegar que nunca existió.

// `periodo` completa «+12,00 € en …» bajo la gráfica del total.
const CNT_RANGOS = [
    { clave: "1M", etiqueta: "1 mes", meses: 1, periodo: "el último mes" },
    { clave: "3M", etiqueta: "3 meses", meses: 3, periodo: "los últimos 3 meses" },
    { clave: "6M", etiqueta: "6 meses", meses: 6, periodo: "los últimos 6 meses" },
    { clave: "1A", etiqueta: "1 año", meses: 12, periodo: "el último año" },
    { clave: "YTD", etiqueta: "YTD", periodo: "el año" },
    { clave: "TODO", etiqueta: "Todo", periodo: "todo el histórico" }
]
const CNT_RANGO_DEFECTO = "YTD"
const CNT_RANGO_PREF = "cuentasGraficoRango"
// La gráfica del total guarda su periodo aparte del de la ventana de una cuenta.
const CNT_RANGO_TOTAL_PREF = "cuentasTotalRango"
const CNT_DIA_MS = 86400000

const CNT_COLOR_LINEA = "#3a7bd5"
const CNT_COLOR_ENTRADA = "#2e9e6b"
const CNT_COLOR_SALIDA = "#e5484d"
const CNT_PALETA = ["#3a7bd5", "#2e9e6b", "#d9a520", "#c44fb4", "#d95926", "#14b8a6", "#8b5cf6", "#e5484d", "#64748b"]

/**
 * Pasa la serie de la API a números: `[{t, entradas, salidas, saldo}]`.
 * @param {Array<{fecha: string, entradas: string, salidas: string, saldo: string}>} puntos
 * @returns {Array<{t: number, entradas: number, salidas: number, saldo: number}>}
 */
function cntNormalizarSerie(puntos) {
    return (Array.isArray(puntos) ? puntos : [])
        .map((p) => {
            const [anio, mes, dia] = String(p.fecha || "")
                .split("-")
                .map(Number)
            return {
                t: new Date(anio, mes - 1, dia).getTime(),
                entradas: Number(p.entradas) || 0,
                salidas: Number(p.salidas) || 0,
                saldo: Number(p.saldo) || 0
            }
        })
        .filter((p) => Number.isFinite(p.t))
}

function cntRangoValido(clave) {
    return CNT_RANGOS.some((r) => r.clave === clave) ? clave : CNT_RANGO_DEFECTO
}

/**
 * Primer instante del rango, o null para «Todo».
 * @param {string} clave Una de CNT_RANGOS.
 * @param {Date} hoy
 * @returns {number|null} Milisegundos de la medianoche local del primer día.
 */
function cntInicioRango(clave, hoy = new Date()) {
    const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate())
    if (clave === "TODO") return null
    if (clave === "YTD") return new Date(base.getFullYear(), 0, 1).getTime()
    const rango = CNT_RANGOS.find((r) => r.clave === clave) || CNT_RANGOS.find((r) => r.clave === CNT_RANGO_DEFECTO)
    if (!rango.meses) return new Date(base.getFullYear(), 0, 1).getTime()
    // El 31 de marzo menos un mes no es el 3 de marzo: se queda en el último día
    // del mes de destino.
    const destino = new Date(base.getFullYear(), base.getMonth() - rango.meses, 1)
    const ultimoDia = new Date(destino.getFullYear(), destino.getMonth() + 1, 0).getDate()
    destino.setDate(Math.min(base.getDate(), ultimoDia))
    return destino.getTime()
}

/**
 * Los puntos de la serie que caen en el rango. Si había saldo antes, el rango
 * empieza con él en su primer día, para que la línea no arranque a media gráfica.
 * Ese punto de arranque no trae flujos: no es un movimiento del rango.
 */
function cntPuntosEnRango(serie, desde) {
    if (desde === null || desde === undefined) return [...serie]
    let anterior = null
    const dentro = []
    serie.forEach((p) => {
        if (p.t < desde) anterior = p
        else dentro.push(p)
    })
    if (!anterior || dentro[0]?.t === desde) return dentro
    return [{ t: desde, entradas: 0, salidas: 0, saldo: anterior.saldo }, ...dentro]
}

/** Lo que entra y sale en el rango, sumando los puntos desde `desde`. */
function cntFlujosEnRango(serie, desde) {
    return serie
        .filter((p) => desde === null || desde === undefined || p.t >= desde)
        .reduce((acc, p) => ({ entradas: acc.entradas + p.entradas, salidas: acc.salidas + p.salidas }), {
            entradas: 0,
            salidas: 0
        })
}

/**
 * Entradas y salidas agrupadas por mes, en orden: `[{clave: "aaaa-mm", t, entradas, salidas}]`.
 * Solo aparecen los meses con algún movimiento.
 */
function cntFlujosPorMes(puntos) {
    const meses = new Map()
    puntos.forEach((p) => {
        if (!p.entradas && !p.salidas) return
        const fecha = new Date(p.t)
        const clave = `${fecha.getFullYear()}-${String(fecha.getMonth() + 1).padStart(2, "0")}`
        const mes = meses.get(clave) || {
            clave,
            t: new Date(fecha.getFullYear(), fecha.getMonth(), 1).getTime(),
            entradas: 0,
            salidas: 0
        }
        mes.entradas += p.entradas
        mes.salidas += p.salidas
        meses.set(clave, mes)
    })
    return [...meses.values()].sort((a, b) => a.t - b.t)
}

/**
 * Trazado SVG en escalones para la miniatura de una tarjeta.
 * @param {Array<{t: number, saldo: number}>} puntos
 * @param {number} ancho
 * @param {number} alto
 * @param {number} margen Hueco arriba y abajo para que el trazo no se corte.
 * @returns {string} El atributo `d` del path, o "" si no hay puntos.
 */
function cntTrazadoMini(puntos, ancho, alto, margen = 4) {
    if (!puntos.length) return ""
    const t0 = puntos[0].t
    const t1 = puntos[puntos.length - 1].t
    const saldos = puntos.map((p) => p.saldo)
    const min = Math.min(...saldos)
    const max = Math.max(...saldos)
    const x = (t) => (t1 === t0 ? 0 : ((t - t0) / (t1 - t0)) * ancho)
    // Saldo plano: una raya a media altura, no pegada al borde.
    const y = (v) => (max === min ? alto / 2 : margen + (1 - (v - min) / (max - min)) * (alto - 2 * margen))
    const r = (n) => Math.round(n * 10) / 10

    let d = `M${r(x(puntos[0].t))},${r(y(puntos[0].saldo))}`
    puntos.slice(1).forEach((p) => {
        d += `H${r(x(p.t))}V${r(y(p.saldo))}`
    })
    // Un solo punto: la raya ocupa todo el ancho.
    if (puntos.length === 1) d += `H${ancho}`
    return d
}

/**
 * Cuánto ha cambiado el saldo entre el primer y el último punto.
 * @param {Array<{saldo: number}>} puntos Los de un rango (cntPuntosEnRango).
 * @returns {{absoluta: number, porcentaje: number|null}} El porcentaje es null
 *     cuando se partía de cero o de un saldo negativo: no significa nada.
 */
function cntVariacion(puntos) {
    if (!puntos.length) return { absoluta: 0, porcentaje: null }
    const inicio = puntos[0].saldo
    const absoluta = puntos[puntos.length - 1].saldo - inicio
    return { absoluta, porcentaje: inicio > 0 ? (absoluta / inicio) * 100 : null }
}

/**
 * Trazado cerrado por abajo para rellenar el área bajo la miniatura.
 * @returns {string} El atributo `d`, o "" si no hay trazado.
 */
function cntAreaMini(trazado, alto) {
    if (!trazado) return ""
    const inicioX = trazado.slice(1).split(",")[0]
    return `${trazado}V${alto}H${inicioX}Z`
}

/**
 * Suma las series de varias cuentas en la serie del total.
 *
 * Hay un punto en cada día en que alguna cuenta tiene uno. Cada cuenta aporta
 * su último saldo conocido; antes de su primer punto, el de partida (su saldo
 * inicial), que es dinero que ya estaba ahí. Los flujos solo cuentan el día en
 * que la cuenta tiene un punto propio.
 * @param {Array<Array<{t: number, entradas: number, salidas: number, saldo: number}>>} series
 * @returns {Array<{t: number, entradas: number, salidas: number, saldo: number}>}
 */
function cntSerieTotal(series) {
    const conPuntos = series.filter((s) => Array.isArray(s) && s.length)
    const tiempos = [...new Set(conPuntos.flatMap((s) => s.map((p) => p.t)))].sort((a, b) => a - b)
    // Un índice por serie que solo avanza: se recorre cada serie una vez.
    const indices = conPuntos.map(() => -1)
    return tiempos.map((t) => {
        const punto = { t, entradas: 0, salidas: 0, saldo: 0 }
        conPuntos.forEach((serie, k) => {
            while (indices[k] + 1 < serie.length && serie[indices[k] + 1].t <= t) indices[k] += 1
            const actual = indices[k] >= 0 ? serie[indices[k]] : serie[0]
            punto.saldo += actual.saldo
            if (indices[k] >= 0 && actual.t === t) {
                punto.entradas += actual.entradas
                punto.salidas += actual.salidas
            }
        })
        return punto
    })
}

// Fracción mínima del círculo que ocupa una porción: una cuenta con 3 € al lado
// de otra con 30.000 € no se vería. El tooltip y la leyenda dan el valor real.
const CNT_DONUT_MIN_FRACCION = 0.015
const CNT_DONUT_MAX_PARTES = 5
const CNT_COLOR_OTRAS = "#64748b"

/**
 * Deja las porciones más grandes y suma el resto en «Otras (n)», para que el
 * donut y su leyenda no crezcan sin límite. Solo cuentan las porciones
 * positivas: un quesito no sabe dibujar un saldo negativo.
 * @param {Array<{etiqueta: string, valor: number, color: string}>} partes
 * @param {number} maximo Porciones que se enseñan sueltas.
 * @returns {Array<{etiqueta: string, valor: number, color: string}>} De mayor a menor.
 */
function cntAgruparPartes(partes, maximo = CNT_DONUT_MAX_PARTES) {
    const positivas = partes.filter((p) => Number.isFinite(p.valor) && p.valor > 0).sort((a, b) => b.valor - a.valor)
    // Agrupar una sola porción no ahorra sitio: se enseña tal cual.
    if (positivas.length <= maximo + 1) return positivas
    const resto = positivas.slice(maximo)
    return [
        ...positivas.slice(0, maximo),
        {
            etiqueta: `Otras (${resto.length})`,
            valor: resto.reduce((suma, p) => suma + p.valor, 0),
            color: CNT_COLOR_OTRAS
        }
    ]
}

/**
 * Porcentaje de una porción para leyendas: «<0,1 %» en vez de «0,0 %», que haría
 * pensar que la porción está vacía.
 * @param {number} parte
 * @param {number} total
 * @returns {string}
 */
function cntPorcentajeTexto(parte, total) {
    if (!(total > 0) || !(parte > 0)) return "0 %"
    const pct = (parte / total) * 100
    if (pct < 0.1) return "<0,1 %"
    return `${pct.toFixed(1).replace(".", ",")} %`
}

/**
 * Fecha local en formato aaaa-mm-dd, la que entienden las rutas de la API.
 * @param {number} t Milisegundos.
 * @returns {string}
 */
function cntFechaIso(t) {
    const fecha = new Date(t)
    const dos = (n) => String(n).padStart(2, "0")
    return `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`
}

// ── Chart.js ─────────────────────────────────────────────────────────────

function cntEstilosGrafica(elemento) {
    const estilos = getComputedStyle(elemento)
    return {
        texto: estilos.getPropertyValue("--text-muted").trim() || "#888",
        rejilla: estilos.getPropertyValue("--border-soft").trim() || "rgba(128,128,128,0.2)",
        fondo: estilos.getPropertyValue("--bg-panel").trim() || estilos.backgroundColor,
        textoFuerte: estilos.getPropertyValue("--text-bright").trim() || "#e5e7eb",
        tooltipFondo: estilos.getPropertyValue("--bg-elevated").trim() || "#1f2937",
        tooltipBorde: estilos.getPropertyValue("--border-mid").trim() || "rgba(128,128,128,0.4)"
    }
}

// El eje dice el mes cuando el tramo visible es largo y el día cuando es corto:
// en «1 mes» todas las marcas serían «nov».
function cntEtiquetaEje(t, tramoMs) {
    const opciones = tramoMs > 75 * CNT_DIA_MS ? { month: "short" } : { day: "numeric", month: "short" }
    if (tramoMs > 400 * CNT_DIA_MS) opciones.year = "2-digit"
    return new Date(t).toLocaleDateString("es-ES", opciones).replace(".", "")
}

/**
 * Dónde van las marcas del eje X. Con el escalado automático de Chart.js caen en
 * instantes arbitrarios (ene, abr, may, jul…); aquí van al día 1 de cada mes, o
 * cada 2, 3, 6 o 12 meses según el tramo, y en tramos cortos cada pocos días.
 * @param {number} t0 Inicio del eje (ms).
 * @param {number} t1 Fin del eje (ms).
 * @param {number} maximo Número de marcas que caben sin amontonarse.
 * @returns {number[]} Instantes de las marcas, en orden.
 */
function cntMarcasEje(t0, t1, maximo = 12) {
    const dias = (t1 - t0) / CNT_DIA_MS
    const marcas = []
    if (dias <= 75) {
        const paso = Math.max(1, Math.ceil(dias / maximo)) * CNT_DIA_MS
        for (let t = t0; t <= t1; t += paso) marcas.push(t)
        return marcas
    }
    const meses = dias / 30.44
    const paso = [1, 2, 3, 6, 12].find((p) => meses / p <= maximo) || 12 * Math.ceil(meses / (12 * maximo))
    const inicio = new Date(t0)
    // Primer día 1 desde t0 cuyo mes encaja con el paso (con paso 12, enero).
    const cursor = new Date(inicio.getFullYear(), inicio.getMonth() + (inicio.getDate() === 1 ? 0 : 1), 1)
    while (cursor.getMonth() % Math.min(paso, 12) !== 0) cursor.setMonth(cursor.getMonth() + 1)
    while (cursor.getTime() <= t1) {
        marcas.push(cursor.getTime())
        cursor.setMonth(cursor.getMonth() + paso)
    }
    return marcas
}

function cntFechaLarga(t) {
    return new Date(t).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" })
}

/**
 * Importe corto para los ejes: «1,2 mil €» en vez de «1200,00 €». Los menores
 * de mil van enteros salvo que sean céntimos.
 * @param {number} valor
 * @returns {string}
 */
function cntEuroCorto(valor) {
    const absoluto = Math.abs(valor)
    if (absoluto >= 1000) {
        return `${new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 }).format(valor)} €`
    }
    const decimales = absoluto > 0 && absoluto < 10 && !Number.isInteger(valor) ? 2 : 0
    return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: decimales, minimumFractionDigits: decimales }).format(valor)} €`
}

// Tooltip común: fondo del panel, borde fino y sin el cuadradito de color.
function cntTooltipBase(estilos) {
    return {
        backgroundColor: estilos.tooltipFondo,
        borderColor: estilos.tooltipBorde,
        borderWidth: 1,
        titleColor: estilos.textoFuerte,
        bodyColor: estilos.textoFuerte,
        titleFont: { size: 11, weight: "600" },
        bodyFont: { size: 13, weight: "700" },
        padding: 10,
        cornerRadius: 8,
        displayColors: false,
        caretSize: 0
    }
}

// Degradado vertical bajo la línea: más intenso arriba, transparente abajo.
function cntDegradado(contexto, color) {
    const { ctx, chartArea } = contexto.chart
    if (!chartArea) return "transparent"
    const degradado = ctx.createLinearGradient(0, chartArea.top, 0, chartArea.bottom)
    degradado.addColorStop(0, `${color}55`)
    degradado.addColorStop(1, `${color}00`)
    return degradado
}

/**
 * Gráfica de saldo de la ventana de una cuenta.
 * @returns {Chart|null}
 */
function cntPintarSaldo(canvas, puntos) {
    if (!canvas || typeof Chart === "undefined" || !puntos.length) return null
    const estilos = cntEstilosGrafica(canvas)
    const t0 = puntos[0].t
    const t1 = puntos[puntos.length - 1].t
    const tramo = Math.max(t1 - t0, CNT_DIA_MS)
    // Una marca cada ~70 px: en la columna lateral caben 4, en la ventana 12.
    const ancho = canvas.parentElement?.clientWidth || 0
    const maxMarcas = ancho ? Math.max(3, Math.min(12, Math.floor(ancho / 70))) : 12
    const marcas = cntMarcasEje(t0, t0 + tramo, maxMarcas)
    const ultimo = puntos.length - 1

    return new Chart(canvas, {
        type: "line",
        data: {
            datasets: [
                {
                    data: puntos.map((p) => ({ x: p.t, y: p.saldo })),
                    borderColor: CNT_COLOR_LINEA,
                    backgroundColor: (contexto) => cntDegradado(contexto, CNT_COLOR_LINEA),
                    borderWidth: 2,
                    fill: true,
                    stepped: true,
                    // Solo se marca el último punto: el saldo de hoy.
                    pointRadius: puntos.map((_p, i) => (i === ultimo ? 3.5 : 0)),
                    pointBackgroundColor: CNT_COLOR_LINEA,
                    pointBorderColor: estilos.fondo,
                    pointBorderWidth: 2,
                    pointHoverRadius: 5,
                    pointHitRadius: 10
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "nearest", axis: "x", intersect: false },
            layout: { padding: { top: 6, right: 6 } },
            scales: {
                x: {
                    type: "linear",
                    min: t0,
                    max: t1 === t0 ? t0 + CNT_DIA_MS : t1,
                    grid: { display: false },
                    border: { color: estilos.rejilla },
                    afterBuildTicks: (eje) => {
                        eje.ticks = marcas.map((value) => ({ value }))
                    },
                    ticks: {
                        color: estilos.texto,
                        font: { size: 11 },
                        autoSkip: false,
                        maxRotation: 0,
                        callback: (valor) => cntEtiquetaEje(valor, tramo)
                    }
                },
                y: {
                    position: "right",
                    grace: "8%",
                    grid: { color: estilos.rejilla, drawTicks: false },
                    border: { display: false, dash: [3, 4] },
                    ticks: {
                        color: estilos.texto,
                        font: { size: 11 },
                        padding: 8,
                        maxTicksLimit: 6,
                        callback: (valor) => cntEuroCorto(valor)
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    ...cntTooltipBase(estilos),
                    callbacks: {
                        title: (items) => cntFechaLarga(items[0].parsed.x),
                        label: (item) => formatEuro(item.parsed.y)
                    }
                }
            }
        }
    })
}

/**
 * Barras de entradas y salidas por mes, con la línea del neto encima.
 * @returns {Chart|null}
 */
function cntPintarFlujosMes(canvas, meses) {
    if (!canvas || typeof Chart === "undefined" || !meses.length) return null
    const estilos = cntEstilosGrafica(canvas)
    const etiquetas = meses.map((m) =>
        new Date(m.t).toLocaleDateString("es-ES", { month: "short", year: "2-digit" }).replace(".", "")
    )
    const barra = { borderRadius: 4, borderSkipped: false, maxBarThickness: 26, categoryPercentage: 0.7 }
    return new Chart(canvas, {
        data: {
            labels: etiquetas,
            datasets: [
                {
                    type: "line",
                    label: "Neto",
                    data: meses.map((m) => m.entradas - m.salidas),
                    borderColor: estilos.textoFuerte,
                    backgroundColor: estilos.textoFuerte,
                    borderWidth: 1.5,
                    pointRadius: 2.5,
                    pointHoverRadius: 4,
                    tension: 0.3,
                    order: 0
                },
                {
                    type: "bar",
                    label: "Entradas",
                    data: meses.map((m) => m.entradas),
                    backgroundColor: CNT_COLOR_ENTRADA,
                    order: 1,
                    ...barra
                },
                {
                    type: "bar",
                    label: "Salidas",
                    data: meses.map((m) => -m.salidas),
                    backgroundColor: CNT_COLOR_SALIDA,
                    order: 1,
                    ...barra
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            scales: {
                x: {
                    stacked: true,
                    grid: { display: false },
                    border: { color: estilos.rejilla },
                    ticks: { color: estilos.texto, font: { size: 11 } }
                },
                y: {
                    stacked: true,
                    position: "right",
                    grid: { color: estilos.rejilla, drawTicks: false },
                    border: { display: false },
                    ticks: {
                        color: estilos.texto,
                        font: { size: 11 },
                        padding: 8,
                        maxTicksLimit: 6,
                        callback: (valor) => cntEuroCorto(valor)
                    }
                }
            },
            plugins: {
                legend: {
                    position: "top",
                    align: "end",
                    labels: {
                        color: estilos.texto,
                        font: { size: 11 },
                        boxWidth: 8,
                        boxHeight: 8,
                        usePointStyle: true,
                        pointStyle: "circle"
                    }
                },
                tooltip: {
                    ...cntTooltipBase(estilos),
                    displayColors: true,
                    usePointStyle: true,
                    bodyFont: { size: 12, weight: "600" },
                    callbacks: {
                        // Las salidas se dibujan en negativo, pero se leen como importe.
                        label: (item) =>
                            ` ${item.dataset.label}: ${formatEuro(item.dataset.label === "Salidas" ? -item.parsed.y : item.parsed.y)}`
                    }
                }
            }
        }
    })
}

/**
 * Donut de reparto, sin leyenda propia: la página pinta la suya con importes.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{etiqueta: string, valor: number, color: string}>} partes
 * @param {(parte: object|null) => void} alResaltar Recibe la porción bajo el
 *     ratón (o null al salir); quien llama la enseña en el centro, por eso no
 *     hay tooltip.
 * @returns {Chart|null}
 */
function cntPintarDonut(canvas, partes, alResaltar) {
    if (!canvas || typeof Chart === "undefined") return null
    const datos = partes.filter((p) => Number.isFinite(p.valor) && p.valor > 0)
    const total = datos.reduce((suma, p) => suma + p.valor, 0)
    if (!datos.length || total <= 0) return null
    const estilos = cntEstilosGrafica(canvas)
    let resaltada = -1

    return new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: datos.map((p) => p.etiqueta),
            datasets: [
                {
                    data: datos.map((p) => Math.max(p.valor, total * CNT_DONUT_MIN_FRACCION)),
                    backgroundColor: datos.map((p) => p.color),
                    borderColor: estilos.fondo,
                    borderWidth: 2,
                    borderRadius: 3,
                    hoverOffset: 4,
                    spacing: 1
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            cutout: "76%",
            layout: { padding: 4 },
            onHover: (_evento, elementos) => {
                const indice = elementos.length ? elementos[0].index : -1
                if (indice === resaltada) return
                resaltada = indice
                alResaltar?.(indice === -1 ? null : datos[indice])
            },
            plugins: { legend: { display: false }, tooltip: { enabled: false } }
        }
    })
}

/**
 * Resalta desde fuera (la leyenda) la porción con esa etiqueta, o ninguna.
 * @param {Chart|null} chart
 * @param {string|null} etiqueta
 */
function cntResaltarPorcion(chart, etiqueta) {
    if (!chart) return
    const indice = etiqueta === null ? -1 : chart.data.labels.indexOf(etiqueta)
    chart.setActiveElements(indice === -1 ? [] : [{ datasetIndex: 0, index: indice }])
    chart.update()
}
