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
// Rangos con velas de menos de un día: lo anterior al rango lo manda el servidor con
// su misma resolución (`previos=1`) en vez de salir de «Todo», que es diario.
const ASSET_GRAFICO_RANGOS_INTRADIA = new Set(["1D", "7D", "30D"])
const ASSET_GRAFICO_VISTAS = [
    { clave: "precio", etiqueta: "Precio" },
    { clave: "posicion", etiqueta: "Mi posición" }
]
const ASSET_GRAFICO_UNIDADES = [
    { clave: "eur", etiqueta: "€" },
    { clave: "pct", etiqueta: "%" }
]
// Cómo se pinta el precio. Las velas necesitan apertura, máximo y mínimo, que solo
// traen los datos de TradingView: con los snapshots propios se queda la línea.
const ASSET_GRAFICO_TIPOS = [
    { clave: "linea", etiqueta: "Línea" },
    { clave: "velas", etiqueta: "Velas" }
]
// Con velas no se elige periodo sino lo que dura cada vela; el periodo (1D, 7D...)
// queda para la línea. El servidor manda todas las de la temporalidad que da el
// feed y se encuadran las últimas: el resto se ve al alejar.
const ASSET_GRAFICO_TEMPORALIDADES = [
    { clave: "5m", etiqueta: "5m" },
    { clave: "15m", etiqueta: "15m" },
    { clave: "1h", etiqueta: "1h" },
    { clave: "4h", etiqueta: "4h" },
    { clave: "1D", etiqueta: "1D" },
    { clave: "1S", etiqueta: "1S" }
]
const ASSET_GRAFICO_TEMPORALIDADES_INTRADIA = new Set(["5m", "15m", "1h", "4h"])
// Velas que se ven al abrir: suficientes para leer la tendencia sin que cada una
// quede en una raya.
const ASSET_GRAFICO_VELAS_ENCUADRE = 150
// Fracción del hueco entre dos velas que ocupa el cuerpo, y su ancho máximo en píxeles
// para que con pocas velas no salgan bloques.
const ASSET_GRAFICO_VELA_ANCHO = 0.7
const ASSET_GRAFICO_VELA_ANCHO_MAX = 14
// Hueco a la derecha de la última vela, como fracción del tramo visible: separa lo
// más reciente del eje de precios para que no quede pegado a las etiquetas.
const ASSET_GRAFICO_MARGEN_DERECHO = 0.1
// Qué se ve en la pestaña. «Compras / ventas» se pinta aquí; los otros dos, en
// assets-grafico-modos.js.
const assetGraficoModos = [
    { clave: "compras", etiqueta: "Compras / ventas" },
    { clave: "indices", etiqueta: "Comparativa índices" },
    { clave: "estacional", etiqueta: "Estacionales" },
    { clave: "anual", etiqueta: "Comparativa anual" }
]
// Ilustración y texto del «?» de cada modo. Los colores llevan valor de respaldo porque
// el menú es fijo y queda fuera de .assetGrafico, donde se definen las variables.
const ASSET_GRAFICO_AYUDA = {
    compras: {
        texto: "El precio (o el rendimiento de tu posición) a lo largo del tiempo, con un punto verde en cada compra y uno rojo en cada venta.",
        svg: `<path class="ayudaLinea" d="M10 70 L40 55 L70 80 L100 50 L130 62 L160 30 L190 42"/>
            <circle cx="70" cy="80" r="5" fill="var(--graficoCompra,#16a34a)"/>
            <circle cx="130" cy="62" r="5" fill="var(--graficoCompra,#16a34a)"/>
            <circle cx="160" cy="30" r="5" fill="var(--graficoVenta,#dc2626)"/>`
    },
    indices: {
        texto: "Tu activo frente a uno o varios índices desde el inicio del periodo: todas las líneas parten de 0 % y se ve quién ha rendido más.",
        svg: `<line class="ayudaEje" x1="10" y1="60" x2="210" y2="60"/>
            <path class="ayudaLinea" d="M10 60 L50 48 L90 54 L130 32 L170 38 L200 20"/>
            <path class="ayudaLinea ayudaLineaTenue" d="M10 60 L50 56 L90 50 L130 46 L170 44 L200 40"/>
            <text class="ayudaTexto" x="204" y="20">Activo</text>
            <text class="ayudaTexto" x="204" y="44">Índice</text>`
    },
    estacional: {
        texto: "Cada línea es un año natural, de enero a diciembre, partiendo de 0 %. Sirve para ver si el activo suele subir o bajar en ciertos meses.",
        svg: `<line class="ayudaEje" x1="10" y1="60" x2="210" y2="60"/>
            <path class="ayudaLinea" d="M10 60 L45 50 L80 56 L115 40 L150 44 L190 30"/>
            <path class="ayudaLinea ayudaLineaTenue" d="M10 60 L45 66 L80 58 L115 70 L150 62 L190 72"/>
            <path class="ayudaLinea ayudaLineaPunteada" d="M10 60 L45 58 L80 48 L115 52 L150 36 L190 46"/>
            <text class="ayudaTexto" x="10" y="100">Ene</text>
            <text class="ayudaTexto" x="186" y="100">Dic</text>`
    },
    anual: {
        texto: "Una barra por año: variación del precio entre el cierre de un año y el del siguiente. Verde si subió, rojo si bajó.",
        svg: `<line class="ayudaEje" x1="10" y1="60" x2="210" y2="60"/>
            <rect x="35" y="25" width="30" height="35" rx="2" fill="var(--graficoCompra,#16a34a)"/>
            <rect x="95" y="60" width="30" height="22" rx="2" fill="var(--graficoVenta,#dc2626)"/>
            <rect x="155" y="40" width="30" height="20" rx="2" fill="var(--graficoCompra,#16a34a)"/>
            <text class="ayudaTexto" x="38" y="100">2024</text>
            <text class="ayudaTexto" x="98" y="100">2025</text>
            <text class="ayudaTexto" x="158" y="100">2026</text>`
    }
}
// En «Estacionales», el gráfico de años superpuestos o la tabla de rendimiento mensual.
const ASSET_GRAFICO_VISTAS_ESTACIONAL = [
    { clave: "grafico", etiqueta: "Gráfico" },
    { clave: "tabla", etiqueta: "Tabla" }
]
// Escala del eje del gráfico de estacionales. La logarítmica evita que un año extremo
// (+1000 %) aplaste a los demás contra el 0.
const ASSET_GRAFICO_ESCALAS_ESTACIONAL = [
    { clave: "lineal", etiqueta: "Lineal" },
    { clave: "log", etiqueta: "Log" }
]
const ASSET_GRAFICO_MODO = "assetGraficoCercano"

// Distancia en píxeles a la que el cursor ya «coge» un punto de compra o venta.
// En un año cada día ocupa dos píxeles: sin este margen, acertar en el punto
// exacto sería cuestión de suerte.
const ASSET_GRAFICO_RADIO_MARCA = 10
// Distancia, esta vez en las dos direcciones, a la que un clic fija o suelta el detalle
// de un punto: con solo la horizontal, pulsar en cualquier altura de ese día lo fijaría.
const ASSET_GRAFICO_RADIO_PULSAR = 12
// Separación entre un punto fijado y su ficha, y de las fichas al borde del lienzo.
const ASSET_GRAFICO_SEPARACION_FICHA = 14
const ASSET_GRAFICO_MARGEN_FICHA = 4
// Hueco mínimo entre dos fichas fijadas, para que no se lean como una sola.
const ASSET_GRAFICO_SEPARACION_ENTRE_FICHAS = 6
// Píxeles de desplazamiento vertical que «cuesta» poner una ficha al otro lado de su
// punto: con poca diferencia, mejor seguir en el lado de siempre.
const ASSET_GRAFICO_COSTE_CAMBIO_LADO = 24
// Píxeles entre dos cifras del eje vertical: deja aire entre etiquetas de 12 px.
const ASSET_GRAFICO_PIXELES_ENTRE_MARCAS_Y = 44
// Píxeles por encima del borde inferior del área en los que no se escribe ninguna cifra.
const ASSET_GRAFICO_MARGEN_INFERIOR_MARCAS_Y = 12
// Separación del botón «Ocultar detalles» al borde del área y al botón «Centrar».
const ASSET_GRAFICO_MARGEN_OCULTAR = 6
// Píxeles que una marca puede salirse del área: radio al pasar el ratón más el borde.
const ASSET_GRAFICO_MARGEN_MARCA = 10

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
// Respuesta de «Todo» del activo abierto, para poner delante del rango lo anterior a
// él; null mientras no se ha cargado o si falló.
let _assetGraficoContexto = null
// Días con compra o venta del activo abierto; null hasta que se conocen.
let _assetGraficoDias = null
// Marcas con su detalle fijado al pulsarlas, por `assetGraficoClaveMarca`. Siguen
// fijadas al cambiar de vista o de rango y se vacían al cambiar de activo.
let _assetGraficoFijadas = new Set()
// Fichas en pantalla de esas marcas, por clave. Se rehacen con cada gráfico nuevo.
let _assetGraficoFichas = new Map()

