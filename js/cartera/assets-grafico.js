// Ficha del activo: pestaña «Gráfico», con el precio o el rendimiento de la
// posición a lo largo del tiempo y un punto en cada compra y cada venta.
//
// Los datos salen de los snapshots que guarda la aplicación (ver
// python/stores/grafico_activo.py), así que van en euros y empiezan donde empieza
// ese histórico. Cambiar de vista o de unidad no vuelve a pedir nada: el servidor
// manda las dos series y aquí solo se elige cuál pintar.
// Con el ticker de TradingView del activo (el mismo que usa Paneles), la línea
// sale de sus velas y los snapshots quedan de respaldo: así las compras
// anteriores al histórico propio también tienen punto.

const ASSET_GRAFICO_RANGOS = [
    { clave: "1D", etiqueta: "1 D" },
    { clave: "7D", etiqueta: "7 D" },
    { clave: "30D", etiqueta: "30 D" },
    { clave: "YTD", etiqueta: "YTD" },
    { clave: "1A", etiqueta: "1 A" },
    { clave: "TODO", etiqueta: "Todo" }
]
const ASSET_GRAFICO_VISTAS = [
    { clave: "precio", etiqueta: "Precio" },
    { clave: "posicion", etiqueta: "Mi posición" }
]
const ASSET_GRAFICO_UNIDADES = [
    { clave: "eur", etiqueta: "€" },
    { clave: "pct", etiqueta: "%" }
]
const ASSET_GRAFICO_MODO = "assetGraficoCercano"

// Distancia en píxeles a la que el cursor ya «coge» un punto de compra o venta.
// En un año cada día ocupa dos píxeles: sin este margen, acertar en el punto
// exacto sería cuestión de suerte.
const ASSET_GRAFICO_RADIO_MARCA = 10

// Hasta qué tramo visible del eje X, en segundos, se escribe la hora o el día. El
// formato depende de lo que se ve y no del rango: «Todo» puede abarcar solo un mes.
const ASSET_GRAFICO_EJE_CON_HORA = 2 * 86400
const ASSET_GRAFICO_EJE_CON_DIA = 200 * 86400

let _assetGraficoChart = null
let _assetGraficoToken = 0
let _assetGraficoDatos = null
// Ventana de fechas (AAAA-MM-DD) elegida a mano. Con alguna fecha puesta manda sobre
// el rango; se queda en memoria y se vacía al cambiar de activo.
let _assetGraficoVentana = { desde: "", hasta: "" }
// Los datos ya recortados a la ventana: la cabecera los lee en cada movimiento del cursor.
let _assetGraficoVisibles = null
// Días con compra o venta del activo abierto; null hasta que se conocen.
let _assetGraficoDias = null

function assetGraficoHayVentana() {
    return Boolean(_assetGraficoVentana.desde || _assetGraficoVentana.hasta)
}

// Con ventana se pide «Todo» al servidor: una ventana puede caer en cualquier punto del
// histórico y el recorte se hace aquí.
function assetGraficoRangoEfectivo() {
    return assetGraficoHayVentana() ? "TODO" : assetGraficoEstado().rango
}

// Inicio del primer día y final del último, en hora local, en segundos.
function assetGraficoLimitesVentana(ventana) {
    const inicio = ventana.desde ? new Date(`${ventana.desde}T00:00:00`).getTime() / 1000 : -Infinity
    const fin = ventana.hasta ? new Date(`${ventana.hasta}T23:59:59`).getTime() / 1000 : Infinity
    return { min: Number.isNaN(inicio) ? -Infinity : inicio, max: Number.isNaN(fin) ? Infinity : fin }
}

/**
 * Deja solo los puntos y las operaciones de la ventana de fechas.
 *
 * Los índices de las operaciones se reajustan a la lista recortada, porque apuntan a
 * la posición del punto de su día.
 *
 * @param {object} datos Respuesta del servidor.
 * @param {{desde: string, hasta: string}} ventana Fechas AAAA-MM-DD; vacías, sin límite.
 * @returns {object} `datos` tal cual si no hay ventana; si la hay, una copia recortada.
 */
function assetGraficoRecortar(datos, ventana) {
    if (!ventana.desde && !ventana.hasta) return datos
    const { min, max } = assetGraficoLimitesVentana(ventana)
    const indiceNuevo = new Map()
    const puntos = []
    ;(datos.puntos || []).forEach((punto, indice) => {
        if (punto.ts < min || punto.ts > max) return
        indiceNuevo.set(indice, puntos.length)
        puntos.push(punto)
    })
    const operaciones = (datos.operaciones || [])
        .filter((operacion) => indiceNuevo.has(operacion.indice))
        .map((operacion) => ({ ...operacion, indice: indiceNuevo.get(operacion.indice) }))
    return { ...datos, puntos, operaciones }
}

function assetGraficoConHora(rango) {
    return !assetGraficoHayVentana() && (rango === "1D" || rango === "7D")
}

function assetGraficoPreferencia(clave, opciones, defecto) {
    const guardada = getChartPref(clave, defecto)
    return opciones.some((opcion) => opcion.clave === guardada) ? guardada : defecto
}

function assetGraficoEstado() {
    return {
        rango: assetGraficoPreferencia("assetGraficoRango", ASSET_GRAFICO_RANGOS, "30D"),
        vista: assetGraficoPreferencia("assetGraficoVista", ASSET_GRAFICO_VISTAS, "precio"),
        unidad: assetGraficoPreferencia("assetGraficoUnidad", ASSET_GRAFICO_UNIDADES, "eur")
    }
}

