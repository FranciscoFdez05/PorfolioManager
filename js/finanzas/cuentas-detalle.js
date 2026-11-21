// ===== CUENTAS · VENTANA DE UNA CUENTA =====
// Lo que se abre desde una tarjeta de la ventana Cuentas: una sola ventana con
// pestañas.
//   · «resumen»: lo que ha entrado y salido en el periodo, de dónde, el
//     desglose del saldo y la gráfica;
//   · «todos»: todo lo que mueve la cuenta, mezclado, con el saldo tras cada uno;
//   · «ingresosGastos»: lo apuntado en Gastos e Ingresos con esta cuenta, más
//     mensualidades, recurrentes, intereses y dividendos;
//   · «movimientos»: sus transferencias, que se editan desde aquí;
//   · «graficos»: el saldo ampliado y las entradas y salidas de cada mes.
//
// Las listas vienen de /api/cuentas/<id>/movimientos, que da el saldo tras
// cada movimiento calculado en el servidor sobre todos ellos: la columna Saldo
// cuadra con el saldo de la tarjeta aunque la tabla esté filtrada.

const CNT_MESES_CORTOS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
const CNT_MESES_CLAVE = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre"
]
const CNT_PESTANAS = [
    { vista: "resumen", etiqueta: "Resumen" },
    { vista: "todos", etiqueta: "Movimientos" },
    { vista: "ingresosGastos", etiqueta: "Ingresos y gastos" },
    { vista: "movimientos", etiqueta: "Transferencias" },
    { vista: "graficos", etiqueta: "Gráficos" }
]

// Cómo se llama cada origen de movimiento y en qué página se apunta.
const CNT_ORIGENES = {
    ingreso: { etiqueta: "Ingreso", pagina: "ingresos", ver: "Ver en Ingresos" },
    recurrente: { etiqueta: "Recurrente", pagina: "ingresosRecurrentes", ver: "Ver en Ingresos recurrentes" },
    gasto: { etiqueta: "Gasto", pagina: "gastos", ver: "Ver en Gastos" },
    mensualidad: { etiqueta: "Mensualidad", pagina: "mensualidades", ver: "Ver en Mensualidades" },
    interes: { etiqueta: "Intereses", pagina: "cuentaRemunerada", ver: "Ver en Cuenta Remunerada" },
    dividendo: { etiqueta: "Dividendo", pagina: "dividendos", ver: "Ver en Dividendos" },
    transferencia: { etiqueta: "Transferencia" },
    comision: { etiqueta: "Comisión" }
}

// Las dos listas de movimientos comparten tabla y filtros; cambia qué entra.
const CNT_LISTAS = {
    todos: {
        origenes: null,
        tipos: [
            ["", "Todos"],
            ["entrada", "Entradas"],
            ["salida", "Salidas"]
        ],
        entradas: "Entradas",
        salidas: "Salidas",
        sinNada: "Esta cuenta no tiene movimientos."
    },
    ingresosGastos: {
        origenes: new Set(["ingreso", "recurrente", "gasto", "mensualidad", "interes", "dividendo"]),
        tipos: [
            ["", "Todos"],
            ["entrada", "Ingresos"],
            ["salida", "Gastos"]
        ],
        entradas: "Ingresos",
        salidas: "Gastos",
        sinNada: "Esta cuenta no tiene nada apuntado en Gastos ni en Ingresos."
    }
}
const CNT_SIN_FECHA = "sin-fecha"
// Opción del selector de año que enseña toda la historia de la cuenta.
const CNT_TODOS_LOS_ANIOS = "todos"

/**
 * ¿Entra el movimiento en el año elegido? «Todos» deja pasar cualquiera,
 * también los que no tienen fecha.
 * @param {{year?: string}} movimiento
 * @param {string} year Un año, CNT_SIN_FECHA o CNT_TODOS_LOS_ANIOS.
 * @returns {boolean}
 */
function cntEnAnio(movimiento, year) {
    return year === CNT_TODOS_LOS_ANIOS || (movimiento.year || CNT_SIN_FECHA) === year
}

// Grupos del desglose del saldo: qué orígenes suma cada uno y con qué signo.
const CNT_GRUPOS_DESGLOSE = [
    {
        clave: "ingresos",
        etiqueta: "Ingresos",
        signo: 1,
        es: (m) => m.origen === "ingreso" || m.origen === "recurrente"
    },
    {
        clave: "rendimientos",
        etiqueta: "Intereses y dividendos",
        signo: 1,
        es: (m) => m.origen === "interes" || m.origen === "dividendo"
    },
    {
        clave: "recibidas",
        etiqueta: "Transferencias recibidas",
        signo: 1,
        es: (m) => m.origen === "transferencia" && m.kind === "entrada"
    },
    { clave: "gastos", etiqueta: "Gastos", signo: -1, es: (m) => m.origen === "gasto" || m.origen === "mensualidad" },
    {
        clave: "enviadas",
        etiqueta: "Transferencias enviadas",
        signo: -1,
        es: (m) => m.origen === "transferencia" && m.kind === "salida"
    },
    { clave: "comisiones", etiqueta: "Comisiones", signo: -1, es: (m) => m.origen === "comision" }
]

let cntPanel = null
let cntPanelCharts = []
// Gastos e ingresos de cada cuenta abierta: se piden al entrar en la pestaña y
// se olvidan en cuanto cambia algo en la página.
let cntPanelMovimientos = {}

function cntRangoActual() {
    return cntRangoValido(getChartPref(CNT_RANGO_PREF, CNT_RANGO_DEFECTO))
}

function cntSerieDe(cuentaId) {
    return cntNormalizarSerie(cntHistorico?.[cuentaId])
}

/**
 * Abre la ventana de una cuenta en una pestaña, o cambia de pestaña.
 * @param {"resumen"|"ingresosGastos"|"movimientos"|"graficos"} vista
 * @param {string} cuentaId
 */
function cntAbrirPanel(vista, cuentaId) {
    let overlay = document.getElementById("cuentasPanelOverlay")
    if (!overlay) {
        overlay = document.createElement("div")
        overlay.id = "cuentasPanelOverlay"
        overlay.className = "modalOverlay"
        overlay.innerHTML =
            '<div class="assetModal cntPanel" role="dialog" aria-modal="true" aria-labelledby="cntPanelTitulo"></div>'
        overlay.addEventListener("click", cntPanelClick)
        overlay.addEventListener("input", cntPanelInput)
        document.addEventListener("keydown", cntPanelTeclas)
        document.body.appendChild(overlay)
    }
    const vistaValida = CNT_PESTANAS.some((p) => p.vista === vista) ? vista : "resumen"
    cntPanel = {
        vista: vistaValida,
        cuentaId,
        buscaMov: "",
        // Cada lista guarda sus filtros: cambiar de pestaña no los mezcla.
        filtros: {
            todos: { tipo: "", year: "", mes: "", busca: "" },
            ingresosGastos: { tipo: "", year: "", mes: "", busca: "" }
        }
    }
    cntRenderPanel()
}