function assetGraficoHayVentana() {
    return Boolean(_assetGraficoVentana.desde || _assetGraficoVentana.hasta)
}

// Con ventana se pide «Todo» al servidor: una ventana puede caer en cualquier punto del
// histórico y el recorte se hace aquí.
// La comparativa anual necesita todo el histórico para tener años completos.
// Los estacionales, también: son el respaldo cuando no hay velas de TradingView.
// Con velas se pide también «Todo»: la temporalidad manda sobre el rango.
function assetGraficoRangoEfectivo() {
    const { modo, rango } = assetGraficoEstado()
    const todo = assetGraficoHayVentana() || modo === "anual" || modo === "estacional" || assetGraficoModoVelas()
    return todo ? "TODO" : rango
}

/**
 * Si el gráfico va con velas y temporalidad propia en vez de con periodo: modo
 * «Compras / ventas», vista de precio, tipo velas y un ticker de TradingView del
 * que sacarlas.
 *
 * @returns {boolean}
 */
function assetGraficoModoVelas() {
    const { modo, vista, tipo } = assetGraficoEstado()
    return modo === "compras" && vista === "precio" && tipo === "velas" && Boolean(assetGraficoSimboloTv())
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
    return assetGraficoRecortarTs(datos, assetGraficoLimitesVentana(ventana))
}

/**
 * Como `assetGraficoRecortar`, pero con los límites ya en segundos.
 *
 * @param {object} datos Respuesta del servidor.
 * @param {{min: number, max: number}} limites Instantes incluidos; ±Infinity sin límite.
 * @returns {object} Una copia con solo los puntos y operaciones entre los límites.
 */
