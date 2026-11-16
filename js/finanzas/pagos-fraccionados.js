// ===== MI DINERO › PAGOS FRACCIONADOS =====
// Vista de solo lectura de los gastos que se pagan enteros y se reparten con
// otros. En Gastos e Ingresos no se enseñan como tipo propio (el reparto ya está
// en tu parte y en las devoluciones); aquí se juntan con todo su detalle.
//
// Reutiliza de gastos.js el emparejado de filas (esFilaParteOtros,
// buscarFilaParteOtros, esDevolucionDe...): no hay un id que una un gasto con
// sus devoluciones y duplicar esa regla acabaría desincronizándose.

let pfAnio = ""
let pfPagos = []
let pfDetalleKeyHandler = null

/**
 * Junta los gastos fraccionados de un año con sus devoluciones.
 *
 * Una fila de gasto es un pago fraccionado si tiene su fila «parte de otros»
 * (misma fecha, cuenta y concepto). Las devoluciones son los ingresos del mismo
 * mes que cumplen esDevolucionDe. Todo en céntimos para no arrastrar error de
 * coma flotante.
 *
 * @param {Object<string, {rows: object[]}>} mesesGastos Meses del año de gastos.
 * @param {Object<string, {rows: object[]}>} mesesIngresos Meses del año de ingresos ({} si no existe).
 * @returns {{mes: string, fecha: string, concepto: string, tipo: string, cuenta: string,
 *            total: number, parte: number, devuelto: number, recibido: number,
 *            pendiente: number, nota: string, devoluciones: {nombre: string, cantidad: number, cuenta: string}[]}[]}
 *          Pagos en el orden de las filas del año.
 */
function construirPagosFraccionados(mesesGastos, mesesIngresos) {
    const pagos = []

    GASTOS_MONTHS.forEach((mes) => {
        const filas = Array.isArray(mesesGastos?.[mes.key]?.rows) ? mesesGastos[mes.key].rows : []
        const ingresos = Array.isArray(mesesIngresos?.[mes.key]?.rows) ? mesesIngresos[mes.key].rows : []

        filas.forEach((fila) => {
            const indiceOtros = buscarFilaParteOtros(filas, fila)
            if (indiceOtros < 0) return

            const concepto = conceptoFraccionado(fila.nombre)
            const parte = importeEnCentimos(fila.cantidad)
            const devuelto = importeEnCentimos(filas[indiceOtros].cantidad)
            const devoluciones = ingresos
                .filter((ingreso) => esDevolucionDe(ingreso, fila.fecha, concepto))
                .map((ingreso) => ({
                    nombre: personaDeDevolucion(ingreso, concepto),
                    cantidad: importeEnCentimos(ingreso.cantidad),
                    cuenta: ingreso.cuenta || ""
                }))
            const recibido = devoluciones.reduce((suma, devolucion) => suma + devolucion.cantidad, 0)

            pagos.push({
                mes: mes.key,
                fecha: fila.fecha || "",
                concepto,
                tipo: fila.tipo || "",
                cuenta: fila.cuenta || "",
                nota: fila.nota || "",
                total: parte + devuelto,
                parte,
                devuelto,
                recibido,
                pendiente: Math.max(devuelto - recibido, 0),
                devoluciones
            })
        })
    })

    return pagos
}

/**
 * Totales de una lista de pagos, en céntimos.
 *
 * @param {object[]} pagos Resultado de construirPagosFraccionados.
 * @returns {{total: number, parte: number, devuelto: number, pendiente: number}}
 */
function totalizarPagosFraccionados(pagos) {
    return pagos.reduce(
        (acc, pago) => ({
            total: acc.total + pago.total,
            parte: acc.parte + pago.parte,
            devuelto: acc.devuelto + pago.devuelto,
            pendiente: acc.pendiente + pago.pendiente
        }),
        { total: 0, parte: 0, devuelto: 0, pendiente: 0 }
    )
}

function pfEuro(centimos) {
    return formatEuro(centimos / 100)
}

/** Más reciente arriba; sin tocar el orden de `pfPagos`, que es el que usan los ids de fila. */
function pfOrdenar(pagos) {
    return [...pagos].sort((a, b) => gastoParseDate(b.fecha) - gastoParseDate(a.fecha))
}

function pfHtmlEstado(pago) {
    if (pago.pendiente > 0) return `<span class="mensBadge">Faltan ${pfEuro(pago.pendiente)}</span>`
    return `<span class="mensBadge">Devuelto</span>`
}

function pfCerrarDetalle() {
    document.getElementById("pfDetalleOverlay")?.remove()
    if (pfDetalleKeyHandler) {
        document.removeEventListener("keydown", pfDetalleKeyHandler)
        pfDetalleKeyHandler = null
    }
}

