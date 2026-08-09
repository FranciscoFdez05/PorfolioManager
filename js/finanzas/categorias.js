// Panel único para ver y editar las categorías de gastos e ingresos.
//
// Las dos listas son editables siempre, se abra el panel desde la pestaña que
// se abra. Eso solo es posible porque el trabajo pesado lo hace el servidor:
// renombrar afecta a todos los años a la vez (stores/categorias_store.py), no
// solo al que el navegador tenga cargado. Si se hiciera aquí, los años no
// cargados se quedarían con la etiqueta vieja y la categoría renombrada
// reaparecería sola en cuanto se guardara cualquiera de ellos, porque el
// backend reconstruye el catálogo a partir de las filas.
//
// El número que se ve junto a cada categoría son sus usos reales en toda la
// base de datos, no solo en el año abierto, así que el bloqueo de borrado ya no
// depende de lo que el navegador tenga a mano.

const CATEGORIAS_OVERLAY_ID = "categoriasModalOverlay"

let categoriasKeyHandler = null
let categoriasEstado = null

const CATEGORIAS_PANELES = [
    { clave: "gasto", titulo: "Gastos", etiqueta: "gasto", endpointLista: "/api/gastos-tipos", idTabla: "gastosAnnualBody", pagina: "gastos" },
    { clave: "ingreso", titulo: "Ingresos", etiqueta: "ingreso", endpointLista: "/api/ingresos-tipos", idTabla: "ingresosAnnualBody", pagina: "ingresos" },
]


