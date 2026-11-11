// Activos > Paneles: tableros que monta el usuario con widgets.
//
// La idea es la de los paneles de Trade Republic: cada panel es una rejilla de
// 12 columnas donde se colocan widgets (mapa de calor, gráfico de TradingView,
// la cartera, favoritos…), se arrastran por la cabecera para reordenarlos y se
// estiran por la esquina. Se pueden tener varios paneles, cada uno en su
// pestaña, y uno nuevo empieza en una galería de plantillas.
//
// Lo que se guarda es solo la forma: qué widgets hay, su tamaño y sus opciones.
// Va a las preferencias del portfolio en el servidor (`panelesConfig`, ver
// python/stores/paneles_config.py), no a localStorage, para que el panel sea el
// mismo en cualquier navegador. Los datos se calculan al abrir la página con
// las mismas funciones que la Vista general y el mapa de calor, así que los
// números cuadran con el resto de la aplicación.
//
// Los widgets de un mismo panel están conectados: pulsar un activo en el mapa,
// la cartera o los favoritos lo abre en los gráficos del panel que tengan el
// enlace encendido (el punto de su cabecera). Si el panel no tiene gráfico, se
// abre el modal de TradingView de siempre.

const PN_COLUMNAS = 12
const PN_FILA = 56
const PN_HUECO = 10
const PN_ALTO_MAX = 16
// Cada columna y cada fila de la rejilla se parte en este número de pistas
// para que estirar un widget sea casi continuo en vez de saltar de celda en
// celda. Los tamaños se siguen guardando en columnas y filas (con fracciones),
// así que los paneles ya guardados y las plantillas no cambian. Debe coincidir
// con el 288 (12 × 24) y el «/ 24» de .pnGrid en paneles.css.
const PN_SUBDIVISION = 24

// `grupo` ordena el menú de añadir; `enlazable` dice que el widget sigue al
// activo que se pulsa en otro widget del panel (el punto de su cabecera).
const PN_GRUPOS = {
    cartera: "Tu cartera",
    metricas: "Métricas",
    mercado: "Mercado",
    sentimiento: "Sentimiento de mercado",
    info: "Información"
}

const PN_TIPOS = {
    mapa: {
        nombre: "Mapa de la cuenta",
        desc: "Tu dinero: tamaño por posición y lo que ha movido",
        grupo: "cartera",
        w: 8,
        h: 7,
        minW: 3,
        minH: 3
    },
    cartera: {
        nombre: "Tu cartera",
        desc: "Posiciones, valor y rendimiento",
        grupo: "cartera",
        w: 12,
        h: 6,
        minW: 4,
        minH: 3
    },
    rendimiento: {
        nombre: "Tu rendimiento",
        desc: "Evolución del valor de la cartera",
        grupo: "cartera",
        w: 8,
        h: 5,
        minW: 3,
        minH: 3
    },
    distribucion: {
        nombre: "Distribución",
        desc: "Reparto por tipo, activo o divisa",
        grupo: "cartera",
        w: 4,
        h: 5,
        minW: 2,
        minH: 3
    },
    resumen: {
        nombre: "Resumen",
        desc: "Valor, rendimiento y lo que más se mueve hoy",
        grupo: "cartera",
        w: 4,
        h: 5,
        minW: 2,
        minH: 3
    },
    mapaMercado: {
        nombre: "Mapa de mercado",
        desc: "Cómo se mueven los activos y los tickers que añadas",
        grupo: "mercado",
        w: 8,
        h: 7,
        minW: 3,
        minH: 3
    },
    grafico: {
        nombre: "Gráfico",
        desc: "Velas de TradingView",
        grupo: "mercado",
        enlazable: true,
        w: 8,
        h: 7,
        minW: 3,
        minH: 4
    },
    favoritos: {
        nombre: "Favoritos",
        desc: "Precio y variación de una lista",
        grupo: "mercado",
        w: 4,
        h: 7,
        minW: 2,
        minH: 3
    },
    instrumento: {
        nombre: "Instrumento",
        desc: "Precio y gráfico de área de un activo",
        grupo: "mercado",
        enlazable: true,
        w: 4,
        h: 5,
        minW: 2,
        minH: 3
    },
    tecnico: {
        nombre: "Análisis técnico",
        desc: "Señal de compra o venta por indicadores",
        grupo: "mercado",
        enlazable: true,
        w: 4,
        h: 6,
        minW: 3,
        minH: 4
    },
    ficha: {
        nombre: "Ficha del activo",
        desc: "Precio, capitalización, PER y dividendo",
        grupo: "mercado",
        enlazable: true,
        w: 6,
        h: 4,
        minW: 3,
        minH: 3
    },
    perfil: {
        nombre: "Perfil de la empresa",
        desc: "Sector, industria y descripción",
        grupo: "mercado",
        enlazable: true,
        w: 4,
        h: 6,
        minW: 3,
        minH: 3
    },
    noticias: {
        nombre: "Noticias",
        desc: "Titulares del mercado o de un activo",
        grupo: "info",
        enlazable: true,
        w: 4,
        h: 7,
        minW: 3,
        minH: 4
    },
    calendario: {
        nombre: "Calendario económico",
        desc: "Datos macro de la semana",
        grupo: "info",
        w: 4,
        h: 7,
        minW: 3,
        minH: 4
    },
    metrica: {
        nombre: "Métricas",
        desc: "Cualquier gráfico o tabla de la página de Métricas",
        grupo: "metricas",
        w: 12,
        h: 8,
        minW: 4,
        minH: 3
    },
    miedoCodicia: {
        nombre: "Miedo y codicia",
        desc: "Índice de sentimiento y su historial",
        grupo: "sentimiento",
        w: 4,
        h: 8,
        minW: 3,
        minH: 4
    },
    amplitud: {
        nombre: "Amplitud del mercado",
        desc: "Cuántas acciones suben y cuántas bajan hoy",
        grupo: "sentimiento",
        w: 4,
        h: 4,
        minW: 3,
        minH: 3
    },
    indices: {
        nombre: "Índices",
        desc: "S&P 500, Nasdaq, DAX, IBEX, VIX, dólar…",
        grupo: "sentimiento",
        w: 8,
        h: 5,
        minW: 3,
        minH: 3
    },
    sectores: {
        nombre: "Mapa de sectores",
        desc: "S&P 500 por sectores, Nasdaq 100 o cripto",
        grupo: "sentimiento",
        w: 8,
        h: 7,
        minW: 3,
        minH: 4
    },
    escaner: {
        nombre: "Escáner",
        desc: "Más suben, más bajan, RSI extremos y volumen inusual",
        grupo: "sentimiento",
        w: 4,
        h: 7,
        minW: 3,
        minH: 4
    },
    notas: { nombre: "Notas", desc: "Texto libre", grupo: "info", w: 4, h: 4, minW: 2, minH: 2 }
}

