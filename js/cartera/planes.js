// Planes de inversión.
//
// Viven dentro de la ficha de cada activo, como una pestaña más junto a
// "Compras spot" y "Ventas": el activo dice lo que se tiene y el plan lo que se
// piensa hacer con él. Por eso todo plan cuelga de un activo (`assetId`) y por
// eso no comparte almacenamiento con las operaciones (tabla `planes_inversion`,
// vía /api/planes): un plan NO cuenta como operación, no toca el rendimiento, ni
// el FIFO fiscal, ni los snapshots.
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

const PLAN_ESTADO_COLORS = {
    Pendiente: "#f5a524",
    "En curso": "#3b82f6",
    Cumplido: "#2ecc71",
    Cancelado: "#64748b"
}

// Las dos listas se guardan enteras aunque en pantalla solo se vea la parte de
// un activo: el servidor recibe siempre la lista completa, así que perder de
// vista los planes de los demás activos los borraría al guardar.
let _planesRows = []
let _planesCargados = false

// Activo cuya ficha está abierta. Es el que filtra las dos rejillas y el que
// pone el precio con el que se evalúa cada plan.
let _planesAsset = null

let _planesFilterEstado = "all"

// ── Datos ────────────────────────────────────────────────────────────────────

async function planesCargarTodo() {
    const planes = await fetch("/api/planes")
        .then((r) => (r.ok ? r.json() : { rows: [] }))
        .catch(() => ({ rows: [] }))
    _planesRows = Array.isArray(planes.rows) ? planes.rows : []
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

function planesDelActivo() {
    const id = _planesAsset?.id
    return id ? _planesRows.filter((row) => row.assetId === id) : []
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

// ── Render de las rejillas ───────────────────────────────────────────────────

function planesFiltrados() {
    return planesDelActivo().filter((row) => _planesFilterEstado === "all" || row.estado === _planesFilterEstado)
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

    const nombre = row.nombre || row.symbol || planId

    planCerrarModal()
    openConfirmModal({
        title: "Eliminar plan",
        message: `Vas a eliminar el plan "${nombre}". Esto no se puede deshacer.`,
        confirmLabel: "Eliminar",
        confirmSide: "right",
        requireText: nombre,
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

/**
 * Clic en una tarjeta de plan.
 *
 * `alPulsar` es lo que hace pulsar la tarjeta por fuera de sus botones: abre el
 * gráfico, que es lo que interesa en un plan de inversión, porque lo que se mira
 * ahí es a qué precio va.
 */
function planesManejarClickTarjeta(
    evento,
    { rows, atributo, editar, eliminar, duplicar, extra, alPulsar = planAbrirGrafico }
) {
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
    if (row) alPulsar(row)
}

// ── Pestañas dentro de la ficha del activo ───────────────────────────────────

function planFiltrosHtml(id, estados) {
    const botones = [{ valor: "all", texto: "Todos" }, ...estados]
        .map(
            ({ valor, texto }) =>
                `<button type="button" class="planFilterBtn${valor === "all" ? " active" : ""}" data-estado="${escapeAttr(valor)}">${escapeHtml(texto)}</button>`
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
        const boton = evento.target.closest(".planFilterBtn")
        if (!boton) return
        seccion.querySelectorAll(".planFilterBtn").forEach((otro) => {
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
 * La lista se pide una sola vez por sesión. Solo se toca desde aquí, así que
 * volver a pedirla al abrir cada activo sería una petición por ficha para
 * recibir exactamente lo que ya está en memoria.
 */
async function initAssetPlanesLogic(asset) {
    _planesAsset = asset || null
    _planesFilterEstado = "all"

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

    if (!planes) return

    if (!_planesCargados) await planesCargarTodo()

    planesRender()
}
