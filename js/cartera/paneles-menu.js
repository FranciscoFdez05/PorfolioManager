// Activos > Paneles: menú flotante y enlace entre widgets.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

// ── Menú flotante ───────────────────────────────────────────────────────────

/**
 * Un único menú flotante para toda la página (desplegables de las cabeceras,
 * opciones del widget, añadir widget). Se cierra al pulsar fuera, con Escape o
 * al elegir. `contenido` permite meter dentro algo que no sea una lista.
 */
function pnMenu(anchor, items, alElegir, opciones = {}) {
    const abierto = document.getElementById("pnPop")
    const mismo = abierto && abierto._anchor === anchor
    pnCerrarMenu()
    if (mismo) return null

    const pop = document.createElement("div")
    pop.id = "pnPop"
    pop.className = "pnPop"
    pop._anchor = anchor
    if (opciones.ancho) pop.style.width = opciones.ancho + "px"
    if (opciones.clase) pop.classList.add(opciones.clase)

    if (opciones.contenido) {
        pop.appendChild(opciones.contenido)
    } else {
        pop.innerHTML = items
            .map((it) =>
                it.separador
                    ? `<div class="pnPopSep"></div>`
                    : it.cabecera
                      ? `<div class="pnPopCab">${escapeHtml(it.cabecera)}</div>`
                      : `<button type="button" class="pnPopItem${it.activo ? " active" : ""}${it.peligro ? " pnPeligro" : ""}" data-valor="${escapeAttr(it.valor)}">${it.html || escapeHtml(it.texto)}</button>`
            )
            .join("")
        pop.addEventListener("click", (e) => {
            const btn = e.target.closest(".pnPopItem")
            if (!btn) return
            pnCerrarMenu()
            alElegir?.(btn.dataset.valor)
        })
    }

    document.body.appendChild(pop)
    pnColocarMenu(pop, anchor, opciones.alinear)
    anchor.classList.add("pnAbierto")

    setTimeout(() => {
        const fuera = (e) => {
            if (pop.contains(e.target) || anchor.contains(e.target)) return
            pnCerrarMenu()
        }
        const tecla = (e) => {
            if (e.key === "Escape") pnCerrarMenu()
        }
        document.addEventListener("pointerdown", fuera)
        document.addEventListener("keydown", tecla)
        window.addEventListener("resize", pnCerrarMenu)
        pop._quitar = () => {
            document.removeEventListener("pointerdown", fuera)
            document.removeEventListener("keydown", tecla)
            window.removeEventListener("resize", pnCerrarMenu)
        }
    })
    return pop
}

function pnColocarMenu(pop, anchor, alinear) {
    const r = anchor.getBoundingClientRect()
    const ancho = pop.offsetWidth
    const alto = pop.offsetHeight
    let left = alinear === "derecha" ? r.right - ancho : r.left
    left = Math.max(8, Math.min(left, window.innerWidth - ancho - 8))
    let top = r.bottom + 4
    if (top + alto > window.innerHeight - 8) top = Math.max(8, r.top - alto - 4)
    pop.style.left = left + "px"
    pop.style.top = top + "px"
}

function pnCerrarMenu() {
    const pop = document.getElementById("pnPop")
    if (!pop) return
    pop._quitar?.()
    pop._anchor?.classList.remove("pnAbierto")
    pop.remove()
}

/**
 * Los controles de la cabecera salen también en los ajustes del widget (en
 * «Cabecera»): en un widget estrecho la cabecera los corta y los últimos no
 * se pueden pulsar. `_cab` dice cómo repetirlos allí: un desplegable que se
 * abre anclado al botón que se pulse, o una botonera (pnSegmentado).
 */
function pnControlCabecera(btn, etiqueta, abrir) {
    btn._cab = { etiqueta, abrir }
    btn.addEventListener("click", () => abrir(btn))
    return btn
}

/** Desplegable de una opción: el chip muestra la elegida. */
function pnChip(ctrls, texto, items, valor, alElegir, etiqueta = "") {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "pnChip"
    btn.innerHTML = `<span>${escapeHtml(texto)}</span><span class="pnChipFlecha">▾</span>`
    pnControlCabecera(btn, etiqueta, (ancla) =>
        pnMenu(
            ancla,
            items.map((it) => ({ ...it, activo: it.valor === valor })),
            alElegir
        )
    )
    ctrls.appendChild(btn)
    return btn
}