// El primer precio conocido del rango: la referencia del % en la vista de precio.
function assetGraficoPrecioBase(puntos) {
    const precios = puntos.map((punto) => (Number.isFinite(punto.precio) && punto.precio > 0 ? punto.precio : null))
    const indice = assetGraficoPrimeroTrazable(precios)
    return indice === -1 ? null : precios[indice]
}

// Índice del primer valor que forma parte de un trazo. Un valor rodeado de huecos no
// se dibuja, porque la línea no tiene puntos propios y no une con nada, así que no
// puede servir de inicio. Si solo hay valores sueltos, vale el primero.
function assetGraficoPrimeroTrazable(valores) {
    const tieneValor = (indice) => Number.isFinite(valores[indice])
    const conVecino = valores.findIndex(
        (_valor, indice) => tieneValor(indice) && (tieneValor(indice - 1) || tieneValor(indice + 1))
    )
    return conVecino !== -1 ? conVecino : valores.findIndex((_valor, indice) => tieneValor(indice))
}

// Lo que vale un punto en la vista y unidad elegidas, o null si no se puede saber.
function assetGraficoValorDelPunto(punto, vista, unidad, precioBase) {
    if (vista === "precio") {
        if (!Number.isFinite(punto.precio)) return null
        if (unidad === "eur") return punto.precio
        return precioBase ? (punto.precio / precioBase - 1) * 100 : null
    }
    const ganancia = punto.valor - punto.coste
    if (unidad === "eur") return ganancia
    return punto.coste > 0 ? (ganancia / punto.coste) * 100 : null
}

// Altura de la marca de una operación. En la vista de precio es lo que se pagó o
// cobró; la línea solo da la cotización de un momento de ese día. En la de posición
// la operación no tiene un valor propio, así que se apoya en la línea.
// Con la línea de TradingView (`sobreLinea`) la marca va siempre en la línea: el
// precio pagado suele quedar fuera de la cotización de ese día (comisiones dentro
// del precio, otro exchange) y la marca flotaba suelta. Lo pagado sigue en el tooltip.
function assetGraficoValorDeMarca(operacion, valorLinea, vista, unidad, precioBase, sobreLinea = false) {
    if (sobreLinea || vista !== "precio" || !Number.isFinite(operacion.precioEur)) return valorLinea
    if (unidad === "eur") return operacion.precioEur
    return precioBase ? (operacion.precioEur / precioBase - 1) * 100 : valorLinea
}

// Prepara lo que pinta Chart.js: la línea, con cortes en los huecos largos, y un
// punto por cada día y tipo de operación. Varias compras del mismo día comparten
// punto: sus posiciones serían idénticas y una taparía a la otra.
function assetGraficoSeries(datos, vista, unidad) {
    const puntos = datos.puntos || []
    const precioBase = assetGraficoPrecioBase(puntos)
    const linea = []
    const indiceEnLinea = []
    const valores = puntos.map((punto) => assetGraficoValorDelPunto(punto, vista, unidad, precioBase))

    puntos.forEach((punto, indice) => {
        const anterior = puntos[indice - 1]
        if (anterior && punto.ts - anterior.ts > datos.segundosHueco) {
            linea.push({ x: (punto.ts + anterior.ts) / 2, y: null })
        }
        indiceEnLinea[indice] = linea.length
        linea.push({ x: punto.ts, y: valores[indice], punto })
    })

    const marcas = { compra: new Map(), venta: new Map() }
    let sinValor = 0
    ;(datos.operaciones || []).forEach((operacion) => {
        const valor = valores[operacion.indice]
        const grupo = marcas[operacion.tipo]
        if (!grupo) return
        if (!Number.isFinite(valor)) {
            sinValor += 1
            return
        }
        const y = assetGraficoValorDeMarca(operacion, valor, vista, unidad, precioBase, !!datos.conVelas)
        // Dos compras del mismo día a precios distintos ya no coinciden en altura.
        const clave = `${operacion.indice}|${y}`
        if (!grupo.has(clave)) {
            grupo.set(clave, {
                x: puntos[operacion.indice].ts,
                y,
                indiceLinea: indiceEnLinea[operacion.indice],
                operaciones: []
            })
        }
        grupo.get(clave).operaciones.push(operacion)
    })

    const limitesX = assetGraficoLimitesX(linea)
    return {
        linea,
        compras: [...marcas.compra.values()],
        ventas: [...marcas.venta.values()],
        extremos: assetGraficoExtremos(limitesX ? linea.filter((punto) => punto.x >= limitesX.min) : []),
        limitesX,
        ultimo: assetGraficoUltimoValido(linea),
        operacionesSinValor: sinValor
    }
}

function assetGraficoExtremos(linea) {
    const validos = linea.filter((punto) => Number.isFinite(punto.y))
    if (!validos.length) return null
    return {
        maximo: validos.reduce((mejor, punto) => (punto.y > mejor.y ? punto : mejor)),
        minimo: validos.reduce((mejor, punto) => (punto.y < mejor.y ? punto : mejor))
    }
}

