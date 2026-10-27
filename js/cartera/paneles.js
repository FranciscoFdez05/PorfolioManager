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
    { valor: "comoditis", texto: "Comoditis" }
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
    const destino = anterior && anterior !== "paneles" && paginaVisible(anterior) ? anterior : primeraPaginaVisible()
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
    return (Array.isArray(lista) ? lista : [])
        .filter((item) => item && item._segId)
        .map((item) => ({
            id: "wl:" + item._segId,
            nombre: item.name || item.symbol || item.ticker || "",
            simbolo: String(item.symbol || item.ticker || item.name || "").toUpperCase(),
            tipo: String(item.type || "acciones").toLowerCase(),
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
    futures: "comoditis"
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

// ── Exportar e importar ─────────────────────────────────────────────────────
//
// Un panel exportado tiene que servirle a otra persona con *sus* datos, así
// que el fichero no lleva ids de activos (son de esta instalación: el
// «bitcoin» de uno puede ser el «btc» de otro) ni ningún importe. Cada activo
// que nombra un widget va como referencia —símbolo de TradingView, ticker y
// nombre— y al importar se busca entre los activos de quien importa. Lo que
// no tenga se queda fuera de su mapa o sus favoritos; el gráfico, en cambio,
// abre igualmente el mismo símbolo de TradingView, que no depende de la cartera.

const PN_FORMATO_EXPORT = "porfoliomanager-paneles"

function pnMenuCompartir(anchor) {
    const panel = pnPanelActivo()
    const items = []
    if (panel?.widgets.length) items.push({ valor: "uno", texto: `Exportar «${panel.nombre}»` })
    if (_pnConfig.paneles.some((p) => p.widgets.length))
        items.push({ valor: "todos", texto: "Exportar todos los paneles" })
    if (items.length) items.push({ separador: true })
    items.push({ valor: "importar", texto: "Importar paneles desde un fichero…" })

    pnMenu(
        anchor,
        items,
        (accion) => {
            if (accion === "importar") document.getElementById("pnImportarInput")?.click()
            else pnExportar(accion === "uno" ? [panel] : _pnConfig.paneles.filter((p) => p.widgets.length))
        },
        { alinear: "derecha" }
    )
}

function pnRefPortable(id) {
    const a = pnBuscarActivo(id)
    if (!a) return null
    const ref = { tv: a.tv || "", simbolo: a.simbolo || "", nombre: a.nombre || "" }
    // Un ticker suelto no depende de la cartera de nadie: viaja tal cual.
    if (String(id).startsWith("tk|")) ref.ticker = id
    return ref
}

function pnCfgExportable(w) {
    const cfg = { ...w.cfg }
    if (cfg.activo) {
        const ref = pnRefPortable(cfg.activo)
        if (ref) cfg.activo = ref
        else delete cfg.activo
    }
    if (Array.isArray(cfg.activos)) cfg.activos = cfg.activos.map(pnRefPortable).filter(Boolean)
    return cfg
}

function pnExportar(paneles) {
    if (!paneles.length) return
    const datos = {
        formato: PN_FORMATO_EXPORT,
        version: 1,
        exportado: new Date().toISOString(),
        paneles: paneles.map((p) => ({
            nombre: p.nombre,
            cfg: { ...(p.cfg || {}) },
            widgets: p.widgets.map((w) => ({ tipo: w.tipo, w: w.w, h: w.h, cfg: pnCfgExportable(w) }))
        }))
    }
    const base = paneles.length === 1 ? paneles[0].nombre : "paneles"
    const slug =
        base
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "panel"
    const blob = new Blob([JSON.stringify(datos, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const enlace = document.createElement("a")
    enlace.href = url
    enlace.download = `${paneles.length === 1 ? "panel-" : ""}${slug}.json`
    document.body.appendChild(enlace)
    enlace.click()
    enlace.remove()
    URL.revokeObjectURL(url)
    window.showToast?.(
        paneles.length === 1 ? `Panel «${paneles[0].nombre}» exportado` : `${paneles.length} paneles exportados`,
        { type: "success" }
    )
}

/**
 * El activo de quien importa que corresponde a una referencia exportada: por
 * símbolo de TradingView, si no por ticker y si no por nombre. Con el texto
 * normalizado (mayúsculas, sin espacios) para no fallar por un detalle.
 */
function pnResolverRef(ref, candidatos) {
    if (!ref || typeof ref !== "object") return null
    const norma = (v) =>
        String(v || "")
            .toUpperCase()
            .replace(/\s+/g, "")
    for (const campo of ["tv", "simbolo", "nombre"]) {
        const buscado = norma(ref[campo])
        if (!buscado) continue
        const hallado = candidatos.find((a) => norma(a[campo]) === buscado)
        if (hallado) return hallado.id
    }
    // Sin equivalente en la cartera, el ticker suelto (si lo era).
    if (typeof ref.ticker === "string" && ref.ticker.startsWith("tk|")) return ref.ticker.slice(0, 120)
    return null
}

/** Un tamaño importado: un número finito o 0 (que luego cae al de fábrica). */
function pnEnteroFinito(v) {
    const n = Number(v)
    return Number.isFinite(n) ? Math.round(n) : 0
}

/** Un panel del fichero, con ids nuevos y los activos de quien importa. */
function pnPanelImportado(p, candidatos, cuenta) {
    const widgets = p.widgets
        .filter((w) => w && PN_TIPOS[w.tipo])
        .slice(0, 24)
        .map((w) => {
            const origen = w.cfg && typeof w.cfg === "object" ? w.cfg : {}
            // Solo opciones planas, como las que admite el servidor. Los activos
            // se resuelven aparte, contra la cartera de quien importa.
            const cfg = pnOpcionesPlanas(origen)
            delete cfg.activos
            if (origen.activo && typeof origen.activo === "object") {
                cuenta.referencias++
                const id = pnResolverRef(origen.activo, candidatos)
                if (id) {
                    cuenta.encontradas++
                    cfg.activo = id
                } else if (origen.activo.tv) {
                    // Sin el activo en la cartera, el mismo símbolo de TradingView.
                    cfg.activo = "tv:" + String(origen.activo.tv).slice(0, 100)
                }
            }
            if (Array.isArray(origen.activos)) {
                const ids = []
                origen.activos.forEach((ref) => {
                    cuenta.referencias++
                    const id = pnResolverRef(ref, candidatos)
                    if (id && !ids.includes(id)) {
                        cuenta.encontradas++
                        ids.push(id)
                    }
                })
                cfg.activos = ids
            }
            return { id: pnNuevoId("w"), tipo: w.tipo, w: pnEnteroFinito(w.w), h: pnEnteroFinito(w.h), cfg }
        })
    const cfg = pnOpcionesPlanas(p.cfg, { listas: false })
    return { id: pnNuevoId("p"), nombre: String(p.nombre || "Panel importado").slice(0, 60), cfg, widgets }
}

async function pnImportarFichero(fichero) {
    if (fichero.size > 1024 * 1024) {
        window.showToast?.("El fichero es demasiado grande para ser un panel exportado", { type: "error" })
        return
    }
    let datos
    try {
        datos = JSON.parse(await fichero.text())
    } catch {
        window.showToast?.("El fichero no es un JSON válido", { type: "error" })
        return
    }
    if (datos?.formato !== PN_FORMATO_EXPORT || !Array.isArray(datos.paneles)) {
        window.showToast?.("Este fichero no es un panel exportado desde Paneles", { type: "error" })
        return
    }

    if (!_pnDatos) await pnCargarDatos()
    const candidatos = pnTodosLosActivos()
    const cuenta = { referencias: 0, encontradas: 0 }
    const importados = datos.paneles
        .filter((p) => p && Array.isArray(p.widgets))
        .map((p) => pnPanelImportado(p, candidatos, cuenta))
        .filter((p) => p.widgets.length)

    if (!importados.length) {
        window.showToast?.("El fichero no trae ningún panel con widgets", { type: "warning" })
        return
    }

    // Si se importa desde la galería de un panel recién creado y vacío, el
    // importado ocupa su sitio en vez de dejar una pestaña vacía detrás.
    const actual = pnPanelActivo()
    if (actual && !actual.widgets.length) _pnConfig.paneles.splice(_pnConfig.paneles.indexOf(actual), 1)

    const entran = importados.slice(0, Math.max(0, 20 - _pnConfig.paneles.length))
    if (!entran.length) {
        window.showToast?.("Ya tienes 20 paneles: borra alguno para importar", { type: "warning" })
        pnRenderTabs()
        return
    }
    const nombres = new Set(_pnConfig.paneles.map((p) => p.nombre))
    entran.forEach((p) => {
        if (nombres.has(p.nombre)) p.nombre = `${p.nombre} (importado)`.slice(0, 60)
        nombres.add(p.nombre)
    })
    _pnConfig.paneles.push(...entran)
    _pnConfig.activo = entran[0].id
    _pnGaleria = false
    pnGuardar()
    pnRenderTabs()
    pnRenderCuerpo()

    const partes = [
        entran.length === 1 ? `Panel «${entran[0].nombre}» importado` : `${entran.length} paneles importados`
    ]
    if (cuenta.referencias)
        partes.push(`${cuenta.encontradas} de ${cuenta.referencias} activos encontrados en tu cartera`)
    if (entran.length < importados.length) partes.push(`${importados.length - entran.length} no caben (máximo 20)`)
    window.showToast?.(partes.join(" · "), {
        type: cuenta.encontradas < cuenta.referencias ? "warning" : "success",
        duration: 7000
    })
}

/** El panel activo (o uno nuevo si no hay) para meterle widgets. */
function pnPanelParaEditar(nombre) {
    let panel = pnPanelActivo()
    if (!panel) {
        panel = { id: pnNuevoId("p"), nombre: nombre || "Mi panel", widgets: [] }
        _pnConfig.paneles.push(panel)
        _pnConfig.activo = panel.id
    }
    return panel
}

function pnAplicarPlantilla(plantilla) {
    if (!plantilla) return
    const panel = pnPanelParaEditar(plantilla.nombre)
    if (panel.nombre === "Nuevo panel" && plantilla.widgets.length) panel.nombre = plantilla.nombre
    panel.widgets = plantilla.widgets.map(([tipo, w, h, cfg]) => ({
        id: pnNuevoId("w"),
        tipo,
        w,
        h,
        cfg: { ...(cfg || {}) }
    }))
    _pnGaleria = false
    pnGuardar()
    pnRenderTabs()
    pnRenderCuerpo()
}

function pnAnadirWidget(tipo) {
    const t = PN_TIPOS[tipo]
    if (!t) return
    const panel = pnPanelParaEditar(t.nombre)
    if (!pnCabeWidget(panel)) return
    const widget = { id: pnNuevoId("w"), tipo, w: t.w, h: t.h, cfg: {} }
    panel.widgets.push(widget)
    pnGuardar()
    pnRenderTabs()
    // Con el panel ya en pantalla se añade solo el nuevo: repintarlo entero
    // recargaría los gráficos de TradingView que ya estaban.
    const grid = document.getElementById("pnGrid")
    if (grid && !_pnGaleria) {
        grid.appendChild(pnCrearWidget(widget))
        pnPintarWidget(widget)
    } else {
        _pnGaleria = false
        pnRenderCuerpo()
    }
    document
        .querySelector(`.pnWidget[data-widget="${widget.id}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" })
}

function pnMenuAnadirWidget(anchor) {
    const items = []
    Object.entries(PN_GRUPOS).forEach(([grupo, titulo]) => {
        items.push({ cabecera: titulo })
        Object.entries(PN_TIPOS)
            .filter(([, t]) => t.grupo === grupo)
            .forEach(([tipo, t]) =>
                items.push({
                    valor: tipo,
                    html: `<span class="pnMenuIcono">${PN_ICONOS[tipo]}</span><span class="pnMenuTexto"><b>${escapeHtml(t.nombre)}</b><small>${escapeHtml(t.desc)}</small></span>`
                })
            )
    })
    pnMenu(anchor, items, pnAnadirWidget, { ancho: 300, alinear: "derecha" })
}

// ── Widgets: estructura común ───────────────────────────────────────────────

function pnCrearWidget(w) {
    const t = PN_TIPOS[w.tipo]
    const el = document.createElement("article")
    el.className = `pnWidget pnW-${w.tipo}`
    el.dataset.widget = w.id
    pnAplicarTamano(el, w)

    const enlace = PN_TIPOS[w.tipo].enlazable
        ? `<button class="pnEnlace${w.cfg.vincular === false ? "" : " on"}" type="button" title="${
              w.cfg.vincular === false
                  ? "Sin enlazar: los clics en otros widgets no cambian este gráfico"
                  : "Enlazado: al pulsar un activo en otro widget del panel se abre aquí"
          }"></button>`
        : ""

    el.innerHTML = `
        <header class="pnWHead">
            ${enlace}
            <span class="pnWTitulo">${escapeHtml(w.cfg.titulo || t.nombre)}</span>
            <div class="pnWCtrls"></div>
            <button class="pnAsa" type="button" title="Arrastrar para reordenar" aria-label="Arrastrar para reordenar">${PN_ASA_SVG}</button>
            <button class="pnWMenuBtn pnWAjustesBtn" type="button" title="Ajustes del widget" aria-label="Ajustes del widget">${iconoHtml("Ajustes")}</button>
            <button class="pnWMenuBtn" type="button" title="Opciones del widget" aria-label="Opciones del widget">${iconoHtml("Opciones")}</button>
        </header>
        <div class="pnWBody"></div>
        <div class="pnResize" title="Arrastra para cambiar el tamaño"></div>`

    el.querySelector(".pnWMenuBtn:not(.pnWAjustesBtn)").addEventListener("click", (e) =>
        pnMenuWidget(e.currentTarget, w)
    )
    el.querySelector(".pnWAjustesBtn").addEventListener("click", () => pnAbrirAjustes(w))
    el.querySelector(".pnEnlace")?.addEventListener("click", (e) => {
        if (w.cfg.vincular === false) delete w.cfg.vincular
        else w.cfg.vincular = false
        const on = w.cfg.vincular !== false
        e.currentTarget.classList.toggle("on", on)
        e.currentTarget.title = on
            ? "Enlazado: al pulsar un activo en otro widget del panel se abre aquí"
            : "Sin enlazar: los clics en otros widgets no cambian este gráfico"
        pnGuardar()
    })
    pnBindArrastre(el)
    pnBindRedimension(el, w)
    return el
}

function pnAplicarTamano(el, w) {
    const t = PN_TIPOS[w.tipo]
    w.w = Math.max(t.minW, Math.min(PN_COLUMNAS, Math.round(w.w) || t.w))
    w.h = Math.max(t.minH, Math.min(PN_ALTO_MAX, Math.round(w.h) || t.h))
    el.style.gridColumn = `span ${w.w}`
    el.style.gridRow = `span ${w.h}`
    // En móvil la rejilla es de una columna; el alto se conserva.
    el.style.setProperty("--pn-h", w.h)
}

function pnWidgetEl(w) {
    return document.querySelector(`.pnWidget[data-widget="${CSS.escape(w.id)}"]`)
}

// Cada pintada de un widget le da un turno nuevo. Lo que se pinta cuando llega
// una respuesta (historial, sentimiento, métricas, TradingView) comprueba que
// su turno sigue siendo el último: si no, el usuario ya cambió de rango o de
// universo y esa respuesta tardía pisaría la buena (pasaba al pulsar rápido).
const _pnTurnos = new Map()

function pnTurno(w) {
    return _pnTurnos.get(w.id) || 0
}

function pnVigente(w, turno) {
    return _pnTurnos.get(w.id) === turno && !!pnWidgetEl(w)
}

function pnPintarWidget(w) {
    const el = pnWidgetEl(w)
    if (!el) return
    _pnTurnos.set(w.id, pnTurno(w) + 1)
    const cuerpo = el.querySelector(".pnWBody")
    const ctrls = el.querySelector(".pnWCtrls")

    pnDestruirChart(w.id)

    // Las notas no dependen de la cartera; el resto espera a los datos. El
    // gráfico también: su activo se busca entre ellos, y pintarlo antes haría
    // que el iframe de TradingView se cargara dos veces.
    if (!_pnDatos && w.tipo !== "notas") {
        ctrls.innerHTML = ""
        cuerpo.innerHTML = `<div class="pnVacio">Cargando…</div>`
        return
    }

    const pintores = {
        mapa: pnPintarMapa,
        mapaMercado: pnPintarMapa,
        grafico: pnPintarGrafico,
        instrumento: pnPintarEmbebido,
        tecnico: pnPintarEmbebido,
        ficha: pnPintarEmbebido,
        perfil: pnPintarEmbebido,
        noticias: pnPintarEmbebido,
        calendario: pnPintarEmbebido,
        metrica: pnPintarMetrica,
        miedoCodicia: pnPintarMiedoCodicia,
        amplitud: pnPintarAmplitud,
        indices: pnPintarIndices,
        sectores: pnPintarSectores,
        escaner: pnPintarEscaner,
        cartera: pnPintarCartera,
        favoritos: pnPintarFavoritos,
        rendimiento: pnPintarRendimiento,
        distribucion: pnPintarDistribucion,
        resumen: pnPintarResumen,
        notas: pnPintarNotas
    }
    try {
        pintores[w.tipo](w, cuerpo, ctrls)
    } catch (error) {
        console.error("Paneles: error pintando", w.tipo, error)
        cuerpo.innerHTML = `<div class="pnVacio">No se pudo pintar este widget</div>`
    }
    pnRefrescarCabeceraAjustes(w)
}

/** Si el widget tiene sus ajustes abiertos, su sección «Cabecera» se pone al día. */
function pnRefrescarCabeceraAjustes(w) {
    pnVentanaAjustes("w:" + w.id)?._pintarCabecera?.()
}

function pnDestruirChart(id) {
    _pnCharts.get(id)?.destroy()
    _pnCharts.delete(id)
    _pnObservers.get(id)?.disconnect()
    _pnObservers.delete(id)
}

function pnDestruirWidgets() {
    ;[..._pnCharts.keys(), ..._pnObservers.keys()].forEach(pnDestruirChart)
    _pnTimers.forEach(clearTimeout)
    _pnTimers.clear()
}

/** Vuelve a pintar el widget cuando cambia de tamaño (mapa, sobre todo). */
function pnObservarTamano(w, cuerpo, pintar) {
    let timer = null
    let ultimo = ""
    const obs = new ResizeObserver(() => {
        const medida = `${cuerpo.clientWidth}x${cuerpo.clientHeight}`
        if (medida === ultimo) return
        ultimo = medida
        clearTimeout(timer)
        timer = setTimeout(pintar, 60)
    })
    obs.observe(cuerpo)
    _pnObservers.set(w.id, obs)
}

function pnMenuWidget(anchor, w) {
    pnMenu(
        anchor,
        [
            { valor: "ajustes", texto: "Ajustes…" },
            { valor: "renombrar", texto: "Renombrar" },
            { valor: "duplicar", texto: "Duplicar" },
            { valor: "ancho", texto: w.w === PN_COLUMNAS ? "Ancho original" : "Ocupar todo el ancho" },
            { valor: "eliminar", texto: "Quitar del panel", peligro: true }
        ],
        (accion) => {
            const panel = pnPanelActivo()
            if (!panel) return
            if (accion === "ajustes") pnAbrirAjustes(w)
            if (accion === "renombrar") pnRenombrarWidget(w)
            if (accion === "duplicar") {
                if (!pnCabeWidget(panel)) return
                const copia = { ...w, id: pnNuevoId("w"), cfg: { ...w.cfg } }
                panel.widgets.splice(panel.widgets.indexOf(w) + 1, 0, copia)
                pnGuardar()
                pnRenderCuerpo()
            }
            if (accion === "ancho") {
                w.w = w.w === PN_COLUMNAS ? PN_TIPOS[w.tipo].w : PN_COLUMNAS
                pnAplicarTamano(pnWidgetEl(w), w)
                pnGuardar()
            }
            if (accion === "eliminar") {
                panel.widgets.splice(panel.widgets.indexOf(w), 1)
                if (!panel.widgets.length) _pnGaleria = true
                pnGuardar()
                pnRenderCuerpo()
            }
        },
        { alinear: "derecha" }
    )
}

function pnRenombrarWidget(w) {
    const titulo = pnWidgetEl(w)?.querySelector(".pnWTitulo")
    if (!titulo) return
    const input = document.createElement("input")
    input.className = "pnTabInput"
    input.value = w.cfg.titulo || PN_TIPOS[w.tipo].nombre
    input.maxLength = 60
    titulo.replaceWith(input)
    input.focus()
    input.select()
    let hecho = false
    const terminar = (guardar) => {
        if (hecho) return
        hecho = true
        const valor = input.value.trim()
        if (guardar) {
            if (valor && valor !== PN_TIPOS[w.tipo].nombre) w.cfg.titulo = valor
            else delete w.cfg.titulo
            pnGuardar()
        }
        const span = document.createElement("span")
        span.className = "pnWTitulo"
        span.textContent = w.cfg.titulo || PN_TIPOS[w.tipo].nombre
        input.replaceWith(span)
    }
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") terminar(true)
        if (e.key === "Escape") terminar(false)
    })
    input.addEventListener("blur", () => terminar(true))
}

// ── Arrastrar y redimensionar ───────────────────────────────────────────────

// La misma asa de seis puntos que los bloques de Ajustes.
const PN_ASA_SVG = `<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="2" r="1.5"/><circle cx="7.5" cy="2" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="14" r="1.5"/><circle cx="7.5" cy="14" r="1.5"/></svg>`

/**
 * Reordenar con la lógica de los bloques de Ajustes (js/ajustes/ajustes.js):
 *
 *   · Se coge solo por el asa: el resto de la cabecera tiene chips y botones,
 *     y pulsarlos no debe empezar a mover el widget.
 *   · El propio widget hace de previsión: mientras se arrastra se coloca en
 *     vivo en el hueco donde caerá, con el mismo aspecto de bloque «en el aire».
 *   · El hueco lo decide el primer widget que el cursor tiene por delante, en
 *     orden de lectura (Ajustes mira solo la mitad de alto porque es una
 *     columna; aquí también la mitad de ancho, porque es una rejilla).
 *   · Soltar fuera de la rejilla o pulsar Esc lo devuelve a donde estaba.
 *
 * Con eventos de puntero y no con el drag & drop nativo de Ajustes: los iframes
 * de TradingView se tragan los eventos del arrastre nativo en cuanto el cursor
 * pasa por encima (por eso la rejilla les quita `pointer-events` mientras dura).
 */
function pnBindArrastre(el) {
    const asa = el.querySelector(".pnAsa")
    asa.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const grid = el.parentElement
        const pagina = document.getElementById("pnBody")
        const casa = { siguiente: el.nextElementSibling }
        let x = e.clientX
        let y = e.clientY
        let cuadro = 0
        let terminado = false

        el.classList.add("pnArrastrado")
        grid.classList.add("pnArrastrando")

        const colocar = () => {
            cuadro = 0
            const otros = [...grid.children].filter((n) => n !== el && n.classList.contains("pnWidget"))
            const referencia = otros.find((n) => {
                const r = n.getBoundingClientRect()
                if (y < r.top) return true
                return y <= r.bottom && x < r.left + r.width / 2
            })
            moveDraggedAssetPreview(grid, el, referencia || null)
        }

        // Cerca del borde de la página, se desplaza sola: un panel largo no
        // cabe en pantalla y si no, no habría forma de llevar un widget abajo.
        const desplazar = () => {
            if (terminado || !pagina) return
            const r = pagina.getBoundingClientRect()
            const margen = 70
            const paso = y < r.top + margen ? -14 : y > r.bottom - margen ? 14 : 0
            if (paso) {
                pagina.scrollBy(0, paso)
                colocar()
            }
            requestAnimationFrame(desplazar)
        }
        requestAnimationFrame(desplazar)

        const mover = (ev) => {
            x = ev.clientX
            y = ev.clientY
            if (!cuadro) cuadro = requestAnimationFrame(colocar)
        }

        const acabar = (confirmar) => {
            if (terminado) return
            terminado = true
            cancelAnimationFrame(cuadro)
            document.removeEventListener("pointermove", mover)
            document.removeEventListener("pointerup", soltar)
            document.removeEventListener("pointercancel", cancelar)
            window.removeEventListener("keydown", tecla, true)
            el.classList.remove("pnArrastrado")
            grid.classList.remove("pnArrastrando")

            if (!confirmar) {
                // Cancelado: vuelve a su sitio, como en Ajustes.
                grid.insertBefore(el, casa.siguiente && casa.siguiente.parentElement === grid ? casa.siguiente : null)
                return
            }
            const panel = pnPanelActivo()
            if (!panel) return
            const orden = [...grid.children].map((n) => n.dataset.widget)
            const antes = panel.widgets.map((w) => w.id).join()
            panel.widgets.sort((a, b) => orden.indexOf(a.id) - orden.indexOf(b.id))
            if (panel.widgets.map((w) => w.id).join() !== antes) pnGuardar()
        }

        const soltar = (ev) => {
            const r = grid.getBoundingClientRect()
            const dentro =
                ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
            acabar(dentro)
        }
        const cancelar = () => acabar(false)
        const tecla = (ev) => {
            if (ev.key !== "Escape") return
            ev.preventDefault()
            ev.stopPropagation()
            acabar(false)
        }

        document.addEventListener("pointermove", mover)
        document.addEventListener("pointerup", soltar)
        document.addEventListener("pointercancel", cancelar)
        window.addEventListener("keydown", tecla, true)
    })
}

/** Estirar por la esquina: el tamaño salta de celda en celda de la rejilla. */
function pnBindRedimension(el, w) {
    const asa = el.querySelector(".pnResize")
    asa.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const grid = el.parentElement
        const anchoGrid = grid.clientWidth
        const fila = pnFila()
        const hueco = pnHueco()
        const columna = (anchoGrid - hueco * (PN_COLUMNAS - 1)) / PN_COLUMNAS
        const rect = el.getBoundingClientRect()
        const inicioX = e.clientX
        const inicioY = e.clientY
        const original = { w: w.w, h: w.h }

        el.classList.add("pnRedimensionando")
        grid.classList.add("pnArrastrando")

        const mover = (ev) => {
            const ancho = rect.width + (ev.clientX - inicioX)
            const alto = rect.height + (ev.clientY - inicioY)
            const nuevoW = Math.round((ancho + hueco) / (columna + hueco))
            const nuevoH = Math.round((alto + hueco) / (fila + hueco))
            if (nuevoW !== w.w || nuevoH !== w.h) {
                w.w = nuevoW
                w.h = nuevoH
                pnAplicarTamano(el, w)
            }
        }
        const soltar = () => {
            document.removeEventListener("pointermove", mover)
            document.removeEventListener("pointerup", soltar)
            el.classList.remove("pnRedimensionando")
            grid.classList.remove("pnArrastrando")
            if (w.w !== original.w || w.h !== original.h) pnGuardar()
        }
        document.addEventListener("pointermove", mover)
        document.addEventListener("pointerup", soltar)
    })
}

