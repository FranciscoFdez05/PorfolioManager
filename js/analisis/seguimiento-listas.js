// Análisis > Seguimiento: listas con nombre.
//
// Cada lista es un subconjunto de los activos de Seguimiento (sus `_segId`) y se
// guarda en `seguimientoListas`, junto al resto de datos de Seguimiento. Los mapas
// de Activos > Paneles eligen cuál enseñar (`pnActivosSeguimiento`). Trozo de
// seguimiento.js: comparte su ámbito global y se carga detrás de él.

const SEG_LISTA_NOMBRE_MAX = 60
const SEG_LISTA_NOMBRE_INICIAL = "Seguimiento"
// Valores de las acciones del menú de listas; no chocan con un id de lista (`l…`).
const SEG_LISTA_NUEVA = "__nueva"
const SEG_LISTA_GESTIONAR = "__gestionar"

// Lista que se está editando en el modal. La del filtro de la página, `_segFilterLista`,
// está con los demás filtros en seguimiento.js.
let _segListaEditada = ""

/**
 * Las listas guardadas, en su orden.
 *
 * @returns {Array<{id: string, nombre: string, ids: string[]}>} Copias: quien las
 *     pide puede modificarlas antes de guardarlas.
 */
function segListasLeer() {
    const guardadas = typeof _segDatos === "function" ? _segDatos().listas || {} : {}
    return Object.entries(guardadas).map(([id, lista]) => ({
        id,
        nombre: String(lista?.nombre || ""),
        ids: Array.isArray(lista?.ids) ? [...lista.ids] : []
    }))
}

/**
 * Los `_segId` de una lista.
 *
 * @param {string} idLista Identificador de la lista.
 * @returns {Set<string>|null} Sus activos, o null si la lista no existe (borrada o
 *     de otro portfolio), para que quien la use vuelva a la lista de Seguimiento.
 */
function segListaIds(idLista) {
    const lista = segListasLeer().find((l) => l.id === idLista)
    return lista ? new Set(lista.ids) : null
}

/** Guarda las listas en memoria y en el servidor. */
function segListasGuardar(listas) {
    const mapa = Object.fromEntries(listas.map((l) => [l.id, { nombre: l.nombre, ids: l.ids }]))
    _segDatos().listas = mapa
    _segGuardar({ seguimientoListas: mapa })
    // La barra lateral de Activos enseña estas listas y tiene que enterarse.
    window.dispatchEvent(new CustomEvent("seguimiento:listas"))
}

/**
 * Crea una lista con un nombre que no repite ninguno.
 *
 * La primera, si ya hay activos en Seguimiento, nace llamándose «Seguimiento» y
 * con todos ellos dentro: así lo que ya se seguía no queda fuera de las listas y
 * se puede recortar a partir de ahí. El nombre es solo el de partida y se edita.
 * Las siguientes, y la primera si Seguimiento está vacío, nacen vacías.
 *
 * @returns {string} El identificador de la lista nueva.
 */
function segListaCrear() {
    const listas = segListasLeer()
    const usados = new Set(listas.map((l) => l.nombre.toLowerCase()))
    const entradas = typeof segLoadCustomItems === "function" ? segLoadCustomItems() : []
    const existentes = (Array.isArray(entradas) ? entradas : []).map((e) => e?._segId).filter(Boolean)

    let nombre
    let ids = []
    if (!listas.length && existentes.length) {
        nombre = SEG_LISTA_NOMBRE_INICIAL
        ids = existentes
    } else {
        let numero = listas.length + 1
        while (usados.has(`lista ${numero}`)) numero++
        nombre = `Lista ${numero}`
    }
    const id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    listas.push({ id, nombre, ids })
    segListasGuardar(listas)
    return id
}

/**
 * Cambia el nombre de una lista. Un nombre vacío se ignora: una lista sin nombre
 * la descarta el servidor.
 *
 * @param {string} idLista Lista a renombrar.
 * @param {string} nombre Nombre nuevo.
 * @returns {boolean} Si se cambió.
 */
