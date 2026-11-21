// ===== HERRAMIENTAS › EQUIVALENCIAS =====
// Lista de divisas y activos (acciones, ETF, cripto, metales...) en la que se
// escribe la cantidad de uno y se ve cuánto equivale de todos los demás, con el
// rendimiento de cada uno en el periodo elegido.
//
// Trozo de js/analisis/herramientas.js: comparte el ámbito global con el resto
// de herramientas-*.js. Del comparador de divisas reutiliza el formato
// (hFxNumero, hFxPorcentaje...), las etiquetas de fecha y los periodos; de
// Capitalización, el buscador de tickers (hCapBuscar). Los nombres propios
// llevan el prefijo hEq.
//
// El servidor (/api/herramientas/equivalencias) devuelve cada serie ya pasada a
// la moneda de referencia, que es la moneda base de Ajustes: aquí solo se
// divide. La lista se guarda en este navegador (localStorage), como el par del
// comparador de divisas.

const H_EQ_STORAGE_KEY = "hEqLista"
// El mismo tope que el servidor (MAX_ELEMENTOS en stores/equivalencias.py).
const H_EQ_MAX_ELEMENTOS = 25
// La forma de ticker que acepta el servidor (series_tradingview._SIMBOLO_RE).
const H_EQ_TICKER_VALIDO = /^(?:[A-Z0-9_]{1,30}:)?[A-Z0-9_.!&/-]{1,40}$/
// Respaldo para cuando shared-utils.js no está cargado (las pruebas).
const H_EQ_COLORES =
    typeof DISTRIBUCION_COLORES !== "undefined"
        ? DISTRIBUCION_COLORES
        : ["#60a5fa", "#34d399", "#fbbf24", "#f87171", "#c084fc", "#22d3ee", "#fb923c", "#a3e635", "#f472b6", "#94a3b8"]

// Listas a la vez: cada una es una pestaña con su propio nombre y elementos.
const H_EQ_MAX_LISTAS = 20
const H_EQ_MAX_NOMBRE = 40

// [{id, nombre, items, ancla, seleccion}]; la activa se trabaja en las tres
// variables de abajo y se vuelca aquí al guardar (hEqVolcarListaActiva).
let _hEqListas = []
let _hEqListaActiva = null
// La lista activa: [{tipo: "divisa"|"activo", id, nombre}]
let _hEqLista = []
// La fila en la que el usuario escribió la cantidad; las demás se derivan de ella.
let _hEqAncla = null
let _hEqSeleccion = null
let _hEqRango = "1M"
// {referencia, rango, elementos: Map(id → elemento de la respuesta)}
let _hEqDatos = null
let _hEqChart = null
let _hEqToken = 0
let _hEqListo = false
// Tarjeta abierta en grande ("tabla", "grafico") o null.
let _hEqVentana = null
const H_EQ_VENTANAS = {
    tabla: { tarjeta: "hEqTablaCard", boton: "hEqAmpliarTablaBtn" },
    grafico: { tarjeta: "hEqGraficoCard", boton: "hEqAmpliarGraficoBtn" }
}

// ── Cálculo (sin DOM) ────────────────────────────────────────────────────

/**
 * Cantidad de cada elemento equivalente a la cantidad del ancla.
 *
 * @param {Map<string, number>} precios Precio de una unidad de cada elemento
 *     en la moneda de referencia. Los que no tienen precio no están.
 * @param {{id: string, cantidad: number} | null} ancla
 * @returns {Map<string, number|null>} null donde no se puede calcular.
 */
function hEqCantidades(precios, ancla) {
    const resultado = new Map()
    const precioAncla = ancla ? precios.get(ancla.id) : undefined
    const valor = precioAncla > 0 && Number.isFinite(ancla.cantidad) ? ancla.cantidad * precioAncla : null
    precios.forEach((precio, id) => {
        resultado.set(id, valor !== null && precio > 0 ? valor / precio : null)
    })
    // El ancla conserva lo que escribió el usuario aunque no tenga precio.
    if (ancla) resultado.set(ancla.id, ancla.cantidad)
    return resultado
}

/**
 * Une varias series en un eje de tiempos común, con el último valor conocido.
 *
 * Una cripto cotiza el fin de semana y una acción no: sin un eje común, el
 * tooltip del gráfico mezclaría puntos de instantes distintos. Antes del
 * primer punto de una serie no hay valor (null), en vez de inventar uno.
 *
 * @param {Array<Array<{ts: number, close: number}>>} series En orden cronológico.
 * @returns {{tiempos: number[], valores: Array<Array<number|null>>}}
 */
function hEqAlinear(series) {
    const tiempos = [...new Set(series.flatMap((s) => s.map((p) => p.ts)))].sort((a, b) => a - b)
    const valores = series.map((serie) => {
        let i = -1
        return tiempos.map((ts) => {
            while (i + 1 < serie.length && serie[i + 1].ts <= ts) i++
            return i >= 0 ? serie[i].close : null
        })
    })
    return { tiempos, valores }
}

/**
 * Rendimiento en % de cada valor respecto al primero que no es null.
 *
 * @param {Array<number|null>} valores
 * @returns {Array<number|null>}
 */
function hEqRendimiento(valores) {
    const base = valores.find((v) => v !== null && v > 0)
    return valores.map((v) => (v === null || !base ? null : (v / base - 1) * 100))
}

// Cantidades: tantos decimales como hagan falta para que se lean las cifras
// que importan, 0,00019 BTC igual que 10.971,25 USD.
function hEqFormatoCantidad(valor) {
    if (!Number.isFinite(valor)) return ""
    const enteras = Math.max(1, Math.floor(Math.log10(Math.abs(valor) || 1)) + 1)
    return new Intl.NumberFormat(hFxLocale(), {
        maximumSignificantDigits: Math.min(21, Math.max(6, enteras + 2)),
        useGrouping: true
    }).format(valor)
}

function hEqLeerCantidad(texto) {
    const limpio = String(texto ?? "").trim()
    if (!limpio) return null
    const valor = parseEuroNumber(limpio)
    return Number.isFinite(valor) && valor >= 0 ? valor : null
}

function hEqVariacionRango(elemento) {
    const puntos = elemento?.puntos
    if (!puntos || puntos.length < 2 || !(puntos[0].close > 0)) return null
    return (puntos.at(-1).close / puntos[0].close - 1) * 100
}