// ── Menú flotante ───────────────────────────────────────────────────────────

/**
 * Un único menú flotante para toda la página (desplegables de las cabeceras,
 * opciones del widget, añadir widget). Se cierra al pulsar fuera, con Escape o
 * al elegir. `contenido` permite meter dentro algo que no sea una lista.
 */
function pnMenu(anchor, items, alElegir, opciones = {}) {
    const abierto = document.getElementById("pnPop")
    const mismo = abierto && abierto._anchor === anchor
    pnCerrarMenu()
    if (mismo) return null

    const pop = document.createElement("div")
    pop.id = "pnPop"
    pop.className = "pnPop"
    pop._anchor = anchor
    if (opciones.ancho) pop.style.width = opciones.ancho + "px"
    if (opciones.clase) pop.classList.add(opciones.clase)

    if (opciones.contenido) {
        pop.appendChild(opciones.contenido)
    } else {
        pop.innerHTML = items
            .map((it) =>
                it.separador
                    ? `<div class="pnPopSep"></div>`
                    : it.cabecera
                      ? `<div class="pnPopCab">${escapeHtml(it.cabecera)}</div>`
                      : `<button type="button" class="pnPopItem${it.activo ? " active" : ""}${it.peligro ? " pnPeligro" : ""}" data-valor="${escapeAttr(it.valor)}">${it.html || escapeHtml(it.texto)}</button>`
            )
            .join("")
        pop.addEventListener("click", (e) => {
            const btn = e.target.closest(".pnPopItem")
            if (!btn) return
            pnCerrarMenu()
            alElegir?.(btn.dataset.valor)
        })
    }

    document.body.appendChild(pop)
    pnColocarMenu(pop, anchor, opciones.alinear)
    anchor.classList.add("pnAbierto")

    setTimeout(() => {
        const fuera = (e) => {
            if (pop.contains(e.target) || anchor.contains(e.target)) return
            pnCerrarMenu()
        }
        const tecla = (e) => {
            if (e.key === "Escape") pnCerrarMenu()
        }
        document.addEventListener("pointerdown", fuera)
        document.addEventListener("keydown", tecla)
        window.addEventListener("resize", pnCerrarMenu)
        pop._quitar = () => {
            document.removeEventListener("pointerdown", fuera)
            document.removeEventListener("keydown", tecla)
            window.removeEventListener("resize", pnCerrarMenu)
        }
    })
    return pop
}

function pnColocarMenu(pop, anchor, alinear) {
    const r = anchor.getBoundingClientRect()
    const ancho = pop.offsetWidth
    const alto = pop.offsetHeight
    let left = alinear === "derecha" ? r.right - ancho : r.left
    left = Math.max(8, Math.min(left, window.innerWidth - ancho - 8))
    let top = r.bottom + 4
    if (top + alto > window.innerHeight - 8) top = Math.max(8, r.top - alto - 4)
    pop.style.left = left + "px"
    pop.style.top = top + "px"
}

function pnCerrarMenu() {
    const pop = document.getElementById("pnPop")
    if (!pop) return
    pop._quitar?.()
    pop._anchor?.classList.remove("pnAbierto")
    pop.remove()
}

/**
 * Los controles de la cabecera salen también en los ajustes del widget (en
 * «Cabecera»): en un widget estrecho la cabecera los corta y los últimos no
 * se pueden pulsar. `_cab` dice cómo repetirlos allí: un desplegable que se
 * abre anclado al botón que se pulse, o una botonera (pnSegmentado).
 */
function pnControlCabecera(btn, etiqueta, abrir) {
    btn._cab = { etiqueta, abrir }
    btn.addEventListener("click", () => abrir(btn))
    return btn
}

/** Desplegable de una opción: el chip muestra la elegida. */
function pnChip(ctrls, texto, items, valor, alElegir, etiqueta = "") {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "pnChip"
    btn.innerHTML = `<span>${escapeHtml(texto)}</span><span class="pnChipFlecha">▾</span>`
    pnControlCabecera(btn, etiqueta, (ancla) =>
        pnMenu(
            ancla,
            items.map((it) => ({ ...it, activo: it.valor === valor })),
            alElegir
        )
    )
    ctrls.appendChild(btn)
    return btn
}

/** Botonera segmentada para pocas opciones que se cambian a menudo. */
function pnSegmentado(ctrls, items, valor, alElegir, etiqueta = "") {
    const cont = document.createElement("div")
    cont._cab = { etiqueta, items, valor, alElegir }
    cont.className = "pnSeg"
    cont.innerHTML = items
        .map(
            (it) =>
                `<button type="button" class="pnSegBtn${it.valor === valor ? " active" : ""}" data-valor="${escapeAttr(it.valor)}">${it.marcado ? `${iconoHtml("Marcado")} ` : ""}${escapeHtml(it.texto)}</button>`
        )
        .join("")
    cont.addEventListener("click", (e) => {
        const btn = e.target.closest(".pnSegBtn")
        if (btn && btn.dataset.valor !== valor) alElegir(btn.dataset.valor)
    })
    ctrls.appendChild(cont)
    return cont
}

// La lupa va como elemento propio y no como fondo del campo: el tema claro
// pone `background` con !important a todos los campos y la borraba.
const PN_LUPA = `<span class="icono iconoBuscar pnLupa" aria-hidden="true"></span>`

/**
 * Selector de activos con casillas, buscador y atajos por tipo. `vacioEsTodos`
 * dice qué significa no marcar ninguno (en el mapa y los favoritos, «todos»).
 *
 * Los cambios se avisan al momento (el widget se repinta detrás mientras se
 * marca); «Listo» solo cierra. Al repintar se rehace la lista y el pie, nunca
 * el buscador, para no perder lo que se está escribiendo.
 */
function pnSelectorActivos(anchor, { opciones, seleccion, alCambiar, vacioEsTodos = true, tickers = true }) {
    const marcados = new Set(seleccion)
    // Los tickers sueltos que ya estaban elegidos tienen que salir en la lista
    // para poder desmarcarlos.
    opciones = [
        ...opciones,
        ...seleccion
            .filter((id) => id.startsWith("tk|"))
            .map(pnBuscarActivo)
            .filter(Boolean)
    ]
    let resultados = null
    let buscado = ""
    const grupoDe = (o) =>
        o.ticker ? "Tickers" : o.watchlist ? "Watchlist" : o.conPosicion ? "En cartera" : "Seguimiento"
    const deTipo = (tipo) => opciones.filter((o) => o.tipo === tipo && !o.watchlist)

    const contenido = document.createElement("div")
    contenido.className = "pnSel"
    contenido.innerHTML = `
        <div class="pnSelCab">
            <label class="pnSelBuscarCaja">${PN_LUPA}<input class="pnSelBuscar" type="search" placeholder="Buscar por nombre o símbolo…" data-no-custom></label>
            <div class="pnSelAtajos"></div>
        </div>
        <div class="pnSelLista"></div>
        <div class="pnSelPie">
            <span class="pnSelCuenta"></span>
            <button type="button" class="pnSelLimpiar" data-accion="limpiar">Quitar todo</button>
            <button type="button" class="pnSelListo" data-accion="listo">Listo</button>
        </div>`

    const lista = contenido.querySelector(".pnSelLista")
    const atajos = contenido.querySelector(".pnSelAtajos")
    const cuenta = contenido.querySelector(".pnSelCuenta")
    const limpiar = contenido.querySelector(".pnSelLimpiar")
    const buscar = contenido.querySelector(".pnSelBuscar")

    const pintar = () => {
        // Un atajo está activo cuando lo marcado es justo ese tipo.
        const igual = (ids) => ids.length === marcados.size && ids.every((id) => marcados.has(id))
        atajos.innerHTML =
            `<button type="button" class="pnSelAtajo${marcados.size ? "" : " active"}" data-atajo="todos">Todos</button>` +
            PN_TIPOS_ACTIVO.map((t) => {
                const ids = deTipo(t.valor).map((o) => o.id)
                if (!ids.length) return ""
                return `<button type="button" class="pnSelAtajo${igual(ids) ? " active" : ""}" data-atajo="${t.valor}">${escapeHtml(t.texto)}<span>${ids.length}</span></button>`
            }).join("")

        const q = buscar.value.trim().toLowerCase()
        const visibles = opciones.filter(
            (o) =>
                !q ||
                o.nombre.toLowerCase().includes(q) ||
                String(o.simbolo || "")
                    .toLowerCase()
                    .includes(q)
        )
        const porGrupo = new Map()
        visibles.forEach((o) => {
            const g = grupoDe(o)
            if (!porGrupo.has(g)) porGrupo.set(g, [])
            porGrupo.get(g).push(o)
        })
        const scroll = lista.scrollTop
        lista.innerHTML =
            [...porGrupo]
                .map(
                    ([g, items]) => `
                <div class="pnSelGrupo"><span>${g}</span><span>${items.filter((o) => marcados.has(o.id)).length}/${items.length}</span></div>
                ${items
                    .map((o) => {
                        const on = marcados.has(o.id)
                        return `<label class="pnSelItem${on ? " pnMarcado" : ""}">
                            <input type="checkbox" class="pnCasilla" value="${escapeAttr(o.id)}" ${on ? "checked" : ""}>
                            <span class="pnSelAvatar" style="--c:${escapeAttr(pnColorTipo(o.tipo))}">${escapeHtml(String(o.simbolo || o.nombre).slice(0, 1))}</span>
                            <span class="pnSelNombre">${escapeHtml(o.nombre)}</span>
                            ${o.simbolo ? `<span class="pnSelSimbolo">${escapeHtml(o.simbolo)}</span>` : ""}
                        </label>`
                    })
                    .join("")}`
                )
                .join("") ||
            (tickers
                ? ""
                : `<div class="pnVacio">Ningún activo coincide con «${escapeHtml(buscar.value.trim())}»</div>`)

        // Buscar fuera de la cartera: cualquier símbolo de TradingView.
        const texto = buscar.value.trim()
        if (tickers && texto.length >= 2) {
            if (resultados === "cargando" && buscado === texto) {
                lista.insertAdjacentHTML(
                    "beforeend",
                    `<div class="pnSelGrupo"><span>En el mercado</span></div><div class="pnVacio">Buscando «${escapeHtml(texto)}»…</div>`
                )
            } else if (Array.isArray(resultados) && buscado === texto) {
                const nuevos = resultados.filter((r) => !opciones.some((o) => o.id === r.id))
                lista.insertAdjacentHTML(
                    "beforeend",
                    `<div class="pnSelGrupo"><span>En el mercado</span><span>${nuevos.length}</span></div>` +
                        (nuevos
                            .map(
                                (
                                    r
                                ) => `<button type="button" class="pnSelItem pnSelResultado" data-ticker="${escapeAttr(r.id)}">
                                <span class="pnSelMas">+</span>
                                <span class="pnSelAvatar" style="--c:${escapeAttr(pnColorTipo(r.tipo))}">${escapeHtml(String(r.simbolo.split(":").pop()).slice(0, 1))}</span>
                                <span class="pnSelNombre">${escapeHtml(r.nombre)}</span>
                                <span class="pnSelSimbolo">${escapeHtml(r.simbolo)}</span>
                            </button>`
                            )
                            .join("") || `<div class="pnVacio">TradingView no encuentra «${escapeHtml(texto)}»</div>`)
                )
            } else {
                lista.insertAdjacentHTML(
                    "beforeend",
                    `<button type="button" class="pnSelBuscarFuera" data-accion="mercado">${PN_LUPA}<span>Buscar <b>${escapeHtml(texto)}</b> en el mercado</span><small>Intro</small></button>`
                )
            }
        }
        lista.scrollTop = scroll

        cuenta.innerHTML = marcados.size
            ? `<b>${marcados.size}</b> seleccionados`
            : vacioEsTodos
              ? "Sin marcar: <b>toda la cartera</b>"
              : "Ninguno marcado"
        limpiar.disabled = !marcados.size
    }

    const avisar = () => {
        pintar()
        alCambiar([...marcados])
    }

    lista.addEventListener("change", (e) => {
        const cb = e.target.closest("input[type=checkbox]")
        if (!cb) return
        if (cb.checked) marcados.add(cb.value)
        else marcados.delete(cb.value)
        avisar()
    })
    atajos.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-atajo]")
        if (!btn) return
        marcados.clear()
        if (btn.dataset.atajo !== "todos") deTipo(btn.dataset.atajo).forEach((o) => marcados.add(o.id))
        avisar()
    })
    const buscarFuera = async () => {
        const texto = buscar.value.trim()
        if (texto.length < 2) return
        buscado = texto
        resultados = "cargando"
        pintar()
        const encontrados = await pnBuscarTickers(texto)
        if (buscado !== texto) return
        resultados = encontrados || []
        pintar()
    }
    lista.addEventListener("click", (e) => {
        if (e.target.closest("[data-accion=mercado]")) {
            buscarFuera()
            return
        }
        const nuevo = e.target.closest("[data-ticker]")
        if (!nuevo) return
        const ticker = pnBuscarActivo(nuevo.dataset.ticker)
        if (!ticker) return
        opciones.push(ticker)
        marcados.add(ticker.id)
        avisar()
    })
    contenido.querySelector(".pnSelPie").addEventListener("click", (e) => {
        const accion = e.target.closest("[data-accion]")?.dataset.accion
        if (accion === "limpiar") {
            marcados.clear()
            avisar()
        }
        if (accion === "listo") pnCerrarMenu()
    })
    buscar.addEventListener("input", () => {
        resultados = null
        pintar()
    })
    buscar.addEventListener("keydown", (e) => {
        // Intro marca o desmarca el primero que coincide con la búsqueda; si
        // en la cartera no hay ninguno, busca en el mercado.
        if (e.key !== "Enter") return
        const primera = lista.querySelector("input[type=checkbox]")
        if (!primera) {
            if (tickers && resultados === null) buscarFuera()
            return
        }
        primera.checked = !primera.checked
        primera.dispatchEvent(new Event("change", { bubbles: true }))
    })

    pintar()
    pnMenu(anchor, [], null, { contenido, ancho: 340, clase: "pnPopSel" })
    setTimeout(() => buscar.focus(), 0)
}

// ── Enlace entre widgets ────────────────────────────────────────────────────

function pnSeleccionarActivo(id) {
    const activo = pnBuscarActivo(id)
    if (!activo) return
    const panel = pnPanelActivo()
    const graficos = (panel?.widgets || []).filter(
        (w) =>
            PN_TIPOS[w.tipo]?.enlazable &&
            w.cfg.vincular !== false &&
            !(w.tipo === "noticias" && w.cfg.modo !== "activo")
    )

    document.querySelectorAll(".pnSeleccionado").forEach((n) => n.classList.remove("pnSeleccionado"))
    document.querySelectorAll(`[data-activo="${CSS.escape(id)}"]`).forEach((n) => n.classList.add("pnSeleccionado"))

    if (!graficos.length) {
        if (activo.tv) openTVChartModal(activo.tv, activo.nombre)
        return
    }
    graficos.forEach((w) => {
        if (w.cfg.activo === id) return
        w.cfg.activo = id
        pnPintarWidget(w)
    })
    pnGuardar()
}

// ── Opciones de los widgets ─────────────────────────────────────────────────
//
// Cada widget guarda sus opciones en `cfg`, plano (textos, números, booleanos y
// listas de textos: es lo que admite el servidor). Una opción que no está es su
// valor por defecto, así que los paneles guardados antes de que existiera una
// opción siguen viéndose igual. Estas tres funciones leen con ese criterio.

function pnLista(cfg, clave) {
    return Array.isArray(cfg[clave]) ? cfg[clave] : []
}

