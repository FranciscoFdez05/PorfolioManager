// Análisis > Herramientas: comparar varios activos en un mismo gráfico.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas-ratio-ab.js, del que usa
// hAbVelas para pedir las velas.
//
// Se eligen de dos a ocho activos (de la cartera o buscando su ticker con
// cualquiera de las APIs del modal de activo) y se solapan sus líneas. El
// histórico sale siempre del feed de TradingView (/api/market/historico): los
// tickers de otras APIs se traducen con buildTVSymbol, la misma traducción que
// usa el gráfico de la ficha, y el que no tenga velas se marca en la lista.
//
// Hay varias listas con nombre, guardadas en el navegador, que se eligen en un
// desplegable con «+ Nueva lista» a su izquierda.

const H_CMP_MAX_SERIES = 8
const H_CMP_STORAGE_KEY = "hCmpListas"
// Clave de cuando había una sola lista: se migra a la primera lista.
const H_CMP_STORAGE_KEY_ANTIGUA = "hCmpLista"
const H_CMP_MAX_LISTAS = 20
const H_CMP_NOMBRE_MAX = 40
const H_CMP_NOMBRE_POR_DEFECTO = "Mi comparación"
// Años de datos a partir de los que se calcula el CAGR (ver hCmpEstadisticas).
const H_CMP_ANOS_MIN_CAGR = 0.95
// La forma de ticker que acepta el servidor (series_tradingview._SIMBOLO_RE).
const H_CMP_TICKER_VALIDO = /^(?:[A-Z0-9_]{1,30}:)?[A-Z0-9_.!&/-]{1,40}$/
// Periodos en meses contados desde el último dato común. 0 = todo.
const H_CMP_PERIODOS = [
    { meses: 6, texto: "6 meses" },
    { meses: 12, texto: "1 año" },
    { meses: 36, texto: "3 años" },
    { meses: 60, texto: "5 años" },
    { meses: 120, texto: "10 años" },
    { meses: 0, texto: "Todo" }
]
// Nombre de la función de búsqueda de assets-ficha.js para cada botón. Se
// resuelven al pulsar: en las pruebas esos ficheros no están cargados.
const H_CMP_BUSCADORES = {
    tradingview: "handleTradingViewSearch",
    finnhub: "handleFinnhubSearch",
    eodhd: "handleEodhdSearch",
    yahoo: "handleYahooSearch",
    alphavantage: "handleAlphaVantageSearch"
}
const H_CMP_NOMBRE_PROVEEDOR = {
    tradingview: "TradingView",
    finnhub: "Finnhub",
    eodhd: "EODHD",
    yahoo: "Yahoo Finance",
    alphavantage: "Alpha Vantage"
}
// Respaldo para cuando shared-utils.js no está cargado (las pruebas).
const H_CMP_COLORES =
    typeof DISTRIBUCION_COLORES !== "undefined"
        ? DISTRIBUCION_COLORES
        : ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#22d3ee", "#fb923c", "#a3e635", "#f472b6", "#94a3b8"]

// Activos de la lista activa: [{ticker, nombre, color, sinHistorico}]. Es la
// copia de trabajo; hCmpGuardarLista la vuelca en su lista de _hCmpListas.
let _hCmpLista = []
// [{id, nombre, series: [{ticker, nombre, color}]}], en orden de creación.
let _hCmpListas = []
let _hCmpListaActiva = ""
// ticker -> {velas, divisa}: las velas no cambian mientras se está en la página.
const _hCmpVelas = new Map()
// {dias, ts, cierres: [[...] por serie], series} de la última comparación.
let _hCmpDatos = null
let _hCmpGrafico = null
// Descarta la respuesta de una comparación que se ha quedado vieja.
let _hCmpToken = 0

// ── Cálculo (sin DOM) ────────────────────────────────────────────────────

/**
 * Cruza las velas de varias series y deja solo los días con cierre en todas.
 *
 * Como en el ratio A/B, una cripto (que cotiza en fin de semana) frente a una
 * acción se compara en días hábiles: así todas parten del mismo día.
 *
 * @param {Array<Array<[number, number]>>} listaVelas `[ts, cierre]` por serie, ts en segundos o ms.
 * @returns {{dias: string[], ts: number[], cierres: number[][]}} `cierres[i]` es la serie i.
 */
function hCmpAlinear(listaVelas) {
    const vacio = { dias: [], ts: [], cierres: listaVelas.map(() => []) }
    if (!listaVelas.length) return vacio
    const mapas = listaVelas.map((velas) => {
        const mapa = new Map()
        ;(velas || []).forEach(([ts, cierre]) => {
            if (!Number.isFinite(ts) || !(cierre > 0)) return
            const ms = ts < 1e12 ? ts * 1000 : ts
            mapa.set(new Date(ms).toISOString().slice(0, 10), { ms, cierre })
        })
        return mapa
    })
    const comunes = [...mapas[0].keys()].filter((dia) => mapas.every((mapa) => mapa.has(dia))).sort()
    if (!comunes.length) return vacio
    return {
        dias: comunes,
        ts: comunes.map((dia) => mapas[0].get(dia).ms),
        cierres: mapas.map((mapa) => comunes.map((dia) => mapa.get(dia).cierre))
    }
}

