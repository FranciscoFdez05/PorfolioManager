// Planes de inversión de la cartera (menú superior › Planes).
//
// Un plan es un nombre —"Acumular en 2026"— y, debajo, los activos que se
// piensan comprar y con qué operaciones. No confundir con la pestaña "Planes"
// de la ficha de cada activo (js/cartera/planes.js), que es una nota de precio
// de entrada y salida para un solo activo. Aquí el plan cruza activos y cada
// línea es una operación de verdad.
//
// Cada operación del plan es una fila de Operaciones (/api/operaciones, la
// misma tabla que ven Cripto › Operaciones y Finanzas › Operaciones): al montar
// el plan se vinculan las que ya están abiertas con ese activo o se crean
// nuevas, que nacen en esa tabla con estado "Activo". Por eso el plan no
// guarda importes ni una marca de "realizado": lo que está hecho es lo que en
// Operaciones aparece como "Completado", y cuando una operación se completa el
// plan lo refleja solo.
//
// Todo lo que aquí se calcula —cuánto hay invertido, qué porcentaje del plan
// está realizado, el peso de cada compra— se hace en el navegador con las
// operaciones ya cargadas, y en euros: un plan puede mezclar un activo en
// dólares con otro en euros, y para sumarlos hace falta una sola moneda.
//
// Todas las funciones y variables llevan el prefijo `pinv` para no pisar las
// de planes.js: los dos ficheros comparten el ámbito global.

const PINV_API = "/api/planes-cartera"
const PINV_OPERACIONES_API = "/api/operaciones"

// Cuántos activos se ven en el popup antes de que la lista empiece a
// desplazarse. Nombre y selector de activos quedan fuera de ese scroll.
const PINV_ACTIVOS_VISIBLES = 5

const PINV_COLOR_REALIZADO = "#2ecc71"
const PINV_COLOR_PENDIENTE = "#3b82f6"

let _pinvPlanes = []
let _pinvActivos = []
let _pinvOperaciones = []
let _pinvPlanActual = null
let _pinvDesplegados = new Set()
let _pinvChart = null

// Recalcula el difuminado de los bordes de la fila de planes. La deja puesta
// initScrollLateral() al montar la página.
let _pinvActualizarTabs = () => {}

// Tipo de cambio de cada divisa a euros. Se piden una vez por sesión y solo las
// que aparecen en algún plan: normalmente EUR y USD.
const _pinvTipos = new Map()

// ── Datos ────────────────────────────────────────────────────────────────────

async function pinvFetchJson(url, vacio) {
    try {
        const respuesta = await fetch(url)
        return respuesta.ok ? await respuesta.json() : vacio
    } catch {
        return vacio
    }
}

async function pinvCargarTodo() {
    const [planes, activos, operaciones] = await Promise.all([
        pinvFetchJson(PINV_API, { rows: [] }),
        pinvFetchJson("/api/activos", { assets: [] }),
        pinvFetchJson(PINV_OPERACIONES_API, { rows: [] })
    ])

    _pinvActivos = (Array.isArray(activos.assets) ? activos.assets : [])
        .map((activo) => ({
            id: String(activo.id || "").trim(),
            name: String(activo.name || activo.symbol || "").trim(),
            symbol: String(activo.symbol || activo.name || "")
                .trim()
                .toUpperCase(),
            marketSymbol: String(activo.marketSymbol || activo.finnhubSymbol || "").trim(),
            type: String(activo.type || "")
                .trim()
                .toLowerCase(),
            currency: String(activo.currency || "EUR").trim()
        }))
        .filter((activo) => activo.id && activo.name)
        .sort((a, b) => a.name.localeCompare(b.name, "es", { sensitivity: "base" }))

    _pinvOperaciones = Array.isArray(operaciones.rows) ? operaciones.rows : []

    // Un activo borrado ya no vuelve del servidor (la FK se llevó su línea), pero
    // la lista puede haberse cargado antes en otra pestaña: se filtra por si acaso
    // para no reenviar un assetId que el servidor rechazaría.
    const ids = new Set(_pinvActivos.map((activo) => activo.id))
    _pinvPlanes = (Array.isArray(planes.rows) ? planes.rows : []).map((plan) => ({
        id: String(plan.id || ""),
        nombre: String(plan.nombre || ""),
        archivado: Boolean(plan.archivado),
        activos: (Array.isArray(plan.activos) ? plan.activos : [])
            .filter((activo) => ids.has(activo.assetId))
            .map((activo) => ({
                assetId: activo.assetId,
                operaciones: Array.isArray(activo.operaciones) ? [...activo.operaciones] : []
            }))
    }))

    await pinvAsegurarTipos()
}

// La lista se guarda entera en cada cambio: crear, editar, archivar y borrar
// son la misma operación desde el punto de vista del servidor.
async function pinvGuardarPlanes() {
    try {
        const respuesta = await fetch(PINV_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows: _pinvPlanes })
        })
        if (!respuesta.ok) {
            const cuerpo = await respuesta.json().catch(() => ({}))
            throw new Error(cuerpo.error || `HTTP ${respuesta.status}`)
        }
        return true
    } catch (error) {
        showError("No se pudo guardar el plan de inversión", error)
        return false
    }
}

/**
 * Las operaciones nuevas del plan se escriben en la tabla de Operaciones, que
 * se guarda entera igual que la ven sus propias páginas. Se envía lo que se
 * acaba de descargar más las nuevas: entre la carga y el guardado no hay otra
 * pantalla tocándola en esta pestaña.
 */
async function pinvGuardarOperacionesNuevas(nuevas) {
    if (!nuevas.length) return true

    const rows = [..._pinvOperaciones, ...nuevas]
    try {
        const respuesta = await fetch(PINV_OPERACIONES_API, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ rows })
        })
        if (!respuesta.ok) {
            const cuerpo = await respuesta.json().catch(() => ({}))
            throw new Error(cuerpo.error || `HTTP ${respuesta.status}`)
        }
        _pinvOperaciones = rows
        return true
    } catch (error) {
        showError("No se pudieron crear las operaciones del plan", error)
        return false
    }
}

/** Divisas que aparecen en las operaciones de algún plan. */
function pinvDivisasEnUso() {
    const divisas = new Set()
    for (const plan of _pinvPlanes) {
        for (const activo of plan.activos) {
            for (const id of activo.operaciones) {
                const op = pinvOperacionPorId(id)
                if (op) {
                    divisas.add(normalizeCurrencyCode(op.currency))
                    divisas.add(normalizeCurrencyCode(op.precioCurrency || op.currency))
                }
            }
        }
    }
    return divisas
}

