// Planes de inversión y planes de aportación periódica (DCA).
//
// Viven en la página de Activos, como dos categorías más junto a la cartera: un
// activo dice lo que se tiene y un plan dice lo que se piensa hacer con él. Por
// eso no comparten almacenamiento (tablas `planes_inversion` y `dca_planes`, vía
// /api/planes y /api/dca) y por eso un plan NO cuenta como operación: no toca el
// rendimiento, ni el FIFO fiscal, ni los snapshots.
//
// El precio actual, que es lo que da sentido a la pantalla, sale de dos sitios:
//
//   * Si el plan apunta a un activo de la cartera, del propio activo: ya está
//     cargado y refrescado por la página de Activos, así que no cuesta nada.
//   * Si no (se planifica sobre algo que todavía no se tiene), de
//     /api/market/quote con el ticker y el proveedor guardados en el plan.
//
// Todo el cálculo —lo que falta para el objetivo, el ratio beneficio/riesgo, el
// calendario de aportes— se hace aquí y no se guarda: depende del precio del
// momento, y persistirlo solo serviría para enseñar números caducados.

const PLAN_ESTADOS = ["Pendiente", "En curso", "Cumplido", "Cancelado"]
const PLAN_HORIZONTES = ["Corto", "Medio", "Largo"]
const PLAN_DIRECCIONES = ["Largo", "Corto"]
const DCA_FRECUENCIAS = ["Semanal", "Quincenal", "Mensual", "Trimestral"]
const DCA_ESTADOS = ["Activo", "Pausado", "Finalizado"]
const PLAN_PROVIDERS = ["finnhub", "eodhd", "yahoo", "alphavantage"]

const PLAN_ESTADO_COLORS = {
    Pendiente: "#f5a524",
    "En curso": "#3b82f6",
    Cumplido: "#2ecc71",
    Cancelado: "#64748b"
}

const DCA_ESTADO_COLORS = {
    Activo: "#2ecc71",
    Pausado: "#f5a524",
    Finalizado: "#64748b"
}

// Aportes al año de cada periodicidad. Se usa para la equivalencia mensual, que
// es lo único que permite comparar en la misma unidad un plan semanal con uno
// trimestral.
const DCA_APORTES_ANUALES = {
    Semanal: 52,
    Quincenal: 26,
    Mensual: 12,
    Trimestral: 4
}

let _planesRows = []
let _dcaRows = []
let _planesFilterEstado = "all"
let _planesSearch = ""
let _dcaFilterEstado = "all"
let _dcaSearch = ""

// Cotizaciones de los planes que no apuntan a un activo de la cartera.
// Clave: "proveedor|TICKER" → { price, currency }
const _planesQuoteCache = new Map()

// ── Datos ────────────────────────────────────────────────────────────────────

async function planesCargarTodo() {
    const [planes, dca] = await Promise.all([
        fetch("/api/planes")
            .then((r) => (r.ok ? r.json() : { rows: [] }))
            .catch(() => ({ rows: [] })),
        fetch("/api/dca")
            .then((r) => (r.ok ? r.json() : { rows: [] }))
            .catch(() => ({ rows: [] }))
    ])
    _planesRows = Array.isArray(planes.rows) ? planes.rows : []
    _dcaRows = Array.isArray(dca.rows) ? dca.rows : []
}

// Se guarda la lista entera en cada cambio: crear, editar, borrar y reordenar
// son la misma operación desde el punto de vista del servidor, y así el orden
// guardado es siempre el que se ve en pantalla.
async function planesGuardarLista(ruta, rows, queSeGuardaba) {
    try {
        const response = await fetch(ruta, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows })
        })
        if (!response.ok) {
            const cuerpo = await response.json().catch(() => ({}))
            throw new Error(cuerpo.error || `HTTP ${response.status}`)
        }
        return true
    } catch (error) {
        showError(`No se pudo guardar ${queSeGuardaba}`, error)
        return false
    }
}

function planesGuardarPlanes() {
    return planesGuardarLista("/api/planes", _planesRows, "el plan de inversión")
}

function planesGuardarDca() {
    return planesGuardarLista("/api/dca", _dcaRows, "el plan DCA")
}

function planesActivosDisponibles() {
    return Array.isArray(_activosAllAssets) ? _activosAllAssets : []
}

// ── Precio actual ────────────────────────────────────────────────────────────

function planClaveCotizacion(row) {
    const ticker = String(row.ticker || "").toUpperCase()
    if (!ticker) return ""
    const proveedor = String(row.marketProvider || inferMarketProviderFromSymbol(ticker) || "").toLowerCase()
    return `${proveedor}|${ticker}`
}

/**
 * Precio de referencia del plan y de dónde sale.
 *
 * `origen` distingue "cartera" (el activo enlazado) de "mercado" (consulta
 * directa al proveedor) y se enseña en la tarjeta: si el número no cuadra, lo
 * primero que hay que saber es de dónde vino.
 */
function planPrecioActual(row) {
    const activo = row.assetId ? planesActivosDisponibles().find((a) => a.id === row.assetId) : null

    if (activo) {
        const precio = parseLooseNumber(activo.price || "")
        if (precio !== null) {
            return { precio, currency: activo.currency || row.currency || "EUR", origen: "cartera" }
        }
    }

    const cacheada = _planesQuoteCache.get(planClaveCotizacion(row))
    if (cacheada && cacheada.price !== null) {
        return { precio: cacheada.price, currency: cacheada.currency || row.currency || "EUR", origen: "mercado" }
    }

    return { precio: null, currency: row.currency || "EUR", origen: "" }
}

/**
 * Cotiza los planes que no están enlazados a un activo de la cartera.
 *
 * En serie y no en paralelo a propósito: los proveedores gratuitos limitan las
 * llamadas por minuto, y una pantalla con quince planes sueltos agotaría la
 * cuota de golpe. Los tickers repetidos se piden una sola vez.
 */
async function planesRefrescarCotizaciones() {
    const pendientes = new Map()

    for (const row of [..._planesRows, ..._dcaRows]) {
        if (row.assetId && planesActivosDisponibles().some((a) => a.id === row.assetId)) continue
        const clave = planClaveCotizacion(row)
        if (!clave || _planesQuoteCache.has(clave) || pendientes.has(clave)) continue
        pendientes.set(clave, row)
    }

    let alguna = false

    for (const [clave, row] of pendientes) {
        try {
            const params = new URLSearchParams({ symbol: row.ticker })
            const proveedor = clave.split("|")[0]
            if (proveedor) params.set("provider", proveedor)
            const response = await fetch(`/api/market/quote?${params}`)
            if (!response.ok) continue
            const data = await response.json()
            if (!data.ok || data.price == null) continue
            _planesQuoteCache.set(clave, {
                price: parseLooseNumber(data.price),
                currency: data.currency || row.currency || "EUR"
            })
            alguna = true
        } catch {
            /* un ticker que no responde no debe dejar sin pintar a los demás */
        }
    }

    if (alguna) {
        planesRender()
        dcaRender()
    }
}

// ── Fechas ───────────────────────────────────────────────────────────────────

function planFechaADate(texto) {
    const ms = parseAssetOperationDate(texto)
    return Number.isFinite(ms) ? new Date(ms) : null
}

