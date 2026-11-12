// Minigráfico del día y vista previa de TradingView en los mapas de calor.
//
// La vista previa la usan el mapa de Análisis (heatmap.js) y el widget «Mapa»
// de Paneles; el minigráfico, solo Paneles. El mapa pinta sus baldosas como
// siempre y marca su lienzo con
// `data-mapa-dia` y cada baldosa con `data-serie-id`. Después, este módulo mete
// en cada baldosa la línea de hoy. El eje va siempre de las 00:00 a las 24:00,
// así que la línea llega hasta la hora actual y se va completando a lo largo
// del día. Los minigráficos se refrescan solos mientras haya un mapa a la vista.
// Con horario de mercado, el eje se ciñe a la sesión del activo (mapaDiaSesion).
// En Semana, Mes, Año y YTD la línea es la del gráfico de la ficha del activo
// en ese rango y el eje va del inicio del periodo hasta ahora.
// Las baldosas con ticker de TradingView (`data-tv`) dibujan antes sus velas
// (/api/market/series), que existen también para lo que no está en la cartera;
// los snapshots quedan de respaldo para los tickers sin velas.

// La serie sale de los snapshots, que se guardan cada pocos minutos: pedirla
// más a menudo no traería puntos nuevos.
const MAPA_DIA_TTL = 60 * 1000
const MAPA_DIA_REFRESCO = 5 * 60 * 1000
// Por debajo de esta medida la línea no se distingue y solo tapa el rótulo.
const MAPA_DIA_ANCHO_MIN = 70
const MAPA_DIA_ALTO_MIN = 64
// Lo mínimo que tiene que abarcar la serie de hoy para pintarla (ver mapaDiaSerieUtil).
const MAPA_DIA_COBERTURA_MIN = 3600
// Un tramo plano al principio o al final del día que dure al menos esto es el
// mercado cerrado: se recorta del eje (ver mapaDiaSesion). Más corto puede ser
// un activo poco negociado o una cotización que tardó en refrescarse (con una
// hora, un valor de EE. UU. con 80 min sin cambio en plena sesión se tomaba por
// cerrado). Tiene que quedarse por debajo de las 2 h que hay entre el cierre de
// EE. UU. (22:00) y la medianoche, o ese cierre no se detectaría nunca.
const MAPA_DIA_CIERRE_MIN = 90 * 60
// Hueco por defecto si la respuesta no trae `segundosHueco` (el del servidor).
const MAPA_DIA_HUECO = 7200
// Como mucho tantas marcas horarias en el eje, y ninguna pegada a los bordes
// (en % del ancho), donde el texto se cortaría.
const MAPA_DIA_EJE_MAX_MARCAS = 4
const MAPA_DIA_EJE_MARGEN = 8
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
// Lo más que espera la precarga a que un iframe termine de cargar antes de
// pasar al siguiente: si TradingView no responde, no se queda atascada.
const MAPA_DIA_TV_ESPERA_CARGA = 8000

// Tickers por petición de velas: el tope que admite /api/market/series.
const MAPA_DIA_VELAS_LOTE = 80

let _mapaDiaCache = {} // periodo -> { datos, ts }
let _mapaDiaPeticion = {} // periodo -> Promise en curso
let _mapaDiaVelas = {} // periodo -> Map(ticker -> { puntos, ts }); `puntos` null si no tiene velas
let _mapaDiaRefresco = null
let _mapaDiaTvTimer = null
let _mapaDiaTvSimbolo = ""
// URL → iframe. Map conserva el orden de inserción: el primero es el que hace
// más tiempo que no se usa y el que sale al pasar del tope.
const _mapaDiaTvMarcos = new Map()
// Tope de vistas previas vivas: el de siempre o, con la precarga activa, tantas
// como símbolos tenga el mapa que la pidió.
let _mapaDiaTvTope = MAPA_DIA_TV_MAX_MARCOS
// Turno de la precarga en curso: cada llamada nueva deja sin efecto la anterior.
let _mapaDiaTvPrecarga = 0

/**
 * Serie de todos los activos en un periodo, cacheada un minuto y compartida
 * entre los mapas: dos mapas en pantalla con el mismo periodo hacen una sola
 * petición.
 *
 * @param {string} [periodo] "dia" (por defecto), "semana", "mes", "anyo" o "ytd".
 * @returns {Promise<object|null>} `{periodo, inicio, fin, segundosHueco, series}` o null si falla.
 */
