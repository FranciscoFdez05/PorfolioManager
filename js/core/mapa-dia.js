// Minigráfico del día y vista previa de TradingView en los mapas de calor.
//
// La vista previa la usan el mapa de Análisis (heatmap.js) y el widget «Mapa»
// de Paneles; el minigráfico, solo Paneles. El mapa pinta sus baldosas como
// siempre y marca su lienzo con
// `data-mapa-dia` y cada baldosa con `data-serie-id`. Después, este módulo mete
// en cada baldosa la línea de hoy. El eje va siempre de las 00:00 a las 24:00,
// así que la línea llega hasta la hora actual y se va completando a lo largo
// del día. Los minigráficos se refrescan solos mientras haya un mapa a la vista.

// La serie sale de los snapshots, que se guardan cada pocos minutos: pedirla
// más a menudo no traería puntos nuevos.
const MAPA_DIA_TTL = 60 * 1000
const MAPA_DIA_REFRESCO = 5 * 60 * 1000
// Por debajo de esta medida la línea no se distingue y solo tapa el rótulo.
const MAPA_DIA_ANCHO_MIN = 70
const MAPA_DIA_ALTO_MIN = 64
// Lo mínimo que tiene que abarcar la serie de hoy para pintarla (ver mapaDiaSerieUtil).
const MAPA_DIA_COBERTURA_MIN = 3600
// Retardo antes de abrir la vista previa: al cruzar el mapa con el ratón no se
// carga un iframe por cada baldosa que se toca de pasada.
const MAPA_DIA_RETARDO_TV = 200
const MAPA_DIA_TV_ANCHO = 440
const MAPA_DIA_TV_ALTO = 280
// Vistas previas que se quedan cargadas (ocultas) para que volver a una
// baldosa ya vista sea inmediato. Crear el iframe de TradingView cuesta ~1 s
// aunque su código ya esté en la caché del navegador, porque arranca la
// aplicación de gráficos entera; cada uno vivo ocupa memoria, de ahí el tope.
const MAPA_DIA_TV_MAX_MARCOS = 6

let _mapaDiaCache = null // { datos, ts }
let _mapaDiaPeticion = null
let _mapaDiaRefresco = null
let _mapaDiaTvTimer = null
let _mapaDiaTvSimbolo = ""
// URL → iframe. Map conserva el orden de inserción: el primero es el que hace
// más tiempo que no se usa y el que sale al pasar del tope.
const _mapaDiaTvMarcos = new Map()

/**
 * Serie de hoy de todos los activos, cacheada un minuto y compartida entre los
 * mapas: dos mapas en pantalla hacen una sola petición.
 *
 * @returns {Promise<object|null>} `{inicio, fin, segundosHueco, series}` o null si falla.
 */
function mapaDiaCargar() {
    if (_mapaDiaCache && Date.now() - _mapaDiaCache.ts < MAPA_DIA_TTL) return Promise.resolve(_mapaDiaCache.datos)
    if (!_mapaDiaPeticion) {
        _mapaDiaPeticion = fetch("/api/activos-serie-dia")
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                if (!json?.ok) return null
                _mapaDiaCache = { datos: json, ts: Date.now() }
                return json
            })
            .catch((error) => {
                console.error("Mapa: no se pudo cargar la serie del día", error)
                return null
            })
            .finally(() => {
                _mapaDiaPeticion = null
            })
    }
    return _mapaDiaPeticion
}

/**
 * Trazado SVG de una línea en una caja de 1000×100, cortada donde faltan datos.
 *
 * @param {Array<[number, number]>} puntos Pares `[ts, valor]` ordenados.
 * @param {number} inicio Inicio del eje X (ts).
 * @param {number} fin Fin del eje X (ts).
 * @param {number} hueco Segundos sin datos a partir de los que se corta la línea.
 * @returns {{linea: string, area: string}} Atributos `d` de la línea y del relleno.
 */
