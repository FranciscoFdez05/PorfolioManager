// Ficha del activo, pestaña «Gráfico»: los modos «Comparativa anual» y «Comparativa
// índices». El modo «Compras / ventas» sigue en assets-grafico.js; aquí solo se pinta
// lo que ese archivo delega cuando se elige otro modo.
//
// Los dos modos parten de los mismos datos que ya pide el gráfico (la serie de
// precios del activo); los índices salen de /api/market/benchmark, la misma fuente
// que la comparativa de Métricas.

// Índices activos la primera vez que se abre el modo.
const assetGraficoIndicesDefecto = ["sp500", "nasdaq"]
// Colores de los índices, por posición en el catálogo: así cada índice conserva el suyo
// aunque se activen o desactiven otros. La línea del activo usa el acento del tema.
const assetGraficoColoresIndices = ["#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16", "#f97316"]
// Margen por delante del primer punto para tener un cierre previo con el que arrancar
// aunque el rango empiece en fin de semana o festivo.
const assetGraficoMargenIndiceSegundos = 7 * 86400
// Con menos de esto entre el primer y el último punto no hay dos cierres que comparar.
const assetGraficoMinimoComparativaSegundos = 2 * 86400

// Estacionales: posiciones del eje (un año bisiesto de referencia, 366 días) y cuánto
// se guardan las velas de un ticker. Las velas son diarias, así que media hora basta.
const assetGraficoDiasEstacional = 366
const assetGraficoHistoricoTtlMs = 30 * 60 * 1000
// Años marcados mientras no se haya elegido ninguno, contando el más reciente.
const assetGraficoAniosDefecto = 5

let _assetGraficoIndicesCatalogo = null
let _assetGraficoModoToken = 0
// Ticker -> { ts, puntos }. Guarda también los tickers sin velas (puntos vacíos) para no
// volver a preguntar por ellos cada vez que se cambia el número de años.
const _assetGraficoHistorico = new Map()
// Años con datos del activo abierto en «Estacionales», para validar los clics en los botones.
let _assetGraficoAniosDisponibles = []

/**
 * Rentabilidad del precio del activo en cada año natural.
 *
 * Cada año parte del último precio del anterior; si no hay datos del anterior, del
 * primer precio que haya, y entonces se marca como parcial porque mide menos de doce
 * meses.
 *
 * @param {{ts: number, precio: number}[]} puntos Puntos del gráfico, por orden de fecha.
 * @returns {{anio: number, rentabilidad: number, inicio: number, cierre: number, parcial: boolean}[]}
 *     Un elemento por año con al menos dos precios distintos en el tiempo.
 */
function assetGraficoRentabilidadAnual(puntos) {
    const porAnio = new Map()
    ;(puntos || []).forEach((punto) => {
        if (!Number.isFinite(punto.precio) || punto.precio <= 0) return
        const anio = new Date(punto.ts * 1000).getFullYear()
        const actual = porAnio.get(anio)
        if (actual) actual.ultimo = punto
        else porAnio.set(anio, { primero: punto, ultimo: punto })
    })

    const filas = []
    ;[...porAnio.keys()]
        .sort((a, b) => a - b)
        .forEach((anio) => {
            const { primero, ultimo } = porAnio.get(anio)
            const previo = porAnio.get(anio - 1)
            const inicio = previo ? previo.ultimo : primero
            // Un único precio en el año no delimita ningún periodo.
            if (inicio === ultimo) return
            filas.push({
                anio,
                rentabilidad: (ultimo.precio / inicio.precio - 1) * 100,
                inicio: inicio.precio,
                cierre: ultimo.precio,
                parcial: !previo
            })
        })
    return filas
}

/**
 * Variación porcentual de un índice en las fechas de los puntos del activo.
 *
 * El índice no cotiza fines de semana ni festivos: en cada fecha se toma el último
 * cierre conocido, para que la línea no tenga huecos. La base es el primer cierre
 * que corresponde a un punto, de modo que ambas series arrancan juntas en 0 %.
 *
 * @param {number[]} fechas Segundos de cada punto del activo, por orden.
 * @param {{ts: number, close: number}[]} cierres Cierres del índice, por orden.
 * @returns {(number|null)[]} Un valor por fecha; null si aún no hay cierre.
 */
function assetGraficoVariacionIndice(fechas, cierres) {
    let posicion = -1
    let base = null
    return fechas.map((ts) => {
        while (posicion + 1 < cierres.length && cierres[posicion + 1].ts <= ts) posicion += 1
        if (posicion < 0) return null
        const cierre = cierres[posicion].close
        if (!(cierre > 0)) return null
        if (base === null) base = cierre
        return (cierre / base - 1) * 100
    })
}

/**
 * Qué índices están activos: lo guardado, limitado a los que existen en el catálogo.
 *
 * @param {{clave: string}[]} catalogo Índices que ofrece el servidor.
 * @returns {string[]} Claves activas, en el orden del catálogo.
 */