function segListaRenombrar(idLista, nombre) {
    const limpio = String(nombre || "")
        .trim()
        .slice(0, SEG_LISTA_NOMBRE_MAX)
    const listas = segListasLeer()
    const lista = listas.find((l) => l.id === idLista)
    if (!lista || !limpio || lista.nombre === limpio) return false
    lista.nombre = limpio
    segListasGuardar(listas)
    return true
}

/** Borra una lista; los activos siguen en Seguimiento. */
function segListaBorrar(idLista) {
    segListasGuardar(segListasLeer().filter((l) => l.id !== idLista))
}

/**
 * Pone o quita un activo de una lista.
 *
 * @param {string} idLista Lista a modificar.
 * @param {string} segId Activo de Seguimiento.
 * @param {boolean} marcado Si debe estar en la lista.
 */
function segListaAlternar(idLista, segId, marcado) {
    const listas = segListasLeer()
    const lista = listas.find((l) => l.id === idLista)
    if (!lista) return
    const sinEl = lista.ids.filter((id) => id !== segId)
    lista.ids = marcado ? [...sinEl, segId] : sinEl
    segListasGuardar(listas)
}

/**
 * Pone o quita varios activos de una lista de una vez (un solo guardado).
 *
 * @param {string} idLista Lista a modificar.
 * @param {string[]} segIds Activos de Seguimiento.
 * @param {boolean} marcado Si deben estar en la lista.
 */
function segListaAlternarVarios(idLista, segIds, marcado) {
    const listas = segListasLeer()
    const lista = listas.find((l) => l.id === idLista)
    if (!lista || !segIds.length) return
    const tocados = new Set(segIds)
    const sinEllos = lista.ids.filter((id) => !tocados.has(id))
    lista.ids = marcado ? [...sinEllos, ...segIds] : sinEllos
    segListasGuardar(listas)
}

/**
 * Mete en la lista elegida en el filtro los activos recién añadidos a Seguimiento:
 * sin ello, uno añadido mientras se mira una lista no saldría en ella.
 *
 * @param {string[]} segIds Activos nuevos de Seguimiento.
 */
function segListaAnadirALaElegida(segIds) {
    if (_segFilterLista && segIds.length) segListaAlternarVarios(_segFilterLista, segIds, true)
}

/** Si el activo está en la lista elegida en el filtro de la página. */
function segEnListaFiltrada(segId) {
    return segListaIds(_segFilterLista)?.has(segId) ?? true
}

function segListasPintarFiltro() {
    const filtro = document.getElementById("seguimientoListaFiltro")
    if (!filtro) return
    const listas = segListasLeer()
    if (!listas.some((l) => l.id === _segFilterLista)) segElegirListaFiltro("")
    const actual = listas.find((l) => l.id === _segFilterLista)
    filtro.textContent = `${actual?.nombre || "Listas"} ▾`
    filtro.classList.toggle("active", Boolean(actual))
    // «Añadir activo» y la fuente marcada dependen de si hay una lista elegida.
    segSyncAddBtn(document.getElementById("seguimientoAddBtn"))
    segMarcarFuentes()
}

/**
 * Menú del chip «Listas»: filtrar por una lista, o ir a crear una nueva o a
 * gestionar las que hay. Se usa `pnMenu`, el menú flotante de Paneles.
 *
 * @param {HTMLElement} ancla Chip del que cuelga el menú.
 */
function segListasAbrirMenu(ancla) {
    if (typeof pnMenu !== "function") return
    const listas = segListasLeer()
    // Sin «todas»: para ver el resto de activos se elige una fuente (Portfolio…).
    const items = listas.map((l) => ({ valor: l.id, texto: l.nombre, activo: l.id === _segFilterLista }))
    if (listas.length) items.push({ separador: true })
    items.push({ valor: SEG_LISTA_NUEVA, texto: "Nueva lista…" })
    if (listas.length) items.push({ valor: SEG_LISTA_GESTIONAR, texto: "Editar listas…" })
    pnMenu(ancla, items, (valor) => {
        if (valor === SEG_LISTA_NUEVA) segListasAbrirModal(true)
        else if (valor === SEG_LISTA_GESTIONAR) segListasAbrirModal(false)
        else {
            segElegirListaFiltro(valor)
            segListasPintarFiltro()
            segRenderGrid()
        }
    })
}