/** Botonera segmentada para pocas opciones que se cambian a menudo. */
function pnSegmentado(ctrls, items, valor, alElegir, etiqueta = "") {
    const cont = document.createElement("div")
    cont._cab = { etiqueta, items, valor, alElegir }
    cont.className = "pnSeg"
    cont.innerHTML = items
        .map(
            (it) =>
                `<button type="button" class="pnSegBtn${it.valor === valor ? " active" : ""}" data-valor="${escapeAttr(it.valor)}">${it.marcado ? `${iconoHtml("Marcado")} ` : ""}${escapeHtml(it.texto)}</button>`
        )
        .join("")
    cont.addEventListener("click", (e) => {
        const btn = e.target.closest(".pnSegBtn")
        if (btn && btn.dataset.valor !== valor) alElegir(btn.dataset.valor)
    })
    ctrls.appendChild(cont)
    return cont
}

// La lupa va como elemento propio y no como fondo del campo: el tema claro
// pone `background` con !important a todos los campos y la borraba.
const PN_LUPA = `<span class="icono iconoBuscar pnLupa" aria-hidden="true"></span>`

/**
 * Selector de activos con casillas, buscador y atajos por tipo. `vacioEsTodos`
 * dice qué significa no marcar ninguno (en el mapa y los favoritos, «todos»).
 *
 * Los cambios se avisan al momento (el widget se repinta detrás mientras se
 * marca); «Listo» solo cierra. Al repintar se rehace la lista y el pie, nunca
 * el buscador, para no perder lo que se está escribiendo.
 */
/**
 * Sección del selector de activos en la que sale cada activo. «Seguimiento» es
 * la lista que el usuario elige en Activos › Watchlist; los del portfolio sin
 * posición van aparte, en «Sin posición».
 */
function pnGrupoSelector(o) {
    if (o.seguido) return "Seguimiento"
    return o.ticker ? "Tickers" : o.watchlist ? "Watchlist" : o.conPosicion ? "En cartera" : "Sin posición"
}

/**
 * La lista «Seguimiento» de la Watchlist, en su orden, como activos de Paneles.
 *
 * Cada uno lleva `seguido` y `origen` («Portfolio» si es un activo de la cartera,
 * «Nuevo» si se dio de alta solo para seguirlo), que el selector enseña. Son
 * copias: los activos de `_pnDatos` no se marcan.
 *
 * @returns {Array<object>} Los activos seguidos que existen.
 */
function pnActivosSeguimiento() {
    const lista = typeof segLoadCustomItems === "function" ? segLoadCustomItems() : []
    const nuevos = new Map(pnActivosWatchlist().map((a) => [a.id, a]))
    return (Array.isArray(lista) ? lista : [])
        .map((entrada) => {
            if (!entrada?._segId) return null
            const activo = entrada.assetId ? _pnDatos?.porId.get(entrada.assetId) : nuevos.get("wl:" + entrada._segId)
            return activo ? { ...activo, seguido: true, origen: entrada.assetId ? "Portfolio" : "Nuevo" } : null
        })
        .filter(Boolean)
}

/**
 * Lo que ofrece el selector de activos de un mapa, sin repetidos: en el de
 * mercado, primero la lista de Seguimiento y después el resto.
 *
 * @param {object} cfg Ajustes del widget.
 * @param {boolean} mercado Si es el mapa de mercado.
 * @returns {Array<object>} Las opciones, en el orden del selector.
 */
function pnOpcionesMapa(cfg, mercado) {
    const resto = pnTodosLosActivos().filter((a) => !a.oculto || cfg.ocultos === true)
    if (!mercado) return resto
    const vistos = new Set()
    return [...pnActivosSeguimiento(), ...resto].filter((a) => !vistos.has(a.id) && vistos.add(a.id))
}

/**
 * Posición de cada activo en el selector de activos: por secciones, en el orden
 * en que aparece la primera de cada una, y dentro de cada sección en el orden de
 * la lista (el de Activos y la Watchlist). Si un id se repite, cuenta el primero.
 *
 * @param {Array<object>} opciones Activos con `id`, en el orden de la lista.
 * @returns {Map<string, number>} Id → posición.
 */
function pnOrdenSelector(opciones) {
    const porGrupo = new Map()
    opciones.forEach((o) => {
        const g = pnGrupoSelector(o)
        if (!porGrupo.has(g)) porGrupo.set(g, [])
        porGrupo.get(g).push(o)
    })
    const posicion = new Map()
    ;[...porGrupo.values()].flat().forEach((o) => {
        if (!posicion.has(o.id)) posicion.set(o.id, posicion.size)
    })
    return posicion
}