function pnOpcion(cfg, clave, permitidas, defecto) {
    return permitidas.includes(cfg[clave]) ? cfg[clave] : defecto
}

function pnSi(cfg, clave, defecto = true) {
    return typeof cfg[clave] === "boolean" ? cfg[clave] : defecto
}

/**
 * Los activos con los que trabaja un widget después de sus filtros: los
 * elegidos a mano (o, sin elegir ninguno, los de la cartera), los tipos
 * marcados y si entran los ocultos. Un activo elegido a mano entra aunque esté
 * oculto: si se ha marcado, es que se quiere ver.
 * `soloPosiciones` deja fuera lo que no tiene posición abierta (la tabla, la
 * distribución y el resumen hablan de dinero invertido).
 */
function pnActivosDelWidget(cfg, { soloPosiciones = true } = {}) {
    const elegidos = pnLista(cfg, "activos")
    let lista
    if (elegidos.length) {
        lista = elegidos.map(pnBuscarActivo).filter(Boolean)
    } else {
        lista = (_pnDatos?.activos || []).filter((a) => cfg.ocultos === true || !a.oculto)
    }
    if (soloPosiciones) lista = lista.filter((a) => a.conPosicion)
    const tipos = pnLista(cfg, "tipos")
    if (tipos.length) lista = lista.filter((a) => tipos.includes(a.tipo))
    return lista
}

function pnTextoFiltro(cfg, porDefecto = "Toda la cartera") {
    const elegidos = pnLista(cfg, "activos").length
    const tipos = pnLista(cfg, "tipos")
    if (elegidos) return `${elegidos} activos`
    if (tipos.length) return tipos.map((t) => PN_TIPOS_ACTIVO.find((x) => x.valor === t)?.texto || t).join(", ")
    return porDefecto
}

// Campos que repiten varios widgets.
const PN_CAMPO_TIPOS = {
    clave: "tipos",
    tipo: "multi",
    etiqueta: "Tipos de activo",
    ayuda: "Sin marcar ninguno se muestran todos.",
    opciones: PN_TIPOS_ACTIVO
}
const PN_CAMPO_OCULTOS = {
    clave: "ocultos",
    tipo: "check",
    etiqueta: "Incluir los activos ocultos",
    defecto: false
}
const pnCampoActivos = (ayuda, soloPosiciones = false) => ({
    clave: "activos",
    tipo: "activos",
    etiqueta: "Activos",
    ayuda,
    soloPosiciones
})

const PN_ESTUDIOS = [
    { valor: "MASimple@tv-basicstudies", texto: "Media móvil" },
    { valor: "MAExp@tv-basicstudies", texto: "Media exponencial" },
    { valor: "BB@tv-basicstudies", texto: "Bollinger" },
    { valor: "RSI@tv-basicstudies", texto: "RSI" },
    { valor: "MACD@tv-basicstudies", texto: "MACD" },
    { valor: "Stochastic@tv-basicstudies", texto: "Estocástico" },
    { valor: "ATR@tv-basicstudies", texto: "ATR" }
]

/** Ajustes de cada tipo de widget, por secciones. */
const PN_AJUSTES = {
    mapa: [
        {
            titulo: "Qué se muestra",
            campos: [
                pnCampoActivos("Sin elegir ninguno, todas las posiciones de la cartera."),
                PN_CAMPO_TIPOS,
                PN_CAMPO_OCULTOS
            ]
        },
        {
            titulo: "Cálculo",
            campos: [
                { clave: "periodo", tipo: "seg", etiqueta: "Periodo", opciones: PN_PERIODOS, defecto: "dia" },
                {
                    clave: "tamano",
                    tipo: "seg",
                    etiqueta: "Tamaño de las baldosas",
                    opciones: [
                        { valor: "valor", texto: "Por valor" },
                        { valor: "igual", texto: "Iguales" }
                    ],
                    defecto: "valor"
                },
                {
                    clave: "agrupar",
                    tipo: "seg",
                    etiqueta: "Agrupar",
                    opciones: [
                        { valor: "no", texto: "No" },
                        { valor: "tipo", texto: "Por tipo" },
                        { valor: "divisa", texto: "Por divisa" }
                    ],
                    defecto: "no"
                },
                {
                    clave: "escala",
                    tipo: "seg",
                    etiqueta: "Color a tope en",
                    ayuda: "«Auto» se ajusta al periodo: un día bueno son décimas y un año bueno, un 25 %.",
                    opciones: [
                        { valor: "auto", texto: "Auto" },
                        { valor: "1", texto: "±1 %" },
                        { valor: "3", texto: "±3 %" },
                        { valor: "10", texto: "±10 %" },
                        { valor: "25", texto: "±25 %" },
                        { valor: "50", texto: "±50 %" }
                    ],
                    defecto: "auto"
                }
            ]
        },
        {
            titulo: "Baldosas",
            campos: [
                {
                    clave: "etiqueta",
                    tipo: "seg",
                    etiqueta: "Rótulo",
                    opciones: [
                        { valor: "simbolo", texto: "Símbolo" },
                        { valor: "nombre", texto: "Nombre" }
                    ],
                    defecto: "simbolo"
                },
                { clave: "pct", tipo: "check", etiqueta: "Variación en %", defecto: true },
                { clave: "eur", tipo: "check", etiqueta: "Movimiento en €", defecto: true },
                { clave: "precio", tipo: "check", etiqueta: "Precio", defecto: false },
                { clave: "leyenda", tipo: "check", etiqueta: "Leyenda de colores", defecto: false }
            ]
        }
    ],
    grafico: [
        {
            titulo: "Gráfico",
            campos: [
                { clave: "intervalo", tipo: "seg", etiqueta: "Intervalo", opciones: PN_INTERVALOS, defecto: "D" },
                {
                    clave: "estilo",
                    tipo: "seg",
                    etiqueta: "Tipo de gráfico",
                    opciones: [
                        { valor: "1", texto: "Velas" },
                        { valor: "9", texto: "Velas huecas" },
                        { valor: "8", texto: "Heikin Ashi" },
                        { valor: "0", texto: "Barras" },
                        { valor: "2", texto: "Línea" },
                        { valor: "3", texto: "Área" }
                    ],
                    defecto: "1"
                },
                { clave: "estudios", tipo: "multi", etiqueta: "Indicadores", opciones: PN_ESTUDIOS },
                {
                    clave: "zona",
                    tipo: "seg",
                    etiqueta: "Zona horaria",
                    opciones: [
                        { valor: "local", texto: "La mía" },
                        { valor: "exchange", texto: "Del mercado" },
                        { valor: "utc", texto: "UTC" }
                    ],
                    defecto: "local"
                }
            ]
        },
        {
            titulo: "Interfaz",
            campos: [
                { clave: "barraSuperior", tipo: "check", etiqueta: "Barra superior de TradingView", defecto: true },
                { clave: "herramientas", tipo: "check", etiqueta: "Herramientas de dibujo", defecto: false },
                { clave: "volumen", tipo: "check", etiqueta: "Volumen", defecto: true },
                {
                    clave: "vincular",
                    tipo: "check",
                    etiqueta: "Enlazado con el panel",
                    ayuda: "Al pulsar un activo en otro widget, se abre aquí.",
                    defecto: true
                }
            ]
        }
    ],
    cartera: [
        {
            titulo: "Qué se muestra",
            campos: [
                pnCampoActivos("Sin elegir ninguno, todas las posiciones abiertas.", true),
                PN_CAMPO_TIPOS,
                PN_CAMPO_OCULTOS
            ]
        },
        {
            titulo: "Tabla",
            campos: [
                {
                    clave: "columnas",
                    tipo: "multi",
                    etiqueta: "Columnas",
                    ayuda: "Sin marcar ninguna se muestran todas.",
                    opciones: []
                },
                { clave: "totales", tipo: "check", etiqueta: "Fila de totales", defecto: true },
                { clave: "compacta", tipo: "check", etiqueta: "Filas compactas", defecto: false },
                { clave: "detalle", tipo: "check", etiqueta: "Tipo y símbolo bajo el nombre", defecto: true }
            ]
        }
    ],
    favoritos: [
        {
            titulo: "Qué se muestra",
            campos: [
                pnCampoActivos("Sin elegir ninguno, todos los de la cartera, también los que solo sigues."),
                PN_CAMPO_TIPOS,
                PN_CAMPO_OCULTOS
            ]
        },
        {
            titulo: "Lista",
            campos: [
                {
                    clave: "orden",
                    tipo: "seg",
                    etiqueta: "Orden",
                    opciones: [
                        { valor: "manual", texto: "El mío" },
                        { valor: "sube", texto: "Más suben" },
                        { valor: "baja", texto: "Más bajan" },
                        { valor: "nombre", texto: "Nombre" }
                    ],
                    defecto: "manual"
                },
                { clave: "precio", tipo: "check", etiqueta: "Precio", defecto: true },
                { clave: "variacion", tipo: "check", etiqueta: "Variación del día", defecto: true },
                { clave: "posicion", tipo: "check", etiqueta: "Valor de mi posición", defecto: false },
                { clave: "logo", tipo: "check", etiqueta: "Inicial de color", defecto: true },
                { clave: "compacta", tipo: "check", etiqueta: "Filas compactas", defecto: false }
            ]
        }
    ],
    rendimiento: [
        {
            titulo: "Gráfico",
            campos: [
                { clave: "rango", tipo: "seg", etiqueta: "Periodo", opciones: PN_RANGOS, defecto: "3M" },
                {
                    clave: "modo",
                    tipo: "seg",
                    etiqueta: "Qué se dibuja",
                    opciones: [
                        { valor: "valor", texto: "Valor" },
                        { valor: "ganancia", texto: "Ganancia" }
                    ],
                    defecto: "valor"
                },
                { clave: "invertido", tipo: "check", etiqueta: "Línea de lo invertido", defecto: true },
                { clave: "relleno", tipo: "check", etiqueta: "Relleno bajo la línea", defecto: true },
                { clave: "cabecera", tipo: "check", etiqueta: "Valor y cambio encima", defecto: true }
            ]
        }
    ],
    distribucion: [
        {
            titulo: "Qué se muestra",
            campos: [
                pnCampoActivos("Sin elegir ninguno, todas las posiciones abiertas.", true),
                PN_CAMPO_TIPOS,
                PN_CAMPO_OCULTOS
            ]
        },
        {
            titulo: "Reparto",
            campos: [
                {
                    clave: "por",
                    tipo: "seg",
                    etiqueta: "Agrupar por",
                    opciones: [
                        { valor: "tipo", texto: "Tipo" },
                        { valor: "activo", texto: "Activo" },
                        { valor: "divisa", texto: "Divisa" }
                    ],
                    defecto: "tipo"
                },
                {
                    clave: "forma",
                    tipo: "seg",
                    etiqueta: "Forma",
                    opciones: [
                        { valor: "anillo", texto: "Anillo" },
                        { valor: "tarta", texto: "Tarta" },
                        { valor: "barras", texto: "Barras" }
                    ],
                    defecto: "anillo"
                },
                {
                    clave: "maximo",
                    tipo: "seg",
                    etiqueta: "Porciones",
                    ayuda: "El resto se junta en «Otros».",
                    opciones: [
                        { valor: "0", texto: "Todas" },
                        { valor: "5", texto: "5" },
                        { valor: "8", texto: "8" },
                        { valor: "12", texto: "12" }
                    ],
                    defecto: "0"
                },
                { clave: "leyenda", tipo: "check", etiqueta: "Leyenda", defecto: true },
                { clave: "importes", tipo: "check", etiqueta: "Importes en la leyenda", defecto: false }
            ]
        }
    ],
    resumen: [
        {
            titulo: "Qué se muestra",
            campos: [pnCampoActivos("Sin elegir ninguno, toda la cartera.", true), PN_CAMPO_TIPOS, PN_CAMPO_OCULTOS]
        },
        {
            titulo: "Bloques",
            campos: [
                {
                    clave: "bloques",
                    tipo: "multi",
                    etiqueta: "Bloques visibles",
                    ayuda: "Sin marcar ninguno se muestran todos.",
                    opciones: [
                        { valor: "total", texto: "Valor y hoy" },
                        { valor: "kpis", texto: "Invertido y rendimiento" },
                        { valor: "movers", texto: "Suben y bajan" }
                    ]
                },
                {
                    clave: "cuantos",
                    tipo: "seg",
                    etiqueta: "Cuántos suben y bajan",
                    opciones: [
                        { valor: "3", texto: "3" },
                        { valor: "5", texto: "5" },
                        { valor: "10", texto: "10" }
                    ],
                    defecto: "3"
                }
            ]
        }
    ],
    notas: [
        {
            titulo: "Texto",
            campos: [
                {
                    clave: "letra",
                    tipo: "seg",
                    etiqueta: "Tamaño de letra",
                    opciones: [
                        { valor: "s", texto: "Pequeña" },
                        { valor: "m", texto: "Normal" },
                        { valor: "l", texto: "Grande" }
                    ],
                    defecto: "m"
                },
                { clave: "mono", tipo: "check", etiqueta: "Letra monoespaciada", defecto: false }
            ]
        }
    ]
}

// ── Ventanas de ajustes ─────────────────────────────────────────────────────
//
// Puede haber varias abiertas a la vez: una por widget y una por panel, para
// ajustar dos widgets comparándolos. Abrir la de un widget que ya la tiene la
// trae al frente en vez de duplicarla. Los cambios se aplican al momento: el
// widget se repinta y se guarda como cualquier otro cambio (con el retardo de
// pnGuardar).
//
// El orden de delante a atrás lo lleva un contador por ventana, no su sitio en
// el DOM: moverla al final del contenedor al pulsarla le quitaba el foco al
// campo o al deslizador que se estaba tocando. El z-index se reparte de nuevo
// cada vez, así que no crece sin límite y nunca alcanza a los modales de la
// aplicación (1000).

const PN_Z_AJUSTES = 960
let _pnOrdenAjustes = 0

/** Las ventanas abiertas, de la de más atrás a la de delante. */
function pnVentanasAjustes() {
    return [...document.querySelectorAll(".pnAjustes")].sort((a, b) => (a._orden || 0) - (b._orden || 0))
}

function pnVentanaAjustes(clave) {
    return pnVentanasAjustes().find((v) => v._clave === clave) || null
}

function pnTraerAlFrente(aside) {
    if (pnVentanasAjustes().at(-1) !== aside || !aside._orden) aside._orden = ++_pnOrdenAjustes
    pnVentanasAjustes().forEach((v, i) => {
        v.style.zIndex = String(PN_Z_AJUSTES + i)
        v.classList.toggle("pnDelante", v === aside)
    })
}

/** Cierra una ventana, o todas si no se dice cuál. */
function pnCerrarAjustes(aside) {
    const ventanas = aside ? [aside] : pnVentanasAjustes()
    ventanas.forEach((v) => {
        if (v._w) {
            const el = pnWidgetEl(v._w)
            el?.classList.remove("pnEditando", "pnResaltado")
        }
        v.remove()
    })
    const delante = pnVentanasAjustes().at(-1)
    if (delante) pnTraerAlFrente(delante)
}

/** Tras repintar el panel, cada ventana sigue si su widget o panel sigue ahí. */
function pnSincronizarAjustes() {
    pnVentanasAjustes().forEach((v) => {
        if (v._panel) {
            if (v._panel !== pnPanelActivo() || _pnGaleria) pnCerrarAjustes(v)
            return
        }
        const sigue = pnPanelActivo()?.widgets.includes(v._w) && !_pnGaleria
        if (!sigue) pnCerrarAjustes(v)
        else pnWidgetEl(v._w)?.classList.add("pnEditando")
    })
}

/** Posición a la derecha o a la izquierda del elemento, si cabe; si no, null. */
function pnPosicionJunto(aside, ancla) {
    const r = ancla.getBoundingClientRect()
    const ancho = aside.offsetWidth
    const y = Math.max(8, r.top)
    if (r.right + 12 + ancho <= window.innerWidth - 8) return { x: r.right + 12, y }
    if (r.left - 12 - ancho >= 8) return { x: r.left - 12 - ancho, y }
    return null
}

/**
 * Una ventana nueva, o null si ya había una con esa clave (entonces se trae
 * al frente y parpadea para que se vea cuál es).
 */
function pnCrearAside(clave, titulo, subtitulo, ancla = null) {
    const existente = pnVentanaAjustes(clave)
    if (existente) {
        pnTraerAlFrente(existente)
        existente.classList.remove("pnAvisar")
        void existente.offsetWidth
        existente.classList.add("pnAvisar")
        return null
    }
    const abiertas = pnVentanasAjustes().length
    const aside = document.createElement("aside")
    aside.className = "pnAjustes"
    aside._clave = clave
    aside.innerHTML = `
        <header class="pnAjCab">
            <div><b>${escapeHtml(titulo)}</b><small>${escapeHtml(subtitulo)}</small></div>
            <button class="pnIconBtn" type="button" data-accion="cerrar" title="Cerrar (Esc)" aria-label="Cerrar">${iconoHtml("Cerrar")}</button>
        </header>
        <div class="pnAjCuerpo"></div>`
    aside.querySelector("[data-accion=cerrar]").addEventListener("click", () => pnCerrarAjustes(aside))
    // Pulsar en cualquier parte de una ventana la trae al frente.
    aside.addEventListener("pointerdown", () => pnTraerAlFrente(aside), true)
    // Pasar por encima resalta su widget: con varias abiertas, dice cuál es cuál.
    aside.addEventListener("mouseenter", () => aside._w && pnWidgetEl(aside._w)?.classList.add("pnResaltado"))
    aside.addEventListener("mouseleave", () => aside._w && pnWidgetEl(aside._w)?.classList.remove("pnResaltado"))
    document.getElementById("pnPage")?.appendChild(aside)

    // Junto a su widget, por el lado que tenga sitio, para no tapar ni el
    // widget ni su ⚙ (abierta siempre en la misma esquina, la primera ventana
    // tapaba el botón del widget de esa esquina y no dejaba abrir otra). Si no
    // cabe a ningún lado, o es la del panel, en cascada desde la última
    // posición recordada.
    const junto = ancla && pnPosicionJunto(aside, ancla)
    if (junto) {
        pnColocarAjustes(aside, junto)
    } else {
        const base = pnLeerPosicionAjustes() || {
            x: window.innerWidth - aside.offsetWidth - 24,
            y: 70
        }
        pnColocarAjustes(aside, { x: base.x - abiertas * 28, y: base.y + abiertas * 28 })
    }
    pnBindMoverAjustes(aside)
    pnTraerAlFrente(aside)
    return aside
}

// ── Ventana de ajustes movible ──────────────────────────────────────────────
//
// Flota encima del panel y se arrastra por la cabecera, para apartarla del
// widget que se está ajustando sin estrechar la rejilla. La posición se
// recuerda en este navegador (es una comodidad, no un dato del panel).

const PN_POS_AJUSTES = "panelesAjustesPos"

function pnLeerPosicionAjustes() {
    try {
        const pos = JSON.parse(localStorage.getItem(PN_POS_AJUSTES))
        if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) return pos
    } catch {
        /* sin almacenamiento: posición por defecto */
    }
    return null
}

/** Al encoger el navegador, las ventanas de ajustes vuelven a caber enteras. */
function pnRecolocarAjustes() {
    pnVentanasAjustes().forEach((v) => pnColocarAjustes(v, { x: v.offsetLeft, y: v.offsetTop }))
}

/** Coloca la ventana dentro de la pantalla; sin posición, arriba a la derecha. */
function pnColocarAjustes(aside, pos) {
    const ancho = aside.offsetWidth
    const alto = aside.offsetHeight
    const x = pos ? pos.x : window.innerWidth - ancho - 24
    const y = pos ? pos.y : 70
    aside.style.left = Math.max(8, Math.min(x, window.innerWidth - ancho - 8)) + "px"
    // Entera dentro de la pantalla: su alto máximo ya deja 8 px por cada lado.
    aside.style.top = Math.max(8, Math.min(y, window.innerHeight - alto - 8)) + "px"
}

function pnBindMoverAjustes(aside) {
    const cab = aside.querySelector(".pnAjCab")
    cab.addEventListener("pointerdown", (e) => {
        if (e.button !== 0 || e.target.closest("button")) return
        e.preventDefault()
        const r = aside.getBoundingClientRect()
        const dx = e.clientX - r.left
        const dy = e.clientY - r.top
        aside.classList.add("pnMoviendo")
        // Los iframes de TradingView se quedan el puntero si el cursor pasa
        // por encima a mitad de arrastre.
        document.getElementById("pnGrid")?.classList.add("pnArrastrando")

        const mover = (ev) => pnColocarAjustes(aside, { x: ev.clientX - dx, y: ev.clientY - dy })
        const soltar = () => {
            document.removeEventListener("pointermove", mover)
            document.removeEventListener("pointerup", soltar)
            aside.classList.remove("pnMoviendo")
            document.getElementById("pnGrid")?.classList.remove("pnArrastrando")
            try {
                localStorage.setItem(PN_POS_AJUSTES, JSON.stringify({ x: aside.offsetLeft, y: aside.offsetTop }))
            } catch {
                /* no se recuerda, sin más */
            }
        }
        document.addEventListener("pointermove", mover)
        document.addEventListener("pointerup", soltar)
    })
}