function planFormatearFecha(fecha) {
    if (!fecha) return "—"
    const dia = String(fecha.getDate()).padStart(2, "0")
    const mes = String(fecha.getMonth() + 1).padStart(2, "0")
    return `${dia}-${mes}-${fecha.getFullYear()}`
}

function planHoy() {
    const ahora = new Date()
    return new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate())
}

function planDiasEntre(desde, hasta) {
    return Math.round((hasta - desde) / 86400000)
}

/**
 * Fecha del aporte número `indice` (0 = el primero) contando desde `inicio`.
 *
 * Se calcula desde el origen en vez de ir sumando periodos uno a uno para que no
 * se acumule el desfase de los meses: doce sumas de "30 días" no son un año, y
 * un plan mensual empezado el día 31 tiene que caer el último día de febrero y
 * volver al 31 en marzo, no quedarse en el 28 para siempre.
 */
function dcaFechaAporte(inicio, frecuencia, indice) {
    if (frecuencia === "Semanal" || frecuencia === "Quincenal") {
        const dias = (frecuencia === "Semanal" ? 7 : 14) * indice
        return new Date(inicio.getFullYear(), inicio.getMonth(), inicio.getDate() + dias)
    }

    const saltoMeses = (frecuencia === "Trimestral" ? 3 : 1) * indice
    const objetivo = new Date(inicio.getFullYear(), inicio.getMonth() + saltoMeses, 1)
    const ultimoDia = new Date(objetivo.getFullYear(), objetivo.getMonth() + 1, 0).getDate()
    objetivo.setDate(Math.min(inicio.getDate(), ultimoDia))
    return objetivo
}

// ── Cálculo de un plan de inversión ──────────────────────────────────────────

function planNumero(valor) {
    const numero = parseLooseNumber(valor)
    return numero === null || !Number.isFinite(numero) ? null : numero
}

function planVariacion(desde, hasta) {
    if (desde === null || hasta === null || desde === 0) return null
    return ((hasta - desde) / Math.abs(desde)) * 100
}

/**
 * Todo lo que se puede deducir de un plan con el precio de ahora.
 *
 * `signo` invierte los criterios de un plan corto: ahí se gana cuando el precio
 * baja, así que "recorrido hasta el objetivo" y "se ha tocado el stop" significan
 * lo contrario. Sin esto, un corto salía siempre con el beneficio en negativo.
 */
function planCalcular(row) {
    const { precio: actual, currency, origen } = planPrecioActual(row)
    const entrada = planNumero(row.precioEntrada)
    const salida = planNumero(row.precioSalida)
    const stop = planNumero(row.stopLoss)
    const capital = planNumero(row.capital)
    const signo = row.direccion === "Corto" ? -1 : 1

    // Cuánto tiene que moverse el precio de hoy para llegar ahí. Va sin signo de
    // dirección a propósito: es un movimiento del mercado, no un resultado, y
    // "el objetivo está un 20 % más abajo" se lee igual en largo que en corto.
    const hastaEntrada = planVariacion(actual, entrada)
    const hastaObjetivo = planVariacion(actual, salida)

    // Estos sí llevan el signo de la dirección: son resultado de la operación.
    // El `null` se comprueba aparte porque `signo * null` da 0, y un plan sin
    // stop acabaría enseñando un riesgo del 0 % en vez de un hueco.
    const aObjetivo = planVariacion(entrada, salida)
    const aStop = planVariacion(entrada, stop)
    const recorrido = aObjetivo === null ? null : signo * aObjetivo
    const riesgo = aStop === null ? null : -signo * aStop

    const ratio = recorrido !== null && riesgo !== null && riesgo > 0 ? recorrido / riesgo : null
    const unidades = capital !== null && entrada ? capital / entrada : null
    const beneficio = capital !== null && recorrido !== null ? (capital * recorrido) / 100 : null
    const perdida = capital !== null && riesgo !== null ? (capital * riesgo) / 100 : null

    // Recorrido del plan de principio a fin: del stop (o de la entrada, si no hay
    // stop) hasta el objetivo. La resta vale igual para un corto porque `inicio`
    // y `salida` ya vienen en el orden del plan, no en el de la recta real.
    const inicio = stop !== null ? stop : entrada
    const posicion = (valor) =>
        inicio !== null && salida !== null && inicio !== salida && valor !== null
            ? Math.min(100, Math.max(0, ((valor - inicio) / (salida - inicio)) * 100))
            : null

    const objetivoAlcanzado = actual !== null && salida !== null && signo * (actual - salida) >= 0
    const stopAlcanzado = actual !== null && stop !== null && signo * (actual - stop) <= 0
    const enEntrada = actual !== null && entrada !== null && signo * (actual - entrada) <= 0

    let aviso = ""
    if (stopAlcanzado) aviso = "stop"
    else if (objetivoAlcanzado) aviso = "objetivo"
    else if (enEntrada) aviso = "entrada"

    return {
        actual,
        currency,
        origen,
        entrada,
        salida,
        stop,
        capital,
        hastaEntrada,
        hastaObjetivo,
        recorrido,
        riesgo,
        ratio,
        unidades,
        beneficio,
        perdida,
        progreso: posicion(actual),
        marcaEntrada: posicion(entrada),
        aviso
    }
}

// ── Cálculo de un plan DCA ───────────────────────────────────────────────────

// Tope de iteraciones al recorrer el calendario. Un plan semanal indefinido
// empezado hace diez años son ~520 aportes; 2.000 cubre cualquier caso real y
// evita que una fecha de inicio absurda (año 1900) cuelgue la pestaña.
const DCA_MAX_APORTES = 2000

function dcaCalcular(row) {
    const { precio: actual, currency, origen } = planPrecioActual(row)
    const importe = planNumero(row.importe)
    const objetivo = planNumero(row.aportesObjetivo)
    const precioMaximo = planNumero(row.precioMaximo)
    const frecuencia = DCA_FRECUENCIAS.includes(row.frecuencia) ? row.frecuencia : "Mensual"
    const inicio = planFechaADate(row.fechaInicio)
    const fin = planFechaADate(row.fechaFin)
    const hoy = planHoy()

    const tope = objetivo && objetivo > 0 ? Math.min(objetivo, DCA_MAX_APORTES) : DCA_MAX_APORTES

    let realizados = 0
    let proximo = null

    if (inicio) {
        for (let indice = 0; indice < tope; indice += 1) {
            const fecha = dcaFechaAporte(inicio, frecuencia, indice)
            if (fin && fecha > fin) break
            if (fecha <= hoy) {
                realizados += 1
                continue
            }
            proximo = fecha
            break
        }
    }

    // Un plan pausado o finalizado no tiene siguiente aporte: lo que se enseña es
    // lo que llevaba hecho, no lo que tocaría si siguiera corriendo.
    if (row.estado !== "Activo") proximo = null

    const invertido = importe !== null ? importe * realizados : null
    const planificado = importe !== null && objetivo ? importe * objetivo : null
    const aportesAno = DCA_APORTES_ANUALES[frecuencia] || 12
    const equivalenteMensual = importe !== null ? (importe * aportesAno) / 12 : null
    const unidadesPorAporte = importe !== null && actual ? importe / actual : null
    const progreso = objetivo ? Math.min(100, (realizados / objetivo) * 100) : null
    const diasParaProximo = proximo ? planDiasEntre(hoy, proximo) : null
    const porEncimaDelMaximo = precioMaximo !== null && actual !== null && actual > precioMaximo

    return {
        actual,
        currency,
        origen,
        importe,
        objetivo,
        precioMaximo,
        frecuencia,
        inicio,
        fin,
        realizados,
        proximo,
        diasParaProximo,
        invertido,
        planificado,
        equivalenteMensual,
        unidadesPorAporte,
        progreso,
        porEncimaDelMaximo
    }
}

