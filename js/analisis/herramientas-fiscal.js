// Análisis > Herramientas: compensación de pérdidas, IRPF del ahorro y doble
// imposición.
//
// Trozo de js/analisis/herramientas.js. Comparte con el resto de herramientas-*.js el
// ámbito global y se carga detrás de herramientas.js, en el orden de index.html.
//
// Las dos primeras las calcula el servidor (/api/herramientas/compensacion y
// /api/herramientas/irpf-ahorro), que reutiliza el FIFO y la normativa de la
// pantalla de Ventas: aquí solo se recogen parámetros y se pinta. La doble
// imposición es aritmética de una sola renta y se resuelve en el navegador.

/**
 * Fecha de hoy en el formato de la aplicación.
 *
 * @param {Date} [hoy] Fecha de referencia; por defecto, la actual.
 * @returns {string} "dd-mm-aaaa".
 */
function hFiscalHoy(hoy = new Date()) {
    const dd = String(hoy.getDate()).padStart(2, "0")
    const mm = String(hoy.getMonth() + 1).padStart(2, "0")
    return `${dd}-${mm}-${hoy.getFullYear()}`
}

/**
 * Pinta un importe en euros que llega del servidor como texto con punto.
 *
 * @param {string|number} valor Importe.
 * @returns {string} Importe con formato de la aplicación.
 */
function hFiscalEuros(valor) {
    return formatEuro(parseFloat(valor) || 0)
}

/**
 * Llena una lista de avisos sin interpretar HTML.
 *
 * @param {HTMLElement|null} lista Elemento <ul>.
 * @param {string[]} avisos Textos.
 */
function hFiscalPintarAvisos(lista, avisos) {
    if (!lista) return
    lista.innerHTML = ""
    ;(avisos || []).forEach((texto) => {
        const li = document.createElement("li")
        li.textContent = texto
        lista.appendChild(li)
    })
}

/**
 * Añade una fila de celdas de texto a un <tbody>.
 *
 * @param {HTMLElement} cuerpo Destino.
 * @param {string[]} celdas Textos de cada celda.
 * @returns {HTMLTableRowElement} La fila creada.
 */
function hFiscalFila(cuerpo, celdas) {
    const tr = document.createElement("tr")
    celdas.forEach((texto) => {
        const td = document.createElement("td")
        td.textContent = texto
        tr.appendChild(td)
    })
    cuerpo.appendChild(tr)
    return tr
}

/**
 * Muestra un mensaje de estado bajo los parámetros.
 *
 * @param {string} id Id del elemento.
 * @param {string} texto Mensaje; vacío lo oculta.
 * @param {boolean} [aviso] Si es un aviso (color de advertencia).
 */
function hFiscalMensaje(id, texto, aviso = false) {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = texto
    el.className = "hPrecargaMsg" + (aviso ? " hRatioFuenteWarn" : "")
}

/**
 * Pide JSON a una ruta de herramientas y normaliza el error.
 *
 * @param {string} url Ruta con su consulta.
 * @returns {Promise<object>} El cuerpo si `ok`.
 * @throws {Error} Con el mensaje del servidor o uno genérico.
 */
async function hFiscalPedir(url) {
    const respuesta = await fetch(url)
    // Un 502 del proxy llega como HTML: sin cuerpo JSON el error es el genérico.
    const datos = await respuesta.json().catch(() => null)
    if (!respuesta.ok || !datos || !datos.ok) {
        throw new Error((datos && datos.error) || "No se pudo calcular.")
    }
    return datos
}

// ── Compensar pérdidas ─────────────────────────────────────────────────────

function hCompPreparar() {
    const fecha = document.getElementById("hCompFecha")
    if (fecha && !fecha.value) fecha.value = hFiscalHoy()
}

async function hCompCalcular() {
    const boton = document.getElementById("hCompCalcBtn")
    const fecha = document.getElementById("hCompFecha")?.value.trim() || ""
    const parametros = new URLSearchParams(fecha ? { fecha } : {})

    if (boton) boton.disabled = true
    hFiscalMensaje("hCompMsg", "Analizando…")
    try {
        const { compensacion } = await hFiscalPedir(`/api/herramientas/compensacion?${parametros}`)
        hCompPintar(compensacion)
        hFiscalMensaje("hCompMsg", "")
    } catch (error) {
        console.error(error)
        hFiscalMensaje("hCompMsg", error.message, true)
    } finally {
        if (boton) boton.disabled = false
    }
}

