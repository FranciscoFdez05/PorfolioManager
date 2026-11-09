// Activos > Paneles: métricas.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

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
        almacen
            .querySelectorAll(".metricasKpiRow[data-pn-clave]")
            .forEach((k) => estado.piezas.set(k.dataset.pnClave, k))
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