function assetGraficoRecortarTs(datos, { min, max }) {
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

/**
 * Pone por delante del rango pedido el histórico anterior de «Todo».
 *
 * Así, al alejar el gráfico (arrastrando el eje X) se ve lo que hubo antes del
 * rango en vez de un hueco vacío. Lo anterior va con la resolución de «Todo»,
 * diaria. En los rangos intradía con velas no se añade: el servidor ya manda las
 * anteriores con la misma resolución (`previos=1`), y mezclar velas de 4 h con
 * diarias dejaba las de antes mucho más separadas. `inicioDetalle` marca dónde
 * empiezan los datos del rango.
 *
 * @param {object} datos Respuesta del servidor para el rango elegido.
 * @param {object|null} contexto Respuesta del servidor para «Todo».
 * @returns {object} `datos` con los puntos y operaciones anteriores añadidos, o
 *     `datos` tal cual si no hay contexto o el rango ya es «Todo».
 */
function assetGraficoUnirContexto(datos, contexto) {
    const puntos = datos.puntos || []
    if (!contexto || datos.rango === "TODO" || !puntos.length) return datos
    if (datos.conVelas && ASSET_GRAFICO_RANGOS_INTRADIA.has(datos.rango)) return datos
    const inicioDetalle = puntos[0].ts
    // Con la línea de un origen y lo anterior de otro (velas y snapshots) los precios
    // no casarían en la unión: solo se añade si los dos salen de lo mismo.
    if (Boolean(contexto.conVelas) !== Boolean(datos.conVelas)) return { ...datos, inicioDetalle }
    const previos = (contexto.puntos || []).filter((punto) => punto.ts < inicioDetalle)
    const desplazamiento = previos.length
    const operacionesPrevias = (contexto.operaciones || []).filter((operacion) => operacion.indice < desplazamiento)
    return {
        ...datos,
        inicioDetalle,
        segundosHuecoContexto: contexto.segundosHueco,
        puntos: [...previos, ...puntos],
        operaciones: [
            ...operacionesPrevias,
            ...(datos.operaciones || []).map((operacion) => ({
                ...operacion,
                indice: operacion.indice + desplazamiento
            }))
        ]
    }
}

// Lo que se encuadra al pintar, en segundos: las fechas elegidas o, si no hay, el
// rango pedido. El resto de los datos queda fuera de la vista hasta que se aleja.
// `inicioRango` es 0 en «Todo», que no encuadra nada. Con temporalidad de velas se
// encuadran las últimas `ASSET_GRAFICO_VELAS_ENCUADRE`.
function assetGraficoEncuadre(datos, ventana) {
    if (ventana.desde || ventana.hasta) return assetGraficoLimitesVentana(ventana)
    if (datos.temporalidad) {
        const velas = (datos.puntos || []).filter((punto) => Number.isFinite(punto.apertura))
        const primera = velas[velas.length - ASSET_GRAFICO_VELAS_ENCUADRE]
        return { min: primera ? primera.ts : -Infinity, max: Infinity }
    }
    return { min: datos.inicioRango || datos.inicioDetalle || -Infinity, max: Infinity }
}

// En la vista de posición, antes de la primera compra la línea es un tramo plano en
// cero que no dice nada: se empieza en esa compra. Si el usuario fija «Desde», se
// respeta su fecha.
function assetGraficoDesdePrimeraCompra(datos, vista, ventana) {
    if (vista !== "posicion" || ventana.desde) return datos
    const puntos = datos.puntos || []
    const primero = puntos.findIndex((punto) => Number.isFinite(punto.coste) && punto.coste > 0)
    if (primero <= 0) return datos
    const operaciones = (datos.operaciones || [])
        .filter((operacion) => operacion.indice >= primero)
        .map((operacion) => ({ ...operacion, indice: operacion.indice - primero }))
    return { ...datos, puntos: puntos.slice(primero), operaciones }
}

function assetGraficoConHora(rango) {
    const temporalidad = _assetGraficoDatos?.temporalidad
    if (temporalidad) return ASSET_GRAFICO_TEMPORALIDADES_INTRADIA.has(temporalidad)
    return !assetGraficoHayVentana() && (rango === "1D" || rango === "7D")
}

function assetGraficoPreferencia(clave, opciones, defecto) {
    const guardada = getChartPref(clave, defecto)
    return opciones.some((opcion) => opcion.clave === guardada) ? guardada : defecto
}

function assetGraficoEstado() {
    return {
        modo: assetGraficoPreferencia("assetGraficoModo", assetGraficoModos, "compras"),
        rango: assetGraficoPreferencia("assetGraficoRango", ASSET_GRAFICO_RANGOS, "30D"),
        vista: assetGraficoPreferencia("assetGraficoVista", ASSET_GRAFICO_VISTAS, "precio"),
        unidad: assetGraficoPreferencia("assetGraficoUnidad", ASSET_GRAFICO_UNIDADES, "eur"),
        tipo: assetGraficoPreferencia("assetGraficoTipo", ASSET_GRAFICO_TIPOS, "linea"),
        temporalidad: assetGraficoPreferencia("assetGraficoTemporalidad", ASSET_GRAFICO_TEMPORALIDADES, "1D"),
        vistaEstacional: assetGraficoPreferencia(
            "assetGraficoVistaEstacional",
            ASSET_GRAFICO_VISTAS_ESTACIONAL,
            "grafico"
        ),
        escalaEstacional: assetGraficoPreferencia(
            "assetGraficoEscalaEstacional",
            ASSET_GRAFICO_ESCALAS_ESTACIONAL,
            "lineal"
        )
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

/**
 * Vela de un punto en la unidad elegida, o null si el punto no la tiene.
 *
 * Solo los puntos de TradingView traen apertura, máximo y mínimo; los de una
 * operación o de los snapshots no, y en la vista de posición no hay velas.
 *
 * @param {object} punto Punto del servidor.
 * @param {string} vista "precio" o "posicion".
 * @param {string} unidad "eur" o "pct".
 * @param {number|null} precioBase Referencia del %.
 * @returns {{apertura: number, maximo: number, minimo: number, cierre: number}|null}
 */
function assetGraficoVelaDelPunto(punto, vista, unidad, precioBase) {
    if (vista !== "precio") return null
    const claves = ["apertura", "maximo", "minimo", "precio"]
    if (!claves.every((clave) => Number.isFinite(punto[clave]))) return null
    const [apertura, maximo, minimo, cierre] = claves.map((clave) =>
        assetGraficoValorDelPunto({ precio: punto[clave] }, vista, unidad, precioBase)
    )
    if (![apertura, maximo, minimo, cierre].every(Number.isFinite)) return null
    return { apertura, maximo, minimo, cierre }
}

// Máximo y mínimo de las mechas, para que el eje y las etiquetas de extremos no se
// queden en los cierres y corten las velas.
function assetGraficoExtremosVelas(linea) {
    const conVela = linea.filter((punto) => punto.vela)
    if (!conVela.length) return null
    const alto = conVela.reduce((mejor, punto) => (punto.vela.maximo > mejor.vela.maximo ? punto : mejor))
    const bajo = conVela.reduce((mejor, punto) => (punto.vela.minimo < mejor.vela.minimo ? punto : mejor))
    return {
        maximo: { x: alto.x, y: alto.vela.maximo },
        minimo: { x: bajo.x, y: bajo.vela.minimo }
    }
}

function assetGraficoDiaLocal(ts) {
    const fecha = new Date(ts * 1000)
    return `${fecha.getFullYear()}-${fecha.getMonth()}-${fecha.getDate()}`
}

/**
 * Anota en cada punto sin vela (`xVela`) la posición de la vela de su mismo día más
 * cercana en el tiempo.
 *
 * Las operaciones van a mediodía porque no tienen hora, y cada mercado abre su vela
 * diaria a una hora distinta (las 00:00 UTC en cripto, la apertura en bolsa): con
 * velas, su marca quedaba entre dos. Se ancla por día y no por hora para no depender
 * del horario de cada mercado; en rangos intradía hay varias velas y vale la más cercana.
 *
 * @param {object[]} linea Puntos de la línea, en orden; se modifican.
 */
function assetGraficoAnclarAVelas(linea) {
    const velasPorDia = new Map()
    linea.forEach((punto) => {
        if (!punto.vela) return
        const dia = assetGraficoDiaLocal(punto.x)
        if (!velasPorDia.has(dia)) velasPorDia.set(dia, [])
        velasPorDia.get(dia).push(punto.x)
    })
    linea.forEach((punto) => {
        if (punto.vela || !Number.isFinite(punto.y)) return
        const candidatas = velasPorDia.get(assetGraficoDiaLocal(punto.x))
        if (!candidatas) return
        punto.xVela = candidatas.reduce((mejor, x) => (Math.abs(x - punto.x) < Math.abs(mejor - punto.x) ? x : mejor))
    })
}

// Con velas, los puntos y las marcas van a la X de su vela (ver assetGraficoAnclarAVelas).
function assetGraficoEnVela(punto) {
    return punto.xVela === undefined ? punto : { ...punto, x: punto.xVela }
}

/**
 * Si el precio se pinta con velas: lo ha pedido el usuario, se ve el precio y los
 * datos son de TradingView, los únicos con apertura, máximo y mínimo.
 *
 * @param {object} datos Respuesta del servidor.
 * @param {string} vista "precio" o "posicion".
 * @param {string} tipo "linea" o "velas".
 * @returns {boolean}
 */
function assetGraficoUsaVelas(datos, vista, tipo) {
    return tipo === "velas" && vista === "precio" && Boolean(datos?.conVelas)
}

// Prepara lo que pinta Chart.js: la línea, con cortes en los huecos largos, y un
// punto por cada día y tipo de operación. Varias compras del mismo día comparten
// punto: sus posiciones serían idénticas y una taparía a la otra.
// Cada punto de la línea lleva su vela, si la tiene, por si se pinta con velas.
// Con `encuadre`, la base del %, los extremos, el último valor y los límites del eje
// salen solo de lo encuadrado; lo de fuera se pinta igual para verlo al alejar.
function assetGraficoSeries(datos, vista, unidad, encuadre = { min: -Infinity, max: Infinity }) {
    const puntos = datos.puntos || []
    const dentro = (ts) => ts >= encuadre.min && ts <= encuadre.max
    const precioBase = assetGraficoPrecioBase(puntos.filter((punto) => dentro(punto.ts)))
    const linea = []
    const indiceEnLinea = []
    const valores = puntos.map((punto) => assetGraficoValorDelPunto(punto, vista, unidad, precioBase))
    // Lo anterior al rango viene de «Todo», con velas diarias y su propio hueco.
    const huecoTras = (anterior) =>
        anterior.ts < (datos.inicioDetalle ?? -Infinity) && datos.segundosHuecoContexto
            ? Math.max(datos.segundosHuecoContexto, datos.segundosHueco)
            : datos.segundosHueco

    puntos.forEach((punto, indice) => {
        const anterior = puntos[indice - 1]
        if (anterior && punto.ts - anterior.ts > huecoTras(anterior)) {
            linea.push({ x: (punto.ts + anterior.ts) / 2, y: null })
        }
        indiceEnLinea[indice] = linea.length
        const vela = Number.isFinite(valores[indice])
            ? assetGraficoVelaDelPunto(punto, vista, unidad, precioBase)
            : null
        linea.push(vela ? { x: punto.ts, y: valores[indice], punto, vela } : { x: punto.ts, y: valores[indice], punto })
    })
    assetGraficoAnclarAVelas(linea)

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
            const enLinea = linea[indiceEnLinea[operacion.indice]]
            grupo.set(clave, {
                x: puntos[operacion.indice].ts,
                y,
                indiceLinea: indiceEnLinea[operacion.indice],
                operaciones: [],
                ...(enLinea.xVela !== undefined ? { xVela: enLinea.xVela } : {})
            })
        }
        grupo.get(clave).operaciones.push(operacion)
    })

    const lineaVisible = linea.filter((punto) => dentro(punto.x))
    const limitesX = assetGraficoLimitesX(lineaVisible)
    const trazo = limitesX ? lineaVisible.filter((punto) => punto.x >= limitesX.min) : []
    const enVista = (marca) => dentro(marca.x)
    return {
        linea,
        compras: [...marcas.compra.values()],
        ventas: [...marcas.venta.values()],
        comprasVisibles: [...marcas.compra.values()].filter(enVista),
        ventasVisibles: [...marcas.venta.values()].filter(enVista),
        extremos: assetGraficoExtremos(trazo),
        extremosVelas: assetGraficoExtremosVelas(trazo),
        limitesX,
        ultimo: assetGraficoUltimoValido(lineaVisible),
        trazables: lineaVisible.filter((punto) => Number.isFinite(punto.y)).length,
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

/**
 * Final del eje X con un hueco a la derecha de la última vela, como en TradingView.
 *
 * Solo se deja cuando lo último que se ve es el dato más reciente: con un «Hasta» en
 * el pasado el hueco se llenaría con velas posteriores a la fecha elegida.
 *
 * @param {{min: number, max: number}} limitesX Primer y último instante visibles.
 * @param {number|undefined} finDatos Instante del último dato de toda la serie.
 * @returns {number} El máximo que se le pone al eje X.
 */
function assetGraficoMaxConMargen(limitesX, finDatos) {
    if (finDatos === undefined || limitesX.max < finDatos) return limitesX.max
    return limitesX.max + (limitesX.max - limitesX.min) * ASSET_GRAFICO_MARGEN_DERECHO
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

// `modos` son los modos del gráfico en los que se ve el grupo, separados por espacios;
// sin él, se ve siempre. `oculto` lo pinta escondido, para grupos que muestra otra
// función.
function assetGraficoSelector(nombre, opciones, activa, modos = "", oculto = false) {
    const botones = opciones
        .map(
            (opcion) =>
                `<button type="button" class="mToggleBtn${opcion.clave === activa ? " active" : ""}" data-grafico-${nombre}="${opcion.clave}" aria-pressed="${opcion.clave === activa}">${escapeHtml(opcion.etiqueta)}</button>`
        )
        .join("")
    return `<div class="mToggleGroup${oculto ? " hidden" : ""}" role="group"${modos ? ` data-grafico-modos="${modos}"` : ""}>${botones}</div>`
}

// El modo se elige desde el propio botón de la pestaña «Gráfico», que hace de
// desplegable con el mismo aspecto que los del menú superior.
function assetGraficoOpcionesModo(activo) {
    return assetGraficoModos
        .map(
            (modo) =>
                `<div class="assetGraficoModoFila">
                    <button type="button" class="navBtn navDropdownItem${modo.clave === activo ? " active" : ""}" role="menuitemradio" aria-checked="${modo.clave === activo}" data-grafico-modo="${modo.clave}">${escapeHtml(modo.etiqueta)}</button>
                    <button type="button" class="assetGraficoAyudaBtn" data-grafico-ayuda="${modo.clave}" aria-label="Qué muestra ${escapeHtml(modo.etiqueta)}" aria-expanded="false">?</button>
                </div>`
        )
        .join("")
}

// Panel con la ilustración del modo, a un lado del menú. Si ya se ve el de ese modo, se cierra.
function assetGraficoAlternarAyuda(menu, boton) {
    const clave = boton.dataset.graficoAyuda
    const previo = menu.querySelector(".assetGraficoAyuda")
    const eraElMismo = previo?.dataset.modo === clave
    previo?.remove()
    menu.querySelectorAll("[data-grafico-ayuda]").forEach((otro) => otro.setAttribute("aria-expanded", "false"))
    const ayuda = ASSET_GRAFICO_AYUDA[clave]
    if (eraElMismo || !ayuda) return
    boton.setAttribute("aria-expanded", "true")
    menu.insertAdjacentHTML(
        "beforeend",
        `<div class="assetGraficoAyuda" data-modo="${clave}" role="note">
            <svg viewBox="0 0 230 110" role="img" aria-hidden="true">${ayuda.svg}</svg>
            <p>${escapeHtml(ayuda.texto)}</p>
        </div>`
    )
}

function assetGraficoAlternarMenuModo(boton) {
    const menu = document.getElementById("assetGraficoModoMenu")
    if (!menu) return
    const abierto = menu.classList.contains("open")
    document.querySelectorAll(".navDropdownMenu.open").forEach((otro) => otro.classList.remove("open"))
    boton.setAttribute("aria-expanded", String(!abierto))
    if (abierto) return
    menu.innerHTML = assetGraficoOpcionesModo(assetGraficoEstado().modo)
    // position: fixed, como los del menú superior: el contenedor de pestañas
    // tiene overflow: hidden y recortaría un menú absoluto.
    const rect = boton.getBoundingClientRect()
    menu.style.top = `${rect.bottom + 4}px`
    menu.style.left = `${rect.left}px`
    menu.style.minWidth = `${rect.width}px`
    menu.classList.add("open")
}

function assetGraficoCambiarModo(modo) {
    setChartPref("assetGraficoModo", modo)
    const assetId = document.querySelector(".assetTablePage")?.dataset.assetId
    if (!assetId || !document.getElementById("assetGraficoSection")?.dataset.assetId) return
    assetGraficoSincronizarModo()
    // El modo anual pide todo el histórico y los demás el rango elegido.
    assetGraficoCargar(assetId)
}

// Se llama una vez por ficha, desde setupAssetTabs.
function assetGraficoRegistrarMenuModo() {
    const menu = document.getElementById("assetGraficoModoMenu")
    if (!menu) return
    menu.addEventListener("click", (evento) => {
        const ayuda = evento.target.closest("[data-grafico-ayuda]")
        if (ayuda) {
            // Sin esto el clic llega al document y cerraría el menú.
            evento.stopPropagation()
            assetGraficoAlternarAyuda(menu, ayuda)
            return
        }
        // Un clic dentro del panel de ayuda tampoco debe cerrar el menú.
        if (evento.target.closest(".assetGraficoAyuda")) {
            evento.stopPropagation()
            return
        }
        const opcion = evento.target.closest("[data-grafico-modo]")
        if (!opcion) return
        menu.classList.remove("open")
        document.getElementById("graficoTabBtn")?.setAttribute("aria-expanded", "false")
        assetGraficoCambiarModo(opcion.dataset.graficoModo)
    })
}

// Enseña solo los controles que valen para el modo elegido.
function assetGraficoSincronizarModo() {
    const { modo } = assetGraficoEstado()
    document.querySelectorAll("#assetGraficoSection [data-grafico-modos]").forEach((elemento) => {
        elemento.classList.toggle("hidden", !elemento.dataset.graficoModos.split(" ").includes(modo))
    })
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
    return campo === "desde"
        ? { max: ventana.hasta || assetGraficoHoy() }
        : { min: ventana.desde, max: assetGraficoHoy() }
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
        <div class="walletsSegRango${assetGraficoHayVentana() ? " activo" : ""}" id="assetGraficoFechas" data-grafico-modos="compras indices" role="group" aria-label="Buscar por fecha">
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
    const { rango, vista, unidad, tipo, temporalidad, vistaEstacional, escalaEstacional } = assetGraficoEstado()
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
                    ${assetGraficoSelector("vista", ASSET_GRAFICO_VISTAS, vista, "compras")}
                    ${assetGraficoSelector("unidad", ASSET_GRAFICO_UNIDADES, unidad, "compras")}
                    ${assetGraficoSelector("tipo", ASSET_GRAFICO_TIPOS, tipo, "compras")}
                    ${assetGraficoSelector("vista-estacional", ASSET_GRAFICO_VISTAS_ESTACIONAL, vistaEstacional, "estacional")}
                    ${assetGraficoSelector("escala-estacional", ASSET_GRAFICO_ESCALAS_ESTACIONAL, escalaEstacional, "estacional")}
                    <div class="mToggleGroup" role="group" id="assetGraficoIndices" aria-label="Índices a comparar" data-grafico-modos="indices"></div>
                    <div class="mToggleGroup assetGraficoAnios" role="group" id="assetGraficoAnios" aria-label="Años a comparar" data-grafico-modos="estacional"></div>
                    ${assetGraficoSelector("rango", ASSET_GRAFICO_RANGOS, assetGraficoHayVentana() ? "" : rango, "compras indices")}
                    ${assetGraficoSelector("temporalidad", ASSET_GRAFICO_TEMPORALIDADES, temporalidad, "", true)}
                    ${assetGraficoFechasHtml()}
                    <button type="button" class="assetGraficoAmpliarBtn" id="assetGraficoAmpliar" aria-pressed="false" aria-label="Ampliar gráfico" title="Ampliar gráfico">
                        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    </button>
                </div>
            </div>
            <div class="assetGraficoLienzo" id="assetGraficoLienzo">
                <canvas id="assetGraficoCanvas"></canvas>
                <div class="assetGraficoFichas" id="assetGraficoFichas"></div>
                <button type="button" class="assetGraficoOcultarFichas hidden" id="assetGraficoOcultarFichas" title="Ocultar los detalles fijados">Ocultar detalles</button>
            </div>
            <div class="assetGraficoTabla hidden" id="assetGraficoTabla"></div>
            <p class="assetGraficoVacio hidden" id="assetGraficoVacio"></p>
            <div class="assetGraficoLeyenda" id="assetGraficoLeyenda"></div>
            <p class="assetGraficoNota" id="assetGraficoNota"></p>
        </div>
        <div class="assetGraficoFondo hidden" id="assetGraficoFondo"></div>
    `
}

/**
 * Pone o quita el gráfico a casi toda la ventana.
 *
 * Se amplía el mismo panel en vez de abrir uno nuevo: los controles, el zoom y la
 * escala siguen funcionando igual, y Chart.js se redimensiona solo porque observa
 * el tamaño de su contenedor.
 *
 * @param {boolean} ampliar true para ampliar, false para volver al tamaño normal.
 */
function assetGraficoAmpliar(ampliar) {
    const panel = document.querySelector("#assetGraficoSection .assetGrafico")
    const boton = document.getElementById("assetGraficoAmpliar")
    if (!panel || !boton) return
    panel.classList.toggle("assetGraficoAmpliado", ampliar)
    document.getElementById("assetGraficoFondo")?.classList.toggle("hidden", !ampliar)
    boton.setAttribute("aria-pressed", String(ampliar))
    const texto = ampliar ? "Reducir gráfico" : "Ampliar gráfico"
    boton.setAttribute("aria-label", texto)
    boton.title = texto
}

let _assetGraficoEscapeRegistrado = false

// Escape cierra la vista ampliada. Se registra una sola vez porque la sección se
// repinta al cambiar de activo. Con el calendario abierto, Escape es para él: lo
// cierra y marca el evento con preventDefault antes de que llegue aquí.
function assetGraficoRegistrarEscape() {
    if (_assetGraficoEscapeRegistrado) return
    _assetGraficoEscapeRegistrado = true
    document.addEventListener("keydown", (evento) => {
        if (evento.key !== "Escape" || evento.defaultPrevented || document.querySelector(".calPopup")) return
        if (document.querySelector(".assetGraficoAmpliado")) assetGraficoAmpliar(false)
    })
}

function assetGraficoDestruir() {
    _assetGraficoChart?.destroy()
    _assetGraficoChart = null
    assetGraficoQuitarFichas()
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
        <span class="assetGraficoLeyendaItem"><span class="assetGraficoPunto assetGraficoPuntoCompra"></span>Compras (${cuenta(series.comprasVisibles ?? series.compras)})</span>
        <span class="assetGraficoLeyendaItem"><span class="assetGraficoPunto assetGraficoPuntoVenta"></span>Ventas (${cuenta(series.ventasVisibles ?? series.ventas)})</span>
    `
}

// Las notas explican lo que falta en el gráfico: sin ellas, una compra antigua sin
// punto parecería un fallo.
function assetGraficoTextoNota(datos, series, vista, moneda, usaVelas = false) {
    const partes = []
    if (datos.conVelas) {
        partes.push(
            usaVelas
                ? "Las velas salen de la cotización de TradingView."
                : "La línea sale de la cotización de TradingView."
        )
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

/**
 * Ancho del cuerpo de las velas en píxeles: una fracción del menor hueco entre dos
 * velas seguidas, para que no se monten, con un tope y un mínimo de un píxel.
 *
 * @param {number[]} posiciones Posición X en píxeles de cada vela, en orden.
 * @returns {number}
 */
function assetGraficoAnchoVela(posiciones) {
    let hueco = Infinity
    for (let indice = 1; indice < posiciones.length; indice += 1) {
        const distancia = posiciones[indice] - posiciones[indice - 1]
        if (distancia > 0) hueco = Math.min(hueco, distancia)
    }
    if (!Number.isFinite(hueco)) return ASSET_GRAFICO_VELA_ANCHO_MAX
    return Math.max(1, Math.min(hueco * ASSET_GRAFICO_VELA_ANCHO, ASSET_GRAFICO_VELA_ANCHO_MAX))
}

// Pinta las velas antes que los datasets, así las marcas de compra y venta quedan
// encima. La línea sigue en el gráfico, transparente, porque de ella dependen la
// interacción, el tooltip y la cabecera.
function assetGraficoPluginVelas(linea, colorSube, colorBaja) {
    const conVela = linea.filter((punto) => punto.vela)
    return {
        id: "assetGraficoVelas",
        beforeDatasetsDraw(chart) {
            const { ctx, chartArea, scales } = chart
            const posiciones = conVela.map((punto) => scales.x.getPixelForValue(punto.x))
            const ancho = assetGraficoAnchoVela(posiciones)
            ctx.save()
            ctx.beginPath()
            ctx.rect(chartArea.left, chartArea.top, chartArea.right - chartArea.left, chartArea.bottom - chartArea.top)
            ctx.clip()
            conVela.forEach(({ vela }, indice) => {
                const x = posiciones[indice]
                const y = (valor) => scales.y.getPixelForValue(valor)
                const color = vela.cierre >= vela.apertura ? colorSube : colorBaja
                ctx.strokeStyle = color
                ctx.fillStyle = color
                ctx.lineWidth = 1
                ctx.beginPath()
                ctx.moveTo(Math.round(x) + 0.5, y(vela.maximo))
                ctx.lineTo(Math.round(x) + 0.5, y(vela.minimo))
                ctx.stroke()
                const arriba = y(Math.max(vela.apertura, vela.cierre))
                // Una vela sin cuerpo (apertura igual al cierre) se ve como una raya.
                const alto = Math.max(1, y(Math.min(vela.apertura, vela.cierre)) - arriba)
                ctx.fillRect(x - ancho / 2, arriba, ancho, alto)
            })
            ctx.restore()
        }
    }
}

function assetGraficoEtiquetasVela(vela, vista, unidad) {
    const formatear = (valor) => assetGraficoFormatearValor(valor, vista, unidad)
    return [
        `Apertura: ${formatear(vela.apertura)}`,
        `Máximo: ${formatear(vela.maximo)}`,
        `Mínimo: ${formatear(vela.minimo)}`,
        `Cierre: ${formatear(vela.cierre)}`
    ]
}

/**
 * Importe de una operación en euros: la cantidad por su precio convertido.
 *
 * Sale de `precioEur`, que el servidor convierte con el cambio de la fecha de la
 * operación; si no lo trae y la operación ya es en euros, vale su propio precio.
 *
 * @param {object} operacion Operación del gráfico (`cantidad`, `precio`, `divisa`, `precioEur`).
 * @returns {number|null} El importe, o null si no se puede saber en euros.
 */
function assetGraficoImporteEur(operacion) {
    const cantidad = Number(operacion?.cantidad)
    if (!Number.isFinite(cantidad) || cantidad <= 0) return null
    if (Number.isFinite(operacion.precioEur)) return cantidad * operacion.precioEur
    const enEuros = normalizeCurrencyCode(operacion.divisa || "EUR") === "EUR"
    return enEuros && Number.isFinite(operacion.precio) ? cantidad * operacion.precio : null
}

// Total de la cartera hoy, el mismo con el que la ficha calcula el «Peso» del activo.
// Es 0 mientras la barra superior no lo ha calculado: entonces no se da el peso.
function assetGraficoTotalCuenta() {
    return window._lastPortfolioMetrics?.totalCuenta || 0
}

/**
 * Líneas que describen una compra o una venta en el tooltip y en su detalle fijado.
 *
 * El peso es el importe de la operación sobre el total de la cartera de hoy, sin
 * importar el rango ni las fechas que se vean en el gráfico.
 *
 * @param {object} operacion Operación del gráfico.
 * @param {string} tipoActivo Tipo del activo, para los decimales de la cantidad.
 * @param {number} totalCuenta Valor total de la cartera en euros; 0 si no se conoce.
 * @returns {string[]} Operación, importe y, si se puede calcular, peso en la cartera.
 *
 * @example
 * assetGraficoLineasOperacion({ tipo: "compra", cantidad: 2, precio: 10, divisa: "EUR" }, "acciones", 1000)
 * // ["Compra: 2 a 10,00 €", "Invertido: 20,00 €", "Peso en la cartera: 2,00 %"]
 */
function assetGraficoLineasOperacion(operacion, tipoActivo, totalCuenta) {
    const venta = operacion.tipo === "venta"
    const cantidad = formatAssetParticipationValue(operacion.cantidad, tipoActivo)
    const tienePrecio = Number.isFinite(operacion.precio)
    const precio = tienePrecio ? ` a ${assetGraficoFormatearDinero(operacion.precio, operacion.divisa)}` : ""
    const lineas = [`${venta ? "Venta" : "Compra"}: ${cantidad}${precio}`]

    const importeEur = assetGraficoImporteEur(operacion)
    // Sin cambio a euros se da al menos el importe en la divisa de la operación.
    const importe = importeEur ?? (tienePrecio ? operacion.cantidad * operacion.precio : null)
    if (importe !== null) {
        const moneda = importeEur !== null ? "EUR" : operacion.divisa
        lineas.push(`${venta ? "Vendido" : "Invertido"}: ${formatMoneyWithDecimals(importe, moneda, 2)}`)
    }
    if (importeEur !== null && totalCuenta > 0) {
        lineas.push(`Peso en la cartera: ${assetGraficoFormatearPct((importeEur / totalCuenta) * 100, false)}`)
    }
    return lineas
}

function assetGraficoEtiquetasMarca(marca) {
    const tipoActivo = document.querySelector(".assetTablePage")?.dataset.assetType || ""
    const totalCuenta = assetGraficoTotalCuenta()
    return marca.operaciones.flatMap((operacion) => assetGraficoLineasOperacion(operacion, tipoActivo, totalCuenta))
}

/**
 * Clave estable de una marca de compra o venta.
 *
 * No usa la altura ni el índice del punto, que cambian con la vista y el rango: así
 * un detalle fijado sigue fijado al cambiar de vista, de unidad o de rango.
 *
 * @param {{operaciones: object[]}} marca Marca de `assetGraficoSeries`.
 * @returns {string}
 */
function assetGraficoClaveMarca(marca) {
    return marca.operaciones
        .map((operacion) => `${operacion.tipo}|${operacion.fecha}|${operacion.cantidad}|${operacion.precio}`)
        .join(";")
}

function assetGraficoEtiquetasTooltip(contexto, vista, unidad, usaVelas = false) {
    const raw = contexto.raw
    if (contexto.datasetIndex === 0 && usaVelas && raw.vela) return assetGraficoEtiquetasVela(raw.vela, vista, unidad)
    if (contexto.datasetIndex === 0) {
        const detalle = raw.punto ? assetGraficoDetalleDelPunto(raw.punto, vista, unidad) : ""
        const base = assetGraficoFormatearValor(raw.y, vista, unidad)
        return detalle ? `${base}  (${detalle})` : base
    }
    return assetGraficoEtiquetasMarca(raw)
}

function assetGraficoDatasetMarcas(datos, etiqueta, color, fondo) {
    return {
        type: "line",
        label: etiqueta,
        data: datos,
        showLine: false,
        // El eje empieza justo en el primer punto: una marca ahí saldría cortada. Se
        // deja asomar lo que mide la marca y no más: las de antes del encuadre, que
        // están ahí para verlas al alejar, no deben pintarse encima de los ejes.
        clip: ASSET_GRAFICO_MARGEN_MARCA,
        pointRadius: 6,
        pointHoverRadius: 8,
        pointBackgroundColor: color,
        pointBorderColor: fondo,
        pointBorderWidth: 2,
        pointHoverBorderColor: fondo,
        pointHoverBackgroundColor: color
    }
}

/**
 * Marca de compra o venta bajo un punto del lienzo.
 *
 * @param {object} chart Gráfico de compras y ventas (datasets 1 y 2 son las marcas).
 * @param {number} x Posición en píxeles dentro del lienzo.
 * @param {number} y Posición en píxeles dentro del lienzo.
 * @returns {object|null} La marca más cercana a menos de ASSET_GRAFICO_RADIO_PULSAR.
 */
function assetGraficoMarcaEn(chart, x, y) {
    let mejor = null
    ;[1, 2].forEach((datasetIndex) => {
        chart.getDatasetMeta(datasetIndex).data.forEach((element, index) => {
            const distancia = Math.hypot(element.x - x, element.y - y)
            if (distancia > ASSET_GRAFICO_RADIO_PULSAR || (mejor && distancia >= mejor.distancia)) return
            mejor = { marca: chart.data.datasets[datasetIndex].data[index], distancia }
        })
    })
    return mejor?.marca ?? null
}

// Pulsar un punto fija su detalle; volver a pulsarlo lo suelta.
function assetGraficoAlternarFijada(chart, evento) {
    const marca = assetGraficoMarcaEn(chart, evento.x, evento.y)
    if (!marca) return
    const clave = assetGraficoClaveMarca(marca)
    if (_assetGraficoFijadas.has(clave)) _assetGraficoFijadas.delete(clave)
    else _assetGraficoFijadas.add(clave)
    // Redibuja para que el tooltip normal salga o deje de salir sobre ese punto.
    chart.update("none")
}

// Quita las fichas de la pantalla sin olvidar qué marcas están fijadas: se llama al
// destruir el gráfico, y el siguiente las vuelve a pintar si siguen en sus datos.
function assetGraficoQuitarFichas() {
    _assetGraficoFichas.forEach((ficha) => ficha.remove())
    _assetGraficoFichas = new Map()
    document.getElementById("assetGraficoOcultarFichas")?.classList.add("hidden")
}

function assetGraficoOcultarFijadas() {
    _assetGraficoFijadas = new Set()
    assetGraficoQuitarFichas()
    _assetGraficoChart?.update("none")
}

// textContent y no innerHTML: el texto lleva importes y divisas que vienen de la BD.
function assetGraficoCrearFicha(marca, titulo) {
    const ficha = document.createElement("div")
    ficha.className = "assetGraficoFicha"
    const cabecera = document.createElement("strong")
    cabecera.textContent = titulo
    ficha.append(cabecera)
    assetGraficoEtiquetasMarca(marca).forEach((linea) => {
        const fila = document.createElement("span")
        fila.textContent = linea
        ficha.append(fila)
    })
    return ficha
}

/**
 * Sitio de una ficha junto a su punto: a la derecha y, si no cabe, a la izquierda,
 * centrada en altura con el punto.
 *
 * @param {HTMLElement} ficha Ficha ya insertada en el lienzo, para poder medirla.
 * @param {object} chart Gráfico de compras y ventas.
 * @param {{x: number, y: number}} element Elemento de Chart.js de la marca.
 * @returns {object|null} `{ficha, left, top, ancho, alto, min, max}` en píxeles del
 *     lienzo, con `min` y `max` como límites de `top`; null si el punto está fuera.
 */
function assetGraficoCajaFicha(ficha, chart, element) {
    const { chartArea, canvas } = chart
    // Con el gráfico desplazado el punto puede quedar fuera: su ficha también.
    const fuera =
        element.x < chartArea.left ||
        element.x > chartArea.right ||
        element.y < chartArea.top ||
        element.y > chartArea.bottom
    ficha.classList.toggle("hidden", fuera)
    if (fuera) return null
    const ancho = ficha.offsetWidth
    const alto = ficha.offsetHeight
    const anchoLienzo = canvas.offsetLeft + chart.width
    const x = canvas.offsetLeft + element.x
    const derecha = x + ASSET_GRAFICO_SEPARACION_FICHA
    const izquierda = x - ASSET_GRAFICO_SEPARACION_FICHA - ancho
    // Lados en que cabe, el preferido primero; el reparto cambia de lado si así no pisa a otra.
    const lados = []
    if (derecha + ancho <= anchoLienzo - ASSET_GRAFICO_MARGEN_FICHA) lados.push(derecha)
    if (izquierda >= ASSET_GRAFICO_MARGEN_FICHA) lados.push(izquierda)
    if (!lados.length) lados.push(Math.max(ASSET_GRAFICO_MARGEN_FICHA, izquierda))
    const min = ASSET_GRAFICO_MARGEN_FICHA
    const max = Math.max(min, canvas.offsetTop + chart.height - alto - ASSET_GRAFICO_MARGEN_FICHA)
    const top = Math.min(Math.max(canvas.offsetTop + element.y - alto / 2, min), max)
    return { ficha, left: lados[0], lados, top, ancho, alto, min, max }
}

/**
 * Coloca las fichas fijadas sin que se pisen entre sí ni con los obstáculos.
 *
 * Se colocan de arriba abajo según la altura que querrían. Para cada una se prueban,
 * en cada lado de su punto en que cabe, su altura y las justo encima y justo debajo
 * de lo ya colocado, y se queda el hueco libre más cercano a su punto (cambiar de
 * lado cuenta como ASSET_GRAFICO_COSTE_CAMBIO_LADO píxeles más). Si no queda ningún
 * hueco libre en el lienzo, va donde menos superficie pise.
 *
 * @param {object[]} cajas Resultado de `assetGraficoCajaFicha` (`left`, `lados`, `top`,
 *     `ancho`, `alto`, `min`, `max`); se modifican su `left` y su `top`.
 * @param {number} separacion Píxeles mínimos entre dos fichas.
 * @param {object[]} obstaculos Cajas fijas (`left`, `top`, `ancho`, `alto`) que no se
 *     deben tapar, como los botones de arriba a la derecha.
 * @returns {object[]} Las mismas cajas.
 *
 * @example
 * assetGraficoRepartirFichas([
 *     { left: 0, lados: [0], top: 100, ancho: 50, alto: 40, min: 0, max: 500 },
 *     { left: 10, lados: [10], top: 110, ancho: 50, alto: 40, min: 0, max: 500 }
 * ], 6)
 * // La segunda pasa a top 146, justo debajo de la primera.
 */
function assetGraficoRepartirFichas(cajas, separacion = ASSET_GRAFICO_SEPARACION_ENTRE_FICHAS, obstaculos = []) {
    const colocadas = [...obstaculos]
    // Superficie que pisaría una ficha en ese sitio, contando el hueco de separación.
    const pisado = (caja, left, top) =>
        colocadas.reduce((total, otra) => {
            const ancho = Math.min(left + caja.ancho, otra.left + otra.ancho) - Math.max(left, otra.left) + separacion
            const alto = Math.min(top + caja.alto, otra.top + otra.alto) - Math.max(top, otra.top) + separacion
            return ancho > 0 && alto > 0 ? total + ancho * alto : total
        }, 0)
    ;[...cajas]
        .sort((a, b) => a.top - b.top)
        .forEach((caja) => {
            const deseada = caja.top
            const lados = caja.lados?.length ? caja.lados : [caja.left]
            const alturas = [
                deseada,
                ...colocadas.flatMap((otra) => [otra.top - caja.alto - separacion, otra.top + otra.alto + separacion])
            ].filter((top) => top >= caja.min && top <= caja.max)
            const opciones = lados.flatMap((left, indice) =>
                alturas.map((top) => ({
                    left,
                    top,
                    pisado: pisado(caja, left, top),
                    coste: Math.abs(top - deseada) + (indice ? ASSET_GRAFICO_COSTE_CAMBIO_LADO : 0)
                }))
            )
            const mejor = opciones.reduce(
                (actual, opcion) =>
                    !actual ||
                    opcion.pisado < actual.pisado ||
                    (opcion.pisado === actual.pisado && opcion.coste < actual.coste)
                        ? opcion
                        : actual,
                null
            )
            if (mejor) {
                caja.left = mejor.left
                caja.top = mejor.top
            }
            colocadas.push(caja)
        })
    return cajas
}

/**
 * Coloca el botón «Ocultar detalles» arriba a la derecha del área, a la izquierda de
 * «Centrar» cuando ese botón sale.
 *
 * @param {object} chart Gráfico de compras y ventas.
 * @param {boolean} visible Si hay alguna ficha fijada en pantalla.
 * @returns {object|null} Zona que ocupan los dos botones (`left`, `top`, `ancho`,
 *     `alto`), para que las fichas no los tapen; null si el botón no se ve.
 */
function assetGraficoColocarBotonOcultar(chart, visible) {
    const boton = document.getElementById("assetGraficoOcultarFichas")
    if (!boton) return null
    boton.classList.toggle("hidden", !visible)
    if (!visible) return null
    const { chartArea, canvas } = chart
    const centrar = typeof escalaPrecioBotonCentrar === "function" ? escalaPrecioBotonCentrar(chart) : null
    const derecha = centrar ? centrar.x : chartArea.right
    const top = canvas.offsetTop + chartArea.top + ASSET_GRAFICO_MARGEN_OCULTAR
    const left = canvas.offsetLeft + derecha - ASSET_GRAFICO_MARGEN_OCULTAR - boton.offsetWidth
    boton.style.top = `${top}px`
    boton.style.left = `${left}px`
    const fin = canvas.offsetLeft + (centrar ? centrar.x + centrar.ancho : chartArea.right)
    return { left, top, ancho: fin - left, alto: Math.max(boton.offsetHeight, centrar?.alto ?? 0) }
}

/**
 * Pinta y recoloca las fichas de las marcas fijadas tras cada dibujo del gráfico.
 *
 * Son elementos HTML sobre el lienzo y no el tooltip de Chart.js, que solo enseña
 * uno a la vez y se va en cuanto el cursor se mueve. Se recolocan en cada dibujo para
 * seguir a su punto al acercar, alejar o desplazar el gráfico.
 *
 * @param {function(number): string} formatearFecha Fecha de la cabecera de cada ficha.
 * @returns {object} Plugin de Chart.js.
 */
function assetGraficoPluginFijadas(formatearFecha) {
    return {
        id: "assetGraficoFijadas",
        afterDraw(chart) {
            const capa = document.getElementById("assetGraficoFichas")
            if (!capa) return
            const vivas = new Set()
            const cajas = []
            ;[1, 2].forEach((datasetIndex) => {
                const datos = chart.data.datasets[datasetIndex].data
                chart.getDatasetMeta(datasetIndex).data.forEach((element, index) => {
                    const clave = assetGraficoClaveMarca(datos[index])
                    if (!_assetGraficoFijadas.has(clave)) return
                    vivas.add(clave)
                    let ficha = _assetGraficoFichas.get(clave)
                    if (!ficha) {
                        ficha = assetGraficoCrearFicha(datos[index], formatearFecha(datos[index].x))
                        capa.append(ficha)
                        _assetGraficoFichas.set(clave, ficha)
                    }
                    const caja = assetGraficoCajaFicha(ficha, chart, element)
                    if (caja) cajas.push(caja)
                })
            })
            _assetGraficoFichas.forEach((ficha, clave) => {
                if (vivas.has(clave)) return
                ficha.remove()
                _assetGraficoFichas.delete(clave)
            })
            const botones = assetGraficoColocarBotonOcultar(chart, vivas.size > 0)
            const obstaculos = botones ? [botones] : []
            assetGraficoRepartirFichas(cajas, ASSET_GRAFICO_SEPARACION_ENTRE_FICHAS, obstaculos).forEach(
                ({ ficha, left, top }) => {
                    ficha.style.left = `${left}px`
                    ficha.style.top = `${top}px`
                }
            )
        }
    }
}

/**
 * Paso «redondo» (1, 2, 2,5 o 5 por una potencia de 10) igual o mayor que el dado.
 *
 * @param {number} bruto Paso sin redondear; mayor que 0.
 * @returns {number}
 *
 * @example
 * assetGraficoPasoRedondo(3400)  // 5000
 */
function assetGraficoPasoRedondo(bruto) {
    const potencia = 10 ** Math.floor(Math.log10(bruto))
    const fraccion = bruto / potencia
    const redondo = fraccion <= 1 ? 1 : fraccion <= 2 ? 2 : fraccion <= 2.5 ? 2.5 : fraccion <= 5 ? 5 : 10
    return redondo * potencia
}

// Quita la cola de coma flotante (0,1 + 0,2) para que la cifra se escriba limpia.
function assetGraficoLimpiarCifra(valor) {
    return Number(valor.toPrecision(12))
}

/**
 * Valores del eje vertical, a la misma distancia en pantalla unos de otros.
 *
 * Chart.js reparte bien la escala lineal pero en la logarítmica pone las marcas en
 * 1, 2, 5... por potencia de 10, que en un tramo corto salen a saltos irregulares
 * (90.000, 60.000, 49.000, 46.000). Aquí se pone una marca cada
 * ASSET_GRAFICO_PIXELES_ENTRE_MARCAS_Y píxeles: en lineal, con un paso redondo; en
 * logarítmica, a intervalos iguales del logaritmo, redondeando cada valor al orden de
 * magnitud del salto entre marcas para que la cifra sea redonda sin perder el ritmo.
 *
 * @param {number} min Valor más bajo del eje.
 * @param {number} max Valor más alto del eje.
 * @param {number} alto Alto del eje en píxeles.
 * @param {boolean} logaritmica Si el eje es logarítmico.
 * @returns {number[]} Valores de menor a mayor, todos dentro de [min, max].
 *
 * @example
 * assetGraficoMarcasEjeY(0, 100, 220, false)  // [0, 20, 40, 60, 80, 100]
 */
function assetGraficoMarcasEjeY(min, max, alto, logaritmica) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return []
    const tramos = Math.max(2, Math.floor((alto || 0) / ASSET_GRAFICO_PIXELES_ENTRE_MARCAS_Y))
    const usaLog = logaritmica && min > 0
    const fraccion = (valor) => (usaLog ? Math.log(valor / min) / Math.log(max / min) : (valor - min) / (max - min))
    const marcas = []
    const anadir = (valor) => {
        if (valor < min || valor > max || valor === marcas[marcas.length - 1]) return
        // Pegada al borde de abajo la cifra se cruza con las fechas y los botones AUTO y LOG.
        if (alto && fraccion(valor) * alto < ASSET_GRAFICO_MARGEN_INFERIOR_MARCAS_Y) return
        marcas.push(valor)
    }
    if (usaLog) {
        const razon = (max / min) ** (1 / tramos)
        for (let indice = 0; indice <= tramos; indice += 1) {
            const valor = min * razon ** indice
            const precision = 10 ** Math.floor(Math.log10(valor * (razon - 1)))
            anadir(assetGraficoLimpiarCifra(Math.round(valor / precision) * precision))
        }
        return marcas
    }
    const paso = assetGraficoPasoRedondo((max - min) / tramos)
    const primera = Math.ceil(min / paso)
    for (let indice = primera; indice * paso <= max; indice += 1) anadir(assetGraficoLimpiarCifra(indice * paso))
    return marcas
}

// El selector de línea o velas solo se ve cuando las velas son posibles: en la vista
// de posición o sin datos de TradingView no cambiaría nada.
function assetGraficoSincronizarTipo(vista) {
    const grupo = document.querySelector("#assetGraficoSection [data-grafico-tipo]")?.parentElement
    if (!grupo) return
    const posible = vista === "precio" && Boolean(_assetGraficoDatos?.conVelas)
    if (!posible) grupo.classList.add("hidden")
}

// Con velas de una temporalidad se elige la temporalidad y no el periodo. Va después
// de assetGraficoSincronizarModo, que enseña el periodo en «Compras / ventas».
function assetGraficoSincronizarTemporalidad() {
    const seccion = document.getElementById("assetGraficoSection")
    if (!seccion) return
    const conTemporalidad = assetGraficoEstado().modo === "compras" && Boolean(_assetGraficoDatos?.temporalidad)
    seccion.querySelector("[data-grafico-temporalidad]")?.parentElement.classList.toggle("hidden", !conTemporalidad)
    if (conTemporalidad) seccion.querySelector("[data-grafico-rango]")?.parentElement.classList.add("hidden")
}

function assetGraficoDibujar() {
    const lienzo = document.getElementById("assetGraficoLienzo")
    const canvas = document.getElementById("assetGraficoCanvas")
    const pagina = document.querySelector(".assetTablePage")
    if (!lienzo || !canvas || !_assetGraficoDatos || typeof Chart === "undefined") return

    assetGraficoSincronizarModo()
    assetGraficoSincronizarTemporalidad()
    // La tabla solo existe en «Estacionales» y la vuelve a enseñar ese modo si toca.
    document.getElementById("assetGraficoTabla")?.classList.add("hidden")
    const { modo, rango, vista, unidad, tipo } = assetGraficoEstado()
    if (modo !== "compras") {
        assetGraficoDibujarModo(modo)
        return
    }
    assetGraficoSincronizarTipo(vista)
    const usaVelas = assetGraficoUsaVelas(_assetGraficoDatos, vista, tipo)
    // Vuelve del otro modo: la cabecera y la leyenda las reescribe el resto de la función.
    // Se pinta todo lo cargado y se encuadra el rango o las fechas: al alejar se ve lo
    // anterior. La cabecera y la nota solo cuentan lo encuadrado.
    const completos = assetGraficoDesdePrimeraCompra(
        assetGraficoUnirContexto(_assetGraficoDatos, _assetGraficoContexto),
        vista,
        _assetGraficoVentana
    )
    const encuadre = assetGraficoEncuadre(completos, _assetGraficoVentana)
    _assetGraficoVisibles = assetGraficoRecortarTs(completos, encuadre)
    const series = assetGraficoSeries(completos, vista, unidad, encuadre)
    assetGraficoEscribir("assetGraficoEtiqueta", assetGraficoEtiquetaVista(vista))

    if (!series.ultimo || series.trazables < 2) {
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
    // Con velas el máximo y el mínimo son los de las mechas, no los de los cierres.
    const extremos = usaVelas ? series.extremosVelas || series.extremos : series.extremos

    assetGraficoRegistrarModo()
    assetGraficoDestruir()
    _assetGraficoChart = new Chart(canvas, {
        type: "line",
        data: {
            datasets: [
                {
                    label: assetGraficoEtiquetaVista(vista),
                    data: usaVelas ? series.linea.map(assetGraficoEnVela) : series.linea,
                    // Con velas la línea no se ve, pero sigue dando la interacción.
                    borderColor: usaVelas ? "transparent" : colorLinea,
                    borderWidth: 2,
                    pointRadius: 0,
                    pointHoverRadius: 4,
                    pointHoverBackgroundColor: colorLinea,
                    tension: 0,
                    spanGaps: false
                },
                assetGraficoDatasetMarcas(
                    usaVelas ? series.compras.map(assetGraficoEnVela) : series.compras,
                    "Compras",
                    color("--graficoCompra"),
                    fondo
                ),
                assetGraficoDatasetMarcas(
                    usaVelas ? series.ventas.map(assetGraficoEnVela) : series.ventas,
                    "Ventas",
                    color("--graficoVenta"),
                    fondo
                )
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            // Por encima y por debajo queda sitio para escribir el máximo y el mínimo.
            layout: { padding: { top: 24, bottom: 8, left: 8 } },
            interaction: { mode: ASSET_GRAFICO_MODO, intersect: false },
            onClick: (evento, _elementos, chart) => assetGraficoAlternarFijada(chart, evento),
            scales: {
                x: {
                    type: "linear",
                    bounds: "data",
                    min: series.limitesX.min,
                    max: assetGraficoMaxConMargen(series.limitesX, assetGraficoUltimoValido(series.linea)?.x),
                    grid: { display: false },
                    border: { color: colorRejilla },
                    ticks: {
                        color: colorTexto,
                        maxTicksLimit: 7,
                        maxRotation: 0,
                        // Con el tramo que se ve ahora, que cambia al alejar o acercar.
                        callback(valor) {
                            return assetGraficoFormatearEje(valor, this.max - this.min)
                        }
                    }
                },
                y: {
                    position: "right",
                    grace: "12%",
                    // El eje se calcula con los cierres: sin esto las mechas se saldrían.
                    ...(usaVelas && extremos
                        ? { suggestedMin: extremos.minimo.y, suggestedMax: extremos.maximo.y }
                        : {}),
                    grid: { color: colorRejilla },
                    border: { display: false },
                    // Sirve igual con la escala LOG de js/core/grafico-escala.js, que solo
                    // cambia el tipo del eje y conserva el resto de opciones.
                    afterBuildTicks: (escala) => {
                        const logaritmica = escala.type === "logarithmic"
                        escala.ticks = assetGraficoMarcasEjeY(escala.min, escala.max, escala.height, logaritmica).map(
                            (value) => ({ value })
                        )
                    },
                    ticks: {
                        color: colorTexto,
                        callback: (valor) => assetGraficoFormatearValor(valor, vista, unidad)
                    }
                }
            },
            plugins: {
                legend: { display: false },
                tooltip: {
                    displayColors: false,
                    // Un punto con su detalle fijado no lo repite en el tooltip.
                    filter: (item) =>
                        item.datasetIndex === 0 || !_assetGraficoFijadas.has(assetGraficoClaveMarca(item.raw)),
                    // El orden del array de la interacción pone primero la línea.
                    callbacks: {
                        title: (items) => {
                            const ts = items[0]?.raw?.x
                            return ts ? assetGraficoFormatearFecha(ts, assetGraficoConHora(rango)) : ""
                        },
                        label: (contexto) => assetGraficoEtiquetasTooltip(contexto, vista, unidad, usaVelas)
                    }
                }
            }
        },
        plugins: [
            ...(usaVelas
                ? [assetGraficoPluginVelas(series.linea, color("--graficoCompra"), color("--graficoVenta"))]
                : []),
            assetGraficoPluginGuia(colorTexto),
            assetGraficoPluginValorCursor(
                (valor) => assetGraficoFormatearValor(valor, vista, unidad),
                colorTexto,
                fondo
            ),
            assetGraficoPluginExtremos(
                extremos,
                (valor) => assetGraficoFormatearValor(valor, vista, unidad),
                colorTexto
            ),
            assetGraficoPluginFijadas((ts) => assetGraficoFormatearFecha(ts, assetGraficoConHora(rango)))
        ]
    })

    assetGraficoActualizarCabecera(series.ultimo)
    assetGraficoEscribirLeyenda(series)
    assetGraficoEscribir(
        "assetGraficoNota",
        assetGraficoTextoNota(_assetGraficoVisibles, series, vista, pagina?.dataset.assetCurrency, usaVelas)
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

// Con `previos`, los rangos intradía traen también las velas anteriores al rango.
// Con `temporalidad`, todas las velas de esa temporalidad, sin mirar el rango.
async function assetGraficoPedir(assetId, rango, previos = false, temporalidad = "") {
    const params = new URLSearchParams({ rango })
    const tv = assetGraficoSimboloTv()
    if (tv) params.set("tv", tv)
    if (previos) params.set("previos", "1")
    if (temporalidad) params.set("temporalidad", temporalidad)
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
    input.calendarioMarcas = (iso) => [...(_assetGraficoDias?.get(iso) || [])]
    abrirCalendarioFecha(input, boton)
}

// «Todo» para poner delante del rango. Si falla, el rango se pinta solo.
async function assetGraficoPedirContexto(assetId) {
    try {
        return await assetGraficoPedir(assetId, "TODO")
    } catch (error) {
        console.error("Gráfico del activo: no se pudo cargar el histórico anterior al rango", error)
        return null
    }
}

async function assetGraficoCargar(assetId) {
    const token = ++_assetGraficoToken
    const rango = assetGraficoRangoEfectivo()
    const temporalidad = assetGraficoModoVelas() ? assetGraficoEstado().temporalidad : ""
    try {
        // Se pide en paralelo y cada vez: una compra nueva tiene que salir también
        // en lo anterior al rango, y el servidor guarda las velas en caché.
        const [cuerpo, contexto] = await Promise.all([
            assetGraficoPedir(assetId, rango, !temporalidad && ASSET_GRAFICO_RANGOS_INTRADIA.has(rango), temporalidad),
            rango === "TODO" ? null : assetGraficoPedirContexto(assetId)
        ])
        // Otro rango u otro activo pueden haberse pedido entretanto.
        if (token !== _assetGraficoToken) return
        _assetGraficoDatos = cuerpo
        _assetGraficoContexto = rango === "TODO" ? cuerpo : contexto
        if (_assetGraficoContexto) _assetGraficoDias = assetGraficoDiasConOperaciones(_assetGraficoContexto.operaciones)
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
    if (boton.dataset.graficoTemporalidad) {
        setChartPref("assetGraficoTemporalidad", boton.dataset.graficoTemporalidad)
        assetGraficoCargar(assetId)
        return
    }
    const conVelasAntes = assetGraficoModoVelas()
    if (boton.dataset.graficoVista) setChartPref("assetGraficoVista", boton.dataset.graficoVista)
    if (boton.dataset.graficoUnidad) setChartPref("assetGraficoUnidad", boton.dataset.graficoUnidad)
    if (boton.dataset.graficoTipo) setChartPref("assetGraficoTipo", boton.dataset.graficoTipo)
    if (boton.dataset.graficoVistaEstacional)
        setChartPref("assetGraficoVistaEstacional", boton.dataset.graficoVistaEstacional)
    if (boton.dataset.graficoEscalaEstacional) {
        setChartPref("assetGraficoEscalaEstacional", boton.dataset.graficoEscalaEstacional)
    }
    // Entre velas por temporalidad y línea por periodo cambian los datos, no solo el dibujo.
    if (assetGraficoModoVelas() !== conVelasAntes) {
        assetGraficoCargar(assetId)
        return
    }
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
        _assetGraficoContexto = null
        _assetGraficoVentana = { desde: "", hasta: "" }
        _assetGraficoDias = null
        _assetGraficoFijadas = new Set()
        _assetGraficoFichas = new Map()
        assetGraficoPintarEsqueleto(seccion)
        assetGraficoRegistrarEscape()
        seccion.addEventListener("click", (evento) => {
            if (evento.target.closest("#assetGraficoAmpliar")) {
                assetGraficoAmpliar(!document.querySelector(".assetGraficoAmpliado"))
                return
            }
            if (evento.target.closest("#assetGraficoFondo")) {
                assetGraficoAmpliar(false)
                return
            }
            if (evento.target.closest("#assetGraficoOcultarFichas")) {
                assetGraficoOcultarFijadas()
                return
            }
            const indice = evento.target.closest("[data-grafico-indice]")
            if (indice) {
                assetGraficoAlternarIndice(indice.dataset.graficoIndice)
                return
            }
            const anio = evento.target.closest("[data-grafico-anio]")
            if (anio) {
                assetGraficoAlternarAnio(anio)
                return
            }
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