function hCompPintar(dato) {
    document.getElementById("hCompAhorro").textContent = hFiscalEuros(dato.conjunta.ahorroCuota)
    document.getElementById("hCompCuota").textContent = hFiscalEuros(dato.ejercicio.cuota)
    document.getElementById("hCompArrastre").textContent = hFiscalEuros(dato.conjunta.perdidaParaAnosSiguientes)

    const saldo = parseFloat(dato.ejercicio.saldo) || 0
    const celdaSaldo = document.getElementById("hCompSaldo")
    celdaSaldo.textContent = hFiscalEuros(saldo)
    celdaSaldo.className = "hResultValue " + (saldo >= 0 ? "hResultPositive" : "hResultNegative")

    const cuerpo = document.getElementById("hCompBody")
    cuerpo.innerHTML = ""
    dato.candidatas.forEach((c) => {
        const fila = hFiscalFila(cuerpo, [
            c.nombre,
            hFiscalEuros(c.perdida),
            hFiscalEuros(c.ahorroCuota),
            hFiscalEuros(c.perdidaParaAnosSiguientes),
            `${c.recompraDesde} (${c.ventanaMeses} ${c.ventanaMeses === 1 ? "mes" : "meses"})`
        ])
        // La nota de antiaplicación explica por qué una pérdida no ahorra lo
        // que parece; se deja a mano al pasar el ratón, sin otra columna.
        if (c.notaAntiaplicacion) fila.title = c.notaAntiaplicacion
    })

    const vacio = document.getElementById("hCompVacio")
    vacio.textContent = dato.candidatas.length
        ? ""
        : "Ninguna posición está en pérdidas con los últimos precios guardados."

    const noEvaluables = document.getElementById("hCompNoEvaluables")
    if (dato.noEvaluables.length) {
        noEvaluables.textContent =
            "Sin evaluar: " + dato.noEvaluables.map((n) => `${n.nombre} (${n.motivo})`).join(" · ")
        noEvaluables.classList.remove("hidden")
    } else {
        noEvaluables.classList.add("hidden")
    }

    hFiscalPintarAvisos(document.getElementById("hCompAvisos"), dato.advertencias)
    document.getElementById("hCompResults").classList.remove("hidden")
}

// ── IRPF del ahorro ────────────────────────────────────────────────────────

/**
 * Filas del desglose de la previsión, en orden de lectura de la declaración.
 *
 * Las de importe cero que no aportan nada (compensaciones que no se dan,
 * tramos vacíos) se omiten para que la tabla no sea una lista de ceros.
 *
 * @param {object} p Previsión tal como la devuelve el servidor.
 * @returns {Array<[string, number]>} Pares concepto e importe.
 */
function hIrpfFilasDesglose(p) {
    const num = (v) => parseFloat(v) || 0
    const r = p.rendimientos
    const i = p.integracion
    const filas = [
        [`Dividendos brutos (${r.dividendosCobros})`, num(r.dividendosBrutos)],
        [`Intereses brutos (${r.interesesApuntes})`, num(r.interesesBrutos)],
        ["Saldo de ganancias y pérdidas", num(i.saldoGyp)]
    ]
    const opcionales = [
        ["Pérdida compensada con rendimientos (25 %)", -num(i.cruzadoGypContraRcm)],
        ["Rendimiento negativo compensado con ganancias (25 %)", -num(i.cruzadoRcmContraGyp)],
        ["Pérdidas de años anteriores contra ganancias", -num(i.arrastresAplicadosGyp)],
        ["Pérdidas de años anteriores contra rendimientos", -num(i.arrastresAplicadosRcm)]
    ]
    opcionales.forEach((fila) => {
        if (fila[1] !== 0) filas.push(fila)
    })
    filas.push(["Base liquidable del ahorro", num(p.base)])
    // Las claves son tramo1…tramo5: el número sale de la clave y no del orden,
    // que en JSON no está garantizado.
    Object.entries(p.tramos || {})
        .sort(([a], [b]) => a.localeCompare(b, "es", { numeric: true }))
        .forEach(([clave, valor]) => {
            if (num(valor) > 0) filas.push([`Cuota tramo ${clave.replace(/\D/g, "")}`, num(valor)])
        })
    if (num(i.perdidaArrastrable) > 0) {
        filas.push(["Pérdida para los 4 años siguientes", num(i.perdidaArrastrable)])
    }
    return filas
}