/**
 * Instante (medianoche local) del día de un movimiento, o null si no tiene.
 * @param {{dia?: string}} movimiento
 * @returns {number|null}
 */
function cntMovInstante(movimiento) {
    const [anio, mes, dia] = String(movimiento?.dia || "")
        .split("-")
        .map(Number)
    if (!anio || !mes || !dia) return null
    return new Date(anio, mes - 1, dia).getTime()
}

/**
 * Desglose del saldo en un periodo: con qué saldo empezó, qué entró y salió
 * por cada vía y con cuál acaba. Lo pendiente (aún no ha llegado) y lo
 * anterior a la fecha de inicio de la cuenta no cuentan.
 * @param {Array<object>} movimientos Los de /api/cuentas/<id>/movimientos.
 * @param {number|null} desde Primer instante del periodo; null para todo.
 * @param {number} saldoInicial Saldo inicial de la cuenta.
 * @returns {{inicio: number, final: number, grupos: Object<string, number>}}
 */
function cntDesglose(movimientos, desde, saldoInicial) {
    const grupos = Object.fromEntries(CNT_GRUPOS_DESGLOSE.map((g) => [g.clave, 0]))
    let inicio = saldoInicial
    ;(movimientos || [])
        // Lo pendiente aún no ha pasado y lo anterior al inicio ya está en el saldo inicial.
        .filter((m) => !m.pendiente && !m.anterior)
        .forEach((m) => {
            const importe = parseEuroNumber(m.cantidad)
            const t = cntMovInstante(m)
            // Lo que no tiene día forma parte del saldo de partida, como en la gráfica.
            if (desde !== null && desde !== undefined && (t === null || t < desde)) {
                inicio += m.kind === "entrada" ? importe : -importe
                return
            }
            const grupo = CNT_GRUPOS_DESGLOSE.find((g) => g.es(m))
            if (grupo) grupos[grupo.clave] += importe
        })
    const final = CNT_GRUPOS_DESGLOSE.reduce((saldo, g) => saldo + g.signo * grupos[g.clave], inicio)
    return { inicio, final, grupos }
}

/**
 * Une cada gasto fraccionado con su «parte de otros» (como la página Gastos) y
 * le deja el saldo de la que va después, que es el saldo tras pagar el total.
 * @param {Array<object>} movimientos
 * @returns {Array<object>}
 */
function cntUnirFraccionados(movimientos) {
    return unirGastosFraccionados(movimientos).map((m) => {
        if (!m.fraccionado) return m
        const nombre = conceptoFraccionado(m.nombre) + SUFIJO_PARTE_OTROS
        const pareja = movimientos.find((o) => o.origen === "gasto" && o.fecha === m.fecha && o.nombre === nombre)
        // `parteOtros` es lo que adelantaste por otros: el detalle lo separa de tu parte.
        const unido = { ...m, parteOtros: pareja?.cantidad || "" }
        return pareja && pareja.orden > m.orden ? { ...unido, saldo: pareja.saldo, orden: pareja.orden } : unido
    })
}

function cntCerrarPanel() {
    cntCerrarDetalle()
    cntDestruirChartsPanel()
    document.getElementById("cuentasPanelOverlay")?.remove()
    document.removeEventListener("keydown", cntPanelTeclas)
    cntPanel = null
    cntPanelMovimientos = {}
}

// Escape cierra solo si no hay otro modal abierto encima (editar una
// transferencia, confirmar un borrado): entonces Escape es de ese modal.
function cntPanelTeclas(event) {
    if (event.key !== "Escape") return
    const overlay = document.getElementById("cuentasPanelOverlay")
    const otroAbierto = [...document.querySelectorAll(".modalOverlay")].some(
        (o) => o !== overlay && !o.hidden && getComputedStyle(o).display !== "none"
    )
    if (overlay && !otroAbierto) cntCerrarPanel()
}

function cntDestruirChartsPanel() {
    cntPanelCharts.forEach((chart) => chart?.destroy())
    cntPanelCharts = []
}

// Tras guardar o borrar algo en la página: los datos de la ventana ya no valen.
function cntRefrescarPanel() {
    if (!cntPanel) return
    cntPanelMovimientos = {}
    cntRenderPanel()
}

function cntRenderPanel() {
    const modal = document.querySelector("#cuentasPanelOverlay .cntPanel")
    if (!modal || !cntPanel) return
    const cuenta = cntCuentas.find((c) => c.id === cntPanel.cuentaId)
    // La cuenta se ha borrado con la ventana abierta.
    if (!cuenta) return cntCerrarPanel()

    cntDestruirChartsPanel()
    const vistas = {
        resumen: cntVistaResumen,
        todos: cntVistaLista,
        ingresosGastos: cntVistaLista,
        movimientos: cntVistaMovimientos,
        graficos: cntVistaGraficos
    }
    modal.innerHTML = `
        ${cntCabeceraPanel(cuenta)}
        ${cntPestanasPanel(cuenta)}
        <div class="cntPanelCuerpo">${vistas[cntPanel.vista](cuenta)}</div>`
    cntMontarVista(modal, cuenta)
}

function cntCabeceraPanel(cuenta) {
    const saldo = parseEuroNumber(cuenta.saldo)
    const indice = cntCuentas.findIndex((c) => c.id === cuenta.id)
    return `
        <div class="cntPanelCab">
            <div class="cntPanelIdentidad">
                <span class="cntCuentaPunto" style="background:${CNT_PALETA[Math.max(indice, 0) % CNT_PALETA.length]}" aria-hidden="true"></span>
                <h3 class="cntPanelTitulo" id="cntPanelTitulo">${escapeGastosHtml(cuenta.nombre)}</h3>
                <span class="cntPanelEtiquetas">${cntEtiquetasHtml(cuenta)}</span>
            </div>
            <button type="button" class="cntPanelCerrar" data-cnt-cerrar aria-label="Cerrar" title="Cerrar">
                <span class="icono iconoCerrar" aria-hidden="true"></span>
            </button>
        </div>
        <div class="cntPanelSaldoBloque">
            <span class="cntPanelSaldoTitulo">Saldo actual</span>
            <span class="cntPanelSaldo ${saldo < 0 ? "cuentasNeg" : ""}">${formatEuro(saldo)}</span>
            ${cntVariacionTexto(cntVariacionYtd(cuenta.id))}
        </div>`
}

function cntPestanasPanel(cuenta) {
    const transferencias = cntTransferenciasDe(cuenta.id).length
    return `
        <div class="cntTabs" role="tablist">
            ${CNT_PESTANAS.map((p) => {
                const activa = p.vista === cntPanel.vista
                const contador =
                    p.vista === "movimientos" && transferencias
                        ? `<span class="cntTabContador">${transferencias}</span>`
                        : ""
                return `<button type="button" class="cntTab${activa ? " active" : ""}" role="tab" aria-selected="${activa}" data-cnt-ir="${p.vista}">${p.etiqueta}${contador}</button>`
            }).join("")}
        </div>`
}