function mapaDiaTrazado(puntos, inicio, fin, hueco) {
    const valores = puntos.map((p) => p[1])
    const min = Math.min(...valores)
    const max = Math.max(...valores)
    // Plano todo el día: la línea va por el centro en vez de pegada a un borde.
    const rango = max - min || Math.abs(max) || 1
    const base = max - min ? min : min - rango / 2
    const x = (ts) => (((ts - inicio) / (fin - inicio)) * 1000).toFixed(1)
    // 8 de margen arriba y abajo para que el trazo no se corte en los extremos.
    const y = (v) => (92 - ((v - base) / rango) * 84).toFixed(1)

    const tramos = []
    puntos.forEach((p, i) => {
        if (i === 0 || p[0] - puntos[i - 1][0] > hueco) tramos.push([])
        tramos[tramos.length - 1].push(p)
    })
    const linea = tramos.map((t) => t.map((p, i) => `${i ? "L" : "M"}${x(p[0])},${y(p[1])}`).join("")).join("")
    const area = tramos
        .filter((t) => t.length > 1)
        .map(
            (t) => `M${x(t[0][0])},100${t.map((p) => `L${x(p[0])},${y(p[1])}`).join("")}L${x(t[t.length - 1][0])},100Z`
        )
        .join("")
    return { linea, area }
}

/**
 * SVG del minigráfico del día para una baldosa.
 *
 * @param {Array<[number, number]>|undefined} puntos Serie del activo.
 * @param {object} datos Respuesta de `mapaDiaCargar`.
 * @returns {string} El SVG, o cadena vacía si no hay dos puntos que unir.
 */
function mapaDiaSvg(puntos, datos) {
    if (!Array.isArray(puntos) || puntos.length < 2) return ""
    const { linea, area } = mapaDiaTrazado(puntos, datos.inicio, datos.fin, datos.segundosHueco || 7200)
    return `<svg class="mapaDiaLinea" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
        <path class="mapaDiaArea" d="${area}"/>
        <path class="mapaDiaTrazo" d="${linea}" vector-effect="non-scaling-stroke"/>
    </svg>`
}

/**
 * La serie si cubre lo bastante del día para decir algo. Con unos minutos de
 * snapshots (el servidor acaba de arrancar) la escala vertical estira cualquier
 * movimiento de céntimos de borde a borde y sale una raya suelta, y el máximo
 * y el mínimo serían los de ese rato y no los del día.
 *
 * @param {Array<[number, number]>|undefined} puntos Serie del activo.
 * @returns {Array<[number, number]>|undefined} La misma serie, o nada si es corta.
 */
function mapaDiaSerieUtil(puntos) {
    if (!Array.isArray(puntos) || puntos.length < 2) return undefined
    return puntos[puntos.length - 1][0] - puntos[0][0] >= MAPA_DIA_COBERTURA_MIN ? puntos : undefined
}

/**
 * Mete o actualiza el minigráfico en las baldosas de un lienzo.
 *
 * @param {HTMLElement} lienzo Contenedor con baldosas `[data-serie-id]`.
 * @param {object} datos Respuesta de `mapaDiaCargar`.
 */
function mapaDiaPintarEn(lienzo, datos) {
    lienzo.querySelectorAll("[data-serie-id]").forEach((celda) => {
        celda.querySelector(".mapaDiaLinea")?.remove()
        const puntos = mapaDiaSerieUtil(datos.series?.[celda.dataset.serieId])
        lienzo._mapaDiaAlPintar?.(celda, puntos)
        if (celda.offsetWidth < MAPA_DIA_ANCHO_MIN || celda.offsetHeight < MAPA_DIA_ALTO_MIN) return
        const svg = mapaDiaSvg(puntos, datos)
        if (svg) celda.insertAdjacentHTML("afterbegin", svg)
    })
}

/**
 * Activa los minigráficos del día en un mapa recién pintado.
 *
 * @param {HTMLElement} lienzo Contenedor de las baldosas.
 * @param {boolean} activo Si el mapa está en el periodo «Hoy»; si no, se
 *     desmarca el lienzo para que el refresco lo ignore.
 * @param {Function} [alPintar] `(celda, puntos)` por cada baldosa al llegar la
 *     serie, también en cada refresco: lo que la baldosa saca de la línea (el
 *     máximo y el mínimo del día en la rejilla de Paneles). `puntos` puede
 *     faltar si el activo no tiene serie.
 */