/** Los `cuantos` próximos aportes, para el calendario de la ficha. */
function dcaProximosAportes(row, cuantos = 12) {
    const calculo = dcaCalcular(row)
    if (!calculo.inicio || calculo.importe === null) return []

    const tope =
        calculo.objetivo && calculo.objetivo > 0 ? Math.min(calculo.objetivo, DCA_MAX_APORTES) : DCA_MAX_APORTES
    const filas = []

    for (let indice = calculo.realizados; indice < tope && filas.length < cuantos; indice += 1) {
        const fecha = dcaFechaAporte(calculo.inicio, calculo.frecuencia, indice)
        if (calculo.fin && fecha > calculo.fin) break
        filas.push({
            numero: indice + 1,
            fecha,
            importe: calculo.importe,
            acumulado: calculo.importe * (indice + 1),
            unidades: calculo.actual ? calculo.importe / calculo.actual : null
        })
    }

    return filas
}

// ── Formateo ─────────────────────────────────────────────────────────────────

function planPorcentajeConSigno(valor) {
    if (valor === null || !Number.isFinite(valor)) return "—"
    return (valor >= 0 ? "+" : "") + formatPercent(valor)
}

function planClaseSigno(valor) {
    if (valor === null || !Number.isFinite(valor)) return ""
    return valor >= 0 ? "avPos" : "avNeg"
}

function planImporte(valor, currency) {
    return valor === null || !Number.isFinite(valor) ? "—" : formatMoney(valor, currency)
}

function planMetrica(etiqueta, valor, clase = "") {
    return `
        <div class="avMetricItem">
            <span class="avMetricLabel">${escapeHtml(etiqueta)}</span>
            <span class="avMetricValue ${clase}">${valor}</span>
        </div>`
}

function planMenuTarjeta(id, extra = "") {
    return `
        <div class="rowMenu">
            <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
            <div class="rowMenuDropdown">
                <button type="button" class="rowMenuItem planActionBtn planEditBtn" data-plan-id="${escapeAttr(id)}">Editar</button>
                <button type="button" class="rowMenuItem planActionBtn planDuplicateBtn" data-plan-id="${escapeAttr(id)}">Duplicar</button>
                ${extra}
                <hr>
                <button type="button" class="rowMenuItem rowMenuItemDanger planActionBtn planDeleteBtn" data-plan-id="${escapeAttr(id)}">Eliminar</button>
            </div>
        </div>`
}

function planEtiquetaOrigen(origen) {
    if (origen === "cartera") return "En cartera"
    if (origen === "mercado") return "Cotización"
    return "Sin precio"
}

// ── Tarjeta de un plan de inversión ──────────────────────────────────────────

const PLAN_AVISOS = {
    entrada: { texto: "En zona de entrada", clase: "planAvisoEntrada" },
    objetivo: { texto: "Objetivo alcanzado", clase: "planAvisoObjetivo" },
    stop: { texto: "Stop alcanzado", clase: "planAvisoStop" }
}

function planConstruirTarjeta(row) {
    const c = planCalcular(row)
    const color = PLAN_ESTADO_COLORS[row.estado] || "#64748b"
    const aviso = PLAN_AVISOS[c.aviso]
    const esCorto = row.direccion === "Corto"

    const tarjeta = document.createElement("div")
    tarjeta.className = "avCard planCard"
    tarjeta.dataset.planId = row.id
    tarjeta.style.setProperty("--av-color", color)

    const barra =
        c.progreso === null
            ? ""
            : `
        <div class="planTrack" title="Del ${c.stop !== null ? "stop" : "precio de entrada"} al objetivo">
            <div class="planTrackFill" style="width:${c.progreso.toFixed(2)}%;background:${color}"></div>
            ${c.marcaEntrada === null ? "" : `<span class="planTrackMark" style="left:${c.marcaEntrada.toFixed(2)}%"></span>`}
        </div>
        <div class="planTrackLabels">
            <span>${c.stop !== null ? "Stop" : "Entrada"}</span>
            <span>Objetivo</span>
        </div>`

    tarjeta.innerHTML = `
        <div class="avCardTop">
            <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(row.estado || "Pendiente")}</span>
            <div class="avCardActions planCardActions">
                <span class="planDirBadge ${esCorto ? "planDirCorto" : "planDirLargo"}">${esCorto ? "Corto" : "Largo"}</span>
                ${planMenuTarjeta(row.id, `<button type="button" class="rowMenuItem planActionBtn planEstadoBtn" data-plan-id="${escapeAttr(row.id)}">Cambiar estado</button>`)}
            </div>
        </div>
        <div class="avCardName">${escapeHtml(row.nombre || row.symbol || "Plan")}</div>
        <div class="avCardPrice">${planImporte(c.actual, c.currency)}</div>
        <div class="avCardTicker">${escapeHtml(row.symbol || row.ticker || "—")} · ${planEtiquetaOrigen(c.origen)}</div>

        ${aviso ? `<div class="planAviso ${aviso.clase}">${aviso.texto}</div>` : ""}

        <div class="planDestacado">
            <span class="planDestacadoLabel">Falta para el objetivo</span>
            <span class="planDestacadoValor ${planClaseSigno(c.hastaObjetivo)}">${planPorcentajeConSigno(c.hastaObjetivo)}</span>
        </div>
        ${barra}

        <div class="avCardMetrics planCardMetrics">
            ${planMetrica("Entrada", planImporte(c.entrada, c.currency))}
            ${planMetrica("Objetivo", planImporte(c.salida, c.currency))}
            ${planMetrica("Stop", planImporte(c.stop, c.currency))}
            ${planMetrica("Hasta entrada", planPorcentajeConSigno(c.hastaEntrada), planClaseSigno(c.hastaEntrada))}
            ${planMetrica("Recorrido", planPorcentajeConSigno(c.recorrido), planClaseSigno(c.recorrido))}
            ${planMetrica("Ratio B/R", c.ratio === null ? "—" : `${c.ratio.toFixed(2)} : 1`, c.ratio !== null && c.ratio >= 2 ? "avPos" : "")}
            ${planMetrica("Capital", planImporte(c.capital, c.currency))}
            ${planMetrica("Unidades est.", c.unidades === null ? "—" : formatShareQuantity(c.unidades))}
            ${planMetrica("Beneficio pot.", c.beneficio === null ? "—" : planImporte(c.beneficio, c.currency), "avPos")}
            ${planMetrica("Riesgo", c.perdida === null ? "—" : `−${planImporte(c.perdida, c.currency)}`, "avNeg")}
        </div>

        ${row.notas ? `<div class="planNota">${escapeHtml(row.notas)}</div>` : ""}
        <div class="avCardUpdated">Horizonte: ${escapeHtml(row.horizonte || "Medio")} plazo${row.fechaObjetivo ? ` · Objetivo: ${escapeHtml(row.fechaObjetivo)}` : ""}</div>
        <div class="avCardBar" style="background:${color}"></div>
    `

    return tarjeta
}