/**
 * Abre el modal de listas.
 *
 * @param {boolean} nueva Si se crea antes una lista nueva y se deja el cursor en su nombre.
 */
function segListasAbrirModal(nueva) {
    const overlay = document.getElementById("segListasModalOverlay")
    const nombre = document.getElementById("segListaNombre")
    const buscar = document.getElementById("segListaBuscar")
    if (!overlay || !nombre || !buscar) return
    if (nueva) _segListaEditada = segListaCrear()
    else if (!segListasLeer().some((l) => l.id === _segListaEditada)) _segListaEditada = ""
    buscar.value = ""
    segListasCambiaron()
    overlay.classList.remove("hidden")
    if (nueva) {
        nombre.focus()
        nombre.select()
    }
}

/** Los activos de Seguimiento que se ofrecen en el modal, tras el buscador. */
function segListaActivosVisibles() {
    const q = String(document.getElementById("segListaBuscar")?.value || "")
        .trim()
        .toLowerCase()
    return _segAllItems.filter(
        (item) =>
            item._seguido &&
            (!q ||
                [item.name, item.symbol, item.ticker].some((t) =>
                    String(t || "")
                        .toLowerCase()
                        .includes(q)
                ))
    )
}

function segListasPintarActivos() {
    const contenedor = document.getElementById("segListaActivos")
    if (!contenedor) return
    const lista = segListasLeer().find((l) => l.id === _segListaEditada)
    if (!lista) {
        contenedor.innerHTML = ""
        return
    }
    const q = String(document.getElementById("segListaBuscar")?.value || "").trim()
    const marcados = new Set(lista.ids)
    const activos = segListaActivosVisibles()
    if (!activos.length) {
        contenedor.innerHTML = `<p class="segAddVacio">${q ? "Ningún activo coincide" : "No hay activos en Seguimiento"}</p>`
        return
    }
    contenedor.innerHTML = activos
        .map((item) => {
            const color = AV_SEG_TYPE_COLORS[item.type] || "#888"
            const tipo = AV_SEG_TYPE_LABELS[item.type] || item.type || ""
            const ticker = item.marketSymbol || item.finnhubSymbol || item.ticker || ""
            return `<label class="segAddFila">
                <input type="checkbox" value="${escapeAttr(item._segId)}"${marcados.has(item._segId) ? " checked" : ""}>
                <span class="avBadge" style="background:${color}22;color:${color};border-color:${color}44">${escapeHtml(tipo)}</span>
                <span class="segAddFilaNombre">${escapeHtml(item.name || item.symbol || item._segId)}</span>
                <span class="segAddFilaTicker">${escapeHtml(ticker)}</span>
            </label>`
        })
        .join("")
}

/**
 * Pestañas del modal (una por lista, con cuántos activos lleva, y «+ Nueva») y
 * el contador de la lista que se edita. Solo cuentan los activos que siguen en
 * Seguimiento: el id de uno quitado se queda en la lista pero ya no se ve.
 */
function segListasPintarPestanas() {
    const pestanas = document.getElementById("segListasTabs")
    const contador = document.getElementById("segListaContador")
    if (!pestanas) return
    const vivos = new Set(_segAllItems.filter((item) => item._seguido).map((item) => item._segId))
    const listas = segListasLeer()
    const cuantos = (lista) => lista.ids.filter((id) => vivos.has(id)).length
    pestanas.innerHTML =
        listas
            .map(
                (l) =>
                    `<button type="button" class="segListaTab${l.id === _segListaEditada ? " active" : ""}" role="tab" aria-selected="${l.id === _segListaEditada}" data-lista="${escapeAttr(l.id)}"><span class="segListaTabNombre">${escapeHtml(l.nombre)}</span><small>${cuantos(l)}</small></button>`
            )
            .join("") + `<button type="button" class="segListaTab segListaTabNueva" data-accion="nueva">+ Nueva</button>`
    const actual = listas.find((l) => l.id === _segListaEditada)
    if (contador) contador.textContent = actual ? `${cuantos(actual)} de ${vivos.size}` : ""
}