function cntTransferenciasDe(cuentaId) {
    return cntTransferencias.filter((t) => t.origen === cuentaId || t.destino === cuentaId)
}

/** Grupo de botones pegados (control segmentado). */
function cntSegmento(opciones, actual, atributo, etiqueta) {
    return `
        <div class="cntSegmento" role="group" aria-label="${escapeGastosHtml(etiqueta)}">
            ${opciones
                .map(
                    ([valor, texto]) =>
                        `<button type="button" class="${valor === actual ? "active" : ""}" ${atributo}="${escapeGastosHtml(valor)}" aria-pressed="${valor === actual}">${escapeGastosHtml(texto)}</button>`
                )
                .join("")}
        </div>`
}

function cntSegmentoRango() {
    return cntSegmento(
        CNT_RANGOS.map((r) => [r.clave, r.etiqueta]),
        cntRangoActual(),
        "data-cnt-rango",
        "Periodo"
    )
}

function cntSinHistorico() {
    return '<p class="overviewEmpty">No se pudo cargar el histórico de saldos.</p>'
}

// ── Pestaña «resumen» ───────────────────────────────────────────────────

function cntVistaResumen(cuenta) {
    if (!cntHistorico) return cntSinHistorico()
    const desde = cntInicioRango(cntRangoActual())
    const serie = cntSerieDe(cuenta.id)
    const { entradas, salidas } = cntFlujosEnRango(serie, desde)
    const variacion = cntVariacion(cntPuntosEnRango(serie, desde))
    const neto = entradas - salidas
    const pct =
        variacion.porcentaje === null
            ? "—"
            : `${variacion.porcentaje > 0 ? "+" : ""}${variacion.porcentaje.toFixed(1).replace(".", ",")} %`

    return `
        <div class="cntPanelBarra">
            <span class="cntPanelBarraTitulo">Periodo</span>
            ${cntSegmentoRango()}
        </div>
        <div class="cuentasKpis cntPanelKpis">
            <div class="cuentasKpi" title="Todo lo que ha entrado en la cuenta en el periodo">
                <span class="cuentasKpiTitulo">Entradas</span>
                <span class="cuentasKpiValor cuentasPos">${cntSigned(entradas)}</span>
                <span class="cntKpiDetalle" data-cnt-kpi="entrada"></span>
            </div>
            <div class="cuentasKpi" title="Todo lo que ha salido de la cuenta en el periodo, comisiones incluidas">
                <span class="cuentasKpiTitulo">Salidas</span>
                <span class="cuentasKpiValor cuentasNeg">${formatEuro(-salidas)}</span>
                <span class="cntKpiDetalle" data-cnt-kpi="salida"></span>
            </div>
            <div class="cuentasKpi">
                <span class="cuentasKpiTitulo">Neto</span>
                <span class="cuentasKpiValor ${neto > 0 ? "cuentasPos" : neto < 0 ? "cuentasNeg" : ""}">${cntSigned(neto)}</span>
            </div>
            <div class="cuentasKpi" title="Cambio del saldo en el periodo respecto al saldo con que empezó">
                <span class="cuentasKpiTitulo">Variación</span>
                <span class="cuentasKpiValor ${variacion.absoluta > 0 ? "cuentasPos" : variacion.absoluta < 0 ? "cuentasNeg" : ""}">${pct}</span>
            </div>
        </div>
        <section class="cntSeccion">
            <h4 class="cntSeccionTitulo">Evolución del saldo</h4>
            <div class="cntGraficaCaja cntGraficaResumen"><canvas id="cntPanelSaldo" aria-label="Saldo de la cuenta en el periodo"></canvas></div>
        </section>
        <section class="cntSeccion">
            <h4 class="cntSeccionTitulo">Desglose del saldo en ${escapeGastosHtml(cntPeriodoTexto(cntRangoActual()))}</h4>
            <div class="cntDesglose"><p class="overviewEmpty">Cargando…</p></div>
        </section>
        ${cntDatosCuenta(cuenta)}`
}

// Rellena el desglose y el detalle de los KPIs cuando llegan los movimientos.
async function cntMontarDesglose(modal, cuenta) {
    let movimientos
    try {
        movimientos = await cntCargarMovimientosCuenta(cuenta.id)
    } catch (error) {
        console.error("Error cargando los movimientos de la cuenta:", error)
        const caja = modal.querySelector(".cntDesglose")
        if (caja) caja.innerHTML = '<p class="overviewEmpty">No se pudieron cargar los movimientos de la cuenta.</p>'
        return
    }
    if (cntPanel?.vista !== "resumen" || cntPanel.cuentaId !== cuenta.id) return
    const desglose = cntDesglose(movimientos, cntInicioRango(cntRangoActual()), parseEuroNumber(cuenta.saldo_inicial))

    const caja = modal.querySelector(".cntDesglose")
    if (caja) caja.innerHTML = cntDesgloseHtml(desglose)

    // Debajo de Entradas y Salidas, de qué se componen (solo lo que no es cero).
    modal.querySelectorAll("[data-cnt-kpi]").forEach((detalle) => {
        const signo = detalle.dataset.cntKpi === "entrada" ? 1 : -1
        detalle.textContent = CNT_GRUPOS_DESGLOSE.filter((g) => g.signo === signo && desglose.grupos[g.clave])
            .map((g) => `${g.etiqueta} ${formatEuro(desglose.grupos[g.clave])}`)
            .join(" · ")
    })
}

function cntDesgloseHtml({ inicio, final, grupos }) {
    const fila = (etiqueta, valor, clase = "", total = false) =>
        `<div class="cntDesgloseFila${total ? " cntDesgloseTotal" : ""}"><span>${escapeGastosHtml(etiqueta)}</span><span class="${clase}">${valor}</span></div>`
    return [
        fila("Saldo al empezar el periodo", formatEuro(inicio), inicio < 0 ? "cuentasNeg" : "", true),
        ...CNT_GRUPOS_DESGLOSE.map((g) => {
            const valor = grupos[g.clave]
            if (!valor) return fila(g.etiqueta, "—", "cuentasSinConcepto")
            return g.signo > 0
                ? fila(g.etiqueta, cntSigned(valor), "cuentasPos")
                : fila(g.etiqueta, formatEuro(-valor), "cuentasNeg")
        }),
        fila("Saldo al final del periodo", formatEuro(final), final < 0 ? "cuentasNeg" : "", true)
    ].join("")
}