// Plantillas de la galería: [tipo, ancho, alto, opciones]. Los anchos de cada
// fila suman 12 para que el panel salga sin huecos.
const PN_PLANTILLAS = [
    {
        id: "research",
        nombre: "Research",
        desc: "Mapa de calor, gráfico y favoritos para estudiar el mercado.",
        widgets: [
            ["mapa", 8, 7],
            ["favoritos", 4, 7],
            ["grafico", 8, 7],
            ["resumen", 4, 7]
        ]
    },
    {
        id: "seguimiento",
        nombre: "Seguimiento",
        desc: "El gráfico del activo que elijas junto a toda tu cartera.",
        widgets: [
            ["grafico", 8, 8],
            ["favoritos", 4, 8],
            ["cartera", 12, 6]
        ]
    },
    {
        id: "cartera",
        nombre: "Cartera",
        desc: "Cómo va tu dinero: evolución, reparto y posiciones.",
        widgets: [
            ["resumen", 4, 5],
            ["rendimiento", 8, 5],
            ["cartera", 8, 7],
            ["distribucion", 4, 7]
        ]
    },
    { id: "vacio", nombre: "Vacío", desc: "Empezar de cero.", widgets: [] }
]

// Dibujos de la galería y del menú de añadir. Son esquemas, no capturas: dicen
// qué hay en el widget sin depender de los datos.
const PN_ICONOS = {
    mapa: `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><rect x="0" y="0" width="58" height="38" rx="2"/><rect x="60" y="0" width="40" height="24" rx="2" opacity=".7"/><rect x="60" y="26" width="19" height="12" rx="2" opacity=".5"/><rect x="81" y="26" width="19" height="12" rx="2" opacity=".6"/><rect x="0" y="40" width="34" height="20" rx="2" opacity=".55"/><rect x="36" y="40" width="22" height="20" rx="2" opacity=".75"/><rect x="60" y="40" width="40" height="20" rx="2" opacity=".45"/></svg>`,
    grafico: `<svg viewBox="0 0 100 60"><g stroke-width="1.5"><line x1="12" y1="18" x2="12" y2="48"/><line x1="28" y1="10" x2="28" y2="40"/><line x1="44" y1="22" x2="44" y2="52"/><line x1="60" y1="8" x2="60" y2="36"/><line x1="76" y1="16" x2="76" y2="44"/><line x1="92" y1="4" x2="92" y2="30"/></g><rect x="8" y="24" width="8" height="16" rx="1"/><rect x="24" y="16" width="8" height="18" rx="1" opacity=".6"/><rect x="40" y="28" width="8" height="16" rx="1"/><rect x="56" y="14" width="8" height="14" rx="1" opacity=".6"/><rect x="72" y="22" width="8" height="14" rx="1"/><rect x="88" y="8" width="8" height="16" rx="1" opacity=".6"/></svg>`,
    cartera: `<svg viewBox="0 0 100 60"><rect x="0" y="2" width="100" height="8" rx="2" opacity=".35"/><g opacity=".8"><rect x="0" y="16" width="34" height="5" rx="2"/><rect x="62" y="16" width="38" height="5" rx="2" opacity=".6"/><rect x="0" y="28" width="28" height="5" rx="2"/><rect x="62" y="28" width="38" height="5" rx="2" opacity=".6"/><rect x="0" y="40" width="38" height="5" rx="2"/><rect x="62" y="40" width="38" height="5" rx="2" opacity=".6"/><rect x="0" y="52" width="24" height="5" rx="2"/><rect x="62" y="52" width="38" height="5" rx="2" opacity=".6"/></g></svg>`,
    favoritos: `<svg viewBox="0 0 100 60"><g><circle cx="5" cy="9" r="4"/><rect x="14" y="6" width="40" height="6" rx="2" opacity=".7"/><rect x="76" y="6" width="24" height="6" rx="2" opacity=".5"/><circle cx="5" cy="30" r="4"/><rect x="14" y="27" width="34" height="6" rx="2" opacity=".7"/><rect x="76" y="27" width="24" height="6" rx="2" opacity=".5"/><circle cx="5" cy="51" r="4"/><rect x="14" y="48" width="44" height="6" rx="2" opacity=".7"/><rect x="76" y="48" width="24" height="6" rx="2" opacity=".5"/></g></svg>`,
    rendimiento: `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><path d="M0 50 L15 44 L28 47 L42 32 L56 36 L70 20 L84 24 L100 8 L100 60 L0 60 Z" opacity=".25"/><path d="M0 50 L15 44 L28 47 L42 32 L56 36 L70 20 L84 24 L100 8" fill="none" stroke-width="2.5"/></svg>`,
    distribucion: `<svg viewBox="0 0 100 60"><circle cx="30" cy="30" r="22" fill="none" stroke-width="10" stroke-dasharray="60 200" opacity=".9"/><circle cx="30" cy="30" r="22" fill="none" stroke-width="10" stroke-dasharray="0 60 45 200" opacity=".55"/><circle cx="30" cy="30" r="22" fill="none" stroke-width="10" stroke-dasharray="0 105 33 200" opacity=".3"/><rect x="62" y="14" width="34" height="5" rx="2" opacity=".7"/><rect x="62" y="28" width="28" height="5" rx="2" opacity=".55"/><rect x="62" y="42" width="30" height="5" rx="2" opacity=".4"/></svg>`,
    resumen: `<svg viewBox="0 0 100 60"><rect x="0" y="2" width="30" height="5" rx="2" opacity=".45"/><rect x="0" y="12" width="60" height="12" rx="2"/><rect x="0" y="34" width="46" height="22" rx="3" opacity=".35"/><rect x="52" y="34" width="48" height="22" rx="3" opacity=".35"/></svg>`,
    notas: `<svg viewBox="0 0 100 60"><g opacity=".7"><rect x="0" y="4" width="92" height="5" rx="2"/><rect x="0" y="16" width="80" height="5" rx="2"/><rect x="0" y="28" width="88" height="5" rx="2"/><rect x="0" y="40" width="54" height="5" rx="2"/></g></svg>`,
    metrica: `<svg viewBox="0 0 100 60"><rect x="0" y="0" width="30" height="8" rx="2" opacity=".5"/><rect x="4" y="40" width="12" height="20" rx="1"/><rect x="22" y="26" width="12" height="34" rx="1" opacity=".7"/><rect x="40" y="32" width="12" height="28" rx="1"/><rect x="58" y="16" width="12" height="44" rx="1" opacity=".7"/><rect x="76" y="22" width="12" height="38" rx="1"/></svg>`,
    miedoCodicia: `<svg viewBox="0 0 100 60"><g fill="none" stroke-width="8"><path d="M14 52 A36 36 0 0 1 28 24" opacity=".9"/><path d="M31 21 A36 36 0 0 1 50 16" opacity=".6"/><path d="M53 16 A36 36 0 0 1 72 22" opacity=".45"/><path d="M75 25 A36 36 0 0 1 86 52" opacity=".75"/></g><line x1="50" y1="52" x2="66" y2="30" stroke-width="3"/><circle cx="50" cy="52" r="4"/></svg>`,
    amplitud: `<svg viewBox="0 0 100 60"><circle cx="30" cy="30" r="22" fill="none" stroke-width="10" stroke-dasharray="80 200"/><circle cx="30" cy="30" r="22" fill="none" stroke-width="10" stroke-dasharray="0 82 50 200" opacity=".45"/><rect x="62" y="16" width="34" height="6" rx="2"/><rect x="62" y="28" width="26" height="5" rx="2" opacity=".55"/><rect x="62" y="40" width="30" height="5" rx="2" opacity=".35"/></svg>`,
    indices: `<svg viewBox="0 0 100 60"><g><rect x="0" y="0" width="30" height="26" rx="3" opacity=".55"/><rect x="35" y="0" width="30" height="26" rx="3" opacity=".8"/><rect x="70" y="0" width="30" height="26" rx="3" opacity=".45"/><rect x="0" y="32" width="30" height="26" rx="3" opacity=".8"/><rect x="35" y="32" width="30" height="26" rx="3" opacity=".45"/><rect x="70" y="32" width="30" height="26" rx="3" opacity=".65"/></g></svg>`,
    sectores: `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><rect x="0" y="0" width="46" height="60" rx="2"/><rect x="48" y="0" width="52" height="28" rx="2" opacity=".55"/><rect x="48" y="30" width="24" height="30" rx="2" opacity=".75"/><rect x="74" y="30" width="26" height="14" rx="2" opacity=".4"/><rect x="74" y="46" width="26" height="14" rx="2" opacity=".6"/></svg>`,
    escaner: `<svg viewBox="0 0 100 60"><g><rect x="0" y="4" width="8" height="6" rx="2" opacity=".5"/><rect x="14" y="4" width="50" height="6" rx="2"/><rect x="76" y="4" width="24" height="6" rx="2" opacity=".6"/><rect x="0" y="22" width="8" height="6" rx="2" opacity=".5"/><rect x="14" y="22" width="42" height="6" rx="2"/><rect x="76" y="22" width="24" height="6" rx="2" opacity=".6"/><rect x="0" y="40" width="8" height="6" rx="2" opacity=".5"/><rect x="14" y="40" width="56" height="6" rx="2"/><rect x="76" y="40" width="24" height="6" rx="2" opacity=".6"/></g></svg>`,
    mapaMercado: `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><rect x="0" y="0" width="32" height="28" rx="2"/><rect x="34" y="0" width="32" height="28" rx="2" opacity=".55"/><rect x="68" y="0" width="32" height="28" rx="2" opacity=".8"/><rect x="0" y="32" width="32" height="28" rx="2" opacity=".45"/><rect x="34" y="32" width="32" height="28" rx="2" opacity=".9"/><rect x="68" y="32" width="32" height="28" rx="2" opacity=".6"/></svg>`,
    instrumento: `<svg viewBox="0 0 100 60" preserveAspectRatio="none"><rect x="0" y="0" width="34" height="6" rx="2"/><rect x="0" y="10" width="22" height="5" rx="2" opacity=".5"/><path d="M0 56 L12 48 L24 52 L38 38 L52 42 L66 28 L80 32 L100 18 L100 60 L0 60 Z" opacity=".25"/><path d="M0 56 L12 48 L24 52 L38 38 L52 42 L66 28 L80 32 L100 18" fill="none" stroke-width="2"/></svg>`,
    tecnico: `<svg viewBox="0 0 100 60"><path d="M22 50 A28 28 0 0 1 78 50" fill="none" stroke-width="7" stroke-dasharray="20 4" opacity=".7"/><line x1="50" y1="50" x2="68" y2="32" stroke-width="3"/><circle cx="50" cy="50" r="4"/></svg>`,
    ficha: `<svg viewBox="0 0 100 60"><circle cx="9" cy="10" r="8"/><rect x="22" y="4" width="34" height="7" rx="2"/><rect x="22" y="14" width="22" height="4" rx="2" opacity=".5"/><rect x="0" y="28" width="40" height="9" rx="2"/><g opacity=".5"><rect x="0" y="46" width="18" height="5" rx="2"/><rect x="26" y="46" width="18" height="5" rx="2"/><rect x="52" y="46" width="18" height="5" rx="2"/><rect x="78" y="46" width="18" height="5" rx="2"/></g></svg>`,
    perfil: `<svg viewBox="0 0 100 60"><rect x="0" y="2" width="50" height="7" rx="2"/><g opacity=".55"><rect x="0" y="16" width="40" height="4" rx="2"/><rect x="0" y="24" width="46" height="4" rx="2"/></g><g opacity=".35"><rect x="0" y="36" width="100" height="4" rx="2"/><rect x="0" y="44" width="94" height="4" rx="2"/><rect x="0" y="52" width="70" height="4" rx="2"/></g></svg>`,
    noticias: `<svg viewBox="0 0 100 60"><g><rect x="0" y="2" width="14" height="14" rx="3" opacity=".5"/><rect x="20" y="3" width="70" height="5" rx="2"/><rect x="20" y="11" width="50" height="4" rx="2" opacity=".5"/><rect x="0" y="24" width="14" height="14" rx="3" opacity=".5"/><rect x="20" y="25" width="76" height="5" rx="2"/><rect x="20" y="33" width="40" height="4" rx="2" opacity=".5"/><rect x="0" y="46" width="14" height="14" rx="3" opacity=".5"/><rect x="20" y="47" width="64" height="5" rx="2"/><rect x="20" y="55" width="46" height="4" rx="2" opacity=".5"/></g></svg>`,
    calendario: `<svg viewBox="0 0 100 60"><rect x="0" y="0" width="100" height="10" rx="2" opacity=".6"/><g opacity=".8"><rect x="0" y="16" width="16" height="5" rx="2"/><rect x="22" y="16" width="44" height="5" rx="2"/><rect x="80" y="16" width="20" height="5" rx="2" opacity=".5"/><rect x="0" y="30" width="16" height="5" rx="2"/><rect x="22" y="30" width="56" height="5" rx="2"/><rect x="80" y="30" width="20" height="5" rx="2" opacity=".5"/><rect x="0" y="44" width="16" height="5" rx="2"/><rect x="22" y="44" width="38" height="5" rx="2"/><rect x="80" y="44" width="20" height="5" rx="2" opacity=".5"/></g></svg>`
}