async function pinvAsegurarTipos(divisas = pinvDivisasEnUso()) {
    const pendientes = [...divisas].filter((divisa) => divisa !== "EUR" && !_pinvTipos.has(divisa))

    await Promise.all(
        pendientes.map(async (divisa) => {
            const datos = await pinvFetchJson(
                `/api/exchange-rate?source=${encodeURIComponent(divisa)}&target=EUR`,
                null
            )
            const tipo = Number(datos?.rate)
            // Sin tipo de cambio se suma a la par antes que dejar el plan sin
            // totales; el aviso queda en consola porque es un dato de apoyo.
            if (!Number.isFinite(tipo) || tipo <= 0) {
                console.warn(`Sin tipo de cambio ${divisa}→EUR: los importes del plan se suman a la par`)
            }
            _pinvTipos.set(divisa, Number.isFinite(tipo) && tipo > 0 ? tipo : 1)
        })
    )
}

function pinvAEuros(importe, divisa) {
    const codigo = normalizeCurrencyCode(divisa)
    if (codigo === "EUR") return importe
    return importe * (_pinvTipos.get(codigo) ?? 1)
}

function pinvOperacionPorId(id) {
    return _pinvOperaciones.find((op) => op.id === id) || null
}

function pinvActivoPorId(id) {
    return _pinvActivos.find((activo) => activo.id === id) || null
}

function pinvPlanPorId(id) {
    return _pinvPlanes.find((plan) => plan.id === id) || null
}

function pinvPlanesActivos() {
    return _pinvPlanes.filter((plan) => !plan.archivado)
}

function pinvNumero(valor) {
    const numero = parseLooseNumber(valor)
    return numero === null || !Number.isFinite(numero) ? null : numero
}

