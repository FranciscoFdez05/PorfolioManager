// Planes de inversión y planes de aportación periódica (DCA).
//
// Viven dentro de la ficha de cada activo, como dos pestañas más junto a
// "Compras spot" y "Ventas": el activo dice lo que se tiene y el plan lo que se
// piensa hacer con él. Por eso todo plan cuelga de un activo (`assetId`) y por
// eso no comparten almacenamiento con las operaciones (tablas
// `planes_inversion` y `dca_planes`, vía /api/planes y /api/dca): un plan NO
// cuenta como operación, no toca el rendimiento, ni el FIFO fiscal, ni los
// snapshots.
//
// Un plan de inversión tampoco es una operativa de trading: es una compra a
// plazo escrita antes de hacerla. No tiene dirección corta ni stop loss, y por
// tanto tampoco ratio beneficio/riesgo ni "riesgo asumido"; lo que se planifica
// es a qué precio entrar, a qué precio recoger y con cuánto capital.
//
// El precio actual, que es lo que da sentido a las tarjetas, sale del propio
// activo cuya ficha está abierta: ya está cargado y refrescado, así que no
// cuesta ninguna petición más.
//
// Todo el cálculo —lo que falta para el objetivo, el calendario de aportes— se
// hace aquí y no se guarda: depende del precio del momento, y persistirlo solo
// serviría para enseñar números caducados.

const PLAN_ESTADOS = ["Pendiente", "En curso", "Cumplido", "Cancelado"]
const PLAN_HORIZONTES = ["Corto", "Medio", "Largo"]
const DCA_FRECUENCIAS = ["Semanal", "Quincenal", "Mensual", "Trimestral"]
const DCA_ESTADOS = ["Activo", "Pausado", "Finalizado"]

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

// Las dos listas se guardan enteras aunque en pantalla solo se vea la parte de
// un activo: el servidor recibe siempre la lista completa, así que perder de
// vista los planes de los demás activos los borraría al guardar.
let _planesRows = []
let _dcaRows = []
let _planesCargados = false

// Activo cuya ficha está abierta. Es el que filtra las dos rejillas y el que
// pone el precio con el que se evalúa cada plan.
let _planesAsset = null

let _planesFilterEstado = "all"
let _dcaFilterEstado = "all"

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
    _planesCargados = true
}

// Se guarda la lista entera en cada cambio: crear, editar y borrar son la misma
// operación desde el punto de vista del servidor, y así el orden guardado es
// siempre el que se ve en pantalla.
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

function planesDelActivo() {
    const id = _planesAsset?.id
    return id ? _planesRows.filter((row) => row.assetId === id) : []
}

function dcaDelActivo() {
    const id = _planesAsset?.id
    return id ? _dcaRows.filter((row) => row.assetId === id) : []
}

/** Campos que el plan copia del activo del que cuelga. */
function planDatosDelActivo() {
    const activo = _planesAsset || {}
    return {
        assetId: activo.id || "",
        symbol: activo.symbol || activo.name || "",
        ticker: activo.marketSymbol || activo.finnhubSymbol || "",
        marketProvider: activo.marketProvider || "",
        tvSymbol: activo.tvSymbol || "",
        currency: activo.currency || "EUR"
    }
}

// ── Precio actual ────────────────────────────────────────────────────────────

/**
 * Precio con el que se evalúa el plan: el del activo de la ficha.
 *
 * No hay segunda fuente. Antes un plan podía apuntar a un ticker suelto y había
 * que cotizarlo aparte; ahora que todo plan cuelga de un activo, ese precio ya
 * está en pantalla y pedirlo otra vez solo gastaría cuota del proveedor.
 */