function pnCampoHtml(campo, cfg) {
    const ayuda = campo.ayuda ? `<small class="pnAjAyuda">${escapeHtml(campo.ayuda)}</small>` : ""
    const cab = `<span class="pnAjEtiqueta">${escapeHtml(campo.etiqueta)}</span>`
    const clave = escapeAttr(campo.clave)

    if (campo.tipo === "seg") {
        const actual = pnOpcion(
            cfg,
            campo.clave,
            campo.opciones.map((o) => o.valor),
            campo.defecto
        )
        return `<div class="pnAjCampo">${cab}<div class="pnSeg pnAjSeg">${campo.opciones
            .map(
                (o) =>
                    `<button type="button" class="pnSegBtn${o.valor === actual ? " active" : ""}" data-clave="${clave}" data-valor="${escapeAttr(o.valor)}">${escapeHtml(o.texto)}</button>`
            )
            .join("")}</div>${ayuda}</div>`
    }
    if (campo.tipo === "multi") {
        const marcados = pnLista(cfg, campo.clave)
        return `<div class="pnAjCampo">${cab}<div class="pnAjChips">
            <button type="button" class="pnAjChip${marcados.length ? "" : " active"}" data-clave="${clave}" data-valor="">Todos</button>
            ${campo.opciones
                .map(
                    (o) =>
                        `<button type="button" class="pnAjChip${marcados.includes(o.valor) ? " active" : ""}" data-clave="${clave}" data-valor="${escapeAttr(o.valor)}">${escapeHtml(o.texto)}</button>`
                )
                .join("")}</div>${ayuda}</div>`
    }
    if (campo.tipo === "check") {
        return `<label class="pnAjCampo pnAjCheck">
            <span class="pnAjEtiqueta">${escapeHtml(campo.etiqueta)}${ayuda}</span>
            <input type="checkbox" class="pnSwitch" data-clave="${clave}" ${pnSi(cfg, campo.clave, campo.defecto) ? "checked" : ""}>
        </label>`
    }
    if (campo.tipo === "activos") {
        const elegidos = pnLista(cfg, campo.clave)
        const nombres = elegidos
            .map((id) => pnBuscarActivo(id)?.nombre)
            .filter(Boolean)
            .slice(0, 6)
        return `<div class="pnAjCampo">${cab}
            <button type="button" class="pnChip pnAjActivos" data-clave="${clave}">
                <span>${elegidos.length ? `${elegidos.length} elegidos` : "Elegir activos…"}</span><span class="pnChipFlecha">▾</span>
            </button>
            ${nombres.length ? `<small class="pnAjLista">${escapeHtml(nombres.join(", "))}${elegidos.length > nombres.length ? "…" : ""}</small>` : ""}
            ${elegidos.length ? `<button type="button" class="pnAjLimpiar" data-clave="${clave}">Quitar la selección</button>` : ""}
            ${ayuda}</div>`
    }
    return ""
}

/**
 * El cuerpo del panel de ajustes a partir de una lista de secciones. Se
 * repinta entero tras cada cambio (son unas pocas decenas de nodos) para que
 * los estados activos salgan siempre de `cfg` y no de lo que se pulsó.
 */
function pnPintarSecciones(cuerpo, secciones, cfg, aplicar, extraHtml = "") {
    const scroll = cuerpo.scrollTop
    cuerpo.innerHTML =
        extraHtml +
        secciones
            .map(
                (s) =>
                    `<section class="pnAjSeccion"><h4>${escapeHtml(s.titulo)}</h4>${s.campos.map((c) => pnCampoHtml(c, cfg)).join("")}</section>`
            )
            .join("")
    cuerpo.scrollTop = scroll

    const campos = secciones.flatMap((s) => s.campos)
    const campoDe = (clave) => campos.find((c) => c.clave === clave)

    cuerpo.onclick = (e) => {
        // Los de la sección «Cabecera» no tienen clave: los lleva pnAbrirAjustes.
        const seg = e.target.closest(".pnAjSeg .pnSegBtn[data-clave]")
        if (seg) {
            const campo = campoDe(seg.dataset.clave)
            aplicar(seg.dataset.clave, seg.dataset.valor === campo?.defecto ? undefined : seg.dataset.valor)
            return
        }
        const chip = e.target.closest(".pnAjChip")
        if (chip) {
            const clave = chip.dataset.clave
            const valor = chip.dataset.valor
            const actual = pnLista(cfg, clave)
            const nueva = !valor ? [] : actual.includes(valor) ? actual.filter((v) => v !== valor) : [...actual, valor]
            aplicar(clave, nueva.length ? nueva : undefined)
            return
        }
        const limpiar = e.target.closest(".pnAjLimpiar")
        if (limpiar) {
            aplicar(limpiar.dataset.clave, undefined)
            return
        }
        const elegir = e.target.closest(".pnAjActivos")
        if (elegir) {
            const campo = campoDe(elegir.dataset.clave)
            pnSelectorActivos(elegir, {
                opciones: pnTodosLosActivos().filter((a) => !campo?.soloPosiciones || a.conPosicion),
                seleccion: pnLista(cfg, elegir.dataset.clave),
                alCambiar: (ids) => aplicar(elegir.dataset.clave, ids.length ? ids : undefined, { mantenerMenu: true })
            })
        }
    }
    cuerpo.onchange = (e) => {
        const sw = e.target.closest(".pnSwitch")
        if (!sw) return
        const campo = campoDe(sw.dataset.clave)
        aplicar(sw.dataset.clave, sw.checked === (campo?.defecto ?? true) ? undefined : sw.checked)
    }
}

function pnAbrirAjustes(w) {
    const t = PN_TIPOS[w.tipo]
    const aside = pnCrearAside("w:" + w.id, "Ajustes del widget", w.cfg.titulo || t.nombre, pnWidgetEl(w))
    if (!aside) return
    aside._w = w
    pnWidgetEl(w)?.classList.add("pnEditando")
    const cuerpo = aside.querySelector(".pnAjCuerpo")

    const secciones = PN_AJUSTES[w.tipo] || []
    // Las columnas de la tabla salen de la propia definición de la tabla.
    if (w.tipo === "cartera") {
        const campo = secciones.flatMap((s) => s.campos).find((c) => c.clave === "columnas")
        if (campo) {
            campo.opciones = PN_COLUMNAS_CARTERA.filter((c) => c.clave !== "nombre").map((c) => ({
                valor: c.clave,
                texto: c.texto
            }))
        }
    }

    const general = () => {
        const tw = PN_TIPOS[w.tipo]
        return `
        <section class="pnAjSeccion">
            <h4>General</h4>
            <label class="pnAjCampo"><span class="pnAjEtiqueta">Título</span>
                <input type="text" class="pnAjTexto" data-campo="titulo" maxlength="60" placeholder="${escapeAttr(tw.nombre)}" value="${escapeAttr(w.cfg.titulo || "")}">
            </label>
            <label class="pnAjCampo"><span class="pnAjEtiqueta">Ancho <b data-valor="w">${w.w} de ${PN_COLUMNAS}</b></span>
                <input type="range" class="pnAjRango" data-campo="w" min="${tw.minW}" max="${PN_COLUMNAS}" value="${w.w}">
            </label>
            <label class="pnAjCampo"><span class="pnAjEtiqueta">Alto <b data-valor="h">${w.h} filas</b></span>
                <input type="range" class="pnAjRango" data-campo="h" min="${tw.minH}" max="${PN_ALTO_MAX}" value="${w.h}">
            </label>
        </section>`
    }

    const pie = () => `
        <section class="pnAjSeccion pnAjAcciones">
            <button type="button" class="pnBtn" data-accion="duplicar">Duplicar</button>
            <button type="button" class="pnBtn" data-accion="restablecer" title="Vuelve a las opciones de fábrica; conserva el título, el activo y el texto">Restablecer</button>
            <button type="button" class="pnBtn pnPeligro" data-accion="quitar">Quitar del panel</button>
        </section>`

    // Los controles de la cabecera, repetidos (pnControlCabecera). Se leen del
    // widget pintado, así que siempre son los mismos que se ven arriba.
    const controlesCabecera = () => [...(pnWidgetEl(w)?.querySelectorAll(".pnWCtrls > *") || [])].filter((c) => c._cab)

    const cabecera = () => {
        const controles = controlesCabecera()
        if (!controles.length) return ""
        const campos = controles.map((c, i) => {
            const etiqueta = `<span class="pnAjEtiqueta">${escapeHtml(c._cab.etiqueta || "Opción")}</span>`
            if (c._cab.abrir) {
                const clases = c.className.replace("pnAbierto", "").trim()
                return `<div class="pnAjCampo">${etiqueta}<button type="button" class="${escapeAttr(clases)} pnAjCabChip" data-cab="${i}">${c.innerHTML}</button></div>`
            }
            const botones = c._cab.items
                .map(
                    (it) =>
                        `<button type="button" class="pnSegBtn${it.valor === c._cab.valor ? " active" : ""}" data-cab="${i}" data-valor="${escapeAttr(it.valor)}">${escapeHtml(it.texto)}</button>`
                )
                .join("")
            return `<div class="pnAjCampo">${etiqueta}<div class="pnSeg pnAjSeg">${botones}</div></div>`
        })
        return `<section class="pnAjSeccion pnAjCabecera"><h4>Cabecera</h4>${campos.join("")}</section>`
    }

    const pintar = () => {
        pnPintarSecciones(cuerpo, secciones, w.cfg, aplicar, cabecera() + general())
        cuerpo.insertAdjacentHTML("beforeend", pie())
    }

    // Tras repintar el widget solo se rehace «Cabecera». Con un menú abierto
    // desde ella se cambia el contenido de los botones sin sustituirlos, para
    // no dejar el menú anclado a un botón que ya no está.
    aside._pintarCabecera = () => {
        const vieja = cuerpo.querySelector(".pnAjCabecera")
        const plantilla = document.createElement("template")
        plantilla.innerHTML = cabecera()
        const nueva = plantilla.content.firstElementChild
        const ancla = document.getElementById("pnPop")?._anchor
        if (vieja && nueva && ancla && vieja.contains(ancla)) {
            const antes = vieja.querySelectorAll("[data-cab]")
            const ahora = nueva.querySelectorAll("[data-cab]")
            if (antes.length === ahora.length) {
                antes.forEach((b, i) => {
                    b.innerHTML = ahora[i].innerHTML
                    b.classList.toggle("active", ahora[i].classList.contains("active"))
                })
                return
            }
        }
        if (vieja && nueva) vieja.replaceWith(nueva)
        else if (vieja) vieja.remove()
        else if (nueva) cuerpo.prepend(nueva)
    }

    function aplicar(clave, valor, { mantenerMenu = false } = {}) {
        if (valor === undefined) delete w.cfg[clave]
        else w.cfg[clave] = valor
        pnGuardar()
        if (clave === "vincular") {
            pnWidgetEl(w)
                ?.querySelector(".pnEnlace")
                ?.classList.toggle("on", w.cfg.vincular !== false)
        } else {
            pnPintarWidget(w)
        }
        if (mantenerMenu) {
            // El selector de activos sigue abierto encima: solo se refresca el
            // texto del botón, para no cerrarlo con cada casilla.
            const btn = cuerpo.querySelector(`.pnAjActivos[data-clave="${clave}"] span`)
            const n = pnLista(w.cfg, clave).length
            if (btn) btn.textContent = n ? `${n} elegidos` : "Elegir activos…"
            return
        }
        pintar()
    }

    pintar()

    cuerpo.addEventListener("input", (e) => {
        const campo = e.target.dataset.campo
        if (campo === "titulo") {
            const valor = e.target.value.trim()
            if (valor) w.cfg.titulo = valor.slice(0, 60)
            else delete w.cfg.titulo
            const span = pnWidgetEl(w)?.querySelector(".pnWTitulo")
            if (span) span.textContent = w.cfg.titulo || t.nombre
            aside.querySelector(".pnAjCab small").textContent = w.cfg.titulo || t.nombre
            pnGuardar()
        }
        if (campo === "w" || campo === "h") {
            w[campo] = Number(e.target.value)
            const el = pnWidgetEl(w)
            if (el) pnAplicarTamano(el, w)
            const etiqueta = cuerpo.querySelector(`[data-valor="${campo}"]`)
            if (etiqueta) etiqueta.textContent = campo === "w" ? `${w.w} de ${PN_COLUMNAS}` : `${w.h} filas`
            pnGuardar()
        }
    })
    cuerpo.addEventListener("click", (e) => {
        const cab = e.target.closest("[data-cab]")
        if (cab) {
            const control = controlesCabecera()[Number(cab.dataset.cab)]
            if (control?._cab.abrir) control._cab.abrir(cab)
            else if (control && cab.dataset.valor !== control._cab.valor) control._cab.alElegir(cab.dataset.valor)
            return
        }
        const accion = e.target.closest("[data-accion]")?.dataset.accion
        const panel = pnPanelActivo()
        if (!accion || !panel) return
        if (accion === "duplicar") {
            if (!pnCabeWidget(panel)) return
            const copia = { ...w, id: pnNuevoId("w"), cfg: { ...w.cfg } }
            panel.widgets.splice(panel.widgets.indexOf(w) + 1, 0, copia)
            pnGuardar()
            pnRenderCuerpo()
            pnAbrirAjustes(copia)
        }
        if (accion === "restablecer") {
            const conservar = ["titulo", "activo", "texto"]
            Object.keys(w.cfg).forEach((k) => {
                if (!conservar.includes(k)) delete w.cfg[k]
            })
            pnGuardar()
            pnPintarWidget(w)
            pintar()
        }
        if (accion === "quitar") {
            pnCerrarAjustes(aside)
            panel.widgets.splice(panel.widgets.indexOf(w), 1)
            if (!panel.widgets.length) _pnGaleria = true
            pnGuardar()
            pnRenderCuerpo()
        }
    })
}

// Ajustes del panel entero: la rejilla y unas cuantas acciones.
const PN_AJUSTES_PANEL = [
    {
        titulo: "Rejilla",
        campos: [
            {
                clave: "fila",
                tipo: "seg",
                etiqueta: "Alto de fila",
                ayuda: "Cambia la altura de todos los widgets a la vez, sin tocar su tamaño en filas.",
                opciones: [
                    { valor: "44", texto: "Compacta" },
                    { valor: "56", texto: "Normal" },
                    { valor: "72", texto: "Amplia" }
                ],
                defecto: "56"
            },
            {
                clave: "hueco",
                tipo: "seg",
                etiqueta: "Separación",
                opciones: [
                    { valor: "4", texto: "Mínima" },
                    { valor: "10", texto: "Normal" },
                    { valor: "18", texto: "Amplia" }
                ],
                defecto: "10"
            },
            { clave: "bordes", tipo: "check", etiqueta: "Bordes de los widgets", defecto: true },
            { clave: "cabeceras", tipo: "check", etiqueta: "Cabeceras de los widgets", defecto: true }
        ]
    }
]

function pnFila(panel = pnPanelActivo()) {
    return Number(pnOpcion(panel?.cfg || {}, "fila", ["44", "56", "72"], String(PN_FILA)))
}

function pnHueco(panel = pnPanelActivo()) {
    return Number(pnOpcion(panel?.cfg || {}, "hueco", ["4", "10", "18"], String(PN_HUECO)))
}

/** Aplica a la rejilla las opciones del panel (alto de fila, separación…). */
function pnAplicarRejilla(grid, panel) {
    const cfg = panel.cfg || {}
    grid.style.setProperty("--pn-fila", pnFila(panel) + "px")
    grid.style.setProperty("--pn-hueco", pnHueco(panel) + "px")
    grid.classList.toggle("pnSinBordes", !pnSi(cfg, "bordes"))
    grid.classList.toggle("pnSinCabeceras", !pnSi(cfg, "cabeceras"))
}

function pnAbrirAjustesPanel() {
    const panel = pnPanelActivo()
    if (!panel) return
    panel.cfg = panel.cfg || {}
    const aside = pnCrearAside("p:" + panel.id, "Ajustes del panel", panel.nombre)
    if (!aside) return
    aside._panel = panel
    const cuerpo = aside.querySelector(".pnAjCuerpo")

    const general = () => `
        <section class="pnAjSeccion">
            <h4>General</h4>
            <label class="pnAjCampo"><span class="pnAjEtiqueta">Nombre</span>
                <input type="text" class="pnAjTexto" data-campo="nombre" maxlength="60" value="${escapeAttr(panel.nombre)}">
            </label>
        </section>`
    const pie = () => `
        <section class="pnAjSeccion pnAjAcciones">
            <button type="button" class="pnBtn" data-accion="duplicar">Duplicar panel</button>
            <button type="button" class="pnBtn" data-accion="exportar">Exportar</button>
            <button type="button" class="pnBtn pnPeligro" data-accion="borrar">Borrar panel</button>
        </section>`

    const pintar = () => {
        pnPintarSecciones(cuerpo, PN_AJUSTES_PANEL, panel.cfg, aplicar, general())
        cuerpo.insertAdjacentHTML("beforeend", pie())
    }
    function aplicar(clave, valor) {
        if (valor === undefined) delete panel.cfg[clave]
        else panel.cfg[clave] = valor
        pnGuardar()
        // La rejilla se ajusta sin repintar los widgets: los gráficos de
        // TradingView no se recargan y el mapa se recoloca solo al cambiar de
        // tamaño.
        const grid = document.getElementById("pnGrid")
        if (grid) pnAplicarRejilla(grid, panel)
        pintar()
    }
    pintar()

    cuerpo.addEventListener("input", (e) => {
        if (e.target.dataset.campo !== "nombre") return
        const valor = e.target.value.trim()
        if (!valor) return
        panel.nombre = valor.slice(0, 60)
        aside.querySelector(".pnAjCab small").textContent = panel.nombre
        const tab = document.querySelector(`.pnTab[data-panel="${CSS.escape(panel.id)}"] .pnTabNombre`)
        if (tab) tab.textContent = panel.nombre
        pnGuardar()
    })
    cuerpo.addEventListener("click", (e) => {
        const accion = e.target.closest("[data-accion]")?.dataset.accion
        if (accion === "duplicar") {
            if (_pnConfig.paneles.length >= 20) {
                window.showToast?.("Ya tienes 20 paneles", { type: "warning" })
                return
            }
            const copia = {
                id: pnNuevoId("p"),
                nombre: `${panel.nombre} (copia)`.slice(0, 60),
                cfg: { ...panel.cfg },
                widgets: panel.widgets.map((w) => ({ ...w, id: pnNuevoId("w"), cfg: { ...w.cfg } }))
            }
            _pnConfig.paneles.splice(_pnConfig.paneles.indexOf(panel) + 1, 0, copia)
            _pnConfig.activo = copia.id
            pnCerrarAjustes(aside)
            pnGuardar()
            pnRenderTabs()
            pnRenderCuerpo()
        }
        if (accion === "exportar") pnExportar([panel])
        if (accion === "borrar") {
            pnCerrarAjustes(aside)
            pnBorrarPanel(panel.id)
        }
    })
}

// ── Widget: mapa de calor ───────────────────────────────────────────────────

/**
 * Los dos mapas comparten el dibujo y se diferencian en la pregunta: el de la
 * cuenta es «cómo va mi dinero» (tamaño por posición, euros movidos, «desde la
 * compra»); el de mercado, «cómo se mueven los activos» (todos del mismo
 * tamaño, con su precio, y admite lo que no está en la cartera).
 */
function pnDefectosMapa(w) {
    const mercado = w.tipo === "mapaMercado"
    return {
        mercado,
        tamano: mercado ? "igual" : "valor",
        eur: !mercado,
        precio: mercado,
        periodos: mercado ? PN_PERIODOS.filter((p) => p.valor !== "todo") : PN_PERIODOS
    }
}

function pnPeriodoMapa(w) {
    return pnOpcion(
        w.cfg,
        "periodo",
        pnDefectosMapa(w).periodos.map((p) => p.valor),
        "dia"
    )
}