function hEqVariacionPeriodo(elemento, periodo) {
    const ref = elemento?.referencias?.find((r) => r.rango === periodo)
    return ref && ref.close > 0 ? (elemento.actual.close / ref.close - 1) * 100 : null
}

// ── Estado y almacenamiento ──────────────────────────────────────────────

function hEqIniciar() {
    // La página se vuelve a montar al abrirla: lo de la visita anterior era de
    // un DOM que ya no existe.
    try {
        _hEqChart?.destroy()
    } catch {
        /* el canvas ya no está */
    }
    _hEqChart = null
    _hEqDatos = null
    _hEqListo = false
    _hEqVentana = null
    _hEqToken++

    if (!document.getElementById("toolEquivalencias")) return

    document.getElementById("hEqBuscarBtn")?.addEventListener("click", hEqBuscar)
    document.getElementById("hEqBuscarInput")?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return
        e.preventDefault()
        hEqBuscar()
    })
    document.getElementById("hEqDivisaBtn")?.addEventListener("click", hEqAnadirDivisa)
    document.getElementById("hEqCarteraBtn")?.addEventListener("click", hEqAnadirDeCartera)
    document.getElementById("hEqCarteraTodoBtn")?.addEventListener("click", hEqAnadirToda)
    document.getElementById("hEqVaciarBtn")?.addEventListener("click", hEqVaciar)
    document.getElementById("hEqListaActualBtn")?.addEventListener("click", () => {
        const menu = document.getElementById("hEqListasMenu")
        hEqMenuListas(Boolean(menu?.classList.contains("hidden")))
    })
    document.getElementById("hEqListaNuevaBtn")?.addEventListener("click", hEqNuevaLista)
    document.getElementById("hEqListaRenombrarBtn")?.addEventListener("click", hEqEditarNombre)
    document.getElementById("hEqListaBorrarBtn")?.addEventListener("click", () => hEqBorrarLista(_hEqListaActiva))
    document.getElementById("hEqListas")?.addEventListener("click", (e) => {
        const opcion = e.target.closest("[data-lista]")
        if (!opcion) return
        hEqMenuListas(false)
        hEqCambiarLista(opcion.dataset.lista)
    })
    Object.entries(H_EQ_VENTANAS).forEach(([clave, { boton }]) => {
        document
            .getElementById(boton)
            ?.addEventListener("click", () => hEqVentana(_hEqVentana === clave ? null : clave))
    })
    document.getElementById("hEqFondo")?.addEventListener("click", () => hEqVentana(null))
    document.getElementById("hEqPestanas")?.addEventListener("click", (e) => {
        const pestana = e.target.closest("[data-origen]")
        if (pestana) hEqElegirOrigen(pestana.dataset.origen)
    })
    hEqRegistrarCierres()
    const caja = document.getElementById("hEqTablaWrap")
    caja?.addEventListener("scroll", hEqActualizarSombras, { passive: true })
    // Arrastrar la tabla con el ratón, como las tiras de pestañas de la app. Al
    // empezar en un campo de cantidad no arrastra, y al soltar tras moverla no
    // llega el clic que seleccionaría la fila.
    if (caja && typeof activarArrastreHorizontal === "function") activarArrastreHorizontal(caja)
    // Al cambiar el ancho (ventana, cajón lateral) cambia si sobra tabla.
    if (caja && typeof ResizeObserver === "function") new ResizeObserver(hEqActualizarSombras).observe(caja)
    document.getElementById("hEqRangos")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rango]")
        if (btn) hEqElegirRango(btn.dataset.rango)
    })
    document.getElementById("hEqVariaciones")?.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-rango]")
        if (btn) hEqElegirRango(btn.dataset.rango)
    })

    const cuerpo = document.getElementById("hEqCuerpo")
    cuerpo?.addEventListener("input", (e) => {
        if (e.target.classList.contains("hEqCantidad")) hEqAlEscribir(e.target)
    })
    cuerpo?.addEventListener("click", (e) => {
        const quitar = e.target.closest(".hEqQuitar")
        if (quitar) {
            hEqQuitar(quitar.dataset.id)
            return
        }
        if (e.target.closest("input")) return
        const fila = e.target.closest("tr[data-id]")
        if (fila) hEqSeleccionar(fila.dataset.id)
    })
}

// La lista de divisas y las series salen de servicios externos: se piden al
// abrir la herramienta, no al cargar la página.
async function hEqAlAbrir() {
    if (_hEqListo) {
        _hEqChart?.resize()
        return
    }
    _hEqListo = true
    hEqLeerGuardado()
    hEqRenderListas()
    hEqRenderTabla()
    hEqCargarDivisas()
    hEqCargarCartera()
    hEqCargar()
}

function hEqReferencia() {
    return String(window._monedaBase || "EUR").toUpperCase()
}

// ── Listas guardadas (sin DOM) ───────────────────────────────────────────

/**
 * Una lista leída del almacenamiento, con lo que no valga descartado.
 *
 * @param {object} lista Tal como estaba guardada (o lo que haya: viene de
 *     localStorage y pudo editarse a mano).
 * @param {number} indice Posición, para el nombre y el id por defecto.
 * @returns {{id: string, nombre: string, items: object[], ancla: object|null, seleccion: string|null}}
 */
function hEqNormalizarLista(lista, indice) {
    const items = (Array.isArray(lista?.items) ? lista.items : [])
        .filter((i) => i && (i.tipo === "divisa" || i.tipo === "activo") && typeof i.id === "string" && i.id)
        .slice(0, H_EQ_MAX_ELEMENTOS)
    const ids = new Set(items.map((i) => i.id))
    const cantidad = Number(lista?.ancla?.cantidad)
    return {
        id: typeof lista?.id === "string" && lista.id ? lista.id : `lista${indice + 1}`,
        nombre:
            String(lista?.nombre || "")
                .trim()
                .slice(0, H_EQ_MAX_NOMBRE) || `Lista ${indice + 1}`,
        items,
        ancla:
            ids.has(lista?.ancla?.id) && Number.isFinite(cantidad)
                ? { id: lista.ancla.id, cantidad }
                : items[0]
                  ? { id: items[0].id, cantidad: 100 }
                  : null,
        seleccion: ids.has(lista?.seleccion) ? lista.seleccion : items[0]?.id || null
    }
}