function assetGraficoIndicesActivos(catalogo) {
    const guardado = getChartPref("assetGraficoIndices", null)
    const claves = typeof guardado === "string" ? guardado.split(",").filter(Boolean) : assetGraficoIndicesDefecto
    return catalogo.map((indice) => indice.clave).filter((clave) => claves.includes(clave))
}

async function assetGraficoCatalogoIndices() {
    if (_assetGraficoIndicesCatalogo) return _assetGraficoIndicesCatalogo
    try {
        const respuesta = await fetch("/api/market/benchmarks")
        const cuerpo = await respuesta.json()
        if (!respuesta.ok || !cuerpo.ok) throw new Error(cuerpo.error || `HTTP ${respuesta.status}`)
        _assetGraficoIndicesCatalogo = cuerpo.indices
    } catch (error) {
        // Sin catálogo no hay con qué comparar; se avisa en el gráfico y se reintenta al volver.
        console.error("No se pudo cargar el catálogo de índices", error)
        return []
    }
    return _assetGraficoIndicesCatalogo
}

async function assetGraficoPedirIndice(clave, desde, hasta) {
    const params = new URLSearchParams({ indice: clave, from: Math.floor(desde), to: Math.ceil(hasta) })
    const respuesta = await fetch(`/api/market/benchmark?${params}`)
    const cuerpo = await respuesta.json()
    if (!respuesta.ok || !cuerpo.ok || !Array.isArray(cuerpo.data)) {
        throw new Error(cuerpo.error || `HTTP ${respuesta.status}`)
    }
    return cuerpo
}

// Los botones de índice se montan con el DOM y no con innerHTML para poder poner el
// color de cada uno sin atributos de estilo en el texto.
function assetGraficoPintarBotonesIndices(catalogo, activos) {
    const contenedor = document.getElementById("assetGraficoIndices")
    if (!contenedor) return
    contenedor.replaceChildren(
        ...catalogo.map((indice, posicion) => {
            const activo = activos.includes(indice.clave)
            const boton = document.createElement("button")
            boton.type = "button"
            boton.className = `mToggleBtn${activo ? " active" : ""}`
            boton.dataset.graficoIndice = indice.clave
            boton.setAttribute("aria-pressed", String(activo))
            const punto = document.createElement("span")
            punto.className = "assetGraficoPunto"
            punto.style.background = assetGraficoColoresIndices[posicion % assetGraficoColoresIndices.length]
            boton.append(punto, ` ${indice.nombre}`)
            return boton
        })
    )
}

/**
 * Activa o desactiva un índice y vuelve a pintar la comparativa.
 *
 * @param {string} clave Clave del índice en el catálogo.
 */
async function assetGraficoAlternarIndice(clave) {
    const catalogo = await assetGraficoCatalogoIndices()
    const activos = assetGraficoIndicesActivos(catalogo)
    const siguientes = activos.includes(clave) ? activos.filter((activa) => activa !== clave) : [...activos, clave]
    // Cadena vacía y no null: «ninguno» es una elección, no la ausencia de ella.
    setChartPref("assetGraficoIndices", siguientes.join(","))
    assetGraficoDibujar()
}

// Deja el lienzo listo para un modo nuevo y devuelve lo que necesita para pintar.
function assetGraficoPrepararModo() {
    const lienzo = document.getElementById("assetGraficoLienzo")
    const canvas = document.getElementById("assetGraficoCanvas")
    if (!lienzo || !canvas) return null
    document.getElementById("assetGraficoVacio")?.classList.add("hidden")
    lienzo.classList.remove("hidden")
    assetGraficoDestruir()
    const estilos = getComputedStyle(lienzo)
    const color = (variable) => estilos.getPropertyValue(variable).trim()
    return {
        canvas,
        colorLinea: color("--accent"),
        colorTexto: color("--text-muted"),
        colorRejilla: color("--border-soft"),
        colorPositivo: color("--graficoCompra"),
        colorNegativo: color("--graficoVenta")
    }
}

function assetGraficoEscribirCabecera({ etiqueta, valor = "—", cambio = "", fecha = "", positivo = true }) {
    assetGraficoEscribir("assetGraficoEtiqueta", etiqueta)
    assetGraficoEscribir("assetGraficoValor", valor)
    assetGraficoEscribir("assetGraficoFecha", fecha)
    assetGraficoEscribir("assetGraficoCambio", cambio)
    const elemento = document.getElementById("assetGraficoCambio")
    elemento?.classList.toggle("assetGraficoCambioPositivo", Boolean(cambio) && positivo)
    elemento?.classList.toggle("assetGraficoCambioNegativo", Boolean(cambio) && !positivo)
}

function assetGraficoLeyendaModo(items) {
    const leyenda = document.getElementById("assetGraficoLeyenda")
    if (!leyenda) return
    leyenda.replaceChildren(
        ...items.map(({ nombre, color }) => {
            const item = document.createElement("span")
            item.className = "assetGraficoLeyendaItem"
            const punto = document.createElement("span")
            punto.className = "assetGraficoPunto"
            punto.style.background = color
            item.append(punto, nombre)
            return item
        })
    )
}