// Los datos fijos de la cuenta, solo los que tienen algo.
function cntDatosCuenta(cuenta) {
    const filas = []
    const papeles = []
    if (cuenta.ahorro) papeles.push("Cuenta de ahorro")
    if (cuenta.remunerada) papeles.push("Remunerada")
    if (cuenta.dividendos) papeles.push("Cobra dividendos")
    const inicial = parseEuroNumber(cuenta.saldo_inicial)
    const comisiones = parseEuroNumber(cuenta.comisiones)
    const intereses = parseEuroNumber(cuenta.intereses)
    const dividendos = parseEuroNumber(cuenta.dividendos_cobrados)
    if (cuenta.inicio) filas.push(["Se lleva desde", cntFechaInicioTexto(cuenta.inicio), ""])
    if (inicial || cuenta.inicio)
        filas.push([cuenta.inicio ? "Saldo ese día" : "Saldo inicial", formatEuro(inicial), ""])
    if (comisiones) filas.push(["Comisiones pagadas", formatEuro(-comisiones), "cuentasNeg"])
    if (intereses) filas.push(["Intereses", cntSigned(intereses), "cuentasPos"])
    if (dividendos) filas.push(["Dividendos cobrados", cntSigned(dividendos), "cuentasPos"])
    if (papeles.length) filas.push(["Papeles", papeles.join(" · "), ""])
    if (!filas.length) return ""
    return `
        <dl class="cntDatos">
            ${filas
                .map(
                    ([titulo, valor, clase]) =>
                        `<div class="cntDato"><dt>${escapeGastosHtml(titulo)}</dt><dd class="${clase}">${escapeGastosHtml(valor)}</dd></div>`
                )
                .join("")}
        </dl>`
}

function cntMontarResumen(modal, cuenta) {
    if (!cntHistorico) return
    const puntos = cntPuntosEnRango(cntSerieDe(cuenta.id), cntInicioRango(cntRangoActual()))
    cntPanelCharts.push(cntPintarSaldo(modal.querySelector("#cntPanelSaldo"), puntos))
}

// ── Pestaña «graficos» ──────────────────────────────────────────────────

function cntVistaGraficos() {
    if (!cntHistorico) return cntSinHistorico()
    return `
        <div class="cntPanelBarra">
            <span class="cntPanelBarraTitulo">Periodo</span>
            ${cntSegmentoRango()}
        </div>
        <section class="cntSeccion">
            <h4 class="cntSeccionTitulo">Evolución del saldo</h4>
            <div class="cntGraficaCaja"><canvas id="cntPanelSaldo" aria-label="Saldo de la cuenta en el periodo"></canvas></div>
        </section>
        <section class="cntSeccion">
            <h4 class="cntSeccionTitulo">Entradas y salidas por mes</h4>
            <div class="cntGraficaCaja cntGraficaBarras"><canvas id="cntPanelFlujos" aria-label="Entradas y salidas por mes"></canvas></div>
            <p class="overviewEmpty hidden" id="cntPanelFlujosVacio">No hay entradas ni salidas en el periodo.</p>
        </section>`
}

function cntMontarGraficos(modal, cuenta) {
    if (!cntHistorico) return
    const puntos = cntPuntosEnRango(cntSerieDe(cuenta.id), cntInicioRango(cntRangoActual()))
    cntPanelCharts.push(cntPintarSaldo(modal.querySelector("#cntPanelSaldo"), puntos))
    const meses = cntFlujosPorMes(puntos)
    cntPanelCharts.push(cntPintarFlujosMes(modal.querySelector("#cntPanelFlujos"), meses))
    modal.querySelector("#cntPanelFlujosVacio")?.classList.toggle("hidden", meses.length > 0)
    modal.querySelector(".cntGraficaBarras")?.classList.toggle("hidden", meses.length === 0)
}

// ── Pestañas «todos» e «ingresosGastos» ─────────────────────────────────

async function cntCargarMovimientosCuenta(cuentaId) {
    if (!cntPanelMovimientos[cuentaId]) {
        const datos = await Api.get(`/api/cuentas/${encodeURIComponent(cuentaId)}/movimientos`)
        cntPanelMovimientos[cuentaId] = Array.isArray(datos?.movimientos) ? datos.movimientos : []
    }
    return cntPanelMovimientos[cuentaId]
}

function cntVistaLista() {
    const filtros = cntPanel.filtros[cntPanel.vista]
    return `
        <div class="cntIGBarra">
            <label class="cntBuscarCaja">
                <span class="icono iconoBuscar" aria-hidden="true"></span>
                <input type="search" class="cntBuscar" value="${escapeGastosHtml(filtros.busca)}" placeholder="Buscar" aria-label="Buscar en la tabla" autocomplete="off" spellcheck="false">
            </label>
            <div class="cntIGFiltroTipo"></div>
            <div class="cntYears"></div>
        </div>
        <div class="cntMeses"></div>
        <p class="cntTablaResumen" aria-live="polite"></p>
        <div class="gastosMovementsWrapper cntPanelTablaWrap">
            <table class="gastosMovementsTable cntPanelTabla cntPanelTablaLista">
                <thead><tr><th>Fecha</th><th>Concepto</th><th>Tipo</th><th>Categoría</th><th class="numCol">Importe</th><th class="numCol" title="Saldo de la cuenta justo después del movimiento">Saldo</th><th class="rowActionHeader"></th></tr></thead>
                <tbody></tbody>
            </table>
            <p class="overviewEmpty cntPanelVacio">Cargando…</p>
        </div>`
}

async function cntMontarLista(modal, cuenta) {
    const vista = cntPanel.vista
    let movimientos
    try {
        movimientos = await cntCargarMovimientosCuenta(cuenta.id)
    } catch (error) {
        console.error("Error cargando los movimientos de la cuenta:", error)
        const vacio = modal.querySelector(".cntPanelVacio")
        if (vacio) vacio.textContent = "No se pudieron cargar los movimientos de la cuenta."
        return
    }
    // La pestaña puede haber cambiado mientras llegaba la respuesta.
    if (cntPanel?.vista !== vista || cntPanel.cuentaId !== cuenta.id) return

    const { origenes } = CNT_LISTAS[vista]
    const lista = cntUnirFraccionados(movimientos.filter((m) => !origenes || origenes.has(m.origen)))
    const filtros = cntPanel.filtros[vista]
    const years = [...new Set(lista.map((m) => m.year || CNT_SIN_FECHA))].sort().reverse()
    const thisYear = String(new Date().getFullYear())
    if (!filtros.year || (filtros.year !== CNT_TODOS_LOS_ANIOS && !years.includes(filtros.year)))
        filtros.year = years.includes(thisYear) ? thisYear : years[0] || CNT_TODOS_LOS_ANIOS
    cntPanel.lista = lista
    cntPanel.listaYears = years
    cntRenderLista(modal)
}

function cntFiltrarLista() {
    const filtros = cntPanel.filtros[cntPanel.vista]
    const busca = filtros.busca.trim().toLocaleLowerCase("es")
    return (
        (cntPanel.lista || [])
            .filter((m) => cntEnAnio(m, filtros.year))
            .filter((m) => !filtros.tipo || m.kind === filtros.tipo)
            // Con todos los años no hay mes que elegir: el filtro de mes no aplica.
            .filter((m) => !filtros.mes || filtros.year === CNT_TODOS_LOS_ANIOS || m.month === filtros.mes)
            .filter(
                (m) =>
                    !busca ||
                    [m.fecha, m.nombre, m.contraparte, m.nota, m.cantidad, CNT_ORIGENES[m.origen]?.etiqueta].some((v) =>
                        String(v || "")
                            .toLocaleLowerCase("es")
                            .includes(busca)
                    )
            )
            .sort((a, b) => b.orden - a.orden)
    )
}