function mapaDiaActivar(lienzo, activo, alPintar = null) {
    if (!lienzo) return
    lienzo._mapaDiaAlPintar = alPintar
    if (!activo) {
        delete lienzo.dataset.mapaDia
        return
    }
    lienzo.dataset.mapaDia = "true"
    mapaDiaCargar().then((datos) => {
        if (datos && lienzo.isConnected && lienzo.dataset.mapaDia) mapaDiaPintarEn(lienzo, datos)
    })
    mapaDiaProgramarRefresco()
}

/**
 * Refresco periódico mientras quede algún mapa del día en la página. Se para
 * solo cuando ya no hay ninguno, sin que cada vista tenga que acordarse.
 */
function mapaDiaProgramarRefresco() {
    if (_mapaDiaRefresco) return
    _mapaDiaRefresco = setInterval(() => {
        const lienzos = [...document.querySelectorAll("[data-mapa-dia]")]
        if (!lienzos.length) {
            clearInterval(_mapaDiaRefresco)
            _mapaDiaRefresco = null
            return
        }
        // Con la pestaña oculta no se pide nada; al volver, el siguiente ciclo lo pone al día.
        if (document.hidden) return
        _mapaDiaCache = null
        mapaDiaCargar().then((datos) => {
            if (datos) lienzos.filter((l) => l.isConnected).forEach((l) => mapaDiaPintarEn(l, datos))
        })
    }, MAPA_DIA_REFRESCO)
}

// ── Vista previa de TradingView ─────────────────────────────────────────────

// Velas diarias siempre, sea cual sea el periodo del mapa: muchos símbolos
// (acciones de bolsas europeas, por ejemplo) solo tienen intervalos D, W y M en
// TradingView, y con velas de minutos u horas el gráfico salía vacío. Sin
// `range`: TradingView elige el intervalo a partir del rango y pasa por encima
// de `interval` («3M» da velas de horas y vuelve a fallar).
const MAPA_DIA_INTERVALO_TV = "D"

/**
 * URL del gráfico de velas de TradingView para la vista previa.
 *
 * Es el gráfico avanzado (`widgetembed`), el mismo del modal y de Paneles: el
 * mini-symbol-overview que había antes solo dibuja una línea. Va sin barras de
 * herramientas ni volumen, porque la vista previa no se puede tocar.
 *
 * @param {string} simbolo Símbolo de TradingView.
 * @returns {string} La URL del iframe.
 */
function mapaDiaUrlTv(simbolo) {
    const claro = document.documentElement.getAttribute("data-theme") === "light"
    const p = new URLSearchParams({
        symbol: simbolo,
        interval: MAPA_DIA_INTERVALO_TV,
        // 1 = velas japonesas.
        style: "1",
        theme: claro ? "light" : "dark",
        locale: "es",
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
        // Con guion bajo: widgetembed ignora las variantes sin él (ver paneles.js).
        hide_side_toolbar: "1",
        hide_top_toolbar: "1",
        hide_volume: "1",
        symboledit: "0",
        saveimage: "0"
    })
    return `https://www.tradingview.com/widgetembed/?${p.toString()}`
}

function mapaDiaCajaTv() {
    let caja = document.getElementById("mapaDiaTv")
    if (!caja) {
        caja = document.createElement("div")
        caja.id = "mapaDiaTv"
        caja.className = "mapaDiaTv"
        document.body.appendChild(caja)
    }
    return caja
}

// Junto a la baldosa: a la derecha si cabe y si no a la izquierda, y siempre
// dentro de la ventana.
function mapaDiaColocarTv(caja, celda) {
    const r = celda.getBoundingClientRect()
    const margen = 8
    let x = r.right + margen
    if (x + MAPA_DIA_TV_ANCHO > window.innerWidth - 4) x = r.left - MAPA_DIA_TV_ANCHO - margen
    if (x < 4) x = Math.max(4, Math.min(r.left, window.innerWidth - MAPA_DIA_TV_ANCHO - 4))
    const y = Math.max(4, Math.min(r.top, window.innerHeight - MAPA_DIA_TV_ALTO - 4))
    caja.style.left = x + "px"
    caja.style.top = y + "px"
}