// El eje abarca lo que se puede pintar: los puntos sin valor en esta vista dejarían
// vacío el lado izquierdo del gráfico.
function assetGraficoLimitesX(linea) {
    const inicio = assetGraficoPrimeroTrazable(linea.map((punto) => punto.y))
    if (inicio === -1) return null
    return { min: linea[inicio].x, max: assetGraficoUltimoValido(linea).x }
}

function assetGraficoUltimoValido(linea) {
    for (let indice = linea.length - 1; indice >= 0; indice -= 1) {
        if (Number.isFinite(linea[indice].y)) return linea[indice]
    }
    return null
}

// Un precio de céntimos con dos decimales se leería siempre igual.
function assetGraficoDecimales(valor) {
    return Math.abs(valor) < 1 && valor !== 0 ? 6 : 2
}

// Con signo es una ganancia, no un precio: ahí los céntimos ya son poco dinero.
function assetGraficoFormatearDinero(valor, moneda, conSigno = false) {
    const signo = conSigno && valor > 0 ? "+" : ""
    const decimales = conSigno ? 2 : assetGraficoDecimales(valor)
    return `${signo}${formatMoneyWithDecimals(valor, moneda, decimales)}`
}

function assetGraficoFormatearPct(valor, conSigno = true) {
    const signo = conSigno && valor > 0 ? "+" : ""
    return `${signo}${new Intl.NumberFormat(_nl(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(valor)} %`
}

function assetGraficoFormatearValor(valor, vista, unidad) {
    if (unidad === "pct") return assetGraficoFormatearPct(valor)
    return assetGraficoFormatearDinero(valor, "EUR", vista === "posicion")
}

// Etiqueta de un punto para la cabecera y el tooltip. En la vista de posición se
// enseñan siempre las dos unidades juntas: son la misma ganancia dicha de dos formas.
function assetGraficoDetalleDelPunto(punto, vista, unidad) {
    if (vista === "precio") return ""
    const ganancia = punto.valor - punto.coste
    if (unidad === "pct") return assetGraficoFormatearDinero(ganancia, "EUR", true)
    return punto.coste > 0 ? assetGraficoFormatearPct((ganancia / punto.coste) * 100) : ""
}

function assetGraficoFormatearFecha(ts, conHora) {
    return new Date(ts * 1000).toLocaleString(_nl(), {
        day: "2-digit",
        month: "short",
        year: "numeric",
        ...(conHora ? { hour: "2-digit", minute: "2-digit" } : {})
    })
}

function assetGraficoFormatearEje(ts, segundosVisibles) {
    const fecha = new Date(ts * 1000)
    if (segundosVisibles <= ASSET_GRAFICO_EJE_CON_HORA) {
        return fecha.toLocaleTimeString(_nl(), { hour: "2-digit", minute: "2-digit" })
    }
    if (segundosVisibles <= ASSET_GRAFICO_EJE_CON_DIA) {
        return fecha.toLocaleDateString(_nl(), { day: "2-digit", month: "short" })
    }
    return fecha.toLocaleDateString(_nl(), { month: "short", year: "2-digit" })
}

function assetGraficoSelector(nombre, opciones, activa) {
    const botones = opciones
        .map(
            (opcion) =>
                `<button type="button" class="mToggleBtn${opcion.clave === activa ? " active" : ""}" data-grafico-${nombre}="${opcion.clave}" aria-pressed="${opcion.clave === activa}">${escapeHtml(opcion.etiqueta)}</button>`
        )
        .join("")
    return `<div class="mToggleGroup" role="group">${botones}</div>`
}

// Misma cápsula de fechas que el seguimiento de wallets (css/pages/operaciones.css),
// con el calendario propio para poder señalar los días con operaciones.
// Hoy en AAAA-MM-DD y hora local. No hay operaciones futuras: el calendario apaga lo
// posterior, como en el seguimiento de wallets.
function assetGraficoHoy() {
    const ahora = new Date()
    const mes = String(ahora.getMonth() + 1).padStart(2, "0")
    const dia = String(ahora.getDate()).padStart(2, "0")
    return `${ahora.getFullYear()}-${mes}-${dia}`
}

// Límites de cada campo: «Desde» no pasa de «Hasta» ni de hoy, y «Hasta» no baja de «Desde».
function assetGraficoLimitesCampo(campo, ventana) {
    return campo === "desde" ? { max: ventana.hasta || assetGraficoHoy() } : { min: ventana.desde, max: assetGraficoHoy() }
}

function assetGraficoCampoFechaHtml(campo, etiqueta, valor) {
    const { min, max } = assetGraficoLimitesCampo(campo, _assetGraficoVentana)
    const atributos = `${min ? ` min="${escapeHtml(min)}"` : ""} max="${escapeHtml(max)}"`
    return `
        <label class="walletsSegRangoCampo">
            <span>${etiqueta}</span>
            <input type="date" class="walletsSegFechaInput${valor ? "" : " vacio"}" data-grafico-fecha="${campo}" value="${escapeHtml(valor)}"${atributos}>
            <button type="button" class="walletsSegFechaBtn" data-grafico-calendario="${campo}" aria-label="Elegir fecha ${campo}" aria-haspopup="dialog" aria-expanded="false" title="Abrir calendario"><span class="icono iconoCalendario" aria-hidden="true"></span></button>
        </label>`
}