// ── Tarjeta de un plan DCA ───────────────────────────────────────────────────

function dcaTextoProximo(row, calculo) {
    if (calculo.proximo === null) {
        return row.estado === "Activo" ? "Sin aportes pendientes" : `Plan ${String(row.estado).toLowerCase()}`
    }
    if (calculo.diasParaProximo === 0) return "Hoy"
    if (calculo.diasParaProximo === 1) return "Mañana"
    return `En ${calculo.diasParaProximo} días`
}

function dcaConstruirTarjeta(row) {
    const c = dcaCalcular(row)
    const color = DCA_ESTADO_COLORS[row.estado] || "#64748b"

    const tarjeta = document.createElement("div")
    tarjeta.className = "avCard planCard"
    tarjeta.dataset.dcaId = row.id
    tarjeta.style.setProperty("--av-color", color)

    const barra =
        c.progreso === null
            ? ""
            : `
        <div class="planTrack" title="Aportes realizados sobre el objetivo">
            <div class="planTrackFill" style="width:${c.progreso.toFixed(2)}%;background:${color}"></div>
        </div>
        <div class="planTrackLabels">
            <span>${c.realizados} hechos</span>
            <span>${c.objetivo} objetivo</span>
        </div>`

    tarjeta.innerHTML = `
        <div class="avCardTop">
            <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(row.estado || "Activo")}</span>
            <div class="avCardActions planCardActions">
                <span class="planDirBadge planDirDca">${escapeHtml(c.frecuencia)}</span>
                ${planMenuTarjeta(row.id, `<button type="button" class="rowMenuItem planActionBtn dcaCalendarBtn" data-plan-id="${escapeAttr(row.id)}">Ver calendario</button>`)}
            </div>
        </div>
        <div class="avCardName">${escapeHtml(row.nombre || row.symbol || "Plan DCA")}</div>
        <div class="avCardPrice">${planImporte(c.importe, c.currency)}<span class="planPorAporte"> / aporte</span></div>
        <div class="avCardTicker">${escapeHtml(row.symbol || row.ticker || "—")} · ${planEtiquetaOrigen(c.origen)}</div>

        ${c.porEncimaDelMaximo ? `<div class="planAviso planAvisoStop">Por encima del precio máximo</div>` : ""}

        <div class="planDestacado">
            <span class="planDestacadoLabel">Próximo aporte</span>
            <span class="planDestacadoValor">${escapeHtml(dcaTextoProximo(row, c))}</span>
        </div>
        ${barra}

        <div class="avCardMetrics planCardMetrics">
            ${planMetrica("Fecha próxima", c.proximo ? planFormatearFecha(c.proximo) : "—")}
            ${planMetrica("Aportes hechos", c.objetivo ? `${c.realizados} / ${c.objetivo}` : String(c.realizados))}
            ${planMetrica("Aportado est.", planImporte(c.invertido, c.currency))}
            ${planMetrica("Total planificado", planImporte(c.planificado, c.currency))}
            ${planMetrica("Equiv. mensual", planImporte(c.equivalenteMensual, c.currency))}
            ${planMetrica("Precio actual", planImporte(c.actual, c.currency))}
            ${planMetrica("Unidades/aporte", c.unidadesPorAporte === null ? "—" : formatShareQuantity(c.unidadesPorAporte))}
            ${planMetrica("Precio máximo", planImporte(c.precioMaximo, c.currency))}
        </div>

        ${row.notas ? `<div class="planNota">${escapeHtml(row.notas)}</div>` : ""}
        <div class="avCardUpdated">Inicio: ${escapeHtml(row.fechaInicio || "—")}${row.fechaFin ? ` · Fin: ${escapeHtml(row.fechaFin)}` : ""}</div>
        <div class="avCardBar" style="background:${color}"></div>
    `

    return tarjeta
}

// ── Resumen de la categoría ──────────────────────────────────────────────────

function planKpi(etiqueta, valor, clase = "") {
    return `
        <div class="planKpi">
            <span class="planKpiLabel">${escapeHtml(etiqueta)}</span>
            <span class="planKpiValue ${clase}">${valor}</span>
        </div>`
}

/**
 * Los totales van en euros aunque los planes estén en otras monedas.
 *
 * Sumar 3.000 $ con 2.000 € da un número que no significa nada. La conversión la
 * hace el servidor (el mismo tipo de cambio que el resto de la aplicación), y por
 * eso esto es asíncrono y se pinta un instante después de las tarjetas.
 */
async function planesRenderKpis(filas) {
    const contenedor = document.getElementById("planesKpis")
    if (!contenedor) return

    let capital = 0
    let beneficio = 0
    let riesgo = 0
    const ratios = []

    for (const row of filas) {
        const c = planCalcular(row)
        if (c.capital !== null) capital += await convertAmountForDisplay(c.capital, c.currency, "EUR")
        if (c.beneficio !== null) beneficio += await convertAmountForDisplay(c.beneficio, c.currency, "EUR")
        if (c.perdida !== null) riesgo += await convertAmountForDisplay(c.perdida, c.currency, "EUR")
        if (c.ratio !== null) ratios.push(c.ratio)
    }

    const ratioMedio = ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null

    contenedor.innerHTML = `
        ${planKpi("Planes mostrados", String(filas.length))}
        ${planKpi("Capital planificado", formatEuro(capital))}
        ${planKpi("Beneficio potencial", `+${formatEuro(beneficio)}`, "avPos")}
        ${planKpi("Riesgo asumido", `−${formatEuro(riesgo)}`, "avNeg")}
        ${planKpi("Ratio B/R medio", ratioMedio === null ? "—" : `${ratioMedio.toFixed(2)} : 1`, ratioMedio !== null && ratioMedio >= 2 ? "avPos" : "")}
    `
}

async function dcaRenderKpis(filas) {
    const contenedor = document.getElementById("dcaKpis")
    if (!contenedor) return

    let mensual = 0
    let aportado = 0
    let planificado = 0
    let activos = 0

    for (const row of filas) {
        const c = dcaCalcular(row)
        if (row.estado === "Activo") {
            activos += 1
            if (c.equivalenteMensual !== null) {
                mensual += await convertAmountForDisplay(c.equivalenteMensual, c.currency, "EUR")
            }
        }
        if (c.invertido !== null) aportado += await convertAmountForDisplay(c.invertido, c.currency, "EUR")
        if (c.planificado !== null) planificado += await convertAmountForDisplay(c.planificado, c.currency, "EUR")
    }

    contenedor.innerHTML = `
        ${planKpi("Planes activos", String(activos))}
        ${planKpi("Aportación mensual", formatEuro(mensual))}
        ${planKpi("Aportado hasta hoy", formatEuro(aportado))}
        ${planKpi("Total planificado", planificado ? formatEuro(planificado) : "—")}
        ${planKpi("Queda por aportar", planificado ? formatEuro(Math.max(0, planificado - aportado)) : "—")}
    `
}

