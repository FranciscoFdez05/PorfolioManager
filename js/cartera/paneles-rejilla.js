// Activos > Paneles: estructura común de los widgets, arrastrar y redimensionar.
//
// Trozo de js/cartera/paneles.js. Comparte con el resto de paneles-*.js el
// ámbito global y se carga detrás de paneles.js, en el orden de index.html.

// ── Widgets: estructura común ───────────────────────────────────────────────

function pnCrearWidget(w) {
    const t = PN_TIPOS[w.tipo]
    const el = document.createElement("article")
    el.className = `pnWidget pnW-${w.tipo}`
    el.dataset.widget = w.id
    pnAplicarTamano(el, w)

    const enlace = PN_TIPOS[w.tipo].enlazable
        ? `<button class="pnEnlace${w.cfg.vincular === false ? "" : " on"}" type="button" title="${
              w.cfg.vincular === false
                  ? "Sin enlazar: los clics en otros widgets no cambian este gráfico"
                  : "Enlazado: al pulsar un activo en otro widget del panel se abre aquí"
          }"></button>`
        : ""

    el.innerHTML = `
        <header class="pnWHead">
            ${enlace}
            <span class="pnWTitulo">${escapeHtml(w.cfg.titulo || t.nombre)}</span>
            <div class="pnWCtrls"></div>
            <button class="pnAsa" type="button" title="Arrastrar para reordenar" aria-label="Arrastrar para reordenar">${PN_ASA_SVG}</button>
            <button class="pnWMenuBtn pnWAjustesBtn" type="button" title="Ajustes del widget" aria-label="Ajustes del widget">${iconoHtml("Ajustes")}</button>
            <button class="pnWMenuBtn" type="button" title="Opciones del widget" aria-label="Opciones del widget">${iconoHtml("Opciones")}</button>
        </header>
        <div class="pnWBody"></div>
        <div class="pnResize" title="Arrastra para cambiar el tamaño"></div>`

    el.querySelector(".pnWMenuBtn:not(.pnWAjustesBtn)").addEventListener("click", (e) =>
        pnMenuWidget(e.currentTarget, w)
    )
    el.querySelector(".pnWAjustesBtn").addEventListener("click", () => pnAbrirAjustes(w))
    el.querySelector(".pnEnlace")?.addEventListener("click", (e) => {
        if (w.cfg.vincular === false) delete w.cfg.vincular
        else w.cfg.vincular = false
        const on = w.cfg.vincular !== false
        e.currentTarget.classList.toggle("on", on)
        e.currentTarget.title = on
            ? "Enlazado: al pulsar un activo en otro widget del panel se abre aquí"
            : "Sin enlazar: los clics en otros widgets no cambian este gráfico"
        pnGuardar()
    })
    pnBindArrastre(el)
    pnBindRedimension(el, w)
    return el
}

/**
 * Ajusta un tamaño (en columnas o filas) al paso más fino de la rejilla.
 *
 * Args:
 *     valor: tamaño en columnas o filas, con o sin decimales.
 *
 * Returns:
 *     El tamaño redondeado a 1/PN_SUBDIVISION, o 0 si no es un número.
 */
function pnRedondearTamano(valor) {
    const n = Number(valor)
    return Number.isFinite(n) ? Math.round(n * PN_SUBDIVISION) / PN_SUBDIVISION : 0
}

/** Texto corto de un tamaño fraccionario: «4», «4,5», «4,25». */
function pnTextoTamano(valor) {
    return String(Math.round(valor * 100) / 100).replace(".", ",")
}

function pnAplicarTamano(el, w) {
    const t = PN_TIPOS[w.tipo]
    w.w = Math.max(t.minW, Math.min(PN_COLUMNAS, pnRedondearTamano(w.w) || t.w))
    w.h = Math.max(t.minH, Math.min(PN_ALTO_MAX, pnRedondearTamano(w.h) || t.h))
    const pistasAncho = Math.round(w.w * PN_SUBDIVISION)
    const pistasAlto = Math.round(w.h * PN_SUBDIVISION)
    el.style.gridColumn = `span ${pistasAncho}`
    el.style.gridRow = `span ${pistasAlto}`
    // En móvil la rejilla es de una columna; el alto se conserva.
    el.style.setProperty("--pn-h", pistasAlto)
}