function segListasPintarModal() {
    const nombre = document.getElementById("segListaNombre")
    const vacio = document.getElementById("segListasVacio")
    const editor = document.getElementById("segListasEditor")
    if (!nombre || !vacio || !editor) return
    const listas = segListasLeer()
    if (!listas.some((l) => l.id === _segListaEditada)) _segListaEditada = listas[0]?.id || ""
    // Sin listas no hay nada que editar: se enseña la invitación a crear la primera.
    vacio.classList.toggle("hidden", listas.length > 0)
    editor.classList.toggle("hidden", !listas.length)
    document.getElementById("segListasTabs")?.classList.toggle("hidden", !listas.length)
    // Mientras se escribe en el nombre no se pisa lo escrito.
    if (document.activeElement !== nombre) nombre.value = listas.find((l) => l.id === _segListaEditada)?.nombre || ""
    segListasPintarPestanas()
    segListasPintarActivos()
}

function segListasCambiaron() {
    segListasPintarFiltro()
    segListasPintarModal()
    segRenderGrid()
}

/** Engancha el chip y el modal de listas; se llama una vez al abrir Seguimiento. */
function segListasIniciar() {
    segListasPintarFiltro()
    const overlay = document.getElementById("segListasModalOverlay")
    const filtro = document.getElementById("seguimientoListaFiltro")
    if (!overlay || !filtro || filtro.dataset.bound === "true") return
    filtro.dataset.bound = "true"

    const nombre = document.getElementById("segListaNombre")
    const buscar = document.getElementById("segListaBuscar")
    const contenedor = document.getElementById("segListaActivos")

    filtro.addEventListener("click", () => segListasAbrirMenu(filtro))
    document.getElementById("segListasCerrarBtn")?.addEventListener("click", () => overlay.classList.add("hidden"))
    overlay.addEventListener("click", (e) => {
        if (e.target === overlay) overlay.classList.add("hidden")
    })

    document.getElementById("segListaNuevaVaciaBtn")?.addEventListener("click", () => segListasAbrirModal(true))
    document.getElementById("segListasTabs")?.addEventListener("click", (e) => {
        const pestana = e.target.closest(".segListaTab")
        if (!pestana) return
        if (pestana.dataset.accion === "nueva") {
            segListasAbrirModal(true)
            return
        }
        _segListaEditada = pestana.dataset.lista
        segListasPintarModal()
    })
    document.getElementById("segListaTodosBtn")?.addEventListener("click", () => {
        segListaAlternarVarios(_segListaEditada, segListaActivosVisibles().map((i) => i._segId), true)
        segListasPintarModal()
        segRenderGrid()
    })
    document.getElementById("segListaNingunoBtn")?.addEventListener("click", () => {
        segListaAlternarVarios(_segListaEditada, segListaActivosVisibles().map((i) => i._segId), false)
        segListasPintarModal()
        segRenderGrid()
    })
    document.getElementById("segListaBorrarBtn")?.addEventListener("click", () => {
        const lista = segListasLeer().find((l) => l.id === _segListaEditada)
        if (!lista) return
        openConfirmModal({
            title: "Borrar lista",
            message: `Vas a borrar la lista "${lista.nombre}". Los activos siguen en Seguimiento.`,
            confirmLabel: "Borrar",
            confirmSide: "right",
            onConfirm: () => {
                segListaBorrar(lista.id)
                segListasCambiaron()
            }
        })
    })
    nombre?.addEventListener("change", () => {
        segListaRenombrar(_segListaEditada, nombre.value)
        segListasCambiaron()
    })
    nombre?.addEventListener("keydown", (e) => {
        if (e.key === "Enter") nombre.blur()
    })
    buscar?.addEventListener("input", segListasPintarActivos)
    contenedor?.addEventListener("change", (e) => {
        const casilla = e.target.closest('input[type="checkbox"]')
        if (!casilla) return
        segListaAlternar(_segListaEditada, casilla.value, casilla.checked)
        segListasPintarPestanas()
        segRenderGrid()
    })
}
