// ===== CUENTAS · VENTANA DE UNA CUENTA =====
// Lo que se abre desde una tarjeta de la ventana Cuentas: una sola ventana con
// pestañas.
//   · «resumen»: lo que ha entrado y salido en el periodo y la gráfica del saldo;
//   · «ingresosGastos»: lo apuntado en Gastos e Ingresos con esta cuenta;
//   · «movimientos»: sus transferencias, que se editan desde aquí;
//   · «graficos»: el saldo ampliado y las entradas y salidas de cada mes.

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
    { vista: "ingresosGastos", etiqueta: "Ingresos y gastos" },
    { vista: "movimientos", etiqueta: "Transferencias" },
    { vista: "graficos", etiqueta: "Gráficos" }
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
    cntPanel = { vista: vistaValida, cuentaId, tipo: "", year: "", mes: "", busca: "", buscaMov: "" }
    cntRenderPanel()
}

function cntCerrarPanel() {
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
        ingresosGastos: cntVistaIngresosGastos,
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
            </div>
            <div class="cuentasKpi" title="Todo lo que ha salido de la cuenta en el periodo, comisiones incluidas">
                <span class="cuentasKpiTitulo">Salidas</span>
                <span class="cuentasKpiValor cuentasNeg">${formatEuro(-salidas)}</span>
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
        ${cntDatosCuenta(cuenta)}`
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
    if (inicial) filas.push(["Saldo inicial", formatEuro(inicial), ""])
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

// ── Pestaña «ingresosGastos» ────────────────────────────────────────────

async function cntCargarMovimientosCuenta(cuentaId) {
    if (!cntPanelMovimientos[cuentaId]) {
        const datos = await Api.get(`/api/cuentas/${encodeURIComponent(cuentaId)}/movimientos`)
        cntPanelMovimientos[cuentaId] = Array.isArray(datos?.movimientos) ? datos.movimientos : []
    }
    return cntPanelMovimientos[cuentaId]
}

function cntVistaIngresosGastos() {
    return `
        <div class="cntIGBarra">
            <label class="cntBuscarCaja">
                <span class="icono iconoBuscar" aria-hidden="true"></span>
                <input type="search" class="cntBuscar" value="${escapeGastosHtml(cntPanel.busca)}" placeholder="Buscar" aria-label="Buscar en la tabla" autocomplete="off" spellcheck="false">
            </label>
            <div class="cntIGFiltroTipo"></div>
            <div class="cntYears"></div>
        </div>
        <div class="cntMeses"></div>
        <p class="cntTablaResumen" aria-live="polite"></p>
        <div class="gastosMovementsWrapper cntPanelTablaWrap">
            <table class="gastosMovementsTable cntPanelTabla">
                <thead><tr><th>Fecha</th><th>Concepto</th><th>Categoría</th><th class="numCol">Importe</th><th class="rowActionHeader"></th></tr></thead>
                <tbody></tbody>
            </table>
            <p class="overviewEmpty cntPanelVacio">Cargando…</p>
        </div>`
}

async function cntMontarIngresosGastos(modal, cuenta) {
    let movimientos
    try {
        movimientos = unirGastosFraccionados(
            (await cntCargarMovimientosCuenta(cuenta.id)).filter((m) => m.origen === "ingreso" || m.origen === "gasto")
        )
    } catch (error) {
        console.error("Error cargando los movimientos de la cuenta:", error)
        const vacio = modal.querySelector(".cntPanelVacio")
        if (vacio) vacio.textContent = "No se pudieron cargar los movimientos de la cuenta."
        return
    }
    // La pestaña puede haber cambiado mientras llegaba la respuesta.
    if (cntPanel?.vista !== "ingresosGastos" || cntPanel.cuentaId !== cuenta.id) return

    const years = [...new Set(movimientos.map((m) => m.year).filter(Boolean))].sort().reverse()
    const thisYear = String(new Date().getFullYear())
    if (!cntPanel.year || !years.includes(cntPanel.year))
        cntPanel.year = years.includes(thisYear) ? thisYear : years[0] || ""
    cntPanel.igMovimientos = movimientos
    cntPanel.igYears = years
    cntRenderIngresosGastos(modal, cuenta)
}

function cntFiltrarIngresosGastos() {
    const busca = cntPanel.busca.trim().toLocaleLowerCase("es")
    return (cntPanel.igMovimientos || [])
        .filter((m) => m.year === cntPanel.year)
        .filter((m) => !cntPanel.tipo || m.origen === cntPanel.tipo)
        .filter((m) => !cntPanel.mes || m.month === cntPanel.mes)
        .filter(
            (m) =>
                !busca ||
                [m.fecha, m.nombre, m.contraparte, m.nota, m.cantidad].some((v) =>
                    String(v || "")
                        .toLocaleLowerCase("es")
                        .includes(busca)
                )
        )
        .sort((a, b) => cntFechaClave(b.fecha) - cntFechaClave(a.fecha) || b.id - a.id)
}

// Repinta filtros y tabla, pero no el buscador: así no pierde el foco al escribir.
function cntRenderIngresosGastos(modal) {
    const movimientos = cntPanel.igMovimientos || []
    const conMovimientos = new Set(movimientos.filter((m) => m.year === cntPanel.year).map((m) => m.month))

    const tipo = modal.querySelector(".cntIGFiltroTipo")
    if (tipo)
        tipo.innerHTML = cntSegmento(
            [
                ["", "Todos"],
                ["ingreso", "Ingresos"],
                ["gasto", "Gastos"]
            ],
            cntPanel.tipo,
            "data-cnt-tipo",
            "Tipo"
        )
    // Con un solo año no hace falta elegir.
    const years = modal.querySelector(".cntYears")
    if (years) {
        const lista = cntPanel.igYears || []
        years.innerHTML =
            lista.length > 1
                ? cntSegmento(
                      lista.map((y) => [y, y]),
                      cntPanel.year,
                      "data-cnt-year",
                      "Año"
                  )
                : ""
    }
    const meses = modal.querySelector(".cntMeses")
    if (meses) {
        meses.innerHTML = cntSegmento(
            [["", "Todo el año"], ...CNT_MESES_CLAVE.map((clave, i) => [clave, CNT_MESES_CORTOS[i]])],
            cntPanel.mes,
            "data-cnt-mes",
            "Mes"
        )
        meses.querySelectorAll("[data-cnt-mes]").forEach((b) => {
            b.classList.toggle("cntMesVacio", Boolean(b.dataset.cntMes) && !conMovimientos.has(b.dataset.cntMes))
        })
    }

    const filas = cntFiltrarIngresosGastos()
    const totalIngresos = filas
        .filter((m) => m.origen === "ingreso")
        .reduce((s, m) => s + parseEuroNumber(m.cantidad), 0)
    const totalGastos = filas.filter((m) => m.origen === "gasto").reduce((s, m) => s + parseEuroNumber(m.cantidad), 0)
    const resumen = modal.querySelector(".cntTablaResumen")
    if (resumen) {
        resumen.innerHTML = filas.length
            ? `${filas.length} ${filas.length === 1 ? "movimiento" : "movimientos"}
               <span class="cntTablaResumenSep">·</span> Ingresos <strong class="cuentasPos">${cntSigned(totalIngresos)}</strong>
               <span class="cntTablaResumenSep">·</span> Gastos <strong class="cuentasNeg">${formatEuro(-totalGastos)}</strong>`
            : ""
    }

    const body = modal.querySelector(".cntPanelTabla tbody")
    if (body) {
        body.innerHTML = filas
            .map((m) => {
                const importe = parseEuroNumber(m.cantidad)
                const esIngreso = m.origen === "ingreso"
                const destino = esIngreso ? "ingresos" : "gastos"
                return `
                <tr class="movDetailRow">
                    <td class="cntCeldaFecha">${escapeGastosHtml(m.fecha)}</td>
                    <td title="${escapeGastosHtml(m.nota || "")}">
                        <span class="cntFlecha ${esIngreso ? "cntFlechaEntra" : "cntFlechaSale"}" aria-label="${esIngreso ? "Ingreso" : "Gasto"}"></span>
                        ${m.nombre ? escapeGastosHtml(m.nombre) : '<span class="cuentasSinConcepto">Sin concepto</span>'}${m.fraccionado ? '<span class="gastosMensualidadTag" title="Pago fraccionado: importe total que salió de la cuenta">Fraccionado</span>' : ""}
                    </td>
                    <td><span class="cntCategoria">${escapeGastosHtml(m.contraparte || "—")}</span></td>
                    <td class="numCell ${esIngreso ? "cuentasPos" : "cuentasNeg"}">${esIngreso ? cntSigned(importe) : formatEuro(-importe)}</td>
                    <td class="rowActionsCell">
                        <div class="rowMenu">
                            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                            <div class="rowMenuDropdown">
                                <button type="button" class="rowMenuItem" data-cnt-ver-pagina="${destino}">${esIngreso ? "Ver en Ingresos" : "Ver en Gastos"}</button>
                            </div>
                        </div>
                    </td>
                </tr>`
            })
            .join("")
    }

    const vacio = modal.querySelector(".cntPanelVacio")
    if (vacio) {
        vacio.textContent = movimientos.length
            ? "No hay movimientos con estos filtros."
            : "Esta cuenta no tiene nada apuntado en Gastos ni en Ingresos."
        vacio.classList.toggle("hidden", filas.length > 0)
    }
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
                <thead><tr><th>Fecha</th><th>Contraparte</th><th>Concepto</th><th class="numCol">Importe</th><th class="numCol">Comisión</th><th class="rowActionHeader"></th></tr></thead>
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
        body.innerHTML = filas
            .map((t) => {
                const entra = t.destino === cuenta.id
                const comision = parseEuroNumber(t.comision)
                return `
                <tr class="movDetailRow" data-id="${t.id}">
                    <td class="cntCeldaFecha">${escapeGastosHtml(t.fecha)}</td>
                    <td>
                        <span class="cntFlecha ${entra ? "cntFlechaEntra" : "cntFlechaSale"}" aria-label="${entra ? "Entrada" : "Salida"}"></span>
                        ${escapeGastosHtml(entra ? t.origen_nombre : t.destino_nombre)}
                    </td>
                    <td title="${escapeGastosHtml(t.nota || "")}">${t.concepto ? escapeGastosHtml(t.concepto) : '<span class="cuentasSinConcepto">Sin concepto</span>'}</td>
                    <td class="numCell ${entra ? "cuentasPos" : "cuentasNeg"}">${entra ? cntSigned(parseEuroNumber(t.cantidad)) : formatEuro(-parseEuroNumber(t.cantidad))}</td>
                    <td class="numCell">${comision > 0 ? `<span class="cuentasNeg">${formatEuro(-comision)}</span>` : '<span class="cuentasSinConcepto">—</span>'}</td>
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

// ── Eventos ─────────────────────────────────────────────────────────────

function cntMontarVista(modal, cuenta) {
    if (cntPanel.vista === "resumen") cntMontarResumen(modal, cuenta)
    else if (cntPanel.vista === "graficos") cntMontarGraficos(modal, cuenta)
    else if (cntPanel.vista === "ingresosGastos") cntMontarIngresosGastos(modal, cuenta)
    else if (cntPanel.vista === "movimientos") cntRenderMovimientos(modal, cuenta)
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

    const tipo = event.target.closest("[data-cnt-tipo]")
    if (tipo) {
        cntPanel.tipo = tipo.dataset.cntTipo
        return cntRenderIngresosGastos(modal, cuenta)
    }

    const year = event.target.closest("[data-cnt-year]")
    if (year) {
        cntPanel.year = year.dataset.cntYear
        cntPanel.mes = ""
        return cntRenderIngresosGastos(modal, cuenta)
    }

    const mes = event.target.closest("[data-cnt-mes]")
    if (mes) {
        cntPanel.mes = mes.dataset.cntMes
        return cntRenderIngresosGastos(modal, cuenta)
    }

    const pagina = event.target.closest("[data-cnt-ver-pagina]")
    if (pagina) {
        cntCerrarPanel()
        document.querySelector(`[data-page="${pagina.dataset.cntVerPagina}"]`)?.click()
        return
    }

    if (event.target.closest("[data-cnt-nueva-transferencia]")) return cntAbrirModalTransferencia(null, cuenta.id)

    const fila = event.target.closest("tr[data-id]")
    const transferencia = fila && cntTransferencias.find((t) => String(t.id) === fila.dataset.id)
    if (!transferencia) return
    if (event.target.closest("[data-cnt-editar]")) cntAbrirModalTransferencia(transferencia)
    else if (event.target.closest("[data-cnt-eliminar]")) cntEliminarTransferencia(transferencia)
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
    } else {
        cntPanel.busca = event.target.value
        cntRenderIngresosGastos(modal, cuenta)
    }
}