function assetGraficoFechasHtml() {
    const { desde, hasta } = _assetGraficoVentana
    return `
        <div class="walletsSegRango${assetGraficoHayVentana() ? " activo" : ""}" id="assetGraficoFechas" role="group" aria-label="Buscar por fecha">
            ${assetGraficoCampoFechaHtml("desde", "Desde", desde)}
            <span class="walletsSegRangoSep" aria-hidden="true">→</span>
            ${assetGraficoCampoFechaHtml("hasta", "Hasta", hasta)}
            <button type="button" class="walletsSegFechasQuitarBtn${assetGraficoHayVentana() ? "" : " hidden"}" id="assetGraficoFechasQuitar" aria-label="Quitar fechas" title="Quitar fechas"><span class="icono iconoCerrar" aria-hidden="true"></span></button>
        </div>`
}

function assetGraficoEtiquetaVista(vista) {
    return vista === "precio" ? "Precio por participación" : "Ganancia o pérdida de lo que sigue en cartera"
}

function assetGraficoPintarEsqueleto(seccion) {
    const { rango, vista, unidad } = assetGraficoEstado()
    seccion.innerHTML = `
        <div class="assetGrafico">
            <div class="assetGraficoCabecera">
                <div class="assetGraficoResumen">
                    <span class="assetGraficoEtiqueta" id="assetGraficoEtiqueta">${escapeHtml(assetGraficoEtiquetaVista(vista))}</span>
                    <div class="assetGraficoCifras">
                        <span class="assetGraficoValor" id="assetGraficoValor">—</span>
                        <span class="assetGraficoCambio" id="assetGraficoCambio"></span>
                    </div>
                    <span class="assetGraficoFecha" id="assetGraficoFecha">&nbsp;</span>
                </div>
                <div class="assetGraficoControles">
                    ${assetGraficoSelector("vista", ASSET_GRAFICO_VISTAS, vista)}
                    ${assetGraficoSelector("unidad", ASSET_GRAFICO_UNIDADES, unidad)}
                    ${assetGraficoSelector("rango", ASSET_GRAFICO_RANGOS, assetGraficoHayVentana() ? "" : rango)}
                    ${assetGraficoFechasHtml()}
                </div>
            </div>
            <div class="assetGraficoLienzo" id="assetGraficoLienzo"><canvas id="assetGraficoCanvas"></canvas></div>
            <p class="assetGraficoVacio hidden" id="assetGraficoVacio"></p>
            <div class="assetGraficoLeyenda" id="assetGraficoLeyenda"></div>
            <p class="assetGraficoNota" id="assetGraficoNota"></p>
        </div>
    `
}

function assetGraficoDestruir() {
    _assetGraficoChart?.destroy()
    _assetGraficoChart = null
}

function assetGraficoMostrarVacio(mensaje) {
    assetGraficoDestruir()
    document.getElementById("assetGraficoLienzo")?.classList.add("hidden")
    const vacio = document.getElementById("assetGraficoVacio")
    if (vacio) {
        vacio.textContent = mensaje
        vacio.classList.remove("hidden")
    }
    const valor = document.getElementById("assetGraficoValor")
    if (valor) valor.textContent = "—"
    assetGraficoEscribir("assetGraficoCambio", "")
    assetGraficoEscribir("assetGraficoFecha", "")
    assetGraficoEscribir("assetGraficoNota", "")
    const leyenda = document.getElementById("assetGraficoLeyenda")
    if (leyenda) leyenda.innerHTML = ""
}

function assetGraficoEscribir(id, texto) {
    const elemento = document.getElementById(id)
    if (elemento) elemento.textContent = texto
}

// Lo que dice la cabecera: el punto bajo el cursor, o el último si no hay cursor.
// En la vista de precio el cambio es el del periodo hasta ese punto.
function assetGraficoActualizarCabecera(puntoLinea) {
    if (!_assetGraficoDatos || !puntoLinea) return
    const { vista, unidad, rango } = assetGraficoEstado()
    const punto = puntoLinea.punto
    assetGraficoEscribir("assetGraficoValor", assetGraficoFormatearValor(puntoLinea.y, vista, unidad))
    assetGraficoEscribir("assetGraficoFecha", assetGraficoFormatearFecha(punto.ts, assetGraficoConHora(rango)))

    const cambio = document.getElementById("assetGraficoCambio")
    if (!cambio) return
    let texto = assetGraficoDetalleDelPunto(punto, vista, unidad)
    let positivo = punto.valor >= punto.coste
    if (vista === "precio") {
        const base = assetGraficoPrecioBase((_assetGraficoVisibles || _assetGraficoDatos).puntos)
        const variacion = base && Number.isFinite(punto.precio) ? (punto.precio / base - 1) * 100 : null
        texto = variacion === null ? "" : assetGraficoFormatearPct(variacion)
        positivo = (variacion ?? 0) >= 0
    }
    cambio.textContent = texto
    cambio.classList.toggle("assetGraficoCambioPositivo", Boolean(texto) && positivo)
    cambio.classList.toggle("assetGraficoCambioNegativo", Boolean(texto) && !positivo)
}

function assetGraficoEscribirLeyenda(series) {
    const leyenda = document.getElementById("assetGraficoLeyenda")
    if (!leyenda) return
    const cuenta = (marcas) => marcas.reduce((total, marca) => total + marca.operaciones.length, 0)
    leyenda.innerHTML = `
        <span class="assetGraficoLeyendaItem"><span class="assetGraficoPunto assetGraficoPuntoCompra"></span>Compras (${cuenta(series.compras)})</span>
        <span class="assetGraficoLeyendaItem"><span class="assetGraficoPunto assetGraficoPuntoVenta"></span>Ventas (${cuenta(series.ventas)})</span>
    `
}