function cntTotalesLista(filas) {
    const suma = (lista) => lista.reduce((s, m) => s + parseEuroNumber(m.cantidad), 0)
    const ocurridas = filas.filter((m) => !m.pendiente && !m.anterior)
    const pendientes = filas.filter((m) => m.pendiente)
    return {
        entradas: suma(ocurridas.filter((m) => m.kind === "entrada")),
        salidas: suma(ocurridas.filter((m) => m.kind === "salida")),
        pendiente:
            suma(pendientes.filter((m) => m.kind === "entrada")) - suma(pendientes.filter((m) => m.kind === "salida"))
    }
}

// Repinta filtros y tabla, pero no el buscador: así no pierde el foco al escribir.
function cntRenderLista(modal) {
    const config = CNT_LISTAS[cntPanel.vista]
    const filtros = cntPanel.filtros[cntPanel.vista]
    const lista = cntPanel.lista || []
    const conMovimientos = new Set(lista.filter((m) => cntEnAnio(m, filtros.year)).map((m) => m.month))

    const tipo = modal.querySelector(".cntIGFiltroTipo")
    if (tipo) tipo.innerHTML = cntSegmento(config.tipos, filtros.tipo, "data-cnt-tipo", "Tipo")
    // «Todos» va siempre el primero, aunque solo haya un año: así se ve también
    // lo que no tiene fecha.
    const years = modal.querySelector(".cntYears")
    if (years) {
        const opciones = cntPanel.listaYears || []
        years.innerHTML = opciones.length
            ? cntSegmento(
                  [[CNT_TODOS_LOS_ANIOS, "Todos"], ...opciones.map((y) => [y, y === CNT_SIN_FECHA ? "Sin fecha" : y])],
                  filtros.year,
                  "data-cnt-year",
                  "Año"
              )
            : ""
    }
    const meses = modal.querySelector(".cntMeses")
    if (meses) {
        meses.innerHTML =
            filtros.year === CNT_SIN_FECHA || filtros.year === CNT_TODOS_LOS_ANIOS
                ? ""
                : cntSegmento(
                      [["", "Todo el año"], ...CNT_MESES_CLAVE.map((clave, i) => [clave, CNT_MESES_CORTOS[i]])],
                      filtros.mes,
                      "data-cnt-mes",
                      "Mes"
                  )
        meses.querySelectorAll("[data-cnt-mes]").forEach((b) => {
            b.classList.toggle("cntMesVacio", Boolean(b.dataset.cntMes) && !conMovimientos.has(b.dataset.cntMes))
        })
    }

    const filas = cntFiltrarLista()
    const totales = cntTotalesLista(filas)
    const resumen = modal.querySelector(".cntTablaResumen")
    if (resumen) {
        const sep = '<span class="cntTablaResumenSep">·</span>'
        resumen.innerHTML = filas.length
            ? `${filas.length} ${filas.length === 1 ? "movimiento" : "movimientos"}
               ${sep} ${config.entradas} <strong class="cuentasPos">${cntSigned(totales.entradas)}</strong>
               ${sep} ${config.salidas} <strong class="cuentasNeg">${formatEuro(-totales.salidas || 0)}</strong>
               ${sep} Neto <strong class="${totales.entradas - totales.salidas < 0 ? "cuentasNeg" : "cuentasPos"}">${cntSigned(totales.entradas - totales.salidas)}</strong>
               ${totales.pendiente ? `${sep} Pendiente <strong>${cntSigned(totales.pendiente)}</strong>` : ""}`
            : ""
    }

    const body = modal.querySelector(".cntPanelTablaLista tbody")
    if (body) body.innerHTML = filas.map(cntFilaLista).join("")

    const vacio = modal.querySelector(".cntPanelVacio")
    if (vacio) {
        vacio.textContent = lista.length ? "No hay movimientos con estos filtros." : config.sinNada
        vacio.classList.toggle("hidden", filas.length > 0)
    }
}

function cntFilaLista(m) {
    const importe = parseEuroNumber(m.cantidad)
    const saldo = parseEuroNumber(m.saldo)
    const entra = m.kind === "entrada"
    const fueraDelSaldo = m.pendiente || m.anterior
    const origen = CNT_ORIGENES[m.origen] || { etiqueta: m.origen }
    const esTransferencia = m.origen === "transferencia" || m.origen === "comision"
    const etiquetas = [
        m.fraccionado
            ? '<span class="gastosMensualidadTag" title="Pago fraccionado: importe total que salió de la cuenta">Fraccionado</span>'
            : "",
        m.pendiente
            ? '<span class="gastosMensualidadTag cntTagPendiente" title="Todavía no ha llegado su día: no cuenta en el saldo actual">Pendiente</span>'
            : "",
        m.anterior
            ? '<span class="gastosMensualidadTag cntTagPendiente" title="Anterior a la fecha de inicio de la cuenta: ya está en su saldo inicial y no cuenta otra vez">Antes del inicio</span>'
            : ""
    ].join("")
    const opciones = esTransferencia
        ? `<button type="button" class="rowMenuItem" data-cnt-editar>Editar transferencia</button>
           <hr>
           <button type="button" class="rowMenuItem rowMenuItemDanger" data-cnt-eliminar>Eliminar transferencia</button>`
        : origen.pagina
          ? `<button type="button" class="rowMenuItem" data-cnt-ver-pagina="${origen.pagina}">${escapeGastosHtml(origen.ver)}</button>`
          : ""
    return `
        <tr class="movDetailRow${fueraDelSaldo ? " cntFilaPendiente" : ""}" data-orden="${m.orden}"${esTransferencia ? ` data-transferencia="${escapeGastosHtml(m.id)}"` : ""} title="Ver el detalle">
            <td class="cntCeldaFecha">${escapeGastosHtml(m.fecha || "Sin fecha")}</td>
            <td title="${escapeGastosHtml(m.nota || "")}">
                <span class="cntFlecha ${entra ? "cntFlechaEntra" : "cntFlechaSale"}" aria-label="${entra ? "Entrada" : "Salida"}"></span>
                ${m.nombre ? escapeGastosHtml(m.nombre) : '<span class="cuentasSinConcepto">Sin concepto</span>'}${etiquetas}
            </td>
            <td><span class="cntOrigen cntOrigen-${escapeGastosHtml(m.origen)}">${escapeGastosHtml(origen.etiqueta)}</span></td>
            <td>${m.contraparte ? `<span class="cntCategoria">${escapeGastosHtml(m.contraparte)}</span>` : '<span class="cuentasSinConcepto">—</span>'}</td>
            <td class="numCell ${entra ? "cuentasPos" : "cuentasNeg"}">${entra ? cntSigned(importe) : formatEuro(-importe)}</td>
            <td class="numCell cntCeldaSaldo ${!m.anterior && saldo < 0 ? "cuentasNeg" : ""}">${m.anterior ? '<span class="cuentasSinConcepto">—</span>' : formatEuro(saldo)}</td>
            <td class="rowActionsCell">
                ${
                    opciones
                        ? `<div class="rowMenu">
                    <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                    <div class="rowMenuDropdown">${opciones}</div>
                </div>`
                        : ""
                }
            </td>
        </tr>`
}