/**
 * Recorta los datos alineados a los últimos `meses` meses desde el último día.
 *
 * @param {{dias: string[], ts: number[], cierres: number[][]}} datos En orden cronológico.
 * @param {number} meses 0 para todos.
 * @returns {{dias: string[], ts: number[], cierres: number[][]}}
 */
function hCmpRecortar(datos, meses) {
    if (!meses || !datos.ts.length) return datos
    const limite = new Date(datos.ts.at(-1))
    limite.setUTCMonth(limite.getUTCMonth() - meses)
    const desde = datos.ts.findIndex((ts) => ts >= limite.getTime())
    return {
        dias: datos.dias.slice(desde),
        ts: datos.ts.slice(desde),
        cierres: datos.cierres.map((serie) => serie.slice(desde))
    }
}

/**
 * Variación en % de cada cierre respecto al primero de la serie.
 *
 * @param {number[]} cierres
 * @returns {number[]}
 */
function hCmpVariacion(cierres) {
    const base = cierres[0]
    return cierres.map((cierre) => (cierre / base - 1) * 100)
}

function hCmpRendimientos(cierres) {
    const rendimientos = []
    for (let i = 1; i < cierres.length; i++) rendimientos.push(cierres[i] / cierres[i - 1] - 1)
    return rendimientos
}

/**
 * Rentabilidad, CAGR, volatilidad anualizada y caída máxima de una serie.
 *
 * Las observaciones por año salen de los propios datos (días / años
 * transcurridos) y no de un 252 fijo: tras cruzar con una cripto o con una
 * bolsa con otros festivos, el número de días por año cambia.
 *
 * @param {number[]} cierres Al menos dos, en orden cronológico.
 * @param {number[]} ts Instantes en ms de cada cierre.
 * @returns {{rentabilidad: number, cagr: number|null, volatilidad: number|null, caidaMaxima: number} | null}
 *     Todo en tanto por uno; `cagr` es null con menos de un año de datos.
 */
function hCmpEstadisticas(cierres, ts) {
    if (!cierres || cierres.length < 2) return null
    const anos = (ts.at(-1) - ts[0]) / (365.25 * 86400000)
    const rentabilidad = cierres.at(-1) / cierres[0] - 1
    const rendimientos = hCmpRendimientos(cierres)

    let volatilidad = null
    if (rendimientos.length >= 2 && anos > 0) {
        const media = rendimientos.reduce((s, r) => s + r, 0) / rendimientos.length
        const varianza = rendimientos.reduce((s, r) => s + (r - media) ** 2, 0) / (rendimientos.length - 1)
        volatilidad = Math.sqrt(varianza * (rendimientos.length / anos))
    }

    let maximo = cierres[0]
    let caidaMaxima = 0
    cierres.forEach((cierre) => {
        maximo = Math.max(maximo, cierre)
        caidaMaxima = Math.min(caidaMaxima, cierre / maximo - 1)
    })

    return {
        rentabilidad,
        // Anualizar menos de un año exagera: un +10 % en un mes no es un +214 % al año.
        // El margen es para el periodo «1 año»: su primer día común suele caer
        // unos días después de hace exactamente doce meses.
        cagr: anos >= H_CMP_ANOS_MIN_CAGR ? (cierres.at(-1) / cierres[0]) ** (1 / anos) - 1 : null,
        volatilidad,
        caidaMaxima
    }
}

/**
 * Correlación de Pearson entre los rendimientos diarios de dos series alineadas.
 *
 * @param {number[]} cierresA
 * @param {number[]} cierresB Misma longitud que `cierresA`.
 * @returns {number|null} null si alguna serie no varía o hay menos de tres cierres.
 */
function hCmpCorrelacion(cierresA, cierresB) {
    const a = hCmpRendimientos(cierresA)
    const b = hCmpRendimientos(cierresB)
    const n = Math.min(a.length, b.length)
    if (n < 2) return null
    const mediaA = a.reduce((s, r) => s + r, 0) / n
    const mediaB = b.reduce((s, r) => s + r, 0) / n
    let cov = 0
    let varA = 0
    let varB = 0
    for (let i = 0; i < n; i++) {
        cov += (a[i] - mediaA) * (b[i] - mediaB)
        varA += (a[i] - mediaA) ** 2
        varB += (b[i] - mediaB) ** 2
    }
    if (varA === 0 || varB === 0) return null
    return cov / Math.sqrt(varA * varB)
}

/**
 * Ticker de TradingView para un resultado de búsqueda de cualquier proveedor.
 *
 * @param {{symbol: string, provider?: string}} resultado Resultado del buscador.
 * @param {string} proveedor Botón con el que se buscó.
 * @returns {string} En mayúsculas; vacío si no hay ticker.
 */