// Como en los estacionales, las velas de TradingView mandan: el histórico propio empieza en
// la primera compra y daría un primer año («YTD») medido desde ese día y no desde el
// cierre del año anterior.
async function assetGraficoDibujarAnual() {
    const token = ++_assetGraficoModoToken
    assetGraficoEscribirCabecera({ etiqueta: "Rentabilidad del precio por año" })
    const historico = await assetGraficoPuntosHistoricos()
    if (token !== _assetGraficoModoToken) return
    const conVelas = Boolean(historico?.divisa) && historico.puntos.length >= 2
    const moneda = conVelas ? historico.divisa : "EUR"
    const base = assetGraficoPrepararModo()
    if (!base || typeof Chart === "undefined") return
    const filas = assetGraficoRentabilidadAnual(conVelas ? historico.puntos : _assetGraficoDatos?.puntos)
    assetGraficoLeyendaModo([])
    if (!filas.length) {
        assetGraficoMostrarVacio("Todavía no hay datos de este activo en dos años o en un año con varios precios.")
        return
    }

    const anioActual = new Date().getFullYear()
    const etiquetas = filas.map((fila) => `${fila.anio}${fila.anio === anioActual ? " (YTD)" : ""}${fila.parcial ? " *" : ""}`)
    const ultima = filas[filas.length - 1]
    assetGraficoEscribirCabecera({
        etiqueta: "Rentabilidad del precio por año",
        valor: assetGraficoFormatearPct(ultima.rentabilidad),
        fecha: etiquetas[etiquetas.length - 1],
        positivo: ultima.rentabilidad >= 0
    })

    _assetGraficoChart = new Chart(base.canvas, {
        type: "bar",
        data: {
            labels: etiquetas,
            datasets: [
                {
                    label: "Rentabilidad (%)",
                    data: filas.map((fila) => +fila.rentabilidad.toFixed(2)),
                    backgroundColor: filas.map((fila) => (fila.rentabilidad >= 0 ? base.colorPositivo : base.colorNegativo)),
                    borderRadius: 6,
                    maxBarThickness: 90
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            scales: {
                x: { grid: { display: false }, ticks: { color: base.colorTexto } },
                y: {
                    position: "right",
                    grid: { color: base.colorRejilla },
                    border: { display: false },
                    ticks: { color: base.colorTexto, callback: (valor) => assetGraficoFormatearPct(valor) }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    displayColors: false,
                    callbacks: {
                        label: (contexto) => {
                            const fila = filas[contexto.dataIndex]
                            return [
                                assetGraficoFormatearPct(fila.rentabilidad),
                                `${assetGraficoFormatearDinero(fila.inicio, moneda)} → ${assetGraficoFormatearDinero(fila.cierre, moneda)}`
                            ]
                        }
                    }
                }
            }
        }
    })

    const parcial = filas.some((fila) => fila.parcial)
    assetGraficoEscribir(
        "assetGraficoNota",
        `Variación del precio${conVelas ? ` en ${moneda} (velas de TradingView)` : " en euros (histórico propio, que empieza en la primera compra)"} entre el cierre de un año y el del siguiente; no incluye aportaciones ni comisiones.${
            parcial ? " * El año arranca en el primer precio disponible, no en el cierre del anterior." : ""
        }`
    )
}

// Texto de la nota: lo que ha hecho el activo frente a cada índice, y qué índices no se
// han podido cargar.
function assetGraficoNotaIndices(seriesIndices, fallidos, valorActivo) {
    const partes = seriesIndices.map(({ nombre, ultimo }) => {
        // Diferencia relativa, no resta de porcentajes: se comparan los dos multiplicadores.
        const diferencia = ((1 + valorActivo / 100) / (1 + ultimo / 100) - 1) * 100
        return `${diferencia >= 0 ? "Por encima" : "Por debajo"} de ${nombre} en ${assetGraficoFormatearPct(Math.abs(diferencia), false)}`
    })
    const texto = partes.length ? `${partes.join(". ")}. ` : ""
    const aviso = fallidos.length ? `No se pudo cargar: ${fallidos.join(", ")}. ` : ""
    return `${texto}${aviso}Variación del precio desde el inicio del periodo; el índice va en su divisa de cotización.`
}

async function assetGraficoDibujarIndices() {
    const token = ++_assetGraficoModoToken
    const visibles = assetGraficoRecortar(_assetGraficoDatos, _assetGraficoVentana)
    const puntos = (visibles.puntos || []).filter((punto) => Number.isFinite(punto.precio) && punto.precio > 0)
    const etiqueta = "Variación del precio frente a índices"

    if (puntos.length < 2 || puntos[puntos.length - 1].ts - puntos[0].ts < assetGraficoMinimoComparativaSegundos) {
        assetGraficoEscribirCabecera({ etiqueta })
        assetGraficoMostrarVacio("Hacen falta al menos dos días de precios para comparar con un índice. Prueba con un rango más amplio.")
        return
    }

    const catalogo = await assetGraficoCatalogoIndices()
    if (token !== _assetGraficoModoToken) return
    const activos = assetGraficoIndicesActivos(catalogo)
    assetGraficoPintarBotonesIndices(catalogo, activos)

    const desde = puntos[0].ts
    const hasta = puntos[puntos.length - 1].ts
    // allSettled: un índice caído no debe tumbar la comparativa de los demás.
    const resultados = await Promise.allSettled(
        activos.map((clave) => assetGraficoPedirIndice(clave, desde - assetGraficoMargenIndiceSegundos, hasta))
    )
    if (token !== _assetGraficoModoToken) return

    const base = assetGraficoPrepararModo()
    if (!base || typeof Chart === "undefined") return

    const precioBase = assetGraficoPrecioBase(puntos)
    const fechas = puntos.map((punto) => punto.ts)
    const serieActivo = puntos.map((punto) => (punto.precio / precioBase - 1) * 100)
    const valorActivo = serieActivo[serieActivo.length - 1]

    const seriesIndices = []
    const fallidos = []
    resultados.forEach((resultado, posicion) => {
        const clave = activos[posicion]
        const nombre = catalogo.find((indice) => indice.clave === clave)?.nombre || clave
        const ok = resultado.status === "fulfilled" && resultado.value.data.length > 0
        if (!ok) {
            console.error(`Comparativa de índices: no se pudo cargar ${clave}`, resultado.reason)
            fallidos.push(nombre)
            return
        }
        const variacion = assetGraficoVariacionIndice(fechas, resultado.value.data)
        const ultimo = [...variacion].reverse().find((valor) => valor !== null)
        if (ultimo === undefined) {
            fallidos.push(nombre)
            return
        }
        const indiceCatalogo = catalogo.findIndex((indice) => indice.clave === clave)
        seriesIndices.push({
            nombre,
            ultimo,
            variacion,
            color: assetGraficoColoresIndices[indiceCatalogo % assetGraficoColoresIndices.length]
        })
    })

    assetGraficoEscribirCabecera({
        etiqueta,
        valor: assetGraficoFormatearPct(valorActivo),
        fecha: `${assetGraficoFormatearFecha(desde, false)} → ${assetGraficoFormatearFecha(hasta, false)}`,
        positivo: valorActivo >= 0
    })
    assetGraficoLeyendaModo([
        { nombre: "Este activo", color: base.colorLinea },
        ...seriesIndices.map(({ nombre, color }) => ({ nombre, color }))
    ])
    assetGraficoEscribir("assetGraficoNota", assetGraficoNotaIndices(seriesIndices, fallidos, valorActivo))

    const dataset = (nombre, valores, color, grosor) => ({
        label: nombre,
        data: fechas.map((ts, indice) => ({ x: ts, y: valores[indice] })),
        borderColor: color,
        borderWidth: grosor,
        pointRadius: 0,
        pointHoverRadius: 4,
        tension: 0,
        spanGaps: false
    })

    _assetGraficoChart = new Chart(base.canvas, {
        type: "line",
        data: {
            datasets: [
                dataset("Este activo", serieActivo, base.colorLinea, 2.5),
                ...seriesIndices.map(({ nombre, variacion, color }) => dataset(nombre, variacion, color, 1.5))
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { top: 8, bottom: 8, left: 8 } },
            interaction: { mode: "index", intersect: false },
            scales: {
                x: {
                    type: "linear",
                    min: fechas[0],
                    max: fechas[fechas.length - 1],
                    grid: { display: false },
                    border: { color: base.colorRejilla },
                    ticks: {
                        color: base.colorTexto,
                        maxTicksLimit: 7,
                        maxRotation: 0,
                        callback: (valor) => assetGraficoFormatearEje(valor, hasta - desde)
                    }
                },
                y: {
                    position: "right",
                    grace: "8%",
                    grid: { color: base.colorRejilla },
                    border: { display: false },
                    ticks: { color: base.colorTexto, maxTicksLimit: 6, callback: (valor) => assetGraficoFormatearPct(valor) }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        title: (items) => (items[0] ? assetGraficoFormatearFecha(items[0].raw.x, assetGraficoConHora(assetGraficoEstado().rango)) : ""),
                        label: (contexto) =>
                            Number.isFinite(contexto.raw.y) ? `${contexto.dataset.label}: ${assetGraficoFormatearPct(contexto.raw.y)}` : ""
                    }
                }
            }
        }
    })
}

/**
 * Posición de un día en el eje de los estacionales.
 *
 * Se cuenta sobre un año bisiesto fijo: así el 1 de marzo cae siempre en el mismo
 * sitio y los años no bisiestos simplemente no tienen el 29 de febrero (posición 59).
 *
 * @param {number} mes Mes, de 0 (enero) a 11.
 * @param {number} dia Día del mes, desde 1.
 * @returns {number} De 0 (1 de enero) a 365 (31 de diciembre).
 */
function assetGraficoDiaEstacional(mes, dia) {
    return Math.round((Date.UTC(2000, mes, dia) - Date.UTC(2000, 0, 1)) / 86400000)
}

/**
 * Variación del precio en cada año natural, día a día, para superponer los años.
 *
 * Cada año parte del último precio del anterior (0 %); si no hay datos del anterior,
 * del primer precio del año, y se marca como parcial. Con varios precios en un día
 * queda el último, que es el cierre.
 *
 * @param {{ts: number, precio: number}[]} puntos Precios por orden de fecha.
 * @returns {{anio: number, valores: (number|null)[], precios: (number|null)[], parcial: boolean, ultimo: number, ultimoDia: number}[]}
 *     Un elemento por año, del más antiguo al más reciente. `valores` (el %) y
 *     `precios` (el cierre de ese día) tienen 366 posiciones (ver
 *     assetGraficoDiaEstacional), con null en los días sin precio.
 *
 * @example
 * assetGraficoSeriesEstacionales([{ ts: dic2024, precio: 100 }, { ts: ene2025, precio: 110 }])
 * // [{ anio: 2025, valores: [10, null, ...], precios: [110, null, ...], parcial: false, ultimo: 10, ultimoDia: 0 }]
 */
function assetGraficoSeriesEstacionales(puntos) {
    const porAnio = new Map()
    ;(puntos || []).forEach((punto) => {
        if (!Number.isFinite(punto.precio) || punto.precio <= 0) return
        const fecha = new Date(punto.ts * 1000)
        const anio = fecha.getFullYear()
        if (!porAnio.has(anio)) porAnio.set(anio, [])
        const dia = assetGraficoDiaEstacional(fecha.getMonth(), fecha.getDate())
        porAnio.get(anio).push({ dia, precio: punto.precio })
    })

    const series = []
    ;[...porAnio.keys()]
        .sort((a, b) => a - b)
        .forEach((anio) => {
            const delAnio = porAnio.get(anio)
            const previo = porAnio.get(anio - 1)
            // Sin año anterior, un único precio sería un 0 % sin línea.
            if (!previo && delAnio.length < 2) return
            const base = previo ? previo[previo.length - 1].precio : delAnio[0].precio
            const valores = new Array(assetGraficoDiasEstacional).fill(null)
            const precios = new Array(assetGraficoDiasEstacional).fill(null)
            delAnio.forEach(({ dia, precio }) => {
                valores[dia] = (precio / base - 1) * 100
                precios[dia] = precio
            })
            const ultimoDia = delAnio[delAnio.length - 1].dia
            series.push({ anio, valores, precios, parcial: !previo, ultimo: valores[ultimoDia], ultimoDia })
        })
    return series
}

/**
 * Qué años se ven en los estacionales.
 *
 * La elección se guarda como lista de años y vale para todos los activos. Si ninguno
 * de los guardados existe en este activo (otro con menos historia), se usan los más
 * recientes en vez de dejar el gráfico vacío.
 *
 * @param {number[]} disponibles Años con datos, de menor a mayor.
 * @param {string|null} guardado Años separados por comas; "" si se han quitado todos a
 *     propósito; null si nunca se ha elegido.
 * @returns {number[]} Años que se ven, de menor a mayor.
 *
 * @example
 * assetGraficoAniosSeleccionados([2023, 2024, 2025], "2023,2025") // [2023, 2025]
 */
function assetGraficoAniosSeleccionados(disponibles, guardado) {
    const porDefecto = disponibles.slice(-assetGraficoAniosDefecto)
    if (typeof guardado !== "string") return porDefecto
    if (guardado === "") return []
    const elegidos = new Set(guardado.split(",").map(Number))
    const validos = disponibles.filter((anio) => elegidos.has(anio))
    return validos.length ? validos : porDefecto
}

// Color de cada año por su distancia al más reciente, que lleva el acento: así un año
// conserva su color al cambiar cuántos se ven. Pasada la paleta de los índices, se
// reparten tonos por el ángulo áureo para que con muchos años no se repitan colores.
function assetGraficoColorAnio(distancia, colorReciente) {
    if (distancia === 0) return colorReciente
    const paleta = assetGraficoColoresIndices
    if (distancia <= paleta.length) return paleta[distancia - 1]
    return `hsl(${Math.round((distancia * 137.5) % 360)} 65% 55%)`
}

/**
 * Velas diarias de TradingView del activo abierto, con todo el histórico del feed.
 *
 * @returns {Promise<{puntos: {ts: number, precio: number}[], divisa: string|null}|null>}
 *     Los cierres en la divisa de cotización y esa divisa (puntos vacíos si el ticker
 *     no tiene velas), o null si no hay ticker o falla la petición.
 */
async function assetGraficoPuntosHistoricos() {
    const ticker = assetGraficoSimboloTv()
    if (!ticker) return null
    const guardado = _assetGraficoHistorico.get(ticker)
    if (guardado && Date.now() - guardado.ts < assetGraficoHistoricoTtlMs) return guardado.historico
    try {
        const respuesta = await fetch(`/api/market/historico?${new URLSearchParams({ symbol: ticker })}`)
        const cuerpo = await respuesta.json()
        if (!respuesta.ok || !cuerpo.ok) throw new Error(cuerpo.error || `HTTP ${respuesta.status}`)
        const historico = {
            puntos: (cuerpo.data || []).map(([ts, cierre]) => ({ ts, precio: cierre })),
            divisa: cuerpo.divisa || null
        }
        _assetGraficoHistorico.set(ticker, { ts: Date.now(), historico })
        return historico
    } catch (error) {
        // Sin velas se pinta con el histórico propio, que empieza en la primera compra.
        console.error("Estacionales: no se pudieron cargar las velas del activo", error)
        return null
    }
}

// Un botón por año con datos; como los de índices, se montan con el DOM para poner el
// color de cada uno sin atributos de estilo en el texto.
function assetGraficoPintarBotonesAnios(anios, seleccionados, colorDe) {
    const contenedor = document.getElementById("assetGraficoAnios")
    if (!contenedor) return
    contenedor.replaceChildren(
        ...anios.map((anio) => {
            const activo = seleccionados.includes(anio)
            const boton = document.createElement("button")
            boton.type = "button"
            boton.className = `mToggleBtn${activo ? " active" : ""}`
            boton.dataset.graficoAnio = String(anio)
            boton.setAttribute("aria-pressed", String(activo))
            const punto = document.createElement("span")
            punto.className = "assetGraficoPunto"
            punto.style.background = colorDe(anio)
            boton.append(punto, ` ${anio}`)
            return boton
        })
    )
}

/**
 * Marca o desmarca un año de los estacionales, guarda la elección y repinta.
 *
 * @param {HTMLElement} boton Botón del año (`data-grafico-anio`).
 */
function assetGraficoAlternarAnio(boton) {
    const anio = Number(boton.dataset.graficoAnio)
    if (!_assetGraficoAniosDisponibles.includes(anio)) return
    const actuales = assetGraficoAniosSeleccionados(
        _assetGraficoAniosDisponibles,
        getChartPref("assetGraficoAniosElegidos", null)
    )
    const siguientes = actuales.includes(anio)
        ? actuales.filter((elegido) => elegido !== anio)
        : [...actuales, anio].sort((a, b) => a - b)
    // Cadena vacía y no null: «ninguno» es una elección, no la ausencia de ella.
    setChartPref("assetGraficoAniosElegidos", siguientes.join(","))
    assetGraficoDibujar()
}

function assetGraficoNotaEstacional(conVelas, parcial) {
    const fuente = conVelas
        ? "Precios de TradingView en la divisa de cotización."
        : "Precios en euros del histórico propio, que empieza en la primera compra: sin velas de TradingView no hay años anteriores."
    const asterisco = parcial ? " * El año arranca en el primer precio disponible, no en el cierre del anterior." : ""
    return `Cada línea es un año natural: variación del precio desde el cierre del año anterior (0 %). ${fuente}${asterisco}`
}

/**
 * Vista «Tabla» de los estacionales: rendimiento de cada mes y de cada año.
 *
 * Usa la tabla de la ficha lateral (assets-detalle-mercado.js) con las mismas velas
 * mensuales de TradingView y la misma caché; sin ticker no hay velas mensuales, y el
 * histórico propio no sirve porque empieza en la primera compra.
 *
 * @param {number} token Turno de dibujo; si cambia mientras llegan los datos, se descartan.
 * @returns {Promise<void>}
 */
async function assetGraficoDibujarTablaEstacional(token) {
    const etiqueta = "Rendimiento mensual por años"
    const tabla = document.getElementById("assetGraficoTabla")
    assetGraficoMostrarVacio("")
    document.getElementById("assetGraficoVacio")?.classList.add("hidden")
    document.getElementById("assetGraficoAnios")?.classList.add("hidden")
    // La escala solo tiene sentido en el gráfico; la tabla no tiene eje.
    document.querySelector("[data-grafico-escala-estacional]")?.parentElement.classList.add("hidden")
    assetGraficoEscribirCabecera({ etiqueta })
    // El servidor devuelve la serie con el ticker en mayúsculas, como lo pide la ficha lateral.
    const ticker = assetGraficoSimboloTv().toUpperCase()
    if (!tabla || typeof detMkObtenerMensual !== "function" || !ticker.includes(":")) {
        assetGraficoMostrarVacio("La tabla mensual necesita las velas de TradingView y este activo no tiene ticker con mercado.")
        return
    }
    tabla.innerHTML = detMkMensaje("Cargando…")
    tabla.classList.remove("hidden")

    const puntos = await detMkObtenerMensual(ticker)
    if (token !== _assetGraficoModoToken) return
    tabla.innerHTML = detMkHtmlTablaMensual(puntos)
    const reciente = detMkTablaMensual(puntos).anyos.find((fila) => fila.total !== null)
    if (reciente) {
        assetGraficoEscribirCabecera({
            etiqueta,
            valor: assetGraficoFormatearPct(reciente.total),
            fecha: `${reciente.anyo}${reciente.anyo === new Date().getFullYear() ? " (YTD)" : ""}`,
            positivo: reciente.total >= 0
        })
    }
    assetGraficoEscribir(
        "assetGraficoNota",
        "Cada mes, variación de su cierre sobre el del mes anterior; cada año, sobre el cierre del año anterior. Velas mensuales de TradingView en la divisa de cotización."
    )
}

async function assetGraficoDibujarEstacional() {
    const token = ++_assetGraficoModoToken
    if (assetGraficoEstado().vistaEstacional === "tabla") {
        await assetGraficoDibujarTablaEstacional(token)
        return
    }
    const etiqueta = "Variación desde el inicio de cada año"
    assetGraficoEscribirCabecera({ etiqueta })
    const historico = await assetGraficoPuntosHistoricos()
    if (token !== _assetGraficoModoToken) return

    // Velas sin divisa no se usan: no se sabría en qué moneda enseñar el precio.
    const conVelas = Boolean(historico?.divisa) && historico.puntos.length >= 2
    // El histórico propio va en euros (ver python/stores/grafico_activo.py).
    const moneda = conVelas ? historico.divisa : "EUR"
    const todas = assetGraficoSeriesEstacionales(conVelas ? historico.puntos : _assetGraficoDatos?.puntos)
    _assetGraficoAniosDisponibles = todas.map((serie) => serie.anio)
    const base = assetGraficoPrepararModo()
    if (!base || typeof Chart === "undefined") return
    // El color va por la distancia al año más reciente con datos, no al más reciente
    // elegido: así cada año conserva su color al marcar o desmarcar otros.
    const ultimoDisponible = _assetGraficoAniosDisponibles[_assetGraficoAniosDisponibles.length - 1]
    const colorDe = (anio) => assetGraficoColorAnio(ultimoDisponible - anio, base.colorLinea)
    const seleccionados = assetGraficoAniosSeleccionados(
        _assetGraficoAniosDisponibles,
        getChartPref("assetGraficoAniosElegidos", null)
    )
    assetGraficoPintarBotonesAnios(_assetGraficoAniosDisponibles, seleccionados, colorDe)
    const series = todas.filter((serie) => seleccionados.includes(serie.anio))
    if (!series.length) {
        assetGraficoMostrarVacio(
            todas.length ? "Elige al menos un año arriba." : "Todavía no hay precios de este activo para comparar años."
        )
        return
    }

    const reciente = series[series.length - 1]
    const colores = series.map((serie) => colorDe(serie.anio))
    assetGraficoEscribirCabecera({
        etiqueta,
        valor: assetGraficoFormatearPct(reciente.ultimo),
        cambio: assetGraficoFormatearDinero(reciente.precios[reciente.ultimoDia], moneda),
        fecha: `${reciente.anio}${reciente.anio === new Date().getFullYear() ? " (YTD)" : ""}`,
        positivo: reciente.ultimo >= 0
    })
    assetGraficoLeyendaModo(
        series.map((serie, posicion) => ({
            nombre: `${serie.anio}${serie.parcial ? " *" : ""}  ${assetGraficoFormatearPct(serie.ultimo)}`,
            color: colores[posicion]
        }))
    )
    const hayParcial = series.some((serie) => serie.parcial)
    assetGraficoEscribir("assetGraficoNota", assetGraficoNotaEstacional(conVelas, hayParcial))

    _assetGraficoChart = new Chart(
        base.canvas,
        assetGraficoConfigEstacional(
            series,
            colores,
            { texto: base.colorTexto, rejilla: base.colorRejilla },
            moneda,
            assetGraficoEstado().escalaEstacional
        )
    )
}

/**
 * Configuración de Chart.js para los años superpuestos de los estacionales.
 *
 * La comparten la pestaña «Gráfico» y el popup de estacionales de la ficha lateral.
 *
 * @param {{anio: number, valores: (number|null)[], ultimoDia: number}[]} series Años que
 *     se ven, del más antiguo al más reciente.
 * @param {string[]} colores Color de cada serie, en el mismo orden.
 * @param {{texto: string, rejilla: string}} estilo Colores del tema para ejes y rejilla.
 * @param {string|null} [moneda] Divisa de los precios. Con ella, el tooltip enseña el
 *     precio de ese día junto al %; sin ella, solo el %.
 * @param {"lineal"|"log"} [escala] Escala del eje vertical.
 * @returns {object} Configuración para `new Chart`.
 */
function assetGraficoConfigEstacional(series, colores, estilo, moneda = null, escala = "lineal") {
    const esLog = escala === "log"
    const reciente = series[series.length - 1]
    const iniciosMes = Array.from({ length: 12 }, (_valor, mes) => assetGraficoDiaEstacional(mes, 1))
    const nombreMes = (mes) => new Date(2000, mes, 1).toLocaleDateString(_nl(), { month: "short" })
    const nombreDia = (dia) => new Date(2000, 0, 1 + dia).toLocaleDateString(_nl(), { day: "2-digit", month: "short" })

    return {
        type: "line",
        data: {
            // Del más antiguo al más reciente: el último se dibuja encima.
            datasets: series.map((serie, posicion) => {
                const esReciente = serie === reciente
                return {
                    label: String(serie.anio),
                    data: serie.valores.map((pct, dia) => ({
                        x: dia,
                        // En log se dibuja el multiplicador (1 + %), que siempre es positivo;
                        // el % sigue en `pct` para el tooltip.
                        y: esLog && pct !== null ? 1 + pct / 100 : pct,
                        pct,
                        precio: serie.precios?.[dia] ?? null
                    })),
                    borderColor: colores[posicion],
                    backgroundColor: colores[posicion],
                    borderWidth: esReciente ? 2.5 : 1.25,
                    // Solo el último día del año más reciente lleva punto: es «hoy».
                    pointRadius: (contexto) => (esReciente && contexto.dataIndex === serie.ultimoDia ? 4 : 0),
                    pointHoverRadius: 3,
                    tension: 0,
                    // Fines de semana y festivos sin cotización no cortan la línea.
                    spanGaps: true
                }
            })
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            layout: { padding: { top: 8, bottom: 8, left: 8 } },
            interaction: { mode: "index", intersect: false },
            scales: {
                x: {
                    type: "linear",
                    min: 0,
                    max: assetGraficoDiasEstacional - 1,
                    grid: { color: estilo.rejilla },
                    border: { color: estilo.rejilla },
                    afterBuildTicks: (eje) => {
                        eje.ticks = iniciosMes.map((value) => ({ value }))
                    },
                    ticks: {
                        color: estilo.texto,
                        maxRotation: 0,
                        callback: (valor) => nombreMes(iniciosMes.indexOf(valor))
                    }
                },
                y: esLog ? assetGraficoEjeLogEstacional(estilo) : assetGraficoEjeLinealEstacional(estilo)
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    filter: (item) => Number.isFinite(item.raw.y),
                    callbacks: {
                        title: (items) => (items[0] ? nombreDia(items[0].raw.x) : ""),
                        label: (contexto) => {
                            const pct = `${contexto.dataset.label}: ${assetGraficoFormatearPct(contexto.raw.pct)}`
                            const { precio } = contexto.raw
                            return moneda && Number.isFinite(precio)
                                ? `${pct}  ·  ${assetGraficoFormatearDinero(precio, moneda)}`
                                : pct
                        }
                    }
                }
            }
        }
    }
}