// ── Pestaña «movimientos» ───────────────────────────────────────────────

function cntVistaMovimientos() {
    return `
        <div class="cntPanelBarra">
            <label class="cntBuscarCaja">
                <span class="icono iconoBuscar" aria-hidden="true"></span>
                <input type="search" class="cntBuscar cntBuscarMov" value="${escapeGastosHtml(cntPanel.buscaMov)}" placeholder="Buscar" aria-label="Buscar en las transferencias" autocomplete="off" spellcheck="false">
            </label>
            <button type="button" class="cntBotonSecundario" data-cnt-nueva-transferencia data-no-autohide="true">Nueva transferencia</button>
        </div>
        <p class="cntTablaResumen cntMovResumen" aria-live="polite"></p>
        <div class="gastosMovementsWrapper cntPanelTablaWrap">
            <table class="gastosMovementsTable cntPanelTabla cntPanelTablaMov">
                <thead><tr><th>Fecha</th><th>Contraparte</th><th>Concepto</th><th class="numCol">Importe</th><th class="numCol">Comisión</th><th class="numCol" title="Saldo de la cuenta justo después de la transferencia (y su comisión)">Saldo</th><th class="rowActionHeader"></th></tr></thead>
                <tbody></tbody>
            </table>
            <p class="overviewEmpty cntMovVacio hidden"></p>
        </div>`
}

// Las transferencias de la cuenta que casan con la búsqueda, la más reciente
// primero. Se busca también por la otra cuenta, la nota y los importes.
function cntFiltrarTransferencias(cuenta) {
    const busca = cntPanel.buscaMov.trim().toLocaleLowerCase("es")
    return cntTransferenciasDe(cuenta.id)
        .filter(
            (t) =>
                !busca ||
                [
                    t.fecha,
                    t.destino === cuenta.id ? t.origen_nombre : t.destino_nombre,
                    t.concepto,
                    t.nota,
                    t.cantidad,
                    t.comision
                ].some((v) =>
                    String(v || "")
                        .toLocaleLowerCase("es")
                        .includes(busca)
                )
        )
        .sort((a, b) => cntFechaClave(b.fecha) - cntFechaClave(a.fecha) || b.id - a.id)
}

// Repinta resumen y tabla, pero no el buscador: así no pierde el foco al escribir.
function cntRenderMovimientos(modal, cuenta) {
    const filas = cntFiltrarTransferencias(cuenta)
    const entradas = filas.filter((t) => t.destino === cuenta.id).reduce((s, t) => s + parseEuroNumber(t.cantidad), 0)
    const salidas = filas.filter((t) => t.origen === cuenta.id).reduce((s, t) => s + parseEuroNumber(t.cantidad), 0)
    const comisiones = filas.filter((t) => t.origen === cuenta.id).reduce((s, t) => s + parseEuroNumber(t.comision), 0)

    const resumen = modal.querySelector(".cntMovResumen")
    if (resumen) {
        resumen.innerHTML = filas.length
            ? `${filas.length} ${filas.length === 1 ? "transferencia" : "transferencias"}
               <span class="cntTablaResumenSep">·</span> Recibido <strong class="cuentasPos">${cntSigned(entradas)}</strong>
               <span class="cntTablaResumenSep">·</span> Enviado <strong class="cuentasNeg">${formatEuro(-salidas)}</strong>
               ${comisiones ? `<span class="cntTablaResumenSep">·</span> Comisiones <strong class="cuentasNeg">${formatEuro(-comisiones)}</strong>` : ""}`
            : ""
    }

    const body = modal.querySelector(".cntPanelTablaMov tbody")
    if (body) {
        const saldos = cntSaldosTrasTransferencia(cntPanelMovimientos[cuenta.id])
        body.innerHTML = filas
            .map((t) => {
                const entra = t.destino === cuenta.id
                const comision = parseEuroNumber(t.comision)
                const tras = saldos.get(String(t.id))
                // Sin saldo: aún cargando, o de antes del inicio de la cuenta.
                const saldo = tras && !tras.anterior ? parseEuroNumber(tras.saldo) : null
                const sinSaldo = tras?.anterior ? "—" : "…"
                return `
                <tr class="movDetailRow${tras?.pendiente || tras?.anterior ? " cntFilaPendiente" : ""}" data-transferencia="${t.id}" title="Ver el detalle">
                    <td class="cntCeldaFecha">${escapeGastosHtml(t.fecha)}</td>
                    <td>
                        <span class="cntFlecha ${entra ? "cntFlechaEntra" : "cntFlechaSale"}" aria-label="${entra ? "Entrada" : "Salida"}"></span>
                        ${escapeGastosHtml(entra ? t.origen_nombre : t.destino_nombre)}
                    </td>
                    <td title="${escapeGastosHtml(t.nota || "")}">${t.concepto ? escapeGastosHtml(t.concepto) : '<span class="cuentasSinConcepto">Sin concepto</span>'}</td>
                    <td class="numCell ${entra ? "cuentasPos" : "cuentasNeg"}">${entra ? cntSigned(parseEuroNumber(t.cantidad)) : formatEuro(-parseEuroNumber(t.cantidad))}</td>
                    <td class="numCell">${comision > 0 ? `<span class="cuentasNeg">${formatEuro(-comision)}</span>` : '<span class="cuentasSinConcepto">—</span>'}</td>
                    <td class="numCell cntCeldaSaldo ${saldo !== null && saldo < 0 ? "cuentasNeg" : ""}">${saldo === null ? `<span class="cuentasSinConcepto">${sinSaldo}</span>` : formatEuro(saldo)}</td>
                    <td class="rowActionsCell">
                        <div class="rowMenu">
                            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                            <div class="rowMenuDropdown">
                                <button type="button" class="rowMenuItem" data-cnt-editar>Editar</button>
                                <hr>
                                <button type="button" class="rowMenuItem rowMenuItemDanger" data-cnt-eliminar>Eliminar</button>
                            </div>
                        </div>
                    </td>
                </tr>`
            })
            .join("")
    }

    const vacio = modal.querySelector(".cntMovVacio")
    if (vacio) {
        vacio.textContent = cntTransferenciasDe(cuenta.id).length
            ? "Ninguna transferencia coincide con la búsqueda."
            : "Esta cuenta no tiene transferencias."
        vacio.classList.toggle("hidden", filas.length > 0)
    }
}

/**
 * Saldo tras cada transferencia: `Map(id -> movimiento)`. Si pagó comisión, el
 * de después de la comisión, que es lo último que hizo esa transferencia.
 * @param {Array<object>|undefined} movimientos
 * @returns {Map<string, object>}
 */
