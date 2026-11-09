// Activos > Paneles: opciones de los widgets y ventanas de ajustes.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

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
function pnActivosDelWidget(cfg, { soloPosiciones = true, porDefecto = null } = {}) {
    const elegidos = pnLista(cfg, "activos")
    let lista
    if (elegidos.length) {
        lista = elegidos.map(pnBuscarActivo).filter(Boolean)
    } else if (porDefecto) {
        // Sin elegir ninguno, el widget puede partir de otra lista que la cartera
        // (el mapa de mercado parte de la de Seguimiento).
        lista = porDefecto
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
                    clave: "forma",
                    tipo: "seg",
                    etiqueta: "Forma",
                    ayuda: "La rejilla da a cada activo la misma casilla, con su línea del día; el treemap la reparte por valor.",
                    opciones: PN_FORMAS_MAPA,
                    defecto: "rejilla"
                },
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
                    // El nombre que el usuario puso al activo («Bitcoin», «XAU») dice
                    // más que el símbolo del ticker («BTCEUR», «XAUEUR»).
                    opciones: [
                        { valor: "nombre", texto: "Nombre" },
                        { valor: "simbolo", texto: "Símbolo" }
                    ],
                    defecto: "nombre"
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
            <label class="pnAjCampo"><span class="pnAjEtiqueta">Ancho <b data-valor="w">${pnTextoTamano(w.w)} de ${PN_COLUMNAS}</b></span>
                <input type="range" class="pnAjRango" data-campo="w" min="${tw.minW}" max="${PN_COLUMNAS}" step="${1 / PN_SUBDIVISION}" value="${w.w}">
            </label>
            <label class="pnAjCampo"><span class="pnAjEtiqueta">Alto <b data-valor="h">${pnTextoTamano(w.h)} filas</b></span>
                <input type="range" class="pnAjRango" data-campo="h" min="${tw.minH}" max="${PN_ALTO_MAX}" step="${1 / PN_SUBDIVISION}" value="${w.h}">
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
            if (etiqueta)
                etiqueta.textContent =
                    campo === "w" ? `${pnTextoTamano(w.w)} de ${PN_COLUMNAS}` : `${pnTextoTamano(w.h)} filas`
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