// Las notas explican lo que falta en el gráfico: sin ellas, una compra antigua sin
// punto parecería un fallo.
function assetGraficoTextoNota(datos, series, vista, moneda) {
    const partes = []
    if (datos.conVelas) {
        partes.push("La línea sale de la cotización de TradingView.")
        if (vista === "posicion") partes.push("La posición se calcula con esa cotización y no descuenta comisiones.")
    } else if (datos.inicioHistorico) {
        partes.push(`Histórico disponible desde el ${assetGraficoFormatearFecha(datos.inicioHistorico, false)}.`)
    }
    const fuera = (datos.operacionesSinPunto || 0) + series.operacionesSinValor
    if (fuera > 0) {
        partes.push(
            fuera === 1
                ? "1 operación del periodo no se muestra porque no hay histórico de esa fecha."
                : `${fuera} operaciones del periodo no se muestran porque no hay histórico de esas fechas.`
        )
    }
    if (vista === "posicion") partes.push("Lo ya vendido no suma: una venta reduce la posición y su ganancia.")
    if (normalizeCurrencyCode(moneda || "EUR") !== "EUR") {
        partes.push("Los importes del gráfico van en euros; el precio de cada operación, en la divisa en que se hizo.")
    }
    return partes.join(" ")
}

function assetGraficoRegistrarModo() {
    if (Chart.Interaction.modes[ASSET_GRAFICO_MODO]) return

    // La línea sigue al punto más cercano, salvo que haya una compra o venta a tiro:
    // entonces esa manda, y la línea se coloca en su misma fecha.
    Chart.Interaction.modes[ASSET_GRAFICO_MODO] = (chart, evento, _opciones, finales) => {
        const { x } = Chart.helpers.getRelativePosition(evento, chart)
        const cercanas = []
        ;[1, 2].forEach((datasetIndex) => {
            const meta = chart.getDatasetMeta(datasetIndex)
            meta.data.forEach((element, index) => {
                const distancia = Math.abs(element.getProps(["x"], finales).x - x)
                if (distancia <= ASSET_GRAFICO_RADIO_MARCA) {
                    cercanas.push({ datasetIndex, index, element, distancia })
                }
            })
        })
        if (cercanas.length) {
            const minima = Math.min(...cercanas.map((marca) => marca.distancia))
            const elegidas = cercanas.filter((marca) => marca.distancia <= minima + 1)
            const raw = chart.data.datasets[elegidas[0].datasetIndex].data[elegidas[0].index]
            const lineaMeta = chart.getDatasetMeta(0)
            return [
                { datasetIndex: 0, index: raw.indiceLinea, element: lineaMeta.data[raw.indiceLinea] },
                ...elegidas.map(({ datasetIndex, index, element }) => ({ datasetIndex, index, element }))
            ]
        }

        const lineaMeta = chart.getDatasetMeta(0)
        let mejor = null
        lineaMeta.data.forEach((element, index) => {
            if (!Number.isFinite(chart.data.datasets[0].data[index].y)) return
            const distancia = Math.abs(element.getProps(["x"], finales).x - x)
            if (!mejor || distancia < mejor.distancia) mejor = { index, element, distancia }
        })
        return mejor ? [{ datasetIndex: 0, index: mejor.index, element: mejor.element }] : []
    }
}

function assetGraficoPluginGuia(colorGuia) {
    return {
        id: "assetGraficoGuia",
        afterDatasetsDraw(chart) {
            const activo = chart.getActiveElements()[0]
            if (!activo) return
            const { ctx, chartArea } = chart
            ctx.save()
            ctx.lineWidth = 1
            ctx.setLineDash([4, 4])
            ctx.strokeStyle = colorGuia
            ctx.beginPath()
            ctx.moveTo(activo.element.x, chartArea.top)
            ctx.lineTo(activo.element.x, chartArea.bottom)
            ctx.stroke()
            ctx.restore()
        },
        afterEvent(chart, argumentos) {
            const { type } = argumentos.event
            if (type !== "mousemove" && type !== "mouseout" && type !== "touchmove" && type !== "touchend") return
            const activo = chart.getActiveElements().find((item) => item.datasetIndex === 0)
            const datosLinea = chart.data.datasets[0].data
            const fuera = type === "mouseout" || type === "touchend" || !activo
            assetGraficoActualizarCabecera(fuera ? assetGraficoUltimoValido(datosLinea) : datosLinea[activo.index])
        }
    }
}

// Etiqueta en el eje derecho con el valor a la altura del cursor. La línea
// horizontal la dibuja el crosshair global (app-core.js), que no sabe formatear
// el valor de este gráfico; por eso la cifra se pinta aquí.
function assetGraficoPluginValorCursor(formatear, colorFondo, colorTexto) {
    let cursorY = null
    return {
        id: "assetGraficoValorCursor",
        afterEvent(chart, argumentos) {
            const { type, y } = argumentos.event
            if (type === "mousemove" || type === "touchmove") cursorY = y
            else if (type === "mouseout" || type === "touchend") cursorY = null
            else return
            argumentos.changed = true
        },
        afterDraw(chart) {
            const { ctx, chartArea, scales } = chart
            if (cursorY === null || cursorY < chartArea.top || cursorY > chartArea.bottom) return
            if (!chart.getActiveElements().length) return
            const texto = formatear(scales.y.getValueForPixel(cursorY))
            ctx.save()
            ctx.font = "bold 12px sans-serif"
            const alto = 20
            const anchoTexto = ctx.measureText(texto).width + 12
            // Si la cifra no cabe en el hueco del eje, se mete hacia dentro para no cortarla.
            const izquierda = Math.min(chartArea.right + 2, chart.width - anchoTexto)
            const ancho = Math.max(anchoTexto, chart.width - izquierda)
            ctx.fillStyle = colorFondo
            ctx.fillRect(izquierda, cursorY - alto / 2, ancho, alto)
            ctx.fillStyle = colorTexto
            ctx.textBaseline = "middle"
            ctx.fillText(texto, izquierda + 6, cursorY)
            ctx.restore()
        }
    }
}