function pinvNuevoId(prefijo) {
    return `${prefijo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

// ── Cálculo ──────────────────────────────────────────────────────────────────

/**
 * Importe de una operación en su divisa: el total si está escrito y, si no,
 * precio por cantidad. Es lo que en Operaciones se llama "Total".
 */
function pinvImporteOperacion(op) {
    const total = pinvNumero(op.total)
    if (total !== null && total > 0) return total

    const precio = pinvNumero(op.precioOrden)
    const cantidad = pinvNumero(op.cantidad)
    return precio !== null && cantidad !== null ? precio * cantidad : 0
}

function pinvEstadoOperacion(op) {
    const estado = String(op.estado || "").trim()
    if (estado === "Completado") return "realizada"
    if (estado === "Cancelado") return "cancelada"
    return "pendiente"
}

/**
 * Un activo del plan con sus operaciones resueltas y sus totales.
 *
 * Las canceladas se enseñan pero no cuentan: ni en lo planificado ni en el
 * reparto de porcentajes. Lo realizado es lo que en Operaciones está
 * "Completado". El precio medio se pondera por cantidad y sale en euros, que
 * es la única moneda en la que se pueden mezclar compras en dólares y en euros.
 */
function pinvCalcularActivo(planActivo) {
    const activo = pinvActivoPorId(planActivo.assetId)
    const operaciones = planActivo.operaciones.map(pinvOperacionPorId).filter(Boolean)

    let planificadoEur = 0
    let realizadoEur = 0
    let cantidad = 0
    let costeEur = 0
    const ordenes = new Set()

    const filas = operaciones.map((op) => {
        const estado = pinvEstadoOperacion(op)
        const importe = pinvImporteOperacion(op)
        const importeEur = pinvAEuros(importe, op.currency)
        const unidades = pinvNumero(op.cantidad) || 0

        if (estado !== "cancelada") {
            planificadoEur += importeEur
            ordenes.add(op.orden === "Venta" ? "Venta" : "Compra")
            if (estado === "realizada") realizadoEur += importeEur
            // El precio medio solo se pondera con las operaciones que dicen
            // cuántas unidades son: una con total y sin cantidad lo desviaría.
            if (unidades > 0) {
                cantidad += unidades
                costeEur += importeEur
            }
        }

        return { op, estado, importe, importeEur, unidades, pct: null }
    })

    for (const fila of filas) {
        fila.pct = fila.estado !== "cancelada" && planificadoEur > 0 ? (fila.importeEur / planificadoEur) * 100 : null
    }

    let orden = "—"
    if (ordenes.size === 1) orden = [...ordenes][0]
    else if (ordenes.size > 1) orden = "Mixta"

    return {
        assetId: planActivo.assetId,
        activo,
        nombre: activo?.name || planActivo.assetId,
        operaciones: filas,
        orden,
        cantidad,
        precioMedioEur: cantidad > 0 ? costeEur / cantidad : null,
        planificadoEur,
        realizadoEur,
        pctInvertido: planificadoEur > 0 ? (realizadoEur / planificadoEur) * 100 : null,
        realizadas: filas.filter((fila) => fila.estado === "realizada").length,
        vigentes: filas.filter((fila) => fila.estado !== "cancelada").length
    }
}

function pinvCalcularPlan(plan) {
    const activos = plan.activos.map(pinvCalcularActivo)
    const planificadoEur = activos.reduce((suma, activo) => suma + activo.planificadoEur, 0)
    const realizadoEur = activos.reduce((suma, activo) => suma + activo.realizadoEur, 0)

    return {
        plan,
        activos,
        planificadoEur,
        realizadoEur,
        pendienteEur: Math.max(0, planificadoEur - realizadoEur),
        pctRealizado: planificadoEur > 0 ? (realizadoEur / planificadoEur) * 100 : 0,
        operaciones: activos.reduce((suma, activo) => suma + activo.operaciones.length, 0)
    }
}

// ── Formateo ─────────────────────────────────────────────────────────────────

function pinvEuros(valor) {
    return valor === null || !Number.isFinite(valor) ? "—" : formatMoney(valor, "EUR")
}

function pinvPorcentaje(valor) {
    if (valor === null || !Number.isFinite(valor)) return "—"
    return new Intl.NumberFormat("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: 1 }).format(valor) + " %"
}

function pinvCantidad(valor, tipo) {
    if (valor === null || !Number.isFinite(valor)) return "—"
    const decimales = typeof getAssetParticipationDecimals === "function" ? getAssetParticipationDecimals(tipo) : 6
    return valor.toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: decimales })
}

function pinvBadgeOrden(orden) {
    const clase = orden === "Venta" ? "pinvOrdenVenta" : orden === "Compra" ? "pinvOrdenCompra" : "pinvOrdenMixta"
    return `<span class="pinvOrden ${clase}">${escapeHtml(orden)}</span>`
}

const PINV_ESTADOS = {
    realizada: { texto: "Realizada", clase: "pinvEstadoRealizada" },
    pendiente: { texto: "No realizada", clase: "pinvEstadoPendiente" },
    cancelada: { texto: "Cancelada", clase: "pinvEstadoCancelada" }
}

function pinvPillEstado(estado) {
    const info = PINV_ESTADOS[estado] || PINV_ESTADOS.pendiente
    return `<span class="pinvEstado ${info.clase}">${info.texto}</span>`
}

/** Resumen de una operación en una línea, para listas y desplegables. */
function pinvResumenOperacion(op, activo) {
    const partes = [op.orden === "Venta" ? "Venta" : "Compra"]
    const cantidad = pinvNumero(op.cantidad)
    if (cantidad !== null) partes.push(`${pinvCantidad(cantidad, activo?.type)} ${pinvSimboloBase(activo)}`.trim())
    const precio = pinvNumero(op.precioOrden)
    if (precio !== null) partes.push(`a ${formatMoney(precio, op.precioCurrency || op.currency)}`)
    partes.push(formatMoney(pinvImporteOperacion(op), op.currency))
    if (op.fechaApertura) partes.push(op.fechaApertura)
    return partes.join(" · ")
}

// ── Render: selector de planes ───────────────────────────────────────────────

function pinvRenderTabs() {
    const contenedor = document.getElementById("pinvPlanTabs")
    if (!contenedor) return

    const planes = pinvPlanesActivos()
    if (!planes.length) {
        contenedor.innerHTML = `<span class="pinvSinPlanes">Sin planes activos</span>`
        return
    }

    contenedor.innerHTML = planes
        .map(
            (plan) =>
                `<button type="button" class="pinvPlanTab${plan.id === _pinvPlanActual ? " active" : ""}" data-plan-id="${escapeAttr(plan.id)}">${escapeHtml(plan.nombre || "Plan")}</button>`
        )
        .join("")

    _pinvActualizarTabs()
    // El plan abierto, a la vista: al entrar puede ser uno de los últimos y la
    // fila arranca por el principio.
    contenedor.querySelector(".pinvPlanTab.active")?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
}

// ── Render: cabecera del plan ────────────────────────────────────────────────

function pinvRenderHeader(calculo) {
    const contenedor = document.getElementById("pinvPlanHeader")
    if (!contenedor) return

    if (!calculo) {
        contenedor.innerHTML = ""
        return
    }

    const { plan, activos, planificadoEur, realizadoEur, pctRealizado, operaciones } = calculo

    contenedor.innerHTML = `
        <div class="pinvPlanTitulo">
            <h2 class="pinvPlanNombre">${escapeHtml(plan.nombre || "Plan")}</h2>
            <span class="pinvPlanMeta">${activos.length} activo${activos.length !== 1 ? "s" : ""} · ${operaciones} operaci${operaciones !== 1 ? "ones" : "ón"}</span>
        </div>
        <div class="pinvPlanKpis">
            <div class="pinvKpi"><span class="pinvKpiLabel">Planificado</span><span class="pinvKpiValue pinvMoney">${pinvEuros(planificadoEur)}</span></div>
            <div class="pinvKpi"><span class="pinvKpiLabel">Realizado</span><span class="pinvKpiValue pinvMoney pinvPos">${pinvEuros(realizadoEur)}</span></div>
            <div class="pinvKpi"><span class="pinvKpiLabel">Completado</span><span class="pinvKpiValue">${pinvPorcentaje(pctRealizado)}</span></div>
        </div>
        <div class="pinvPlanAcciones">
            <button type="button" class="secondaryButton pinvHeaderBtn" data-accion="editar">Editar plan</button>
            <div class="rowMenu">
                <button type="button" class="rowMenuTrigger" title="Opciones">···</button>
                <div class="rowMenuDropdown">
                    <button type="button" class="rowMenuItem pinvHeaderBtn" data-accion="archivar">Archivar</button>
                    <hr>
                    <button type="button" class="rowMenuItem rowMenuItemDanger pinvHeaderBtn" data-accion="eliminar">Eliminar</button>
                </div>
            </div>
        </div>`
}

// ── Render: tabla de activos ─────────────────────────────────────────────────

function pinvFilaActivo(activo) {
    const abierto = _pinvDesplegados.has(activo.assetId)
    const barra =
        activo.pctInvertido === null
            ? "—"
            : `<span class="pinvBar" title="${escapeAttr(pinvEuros(activo.realizadoEur))} de ${escapeAttr(pinvEuros(activo.planificadoEur))}"><span class="pinvBarFill" style="width:${Math.min(100, activo.pctInvertido).toFixed(1)}%"></span></span><span class="pinvBarPct">${pinvPorcentaje(activo.pctInvertido)}</span>`

    return `
        <tr class="pinvAssetRow${abierto ? " pinvAssetRowOpen" : ""}" data-asset-id="${escapeAttr(activo.assetId)}">
            <td>${pinvBadgeOrden(activo.orden)}</td>
            <td class="pinvTdActivo">
                <div class="pinvCelda">
                    <span class="pinvChevron" aria-hidden="true"></span>
                    <span class="pinvActivoNombre">${escapeHtml(activo.nombre)}</span>
                    <span class="pinvActivoSub">${activo.operaciones.length} operaci${activo.operaciones.length !== 1 ? "ones" : "ón"}</span>
                </div>
            </td>
            <td class="pinvTdNum pinvMoney">${activo.cantidad > 0 ? pinvCantidad(activo.cantidad, activo.activo?.type) : "—"}</td>
            <td class="pinvTdNum pinvMoney">${pinvEuros(activo.precioMedioEur)}</td>
            <td class="pinvTdNum pinvMoney">${activo.planificadoEur > 0 ? pinvEuros(activo.planificadoEur) : "—"}</td>
            <td class="pinvTdNum pinvTdPct">${barra}</td>
            <td class="pinvTdEstado">${activo.vigentes ? `${activo.realizadas}/${activo.vigentes} realizadas` : ""}</td>
        </tr>`
}

function pinvFilaOperacion(fila, activo) {
    const { op, estado, importe, unidades, pct } = fila
    const precio = pinvNumero(op.precioOrden)

    return `
        <tr class="pinvOpRow pinvOpRow--${estado}" data-asset-id="${escapeAttr(activo.assetId)}" data-op-id="${escapeAttr(op.id)}">
            <td>${pinvBadgeOrden(op.orden === "Venta" ? "Venta" : "Compra")}</td>
            <td class="pinvTdActivo">
                <div class="pinvCelda pinvCeldaOp">
                    <span class="pinvOpFecha">${escapeHtml(op.fechaApertura || "Sin fecha")}</span>
                    ${op.par ? `<span class="pinvActivoSub">${escapeHtml(op.par)}</span>` : ""}
                </div>
            </td>
            <td class="pinvTdNum pinvMoney">${unidades ? pinvCantidad(unidades, activo.activo?.type) : "—"}</td>
            <td class="pinvTdNum pinvMoney">${precio === null ? "—" : formatMoney(precio, op.precioCurrency || op.currency)}</td>
            <td class="pinvTdNum pinvMoney">${formatMoney(importe, op.currency)}</td>
            <td class="pinvTdNum pinvTdPct">${pinvPorcentaje(pct)}</td>
            <td class="pinvTdEstado">${pinvPillEstado(estado)}</td>
        </tr>`
}

function pinvRenderTabla(calculo) {
    const cuerpo = document.getElementById("pinvBodyRows")
    const vacio = document.getElementById("pinvEmptyMsg")
    const tabla = document.getElementById("pinvTable")
    if (!cuerpo) return

    if (!calculo) {
        cuerpo.innerHTML = ""
        tabla?.classList.add("hidden")
        if (vacio) {
            vacio.textContent = pinvPlanesActivos().length
                ? "Elige un plan."
                : "No hay ningún plan de inversión. Crea uno para agrupar los activos que piensas comprar y las operaciones con las que lo vas a hacer."
            vacio.classList.remove("hidden")
        }
        return
    }

    tabla?.classList.remove("hidden")

    if (!calculo.activos.length) {
        cuerpo.innerHTML = ""
        if (vacio) {
            vacio.textContent = "Este plan no tiene activos todavía. Edítalo para añadirlos."
            vacio.classList.remove("hidden")
        }
        return
    }

    vacio?.classList.add("hidden")
    cuerpo.innerHTML = calculo.activos
        .map((activo) => {
            const filas = [pinvFilaActivo(activo)]
            if (_pinvDesplegados.has(activo.assetId)) {
                if (activo.operaciones.length) {
                    filas.push(...activo.operaciones.map((fila) => pinvFilaOperacion(fila, activo)))
                } else {
                    filas.push(
                        `<tr class="pinvOpRow pinvOpRowVacia" data-asset-id="${escapeAttr(activo.assetId)}"><td colspan="7"><div class="pinvCelda pinvCeldaOp">Sin operaciones vinculadas. Edita el plan para vincular una operación abierta o crear una nueva.</div></td></tr>`
                    )
                }
            }
            return filas.join("")
        })
        .join("")
}

// ── Render: gráfica ──────────────────────────────────────────────────────────

/**
 * Líneas del tooltip: los activos comprados si el cursor está sobre lo
 * realizado, y los que quedan por comprar si está sobre lo pendiente.
 */
function pinvLineasTooltip(calculo, realizado) {
    const lineas = []
    for (const activo of calculo.activos) {
        const importe = realizado ? activo.realizadoEur : activo.planificadoEur - activo.realizadoEur
        if (importe <= 0.005) continue
        const total = realizado ? calculo.realizadoEur : calculo.pendienteEur
        const pct = total > 0 ? (importe / total) * 100 : 0
        lineas.push(`${activo.nombre}: ${pinvEuros(importe)} (${pinvPorcentaje(pct)})`)
    }
    return lineas.length ? lineas : [realizado ? "Nada comprado todavía" : "Nada pendiente"]
}

function pinvRenderChart(calculo) {
    const canvas = document.getElementById("pinvChart")
    const centro = document.getElementById("pinvChartCenter")
    const leyenda = document.getElementById("pinvChartLegend")
    if (!canvas) return

    if (_pinvChart) {
        _pinvChart.destroy()
        _pinvChart = null
    }

    const hayDatos = calculo && calculo.planificadoEur > 0
    if (centro) {
        centro.innerHTML = hayDatos
            ? `<span class="pinvChartPct">${pinvPorcentaje(calculo.pctRealizado)}</span><span class="pinvChartSub">realizado</span>`
            : `<span class="pinvChartSub">${calculo ? "Sin importes" : "Sin plan"}</span>`
    }

    if (leyenda) {
        leyenda.innerHTML = hayDatos
            ? `
            <div class="pinvLegendRow"><span class="pinvLegendDot" style="background:${PINV_COLOR_REALIZADO}"></span><span>Realizado</span><span class="pinvLegendPct">${pinvPorcentaje(calculo.pctRealizado)}</span><span class="pinvLegendVal pinvMoney">${pinvEuros(calculo.realizadoEur)}</span></div>
            <div class="pinvLegendRow"><span class="pinvLegendDot" style="background:${PINV_COLOR_PENDIENTE}"></span><span>Por realizar</span><span class="pinvLegendPct">${pinvPorcentaje(100 - calculo.pctRealizado)}</span><span class="pinvLegendVal pinvMoney">${pinvEuros(calculo.pendienteEur)}</span></div>`
            : ""
    }

    if (!hayDatos || typeof Chart !== "function") return

    _pinvChart = new Chart(canvas, {
        type: "doughnut",
        data: {
            labels: ["Realizado", "Por realizar"],
            datasets: [
                {
                    data: [calculo.realizadoEur, calculo.pendienteEur],
                    backgroundColor: [PINV_COLOR_REALIZADO, PINV_COLOR_PENDIENTE],
                    borderWidth: 0,
                    hoverOffset: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: "68%",
            plugins: {
                legend: { display: false },
                tooltip: {
                    displayColors: false,
                    // Opaco: el porcentaje del centro quedaba a la vista a
                    // través del fondo por defecto, que es translúcido.
                    backgroundColor: "#0b1120",
                    borderColor: "#273246",
                    borderWidth: 1,
                    padding: 10,
                    callbacks: {
                        title: (items) => items[0]?.label || "",
                        label: (item) => {
                            const total = calculo.planificadoEur
                            const pct = total > 0 ? (item.parsed / total) * 100 : 0
                            return `${pinvEuros(item.parsed)} · ${pinvPorcentaje(pct)}`
                        },
                        afterBody: (items) => {
                            const realizado = items[0]?.dataIndex === 0
                            return [
                                "",
                                realizado ? "Comprado:" : "Por comprar:",
                                ...pinvLineasTooltip(calculo, realizado)
                            ]
                        }
                    }
                }
            }
        }
    })
}

// ── Reparto por activo ───────────────────────────────────────────────────────

/**
 * Una barra por activo: la longitud dice cuánto pesa dentro del plan y el
 * relleno verde, cuánto de ese activo está ya comprado.
 *
 * El ancho es proporcional al activo más grande y no al total del plan: con
 * cinco activos, repartir sobre el total deja a todos en barritas del 20 % y
 * no se aprecia cuál manda. Así el mayor llena la fila y los demás se leen
 * contra él.
 *
 * El orden es el del plan, el mismo de la tabla de la izquierda, para poder
 * mirar las dos cosas a la vez sin traducir posiciones.
 */
function pinvRenderReparto(calculo) {
    const contenedor = document.getElementById("pinvReparto")
    const tarjeta = document.getElementById("pinvRepartoCard")
    if (!contenedor || !tarjeta) return

    const activos = calculo?.activos || []
    tarjeta.classList.toggle("hidden", !activos.length)
    if (!activos.length) {
        contenedor.innerHTML = ""
        return
    }

    const mayor = Math.max(...activos.map((activo) => activo.planificadoEur))

    contenedor.innerHTML = activos
        .map((activo) => {
            const peso = mayor > 0 ? (activo.planificadoEur / mayor) * 100 : 0
            const hecho = activo.planificadoEur > 0 ? (activo.realizadoEur / activo.planificadoEur) * 100 : 0
            const detalle = `${activo.nombre}: ${pinvEuros(activo.realizadoEur)} de ${pinvEuros(activo.planificadoEur)} (${pinvPorcentaje(activo.pctInvertido)} realizado)`

            return `
            <div class="pinvRepartoFila" title="${escapeAttr(detalle)}">
                <div class="pinvRepartoCab">
                    <span class="pinvRepartoNombre">${escapeHtml(activo.nombre)}</span>
                    <span class="pinvRepartoValor pinvMoney">${activo.planificadoEur > 0 ? pinvEuros(activo.planificadoEur) : "—"}</span>
                </div>
                <div class="pinvRepartoCarril">
                    <div class="pinvRepartoBarra" style="width:${peso.toFixed(2)}%">
                        <span class="pinvRepartoHecho" style="width:${hecho.toFixed(2)}%"></span>
                    </div>
                </div>
            </div>`
        })
        .join("")
}

// ── Render ───────────────────────────────────────────────────────────────────

function pinvCalculoActual() {
    const plan = pinvPlanPorId(_pinvPlanActual)
    return plan && !plan.archivado ? pinvCalcularPlan(plan) : null
}

function pinvRender() {
    const activos = pinvPlanesActivos()
    if (!activos.some((plan) => plan.id === _pinvPlanActual)) {
        _pinvPlanActual = activos[0]?.id || null
    }
    if (_pinvPlanActual && typeof setChartPref === "function") setChartPref("pinvPlan", _pinvPlanActual)

    const calculo = pinvCalculoActual()
    pinvRenderTabs()
    pinvRenderHeader(calculo)
    pinvRenderTabla(calculo)
    pinvRenderChart(calculo)
    pinvRenderReparto(calculo)
    document.getElementById("pinvBody")?.classList.toggle("pinvBodySinPlan", !calculo)
}

// ── Editor: crear y editar un plan ───────────────────────────────────────────

// Estado del popup mientras está abierto. Las operaciones nuevas se quedan en
// `nuevas` hasta que se pulsa Guardar: cancelar el popup no deja ninguna
// operación suelta en Operaciones.
let _pinvEditor = null

function pinvOperacionesAbiertasDe(assetId) {
    return _pinvOperaciones.filter((op) => op.assetId === assetId && String(op.estado || "").trim() === "Activo")
}

function pinvDivisasOperacion() {
    const fiat =
        Array.isArray(window._fiatCurrencies) && window._fiatCurrencies.length
            ? window._fiatCurrencies
            : ["EUR", "USD", "GBP", "CHF", "JPY"]
    return fiat.map((codigo) => String(codigo).toUpperCase())
}

/**
 * Símbolo con el que se nombra el activo en un par ("BTC" en "BTC/EUR"). Lo
 * deriva Operaciones del ticker de mercado; si ese módulo no está cargado se
 * saca del ticker a mano ("BINANCE:BTC-USD" → "BTC") y, sin ticker, del símbolo.
 */
function pinvSimboloBase(activo) {
    if (!activo) return ""
    if (typeof deriveOperationAssetBaseSymbol === "function") {
        const base = deriveOperationAssetBaseSymbol(activo)
        if (base) return base
    }
    const ticker = String(activo.marketSymbol || "")
        .split(":")
        .pop()
        .split(/[-/_]/)[0]
        .trim()
        .toUpperCase()
    return ticker || String(activo.symbol || activo.name || "").toUpperCase()
}

function pinvCerrarEditor() {
    document.getElementById("pinvEditorOverlay")?.remove()
    _pinvEditor = null
}

function pinvEditorActivo(assetId) {
    return _pinvEditor?.activos.find((activo) => activo.assetId === assetId) || null
}

/** Ficha de un activo dentro del popup, con su panel de operaciones. */
function pinvEditorFichaActivo(entrada) {
    const activo = pinvActivoPorId(entrada.assetId)
    const abierto = _pinvEditor.abierto === entrada.assetId
    const vinculadas = entrada.operaciones.map(pinvOperacionPorId).filter(Boolean)
    const total =
        vinculadas.reduce((suma, op) => suma + pinvAEuros(pinvImporteOperacion(op), op.currency), 0) +
        entrada.nuevas.reduce((suma, op) => suma + pinvAEuros(pinvImporteOperacion(op), op.currency), 0)
    const cuantas = vinculadas.length + entrada.nuevas.length

    // Candidatas: las abiertas del activo que aún no están en la lista, más las
    // ya vinculadas (estén como estén, para poder desvincularlas).
    const candidatas = [
        ...vinculadas,
        ...pinvOperacionesAbiertasDe(entrada.assetId).filter((op) => !entrada.operaciones.includes(op.id))
    ]

    const listaOps = candidatas.length
        ? candidatas
              .map(
                  (op) => `
            <label class="pinvOpCheck">
                <input type="checkbox" data-op-id="${escapeAttr(op.id)}"${entrada.operaciones.includes(op.id) ? " checked" : ""}>
                <span class="pinvOpCheckTexto">${escapeHtml(pinvResumenOperacion(op, activo))}</span>
                ${pinvPillEstado(pinvEstadoOperacion(op))}
            </label>`
              )
              .join("")
        : `<p class="pinvEditorNota">No hay operaciones abiertas con ${escapeHtml(activo?.name || "este activo")}. Crea una nueva.</p>`

    const listaNuevas = entrada.nuevas
        .map(
            (op) => `
            <div class="pinvOpCheck pinvOpNueva">
                <span class="pinvOpHueco" aria-hidden="true"></span>
                <span class="pinvOpCheckTexto">${escapeHtml(pinvResumenOperacion(op, activo))}</span>
                <span class="pinvOpNuevaTag">Nueva</span>
                <button type="button" class="pinvQuitarBtn" data-quitar-nueva="${escapeAttr(op.id)}" title="Quitar">×</button>
            </div>`
        )
        .join("")

    const divisas = pinvDivisasOperacion()
    const divisaPorDefecto = normalizeCurrencyCode(activo?.currency || "EUR")

    const formulario = `
        <div class="pinvNuevaForm" data-asset-id="${escapeAttr(entrada.assetId)}">
            <div class="pinvNuevaCampos">
                <label class="pinvNuevaCampo"><span>Orden</span>
                    <select class="assetRowModalSelect" data-campo="orden" data-no-custom>
                        <option value="Compra">Compra</option>
                        <option value="Venta">Venta</option>
                    </select>
                </label>
                <label class="pinvNuevaCampo"><span>Fecha</span>
                    <input class="assetRowModalInput" data-campo="fecha" type="text" value="${escapeAttr(todayDateString())}" placeholder="dd-mm-aaaa">
                </label>
                <label class="pinvNuevaCampo"><span>Precio</span>
                    <input class="assetRowModalInput" data-campo="precio" type="text" inputmode="decimal" placeholder="50.000">
                </label>
                <label class="pinvNuevaCampo"><span>Cantidad</span>
                    <input class="assetRowModalInput" data-campo="cantidad" type="text" inputmode="decimal" placeholder="0,004">
                </label>
                <label class="pinvNuevaCampo"><span>Total</span>
                    <input class="assetRowModalInput" data-campo="total" type="text" inputmode="decimal" placeholder="200">
                </label>
                <label class="pinvNuevaCampo"><span>Divisa</span>
                    <select class="assetRowModalSelect" data-campo="divisa" data-no-custom>
                        ${divisas.map((codigo) => `<option value="${escapeAttr(codigo)}"${codigo === divisaPorDefecto ? " selected" : ""}>${escapeHtml(codigo)}</option>`).join("")}
                    </select>
                </label>
            </div>
            <div class="pinvNuevaAcciones">
                <span class="pinvEditorNota">Precio, cantidad y total: escribe dos y el tercero se calcula.</span>
                <button type="button" class="primaryButton pinvNuevaAddBtn">Añadir operación</button>
            </div>
        </div>`

    return `
        <div class="pinvEditorActivo${abierto ? " pinvEditorActivoAbierto" : ""}" data-asset-id="${escapeAttr(entrada.assetId)}">
            <div class="pinvEditorActivoCab" data-toggle-activo="${escapeAttr(entrada.assetId)}">
                <span class="pinvChevron" aria-hidden="true"></span>
                <span class="pinvEditorActivoNombre">${escapeHtml(activo?.name || entrada.assetId)}</span>
                <span class="pinvEditorActivoResumen">${cuantas} operaci${cuantas !== 1 ? "ones" : "ón"}${total > 0 ? ` · ${pinvEuros(total)}` : ""}</span>
                <button type="button" class="secondaryButton pinvVincularBtn" data-toggle-activo="${escapeAttr(entrada.assetId)}">${abierto ? "Cerrar" : "Vincular operaciones"}</button>
                <button type="button" class="pinvQuitarBtn" data-quitar-activo="${escapeAttr(entrada.assetId)}" title="Quitar del plan">×</button>
            </div>
            ${
                abierto
                    ? `
            <div class="pinvEditorOps">
                <div class="pinvEditorOpsTitulo">Operaciones abiertas con ${escapeHtml(activo?.name || "el activo")}</div>
                ${listaOps}
                ${listaNuevas}
                ${formulario}
            </div>`
                    : ""
            }
        </div>`
}

/**
 * Marca si queda lista por debajo del borde visible.
 *
 * La clase la usa el CSS para desvanecer el borde inferior: sin ella, una ficha
 * cortada a la mitad por el final del contenedor parece un fallo de encuadre en
 * vez de contenido que sigue.
 */
function pinvEditorSombraLista(lista) {
    const queda = lista.scrollHeight - lista.clientHeight - lista.scrollTop > 4
    lista.classList.toggle("pinvEditorListaConMas", queda)
}

function pinvEditorRenderLista() {
    const lista = document.getElementById("pinvEditorLista")
    const selector = document.getElementById("pinvEditorSelector")
    if (!lista || !_pinvEditor) return

    lista.classList.toggle("pinvEditorListaAbierta", Boolean(_pinvEditor.abierto))
    lista.innerHTML = _pinvEditor.activos.length
        ? _pinvEditor.activos.map(pinvEditorFichaActivo).join("")
        : `<p class="overviewEmpty pinvEditorVacio">Elige arriba los activos que van a ir dentro del plan.</p>`

    // La ficha recién abierta, a la vista: con cuatro o cinco activos en el plan
    // su panel de operaciones nacía fuera de la parte visible de la lista.
    pinvEditorSombraLista(lista)

    // `scrollIntoView` se comprueba porque no existe en el DOM de las pruebas.
    const abierta = _pinvEditor.abierto ? lista.querySelector(".pinvEditorActivoAbierto") : null
    if (typeof abierta?.scrollIntoView === "function") {
        abierta.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }

    if (selector) {
        const elegidos = new Set(_pinvEditor.activos.map((activo) => activo.assetId))
        selector.innerHTML =
            `<option value="">Seleccionar activo…</option>` +
            _pinvActivos
                .filter((activo) => !elegidos.has(activo.id))
                .map((activo) => `<option value="${escapeAttr(activo.id)}">${escapeHtml(activo.name)}</option>`)
                .join("")
        selector.value = ""
    }
}

/**
 * Lee el formulario de operación nueva de un activo y la convierte en una fila
 * como las de Operaciones. Se queda en memoria hasta Guardar.
 */
function pinvEditorAnadirNueva(assetId) {
    const entrada = pinvEditorActivo(assetId)
    const form = [...document.querySelectorAll(".pinvNuevaForm")].find((f) => f.dataset.assetId === assetId)
    const activo = pinvActivoPorId(assetId)
    if (!entrada || !form || !activo) return

    const leer = (campo) => form.querySelector(`[data-campo="${campo}"]`)?.value.trim() || ""
    let precio = pinvNumero(leer("precio"))
    let cantidad = pinvNumero(leer("cantidad"))
    let total = pinvNumero(leer("total"))

    if (total === null && precio !== null && cantidad !== null) total = precio * cantidad
    else if (cantidad === null && precio && total !== null) cantidad = total / precio
    else if (precio === null && cantidad && total !== null) precio = total / cantidad

    if (total === null || total <= 0) {
        showToast("Escribe al menos dos de precio, cantidad y total", { type: "warning" })
        return
    }

    const divisa = leer("divisa") || normalizeCurrencyCode(activo.currency)
    const texto = (numero) =>
        numero === null ? "" : numero.toLocaleString("es-ES", { maximumFractionDigits: 8, useGrouping: false })

    entrada.nuevas.push({
        id: pinvNuevoId("operacion"),
        assetId,
        activo: activo.name,
        fechaApertura: leer("fecha"),
        par: `${pinvSimboloBase(activo)}/${divisa}`,
        stablecoinSymbol: "",
        orden: leer("orden") === "Venta" ? "Venta" : "Compra",
        precioOrden: texto(precio),
        precioCurrency: divisa,
        cantidad: texto(cantidad),
        comisionesCripto: "",
        comisionesFiat: "",
        total: texto(total),
        currency: divisa,
        estado: "Activo",
        fechaCierre: ""
    })

    pinvEditorRenderLista()
}

async function pinvEditorGuardar() {
    if (!_pinvEditor) return

    const nombre = document.getElementById("pinvEditorNombre")?.value.trim() || ""
    if (!nombre) {
        showToast("Ponle un nombre al plan", { type: "warning" })
        document.getElementById("pinvEditorNombre")?.focus()
        return
    }

    const boton = document.getElementById("pinvEditorSaveBtn")
    if (boton) boton.disabled = true

    // Primero las operaciones nuevas, que tienen que existir en Operaciones
    // antes de que el plan las referencie: el servidor descarta los
    // identificadores que no encuentra.
    const nuevas = _pinvEditor.activos.flatMap((activo) => activo.nuevas)
    if (!(await pinvGuardarOperacionesNuevas(nuevas))) {
        if (boton) boton.disabled = false
        return
    }

    const plan = {
        id: _pinvEditor.id,
        nombre,
        archivado: false,
        activos: _pinvEditor.activos.map((activo) => ({
            assetId: activo.assetId,
            operaciones: [...activo.operaciones, ...activo.nuevas.map((op) => op.id)]
        }))
    }

    const indice = _pinvPlanes.findIndex((existente) => existente.id === plan.id)
    const anterior = indice >= 0 ? _pinvPlanes[indice] : null
    if (anterior) _pinvPlanes[indice] = { ...plan, archivado: anterior.archivado }
    else _pinvPlanes.push(plan)

    _pinvPlanActual = plan.id
    pinvCerrarEditor()

    await pinvAsegurarTipos()
    pinvRender()
    if (await pinvGuardarPlanes()) {
        showToast(anterior ? "Plan guardado" : "Plan creado", { type: "success" })
    }
}

function pinvAbrirEditor(planId = null) {
    pinvCerrarEditor()

    const existente = planId ? pinvPlanPorId(planId) : null
    _pinvEditor = {
        id: existente?.id || pinvNuevoId("plan"),
        activos: (existente?.activos || []).map((activo) => ({
            assetId: activo.assetId,
            operaciones: [...activo.operaciones],
            nuevas: []
        })),
        abierto: null
    }

    const overlay = document.createElement("div")
    overlay.id = "pinvEditorOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal pinvEditor">
            <h3 class="assetModalTitle assetRowModalTitle">${existente ? "Editar plan de inversión" : "Crear plan de inversión"}</h3>
            <div class="pinvEditorFijo">
                <div class="assetRowModalField">
                    <label class="assetRowModalLabel" for="pinvEditorNombre">Nombre del plan</label>
                    <input id="pinvEditorNombre" class="assetRowModalInput" type="text" value="${escapeAttr(existente?.nombre || "")}" placeholder="Acumular en 2026">
                </div>
                <div class="assetRowModalField">
                    <label class="assetRowModalLabel" for="pinvEditorSelector">Seleccionar activos del plan</label>
                    <select id="pinvEditorSelector" class="assetRowModalSelect"></select>
                </div>
            </div>
            <div class="pinvEditorLista" id="pinvEditorLista" style="--pinv-visibles:${PINV_ACTIVOS_VISIBLES}"></div>
            <div class="assetRowModalFooter">
                <button type="button" id="pinvEditorCancelBtn" class="cancelButton assetRowModalCancelBtn">Cancelar</button>
                <button type="button" id="pinvEditorSaveBtn" data-no-autohide="true" class="primaryButton assetRowModalSaveBtn">${existente ? "Guardar" : "Crear plan"}</button>
            </div>
        </div>`

    overlay.querySelector("#pinvEditorCancelBtn").addEventListener("click", pinvCerrarEditor)
    overlay.querySelector("#pinvEditorSaveBtn").addEventListener("click", pinvEditorGuardar)

    // Clic fuera de la ficha: cerrar. Dentro no, porque el desplegable de los
    // <select> personalizados se pinta en el <body> y su clic burbujea hasta aquí.
    overlay.addEventListener("click", (evento) => {
        if (evento.target === overlay) pinvCerrarEditor()
    })

    overlay.querySelector("#pinvEditorSelector").addEventListener("change", (evento) => {
        const assetId = evento.target.value
        if (!assetId || pinvEditorActivo(assetId)) return
        _pinvEditor.activos.push({ assetId, operaciones: [], nuevas: [] })
        _pinvEditor.abierto = assetId
        pinvEditorRenderLista()
    })

    const lista = overlay.querySelector("#pinvEditorLista")

    lista.addEventListener("click", (evento) => {
        const quitarActivo = evento.target.closest("[data-quitar-activo]")
        if (quitarActivo) {
            const assetId = quitarActivo.dataset.quitarActivo
            _pinvEditor.activos = _pinvEditor.activos.filter((activo) => activo.assetId !== assetId)
            if (_pinvEditor.abierto === assetId) _pinvEditor.abierto = null
            pinvEditorRenderLista()
            return
        }

        const quitarNueva = evento.target.closest("[data-quitar-nueva]")
        if (quitarNueva) {
            const ficha = quitarNueva.closest(".pinvEditorActivo")
            const entrada = pinvEditorActivo(ficha?.dataset.assetId)
            if (entrada) entrada.nuevas = entrada.nuevas.filter((op) => op.id !== quitarNueva.dataset.quitarNueva)
            pinvEditorRenderLista()
            return
        }

        if (evento.target.closest(".pinvNuevaAddBtn")) {
            pinvEditorAnadirNueva(evento.target.closest(".pinvNuevaForm")?.dataset.assetId)
            return
        }

        // El formulario y las casillas viven dentro de la ficha: un clic ahí
        // no debe plegarla.
        if (evento.target.closest(".pinvEditorOps")) return

        const toggle = evento.target.closest("[data-toggle-activo]")
        if (toggle) {
            const assetId = toggle.dataset.toggleActivo
            _pinvEditor.abierto = _pinvEditor.abierto === assetId ? null : assetId
            pinvEditorRenderLista()
        }
    })

    lista.addEventListener("scroll", () => pinvEditorSombraLista(lista))

    lista.addEventListener("change", (evento) => {
        const casilla = evento.target.closest("input[type=checkbox][data-op-id]")
        if (!casilla) return
        const entrada = pinvEditorActivo(casilla.closest(".pinvEditorActivo")?.dataset.assetId)
        if (!entrada) return
        const id = casilla.dataset.opId
        if (casilla.checked && !entrada.operaciones.includes(id)) entrada.operaciones.push(id)
        if (!casilla.checked) entrada.operaciones = entrada.operaciones.filter((otro) => otro !== id)
        // Solo cambia el resumen de la cabecera; se repinta la lista entera
        // para no mantener dos caminos de pintado.
        pinvEditorRenderLista()
    })

    document.body.appendChild(overlay)
    pinvEditorRenderLista()
    overlay.querySelector("#pinvEditorNombre")?.focus()
}