function pnSelectorActivos(
    anchor,
    { opciones, seleccion, alCambiar, vacioEsTodos = true, tickers = true, textoVacio = "toda la cartera" }
) {
    const marcados = new Set(seleccion)
    // Los tickers sueltos que ya estaban elegidos tienen que salir en la lista
    // para poder desmarcarlos.
    opciones = [
        ...opciones,
        ...seleccion
            .filter((id) => id.startsWith("tk|"))
            .map(pnBuscarActivo)
            .filter(Boolean)
    ]
    let resultados = null
    let buscado = ""
    const grupoDe = pnGrupoSelector
    const deTipo = (tipo) => opciones.filter((o) => o.tipo === tipo && !o.watchlist)

    const contenido = document.createElement("div")
    contenido.className = "pnSel"
    contenido.innerHTML = `
        <div class="pnSelCab">
            <label class="pnSelBuscarCaja">${PN_LUPA}<input class="pnSelBuscar" type="search" placeholder="Buscar por nombre o símbolo…" data-no-custom></label>
            <div class="pnSelAtajos"></div>
        </div>
        <div class="pnSelLista"></div>
        <div class="pnSelPie">
            <span class="pnSelCuenta"></span>
            <button type="button" class="pnSelLimpiar" data-accion="limpiar">Quitar todo</button>
            <button type="button" class="pnSelListo" data-accion="listo">Listo</button>
        </div>`

    const lista = contenido.querySelector(".pnSelLista")
    const atajos = contenido.querySelector(".pnSelAtajos")
    const cuenta = contenido.querySelector(".pnSelCuenta")
    const limpiar = contenido.querySelector(".pnSelLimpiar")
    const buscar = contenido.querySelector(".pnSelBuscar")

    const pintar = () => {
        // Un atajo está activo cuando lo marcado es justo ese tipo.
        const igual = (ids) => ids.length === marcados.size && ids.every((id) => marcados.has(id))
        atajos.innerHTML =
            `<button type="button" class="pnSelAtajo${marcados.size ? "" : " active"}" data-atajo="todos">Todos</button>` +
            PN_TIPOS_ACTIVO.map((t) => {
                const ids = deTipo(t.valor).map((o) => o.id)
                if (!ids.length) return ""
                return `<button type="button" class="pnSelAtajo${igual(ids) ? " active" : ""}" data-atajo="${t.valor}">${escapeHtml(t.texto)}<span>${ids.length}</span></button>`
            }).join("")

        const q = buscar.value.trim().toLowerCase()
        const visibles = opciones.filter(
            (o) =>
                !q ||
                o.nombre.toLowerCase().includes(q) ||
                String(o.simbolo || "")
                    .toLowerCase()
                    .includes(q)
        )
        const porGrupo = new Map()
        visibles.forEach((o) => {
            const g = grupoDe(o)
            if (!porGrupo.has(g)) porGrupo.set(g, [])
            porGrupo.get(g).push(o)
        })
        const scroll = lista.scrollTop
        lista.innerHTML =
            [...porGrupo]
                .map(
                    ([g, items]) => `
                <div class="pnSelGrupo"><span>${g}</span><span>${items.filter((o) => marcados.has(o.id)).length}/${items.length}</span></div>
                ${items
                    .map((o) => {
                        const on = marcados.has(o.id)
                        return `<label class="pnSelItem${on ? " pnMarcado" : ""}">
                            <input type="checkbox" class="pnCasilla" value="${escapeAttr(o.id)}" ${on ? "checked" : ""}>
                            <span class="pnSelAvatar" style="--c:${escapeAttr(pnColorTipo(o.tipo))}">${escapeHtml(String(o.simbolo || o.nombre).slice(0, 1))}</span>
                            <span class="pnSelNombre">${escapeHtml(o.nombre)}</span>
                            ${o.origen ? `<span class="pnSelOrigen">${escapeHtml(o.origen)}</span>` : ""}
                            ${o.simbolo ? `<span class="pnSelSimbolo">${escapeHtml(o.simbolo)}</span>` : ""}
                        </label>`
                    })
                    .join("")}`
                )
                .join("") ||
            (tickers
                ? ""
                : `<div class="pnVacio">Ningún activo coincide con «${escapeHtml(buscar.value.trim())}»</div>`)

        // Buscar fuera de la cartera: cualquier símbolo de TradingView.
        const texto = buscar.value.trim()
        if (tickers && texto.length >= 2) {
            if (resultados === "cargando" && buscado === texto) {
                lista.insertAdjacentHTML(
                    "beforeend",
                    `<div class="pnSelGrupo"><span>En el mercado</span></div><div class="pnVacio">Buscando «${escapeHtml(texto)}»…</div>`
                )
            } else if (Array.isArray(resultados) && buscado === texto) {
                const nuevos = resultados.filter((r) => !opciones.some((o) => o.id === r.id))
                lista.insertAdjacentHTML(
                    "beforeend",
                    `<div class="pnSelGrupo"><span>En el mercado</span><span>${nuevos.length}</span></div>` +
                        (nuevos
                            .map(
                                (
                                    r
                                ) => `<button type="button" class="pnSelItem pnSelResultado" data-ticker="${escapeAttr(r.id)}">
                                <span class="pnSelMas">+</span>
                                <span class="pnSelAvatar" style="--c:${escapeAttr(pnColorTipo(r.tipo))}">${escapeHtml(String(r.simbolo.split(":").pop()).slice(0, 1))}</span>
                                <span class="pnSelNombre">${escapeHtml(r.nombre)}</span>
                                <span class="pnSelSimbolo">${escapeHtml(r.simbolo)}</span>
                            </button>`
                            )
                            .join("") || `<div class="pnVacio">TradingView no encuentra «${escapeHtml(texto)}»</div>`)
                )
            } else {
                lista.insertAdjacentHTML(
                    "beforeend",
                    `<button type="button" class="pnSelBuscarFuera" data-accion="mercado">${PN_LUPA}<span>Buscar <b>${escapeHtml(texto)}</b> en el mercado</span><small>Intro</small></button>`
                )
            }
        }
        lista.scrollTop = scroll

        cuenta.innerHTML = marcados.size
            ? `<b>${marcados.size}</b> seleccionados`
            : vacioEsTodos
              ? `Sin marcar: <b>${escapeHtml(textoVacio)}</b>`
              : "Ninguno marcado"
        limpiar.disabled = !marcados.size
    }

    const avisar = () => {
        pintar()
        alCambiar([...marcados])
    }

    lista.addEventListener("change", (e) => {
        const cb = e.target.closest("input[type=checkbox]")
        if (!cb) return
        if (cb.checked) marcados.add(cb.value)
        else marcados.delete(cb.value)
        avisar()
    })
    atajos.addEventListener("click", (e) => {
        const btn = e.target.closest("[data-atajo]")
        if (!btn) return
        marcados.clear()
        if (btn.dataset.atajo !== "todos") deTipo(btn.dataset.atajo).forEach((o) => marcados.add(o.id))
        avisar()
    })
    const buscarFuera = async () => {
        const texto = buscar.value.trim()
        if (texto.length < 2) return
        buscado = texto
        resultados = "cargando"
        pintar()
        const encontrados = await pnBuscarTickers(texto)
        if (buscado !== texto) return
        resultados = encontrados || []
        pintar()
    }
    lista.addEventListener("click", (e) => {
        if (e.target.closest("[data-accion=mercado]")) {
            buscarFuera()
            return
        }
        const nuevo = e.target.closest("[data-ticker]")
        if (!nuevo) return
        const ticker = pnBuscarActivo(nuevo.dataset.ticker)
        if (!ticker) return
        opciones.push(ticker)
        marcados.add(ticker.id)
        avisar()
    })
    contenido.querySelector(".pnSelPie").addEventListener("click", (e) => {
        const accion = e.target.closest("[data-accion]")?.dataset.accion
        if (accion === "limpiar") {
            marcados.clear()
            avisar()
        }
        if (accion === "listo") pnCerrarMenu()
    })
    buscar.addEventListener("input", () => {
        resultados = null
        pintar()
    })
    buscar.addEventListener("keydown", (e) => {
        // Intro marca o desmarca el primero que coincide con la búsqueda; si
        // en la cartera no hay ninguno, busca en el mercado.
        if (e.key !== "Enter") return
        const primera = lista.querySelector("input[type=checkbox]")
        if (!primera) {
            if (tickers && resultados === null) buscarFuera()
            return
        }
        primera.checked = !primera.checked
        primera.dispatchEvent(new Event("change", { bubbles: true }))
    })

    pintar()
    pnMenu(anchor, [], null, { contenido, ancho: 340, clase: "pnPopSel" })
    setTimeout(() => buscar.focus(), 0)
}

// ── Enlace entre widgets ────────────────────────────────────────────────────

function pnSeleccionarActivo(id) {
    const activo = pnBuscarActivo(id)
    if (!activo) return
    const panel = pnPanelActivo()
    const graficos = (panel?.widgets || []).filter(
        (w) =>
            PN_TIPOS[w.tipo]?.enlazable &&
            w.cfg.vincular !== false &&
            !(w.tipo === "noticias" && w.cfg.modo !== "activo")
    )

    document.querySelectorAll(".pnSeleccionado").forEach((n) => n.classList.remove("pnSeleccionado"))
    document.querySelectorAll(`[data-activo="${CSS.escape(id)}"]`).forEach((n) => n.classList.add("pnSeleccionado"))

    if (!graficos.length) {
        if (activo.tv) openTVChartModal(activo.tv, activo.nombre)
        return
    }
    graficos.forEach((w) => {
        if (w.cfg.activo === id) return
        w.cfg.activo = id
        pnPintarWidget(w)
    })
    pnGuardar()
}