const PN_PERIODOS = [
    { valor: "dia", texto: "Hoy" },
    { valor: "semana", texto: "Semana" },
    { valor: "mes", texto: "Mes" },
    { valor: "anyo", texto: "Año" },
    { valor: "ytd", texto: "YTD" },
    { valor: "todo", texto: "Desde la compra" }
]

// Dónde satura el color del mapa en cada periodo: lo mismo que el mapa de
// calor de Activos > Mapas, por la misma razón (un día bueno son décimas, un
// año bueno un 25 %).
const PN_ESCALA = { dia: 3, semana: 6, mes: 10, anyo: 25, ytd: 25, todo: 50 }

const PN_FORMAS_MAPA = [
    { valor: "rejilla", texto: "Rejilla" },
    { valor: "treemap", texto: "Treemap" }
]

// Casillas de la rejilla del mapa: la proporción a la que se acercan y lo mínimo
// para que quepan el precio, la variación, el máximo y el mínimo y la línea. Si
// no caben todas a ese tamaño, el mapa se desplaza en vez de encogerlas.
const PN_REJILLA_ASPECTO = 1.75
const PN_REJILLA_ANCHO_MIN = 150
const PN_REJILLA_ALTO_MIN = 96
const PN_REJILLA_HUECO = 2
// A menos de esto del máximo o del mínimo del día, la cifra se resalta: el
// precio está tocando ese extremo.
const PN_REJILLA_CERCA_EXTREMO = 0.003