function mapaDiaCargar(periodo = "dia") {
    const guardado = _mapaDiaCache[periodo]
    if (guardado && Date.now() - guardado.ts < MAPA_DIA_TTL) return Promise.resolve(guardado.datos)
    if (!_mapaDiaPeticion[periodo]) {
        const url = periodo === "dia" ? "/api/activos-serie-dia" : `/api/activos-serie-dia?periodo=${encodeURIComponent(periodo)}`
        _mapaDiaPeticion[periodo] = fetch(url)
            .then((res) => (res.ok ? res.json() : null))
            .then((json) => {
                if (!json?.ok) return null
                _mapaDiaCache[periodo] = { datos: json, ts: Date.now() }
                return json
            })
            .catch((error) => {
                console.error(`Mapa: no se pudo cargar la serie (${periodo})`, error)
                return null
            })
            .finally(() => {
                delete _mapaDiaPeticion[periodo]
            })
    }
    return _mapaDiaPeticion[periodo]
}

/**
 * Velas de cierre de TradingView de unos tickers en un periodo, cacheadas un
 * minuto por ticker. Los que no tienen velas también se recuerdan, para no
 * volver a preguntar por ellos en cada repintado.
 *
 * @param {string} periodo "dia", "semana", "mes", "anyo" o "ytd".
 * @param {Array<string>} simbolos Tickers de TradingView.
 * @returns {Promise<Object<string, Array<[number, number]>>>} Ticker → velas; nunca falla.
 */
async function mapaDiaCargarVelas(periodo, simbolos) {
    const cache = (_mapaDiaVelas[periodo] ||= new Map())
    const vigente = (s) => cache.has(s) && Date.now() - cache.get(s).ts < MAPA_DIA_TTL
    const faltan = [...new Set(simbolos)].filter((s) => s && !vigente(s))
    const lotes = []
    for (let i = 0; i < faltan.length; i += MAPA_DIA_VELAS_LOTE) lotes.push(faltan.slice(i, i + MAPA_DIA_VELAS_LOTE))
    await Promise.all(
        lotes.map(async (lote) => {
            try {
                const params = new URLSearchParams({ symbols: lote.join(","), periodo })
                const res = await fetch(`/api/market/series?${params}`)
                const json = res.ok ? await res.json() : null
                if (!json?.ok) return
                const ts = Date.now()
                lote.forEach((s) => cache.set(s, { puntos: json.series?.[s] || null, ts }))
            } catch (error) {
                // Sin velas, las baldosas usan los snapshots: no es un error que enseñar.
                console.error(`Mapa: no se pudieron cargar las velas (${periodo})`, error)
            }
        })
    )
    const velas = {}
    simbolos.forEach((s) => {
        const puntos = cache.get(s)?.puntos
        if (puntos) velas[s] = puntos
    })
    return velas
}