/**
 * El iframe de la vista previa de `simbolo`, reutilizando el que ya esté cargado.
 *
 * La clave es la URL y no el símbolo: con otro tema la URL cambia y hace falta
 * un iframe nuevo; el del tema anterior acaba saliendo por el tope.
 *
 * @param {HTMLElement} caja Contenedor de la vista previa.
 * @param {string} simbolo Símbolo de TradingView.
 * @returns {HTMLIFrameElement} El iframe, ya dentro de la caja.
 */
function mapaDiaMarcoTv(caja, simbolo) {
    const url = mapaDiaUrlTv(simbolo)
    let marco = _mapaDiaTvMarcos.get(url)
    if (marco?.isConnected) {
        _mapaDiaTvMarcos.delete(url)
    } else {
        marco = document.createElement("iframe")
        // sandbox antes que src: si se pone después, la primera carga va sin él.
        marco.setAttribute("sandbox", "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox")
        marco.setAttribute("frameborder", "0")
        marco.setAttribute("allowtransparency", "true")
        marco.setAttribute("scrolling", "no")
        marco.referrerPolicy = "no-referrer"
        marco.title = simbolo
        marco.src = url
        caja.appendChild(marco)
    }
    _mapaDiaTvMarcos.set(url, marco)
    while (_mapaDiaTvMarcos.size > MAPA_DIA_TV_MAX_MARCOS) {
        const [masAntigua, viejo] = _mapaDiaTvMarcos.entries().next().value
        viejo.remove()
        _mapaDiaTvMarcos.delete(masAntigua)
    }
    return marco
}

/**
 * Carga en segundo plano la vista previa de un activo del mapa recién pintado.
 *
 * La primera vista previa de la sesión descarga la aplicación de gráficos de
 * TradingView (varios segundos en frío); hacerlo mientras el navegador está
 * libre evita que esa espera caiga en el primer paso del ratón. Solo se hace
 * si todavía no hay ninguna cargada.
 *
 * @param {string} [simbolo] Símbolo de TradingView de alguna baldosa.
 */
function mapaDiaPrecalentarTv(simbolo) {
    if (!simbolo || _mapaDiaTvMarcos.size) return
    const tarea = () => {
        if (!_mapaDiaTvMarcos.size) mapaDiaMarcoTv(mapaDiaCajaTv(), simbolo)
    }
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(tarea, { timeout: 3000 })
    else setTimeout(tarea, 1000)
}

/**
 * Abre, tras un instante, la vista previa de TradingView junto a una baldosa.
 * Si ya está abierta con el mismo símbolo solo se recoloca, sin recargar el iframe.
 *
 * @param {HTMLElement} celda Baldosa sobre la que está el cursor.
 * @param {string} simbolo Símbolo de TradingView.
 */
function mapaDiaMostrarTv(celda, simbolo) {
    const caja = mapaDiaCajaTv()
    const clave = simbolo
    if (clave === _mapaDiaTvSimbolo && caja.classList.contains("mapaDiaTvVisible")) {
        // Se cancela la de la baldosa por la que se pasó de camino: si no, se
        // abriría encima de esta.
        clearTimeout(_mapaDiaTvTimer)
        delete caja.dataset.pendiente
        mapaDiaColocarTv(caja, celda)
        return
    }
    if (caja.dataset.pendiente === clave) return
    clearTimeout(_mapaDiaTvTimer)
    caja.dataset.pendiente = clave
    _mapaDiaTvTimer = setTimeout(() => {
        delete caja.dataset.pendiente
        if (!celda.isConnected) return
        _mapaDiaTvSimbolo = clave
        const marco = mapaDiaMarcoTv(caja, simbolo)
        caja.querySelectorAll("iframe").forEach((f) => f.classList.toggle("mapaDiaTvActivo", f === marco))
        mapaDiaColocarTv(caja, celda)
        caja.classList.add("mapaDiaTvVisible")
    }, MAPA_DIA_RETARDO_TV)
}

/** Cierra la vista previa y cancela la que estuviera a punto de abrirse. */
function mapaDiaOcultarTv() {
    clearTimeout(_mapaDiaTvTimer)
    const caja = document.getElementById("mapaDiaTv")
    if (!caja) return
    delete caja.dataset.pendiente
    caja.classList.remove("mapaDiaTvVisible")
}