// Eje vertical lineal de los estacionales, en %.
function assetGraficoEjeLinealEstacional(estilo) {
    return {
        position: "right",
        grace: "8%",
        // La línea del 0 % es la referencia de todas las curvas: se marca más.
        grid: { color: (contexto) => (contexto.tick?.value === 0 ? estilo.texto : estilo.rejilla) },
        border: { display: false },
        ticks: {
            color: estilo.texto,
            maxTicksLimit: 7,
            callback: (valor) => assetGraficoFormatearPct(valor)
        }
    }
}

/**
 * Marcas del eje logarítmico de los estacionales, como multiplicadores (1 + %).
 *
 * Porcentajes redondos repartidos de forma pareja en escala log: cada uno es más o
 * menos el doble o la mitad del vecino. Solo se quedan los que caen dentro del eje.
 *
 * @param {number} minimo Valor más bajo del eje (multiplicador).
 * @param {number} maximo Valor más alto del eje (multiplicador).
 * @returns {number[]} Multiplicadores de las marcas, de menor a mayor.
 */
function assetGraficoMarcasLogEstacional(minimo, maximo) {
    const porcentajes = [-99, -95, -90, -75, -50, -25, 0, 50, 100, 200, 400, 1000, 2500, 5000, 10000, 25000]
    return porcentajes.map((pct) => 1 + pct / 100).filter((valor) => valor >= minimo && valor <= maximo)
}

// Eje vertical logarítmico de los estacionales: dibuja multiplicadores y los rotula en %.
function assetGraficoEjeLogEstacional(estilo) {
    return {
        type: "logarithmic",
        position: "right",
        grid: { color: (contexto) => (contexto.tick?.value === 1 ? estilo.texto : estilo.rejilla) },
        border: { display: false },
        afterBuildTicks: (eje) => {
            eje.ticks = assetGraficoMarcasLogEstacional(eje.min, eje.max).map((value) => ({ value }))
        },
        ticks: {
            color: estilo.texto,
            callback: (valor) => assetGraficoFormatearPct((valor - 1) * 100)
        }
    }
}

/**
 * Pinta el gráfico en un modo distinto de «Compras / ventas».
 *
 * @param {"anual"|"indices"|"estacional"} modo Modo elegido en el desplegable.
 */
function assetGraficoDibujarModo(modo) {
    ++_assetGraficoModoToken
    if (modo === "anual") assetGraficoDibujarAnual()
    else if (modo === "estacional") assetGraficoDibujarEstacional()
    else assetGraficoDibujarIndices()
}