function escapeCategoriasHtml(value) {
    return String(value || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;")
}


function normalizarCategoriaTexto(value) {
    return String(value || "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
}


function limpiarCategoriaTexto(value) {
    return String(value || "").trim().replace(/\s+/g, " ").slice(0, 80).trim()
}


async function cargarCategoriasEstado() {
    const datos = await Api.get("/api/categorias/resumen")
    const resumen = datos?.categorias || {}
    const estado = {}

    CATEGORIAS_PANELES.forEach((panel) => {
        const lista = Array.isArray(resumen[panel.clave]) ? resumen[panel.clave] : []
        estado[panel.clave] = {
            filas: lista.map((item) => ({
                original: item.label,
                valor: item.label,
                usos: Number(item.usos) || 0,
            })),
        }
    })

    return estado
}


function cerrarCategoriasModal() {
    document.getElementById(CATEGORIAS_OVERLAY_ID)?.remove()
    categoriasEstado = null

    if (categoriasKeyHandler) {
        document.removeEventListener("keydown", categoriasKeyHandler)
        categoriasKeyHandler = null
    }
}


function ponerFeedbackCategorias(mensaje = "", esError = false) {
    const feedback = document.getElementById("categoriasModalFeedback")
    if (!feedback) {
        return
    }

    feedback.textContent = mensaje
    feedback.classList.toggle("hidden", !mensaje)
    feedback.classList.toggle("error", Boolean(mensaje && esError))
}


function construirFilaCategoria(panel, fila, indice, total) {
    const enUso = fila.usos > 0
    const tituloUso = enUso
        ? `${fila.usos} movimiento${fila.usos === 1 ? "" : "s"} usan esta categoría`
        : "Sin movimientos: se puede eliminar"

    return `
        <li class="catRow">
            <input class="catInput" type="text" value="${escapeCategoriasHtml(fila.valor)}"
                   data-cat-input="${panel.clave}" data-cat-index="${indice}"
                   aria-label="Nombre de la categoría">
            <span class="catUso" title="${tituloUso}">${enUso ? fila.usos : ""}</span>
            <button type="button" class="catIconBtn" data-cat-move="${panel.clave}" data-cat-index="${indice}" data-cat-dir="up" ${indice === 0 ? "disabled" : ""} title="Subir">▲</button>
            <button type="button" class="catIconBtn" data-cat-move="${panel.clave}" data-cat-index="${indice}" data-cat-dir="down" ${indice === total - 1 ? "disabled" : ""} title="Bajar">▼</button>
            <button type="button" class="catIconBtn catIconBtnDanger" data-cat-delete="${panel.clave}" data-cat-index="${indice}" ${enUso ? "disabled" : ""} title="${enUso ? "En uso: no se puede eliminar" : "Eliminar"}">✕</button>
        </li>
    `
}


function construirColumnaCategorias(panel) {
    const filas = categoriasEstado[panel.clave].filas

    const cuerpo = filas.length
        ? filas.map((fila, indice) => construirFilaCategoria(panel, fila, indice, filas.length)).join("")
        : `<li class="catRow catRowEmpty">Todavía no hay categorías de ${escapeCategoriasHtml(panel.etiqueta)}.</li>`

    return `
        <section class="catColumn">
            <h4 class="catColumnTitle">${escapeCategoriasHtml(panel.titulo)}<span class="catCount">${filas.length}</span></h4>
            <ul class="catList">${cuerpo}</ul>
            <button type="button" class="catAddBtn" data-cat-add="${panel.clave}">+ Añadir categoría</button>
        </section>
    `
}


function renderCategoriasModal() {
    const contenedor = document.getElementById("categoriasModalBody")
    if (!contenedor || !categoriasEstado) {
        return
    }

    contenedor.innerHTML = CATEGORIAS_PANELES.map(construirColumnaCategorias).join("")
}


function leerInputsCategorias() {
    // Los inputs mandan sobre el estado: el usuario puede haber escrito sin que
    // ningún evento haya refrescado nada.
    document.querySelectorAll("[data-cat-input]").forEach((input) => {
        const fila = categoriasEstado?.[input.dataset.catInput]?.filas?.[Number(input.dataset.catIndex)]
        if (fila) {
            fila.valor = input.value
        }
    })
}


function manejarClickCategorias(event) {
    if (!categoriasEstado) {
        return
    }

    const botonAnadir = event.target.closest("[data-cat-add]")
    if (botonAnadir) {
        leerInputsCategorias()
        const clave = botonAnadir.dataset.catAdd
        categoriasEstado[clave].filas.push({ original: "", valor: "", usos: 0 })
        renderCategoriasModal()
        const inputs = document.querySelectorAll(`[data-cat-input="${clave}"]`)
        inputs[inputs.length - 1]?.focus()
        return
    }

    const botonMover = event.target.closest("[data-cat-move]")
    if (botonMover) {
        leerInputsCategorias()
        const filas = categoriasEstado[botonMover.dataset.catMove].filas
        const indice = Number(botonMover.dataset.catIndex)
        const destino = botonMover.dataset.catDir === "up" ? indice - 1 : indice + 1

        if (destino < 0 || destino >= filas.length) {
            return
        }

        ;[filas[indice], filas[destino]] = [filas[destino], filas[indice]]
        renderCategoriasModal()
        return
    }

    const botonBorrar = event.target.closest("[data-cat-delete]")
    if (botonBorrar) {
        leerInputsCategorias()
        categoriasEstado[botonBorrar.dataset.catDelete].filas.splice(Number(botonBorrar.dataset.catIndex), 1)
        renderCategoriasModal()
        ponerFeedbackCategorias("")
    }
}


function planificarCambiosCategorias(panel) {
    const filas = categoriasEstado[panel.clave].filas
    const finales = []
    const vistos = new Set()

    for (const fila of filas) {
        const etiqueta = limpiarCategoriaTexto(fila.valor)

        // Una fila en blanco es una categoría añadida y luego vaciada: se
        // descarta en lugar de dar error.
        if (!etiqueta) {
            continue
        }

        const normalizada = normalizarCategoriaTexto(etiqueta)

        if (vistos.has(normalizada)) {
            return { error: `«${etiqueta}» está repetida en ${panel.titulo.toLowerCase()}.` }
        }

        vistos.add(normalizada)
        finales.push({ original: fila.original, etiqueta })
    }

    const presentes = new Set(finales.map((fila) => fila.original).filter(Boolean))
    const eliminadas = filas
        .map((fila) => fila.original)
        .filter((original) => original && !presentes.has(original))

    const renombradas = finales
        .filter((fila) => fila.original && fila.original !== fila.etiqueta)
        .map((fila) => ({ de: fila.original, a: fila.etiqueta }))

    // Una fila añadida y dejada en blanco no cuenta como cambio: si el resto del
    // panel está igual que al abrir, no se manda nada al servidor.
    const ordenPrevio = filas.map((fila) => fila.original).filter(Boolean)
    const ordenNuevo = finales.map((fila) => fila.original)
    const sinCambios = !eliminadas.length
        && !renombradas.length
        && ordenPrevio.length === ordenNuevo.length
        && ordenNuevo.every((original, indice) => original === ordenPrevio[indice])

    return {
        etiquetas: finales.map((fila) => fila.etiqueta),
        eliminadas,
        renombradas,
        sinCambios,
    }
}


async function guardarCategorias() {
    leerInputsCategorias()
    ponerFeedbackCategorias("")

    const planes = []

    for (const panel of CATEGORIAS_PANELES) {
        const plan = planificarCambiosCategorias(panel)

        if (plan.error) {
            ponerFeedbackCategorias(plan.error, true)
            return { ok: false, cambios: false }
        }

        planes.push({ panel, plan })
    }

    for (const { panel, plan } of planes) {
        if (plan.sinCambios) {
            continue
        }

        // Borrados primero: liberan nombres y devuelven 409 si están en uso, y
        // en ese caso no se debe seguir tocando nada más de este panel.
        for (const etiqueta of plan.eliminadas) {
            try {
                await Api.post("/api/categorias/eliminar", { tipo: panel.clave, label: etiqueta })
            } catch (error) {
                ponerFeedbackCategorias(error?.message || `No se pudo eliminar «${etiqueta}».`, true)
                return { ok: false, cambios: true }
            }
        }

        // Renombrados después: el servidor arrastra las filas de todos los años.
        for (const { de, a } of plan.renombradas) {
            try {
                await Api.post("/api/categorias/renombrar", { tipo: panel.clave, de, a })
            } catch (error) {
                ponerFeedbackCategorias(error?.message || `No se pudo renombrar «${de}».`, true)
                return { ok: false, cambios: true }
            }
        }

        // Y por último la lista completa, que fija el orden y da de alta las
        // categorías nuevas.
        await Api.post(panel.endpointLista, { types: plan.etiquetas })
    }

    return { ok: true, cambios: planes.some(({ plan }) => !plan.sinCambios) }
}


function refrescarPaginaTrasCategorias() {
    // Recargar la pestaña abierta es más fiable que parchear su estado en
    // memoria: tras un renombrado global sus filas ya no coinciden con lo que
    // hay en la base de datos. loadPage() vuelca antes los cambios pendientes.
    const panel = CATEGORIAS_PANELES.find((item) => document.getElementById(item.idTabla))

    if (panel && typeof loadPage === "function") {
        loadPage(panel.pagina)
    }
}


function abrirCategoriasModal() {
    cerrarCategoriasModal()

    const overlay = document.createElement("div")
    overlay.id = CATEGORIAS_OVERLAY_ID
    overlay.className = "modalOverlay"

    const modal = document.createElement("div")
    modal.className = "assetModal categoriasModal"
    modal.setAttribute("role", "dialog")
    modal.setAttribute("aria-modal", "true")
    modal.setAttribute("aria-labelledby", "categoriasModalTitle")

    modal.innerHTML = `
        <h3 class="assetModalTitle" id="categoriasModalTitle">Categorías</h3>
        <div class="catColumns" id="categoriasModalBody">
            <p class="catHint">Cargando…</p>
        </div>
        <p class="gastosCreateModalFeedback hidden" id="categoriasModalFeedback"></p>
        <div class="assetModalActions">
            <button type="button" class="cancelButton" id="categoriasModalCancelBtn">Cancelar</button>
            <button type="button" class="primaryButton" id="categoriasModalSaveBtn" data-no-autohide="true">Guardar</button>
        </div>
    `

    overlay.appendChild(modal)
    document.body.appendChild(overlay)

    modal.querySelector("#categoriasModalCancelBtn")?.addEventListener("click", cerrarCategoriasModal)
    modal.querySelector("#categoriasModalBody")?.addEventListener("click", manejarClickCategorias)

    modal.querySelector("#categoriasModalSaveBtn")?.addEventListener("click", async (event) => {
        const boton = event.currentTarget
        boton.disabled = true

        try {
            const resultado = await guardarCategorias()

            if (resultado.ok) {
                cerrarCategoriasModal()

                if (resultado.cambios) {
                    refrescarPaginaTrasCategorias()
                }
            }
        } catch (error) {
            console.error(error)
            ponerFeedbackCategorias("No se pudieron guardar las categorías.", true)
        } finally {
            boton.disabled = false
        }
    })

    categoriasKeyHandler = (event) => {
        if (event.key === "Escape") {
            cerrarCategoriasModal()
        }
    }
    document.addEventListener("keydown", categoriasKeyHandler)

    cargarCategoriasEstado()
        .then((estado) => {
            categoriasEstado = estado
            renderCategoriasModal()
        })
        .catch((error) => {
            console.error(error)
            ponerFeedbackCategorias("No se pudieron cargar las categorías.", true)
        })
}


// Delegación en document: los fragmentos de página se inyectan después de que
// este script se ejecute, así que enlazar por id al cargar no serviría.
document.addEventListener("click", (event) => {
    if (event.target.closest("[data-abrir-categorias]")) {
        abrirCategoriasModal()
    }
})