function pnWidgetEl(w) {
    return document.querySelector(`.pnWidget[data-widget="${CSS.escape(w.id)}"]`)
}

// Cada pintada de un widget le da un turno nuevo. Lo que se pinta cuando llega
// una respuesta (historial, sentimiento, métricas, TradingView) comprueba que
// su turno sigue siendo el último: si no, el usuario ya cambió de rango o de
// universo y esa respuesta tardía pisaría la buena (pasaba al pulsar rápido).
const _pnTurnos = new Map()

function pnTurno(w) {
    return _pnTurnos.get(w.id) || 0
}

function pnVigente(w, turno) {
    return _pnTurnos.get(w.id) === turno && !!pnWidgetEl(w)
}

function pnPintarWidget(w) {
    const el = pnWidgetEl(w)
    if (!el) return
    _pnTurnos.set(w.id, pnTurno(w) + 1)
    const cuerpo = el.querySelector(".pnWBody")
    const ctrls = el.querySelector(".pnWCtrls")

    pnDestruirChart(w.id)

    // Las notas no dependen de la cartera; el resto espera a los datos. El
    // gráfico también: su activo se busca entre ellos, y pintarlo antes haría
    // que el iframe de TradingView se cargara dos veces.
    if (!_pnDatos && w.tipo !== "notas") {
        ctrls.innerHTML = ""
        cuerpo.innerHTML = `<div class="pnVacio">Cargando…</div>`
        return
    }

    const pintores = {
        mapa: pnPintarMapa,
        mapaMercado: pnPintarMapa,
        grafico: pnPintarGrafico,
        instrumento: pnPintarEmbebido,
        tecnico: pnPintarEmbebido,
        ficha: pnPintarEmbebido,
        perfil: pnPintarEmbebido,
        noticias: pnPintarEmbebido,
        calendario: pnPintarEmbebido,
        metrica: pnPintarMetrica,
        miedoCodicia: pnPintarMiedoCodicia,
        amplitud: pnPintarAmplitud,
        indices: pnPintarIndices,
        sectores: pnPintarSectores,
        escaner: pnPintarEscaner,
        cartera: pnPintarCartera,
        favoritos: pnPintarFavoritos,
        rendimiento: pnPintarRendimiento,
        distribucion: pnPintarDistribucion,
        resumen: pnPintarResumen,
        notas: pnPintarNotas
    }
    try {
        pintores[w.tipo](w, cuerpo, ctrls)
    } catch (error) {
        console.error("Paneles: error pintando", w.tipo, error)
        cuerpo.innerHTML = `<div class="pnVacio">No se pudo pintar este widget</div>`
    }
    pnRefrescarCabeceraAjustes(w)
}

/** Si el widget tiene sus ajustes abiertos, su sección «Cabecera» se pone al día. */
function pnRefrescarCabeceraAjustes(w) {
    pnVentanaAjustes("w:" + w.id)?._pintarCabecera?.()
}

function pnDestruirChart(id) {
    _pnCharts.get(id)?.destroy()
    _pnCharts.delete(id)
    _pnObservers.get(id)?.disconnect()
    _pnObservers.delete(id)
}

function pnDestruirWidgets() {
    ;[..._pnCharts.keys(), ..._pnObservers.keys()].forEach(pnDestruirChart)
    _pnTimers.forEach(clearTimeout)
    _pnTimers.clear()
}

/** Vuelve a pintar el widget cuando cambia de tamaño (mapa, sobre todo). */
function pnObservarTamano(w, cuerpo, pintar) {
    let timer = null
    let ultimo = ""
    const obs = new ResizeObserver(() => {
        const medida = `${cuerpo.clientWidth}x${cuerpo.clientHeight}`
        if (medida === ultimo) return
        ultimo = medida
        clearTimeout(timer)
        timer = setTimeout(pintar, 60)
    })
    obs.observe(cuerpo)
    _pnObservers.set(w.id, obs)
}