function pnPintarMapa(w, cuerpo, ctrls) {
    const turno = pnTurno(w)
    const cfg = w.cfg
    const def = pnDefectosMapa(w)
    const periodo = pnPeriodoMapa(w)
    const tamano = pnOpcion(cfg, "tamano", ["valor", "igual"], def.tamano)

    ctrls.innerHTML = ""
    const chipActivos = document.createElement("button")
    chipActivos.type = "button"
    chipActivos.className = "pnChip"
    const textoChip = () => pnTextoFiltro(cfg, def.mercado ? "Todos los activos" : "Toda la cartera")
    chipActivos.innerHTML = `<span>${escapeHtml(textoChip())}</span><span class="pnChipFlecha">▾</span>`
    pnControlCabecera(chipActivos, "Activos", (ancla) =>
        pnSelectorActivos(ancla, {
            opciones: pnTodosLosActivos().filter((a) => !a.oculto || cfg.ocultos === true),
            seleccion: pnLista(cfg, "activos"),
            alCambiar: (ids) => {
                if (ids.length) cfg.activos = ids
                else delete cfg.activos
                pnGuardar()
                // El selector sigue abierto: se repinta el mapa y el texto del
                // chip, no la cabecera entera (cerraría el menú).
                clearTimeout(_pnTimers.get(w.id))
                _pnTimers.set(
                    w.id,
                    setTimeout(() => {
                        pnDibujarMapa(w, cuerpo)
                        chipActivos.querySelector("span").textContent = textoChip()
                        pnRefrescarCabeceraAjustes(w)
                    }, 120)
                )
            }
        })
    )
    ctrls.appendChild(chipActivos)
    pnChip(
        ctrls,
        def.periodos.find((p) => p.valor === periodo).texto,
        def.periodos,
        periodo,
        (v) => {
            if (v === "dia") delete cfg.periodo
            else cfg.periodo = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Periodo"
    )
    pnChip(
        ctrls,
        tamano === "igual" ? "Mismo tamaño" : "Por valor",
        [
            { valor: "valor", texto: "Tamaño por valor de la posición" },
            { valor: "igual", texto: "Todos del mismo tamaño" }
        ],
        tamano,
        (v) => {
            if (v === def.tamano) delete cfg.tamano
            else cfg.tamano = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Tamaño"
    )

    const leyenda = pnSi(cfg, "leyenda", false)
    cuerpo.innerHTML = `<div class="pnMapa${leyenda ? " pnConLeyenda" : ""}"></div>${
        leyenda ? `<div class="pnMapaLeyenda"><span></span><i></i><span></span></div>` : ""
    }`
    const lienzo = cuerpo.querySelector(".pnMapa")
    pnBindMapa(lienzo)

    const dibujar = () => pnDibujarMapa(w, cuerpo)
    if (periodo !== "dia" && periodo !== "todo" && !_pnHist[periodo]) {
        lienzo.innerHTML = `<div class="pnVacio">Cargando histórico…</div>`
        pnHistorico(periodo).then(() => {
            if (!pnVigente(w, turno)) return
            dibujar()
            pnObservarTamano(w, cuerpo, dibujar)
        })
        return
    }
    dibujar()
    pnObservarTamano(w, cuerpo, dibujar)
}

function pnEscalaMapa(cfg, periodo) {
    const escala = pnOpcion(cfg, "escala", ["auto", "1", "3", "10", "25", "50"], "auto")
    return escala === "auto" ? PN_ESCALA[periodo] : Number(escala)
}

function pnDibujarMapa(w, cuerpo) {
    const lienzo = cuerpo.querySelector(".pnMapa")
    if (!lienzo) return
    const cfg = w.cfg
    const periodo = pnPeriodoMapa(w)
    const def = pnDefectosMapa(w)
    const igual = pnOpcion(cfg, "tamano", ["valor", "igual"], def.tamano) === "igual"
    const agrupar = pnOpcion(cfg, "agrupar", ["no", "tipo", "divisa"], "no")
    const hist = _pnHist[periodo]?.data || {}
    const escala = pnEscalaMapa(cfg, periodo)

    const leyenda = cuerpo.querySelector(".pnMapaLeyenda")
    if (leyenda) {
        const [min, max] = leyenda.querySelectorAll("span")
        min.textContent = `−${escala} %`
        max.textContent = `+${escala} %`
    }

    let items = pnActivosDelWidget(cfg, { soloPosiciones: false })
    if (!def.mercado && !pnLista(cfg, "activos").length) items = items.filter((a) => a.conPosicion)
    // Por valor, lo que no tiene posición no tiene tamaño: se queda fuera y se
    // avisa, en vez de pintar una baldosa con un tamaño inventado.
    const sinPosicion = igual ? 0 : items.filter((a) => !(a.netoEur > 0.01)).length
    if (!igual) items = items.filter((a) => a.netoEur > 0.01)

    if (!items.length) {
        lienzo.innerHTML = `<div class="pnVacio">${
            sinPosicion
                ? "Los activos elegidos no tienen posición: cambia a «Mismo tamaño»"
                : def.mercado
                  ? "Elige activos o busca tickers en «Todos los activos»"
                  : "No hay activos para mostrar"
        }</div>`
        return
    }

    const W = lienzo.clientWidth || 400
    const H = lienzo.clientHeight || 300
    const total = items.reduce((s, a) => s + (igual ? 1 : a.netoEur), 0)

    const enriquecidos = items.map((a) => {
        let valor
        if (periodo === "dia") valor = a.dia
        else if (periodo === "todo") valor = a.invertidoEur > 0 ? a.rendPct : null
        else valor = hist[a.id] ?? null
        const hay = valor !== null && valor !== undefined && Number.isFinite(valor)
        const peso = (igual ? 1 : a.netoEur) / total
        return {
            ...a,
            valor: hay ? valor : null,
            peso,
            mov: hay && a.netoEur > 0 ? hmMovimiento(a.netoEur, valor) : null
        }
    })

    lienzo.innerHTML = ""

    if (agrupar === "no") {
        pnBaldosas(lienzo, enriquecidos, { x: 0, y: 0, w: W, h: H }, cfg, periodo, escala, def)
        return
    }

    // Agrupado: primero se reparte el lienzo entre los grupos y luego cada
    // grupo entre sus activos. Cada grupo lleva una franja con su nombre y su
    // variación media ponderada por peso.
    const claveGrupo = (a) => (agrupar === "tipo" ? a.tipo : a.currency || "EUR")
    const nombreGrupo = (k) => (agrupar === "tipo" ? buildAssetTypeLabel(k) : k)
    const grupos = new Map()
    enriquecidos.forEach((a) => {
        const k = claveGrupo(a)
        if (!grupos.has(k)) grupos.set(k, [])
        grupos.get(k).push(a)
    })
    const lista = [...grupos].map(([k, miembros]) => {
        const peso = miembros.reduce((s, a) => s + a.peso, 0)
        const conValor = miembros.filter((a) => a.valor !== null)
        const pesoValor = conValor.reduce((s, a) => s + a.peso, 0)
        const media = pesoValor > 0 ? conValor.reduce((s, a) => s + a.valor * a.peso, 0) / pesoValor : null
        return { id: k, nombre: nombreGrupo(k), miembros, peso, media, area: peso * W * H }
    })
    lista.sort((a, b) => b.area - a.area)

    hmSquarify(lista, 0, 0, W, H).forEach((g) => {
        const franja = g.h > 46 && g.w > 50 ? 16 : 0
        if (franja) {
            const cab = document.createElement("div")
            cab.className = "pnGrupo"
            cab.style.cssText = `left:${g.x + 2}px;top:${g.y}px;width:${Math.max(g.w - 4, 0)}px`
            cab.innerHTML = `<span>${escapeHtml(g.nombre)}</span>${
                g.media !== null ? `<b class="${pnClaseSigno(g.media)}">${pnPct(g.media)}</b>` : ""
            }`
            lienzo.appendChild(cab)
        }
        pnBaldosas(lienzo, g.miembros, { x: g.x, y: g.y + franja, w: g.w, h: g.h - franja }, cfg, periodo, escala, def)
    })
}

/** Reparte un rectángulo entre activos y pinta sus baldosas. */
function pnBaldosas(lienzo, items, caja, cfg, periodo, escala, def = {}) {
    if (caja.w < 2 || caja.h < 2 || !items.length) return
    const peso = items.reduce((s, a) => s + a.peso, 0) || 1
    const conArea = items
        .map((a) => ({ ...a, area: (a.peso / peso) * caja.w * caja.h }))
        .sort((a, b) => b.area - a.area)
    const rects = hmSquarify(conArea, caja.x, caja.y, caja.w, caja.h)
    const hueco = 2
    const porNombre = cfg.etiqueta === "nombre"
    const verPct = pnSi(cfg, "pct")
    const verEur = pnSi(cfg, "eur", def.eur ?? true)
    const verPrecio = pnSi(cfg, "precio", def.precio ?? false)

    rects.forEach((r) => {
        const cw = Math.max(r.w - hueco, 2)
        const ch = Math.max(r.h - hueco, 2)
        const cel = document.createElement("div")
        cel.className = "pnCelda"
        cel.dataset.activo = r.id
        cel.style.cssText = `left:${r.x + hueco / 2}px;top:${r.y + hueco / 2}px;width:${cw}px;height:${ch}px;background:${pnColorMapa(r.valor, escala)}`
        cel._pn = { ...r, periodo }

        const rotulo = porNombre ? r.nombre : r.simbolo || r.nombre
        let html = ""
        if (cw >= 22 && ch >= 16) {
            html += `<span class="pnCeldaSimbolo" style="font-size:${hmFontSize(cw, ch, rotulo)}px">${escapeHtml(rotulo)}</span>`
        }
        let lineas = 0
        if (verPct && ch >= 38 && cw >= 44) {
            html += `<span class="pnCeldaPct">${r.valor === null ? "N/D" : (r.valor >= 0 ? "▲ " : "▼ ") + pnPct(Math.abs(r.valor), false)}</span>`
            lineas++
        }
        if (verEur && ch >= 54 + lineas * 16 && cw >= 70 && r.mov !== null) {
            html += `<span class="pnCeldaMov pnMoney">${pnEurFirmado(r.mov)}</span>`
            lineas++
        }
        if (verPrecio && ch >= 54 + lineas * 16 && cw >= 70 && r.precio > 0) {
            html += `<span class="pnCeldaMov">${escapeHtml(pnPrecio(r))}</span>`
        }
        cel.innerHTML = html
        lienzo.appendChild(cel)
    })
}

function pnColorMapa(pct, escala) {
    if (pct === null || pct === undefined || Math.abs(pct) < escala / 250) return hmNeutralColor()
    const t = Math.min(Math.abs(pct) / escala, 1)
    return pct > 0 ? hmBlend("#a5d6a7", "#43a047", "#1b5e20", t) : hmBlend("#ef9a9a", "#e53935", "#b71c1c", t)
}

function pnBindMapa(lienzo) {
    lienzo.addEventListener("mousemove", (e) => {
        const tip = hmGetTooltip()
        const d = e.target.closest(".pnCelda")?._pn
        if (!d) {
            tip.classList.remove("hmTooltipVisible")
            return
        }
        const fila = (l, v, cls = "", dinero = false) =>
            `<span class="hmTipLabel">${l}</span><span class="hmTipVal ${dinero ? "hmTipMoneyVal" : ""} ${cls}">${v}</span>`
        const cls = d.valor === null ? "" : d.valor < 0 ? "hmTipNeg" : d.valor > 0 ? "hmTipPos" : ""
        const periodo = PN_PERIODOS.find((p) => p.valor === d.periodo)?.texto || ""
        tip.innerHTML = `
            <div class="hmTipName">${escapeHtml(d.nombre)}</div>
            <div class="hmTipDivider"></div>
            <div class="hmTipGrid">
                ${d.precio > 0 ? fila("Precio", pnPrecio(d)) : ""}
                ${fila(periodo, d.valor === null ? "sin dato" : pnPct(d.valor), cls)}
                ${d.mov !== null ? fila("Movimiento", pnEurFirmado(d.mov), cls, true) : ""}
                ${d.netoEur > 0 ? fila("Valor", pnEur(d.netoEur), "", true) : ""}
                ${d.invertidoEur > 0 ? fila("Rendimiento", `${pnEurFirmado(d.rendEur)} (${pnPct(d.rendPct)})`, pnClaseSigno(d.rendEur).replace("pn", "hmTip"), true) : ""}
                ${fila("Peso", pnPct(d.peso * 100, false))}
            </div>`
        tip.classList.add("hmTooltipVisible")
        const r = tip.getBoundingClientRect()
        let x = e.clientX + 12
        let y = e.clientY + 12
        if (x + r.width > window.innerWidth - 4) x = e.clientX - r.width - 12
        if (y + r.height > window.innerHeight - 4) y = e.clientY - r.height - 12
        tip.style.left = Math.max(4, x) + "px"
        tip.style.top = Math.max(4, y) + "px"
    })
    lienzo.addEventListener("mouseleave", () => hmGetTooltip().classList.remove("hmTooltipVisible"))
    lienzo.addEventListener("click", (e) => {
        const d = e.target.closest(".pnCelda")?._pn
        if (!d) return
        hmGetTooltip().classList.remove("hmTooltipVisible")
        pnSeleccionarActivo(d.id)
    })
}

// ── Widget: gráfico de TradingView ──────────────────────────────────────────

function pnTvUrl(simbolo, cfg) {
    const claro = document.documentElement.getAttribute("data-theme") === "light"
    const zona = pnOpcion(cfg, "zona", ["local", "exchange", "utc"], "local")
    const p = new URLSearchParams({
        symbol: simbolo,
        interval: pnOpcion(
            cfg,
            "intervalo",
            PN_INTERVALOS.map((i) => i.valor),
            "D"
        ),
        theme: claro ? "light" : "dark",
        style: pnOpcion(cfg, "estilo", ["1", "9", "8", "0", "2", "3"], "1"),
        locale: "es",
        timezone:
            zona === "utc"
                ? "Etc/UTC"
                : zona === "exchange"
                  ? "exchange"
                  : Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC",
        // Con guion bajo: widgetembed ignora en silencio las variantes sin él
        // (hidesidetoolbar, hidevolume…), comprobado contra TradingView.
        hide_side_toolbar: pnSi(cfg, "herramientas", false) ? "0" : "1",
        hide_top_toolbar: pnSi(cfg, "barraSuperior") ? "0" : "1",
        hide_volume: pnSi(cfg, "volumen") ? "0" : "1",
        symboledit: "1",
        saveimage: "0",
        // Los indicadores van como objetos {id}: la lista de textos la acepta
        // pero falla con «cannot_get_metainfo» y no pinta ninguno.
        studies: JSON.stringify(
            pnLista(cfg, "estudios")
                .filter((s) => PN_ESTUDIOS.some((e) => e.valor === s))
                .map((id) => ({ id }))
        ),
        toolbarbg: claro ? "f1f5f9" : "111827"
    })
    return `https://www.tradingview.com/widgetembed/?${p.toString()}`
}

function pnPintarGrafico(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const intervalo = pnOpcion(
        cfg,
        "intervalo",
        PN_INTERVALOS.map((i) => i.valor),
        "D"
    )
    // Sin activo elegido, el de más peso de la cartera.
    const porDefecto = [...pnPosiciones()].sort((a, b) => b.netoEur - a.netoEur)[0]
    const activo = pnBuscarActivo(cfg.activo) || porDefecto || null

    ctrls.innerHTML = ""
    pnChipActivo(ctrls, w, activo)

    pnSegmentado(
        ctrls,
        PN_INTERVALOS,
        intervalo,
        (v) => {
            if (v === "D") delete cfg.intervalo
            else cfg.intervalo = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Intervalo"
    )

    if (!activo?.tv) {
        cuerpo.innerHTML = `<div class="pnVacio">Elige un activo para ver su gráfico</div>`
        return
    }
    cuerpo.innerHTML = `
        <iframe class="pnIframe" src="${escapeAttr(pnTvUrl(activo.tv, cfg))}" frameborder="0" allowtransparency="true" scrolling="no" allowfullscreen
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer" title="${escapeAttr("Gráfico de " + activo.nombre)}"></iframe>`
}

function pnMenuActivoGrafico(anchor, w) {
    const contenido = document.createElement("div")
    contenido.className = "pnSel"
    contenido.innerHTML = `
        <label class="pnSelBuscarCaja">${PN_LUPA}<input class="pnSelBuscar" type="search" placeholder="Buscar en tu cartera o en el mercado…" data-no-custom></label>
        <div class="pnSelLista"></div>`
    const buscar = contenido.querySelector(".pnSelBuscar")
    const lista = contenido.querySelector(".pnSelLista")
    const opciones = pnTodosLosActivos().filter((a) => a.tv && !a.oculto)
    let resultados = null
    let buscado = ""
    let timer = null

    const fila = (id, nombre, simbolo, tipo, activa) => `
        <button type="button" class="pnPopItem${activa ? " active" : ""}" data-valor="${escapeAttr(id)}">
            <span class="pnPunto" style="background:${escapeAttr(pnColorTipo(tipo))}"></span>
            <span class="pnSelNombre">${escapeHtml(nombre)}</span>
            <span class="pnSelSimbolo">${escapeHtml(simbolo)}</span>
        </button>`

    const pintar = () => {
        const q = buscar.value.trim()
        const ql = q.toLowerCase()
        const visibles = opciones.filter(
            (o) =>
                !ql ||
                o.nombre.toLowerCase().includes(ql) ||
                String(o.simbolo || "")
                    .toLowerCase()
                    .includes(ql)
        )
        let html = visibles.length ? `<div class="pnSelGrupo"><span>Tus activos</span></div>` : ""
        html += visibles.map((o) => fila(o.id, o.nombre, o.tv, o.tipo, o.id === w.cfg.activo)).join("")
        if (q.length >= 2) {
            html += `<div class="pnSelGrupo"><span>En el mercado</span></div>`
            if (resultados === "cargando" || buscado !== q) {
                html += `<div class="pnVacio">Buscando «${escapeHtml(q)}»…</div>`
            } else if (resultados.length) {
                html += resultados.map((r) => fila(r.id, r.nombre, r.simbolo, r.tipo, r.id === w.cfg.activo)).join("")
            } else {
                html += `<div class="pnVacio">TradingView no encuentra «${escapeHtml(q)}»</div>`
            }
            // Un símbolo escrito a mano, tal cual, por si la búsqueda no lo da.
            html += `<button type="button" class="pnPopItem pnSelLibre" data-valor="${escapeAttr("tv:" + q.toUpperCase())}">Abrir <b>${escapeHtml(q.toUpperCase())}</b> tal cual en TradingView</button>`
        }
        lista.innerHTML = html || `<div class="pnVacio">Escribe para buscar en el mercado</div>`
    }

    const elegir = (valor) => {
        pnCerrarMenu()
        w.cfg.activo = valor
        pnGuardar()
        pnPintarWidget(w)
    }
    lista.addEventListener("click", (e) => {
        const btn = e.target.closest(".pnPopItem")
        if (btn) elegir(btn.dataset.valor)
    })
    buscar.addEventListener("input", () => {
        const q = buscar.value.trim()
        clearTimeout(timer)
        pintar()
        if (q.length < 2) return
        // Se busca al dejar de escribir, no con cada letra.
        timer = setTimeout(async () => {
            buscado = q
            resultados = "cargando"
            const encontrados = await pnBuscarTickers(q)
            if (buscado !== q || buscar.value.trim() !== q) return
            resultados = encontrados || []
            pintar()
        }, 350)
    })
    buscar.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return
        const primero = lista.querySelector(".pnPopItem")
        if (primero) elegir(primero.dataset.valor)
    })
    pintar()
    pnMenu(anchor, [], null, { contenido, ancho: 360, clase: "pnPopSel" })
    setTimeout(() => buscar.focus(), 0)
}

// ── Widgets de TradingView embebidos ────────────────────────────────────────
//
// Instrumento, análisis técnico, ficha, perfil, noticias y calendario son los
// widgets públicos de TradingView. Se cargan por URL en un iframe (la
// configuración va en el fragmento, tras «#»), que es lo que permite la CSP:
// frame-src ya admite s.tradingview.com y no hace falta cargar su script.

const PN_EMBEBIDOS = {
    instrumento: "mini-symbol-overview",
    tecnico: "technical-analysis",
    ficha: "symbol-info",
    perfil: "symbol-profile",
    noticias: "timeline",
    calendario: "events"
}

const PN_RANGOS_INSTRUMENTO = [
    { valor: "1D", texto: "1D" },
    { valor: "1M", texto: "1M" },
    { valor: "3M", texto: "3M" },
    { valor: "12M", texto: "1A" },
    { valor: "60M", texto: "5A" },
    { valor: "ALL", texto: "Todo" }
]

const PN_INTERVALOS_TECNICO = [
    { valor: "1m", texto: "1 minuto" },
    { valor: "5m", texto: "5 minutos" },
    { valor: "15m", texto: "15 minutos" },
    { valor: "1h", texto: "1 hora" },
    { valor: "4h", texto: "4 horas" },
    { valor: "1D", texto: "1 día" },
    { valor: "1W", texto: "1 semana" },
    { valor: "1M", texto: "1 mes" }
]

const PN_PAISES = [
    { valor: "us", texto: "EE. UU." },
    { valor: "eu", texto: "Eurozona" },
    { valor: "es", texto: "España" },
    { valor: "de", texto: "Alemania" },
    { valor: "fr", texto: "Francia" },
    { valor: "it", texto: "Italia" },
    { valor: "gb", texto: "Reino Unido" },
    { valor: "jp", texto: "Japón" },
    { valor: "cn", texto: "China" }
]

const PN_IMPORTANCIAS = [
    { valor: "-1,0,1", texto: "Todas" },
    { valor: "0,1", texto: "Media y alta" },
    { valor: "1", texto: "Solo alta" }
]

/** El activo de un widget que sigue a uno: el elegido o, si no, el de más peso. */
function pnActivoDeWidget(w) {
    const porDefecto = [...pnPosiciones()].sort((a, b) => b.netoEur - a.netoEur)[0]
    return pnBuscarActivo(w.cfg.activo) || porDefecto || null
}

function pnChipActivo(ctrls, w, activo) {
    const chip = document.createElement("button")
    chip.type = "button"
    chip.className = "pnChip pnChipActivo"
    chip.innerHTML = `<span>${escapeHtml(activo ? activo.nombre : "Elegir activo")}</span>${
        activo?.tv ? `<small>${escapeHtml(activo.tv)}</small>` : ""
    }<span class="pnChipFlecha">▾</span>`
    pnControlCabecera(chip, "Activo", (ancla) => pnMenuActivoGrafico(ancla, w))
    ctrls.appendChild(chip)
}

function pnPintarEmbebido(w, cuerpo, ctrls) {
    const turno = pnTurno(w)
    const cfg = w.cfg
    const claro = document.documentElement.getAttribute("data-theme") === "light"
    const base = {
        width: "100%",
        height: "100%",
        colorTheme: claro ? "light" : "dark",
        isTransparent: true,
        autosize: true
    }
    const delActivo = w.tipo !== "calendario" && !(w.tipo === "noticias" && cfg.modo !== "activo")
    // Las noticias de este widget no existen en español: con locale=es falla
    // con «Algo ha ido mal». En inglés cargan.
    let locale = "es"

    ctrls.innerHTML = ""
    const activo = delActivo ? pnActivoDeWidget(w) : null
    if (delActivo) pnChipActivo(ctrls, w, activo)

    const cambiar = (clave, defecto) => (v) => {
        if (v === defecto) delete cfg[clave]
        else cfg[clave] = v
        pnGuardar()
        pnPintarWidget(w)
    }

    let config
    switch (w.tipo) {
        case "instrumento": {
            const rango = pnOpcion(
                cfg,
                "rango",
                PN_RANGOS_INSTRUMENTO.map((r) => r.valor),
                "12M"
            )
            pnSegmentado(ctrls, PN_RANGOS_INSTRUMENTO, rango, cambiar("rango", "12M"), "Rango")
            config = { ...base, symbol: activo?.tv, dateRange: rango, chartOnly: !pnSi(cfg, "cabecera") }
            break
        }
        case "tecnico": {
            const intervalo = pnOpcion(
                cfg,
                "intervalo",
                PN_INTERVALOS_TECNICO.map((i) => i.valor),
                "1D"
            )
            pnChip(
                ctrls,
                PN_INTERVALOS_TECNICO.find((i) => i.valor === intervalo).texto,
                PN_INTERVALOS_TECNICO,
                intervalo,
                cambiar("intervalo", "1D"),
                "Intervalo"
            )
            config = {
                ...base,
                symbol: activo?.tv,
                interval: intervalo,
                showIntervalTabs: pnSi(cfg, "pestanas"),
                displayMode: pnOpcion(cfg, "detalle", ["single", "multiple"], "single")
            }
            break
        }
        case "ficha":
        case "perfil":
            config = { ...base, symbol: activo?.tv }
            break
        case "noticias": {
            const modo = pnOpcion(cfg, "modo", ["general", "activo"], "general")
            ctrls.insertBefore(document.createElement("span"), ctrls.firstChild).remove()
            pnSegmentado(
                ctrls,
                [
                    { valor: "general", texto: "Mercado" },
                    { valor: "activo", texto: "Del activo" }
                ],
                modo,
                cambiar("modo", "general"),
                "Noticias"
            )
            locale = "en"
            config = {
                ...base,
                feedMode: modo === "activo" ? "symbol" : "all_symbols",
                ...(modo === "activo" ? { symbol: activo?.tv } : {}),
                displayMode: pnSi(cfg, "compacta", false) ? "compact" : "regular"
            }
            break
        }
        case "calendario": {
            const importancia = pnOpcion(
                cfg,
                "importancia",
                PN_IMPORTANCIAS.map((i) => i.valor),
                "-1,0,1"
            )
            pnChip(
                ctrls,
                PN_IMPORTANCIAS.find((i) => i.valor === importancia).texto,
                PN_IMPORTANCIAS,
                importancia,
                cambiar("importancia", "-1,0,1"),
                "Importancia"
            )
            const paises = pnLista(cfg, "paises").filter((p) => PN_PAISES.some((x) => x.valor === p))
            config = {
                ...base,
                importanceFilter: importancia,
                countryFilter: (paises.length ? paises : PN_PAISES.map((p) => p.valor)).join(",")
            }
            break
        }
    }

    if (delActivo && !activo?.tv) {
        cuerpo.innerHTML = `<div class="pnVacio">Elige un activo</div>`
        return
    }
    const montar = (cfgFinal) => {
        // El símbolo va también en la consulta, como lo pone el script
        // oficial: la ficha y el perfil solo lo leen de ahí y, si falta,
        // enseñan Apple sin avisar.
        const consulta = new URLSearchParams({ locale })
        if (cfgFinal.symbol) consulta.set("symbol", cfgFinal.symbol)
        const url = `https://s.tradingview.com/embed-widget/${PN_EMBEBIDOS[w.tipo]}/?${consulta}#${encodeURIComponent(JSON.stringify(cfgFinal))}`
        cuerpo.innerHTML = `
        <iframe class="pnIframe pnIframeWidget" src="${escapeAttr(url)}" frameborder="0" allowtransparency="true" scrolling="no"
            sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            referrerpolicy="no-referrer" title="${escapeAttr(PN_TIPOS[w.tipo].nombre)}"></iframe>`
    }

    // La ficha y el perfil necesitan el símbolo con su mercado: con «NVDA» a
    // secas TradingView no da error, enseña Apple. Se busca el mercado una vez.
    if ((w.tipo === "ficha" || w.tipo === "perfil") && !String(activo.tv).includes(":")) {
        cuerpo.innerHTML = `<div class="pnVacio">Buscando ${escapeHtml(activo.tv)}…</div>`
        pnSimboloConMercado(activo.tv).then((completo) => {
            if (!pnVigente(w, turno)) return
            if (completo) montar({ ...config, symbol: completo })
            else
                cuerpo.innerHTML = `<div class="pnVacio">TradingView no encuentra el mercado de «${escapeHtml(activo.tv)}». Elige el activo con su mercado (por ejemplo NASDAQ:${escapeHtml(activo.tv)}).</div>`
        })
        return
    }
    montar(config)
}

const _pnSimbolosCompletos = new Map()

/**
 * «NVDA» → «NASDAQ:NVDA», con la búsqueda de TradingView: el primer resultado
 * cuyo símbolo sea exactamente ese. Sin coincidencia exacta, null: mejor
 * avisar que enseñar otra empresa.
 */
async function pnSimboloConMercado(simbolo) {
    const clave = String(simbolo).toUpperCase()
    if (_pnSimbolosCompletos.has(clave)) return _pnSimbolosCompletos.get(clave)
    const resultados = (await pnBuscarTickers(clave)) || []
    const exacto = resultados.find((r) => r.simbolo.split(":").pop() === clave)
    const completo = exacto ? exacto.simbolo : null
    _pnSimbolosCompletos.set(clave, completo)
    return completo
}

// ── Widget: tu cartera ──────────────────────────────────────────────────────

const PN_COLUMNAS_CARTERA = [
    { clave: "nombre", texto: "Instrumento", izquierda: true },
    { clave: "participaciones", texto: "Posición" },
    { clave: "precio", texto: "Último precio" },
    { clave: "precioMedio", texto: "Precio medio" },
    { clave: "dia", texto: "Hoy" },
    { clave: "hoyEur", texto: "Hoy €", dinero: true },
    { clave: "netoEur", texto: "Valor", dinero: true },
    { clave: "invertidoEur", texto: "Invertido", dinero: true },
    { clave: "rendEur", texto: "Rend. €", dinero: true },
    { clave: "rendPct", texto: "Rend. %" },
    { clave: "peso", texto: "Peso" }
]

// Columnas que se ven en una tabla sin elegir ninguna: las de siempre.
const PN_COLUMNAS_DEFECTO = [
    "participaciones",
    "precio",
    "dia",
    "netoEur",
    "invertidoEur",
    "rendEur",
    "rendPct",
    "peso"
]

function pnPintarCartera(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const orden = PN_COLUMNAS_CARTERA.some((c) => c.clave === cfg.orden) ? cfg.orden : "netoEur"
    const dir = cfg.dir === "asc" ? 1 : -1
    const elegidas = pnLista(cfg, "columnas")
    const columnas = PN_COLUMNAS_CARTERA.filter(
        (c) => c.clave === "nombre" || (elegidas.length ? elegidas : PN_COLUMNAS_DEFECTO).includes(c.clave)
    )
    const detalle = pnSi(cfg, "detalle")

    ctrls.innerHTML = ""
    const tipos = pnLista(cfg, "tipos")
    pnChip(
        ctrls,
        pnTextoFiltro(cfg, "Todos los tipos"),
        [
            { valor: "", texto: "Todos los tipos" },
            ...PN_TIPOS_ACTIVO.map((t) => ({ ...t, marcado: tipos.includes(t.valor) }))
        ],
        tipos.length ? null : "",
        (v) => {
            const nueva = !v ? [] : tipos.includes(v) ? tipos.filter((t) => t !== v) : [...tipos, v]
            if (nueva.length) cfg.tipos = nueva
            else delete cfg.tipos
            pnGuardar()
            pnPintarWidget(w)
        },
        "Tipos"
    )

    // El peso es sobre toda la cartera, no sobre lo filtrado: «un 8 % de lo
    // que tengo», que es lo que se pregunta al mirar esa columna.
    const totalCartera = pnPosiciones().reduce((s, a) => s + a.netoEur, 0)
    const filas = pnActivosDelWidget(cfg)
        .map((a) => ({ ...a, peso: totalCartera > 0 ? (a.netoEur / totalCartera) * 100 : 0 }))
        .sort((a, b) => {
            const va = a[orden]
            const vb = b[orden]
            if (typeof va === "string") return va.localeCompare(vb) * dir
            return ((va ?? -Infinity) - (vb ?? -Infinity)) * dir
        })

    if (!filas.length) {
        cuerpo.innerHTML = `<div class="pnVacio">No hay posiciones abiertas con estos filtros</div>`
        return
    }

    const suma = (k) => filas.reduce((s, a) => s + (a[k] || 0), 0)
    const totValor = suma("netoEur")
    const totInv = suma("invertidoEur")
    const totRend = totValor - totInv
    const totHoy = suma("hoyEur")
    const totPeso = suma("peso")

    const celda = (a, c) => {
        switch (c.clave) {
            case "nombre":
                return `<td class="pnTdNombre"><div><span class="pnPunto" style="background:${escapeAttr(pnColorActivo(a))}"></span><span><b>${escapeHtml(a.nombre)}</b>${
                    detalle
                        ? `<small>${escapeHtml(buildAssetTypeLabel(a.tipo))} · ${escapeHtml(a.simbolo || "")}</small>`
                        : ""
                }</span></div></td>`
            case "participaciones":
                return `<td class="pnMoney">${escapeHtml(formatShareQuantity(a.participaciones))}</td>`
            case "precio":
                return `<td>${escapeHtml(pnPrecio(a))}</td>`
            case "precioMedio":
                return `<td class="pnMoney">${a.precioMedio > 0 ? escapeHtml(hmFormatPrice(a.precioMedio, a.currency)) : "—"}</td>`
            case "dia":
                return `<td class="${pnClaseSigno(a.dia)}">${pnPct(a.dia)}</td>`
            case "hoyEur":
                return `<td class="pnMoney ${pnClaseSigno(a.hoyEur)}">${a.hoyEur === null ? "—" : pnEurFirmado(a.hoyEur)}</td>`
            case "netoEur":
                return `<td class="pnMoney"><b>${pnEur(a.netoEur)}</b></td>`
            case "invertidoEur":
                return `<td class="pnMoney">${pnEur(a.invertidoEur)}</td>`
            case "rendEur":
                return `<td class="pnMoney ${pnClaseSigno(a.rendEur)}">${pnEurFirmado(a.rendEur)}</td>`
            case "rendPct":
                return `<td class="${pnClaseSigno(a.rendPct)}">${pnPct(a.rendPct)}</td>`
            case "peso":
                return `<td><span class="pnPeso"><span style="width:${Math.min(100, a.peso).toFixed(1)}%"></span></span>${pnPct(a.peso, false)}</td>`
        }
        return "<td></td>"
    }

    const pieCelda = (c) => {
        switch (c.clave) {
            case "nombre":
                return `<td class="pnIzq">${filas.length} posiciones</td>`
            case "hoyEur":
                return `<td class="pnMoney ${pnClaseSigno(totHoy)}">${pnEurFirmado(totHoy)}</td>`
            case "dia": {
                const base = totValor - totHoy
                return `<td class="${pnClaseSigno(totHoy)}">${base > 0 ? pnPct((totHoy / base) * 100) : "—"}</td>`
            }
            case "netoEur":
                return `<td class="pnMoney"><b>${pnEur(totValor)}</b></td>`
            case "invertidoEur":
                return `<td class="pnMoney">${pnEur(totInv)}</td>`
            case "rendEur":
                return `<td class="pnMoney ${pnClaseSigno(totRend)}">${pnEurFirmado(totRend)}</td>`
            case "rendPct":
                return `<td class="${pnClaseSigno(totRend)}">${totInv > 0 ? pnPct((totRend / totInv) * 100) : "—"}</td>`
            case "peso":
                return `<td>${pnPct(totPeso, false)}</td>`
        }
        return "<td></td>"
    }

    cuerpo.innerHTML = `
        <div class="pnTablaWrap">
            <table class="pnTabla${pnSi(cfg, "compacta", false) ? " pnCompacta" : ""}">
                <thead><tr>${columnas
                    .map(
                        (c) =>
                            `<th data-orden="${c.clave}" class="${c.izquierda ? "pnIzq" : ""}${c.clave === orden ? " pnOrdenado" : ""}">${escapeHtml(c.texto)}${
                                c.clave === orden ? (dir > 0 ? " ▲" : " ▼") : ""
                            }</th>`
                    )
                    .join("")}</tr></thead>
                <tbody>${filas
                    .map(
                        (a) => `<tr data-activo="${escapeAttr(a.id)}">${columnas.map((c) => celda(a, c)).join("")}</tr>`
                    )
                    .join("")}</tbody>
                ${pnSi(cfg, "totales") ? `<tfoot><tr>${columnas.map(pieCelda).join("")}</tr></tfoot>` : ""}
            </table>
        </div>`

    cuerpo.querySelector("thead").addEventListener("click", (e) => {
        const th = e.target.closest("th[data-orden]")
        if (!th) return
        if (cfg.orden === th.dataset.orden || (!cfg.orden && th.dataset.orden === "netoEur")) {
            cfg.dir = cfg.dir === "asc" ? "desc" : "asc"
        } else {
            cfg.orden = th.dataset.orden
            cfg.dir = th.dataset.orden === "nombre" ? "asc" : "desc"
        }
        pnGuardar()
        pnPintarWidget(w)
    })
    cuerpo.querySelector("tbody").addEventListener("click", (e) => {
        const tr = e.target.closest("tr[data-activo]")
        if (tr) pnSeleccionarActivo(tr.dataset.activo)
    })
}

// ── Widget: favoritos ───────────────────────────────────────────────────────

function pnPintarFavoritos(w, cuerpo, ctrls) {
    const cfg = w.cfg

    ctrls.innerHTML = ""
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "pnChip"
    btn.innerHTML = `<span>${pnLista(cfg, "activos").length ? "Editar lista" : "Elegir activos"}</span><span class="pnChipFlecha">▾</span>`
    pnControlCabecera(btn, "Activos", (ancla) =>
        pnSelectorActivos(ancla, {
            opciones: pnTodosLosActivos().filter((a) => !a.oculto || cfg.ocultos === true),
            seleccion: pnLista(cfg, "activos"),
            alCambiar: (ids) => {
                if (ids.length) cfg.activos = ids
                else delete cfg.activos
                pnGuardar()
                pnListaFavoritos(w, cuerpo)
            }
        })
    )
    ctrls.appendChild(btn)
    pnListaFavoritos(w, cuerpo)
}

function pnListaFavoritos(w, cuerpo) {
    const cfg = w.cfg
    // Sin lista propia: todo lo de la cartera que no esté oculto, también lo
    // que solo se sigue (activos sin compras), en el orden de la barra lateral.
    const items = pnActivosDelWidget(cfg, { soloPosiciones: false })
    const orden = pnOpcion(cfg, "orden", ["manual", "sube", "baja", "nombre"], "manual")
    const dia = (a) => (Number.isFinite(a.dia) ? a.dia : null)
    if (orden === "sube") items.sort((a, b) => (dia(b) ?? -Infinity) - (dia(a) ?? -Infinity))
    if (orden === "baja") items.sort((a, b) => (dia(a) ?? Infinity) - (dia(b) ?? Infinity))
    if (orden === "nombre") items.sort((a, b) => a.nombre.localeCompare(b.nombre))

    if (!items.length) {
        cuerpo.innerHTML = `<div class="pnVacio">Pulsa «Elegir activos» para montar tu lista</div>`
        return
    }
    const verPrecio = pnSi(cfg, "precio")
    const verVar = pnSi(cfg, "variacion")
    const verPos = pnSi(cfg, "posicion", false)
    const verLogo = pnSi(cfg, "logo")

    cuerpo.innerHTML = `<div class="pnLista${pnSi(cfg, "compacta", false) ? " pnCompacta" : ""}">${items
        .map(
            (a) => `
            <button type="button" class="pnFila" data-activo="${escapeAttr(a.id)}">
                ${verLogo ? `<span class="pnFilaLogo" style="background:${escapeAttr(pnColorActivo(a))}">${escapeHtml(String(a.simbolo || a.nombre).slice(0, 1))}</span>` : ""}
                <span class="pnFilaNombre"><b>${escapeHtml(a.nombre)}</b><small>${escapeHtml(a.simbolo || "")}</small></span>
                ${verPos && a.netoEur > 0 ? `<span class="pnFilaPrecio pnMoney"><b>${pnEur(a.netoEur)}</b><small class="${pnClaseSigno(a.rendEur)}">${pnPct(a.rendPct)}</small></span>` : ""}
                ${
                    verPrecio || verVar
                        ? `<span class="pnFilaPrecio">${verPrecio ? `<b>${escapeHtml(pnPrecio(a))}</b>` : ""}${
                              verVar ? `<small class="${pnClaseSigno(a.dia)}">${pnPct(a.dia)}</small>` : ""
                          }</span>`
                        : ""
                }
            </button>`
        )
        .join("")}</div>`
    cuerpo.querySelector(".pnLista").addEventListener("click", (e) => {
        const fila = e.target.closest(".pnFila")
        if (fila) pnSeleccionarActivo(fila.dataset.activo)
    })
}

// ── Widget: tu rendimiento ──────────────────────────────────────────────────

function pnPintarRendimiento(w, cuerpo, ctrls) {
    const turno = pnTurno(w)
    const cfg = w.cfg
    const rango = pnOpcion(
        cfg,
        "rango",
        PN_RANGOS.map((r) => r.valor),
        "3M"
    )
    const ganancia = cfg.modo === "ganancia"
    const verInvertido = !ganancia && pnSi(cfg, "invertido")
    const relleno = pnSi(cfg, "relleno")
    const cabecera = pnSi(cfg, "cabecera")

    ctrls.innerHTML = ""
    pnSegmentado(
        ctrls,
        PN_RANGOS,
        rango,
        (v) => {
            if (v === "3M") delete cfg.rango
            else cfg.rango = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Rango"
    )

    cuerpo.innerHTML = `
        <div class="pnRend">
            <div class="pnRendCab"${cabecera ? "" : " hidden"}>
                <span class="pnRendValor pnMoney">—</span>
                <span class="pnRendCambio pnMoney"></span>
            </div>
            <div class="pnRendLienzo"><canvas></canvas></div>
        </div>`

    fetch(`/api/portfolio/history?range=${encodeURIComponent(rango)}`)
        .then((r) => r.json())
        .then((data) => {
            if (!pnVigente(w, turno)) return
            let puntos = Array.isArray(data.data) ? data.data : []

            // El último punto es el valor de ahora mismo, para que la línea
            // acabe donde dicen los demás widgets (los snapshots son periódicos).
            const pos = pnPosiciones()
            const vivo = pos.reduce((s, a) => s + a.netoEur, 0)
            const invVivo = pos.reduce((s, a) => s + a.invertidoEur, 0)
            const ahora = Math.floor(Date.now() / 1000)
            if (pos.length) {
                const ultimo = puntos[puntos.length - 1]
                const punto = { ts: ahora, v: vivo, i: invVivo }
                puntos = ultimo && ahora - ultimo.ts < 120 ? [...puntos.slice(0, -1), punto] : [...puntos, punto]
            }

            const cab = cuerpo.querySelector(".pnRendCab")
            cab.querySelector(".pnRendValor").textContent = ganancia
                ? pnEurFirmado(vivo - invVivo)
                : pnEur(vivo || puntos[puntos.length - 1]?.v || 0)

            if (puntos.length < 2) {
                cuerpo.querySelector(".pnRendLienzo").innerHTML =
                    `<div class="pnVacio">Aún no hay historial para este periodo</div>`
                return
            }

            // Lo que ha ganado la cartera en el periodo, sin contar lo que se ha
            // metido o sacado: la diferencia de las ganancias, no de los valores.
            const primero = puntos[0]
            const ultimo = puntos[puntos.length - 1]
            const cambioEur = ultimo.v - ultimo.i - (primero.v - primero.i)
            const base = primero.v > 0 ? primero.v : primero.i
            const cambio = cab.querySelector(".pnRendCambio")
            cambio.className = "pnRendCambio pnMoney " + pnClaseSigno(cambioEur)
            cambio.textContent = `${pnEurFirmado(cambioEur)} (${base > 0 ? pnPct((cambioEur / base) * 100) : "—"}) · ${
                PN_RANGOS.find((r) => r.valor === rango).texto
            }`

            const acento = pnVarCss("--accent", "#3b82f6")
            const tenue = pnVarCss("--text-dim", "#64748b")
            const rejilla = pnVarCss("--border-soft", "#1e2d45")
            const fecha = (ts) => {
                const d = new Date(ts * 1000)
                return rango === "1M" || rango === "3M"
                    ? d.toLocaleDateString(_nl(), { day: "numeric", month: "short" })
                    : d.toLocaleDateString(_nl(), { month: "short", year: "2-digit" })
            }
            const canvas = cuerpo.querySelector("canvas")
            const ctx = canvas.getContext("2d")
            const degradado = ctx.createLinearGradient(0, 0, 0, canvas.parentElement.clientHeight || 200)
            const hex = /^#[0-9a-f]{6}$/i.test(acento) ? acento : "#3b82f6"
            degradado.addColorStop(0, hex + "55")
            degradado.addColorStop(1, hex + "00")

            const datasets = [
                {
                    label: ganancia ? "Ganancia" : "Valor",
                    data: puntos.map((p) => (ganancia ? p.v - p.i : p.v)),
                    borderColor: acento,
                    backgroundColor: degradado,
                    fill: relleno,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.25
                }
            ]
            if (verInvertido) {
                datasets.push({
                    label: "Invertido",
                    data: puntos.map((p) => p.i),
                    borderColor: tenue,
                    borderDash: [4, 4],
                    borderWidth: 1.25,
                    pointRadius: 0,
                    fill: false
                })
            }

            const chart = new Chart(canvas, {
                type: "line",
                data: { labels: puntos.map((p) => fecha(p.ts)), datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    animation: false,
                    interaction: { mode: "index", intersect: false },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (c) =>
                                    `${c.dataset.label}: ${ganancia ? pnEurFirmado(c.parsed.y) : pnEur(c.parsed.y)}`
                            }
                        }
                    },
                    scales: {
                        x: { ticks: { color: tenue, maxTicksLimit: 6, maxRotation: 0 }, grid: { display: false } },
                        y: {
                            position: "right",
                            ticks: {
                                color: tenue,
                                maxTicksLimit: 5,
                                callback: (v) => new Intl.NumberFormat(_nl(), { notation: "compact" }).format(v) + " €"
                            },
                            grid: { color: rejilla }
                        }
                    }
                }
            })
            _pnCharts.set(w.id, chart)
        })
        .catch((error) => {
            console.error("Paneles: historial", error)
            cuerpo.querySelector(".pnRendLienzo").innerHTML =
                `<div class="pnVacio">No se pudo cargar el historial</div>`
        })
}