function hCmpTickerDeResultado(resultado, proveedor) {
    const simbolo = String(resultado?.symbol || "").trim()
    if (!simbolo) return ""
    const proveedorReal = String(resultado.provider || proveedor || "").toLowerCase()
    const traducido =
        typeof buildTVSymbol === "function"
            ? buildTVSymbol({ marketSymbol: simbolo, marketProvider: proveedorReal, symbol: simbolo })
            : simbolo
    return String(traducido || simbolo)
        .trim()
        .toUpperCase()
}

// ── Lista de activos ─────────────────────────────────────────────────────

function hCmpMensaje(texto, aviso = false) {
    const el = document.getElementById("hCmpMsg")
    if (!el) return
    el.textContent = texto
    el.className = "hPrecargaMsg" + (aviso ? " hRatioFuenteWarn" : "")
}

/**
 * Vuelca la lista de trabajo en la lista activa y guarda todas en el navegador.
 */
function hCmpGuardarLista() {
    const activa = _hCmpListas.find((l) => l.id === _hCmpListaActiva)
    if (activa) activa.series = _hCmpLista.map(({ ticker, nombre, color }) => ({ ticker, nombre, color }))
    try {
        localStorage.setItem(H_CMP_STORAGE_KEY, JSON.stringify({ activa: _hCmpListaActiva, listas: _hCmpListas }))
    } catch (error) {
        // Sin almacenamiento (ventana privada) las listas valen para esta visita.
        console.warn("No se pudieron guardar las listas del comparador", error)
    }
}

/**
 * Deja solo las series con ticker válido, sin repetir y hasta el máximo.
 *
 * @param {unknown} series Lo leído del almacenamiento, sin fiarse de su forma.
 * @returns {{ticker: string, nombre: string, color: string}[]}
 */
function hCmpNormalizarSeries(series) {
    if (!Array.isArray(series)) return []
    const vistos = new Set()
    return series
        .filter((s) => {
            const ticker = String(s?.ticker || "")
            if (!H_CMP_TICKER_VALIDO.test(ticker) || vistos.has(ticker)) return false
            vistos.add(ticker)
            return true
        })
        .slice(0, H_CMP_MAX_SERIES)
        .map((s) => ({ ticker: s.ticker, nombre: String(s.nombre || s.ticker), color: String(s.color || "") }))
}