const PN_INTERVALOS = [
    { valor: "15", texto: "15m" },
    { valor: "60", texto: "1h" },
    { valor: "240", texto: "4h" },
    { valor: "D", texto: "1D" },
    { valor: "W", texto: "1S" },
    { valor: "M", texto: "1M" }
]

const PN_RANGOS = [
    { valor: "1M", texto: "1M" },
    { valor: "3M", texto: "3M" },
    { valor: "6M", texto: "6M" },
    { valor: "1Y", texto: "1A" },
    { valor: "YTD", texto: "YTD" },
    { valor: "ALL", texto: "Todo" }
]

const PN_TIPOS_ACTIVO = [
    { valor: "cripto", texto: "Cripto" },
    { valor: "acciones", texto: "Acciones" },
    { valor: "etfs", texto: "ETFs" },
    { valor: "comoditis", texto: "Comoditis" },
    { valor: "indices", texto: "Índices" }
]

let _pnConfig = { paneles: [], activo: "" }
let _pnDatos = null
let _pnGaleria = false
let _pnGuardarTimer = null
let _pnTemaObserver = null
const _pnCharts = new Map()
const _pnObservers = new Map()
const _pnHist = {}
const _pnTimers = new Map()

// ── Arranque y guardado ─────────────────────────────────────────────────────

async function initPanelesLogic() {
    _pnConfig = pnNormalizarConfig(window._panelesConfig)
    _pnSucio = false
    _pnDatos = null
    _pnMetricas = null
    pnOlvidarPulso()

    // Las preferencias que trajo el arranque pueden ser de otra pestaña o de
    // antes de cambiar de portfolio: se piden otra vez para no pisar nada.
    try {
        const res = await fetch("/api/settings")
        const data = await res.json()
        if (data.ok) {
            window._panelesConfig = data.panelesConfig || {}
            _pnConfig = pnNormalizarConfig(window._panelesConfig)
        }
    } catch {
        /* se sigue con lo que hubiera */
    }

    const panel = pnPanelActivo()
    _pnGaleria = !panel || !panel.widgets.length

    document.getElementById("pnNuevoBtn")?.addEventListener("click", pnNuevoPanel)
    document.getElementById("pnAjustesPanelBtn")?.addEventListener("click", () => {
        const abierta = pnVentanaAjustes("p:" + pnPanelActivo()?.id)
        if (abierta) pnCerrarAjustes(abierta)
        else pnAbrirAjustesPanel()
    })
    document.getElementById("pnCompartirBtn")?.addEventListener("click", (e) => pnMenuCompartir(e.currentTarget))
    document.getElementById("pnImportarInput")?.addEventListener("change", (e) => {
        const fichero = e.target.files?.[0]
        e.target.value = ""
        if (fichero) pnImportarFichero(fichero)
    })
    document.getElementById("pnAddWidgetBtn")?.addEventListener("click", (e) => pnMenuAnadirWidget(e.currentTarget))
    document.getElementById("pnRefreshBtn")?.addEventListener("click", async (e) => {
        const btn = e.currentTarget
        btn.disabled = true
        btn.classList.add("pnGirando")
        pnOlvidarPulso()
        pnOlvidarMetricas()
        await pnCargarDatos()
        pnRenderCuerpo()
        btn.disabled = false
        btn.classList.remove("pnGirando")
    })

    // Los paneles tapan la cabecera y la barra lateral: se sale con ✕ o Esc.
    document.body.classList.add("pnPantallaCompleta")
    document.getElementById("pnSalirBtn")?.addEventListener("click", pnSalir)
    document.addEventListener("keydown", pnTeclaSalir, true)

    window.flushPendingPageChanges = pnGuardarYa
    window._pnCleanup = pnLimpiar
    window.addEventListener("app:datos-restaurados", pnDatosRestaurados)
    window.addEventListener("resize", pnRecolocarAjustes)

    // El tema cambia sin recargar la página: los gráficos de TradingView, los
    // de Chart.js y el gris del mapa toman el color al pintarse.
    _pnTemaObserver = new MutationObserver(() => {
        pnOlvidarMetricas()
        pnRenderCuerpo()
    })
    _pnTemaObserver.observe(document.documentElement, { attributeFilter: ["data-theme"] })

    pnRenderTabs()
    pnRenderCuerpo()

    await pnCargarDatos()
    pnRenderCuerpo()
}

/** Vuelve a la página desde la que se abrieron los paneles. */
function pnSalir() {
    const anterior = window._paginaAnterior
    const destino = anterior && anterior !== "paneles" && paginaVisible(anterior) ? anterior : paginaDeInicio()
    if (!destino || destino === "paneles") return
    activarBotonNav(destino)
    loadPage(destino)
}

