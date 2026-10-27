// ===== CUENTA REMUNERADA: GRÁFICAS Y RESUMEN DEL AÑO =====
// Trozo de intereses.js: lee su estado (_allInteresesRows, currentInteresesYear,
// getCurrentCuenta) y se repinta desde updateTotals(), de modo que sigue a la
// tabla en cada cambio de cuenta, de año o de fila sin enganches propios.

const INTERESES_MESES_INICIAL = ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"]
const INTERESES_MESES_NOMBRE = [
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
// La TAE que anuncian los bancos es anual: la aproximada mira el último año.
const INTERESES_MESES_TAE = 12

// Medidas del viewBox de las dos gráficas. Comparten eje X (el centro de cada
// mes) para que barras y línea queden alineadas mes a mes.
// Bajas para que, con los doce meses en la tabla, quepan sin scroll en 1080p.
const INTERESES_GRAFICA = { W: 400, H: 90, padX: 8, top: 8, bottom: 16 }

let interesesSaldosCuentas = new Map() // id en «Cuentas» -> saldo en euros
let interesesGraficaMeses = null
let interesesGraficaAcumulado = null

// ----- Cálculos -----

/**
 * Mes (0-11) de una fecha de la tabla.
 *
 * Args:
 *     fecha: "dd-mm-aaaa" o, en filas antiguas, "mm-aaaa".
 *
 * Returns:
 *     El índice del mes, o null si la fecha no se puede leer.
 */
function parseInteresMes(fecha) {
    const p = String(fecha || "").split("-")
    const mes = Number(p.length === 3 ? p[1] : p.length === 2 ? p[0] : NaN)
    return Number.isInteger(mes) && mes >= 1 && mes <= 12 ? mes - 1 : null
}

/**
 * Bruto, impuestos y neto de cada mes de un año.
 *
 * Varias filas en el mismo mes se suman. `acumulado` es el bruto de la fila,
 * como en la tabla (total = acumulado - impuestos).
 *
 * Args:
 *     rows: filas de la cuenta remunerada.
 *     year: año a calcular, como texto o número.
 *
 * Returns:
 *     Doce objetos { bruto, impuestos, neto, conDatos }, de enero a diciembre.
 */
function calcularInteresesPorMes(rows, year) {
    const meses = Array.from({ length: 12 }, () => ({ bruto: 0, impuestos: 0, neto: 0, conDatos: false }))
    rows.forEach((row) => {
        if (parseInteresYear(row.fecha) !== String(year)) return
        const mes = parseInteresMes(row.fecha)
        if (mes === null) return
        const bruto = parseEuroNumber(row.acumulado)
        const impuestos = parseEuroNumber(row.impuestos)
        meses[mes].bruto += bruto
        meses[mes].impuestos += impuestos
        meses[mes].neto += bruto - impuestos
        meses[mes].conDatos = true
    })
    return meses
}

/**
 * Rentabilidad anual aproximada: bruto de los últimos 12 meses sobre el saldo.
 *
 * Es aproximada porque solo se conoce el saldo de hoy, no el de cada mes: si
 * el saldo ha cambiado mucho durante el año, se aleja de la TAE real.
 *
 * Args:
 *     rows: filas de la cuenta remunerada (de todos los años).
 *     saldo: saldo actual de la cuenta enlazada, en euros.
 *     hoy: fecha de referencia; el mes en curso entra en la ventana.
 *
 * Returns:
 *     El porcentaje, o null sin saldo positivo o sin intereses en la ventana.
 */
function calcularInteresesTae(rows, saldo, hoy = new Date()) {
    if (!(saldo > 0)) return null
    const fin = hoy.getFullYear() * 12 + hoy.getMonth()
    const bruto = rows.reduce((acc, row) => {
        const mes = parseInteresMes(row.fecha)
        const year = Number(parseInteresYear(row.fecha))
        if (mes === null || !year) return acc
        const indice = year * 12 + mes
        return indice > fin - INTERESES_MESES_TAE && indice <= fin ? acc + parseEuroNumber(row.acumulado) : acc
    }, 0)
    return bruto > 0 ? (bruto / saldo) * 100 : null
}

/**
 * Cifras de la tarjeta de resumen para un año.
 *
 * La comparación con el año anterior usa solo los meses hasta el último con
 * datos del año elegido: comparar un año a medias con uno entero daría
 * siempre una caída que no es tal.
 *
 * Args:
 *     rows: filas de la cuenta remunerada (de todos los años).
 *     year: año elegido.
 *     saldo: saldo actual de la cuenta enlazada, o null si no se conoce.
 *     hoy: fecha de referencia para la rentabilidad aproximada.
 *
 * Returns:
 *     { bruto, impuestos, neto, mediaMensual, mejorMes, retencion,
 *       netoAnterior, variacion, tae }. Las que no se pueden calcular son null.
 */
function calcularResumenIntereses(rows, year, saldo, hoy = new Date()) {
    const meses = calcularInteresesPorMes(rows, year)
    const conDatos = meses.filter((m) => m.conDatos)
    const bruto = conDatos.reduce((acc, m) => acc + m.bruto, 0)
    const impuestos = conDatos.reduce((acc, m) => acc + m.impuestos, 0)
    const neto = bruto - impuestos

    let mejorMes = null
    let ultimoMes = -1
    meses.forEach((m, i) => {
        if (!m.conDatos) return
        ultimoMes = i
        if (!mejorMes || m.neto > mejorMes.neto) mejorMes = { mes: i, neto: m.neto }
    })

    const anterior = calcularInteresesPorMes(rows, Number(year) - 1).slice(0, ultimoMes + 1)
    const netoAnterior = anterior.some((m) => m.conDatos) ? anterior.reduce((acc, m) => acc + m.neto, 0) : null

    return {
        bruto,
        impuestos,
        neto,
        mediaMensual: conDatos.length ? neto / conDatos.length : null,
        mejorMes,
        retencion: bruto > 0 ? (impuestos / bruto) * 100 : null,
        netoAnterior,
        variacion: netoAnterior > 0 ? ((neto - netoAnterior) / netoAnterior) * 100 : null,
        tae: calcularInteresesTae(rows, saldo, hoy)
    }
}

// ----- Saldos de «Cuentas» -----

/**
 * Carga el saldo de cada cuenta de Finanzas › Cuentas para la rentabilidad.
 *
 * Un fallo aquí no debe tumbar la página: sin saldos solo se pierde esa cifra.
 */
async function cargarInteresesSaldos() {
    try {
        const data = await Api.get("/api/cuentas")
        const cuentas = Array.isArray(data?.cuentas) ? data.cuentas : []
        interesesSaldosCuentas = new Map(cuentas.map((c) => [c.id, parseEuroNumber(c.saldo)]))
    } catch (error) {
        console.warn("No se pudieron cargar los saldos de las cuentas:", error)
        interesesSaldosCuentas = new Map()
    }
}

function getInteresesSaldoCuentaActual() {
    const cuenta = getCurrentCuenta()
    return cuenta?.cuenta && interesesSaldosCuentas.has(cuenta.cuenta)
        ? interesesSaldosCuentas.get(cuenta.cuenta)
        : null
}

// ----- Pintado -----

function formatInteresesPct(value, conSigno = false) {
    const texto = new Intl.NumberFormat(_nl(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
    return `${conSigno && value > 0 ? "+" : ""}${texto} %`
}

function interesesMesX(i) {
    const { W, padX } = INTERESES_GRAFICA
    return padX + ((W - padX * 2) / 12) * (i + 0.5)
}

function interesesEtiquetasMeses() {
    const { H } = INTERESES_GRAFICA
    return INTERESES_MESES_INICIAL.map(
        (l, i) =>
            `<text x="${interesesMesX(i).toFixed(1)}" y="${H - 5}" text-anchor="middle" class="interesesGraficaLabel">${l}</text>`
    ).join("")
}

function interesesGuia() {
    const { H, top, bottom } = INTERESES_GRAFICA
    return `<line class="interesesGraficaGuia" x1="0" x2="0" y1="${top}" y2="${H - bottom}" visibility="hidden"></line>`
}

/** Barras apiladas por mes: el neto abajo y los impuestos encima (juntos, el bruto). */
function renderInteresesGraficaMensual(meses) {
    const svg = document.getElementById("interesesGraficaMensual")
    if (!svg) return

    const { W, H, padX, top, bottom } = INTERESES_GRAFICA
    const base = H - bottom
    const ancho = ((W - padX * 2) / 12) * 0.56
    const max = Math.max(...meses.map((m) => Math.max(m.neto, 0) + Math.max(m.impuestos, 0)), 0) || 1
    const alto = (v) => (Math.max(v, 0) / max) * (base - top)

    const barras = meses
        .map((m, i) => {
            if (!m.conDatos) return ""
            const x = (interesesMesX(i) - ancho / 2).toFixed(1)
            const altoNeto = alto(m.neto)
            const altoImpuestos = alto(m.impuestos)
            return `
                <g class="interesesGraficaBarra" data-i="${i}">
                    <rect x="${x}" y="${(base - altoNeto).toFixed(1)}" width="${ancho.toFixed(1)}" height="${altoNeto.toFixed(1)}" class="interesesGraficaNeto"></rect>
                    <rect x="${x}" y="${(base - altoNeto - altoImpuestos).toFixed(1)}" width="${ancho.toFixed(1)}" height="${altoImpuestos.toFixed(1)}" class="interesesGraficaImpuestos"></rect>
                </g>`
        })
        .join("")

    interesesGraficaMeses = meses
    svg.innerHTML = `
        ${interesesGuia()}
        <line class="interesesGraficaEje" x1="${padX}" x2="${W - padX}" y1="${base}" y2="${base}"></line>
        ${barras}${interesesEtiquetasMeses()}`
}

/** Neto acumulado en el año, hasta el último mes con datos. */
function renderInteresesGraficaAcumulado(meses) {
    const svg = document.getElementById("interesesGraficaAcumulado")
    if (!svg) return

    const { H, top, bottom } = INTERESES_GRAFICA
    const ultimoMes = meses.reduce((ultimo, m, i) => (m.conDatos ? i : ultimo), -1)
    let suma = 0
    const valores = meses.map((m, i) => {
        suma += m.neto
        return i > ultimoMes ? null : suma
    })

    const conocidos = valores.filter((v) => v !== null)
    const min = Math.min(...conocidos, 0)
    const span = Math.max(...conocidos, 0) - min || 1
    const y = (v) => top + (1 - (v - min) / span) * (H - top - bottom)
    const puntos = valores
        .map((v, i) => (v === null ? null : `${interesesMesX(i).toFixed(1)},${y(v).toFixed(1)}`))
        .filter(Boolean)
    const base = (H - bottom).toFixed(1)
    const area = `${interesesMesX(0).toFixed(1)},${base} ${puntos.join(" ")} ${interesesMesX(ultimoMes).toFixed(1)},${base}`
    const dots = valores
        .map((v, i) =>
            v === null
                ? ""
                : `<circle cx="${interesesMesX(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" class="interesesGraficaDot" data-i="${i}"></circle>`
        )
        .join("")

    interesesGraficaAcumulado = valores
    svg.innerHTML = `
        ${interesesGuia()}
        <polygon points="${area}" class="interesesGraficaArea"></polygon>
        <polyline points="${puntos.join(" ")}" class="interesesGraficaLinea" fill="none"></polyline>
        ${dots}${interesesEtiquetasMeses()}`
}

function setInteresesStat(id, texto, clase = "", titulo = "") {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = texto
    el.classList.toggle("interesesStatPos", clase === "pos")
    el.classList.toggle("interesesStatNeg", clase === "neg")
    if (titulo) el.title = titulo
    else el.removeAttribute("title")
}

function renderInteresesEstadisticas(resumen, year) {
    const vacio = "—"
    setInteresesStat("interesesStatBruto", formatEuro(resumen.bruto))
    setInteresesStat(
        "interesesStatMedia",
        resumen.mediaMensual === null ? vacio : formatEuro(resumen.mediaMensual),
        "",
        "Neto del año entre los meses con algún registro"
    )
    setInteresesStat(
        "interesesStatMejorMes",
        resumen.mejorMes ? formatEuro(resumen.mejorMes.neto) : vacio,
        "",
        resumen.mejorMes ? `Neto de ${INTERESES_MESES_NOMBRE[resumen.mejorMes.mes]}` : ""
    )
    const mejorMesNombre = document.getElementById("interesesStatMejorMesNombre")
    if (mejorMesNombre) {
        mejorMesNombre.textContent = resumen.mejorMes ? INTERESES_MESES_NOMBRE[resumen.mejorMes.mes] : ""
    }
    setInteresesStat(
        "interesesStatRetencion",
        resumen.retencion === null ? vacio : formatInteresesPct(resumen.retencion),
        "",
        "Impuestos entre bruto del año"
    )
    setInteresesStat(
        "interesesStatVariacion",
        resumen.variacion === null ? vacio : formatInteresesPct(resumen.variacion, true),
        resumen.variacion > 0 ? "pos" : resumen.variacion < 0 ? "neg" : "",
        resumen.netoAnterior === null
            ? `Sin registros en ${Number(year) - 1} para comparar`
            : `Neto frente al de ${Number(year) - 1} en los mismos meses`
    )
    setInteresesStat(
        "interesesStatTae",
        resumen.tae === null ? vacio : formatInteresesPct(resumen.tae),
        "",
        resumen.tae === null
            ? "Hace falta la cuenta enlazada con saldo e intereses en los últimos 12 meses"
            : "Intereses brutos de los últimos 12 meses entre el saldo actual de la cuenta. Aproximada: no tiene en cuenta cómo ha cambiado el saldo durante el año"
    )
}

/**
 * Repinta las gráficas y la tarjeta de resumen del año elegido.
 *
 * Sin registros en el año se ocultan: la página ya muestra su aviso de vacío.
 */
function renderInteresesResumen() {
    const graficas = document.getElementById("interesesGraficas")
    const tarjeta = document.getElementById("interesesStatsCard")
    if (!graficas && !tarjeta) return

    // Un tooltip abierto hablaría del año o la cuenta de antes del repintado.
    document.querySelectorAll(".interesesTooltip").forEach((tip) => tip.classList.add("hidden"))

    const meses = calcularInteresesPorMes(_allInteresesRows, currentInteresesYear)
    const hayDatos = meses.some((m) => m.conDatos)
    graficas?.classList.toggle("hidden", !hayDatos)
    tarjeta?.classList.toggle("hidden", !hayDatos)
    if (!hayDatos) return

    renderInteresesGraficaMensual(meses)
    renderInteresesGraficaAcumulado(meses)
    renderInteresesEstadisticas(
        calcularResumenIntereses(_allInteresesRows, currentInteresesYear, getInteresesSaldoCuentaActual()),
        currentInteresesYear
    )
    bindInteresesGraficaHover("interesesGraficaMensual", "interesesTooltipMensual", contenidoInteresesTooltipMensual)
    bindInteresesGraficaHover(
        "interesesGraficaAcumulado",
        "interesesTooltipAcumulado",
        contenidoInteresesTooltipAcumulado
    )
}

// ----- Tooltip -----

function nombreInteresesMes(i) {
    const nombre = INTERESES_MESES_NOMBRE[i]
    return `${nombre.charAt(0).toUpperCase()}${nombre.slice(1)} ${currentInteresesYear}`
}

function contenidoInteresesTooltipMensual(i) {
    const m = interesesGraficaMeses?.[i]
    if (!m?.conDatos) return null
    return `
        <strong>${nombreInteresesMes(i)}</strong>
        <span>Bruto: ${formatEuro(m.bruto)}</span>
        <span>Impuestos: ${formatEuro(m.impuestos)}</span>
        <span>Neto: ${formatEuro(m.neto)}</span>`
}

function contenidoInteresesTooltipAcumulado(i) {
    const v = interesesGraficaAcumulado?.[i]
    if (v === null || v === undefined) return null
    return `
        <strong>${nombreInteresesMes(i)}</strong>
        <span>Neto acumulado: ${formatEuro(v)}</span>`
}

/**
 * Engancha el tooltip de una gráfica: el mes bajo el ratón y su guía.
 *
 * Se llama en cada repintado; la marca en el dataset evita duplicar oyentes.
 *
 * Args:
 *     svgId: id del <svg> de la gráfica.
 *     tipId: id del tooltip, hermano del svg dentro de su contenedor.
 *     contenido: función (mes) -> HTML del tooltip, o null si el mes no tiene datos.
 */
function bindInteresesGraficaHover(svgId, tipId, contenido) {
    const svg = document.getElementById(svgId)
    const tip = document.getElementById(tipId)
    if (!svg || !tip || svg.dataset.hoverListo) return
    svg.dataset.hoverListo = "1"

    const { W, padX } = INTERESES_GRAFICA
    const hide = () => {
        tip.classList.add("hidden")
        svg.querySelector(".interesesGraficaGuia")?.setAttribute("visibility", "hidden")
        svg.querySelectorAll("[data-i].active").forEach((el) => el.classList.remove("active"))
    }

    svg.addEventListener("mouseleave", hide)
    svg.addEventListener("mousemove", (event) => {
        const rect = svg.getBoundingClientRect()
        const vx = ((event.clientX - rect.left) / rect.width) * W
        const i = Math.max(0, Math.min(11, Math.floor((vx - padX) / ((W - padX * 2) / 12))))
        const html = contenido(i)
        if (!html) return hide()

        const guia = svg.querySelector(".interesesGraficaGuia")
        guia?.setAttribute("x1", interesesMesX(i))
        guia?.setAttribute("x2", interesesMesX(i))
        guia?.setAttribute("visibility", "visible")
        svg.querySelectorAll("[data-i]").forEach((el) => el.classList.toggle("active", Number(el.dataset.i) === i))

        tip.innerHTML = html
        tip.classList.remove("hidden")
        const wrap = svg.parentElement.getBoundingClientRect()
        const px = rect.left - wrap.left + (interesesMesX(i) / W) * rect.width
        tip.style.left = `${Math.max(0, Math.min(wrap.width - tip.offsetWidth, px - tip.offsetWidth / 2))}px`
    })
}