// Máximo y mínimo del periodo, escritos junto al punto en que ocurrieron. Se
// mantienen dentro del lienzo para que no se corten cerca de los bordes.
function assetGraficoPluginExtremos(extremos, formatear, color) {
    return {
        id: "assetGraficoExtremos",
        afterDatasetsDraw(chart) {
            if (!extremos) return
            const { ctx, chartArea, scales } = chart
            ctx.save()
            ctx.font = "12px sans-serif"
            ctx.fillStyle = color
            ctx.textBaseline = "middle"
            const dibujar = (punto, desplazamiento) => {
                const texto = formatear(punto.y)
                const ancho = ctx.measureText(texto).width
                const centro = scales.x.getPixelForValue(punto.x)
                const izquierda = Math.min(Math.max(centro - ancho / 2, chartArea.left), chartArea.right - ancho)
                ctx.fillText(texto, izquierda, scales.y.getPixelForValue(punto.y) + desplazamiento)
            }
            dibujar(extremos.maximo, -14)
            if (extremos.minimo.y !== extremos.maximo.y) dibujar(extremos.minimo, 14)
            ctx.restore()
        }
    }
}

function assetGraficoEtiquetasTooltip(contexto, vista, unidad) {
    const raw = contexto.raw
    if (contexto.datasetIndex === 0) {
        const detalle = raw.punto ? assetGraficoDetalleDelPunto(raw.punto, vista, unidad) : ""
        const base = assetGraficoFormatearValor(raw.y, vista, unidad)
        return detalle ? `${base}  (${detalle})` : base
    }
    const tipoActivo = document.querySelector(".assetTablePage")?.dataset.assetType || ""
    return raw.operaciones.map((operacion) => {
        const nombre = operacion.tipo === "venta" ? "Venta" : "Compra"
        const cantidad = formatAssetParticipationValue(operacion.cantidad, tipoActivo)
        const precio =
            operacion.precio === null ? "" : ` a ${assetGraficoFormatearDinero(operacion.precio, operacion.divisa)}`
        return `${nombre}: ${cantidad}${precio}`
    })
}

function assetGraficoDatasetMarcas(datos, etiqueta, color, fondo) {
    return {
        type: "line",
        label: etiqueta,
        data: datos,
        showLine: false,
        // El eje empieza justo en el primer punto: una marca ahí saldría cortada.
        clip: false,
        pointRadius: 6,
        pointHoverRadius: 8,
        pointBackgroundColor: color,
        pointBorderColor: fondo,
        pointBorderWidth: 2,
        pointHoverBorderColor: fondo,
        pointHoverBackgroundColor: color
    }
}