function pnTeclaSalir(e) {
    if (e.key !== "Escape") return
    // Esc cierra primero lo que esté abierto encima: un menú, el modal del
    // gráfico, una confirmación o un campo que se está editando. Se escucha en
    // captura para mirarlo antes de que esos mismos elementos lo cierren con
    // su propio Esc; si no, aquí ya no estarían y se saldría a la vez.
    if (
        document.getElementById("pnPop") ||
        document.getElementById("tvChartOverlay") ||
        document.querySelector("#confirmModalOverlay:not(.hidden), .modalOverlay:not(.hidden)") ||
        e.target.closest?.("input, textarea") ||
        document.querySelector(".pnArrastrado")
    ) {
        return
    }
    const delante = pnVentanasAjustes().at(-1)
    if (delante) {
        pnCerrarAjustes(delante)
        return
    }
    pnSalir()
}

/**
 * Se acaba de restaurar una copia o importar un ZIP (Ajustes): lo que hay en
 * memoria ya no es lo bueno. Se descarta sin guardarlo —guardarlo pisaría los
 * paneles recién restaurados— y se vuelve a leer todo del servidor.
 */
async function pnDatosRestaurados() {
    clearTimeout(_pnGuardarTimer)
    _pnGuardarTimer = null
    _pnSucio = false
    pnCerrarAjustes()
    pnCerrarMenu()
    try {
        const data = await (await fetch("/api/settings")).json()
        if (data.ok) window._panelesConfig = data.panelesConfig || {}
    } catch {
        /* se queda con lo que hubiera */
    }
    _pnConfig = pnNormalizarConfig(window._panelesConfig)
    _pnGaleria = !pnPanelActivo()?.widgets.length
    pnOlvidarPulso()
    pnOlvidarMetricas()
    await pnCargarDatos()
    pnRenderTabs()
    pnRenderCuerpo()
}

function pnLimpiar() {
    window.removeEventListener("app:datos-restaurados", pnDatosRestaurados)
    window.removeEventListener("resize", pnRecolocarAjustes)
    document.body.classList.remove("pnPantallaCompleta")
    document.removeEventListener("keydown", pnTeclaSalir, true)
    clearTimeout(_pnGuardarTimer)
    if (_pnGuardarTimer) pnGuardarYa()
    _pnGuardarTimer = null
    pnDestruirWidgets()
    _pnTemaObserver?.disconnect()
    _pnTemaObserver = null
    pnCerrarMenu()
    pnCerrarAjustes()
    pnOlvidarMetricas()
    document.getElementById("hmTooltip")?.remove()
}

function pnNormalizarConfig(raw) {
    const cfg = raw && typeof raw === "object" ? raw : {}
    // Un id repetido haría que dos widgets compartieran el mismo nodo: el
    // segundo no se pintaría nunca y sus cambios irían al primero. El servidor
    // ya los quita; aquí se repite por lo que no haya pasado por él.
    const unicos = (lista, clave) => {
        const vistos = new Set()
        return lista.filter((x) => {
            const id = String(x[clave])
            if (vistos.has(id)) return false
            vistos.add(id)
            return true
        })
    }
    const paneles = unicos(
        (Array.isArray(cfg.paneles) ? cfg.paneles : []).filter((p) => p && p.id),
        "id"
    ).map((p) => ({
        id: String(p.id),
        nombre: String(p.nombre || "Panel"),
        cfg: pnOpcionesPlanas(p.cfg),
        widgets: unicos(
            (Array.isArray(p.widgets) ? p.widgets : []).filter((w) => w && w.id && PN_TIPOS[w.tipo]),
            "id"
        ).map((w) => ({ id: String(w.id), tipo: w.tipo, w: w.w, h: w.h, cfg: pnOpcionesPlanas(w.cfg) }))
    }))
    const activo = paneles.some((p) => p.id === cfg.activo) ? cfg.activo : paneles[0]?.id || ""
    return { paneles, activo }
}

// Claves que no se copian nunca: asignar `cfg.__proto__` cambia el prototipo
// del objeto en vez de guardar una opción.
const PN_CLAVES_PROHIBIDAS = new Set(["__proto__", "constructor", "prototype"])

/**
 * Opciones con la forma que admite el servidor: textos, booleanos, números
 * finitos y listas de textos. Lo demás (objetos, NaN, Infinity, claves del
 * prototipo) se descarta. Sirve para lo guardado y para lo importado, que pudo
 * editar cualquiera.
 */
function pnOpcionesPlanas(origen, { listas = true } = {}) {
    const limpio = {}
    if (!origen || typeof origen !== "object" || Array.isArray(origen)) return limpio
    Object.keys(origen).forEach((k) => {
        if (PN_CLAVES_PROHIBIDAS.has(k)) return
        const v = origen[k]
        if (typeof v === "string" || typeof v === "boolean") limpio[k] = v
        else if (typeof v === "number" && Number.isFinite(v)) limpio[k] = v
        else if (listas && Array.isArray(v)) limpio[k] = v.filter((x) => typeof x === "string")
    })
    return limpio
}

function pnPanelActivo() {
    return _pnConfig.paneles.find((p) => p.id === _pnConfig.activo) || null
}

function pnNuevoId(prefijo) {
    return prefijo + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

// Hay cambios sin mandar al servidor. Al salir de la página solo se guarda si
// los hay: guardar siempre hacía que una pestaña abierta desde hace rato
// pisara, al cerrarse, lo que se había cambiado en otra o en otro dispositivo.
let _pnSucio = false
// Los guardados van en fila: dos peticiones a la vez podían llegar al servidor
// en orden distinto al que se mandaron y dejar guardada la versión vieja.
let _pnColaGuardado = Promise.resolve()

function pnGuardar() {
    _pnSucio = true
    clearTimeout(_pnGuardarTimer)
    _pnGuardarTimer = setTimeout(pnGuardarYa, 600)
}

function pnGuardarYa() {
    clearTimeout(_pnGuardarTimer)
    _pnGuardarTimer = null
    if (!_pnSucio) return _pnColaGuardado
    _pnSucio = false
    window._panelesConfig = _pnConfig
    const cuerpo = JSON.stringify({ panelesConfig: _pnConfig })
    _pnColaGuardado = _pnColaGuardado.then(async () => {
        try {
            const res = await fetch("/api/settings", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: cuerpo
            })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
        } catch (error) {
            // Queda pendiente: el siguiente cambio o la salida lo reintentan.
            _pnSucio = true
            window.showError?.("No se pudieron guardar los paneles", error)
        }
    })
    return _pnColaGuardado
}

// ── Datos ───────────────────────────────────────────────────────────────────

/**
 * Una fila por activo con lo que necesitan todos los widgets. Se calcula una
 * vez por visita (o al pulsar ↻) y la comparten los widgets de todos los
 * paneles: con diez widgets no tiene sentido pedir diez veces lo mismo.
 */