function pnMenuWidget(anchor, w) {
    pnMenu(
        anchor,
        [
            { valor: "ajustes", texto: "Ajustes…" },
            { valor: "renombrar", texto: "Renombrar" },
            { valor: "duplicar", texto: "Duplicar" },
            { valor: "ancho", texto: w.w === PN_COLUMNAS ? "Ancho original" : "Ocupar todo el ancho" },
            { valor: "eliminar", texto: "Quitar del panel", peligro: true }
        ],
        (accion) => {
            const panel = pnPanelActivo()
            if (!panel) return
            if (accion === "ajustes") pnAbrirAjustes(w)
            if (accion === "renombrar") pnRenombrarWidget(w)
            if (accion === "duplicar") {
                if (!pnCabeWidget(panel)) return
                const copia = { ...w, id: pnNuevoId("w"), cfg: { ...w.cfg } }
                panel.widgets.splice(panel.widgets.indexOf(w) + 1, 0, copia)
                pnGuardar()
                pnRenderCuerpo()
            }
            if (accion === "ancho") {
                w.w = w.w === PN_COLUMNAS ? PN_TIPOS[w.tipo].w : PN_COLUMNAS
                pnAplicarTamano(pnWidgetEl(w), w)
                pnGuardar()
            }
            if (accion === "eliminar") {
                panel.widgets.splice(panel.widgets.indexOf(w), 1)
                if (!panel.widgets.length) _pnGaleria = true
                pnGuardar()
                pnRenderCuerpo()
            }
        },
        { alinear: "derecha" }
    )
}

function pnRenombrarWidget(w) {
    const titulo = pnWidgetEl(w)?.querySelector(".pnWTitulo")
    if (!titulo) return
    const input = document.createElement("input")
    input.className = "pnTabInput"
    input.value = w.cfg.titulo || PN_TIPOS[w.tipo].nombre
    input.maxLength = 60
    titulo.replaceWith(input)
    input.focus()
    input.select()
    let hecho = false
    const terminar = (guardar) => {
        if (hecho) return
        hecho = true
        const valor = input.value.trim()
        if (guardar) {
            if (valor && valor !== PN_TIPOS[w.tipo].nombre) w.cfg.titulo = valor
            else delete w.cfg.titulo
            pnGuardar()
        }
        const span = document.createElement("span")
        span.className = "pnWTitulo"
        span.textContent = w.cfg.titulo || PN_TIPOS[w.tipo].nombre
        input.replaceWith(span)
    }
    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") terminar(true)
        if (e.key === "Escape") terminar(false)
    })
    input.addEventListener("blur", () => terminar(true))
}

// ── Arrastrar y redimensionar ───────────────────────────────────────────────

// La misma asa de seis puntos que los bloques de Ajustes.
const PN_ASA_SVG = `<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2.5" cy="2" r="1.5"/><circle cx="7.5" cy="2" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="14" r="1.5"/><circle cx="7.5" cy="14" r="1.5"/></svg>`

/**
 * Reordenar con la lógica de los bloques de Ajustes (js/ajustes/ajustes.js):
 *
 *   · Se coge solo por el asa: el resto de la cabecera tiene chips y botones,
 *     y pulsarlos no debe empezar a mover el widget.
 *   · El propio widget hace de previsión: mientras se arrastra se coloca en
 *     vivo en el hueco donde caerá, con el mismo aspecto de bloque «en el aire».
 *   · El hueco lo decide el primer widget que el cursor tiene por delante, en
 *     orden de lectura (Ajustes mira solo la mitad de alto porque es una
 *     columna; aquí también la mitad de ancho, porque es una rejilla).
 *   · Soltar fuera de la rejilla o pulsar Esc lo devuelve a donde estaba.
 *
 * Con eventos de puntero y no con el drag & drop nativo de Ajustes: los iframes
 * de TradingView se tragan los eventos del arrastre nativo en cuanto el cursor
 * pasa por encima (por eso la rejilla les quita `pointer-events` mientras dura).
 */