function assetGraficoDibujar() {
    const lienzo = document.getElementById("assetGraficoLienzo")
    const canvas = document.getElementById("assetGraficoCanvas")
    const pagina = document.querySelector(".assetTablePage")
    if (!lienzo || !canvas || !_assetGraficoDatos || typeof Chart === "undefined") return

    const { rango, vista, unidad } = assetGraficoEstado()
    _assetGraficoVisibles = assetGraficoRecortar(_assetGraficoDatos, _assetGraficoVentana)
    const series = assetGraficoSeries(_assetGraficoVisibles, vista, unidad)
    assetGraficoEscribir("assetGraficoEtiqueta", assetGraficoEtiquetaVista(vista))

    if (!series.ultimo || series.linea.filter((punto) => Number.isFinite(punto.y)).length < 2) {
        const hayHistorico = Boolean(_assetGraficoDatos.inicioHistorico)
        assetGraficoMostrarVacio(
            hayHistorico
                ? assetGraficoHayVentana()
                    ? "No hay suficientes datos de este activo entre esas fechas. Prueba con otras."
                    : "No hay suficientes datos de este activo en este periodo. Prueba con un rango más amplio."
                : "Todavía no hay histórico de este activo. Se construye con las valoraciones que la aplicación guarda periódicamente mientras hay posición abierta."
        )
        return
    }

    document.getElementById("assetGraficoVacio")?.classList.add("hidden")
    lienzo.classList.remove("hidden")

    const estilos = getComputedStyle(lienzo)
    const color = (variable) => estilos.getPropertyValue(variable).trim()
    const colorLinea = color("--accent")
    const colorTexto = color("--text-muted")
    const colorRejilla = color("--border-soft")
    const fondo = color("--bg-panel")

    assetGraficoRegistrarModo()
    assetGraficoDestruir()
    _assetGraficoChart = new Chart(canvas, {
        type: "line",
        data: {
            datasets: [
                {
                    label: assetGraficoEtiquetaVista(vista),
                    data: series.linea,
                    borderColor: colorLinea,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBackgroundColor: colorLinea,
                    tension: 0,
                    spanGaps: false
                },
                assetGraficoDatasetMarcas(series.compras, "Compras", color("--graficoCompra"), fondo),
                assetGraficoDatasetMarcas(series.ventas, "Ventas", color("--graficoVenta"), fondo)
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            // Por encima y por debajo queda sitio para escribir el máximo y el mínimo.
            layout: { padding: { top: 24, bottom: 8, left: 8 } },
            interaction: { mode: ASSET_GRAFICO_MODO, intersect: false },
            scales: {
                x: {
                    type: "linear",
                    bounds: "data",
                    min: series.limitesX.min,
                    max: series.limitesX.max,
                    grid: { display: false },
                    border: { color: colorRejilla },
                    ticks: {
                        color: colorTexto,
                        maxTicksLimit: 7,
                        maxRotation: 0,
                        callback: (valor) => assetGraficoFormatearEje(valor, series.limitesX.max - series.limitesX.min)
                    }
                },
                y: {
                    position: "right",
                    grace: "12%",
                    grid: { color: colorRejilla },
                    border: { display: false },
                    ticks: {
                        color: colorTexto,
                        maxTicksLimit: 6,
                        callback: (valor) => assetGraficoFormatearValor(valor, vista, unidad)
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    displayColors: false,
                    // El orden del array de la interacción pone primero la línea.
                    callbacks: {
                        title: (items) => {
                            const ts = items[0]?.raw?.x
                            return ts ? assetGraficoFormatearFecha(ts, assetGraficoConHora(rango)) : ""
                        },
                        label: (contexto) => assetGraficoEtiquetasTooltip(contexto, vista, unidad)
                    }
                }
            }
        },
        plugins: [
            assetGraficoPluginGuia(colorTexto),
            assetGraficoPluginValorCursor(
                (valor) => assetGraficoFormatearValor(valor, vista, unidad),
                colorTexto,
                fondo
            ),
            assetGraficoPluginExtremos(
                series.extremos,
                (valor) => assetGraficoFormatearValor(valor, vista, unidad),
                colorTexto
            )
        ]
    })

    assetGraficoActualizarCabecera(series.ultimo)
    assetGraficoEscribirLeyenda(series)
    assetGraficoEscribir(
        "assetGraficoNota",
        assetGraficoTextoNota(_assetGraficoVisibles, series, vista, pagina?.dataset.assetCurrency)
    )
}

/**
 * Ticker de TradingView del activo abierto, el mismo que usan Paneles y el
 * gráfico de TradingView de la ficha.
 *
 * @returns {string} El ticker, o "" si no se puede calcular.
 */
function assetGraficoSimboloTv() {
    try {
        return String(buildTVSymbol(buildCurrentAssetPayload()) || "").trim()
    } catch (error) {
        // Sin ticker el gráfico sale igual, solo con los snapshots.
        console.error("Gráfico del activo: no se pudo calcular el ticker de TradingView", error)
        return ""
    }
}

async function assetGraficoPedir(assetId, rango) {
    const params = new URLSearchParams({ rango })
    const tv = assetGraficoSimboloTv()
    if (tv) params.set("tv", tv)
    const respuesta = await fetch(`/api/activos/${encodeURIComponent(assetId)}/grafico?${params}`)
    const cuerpo = await respuesta.json()
    if (!respuesta.ok || !cuerpo.ok) throw new Error(cuerpo.error || `HTTP ${respuesta.status}`)
    return cuerpo
}

/**
 * Días con operaciones, para señalarlos en el calendario.
 *
 * @param {object[]} operaciones Operaciones del gráfico, con `fecha` en dd-mm-aaaa.
 * @returns {Map<string, Set<string>>} Fecha AAAA-MM-DD -> tipos de operación ese día.
 */
function assetGraficoDiasConOperaciones(operaciones) {
    const dias = new Map()
    ;(operaciones || []).forEach((operacion) => {
        const [dia, mes, anio] = String(operacion.fecha || "").split("-")
        if (!dia || !mes || !anio) return
        const iso = `${anio}-${mes}-${dia}`
        if (!dias.has(iso)) dias.set(iso, new Set())
        dias.get(iso).add(operacion.tipo)
    })
    return dias
}

// El calendario tiene que señalar todas las operaciones y no solo las del rango que se
// ve: si el gráfico no tiene «Todo» cargado, se pide aparte y se guarda para el activo.
async function assetGraficoAsegurarDias(assetId) {
    if (_assetGraficoDias) return
    try {
        const cuerpo =
            _assetGraficoDatos?.rango === "TODO" ? _assetGraficoDatos : await assetGraficoPedir(assetId, "TODO")
        _assetGraficoDias = assetGraficoDiasConOperaciones(cuerpo.operaciones)
    } catch (error) {
        // Sin las marcas el calendario sirve igual.
        console.error("No se pudieron cargar las operaciones para el calendario", error)
    }
}

async function assetGraficoAbrirCalendario(boton, assetId) {
    const input = boton.closest("label")?.querySelector("[data-grafico-fecha]")
    if (!input) return
    await assetGraficoAsegurarDias(assetId)
    input.calendarioMarcas = (iso) => [..._assetGraficoDias?.get(iso) || []]
    abrirCalendarioFecha(input, boton)
}

async function assetGraficoCargar(assetId) {
    const token = ++_assetGraficoToken
    const rango = assetGraficoRangoEfectivo()
    try {
        const cuerpo = await assetGraficoPedir(assetId, rango)
        // Otro rango u otro activo pueden haberse pedido entretanto.
        if (token !== _assetGraficoToken) return
        _assetGraficoDatos = cuerpo
        if (cuerpo.rango === "TODO") _assetGraficoDias = assetGraficoDiasConOperaciones(cuerpo.operaciones)
        assetGraficoDibujar()
    } catch (error) {
        if (token !== _assetGraficoToken) return
        console.error("No se pudo cargar el gráfico del activo", error)
        _assetGraficoDatos = null
        assetGraficoMostrarVacio("No se pudo cargar el gráfico de este activo.")
    }
}

function assetGraficoPulsar(boton, assetId) {
    const grupo = boton.parentElement
    grupo.querySelectorAll(".mToggleBtn").forEach((otro) => {
        otro.classList.toggle("active", otro === boton)
        otro.setAttribute("aria-pressed", String(otro === boton))
    })

    if (boton.dataset.graficoRango) {
        setChartPref("assetGraficoRango", boton.dataset.graficoRango)
        assetGraficoLimpiarVentana()
        assetGraficoCargar(assetId)
        return
    }
    if (boton.dataset.graficoVista) setChartPref("assetGraficoVista", boton.dataset.graficoVista)
    if (boton.dataset.graficoUnidad) setChartPref("assetGraficoUnidad", boton.dataset.graficoUnidad)
    assetGraficoDibujar()
}

function assetGraficoLimpiarVentana() {
    _assetGraficoVentana = { desde: "", hasta: "" }
    assetGraficoSincronizarFechas()
}

// Deja los campos de fecha, la cápsula y los botones de rango acordes con la ventana:
// con fechas el rango deja de estar activo, y cada fecha limita a la otra para que no
// se pueda cruzar el periodo.
function assetGraficoSincronizarFechas() {
    const seccion = document.getElementById("assetGraficoSection")
    if (!seccion) return
    seccion.querySelectorAll("[data-grafico-fecha]").forEach((input) => {
        const campo = input.dataset.graficoFecha
        const { min, max } = assetGraficoLimitesCampo(campo, _assetGraficoVentana)
        input.value = _assetGraficoVentana[campo]
        input.classList.toggle("vacio", !input.value)
        input.max = max
        if (min) input.min = min
        else input.removeAttribute("min")
    })
    seccion.querySelector("#assetGraficoFechas")?.classList.toggle("activo", assetGraficoHayVentana())
    seccion.querySelector("#assetGraficoFechasQuitar")?.classList.toggle("hidden", !assetGraficoHayVentana())

    const { rango } = assetGraficoEstado()
    seccion.querySelectorAll("[data-grafico-rango]").forEach((boton) => {
        const activo = !assetGraficoHayVentana() && boton.dataset.graficoRango === rango
        boton.classList.toggle("active", activo)
        boton.setAttribute("aria-pressed", String(activo))
    })
}

function assetGraficoCambiarFecha(input, assetId) {
    _assetGraficoVentana = { ..._assetGraficoVentana, [input.dataset.graficoFecha]: input.value }
    assetGraficoSincronizarFechas()
    assetGraficoCargar(assetId)
}

function assetGraficoQuitarFechas(assetId) {
    assetGraficoLimpiarVentana()
    assetGraficoCargar(assetId)
}

// Se llama al abrir la pestaña y no al pintar la ficha: la mayoría de las veces que
// se abre un activo no se mira el gráfico, y así no se piden sus datos.
function renderAssetGraficoSection() {
    const seccion = document.getElementById("assetGraficoSection")
    const assetId = document.querySelector(".assetTablePage")?.dataset.assetId
    if (!seccion || !assetId) return

    if (seccion.dataset.assetId !== assetId) {
        seccion.dataset.assetId = assetId
        _assetGraficoDatos = null
        _assetGraficoVisibles = null
        _assetGraficoVentana = { desde: "", hasta: "" }
        _assetGraficoDias = null
        assetGraficoPintarEsqueleto(seccion)
        seccion.addEventListener("click", (evento) => {
            const boton = evento.target.closest(".mToggleBtn")
            if (boton) assetGraficoPulsar(boton, assetId)
            const calendario = evento.target.closest("[data-grafico-calendario]")
            if (calendario) {
                // Dentro de un <label>: sin esto el clic también enfocaría el input.
                evento.preventDefault()
                assetGraficoAbrirCalendario(calendario, assetId)
            }
            if (evento.target.closest("#assetGraficoFechasQuitar")) assetGraficoQuitarFechas(assetId)
        })
        // Alt+↓ es el atajo del navegador para abrir su calendario nativo: abre el propio.
        seccion.addEventListener("keydown", (evento) => {
            const input = evento.target.closest("[data-grafico-fecha]")
            if (!input || !evento.altKey || evento.key !== "ArrowDown") return
            evento.preventDefault()
            assetGraficoAbrirCalendario(input.closest("label").querySelector("[data-grafico-calendario]"), assetId)
        })
        seccion.addEventListener("change", (evento) => {
            const input = evento.target.closest("[data-grafico-fecha]")
            if (input) assetGraficoCambiarFecha(input, assetId)
        })
    }
    assetGraficoCargar(assetId)
}