async function pnCargarDatos() {
    try {
        const lista = await loadAssetsList()
        const filas = await Promise.all(
            lista.map(async (resumen, indice) => {
                try {
                    const asset = await loadAssetData(resumen.id)
                    const row = await buildOverviewRow(asset)
                    const euros = await buildSummaryMetricsInEuros(row)
                    const dia = pnPorcentaje(resumen.change ?? asset.change)
                    const invertidoEur = euros.invertidoBrutoEur
                    const netoEur = euros.netoActualEur
                    return {
                        id: resumen.id,
                        nombre: resumen.name || resumen.symbol || resumen.id,
                        // "BTC-EUR" → "BTC": en una baldosa sobra la divisa del par.
                        simbolo: hmExtractSymbol(resumen).replace(/-(EUR|USD|USDT|USDC)$/, ""),
                        tipo: String(resumen.type || "acciones").toLowerCase(),
                        currency: normalizeCurrencyCode(resumen.currency || "EUR"),
                        precio: row.valorActual,
                        dia,
                        participaciones: row.participaciones,
                        precioMedio: row.promedioCompra,
                        invertidoEur,
                        netoEur,
                        rendEur: euros.rendimientoEur,
                        rendPct: invertidoEur > 0 ? (euros.rendimientoEur / invertidoEur) * 100 : null,
                        hoyEur: hmMovimiento(netoEur, dia),
                        color: resumen.color || "",
                        oculto: !!resumen.hidden,
                        orden: resumen.order ?? indice,
                        conPosicion: row.participaciones > 0 && netoEur > 0.01,
                        tv: buildTVSymbol(resumen)
                    }
                } catch (error) {
                    console.error("Paneles: no se pudo calcular", resumen.id, error)
                    return null
                }
            })
        )
        const activos = filas.filter(Boolean).sort((a, b) => a.orden - b.orden)
        _pnDatos = { activos, porId: new Map(activos.map((a) => [a.id, a])) }
    } catch (error) {
        console.error("Paneles: error cargando la cartera", error)
        _pnDatos = { activos: [], porId: new Map(), error: true }
    }
}

function pnPorcentaje(texto) {
    let limpio = String(texto ?? "")
        .replace(/%/g, "")
        .replace(/\u2212/g, "-")
        .replace(/\s+/g, "")
    // «1.234,56» (español) → «1234.56»; «1234.56» se queda como está.
    if (limpio.includes(",")) limpio = limpio.replace(/\./g, "").replace(",", ".")
    if (!limpio) return null
    const n = parseFloat(limpio)
    return Number.isFinite(n) ? n : null
}

/** Lo que el usuario sigue en Activos > Watchlist sin tenerlo en la cartera. */
function pnActivosWatchlist() {
    const lista = typeof segLoadCustomItems === "function" ? segLoadCustomItems() : []
    // Las entradas con `assetId` apuntan a un activo del portfolio, que ya sale como tal.
    return (Array.isArray(lista) ? lista : [])
        .filter((item) => item && item._segId && !item.assetId)
        .map((item) => ({
            id: "wl:" + item._segId,
            // La lista guardada usa los campos en español (`nombre`, `tipo`; ver
            // segMergeAndRender en seguimiento.js); los ingleses quedan por si llega ya convertida.
            nombre: item.nombre || item.name || item.symbol || item.ticker || "",
            simbolo: String(item.symbol || item.ticker || item.nombre || item.name || "").toUpperCase(),
            tipo: String(item.tipo || item.type || "acciones").toLowerCase(),
            currency: normalizeCurrencyCode(item.currency || "EUR"),
            precio: parseLooseNumber(item.price) || 0,
            dia: pnPorcentaje(item.change),
            netoEur: 0,
            invertidoEur: 0,
            conPosicion: false,
            watchlist: true,
            tv: buildTVSymbol({
                tvSymbol: item.tvSymbol,
                marketSymbol: item.ticker || item.marketSymbol,
                marketProvider: item.marketProvider,
                symbol: item.symbol,
                name: item.name
            })
        }))
}

function pnTodosLosActivos() {
    return [...(_pnDatos?.activos || []), ...pnActivosWatchlist()]
}

function pnBuscarActivo(id) {
    if (!id) return null
    if (String(id).startsWith("tk|")) return pnTickerDesdeId(id)
    if (String(id).startsWith("tv:")) {
        const sym = String(id).slice(3)
        return { id, nombre: sym, simbolo: sym, tv: sym }
    }
    return _pnDatos?.porId.get(id) || pnActivosWatchlist().find((a) => a.id === id) || null
}

// ── Tickers sueltos ─────────────────────────────────────────────────────────
//
// Cualquier símbolo de TradingView se puede meter en un widget aunque no esté
// en la cartera ni en la watchlist. El id lleva todo lo necesario para
// pintarlo sin consultar nada más —«tk|EXCHANGE:SIMBOLO|Nombre|tipo»—, así que
// cabe en las listas planas que guarda el servidor y viaja tal cual al
// exportar un panel. El precio se pide aparte (/api/market/quote, proveedor
// TradingView) y se guarda unos minutos.

const PN_COTIZ_TTL = 5 * 60 * 1000
const _pnCotiz = new Map()

// Los tipos de TradingView, en los de la aplicación (colores, filtros). Lo que
// no encaja en ninguno (índices, divisas, bonos…) queda como «otros».
const PN_TIPO_TV = {
    stock: "acciones",
    fund: "etfs",
    etf: "etfs",
    crypto: "cripto",
    commodity: "comoditis",
    futures: "comoditis",
    index: "indices"
}

function pnIdTicker(resultado) {
    const limpio = (v, n) =>
        String(v || "")
            .replace(/\|/g, " ")
            .trim()
            .slice(0, n)
    const simbolo = limpio(resultado.symbol, 40).toUpperCase()
    return ["tk", simbolo, limpio(resultado.description || simbolo, 50), PN_TIPO_TV[resultado.type] || "otros"].join(
        "|"
    )
}

function pnTickerDesdeId(id) {
    const [, simbolo, nombre, tipo] = String(id).split("|")
    if (!simbolo) return null
    pnAsegurarCotizacion(simbolo)
    const c = _pnCotiz.get(simbolo) || {}
    return {
        id,
        nombre: nombre || simbolo,
        simbolo: simbolo.split(":").pop(),
        tipo: tipo || "otros",
        currency: normalizeCurrencyCode(c.currency || "USD"),
        precio: c.precio || 0,
        dia: Number.isFinite(c.dia) ? c.dia : null,
        netoEur: 0,
        invertidoEur: 0,
        conPosicion: false,
        ticker: true,
        tv: simbolo
    }
}