// ── Widget: distribución ────────────────────────────────────────────────────

function pnPintarDistribucion(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const por = pnOpcion(cfg, "por", ["tipo", "activo", "divisa"], "tipo")
    const forma = pnOpcion(cfg, "forma", ["anillo", "tarta", "barras"], "anillo")
    const maximo = Number(pnOpcion(cfg, "maximo", ["0", "5", "8", "12"], "0"))
    const verLeyenda = pnSi(cfg, "leyenda")
    const verImportes = pnSi(cfg, "importes", false)

    ctrls.innerHTML = ""
    pnSegmentado(
        ctrls,
        [
            { valor: "tipo", texto: "Tipo" },
            { valor: "activo", texto: "Activo" },
            { valor: "divisa", texto: "Divisa" }
        ],
        por,
        (v) => {
            if (v === "tipo") delete cfg.por
            else cfg.por = v
            pnGuardar()
            pnPintarWidget(w)
        },
        "Agrupar por"
    )

    const pos = pnActivosDelWidget(cfg)
    const total = pos.reduce((s, a) => s + a.netoEur, 0)
    if (!pos.length || total <= 0) {
        cuerpo.innerHTML = `<div class="pnVacio">No hay posiciones abiertas con estos filtros</div>`
        return
    }

    let partes
    if (por === "activo") {
        partes = pos.map((a) => ({ nombre: a.nombre, valor: a.netoEur, color: pnColorActivo(a), id: a.id }))
    } else {
        const clave = (a) => (por === "tipo" ? a.tipo : a.currency || "EUR")
        const grupos = new Map()
        pos.forEach((a) => grupos.set(clave(a), (grupos.get(clave(a)) || 0) + a.netoEur))
        partes = [...grupos].map(([k, valor]) => ({
            nombre: por === "tipo" ? buildAssetTypeLabel(k) : k,
            valor,
            color:
                por === "tipo" ? pnColorTipo(k) : typeof mPaletteForName === "function" ? mPaletteForName(k) : "#64748b"
        }))
    }
    partes.sort((a, b) => b.valor - a.valor)
    if (maximo && partes.length > maximo) {
        const resto = partes.slice(maximo - 1)
        partes = [
            ...partes.slice(0, maximo - 1),
            { nombre: `Otros (${resto.length})`, valor: resto.reduce((s, p) => s + p.valor, 0), color: "#64748b" }
        ]
    }

    const leyenda = verLeyenda
        ? `<div class="pnDistLeyenda">${partes
              .map(
                  (p) => `<div class="pnDistFila"${p.id ? ` data-activo="${escapeAttr(p.id)}"` : ""}>
                    <span class="pnPunto" style="background:${escapeAttr(p.color)}"></span>
                    <span class="pnDistNombre">${escapeHtml(p.nombre)}</span>
                    ${verImportes ? `<span class="pnDistPct pnMoney">${pnEur(p.valor)}</span>` : ""}
                    <span class="pnDistPct">${pnPct((p.valor / total) * 100, false)}</span>
                </div>`
              )
              .join("")}</div>`
        : ""

    if (forma === "barras") {
        const mayor = partes[0].valor
        cuerpo.innerHTML = `<div class="pnBarras">${partes
            .map(
                (p) => `<div class="pnBarra"${p.id ? ` data-activo="${escapeAttr(p.id)}"` : ""}>
                    <span class="pnBarraNombre">${escapeHtml(p.nombre)}</span>
                    <span class="pnBarraPista"><span style="width:${((p.valor / mayor) * 100).toFixed(1)}%;background:${escapeAttr(p.color)}"></span></span>
                    <span class="pnDistPct">${verImportes ? `<span class="pnMoney">${pnEur(p.valor)}</span> · ` : ""}${pnPct((p.valor / total) * 100, false)}</span>
                </div>`
            )
            .join("")}</div>`
    } else {
        cuerpo.innerHTML = `
            <div class="pnDist${verLeyenda ? "" : " pnSinLeyenda"}">
                <div class="pnDistLienzo"><canvas></canvas>${
                    forma === "anillo"
                        ? `<div class="pnDistCentro"><small>Total</small><b class="pnMoney">${pnEur(total)}</b></div>`
                        : ""
                }</div>
                ${leyenda}
            </div>`

        const chart = new Chart(cuerpo.querySelector("canvas"), {
            type: "doughnut",
            data: {
                labels: partes.map((p) => p.nombre),
                datasets: [
                    {
                        data: partes.map((p) => p.valor),
                        backgroundColor: partes.map((p) => p.color),
                        borderColor: pnVarCss("--bg-panel", "#0f1724"),
                        borderWidth: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                cutout: forma === "anillo" ? "68%" : 0,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => `${c.label}: ${pnEur(c.parsed)} (${pnPct((c.parsed / total) * 100, false)})`
                        }
                    }
                }
            }
        })
        _pnCharts.set(w.id, chart)
    }

    cuerpo.addEventListener("click", (e) => {
        const fila = e.target.closest("[data-activo]")
        if (fila) pnSeleccionarActivo(fila.dataset.activo)
    })
}