function pfHtmlDevolucionesDetalle(pago) {
    if (!pago.devoluciones.length) {
        return '<span class="movDetailNoteLabel">Devoluciones</span><p class="movDetailChargesEmpty">Sin ingresos de devoluciones registrados.</p>'
    }
    const items = pago.devoluciones
        .map(
            (devolucion) => `
            <li class="movDetailCharge">
                <span>${escapeHtml(devolucion.nombre || "Sin nombre")}</span>
                <span class="movDetailChargeAccount">${escapeHtml(nombreDeCuenta(devolucion.cuenta))}</span>
                <span class="movDetailChargeAmount">${pfEuro(devolucion.cantidad)}</span>
            </li>`
        )
        .join("")
    return `
        <span class="movDetailNoteLabel">Devoluciones (${pago.devoluciones.length})</span>
        <ul class="movDetailChargesList">${items}</ul>
    `
}

/**
 * Popup con el detalle de un pago fraccionado: reparto, estado y quién devolvió qué.
 *
 * @param {object} pago Elemento de construirPagosFraccionados.
 */
function pfAbrirDetalle(pago) {
    pfCerrarDetalle()

    const overlay = document.createElement("div")
    overlay.id = "pfDetalleOverlay"
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal movDetailModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.setAttribute("aria-labelledby", "pfDetalleTitulo")
    const nota = String(pago.nota || "").trim()
    modal.innerHTML = `
        <h3 class="assetModalTitle" id="pfDetalleTitulo">Detalle del pago fraccionado</h3>
        <dl class="movDetailList">
            <div class="movDetailItem"><dt>Fecha</dt><dd>${escapeHtml(pago.fecha || "—")}</dd></div>
            <div class="movDetailItem"><dt>Concepto</dt><dd>${escapeHtml(pago.concepto)}</dd></div>
            <div class="movDetailItem"><dt>Tipo</dt><dd>${escapeHtml(pago.tipo || "—")}</dd></div>
            <div class="movDetailItem"><dt>Pagado con</dt><dd>${escapeHtml(nombreDeCuenta(pago.cuenta))}</dd></div>
            <div class="movDetailItem"><dt>Total pagado</dt><dd>${pfEuro(pago.total)}</dd></div>
            <div class="movDetailItem"><dt>Te devuelven</dt><dd class="movDetailAmountPos">${pfEuro(pago.devuelto)}</dd></div>
            <div class="movDetailItem"><dt>Tu parte</dt><dd class="movDetailAmount">${pfEuro(pago.parte)}</dd></div>
            <div class="movDetailItem"><dt>Estado</dt><dd>${pago.pendiente > 0 ? `Faltan ${pfEuro(pago.pendiente)}` : "Devuelto"}</dd></div>
        </dl>
        <div class="movDetailCharges">${pfHtmlDevolucionesDetalle(pago)}</div>
        <div class="movDetailNote${nota ? "" : " movDetailNoteEmpty"}">
            <span class="movDetailNoteLabel">Nota</span>
            <p class="movDetailNoteText">${nota ? escapeHtml(nota) : "Sin nota"}</p>
        </div>
        <div class="assetModalActions">
            <button type="button" class="cancelButton" id="pfDetalleCerrarBtn">Cerrar</button>
        </div>
    `

    modal.querySelector("#pfDetalleCerrarBtn").addEventListener("click", pfCerrarDetalle)
    overlay.addEventListener("click", (evento) => {
        if (evento.target === overlay) pfCerrarDetalle()
    })
    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    pfDetalleKeyHandler = (evento) => {
        if (evento.key === "Escape") pfCerrarDetalle()
    }
    document.addEventListener("keydown", pfDetalleKeyHandler)
    modal.querySelector("#pfDetalleCerrarBtn").focus()
}

function pfAbrirDetalleDeFila(fila) {
    const pago = pfPagos[Number(fila?.dataset.pfId)]
    if (pago) pfAbrirDetalle(pago)
}

function pfRenderResumen(pagos) {
    const contenedor = document.getElementById("pfSummary")
    if (!contenedor) return
    const totales = totalizarPagosFraccionados(pagos)
    const tarjeta = (etiqueta, valor, pista) => `
        <div class="mensCard">
            <p class="mensCardLabel">${etiqueta}</p>
            <p class="mensCardValue">${valor}</p>
            <p class="mensCardHint">${pista}</p>
        </div>`
    contenedor.innerHTML = [
        tarjeta("Pagos", String(pagos.length), "En el año"),
        tarjeta("Total adelantado", pfEuro(totales.total), "Lo que salió de las cuentas"),
        tarjeta("Tu parte", pfEuro(totales.parte), "Lo que te cuesta de verdad"),
        tarjeta("Pendiente", pfEuro(totales.pendiente), "Por recibir de los demás")
    ].join("")
}