/**
 * Estado guardado listo para usar, venga del formato que venga.
 *
 * Antes había una sola lista (`{items, ancla, seleccion, rango}`): se
 * convierte en «Mi lista» para que nadie pierda la suya al actualizar.
 *
 * @param {object|null} guardado Lo leído de localStorage.
 * @param {string} referencia Moneda base, para la lista de la primera vez.
 * @returns {{listas: object[], activa: string, rango: string}}
 */
function hEqNormalizarGuardado(guardado, referencia) {
    let crudas = []
    if (Array.isArray(guardado?.listas)) crudas = guardado.listas.slice(0, H_EQ_MAX_LISTAS)
    else if (Array.isArray(guardado?.items)) crudas = [{ ...guardado, id: "lista1", nombre: "Mi lista" }]

    const vistos = new Set()
    const listas = crudas.map((cruda, indice) => {
        const lista = hEqNormalizarLista(cruda, indice)
        // Dos con el mismo id harían que borrar una se llevara las dos.
        while (vistos.has(lista.id)) lista.id += "_"
        vistos.add(lista.id)
        return lista
    })
    // La primera vez, la moneda base: es la que se tiene en la cabeza al
    // preguntar «cuánto es esto».
    if (!listas.length) {
        listas.push(
            hEqNormalizarLista(
                { nombre: "Mi lista", items: [{ tipo: "divisa", id: referencia, nombre: referencia }] },
                0
            )
        )
    }
    return {
        listas,
        activa: listas.some((l) => l.id === guardado?.activa) ? guardado.activa : listas[0].id,
        rango: H_FX_PERIODOS[guardado?.rango] || guardado?.rango === "5A" ? guardado.rango : "1M"
    }
}

/** Primer «Lista N» que no esté ya usado. */
function hEqNombreLibre(listas) {
    const usados = new Set(listas.map((l) => l.nombre.toLowerCase()))
    let n = listas.length + 1
    while (usados.has(`lista ${n}`)) n++
    return `Lista ${n}`
}

// ── Estado y almacenamiento ──────────────────────────────────────────────

function hEqLeerGuardado() {
    let guardado
    try {
        guardado = JSON.parse(localStorage.getItem(H_EQ_STORAGE_KEY))
    } catch {
        // Corrupto o sin almacenamiento: se empieza como la primera vez.
        guardado = null
    }
    const estado = hEqNormalizarGuardado(guardado, hEqReferencia())
    _hEqListas = estado.listas
    _hEqRango = estado.rango
    hEqCargarListaActiva(estado.activa)
    document.querySelectorAll("#hEqRangos [data-rango]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.rango === _hEqRango)
    })
}

function hEqListaActiva() {
    return _hEqListas.find((l) => l.id === _hEqListaActiva) || null
}

// _hEqLista, _hEqAncla y _hEqSeleccion son la lista activa en uso; esto los
// devuelve a su objeto antes de guardar o de cambiar de lista.
function hEqVolcarListaActiva() {
    const lista = hEqListaActiva()
    if (!lista) return
    lista.items = _hEqLista
    lista.ancla = _hEqAncla
    lista.seleccion = _hEqSeleccion
}

function hEqCargarListaActiva(id) {
    _hEqListaActiva = id
    const lista = hEqListaActiva()
    _hEqLista = lista ? [...lista.items] : []
    _hEqAncla = lista?.ancla ? { ...lista.ancla } : null
    _hEqSeleccion = lista?.seleccion || null
}

// ── Varias listas ────────────────────────────────────────────────────────

function hEqCambiarLista(id) {
    if (id === _hEqListaActiva || !_hEqListas.some((l) => l.id === id)) return
    hEqVolcarListaActiva()
    hEqCargarListaActiva(id)
    _hEqDatos = null
    hEqCerrarResultados()
    hEqMensaje("")
    hEqGuardar()
    hEqRenderListas()
    hEqCargar()
}