function cntSaldosTrasTransferencia(movimientos) {
    const saldos = new Map()
    ;(movimientos || [])
        .filter((m) => m.origen === "transferencia" || m.origen === "comision")
        .forEach((m) => {
            const previo = saldos.get(String(m.id))
            if (!previo || m.orden > previo.orden) saldos.set(String(m.id), m)
        })
    return saldos
}

// La tabla se pinta enseguida con las transferencias ya cargadas; la columna
// Saldo se completa cuando llegan los movimientos de la cuenta.
async function cntMontarMovimientos(modal, cuenta) {
    cntRenderMovimientos(modal, cuenta)
    if (cntPanelMovimientos[cuenta.id]) return
    try {
        await cntCargarMovimientosCuenta(cuenta.id)
    } catch (error) {
        console.error("Error cargando los movimientos de la cuenta:", error)
        return
    }
    if (cntPanel?.vista === "movimientos" && cntPanel.cuentaId === cuenta.id) cntRenderMovimientos(modal, cuenta)
}

// ── Detalle de un movimiento ────────────────────────────────────────────
// Pulsar una fila abre encima de la ventana de la cuenta todo lo que se sabe
// de ese movimiento, con el saldo de la cuenta antes y después.

/**
 * El movimiento de una transferencia de la tabla de Transferencias, con lo que
 * hace falta para el detalle.
 * @param {{id: string}} cuenta
 * @param {object} transferencia De /api/transferencias.
 * @returns {object|null}
 */
function cntMovimientoDeTransferencia(cuenta, transferencia) {
    if (!transferencia) return null
    const entra = transferencia.destino === cuenta.id
    const registro = (cntPanelMovimientos[cuenta.id] || []).find(
        (m) => m.origen === "transferencia" && String(m.id) === String(transferencia.id)
    )
    return {
        ...(registro || {}),
        origen: "transferencia",
        id: transferencia.id,
        kind: entra ? "entrada" : "salida",
        fecha: transferencia.fecha,
        nombre: transferencia.concepto,
        contraparte: entra ? transferencia.origen_nombre : transferencia.destino_nombre,
        cantidad: transferencia.cantidad,
        nota: transferencia.nota
    }
}

/**
 * Saldo de la cuenta justo antes y justo después de un movimiento.
 *
 * Una transferencia con comisión deja el saldo de después de la comisión, que es
 * lo último que hizo. Sin saldo (de antes del inicio, o aún sin cargar) da null.
 * @param {object} m Movimiento.
 * @param {object|null} transferencia La transferencia si el movimiento es una.
 * @param {string} cuentaId
 * @returns {{antes: number, despues: number}|null}
 */
function cntSaldosDelMovimiento(m, transferencia, cuentaId) {
    if (m.anterior) return null
    let despues = m.saldo
    let importe = parseEuroNumber(m.cantidad)
    if (transferencia) {
        const tras = cntSaldosTrasTransferencia(cntPanelMovimientos[cuentaId]).get(String(transferencia.id))
        if (!tras || tras.anterior) return null
        despues = tras.saldo
        importe = parseEuroNumber(transferencia.cantidad)
        if (transferencia.origen === cuentaId) importe += parseEuroNumber(transferencia.comision)
    }
    if (despues === undefined || despues === null || despues === "") return null
    const final = parseEuroNumber(despues)
    const entra = transferencia ? transferencia.destino === cuentaId : m.kind === "entrada"
    // En céntimos: 83,10 - 50 en coma flotante da 33,0999…
    const antes = Math.round((entra ? final - importe : final + importe) * 100) / 100
    return { antes, despues: final }
}

/**
 * Filas `[etiqueta, valor, clase]` del detalle de un movimiento.
 * @param {object} m Movimiento.
 * @param {object|null} transferencia
 * @param {string} cuentaId
 * @returns {Array<[string, string, string]>}
 */
function cntDatosDelDetalle(m, transferencia, cuentaId) {
    const entra = transferencia ? transferencia.destino === cuentaId : m.kind === "entrada"
    const importe = parseEuroNumber(transferencia ? transferencia.cantidad : m.cantidad)
    const origen = CNT_ORIGENES[transferencia ? "transferencia" : m.origen]?.etiqueta || m.origen
    const filas = [["Fecha", m.fecha || "Sin fecha", ""]]
    const dia = cntFechaInicioTexto(m.dia)
    if (dia && dia !== m.fecha) filas.push(["Cuenta el día", dia, ""])
    filas.push(["Tipo", `${origen} · ${entra ? "entrada" : "salida"}`, ""])

    if (transferencia) {
        filas.push([entra ? "Desde" : "Hacia", entra ? transferencia.origen_nombre : transferencia.destino_nombre, ""])
        filas.push(["Concepto", transferencia.concepto || "Sin concepto", ""])
    } else {
        filas.push(["Concepto", m.nombre || "Sin concepto", ""])
        filas.push([m.origen === "interes" ? "Cuenta remunerada" : "Categoría", m.contraparte || "—", ""])
    }

    if (m.fraccionado && m.parteOtros) {
        const otros = parseEuroNumber(m.parteOtros)
        filas.push(["Total pagado", formatEuro(-importe), "cuentasNeg"])
        filas.push(["Tu parte", formatEuro(-(importe - otros)), "cuentasNeg"])
        filas.push(["Parte de otros", formatEuro(otros), ""])
    } else {
        filas.push(["Importe", entra ? cntSigned(importe) : formatEuro(-importe), entra ? "cuentasPos" : "cuentasNeg"])
    }
    const comision = transferencia && !entra ? parseEuroNumber(transferencia.comision) : 0
    if (comision > 0) filas.push(["Comisión", formatEuro(-comision), "cuentasNeg"])

    const saldos = cntSaldosDelMovimiento(m, transferencia, cuentaId)
    if (saldos) {
        const sufijo = m.pendiente ? " (previsto)" : ""
        filas.push([`Saldo antes${sufijo}`, formatEuro(saldos.antes), saldos.antes < 0 ? "cuentasNeg" : ""])
        filas.push([`Saldo después${sufijo}`, formatEuro(saldos.despues), saldos.despues < 0 ? "cuentasNeg" : ""])
    }
    filas.push([
        "Estado",
        m.anterior
            ? "Antes del inicio de la cuenta: ya está en su saldo inicial"
            : m.pendiente
              ? "Pendiente: aún no ha llegado su día"
              : "Contado en el saldo",
        ""
    ])
    return filas
}

function cntCerrarDetalle() {
    document.getElementById("cntMovDetalleOverlay")?.remove()
    document.removeEventListener("keydown", cntDetalleTeclas)
}

function cntDetalleTeclas(event) {
    if (event.key === "Escape") cntCerrarDetalle()
}

/**
 * Abre el detalle de un movimiento encima de la ventana de la cuenta.
 * @param {object} m Movimiento de la lista (o de cntMovimientoDeTransferencia).
 * @param {{id: string}} cuenta
 */