function pnBindArrastre(el) {
    const asa = el.querySelector(".pnAsa")
    asa.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const grid = el.parentElement
        const pagina = document.getElementById("pnBody")
        const casa = { siguiente: el.nextElementSibling }
        let x = e.clientX
        let y = e.clientY
        let cuadro = 0
        let terminado = false

        el.classList.add("pnArrastrado")
        grid.classList.add("pnArrastrando")

        const colocar = () => {
            cuadro = 0
            const otros = [...grid.children].filter((n) => n !== el && n.classList.contains("pnWidget"))
            const referencia = otros.find((n) => {
                const r = n.getBoundingClientRect()
                if (y < r.top) return true
                return y <= r.bottom && x < r.left + r.width / 2
            })
            moveDraggedAssetPreview(grid, el, referencia || null)
        }

        // Cerca del borde de la página, se desplaza sola: un panel largo no
        // cabe en pantalla y si no, no habría forma de llevar un widget abajo.
        const desplazar = () => {
            if (terminado || !pagina) return
            const r = pagina.getBoundingClientRect()
            const margen = 70
            const paso = y < r.top + margen ? -14 : y > r.bottom - margen ? 14 : 0
            if (paso) {
                pagina.scrollBy(0, paso)
                colocar()
            }
            requestAnimationFrame(desplazar)
        }
        requestAnimationFrame(desplazar)

        const mover = (ev) => {
            x = ev.clientX
            y = ev.clientY
            if (!cuadro) cuadro = requestAnimationFrame(colocar)
        }

        const acabar = (confirmar) => {
            if (terminado) return
            terminado = true
            cancelAnimationFrame(cuadro)
            document.removeEventListener("pointermove", mover)
            document.removeEventListener("pointerup", soltar)
            document.removeEventListener("pointercancel", cancelar)
            window.removeEventListener("keydown", tecla, true)
            el.classList.remove("pnArrastrado")
            grid.classList.remove("pnArrastrando")

            if (!confirmar) {
                // Cancelado: vuelve a su sitio, como en Ajustes.
                grid.insertBefore(el, casa.siguiente && casa.siguiente.parentElement === grid ? casa.siguiente : null)
                return
            }
            const panel = pnPanelActivo()
            if (!panel) return
            const orden = [...grid.children].map((n) => n.dataset.widget)
            const antes = panel.widgets.map((w) => w.id).join()
            panel.widgets.sort((a, b) => orden.indexOf(a.id) - orden.indexOf(b.id))
            if (panel.widgets.map((w) => w.id).join() !== antes) pnGuardar()
        }

        const soltar = (ev) => {
            const r = grid.getBoundingClientRect()
            const dentro =
                ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom
            acabar(dentro)
        }
        const cancelar = () => acabar(false)
        const tecla = (ev) => {
            if (ev.key !== "Escape") return
            ev.preventDefault()
            ev.stopPropagation()
            acabar(false)
        }

        document.addEventListener("pointermove", mover)
        document.addEventListener("pointerup", soltar)
        document.addEventListener("pointercancel", cancelar)
        window.addEventListener("keydown", tecla, true)
    })
}

/** Estirar por la esquina: el tamaño sigue al puntero, con el paso fino de la rejilla. */
function pnBindRedimension(el, w) {
    const asa = el.querySelector(".pnResize")
    asa.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return
        e.preventDefault()
        const grid = el.parentElement
        const hueco = pnHueco()
        // La rejilla no tiene gap: cada widget lleva medio hueco de margen y la
        // rejilla se sale medio hueco por cada lado. Así una columna mide el
        // ancho de la rejilla entre 12 y el widget es eso menos un hueco.
        const columna = grid.clientWidth / PN_COLUMNAS
        const fila = pnFila() + hueco
        const rect = el.getBoundingClientRect()
        const inicioX = e.clientX
        const inicioY = e.clientY
        const original = { w: w.w, h: w.h }

        el.classList.add("pnRedimensionando")
        grid.classList.add("pnArrastrando")

        const mover = (ev) => {
            const ancho = rect.width + (ev.clientX - inicioX)
            const alto = rect.height + (ev.clientY - inicioY)
            const nuevoW = pnRedondearTamano((ancho + hueco) / columna)
            const nuevoH = pnRedondearTamano((alto + hueco) / fila)
            if (nuevoW !== w.w || nuevoH !== w.h) {
                w.w = nuevoW
                w.h = nuevoH
                pnAplicarTamano(el, w)
            }
        }
        const soltar = () => {
            document.removeEventListener("pointermove", mover)
            document.removeEventListener("pointerup", soltar)
            el.classList.remove("pnRedimensionando")
            grid.classList.remove("pnArrastrando")
            if (w.w !== original.w || w.h !== original.h) pnGuardar()
        }
        document.addEventListener("pointermove", mover)
        document.addEventListener("pointerup", soltar)
    })
}