function hEqNuevaLista() {
    if (_hEqListas.length >= H_EQ_MAX_LISTAS) {
        hEqMensaje(`Como mucho ${H_EQ_MAX_LISTAS} listas.`, true)
        return
    }
    hEqVolcarListaActiva()
    const lista = {
        id: `lista${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        nombre: hEqNombreLibre(_hEqListas),
        items: [],
        ancla: null,
        seleccion: null
    }
    _hEqListas.push(lista)
    hEqMenuListas(false)
    hEqCambiarLista(lista.id)
    // Lo normal es querer llamarla de otra forma nada más crearla.
    hEqEditarNombre()
}

/** Cambia el botón del desplegable por un campo para renombrar la lista activa. */
function hEqEditarNombre() {
    const lista = hEqListaActiva()
    const boton = document.getElementById("hEqListaActualBtn")
    if (!lista || !boton || !boton.isConnected) return
    hEqMenuListas(false)

    const campo = document.createElement("input")
    campo.type = "text"
    campo.className = "hEqListaNombreInput"
    campo.maxLength = H_EQ_MAX_NOMBRE
    campo.value = lista.nombre
    campo.setAttribute("aria-label", "Nombre de la lista")
    let hecho = false
    const terminar = (guardar) => {
        if (hecho) return
        hecho = true
        const nombre = campo.value.trim().slice(0, H_EQ_MAX_NOMBRE)
        if (guardar && nombre) {
            lista.nombre = nombre
            hEqGuardar()
        }
        campo.replaceWith(boton)
        hEqRenderListas()
    }
    campo.addEventListener("keydown", (e) => {
        if (e.key === "Enter") terminar(true)
        if (e.key === "Escape") {
            // Que no cierre además la vista ampliada.
            e.preventDefault()
            terminar(false)
        }
    })
    campo.addEventListener("blur", () => terminar(true))
    boton.replaceWith(campo)
    campo.focus()
    campo.select()
}

function hEqBorrarLista(id) {
    const lista = _hEqListas.find((l) => l.id === id)
    if (!lista) return
    if (_hEqListas.length === 1) {
        hEqMensaje("Es la única lista: vacíala en vez de borrarla.", true)
        return
    }
    const borrar = () => {
        const indice = _hEqListas.indexOf(lista)
        _hEqListas = _hEqListas.filter((l) => l !== lista)
        if (_hEqListaActiva === id) {
            // La siguiente en el menú (o la anterior si era la última).
            hEqCargarListaActiva(_hEqListas[Math.min(indice, _hEqListas.length - 1)].id)
            _hEqDatos = null
            hEqCargar()
        }
        hEqGuardar()
        hEqRenderListas()
    }
    const mensaje = `Se borrará «${lista.nombre}» con sus ${lista.id === _hEqListaActiva ? _hEqLista.length : lista.items.length} elementos. No se puede deshacer.`
    if (typeof openConfirmModal === "function" && document.getElementById("confirmModalOverlay")) {
        openConfirmModal({ title: "Borrar lista", message: mensaje, confirmLabel: "Borrar", onConfirm: borrar })
    } else if (window.confirm(mensaje)) {
        borrar()
    }
}

// El botón dice cuál es la activa; el menú, todas. Renombrar y borrar van
// fuera del menú, junto al botón, y actúan sobre la activa.
function hEqRenderListas() {
    const activa = hEqListaActiva()
    const nombreActual = document.getElementById("hEqListaActualNombre")
    if (nombreActual) nombreActual.textContent = activa?.nombre || ""
    const cuentaActual = document.getElementById("hEqListaActualCuenta")
    if (cuentaActual) cuentaActual.textContent = String(_hEqLista.length)
    const borrar = document.getElementById("hEqListaBorrarBtn")
    if (borrar) {
        borrar.disabled = _hEqListas.length <= 1
        borrar.title = borrar.disabled ? "Es la única lista: vacíala en vez de borrarla" : "Borrar esta lista"
    }
    const nueva = document.getElementById("hEqListaNuevaBtn")
    if (nueva) nueva.disabled = _hEqListas.length >= H_EQ_MAX_LISTAS

    const menu = document.getElementById("hEqListas")
    if (!menu) return
    menu.replaceChildren(
        ..._hEqListas.map((lista) => {
            const esActiva = lista.id === _hEqListaActiva
            const opcion = document.createElement("button")
            opcion.type = "button"
            opcion.className = `hEqListaOpcion${esActiva ? " active" : ""}`
            opcion.dataset.lista = lista.id
            opcion.setAttribute("role", "option")
            opcion.setAttribute("aria-selected", String(esActiva))
            const nombre = document.createElement("span")
            nombre.className = "hEqListaNombre"
            nombre.textContent = lista.nombre
            const cuenta = document.createElement("span")
            cuenta.className = "hEqListaCuenta"
            cuenta.textContent = String(esActiva ? _hEqLista.length : lista.items.length)
            opcion.append(nombre, cuenta)
            return opcion
        })
    )
}

/** @returns {boolean} Si el menú estaba abierto. */
function hEqMenuListas(abrir) {
    const menu = document.getElementById("hEqListasMenu")
    const boton = document.getElementById("hEqListaActualBtn")
    if (!menu || !boton) return false
    const estaba = !menu.classList.contains("hidden")
    menu.classList.toggle("hidden", !abrir)
    boton.setAttribute("aria-expanded", String(abrir))
    if (abrir) menu.querySelector(".hEqListaOpcion.active")?.scrollIntoView({ block: "nearest" })
    return estaba
}

/**
 * Abre la tarjeta de la tabla o la del gráfico a casi toda la ventana, o la cierra.
 *
 * Se amplía la misma tarjeta en vez de copiarla a un modal, como el gráfico de
 * la ficha de un activo: las cantidades, el arrastre, los periodos y la
 * selección siguen funcionando igual, y no hay dos tablas que mantener.
 *
 * @param {"tabla"|"grafico"|null} cual La que se abre; null cierra la abierta.
 */
function hEqVentana(cual) {
    _hEqVentana = cual
    Object.entries(H_EQ_VENTANAS).forEach(([clave, { tarjeta, boton }]) => {
        const abierta = clave === cual
        document.getElementById(tarjeta)?.classList.toggle("hEqVentana", abierta)
        const nodo = document.getElementById(boton)
        if (!nodo) return
        nodo.setAttribute("aria-pressed", String(abierta))
        nodo.title = abierta ? "Cerrar la vista ampliada (Esc)" : "Ver en grande"
        const texto = nodo.querySelector(".hEqAmpliarTexto")
        if (texto) texto.textContent = abierta ? "Reducir" : "Ampliar"
    })
    document.getElementById("hEqFondo")?.classList.toggle("hidden", !cual)
    // Chart.js observa su contenedor, pero el cambio de posición no siempre
    // dispara su ResizeObserver a tiempo.
    _hEqChart?.resize()
    hEqActualizarSombras()
}

function hEqGuardar() {
    hEqVolcarListaActiva()
    try {
        localStorage.setItem(
            H_EQ_STORAGE_KEY,
            JSON.stringify({ listas: _hEqListas, activa: _hEqListaActiva, rango: _hEqRango })
        )
    } catch {
        /* sin almacenamiento: la próxima visita empieza con la lista por defecto */
    }
}

async function hEqCargarDivisas() {
    const select = document.getElementById("hEqDivisa")
    if (!select) return
    try {
        const datos = await Api.get("/api/divisas")
        const divisas = Array.isArray(datos?.divisas) ? datos.divisas : []
        select.innerHTML = ""
        divisas.forEach(({ code, name }) => {
            const opcion = document.createElement("option")
            opcion.value = code
            opcion.textContent = name && name !== code ? `${code} · ${name}` : code
            opcion.dataset.nombre = name || code
            select.appendChild(opcion)
        })
        // Repinta el desplegable personalizado de la app.
        select.dispatchEvent(new Event("change"))
    } catch (error) {
        hEqMensaje(error?.message || "No se pudo cargar la lista de divisas.", true)
    }
}

// ── Lista ────────────────────────────────────────────────────────────────

/**
 * Añade a la lista los que aún no están, hasta el tope, y pide las series una vez.
 *
 * @param {Array<{tipo: string, id: string, nombre: string}>} items
 * @returns {{anadidos: number, repetidos: number, fuera: number}} Cuántos
 *     entraron, cuántos ya estaban y cuántos no cupieron.
 */
function hEqAnadirVarios(items) {
    const recuento = { anadidos: 0, repetidos: 0, fuera: 0 }
    items.forEach((item) => {
        if (_hEqLista.some((i) => i.id === item.id)) recuento.repetidos++
        else if (_hEqLista.length >= H_EQ_MAX_ELEMENTOS) recuento.fuera++
        else {
            _hEqLista.push(item)
            _hEqSeleccion = item.id
            recuento.anadidos++
        }
    })
    if (recuento.anadidos) {
        // Tras vaciar la lista no hay fila de la que derivar las demás.
        if (!_hEqAncla && _hEqLista.length) _hEqAncla = { id: _hEqLista[0].id, cantidad: 1 }
        hEqGuardar()
        hEqRenderTabla()
        hEqCargar()
    }
    return recuento
}

function hEqAnadir(item) {
    const { anadidos, repetidos } = hEqAnadirVarios([item])
    if (anadidos) hEqMensaje("")
    else if (repetidos) hEqMensaje(`${item.nombre || item.id} ya está en la lista.`, true)
    else hEqMensaje(`Como mucho ${H_EQ_MAX_ELEMENTOS} en la lista.`, true)
}

function hEqVaciar() {
    if (!_hEqLista.length) return
    _hEqLista = []
    _hEqAncla = null
    _hEqSeleccion = null
    _hEqDatos = null
    _hEqToken++
    hEqMensaje("")
    hEqGuardar()
    hEqCargar()
}

function hEqElegirOrigen(origen) {
    document.querySelectorAll("#hEqPestanas [data-origen]").forEach((btn) => {
        const activa = btn.dataset.origen === origen
        btn.classList.toggle("active", activa)
        btn.setAttribute("aria-selected", String(activa))
    })
    document.querySelectorAll("#toolEquivalencias .hEqOrigen").forEach((pane) => {
        pane.classList.toggle("hidden", pane.dataset.origen !== origen)
    })
    hEqMensaje("")
    if (origen === "buscar") document.getElementById("hEqBuscarInput")?.focus()
}

/** @returns {boolean} Si había resultados abiertos que cerrar. */
function hEqCerrarResultados() {
    const lista = document.getElementById("hEqResultados")
    if (!lista || lista.classList.contains("hidden")) return false
    lista.classList.add("hidden")
    lista.replaceChildren()
    return true
}

let _hEqCierresRegistrados = false

// Los desplegables (resultados de búsqueda y menú de listas) se cierran al
// pulsar fuera de ellos; Escape cierra primero esos y, si no hay ninguno, la
// vista ampliada. En el documento y no en el panel: un clic en la cabecera de
// la app o el foco fuera del panel también cuentan. Una sola vez, porque la
// página se vuelve a montar en cada visita.
function hEqRegistrarCierres() {
    if (_hEqCierresRegistrados) return
    _hEqCierresRegistrados = true
    document.addEventListener("click", (e) => {
        if (!document.getElementById("toolEquivalencias")) return
        if (!e.target.closest?.(".hEqBuscarCaja")) hEqCerrarResultados()
        if (!e.target.closest?.(".hEqListaSelector")) hEqMenuListas(false)
    })
    document.addEventListener("keydown", (e) => {
        if (e.key !== "Escape" || e.defaultPrevented || !document.getElementById("toolEquivalencias")) return
        if (hEqCerrarResultados() || hEqMenuListas(false)) return
        if (_hEqVentana) hEqVentana(null)
    })
}

// ── Activos de la cartera ────────────────────────────────────────────────
// El ticker sale de buildTVSymbol, el mismo con el que se abre el gráfico de
// cada activo y con el que «Ratio entre dos activos» trae los de la cartera:
// aquí no se adivina ninguno.

/**
 * Elemento de la lista para un activo de la cartera, o null si no tiene un
 * ticker de TradingView con forma válida.
 *
 * @param {{name?: string, symbol?: string}} activo Un activo de /api/activos.
 * @param {(activo: object) => string} resolver El que da su ticker.
 * @returns {{tipo: "activo", id: string, nombre: string} | null}
 */
function hEqItemDeActivo(activo, resolver) {
    // Sin ningún identificador de mercado, buildTVSymbol devuelve el nombre en
    // mayúsculas («Piso» → PISO): eso no es un ticker, es una suposición.
    const identificado = ["tvSymbol", "marketSymbol", "finnhubSymbol", "symbol"].some((campo) =>
        String(activo?.[campo] || "").trim()
    )
    if (!identificado) return null
    let ticker
    try {
        ticker = String(resolver(activo) || "")
            .trim()
            .toUpperCase()
    } catch {
        // Un activo con datos raros no debe dejar sin lista a los demás.
        return null
    }
    if (!H_EQ_TICKER_VALIDO.test(ticker)) return null
    return { tipo: "activo", id: ticker, nombre: activo.name || activo.symbol || ticker }
}

function hEqResolverTicker(activo) {
    return typeof buildTVSymbol === "function" ? buildTVSymbol(activo) : activo.tvSymbol
}

async function hEqActivosCartera() {
    const activos = await hActivos()
    return activos
        .filter((a) => !a.hidden)
        .map((a) => ({ activo: a, item: hEqItemDeActivo(a, hEqResolverTicker) }))
        .sort((x, y) => (x.activo.name || "").localeCompare(y.activo.name || "", "es"))
}

async function hEqCargarCartera() {
    const select = document.getElementById("hEqCartera")
    if (!select) return
    let activos
    try {
        activos = await hEqActivosCartera()
    } catch (error) {
        console.error(error)
        hEqMensaje("No se pudieron cargar los activos de tu cartera.", true)
        return
    }

    select.innerHTML = ""
    activos.forEach(({ activo, item }) => {
        const opcion = document.createElement("option")
        opcion.value = item ? item.id : ""
        opcion.disabled = !item
        opcion.textContent = `${activo.name || activo.symbol}${item ? ` · ${item.id}` : " · sin ticker"}`
        if (item) opcion.dataset.nombre = item.nombre
        select.appendChild(opcion)
    })
    if (!activos.length) {
        const opcion = document.createElement("option")
        opcion.value = ""
        opcion.textContent = "Tu cartera no tiene activos"
        select.appendChild(opcion)
    }
    const primero = activos.find(({ item }) => item && !_hEqLista.some((i) => i.id === item.id))
    if (primero) select.value = primero.item.id
    select.dispatchEvent(new Event("change"))
    document.getElementById("hEqCarteraTodoBtn")?.classList.toggle("hidden", !activos.some(({ item }) => item))
}

function hEqAnadirDeCartera() {
    const opcion = document.getElementById("hEqCartera")?.selectedOptions?.[0]
    if (!opcion?.value) return
    hEqAnadir({ tipo: "activo", id: opcion.value, nombre: opcion.dataset.nombre || opcion.value })
}

async function hEqAnadirToda() {
    let activos
    try {
        activos = await hEqActivosCartera()
    } catch (error) {
        console.error(error)
        hEqMensaje("No se pudieron cargar los activos de tu cartera.", true)
        return
    }
    const sinTicker = activos.filter(({ item }) => !item).length
    // Dos activos pueden compartir ticker (el mismo ETF en dos brókeres).
    const items = [...new Map(activos.filter(({ item }) => item).map(({ item }) => [item.id, item])).values()]
    const { anadidos, fuera } = hEqAnadirVarios(items)

    const partes = [anadidos ? `${anadidos} añadido${anadidos === 1 ? "" : "s"}` : "Ya estaban todos en la lista"]
    if (fuera) partes.push(`${fuera} no caben (máximo ${H_EQ_MAX_ELEMENTOS})`)
    if (sinTicker) partes.push(`${sinTicker} sin ticker de TradingView`)
    hEqMensaje(partes.join(" · ") + ".", Boolean(fuera || sinTicker || !anadidos))
}

function hEqAnadirDivisa() {
    const select = document.getElementById("hEqDivisa")
    const opcion = select?.selectedOptions?.[0]
    if (!opcion?.value) return
    hEqAnadir({ tipo: "divisa", id: opcion.value, nombre: opcion.dataset.nombre || opcion.value })
}

function hEqBuscar() {
    hCapBuscar("hEqBuscarInput", "hEqResultados", (resultado) => {
        document.getElementById("hEqBuscarInput").value = ""
        hEqAnadir({
            tipo: "activo",
            id: String(resultado.symbol || "").toUpperCase(),
            nombre: resultado.description || resultado.symbol
        })
    })
}

function hEqQuitar(id) {
    _hEqLista = _hEqLista.filter((i) => i.id !== id)
    _hEqDatos?.elementos.delete(id)
    if (_hEqAncla?.id === id) {
        // La cantidad que había pasa a la siguiente fila con precio, para que
        // el resto de la tabla no se quede en blanco.
        const cantidades = hEqCantidadesActuales()
        const siguiente = _hEqLista.find((i) => Number.isFinite(cantidades.get(i.id)))
        _hEqAncla = siguiente
            ? { id: siguiente.id, cantidad: cantidades.get(siguiente.id) }
            : _hEqLista[0]
              ? { id: _hEqLista[0].id, cantidad: 1 }
              : null
    }
    if (_hEqSeleccion === id) _hEqSeleccion = _hEqLista[0]?.id || null
    hEqGuardar()
    hEqRender()
}

function hEqSeleccionar(id) {
    if (id === _hEqSeleccion) return
    _hEqSeleccion = id
    hEqGuardar()
    document.querySelectorAll("#hEqCuerpo tr[data-id]").forEach((fila) => {
        fila.classList.toggle("active", fila.dataset.id === id)
    })
    hEqRenderGrafico()
    hEqRenderStats()
    hEqRenderVariaciones()
}

function hEqAlEscribir(input) {
    const cantidad = hEqLeerCantidad(input.value)
    if (cantidad === null) return
    _hEqAncla = { id: input.dataset.id, cantidad }
    hEqGuardar()
    hEqRenderCantidades(input.dataset.id)
    hEqRenderVariaciones()
}

// ── Datos ────────────────────────────────────────────────────────────────

async function hEqCargar() {
    if (!_hEqLista.length) {
        _hEqDatos = null
        hEqRender()
        hEqEstado("Añade divisas o activos a la lista.")
        return
    }

    const token = ++_hEqToken
    const parametros = new URLSearchParams({
        divisas: _hEqLista
            .filter((i) => i.tipo === "divisa")
            .map((i) => i.id)
            .join(","),
        tickers: _hEqLista
            .filter((i) => i.tipo === "activo")
            .map((i) => i.id)
            .join(","),
        referencia: hEqReferencia(),
        rango: _hEqRango
    })
    hEqEstado("Cargando…")
    try {
        const datos = await Api.get(`/api/herramientas/equivalencias?${parametros}`)
        // Si mientras tanto cambió la lista o el periodo, esta respuesta ya no vale.
        if (token !== _hEqToken) return
        _hEqDatos = {
            referencia: datos.referencia,
            rango: datos.rango,
            elementos: new Map((datos.elementos || []).map((e) => [e.id, e]))
        }
        hEqEstado("")
        hEqRender()
    } catch (error) {
        if (token !== _hEqToken) return
        _hEqDatos = null
        hEqRender()
        hEqEstado(error?.message || "No se pudieron cargar las cotizaciones.", true)
    }
}

function hEqElegirRango(rango) {
    if (!rango || rango === _hEqRango) return
    _hEqRango = rango
    document.querySelectorAll("#hEqRangos [data-rango]").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.rango === rango)
    })
    hEqGuardar()
    hEqCargar()
}

function hEqElemento(id) {
    const elemento = _hEqDatos?.elementos.get(id)
    return elemento && !elemento.error && elemento.puntos?.length ? elemento : null
}

function hEqCantidadesActuales() {
    const precios = new Map()
    _hEqLista.forEach((item) => {
        const elemento = hEqElemento(item.id)
        if (elemento) precios.set(item.id, elemento.actual.close)
    })
    return hEqCantidades(precios, _hEqAncla)
}

// ── Pintado ──────────────────────────────────────────────────────────────

function hEqEstado(texto, esError = false) {
    const nodo = document.getElementById("hEqEstado")
    if (!nodo) return
    nodo.textContent = texto
    nodo.classList.toggle("hFxEstadoError", Boolean(texto && esError))
    nodo.classList.toggle("hFxEstadoVisible", Boolean(texto))
}

function hEqMensaje(texto, aviso = false) {
    const nodo = document.getElementById("hEqMsg")
    if (!nodo) return
    nodo.textContent = texto
    nodo.className = "hRatioFuenteMsg" + (aviso && texto ? " hRatioFuenteWarn" : "")
}

function hEqColor(id) {
    const indice = _hEqLista.findIndex((i) => i.id === id)
    return H_EQ_COLORES[(indice < 0 ? 0 : indice) % H_EQ_COLORES.length]
}

function hEqRender() {
    hEqRenderTabla()
    hEqRenderGrafico()
    hEqRenderStats()
    hEqRenderVariaciones()
}

function hEqCelda(clase, texto = "") {
    const celda = document.createElement("td")
    if (clase) celda.className = clase
    celda.textContent = texto
    return celda
}

function hEqCeldaVariacion(valor) {
    return hEqCelda(
        `hEqNum ${valor === null ? "" : hFxClaseVariacion(valor)}`,
        valor === null ? "—" : hFxPorcentaje(valor)
    )
}

function hEqFila(item, cantidades, referencia) {
    const elemento = hEqElemento(item.id)
    const error = _hEqDatos?.elementos.get(item.id)?.error
    const fila = document.createElement("tr")
    fila.dataset.id = item.id
    fila.classList.toggle("active", item.id === _hEqSeleccion)

    const nombre = document.createElement("td")
    const caja = document.createElement("div")
    caja.className = "hEqActivo"
    nombre.appendChild(caja)
    const muestra = document.createElement("span")
    muestra.className = "hEqMuestra"
    muestra.style.background = hEqColor(item.id)
    const textos = document.createElement("span")
    textos.className = "hEqActivoTexto"
    const titulo = document.createElement("strong")
    titulo.textContent = item.nombre || item.id
    const detalle = document.createElement("small")
    const divisa = _hEqDatos?.elementos.get(item.id)?.divisa
    detalle.textContent = divisa && item.tipo === "activo" ? `${item.id} · ${divisa}` : item.id
    textos.append(titulo, detalle)
    caja.append(muestra, textos)

    const celdaCantidad = document.createElement("td")
    const input = document.createElement("input")
    input.type = "text"
    input.inputMode = "decimal"
    input.autocomplete = "off"
    input.className = "hPrecioInput hEqCantidad"
    input.dataset.id = item.id
    input.setAttribute("aria-label", `Cantidad de ${item.nombre || item.id}`)
    input.value = hEqFormatoCantidad(cantidades.get(item.id))
    celdaCantidad.appendChild(input)

    let precio
    if (elemento) precio = hEqCelda("hEqNum", `${hFxNumero(elemento.actual.close)} ${referencia}`)
    else if (error) {
        precio = hEqCelda("hEqNum hEqSinCotizacion", "Sin cotización")
        precio.title = error
    } else precio = hEqCelda("hEqNum hEqSinCotizacion", _hEqDatos ? "—" : "Cargando…")

    const quitar = document.createElement("td")
    const boton = document.createElement("button")
    boton.type = "button"
    boton.className = "hEqQuitar"
    boton.dataset.id = item.id
    boton.title = `Quitar ${item.nombre || item.id}`
    boton.setAttribute("aria-label", boton.title)
    boton.textContent = "×"
    quitar.appendChild(boton)

    fila.append(
        nombre,
        celdaCantidad,
        precio,
        hEqCeldaVariacion(hEqVariacionRango(elemento)),
        hEqCeldaVariacion(hEqVariacionPeriodo(elemento, "1D")),
        hEqCeldaVariacion(hEqVariacionPeriodo(elemento, "1A")),
        quitar
    )
    return fila
}

function hEqRenderTabla() {
    const cuerpo = document.getElementById("hEqCuerpo")
    if (!cuerpo) return
    const referencia = _hEqDatos?.referencia || hEqReferencia()
    document.querySelectorAll(".hEqReferencia").forEach((nodo) => {
        nodo.textContent = referencia
    })
    const rango = document.getElementById("hEqColRango")
    if (rango) rango.textContent = H_FX_PERIODOS[_hEqRango] || (_hEqRango === "5A" ? "5 años" : _hEqRango)

    const cantidades = hEqCantidadesActuales()
    cuerpo.replaceChildren(..._hEqLista.map((item) => hEqFila(item, cantidades, referencia)))
    document.getElementById("hEqVacia")?.classList.toggle("hidden", _hEqLista.length > 0)
    document.getElementById("hEqTablaWrap")?.classList.toggle("hidden", !_hEqLista.length)
    document.getElementById("hEqVaciarBtn")?.classList.toggle("hidden", !_hEqLista.length)
    const contador = document.getElementById("hEqContador")
    if (contador) contador.textContent = _hEqLista.length ? `${_hEqLista.length}/${H_EQ_MAX_ELEMENTOS}` : ""
    // Solo las cifras: repintar el desplegable cerraría un renombrado a medias.
    document
        .querySelectorAll("#hEqListaActualCuenta, #hEqListas .hEqListaOpcion.active .hEqListaCuenta")
        .forEach((cuenta) => {
            cuenta.textContent = String(_hEqLista.length)
        })
    hEqRenderTotal(cantidades)
    hEqActualizarSombras()
}

// Sombra en el borde por el que la tabla tiene más columnas: sin ella no se
// ve que las variaciones están a la derecha, fuera de la vista.
function hEqActualizarSombras() {
    const caja = document.getElementById("hEqTablaWrap")
    if (!caja) return
    const resto = caja.scrollWidth - caja.clientWidth - caja.scrollLeft
    caja.classList.toggle("hEqMasIzquierda", caja.scrollLeft > 1)
    caja.classList.toggle("hEqMasDerecha", resto > 1)
}

// Al escribir en una fila solo cambian las demás cantidades: repintar la tabla
// entera le quitaría el foco al campo en el que se está escribiendo.
function hEqRenderCantidades(exceptoId) {
    const cantidades = hEqCantidadesActuales()
    document.querySelectorAll("#hEqCuerpo .hEqCantidad").forEach((input) => {
        if (input.dataset.id !== exceptoId) input.value = hEqFormatoCantidad(cantidades.get(input.dataset.id))
    })
    hEqRenderTotal(cantidades)
}

function hEqRenderTotal(cantidades) {
    const nodo = document.getElementById("hEqTotal")
    if (!nodo) return
    const elemento = _hEqAncla ? hEqElemento(_hEqAncla.id) : null
    const item = _hEqLista.find((i) => i.id === _hEqAncla?.id)
    if (!elemento || !item) {
        nodo.textContent = ""
        return
    }
    const valor = cantidades.get(item.id) * elemento.actual.close
    nodo.textContent = `${hEqFormatoCantidad(_hEqAncla.cantidad)} ${item.nombre || item.id} = ${hFxNumero(valor, 2)} ${_hEqDatos.referencia}`
}

function hEqRenderGrafico() {
    const canvas = document.getElementById("hEqChart")
    if (!canvas || typeof Chart === "undefined") return
    try {
        _hEqChart?.destroy()
    } catch {
        /* ya destruido */
    }
    _hEqChart = null

    const conDatos = _hEqLista.filter((i) => hEqElemento(i.id))
    if (!conDatos.length) return

    const rango = _hEqDatos.rango
    const { tiempos, valores } = hEqAlinear(conDatos.map((i) => hEqElemento(i.id).puntos))
    const tema = hChartTheme()
    const datasets = conDatos.map((item, indice) => {
        const color = hEqColor(item.id)
        const elegido = item.id === _hEqSeleccion
        return {
            label: item.nombre || item.id,
            data: hEqRendimiento(valores[indice]),
            precios: valores[indice],
            borderColor: color,
            // Relleno suave solo si es la única línea; si no, el color entero,
            // que es el que pinta el cuadro de la leyenda.
            backgroundColor: conDatos.length === 1 ? `${color}22` : color,
            borderWidth: elegido ? 2.5 : 1.25,
            pointRadius: 0,
            pointHoverRadius: 3,
            tension: 0.15,
            fill: elegido && conDatos.length === 1,
            spanGaps: true,
            // El elegido, encima de los demás.
            order: elegido ? 0 : 1
        }
    })

    _hEqChart = new Chart(canvas, {
        type: "line",
        data: { labels: tiempos.map((ts) => hFxEtiqueta(ts, rango)), datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 250 },
            interaction: { mode: "index", intersect: false },
            plugins: {
                legend: {
                    labels: { color: tema.text, boxWidth: 12, font: { size: 11 } },
                    // Pulsar la leyenda elige el activo, como pulsar su fila.
                    onClick: (_e, leyenda) => hEqSeleccionar(conDatos[leyenda.datasetIndex].id)
                },
                tooltip: {
                    itemSort: (a, b) => (b.parsed.y ?? -Infinity) - (a.parsed.y ?? -Infinity),
                    callbacks: {
                        title: (items) => hFxEtiqueta(tiempos[items[0].dataIndex], rango, true),
                        label: (item) => {
                            const precio = item.dataset.precios[item.dataIndex]
                            if (item.parsed.y === null || precio === null) return null
                            return `${item.dataset.label}: ${hFxPorcentaje(item.parsed.y)} · ${hFxNumero(precio)} ${_hEqDatos.referencia}`
                        }
                    }
                }
            },
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { color: tema.muted, maxTicksLimit: 7, maxRotation: 0, autoSkip: true }
                },
                y: {
                    grid: { color: tema.grid },
                    ticks: { color: tema.muted, callback: (v) => hFxPorcentaje(Number(v)) }
                }
            }
        }
    })
}

function hEqRenderStats() {
    const nodo = document.getElementById("hEqStats")
    const titulo = document.getElementById("hEqSeleccionTitulo")
    if (!nodo) return
    const elemento = hEqElemento(_hEqSeleccion)
    const item = _hEqLista.find((i) => i.id === _hEqSeleccion)
    if (titulo)
        titulo.textContent = item ? `${item.nombre || item.id} en ${_hEqDatos?.referencia || hEqReferencia()}` : ""
    if (!elemento) {
        nodo.innerHTML = ""
        return
    }

    const { puntos } = elemento
    const rango = _hEqDatos.rango
    const valores = puntos.map((p) => p.close)
    const primero = valores[0]
    const ultimo = valores.at(-1)
    const iMin = valores.indexOf(Math.min(...valores))
    const iMax = valores.indexOf(Math.max(...valores))
    const media = valores.reduce((a, b) => a + b, 0) / valores.length
    const cambio = ultimo - primero

    // Las etiquetas son fijas y los valores, números ya formateados: no llega
    // ningún texto del usuario ni de la API a este innerHTML.
    const dato = (etiqueta, valor, clase = "", detalle = "") =>
        `<div class="hFxStat"><span class="hFxStatLabel">${etiqueta}</span><span class="hFxStatValue ${clase}">${valor}</span>${
            detalle ? `<span class="hFxStatDetalle">${detalle}</span>` : ""
        }</div>`

    nodo.innerHTML =
        dato("Apertura", hFxNumero(primero), "", hFxEtiqueta(puntos[0].ts, rango, true)) +
        dato("Actual", hFxNumero(ultimo), "", hFxEtiqueta(puntos.at(-1).ts, rango, true)) +
        dato(
            "Cambio",
            hFxDiferencia(cambio, ultimo),
            hFxClaseVariacion(cambio),
            hFxPorcentaje((ultimo / primero - 1) * 100)
        ) +
        dato("Mínimo", hFxNumero(valores[iMin]), "", hFxEtiqueta(puntos[iMin].ts, rango, true)) +
        dato("Máximo", hFxNumero(valores[iMax]), "", hFxEtiqueta(puntos[iMax].ts, rango, true)) +
        dato("Media", hFxNumero(media))
}

function hEqRenderVariaciones() {
    const nodo = document.getElementById("hEqVariaciones")
    if (!nodo) return
    const elemento = hEqElemento(_hEqSeleccion)
    if (!elemento) {
        nodo.innerHTML = ""
        return
    }

    const { actual, referencias } = elemento
    const referencia = _hEqDatos.referencia
    const cantidad = hEqCantidadesActuales().get(_hEqSeleccion)

    nodo.innerHTML = referencias
        .filter((r) => H_FX_PERIODOS[r.rango])
        .map((r) => {
            const diferencia = actual.close - r.close
            const variacion = (actual.close / r.close - 1) * 100
            const clase = hFxClaseVariacion(variacion)
            // Lo que supone para la cantidad de la tabla: cuánto más (o menos)
            // vale hoy que en esa fecha.
            const efecto =
                Number.isFinite(cantidad) && cantidad > 0
                    ? `<span class="hFxVarEfecto ${clase}">${hEqFormatoCantidad(cantidad)}: ${hFxDinero(cantidad * diferencia)} ${referencia}</span>`
                    : ""
            return `
                <button type="button" class="hFxVar${r.rango === _hEqRango ? " active" : ""}" data-rango="${r.rango}" title="Ver ${H_FX_PERIODOS[r.rango]} en el gráfico">
                    <span class="hFxVarLabel">${H_FX_PERIODOS[r.rango]}</span>
                    <span class="hFxVarPct ${clase}">${hFxPorcentaje(variacion)}</span>
                    <span class="hFxVarDif ${clase}">${hFxDiferencia(diferencia, actual.close)} ${referencia}</span>
                    ${efecto}
                    <span class="hFxVarRef">desde ${hFxNumero(r.close)}</span>
                </button>`
        })
        .join("")
}