/** Tickers de TradingView de las baldosas de un lienzo, sin repetir. */
function mapaDiaSimbolos(lienzo) {
    return [...new Set([...lienzo.querySelectorAll("[data-serie-id][data-tv]")].map((c) => c.dataset.tv).filter(Boolean))]
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
 * @param {{inicio: number, fin: number}} [ventana] Eje X; por defecto, el día entero.
 * @returns {string} El SVG, o cadena vacía si no hay dos puntos que unir.
 */
function mapaDiaSvg(puntos, datos, ventana = datos) {
    if (!Array.isArray(puntos) || puntos.length < 2) return ""
    // Fuera de «Hoy» las noches y los fines de semana son huecos normales del mercado, no
    // falta de datos: la línea los une en vez de partirse en un trozo por sesión.
    const hueco = ventana.dias ? Infinity : datos.segundosHueco || MAPA_DIA_HUECO
    const { linea, area } = mapaDiaTrazado(puntos, ventana.inicio, ventana.fin, hueco)
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
 * Ventana del eje X para una serie: el día entero, o solo la sesión si el
 * activo tiene horario de mercado.
 *
 * El horario no se sabe de antemano (no hay tabla por bolsa): se deduce de la
 * propia serie. Antes de abrir y después de cerrar, los snapshots repiten el
 * mismo precio, y eso dibujaba horas de línea recta. Un tramo plano de al menos
 * `MAPA_DIA_CIERRE_MIN` en un extremo se recorta: la ventana empieza en el
 * último punto antes del primer cambio (el cierre anterior, de donde parte la
 * sesión) y acaba en el primer punto del tramo plano final (el cierre). Con
 * uno de los dos extremos recortado el activo tiene horario, y el otro se
 * ciñe a los datos: con la sesión abierta la ventana acaba en el último punto,
 * y si el servidor arrancó ya abierta la sesión empieza en el primero, en vez
 * de dejar medio eje vacío. Lo que cotiza todo el día, como la cripto, no tiene
 * esos tramos y conserva el día entero; una serie plana entera (fin de semana)
 * también.
 *
 * Los tramos planos solo cuentan con datos seguidos: entre dos puntos separados
 * más de `hueco` no hubo snapshots (servidor parado) y no se sabe si el precio
 * se movió. Sin esto, el precio de antes de parar el servidor y el de después,
 * si coincidían, pasaban por horas de mercado cerrado.
 *
 * `cerrado` dice si el mercado del activo está cerrado ahora: lleva al menos
 * `MAPA_DIA_CIERRE_MIN` sin moverse al final de la serie. `plano`, si no se ha
 * movido en todo el día (aún no ha abierto, o es fin de semana).
 *
 * @param {Array<[number, number]>|undefined} puntos Serie del activo, ordenada.
 * @param {number} inicio Inicio del día (ts).
 * @param {number} fin Fin del día (ts).
 * @param {number} [hueco] Segundos sin datos a partir de los que la serie se corta.
 * @returns {{inicio: number, fin: number, cerrado: boolean, plano: boolean}} La ventana.
 */
function mapaDiaSesion(puntos, inicio, fin, hueco = MAPA_DIA_HUECO) {
    const diaEntero = { inicio, fin, cerrado: false, plano: false }
    if (!Array.isArray(puntos) || puntos.length < 2) return diaEntero
    const ultimo = puntos.length - 1
    const plano = (desde, hasta) => mapaDiaDuracionConDatos(puntos, desde, hasta, hueco) >= MAPA_DIA_CIERRE_MIN
    const primerCambio = puntos.findIndex((p) => p[1] !== puntos[0][1])
    if (primerCambio < 0) return { ...diaEntero, cerrado: plano(0, ultimo), plano: true }

    const ultimoCambio = puntos.findLastIndex((p) => p[1] !== puntos[ultimo][1])
    const antesDeAbrir = plano(0, primerCambio - 1)
    const trasCerrar = plano(ultimoCambio + 1, ultimo)
    if (!antesDeAbrir && !trasCerrar) return diaEntero

    return {
        inicio: antesDeAbrir ? puntos[primerCambio - 1][0] : puntos[0][0],
        fin: trasCerrar ? puntos[ultimoCambio + 1][0] : puntos[ultimo][0],
        cerrado: trasCerrar,
        plano: false
    }
}

/**
 * Ventana del eje X para las velas de hoy de TradingView.
 *
 * Con velas, el mercado cerrado no deja un tramo plano como en los snapshots:
 * simplemente no hay velas. Si la primera llega bastante después de medianoche
 * o la última hace rato, el activo tiene horario y el eje se ciñe a sus velas;
 * si no (la cripto), es el día entero. Sin ninguna vela hoy, el mercado lleva
 * cerrado todo el día.
 *
 * @param {Array<[number, number]>} puntos Velas de hoy, ordenadas (puede estar vacía).
 * @param {number} inicio Inicio del día (ts).
 * @param {number} fin Fin del día (ts).
 * @param {number} [ahora] Instante actual (ts).
 * @returns {{inicio: number, fin: number, cerrado: boolean, plano: boolean}} La ventana.
 */
function mapaDiaSesionVelas(puntos, inicio, fin, ahora = Date.now() / 1000) {
    if (!puntos.length) return { inicio, fin, cerrado: true, plano: true }
    const primera = puntos[0][0]
    const ultima = puntos[puntos.length - 1][0]
    const abreDespues = primera - inicio >= MAPA_DIA_CIERRE_MIN
    const cerrado = Math.min(ahora, fin) - ultima >= MAPA_DIA_CIERRE_MIN
    if (!abreDespues && !cerrado) return { inicio, fin, cerrado: false, plano: false }
    return { inicio: primera, fin: ultima, cerrado, plano: false }
}

/**
 * Serie y ventana de una baldosa: las velas de TradingView de su ticker si las
 * hay en la ventana del periodo y, si no, la de los snapshots.
 *
 * @param {HTMLElement} celda Baldosa con `data-serie-id` y quizá `data-tv`.
 * @param {object} datos Respuesta de `mapaDiaCargar`.
 * @param {Object<string, Array<[number, number]>>} velas Respuesta de `mapaDiaCargarVelas`.
 * @returns {{puntos: Array<[number, number]>|undefined, ventana: object}}
 */
function mapaDiaSerieCelda(celda, datos, velas) {
    const esDia = (datos.periodo || "dia") === "dia"
    const conVelas = velas[celda.dataset.tv]
    if (conVelas) {
        const enVentana = conVelas.filter((p) => p[0] >= datos.inicio && p[0] <= datos.fin)
        // `velas`: la línea es de precios, no del valor de una posición (que se
        // mueve también con compras y ventas); quien la recibe puede sacar de
        // ella la variación del periodo.
        if (esDia) {
            const ventana = { ...mapaDiaSesionVelas(enVentana, datos.inicio, datos.fin), velas: true }
            return { puntos: enVentana.length ? enVentana : undefined, ventana }
        }
        if (enVentana.length >= 2) {
            return {
                puntos: enVentana,
                ventana: { inicio: datos.inicio, fin: datos.fin, cerrado: false, plano: false, dias: true, velas: true }
            }
        }
    }

    // Fuera de «Hoy» la serie abarca varios días: ni hay sesión que recortar
    // (las noches y los fines de semana son parte del periodo) ni cobertura mínima
    // que exigir, que es cosa de un servidor recién arrancado a media mañana.
    const bruta = datos.series?.[celda.dataset.serieId]
    const serie = esDia ? mapaDiaSerieUtil(bruta) : Array.isArray(bruta) && bruta.length >= 2 ? bruta : undefined
    const ventana = esDia
        ? mapaDiaSesion(serie, datos.inicio, datos.fin, datos.segundosHueco || MAPA_DIA_HUECO)
        : { inicio: datos.inicio, fin: datos.fin, cerrado: false, plano: false, dias: true }
    // Fuera de la sesión solo quedan los puntos planos recortados. Con el
    // mercado cerrado todo el día no hay nada que dibujar: sería una recta.
    const puntos =
        ventana.plano && ventana.cerrado ? undefined : serie?.filter((p) => p[0] >= ventana.inicio && p[0] <= ventana.fin)
    return { puntos, ventana }
}

/**
 * Tiempo cubierto por datos entre dos puntos de una serie: la suma de los
 * intervalos entre puntos seguidos, sin los que pasan de `hueco`.
 *
 * @param {Array<[number, number]>} puntos Serie ordenada.
 * @param {number} desde Índice del primer punto.
 * @param {number} hasta Índice del último punto.
 * @param {number} hueco Intervalo máximo que cuenta.
 * @returns {number} Segundos.
 */
function mapaDiaDuracionConDatos(puntos, desde, hasta, hueco) {
    let total = 0
    for (let i = desde; i < hasta; i++) {
        const paso = puntos[i + 1][0] - puntos[i][0]
        if (paso <= hueco) total += paso
    }
    return total
}

/**
 * Marcas horarias del eje X para una ventana: horas en punto, con el paso más
 * corto que no pase de `MAPA_DIA_EJE_MAX_MARCAS`, y ninguna pegada a un borde.
 * El día entero da las 06:00, 12:00 y 18:00 de siempre.
 *
 * @param {number} inicio Inicio de la ventana (ts).
 * @param {number} fin Fin de la ventana (ts).
 * @returns {Array<{pos: number, texto: string}>} Posición en % del ancho y rótulo.
 */
function mapaDiaMarcasEje(inicio, fin) {
    const duracion = fin - inicio
    if (!(duracion > 0)) return []
    const paso = [1, 2, 3, 4, 6].find((p) => duracion / 3600 / p <= MAPA_DIA_EJE_MAX_MARCAS) || 6
    const marcas = []
    // Hora a hora con setHours y no sumando 3600: así las marcas caen en la
    // hora en punto local también el día del cambio de hora.
    const hora = new Date(inicio * 1000)
    hora.setMinutes(0, 0, 0)
    while (hora.getTime() / 1000 <= fin) {
        const pos = ((hora.getTime() / 1000 - inicio) / duracion) * 100
        if (hora.getHours() % paso === 0 && pos >= MAPA_DIA_EJE_MARGEN && pos <= 100 - MAPA_DIA_EJE_MARGEN) {
            marcas.push({ pos, texto: `${String(hora.getHours()).padStart(2, "0")}:00` })
        }
        hora.setHours(hora.getHours() + 1)
    }
    return marcas
}

/**
 * Mete o actualiza el minigráfico en las baldosas de un lienzo.
 *
 * @param {HTMLElement} lienzo Contenedor con baldosas `[data-serie-id]`.
 * @param {object} datos Respuesta de `mapaDiaCargar`.
 * @param {Object<string, Array<[number, number]>>} [velas] Velas de TradingView por ticker.
 */
function mapaDiaPintarEn(lienzo, datos, velas = {}) {
    lienzo.querySelectorAll("[data-serie-id]").forEach((celda) => {
        celda.querySelector(".mapaDiaLinea")?.remove()
        const { puntos, ventana } = mapaDiaSerieCelda(celda, datos, velas)
        lienzo._mapaDiaAlPintar?.(celda, puntos, ventana)
        if (celda.offsetWidth < MAPA_DIA_ANCHO_MIN || celda.offsetHeight < MAPA_DIA_ALTO_MIN) return
        const svg = mapaDiaSvg(puntos, datos, ventana)
        if (svg) celda.insertAdjacentHTML("afterbegin", svg)
    })
}

/**
 * Activa los minigráficos del día en un mapa recién pintado.
 *
 * @param {HTMLElement} lienzo Contenedor de las baldosas.
 * @param {string|null} periodo Periodo del mapa ("dia", "semana", "mes",
 *     "anyo" o "ytd"); null si no tiene línea (p. ej. «Desde la compra»), y
 *     entonces se desmarca el lienzo para que el refresco lo ignore.
 * @param {Function} [alPintar] `(celda, puntos)` por cada baldosa al llegar la
 *     serie, también en cada refresco: lo que la baldosa saca de la línea (el
 *     máximo y el mínimo del periodo en la rejilla de Paneles). `puntos` puede
 *     faltar si el activo no tiene serie o si su mercado lleva cerrado todo
 *     el día. Recibe además la ventana del eje (`mapaDiaSesion`), con
 *     `cerrado`, como tercer argumento; fuera de «Hoy» lleva `dias: true`.
 */
function mapaDiaActivar(lienzo, periodo, alPintar = null) {
    if (!lienzo) return
    lienzo._mapaDiaAlPintar = alPintar
    if (!periodo) {
        delete lienzo.dataset.mapaDia
        return
    }
    lienzo.dataset.mapaDia = periodo
    mapaDiaRepintar(lienzo, periodo)
    mapaDiaProgramarRefresco()
}

/**
 * Pide los snapshots del periodo y las velas de los tickers del lienzo, y pinta
 * cuando llegan los dos. Sin snapshots no hay ventana del periodo y no se pinta.
 *
 * @param {HTMLElement} lienzo Contenedor de las baldosas.
 * @param {string} periodo Periodo del mapa.
 * @returns {Promise<void>}
 */
async function mapaDiaRepintar(lienzo, periodo) {
    const [datos, velas] = await Promise.all([mapaDiaCargar(periodo), mapaDiaCargarVelas(periodo, mapaDiaSimbolos(lienzo))])
    // El periodo pudo cambiar mientras llegaba la respuesta.
    if (datos && lienzo.isConnected && lienzo.dataset.mapaDia === periodo) mapaDiaPintarEn(lienzo, datos, velas)
}

/**
 * Marcas de fecha del eje X para una ventana de varios días: tres, repartidas,
 * cada una en la medianoche más cercana para que el rótulo diga el día justo.
 *
 * @param {number} inicio Inicio de la ventana (ts).
 * @param {number} fin Fin de la ventana (ts).
 * @returns {Array<{pos: number, texto: string}>} Posición en % del ancho y rótulo.
 */
function mapaDiaMarcasFecha(inicio, fin) {
    const duracion = fin - inicio
    if (!(duracion > 0)) return []
    const marcas = []
    for (const fraccion of [0.25, 0.5, 0.75]) {
        const dia = new Date((inicio + duracion * fraccion) * 1000)
        // Redondeo a la medianoche local más cercana, con setHours para que el
        // cambio de hora no la desplace.
        if (dia.getHours() >= 12) dia.setDate(dia.getDate() + 1)
        dia.setHours(0, 0, 0, 0)
        const pos = ((dia.getTime() / 1000 - inicio) / duracion) * 100
        const texto = dia.toLocaleDateString("es-ES", { day: "numeric", month: "short" }).replace(".", "")
        if (pos >= MAPA_DIA_EJE_MARGEN && pos <= 100 - MAPA_DIA_EJE_MARGEN && !marcas.some((m) => m.texto === texto)) {
            marcas.push({ pos, texto })
        }
    }
    return marcas
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
        _mapaDiaCache = {}
        _mapaDiaVelas = {}
        // Los snapshots, una petición por periodo y no por mapa (mapaDiaCargar
        // reparte la misma promesa); las velas, por mapa, solo de sus tickers.
        lienzos.filter((l) => l.isConnected).forEach((l) => mapaDiaRepintar(l, l.dataset.mapaDia))
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
    mapaDiaRecortarMarcos()
    return marco
}

/** Quita las vistas previas que llevan más tiempo sin usarse hasta quedar en el tope. */
function mapaDiaRecortarMarcos() {
    while (_mapaDiaTvMarcos.size > _mapaDiaTvTope) {
        const [masAntigua, viejo] = _mapaDiaTvMarcos.entries().next().value
        viejo.remove()
        _mapaDiaTvMarcos.delete(masAntigua)
    }
}

/** Promesa que se cumple cuando el navegador está libre (o a los 3 s como mucho). */
function mapaDiaEsperarOcio() {
    return new Promise((resolver) => {
        if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(resolver, { timeout: 3000 })
        else setTimeout(resolver, 200)
    })
}

/**
 * Promesa que se cumple cuando el iframe termina de cargar, o pasado
 * `MAPA_DIA_TV_ESPERA_CARGA` si no lo hace.
 *
 * @param {HTMLIFrameElement} marco Iframe recién creado.
 * @returns {Promise<void>}
 */
function mapaDiaEsperarCarga(marco) {
    return new Promise((resolver) => {
        const temporizador = setTimeout(resolver, MAPA_DIA_TV_ESPERA_CARGA)
        marco.addEventListener(
            "load",
            () => {
                clearTimeout(temporizador)
                resolver()
            },
            { once: true }
        )
    })
}

/**
 * Carga de antemano las vistas previas de todos los símbolos de un mapa, para
 * que ninguna tenga la espera de ~1 s al pasar el ratón por primera vez.
 *
 * Van una detrás de otra y con el navegador libre, no todas a la vez: cada
 * iframe arranca la aplicación de gráficos de TradingView entera y en paralelo
 * dejarían la página sin responder. El tope de iframes vivos sube hasta que
 * quepan todos; cada uno ocupa memoria, por eso la precarga es opcional.
 *
 * Llamarla con una lista vacía cancela la precarga en curso y devuelve el tope
 * al de siempre.
 *
 * @param {string[]} simbolos Símbolos de TradingView del mapa.
 * @param {(hechos: number, total: number) => void} [alProgresar] Se llama al
 *     empezar y tras cada vista previa lista, solo mientras esta precarga siga
 *     siendo la vigente (una cancelada no pisa el progreso de la nueva).
 * @returns {Promise<void>} Se cumple al acabar o al quedar cancelada.
 */
async function mapaDiaPrecargarTv(simbolos, alProgresar) {
    const turno = ++_mapaDiaTvPrecarga
    const unicos = [...new Set(simbolos.filter(Boolean))]
    _mapaDiaTvTope = Math.max(MAPA_DIA_TV_MAX_MARCOS, unicos.length)
    mapaDiaRecortarMarcos()
    const avisar = (hechos) => {
        if (alProgresar && turno === _mapaDiaTvPrecarga) alProgresar(hechos, unicos.length)
    }
    avisar(0)
    for (const [i, simbolo] of unicos.entries()) {
        await mapaDiaEsperarOcio()
        if (turno !== _mapaDiaTvPrecarga) return
        // También se pasa por las que ya estaban cargadas: así suben al final
        // de la cola y no las echa el recorte al meter las que faltan.
        const yaEstaba = _mapaDiaTvMarcos.get(mapaDiaUrlTv(simbolo))?.isConnected
        const marco = mapaDiaMarcoTv(mapaDiaCajaTv(), simbolo)
        if (!yaEstaba) await mapaDiaEsperarCarga(marco)
        avisar(i + 1)
    }
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