function hIrpfPreparar() {
    const anio = document.getElementById("hIrpfAnio")
    if (anio && !anio.value) {
        anio.value = new Date().getFullYear()
        // Reiniciar devuelve los campos numéricos a su defaultValue: el año
        // en curso es el valor natural, no un campo vacío.
        anio.defaultValue = anio.value
    }
}

async function hIrpfCalcular() {
    const boton = document.getElementById("hIrpfCalcBtn")
    const anio = document.getElementById("hIrpfAnio")?.value.trim() || ""
    const retenciones = document.getElementById("hIrpfRetenciones")?.value.trim() || ""
    const parametros = new URLSearchParams({ anio })
    if (retenciones) parametros.set("retenciones", retenciones)

    if (boton) boton.disabled = true
    hFiscalMensaje("hIrpfMsg", "Calculando…")
    try {
        const { prevision } = await hFiscalPedir(`/api/herramientas/irpf-ahorro?${parametros}`)
        hIrpfPintar(prevision)
        hFiscalMensaje("hIrpfMsg", "")
    } catch (error) {
        console.error(error)
        hFiscalMensaje("hIrpfMsg", error.message, true)
    } finally {
        if (boton) boton.disabled = false
    }
}

function hIrpfPintar(p) {
    const resultado = parseFloat(p.resultado) || 0
    document.getElementById("hIrpfResultadoLabel").textContent =
        resultado >= 0 ? "A pagar (parte del ahorro)" : "A devolver (parte del ahorro)"
    const celda = document.getElementById("hIrpfResultado")
    celda.textContent = hFiscalEuros(Math.abs(resultado))
    celda.className = "hResultValue " + (resultado > 0 ? "hResultNegative" : "hResultPositive")

    document.getElementById("hIrpfCuota").textContent = hFiscalEuros(p.cuota)
    document.getElementById("hIrpfRet").textContent = hFiscalEuros(p.retencionesAplicadas)
    document.getElementById("hIrpfTipo").textContent =
        (parseFloat(p.tipoMedio) || 0).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
        " %"

    const cuerpo = document.getElementById("hIrpfBody")
    cuerpo.innerHTML = ""
    hIrpfFilasDesglose(p).forEach(([concepto, importe]) => {
        hFiscalFila(cuerpo, [concepto, formatEuro(importe)])
    })

    hFiscalPintarAvisos(document.getElementById("hIrpfAvisos"), p.advertencias)
    document.getElementById("hIrpfResults").classList.remove("hidden")
}

// ── Doble imposición internacional ─────────────────────────────────────────
// Art. 80 LIRPF: se deduce lo menor entre lo pagado fuera (como mucho, el tipo
// del convenio) y lo que España cobraría por esa misma renta. Lo retenido por
// encima del convenio no se deduce aquí: se reclama al otro país.

/**
 * Reparto de la retención extranjera de un dividendo.
 *
 * @param {{bruto: number, origen: number, convenio: number, tipo: number}} datos
 *     Dividendo bruto en euros y los tres porcentajes (0-100): retención en
 *     origen, límite del convenio y tipo del ahorro en España.
 * @returns {{retenido: number, deduccion: number, reclamable: number,
 *     perdido: number, cuotaEspana: number, aPagarEspana: number, neto: number,
 *     netoConReclamacion: number} | null} null si algún dato no es válido.
 */