// ── Archivar, desarchivar y eliminar ─────────────────────────────────────────

async function pinvArchivar(planId, archivado) {
    const plan = pinvPlanPorId(planId)
    if (!plan) return
    plan.archivado = archivado
    pinvRender()
    pinvRenderArchivo()
    if (await pinvGuardarPlanes()) {
        showToast(`Plan "${plan.nombre}" ${archivado ? "archivado" : "recuperado"}`)
    }
}

function pinvEliminar(planId) {
    const plan = pinvPlanPorId(planId)
    if (!plan) return

    pinvCerrarArchivo()
    openConfirmModal({
        title: "Eliminar plan",
        message: `Vas a eliminar el plan "${plan.nombre}". Las operaciones vinculadas siguen en Operaciones; solo se borra el plan.`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        requireText: plan.nombre,
        onConfirm: async () => {
            _pinvPlanes = _pinvPlanes.filter((otro) => otro.id !== planId)
            pinvRender()
            await pinvGuardarPlanes()
        }
    })
}

function pinvCerrarArchivo() {
    document.getElementById("pinvArchivoOverlay")?.remove()
}

function pinvFilaArchivo(plan) {
    const calculo = pinvCalcularPlan(plan)
    return `
        <div class="pinvArchivoFila" data-plan-id="${escapeAttr(plan.id)}">
            <div class="pinvArchivoInfo">
                <span class="pinvArchivoNombre">${escapeHtml(plan.nombre || "Plan")}</span>
                <span class="pinvArchivoMeta">${calculo.activos.length} activo${calculo.activos.length !== 1 ? "s" : ""} · ${pinvPorcentaje(calculo.pctRealizado)} realizado · <span class="pinvMoney">${pinvEuros(calculo.planificadoEur)}</span></span>
            </div>
            <div class="pinvArchivoAcciones">
                <button type="button" class="secondaryButton" data-archivo-accion="${plan.archivado ? "desarchivar" : "archivar"}">${plan.archivado ? "Desarchivar" : "Archivar"}</button>
                <button type="button" class="dangerButton" data-archivo-accion="eliminar">Eliminar</button>
            </div>
        </div>`
}