function pnAsegurarCotizacion(simbolo) {
    const c = _pnCotiz.get(simbolo)
    if (c && (c.cargando || Date.now() - c.ts < PN_COTIZ_TTL)) return
    _pnCotiz.set(simbolo, { ...(c || {}), cargando: true, ts: Date.now() })
    fetch(`/api/market/quote?${new URLSearchParams({ symbol: simbolo, provider: "tradingview" })}`)
        .then((r) => r.json())
        .then((d) => {
            const precio = typeof d.price === "number" ? d.price : parseLooseNumber(d.price)
            _pnCotiz.set(
                simbolo,
                d.ok
                    ? {
                          precio: precio || 0,
                          dia: pnPorcentaje(d.change),
                          currency: d.currency || "USD",
                          ts: Date.now()
                      }
                    : { error: true, ts: Date.now() }
            )
        })
        .catch(() => _pnCotiz.set(simbolo, { error: true, ts: Date.now() }))
        .finally(pnRefrescarTickers)
}

/**
 * Repinta los widgets que enseñan precios de tickers sueltos cuando llega una
 * cotización. Los de TradingView no: no usan este precio y recargarlos
 * reiniciaría el iframe.
 */
function pnRefrescarTickers() {
    clearTimeout(_pnTimers.get("tickers"))
    _pnTimers.set(
        "tickers",
        setTimeout(() => {
            const conPrecios = ["mapa", "mapaMercado", "favoritos"]
            ;(pnPanelActivo()?.widgets || [])
                .filter(
                    (w) => conPrecios.includes(w.tipo) && pnLista(w.cfg, "activos").some((id) => id.startsWith("tk|"))
                )
                .forEach((w) => pnPintarWidget(w))
        }, 200)
    )
}

/** Busca símbolos en TradingView; cada resultado lleva ya su id de ticker. */
async function pnBuscarTickers(q) {
    try {
        const res = await fetch(`/api/tradingview/search?${new URLSearchParams({ q })}`)
        const data = await res.json()
        return (data.results || []).slice(0, 12).map((r) => ({
            id: pnIdTicker(r),
            nombre: r.description || r.symbol,
            simbolo: r.symbol,
            tipo: PN_TIPO_TV[r.type] || "otros",
            exchange: r.exchange || ""
        }))
    } catch (error) {
        console.error("Paneles: búsqueda de tickers", error)
        return null
    }
}

/** Las posiciones abiertas que se ven en la cartera (sin los ocultos). */
function pnPosiciones() {
    return (_pnDatos?.activos || []).filter((a) => a.conPosicion && !a.oculto)
}

async function pnHistorico(periodo) {
    const guardado = _pnHist[periodo]
    if (guardado && Date.now() - guardado.ts < 4 * 3600 * 1000) return guardado.data
    try {
        const res = await fetch(`/api/historical-changes?period=${encodeURIComponent(periodo)}`)
        const json = await res.json()
        if (json.ok) {
            _pnHist[periodo] = { data: json.data || {}, ts: Date.now() }
            return _pnHist[periodo].data
        }
    } catch (error) {
        console.error("Paneles: histórico", error)
    }
    return {}
}

// ── Formato ─────────────────────────────────────────────────────────────────

function pnEur(v) {
    return formatMoney(v || 0, "EUR")
}

function pnEurFirmado(v) {
    return (v > 0 ? "+" : v < 0 ? "−" : "") + formatMoney(Math.abs(v || 0), "EUR")
}

function pnPct(v, conSigno = true) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—"
    // Lo que con dos decimales es cero se escribe sin signo: «−0,00 %» no dice
    // nada y además salía en rojo.
    if (Math.abs(v) < 0.005) v = 0
    const signo = conSigno ? (v > 0 ? "+" : v < 0 ? "−" : "") : ""
    return (
        signo +
        new Intl.NumberFormat(_nl(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Math.abs(v)) +
        " %"
    )
}

function pnClaseSigno(v) {
    if (v === null || v === undefined || !Number.isFinite(v) || Math.abs(v) < 0.005) return ""
    return v > 0 ? "pnPos" : "pnNeg"
}

function pnPrecio(activo) {
    if (!activo || !(activo.precio > 0)) return "—"
    return hmFormatPrice(activo.precio, activo.currency)
}

function pnColorTipo(tipo) {
    return (typeof M_TYPE_COLORS !== "undefined" && M_TYPE_COLORS[tipo]) || "#64748b"
}

function pnColorActivo(activo) {
    if (activo.color) return activo.color
    if (typeof mPaletteForName === "function") return mPaletteForName(activo.nombre || activo.id)
    return pnColorTipo(activo.tipo)
}

function pnVarCss(nombre, defecto) {
    return getComputedStyle(document.documentElement).getPropertyValue(nombre).trim() || defecto
}

// ── Pestañas ────────────────────────────────────────────────────────────────

function pnRenderTabs() {
    const cont = document.getElementById("pnTabs")
    if (!cont) return
    cont.innerHTML = _pnConfig.paneles
        .map(
            (p) => `
            <div class="pnTab${p.id === _pnConfig.activo ? " active" : ""}" data-panel="${escapeAttr(p.id)}" title="Doble clic para renombrar">
                <span class="pnTabNombre">${escapeHtml(p.nombre)}</span>
                <button class="pnTabCerrar" type="button" title="Borrar panel" aria-label="Borrar panel">${iconoHtml("Cerrar")}</button>
            </div>`
        )
        .join("")

    if (cont.dataset.bound) return
    cont.dataset.bound = "true"

    cont.addEventListener("click", (e) => {
        const tab = e.target.closest(".pnTab")
        if (!tab) return
        if (e.target.closest(".pnTabCerrar")) {
            pnBorrarPanel(tab.dataset.panel)
            return
        }
        if (tab.dataset.panel === _pnConfig.activo || tab.querySelector("input")) return
        _pnConfig.activo = tab.dataset.panel
        _pnGaleria = !pnPanelActivo()?.widgets.length
        pnGuardar()
        pnRenderTabs()
        pnRenderCuerpo()
    })

    cont.addEventListener("dblclick", (e) => {
        const tab = e.target.closest(".pnTab")
        if (tab && !e.target.closest(".pnTabCerrar")) pnRenombrarPanel(tab)
    })
}

function pnRenombrarPanel(tab) {
    const panel = _pnConfig.paneles.find((p) => p.id === tab.dataset.panel)
    const span = tab.querySelector(".pnTabNombre")
    if (!panel || !span || tab.querySelector("input")) return

    const input = document.createElement("input")
    input.className = "pnTabInput"
    input.value = panel.nombre
    input.maxLength = 60
    span.replaceWith(input)
    input.focus()
    input.select()

    let hecho = false
    const terminar = (guardar) => {
        if (hecho) return
        hecho = true
        const nombre = input.value.trim()
        if (guardar && nombre && nombre !== panel.nombre) {
            panel.nombre = nombre
            pnGuardar()
        }
        pnRenderTabs()
    }
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") terminar(true)
        if (e.key === "Escape") terminar(false)
    })
    input.addEventListener("blur", () => terminar(true))
}