function hDiCalcular({ bruto, origen, convenio, tipo }) {
    const pct = (v) => Number.isFinite(v) && v >= 0 && v <= 100
    if (!(bruto > 0) || !pct(origen) || !pct(convenio) || !pct(tipo)) return null

    const retenido = (bruto * origen) / 100
    const topeConvenio = (bruto * convenio) / 100
    const cuotaEspana = (bruto * tipo) / 100
    const reclamable = Math.max(0, retenido - topeConvenio)
    const deduccion = Math.min(retenido, topeConvenio, cuotaEspana)
    const perdido = retenido - reclamable - deduccion
    const aPagarEspana = cuotaEspana - deduccion
    const neto = bruto - retenido - aPagarEspana
    return {
        retenido,
        deduccion,
        reclamable,
        perdido,
        cuotaEspana,
        aPagarEspana,
        neto,
        netoConReclamacion: neto + reclamable
    }
}

function hDiLeer(id) {
    const texto = document.getElementById(id)?.value ?? ""
    return texto.trim() === "" ? NaN : parseFloat(texto)
}

function hDiCalcularPanel() {
    const r = hDiCalcular({
        bruto: hDiLeer("hDiBruto"),
        origen: hDiLeer("hDiOrigen"),
        convenio: hDiLeer("hDiConvenio"),
        tipo: hDiLeer("hDiTipo")
    })
    if (!r) {
        hFiscalMensaje("hDiMsg", "Rellena el bruto y los tres porcentajes (entre 0 y 100).", true)
        return
    }
    hFiscalMensaje("hDiMsg", "")

    document.getElementById("hDiNeto").textContent = formatEuro(r.neto)
    document.getElementById("hDiRetenido").textContent = formatEuro(r.retenido)
    document.getElementById("hDiDeduccion").textContent = formatEuro(r.deduccion)
    document.getElementById("hDiEspana").textContent = formatEuro(r.aPagarEspana)
    document.getElementById("hDiReclamable").textContent = formatEuro(r.reclamable)
    const perdido = document.getElementById("hDiPerdido")
    perdido.textContent = formatEuro(r.perdido)
    // En rojo solo si de verdad se pierde algo: un 0 en rojo parece un error.
    perdido.className = "hResultValue" + (r.perdido > 0.005 ? " hResultNegative" : "")

    const nota = document.getElementById("hDiNota")
    if (r.reclamable > 0) {
        nota.textContent =
            `Te han retenido ${formatEuro(r.reclamable)} por encima del convenio. ` +
            "Eso no se deduce en la Renta: se reclama a la administración del otro país. " +
            `Si lo recuperas, el neto sube a ${formatEuro(r.netoConReclamacion)}.`
        nota.className = "hRatioInterpretacion hRatioInfoNeg"
    } else if (r.perdido > 0) {
        nota.textContent =
            `Tu tipo en España es menor que la retención en origen: ${formatEuro(r.perdido)} ` +
            "no se recuperan, porque la deducción no puede superar lo que España cobraría por esa renta."
        nota.className = "hRatioInterpretacion hRatioInfoNeg"
    } else {
        nota.textContent = "Toda la retención en origen se recupera con la deducción por doble imposición."
        nota.className = "hRatioInterpretacion hRatioInfoPos"
    }

    document.getElementById("hDiResults").classList.remove("hidden")
}

// ── Arranque y reinicio ────────────────────────────────────────────────────

function hFiscalIniciar() {
    hCompPreparar()
    hIrpfPreparar()
    document.getElementById("hCompCalcBtn")?.addEventListener("click", hCompCalcular)
    document.getElementById("hIrpfCalcBtn")?.addEventListener("click", hIrpfCalcular)
    document.getElementById("hDiCalcBtn")?.addEventListener("click", hDiCalcularPanel)
}

function hFiscalReiniciar(panelId) {
    if (panelId === "toolCompensacion") {
        const fecha = document.getElementById("hCompFecha")
        if (fecha) fecha.value = ""
        hCompPreparar()
        hFiscalMensaje("hCompMsg", "")
    }
    if (panelId === "toolIrpfAhorro") hFiscalMensaje("hIrpfMsg", "")
    if (panelId === "toolDobleImposicion") hFiscalMensaje("hDiMsg", "")
}