function pinvRenderArchivo() {
    const cuerpo = document.getElementById("pinvArchivoCuerpo")
    if (!cuerpo) return

    const activos = pinvPlanesActivos()
    const archivados = _pinvPlanes.filter((plan) => plan.archivado)

    cuerpo.innerHTML = `
        <div class="pinvArchivoSeccion">
            <div class="pinvArchivoTitulo">Planes activos <span>${activos.length}</span></div>
            ${activos.length ? activos.map(pinvFilaArchivo).join("") : `<p class="pinvEditorNota">Ninguno.</p>`}
        </div>
        <div class="pinvArchivoSeccion">
            <div class="pinvArchivoTitulo">Archivados <span>${archivados.length}</span></div>
            ${archivados.length ? archivados.map(pinvFilaArchivo).join("") : `<p class="pinvEditorNota">Ninguno. Archiva un plan para sacarlo del selector sin borrarlo.</p>`}
        </div>`
}

function pinvAbrirArchivo() {
    pinvCerrarArchivo()

    const overlay = document.createElement("div")
    overlay.id = "pinvArchivoOverlay"
    overlay.className = "modalOverlay assetRowModalOverlay"
    overlay.innerHTML = `
        <div class="assetModal assetRowModal pinvArchivo">
            <h3 class="assetModalTitle assetRowModalTitle">Archivo de planes</h3>
            <div class="assetRowModalFields" id="pinvArchivoCuerpo"></div>
            <div class="assetRowModalFooter">
                <button type="button" id="pinvArchivoCerrarBtn" class="cancelButton assetRowModalCancelBtn">Cerrar</button>
            </div>
        </div>`

    overlay.querySelector("#pinvArchivoCerrarBtn").addEventListener("click", pinvCerrarArchivo)
    overlay.addEventListener("click", (evento) => {
        if (evento.target === overlay) pinvCerrarArchivo()
    })
    overlay.querySelector("#pinvArchivoCuerpo").addEventListener("click", (evento) => {
        const boton = evento.target.closest("[data-archivo-accion]")
        if (!boton) return
        const planId = boton.closest(".pinvArchivoFila")?.dataset.planId
        const accion = boton.dataset.archivoAccion
        if (accion === "archivar") pinvArchivar(planId, true)
        else if (accion === "desarchivar") pinvArchivar(planId, false)
        else if (accion === "eliminar") pinvEliminar(planId)
    })

    document.body.appendChild(overlay)
    pinvRenderArchivo()
}