function planPrecioActual() {
    const activo = _planesAsset
    const precio = activo ? parseLooseNumber(activo.price || "") : null

    return {
        precio: precio === null || !Number.isFinite(precio) ? null : precio,
        currency: activo?.currency || "EUR"
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
 * Se lee siempre en el sentido de una compra: se entra a un precio y se recoge
 * más arriba. Un objetivo por debajo de la entrada no es un corto, es un plan
 * mal escrito, y sale con el recorrido en negativo para que se vea.
 */
function planCalcular(row) {
    const { precio: actual, currency } = planPrecioActual()
    const entrada = planNumero(row.precioEntrada)
    const salida = planNumero(row.precioSalida)
    const capital = planNumero(row.capital)

    // Cuánto tiene que moverse el precio de hoy para llegar ahí.
    const hastaEntrada = planVariacion(actual, entrada)
    const hastaObjetivo = planVariacion(actual, salida)

    // Y esto es lo que da el plan si sale: de la entrada al objetivo.
    const recorrido = planVariacion(entrada, salida)
    const unidades = capital !== null && entrada ? capital / entrada : null
    const beneficio = capital !== null && recorrido !== null ? (capital * recorrido) / 100 : null

    const posicion = (valor) =>
        entrada !== null && salida !== null && entrada !== salida && valor !== null
            ? Math.min(100, Math.max(0, ((valor - entrada) / (salida - entrada)) * 100))
            : null

    const objetivoAlcanzado = actual !== null && salida !== null && actual >= salida
    const enEntrada = actual !== null && entrada !== null && actual <= entrada

    let aviso = ""
    if (objetivoAlcanzado) aviso = "objetivo"
    else if (enEntrada) aviso = "entrada"

    return {
        actual,
        currency,
        entrada,
        salida,
        capital,
        hastaEntrada,
        hastaObjetivo,
        recorrido,
        unidades,
        beneficio,
        progreso: posicion(actual),
        aviso
    }
}

// ── Cálculo de un plan DCA ───────────────────────────────────────────────────

// Tope de iteraciones al recorrer el calendario. Un plan semanal indefinido
// empezado hace diez años son ~520 aportes; 2.000 cubre cualquier caso real y
// evita que una fecha de inicio absurda (año 1900) cuelgue la pestaña.
const DCA_MAX_APORTES = 2000

function dcaCalcular(row) {
    const { precio: actual, currency } = planPrecioActual()
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

// ── Tarjeta de un plan de inversión ──────────────────────────────────────────

const PLAN_AVISOS = {
    entrada: { texto: "En zona de entrada", clase: "planAvisoEntrada" },
    objetivo: { texto: "Objetivo alcanzado", clase: "planAvisoObjetivo" }
}

function planConstruirTarjeta(row) {
    const c = planCalcular(row)
    const color = PLAN_ESTADO_COLORS[row.estado] || "#64748b"
    const aviso = PLAN_AVISOS[c.aviso]

    const tarjeta = document.createElement("div")
    tarjeta.className = "avCard planCard"
    tarjeta.dataset.planId = row.id
    tarjeta.style.setProperty("--av-color", color)

    const barra =
        c.progreso === null
            ? ""
            : `
        <div class="planTrack" title="Del precio de entrada al objetivo">
            <div class="planTrackFill" style="width:${c.progreso.toFixed(2)}%;background:${color}"></div>
        </div>
        <div class="planTrackLabels">
            <span>Entrada</span>
            <span>Objetivo</span>
        </div>`

    tarjeta.innerHTML = `
        <div class="avCardTop">
            <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(row.estado || "Pendiente")}</span>
            <div class="avCardActions planCardActions">
                ${planMenuTarjeta(row.id, `<button type="button" class="rowMenuItem planActionBtn planEstadoBtn" data-plan-id="${escapeAttr(row.id)}">Cambiar estado</button>`)}
            </div>
        </div>
        <div class="avCardName">${escapeHtml(row.nombre || row.symbol || "Plan")}</div>
        <div class="avCardPrice">${planImporte(c.actual, c.currency)}</div>

        ${aviso ? `<div class="planAviso ${aviso.clase}">${aviso.texto}</div>` : ""}

        <div class="planDestacado">
            <span class="planDestacadoLabel">Falta para el objetivo</span>
            <span class="planDestacadoValor ${planClaseSigno(c.hastaObjetivo)}">${planPorcentajeConSigno(c.hastaObjetivo)}</span>
        </div>
        ${barra}

        <div class="avCardMetrics planCardMetrics">
            ${planMetrica("Entrada", planImporte(c.entrada, c.currency))}
            ${planMetrica("Objetivo", planImporte(c.salida, c.currency))}
            ${planMetrica("Hasta entrada", planPorcentajeConSigno(c.hastaEntrada), planClaseSigno(c.hastaEntrada))}
            ${planMetrica("Recorrido", planPorcentajeConSigno(c.recorrido), planClaseSigno(c.recorrido))}
            ${planMetrica("Capital", planImporte(c.capital, c.currency))}
            ${planMetrica("Unidades est.", c.unidades === null ? "—" : formatShareQuantity(c.unidades))}
            ${planMetrica("Beneficio pot.", c.beneficio === null ? "—" : planImporte(c.beneficio, c.currency), planClaseSigno(c.beneficio))}
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

        ${c.porEncimaDelMaximo ? `<div class="planAviso planAvisoMaximo">Por encima del precio máximo</div>` : ""}

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

// ── Resumen de la pestaña ────────────────────────────────────────────────────

function planKpi(etiqueta, valor, clase = "") {
    return `
        <div class="planKpi">
            <span class="planKpiLabel">${escapeHtml(etiqueta)}</span>
            <span class="planKpiValue ${clase}">${valor}</span>
        </div>`
}

/**
 * Los totales van en la moneda del activo y sin conversión ninguna.
 *
 * Cuando los planes vivían todos juntos había que pasarlos a euros para poder
 * sumarlos; aquí todos son del mismo activo, así que ya están en la misma
 * unidad y la suma es exacta y síncrona.
 */
function planesRenderKpis(filas) {
    const contenedor = document.getElementById("planesKpis")
    if (!contenedor) return

    const { currency } = planPrecioActual()
    let capital = 0
    let beneficio = 0

    for (const row of filas) {
        const c = planCalcular(row)
        if (c.capital !== null) capital += c.capital
        if (c.beneficio !== null) beneficio += c.beneficio
    }

    contenedor.innerHTML = `
        ${planKpi("Planes mostrados", String(filas.length))}
        ${planKpi("Capital planificado", planImporte(capital, currency))}
        ${planKpi("Beneficio potencial", planImporte(beneficio, currency), planClaseSigno(beneficio))}
    `
}

function dcaRenderKpis(filas) {
    const contenedor = document.getElementById("dcaKpis")
    if (!contenedor) return

    const { currency } = planPrecioActual()
    let mensual = 0
    let aportado = 0
    let planificado = 0
    let activos = 0

    for (const row of filas) {
        const c = dcaCalcular(row)
        if (row.estado === "Activo") {
            activos += 1
            if (c.equivalenteMensual !== null) mensual += c.equivalenteMensual
        }
        if (c.invertido !== null) aportado += c.invertido
        if (c.planificado !== null) planificado += c.planificado
    }

    contenedor.innerHTML = `
        ${planKpi("Planes activos", String(activos))}
        ${planKpi("Aportación mensual", planImporte(mensual, currency))}
        ${planKpi("Aportado hasta hoy", planImporte(aportado, currency))}
        ${planKpi("Total planificado", planificado ? planImporte(planificado, currency) : "—")}
        ${planKpi("Queda por aportar", planificado ? planImporte(Math.max(0, planificado - aportado), currency) : "—")}
    `
}

// ── Render de las rejillas ───────────────────────────────────────────────────

function planesFiltrados() {
    return planesDelActivo().filter((row) => _planesFilterEstado === "all" || row.estado === _planesFilterEstado)
}

function dcaFiltrados() {
    return dcaDelActivo().filter((row) => _dcaFilterEstado === "all" || row.estado === _dcaFilterEstado)
}

/** Deja en la pestaña el número de planes del activo, como hace la de Ventas. */
function planesEtiquetaPestana(botonId, texto, cuantos) {
    const boton = document.getElementById(botonId)
    if (boton) boton.textContent = cuantos ? `${texto} (${cuantos})` : texto
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
    planesEtiquetaPestana("planesTabBtn", "Planes", planesDelActivo().length)
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
    planesEtiquetaPestana("dcaTabBtn", "DCA", dcaDelActivo().length)
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

function planLeer(id) {
    const elemento = document.getElementById(id)
    return elemento ? elemento.value.trim() : ""
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
    if (!_planesAsset) return

    const existente = planId ? _planesRows.find((row) => row.id === planId) : null
    const row = existente || {
        id: planNuevoId("plan"),
        horizonte: "Medio",
        estado: "Pendiente"
    }

    const nombreActivo = _planesAsset.name || _planesAsset.symbol || ""
    const { currency } = planPrecioActual()

    const campos = `
        ${planCampoTexto("planFormNombre", "Nombre del plan", row.nombre, { placeholder: `${nombreActivo} a un precio objetivo`, pista: `El plan es de ${nombreActivo}. Sin nombre se queda con el del activo.` })}
        ${planCampoTexto("planFormEntrada", "Precio de entrada", row.precioEntrada, { placeholder: "60.000" })}
        ${planCampoTexto("planFormSalida", "Precio de salida (objetivo)", row.precioSalida, { placeholder: "120.000" })}
        ${planCampoTexto("planFormCapital", "Capital a invertir", row.capital, { placeholder: "3.000", pista: `En ${currency}, la moneda del activo.` })}
        ${planCampoSelect("planFormHorizonte", "Horizonte", row.horizonte || "Medio", PLAN_HORIZONTES)}
        ${planCampoSelect("planFormEstado", "Estado", row.estado || "Pendiente", PLAN_ESTADOS)}
        ${planCampoTexto("planFormFecha", "Fecha objetivo", row.fechaObjetivo, { placeholder: "dd-mm-aaaa" })}
        ${planCampoNotas("planFormNotas", row.notas)}
    `

    planAbrirModal({
        titulo: existente ? "Editar plan de inversión" : `Nuevo plan · ${nombreActivo}`,
        campos,
        onGuardar: async () => {
            const actualizado = {
                ...planDatosDelActivo(),
                id: row.id,
                nombre: planLeer("planFormNombre") || nombreActivo,
                precioEntrada: planLeer("planFormEntrada"),
                precioSalida: planLeer("planFormSalida"),
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
            planesGuardarPlanes()
        },
        onEliminar: existente ? () => planEliminar(row.id) : null
    })
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
    if (!_planesAsset) return

    const existente = planId ? _dcaRows.find((row) => row.id === planId) : null
    const row = existente || {
        id: planNuevoId("dca"),
        frecuencia: "Mensual",
        estado: "Activo",
        fechaInicio: todayDateString()
    }

    const nombreActivo = _planesAsset.name || _planesAsset.symbol || ""
    const { currency } = planPrecioActual()

    const campos = `
        ${planCampoTexto("dcaFormNombre", "Nombre del plan", row.nombre, { placeholder: `${nombreActivo} mensual`, pista: `El plan es de ${nombreActivo}. Sin nombre se queda con el del activo.` })}
        ${planCampoTexto("dcaFormImporte", "Importe por aporte", row.importe, { placeholder: "300", pista: `En ${currency}, la moneda del activo.` })}
        ${planCampoSelect("dcaFormFrecuencia", "Frecuencia", row.frecuencia || "Mensual", DCA_FRECUENCIAS)}
        ${planCampoTexto("dcaFormInicio", "Fecha de inicio", row.fechaInicio, { placeholder: "dd-mm-aaaa" })}
        ${planCampoTexto("dcaFormFin", "Fecha de fin", row.fechaFin, { placeholder: "dd-mm-aaaa", pista: "Opcional. Vacío = plan indefinido." })}
        ${planCampoTexto("dcaFormObjetivo", "Nº de aportes objetivo", row.aportesObjetivo, { placeholder: "24", pista: "Opcional. Es lo que llena la barra de progreso." })}
        ${planCampoTexto("dcaFormMaximo", "Precio máximo de compra", row.precioMaximo, { placeholder: "Opcional", pista: "Avisa en la tarjeta cuando la cotización lo supera." })}
        ${planCampoSelect("dcaFormEstado", "Estado", row.estado || "Activo", DCA_ESTADOS)}
        ${planCampoNotas("dcaFormNotas", row.notas)}
    `

    planAbrirModal({
        titulo: existente ? "Editar plan DCA" : `Nuevo plan DCA · ${nombreActivo}`,
        campos,
        onGuardar: async () => {
            const objetivo = planLeer("dcaFormObjetivo")
            if (objetivo && parseLooseNumber(objetivo) === null) {
                showToast("El número de aportes objetivo tiene que ser un número", { type: "warning" })
                return
            }

            const actualizado = {
                ...planDatosDelActivo(),
                id: row.id,
                nombre: planLeer("dcaFormNombre") || nombreActivo,
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
            planesGuardarDca()
        },
        onEliminar: existente ? () => dcaEliminar(row.id) : null
    })
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

// ── Pestañas dentro de la ficha del activo ───────────────────────────────────

function planFiltrosHtml(id, estados) {
    const botones = [{ valor: "all", texto: "Todos" }, ...estados]
        .map(
            ({ valor, texto }) =>
                `<button type="button" class="filterDropBtn${valor === "all" ? " active" : ""}" data-estado="${escapeAttr(valor)}">${escapeHtml(texto)}</button>`
        )
        .join("")

    return `<div class="planFilters" id="${id}">${botones}</div>`
}

/**
 * Monta una de las dos pestañas y la deja escuchando.
 *
 * La ficha del activo se repinta entera cada vez que se abre, así que el HTML se
 * construye aquí y los manejadores se enganchan al contenedor recién creado: no
 * hay listeners que sobrevivan a la pantalla anterior ni que se dupliquen.
 */
function planesMontarSeccion({
    seccionId,
    filtrosId,
    kpisId,
    gridId,
    vacioId,
    contadorId,
    filtros,
    vacio,
    alFiltrar,
    alHacerClick
}) {
    const seccion = document.getElementById(seccionId)
    if (!seccion) return null

    seccion.innerHTML = `
        <div class="planPanelBar">
            ${planFiltrosHtml(filtrosId, filtros)}
            <span class="activosCount" id="${contadorId}"></span>
        </div>
        <div class="planKpiRow" id="${kpisId}"></div>
        <div class="activosGrid planesGrid" id="${gridId}"></div>
        <p class="overviewEmpty hidden" id="${vacioId}">${escapeHtml(vacio)}</p>`

    seccion.querySelector(`#${filtrosId}`).addEventListener("click", (evento) => {
        const boton = evento.target.closest(".filterDropBtn")
        if (!boton) return
        seccion.querySelectorAll(".filterDropBtn").forEach((otro) => {
            otro.classList.toggle("active", otro === boton)
        })
        alFiltrar(boton.dataset.estado)
    })

    seccion.querySelector(`#${gridId}`).addEventListener("click", alHacerClick)
    return seccion
}

/**
 * Se llama desde `renderAssetTablePage()`, con el activo ya pintado: las
 * tarjetas leen de él el precio actual y la moneda.
 *
 * Las dos listas se piden una sola vez por sesión. Solo se tocan desde aquí, así
 * que volver a pedirlas al abrir cada activo serían dos peticiones por ficha
 * para recibir exactamente lo que ya está en memoria.
 */
async function initAssetPlanesLogic(asset) {
    _planesAsset = asset || null
    _planesFilterEstado = "all"
    _dcaFilterEstado = "all"

    const planes = planesMontarSeccion({
        seccionId: "assetPlanesSection",
        filtrosId: "planesEstadoFilters",
        kpisId: "planesKpis",
        gridId: "planesGrid",
        vacioId: "planesEmpty",
        contadorId: "planesCount",
        filtros: PLAN_ESTADOS.map((estado) => ({ valor: estado, texto: estado })),
        vacio: "Este activo no tiene ningún plan de inversión. Crea uno para dejar por escrito a qué precio entras, dónde recoges el beneficio y con cuánto capital.",
        alFiltrar: (estado) => {
            _planesFilterEstado = estado
            planesRender()
        },
        alHacerClick: (evento) =>
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
    })

    planesMontarSeccion({
        seccionId: "assetDcaSection",
        filtrosId: "dcaEstadoFilters",
        kpisId: "dcaKpis",
        gridId: "dcaGrid",
        vacioId: "dcaEmpty",
        contadorId: "dcaCount",
        filtros: DCA_ESTADOS.map((estado) => ({ valor: estado, texto: estado })),
        vacio: "Este activo no tiene ningún plan de aportación periódica. Crea uno para fijar cuánto aportas, cada cuánto y hasta cuándo.",
        alFiltrar: (estado) => {
            _dcaFilterEstado = estado
            dcaRender()
        },
        alHacerClick: (evento) =>
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
    })

    if (!planes) return

    if (!_planesCargados) await planesCargarTodo()

    planesRender()
    dcaRender()
}