function cntAbrirDetalle(m, cuenta) {
    cntCerrarDetalle()
    const esTransferencia = m.origen === "transferencia" || m.origen === "comision"
    const transferencia = esTransferencia ? cntTransferencias.find((t) => String(t.id) === String(m.id)) || null : null
    // Pulsar la comisión enseña la transferencia entera, que es la que la generó.
    const origen = CNT_ORIGENES[transferencia ? "transferencia" : m.origen] || {}
    const nota = String(m.nota || "").trim()
    const accion = transferencia
        ? '<button type="button" class="primaryButton" data-cnt-detalle-editar data-no-autohide="true">Editar transferencia</button>'
        : origen.pagina
          ? `<button type="button" class="primaryButton" data-cnt-detalle-ver="${origen.pagina}" data-no-autohide="true">${escapeGastosHtml(origen.ver)}</button>`
          : ""

    const overlay = document.createElement("div")
    overlay.id = "cntMovDetalleOverlay"
    overlay.className = "modalOverlay"
    overlay.innerHTML = `
        <div class="assetModal movDetailModal" role="dialog" aria-modal="true" aria-labelledby="cntMovDetalleTitulo">
            <h3 class="assetModalTitle" id="cntMovDetalleTitulo">Detalle · ${escapeGastosHtml(origen.etiqueta || "Movimiento")}</h3>
            <dl class="movDetailList">
                ${cntDatosDelDetalle(m, transferencia, cuenta.id)
                    .map(
                        ([titulo, valor, clase]) =>
                            `<div class="movDetailItem"><dt>${escapeGastosHtml(titulo)}</dt><dd class="${clase}">${escapeGastosHtml(valor)}</dd></div>`
                    )
                    .join("")}
            </dl>
            <div class="movDetailNote${nota ? "" : " movDetailNoteEmpty"}">
                <span class="movDetailNoteLabel">Nota</span>
                <p class="movDetailNoteText">${nota ? escapeGastosHtml(nota) : "Sin nota"}</p>
            </div>
            <div class="assetModalActions">
                <button type="button" class="cancelButton" data-cnt-detalle-cerrar>Cerrar</button>
                ${accion}
            </div>
        </div>`

    overlay.addEventListener("click", (event) => {
        if (event.target === overlay || event.target.closest("[data-cnt-detalle-cerrar]")) return cntCerrarDetalle()
        if (event.target.closest("[data-cnt-detalle-editar]")) {
            cntCerrarDetalle()
            return cntAbrirModalTransferencia(transferencia)
        }
        const ver = event.target.closest("[data-cnt-detalle-ver]")
        if (ver) {
            cntCerrarPanel()
            document.querySelector(`[data-page="${ver.dataset.cntDetalleVer}"]`)?.click()
        }
    })
    document.addEventListener("keydown", cntDetalleTeclas)
    document.body.appendChild(overlay)
}

// ── Eventos ─────────────────────────────────────────────────────────────

function cntMontarVista(modal, cuenta) {
    if (cntPanel.vista === "resumen") {
        cntMontarResumen(modal, cuenta)
        if (cntHistorico) cntMontarDesglose(modal, cuenta)
    } else if (cntPanel.vista === "graficos") cntMontarGraficos(modal, cuenta)
    else if (cntPanel.vista === "todos" || cntPanel.vista === "ingresosGastos") cntMontarLista(modal, cuenta)
    else if (cntPanel.vista === "movimientos") cntMontarMovimientos(modal, cuenta)
}

function cntPanelClick(event) {
    const overlay = event.currentTarget
    if (event.target === overlay || event.target.closest("[data-cnt-cerrar]")) return cntCerrarPanel()
    if (!cntPanel) return
    const cuenta = cntCuentas.find((c) => c.id === cntPanel.cuentaId)
    const modal = overlay.querySelector(".cntPanel")
    if (!cuenta || !modal) return

    const ir = event.target.closest("[data-cnt-ir]")
    if (ir) {
        if (ir.dataset.cntIr === cntPanel.vista) return
        // Los filtros de Ingresos y gastos se conservan al cambiar de pestaña.
        cntPanel.vista = ir.dataset.cntIr
        return cntRenderPanel()
    }

    const rango = event.target.closest("[data-cnt-rango]")
    if (rango) {
        setChartPref(CNT_RANGO_PREF, rango.dataset.cntRango)
        // Las miniaturas de las tarjetas son siempre YTD; solo cambia la ventana.
        return cntRenderPanel()
    }

    const filtros = cntPanel.filtros[cntPanel.vista]
    const tipo = event.target.closest("[data-cnt-tipo]")
    if (tipo && filtros) {
        filtros.tipo = tipo.dataset.cntTipo
        return cntRenderLista(modal)
    }

    const year = event.target.closest("[data-cnt-year]")
    if (year && filtros) {
        filtros.year = year.dataset.cntYear
        filtros.mes = ""
        return cntRenderLista(modal)
    }

    const mes = event.target.closest("[data-cnt-mes]")
    if (mes && filtros) {
        filtros.mes = mes.dataset.cntMes
        return cntRenderLista(modal)
    }

    const pagina = event.target.closest("[data-cnt-ver-pagina]")
    if (pagina) {
        cntCerrarPanel()
        document.querySelector(`[data-page="${pagina.dataset.cntVerPagina}"]`)?.click()
        return
    }

    if (event.target.closest("[data-cnt-nueva-transferencia]")) return cntAbrirModalTransferencia(null, cuenta.id)

    const fila = event.target.closest("tr[data-transferencia], tr[data-orden]")
    if (!fila) return
    const transferencia = cntTransferencias.find((t) => String(t.id) === fila.dataset.transferencia)
    if (transferencia && event.target.closest("[data-cnt-editar]")) return cntAbrirModalTransferencia(transferencia)
    if (transferencia && event.target.closest("[data-cnt-eliminar]")) return cntEliminarTransferencia(transferencia)
    // El menú de la fila tiene sus propias acciones; pulsar el resto de la fila abre el detalle.
    if (event.target.closest(".rowMenu")) return
    const movimiento =
        fila.dataset.orden !== undefined
            ? cntPanel.lista?.find((m) => String(m.orden) === fila.dataset.orden)
            : cntMovimientoDeTransferencia(cuenta, transferencia)
    if (movimiento) cntAbrirDetalle(movimiento, cuenta)
}

function cntPanelInput(event) {
    if (!cntPanel || !event.target.classList.contains("cntBuscar")) return
    const cuenta = cntCuentas.find((c) => c.id === cntPanel.cuentaId)
    const modal = event.currentTarget.querySelector(".cntPanel")
    if (!cuenta || !modal) return
    // Cada pestaña guarda su búsqueda: cambiar de pestaña no la mezcla.
    if (event.target.classList.contains("cntBuscarMov")) {
        cntPanel.buscaMov = event.target.value
        cntRenderMovimientos(modal, cuenta)
    } else if (cntPanel.filtros[cntPanel.vista]) {
        cntPanel.filtros[cntPanel.vista].busca = event.target.value
        cntRenderLista(modal)
    }
}