// ── Página ───────────────────────────────────────────────────────────────────

function pinvEnlazarPagina() {
    // La fila de planes no parte en dos líneas: se desplaza a lo ancho, como el
    // panel de métricas. Si partiera, empujaría hacia abajo los botones de
    // archivar y crear, que tienen que quedarse donde están.
    _pinvActualizarTabs = initScrollLateral(document.getElementById("pinvPlanTabs"), {
        scrollable: "pinvTabsScrollable",
        inicio: "pinvTabsFadeStart",
        fin: "pinvTabsFadeEnd",
        arrastrando: "pinvTabsDragging"
    })

    document.getElementById("pinvCrearBtn")?.addEventListener("click", () => pinvAbrirEditor())
    document.getElementById("pinvArchivoBtn")?.addEventListener("click", pinvAbrirArchivo)

    document.getElementById("pinvPlanTabs")?.addEventListener("click", (evento) => {
        const pestana = evento.target.closest(".pinvPlanTab")
        if (!pestana) return
        _pinvPlanActual = pestana.dataset.planId
        _pinvDesplegados = new Set()
        pinvRender()
    })

    document.getElementById("pinvPlanHeader")?.addEventListener("click", (evento) => {
        const boton = evento.target.closest(".pinvHeaderBtn")
        if (!boton || !_pinvPlanActual) return
        const accion = boton.dataset.accion
        if (accion === "editar") pinvAbrirEditor(_pinvPlanActual)
        else if (accion === "archivar") pinvArchivar(_pinvPlanActual, true)
        else if (accion === "eliminar") pinvEliminar(_pinvPlanActual)
    })

    document.getElementById("pinvBodyRows")?.addEventListener("click", (evento) => {
        const fila = evento.target.closest(".pinvAssetRow")
        if (!fila) return
        const assetId = fila.dataset.assetId
        if (_pinvDesplegados.has(assetId)) _pinvDesplegados.delete(assetId)
        else _pinvDesplegados.add(assetId)
        pinvRenderTabla(pinvCalculoActual())
    })
}

async function initPlanesInversionLogic() {
    _pinvDesplegados = new Set()
    pinvEnlazarPagina()
    await pinvCargarTodo()

    const recordado = typeof getChartPref === "function" ? getChartPref("pinvPlan", null) : null
    _pinvPlanActual = pinvPlanesActivos().some((plan) => plan.id === recordado) ? recordado : null

    pinvRender()
}