// ── Render de las rejillas ───────────────────────────────────────────────────

function planCoincideBusqueda(row, texto) {
    if (!texto) return true
    const aguja = texto.toLowerCase()
    return [row.nombre, row.symbol, row.ticker, row.notas].some((campo) =>
        String(campo || "")
            .toLowerCase()
            .includes(aguja)
    )
}

function planesFiltrados() {
    return _planesRows.filter(
        (row) =>
            (_planesFilterEstado === "all" || row.estado === _planesFilterEstado) &&
            planCoincideBusqueda(row, _planesSearch)
    )
}

function dcaFiltrados() {
    return _dcaRows.filter(
        (row) =>
            (_dcaFilterEstado === "all" || row.estado === _dcaFilterEstado) && planCoincideBusqueda(row, _dcaSearch)
    )
}

function planesPintarRejilla({ gridId, vacioId, contadorId, filas, construir }) {
    const grid = document.getElementById(gridId)
    if (!grid) return

    const contador = document.getElementById(contadorId)
    if (contador) contador.textContent = `${filas.length} plan${filas.length !== 1 ? "es" : ""}`

    const vacio = document.getElementById(vacioId)
    grid.innerHTML = ""

    if (!filas.length) {
        vacio?.classList.remove("hidden")
        return
    }

    vacio?.classList.add("hidden")
    const fragmento = document.createDocumentFragment()
    filas.forEach((row) => fragmento.appendChild(construir(row)))
    grid.appendChild(fragmento)
}

function planesRender() {
    const filas = planesFiltrados()
    planesPintarRejilla({
        gridId: "planesGrid",
        vacioId: "planesEmpty",
        contadorId: "planesCount",
        filas,
        construir: planConstruirTarjeta
    })
    planesRenderKpis(filas)
}

function dcaRender() {
    const filas = dcaFiltrados()
    planesPintarRejilla({
        gridId: "dcaGrid",
        vacioId: "dcaEmpty",
        contadorId: "dcaCount",
        filas,
        construir: dcaConstruirTarjeta
    })
    dcaRenderKpis(filas)
}

// ── Campos del formulario ────────────────────────────────────────────────────

function planCampoTexto(id, etiqueta, valor, { placeholder = "", pista = "" } = {}) {
    return `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel" for="${id}">${escapeHtml(etiqueta)}</label>
            <input id="${id}" class="assetRowModalInput" type="text" value="${escapeAttr(valor ?? "")}" placeholder="${escapeAttr(placeholder)}">
            ${pista ? `<span class="planCampoPista">${escapeHtml(pista)}</span>` : ""}
        </div>`
}

function planCampoSelect(id, etiqueta, valor, opciones) {
    const items = opciones
        .map((opcion) => {
            const clave = typeof opcion === "string" ? opcion : opcion.valor
            const texto = typeof opcion === "string" ? opcion : opcion.texto
            return `<option value="${escapeAttr(clave)}"${clave === valor ? " selected" : ""}>${escapeHtml(texto)}</option>`
        })
        .join("")

    return `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel" for="${id}">${escapeHtml(etiqueta)}</label>
            <select id="${id}" class="assetRowModalSelect">${items}</select>
        </div>`
}

function planCampoNotas(id, valor) {
    return `
        <div class="assetRowModalField">
            <label class="assetRowModalLabel" for="${id}">Notas</label>
            <textarea id="${id}" class="assetRowModalInput planTextarea" rows="3" placeholder="Por qué este plan y qué lo invalidaría">${escapeHtml(valor || "")}</textarea>
        </div>`
}

function planOpcionesActivos() {
    return [
        { valor: "", texto: "— Ticker manual (no está en la cartera) —" },
        ...planesActivosDisponibles().map((activo) => ({
            valor: activo.id,
            texto: activo.name || activo.symbol || activo.id
        }))
    ]
}

function planLeer(id) {
    const elemento = document.getElementById(id)
    return elemento ? elemento.value.trim() : ""
}

/**
 * Rellena símbolo, ticker y moneda al elegir un activo de la cartera.
 *
 * Solo pisa lo que esté vacío: si se ha escrito un ticker a mano, cambiar el
 * activo enlazado no debe borrarlo sin avisar.
 */
function planEnlazarActivo(prefijo) {
    const selector = document.getElementById(`${prefijo}AssetId`)
    if (!selector) return

    selector.addEventListener("change", () => {
        const activo = planesActivosDisponibles().find((a) => a.id === selector.value)
        if (!activo) return

        const rellenarSiVacio = (id, valor) => {
            const campo = document.getElementById(id)
            if (campo && !campo.value.trim() && valor) campo.value = valor
        }

        rellenarSiVacio(`${prefijo}Nombre`, activo.name || activo.symbol || "")
        rellenarSiVacio(`${prefijo}Symbol`, activo.symbol || activo.name || "")
        rellenarSiVacio(`${prefijo}Ticker`, activo.marketSymbol || activo.finnhubSymbol || "")

        // La moneda sí se impone: es la del activo y no admite discusión, porque
        // es la que se usa para leer su precio.
        const moneda = document.getElementById(`${prefijo}Currency`)
        if (moneda && activo.currency) {
            moneda.value = activo.currency
            moneda.dispatchEvent(new Event("change", { bubbles: true }))
        }
    })
}

// ── Modal ────────────────────────────────────────────────────────────────────

function planCerrarModal() {
    document.getElementById("planModalOverlay")?.remove()
}

function planAbrirModal({ titulo, campos, onGuardar, etiquetaGuardar = "Guardar", onEliminar = null }) {
    planCerrarModal()

    const overlay = document.createElement("div")
    overlay.id = "planModalOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"

    overlay.innerHTML = `
        <div class="assetModal assetRowModal planModal">
            <h3 class="assetModalTitle assetRowModalTitle">${escapeHtml(titulo)}</h3>
            <div class="assetRowModalFields">${campos}</div>
            <div class="assetRowModalFooter">
                ${onEliminar ? `<button type="button" id="planModalDeleteBtn" class="dangerButton assetRowModalDeleteBtn">Eliminar</button>` : ""}
                <button type="button" id="planModalCancelBtn" class="cancelButton assetRowModalCancelBtn">Cancelar</button>
                <button type="button" id="planModalSaveBtn" data-no-autohide="true" class="primaryButton assetRowModalSaveBtn">${escapeHtml(etiquetaGuardar)}</button>
            </div>
        </div>`

    overlay.querySelector("#planModalCancelBtn").addEventListener("click", planCerrarModal)
    overlay.querySelector("#planModalSaveBtn").addEventListener("click", onGuardar)
    overlay.querySelector("#planModalDeleteBtn")?.addEventListener("click", onEliminar)

    // Clic fuera de la ficha: cerrar. Dentro no, porque el desplegable de los
    // <select> personalizados se pinta en el <body> y su clic burbujea hasta aquí.
    overlay.addEventListener("click", (evento) => {
        if (evento.target === overlay) planCerrarModal()
    })

    document.body.appendChild(overlay)
}