// ── Widget: resumen ─────────────────────────────────────────────────────────

function pnPintarResumen(w, cuerpo, ctrls) {
    const cfg = w.cfg
    ctrls.innerHTML = ""
    const pos = pnActivosDelWidget(cfg)
    if (!pos.length) {
        cuerpo.innerHTML = `<div class="pnVacio">No hay posiciones abiertas con estos filtros</div>`
        return
    }
    const bloques = pnLista(cfg, "bloques").length ? pnLista(cfg, "bloques") : ["total", "kpis", "movers"]
    const cuantos = Number(pnOpcion(cfg, "cuantos", ["3", "5", "10"], "3"))
    const filtrado = pnLista(cfg, "activos").length || pnLista(cfg, "tipos").length

    const valor = pos.reduce((s, a) => s + a.netoEur, 0)
    const invertido = pos.reduce((s, a) => s + a.invertidoEur, 0)
    const rend = valor - invertido
    const hoy = pos.reduce((s, a) => s + (a.hoyEur || 0), 0)
    const baseHoy = valor - hoy

    const conDia = pos.filter((a) => a.dia !== null && Number.isFinite(a.dia)).sort((a, b) => b.dia - a.dia)
    const suben = conDia.filter((a) => a.dia > 0).slice(0, cuantos)
    const bajan = conDia
        .filter((a) => a.dia < 0)
        .reverse()
        .slice(0, cuantos)

    const mover = (a) => `
        <button type="button" class="pnMover" data-activo="${escapeAttr(a.id)}">
            <span class="pnMoverNombre">${escapeHtml(a.nombre)}</span>
            <span class="${pnClaseSigno(a.dia)}">${pnPct(a.dia)}</span>
        </button>`

    cuerpo.innerHTML = `
        <div class="pnResumen">
            ${
                bloques.includes("total")
                    ? `<div class="pnResumenTotal">
                <small>${filtrado ? `Valor · ${escapeHtml(pnTextoFiltro(cfg))}` : "Valor de la cartera"}</small>
                <b class="pnMoney">${pnEur(valor)}</b>
                <span class="pnMoney ${pnClaseSigno(hoy)}">${pnEurFirmado(hoy)} (${baseHoy > 0 ? pnPct((hoy / baseHoy) * 100) : "—"}) hoy</span>
            </div>`
                    : ""
            }
            ${
                bloques.includes("kpis")
                    ? `<div class="pnKpis">
                <div class="pnKpi"><small>Invertido</small><b class="pnMoney">${pnEur(invertido)}</b></div>
                <div class="pnKpi"><small>Rendimiento</small><b class="pnMoney ${pnClaseSigno(rend)}">${pnEurFirmado(rend)}</b><span class="${pnClaseSigno(rend)}">${invertido > 0 ? pnPct((rend / invertido) * 100) : "—"}</span></div>
            </div>`
                    : ""
            }
            ${
                bloques.includes("movers")
                    ? `<div class="pnMovers">
                <div><small>Suben hoy</small>${suben.map(mover).join("") || `<span class="pnTenue">—</span>`}</div>
                <div><small>Bajan hoy</small>${bajan.map(mover).join("") || `<span class="pnTenue">—</span>`}</div>
            </div>`
                    : ""
            }
        </div>`
    cuerpo.querySelector(".pnResumen").addEventListener("click", (e) => {
        const btn = e.target.closest("[data-activo]")
        if (btn) pnSeleccionarActivo(btn.dataset.activo)
    })
}

// ── Widget: notas ───────────────────────────────────────────────────────────

function pnPintarNotas(w, cuerpo, ctrls) {
    ctrls.innerHTML = ""
    const letra = pnOpcion(w.cfg, "letra", ["s", "m", "l"], "m")
    cuerpo.innerHTML = `<textarea class="pnNotas pnLetra-${letra}${pnSi(w.cfg, "mono", false) ? " pnMono" : ""}" maxlength="5000" placeholder="Ideas, niveles a vigilar, recordatorios…"></textarea>`
    const area = cuerpo.querySelector("textarea")
    area.value = w.cfg.texto || ""
    area.addEventListener("input", () => {
        w.cfg.texto = area.value
        pnGuardar()
    })
}

// Ajustes de los widgets de mercado e información. Va al final porque usa las
// listas de opciones de sus widgets (rangos, intervalos, países), declaradas
// más arriba con `const`: antes de ellas, la carga del fichero se cortaba aquí.
const PN_CAMPO_VINCULAR = {
    clave: "vincular",
    tipo: "check",
    etiqueta: "Enlazado con el panel",
    ayuda: "Al pulsar un activo en otro widget, se abre aquí.",
    defecto: true
}

Object.assign(PN_AJUSTES, {
    // El mapa de mercado: las mismas opciones con otros valores por defecto
    // (baldosas iguales, precio en vez de euros) y sin «desde la compra».
    mapaMercado: PN_AJUSTES.mapa.map((seccion) => ({
        ...seccion,
        campos: seccion.campos.map((c) => {
            if (c.clave === "activos")
                return {
                    ...c,
                    ayuda: "Sin elegir ninguno, todos los de la cartera. Escribe en el buscador para añadir cualquier ticker del mercado."
                }
            if (c.clave === "periodo") return { ...c, opciones: PN_PERIODOS.filter((p) => p.valor !== "todo") }
            if (c.clave === "tamano") return { ...c, defecto: "igual" }
            if (c.clave === "eur") return { ...c, defecto: false }
            if (c.clave === "precio") return { ...c, defecto: true }
            return c
        })
    })),
    instrumento: [
        {
            titulo: "Instrumento",
            campos: [
                { clave: "rango", tipo: "seg", etiqueta: "Periodo", opciones: PN_RANGOS_INSTRUMENTO, defecto: "12M" },
                { clave: "cabecera", tipo: "check", etiqueta: "Precio y variación encima", defecto: true },
                PN_CAMPO_VINCULAR
            ]
        }
    ],
    tecnico: [
        {
            titulo: "Análisis técnico",
            campos: [
                {
                    clave: "intervalo",
                    tipo: "seg",
                    etiqueta: "Intervalo",
                    opciones: PN_INTERVALOS_TECNICO,
                    defecto: "1D"
                },
                {
                    clave: "detalle",
                    tipo: "seg",
                    etiqueta: "Indicadores",
                    opciones: [
                        { valor: "single", texto: "Solo el resumen" },
                        { valor: "multiple", texto: "Osciladores y medias" }
                    ],
                    defecto: "single"
                },
                { clave: "pestanas", tipo: "check", etiqueta: "Pestañas de intervalo", defecto: true },
                PN_CAMPO_VINCULAR
            ]
        }
    ],
    ficha: [{ titulo: "Ficha", campos: [PN_CAMPO_VINCULAR] }],
    perfil: [{ titulo: "Perfil", campos: [PN_CAMPO_VINCULAR] }],
    noticias: [
        {
            titulo: "Noticias",
            campos: [
                {
                    clave: "modo",
                    tipo: "seg",
                    etiqueta: "Qué noticias",
                    ayuda: "Vienen en inglés: TradingView no ofrece este widget en español.",
                    opciones: [
                        { valor: "general", texto: "Del mercado" },
                        { valor: "activo", texto: "Del activo" }
                    ],
                    defecto: "general"
                },
                { clave: "compacta", tipo: "check", etiqueta: "Solo titulares", defecto: false },
                { ...PN_CAMPO_VINCULAR, ayuda: "Con «Del activo», sigue al activo que se pulse en otro widget." }
            ]
        }
    ],
    calendario: [
        {
            titulo: "Calendario",
            campos: [
                {
                    clave: "importancia",
                    tipo: "seg",
                    etiqueta: "Importancia",
                    opciones: PN_IMPORTANCIAS,
                    defecto: "-1,0,1"
                },
                {
                    clave: "paises",
                    tipo: "multi",
                    etiqueta: "Países",
                    ayuda: "Sin marcar ninguno se muestran todos los de la lista.",
                    opciones: PN_PAISES
                }
            ]
        }
    ]
})

// ── Sentimiento de mercado ──────────────────────────────────────────────────
//
// Los mismos datos que Activos > Sentimiento (/api/market/pulse): miedo y
// codicia, amplitud, índices, sectores y los rankings del escáner. Se piden una
// vez por visita y los comparten todos los widgets; ↻ los vuelve a pedir. Las
// filas y tarjetas se pintan con las mismas funciones de sentimiento.js, así
// que se ven igual que en esa página.

let _pnPulso = null
const _pnUniversos = {}

function pnCargarPulso() {
    if (!_pnPulso) {
        _pnPulso = fetch("/api/market/pulse")
            .then((r) => r.json())
            .then((d) => (d.ok ? d : Promise.reject(new Error(d.error || "Sin datos"))))
            .catch((error) => {
                _pnPulso = null
                throw error
            })
    }
    return _pnPulso
}

function pnCargarUniverso(clave) {
    if (clave === "sp500") return pnCargarPulso().then((d) => smSectoresToUniverseRows(d.snapshot?.sectores))
    if (!_pnUniversos[clave]) {
        _pnUniversos[clave] = fetch(`/api/market/pulse/universe?type=${encodeURIComponent(clave)}`)
            .then((r) => r.json())
            .then((d) => (d.ok ? d.items || [] : Promise.reject(new Error(d.error || "Sin datos"))))
            .catch((error) => {
                delete _pnUniversos[clave]
                throw error
            })
    }
    return _pnUniversos[clave]
}

function pnOlvidarPulso() {
    _pnPulso = null
    Object.keys(_pnUniversos).forEach((k) => delete _pnUniversos[k])
}

/** Pinta cuando llegan los datos, si el widget sigue en pantalla. */
function pnConPulso(w, cuerpo, pintar, cargar = pnCargarPulso) {
    const turno = pnTurno(w)
    cuerpo.innerHTML = `<div class="pnVacio">Cargando…</div>`
    cargar()
        .then((datos) => {
            if (pnVigente(w, turno)) pintar(datos)
        })
        .catch((error) => {
            if (pnVigente(w, turno))
                cuerpo.innerHTML = `<div class="pnVacio">No se pudieron cargar los datos: ${escapeHtml(error.message)}</div>`
        })
}

function pnCambiarOpcion(w, clave, defecto) {
    return (v) => {
        if (v === defecto) delete w.cfg[clave]
        else w.cfg[clave] = v
        pnGuardar()
        pnPintarWidget(w)
    }
}

const PN_RANGOS_FG = [
    { valor: "1M", texto: "1M", dias: 30 },
    { valor: "3M", texto: "3M", dias: 90 },
    { valor: "6M", texto: "6M", dias: 180 },
    { valor: "1A", texto: "1A", dias: 365 }
]

/** Semicírculo de miedo y codicia: los tramos de color y la aguja. */
function pnIndicadorFgSvg(valor) {
    const punto = (v, r) => {
        const a = Math.PI - (v / 100) * Math.PI
        return [100 + r * Math.cos(a), 100 - r * Math.sin(a)]
    }
    // Los mismos cortes que colorean la página de Sentimiento.
    const tramos = [
        [0, 24],
        [25, 44],
        [45, 55],
        [56, 75],
        [76, 100]
    ]
    const arcos = tramos
        .map(([desde, hasta]) => {
            const [x1, y1] = punto(desde + 0.8, 80)
            const [x2, y2] = punto(hasta - 0.8, 80)
            return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A80 80 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${smFgZoneColor((desde + hasta) / 2)}" />`
        })
        .join("")
    const [nx, ny] = punto(valor, 64)
    return `<svg class="pnFgArco" viewBox="0 0 200 112" aria-hidden="true">
        <g fill="none" stroke-width="14">${arcos}</g>
        <line x1="100" y1="100" x2="${nx.toFixed(1)}" y2="${ny.toFixed(1)}" class="pnFgAguja" />
        <circle cx="100" cy="100" r="6" class="pnFgEje" />
    </svg>`
}

function pnPintarMiedoCodicia(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const vista = pnOpcion(cfg, "vista", ["completo", "indicador", "historial"], "completo")
    const rango = PN_RANGOS_FG.find((r) => r.valor === cfg.rango) || PN_RANGOS_FG[1]
    const conHistorial = vista !== "indicador"

    ctrls.innerHTML = ""
    if (conHistorial) pnSegmentado(ctrls, PN_RANGOS_FG, rango.valor, pnCambiarOpcion(w, "rango", "3M"), "Rango")

    pnConPulso(w, cuerpo, (d) => {
        const fg = d.fearGreed
        const historia = Array.isArray(d.fearGreedHistory) ? d.fearGreedHistory : []
        let html = `<div class="pnFg pnFg-${vista}">`
        if (vista !== "historial") {
            if (fg) {
                const valor = Math.max(0, Math.min(100, Number(fg.valor)))
                const color = smFgZoneColor(valor)
                html += `<div class="pnFgIndicador">
                    ${pnIndicadorFgSvg(valor)}
                    <b style="color:${color};text-shadow:0 0 22px ${color}77">${valor}</b>
                    <span>${escapeHtml(smFearGreedLabel(fg.clasificacion))}</span>
                </div>`
            } else {
                html += `<div class="pnVacio">Sin dato de miedo y codicia</div>`
            }
        }
        if (conHistorial && pnSi(cfg, "datos") && historia.length) {
            html += `<div class="smFgStatsStrip pnFgDatos">${smFgStatsStripHtml(historia)}</div>`
        }
        if (conHistorial) {
            html += historia.length
                ? `<div class="pnFgLienzo"><canvas></canvas></div>`
                : `<div class="pnVacio">Sin historial</div>`
        }
        cuerpo.innerHTML = html + "</div>"

        if (!conHistorial || !historia.length) return
        // La fuente da el más reciente primero; el gráfico va en orden de fechas.
        const tramo = historia.slice(0, rango.dias).reverse()
        const valores = tramo.map((p) => p.valor)
        const tenue = pnVarCss("--text-dim", "#64748b")
        const chart = new Chart(cuerpo.querySelector("canvas"), {
            type: "line",
            data: {
                labels: tramo.map((p) => smFgDateLabel(p.timestamp)),
                datasets: [
                    {
                        data: valores,
                        borderWidth: 2,
                        pointRadius: 0,
                        tension: 0.25,
                        fill: true,
                        backgroundColor: smFgAreaGradient(smFgZoneColor(valores[valores.length - 1])),
                        segment: { borderColor: (c) => smFgZoneColor((c.p0.parsed.y + c.p1.parsed.y) / 2) }
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: "index", intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: (c) => ` ${c.parsed.y} · ${smFearGreedLabel(tramo[c.dataIndex]?.clasificacion)}`
                        }
                    }
                },
                scales: {
                    x: { ticks: { color: tenue, maxTicksLimit: 5, maxRotation: 0 }, grid: { display: false } },
                    y: {
                        min: 0,
                        max: 100,
                        position: "right",
                        ticks: { color: tenue, stepSize: 25 },
                        grid: { color: pnVarCss("--border-soft", "#1e2d45") }
                    }
                }
            }
        })
        _pnCharts.set(w.id, chart)
    })
}