function pfRenderTabla(pagos) {
    const cuerpo = document.getElementById("pfBody")
    const pie = document.getElementById("pfFoot")
    const vacio = document.getElementById("pfEmptyMsg")
    const envoltorio = document.getElementById("pfTableWrapper")
    if (!cuerpo || !pie) return

    vacio?.classList.toggle("hidden", pagos.length > 0)
    envoltorio?.classList.toggle("hidden", pagos.length === 0)

    cuerpo.innerHTML = pfOrdenar(pagos)
        .map(
            (pago) => `
            <tr data-pf-id="${pfPagos.indexOf(pago)}" tabindex="0">
                <td>${escapeHtml(pago.fecha)}</td>
                <td><strong>${escapeHtml(pago.concepto)}</strong></td>
                <td>${escapeHtml(pago.tipo)}</td>
                <td>${escapeHtml(nombreDeCuenta(pago.cuenta))}</td>
                <td class="pfNum">${pfEuro(pago.total)}</td>
                <td class="pfNum">${pfEuro(pago.parte)}</td>
                <td class="pfNum">${pfEuro(pago.devuelto)}</td>
                <td>${pfHtmlEstado(pago)}</td>
            </tr>`
        )
        .join("")

    const totales = totalizarPagosFraccionados(pagos)
    pie.innerHTML = pagos.length
        ? `<tr>
            <td colspan="4">Total</td>
            <td class="pfNum">${pfEuro(totales.total)}</td>
            <td class="pfNum">${pfEuro(totales.parte)}</td>
            <td class="pfNum">${pfEuro(totales.devuelto)}</td>
            <td>${totales.pendiente > 0 ? `Faltan ${pfEuro(totales.pendiente)}` : ""}</td>
        </tr>`
        : ""
}

function pfRenderAnios(anios) {
    const lista = document.getElementById("pfYearList")
    if (!lista) return
    lista.innerHTML = anios
        .map(
            (anio) =>
                `<button type="button" class="gastosYearBtn${anio === pfAnio ? " active" : ""}" data-pf-anio="${escapeHtml(anio)}">${escapeHtml(anio)}</button>`
        )
        .join("")
    refrescarTiraPestanas(lista)
}

/** Ingresos del año; un año sin crear es «sin devoluciones», no un error. */
async function pfCargarIngresos(anio) {
    try {
        const datos = await Api.get(`/api/ingresos/${encodeURIComponent(anio)}`)
        return datos?.months || {}
    } catch (error) {
        if (error?.status === 404) return {}
        throw error
    }
}

async function pfSeleccionarAnio(anio) {
    pfAnio = anio
    const [gastos, mesesIngresos] = await Promise.all([loadGastosYear(anio), pfCargarIngresos(anio)])
    pfPagos = construirPagosFraccionados(gastos?.months, mesesIngresos)
    pfRenderResumen(pfPagos)
    pfRenderTabla(pfPagos)
    document.querySelectorAll("#pfYearList [data-pf-anio]").forEach((boton) => {
        boton.classList.toggle("active", boton.dataset.pfAnio === anio)
    })
}

function pfBindEventos() {
    const cuerpo = document.getElementById("pfBody")
    if (cuerpo && !cuerpo.dataset.bound) {
        cuerpo.dataset.bound = "true"
        cuerpo.addEventListener("click", (evento) => pfAbrirDetalleDeFila(evento.target.closest("tr[data-pf-id]")))
        cuerpo.addEventListener("keydown", (evento) => {
            if (evento.key === "Enter") pfAbrirDetalleDeFila(evento.target.closest("tr[data-pf-id]"))
        })
    }

    const lista = document.getElementById("pfYearList")
    if (lista && !lista.dataset.bound) {
        lista.dataset.bound = "true"
        lista.addEventListener("click", (evento) => {
            const boton = evento.target.closest("[data-pf-anio]")
            if (!boton) return
            pfSeleccionarAnio(boton.dataset.pfAnio).catch((error) =>
                showError("No se pudieron cargar los pagos fraccionados", error)
            )
        })
    }
}

/** Entrada de la página (la llama loadPage en app-core.js). */
async function initPagosFraccionadosLogic() {
    pfBindEventos()
    const [anios] = await Promise.all([loadGastosYears(), cargarCuentasDinero()])
    pfAnio = anios.includes(pfAnio) ? pfAnio : anios[0] || String(new Date().getFullYear())
    pfRenderAnios(anios)
    await pfSeleccionarAnio(pfAnio)
}