function planNuevoId(prefijo) {
    return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── Plan de inversión: alta, edición y borrado ───────────────────────────────

function planAbrirEditor(planId = null) {
    const existente = planId ? _planesRows.find((row) => row.id === planId) : null
    const row = existente || {
        id: planNuevoId("plan"),
        direccion: "Largo",
        currency: "EUR",
        horizonte: "Medio",
        estado: "Pendiente",
        marketProvider: "finnhub"
    }

    const campos = `
        ${planCampoSelect("planFormAssetId", "Activo de la cartera", row.assetId || "", planOpcionesActivos())}
        ${planCampoTexto("planFormNombre", "Nombre del plan", row.nombre, { placeholder: "Bitcoin a 120.000" })}
        ${planCampoTexto("planFormSymbol", "Símbolo", row.symbol, { placeholder: "BTC" })}
        ${planCampoTexto("planFormTicker", "Ticker de mercado", row.ticker, { placeholder: "BTC-USD", pista: "Solo hace falta si el plan no apunta a un activo de la cartera." })}
        ${planCampoSelect("planFormProvider", "Proveedor de cotización", row.marketProvider || "finnhub", PLAN_PROVIDERS)}
        ${planCampoSelect("planFormDireccion", "Dirección", row.direccion || "Largo", PLAN_DIRECCIONES)}
        ${planCampoSelect("planFormCurrency", "Moneda", row.currency || "EUR", ["EUR", "USD"])}
        ${planCampoTexto("planFormEntrada", "Precio de entrada", row.precioEntrada, { placeholder: "60.000" })}
        ${planCampoTexto("planFormSalida", "Precio de salida (objetivo)", row.precioSalida, { placeholder: "120.000" })}
        ${planCampoTexto("planFormStop", "Stop loss", row.stopLoss, { placeholder: "52.000", pista: "Sin stop no hay riesgo que medir: el ratio B/R sale vacío." })}
        ${planCampoTexto("planFormCapital", "Capital a invertir", row.capital, { placeholder: "3.000" })}
        ${planCampoSelect("planFormHorizonte", "Horizonte", row.horizonte || "Medio", PLAN_HORIZONTES)}
        ${planCampoSelect("planFormEstado", "Estado", row.estado || "Pendiente", PLAN_ESTADOS)}
        ${planCampoTexto("planFormFecha", "Fecha objetivo", row.fechaObjetivo, { placeholder: "dd-mm-aaaa" })}
        ${planCampoNotas("planFormNotas", row.notas)}
    `

    planAbrirModal({
        titulo: existente ? "Editar plan de inversión" : "Nuevo plan de inversión",
        campos,
        onGuardar: async () => {
            const nombre = planLeer("planFormNombre")
            const symbol = planLeer("planFormSymbol")

            if (!nombre && !symbol) {
                showToast("El plan necesita al menos un nombre o un símbolo", { type: "warning" })
                return
            }

            const actualizado = {
                id: row.id,
                assetId: planLeer("planFormAssetId"),
                nombre: nombre || symbol,
                symbol,
                ticker: planLeer("planFormTicker"),
                marketProvider: planLeer("planFormProvider"),
                tvSymbol: row.tvSymbol || "",
                direccion: planLeer("planFormDireccion"),
                currency: planLeer("planFormCurrency"),
                precioEntrada: planLeer("planFormEntrada"),
                precioSalida: planLeer("planFormSalida"),
                stopLoss: planLeer("planFormStop"),
                capital: planLeer("planFormCapital"),
                horizonte: planLeer("planFormHorizonte"),
                estado: planLeer("planFormEstado"),
                fechaObjetivo: planLeer("planFormFecha"),
                notas: document.getElementById("planFormNotas")?.value.trim() || ""
            }

            const indice = _planesRows.findIndex((fila) => fila.id === row.id)
            if (indice >= 0) _planesRows[indice] = actualizado
            else _planesRows.push(actualizado)

            planCerrarModal()
            planesRender()
            if (await planesGuardarPlanes()) planesRefrescarCotizaciones()
        },
        onEliminar: existente ? () => planEliminar(row.id) : null
    })

    planEnlazarActivo("planForm")
}

function planEliminar(planId) {
    const row = _planesRows.find((fila) => fila.id === planId)
    if (!row) return

    planCerrarModal()
    openConfirmModal({
        title: "Eliminar plan",
        message: `¿Quieres eliminar el plan "${row.nombre || row.symbol || planId}"?`,
        confirmLabel: "Sí, eliminar",
        confirmSide: "right",
        onConfirm: async () => {
            _planesRows = _planesRows.filter((fila) => fila.id !== planId)
            planesRender()
            await planesGuardarPlanes()
        }
    })
}

function planDuplicar(planId) {
    const indice = _planesRows.findIndex((fila) => fila.id === planId)
    if (indice < 0) return

    const row = _planesRows[indice]
    _planesRows.splice(indice + 1, 0, {
        ...row,
        id: planNuevoId("plan"),
        nombre: `${row.nombre || row.symbol} (copia)`,
        estado: "Pendiente"
    })
    planesRender()
    planesGuardarPlanes()
}

/** Avanza el estado por el ciclo Pendiente → En curso → Cumplido → Cancelado. */
function planCambiarEstado(planId) {
    const row = _planesRows.find((fila) => fila.id === planId)
    if (!row) return

    row.estado = PLAN_ESTADOS[(PLAN_ESTADOS.indexOf(row.estado) + 1) % PLAN_ESTADOS.length]
    planesRender()
    planesGuardarPlanes()
    showToast(`Plan "${row.nombre || row.symbol}": ${row.estado}`)
}

// ── Plan DCA: alta, edición y borrado ────────────────────────────────────────

function dcaAbrirEditor(planId = null) {
    const existente = planId ? _dcaRows.find((row) => row.id === planId) : null
    const row = existente || {
        id: planNuevoId("dca"),
        currency: "EUR",
        frecuencia: "Mensual",
        estado: "Activo",
        marketProvider: "finnhub",
        fechaInicio: todayDateString()
    }

    const campos = `
        ${planCampoSelect("dcaFormAssetId", "Activo de la cartera", row.assetId || "", planOpcionesActivos())}
        ${planCampoTexto("dcaFormNombre", "Nombre del plan", row.nombre, { placeholder: "MSCI World mensual" })}
        ${planCampoTexto("dcaFormSymbol", "Símbolo", row.symbol, { placeholder: "IWDA" })}
        ${planCampoTexto("dcaFormTicker", "Ticker de mercado", row.ticker, { placeholder: "IWDA.AS", pista: "Solo hace falta si el plan no apunta a un activo de la cartera." })}
        ${planCampoSelect("dcaFormProvider", "Proveedor de cotización", row.marketProvider || "finnhub", PLAN_PROVIDERS)}
        ${planCampoSelect("dcaFormCurrency", "Moneda", row.currency || "EUR", ["EUR", "USD"])}
        ${planCampoTexto("dcaFormImporte", "Importe por aporte", row.importe, { placeholder: "300" })}
        ${planCampoSelect("dcaFormFrecuencia", "Frecuencia", row.frecuencia || "Mensual", DCA_FRECUENCIAS)}
        ${planCampoTexto("dcaFormInicio", "Fecha de inicio", row.fechaInicio, { placeholder: "dd-mm-aaaa" })}
        ${planCampoTexto("dcaFormFin", "Fecha de fin", row.fechaFin, { placeholder: "dd-mm-aaaa", pista: "Opcional. Vacío = plan indefinido." })}
        ${planCampoTexto("dcaFormObjetivo", "Nº de aportes objetivo", row.aportesObjetivo, { placeholder: "24", pista: "Opcional. Es lo que llena la barra de progreso." })}
        ${planCampoTexto("dcaFormMaximo", "Precio máximo de compra", row.precioMaximo, { placeholder: "Opcional", pista: "Avisa en la tarjeta cuando la cotización lo supera." })}
        ${planCampoSelect("dcaFormEstado", "Estado", row.estado || "Activo", DCA_ESTADOS)}
        ${planCampoNotas("dcaFormNotas", row.notas)}
    `

    planAbrirModal({
        titulo: existente ? "Editar plan DCA" : "Nuevo plan DCA",
        campos,
        onGuardar: async () => {
            const nombre = planLeer("dcaFormNombre")
            const symbol = planLeer("dcaFormSymbol")

            if (!nombre && !symbol) {
                showToast("El plan necesita al menos un nombre o un símbolo", { type: "warning" })
                return
            }

            const objetivo = planLeer("dcaFormObjetivo")
            if (objetivo && parseLooseNumber(objetivo) === null) {
                showToast("El número de aportes objetivo tiene que ser un número", { type: "warning" })
                return
            }

            const actualizado = {
                id: row.id,
                assetId: planLeer("dcaFormAssetId"),
                nombre: nombre || symbol,
                symbol,
                ticker: planLeer("dcaFormTicker"),
                marketProvider: planLeer("dcaFormProvider"),
                tvSymbol: row.tvSymbol || "",
                currency: planLeer("dcaFormCurrency"),
                importe: planLeer("dcaFormImporte"),
                frecuencia: planLeer("dcaFormFrecuencia"),
                fechaInicio: planLeer("dcaFormInicio"),
                fechaFin: planLeer("dcaFormFin"),
                aportesObjetivo: objetivo,
                precioMaximo: planLeer("dcaFormMaximo"),
                estado: planLeer("dcaFormEstado"),
                notas: document.getElementById("dcaFormNotas")?.value.trim() || ""
            }

            const indice = _dcaRows.findIndex((fila) => fila.id === row.id)
            if (indice >= 0) _dcaRows[indice] = actualizado
            else _dcaRows.push(actualizado)

            planCerrarModal()
            dcaRender()
            if (await planesGuardarDca()) planesRefrescarCotizaciones()
        },
        onEliminar: existente ? () => dcaEliminar(row.id) : null
    })

    planEnlazarActivo("dcaForm")
}

function dcaEliminar(planId) {
    const row = _dcaRows.find((fila) => fila.id === planId)
    if (!row) return

    planCerrarModal()
    openConfirmModal({
        title: "Eliminar plan DCA",
        message: `¿Quieres eliminar el plan "${row.nombre || row.symbol || planId}"?`,
        confirmLabel: "Sí, eliminar",
        confirmSide: "right",
        onConfirm: async () => {
            _dcaRows = _dcaRows.filter((fila) => fila.id !== planId)
            dcaRender()
            await planesGuardarDca()
        }
    })
}

function dcaDuplicar(planId) {
    const indice = _dcaRows.findIndex((fila) => fila.id === planId)
    if (indice < 0) return

    const row = _dcaRows[indice]
    _dcaRows.splice(indice + 1, 0, {
        ...row,
        id: planNuevoId("dca"),
        nombre: `${row.nombre || row.symbol} (copia)`
    })
    dcaRender()
    planesGuardarDca()
}

// ── Calendario de aportes ────────────────────────────────────────────────────

function dcaAbrirCalendario(planId) {
    const row = _dcaRows.find((fila) => fila.id === planId)
    if (!row) return

    const c = dcaCalcular(row)
    const proximos = dcaProximosAportes(row, 12)

    const filas = proximos.length
        ? proximos
              .map(
                  (aporte) => `
            <tr>
                <td>${aporte.numero}</td>
                <td>${planFormatearFecha(aporte.fecha)}</td>
                <td>${planImporte(aporte.importe, c.currency)}</td>
                <td>${planImporte(aporte.acumulado, c.currency)}</td>
                <td>${aporte.unidades === null ? "—" : formatShareQuantity(aporte.unidades)}</td>
            </tr>`
              )
              .join("")
        : `<tr><td colspan="5" class="planCalendarioVacio">No quedan aportes pendientes. Revisa la fecha de inicio, el estado del plan o el número de aportes objetivo.</td></tr>`

    planAbrirModal({
        titulo: `Calendario · ${row.nombre || row.symbol || "Plan DCA"}`,
        etiquetaGuardar: "Cerrar",
        campos: `
            <p class="planCalendarioNota">
                Las unidades son una estimación al precio de hoy (${planImporte(c.actual, c.currency)}). El precio real
                de cada aporte será otro: de eso se trata al promediar.
            </p>
            <div class="planCalendarioWrap">
                <table class="planCalendario">
                    <thead>
                        <tr><th>#</th><th>Fecha</th><th>Importe</th><th>Acumulado</th><th>Unidades est.</th></tr>
                    </thead>
                    <tbody>${filas}</tbody>
                </table>
            </div>`,
        onGuardar: planCerrarModal
    })

    document.getElementById("planModalCancelBtn")?.remove()
}

// ── Exportación ──────────────────────────────────────────────────────────────

function planesExportarCsv() {
    const filas = planesFiltrados().map((row) => {
        const c = planCalcular(row)
        return {
            Nombre: row.nombre,
            Símbolo: row.symbol,
            Dirección: row.direccion,
            Estado: row.estado,
            Moneda: c.currency,
            "Precio actual": c.actual,
            Entrada: c.entrada,
            Objetivo: c.salida,
            Stop: c.stop,
            "Hasta objetivo (%)": c.hastaObjetivo,
            "Recorrido (%)": c.recorrido,
            "Riesgo (%)": c.riesgo,
            "Ratio B/R": c.ratio,
            Capital: c.capital,
            "Beneficio potencial": c.beneficio,
            "Pérdida potencial": c.perdida,
            Horizonte: row.horizonte,
            "Fecha objetivo": row.fechaObjetivo,
            Notas: row.notas
        }
    })

    if (!downloadCsvFile("planes-inversion.csv", filas)) {
        showToast("No hay planes que exportar", { type: "warning" })
    }
}

function dcaExportarCsv() {
    const filas = dcaFiltrados().map((row) => {
        const c = dcaCalcular(row)
        return {
            Nombre: row.nombre,
            Símbolo: row.symbol,
            Estado: row.estado,
            Moneda: c.currency,
            Importe: c.importe,
            Frecuencia: c.frecuencia,
            Inicio: row.fechaInicio,
            Fin: row.fechaFin,
            "Aportes hechos": c.realizados,
            "Aportes objetivo": row.aportesObjetivo,
            "Aportado estimado": c.invertido,
            "Total planificado": c.planificado,
            "Equivalente mensual": c.equivalenteMensual,
            "Próximo aporte": c.proximo ? planFormatearFecha(c.proximo) : "",
            "Precio actual": c.actual,
            "Precio máximo": c.precioMaximo,
            Notas: row.notas
        }
    })

    if (!downloadCsvFile("planes-dca.csv", filas)) {
        showToast("No hay planes DCA que exportar", { type: "warning" })
    }
}

// ── Interacción ──────────────────────────────────────────────────────────────

function planAbrirGrafico(row) {
    const simbolo = buildTVSymbol({
        tvSymbol: row.tvSymbol,
        marketSymbol: row.ticker,
        symbol: row.symbol || row.nombre,
        marketProvider: row.marketProvider
    })

    if (!simbolo) {
        showToast("Este plan no tiene ticker con el que abrir el gráfico", { type: "warning" })
        return
    }

    openTVChartModal(simbolo, row.nombre || row.symbol || simbolo)
}

function planesManejarClickTarjeta(evento, { rows, atributo, editar, eliminar, duplicar, extra }) {
    const boton = evento.target.closest(".planActionBtn")

    if (boton) {
        const id = boton.dataset.planId
        if (boton.classList.contains("planEditBtn")) editar(id)
        else if (boton.classList.contains("planDeleteBtn")) eliminar(id)
        else if (boton.classList.contains("planDuplicateBtn")) duplicar(id)
        else extra(boton, id)
        return
    }

    if (evento.target.closest(".rowMenu")) return

    const tarjeta = evento.target.closest(".planCard")
    if (!tarjeta) return

    const row = rows().find((fila) => fila.id === tarjeta.dataset[atributo])
    if (row) planAbrirGrafico(row)
}

function planesBindFiltros(contenedorId, alCambiar) {
    const contenedor = document.getElementById(contenedorId)
    if (!contenedor || contenedor.dataset.bound === "true") return
    contenedor.dataset.bound = "true"

    contenedor.addEventListener("click", (evento) => {
        const boton = evento.target.closest(".filterDropBtn")
        if (!boton) return
        contenedor.querySelectorAll(".filterDropBtn").forEach((otro) => {
            otro.classList.toggle("active", otro === boton)
        })
        alCambiar(boton.dataset.estado)
    })
}

function planesBindBusqueda(inputId, alEscribir) {
    const input = document.getElementById(inputId)
    if (!input || input.dataset.bound === "true") return
    input.dataset.bound = "true"
    input.addEventListener("input", () => alEscribir(input.value.trim()))
}

function planesBindClick(id, manejador) {
    const elemento = document.getElementById(id)
    if (!elemento || elemento.dataset.bound === "true") return
    elemento.dataset.bound = "true"
    elemento.addEventListener("click", manejador)
}

const PLAN_CATEGORIA_PANELES = {
    activos: "avCatPanelActivos",
    planes: "avCatPanelPlanes",
    dca: "avCatPanelDca"
}

function planesCambiarCategoria(categoria) {
    const elegida = PLAN_CATEGORIA_PANELES[categoria] ? categoria : "activos"

    document.querySelectorAll("#avCatTabs .avCatTab").forEach((boton) => {
        boton.classList.toggle("avCatTabActive", boton.dataset.cat === elegida)
    })

    Object.entries(PLAN_CATEGORIA_PANELES).forEach(([clave, panelId]) => {
        document.getElementById(panelId)?.classList.toggle("hidden", clave !== elegida)
    })

    localStorage.setItem("activosCategoria", elegida)
}

// ── Arranque ─────────────────────────────────────────────────────────────────

/**
 * Se llama desde `initActivosPageLogic()`, con los activos ya cargados: las
 * tarjetas necesitan el precio de la cartera, y volver a pedir la lista sería
 * repetir una petición que acaba de hacerse.
 */
async function initPlanesLogic() {
    const tabs = document.getElementById("avCatTabs")
    if (!tabs) return

    // El estado de los filtros se reinicia en cada entrada, igual que hace la
    // categoría de Activos: el fragmento HTML se vuelve a insertar con "Todos"
    // marcado y el buscador vacío, así que conservarlo dejaría la barra diciendo
    // una cosa y la rejilla enseñando otra.
    _planesFilterEstado = "all"
    _planesSearch = ""
    _dcaFilterEstado = "all"
    _dcaSearch = ""

    if (tabs.dataset.bound !== "true") {
        tabs.dataset.bound = "true"
        tabs.addEventListener("click", (evento) => {
            const boton = evento.target.closest(".avCatTab")
            if (boton) planesCambiarCategoria(boton.dataset.cat)
        })
    }

    planesBindClick("planesAddBtn", () => planAbrirEditor())
    planesBindClick("dcaAddBtn", () => dcaAbrirEditor())
    planesBindClick("planesExportBtn", planesExportarCsv)
    planesBindClick("dcaExportBtn", dcaExportarCsv)

    planesBindFiltros("planesEstadoFilters", (estado) => {
        _planesFilterEstado = estado
        planesRender()
    })
    planesBindFiltros("dcaEstadoFilters", (estado) => {
        _dcaFilterEstado = estado
        dcaRender()
    })

    planesBindBusqueda("planesSearch", (texto) => {
        _planesSearch = texto
        planesRender()
    })
    planesBindBusqueda("dcaSearch", (texto) => {
        _dcaSearch = texto
        dcaRender()
    })

    const planesGrid = document.getElementById("planesGrid")
    if (planesGrid && planesGrid.dataset.bound !== "true") {
        planesGrid.dataset.bound = "true"
        planesGrid.addEventListener("click", (evento) =>
            planesManejarClickTarjeta(evento, {
                rows: () => _planesRows,
                atributo: "planId",
                editar: planAbrirEditor,
                eliminar: planEliminar,
                duplicar: planDuplicar,
                extra: (boton, id) => {
                    if (boton.classList.contains("planEstadoBtn")) planCambiarEstado(id)
                }
            })
        )
    }

    const dcaGrid = document.getElementById("dcaGrid")
    if (dcaGrid && dcaGrid.dataset.bound !== "true") {
        dcaGrid.dataset.bound = "true"
        dcaGrid.addEventListener("click", (evento) =>
            planesManejarClickTarjeta(evento, {
                rows: () => _dcaRows,
                atributo: "dcaId",
                editar: dcaAbrirEditor,
                eliminar: dcaEliminar,
                duplicar: dcaDuplicar,
                extra: (boton, id) => {
                    if (boton.classList.contains("dcaCalendarBtn")) dcaAbrirCalendario(id)
                }
            })
        )
    }

    // Se vuelve a la categoría en la que se estaba: en esta pantalla se entra y
    // se sale constantemente desde el menú, y reiniciarla a "Activos" cada vez
    // obligaría a dar dos clics para seguir donde uno lo dejó.
    planesCambiarCategoria(localStorage.getItem("activosCategoria") || "activos")

    await planesCargarTodo()
    planesRender()
    dcaRender()
    planesRefrescarCotizaciones()
}