// Los topes del servidor (python/stores/paneles_config.py). Pasarlos no da
// error: el servidor descarta lo que sobra al guardar y el widget o el panel de
// más desaparecía al recargar sin decir nada. Se avisa antes.
const PN_MAX_PANELES = 20
const PN_MAX_WIDGETS = 24

function pnCabeWidget(panel) {
    if (panel.widgets.length < PN_MAX_WIDGETS) return true
    window.showToast?.(`Un panel admite hasta ${PN_MAX_WIDGETS} widgets`, { type: "warning" })
    return false
}

function pnNuevoPanel() {
    if (_pnConfig.paneles.length >= PN_MAX_PANELES) {
        window.showToast?.(`Ya tienes ${PN_MAX_PANELES} paneles: borra alguno para crear otro`, { type: "warning" })
        return
    }
    const panel = { id: pnNuevoId("p"), nombre: "Nuevo panel", widgets: [] }
    _pnConfig.paneles.push(panel)
    _pnConfig.activo = panel.id
    _pnGaleria = true
    pnGuardar()
    pnRenderTabs()
    pnRenderCuerpo()
}

function pnBorrarPanel(id) {
    const panel = _pnConfig.paneles.find((p) => p.id === id)
    if (!panel) return

    const borrar = () => {
        const indice = _pnConfig.paneles.indexOf(panel)
        _pnConfig.paneles.splice(indice, 1)
        if (_pnConfig.activo === id) {
            _pnConfig.activo = (_pnConfig.paneles[indice] || _pnConfig.paneles[indice - 1])?.id || ""
        }
        _pnGaleria = !pnPanelActivo()?.widgets.length
        pnGuardar()
        pnRenderTabs()
        pnRenderCuerpo()
    }

    // Un panel vacío se borra sin preguntar: no hay nada que perder.
    if (!panel.widgets.length) {
        borrar()
        return
    }
    openConfirmModal({
        title: "Borrar panel",
        message: `Vas a borrar el panel "${panel.nombre}" y sus ${panel.widgets.length} widgets. Tus datos no se tocan.`,
        confirmLabel: "Borrar",
        confirmSide: "right",
        onConfirm: borrar
    })
}

// ── Cuerpo: galería o panel ─────────────────────────────────────────────────

function pnRenderCuerpo() {
    const cuerpo = document.getElementById("pnBody")
    if (!cuerpo) return
    pnDestruirWidgets()
    pnCerrarMenu()

    const panel = pnPanelActivo()
    document.getElementById("pnAddWidgetBtn")?.classList.toggle("hidden", _pnGaleria || !panel)
    document.getElementById("pnAjustesPanelBtn")?.classList.toggle("hidden", _pnGaleria || !panel)

    if (_pnGaleria || !panel) {
        pnRenderGaleria(cuerpo)
        pnSincronizarAjustes()
        return
    }

    cuerpo.innerHTML = `<div class="pnGrid" id="pnGrid"></div>`
    const grid = cuerpo.querySelector(".pnGrid")
    pnAplicarRejilla(grid, panel)
    panel.widgets.forEach((w) => grid.appendChild(pnCrearWidget(w)))
    panel.widgets.forEach((w) => pnPintarWidget(w))
    pnSincronizarAjustes()
}

function pnRenderGaleria(cuerpo) {
    // Las filas de la miniatura se reparten el alto de la tarjeta: con un alto
    // fijo por fila, las plantillas altas se salían por abajo y sus widgets
    // salían cortados. Las plantillas llenan sus filas (los anchos suman 12),
    // así que el número de filas es el área entre las 12 columnas.
    const miniatura = (widgets) =>
        `<div class="pnMini" style="grid-template-rows: repeat(${Math.ceil(
            widgets.reduce((s, [, w, h]) => s + w * h, 0) / PN_COLUMNAS
        )}, minmax(0, 1fr))">${widgets
            .map(
                ([tipo, w, h]) => `
                <div class="pnMiniW" style="grid-column: span ${w}; grid-row: span ${h}">
                    <span class="pnMiniTitulo">${escapeHtml(PN_TIPOS[tipo].nombre)}</span>
                    <span class="pnMiniIcono">${PN_ICONOS[tipo]}</span>
                </div>`
            )
            .join("")}</div>`

    const vacia = `<div class="pnMini pnMiniVacia"><span>+</span></div>`

    cuerpo.innerHTML = `
        <div class="pnGaleria">
            <h3 class="pnGaleriaTitulo">Plantillas</h3>
            <div class="pnPlantillas">
                ${PN_PLANTILLAS.map(
                    (p) => `
                    <button class="pnPlantilla" type="button" data-plantilla="${p.id}">
                        ${p.widgets.length ? miniatura(p.widgets) : vacia}
                        <span class="pnPlantillaNombre">${escapeHtml(p.nombre)}</span>
                        <span class="pnPlantillaDesc">${escapeHtml(p.desc)}</span>
                    </button>`
                ).join("")}
                <button class="pnPlantilla" type="button" data-plantilla="importar">
                    <div class="pnMini pnMiniVacia"><span>⇩</span></div>
                    <span class="pnPlantillaNombre">Importar</span>
                    <span class="pnPlantillaDesc">Abre un panel que te hayan pasado: se monta con tus activos.</span>
                </button>
            </div>

            <h3 class="pnGaleriaTitulo">Iniciar panel personalizado</h3>
            <div class="pnCatalogo">
                ${Object.entries(PN_TIPOS)
                    .map(
                        ([tipo, t]) => `
                    <button class="pnCatalogoItem" type="button" data-tipo="${tipo}" title="${escapeAttr(t.desc)}">
                        <span class="pnMiniTitulo">${escapeHtml(t.nombre)}</span>
                        <span class="pnMiniIcono">${PN_ICONOS[tipo]}</span>
                    </button>`
                    )
                    .join("")}
            </div>
        </div>`

    cuerpo.querySelector(".pnPlantillas").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-plantilla]")
        if (btn?.dataset.plantilla === "importar") document.getElementById("pnImportarInput")?.click()
        else if (btn) pnAplicarPlantilla(PN_PLANTILLAS.find((p) => p.id === btn.dataset.plantilla))
    })
    cuerpo.querySelector(".pnCatalogo").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-tipo]")
        if (btn) pnAnadirWidget(btn.dataset.tipo)
    })
}