function hCmpNuevoId() {
    return `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Lee las listas guardadas; si no hay, migra la lista única de antes.
 *
 * Siempre devuelve al menos una lista, para que haya dónde añadir activos.
 *
 * @returns {{listas: {id: string, nombre: string, series: object[]}[], activa: string}}
 */
function hCmpLeerListas() {
    let listas = []
    let activa = ""
    try {
        const guardado = JSON.parse(localStorage.getItem(H_CMP_STORAGE_KEY) || "null")
        if (guardado && Array.isArray(guardado.listas)) {
            listas = guardado.listas
                .filter((l) => l && typeof l.id === "string" && l.id)
                .slice(0, H_CMP_MAX_LISTAS)
                .map((l) => ({
                    id: l.id,
                    nombre: String(l.nombre || "").slice(0, H_CMP_NOMBRE_MAX) || H_CMP_NOMBRE_POR_DEFECTO,
                    series: hCmpNormalizarSeries(l.series)
                }))
            activa = String(guardado.activa || "")
        } else {
            const antigua = hCmpNormalizarSeries(JSON.parse(localStorage.getItem(H_CMP_STORAGE_KEY_ANTIGUA) || "[]"))
            if (antigua.length) listas = [{ id: hCmpNuevoId(), nombre: H_CMP_NOMBRE_POR_DEFECTO, series: antigua }]
        }
    } catch (error) {
        console.warn("No se pudieron leer las listas del comparador", error)
    }
    if (!listas.length) listas = [{ id: hCmpNuevoId(), nombre: H_CMP_NOMBRE_POR_DEFECTO, series: [] }]
    if (!listas.some((l) => l.id === activa)) activa = listas[0].id
    return { listas, activa }
}

/**
 * Primer nombre libre del tipo "Lista N", sin distinguir mayúsculas.
 *
 * @param {{nombre: string}[]} listas
 * @returns {string}
 */
function hCmpNombreLibre(listas) {
    const usados = new Set(listas.map((l) => l.nombre.toLowerCase()))
    let n = listas.length + 1
    while (usados.has(`lista ${n}`)) n++
    return `Lista ${n}`
}

/**
 * Crea una lista vacía, la deja activa y abre su nombre para cambiarlo.
 *
 * @returns {boolean} Si se ha creado.
 */
function hCmpCrearLista() {
    if (_hCmpListas.length >= H_CMP_MAX_LISTAS) {
        hCmpMensaje(`Como mucho ${H_CMP_MAX_LISTAS} listas.`, true)
        return false
    }
    const lista = { id: hCmpNuevoId(), nombre: hCmpNombreLibre(_hCmpListas), series: [] }
    _hCmpListas.push(lista)
    hCmpActivarLista(lista.id)
    // Lo normal es querer llamarla de otra forma nada más crearla.
    hCmpEditarNombre()
    return true
}

/**
 * Cambia el nombre de una lista. Uno vacío no cambia nada.
 *
 * @param {string} id
 * @param {string} nombre
 * @returns {boolean} Si se ha cambiado.
 */
function hCmpRenombrarLista(id, nombre) {
    const lista = _hCmpListas.find((l) => l.id === id)
    const limpio = String(nombre || "")
        .trim()
        .slice(0, H_CMP_NOMBRE_MAX)
    if (!lista || !limpio) return false
    lista.nombre = limpio
    hCmpGuardarLista()
    return true
}

/**
 * Borra una lista. La única no se borra: se vacía con «Reiniciar».
 *
 * @param {string} id
 * @returns {boolean} Si se ha borrado.
 */
function hCmpBorrarLista(id) {
    const indice = _hCmpListas.findIndex((l) => l.id === id)
    if (indice === -1) return false
    if (_hCmpListas.length === 1) {
        hCmpMensaje("Es la única lista: vacíala con «Reiniciar» en vez de borrarla.", true)
        return false
    }
    _hCmpListas.splice(indice, 1)
    if (id === _hCmpListaActiva) {
        // La de al lado, para no saltar al principio de la tira.
        _hCmpListaActiva = ""
        hCmpActivarLista(_hCmpListas[Math.min(indice, _hCmpListas.length - 1)].id)
    } else {
        hCmpGuardarLista()
        hCmpPintarListas()
    }
    return true
}

/**
 * Carga los activos de una lista y, si tiene al menos dos, los compara.
 *
 * @param {string} id
 */
function hCmpActivarLista(id) {
    const lista = _hCmpListas.find((l) => l.id === id)
    if (!lista) return
    if (_hCmpListaActiva && _hCmpListaActiva !== id) hCmpGuardarLista()
    _hCmpListaActiva = id
    _hCmpLista = lista.series.map((s) => ({ ...s }))
    // Lo que se ve es de la lista anterior: fuera, y que no llegue tarde su respuesta.
    _hCmpToken++
    _hCmpDatos = null
    document.getElementById("hCmpResults")?.classList.add("hidden")
    const boton = document.getElementById("hCmpCalcBtn")
    if (boton) boton.disabled = false
    hCmpMensaje("")
    hCmpGuardarLista()
    hCmpPintarListas()
    hCmpPintarLista()
    if (_hCmpLista.length >= 2) hCmpComparar()
}

/**
 * Cambia el desplegable por un campo para renombrar la lista activa en el sitio.
 *
 * Se escribe en un campo y no en un prompt(): el resto de la página sigue a la
 * vista y Escape lo deja como estaba.
 */
function hCmpEditarNombre() {
    const lista = _hCmpListas.find((l) => l.id === _hCmpListaActiva)
    const fila = document.getElementById("hCmpListasFila")
    const campo = document.getElementById("hCmpListaNombre")
    if (!lista || !fila || !campo) return

    let hecho = false
    const terminar = (guardar) => {
        if (hecho) return
        hecho = true
        campo.removeEventListener("keydown", alPulsar)
        campo.removeEventListener("blur", alSalir)
        if (guardar) hCmpRenombrarLista(lista.id, campo.value)
        fila.classList.remove("renombrando")
        hCmpPintarListas()
    }
    const alPulsar = (e) => {
        if (e.key !== "Enter" && e.key !== "Escape") return
        // Sin esto, el Enter de la página pulsaría «Comparar».
        e.preventDefault()
        e.stopPropagation()
        terminar(e.key === "Enter")
    }
    const alSalir = () => terminar(true)

    campo.maxLength = H_CMP_NOMBRE_MAX
    campo.value = lista.nombre
    fila.classList.add("renombrando")
    campo.addEventListener("keydown", alPulsar)
    campo.addEventListener("blur", alSalir)
    campo.focus()
    campo.select()
}

function hCmpPedirBorrarLista() {
    const lista = _hCmpListas.find((l) => l.id === _hCmpListaActiva)
    if (!lista) return
    if (_hCmpListas.length === 1) {
        hCmpBorrarLista(lista.id)
        return
    }
    const cuantos = _hCmpLista.length
    const mensaje = `Se borrará «${lista.nombre}» con sus ${cuantos} activo${cuantos === 1 ? "" : "s"}. No se puede deshacer.`
    if (typeof openConfirmModal === "function" && document.getElementById("confirmModalOverlay")) {
        openConfirmModal({
            title: "Borrar lista",
            message: mensaje,
            confirmLabel: "Borrar",
            onConfirm: () => hCmpBorrarLista(lista.id)
        })
    } else if (window.confirm(mensaje)) {
        hCmpBorrarLista(lista.id)
    }
}

/**
 * Rellena el desplegable de listas con su número de activos y deja elegida la activa.
 *
 * Es un <select> normal: shared-utils.js lo convierte en el desplegable de la
 * aplicación y lo vuelve a sincronizar cada vez que cambian sus opciones.
 */
function hCmpPintarListas() {
    const select = document.getElementById("hCmpListaSelect")
    if (!select) return
    const opciones = _hCmpListas.map((lista) => {
        const cuantos = lista.id === _hCmpListaActiva ? _hCmpLista.length : lista.series.length
        const opcion = document.createElement("option")
        opcion.value = lista.id
        opcion.textContent = `${lista.nombre} (${cuantos})`
        opcion.selected = lista.id === _hCmpListaActiva
        return opcion
    })
    select.replaceChildren(...opciones)
    select.value = _hCmpListaActiva

    const nueva = document.getElementById("hCmpListaNuevaBtn")
    if (nueva) nueva.disabled = _hCmpListas.length >= H_CMP_MAX_LISTAS
    const borrar = document.getElementById("hCmpListaBorrarBtn")
    if (borrar) borrar.disabled = _hCmpListas.length <= 1
}

function hCmpConectarListas() {
    document.getElementById("hCmpListaNuevaBtn")?.addEventListener("click", hCmpCrearLista)
    document.getElementById("hCmpListaRenombrarBtn")?.addEventListener("click", hCmpEditarNombre)
    document.getElementById("hCmpListaBorrarBtn")?.addEventListener("click", hCmpPedirBorrarLista)
    document.getElementById("hCmpListaSelect")?.addEventListener("change", (e) => {
        if (e.target.value !== _hCmpListaActiva) hCmpActivarLista(e.target.value)
    })
}

function hCmpColorLibre() {
    const usados = new Set(_hCmpLista.map((s) => s.color))
    return H_CMP_COLORES.find((c) => !usados.has(c)) || H_CMP_COLORES[_hCmpLista.length % H_CMP_COLORES.length]
}

/**
 * Añade una serie a la lista si cabe y no está ya.
 *
 * @param {string} ticker Ticker de TradingView.
 * @param {string} nombre Lo que se muestra en la lista y la leyenda.
 * @param {string} [color] Color del activo en la cartera, si tiene.
 * @returns {boolean} Si se ha añadido.
 */
function hCmpAnadir(ticker, nombre, color = "") {
    const limpio = String(ticker || "")
        .trim()
        .toUpperCase()
    if (!H_CMP_TICKER_VALIDO.test(limpio)) {
        hCmpMensaje(`«${ticker}» no tiene forma de ticker (p. ej. NASDAQ:NVDA o AMD).`, true)
        return false
    }
    if (_hCmpLista.some((s) => s.ticker === limpio)) {
        hCmpMensaje(`${limpio} ya está en la lista.`, true)
        return false
    }
    if (_hCmpLista.length >= H_CMP_MAX_SERIES) {
        hCmpMensaje(`Como mucho ${H_CMP_MAX_SERIES} activos a la vez.`, true)
        return false
    }
    const colorLibre = color && !_hCmpLista.some((s) => s.color === color) ? color : hCmpColorLibre()
    _hCmpLista.push({ ticker: limpio, nombre: String(nombre || limpio).trim() || limpio, color: colorLibre })
    hCmpMensaje("")
    hCmpListaCambiada()
    return true
}

function hCmpQuitar(ticker) {
    _hCmpLista = _hCmpLista.filter((s) => s.ticker !== ticker)
    hCmpListaCambiada()
}

function hCmpListaCambiada() {
    hCmpGuardarLista()
    hCmpPintarLista()
    hCmpPintarListas()
    // Con una comparación a la vista, se rehace sola: es lo que espera quien
    // añade o quita un activo mirando el gráfico.
    if (_hCmpDatos) hCmpComparar()
}

function hCmpPintarLista() {
    const lista = document.getElementById("hCmpLista")
    if (!lista) return
    lista.innerHTML = ""
    _hCmpLista.forEach((serie) => {
        const fila = document.createElement("li")
        fila.className = "hCmpChip" + (serie.sinHistorico ? " hCmpChipError" : "")
        fila.title = serie.sinHistorico ? "Sin histórico en TradingView: busca su ticker con TradingView" : serie.ticker

        const color = document.createElement("span")
        color.className = "hCmpChipColor"
        color.style.background = serie.color

        const texto = document.createElement("span")
        texto.className = "hCmpChipTexto"
        texto.textContent = serie.nombre === serie.ticker ? serie.ticker : `${serie.nombre} · ${serie.ticker}`

        const quitar = document.createElement("button")
        quitar.type = "button"
        quitar.className = "hCmpChipQuitar"
        quitar.textContent = "×"
        quitar.setAttribute("aria-label", `Quitar ${serie.ticker}`)
        quitar.dataset.ticker = serie.ticker

        fila.append(color, texto, quitar)
        lista.appendChild(fila)
    })
    const contador = document.getElementById("hCmpContador")
    if (contador) contador.textContent = `${_hCmpLista.length}/${H_CMP_MAX_SERIES}`
}

// ── Fuentes: cartera y buscadores ────────────────────────────────────────

async function hCmpCargarActivos() {
    let activos
    try {
        activos = await hActivos()
    } catch (error) {
        console.error(error)
        return
    }
    const select = document.getElementById("hCmpActivo")
    if (!select) return
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

async function hCmpAnadirDeCartera() {
    const select = document.getElementById("hCmpActivo")
    if (!select?.value) {
        hCmpMensaje("Elige antes un activo de tu cartera.", true)
        return
    }
    let activo
    try {
        activo = (await hActivos()).find((a) => a.id === select.value)
    } catch (error) {
        console.error(error)
    }
    if (!activo) return
    const ticker = String(
        (typeof buildTVSymbol === "function" ? buildTVSymbol(activo) : activo.tvSymbol || activo.symbol) || ""
    ).trim()
    if (!ticker) {
        hCmpMensaje(`${activo.name} no tiene ticker: añádelo con el buscador.`, true)
        return
    }
    if (hCmpAnadir(ticker, activo.name, activo.color || "")) select.value = ""
}

function hCmpAnadirEscrito() {
    const entrada = document.getElementById("hCmpTicker")
    const texto = entrada?.value.trim() || ""
    if (!texto) {
        hCmpMensaje("Escribe un ticker o búscalo con una de las APIs.", true)
        return
    }
    if (hCmpAnadir(texto, texto.toUpperCase())) entrada.value = ""
}

async function hCmpBuscar(proveedor) {
    const buscador = globalThis[H_CMP_BUSCADORES[proveedor]]
    if (typeof buscador !== "function") return
    const entrada = document.getElementById("hCmpTicker")
    const resultados = document.getElementById("hCmpResultados")
    await buscador({
        query: entrada?.value.trim() || "",
        feedbackElement: document.getElementById("hCmpBuscarMsg"),
        resultsElement: resultados,
        onSelect: (resultado) => {
            const ticker = hCmpTickerDeResultado(resultado, proveedor)
            if (!ticker) return
            const nombre = String(resultado.description || "").trim() || ticker
            if (hCmpAnadir(ticker, nombre) && entrada) entrada.value = ""
            if (typeof setAssetSearchFeedback === "function") {
                setAssetSearchFeedback(
                    document.getElementById("hCmpBuscarMsg"),
                    `Añadido (${H_CMP_NOMBRE_PROVEEDOR[proveedor]}): ${ticker}`
                )
            }
            if (typeof renderMarketSearchResults === "function") renderMarketSearchResults(resultados, [], () => {})
        }
    })
}

// ── Comparación ──────────────────────────────────────────────────────────

async function hCmpVelasDe(ticker) {
    if (_hCmpVelas.has(ticker)) return _hCmpVelas.get(ticker)
    const datos = await hAbVelas(ticker)
    // Solo se guardan las que tienen velas: un fallo del feed puede ser pasajero.
    if (datos.velas.length >= 2) _hCmpVelas.set(ticker, datos)
    return datos
}

async function hCmpComparar() {
    if (_hCmpLista.length < 2) {
        // Tras quitar uno, lo que se ve ya no corresponde a la lista.
        document.getElementById("hCmpResults")?.classList.add("hidden")
        hCmpMensaje("Añade al menos dos activos para compararlos.", true)
        return
    }
    const token = ++_hCmpToken
    const boton = document.getElementById("hCmpCalcBtn")
    if (boton) boton.disabled = true
    hCmpMensaje("Cargando históricos…")
    const series = [..._hCmpLista]
    try {
        const respuestas = await Promise.allSettled(series.map((s) => hCmpVelasDe(s.ticker)))
        if (token !== _hCmpToken) return

        const conDatos = []
        respuestas.forEach((respuesta, i) => {
            const ok = respuesta.status === "fulfilled" && respuesta.value.velas.length >= 2
            series[i].sinHistorico = !ok
            if (ok) conDatos.push({ serie: series[i], ...respuesta.value })
            else if (respuesta.status === "rejected") console.error(respuesta.reason)
        })
        hCmpPintarLista()

        const sinHistorico = series.filter((s) => s.sinHistorico).map((s) => s.ticker)
        const avisoFaltan = sinHistorico.length ? ` Sin histórico: ${sinHistorico.join(", ")}.` : ""
        if (conDatos.length < 2) {
            hCmpMensaje(`Hacen falta al menos dos activos con histórico.${avisoFaltan}`, true)
            return
        }

        const alineado = hCmpAlinear(conDatos.map((d) => d.velas))
        if (alineado.dias.length < 2) {
            hCmpMensaje(`No hay días con cotización de todos a la vez.${avisoFaltan}`, true)
            return
        }
        _hCmpDatos = { ...alineado, series: conDatos.map((d) => ({ ...d.serie, divisa: d.divisa })) }

        const divisas = new Set(conDatos.map((d) => d.divisa).filter(Boolean))
        const avisoDivisas =
            divisas.size > 1 ? ` Cotizan en ${[...divisas].join(", ")}: cada uno se mide en su divisa.` : ""
        hCmpMensaje(
            `${alineado.dias.length} días en común, desde ${alineado.dias[0]}.${avisoFaltan}${avisoDivisas}`,
            Boolean(avisoFaltan || avisoDivisas)
        )
        hCmpPintar()
    } finally {
        if (boton && token === _hCmpToken) boton.disabled = false
    }
}

function hCmpPorcentaje(valor, conSigno = true) {
    if (valor === null || !Number.isFinite(valor)) return "---"
    return `${(valor * 100).toLocaleString("es-ES", {
        maximumFractionDigits: 1,
        minimumFractionDigits: 1,
        signDisplay: conSigno ? "always" : "auto"
    })} %`
}

function hCmpPintar() {
    if (!_hCmpDatos) return
    const meses = parseInt(document.getElementById("hCmpPeriodo")?.value ?? "0", 10) || 0
    const datos = hCmpRecortar(_hCmpDatos, meses)
    if (datos.dias.length < 2) {
        hCmpMensaje("En ese periodo no hay datos suficientes.", true)
        return
    }
    const series = _hCmpDatos.series
    hCmpPintarTabla(datos, series)
    hCmpPintarCorrelaciones(datos, series)
    document.getElementById("hCmpResults")?.classList.remove("hidden")
    hCmpGrafico(datos, series)
}

function hCmpCelda(fila, texto, clase = "") {
    const celda = document.createElement("td")
    celda.textContent = texto
    if (clase) celda.className = clase
    fila.appendChild(celda)
    return celda
}

function hCmpEtiqueta(fila, serie) {
    const celda = document.createElement("td")
    const color = document.createElement("span")
    color.className = "hCmpChipColor"
    color.style.background = serie.color
    celda.append(color, document.createTextNode(` ${serie.nombre === serie.ticker ? serie.ticker : serie.nombre}`))
    celda.title = serie.ticker
    fila.appendChild(celda)
}

function hCmpPintarTabla(datos, series) {
    const cuerpo = document.getElementById("hCmpTabla")
    if (!cuerpo) return
    cuerpo.innerHTML = ""
    const signo = (v) => (v === null ? "" : v >= 0 ? "hCmpPos" : "hCmpNeg")
    series.forEach((serie, i) => {
        const e = hCmpEstadisticas(datos.cierres[i], datos.ts)
        const fila = document.createElement("tr")
        hCmpEtiqueta(fila, serie)
        const ultimo = datos.cierres[i].at(-1)
        hCmpCelda(
            fila,
            `${ultimo.toLocaleString("es-ES", { maximumFractionDigits: ultimo >= 1 ? 2 : 6 })} ${serie.divisa || ""}`.trim()
        )
        hCmpCelda(fila, hCmpPorcentaje(e?.rentabilidad ?? null), signo(e?.rentabilidad ?? null))
        hCmpCelda(fila, hCmpPorcentaje(e?.cagr ?? null), signo(e?.cagr ?? null))
        hCmpCelda(fila, hCmpPorcentaje(e?.volatilidad ?? null, false))
        hCmpCelda(fila, hCmpPorcentaje(e?.caidaMaxima ?? null), "hCmpNeg")
        cuerpo.appendChild(fila)
    })
}

function hCmpPintarCorrelaciones(datos, series) {
    const tabla = document.getElementById("hCmpCorr")
    if (!tabla) return
    tabla.innerHTML = ""
    const cabecera = document.createElement("tr")
    cabecera.appendChild(document.createElement("th"))
    series.forEach((serie) => {
        const th = document.createElement("th")
        th.textContent = serie.ticker.split(":").pop()
        th.title = serie.ticker
        cabecera.appendChild(th)
    })
    const thead = document.createElement("thead")
    thead.appendChild(cabecera)
    const tbody = document.createElement("tbody")
    series.forEach((serie, i) => {
        const fila = document.createElement("tr")
        hCmpEtiqueta(fila, serie)
        series.forEach((_, j) => {
            const r = i === j ? 1 : hCmpCorrelacion(datos.cierres[i], datos.cierres[j])
            const celda = hCmpCelda(
                fila,
                r === null ? "---" : r.toLocaleString("es-ES", { maximumFractionDigits: 2, minimumFractionDigits: 2 })
            )
            // La intensidad del fondo dice lo mismo que la cifra, para leer la
            // matriz de un vistazo; el signo va en el color.
            if (r !== null && i !== j) {
                celda.style.setProperty("--hCmpCorrAlfa", String(Math.round(Math.abs(r) * 40) / 100))
                celda.className = r >= 0 ? "hCmpCorrPos" : "hCmpCorrNeg"
            }
        })
        tbody.appendChild(fila)
    })
    tabla.append(thead, tbody)
}

function hCmpGrafico(datos, series) {
    if (_hCmpGrafico) {
        _hCmpGrafico.destroy()
        _hCmpGrafico = null
    }
    const lienzo = document.getElementById("hCmpChart")
    if (!lienzo || typeof Chart === "undefined") return
    const tema = hChartTheme()
    const modoPrecio = document.getElementById("hCmpModo")?.value === "precio"
    _hCmpGrafico = new Chart(lienzo, {
        type: "line",
        data: {
            labels: datos.dias,
            datasets: series.map((serie, i) => ({
                label: serie.nombre === serie.ticker ? serie.ticker : `${serie.nombre} (${serie.ticker})`,
                data: modoPrecio ? datos.cierres[i] : hCmpVariacion(datos.cierres[i]),
                borderColor: serie.color,
                backgroundColor: serie.color,
                borderWidth: 1.5,
                pointRadius: 0,
                tension: 0.1,
                fill: false
            }))
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 300 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: { labels: { color: tema.text, font: { size: 12 }, padding: 12, boxWidth: 12 } },
                tooltip: {
                    callbacks: {
                        label: (c) => {
                            const valor = c.raw.toLocaleString("es-ES", {
                                maximumFractionDigits: 2,
                                signDisplay: modoPrecio ? "auto" : "always"
                            })
                            const unidad = modoPrecio ? ` ${series[c.datasetIndex].divisa || ""}` : " %"
                            return `  ${c.dataset.label}: ${valor}${unidad}`
                        }
                    }
                }
            },
            scales: {
                x: { ticks: { color: tema.muted, font: { size: 11 }, maxTicksLimit: 10 }, grid: { color: tema.grid } },
                y: {
                    // En precio, escala logarítmica: con activos de 5 € y de
                    // 60.000 $ en el mismo eje, la lineal aplasta al barato.
                    type: modoPrecio ? "logarithmic" : "linear",
                    ticks: {
                        color: tema.muted,
                        font: { size: 11 },
                        callback: (v) => {
                            if (!modoPrecio) return `${Number(v).toLocaleString("es-ES")} %`
                            // La escala logarítmica marca 1…9 de cada década y las
                            // etiquetas se pisan: solo se rotulan 1, 2 y 5.
                            const mantisa = Math.round(v / 10 ** Math.floor(Math.log10(v)))
                            return [1, 2, 5].includes(mantisa) ? Number(v).toLocaleString("es-ES") : ""
                        }
                    },
                    grid: { color: tema.grid }
                }
            }
        }
    })
}

// ── Montaje ──────────────────────────────────────────────────────────────

function hCmpIniciar() {
    const periodo = document.getElementById("hCmpPeriodo")
    if (periodo && !periodo.options.length) {
        H_CMP_PERIODOS.forEach(({ meses, texto }) => {
            const opcion = document.createElement("option")
            opcion.value = String(meses)
            opcion.textContent = texto
            periodo.appendChild(opcion)
        })
        periodo.value = "12"
    }
    periodo?.addEventListener("change", hCmpPintar)
    document.getElementById("hCmpModo")?.addEventListener("change", hCmpPintar)
    document.getElementById("hCmpCalcBtn")?.addEventListener("click", hCmpComparar)
    document.getElementById("hCmpActivoBtn")?.addEventListener("click", hCmpAnadirDeCartera)
    document.getElementById("hCmpTickerBtn")?.addEventListener("click", hCmpAnadirEscrito)
    document.getElementById("hCmpBuscarAcciones")?.addEventListener("click", (e) => {
        const boton = e.target.closest("[data-provider]")
        if (boton) hCmpBuscar(boton.dataset.provider)
    })
    document.getElementById("hCmpLista")?.addEventListener("click", (e) => {
        const quitar = e.target.closest(".hCmpChipQuitar")
        if (quitar) hCmpQuitar(quitar.dataset.ticker)
    })
    document.getElementById("hCmpTicker")?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return
        // Enter añade lo escrito; el de la página pulsaría «Comparar».
        e.preventDefault()
        e.stopPropagation()
        hCmpAnadirEscrito()
    })
    hCmpConectarListas()
    const { listas, activa } = hCmpLeerListas()
    _hCmpListas = listas
    _hCmpListaActiva = activa
    _hCmpLista = (listas.find((l) => l.id === activa)?.series || []).map((s) => ({ ...s }))
    hCmpGuardarLista()
    // La clave antigua ya está migrada a la primera lista.
    try {
        localStorage.removeItem(H_CMP_STORAGE_KEY_ANTIGUA)
    } catch (error) {
        console.warn("No se pudo borrar la lista antigua del comparador", error)
    }
    hCmpPintarListas()
    hCmpPintarLista()
    hCmpCargarActivos()
}

function hCmpReiniciar(panelId) {
    if (panelId !== "toolComparador") return
    _hCmpToken++
    _hCmpDatos = null
    // Vacía la lista activa; las demás listas se quedan como estaban.
    _hCmpLista = []
    hCmpGuardarLista()
    hCmpPintarLista()
    hCmpPintarListas()
    hCmpMensaje("")
    if (_hCmpGrafico) {
        _hCmpGrafico.destroy()
        _hCmpGrafico = null
    }
    const boton = document.getElementById("hCmpCalcBtn")
    if (boton) boton.disabled = false
}