function pnPintarAmplitud(w, cuerpo, ctrls) {
    ctrls.innerHTML = ""
    pnConPulso(w, cuerpo, (d) => {
        const b = d.breadth
        if (!b || !b.total) {
            cuerpo.innerHTML = `<div class="pnVacio">Sin datos de amplitud ahora mismo</div>`
            return
        }
        const pct = (b.subidas / b.total) * 100
        const color = pct >= 60 ? "#4ade80" : pct <= 40 ? "#f87171" : "#cbd5e1"
        const filas = [
            { texto: "Suben", valor: b.subidas, cls: "smLegendPos" },
            { texto: "Bajan", valor: b.bajadas, cls: "smLegendNeg" },
            { texto: "Planas", valor: b.planas, cls: "smLegendNd" }
        ]
        cuerpo.innerHTML = `
            <div class="pnAmplitud">
                <div class="pnDistLienzo"><canvas></canvas>
                    <div class="pnDistCentro"><b style="color:${color};font-size:1.3rem">${Math.round(pct)}%</b><small>suben</small></div>
                </div>
                <div class="pnAmplitudTexto">
                    <b>${escapeHtml(smBreadthLabel(b.subidas, b.bajadas, b.total))}</b>
                    ${
                        pnSi(w.cfg, "leyenda")
                            ? filas
                                  .map(
                                      (f) =>
                                          `<div class="smLegendRow"><span class="smLegendDot ${f.cls}"></span><span>${f.texto}</span><span class="smLegendCount">${f.valor}</span></div>`
                                  )
                                  .join("")
                            : ""
                    }
                    <small>${b.total} valores</small>
                </div>
            </div>`
        const chart = new Chart(cuerpo.querySelector("canvas"), {
            type: "doughnut",
            data: {
                labels: filas.map((f) => f.texto),
                datasets: [
                    {
                        data: filas.map((f) => f.valor),
                        backgroundColor: ["#2ecc71", "#e74c3c", "#64748b"],
                        borderColor: pnVarCss("--bg-panel", "#0f1724"),
                        borderWidth: 2,
                        spacing: 2
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                cutout: "72%",
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: { label: (c) => ` ${c.label}: ${c.raw} (${((c.raw / b.total) * 100).toFixed(1)} %)` }
                    }
                }
            }
        })
        _pnCharts.set(w.id, chart)
    })
}

function pnPintarIndices(w, cuerpo, ctrls) {
    ctrls.innerHTML = ""
    const elegidos = pnLista(w.cfg, "grupos")
    pnConPulso(w, cuerpo, (d) => {
        const indices = Array.isArray(d.snapshot?.indices) ? d.snapshot.indices : []
        const porClave = new Map(indices.map((i) => [i.key, i]))
        const html = SM_INDEX_GROUPS.filter((g) => !elegidos.length || elegidos.includes(g.label))
            .map((g) => {
                const tarjetas = g.keys
                    .map((k) => porClave.get(k))
                    .filter(Boolean)
                    .map(smIndexCardHtml)
                    .join("")
                return tarjetas
                    ? `<div class="smIndexGroup"><span class="smIndexGroupLabel">${escapeHtml(g.label)}</span><div class="smIndexCards">${tarjetas}</div></div>`
                    : ""
            })
            .join("")
        cuerpo.innerHTML = `<div class="pnIndices">${html || `<div class="pnVacio">Sin datos de índices ahora mismo</div>`}</div>`
        cuerpo.querySelector(".pnIndices").addEventListener("click", (e) => {
            const tarjeta = e.target.closest(".smIndexCard")
            if (tarjeta?.dataset.symbol) pnSeleccionarActivo("tv:" + tarjeta.dataset.symbol)
        })
    })
}

const PN_UNIVERSOS = [
    { valor: "sp500", texto: "S&P 500" },
    { valor: "nasdaq100", texto: "Nasdaq 100" },
    { valor: "cripto", texto: "Cripto" }
]

function pnPintarSectores(w, cuerpo, ctrls) {
    const cfg = w.cfg
    const universo = pnOpcion(
        cfg,
        "universo",
        PN_UNIVERSOS.map((u) => u.valor),
        "sp500"
    )
    ctrls.innerHTML = ""
    pnSegmentado(ctrls, PN_UNIVERSOS, universo, pnCambiarOpcion(w, "universo", "sp500"), "Universo")

    pnConPulso(
        w,
        cuerpo,
        (filas) => {
            const validas = (filas || []).filter((f) => f.size > 0)
            if (!validas.length) {
                cuerpo.innerHTML = `<div class="pnVacio">Sin datos ahora mismo</div>`
                return
            }
            cuerpo.innerHTML = `<div class="pnMapa"></div>`
            const lienzo = cuerpo.querySelector(".pnMapa")
            pnBindMapa(lienzo)
            const total = validas.reduce((s, f) => s + f.size, 0)
            const items = validas.map((f) => ({
                id: "tv:" + f.symbol,
                nombre: f.primary || f.symbol,
                simbolo: String(f.symbol || "")
                    .split(":")
                    .pop(),
                valor: Number.isFinite(f.change) ? f.change : null,
                peso: f.size / total,
                precio: Number(f.price) || 0,
                currency: f.currency || "USD",
                netoEur: 0,
                invertidoEur: 0,
                mov: null
            }))
            // Los sectores del S&P 500 se leen por su nombre («Tecnología»);
            // las acciones y las monedas, por su símbolo.
            const rotulo = cfg.etiqueta || (universo === "sp500" ? "nombre" : "simbolo")
            const dibujar = () => {
                lienzo.innerHTML = ""
                pnBaldosas(
                    lienzo,
                    items,
                    { x: 0, y: 0, w: lienzo.clientWidth || 400, h: lienzo.clientHeight || 300 },
                    { etiqueta: rotulo },
                    "dia",
                    SM_UNIVERSE_SCALE[universo] || 3,
                    { eur: false, precio: false }
                )
            }
            dibujar()
            pnObservarTamano(w, cuerpo, dibujar)
        },
        () => pnCargarUniverso(universo)
    )
}

const PN_LISTAS_ESCANER = [
    { valor: "suben", texto: "Más suben" },
    { valor: "bajan", texto: "Más bajan" },
    { valor: "sobrecompra", texto: "RSI sobrecompra" },
    { valor: "sobreventa", texto: "RSI sobreventa" },
    { valor: "volumen", texto: "Volumen inusual" }
]

function pnPintarEscaner(w, cuerpo, ctrls) {
    const lista = pnOpcion(
        w.cfg,
        "lista",
        PN_LISTAS_ESCANER.map((l) => l.valor),
        "suben"
    )
    ctrls.innerHTML = ""
    pnChip(
        ctrls,
        PN_LISTAS_ESCANER.find((l) => l.valor === lista).texto,
        PN_LISTAS_ESCANER,
        lista,
        pnCambiarOpcion(w, "lista", "suben"),
        "Lista"
    )

    pnConPulso(w, cuerpo, (d) => {
        const fuentes = {
            suben: [d.movers?.subidas, smMoverRowHtml],
            bajan: [d.movers?.bajadas, smMoverRowHtml],
            sobrecompra: [d.rsi?.sobrecompra, smRsiRowHtml],
            sobreventa: [d.rsi?.sobreventa, smRsiRowHtml],
            volumen: [d.unusualVolume, smVolumeRowHtml]
        }
        const [filas, fila] = fuentes[lista]
        const html = (filas || [])
            .map((f, i) => `<div class="pnEscFila" data-activo="${escapeAttr("tv:" + f.ticker)}">${fila(f, i)}</div>`)
            .join("")
        cuerpo.innerHTML = `<div class="pnEscaner">${html || `<div class="pnVacio">Sin datos ahora mismo</div>`}</div>`
        cuerpo.querySelector(".pnEscaner").addEventListener("click", (e) => {
            const f = e.target.closest("[data-activo]")
            if (f) pnSeleccionarActivo(f.dataset.activo)
        })
    })
}

// ── Métricas ────────────────────────────────────────────────────────────────
//
// Cualquier apartado de la página de Métricas, tal cual: no son copias, son los
// mismos elementos. La página se carga una vez, oculta, con su propio
// initMetricasLogic, y cada widget se lleva a su cuerpo el apartado que tiene
// elegido. Así los gráficos, las tablas y sus botones (rango, año, €/%…) se
// comportan igual que allí y no hay dos versiones que mantener. La pega es que
// cada apartado es un único elemento: no puede estar en dos widgets a la vez.

const PN_METRICAS = [
    { clave: "kpi:0", titulo: "Indicadores del portfolio", grupo: "Portfolio" },
    { clave: "mSectionEvolucion", titulo: "Evolución del portfolio", grupo: "Portfolio" },
    { clave: "mSectionEvolucionTipos", titulo: "Evolución por tipo de activo", grupo: "Portfolio" },
    { clave: "mSectionInvertidoPeriodo", titulo: "Invertido por periodo", grupo: "Portfolio" },
    { clave: "mSectionDistribucion", titulo: "Distribución del portfolio", grupo: "Portfolio" },
    { clave: "mSectionRendimiento", titulo: "Rendimiento por tipo y activo", grupo: "Portfolio" },
    { clave: "kpi:1", titulo: "Rentabilidad y riesgo (indicadores)", grupo: "Portfolio" },
    { clave: "mSectionRiesgo", titulo: "Rentabilidad y riesgo", grupo: "Portfolio" },
    { clave: "mSectionAnalisis", titulo: "Análisis de la cartera", grupo: "Portfolio" },
    { clave: "mSectionPosiciones", titulo: "Posiciones (tabla)", grupo: "Portfolio" },
    { clave: "kpi:2", titulo: "Ingresos pasivos (indicadores)", grupo: "Finanzas" },
    { clave: "mSectionDividendos", titulo: "Dividendos", grupo: "Finanzas" },
    { clave: "mSectionDivMensual", titulo: "Dividendos por mes", grupo: "Finanzas" },
    { clave: "mSectionIntereses", titulo: "Cuenta remunerada", grupo: "Finanzas" },
    { clave: "mSectionPasivosEvol", titulo: "Ingresos pasivos", grupo: "Finanzas" },
    { clave: "kpiRentaFija", titulo: "Renta fija (indicadores)", grupo: "Finanzas" },
    { clave: "mSectionRentaFija", titulo: "Renta fija", grupo: "Finanzas" },
    { clave: "mSectionBonos", titulo: "Bonos", grupo: "Finanzas" },
    { clave: "kpiPrivateMarket", titulo: "Mercado privado (indicadores)", grupo: "Finanzas" },
    { clave: "kpi:3", titulo: "Gastos (indicadores)", grupo: "Gastos e ingresos" },
    { clave: "mSectionGastos", titulo: "Gastos", grupo: "Gastos e ingresos" },
    { clave: "kpi:4", titulo: "Ingresos (indicadores)", grupo: "Gastos e ingresos" },
    { clave: "mSectionIngresos", titulo: "Ingresos", grupo: "Gastos e ingresos" },
    { clave: "mSectionComparativa", titulo: "Ingresos vs gastos por mes", grupo: "Gastos e ingresos" },
    { clave: "mSectionSaldoMes", titulo: "Saldo durante el mes", grupo: "Gastos e ingresos" },
    { clave: "mSectionAhorro", titulo: "Tasa de ahorro mensual", grupo: "Gastos e ingresos" },
    { clave: "kpi:5", titulo: "Resumen anual (indicadores)", grupo: "Gastos e ingresos" },
    { clave: "mSectionAnual", titulo: "Gastado vs ahorrado por año", grupo: "Gastos e ingresos" },
    { clave: "kpi:6", titulo: "Trading (indicadores)", grupo: "Trading" },
    { clave: "mSectionTradingDireccion", titulo: "Long vs short", grupo: "Trading" },
    { clave: "mSectionTradingWinLoss", titulo: "Aciertos y fallos", grupo: "Trading" },
    { clave: "mSectionTradingRendimiento", titulo: "Rendimiento neto acumulado", grupo: "Trading" }
]

let _pnMetricas = null

function pnCargarMetricas() {
    if (_pnMetricas) return _pnMetricas.listo
    const almacen = document.createElement("div")
    almacen.className = "pnMetricasAlmacen"
    almacen.setAttribute("aria-hidden", "true")
    document.getElementById("pnPage")?.appendChild(almacen)
    const estado = { almacen, piezas: new Map() }
    _pnMetricas = estado
    estado.listo = (async () => {
        const res = await fetch(`${pageHtmlPath("metricas")}?v=${PAGE_HTML_VERSION}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        almacen.innerHTML = await res.text()
        await initMetricasLogic()
        almacen.querySelectorAll(".metricasSection[id]").forEach((s) => estado.piezas.set(s.id, s))
        // Las filas con data-pn-clave van por su clave y no cuentan en el índice:
        // así las kpi:N que ya hay guardadas en los paneles siguen apuntando a la misma fila.
        almacen
            .querySelectorAll(".metricasKpiRow:not([data-pn-clave])")
            .forEach((k, i) => estado.piezas.set("kpi:" + i, k))
        almacen.querySelectorAll(".metricasKpiRow[data-pn-clave]").forEach((k) => estado.piezas.set(k.dataset.pnClave, k))
    })().catch((error) => {
        if (_pnMetricas === estado) _pnMetricas = null
        almacen.remove()
        throw error
    })
    return estado.listo
}

/** Se tira la página oculta: la próxima pintada la vuelve a montar con datos frescos. */
function pnOlvidarMetricas() {
    _pnMetricas?.almacen.remove()
    _pnMetricas = null
}

function pnMenuMetricas(anchor, w) {
    const items = []
    let grupo = ""
    PN_METRICAS.forEach((m) => {
        if (m.grupo !== grupo) {
            items.push({ cabecera: m.grupo })
            grupo = m.grupo
        }
        items.push({ valor: m.clave, texto: m.titulo, activo: m.clave === w.cfg.pieza })
    })
    pnMenu(anchor, items, (clave) => pnElegirMetrica(w, clave), { ancho: 300 })
}

function pnElegirMetrica(w, clave) {
    w.cfg.pieza = clave
    const m = PN_METRICAS.find((x) => x.clave === clave)
    // El título sigue a lo elegido mientras el usuario no haya puesto uno.
    const span = pnWidgetEl(w)?.querySelector(".pnWTitulo")
    if (span && !w.cfg.titulo && m) span.textContent = m.titulo
    pnGuardar()
    pnPintarWidget(w)
}

function pnPintarMetrica(w, cuerpo, ctrls) {
    const turno = pnTurno(w)
    const m = PN_METRICAS.find((x) => x.clave === w.cfg.pieza)
    const span = pnWidgetEl(w)?.querySelector(".pnWTitulo")
    if (span && !w.cfg.titulo && m) span.textContent = m.titulo

    ctrls.innerHTML = ""
    const chip = document.createElement("button")
    chip.type = "button"
    chip.className = "pnChip"
    chip.innerHTML = `<span>${escapeHtml(m ? "Cambiar" : "Elegir métrica")}</span><span class="pnChipFlecha">▾</span>`
    pnControlCabecera(chip, "Métrica", (ancla) => pnMenuMetricas(ancla, w))
    ctrls.appendChild(chip)

    if (!m) {
        // Sin elegir: el catálogo en el propio cuerpo, por grupos.
        let grupo = ""
        let html = ""
        PN_METRICAS.forEach((x) => {
            if (x.grupo !== grupo) {
                html += `${grupo ? "</div>" : ""}<h4>${escapeHtml(x.grupo)}</h4><div class="pnMetricasLista">`
                grupo = x.grupo
            }
            html += `<button type="button" data-pieza="${escapeAttr(x.clave)}">${escapeHtml(x.titulo)}</button>`
        })
        cuerpo.innerHTML = `<div class="pnMetricasCatalogo">${html}</div></div>`
        cuerpo.querySelector(".pnMetricasCatalogo").addEventListener("click", (e) => {
            const btn = e.target.closest("[data-pieza]")
            if (btn) pnElegirMetrica(w, btn.dataset.pieza)
        })
        return
    }

    cuerpo.innerHTML = `<div class="pnVacio">Cargando ${escapeHtml(m.titulo)}…</div>`
    pnCargarMetricas()
        .then(() => {
            if (!pnVigente(w, turno)) return
            const pieza = _pnMetricas?.piezas.get(m.clave)
            if (!pieza) {
                cuerpo.innerHTML = `<div class="pnVacio">Este apartado no existe en Métricas</div>`
                return
            }
            const otro = pieza.isConnected && pieza.closest(".pnWidget")
            if (otro && otro !== pnWidgetEl(w)) {
                cuerpo.innerHTML = `<div class="pnVacio">«${escapeHtml(m.titulo)}» ya está en otro widget de este panel. Cada apartado de Métricas solo puede estar en uno.</div>`
                return
            }
            if (pieza.classList.contains("hidden")) {
                cuerpo.innerHTML = `<div class="pnVacio">«${escapeHtml(m.titulo)}» aún no tiene datos</div>`
                return
            }
            // Métricas lo pudo dejar oculto por su filtro de categorías o
            // plegado; aquí se ve siempre entero.
            pieza.style.display = ""
            pieza.querySelectorAll(".mSectionBodyHidden").forEach((n) => n.classList.remove("mSectionBodyHidden"))
            const marco = document.createElement("div")
            marco.className = "pnMetricaMarco"
            marco.appendChild(pieza)
            cuerpo.innerHTML = ""
            cuerpo.appendChild(marco)
        })
        .catch((error) => {
            if (pnVigente(w, turno))
                cuerpo.innerHTML = `<div class="pnVacio">No se pudo cargar Métricas: ${escapeHtml(error.message)}</div>`
        })
}

// Ajustes de los widgets de sentimiento y de métricas.
Object.assign(PN_AJUSTES, {
    miedoCodicia: [
        {
            titulo: "Miedo y codicia",
            campos: [
                {
                    clave: "vista",
                    tipo: "seg",
                    etiqueta: "Qué se muestra",
                    ayuda: "Índice Fear & Greed de cripto (alternative.me), el mismo de la página de Sentimiento.",
                    opciones: [
                        { valor: "completo", texto: "Todo" },
                        { valor: "indicador", texto: "Solo el indicador" },
                        { valor: "historial", texto: "Solo el historial" }
                    ],
                    defecto: "completo"
                },
                {
                    clave: "rango",
                    tipo: "seg",
                    etiqueta: "Periodo del historial",
                    opciones: PN_RANGOS_FG,
                    defecto: "3M"
                },
                { clave: "datos", tipo: "check", etiqueta: "Hoy, ayer, semana, mes, máximo y mínimo", defecto: true }
            ]
        }
    ],
    amplitud: [
        {
            titulo: "Amplitud",
            campos: [{ clave: "leyenda", tipo: "check", etiqueta: "Suben, bajan y planas", defecto: true }]
        }
    ],
    indices: [
        {
            titulo: "Índices",
            campos: [
                {
                    clave: "grupos",
                    tipo: "multi",
                    etiqueta: "Regiones",
                    ayuda: "Sin marcar ninguna se muestran todas.",
                    opciones: SM_INDEX_GROUPS.map((g) => ({ valor: g.label, texto: g.label }))
                }
            ]
        }
    ],
    sectores: [
        {
            titulo: "Mapa",
            campos: [
                { clave: "universo", tipo: "seg", etiqueta: "Universo", opciones: PN_UNIVERSOS, defecto: "sp500" },
                {
                    clave: "etiqueta",
                    tipo: "seg",
                    etiqueta: "Rótulo",
                    ayuda: "Sin elegir: el nombre en los sectores y el símbolo en el resto.",
                    opciones: [
                        { valor: "simbolo", texto: "Símbolo" },
                        { valor: "nombre", texto: "Nombre" }
                    ]
                }
            ]
        }
    ],
    escaner: [
        {
            titulo: "Escáner",
            campos: [{ clave: "lista", tipo: "seg", etiqueta: "Lista", opciones: PN_LISTAS_ESCANER, defecto: "suben" }]
        }
    ],
    metrica: []
})
